import { Raster } from '../model/raster'
import { curveValue } from '../model/adjustments'

// Filter › Lens Effects, after LensEffects.swift: what light does inside a camera's lens and the filters in front of it, each effect
// made from the picture's own light, in linear light as optics work. Planes of floats (one per color) stand in for Core Image's
// images: past the picture's edge is black unless a step carries the edge on, as clampedToExtent does there.
export const lensEffects = ['Anamorphic Flare', 'Starburst', 'Mist', 'Prism', 'Bokeh'] as const
export const bokehShapes = ['Round', 'Hexagon', 'Oval', "Cat's Eye"] as const
export const starPointChoices = [4, 6, 8, 12, 14]
export type LensEffectName = typeof lensEffects[number]
export type BokehShape = typeof bokehShapes[number]

// The project's `lens` object (format 18 and 20): lengths given as percentages are of the document's longer side.
export type LensSettings = {
  effect: LensEffectName; threshold: number
  flareAmount: number; flareLength: number; flareBlue: number
  starAmount: number; starLength: number; starPoints: number; starAngle: number
  mistStrength: number; mistSize: number
  prismAmount: number; prismCopies: number; prismOffset: number; prismAngle: number; prismBothWays: boolean; prismBlur: number; prismFringe: number
  bokehRadius: number; bokehBrightness: number; bokehRing: number; bokehShape: BokehShape
}

export const defaultLens: LensSettings = {
  effect: 'Anamorphic Flare', threshold: 90, flareAmount: 50, flareLength: 60, flareBlue: 80, starAmount: 50, starLength: 12, starPoints: 6, starAngle: 15,
  mistStrength: 50, mistSize: 30, prismAmount: 80, prismCopies: 5, prismOffset: 6, prismAngle: 180, prismBothWays: false, prismBlur: 0, prismFringe: 30,
  bokehRadius: 2, bokehBrightness: 50, bokehRing: 100, bokehShape: 'Round',
}

const ranges: [keyof LensSettings, number, number][] = [
  ['threshold', 50, 100], ['flareAmount', 0, 100], ['flareLength', 1, 100], ['flareBlue', 0, 100], ['starAmount', 0, 100], ['starLength', 2, 40], ['starAngle', -180, 180],
  ['mistStrength', 0, 100], ['mistSize', 0, 100], ['prismAmount', 0, 100], ['prismCopies', 1, 8], ['prismOffset', 0, 50], ['prismAngle', -180, 180], ['prismBlur', 0, 100],
  ['prismFringe', 0, 100], ['bokehRadius', 0.5, 6], ['bokehBrightness', 0, 100], ['bokehRing', 0, 100],
]

// Each setting read if it's there and its default if not, clamped as LensEffectSettings.normalized does.
export function normalizedLens(raw: Partial<LensSettings> | undefined): LensSettings {
  const r = (raw ?? {}) as Record<string, unknown>, out: Record<string, unknown> = { ...defaultLens }
  for (const [key, lo, hi] of ranges) { const v = r[key]; if (typeof v === 'number' && Number.isFinite(v)) out[key] = Math.min(hi, Math.max(lo, v)) }
  out.prismCopies = Math.round(out.prismCopies as number)
  if (lensEffects.includes(r.effect as LensEffectName)) out.effect = r.effect
  if (bokehShapes.includes(r.bokehShape as BokehShape)) out.bokehShape = r.bokehShape
  if (starPointChoices.includes(r.starPoints as number)) out.starPoints = r.starPoints
  if (typeof r.prismBothWays === 'boolean') out.prismBothWays = r.prismBothWays
  return out as LensSettings
}

// Nothing to do: OK closes as Cancel does.
export function lensIsIdentity(s: LensSettings) {
  return s.effect === 'Anamorphic Flare' ? s.flareAmount === 0 : s.effect === 'Starburst' ? s.starAmount === 0 : s.effect === 'Mist' ? s.mistStrength === 0 : s.effect === 'Prism' ? s.prismAmount === 0 : false
}

type Planes = Float32Array[]
type Frame = { w: number; h: number; side: number; lin: Planes; luma: Float32Array }
// A plane's rows after a blur, a row at a time at full size: what `enlarge` would add at row y, times `gain`, written into `dst`;
// false where that's all black.
type Rows = (y: number, gain: number, dst: Float32Array | Float64Array) => boolean

// The effect on premultiplied 8-bit pixels, its sizes proportions of `side` pixels (the document's longer side). The light arithmetic
// runs on opaque colors and each pixel's own alpha goes back on at the end, as the Mac's does.
export function lensEffect(pixels: Raster, settings: LensSettings, side: number): Raster {
  const s = normalizedLens(settings), { width: w, height: h } = pixels
  if (!w || !h || lensIsIdentity(s)) return pixels.clone()
  const f = decode(pixels, Math.max(1, side), s.effect !== 'Prism')
  const light = s.effect === 'Anamorphic Flare' ? anamorphic(f, s) : s.effect === 'Starburst' ? starburst(f, s) : s.effect === 'Mist' ? mist(f, s) : s.effect === 'Prism' ? prism(f, s) : bokeh(f, s)
  return encode(light, pixels)
}

const toLinear = (v: number) => v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
const byteLinear = Float32Array.from({ length: 256 }, (_, i) => toLinear(i / 255))
let gammaTable: Float32Array | undefined, gammaBytes: Uint8Array | undefined
const gammaOf = () => gammaTable ??= Float32Array.from({ length: 65537 }, (_, i) => { const v = i / 65536; return (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055) * 255 })

// Each pixel read as one 32-bit word where the bytes allow it.
const littleEndian = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1
const words = (data: Uint8Array) => littleEndian && data.byteOffset % 4 === 0 ? new Uint32Array(data.buffer, data.byteOffset, data.length >> 2) : null

function decode(pixels: Raster, side: number, withLuma = true): Frame {
  const { width: w, height: h, data } = pixels, n = w * h, lin = [new Float32Array(n), new Float32Array(n), new Float32Array(n)], luma = new Float32Array(withLuma ? n : 0), [l0, l1, l2] = lin, word = words(data)
  for (let i = 0; i < n; i++) {
    const v = word ? word[i] : 0, a = word ? v >>> 24 : data[i * 4 + 3]
    if (!a) continue
    const r = word ? v & 255 : data[i * 4], g = word ? (v >>> 8) & 255 : data[i * 4 + 1], b = word ? (v >>> 16) & 255 : data[i * 4 + 2]
    if (a === 255) { l0[i] = byteLinear[r]; l1[i] = byteLinear[g]; l2[i] = byteLinear[b]; if (withLuma) luma[i] = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255; continue }
    const sr = Math.min(1, r / a), sg = Math.min(1, g / a), sb = Math.min(1, b / a)
    l0[i] = toLinear(sr); l1[i] = toLinear(sg); l2[i] = toLinear(sb); if (withLuma) luma[i] = 0.2126 * sr + 0.7152 * sg + 0.0722 * sb
  }
  return { w, h, side, lin, luma }
}

function encode(light: Planes, pixels: Raster) {
  const out = new Raster(pixels.width, pixels.height, 4), table = gammaOf(), bytes = gammaBytes ??= Uint8Array.from(table, v => Math.round(v * 255 / 255)), src = pixels.data, d = out.data, [l0, l1, l2] = light
  for (let i = 0; i < l0.length; i++) {
    const a = src[i * 4 + 3]
    if (!a) continue
    const r = l0[i], g = l1[i], b = l2[i], kr = r <= 0 ? 0 : r >= 1 ? 65536 : (r * 65536 + 0.5) | 0, kg = g <= 0 ? 0 : g >= 1 ? 65536 : (g * 65536 + 0.5) | 0, kb = b <= 0 ? 0 : b >= 1 ? 65536 : (b * 65536 + 0.5) | 0
    if (a === 255) { d[i * 4] = bytes[kr]; d[i * 4 + 1] = bytes[kg]; d[i * 4 + 2] = bytes[kb] }
    else { d[i * 4] = Math.round(table[kr] * a / 255); d[i * 4 + 1] = Math.round(table[kg] * a / 255); d[i * 4 + 2] = Math.round(table[kb] * a / 255) }
    d[i * 4 + 3] = a
  }
  return out
}

// Core Image's tone curve, as a table over 0–1: a smooth curve through the points (Curves' spline), flat past the ends.
function toneTable(points: number[][]) {
  const p = points.map(([x, y]) => ({ x: x * 255, y: y * 255 })), t = new Float32Array(1025)
  for (let i = 0; i <= 1024; i++) t[i] = curveValue(p, i / 1024 * 255) / 255
  return t
}
function tone(t: Float32Array, v: number) { const u = (v <= 0 ? 0 : v >= 1 ? 1 : v) * 1024, i = Math.min(1023, u | 0); return t[i] + (t[i + 1] - t[i]) * (u - i) }
const softTable = toneTable([[0, 0], [0.0625, 0.224], [0.125, 0.398], [0.25, 0.638], [1, 1]])
const brightnessTables = new Map<number, Float32Array>()

