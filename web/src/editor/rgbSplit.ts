import { Raster } from '../model/raster'
import type { Sides } from './filterKinds'

// Filter › RGB Split, as the Mac's MetalDispersion: each pixel gathers the image from many places along the split, each tinted by its
// place in the spectrum (blue at one end, green in the middle, red at the other), so edges fan into a continuous rainbow. Blur smears
// each of those along the same line, into streaks. Linear splits along `angle` (degrees counterclockwise from horizontal) everywhere;
// Radial splits outwards from `center`, `distance` at `reach` from it and in proportion to the distance from it, leaving it sharp.
// Distances, `center` and `reach` are in the pixels' own coordinates, rows top-down.
export type RGBSplitSettings = { distance: number; blur: number; angle: number; radial: boolean; center: [number, number]; reach: number }

const jitterAt = (x: number, y: number) => { const v = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453; return v - Math.floor(v) }
const sideBits = (sides?: Sides) => sides ? (sides.left ? 1 : 0) | (sides.right ? 2 : 0) | (sides.top ? 4 : 0) | (sides.bottom ? 8 : 0) : 0
// Past this many pixels the streaks' padded copy stops growing; spectrum samples beyond it smear the image where they land instead.
const maxPadded = 4096 * 4096

// Samples per spectrum and per streak, as Filters.rgbSplit picks them: enough that neighbors sit a pixel or two apart.
export function rgbSplitTaps(s: RGBSplitSettings) {
  const spread = s.radial ? s.distance * 2 : s.distance, smear = s.radial ? s.blur * 2 : s.blur
  return { spectral: s.distance > 0 ? Math.min(32, Math.max(3, Math.floor(spread))) : 1, smear: s.blur > 0 ? Math.min(24, Math.max(2, Math.floor(smear / 2))) : 1 }
}

// How far the spectrum reaches from any point of the rectangle: the distance, times how far Radial's grows past `reach` at its farthest corner.
export function rgbSplitSpread(s: RGBSplitSettings, x0: number, y0: number, x1: number, y1: number) {
  if (!s.radial) return s.distance
  const [cx, cy] = s.center
  return s.distance * Math.max(Math.hypot(x0 - cx, y0 - cy), Math.hypot(x1 - cx, y0 - cy), Math.hypot(x0 - cx, y1 - cy), Math.hypot(x1 - cx, y1 - cy)) / Math.max(s.reach, 1)
}

// The image at (qx, qy) into `out`, bilinear between texel centers as Metal's clamp-to-edge sampler reads it: clear past a side that
// isn't in `sides`, its edge carried on past one that is. `ox`, `oy` is where the first texel's corner sits.
function tap(src: Uint16Array, w: number, h: number, ox: number, oy: number, sides: number, qx: number, qy: number, out: Float64Array) {
  const tx = qx - ox, ty = qy - oy
  if ((tx < 0 && !(sides & 1)) || (tx > w && !(sides & 2)) || (ty < 0 && !(sides & 4)) || (ty > h && !(sides & 8))) { out[0] = out[1] = out[2] = out[3] = 0; return }
  const x = tx - 0.5, y = ty - 0.5, fx0 = Math.floor(x), fy0 = Math.floor(y), fx = x - fx0, fy = y - fy0
  const x0 = fx0 < 0 ? 0 : fx0 >= w ? w - 1 : fx0, x1 = fx0 + 1 < 0 ? 0 : fx0 + 1 >= w ? w - 1 : fx0 + 1
  const y0 = fy0 < 0 ? 0 : fy0 >= h ? h - 1 : fy0, y1 = fy0 + 1 < 0 ? 0 : fy0 + 1 >= h ? h - 1 : fy0 + 1
  const a = (y0 * w + x0) * 4, b = (y0 * w + x1) * 4, c = (y1 * w + x0) * 4, d = (y1 * w + x1) * 4
  const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy
  out[0] = src[a] * w00 + src[b] * w10 + src[c] * w01 + src[d] * w11
  out[1] = src[a + 1] * w00 + src[b + 1] * w10 + src[c + 1] * w01 + src[d + 1] * w11
  out[2] = src[a + 2] * w00 + src[b + 2] * w10 + src[c + 2] * w01 + src[d + 2] * w11
  out[3] = src[a + 3] * w00 + src[b + 3] * w10 + src[c + 3] * w01 + src[d + 3] * w11
}

