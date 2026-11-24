import { Raster } from '../model/raster'
import { blurFloats } from '../model/pixels'
import { resize } from '../ai/matte'
import { call, kernelsLoaded, withBuffers } from '../kernels'

// Filter › Volumetric Light (VolumetricLight.swift and MetalVolumetricLight.swift): a light placed on the image, its beams through
// the air, and the haze it lights, thicker with distance and thinner in front of the subject, with the photo's own lights glowing into
// it. 0–100 settings as on the Mac; `color` is 0–255.
export type VolumetricSettings = { color: [number, number, number]; intensity: number; length: number; haze: number; size: number; shafts: number; distance: number; depthContrast: number; keepsSubjectClear: boolean }
export const defaultVolumetric: VolumetricSettings = { color: [255, 219, 173], intensity: 30, length: 0, haze: 60, size: 20, shafts: 0, distance: 30, depthContrast: 0, keepsSubjectClear: true }
export const isIdentityVolumetric = (s: VolumetricSettings) => s.intensity === 0 && s.haze === 0

const fullIntensity = 5, fullHaze = 1
// The scene and depth are worked out at most this many pixels across and enlarged as they're laid over the photo: they're blurred
// wide, and full-size float copies of a large photo would take gigabytes. The beams, which are soft, at most 1024.
const workSide = 2048, beamSide = 1024

// What doesn't change as the sliders move, kept between runs on the same image (VolumetricLighting.Prepared): the scene, the depth
// for Depth Contrast and Keep Subject Clear, and the beams for the light's place, Size, Length and Shafts. Start with `{}`.
export type VolumetricCache = { scene?: Kept<Scene>; depth?: Kept<Depth>; beams?: Kept<Plane> }
type Kept<T> = { key: unknown[]; value: T }
type Plane = { data: Float32Array; width: number; height: number }
type Scene = { width: number; height: number; subject: Float32Array | null; near: Float32Array; glows: Float32Array[]; ambient: Float32Array[] }
type Depth = { composed: Float32Array; distances: Uint32Array }

function cached<K extends keyof VolumetricCache>(cache: VolumetricCache, slot: K, key: unknown[], make: () => NonNullable<VolumetricCache[K]>['value']) {
  const hit = cache[slot]
  if (hit && hit.key.length === key.length && hit.key.every((v, i) => v === key[i])) return hit.value as NonNullable<VolumetricCache[K]>['value']
  const value = make()
  cache[slot] = { key, value } as VolumetricCache[K]
  return value
}

