// Developing a camera RAW (RawImporter.swift): exposure, white balance, Apple's "boost" tone curve, noise reduction, lens correction and
// highlight recovery, chosen before the photo becomes a layer. The Mac develops with Core Image's RAW engine; the web decodes the
// sensor's data with LibRaw (io/raw.ts) to linear light in sRGB primaries, balanced as the camera recorded it, and develops that here:
// white balance as a Bradford adaptation from the camera's reading to the chosen temperature and tint, then exposure, then a filmic
// tone curve that Boost blends in. The looks differ from the Mac's, which come from Apple's own processing.

export type RawDevelopSettings = {
  exposure: number; temperature: number; tint: number; boost: number; noiseReduction: number; lensCorrection: boolean; highlightRecovery: boolean
  asShotTemperature: number; asShotTint: number; asShotNoiseReduction: number; asShotLensCorrection: boolean; asShotHighlightRecovery: boolean
  supportsNoiseReduction: boolean; supportsLensCorrection: boolean; supportsHighlightRecovery: boolean
}

export function rawSettings(temperature = 5000, tint = 0): RawDevelopSettings {
  return { exposure: 0, temperature, tint, boost: 1, noiseReduction: 0, lensCorrection: false, highlightRecovery: false, asShotTemperature: temperature, asShotTint: tint, asShotNoiseReduction: 0, asShotLensCorrection: false, asShotHighlightRecovery: false, supportsNoiseReduction: true, supportsLensCorrection: false, supportsHighlightRecovery: true }
}
export const isAsShot = (s: RawDevelopSettings) => s.exposure === 0 && s.boost === 1 && s.temperature === s.asShotTemperature && s.tint === s.asShotTint && s.noiseReduction === s.asShotNoiseReduction && s.lensCorrection === s.asShotLensCorrection && s.highlightRecovery === s.asShotHighlightRecovery
export const resetRaw = (s: RawDevelopSettings): RawDevelopSettings => ({ ...s, exposure: 0, boost: 1, temperature: s.asShotTemperature, tint: s.asShotTint, noiseReduction: s.asShotNoiseReduction, lensCorrection: s.asShotLensCorrection, highlightRecovery: s.asShotHighlightRecovery })

// MARK: White balance

type M3 = number[]
const mul = (a: M3, b: M3): M3 => [0, 1, 2].flatMap(r => [0, 1, 2].map(c => a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c]))
const apply3 = (m: M3, v: number[]) => [0, 1, 2].map(r => m[r * 3] * v[0] + m[r * 3 + 1] * v[1] + m[r * 3 + 2] * v[2])
function inverse(m: M3): M3 {
  const [a, b, c, d, e, f, g, h, i] = m, A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g, det = a * A + b * B + c * C
  return [A, -(b * i - c * h), b * f - c * e, B, a * i - c * g, -(a * f - c * d), C, -(a * h - b * g), a * e - b * d].map(v => v / det)
}
const srgbToXYZ: M3 = [0.4124564, 0.3575761, 0.1804375, 0.2126729, 0.7151522, 0.072175, 0.0193339, 0.119192, 0.9503041]
const xyzToSRGB = inverse(srgbToXYZ)
const bradford: M3 = [0.8951, 0.2664, -0.1614, -0.7502, 1.7135, 0.0367, 0.0389, -0.0685, 1.0296]
const xyToXYZ = ([x, y]: number[]) => [x / y, 1, (1 - x - y) / y]
const d65 = [0.3127, 0.329]

// A Planckian illuminant's chromaticity in CIE 1960 uv (Krystek's approximation), and the point `duv` off the locus, toward green
// for a positive one.
function planckUV(t: number) {
  const u = (0.860117757 + 1.54118254e-4 * t + 1.28641212e-7 * t * t) / (1 + 8.42420235e-4 * t + 7.08145163e-7 * t * t)
  const v = (0.317398726 + 4.22806245e-5 * t + 4.20481691e-8 * t * t) / (1 - 2.89741816e-5 * t + 1.61456053e-7 * t * t)
  return [u, v]
}
function illuminantXY(temperature: number, duv: number) {
  const t = Math.min(25000, Math.max(1667, temperature)), [u, v] = planckUV(t), [u2, v2] = planckUV(t + 1)
  const du = u2 - u, dv = v2 - v, length = Math.hypot(du, dv), nu = -dv / length, nv = du / length
  const U = u + nu * duv, V = v + nv * duv
  return [3 * U / (2 * U - 8 * V + 4), 2 * V / (2 * U - 8 * V + 4)]
}
// Tint is the offset from the locus in thousandths of a uv unit, scaled to the ±150 the Mac's control takes: green illuminants positive,
// which a positive Tint, toward magenta, takes out.
const tintToDuv = (tint: number) => tint / 3000