// Linear's samples, the same for every pixel but for their jitter step: each one's place `along` the split (by `vx`, `vy`) as an
// offset into a buffer with `row` floats a row, and its bilinear weights, since the pixels' centers all sit on the grid alike. Along a
// row or a column (`step` 4 or `row`) only two of each sample's four texels count, so `pairs` keeps just their weights.
type Grid = { offsets: Int32Array; weights: Float64Array; pairs: Float64Array; step: number }
function gridTaps(along: Float64Array, vx: number, vy: number, row: number): Grid {
  const offsets = new Int32Array(along.length), weights = new Float64Array(along.length * 4), pairs = new Float64Array(along.length * 2)
  let across = true, down = true
  for (let k = 0; k < along.length; k++) {
    const tx = -vx * along[k], ty = -vy * along[k], ix = Math.floor(tx), iy = Math.floor(ty), fx = tx - ix, fy = ty - iy
    offsets[k] = iy * row + ix * 4
    weights[k * 4] = (1 - fx) * (1 - fy); weights[k * 4 + 1] = fx * (1 - fy); weights[k * 4 + 2] = (1 - fx) * fy; weights[k * 4 + 3] = fx * fy
    across &&= fy === 0; down &&= fx === 0
  }
  const step = across ? 4 : down ? row : 0
  for (let k = 0; k < along.length; k++) { pairs[k * 2] = weights[k * 4]; pairs[k * 2 + 1] = weights[k * 4 + (across ? 1 : 2)] }
  return { offsets, weights, pairs, step }
}

// Each pixel's samples sit a little apart from its neighbors' (by its jitter, in this many steps), so where they're spread wide a hard
// edge fans into a smooth spectrum with a fine grain, rather than a row of separate copies.
const levels = 64
// Pixels are worked through in strips this wide, top to bottom, so their samples, spread over many rows, stay in the cache.
const strip = 64
const levelAt = (x: number, y: number) => Math.floor(jitterAt(x, y) * levels)
// Every pixel's jitter step from the corner, kept for the next run (a slider drag redraws the same layer over and over).
let jitter = { w: 0, h: 0, levels: new Uint8Array(0) }
function levelMap(w: number, h: number) {
  if (jitter.w >= w && jitter.h >= h) return jitter
  const cw = Math.max(w, jitter.w), ch = Math.max(h, jitter.h), map = new Uint8Array(cw * ch)
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) map[y * cw + x] = levelAt(x, y)
  return jitter = { w: cw, h: ch, levels: map }
}

// One pass's samples: read bilinearly from `input` (16-bit levels, its first texel's corner at `origin`, `sides` carrying its edges on),
// `n` to a pixel at `along` the axis, each weighted by its `tints` (red, green, blue; all 1 if `unit`). `opaque` when every input alpha
// is full, so only the colors need reading; a jitter step's red tint is 0 before its `reds`th sample and blue from its `blues`th, so
// those go unread too.
type Taps = { input: Uint16Array; iw: number; ih: number; origin: number; sides: number; opaque: boolean; unit: boolean; reds: Int32Array; blues: Int32Array; n: number; along: Float64Array; tints: Float64Array; totals: Float64Array }
type Axis = { radial: boolean; cx: number; cy: number; reach: number; dx: number; dy: number; scale: number }