const clamp01 = (v: number) => v < 0 ? 0 : v > 1 ? 1 : v
const smoothstep = (a: number, b: number, x: number) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t) }
const fract = (v: number) => v - Math.floor(v)
const hash = (n: number) => fract(Math.sin(n * 12.9898) * 43758.5453)
// A Gaussian blur, edges held as Core Image's clampedToExtent; a wide one is worked out on a copy shrunk by up to an eighth of its
// sigma and enlarged again, which looks the same and takes a fraction of the time.
function blur(data: Float32Array, width: number, height: number, sigma: number) {
  if (sigma < 0.3) return data.slice()
  const f = Math.floor(sigma / 8)
  if (f < 2) return blurFloats(data, width, height, 1, sigma, true)
  const w = Math.max(1, Math.round(width / f)), h = Math.max(1, Math.round(height / f))
  return enlarge(blurFloats(resize(data, width, height, w, h), w, h, 1, sigma * w / width, true), w, h, width, height)
}
// matte.resize's enlargement, the same sums, each source row blended across once for all the rows of the output between it and the next.
function enlarge(source: Float32Array, width: number, height: number, toWidth: number, toHeight: number) {
  if (width === toWidth && height === toHeight) return source
  const out = new Float32Array(toWidth * toHeight), sx = width / toWidth, sy = height / toHeight, x0 = new Int32Array(toWidth), x1 = new Int32Array(toWidth), tx = new Float32Array(toWidth)
  for (let x = 0; x < toWidth; x++) { const fx = Math.min(width - 1, Math.max(0, (x + 0.5) * sx - 0.5)); x0[x] = Math.floor(fx); x1[x] = Math.min(width - 1, x0[x] + 1); tx[x] = fx - x0[x] }
  const rows = [new Float32Array(toWidth), new Float32Array(toWidth)], held = [-1, -1]
  const row = (y: number, keep: number) => {
    let k = held[0] === y ? 0 : held[1] === y ? 1 : -1
    if (k >= 0) return rows[k]
    k = held[0] === keep ? 1 : 0; held[k] = y
    const r = rows[k], from = y * width
    for (let x = 0; x < toWidth; x++) r[x] = source[from + x0[x]] * (1 - tx[x]) + source[from + x1[x]] * tx[x]
    return r
  }
  for (let y = 0, o = 0; y < toHeight; y++, o += toWidth) {
    const fy = Math.min(height - 1, Math.max(0, (y + 0.5) * sy - 0.5)), y0 = Math.floor(fy), y1 = Math.min(height - 1, y0 + 1), ty = fy - y0, top = row(y0, y1), bottom = row(y1, y0)
    for (let x = 0; x < toWidth; x++) out[o + x] = top[x] * (1 - ty) + bottom[x] * ty
  }
  return out
}
// Each 8-bit value unpremultiplied by each alpha, value + alpha × 256, as the haze works it out per pixel.
const unpremultiplied = Float64Array.from({ length: 65536 }, (_, i) => Math.max(0, (i & 255) / 255 / ((i >> 8) / 255)))
const linear = (v: number) => v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
// Interpolated table for exp(-x) over [0, 16]: max error < 1e-6, avoids millions of Math.exp calls per slider drag.
const expSteps = 4096, expMax = 16, expScale = expSteps / expMax
const expTable = Float32Array.from({ length: expSteps + 2 }, (_, i) => Math.exp(-i / expScale))
const expNeg = (x: number) => {
  if (x <= 0) return 1
  if (x >= expMax) return 0
  const u = x * expScale, i = u | 0
  return expTable[i] + (expTable[i + 1] - expTable[i]) * (u - i)
}
const workSize = (width: number, height: number, limit: number) => { const k = Math.min(1, limit / Math.max(width, height)); return [Math.max(1, Math.round(width * k)), Math.max(1, Math.round(height * k))] }
const unit = (bytes: Uint8Array) => { const out = new Float32Array(bytes.length); for (let i = 0; i < out.length; i++) out[i] = bytes[i] / 255; return out }
const channel = (pixels: Raster, c: number) => { const out = new Float32Array(pixels.width * pixels.height); for (let i = 0; i < out.length; i++) out[i] = pixels.data[i * 4 + c] / 255; return out }

// Bilinear lookups from a `width`×`height` plane onto `toWidth`×`toHeight`, pixel centers onto pixel centers, as matte.resize enlarges.
function axis(from: number, to: number) {
  const lo = new Int32Array(to), hi = new Int32Array(to), t = new Float32Array(to)
  for (let i = 0; i < to; i++) { const f = Math.min(from - 1, Math.max(0, (i + 0.5) * from / to - 0.5)); lo[i] = Math.floor(f); hi[i] = Math.min(from - 1, lo[i] + 1); t[i] = f - lo[i] }
  return { lo, hi, t }
}