// Light compressed smoothly toward `limit`: nearly unchanged when dim, never past it.
const softClip = (v: number, limit: number) => tone(softTable, v / (4 * limit)) * limit

function brightnessTable(t: number) {
  let table = brightnessTables.get(t)
  if (!table) { const k = 1 - t; brightnessTables.set(t, table = toneTable([[0, 0], [t, 0], [t + k * 0.4, 0.25], [t + k * 0.75, 0.7], [1, 1]])) }
  return table
}

// How far each pixel is above `threshold` in brightness (of its sRGB tones), 0–1.
function brightness(luma: Float32Array, threshold: number) {
  const t = Math.min(0.95, Math.max(0, threshold)), table = brightnessTable(t), out = new Float32Array(luma.length)
  for (let i = 0; i < luma.length; i++) if (luma[i] > t) out[i] = tone(table, luma[i])
  return out
}

const masked = (f: Frame, mask: Float32Array, gain = 1) => f.lin.map(p => { const out = new Float32Array(p.length); for (let i = 0; i < p.length; i++) out[i] = p[i] * mask[i] * gain; return out })

// The picture's light where it's brighter than `threshold`, by how far (`brightness` and `masked` in one pass over the lit pixels).
function highlights(f: Frame, threshold: number, gain = 1) {
  const t = Math.min(0.95, Math.max(0, threshold)), table = brightnessTable(t), { luma, lin: [l0, l1, l2] } = f, n = luma.length, out = [new Float32Array(n), new Float32Array(n), new Float32Array(n)], [o0, o1, o2] = out
  for (let i = 0; i < n; i++) if (luma[i] > t) { const m = Math.fround(tone(table, luma[i])); o0[i] = l0[i] * m * gain; o1[i] = l1[i] * m * gain; o2[i] = l2[i] * m * gain }
  return out
}

// The lights a flare or starburst is made from (LensOptics.sources): up to 0.95 by how bright they are; past it, by how big and solid,
// a pixel staying only where its surroundings are lit too, measured against the picture's strongest source. Worked on a copy shrunk
// to a few pixels per radius, as everything there is a wide blur.
function sources(f: Frame, threshold: number): Planes {
  if (threshold <= 0.95) return highlights(f, threshold)
  const { w, h, side } = f, density = Math.min(1, (threshold - 0.95) / 0.05), lit = brightness(f.luma, 0.95), radius = side * 0.03 * density
  const k = Math.max(1, Math.ceil(radius / 4)), sw = Math.max(1, Math.round(w / k)), sh = Math.max(1, Math.round(h / k))
  const small = k > 1 ? resample(lit, w, h, sw, sh) : lit, r = radius * sw / w
  const around = gauss(small, sw, sh, r, radius * sh / h, true)
  let peak = 0
  for (let i = 0; i < around.length; i++) if (around[i] > peak) peak = around[i]
  if (peak <= 0.001) return highlights(f, 0.95)
  const cut = 0.25 + 0.6 * density, soft = 0.05, curve = toneTable([[0, 0], [Math.max(0, cut - soft), 0], [cut, 0.5], [cut + soft, 1], [Math.max(1, cut + soft * 2), 1]])
  for (let i = 0; i < around.length; i++) around[i] = tone(curve, around[i] / peak)
  const grown = dilate(around, sw, sh, r), whole = k > 1 ? enlarge(grown, sw, sh, w, h) : grown
  for (let i = 0; i < lit.length; i++) lit[i] *= whole[i]
  return masked(f, lit)
}

// Each value spread over a disc of `radius`, the largest kept (Core Image's CIMorphologyMaximum), from the lit pixels only.
function dilate(src: Float32Array, w: number, h: number, radius: number) {
  const out = src.slice(), reach = Math.floor(radius), spans: [number, number][] = []
  for (let dy = -reach; dy <= reach; dy++) spans.push([dy, Math.floor(Math.sqrt(Math.max(0, radius * radius - dy * dy)))])
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = src[y * w + x]
    if (v <= 0) continue
    for (const [dy, half] of spans) {
      const yy = y + dy
      if (yy < 0 || yy >= h) continue
      const row = yy * w, x1 = Math.min(w - 1, x + half)
      for (let xx = Math.max(0, x - half); xx <= x1; xx++) if (out[row + xx] < v) out[row + xx] = v
    }
  }
  return out
}

// Only the lights shorter than `height` pixels: the light less its vertical opening, so a wide bright area drops out and a lamp stays.
// `live` marks the light's lit rows; the result goes in `out`, `spare` is worked in, both black to begin with.
function compact(light: Float32Array, w: number, h: number, height: number, live: Uint8Array, spare: Float32Array, out: Float32Array) {
  const size = Math.max(3, Math.floor(height) | 1)
  columnFilter(spare, w, h, size, true, columnFilter(light, w, h, size, false, live, spare), out)
  for (let y = 0; y < h; y++) {
    const o = y * w
    if (!live[y]) { out.fill(0, o, o + w); continue }
    for (let i = o; i < o + w; i++) out[i] = Math.max(0, light[i] - out[i])
  }
}

// The largest (or smallest) value in a centered run of `size` down each column, black past the ends (van Herk–Gil–Werman), into
// `out` (black to begin with), worked a block of `size` rows at a time across the whole width: the suffix of one block and the
// prefix of the next meet at each row. Only blocks with a row that can be lit are worked, by `live`, the lit rows of `src`: for the
// largest, a row with a lit one in its run; for the smallest, one whose run is all lit. Those rows are returned.
function columnFilter(src: Float32Array, w: number, h: number, size: number, largest: boolean, live: Uint8Array, out: Float32Array) {
  const r = (size - 1) >> 1, pre = new Float32Array(size * w), suf = new Float32Array(size * w), count = new Int32Array(h + 1), can = new Uint8Array(h)
  for (let y = 0; y < h; y++) count[y + 1] = count[y] + live[y]
  for (let y = 0; y < h; y++) { const n = count[Math.min(h, y + r + 1)] - count[Math.max(0, y - r)]; can[y] = largest ? (n > 0 ? 1 : 0) : (y - r >= 0 && y + r < h && n === size ? 1 : 0) }
  // Row t of the run padded by r black rows above: its offset in `src`, or −1 for black.
  const at = (t: number) => t - r >= 0 && t - r < h && live[t - r] ? (t - r) * w : -1
  for (let t0 = 0; t0 < h; t0 += size) {
    let any = false
    for (let y = t0; y < Math.min(h, t0 + size); y++) if (can[y]) { any = true; break }
    if (!any) continue
    for (let k = size - 1; k >= 0; k--) {
      const b = at(t0 + k), o = k * w, n = o + w
      if (k === size - 1) { if (b < 0) suf.fill(0, o, n); else suf.set(src.subarray(b, b + w), o) }
      else if (b < 0) { if (largest) suf.copyWithin(o, n, n + w); else suf.fill(0, o, n) }
      else if (largest) for (let x = 0; x < w; x++) { const v = src[b + x], u = suf[n + x]; suf[o + x] = v > u ? v : u }
      else for (let x = 0; x < w; x++) { const v = src[b + x], u = suf[n + x]; suf[o + x] = v < u ? v : u }
    }
    for (let k = 0; k < size - 1 && t0 + k + 1 < h; k++) {
      const b = at(t0 + size + k), o = k * w, q = o - w
      if (k === 0) { if (b < 0) pre.fill(0, 0, w); else pre.set(src.subarray(b, b + w), 0) }
      else if (b < 0) { if (largest) pre.copyWithin(o, q, o); else pre.fill(0, o, o + w) }
      else if (largest) for (let x = 0; x < w; x++) { const v = src[b + x], u = pre[q + x]; pre[o + x] = v > u ? v : u }
      else for (let x = 0; x < w; x++) { const v = src[b + x], u = pre[q + x]; pre[o + x] = v < u ? v : u }
    }
    out.set(suf.subarray(0, w), t0 * w)
    for (let k = 1; k < size && t0 + k < h; k++) {
      const o = (t0 + k) * w, s = k * w, q = (k - 1) * w
      if (largest) for (let x = 0; x < w; x++) { const u = suf[s + x], v = pre[q + x]; out[o + x] = u > v ? u : v }
      else for (let x = 0; x < w; x++) { const u = suf[s + x], v = pre[q + x]; out[o + x] = u < v ? u : v }
    }
  }
  return can
}