// Sums for `count` pixels from `at` (an index into the input), all of whose samples sit inside it, by Linear's grid, into `acc` (six
// to a pixel: red, green, blue, then alpha by each tint). Indices are kept to 32 bits (`| 0`) so they're added without overflow checks.
function gridRow(t: Taps, g: Grid, lv: Uint8Array, li: number, at: number, count: number, acc: Float64Array, ai: number) {
  const { input, n, tints, totals, opaque } = t, { offsets, weights, pairs, step } = g, irow = t.iw * 4
  for (let j = 0; j < count; j++, at += 4, ai += 6) {
    const level = lv[li + j], first = level * n, end = first + n
    let cr = 0, cg = 0, cb = 0, ar = 0, ag = 0, ab = 0
    if (step && opaque) for (let k = first; k < end; k++) {
      const p = (at + offsets[k]) | 0, q = (p + step) | 0, k3 = (k * 3) | 0, wa = pairs[k << 1], wb = pairs[(k << 1) | 1]
      cr += tints[k3] * (input[p] * wa + input[q] * wb); cg += tints[k3 + 1] * (input[(p + 1) | 0] * wa + input[(q + 1) | 0] * wb); cb += tints[k3 + 2] * (input[(p + 2) | 0] * wa + input[(q + 2) | 0] * wb)
    } else if (step) for (let k = first; k < end; k++) {
      const p = (at + offsets[k]) | 0, q = (p + step) | 0, k3 = (k * 3) | 0, wa = pairs[k << 1], wb = pairs[(k << 1) | 1], wr = tints[k3], wg = tints[k3 + 1], wbl = tints[k3 + 2]
      const a = input[(p + 3) | 0] * wa + input[(q + 3) | 0] * wb
      cr += wr * (input[p] * wa + input[q] * wb); cg += wg * (input[(p + 1) | 0] * wa + input[(q + 1) | 0] * wb); cb += wbl * (input[(p + 2) | 0] * wa + input[(q + 2) | 0] * wb)
      ar += wr * a; ag += wg * a; ab += wbl * a
    } else if (opaque && t.unit) for (let k = first; k < end; k++) {
      const p = (at + offsets[k]) | 0, q = (p + irow) | 0, k4 = k << 2, w00 = weights[k4], w10 = weights[k4 | 1], w01 = weights[k4 | 2], w11 = weights[k4 | 3]
      cr += input[p] * w00 + input[(p + 4) | 0] * w10 + input[q] * w01 + input[(q + 4) | 0] * w11
      cg += input[(p + 1) | 0] * w00 + input[(p + 5) | 0] * w10 + input[(q + 1) | 0] * w01 + input[(q + 5) | 0] * w11
      cb += input[(p + 2) | 0] * w00 + input[(p + 6) | 0] * w10 + input[(q + 2) | 0] * w01 + input[(q + 6) | 0] * w11
    } else if (opaque) for (let k = first, mid = first + t.reds[level], tail = first + t.blues[level]; k < end; k++) {
      const p = (at + offsets[k]) | 0, q = (p + irow) | 0, k3 = (k * 3) | 0, k4 = k << 2, w00 = weights[k4], w10 = weights[k4 | 1], w01 = weights[k4 | 2], w11 = weights[k4 | 3]
      if (k >= mid) cr += tints[k3] * (input[p] * w00 + input[(p + 4) | 0] * w10 + input[q] * w01 + input[(q + 4) | 0] * w11)
      cg += tints[k3 + 1] * (input[(p + 1) | 0] * w00 + input[(p + 5) | 0] * w10 + input[(q + 1) | 0] * w01 + input[(q + 5) | 0] * w11)
      if (k < tail) cb += tints[k3 + 2] * (input[(p + 2) | 0] * w00 + input[(p + 6) | 0] * w10 + input[(q + 2) | 0] * w01 + input[(q + 6) | 0] * w11)
    } else for (let k = first; k < end; k++) {
      const p = (at + offsets[k]) | 0, q = (p + irow) | 0, k3 = (k * 3) | 0, k4 = k << 2, w00 = weights[k4], w10 = weights[k4 | 1], w01 = weights[k4 | 2], w11 = weights[k4 | 3]
      const a = input[(p + 3) | 0] * w00 + input[(p + 7) | 0] * w10 + input[(q + 3) | 0] * w01 + input[(q + 7) | 0] * w11, wr = tints[k3], wg = tints[k3 + 1], wb = tints[k3 + 2]
      cr += wr * (input[p] * w00 + input[(p + 4) | 0] * w10 + input[q] * w01 + input[(q + 4) | 0] * w11)
      cg += wg * (input[(p + 1) | 0] * w00 + input[(p + 5) | 0] * w10 + input[(q + 1) | 0] * w01 + input[(q + 5) | 0] * w11)
      cb += wb * (input[(p + 2) | 0] * w00 + input[(p + 6) | 0] * w10 + input[(q + 2) | 0] * w01 + input[(q + 6) | 0] * w11)
      ar += wr * a; ag += wg * a; ab += wb * a
    }
    if (opaque) { ar = totals[level * 3] * 65280; ag = totals[level * 3 + 1] * 65280; ab = totals[level * 3 + 2] * 65280 }
    acc[ai] = cr; acc[ai + 1] = cg; acc[ai + 2] = cb; acc[ai + 3] = ar; acc[ai + 4] = ag; acc[ai + 5] = ab
  }
}