// `pixels` (premultiplied RGBA) with the light at `center`, in its pixels (rows down). `depth`: width × height, 1 nearest and 0
// farthest, as the Mac's DepthMap (null guesses from where each pixel sits, as the Mac does without its model); `subject`: 0–255 over
// the subject, or null.
export function volumetricLight(pixels: Raster, depth: Float32Array | null, subject: Uint8Array | null, s: VolumetricSettings, center: [number, number], cache: VolumetricCache = {}): Raster {
  if (isIdentityVolumetric(s)) return pixels.clone()
  const { width, height } = pixels, side = Math.max(width, height), src = pixels.data
  const scene = cached(cache, 'scene', [pixels, pixels.version, subject], () => makeScene(pixels, subject))
  const sw = scene.width, sh = scene.height
  const composed = depth ? cached(cache, 'depth', [depth, subject, width, height, s.depthContrast, s.keepsSubjectClear], () => makeDepth(resize(depth, width, height, sw, sh), scene.subject, sw, sh, s)) : null
  const beams = s.intensity > 0 ? cached(cache, 'beams', [pixels, pixels.version, subject, center[0], center[1], s.size, s.length, s.shafts], () => makeBeams(pixels, subject, center, s)) : null
  const [start, rampEnd] = ramp(s.distance, composed?.distances ?? null), end = Math.max(rampEnd, start + 0.01)
  const tint = s.color.map(c => linear(clamp01(c / 255))), strength = s.intensity / 100 * fullIntensity, haze = s.haze / 100 * fullHaze
  const sx = axis(sw, width), sy = axis(sh, height), bx = beams && axis(beams.width, width), by = beams && axis(beams.height, height)
  // A scene worked out at the photo's size is read straight, as the lookups would land on its pixels.
  const out = new Raster(width, height, 4), dst = out.data, direct = sw === width && sh === height, { near, glows, ambient } = scene, depthAt = composed?.composed
  const [g0, g1, g2] = glows, [a0, a1, a2] = ambient, [t0, t1, t2] = tint
  const fog0 = 1 - Math.exp(-3 * haze * 0.12), fog1 = 1 - Math.exp(-3 * haze), invRadius = 1 / (side * 0.35), invSpan = 1 / (end - start)
  const beamData = beams?.data, beamW = beams?.width ?? 0, hasBeams = !!(beams && bx && by && strength > 0)
  const k0 = (1 + (t0 - 1) * 0.6) * 0.9, k1 = (1 + (t1 - 1) * 0.6) * 0.9, k2 = (1 + (t2 - 1) * 0.6) * 0.9
  const s0 = t0 * strength * 0.5, s1 = t1 * strength * 0.5, s2 = t2 * strength * 0.5
  const hazeBloom = haze * 1.6, fogCoeff = 3 * haze, c0 = center[0], c1 = center[1]
  for (let y = 0, i = 0; y < height; y++) {
    const down = (y + 0.5) / height, r0 = sy.lo[y] * sw, r1 = sy.hi[y] * sw, ty = sy.t[y], dy = y + 0.5 - c1, dy2 = dy * dy
    const q0 = by ? by.lo[y] * beamW : 0, q1 = by ? by.hi[y] * beamW : 0, bty = by ? by.t[y] : 0
    const guessBase = 1 - smoothstep(0.45, 1.05, down)
    for (let x = 0; x < width; x++, i++) {
      const o = i * 4, alpha = src[o + 3]
      if (alpha === 0) { dst[o] = src[o]; dst[o + 1] = src[o + 1]; dst[o + 2] = src[o + 2]; continue }
      let front: number, far: number, air0: number, air1: number, air2: number, bl0: number, bl1: number, bl2: number
      if (direct) {
        const nf = near[i]; front = nf < 0 ? 0 : nf > 1 ? 1 : nf
        if (depthAt) { const df = depthAt[i]; far = 1 - (df < 0 ? 0 : df > 1 ? 1 : df) } else far = guessBase * (1 - 0.8 * front)
        air0 = a0[i]; if (air0 < 0) air0 = 0; air1 = a1[i]; if (air1 < 0) air1 = 0; air2 = a2[i]; if (air2 < 0) air2 = 0
        bl0 = g0[i]; if (bl0 < 0) bl0 = 0; bl1 = g1[i]; if (bl1 < 0) bl1 = 0; bl2 = g2[i]; if (bl2 < 0) bl2 = 0
      } else {
        const ia = r0 + sx.lo[x], ib = r0 + sx.hi[x], ic = r1 + sx.lo[x], id = r1 + sx.hi[x], tx = sx.t[x], omt = 1 - tx, omy = 1 - ty
        const nf = (near[ia] * omt + near[ib] * tx) * omy + (near[ic] * omt + near[id] * tx) * ty
        front = nf < 0 ? 0 : nf > 1 ? 1 : nf
        if (depthAt) {
          const df = (depthAt[ia] * omt + depthAt[ib] * tx) * omy + (depthAt[ic] * omt + depthAt[id] * tx) * ty
          far = 1 - (df < 0 ? 0 : df > 1 ? 1 : df)
        } else far = guessBase * (1 - 0.8 * front)
        air0 = (a0[ia] * omt + a0[ib] * tx) * omy + (a0[ic] * omt + a0[id] * tx) * ty; if (air0 < 0) air0 = 0
        air1 = (a1[ia] * omt + a1[ib] * tx) * omy + (a1[ic] * omt + a1[id] * tx) * ty; if (air1 < 0) air1 = 0
        air2 = (a2[ia] * omt + a2[ib] * tx) * omy + (a2[ic] * omt + a2[id] * tx) * ty; if (air2 < 0) air2 = 0
        bl0 = (g0[ia] * omt + g0[ib] * tx) * omy + (g0[ic] * omt + g0[id] * tx) * ty; if (bl0 < 0) bl0 = 0
        bl1 = (g1[ia] * omt + g1[ib] * tx) * omy + (g1[ic] * omt + g1[id] * tx) * ty; if (bl1 < 0) bl1 = 0
        bl2 = (g2[ia] * omt + g2[ib] * tx) * omy + (g2[ic] * omt + g2[id] * tx) * ty; if (bl2 < 0) bl2 = 0
      }
      const dx = x + 0.5 - c0, glow = expNeg(Math.sqrt(dx * dx + dy2) * invRadius) * 0.45
      let u = (far - start) * invSpan; if (u < 0) u = 0; else if (u > 1) u = 1
      const r = u * u * (3 - 2 * u)
      const fog = r === 0 ? fog0 : r === 1 ? fog1 : 1 - expNeg(fogCoeff * (0.12 + 0.88 * r))
      const bloomScale = hazeBloom * (0.3 + 0.7 * r), aShift = alpha << 8
      let b0 = unpremultiplied[aShift | src[o]], b1 = unpremultiplied[aShift | src[o + 1]], b2 = unpremultiplied[aShift | src[o + 2]]
      let v0 = b0 + (air0 * k0 + t0 * glow - b0) * fog + bl0 * bloomScale
      let v1 = b1 + (air1 * k1 + t1 * glow - b1) * fog + bl1 * bloomScale
      let v2 = b2 + (air2 * k2 + t2 * glow - b2) * fog + bl2 * bloomScale
      if (hasBeams) {
        const btx = bx!.t[x], bmx = 1 - btx, blo = bx!.lo[x], bhi = bx!.hi[x]
        const beam = (beamData![q0 + blo] * bmx + beamData![q0 + bhi] * btx) * (1 - bty) + (beamData![q1 + blo] * bmx + beamData![q1 + bhi] * btx) * bty
        if (beam > 0) {
          const bs = beam * (1 - 0.92 * front)
          v0 = 1 - (1 - (v0 < 1 ? v0 : 1)) * expNeg(s0 * bs)
          v1 = 1 - (1 - (v1 < 1 ? v1 : 1)) * expNeg(s1 * bs)
          v2 = 1 - (1 - (v2 < 1 ? v2 : 1)) * expNeg(s2 * bs)
        }
      }
      dst[o] = (v0 <= 0 ? 0 : v0 >= 1 ? 1 : v0) * alpha + 0.5
      dst[o + 1] = (v1 <= 0 ? 0 : v1 >= 1 ? 1 : v1) * alpha + 0.5
      dst[o + 2] = (v2 <= 0 ? 0 : v2 >= 1 ? 1 : v2) * alpha + 0.5
      dst[o + 3] = alpha
    }
  }
  return out
}

