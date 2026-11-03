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
// offset into a buffer with `row` floats a row, and its bilinear weights, since the pixels' centers all sit on the grid alike.
function gridTaps(along: Float64Array, vx: number, vy: number, row: number) {
  const offsets = new Int32Array(along.length), weights = new Float64Array(along.length * 4)
  for (let k = 0; k < along.length; k++) {
    const tx = -vx * along[k], ty = -vy * along[k], ix = Math.floor(tx), iy = Math.floor(ty), fx = tx - ix, fy = ty - iy
    offsets[k] = iy * row + ix * 4
    weights[k * 4] = (1 - fx) * (1 - fy); weights[k * 4 + 1] = fx * (1 - fy); weights[k * 4 + 2] = (1 - fx) * fy; weights[k * 4 + 3] = fx * fy
  }
  return { offsets, weights }
}

// Each pixel's samples sit a little apart from its neighbors' (by its jitter, in this many steps), so where they're spread wide a hard
// edge fans into a smooth spectrum with a fine grain, rather than a row of separate copies.
const levels = 64
// Pixels are worked through in tiles this size, so their samples, spread over many rows, stay in the cache.
const tile = 64
const levelAt = (x: number, y: number) => Math.floor(jitterAt(x, y) * levels)

// Pixels are premultiplied 8-bit RGBA; returns a new raster the same size. `sides` are the layer's sides at the canvas's edge, which
// carry its edge pixels on rather than going clear.
export function rgbSplit(pixels: Raster, s: RGBSplitSettings, sides?: Sides): Raster {
  const { width: w, height: h } = pixels
  if (!(s.distance > 0 || s.blur > 0) || !w || !h) return pixels.clone()
  const { spectral: n, smear: m } = rgbSplitTaps(s), edges = sideBits(sides)
  const [cx, cy] = s.center, reach = Math.max(s.reach, 1), radial = s.radial, distance = s.distance, blur = s.blur
  const dx = Math.cos(s.angle * Math.PI / 180), dy = -Math.sin(s.angle * Math.PI / 180)
  // The pixels and the streaks are read as 16-bit levels, 256 to each 8-bit one: half the memory of floats, which the samples spread
  // over many rows of, and finer than the half floats the Mac keeps the streaks in.
  const source = new Uint16Array(pixels.data.length), sample = new Float64Array(4), row = w * 4
  for (let i = 0; i < source.length; i++) source[i] = pixels.data[i] * 256
  // Each streak runs both ways along the split, centered on the point, so the image smears out without shifting one way.
  const streak = new Float64Array(levels * m)
  for (let level = 0; level < levels; level++) for (let j = 0; j < m; j++) streak[level * m + j] = (j + level / levels) / m - 0.5
  const smearGrid = radial ? null : gridTaps(streak, dx * blur, dy * blur, row)
  // The streak at a point near or past the image's edges (the others are read without the edge checks, below).
  const smearAt = (ax: number, ay: number, level: number, out: Uint16Array, o: number) => {
    const vx = (radial ? (ax - cx) / reach : dx) * blur, vy = (radial ? (ay - cy) / reach : dy) * blur
    let r = 0, g = 0, b = 0, a = 0
    for (let k = level * m, end = k + m; k < end; k++) {
      tap(source, w, h, 0, 0, edges, ax - vx * streak[k], ay - vy * streak[k], sample)
      r += sample[0]; g += sample[1]; b += sample[2]; a += sample[3]
    }
    out[o] = r / m + 0.5; out[o + 1] = g / m + 0.5; out[o + 2] = b / m + 0.5; out[o + 3] = a / m + 0.5
  }
  // With blur, the streaks first, into a copy padded by the spectrum's reach; then the spectrum read from that.
  let input = source, iw = w, ih = h, origin = 0, inputSides = edges
  if (m > 1) {
    let pad = Math.ceil(rgbSplitSpread(s, 0, 0, w, h)) + 2
    const most = Math.max(maxPadded, w * h * 4)
    if ((w + pad * 2) * (h + pad * 2) > most) pad = Math.floor((Math.sqrt((w - h) ** 2 + 4 * most) - w - h) / 4)
    iw = w + pad * 2; ih = h + pad * 2
    const streaks = input = new Uint16Array(iw * ih * 4)
    for (let y0 = 0; y0 < ih; y0 += tile) for (let x0 = 0; x0 < iw; x0 += tile) for (let y = y0; y < Math.min(ih, y0 + tile); y++) for (let x = x0; x < Math.min(iw, x0 + tile); x++) {
      const sx = x - pad, sy = y - pad, ax = sx + 0.5, ay = sy + 0.5, o = (y * iw + x) * 4, level = levelAt(x, y)
      const vx = (radial ? (ax - cx) / reach : dx) * blur, vy = (radial ? (ay - cy) / reach : dy) * blur, ex = Math.abs(vx) * 0.5, ey = Math.abs(vy) * 0.5
      if (ax - ex < 0.5 || ax + ex >= w - 0.5 || ay - ey < 0.5 || ay + ey >= h - 0.5) { smearAt(ax, ay, level, streaks, o); continue }
      let r = 0, g = 0, b = 0, a = 0
      if (smearGrid) {
        const { offsets, weights } = smearGrid, at = sy * row + sx * 4
        for (let k = level * m, end = k + m; k < end; k++) {
          const p = at + offsets[k], q = p + row, w00 = weights[k * 4], w10 = weights[k * 4 + 1], w01 = weights[k * 4 + 2], w11 = weights[k * 4 + 3]
          r += source[p] * w00 + source[p + 4] * w10 + source[q] * w01 + source[q + 4] * w11
          g += source[p + 1] * w00 + source[p + 5] * w10 + source[q + 1] * w01 + source[q + 5] * w11
          b += source[p + 2] * w00 + source[p + 6] * w10 + source[q + 2] * w01 + source[q + 6] * w11
          a += source[p + 3] * w00 + source[p + 7] * w10 + source[q + 3] * w01 + source[q + 7] * w11
        }
      } else for (let k = level * m, end = k + m; k < end; k++) {
        const tx = sx - vx * streak[k], ty = sy - vy * streak[k], ix = tx | 0, iy = ty | 0, fx = tx - ix, fy = ty - iy
        const p = iy * row + ix * 4, q = p + row, w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy
        r += source[p] * w00 + source[p + 4] * w10 + source[q] * w01 + source[q + 4] * w11
        g += source[p + 1] * w00 + source[p + 5] * w10 + source[q + 1] * w01 + source[q + 5] * w11
        b += source[p + 2] * w00 + source[p + 6] * w10 + source[q + 2] * w01 + source[q + 6] * w11
        a += source[p + 3] * w00 + source[p + 7] * w10 + source[q + 3] * w01 + source[q + 7] * w11
      }
      streaks[o] = r / m + 0.5; streaks[o + 1] = g / m + 0.5; streaks[o + 2] = b / m + 0.5; streaks[o + 3] = a / m + 0.5
    }
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
  const irow = iw * 4, grid = radial ? null : gridTaps(along, dx * distance, dy * distance, irow)
  const out = new Raster(w, h, 4), data = out.data, beyond = new Uint16Array(4)
  for (let y0 = 0; y0 < h; y0 += tile) for (let x0 = 0; x0 < w; x0 += tile) for (let y = y0; y < Math.min(h, y0 + tile); y++) for (let x = x0; x < Math.min(w, x0 + tile); x++) {
    const ax = x + 0.5, ay = y + 0.5, level = levelAt(x, y), first = level * n, end = first + n
    const px = (radial ? (ax - cx) / reach : dx) * distance, py = (radial ? (ay - cy) / reach : dy) * distance, ex = Math.abs(px), ey = Math.abs(py)
    let cr = 0, cg = 0, cb = 0, ar = 0, ag = 0, ab = 0
    if (ax - ex - origin >= 0.5 && ax + ex - origin < iw - 0.5 && ay - ey - origin >= 0.5 && ay + ey - origin < ih - 0.5) {
      // Every sample inside the input: read without the edge checks.
      if (grid) {
        const { offsets, weights } = grid, at = (y - origin) * irow + (x - origin) * 4
        for (let k = first; k < end; k++) {
          const p = at + offsets[k], q = p + irow, w00 = weights[k * 4], w10 = weights[k * 4 + 1], w01 = weights[k * 4 + 2], w11 = weights[k * 4 + 3]
          const a = input[p + 3] * w00 + input[p + 7] * w10 + input[q + 3] * w01 + input[q + 7] * w11, wr = tints[k * 3], wg = tints[k * 3 + 1], wb = tints[k * 3 + 2]
          cr += wr * (input[p] * w00 + input[p + 4] * w10 + input[q] * w01 + input[q + 4] * w11)
          cg += wg * (input[p + 1] * w00 + input[p + 5] * w10 + input[q + 1] * w01 + input[q + 5] * w11)
          cb += wb * (input[p + 2] * w00 + input[p + 6] * w10 + input[q + 2] * w01 + input[q + 6] * w11)
          ar += wr * a; ag += wg * a; ab += wb * a
        }
      } else {
        const ox = ax - origin - 0.5, oy = ay - origin - 0.5
        for (let k = first; k < end; k++) {
          const tx = ox - px * along[k], ty = oy - py * along[k], ix = tx | 0, iy = ty | 0, fx = tx - ix, fy = ty - iy
          const p = iy * irow + ix * 4, q = p + irow, w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy
          const a = input[p + 3] * w00 + input[p + 7] * w10 + input[q + 3] * w01 + input[q + 7] * w11, wr = tints[k * 3], wg = tints[k * 3 + 1], wb = tints[k * 3 + 2]
          cr += wr * (input[p] * w00 + input[p + 4] * w10 + input[q] * w01 + input[q + 4] * w11)
          cg += wg * (input[p + 1] * w00 + input[p + 5] * w10 + input[q + 1] * w01 + input[q + 5] * w11)
          cb += wb * (input[p + 2] * w00 + input[p + 6] * w10 + input[q + 2] * w01 + input[q + 6] * w11)
          ar += wr * a; ag += wg * a; ab += wb * a
        }
      }
    } else for (let k = first; k < end; k++) {
      const qx = ax - px * along[k], qy = ay - py * along[k], wr = tints[k * 3], wg = tints[k * 3 + 1], wb = tints[k * 3 + 2]
      // Past a padded copy that stopped growing, the streaks where the sample lands.
      if (m > 1 && (qx < origin || qy < origin || qx > w - origin || qy > h - origin)) {
        smearAt(qx, qy, levelAt(Math.floor(qx - origin), Math.floor(qy - origin)), beyond, 0)
        sample[0] = beyond[0]; sample[1] = beyond[1]; sample[2] = beyond[2]; sample[3] = beyond[3]
      } else tap(input, iw, ih, origin, origin, inputSides, qx, qy, sample)
      cr += wr * sample[0]; cg += wg * sample[1]; cb += wb * sample[2]
      ar += wr * sample[3]; ag += wg * sample[3]; ab += wb * sample[3]
    }
    // As opaque as the most opaque channel, so each color stays within the alpha it's stored multiplied by.
    const tr = totals[level * 3] * 256, tg = totals[level * 3 + 1] * 256, tb = totals[level * 3 + 2] * 256
    const a = Math.min(255, Math.max(ar / tr, ag / tg, ab / tb)), o = (y * w + x) * 4
    data[o] = Math.round(Math.min(cr / tr, a)); data[o + 1] = Math.round(Math.min(cg / tg, a)); data[o + 2] = Math.round(Math.min(cb / tb, a)); data[o + 3] = Math.round(a)
  }
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