// The temperature and tint of an illuminant given as its color in linear sRGB (white is D65), the inverse of `illuminantXY`.
export function temperatureOf(rgb: number[]) {
  const [X, Y, Z] = apply3(srgbToXYZ, rgb), x = X / (X + Y + Z), y = Y / (X + Y + Z)
  const u = 4 * x / (-2 * x + 12 * y + 3), v = 6 * y / (-2 * x + 12 * y + 3)
  let best = 6500, distance = Infinity
  for (let t = 1700; t <= 25000; t += t < 8000 ? 10 : 50) { const [pu, pv] = planckUV(t), d = Math.hypot(u - pu, v - pv); if (d < distance) { distance = d; best = t } }
  const [pu, pv] = planckUV(best), [qu, qv] = planckUV(best + 1), side = Math.sign(-(qv - pv) * (u - pu) + (qu - pu) * (v - pv))
  return { temperature: Math.round(best), tint: Math.round(side * distance * 3000) }
}

// The camera's reading of the light as a temperature and tint, from LibRaw's multipliers: the light, in the camera's channels balanced
// for daylight (`pre_mul`), is what the as-shot multipliers (`cam_mul`) took out, carried into sRGB by `rgb_cam`.
export function asShotFromCamera(camMul: number[], preMul: number[], rgbCam: number[][]) {
  const g = (camMul[1] + (camMul[3] || camMul[1])) / 2, pg = (preMul[1] + (preMul[3] || preMul[1])) / 2
  const light = [preMul[0] / camMul[0], pg / g, preMul[2] / camMul[2]]
  if (!light.every(v => Number.isFinite(v) && v > 0)) return { temperature: 5000, tint: 0 }
  return temperatureOf(rgbCam.slice(0, 3).map(row => row[0] * light[0] + row[1] * light[1] + row[2] * light[2]))
}

// Linear sRGB balanced for one illuminant, rebalanced for another: back to the light as recorded, then to white as the chosen one.
export function whiteBalance(s: RawDevelopSettings): M3 {
  const adapt = (from: number[], to: number[]): M3 => {
    const a = apply3(bradford, xyToXYZ(from)), b = apply3(bradford, xyToXYZ(to)), scale: M3 = [b[0] / a[0], 0, 0, 0, b[1] / a[1], 0, 0, 0, b[2] / a[2]]
    return mul(inverse(bradford), mul(scale, bradford))
  }
  const shot = illuminantXY(s.asShotTemperature, tintToDuv(s.asShotTint)), chosen = illuminantXY(s.temperature, tintToDuv(s.tint))
  // As shot, the camera's light was made white; now the chosen light is: undo the first, apply the second.
  return mul(xyzToSRGB, mul(adapt(chosen, d65), mul(adapt(d65, shot), srgbToXYZ)))
}

// MARK: Tone

// Hable's filmic curve, normalized to white at 11.2 and scaled by 2 going in: what Boost 1 gives; 0 is the linear values plainly encoded.
const hable = (x: number) => ((x * (0.15 * x + 0.05) + 0.004) / (x * (0.15 * x + 0.5) + 0.06)) - 0.02 / 0.3
const filmicWhite = hable(11.2)
const filmic = (x: number) => Math.min(1, Math.max(0, hable(2 * x) / filmicWhite))
const encode = (v: number) => v <= 0 ? 0 : v >= 1 ? 1 : v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055

// A tone table from linear light (4096 steps to white, on to 16 times it, where the curve has long since flattened) to encoded 0–1.
function toneTable(boost: number) {
  const table = new Float32Array(4096 * 16 + 1)
  for (let i = 0; i < table.length; i++) { const x = i / 4096, plain = encode(x); table[i] = plain + (encode(filmic(x)) - plain) * boost }
  return table
}

// The developed picture: linear RGB at 16 bits (3 a pixel, as LibRaw gives it) to sRGB-encoded RGBA at 16 bits, opaque.
export function developPixels(linear: Uint16Array, count: number, s: RawDevelopSettings): Uint16Array {
  const m = whiteBalance(s), gain = Math.pow(2, s.exposure) / 65535, table = toneTable(s.boost), top = table.length - 1, out = new Uint16Array(count * 4)
  for (let i = 0; i < count; i++) {
    const r = linear[i * 3] * gain, g = linear[i * 3 + 1] * gain, b = linear[i * 3 + 2] * gain
    for (let c = 0; c < 3; c++) {
      const v = Math.max(0, m[c * 3] * r + m[c * 3 + 1] * g + m[c * 3 + 2] * b) * 4096, k = Math.min(top - 1, Math.floor(v)), f = Math.min(1, v - k)
      out[i * 4 + c] = Math.round(Math.min(1, table[k] + (table[k + 1] - table[k]) * f) * 65535)
    }
    out[i * 4 + 3] = 65535
  }
  return out
}