// The photo's own lights glowing into the haze, each in its own color; the air lit by the scene, spread wide; and how near the
// subject each pixel is. A light is what's brighter than half white and than half again the light around it.
function makeScene(pixels: Raster, subject: Uint8Array | null): Scene {
  const { width: W, height: H } = pixels, [width, height] = workSize(W, H, workSide), side = Math.max(width, height)
  const glows: Float32Array[] = [], ambient: Float32Array[] = []
  for (let c = 0; c < 3; c++) {
    const plane = resize(channel(pixels, c), W, H, width, height), surround = blur(plane, width, height, side * 0.04), lights = new Float32Array(plane.length)
    for (let i = 0; i < plane.length; i++) lights[i] = Math.max(0, plane[i] - Math.max(0.5, surround[i] * 1.5))
    const halo = blur(lights, width, height, side * 0.012), bloom = blur(lights, width, height, side * 0.05)
    for (let i = 0; i < halo.length; i++) halo[i] += bloom[i] * 2
    glows.push(halo); ambient.push(blur(plane, width, height, side * 0.12))
  }
  const mask = subject ? resize(unit(subject), W, H, width, height) : null
  return { width, height, subject: mask, near: mask ? blur(mask, width, height, Math.max(1, side * 0.003)) : new Float32Array(width * height), glows, ambient }
}