// The same for `count` pixels from the one centered at `ax`, `ay`, placing each sample (Radial's, or Linear's near the edges). With
// `clamp`, read as Metal's clamp-to-edge sampler does: clear past a side that isn't in `sides`, its edge carried on past one that is.
function pointRow(t: Taps, axis: Axis, lv: Uint8Array, li: number, ax: number, ay: number, count: number, acc: Float64Array, ai: number, clamp: boolean) {
  const { input, iw, ih, origin, sides, n, along, tints, totals, opaque } = t, { radial, cx, cy, reach, dx, dy, scale } = axis
  const irow = iw * 4, last = iw - 1, bottom = ih - 1, oy = ay - origin - 0.5, clip = clamp && sides !== 15
  const lox = sides & 1 ? -Infinity : -0.5, hix = sides & 2 ? Infinity : iw - 0.5, loy = sides & 4 ? -Infinity : -0.5, hiy = sides & 8 ? Infinity : ih - 0.5
  for (let j = 0; j < count; j++, ax++, ai += 6) {
    const level = lv[li + j], first = level * n, end = first + n, ox = ax - origin - 0.5
    const vx = (radial ? (ax - cx) / reach : dx) * scale, vy = (radial ? (ay - cy) / reach : dy) * scale
    let cr = 0, cg = 0, cb = 0, ar = 0, ag = 0, ab = 0
    if (!clamp && opaque && t.unit) for (let k = first; k < end; k++) {
      const x = ox - vx * along[k], y = oy - vy * along[k], ix = x | 0, iy = y | 0, fx = x - ix, fy = y - iy
      const p = (iy * irow + (ix << 2)) | 0, q = (p + irow) | 0, w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy
      cr += input[p] * w00 + input[(p + 4) | 0] * w10 + input[q] * w01 + input[(q + 4) | 0] * w11
      cg += input[(p + 1) | 0] * w00 + input[(p + 5) | 0] * w10 + input[(q + 1) | 0] * w01 + input[(q + 5) | 0] * w11
      cb += input[(p + 2) | 0] * w00 + input[(p + 6) | 0] * w10 + input[(q + 2) | 0] * w01 + input[(q + 6) | 0] * w11
    } else if (!clamp && opaque) for (let k = first, mid = first + t.reds[level], tail = first + t.blues[level]; k < end; k++) {
      const x = ox - vx * along[k], y = oy - vy * along[k], ix = x | 0, iy = y | 0, fx = x - ix, fy = y - iy, k3 = (k * 3) | 0
      const p = (iy * irow + (ix << 2)) | 0, q = (p + irow) | 0, w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy
      if (k >= mid) cr += tints[k3] * (input[p] * w00 + input[(p + 4) | 0] * w10 + input[q] * w01 + input[(q + 4) | 0] * w11)
      cg += tints[k3 + 1] * (input[(p + 1) | 0] * w00 + input[(p + 5) | 0] * w10 + input[(q + 1) | 0] * w01 + input[(q + 5) | 0] * w11)
      if (k < tail) cb += tints[k3 + 2] * (input[(p + 2) | 0] * w00 + input[(p + 6) | 0] * w10 + input[(q + 2) | 0] * w01 + input[(q + 6) | 0] * w11)
    } else for (let k = first; k < end; k++) {
      const x = ox - vx * along[k], y = oy - vy * along[k]
      if (clip && (x < lox || x > hix || y < loy || y > hiy)) continue
      const xc = x < 0 ? 0 : x > last ? last : x, yc = y < 0 ? 0 : y > bottom ? bottom : y, ix = xc | 0, iy = yc | 0, fx = xc - ix, fy = yc - iy, k3 = (k * 3) | 0
      const p = (iy * irow + (ix << 2)) | 0, q = iy < bottom ? (p + irow) | 0 : p, s = ix < last ? (p + 4) | 0 : p, u = ix < last ? (q + 4) | 0 : q
      const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy, wr = tints[k3], wg = tints[k3 + 1], wb = tints[k3 + 2]
      cr += wr * (input[p] * w00 + input[s] * w10 + input[q] * w01 + input[u] * w11)
      cg += wg * (input[(p + 1) | 0] * w00 + input[(s + 1) | 0] * w10 + input[(q + 1) | 0] * w01 + input[(u + 1) | 0] * w11)
      cb += wb * (input[(p + 2) | 0] * w00 + input[(s + 2) | 0] * w10 + input[(q + 2) | 0] * w01 + input[(u + 2) | 0] * w11)
      if (opaque) { ar += wr; ag += wg; ab += wb; continue }
      const a = input[(p + 3) | 0] * w00 + input[(s + 3) | 0] * w10 + input[(q + 3) | 0] * w01 + input[(u + 3) | 0] * w11
      ar += wr * a; ag += wg * a; ab += wb * a
    }
    if (opaque && !clamp) { ar = totals[level * 3]; ag = totals[level * 3 + 1]; ab = totals[level * 3 + 2] }
    if (opaque) { ar *= 65280; ag *= 65280; ab *= 65280 }
    acc[ai] = cr; acc[ai + 1] = cg; acc[ai + 2] = cb; acc[ai + 3] = ar; acc[ai + 4] = ag; acc[ai + 5] = ab
  }
}

