import { Raster } from '../model/raster'
import { blurFloats } from '../model/pixels'

// Filter › Rim Light (RimLight.swift, MetalRimLight.swift): up to three lights behind the subject that catch its edges, lit the way
// games light flat sprites. The outline is rounded into a surface that faces sideways at the edge and the camera a light's Width in,
// the photo's fine detail is pressed in as bumps, and each light, from a little behind, brightens what faces it. Glow lays the rims'
// light in the air around the subject. The Mac finds the subject with Vision; here it's `subject` when given, else the layer's alpha.

// A light: where it comes from in degrees counterclockwise from the right, its color (0–255), and Strength, Width and Choke, 0–100.
export type RimLight = { angle: number; color: [number, number, number]; strength: number; width: number; choke: number }
export type RimLightSettings = { lights: RimLight[]; glow: number }
export const maximumRimLights = 3
export const newRimLight = (): RimLight => ({ angle: 135, color: [255, 219, 179], strength: 50, width: 30, choke: 0 })
export const defaultRimLight: RimLightSettings = { lights: [newRimLight()], glow: 10 }

// What the next added light starts as: from the side across from the last, a cool one across from the first, then white.
export function nextRimLight(s: RimLightSettings): RimLight {
  const last = s.lights[s.lights.length - 1], colors: [number, number, number][] = [[179, 214, 255], [255, 255, 255]]
  return { angle: last ? (last.angle > 0 ? last.angle - 180 : last.angle + 180) : 135, color: colors[Math.min(Math.max(s.lights.length - 1, 0), 1)], strength: 50, width: last?.width ?? 30, choke: last?.choke ?? 0 }
}

export const rimLightIsIdentity = (s: RimLightSettings) => s.lights.every(l => l.strength === 0)
const clamp = (v: number, lo: number, hi: number, fallback: number) => Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback
export function normalizedRimLight(s: RimLightSettings): RimLightSettings {
  return { glow: clamp(s.glow, 0, 100, 10), lights: s.lights.slice(0, maximumRimLights).map(l => ({ angle: clamp(l.angle, -180, 180, 135), color: l.color.map(c => clamp(c, 0, 255, 255)) as [number, number, number], strength: clamp(l.strength, 0, 100, 50), width: clamp(l.width, 0, 100, 30), choke: clamp(l.choke, 0, 100, 0) })) }
}

// The rim's width as a share of the image's longer side; a light's brightness at Strength 100; the glow at Glow 100.
const widthShare = (width: number) => 0.002 + width / 100 * 0.03
const fullStrength = 10, fullGlow = 4

const decode = (v: number) => v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
const encode = (v: number) => v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055
const lumaWeights = [0.2126, 0.7152, 0.0722], toLinear = Float32Array.from({ length: 256 }, (_, i) => decode(i / 255))
// Each 8-bit value unpremultiplied by each alpha, value + alpha × 256.
const straight = Uint8Array.from({ length: 65536 }, (_, i) => i >> 8 ? Math.min(255, Math.round((i & 255) * 255 / (i >> 8))) : 0)
const smoothstep = (e0: number, e1: number, x: number) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t) }

// The inverse of the error function (Giles's approximation), for how far into a blurred edge a level lies.
function inverseError(x: number) {
  let w = -Math.log((1 - x) * (1 + x)), p
  if (w < 5) {
    w -= 2.5
    p = 2.81022636e-08; p = 3.43273939e-07 + p * w; p = -3.5233877e-06 + p * w; p = -4.39150654e-06 + p * w; p = 0.00021858087 + p * w
    p = -0.00125372503 + p * w; p = -0.00417768164 + p * w; p = 0.246640727 + p * w; p = 1.50140941 + p * w
  } else {
    w = Math.sqrt(w) - 3
    p = -0.000200214257; p = 0.000100950558 + p * w; p = 0.00134934322 + p * w; p = -0.00367342844 + p * w; p = 0.00573950773 + p * w
    p = -0.0076224613 + p * w; p = 0.00943887047 + p * w; p = 1.00167406 + p * w; p = 2.83297682 + p * w
  }
  return p * x
}