// Smooth noise around the light, one value per `cells` around the circle, the noise at each cell looked up from `noise(cells, seed)`.
const noise = (cells: number, seed: number) => Float64Array.from({ length: cells + 1 }, (_, m) => hash(m - 1 + seed))
function around(angle: number, cells: number, values: Float64Array) {
  const u = (angle / 6.2831853 + 0.5) * cells, i = Math.floor(u), f0 = u - i, f = f0 * f0 * (3 - 2 * f0), a = values[(i % cells) + 1]
  return a + (values[((i + 1) % cells) + 1] - a) * f
}

// The beams (volumetricBeams), worked out at half size as on the Mac, at most `beamSide` across. What gives off light at each pixel:
// the light itself, a soft disc, mostly where the photo is light enough to let it through, and its bright openings, more near the
// light; the subject blocks both and the shafts break them up around it. Each pixel then gathers that along the line back toward
// the light, so what blocks it casts shafts of shadow through the beams.
function makeBeams(pixels: Raster, subject: Uint8Array | null, center: [number, number], s: VolumetricSettings): Plane {
  const { width, height } = pixels, count = width * height, side = Math.max(width, height), src = pixels.data
  const scale = Math.min(0.5, beamSide / side), bw = Math.max(1, Math.ceil(width * scale)), bh = Math.max(1, Math.ceil(height * scale))
  const luma = new Float32Array(count)
  for (let i = 0; i < count; i++) luma[i] = (0.2126 * src[i * 4] + 0.7152 * src[i * 4 + 1] + 0.0722 * src[i * 4 + 2]) / 255
  // The photo's brightest, lightly blurred so one hot pixel doesn't set it, to tell its openings by.
  let peak = 0
  const [pw, ph] = workSize(width, height, workSide)
  const peakBuf = blur(resize(channel(pixels, 1), width, height, pw, ph), pw, ph, 2 * pw / width)
  for (let i = 0; i < peakBuf.length; i++) if (peakBuf[i] > peak) peak = peakBuf[i]
  const brightest = Math.max(0.05, peak), small = resize(luma, width, height, bw, bh), blocked = subject ? resize(unit(subject), width, height, bw, bh) : null
  const bside = side * scale, size = Math.max(1, bside * (0.02 + s.size / 100 * 0.4)), shafts = s.shafts / 100, lx = center[0] * scale, ly = center[1] * scale
  // Kept at float precision, in doubles, which the gathering below reads quicker.
  const emission = new Float64Array(bw * bh), fine = noise(97, 3.1), broad = noise(251, 7.7)
  for (let y = 0, i = 0; y < bh; y++) for (let x = 0; x < bw; x++, i++) {
    const bright = clamp01(small[i] / brightest), dx = x + 0.5 - lx, dy = y + 0.5 - ly, d = Math.hypot(dx, dy)
    const open = clamp01((bright - 0.08) / 0.3), disc = Math.exp(-2 * (d / size) * (d / size)), openings = clamp01((bright - 0.45) / 0.45) * Math.exp(-d / (bside * 0.5))
    const angle = shafts ? Math.atan2(dy, dx) : 0, wave = shafts ? 0.6 * around(angle, 97, fine) + 0.4 * around(angle, 251, broad) : 0
    emission[i] = Math.fround((disc * (0.25 + 0.75 * open) + openings) * (1 - (blocked ? blocked[i] : 0)) * (1 - shafts + shafts * wave * wave * 1.8))
  }
  const samples = 96, length = s.length / 100, gathered = new Float32Array(bw * bh), weight = new Float64Array(samples)
  const sample = (px: number, py: number) => {
    const fx = Math.min(bw - 1, Math.max(0, px - 0.5)), fy = Math.min(bh - 1, Math.max(0, py - 0.5)), x0 = Math.floor(fx), y0 = Math.floor(fy)
    const a = y0 * bw + x0, b = y0 * bw + Math.min(bw - 1, x0 + 1), c = Math.min(bh - 1, y0 + 1) * bw + x0, d = Math.min(bh - 1, y0 + 1) * bw + Math.min(bw - 1, x0 + 1), tx = fx - x0, ty = fy - y0
    return (emission[a] * (1 - tx) + emission[b] * tx) * (1 - ty) + (emission[c] * (1 - tx) + emission[d] * tx) * ty
  }
  const within = (px: number, py: number) => px - 0.5 >= 0 && px - 0.5 < bw - 1 && py - 0.5 >= 0 && py - 0.5 < bh - 1
  let weights = 0
  for (let k = 0, w = 1; k < samples; k++, w *= 0.985) { weight[k] = w; weights += w }
  if (kernelsLoaded() && bw * bh >= 4096) {
    const emissionF = Float32Array.from(emission), weightF = Float32Array.from(weight)
    withBuffers([{ data: emissionF }, { data: gathered, out: true }, { data: weightF }], ([e, g, w]) =>
      call('web_volumetric_gather', e, g, w, bw, bh, lx, ly, length, samples))
    return { data: blur(gathered, bw, bh, scale * 2), width: bw, height: bh }
  }
  for (let y = 0, i = 0; y < bh; y++) for (let x = 0; x < bw; x++, i++) {
    // With no Length every sample lands on the pixel itself.
    if (length === 0) { gathered[i] = emission[i] * weights / samples * 4; continue }
    const hx = x + 0.5, hy = y + 0.5, stepX = (lx - hx) * length / samples, stepY = (ly - hy) * length / samples, jitter = hash(x * 0.618 + y * 1.414)
    let sum = 0
    // The samples run in a line, so when both ends need no clamping none between do, and they're read straight.
    if (within(hx + stepX * jitter, hy + stepY * jitter) && within(hx + stepX * (samples - 1 + jitter), hy + stepY * (samples - 1 + jitter))) for (let k = 0; k < samples; k++) {
      const t = k + jitter, fx = hx + stepX * t - 0.5, fy = hy + stepY * t - 0.5, x0 = fx | 0, y0 = fy | 0, j = y0 * bw + x0, tx = fx - x0, ty = fy - y0
      sum += ((emission[j] * (1 - tx) + emission[j + 1] * tx) * (1 - ty) + (emission[j + bw] * (1 - tx) + emission[j + bw + 1] * tx) * ty) * weight[k]
    }
    else for (let k = 0; k < samples; k++) sum += sample(hx + stepX * (k + jitter), hy + stepY * (k + jitter)) * weight[k]
    gathered[i] = sum / samples * 4
  }
  return { data: blur(gathered, bw, bh, scale * 2), width: bw, height: bh }
}