// Every pixel of a `w` by `h` target whose first texel's corner sits at `at`, a strip at a time: those whose samples (reaching `extent`
// times the axis either way) all land inside the input by the grid or placed one by one, the rest placed and clamped (or by `slow`),
// each row's sums then handed to `finish`. With `spans`, just the columns from `spans[y * 2]` to `spans[y * 2 + 1]` of each row.
function sweep(w: number, h: number, at: number, t: Taps, axis: Axis, extent: number, grid: Grid | null, slow: ((x: number, y: number, acc: Float64Array, ai: number) => void) | null, finish: (y: number, x0: number, x1: number, acc: Float64Array, lv: Uint8Array, li: number) => void, spans?: Int32Array) {
  const { levels: lv, w: lw } = levelMap(w, h), acc = new Float64Array(strip * 6), { origin, iw, ih } = t, irow = iw * 4
  const { radial, cx, cy, reach, dx, dy, scale } = axis
  const inside = (ax: number, ay: number) => {
    const ex = Math.abs((radial ? (ax - cx) / reach : dx) * scale) * extent, ey = Math.abs((radial ? (ay - cy) / reach : dy) * scale) * extent
    return ax - ex - origin >= 0.5 && ax + ex - origin < iw - 0.5 && ay - ey - origin >= 0.5 && ay + ey - origin < ih - 0.5
  }
  const edge = (x0: number, x1: number, xs: number, y: number, ay: number, li: number) => {
    if (!slow) pointRow(t, axis, lv, li + x0, x0 + at + 0.5, ay, x1 - x0, acc, (x0 - xs) * 6, true)
    else for (let x = x0; x < x1; x++) slow(x, y, acc, (x - xs) * 6)
  }
  for (let x0 = 0; x0 < w; x0 += strip) for (let y = 0; y < h; y++) {
    const ay = y + at + 0.5, li = y * lw, xs = spans ? Math.max(x0, spans[y * 2]) : x0, xe = Math.min(w, x0 + strip, spans ? spans[y * 2 + 1] : w)
    if (xs >= xe) continue
    let a = xs, b = xe
    while (a < xe && !inside(a + at + 0.5, ay)) a++
    while (b > a && !inside(b - 1 + at + 0.5, ay)) b--
    edge(xs, a, xs, y, ay, li); edge(b, xe, xs, y, ay, li)
    if (grid) gridRow(t, grid, lv, li + a, (y + at - origin) * irow + (a + at - origin) * 4, b - a, acc, (a - xs) * 6)
    else pointRow(t, axis, lv, li + a, a + at + 0.5, ay, b - a, acc, (a - xs) * 6, false)
    finish(y, xs, xe, acc, lv, li)
  }
}

const opaqueLevels = (data: Uint16Array) => { for (let i = 3; i < data.length; i += 4) if (data[i] !== 65280) return false; return true }

// The pixels as 16-bit levels, 256 to each 8-bit one, with `pad` more on every side carrying the edges on.
function levelsPadded(data: Uint8Array, w: number, h: number, pad: number) {
  const iw = w + pad * 2, out = new Uint16Array(iw * (h + pad * 2) * 4)
  for (let y = 0; y < h + pad * 2; y++) {
    const from = (Math.min(h - 1, Math.max(0, y - pad)) * w) * 4, to = y * iw * 4, edge = to + (pad + w) * 4
    for (let i = 0; i < w * 4; i++) out[to + pad * 4 + i] = data[from + i] * 256
    for (let x = 0; x < pad; x++) for (let c = 0; c < 4; c++) { out[to + x * 4 + c] = data[from + c] * 256; out[edge + x * 4 + c] = data[from + (w - 1) * 4 + c] * 256 }
  }
  return out
}