const emptyRow = (p: Float32Array, base: number, w: number) => { for (let x = 0; x < w; x++) if (p[base + x] !== 0) return false; return true }
function liveRows(p: Float32Array, w: number, h: number) { const live = new Uint8Array(h); for (let y = 0; y < h; y++) live[y] = emptyRow(p, y * w, w) ? 0 : 1; return live }
// The first and last lit pixels of a row, [w, −1] for an empty one.
function litSpan(p: Float32Array | Float64Array, base: number, w: number): [number, number] {
  let lo = 0, hi = w - 1
  while (lo < w && p[base + lo] === 0) lo++
  if (lo === w) return [w, -1]
  while (p[base + hi] === 0) hi--
  return [lo, hi]
}

// Area-averaging weights from `n` pixels to `m`: output i is the sum of wt[off[i] + k]·input[from[i] + k].
function averaging(n: number, m: number) {
  const scale = n / m, from = new Int32Array(m), off = new Int32Array(m + 1), wt: number[] = []
  for (let i = 0; i < m; i++) {
    const lo = i * scale, hi = Math.min(n, (i + 1) * scale), j0 = Math.floor(lo)
    from[i] = j0; off[i] = wt.length
    for (let j = j0; j < Math.min(n, Math.ceil(hi)); j++) wt.push((Math.min(hi, j + 1) - Math.max(lo, j)) / scale)
  }
  off[m] = wt.length
  return { from, off, wt: Float64Array.from(wt) }
}

// Area-averaged reduction to `sw`×`sh`, a row pass then a column pass.
// `spans`, when given, holds each row's first and last lit pixels (−1 for none), so the rows needn't be searched.
function resample(src: Float32Array, w: number, h: number, sw: number, sh: number, spans?: Int32Array) {
  let rows = src
  if (sw !== w) {
    const { from, off, wt } = averaging(w, sw)
    rows = new Float32Array(sw * h)
    for (let y = 0; y < h; y++) {
      const [lo, hi] = spans ? [spans[2 * y], spans[2 * y + 1]] : litSpan(src, y * w, w)
      if (hi < 0) continue
      for (let i = Math.max(0, Math.floor(lo * sw / w) - 1), e = Math.min(sw, Math.ceil(hi * sw / w) + 2); i < e; i++) { let s = 0; for (let k = off[i], j = y * w + from[i], ke = off[i + 1]; k < ke; k++, j++) s += wt[k] * src[j]; rows[y * sw + i] = s }
    }
  }
  if (sh === h) return rows
  const { from, off, wt } = averaging(h, sh), out = new Float32Array(sw * sh)
  for (let i = 0; i < sh; i++) for (let k = off[i]; k < off[i + 1]; k++) {
    const v = wt[k], b = (from[i] + k - off[i]) * sw, o = i * sw
    for (let x = 0; x < sw; x++) out[o + x] += v * rows[b + x]
  }
  return out
}

// Where each of `n` pixels samples a plane `m` long, smoothly, its edge carried on: between i0 and i1, f of the way, the pixels
// [start[a], start[a + 1]) all from a.
type Axis = { i0: Int32Array; i1: Int32Array; f: Float32Array; start: Int32Array }
function stretchAxis(n: number, m: number): Axis {
  const i0 = new Int32Array(n), i1 = new Int32Array(n), f = new Float32Array(n), start = new Int32Array(m + 1).fill(n)
  for (let x = n - 1; x >= 0; x--) { const u = Math.min(m - 1, Math.max(0, (x + 0.5) * m / n - 0.5)), a = Math.floor(u); i0[x] = a; i1[x] = Math.min(m - 1, a + 1); f[x] = u - a; start[a] = x }
  for (let a = m - 1; a >= 0; a--) if (start[a] > start[a + 1]) start[a] = start[a + 1]
  return { i0, i1, f, start }
}

// Columns [x0, x1) of a reduced row stretched out, into `out` from `o` (added when `add`): each reduced pixel's run in turn, its two
// values read once. `row` has a black pixel past its end; where i1 stops at the edge f is 0, so reading a + 1 changes nothing.
function stretchRow(out: Float32Array | Float64Array, o: number, row: Float32Array | Float64Array, { i0, f, start }: Axis, x0: number, x1: number, add: boolean) {
  if (x0 >= x1) return
  for (let a = i0[x0], e = i0[x1 - 1]; a <= e; a++) {
    const r = row[a], d = row[a + 1] - r, s = Math.max(x0, start[a]), t = Math.min(x1, start[a + 1])
    if (add) for (let x = s; x < t; x++) out[o + x] += r + d * f[x]
    else for (let x = s; x < t; x++) out[o + x] = r + d * f[x]
  }
}

// A reduced plane stretched back to `w`×`h`, sampled smoothly (bilinear), its edge carried on; added into `into`, times `gain`, when
// it's given.
function enlarge(src: Float32Array, sw: number, sh: number, w: number, h: number, into?: Float32Array, gain = 1) {
  const X = stretchAxis(w, sw), Y = stretchAxis(h, sh), out = into ?? new Float32Array(w * h), live = liveRows(src, sw, sh), row = new Float32Array(sw + 1)
  for (let y = 0; y < h; y++) {
    const j0 = Y.i0[y], j1 = Y.i1[y], fy = Y.f[y], o = y * w
    if (!live[j0] && !live[j1]) continue
    for (let x = 0; x < sw; x++) row[x] = (src[j0 * sw + x] + (src[j1 * sw + x] - src[j0 * sw + x]) * fy) * gain
    const [lo, hi] = litSpan(row, 0, sw)
    stretchRow(out, o, row, X, Math.max(0, Math.floor((lo - 1) * w / sw)), Math.min(w, Math.ceil((hi + 2) * w / sw)), true)
  }
  return out
}

// `enlarge` a row at a time: `at(y, gain)` puts row y of the reduced plane, times `gain`, in `row` (false where it's all black), and
// column x of the full row is then row[i0[x]] + (row[i1[x]] − row[i0[x]])·f[x], what enlarge adds there.
type Stretch = { row: Float64Array; X: Axis | null; at: (y: number, gain: number) => boolean }
function stretch(src: Float32Array, sw: number, sh: number, w: number, h: number): Stretch {
  const row = new Float64Array(sw + 1)
  if (sw === w && sh === h) return { row, X: null, at: (y, gain) => { for (let x = 0, o = y * w; x < w; x++) row[x] = src[o + x] * gain; return true } }
  const X = stretchAxis(w, sw), Y = stretchAxis(h, sh), live = liveRows(src, sw, sh)
  return { row, X, at: (y, gain) => {
    const j0 = Y.i0[y], j1 = Y.i1[y], fy = Y.f[y], b0 = j0 * sw, b1 = j1 * sw
    if (!live[j0] && !live[j1]) { row.fill(0); return false }
    for (let x = 0; x < sw; x++) row[x] = Math.fround((src[b0 + x] + (src[b1 + x] - src[b0 + x]) * fy) * gain)
    return true
  } }
}

// The same into `dst`, black where it adds nothing.
function stretcher(src: Float32Array, sw: number, sh: number, w: number, h: number): Rows {
  const { row, X, at } = stretch(src, sw, sh, w, h)
  return (y, gain, dst) => {
    if (!at(y, gain)) { dst.fill(0); return false }
    if (!X) { dst.set(row.subarray(0, w)); return true }
    const [lo, hi] = litSpan(row, 0, sw), x0 = Math.min(w, Math.max(0, Math.floor((lo - 1) * w / sw))), x1 = Math.max(x0, Math.min(w, Math.ceil((hi + 2) * w / sw)))
    dst.fill(0, 0, x0); dst.fill(0, x1)
    stretchRow(dst, 0, row, X, x0, x1, false)
    return hi >= 0
  }
}

function gaussKernel(sigma: number) {
  if (sigma < 0.2) return new Float32Array([1])
  const K = Math.ceil(sigma * 3), g = new Float32Array(K * 2 + 1)
  let sum = 0
  for (let k = -K; k <= K; k++) sum += g[k + K] = Math.exp(-k * k / (2 * sigma * sigma))
  for (let k = 0; k < g.length; k++) g[k] /= sum
  return g
}

function convRows(src: Float32Array, w: number, h: number, sigma: number, clamp: boolean) {
  const g = gaussKernel(sigma), K = (g.length - 1) / 2
  if (!K) return src.slice()
  const out = new Float32Array(w * h), row = new Float32Array(w + 2 * K)
  for (let y = 0; y < h; y++) {
    const base = y * w
    const [lo, hi] = litSpan(src, base, w)
    if (hi < 0) continue
    row.fill(clamp ? src[base] : 0, 0, K); row.set(src.subarray(base, base + w), K); row.fill(clamp ? src[base + w - 1] : 0, K + w)
    const x1 = clamp ? w : Math.min(w, hi + K + 1)
    for (let x = clamp ? 0 : Math.max(0, lo - K); x < x1; x++) { let s = g[K] * row[x + K]; for (let k = 0, e = x + 2 * K; k < K; k++) s += g[k] * (row[x + k] + row[e - k]); out[base + x] = s }
  }
  return out
}