// The depth spread `amount` of the way (0–1) to equalized, each value toward its rank among them all (DepthMap.equalized), ranked
// through a fine histogram rather than a sort, so depths the model bunched together come apart into steps.
const bins = 65536
function histogram(values: Float32Array) {
  const counts = new Uint32Array(bins)
  for (let i = 0; i < values.length; i++) {
    const v = values[i], c = v < 0 ? 0 : v > 1 ? 1 : v, b = (c * bins) | 0
    counts[b < bins ? b : bins - 1]++
  }
  return counts
}
export function equalized(values: Float32Array, amount: number): Float32Array {
  if (amount <= 0 || values.length < 2) return values
  const counts = histogram(values), before = new Float64Array(bins), last = values.length - 1, out = new Float32Array(values.length)
  for (let b = 1; b < bins; b++) before[b] = before[b - 1] + counts[b - 1]
  for (let i = 0; i < values.length; i++) {
    const v = values[i], at = clamp01(v) * bins, b = Math.min(bins - 1, Math.floor(at)), rank = before[b] + Math.max(0, Math.min(counts[b] - 1, (at - b) * counts[b]))
    out[i] = v + (rank / last - v) * amount
  }
  return out
}

// Where the haze begins and where it's full, as distance (0 nearest, 1 farthest), for Distance (VolumetricLighting.ramp): read off the
// photo's own spread of distances (their histogram) when there's depth, so the same Distance clears the same share of any scene;
// otherwise as the guess runs. Always over a wide stretch, so a soft edge in the depth stays a soft edge in the haze.
export function ramp(distance: number, distances: Uint32Array | null): [number, number] {
  const share = distance / 100
  if (!distances) return [share * 0.6, share * 0.6 + 0.5]
  let total = 0
  for (const c of distances) total += c
  const at = (part: number) => {
    const target = Math.floor(Math.max(0, part) * (total - 1))
    for (let b = 0, seen = 0; b < bins; b++) { seen += distances[b]; if (seen > target) return (b + 0.5) / bins }
    return 1
  }
  const start = Math.min(at(share), 0.9)
  return [start, Math.max(at(Math.min(1, share + 0.45)), start + 0.45)]
}