// The streaks the spectrum reads, as the columns of each row of the copy padded by `pad` that its samples (and the texels beside
// them) land in: Linear's sweep the image along the split; Radial's scale it about the center, by as much as the spread is to `reach`.
function spectrumSpans(s: RGBSplitSettings, w: number, h: number, pad: number, dx: number, dy: number) {
  const iw = w + pad * 2, ih = h + pad * 2, spans = new Int32Array(ih * 2), [cx, cy] = s.center, f = s.distance / Math.max(s.reach, 1)
  const ends = (c: number, size: number) => { const q = [1 - f, 1 + f].flatMap(k => [c + (0.5 - c) * k, c + (size - 0.5 - c) * k]); return [Math.min(...q), Math.max(...q)] }
  const [left, right] = ends(cx, w), [top, bottom] = ends(cy, h), px = dx * s.distance, py = dy * s.distance
  for (let y = 0; y < ih; y++) {
    let x0 = 0, x1 = 0
    if (s.radial) { if (y - pad + 2 >= top && y - pad - 1 <= bottom) { x0 = left; x1 = right } else x0 = Infinity }
    else {
      const a = -1.5 - y + pad, b = h + 0.5 - y + pad
      const t0 = py ? Math.max(-1, Math.min(a / py, b / py)) : a <= 0 && b >= 0 ? -1 : Infinity, t1 = py ? Math.min(1, Math.max(a / py, b / py)) : 1
      x0 = t0 <= t1 ? 0.5 - Math.max(px * t0, px * t1) : Infinity; x1 = w - 0.5 - Math.min(px * t0, px * t1)
    }
    spans[y * 2] = x0 === Infinity ? iw : Math.max(0, Math.floor(x0 + pad - 0.5) - 1); spans[y * 2 + 1] = x0 === Infinity ? 0 : Math.min(iw, Math.floor(x1 + pad - 0.5) + 3)
  }
  return spans
}

function streaksOut(out: Uint16Array, o: number, acc: Float64Array, count: number, m: number) {
  for (let i = 0, end = count * 6; i < end; i += 6, o += 4) { out[o] = acc[i] / m + 0.5; out[o + 1] = acc[i + 1] / m + 0.5; out[o + 2] = acc[i + 2] / m + 0.5; out[o + 3] = acc[i + 3] / m + 0.5 }
}

// As opaque as the most opaque channel, so each color stays within the alpha it's stored multiplied by. Rounded by adding a half
// (Math.round, the same for these, is several times slower).
function spectrumOut(data: Uint8Array, o: number, acc: Float64Array, count: number, lv: Uint8Array, li: number, totals: Float64Array) {
  for (let j = 0, i = 0; j < count; j++, i += 6, o += 4) {
    const t = lv[li + j] * 3, tr = totals[t] * 256, tg = totals[t + 1] * 256, tb = totals[t + 2] * 256, r = acc[i + 3] / tr, g = acc[i + 4] / tg, b = acc[i + 5] / tb
    const most = r > g ? (r > b ? r : b) : g > b ? g : b, a = most < 255 ? most : 255, cr = acc[i] / tr, cg = acc[i + 1] / tg, cb = acc[i + 2] / tb
    data[o] = ((cr < a ? cr : a) + 0.5) | 0; data[o + 1] = ((cg < a ? cg : a) + 0.5) | 0; data[o + 2] = ((cb < a ? cb : a) + 0.5) | 0; data[o + 3] = (a + 0.5) | 0
  }
}