function convColumns(src: Float32Array, w: number, h: number, sigma: number, clamp: boolean) {
  const g = gaussKernel(sigma), K = (g.length - 1) / 2
  if (!K) return src
  const out = new Float32Array(w * h), live = liveRows(src, w, h)
  for (let o = 0; o < h; o++) for (let k = -K; k <= K; k++) {
    let j = o + k
    if (j < 0 || j >= h) { if (!clamp) continue; j = j < 0 ? 0 : h - 1 }
    if (!live[j]) continue
    const gk = g[k + K], ib = j * w, ob = o * w
    for (let x = 0; x < w; x++) out[ob + x] += gk * src[ib + x]
  }
  return out
}

// A Gaussian blur of one plane, `sx` pixels across and `sy` down; `clamp` carries the edge pixels on past the edge, otherwise past it
// is black. Along a wide axis it runs on a copy reduced to a few pixels per sigma and stretched back, as Core Image's own blur and
// the Mac's streaks do, so a long streak costs no more than a short one. `blurGrid` is the blurred copy before it's stretched back.
function blurGrid(src: Float32Array, w: number, h: number, sx: number, sy: number, clamp: boolean, spans?: Int32Array) {
  const qx = sx < 5 ? 1 : Math.floor(sx / 2.5), qy = sy < 5 ? 1 : Math.floor(sy / 2.5)
  const sw = qx > 1 ? Math.max(1, Math.round(w / qx)) : w, sh = qy > 1 ? Math.max(1, Math.round(h / qy)) : h, reduced = sw !== w || sh !== h
  return { data: convColumns(convRows(reduced ? resample(src, w, h, sw, sh, spans) : src, sw, sh, sx * sw / w, clamp), sw, sh, sy * sh / h, clamp), sw, sh }
}
const blurRows = (src: Float32Array, w: number, h: number, sx: number, sy: number, clamp: boolean, spans?: Int32Array) => { const { data, sw, sh } = blurGrid(src, w, h, sx, sy, clamp, spans); return stretcher(data, sw, sh, w, h) }

// The blur at full size, added into `into`, times `gain`, when it's given.
function gauss(src: Float32Array, w: number, h: number, sx: number, sy: number, clamp: boolean, into?: Float32Array, gain = 1) {
  const { data, sw, sh } = blurGrid(src, w, h, sx, sy, clamp)
  if (sw !== w || sh !== h) return enlarge(data, sw, sh, w, h, into, gain)
  if (into) addInto(into, data, gain)
  return into ?? data
}

// LensOptics.streak: blurred `along` pixels along the rows and `across` down them, black past the edges.
const streakRows = (src: Float32Array, w: number, h: number, along: number, across: number, spans?: Int32Array) => { const a = Math.max(0.5, across); return blurRows(src, w, h, Math.max(along, a), a, false, spans) }

function addInto(into: Float32Array, src: Float32Array, k = 1) { for (let i = 0; i < into.length; i++) into[i] += src[i] * k }

// A large picture's streaks are drawn on a copy reduced until their thinnest line (`thin` pixels) is under two pixels across, so the
// work stays near a 2,000-pixel picture's however large it is; they're stretched back and added to the full-size picture. `draw`
// adds its light into the planes it's given.
function streaked(f: Frame, light: Planes, thin: number, draw: (light: Planes, w: number, h: number, side: number, into: Planes) => void): Planes {
  const { w, h, side } = f, k = 1.6 / thin, out = f.lin.map(p => p.slice())
  if (k >= 0.85) { draw(light, w, h, side, out); return out }
  const sw = Math.max(1, Math.round(w * k)), sh = Math.max(1, Math.round(h * k)), small = [0, 1, 2].map(() => new Float32Array(sw * sh))
  draw(light.map(p => resample(p, w, h, sw, sh)), sw, sh, side * sw / w, small)
  small.forEach((p, c) => enlarge(p, sw, sh, w, h, out[c]))
  return out
}

// Horizontal streaks as an anamorphic lens's cylindrical glass draws them: each light throws a thin line across the frame inside a
// softer band, a white core and a veil, turning blue along its length as the coatings do. Each streak is blurred on its own reduced
// copy; they're stretched back and combined a row at a time, the rows only the veil reaches more simply.
function anamorphic(f: Frame, s: LensSettings): Planes {
  const amount = s.flareAmount / 50, blue = s.flareBlue / 100, lengths = [1 - 0.7 * blue, 1 - 0.4 * blue, 1], coat = [1 - blue * 0.9, 1 - blue * 0.62, 1]
  return streaked(f, sources(f, s.threshold / 100), Math.max(0.5, f.side * 0.0008), (lights, w, h, side, into) => {
    const reach = side * s.flareLength / 100, thin = Math.max(0.5, side * 0.0008), n = w * h, src = new Float32Array(n), spare = new Float32Array(n), small = new Float32Array(n)
    const live = new Uint8Array(h), spans = new Int32Array(2 * h), smallSpans = new Int32Array(2 * h), [rl, r1, r2, r3, rc, rv] = [0, 1, 2, 3, 4, 5].map(() => new Float64Array(w))
    lights.forEach((light, c) => {
      if (c) src.fill(0)
      gauss(light, w, h, side * 0.004, side * 0.004, true, src)
      let any = false
      for (let y = 0; y < h; y++) {
        let lo = -1, hi = -1
        for (let x = 0, i = y * w; x < w; x++, i++) { const v = src[i] = 1.6 * src[i] * (src[i] + 0.12); if (v !== 0) { if (lo < 0) lo = x; hi = x } }
        spans[2 * y] = lo < 0 ? w : lo; spans[2 * y + 1] = hi; live[y] = hi >= 0 ? 1 : 0
        if (hi >= 0) any = true
      }
      if (!any) return
      // The thin line comes from compact lights only: drawn from a big one it would be as tall as the light.
      if (c) { spare.fill(0); small.fill(0) }
      compact(src, w, h, side * 0.012, live, spare, small)
      for (let y = 0; y < h; y++) { const [lo, hi] = live[y] ? litSpan(small, y * w, w) : [w, -1]; smallSpans[2 * y] = lo; smallSpans[2 * y + 1] = hi }
      const k = coat[c], gains = [0.08, 0.3, 0.9].map((fraction, n) => [0.8, 0.35, 0.15][n] * Math.sqrt(reach * fraction * lengths[c] / (side * 0.08)) * amount), o = into[c]
      const [line, b1, b2, b3] = [streakRows(small, w, h, reach * lengths[c], thin, smallSpans), ...[0.08, 0.3, 0.9].map(fraction => streakRows(src, w, h, reach * fraction * lengths[c], side * 0.006, spans))]
      const core = streakRows(src, w, h, side * 0.015, thin * 3, spans), veil = blurRows(src, w, h, side * 0.04, side * 0.04, true, spans)
      for (let y = 0; y < h; y++) {
        const narrow = line(y, 1, rl), lit = +b1(y, gains[0], r1) | +b2(y, gains[1], r2) | +b3(y, gains[2], r3) | +core(y, 1.2 * amount, rc), far = veil(y, 0.5 * amount * k, rv)
        if (!narrow && !lit) { if (far) for (let x = 0, i = y * w; x < w; x++, i++) o[i] += Math.fround(rv[x]); continue }
        for (let x = 0, i = y * w; x < w; x++, i++) {
          const band = Math.fround(Math.fround(Math.fround(r1[x]) + r2[x]) + r3[x])
          let v = narrow ? Math.fround(k * softClip(4 * amount * Math.fround(rl[x]), 0.6)) : 0
          v = Math.fround(v + k * softClip(band, 0.7)); v = Math.fround(v + rc[x]); v = Math.fround(v + rv[x])
          o[i] += v
        }
      }
    })
  })
}

// Which 16-pixel blocks hold light, each marked with its neighbors too: a run of 16 samples, each a pixel or less from the last,
// that starts in an unmarked block reads only black.
type Blocks = { on: Uint8Array; bw: number; bh: number }
function blocksOf(w: number, h: number, mark: (raw: Uint8Array, bw: number) => void): Blocks {
  const bw = (w + 15) >> 4, bh = (h + 15) >> 4, raw = new Uint8Array(bw * bh), on = new Uint8Array(bw * bh)
  mark(raw, bw)
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) if (raw[y * bw + x]) for (let j = Math.max(0, y - 1); j <= Math.min(bh - 1, y + 1); j++) on.fill(1, j * bw + Math.max(0, x - 1), j * bw + Math.min(bw, x + 2))
  return { on, bw, bh }
}

// Where a·i + b falls within [−1, n], for each row's run of columns that can read the source.
const within = (a: number, b: number, n: number): [number, number] => Math.abs(a) < 1e-9 ? (b >= -1 && b <= n ? [-Infinity, Infinity] : [1, 0]) : a > 0 ? [(-1 - b) / a, (n - b) / a] : [(n - b) / a, (-1 - b) / a]