// The depth the haze goes by, 1 near and 0 far (VolumetricLighting.composedDepth), all at `width`×`height`. The model's map is soft at
// the subject's edge, its nearness bleeding into a band around it, so there the band takes the depth of the backdrop just beyond it,
// averaged from around it; inside the subject it's held near (Keep Subject Clear) or at its own depth averaged over it. The subject's
// outline is made crisp first (`firmed`), so the haze meets it cleanly.
export function composedDepth(depth: Float32Array, subject: Float32Array | null, width: number, height: number, keepsSubjectClear: boolean): Float32Array {
  const side = Math.max(width, height), count = width * height, near = blur(depth, width, height, side * 0.0015)
  if (!subject) return near
  const mask = blur(subject, width, height, Math.max(1, side * 0.0015)), reach = side * 0.02
  for (let i = 0; i < count; i++) mask[i] = clamp01(mask[i] * 2.5 - 1.1)
  const beyond = blur(mask, width, height, reach), product = new Float32Array(count)
  for (let i = 0; i < count; i++) { beyond[i] = clamp01(1 - 6 * beyond[i]); product[i] = near[i] * beyond[i] }
  const weighted = blur(product, width, height, reach * 2.5), spread = blur(beyond, width, height, reach * 2.5), closeness = blur(mask, width, height, reach * 1.5)
  let inside: Float32Array
  if (keepsSubjectClear) inside = near.map(v => Math.max(0.9, Math.min(1, v)))
  else {
    const span = side * 0.08
    for (let i = 0; i < count; i++) product[i] = near[i] * mask[i]
    const sum = blur(product, width, height, span), cover = blur(mask, width, height, span)
    inside = new Float32Array(count)
    for (let i = 0; i < count; i++) inside[i] = clamp01(sum[i] / clamp01(cover[i] + 0.001))
  }
  const out = new Float32Array(count)
  for (let i = 0; i < count; i++) {
    const behind = weighted[i] / clamp01(spread[i] + 0.001), k = clamp01(closeness[i] * 4), aroundIt = near[i] + (behind - near[i]) * k
    out[i] = aroundIt + (inside[i] - aroundIt) * mask[i]
  }
  return out
}