// Pixels are premultiplied 8-bit RGBA; returns a new raster the same size. `sides` are the layer's sides at the canvas's edge, which
// carry its edge pixels on rather than going clear.
export function rgbSplit(pixels: Raster, s: RGBSplitSettings, sides?: Sides): Raster {
  const { width: w, height: h } = pixels
  if (!(s.distance > 0 || s.blur > 0) || !w || !h) return pixels.clone()
  const { spectral: n, smear: m } = rgbSplitTaps(s), edges = sideBits(sides)
  const [cx, cy] = s.center, reach = Math.max(s.reach, 1), radial = s.radial, distance = s.distance, blur = s.blur
  // A split along a row or column is kept exactly along it, so its samples fall between two texels rather than four.
  const snap = (v: number) => Math.abs(v) < 1e-12 ? 0 : v, dx = snap(Math.cos(s.angle * Math.PI / 180)), dy = snap(-Math.sin(s.angle * Math.PI / 180))
  // With blur, the streaks first, into a copy padded by the spectrum's reach; then the spectrum read from that.
  let pad = 0, capped = false
  if (m > 1) {
    pad = Math.ceil(rgbSplitSpread(s, 0, 0, w, h)) + 2
    const most = Math.max(maxPadded, w * h * 4)
    if ((w + pad * 2) * (h + pad * 2) > most) { pad = Math.floor((Math.sqrt((w - h) ** 2 + 4 * most) - w - h) / 4); capped = true }
  }
  // The pixels and the streaks are read as 16-bit levels, 256 to each 8-bit one: half the memory of floats, which the samples spread
  // over many rows of, and finer than the half floats the Mac keeps the streaks in. With every side carried on (a layer filling the
  // canvas), the pixels are padded as far as the first pass reads (up to maxPadded), so no sample needs clamping.
  const far = m > 1 ? pad + Math.ceil(rgbSplitSpread({ ...s, distance: blur / 2 }, -pad, -pad, w + pad, h + pad)) + 2 : Math.ceil(rgbSplitSpread(s, 0, 0, w, h)) + 2
  const sp = edges === 15 && (w + far * 2) * (h + far * 2) <= maxPadded ? far : 0, pixels16 = levelsPadded(pixels.data, w, h, sp), sample = new Float64Array(4)
  // Each streak runs both ways along the split, centered on the point, so the image smears out without shifting one way.
  const streak = new Float64Array(levels * m)
  for (let level = 0; level < levels; level++) for (let j = 0; j < m; j++) streak[level * m + j] = (j + level / levels) / m - 0.5
  const source: Taps = { input: pixels16, iw: w + sp * 2, ih: h + sp * 2, origin: -sp, sides: sp ? 15 : edges, opaque: opaqueLevels(pixels16), unit: true, reds: new Int32Array(levels), blues: new Int32Array(levels).fill(m), n: m, along: streak, tints: new Float64Array(levels * m * 3).fill(1), totals: new Float64Array(levels * 3).fill(m) }
  const smearAt = (ax: number, ay: number, level: number, out: Uint16Array, o: number) => {
    const vx = (radial ? (ax - cx) / reach : dx) * blur, vy = (radial ? (ay - cy) / reach : dy) * blur
    let r = 0, g = 0, b = 0, a = 0
    for (let k = level * m, end = k + m; k < end; k++) {
      tap(source.input, source.iw, source.ih, -sp, -sp, source.sides, ax - vx * streak[k], ay - vy * streak[k], sample)
      r += sample[0]; g += sample[1]; b += sample[2]; a += sample[3]
    }
    out[o] = r / m + 0.5; out[o + 1] = g / m + 0.5; out[o + 2] = b / m + 0.5; out[o + 3] = a / m + 0.5
  }
  let input = source.input, iw = source.iw, ih = source.ih, origin = -sp, inputSides = source.sides
  if (m > 1) {
    iw = w + pad * 2; ih = h + pad * 2
    const streaks = input = new Uint16Array(iw * ih * 4), row = iw * 4
    sweep(iw, ih, -pad, source, { radial, cx, cy, reach, dx, dy, scale: blur }, 0.5, radial ? null : gridTaps(streak, dx * blur, dy * blur, source.iw * 4), null, (y, x0, x1, acc) => streaksOut(streaks, y * row + x0 * 4, acc, x1 - x0, m), spectrumSpans(s, w, h, pad, dx, dy))
    origin = -pad; inputSides = 15
  }
  // The spectrum's places along the split and their tints, for each jitter step: −1 is the blue end, 0 green, 1 red, so red lands
  // ahead along the split and blue behind.
  const along = new Float64Array(levels * n), tints = new Float64Array(levels * n * 3), totals = new Float64Array(levels * 3)
  for (let level = 0; level < levels; level++) for (let i = 0; i < n; i++) {
    const k = level * n + i, t = n === 1 ? 0 : (i + level / levels) / n * 2 - 1
    const rx = Math.min(1, Math.max(0, (t + 0.3) / 1.3)), bx = Math.min(1, Math.max(0, (0.3 - t) / 1.3)), gx = Math.abs(t)
    along[k] = t; tints[k * 3] = rx * rx * (3 - 2 * rx); tints[k * 3 + 1] = 1.05 - gx * gx * (3 - 2 * gx); tints[k * 3 + 2] = bx * bx * (3 - 2 * bx)
    for (let c = 0; c < 3; c++) totals[level * 3 + c] += tints[k * 3 + c]
  }
  const out = new Raster(w, h, 4), data = out.data, beyond = new Uint16Array(4)
  const reds = new Int32Array(levels), blues = new Int32Array(levels)
  for (let level = 0; level < levels; level++) { let i = 0; while (i < n && !tints[(level * n + i) * 3]) i++; reds[level] = i; while (i < n && tints[(level * n + i) * 3 + 2]) i++; blues[level] = i }
  const taps: Taps = { input, iw, ih, origin, sides: inputSides, opaque: source.opaque && (m === 1 || source.sides === 15), unit: false, reds, blues, n, along, tints, totals }
  // Past a padded copy that stopped growing, the streaks where the sample lands, each sample placed and read one at a time.
  const slow = !capped ? null : (x: number, y: number, acc: Float64Array, ai: number) => {
    const ax = x + 0.5, ay = y + 0.5, level = levelAt(x, y), px = (radial ? (ax - cx) / reach : dx) * distance, py = (radial ? (ay - cy) / reach : dy) * distance
    let cr = 0, cg = 0, cb = 0, ar = 0, ag = 0, ab = 0
    for (let k = level * n, end = k + n; k < end; k++) {
      const qx = ax - px * along[k], qy = ay - py * along[k], wr = tints[k * 3], wg = tints[k * 3 + 1], wb = tints[k * 3 + 2]
      if (qx < origin || qy < origin || qx > w - origin || qy > h - origin) {
        smearAt(qx, qy, levelAt(Math.floor(qx - origin), Math.floor(qy - origin)), beyond, 0)
        sample[0] = beyond[0]; sample[1] = beyond[1]; sample[2] = beyond[2]; sample[3] = beyond[3]
      } else tap(input, iw, ih, origin, origin, inputSides, qx, qy, sample)
      cr += wr * sample[0]; cg += wg * sample[1]; cb += wb * sample[2]
      ar += wr * sample[3]; ag += wg * sample[3]; ab += wb * sample[3]
    }
    acc[ai] = cr; acc[ai + 1] = cg; acc[ai + 2] = cb; acc[ai + 3] = ar; acc[ai + 4] = ag; acc[ai + 5] = ab
  }
  sweep(w, h, 0, taps, { radial, cx, cy, reach, dx, dy, scale: distance }, 1, radial ? null : gridTaps(along, dx * distance, dy * distance, iw * 4), slow, (y, x0, x1, acc, lv, li) => spectrumOut(data, (y * w + x0) * 4, acc, x1 - x0, lv, li + x0, totals))
  return out
}