// `planes` (w×h) sampled into `out` (dw×dh), which is black: destination pixel (i, j) reads the source at (ax·i + bx·j + cx, ay·i + by·j
// + cy) in pixel indices, smoothly, black outside; only columns [from, to) are read, and runs that start in a black block are passed
// over. Added into `out` when `add`. Each row's first and last written columns go in `lo` and `hi` when they're given.
function warp(planes: Planes, w: number, h: number, { on, bw, bh }: Blocks, out: Planes, dw: number, dh: number, ax: number, bx: number, cx: number, ay: number, by: number, cy: number, from: number, to: number, add: boolean, lo?: Int32Array, hi?: Int32Array) {
  const [p0, p1, p2] = planes, [o0, o1, o2] = out, run = Math.max(1, Math.min(16, Math.floor(15 / Math.max(Math.abs(ax), Math.abs(ay), 1e-9)) + 1))
  for (let j = 0; j < dh; j++) {
    const [xa, xb] = within(ax, bx * j + cx, w), [ya, yb] = within(ay, by * j + cy, h), end = Math.min(dw, to, Math.ceil(Math.min(xb, yb)) + 2)
    let first = -1, last = -1
    for (let c0 = Math.max(0, from, Math.floor(Math.max(xa, ya)) - 1); c0 < end; c0 += run) {
      const X0 = ax * c0 + bx * j + cx, Y0 = ay * c0 + by * j + cy, kx = Math.min(bw - 1, Math.max(0, Math.floor(X0 / 16))), ky = Math.min(bh - 1, Math.max(0, Math.floor(Y0 / 16)))
      if (!on[ky * bw + kx]) continue
      const c1 = Math.min(end, c0 + run)
      if (first < 0) first = c0
      last = c1 - 1
      for (let i = c0; i < c1; i++) {
        const X = ax * i + bx * j + cx, Y = ay * i + by * j + cy, x0 = Math.floor(X), y0 = Math.floor(Y)
        if (x0 < -1 || x0 >= w || y0 < -1 || y0 >= h) continue
        const fx = X - x0, fy = Y - y0, o = j * dw + i
        let w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy, i00 = y0 * w + x0, i10 = i00 + 1, i01 = i00 + w, i11 = i01 + 1
        if (x0 < 0 || y0 < 0 || x0 + 1 >= w || y0 + 1 >= h) {
          if (x0 < 0 || y0 < 0) w00 = 0; if (x0 + 1 >= w || y0 < 0) w10 = 0; if (x0 < 0 || y0 + 1 >= h) w01 = 0; if (x0 + 1 >= w || y0 + 1 >= h) w11 = 0
          const xa = Math.max(0, x0), xb = Math.min(w - 1, x0 + 1), ya = Math.max(0, y0) * w, yb = Math.min(h - 1, y0 + 1) * w
          i00 = ya + xa; i10 = ya + xb; i01 = yb + xa; i11 = yb + xb
        }
        const v0 = w00 * p0[i00] + w10 * p0[i10] + w01 * p0[i01] + w11 * p0[i11], v1 = w00 * p1[i00] + w10 * p1[i10] + w01 * p1[i01] + w11 * p1[i11], v2 = w00 * p2[i00] + w10 * p2[i10] + w01 * p2[i01] + w11 * p2[i11]
        if (add) { o0[o] += Math.fround(v0); o1[o] += Math.fround(v1); o2[o] += Math.fround(v2) } else { o0[o] = v0; o1[o] = v1; o2[o] = v2 }
      }
    }
    if (lo && hi) { lo[j] = first < 0 ? dw : first; hi[j] = last }
  }
}

// One channel of one spike length, as `streak` draws it from the lights drawn out along the rows by their largest value over `size`
// (none when 0): each turned row's lit run spread, reduced along the row and blurred along it, then blurred across a few rows at a
// time and stretched back, added into `spikes` times `gain`, its rows' written spans widened in `slo`/`shi`. `R` holds the reduced rows.
function spikeLength(src: Float32Array, lo: Int32Array, hi: Int32Array, gw: number, gh: number, size: number, sx: number, sy: number, gain: number, spikes: Float32Array, slo: Int32Array, shi: Int32Array, R: Float32Array) {
  const qx = sx < 5 ? 1 : Math.floor(sx / 2.5), sw = qx > 1 ? Math.max(1, Math.round(gw / qx)) : gw, avg = sw !== gw ? averaging(gw, sw) : null, X = avg ? stretchAxis(gw, sw) : null
  const gr = gaussKernel(sx * sw / gw), Kr = (gr.length - 1) / 2, gc = gaussKernel(sy), Kc = (gc.length - 1) / 2, rr = size ? (size - 1) >> 1 : 0
  const spread = new Float32Array(gw), row = new Float32Array(sw + 2 * Kr), sum = new Float32Array(sw + 1), rlo = new Int32Array(gh), rhi = new Int32Array(gh).fill(-1)
  const p = new Float32Array(gw + 2 * rr + size), g = new Float32Array(p.length), q = new Float32Array(p.length)
  for (let y = 0; y < gh; y++) {
    const base = y * gw
    let l = lo[y], r = hi[y]
    while (l <= r && src[base + l] === 0) l++
    while (r >= l && src[base + r] === 0) r--
    if (l > r) continue
    let a = l, b = r
    if (size) {
      a = Math.max(0, l - rr); b = Math.min(gw - 1, r + rr)
      const n = b - a + 1 + 2 * rr
      p.fill(0, 0, n); p.set(src.subarray(base + l, base + r + 1), l - a + rr)
      for (let start = 0; start < n; start += size) {
        const end = Math.min(n, start + size)
        let m = g[start] = p[start]
        for (let i = start + 1; i < end; i++) { const v = p[i]; if (v > m) m = v; g[i] = m }
        m = q[end - 1] = p[end - 1]
        for (let i = end - 2; i >= start; i--) { const v = p[i]; if (v > m) m = v; q[i] = m }
      }
      for (let x = 0; x <= b - a; x++) { const u = q[x], v = g[x + size - 1]; spread[a + x] = u > v ? u : v }
    } else spread.set(src.subarray(base + l, base + r + 1), l)
    let i0 = a, i1 = b + 1
    if (avg) {
      const { from, off, wt } = avg
      i0 = Math.max(0, Math.floor(a * sw / gw) - 1); i1 = Math.min(sw, Math.ceil(b * sw / gw) + 2)
      for (let i = i0; i < i1; i++) { let s = 0; for (let k = off[i], j = from[i], e = off[i + 1]; k < e; k++, j++) s += wt[k] * spread[j]; row[Kr + i] = s }
    } else row.set(spread.subarray(a, b + 1), Kr + a)
    spread.fill(0, a, b + 1)
    const x0 = Math.max(0, i0 - Kr), x1 = Math.min(sw, i1 + Kr), o = y * sw
    // The kernel is symmetric, so each weight takes its two pixels at once.
    for (let x = x0; x < x1; x++) { let s = gr[Kr] * row[x + Kr]; for (let k = 0, e = x + 2 * Kr; k < Kr; k++) s += gr[k] * (row[x + k] + row[e - k]); R[o + x] = s }
    row.fill(0, Kr + i0, Kr + i1)
    rlo[y] = x0; rhi[y] = x1 - 1
  }
  for (let y = 0; y < gh; y++) {
    const j0 = Math.max(0, y - Kc), j1 = Math.min(gh - 1, y + Kc)
    let u0 = sw, u1 = -1
    for (let j = j0; j <= j1; j++) if (rlo[j] <= rhi[j]) { if (rlo[j] < u0) u0 = rlo[j]; if (rhi[j] > u1) u1 = rhi[j] }
    if (u1 < 0) continue
    for (let j = j0; j <= j1; j++) { const gk = gc[j - y + Kc], b = j * sw, e = rhi[j]; for (let x = rlo[j]; x <= e; x++) sum[x] += gk * R[b + x] }
    const o = y * gw
    let xs = u0, xe = u1 + 1
    if (X) {
      for (let x = u0; x <= u1; x++) sum[x] *= gain
      xs = Math.max(0, Math.floor((u0 - 1) * gw / sw)); xe = Math.min(gw, Math.ceil((u1 + 2) * gw / sw))
      stretchRow(spikes, o, sum, X, xs, xe, true)
    } else for (let x = u0; x <= u1; x++) spikes[o + x] += sum[x] * gain
    sum.fill(0, u0, u1 + 1)
    if (xs < slo[y]) slo[y] = xs
    if (xe - 1 > shi[y]) shi[y] = xe - 1
  }
}