function makeDepth(depth: Float32Array, subject: Float32Array | null, width: number, height: number, s: VolumetricSettings): Depth {
  const spread = equalized(depth, s.depthContrast / 100), distances = new Float32Array(spread.length)
  for (let i = 0; i < spread.length; i++) distances[i] = 1 - spread[i]
  return { composed: composedDepth(spread, subject, width, height, s.keepsSubjectClear), distances: histogram(distances) }
}

// Extract Depth's layer: the depth the haze goes by, as opaque gray the image's size, white near and black far (depthMap).
export function depthPicture(depth: Float32Array, subject: Uint8Array | null, width: number, height: number, s: VolumetricSettings): Raster {
  const [sw, sh] = workSize(width, height, workSide), mask = subject ? resize(unit(subject), width, height, sw, sh) : null
  const map = resize(composedDepth(equalized(resize(depth, width, height, sw, sh), s.depthContrast / 100), mask, sw, sh, s.keepsSubjectClear), sw, sh, width, height), out = new Raster(width, height, 4)
  for (let i = 0; i < map.length; i++) { const v = Math.round(clamp01(map[i]) * 255); out.data[i * 4] = out.data[i * 4 + 1] = out.data[i * 4 + 2] = v; out.data[i * 4 + 3] = 255 }
  return out
}

// Where the light starts: in the biggest bright area (a window, the sky, a beam), at its brightest, in the pixels (rows down)
// (VolumetricLighting.brightestPoint). Areas are the connected parts of a 64-pixel copy near its top brightness, each weighed by its
// size and brightness, so a wide opening wins over a smaller, hotter patch.
export function brightestPoint(pixels: Raster): [number, number] {
  const { width: W, height: H } = pixels, side = 64, center: [number, number] = [W / 2, H / 2]
  const width = Math.max(1, W >= H ? side : Math.floor(side * W / Math.max(1, H))), height = Math.max(1, H >= W ? side : Math.floor(side * H / Math.max(1, W)))
  const luma = new Float32Array(W * H)
  for (let i = 0; i < luma.length; i++) luma[i] = 0.2126 * pixels.data[i * 4] + 0.7152 * pixels.data[i * 4 + 1] + 0.0722 * pixels.data[i * 4 + 2]
  // Lightly smoothed, so a speck doesn't count as an area.
  const gray = resize(luma, W, H, width, height), bright = new Float32Array(width * height)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let sum = 0, n = 0
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const sx = x + dx, sy = y + dy; if (sx >= 0 && sy >= 0 && sx < width && sy < height) { sum += gray[sy * width + sx]; n++ } }
    bright[y * width + x] = sum / n
  }
  let peak = 0
  for (const v of bright) if (v > peak) peak = v
  if (!(peak > 0)) return center
  const threshold = peak * 0.75, area = new Int32Array(width * height).fill(-1)
  let best = { score: -1, at: 0 }
  for (let start = 0; start < bright.length; start++) {
    if (bright[start] < threshold || area[start] >= 0) continue
    const stack = [start]
    let score = 0, brightest = start
    area[start] = start
    while (stack.length) {
      const index = stack.pop()!, x = index % width, y = (index - x) / width
      score += bright[index]
      if (bright[index] > bright[brightest]) brightest = index
      for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue
        const next = ny * width + nx
        if (area[next] < 0 && bright[next] >= threshold) { area[next] = start; stack.push(next) }
      }
    }
    if (score > best.score) best = { score, at: brightest }
  }
  return [(best.at % width + 0.5) * W / width, (Math.floor(best.at / width) + 0.5) * H / height]
}