// The same as a WebGL 2 pass over a texture of premultiplied pixels, for an RGB Split layer on the canvas. All positions are in the
// source texture's texels (rows as the texture stores them; flip `direction.y` and `center.y` to match if rows run bottom-up).
// Uniforms: `source` (sampler2D, linear filtering, clamp to edge); `pass` (0 the whole split without blur, 1 the streaks, 2 the
// spectrum read from the streaks); `outputOrigin`, `inputOrigin` (where the target's and source's first texel corners sit, in those
// coordinates: −pad for the padded streaks); `center`, `direction` (Linear's, a unit vector); `spread` and `streak` (the distance and blur), `reach`; `radial` (0
// or 1); `sides` (bits 1 left, 2 right, 4 top, 8 bottom: carry the edge on; 15 for pass 2); `spectral`, `smear` (rgbSplitTaps). With
// blur, run pass 1 into a target padded by ceil(rgbSplitSpread) + 2 on each side (float if EXT_color_buffer_float is there), then
// pass 2 from it; otherwise pass 0.
export const rgbSplitShader = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D source;
uniform int pass;
uniform vec2 outputOrigin;
uniform vec2 inputOrigin;
uniform vec2 center;
uniform vec2 direction;
uniform float spread;
uniform float streak;
uniform float reach;
uniform int radial;
uniform int sides;
uniform int spectral;
uniform int smear;
out vec4 color;
vec4 tap(vec2 q) {
  vec2 size = vec2(textureSize(source, 0)), texel = q - inputOrigin;
  if ((texel.x < 0.0 && (sides & 1) == 0) || (texel.x > size.x && (sides & 2) == 0) || (texel.y < 0.0 && (sides & 4) == 0) || (texel.y > size.y && (sides & 8) == 0)) return vec4(0.0);
  return texture(source, texel / size);
}
void main() {
  vec2 pixel = floor(gl_FragCoord.xy), at = outputOrigin + pixel + 0.5;
  vec2 axis = radial == 1 ? (at - center) / max(reach, 1.0) : direction;
  float jitter = fract(sin(dot(pixel, vec2(12.9898, 78.233))) * 43758.5453);
  if (pass == 1) {
    int m = max(smear, 1);
    vec4 sum = vec4(0.0);
    for (int j = 0; j < m; j++) sum += tap(at - axis * streak * ((float(j) + jitter) / float(m) - 0.5));
    color = sum / float(m);
    return;
  }
  int n = max(spectral, 1);
  vec3 c = vec3(0.0), alpha = vec3(0.0), total = vec3(0.0);
  for (int i = 0; i < n; i++) {
    float t = n == 1 ? 0.0 : (float(i) + jitter) / float(n) * 2.0 - 1.0;
    vec3 weight = vec3(smoothstep(-0.3, 1.0, t), 1.0 - smoothstep(0.0, 1.0, abs(t)) + 0.05, smoothstep(-0.3, 1.0, -t));
    vec4 s = tap(at - axis * spread * t);
    c += weight * s.rgb;
    alpha += weight * s.a;
    total += weight;
  }
  c /= total;
  alpha /= total;
  float a = max(alpha.r, max(alpha.g, alpha.b));
  color = vec4(min(c, vec3(a)), a);
}`