// Thin spikes from each light, as an aperture's blades diffract it: fading quickly, a little longer in red than in blue. Each
// direction turns the lights once onto a grid along it, only as tall as the lights reach, and turns the spikes back once; only the
// rows and runs that hold light are worked, and the grids are reused between directions, cleared where they were written.
function starburst(f: Frame, s: LensSettings): Planes {
  return streaked(f, sources(f, s.threshold / 100), Math.max(0.5, f.side * 0.0006), (light, w, h, side, into) => {
    const reach = side * s.starLength / 100, thin = Math.max(0.5, side * 0.0006), rays = [0, 1, 2].map(() => new Float32Array(w * h)), [l0, l1, l2] = light
    let x0 = w, x1 = -1, y0 = h, y1 = -1
    const lit = blocksOf(w, h, (raw, bw) => {
      for (let y = 0; y < h; y++) for (let x = 0, i = y * w; x < w; x++, i++) if (l0[i] > 0 || l1[i] > 0 || l2[i] > 0) { raw[(y >> 4) * bw + (x >> 4)] = 1; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; y1 = y }
    })
    if (x1 < 0) return
    const spokes = Math.max(1, Math.floor(s.starPoints / 2)), margin = Math.ceil(3 * thin) + 3, cx = w / 2, cy = h / 2
    const grids = Array.from({ length: spokes }, (_, spoke) => {
      // Counterclockwise as on the Mac, whose rows run up: u along the spike, v across it, in rows running down.
      const theta = s.starAngle * Math.PI / 180 + spoke * Math.PI / spokes, ux = Math.cos(theta), uy = -Math.sin(theta), vx = -uy, vy = ux
      const along = [[0, 0], [w, 0], [0, h], [w, h]].map(([X, Y]) => (X - cx) * ux + (Y - cy) * uy)
      const corners = [[x0, y0], [x1 + 1, y0], [x0, y1 + 1], [x1 + 1, y1 + 1]], across = corners.map(([X, Y]) => (X - cx) * vx + (Y - cy) * vy), span = corners.map(([X, Y]) => (X - cx) * ux + (Y - cy) * uy)
      const s0 = Math.floor(Math.min(...along)) - 1, t0 = Math.floor(Math.min(...across)) - margin, gw = Math.ceil(Math.max(...along)) + 1 - s0, gh = Math.ceil(Math.max(...across)) + margin - t0
      return { ux, uy, vx, vy, s0, t0, gw, gh, from: Math.floor(Math.min(...span)) - s0 - 2, to: Math.ceil(Math.max(...span)) - s0 + 2 }
    })
    const most = Math.max(...grids.map(g => g.gw * g.gh)), tall = Math.max(...grids.map(g => g.gh)), turned = [0, 1, 2].map(() => new Float32Array(most)), spikes = [0, 1, 2].map(() => new Float32Array(most)), R = new Float32Array(most)
    const lo = new Int32Array(tall), hi = new Int32Array(tall), slo = new Int32Array(tall), shi = new Int32Array(tall)
    for (const { ux, uy, vx, vy, s0, t0, gw, gh, from, to } of grids) {
      warp(light, w, h, lit, turned, gw, gh, ux, vx, cx + (s0 + 0.5) * ux + (t0 + 0.5) * vx - 0.5, uy, vy, cy + (s0 + 0.5) * uy + (t0 + 0.5) * vy - 0.5, from, to, false, lo, hi)
      slo.fill(gw); shi.fill(-1)
      for (const [c, stretch] of [[0, 1], [1, 0.9], [2, 0.8]]) for (const [fraction, weight] of [[0.04, 1.8], [0.12, 0.9], [0.35, 0.35], [1, 0.1]]) {
        // Each light drawn out along the spike first, so a small light spikes as a big one does.
        const width = Math.max(thin * 2, reach * fraction) * 0.8, a = Math.max(0.5, thin)
        spikeLength(turned[c], lo, hi, gw, gh, width >= 3 ? Math.min(301, Math.floor(width) | 1) : 0, Math.max(Math.max(thin * 2, reach * fraction * stretch), a), a, weight * s.starAmount / 50, spikes[c], slo, shi, R)
      }
      const back = blocksOf(gw, gh, (raw, bw) => { for (let y = 0; y < gh; y++) for (let b = slo[y] >> 4; slo[y] <= shi[y] && b <= shi[y] >> 4; b++) raw[(y >> 4) * bw + b] = 1 })
      warp(spikes, gw, gh, back, rays, w, h, ux, uy, ux * (0.5 - cx) + uy * (0.5 - cy) - s0 - 0.5, vx, vy, vx * (0.5 - cx) + vy * (0.5 - cy) - t0 - 0.5, 0, w, true)
      for (let y = 0; y < gh; y++) {
        if (lo[y] <= hi[y]) for (const p of turned) p.fill(0, y * gw + lo[y], y * gw + hi[y] + 1)
        if (slo[y] <= shi[y]) for (const p of spikes) p.fill(0, y * gw + slo[y], y * gw + shi[y] + 1)
      }
    }
    rays.forEach((p, c) => addInto(into[c], p))
  })
}

// A diffusion filter, as a black mist one: a share of every pixel's light scatters into a near halo and a wide veil rather than
// being added, so bright areas soften and spill and the shadows lift a little. The brightest lights scatter a little extra.
function mist(f: Frame, s: LensSettings): Planes {
  const { w, h, side, lin } = f, scale = side * (0.2 + s.mistSize / 100 * 1.8) / 100, glow = highlights(f, 0.75), strength = s.mistStrength / 100, scatter = strength * 0.4
  const rn = new Float64Array(w), rf = new Float64Array(w), rh = new Float64Array(w)
  return lin.map((p, c) => {
    const near = blurRows(p, w, h, scale * 0.6, scale * 0.6, true), far = blurRows(p, w, h, scale * 4, scale * 4, true), halo = blurRows(glow[c], w, h, scale * 1.5, scale * 1.5, true), out = new Float32Array(p.length)
    for (let y = 0; y < h; y++) {
      near(y, 1, rn); far(y, 1, rf); halo(y, 1, rh)
      for (let x = 0, i = y * w; x < w; x++, i++) out[i] = Math.fround(rh[x]) * strength * 0.35 + Math.fround(rf[x]) * scatter * 0.4 + Math.fround(rn[x]) * scatter * 0.6 + p[i] * (1 - scatter)
    }
    return out
  })
}

// One copy's step along an axis of `n` grid pixels whose first sits at `origin` in the picture's, reading a picture `size` long moved
// by `t`: the two pixels each reads and their weights, and the run [lo, hi) where both are inside, with weights ca and cb. A step
// within a billionth of a whole pixel is taken as whole (as a 180° prism's sine leaves it), so it reads one pixel, not two.
function stepAxis(n: number, origin: number, t: number, size: number) {
  const shift = origin - t
  let k = Math.floor(shift), f = shift - k
  if (f < 1e-9) f = 0; else if (f > 1 - 1e-9) { k++; f = 0 }
  const a = new Int32Array(n), b = new Int32Array(n), wa = new Float32Array(n), wb = new Float32Array(n)
  for (let i = 0; i < n; i++) { const j = i + k; a[i] = Math.min(size - 1, Math.max(0, j)); b[i] = Math.min(size - 1, Math.max(0, j + 1)); wa[i] = j >= 0 && j < size ? 1 - f : 0; wb[i] = j + 1 >= 0 && j + 1 < size ? f : 0 }
  const lo = Math.min(n, Math.max(0, -k)), hi = Math.max(lo, Math.min(n, size - 1 - k))
  return { a, b, wa, wb, k, lo, hi, ca: Math.fround(1 - f), cb: Math.fround(f) }
}
type Step = { c: number; X: ReturnType<typeof stepAxis>; Y: ReturnType<typeof stepAxis> }
// A copy's layers and the columns where any layer's weights change, between which each layer's coverage is the same all along.
type Layers = { steps: Step[]; cuts: number[]; on: Uint8Array; ab: Float64Array; as: Float64Array; list: Int32Array }
const layered = (steps: Step[], gw: number): Layers => ({ steps, on: new Uint8Array(steps.length), ab: new Float64Array(steps.length), as: new Float64Array(steps.length), list: new Int32Array(steps.length), cuts: [...new Set([0, gw, ...steps.flatMap(({ X }) => [X.lo - 1, X.lo, X.hi, X.hi + 1])].map(x => Math.min(gw, Math.max(0, x))))].sort((a, b) => a - b) })