// A Gaussian blur of one channel with clamped edges, as Core Image's `clampedToExtent` blur. A wide one runs on a copy reduced by a
// fifth of its sigma and is enlarged again smoothly, which it can't tell from the full-size blur.
function blur(data: Float32Array, w: number, h: number, sigma: number): Float32Array {
  if (sigma < 0.3) return data
  const f = sigma >= 10 ? Math.floor(sigma / 5) : 1
  if (f === 1) return blurFloats(data, w, h, 1, sigma, true)
  const sw = Math.ceil(w / f), sh = Math.ceil(h / f), small = new Float32Array(sw * sh)
  // Each cell summed a row at a time, left to right, at the float precision it's kept in.
  for (let y = 0; y < h; y++) for (let X = 0, row = y * w, to = ((y / f) | 0) * sw; X < sw; X++) {
    let sum = small[to + X]
    for (let x = X * f, end = Math.min(w, x + f); x < end; x++) sum = Math.fround(sum + data[row + x])
    small[to + X] = sum
  }
  for (let Y = 0; Y < sh; Y++) for (let X = 0; X < sw; X++) small[Y * sw + X] /= (Math.min(w, (X + 1) * f) - X * f) * (Math.min(h, (Y + 1) * f) - Y * f)
  const blurred = blur(small, sw, sh, Math.sqrt(Math.max(0.09, sigma * sigma - f * f / 6)) / f), out = new Float32Array(w * h)
  const x0 = new Int32Array(w), x1 = new Int32Array(w), tx = new Float32Array(w)
  for (let x = 0; x < w; x++) { const fx = Math.min(sw - 1, Math.max(0, (x + 0.5) / f - 0.5)); x0[x] = Math.floor(fx); x1[x] = Math.min(sw - 1, x0[x] + 1); tx[x] = fx - x0[x] }
  // Each reduced row blended across once, for all the rows between it and the next.
  const rows = [new Float64Array(w), new Float64Array(w)], held = [-1, -1]
  const across = (r: number, keep: number) => {
    let k = held[0] === r ? 0 : held[1] === r ? 1 : -1
    if (k >= 0) return rows[k]
    k = held[0] === keep ? 1 : 0; held[k] = r
    const line = rows[k]
    for (let x = 0; x < w; x++) line[x] = blurred[r + x0[x]] + (blurred[r + x1[x]] - blurred[r + x0[x]]) * tx[x]
    return line
  }
  for (let y = 0; y < h; y++) {
    const fy = Math.min(sh - 1, Math.max(0, (y + 0.5) / f - 0.5)), y0 = Math.floor(fy), ty = fy - y0, r0 = y0 * sw, r1 = Math.min(sh - 1, y0 + 1) * sw
    const top = across(r0, r1), bottom = across(r1, r0)
    for (let x = 0, o = y * w; x < w; x++) out[o + x] = top[x] + (bottom[x] - top[x]) * ty
  }
  return out
}