// A prism held before the lens: copies of the picture stepped along a line, one way or both, each fainter than the last, with a
// color fringe from the glass. Copies combine as Core Image's Lighten blend does, with their coverage, so a copy shows where it's
// brighter than what's behind it. Blur softens the copies over the area they cover, its edge carried on, as clampedToExtent does.
// Unblurred, every copy is worked a row at a time; blurred, each copy's blur is stretched back a row at a time as it's laid on.
function prism(f: Frame, s: LensSettings): Planes {
  const { w, h, side, lin } = f, theta = s.prismAngle * Math.PI / 180, dx = Math.cos(theta), dy = -Math.sin(theta), shift = side * s.prismOffset / 100
  const result = lin.map(p => p.slice()), ways = s.prismBothWays ? [1, -1] : [1], fringe = side * s.prismFringe / 10_000
  const copies = Array.from({ length: s.prismCopies }, (_, n) => {
    const copy = s.prismCopies - n, step = shift * copy, layers: { c: number; tx: number; ty: number }[] = []
    for (const way of ways) {
      if (!s.prismFringe) layers.push({ c: -1, tx: dx * step * way, ty: dy * step * way })
      else for (const [c, along] of [[0, step + fringe], [1, step], [2, step - fringe]]) layers.push({ c, tx: dx * along * way, ty: dy * along * way })
    }
    const sigma = s.prismBlur > 0 ? side * s.prismBlur / 10_000 * copy : 0
    let gx0 = 0, gy0 = 0, gw = w, gh = h
    if (sigma) {
      const m = Math.ceil(sigma * 3) + 2, xs = layers.map(l => l.tx), ys = layers.map(l => l.ty)
      gx0 = Math.floor(Math.max(Math.min(...xs), -m)); gy0 = Math.floor(Math.max(Math.min(...ys), -m))
      gw = Math.ceil(Math.min(Math.max(...xs) + w, w + m)) - gx0; gh = Math.ceil(Math.min(Math.max(...ys) + h, h + m)) - gy0
    }
    const steps = layers.map(({ c, tx, ty }) => ({ c, X: stepAxis(gw, gx0, tx, w), Y: stepAxis(gh, gy0, ty, h) }))
    return { layers: layered(steps, gw), sigma, gx0, gy0, gw, gh, fade: Math.pow(0.78, copy - 1) * s.prismAmount / 100 }
  })
  if (!s.prismBlur) {
    const ghost = [0, 1, 2, 3].map(() => new Float32Array(w))
    for (let y = 0; y < h; y++) for (const { layers, fade } of copies) {
      for (const g of ghost) g.fill(0)
      lightenRow(ghost, 0, y, lin, w, layers)
      lay(result, y * w, ghost, 0, w, fade)
    }
    return result
  }
  const most = Math.max(...copies.map(c => c.gw * c.gh)), ghost = [0, 1, 2, 3].map(() => new Float32Array(most))
  for (const { layers, sigma, gx0, gy0, gw, gh, fade } of copies) {
    for (let gy = 0; gy < gh; gy++) lightenRow(ghost, gy * gw, gy, lin, w, layers)
    const rows = ghost.map(p => blurRows(p.subarray(0, gw * gh), gw, gh, sigma, sigma, true)), back = [0, 1, 2, 3].map(() => new Float32Array(gw)), whole = gx0 <= 0 && gx0 + gw >= w
    ghost.forEach(g => g.fill(0))
    for (let y = 0; y < h; y++) {
      const gy = Math.min(gh - 1, Math.max(0, y - gy0))
      rows.forEach((r, k) => r(gy, 1, back[k]))
      if (whole) lay(result, y * w, back, -gx0, w, fade)
      else for (let x = 0; x < w; x++) lay(result, y * w + x, back, Math.min(gw - 1, Math.max(0, x - gx0)), 1, fade)
    }
  }
  return result
}

// `n` pixels of a copy's ghost (from `g0` in its rows) laid on the result (from `i0`): Lighten by its coverage, faded. The larger of
// two is taken as ½(u + v + |u − v|), which has no branch to mispredict where a copy and the picture trade places pixel by pixel.
function lay([r0, r1, r2]: Planes, i0: number, [gr, gg, gb, ga]: Planes, g0: number, n: number, fade: number) {
  for (let x = 0, i = i0, g = g0; x < n; x++, i++, g++) {
    const a = ga[g]
    if (a <= 0) continue
    const r = r0[i], gn = r1[i], b = r2[i], k = 1 - a, ur = r * a, vr = gr[g] * fade, ug = gn * a, vg = gg[g] * fade, ub = b * a, vb = gb[g] * fade
    r0[i] = r * k + 0.5 * (ur + vr + Math.abs(ur - vr)); r1[i] = gn * k + 0.5 * (ug + vg + Math.abs(ug - vg)); r2[i] = b * k + 0.5 * (ub + vb + Math.abs(ub - vb))
  }
}

// Row `gy` of a copy's layers, each one channel of the picture or all (c −1) stepped, lightened in turn over `ghost` (premultiplied
// color and coverage, the row starting at `o`, black to begin with): Core Image's Lighten, cs(1−ab) + cb(1−as) + max(cs·ab, cb·as).
// Between the cuts every layer's weights and coverage are the same all along, so the coverage behind each layer is too, and a
// channel's layers can be laid two at a time.
function lightenRow(ghost: Planes, o: number, gy: number, lin: Planes, w: number, { steps, cuts, on, ab, as, list }: Layers) {
  const alpha = ghost[3], n = steps.length
  for (let r = 0; r + 1 < cuts.length; r++) {
    const x0 = cuts[r], x1 = cuts[r + 1]
    let A = 0
    for (let l = 0; l < n; l++) {
      const { X, Y } = steps[l], wy = Y.wa[gy] + Y.wb[gy], s = wy * (X.wa[x0] + X.wb[x0])
      on[l] = wy > 0 && s > 0 ? 1 : 0
      if (!on[l]) continue
      ab[l] = A; as[l] = s; A = Math.fround(s + A - s * A)
    }
    for (let ch = 0; ch < 3; ch++) {
      let m = 0
      for (let l = 0; l < n; l++) if (on[l] && (steps[l].c < 0 || steps[l].c === ch)) list[m++] = l
      const p = lin[ch], g = ghost[ch]
      for (let t = 0; t < m;) {
        const l = list[t], st = steps[l], inside = x0 >= st.X.lo && x0 < st.X.hi, next = t + 1 < m ? steps[list[t + 1]] : null
        if (inside && next && x0 >= next.X.lo && x0 < next.X.hi) { layTwo(p, g, o, x0, x1, gy, w, st, ab[l], as[l], next, ab[list[t + 1]], as[list[t + 1]]); t += 2 }
        else { layOne(p, g, o, x0, x1, gy, w, st, inside, ab[l], as[l]); t++ }
      }
    }
    if (A) alpha.fill(A, o + x0, o + x1)
  }
}

// One layer lightened over columns [x0, x1) of one channel, its coverage behind `ab` and its own `as`.
function layOne(p: Float32Array, g: Float32Array, o: number, x0: number, x1: number, gy: number, w: number, { X, Y }: Step, inside: boolean, ab: number, as: number) {
  const wya = Y.wa[gy], wyb = Y.wb[gy], ra = Y.a[gy] * w, rb = Y.b[gy] * w, wa = X.wa[x0], wb = X.wb[x0], k = X.k, ka = 1 - ab, kb = 1 - as
  if (!inside) for (let x = x0; x < x1; x++) {
    const i = o + x, gv = g[i], xa = X.a[x], xb = X.b[x], cs = wya * (wa * p[ra + xa] + wb * p[ra + xb]) + wyb * (wa * p[rb + xa] + wb * p[rb + xb])
    const u = cs * ab, v = gv * as; g[i] = cs * ka + gv * kb + 0.5 * (u + v + Math.abs(u - v))
  }
  else if (wyb === 0) for (let x = x0, s = ra + x0 + k, i = o + x0; x < x1; x++, s++, i++) { const gv = g[i], cs = wya * (wa * p[s] + wb * p[s + 1]); const u = cs * ab, v = gv * as; g[i] = cs * ka + gv * kb + 0.5 * (u + v + Math.abs(u - v)) }
  else for (let x = x0, s = x0 + k, i = o + x0; x < x1; x++, s++, i++) { const gv = g[i], cs = wya * (wa * p[ra + s] + wb * p[ra + s + 1]) + wyb * (wa * p[rb + s] + wb * p[rb + s + 1]); const u = cs * ab, v = gv * as; g[i] = cs * ka + gv * kb + 0.5 * (u + v + Math.abs(u - v)) }
}

// Two layers in turn, both inside the picture over [x0, x1): the ghost between them rounded as it's stored.
function layTwo(p: Float32Array, g: Float32Array, o: number, x0: number, x1: number, gy: number, w: number, s1: Step, ab1: number, as1: number, s2: Step, ab2: number, as2: number) {
  const wya1 = s1.Y.wa[gy], wyb1 = s1.Y.wb[gy], ra1 = s1.Y.a[gy] * w, rb1 = s1.Y.b[gy] * w, wa1 = s1.X.wa[x0], wb1 = s1.X.wb[x0], k1 = s1.X.k, ka1 = 1 - ab1, kb1 = 1 - as1
  const wya2 = s2.Y.wa[gy], wyb2 = s2.Y.wb[gy], ra2 = s2.Y.a[gy] * w, rb2 = s2.Y.b[gy] * w, wa2 = s2.X.wa[x0], wb2 = s2.X.wb[x0], k2 = s2.X.k, ka2 = 1 - ab2, kb2 = 1 - as2
  if (wyb1 === 0 && wyb2 === 0) for (let x = x0, s = ra1 + x0 + k1, t = ra2 + x0 + k2, i = o + x0; x < x1; x++, s++, t++, i++) {
    let gv = g[i], cs = wya1 * (wa1 * p[s] + wb1 * p[s + 1])
    gv = Math.fround(cs * ka1 + gv * kb1 + Math.max(cs * ab1, gv * as1)); cs = wya2 * (wa2 * p[t] + wb2 * p[t + 1])
    const u = cs * ab2, v = gv * as2; g[i] = cs * ka2 + gv * kb2 + 0.5 * (u + v + Math.abs(u - v))
  }
  else for (let x = x0, s = x0 + k1, t = x0 + k2, i = o + x0; x < x1; x++, s++, t++, i++) {
    let gv = g[i], cs = wya1 * (wa1 * p[ra1 + s] + wb1 * p[ra1 + s + 1]) + wyb1 * (wa1 * p[rb1 + s] + wb1 * p[rb1 + s + 1])
    gv = Math.fround(cs * ka1 + gv * kb1 + Math.max(cs * ab1, gv * as1)); cs = wya2 * (wa2 * p[ra2 + t] + wb2 * p[ra2 + t + 1]) + wyb2 * (wa2 * p[rb2 + t] + wb2 * p[rb2 + t + 1])
    const u = cs * ab2, v = gv * as2; g[i] = cs * ka2 + gv * kb2 + 0.5 * (u + v + Math.abs(u - v))
  }
}

const smoothstep = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t) }

// MetalBokeh's aperture: how far `(x, y)` (in disc radii) is toward the edge, 1 on it.
function aperture(x: number, y: number, shape: number, ox: number, oy: number) {
  if (shape === 1) { const qx = Math.abs(x), qy = Math.abs(y); return Math.max(qx * 0.866025 + qy * 0.5, qy) / 0.866025 * 0.93 }
  if (shape === 2) return Math.hypot(x, y * 0.62)
  if (shape === 3) return Math.max(Math.hypot(x, y), Math.hypot(x + ox * 1.25, y + oy * 1.25))
  return Math.hypot(x, y)
}

// A disc's weights as MetalBokeh works them out, by row: equal weights in a run (the inside of a disc is all 1) summed from the
// row's running totals, the rest (its rim) one sample at a time.
type Disc = { dy: Int32Array; a: Int32Array; b: Int32Array; weight: Float32Array; run: Uint8Array; total: number; cost: number }
function discTable(radius: number, shape: number, ring: number, ox = 0, oy = 0): Disc {
  const R = Math.max(radius, 0.5), reachX = Math.ceil(R), reachY = Math.ceil(R * (shape === 2 ? 1.62 : 1)), segments: number[][] = [], row = new Float32Array(reachX * 2 + 1)
  let total = 0, cost = 0
  for (let dy = -reachY; dy <= reachY; dy++) {
    for (let dx = -reachX; dx <= reachX; dx++) {
      const d = aperture(dx / R, dy / R, shape, ox, oy), inside = 1 - smoothstep(1 - 1 / R, 1, d)
      row[dx + reachX] = inside <= 0 ? 0 : inside * (1 + ring * 2.5 * smoothstep(0.6, 0.97, d))
    }
    for (let i = 0; i < row.length;) {
      const wt = row[i]
      if (wt <= 0) { i++; continue }
      let j = i
      while (j + 1 < row.length && row[j + 1] === wt) j++
      if (j - i >= 2) { segments.push([dy, i - reachX, j - reachX, wt, 1]); cost += 1.5 }
      else for (let k = i; k <= j; k++) { segments.push([dy, k - reachX, k - reachX, wt, 0]); cost++ }
      total += wt * (j - i + 1); i = j + 1
    }
  }
  const pick = (k: number) => segments.map(s => s[k])
  return { dy: Int32Array.from(pick(0)), a: Int32Array.from(pick(1)), b: Int32Array.from(pick(2)), weight: Float32Array.from(pick(3)), run: Uint8Array.from(pick(4)), total, cost }
}

// MetalBokeh's gather: every pixel the weighted mean of the pixels around it within the aperture, the edge carried on. Cat's Eye's
// discs change shape across the frame, worked out once per 8×8 block.
function discBlur(planes: Planes, w: number, h: number, radius: number, shape: number, ring: number): Planes {
  const R = Math.max(radius, 0.5), reachX = Math.ceil(R), pw = w + reachX * 2, block = 8
  const sources = planes.map(p => {
    const V = new Float32Array(pw * h), P = new Float64Array((pw + 1) * h), lo = new Int32Array(h).fill(pw), hi = new Int32Array(h).fill(-1)
    for (let y = 0; y < h; y++) {
      let sum = 0
      for (let i = 0; i < pw; i++) {
        const v = p[y * w + Math.min(w - 1, Math.max(0, i - reachX))]
        V[y * pw + i] = v; P[y * (pw + 1) + i] = sum; sum += v
        if (v !== 0) { if (lo[y] === pw) lo[y] = i; hi[y] = i }
      }
      P[y * (pw + 1) + pw] = sum
    }
    return { V, P, lo, hi }
  })
  const fixed = shape === 3 ? null : discTable(R, shape, ring), blocks = Math.ceil(w / block), outs = planes.map(() => new Float32Array(w * h))
  let tables: Disc[] = []
  for (let y = 0; y < h; y++) {
    if (!fixed && y % block === 0) tables = Array.from({ length: blocks }, (_, bx) => {
      const mx = ((bx * block + Math.min(w, bx * block + block)) / 2 - w / 2) / (Math.max(w, h) / 2), my = ((y + Math.min(h, y + block)) / 2 - h / 2) / (Math.max(w, h) / 2), k = Math.min(1, Math.hypot(mx, my))
      return discTable(R, 3, ring, mx * k, my * k)
    })
    const o = y * w
    for (let bx = 0; bx < (fixed ? 1 : blocks); bx++) {
      const t = fixed ?? tables[bx], xs = fixed ? 0 : bx * block, xe = fixed ? w : Math.min(w, xs + block)
      planes.forEach((_, c) => {
        const { V, P, lo, hi } = sources[c], out = outs[c]
        for (let s = 0; s < t.dy.length; s++) {
          const j = Math.min(h - 1, Math.max(0, y + t.dy[s]))
          if (hi[j] < 0) continue
          const a = t.a[s], b = t.b[s], wt = t.weight[s], x0 = Math.max(xs, lo[j] - reachX - b), x1 = Math.min(xe - 1, hi[j] - reachX - a)
          if (t.run[s]) { const pb = j * (pw + 1) + reachX; for (let x = x0; x <= x1; x++) out[o + x] += wt * (P[pb + x + b + 1] - P[pb + x + a]) }
          else { const vb = j * pw + reachX + a; for (let x = x0; x <= x1; x++) out[o + x] += wt * V[vb + x] }
        }
        const scale = 1 / Math.max(t.total, 1e-5)
        for (let x = xs; x < xe; x++) out[o + x] *= scale
      })
    }
  }
  return outs
}

// What the gather may cost, in weighted samples: past it, the discs are drawn on a smaller copy and stretched back, as the Mac draws
// any disc wider than 20 pixels.
const bokehBudget = 3e8

// The blur of a lens focused elsewhere: every point spreads into a disc of the aperture's shape. In a real photo a light is far
// brighter than white, so its disc stays bright: the lights are boosted, blurred on their own and eased back.
function bokeh(f: Frame, s: LensSettings): Planes {
  const { w, h, side, lin } = f, radius = side * s.bokehRadius / 100, shape = bokehShapes.indexOf(s.bokehShape), ring = s.bokehRing / 100
  let shrink = Math.min(1, 20 / Math.max(radius, 0.5)), sw = w, sh = h
  for (let tries = 0; tries < 8; tries++) {
    sw = Math.max(1, Math.round(w * shrink)); sh = Math.max(1, Math.round(h * shrink))
    const cost = sw * sh * 6 * discTable(radius * sw / w, shape === 3 ? 0 : shape, ring).cost
    if (cost <= bokehBudget) break
    shrink *= Math.sqrt(bokehBudget / cost) * 0.97
  }
  const reduced = sw !== w || sh !== h, lights = highlights(f, 0.8, 12 + s.bokehBrightness * 0.7)
  const blurred = discBlur([...lin, ...lights].map(p => reduced ? resample(p, w, h, sw, sh) : p), sw, sh, radius * sw / w, shape, ring).map(p => reduced ? enlarge(p, sw, sh, w, h) : p)
  return [0, 1, 2].map(c => { const base = blurred[c], glow = blurred[c + 3]; for (let i = 0; i < base.length; i++) base[i] += softClip(glow[i], 0.8); return base })
}