// `pixels` (premultiplied 8-bit RGBA) with its rim lights added, on the same grid; `subject` (one channel, the same size) is where the
// subject is, which the layer's alpha stands in for without it. Worked in linear light, as Core Image works on the Mac.
export function rimLight(pixels: Raster, settings: RimLightSettings, subject?: Raster): Raster {
  const s = normalizedRimLight(settings), { width: w, height: h, data: src } = pixels, n = w * h, side = Math.max(w, h)
  if (rimLightIsIdentity(s) || !n) return pixels.clone()
  const blurred = (data: Float32Array, sigma: number) => blur(data, w, h, sigma), planes = () => [0, 1, 2].map(() => new Float32Array(n))
  // The photo unpremultiplied in linear light (its albedo), its alpha, the subject's coverage and hard outline, and its gray as stored.
  const albedo = planes(), alpha = new Float32Array(n), coverage = new Float32Array(n), outline = new Float32Array(n), gray = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const a = src[i * 4 + 3]
    alpha[i] = a / 255
    coverage[i] = subject ? subject.data[i] / 255 : a / 255
    outline[i] = Math.min(1, Math.max(0, coverage[i] * 1.6 - 0.3))
    if (!a) continue
    let luma = 0
    for (let c = 0; c < 3; c++) { const v = straight[a << 8 | src[i * 4 + c]]; albedo[c][i] = toLinear[v]; luma += lumaWeights[c] * v / 255 }
    gray[i] = luma
  }
  const fine = blurred(gray, 1), coarse = blurred(gray, Math.max(2, side / 400)), detail = new Float32Array(n)
  for (let i = 0; i < n; i++) detail[i] = fine[i] - coarse[i]
  const near = blurred(outline, side * 0.015)
  const left = (x: number) => x > 0 ? -1 : 0, right = (x: number) => x < w - 1 ? 1 : 0, up = (y: number) => y > 0 ? -w : 0, down = (y: number) => y < h - 1 ? w : 0

  // Past the edge, loose strands: whatever near the subject stands out from the backdrop behind it (the photo outside the outline
  // spread in under it) by more than that backdrop varies on its own. Only a subject mask has photo outside it; alpha has none.
  let strand: Float32Array | null = null
  if (subject) {
    const spread = side * 0.01, open = new Float32Array(n), weighted = planes(), squares = planes()
    for (let i = 0; i < n; i++) {
      open[i] = 1 - outline[i]
      for (let c = 0; c < 3; c++) { const v = albedo[c][i] * alpha[i]; weighted[c][i] = v * open[i]; squares[c][i] = v * v * open[i] }
    }
    const openBlur = blurred(open, spread), around = weighted.map(p => blurred(p, spread)), aroundSquares = squares.map(p => blurred(p, spread))
    strand = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      const o = openBlur[i] + 0.001
      let differs = 0, varies = 0
      for (let c = 0; c < 3; c++) { const behind = around[c][i] / o; differs = Math.max(differs, Math.abs(albedo[c][i] * alpha[i] - behind)); varies = Math.max(varies, Math.abs(aroundSquares[c][i] / o - behind * behind)) }
      strand[i] = Math.min(1, Math.max(0, (differs - 0.03 - 2.5 * Math.sqrt(varies)) / 0.1)) * smoothstep(0, 0.1, near[i])
    }
  }

  // Each light on its own, reaching in as far as its Width, added up.
  const light = planes(), detailScale = side / 250, measured = new Map<number, Float32Array>()
  for (const l of s.lights) {
    if (l.strength <= 0) continue
    const width = side * widthShare(l.width), reach = Math.max(1, width / 1.5), choke = l.choke / 100, angle = l.angle * Math.PI / 180
    // The outline blurred far enough to tell, at each pixel, how far in from the edge it is, out to twice Width. Past 0.999 that's
    // further than the light reaches, and below 0.001 it's outside, where only strands catch it.
    const depthOf = measured.get(reach) ?? blurred(outline, reach)
    measured.set(reach, depthOf)
    const dl = Math.hypot(Math.cos(angle), Math.sin(angle), 0.2), dx = Math.cos(angle) / dl, dy = Math.sin(angle) / dl, dz = -0.2 / dl
    const strength = l.strength / 100 * fullStrength, color = l.color.map(c => decode(c / 255) * strength)
    const heldFrom = Math.max(0, (choke - 0.3) / 0.7) * 0.95
    for (let y = 0, i = 0; y < h; y++) for (let x = 0; x < w; x++, i++) {
      const covered = coverage[i], b = depthOf[i]
      if ((covered <= 0.002 && near[i] <= 0.002) || !alpha[i] || b >= 0.999 || (b <= 0.001 && !(strand && strand[i] > 0))) continue
      // A hard edge blurred by `reach` is at half where the edge is, and its level tells the distance from it.
      const depth = reach * Math.SQRT2 * inverseError(2 * Math.max(0.001, b) - 1)
      const l0 = i + left(x), r0 = i + right(x), u0 = i + up(y), d0 = i + down(y)
      let ix = depthOf[r0] - depthOf[l0], iy = depthOf[u0] - depthOf[d0]
      const il = Math.hypot(ix, iy)
      if (il > 1e-6) { ix /= il; iy /= il } else ix = iy = 0
      const bx = (detail[r0] - detail[l0]) / 2, by = (detail[u0] - detail[d0]) / 2
      const sx = -ix * 2.75 - bx * detailScale, sy = -iy * 2.75 - by * detailScale, sl = Math.hypot(sx, sy, 1)
      const lit = Math.pow(Math.max(0, (sx * dx + sy * dy + dz) / sl), 1.6)
      // At Choke 0 it tails off softly with no end; more holds it bright and ends it crisply at Width. Let go before twice Width.
      const t = Math.max(depth, 0) / width, held = 1 - smoothstep(heldFrom, 1, t), tail = Math.exp(-2.2 * t)
      const reaches = (choke < 0.3 ? tail + (held - tail) * choke / 0.3 : held) * (1 - smoothstep(1.5, 1.9, t))
      // Strands and edges brighter than around them catch more of it.
      const catches = Math.min(1.8, Math.max(0.3, 1 + detail[i] * 6)), inside = smoothstep(-1.5, 1.5, depth)
      let k = lit * reaches * catches * covered * inside
      if (strand && strand[i] > 0 && inside < 1) {
        let ax = near[r0] - near[l0], ay = near[u0] - near[d0]
        const al = Math.hypot(ax, ay)
        if (al > 1e-6) { ax /= al; ay /= al } else ax = ay = 0
        k += Math.pow(Math.max(0, (-ax * 2.75 * dx - ay * 2.75 * dy + dz) / Math.hypot(ax * 2.75, ay * 2.75, 1)), 1.6) * strand[i] * (1 - inside)
      }
      if (k > 0) for (let c = 0; c < 3; c++) light[c][i] += color[c] * (albedo[c][i] * 0.7 + 0.45) * k * alpha[i]
    }
  }

  // Glow: the rims' light in the air behind the subject, a halo and a wider haze, wrapping a little way in across the edge.
  if (s.glow > 0) {
    const amount = s.glow / 100 * fullGlow, edge = blurred(outline, side * 0.008)
    for (let c = 0; c < 3; c++) {
      const halo = blurred(light[c], side * 0.012), haze = blurred(light[c], side * 0.035), plane = light[c]
      for (let i = 0; i < n; i++) {
        const around = Math.min(1, Math.max(0, 2 - 2 * edge[i]))
        if (around > 0) plane[i] += (halo[i] * 0.6 + haze[i]) * amount * around
      }
    }
  }

  // The light over the photo: eased so a lot of it approaches 1 rather than passing it, then screened over, so a bright edge rolls off
  // into the light's color and white instead of clipping. Clear pixels stay clear.
  const out = pixels.clone(), data = out.data
  for (let i = 0; i < n; i++) {
    const a = alpha[i]
    if (!a || (light[0][i] <= 0 && light[1][i] <= 0 && light[2][i] <= 0)) continue
    for (let c = 0; c < 3; c++) data[i * 4 + c] = Math.round(encode(1 - (1 - Math.min(1, albedo[c][i])) * Math.exp(-Math.max(0, light[c][i]))) * a * 255)
  }
  return out
}
