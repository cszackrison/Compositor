import { encode } from 'fast-png'
import { Raster, quantize16 } from './raster'
import { call, withBuffers } from '../kernels'
import { encodeEXR, toHalf } from '../io/exr'
import type { Layer } from './types'

// 16-bit and HDR layers in 8-bit documents (DeepLayers.swift). A layer's `deep` keeps its pixels at 16 bits a channel: sRGB,
// premultiplied RGBA, top row first; or for an HDR layer half floats in extended sRGB, keeping light brighter than white. Its `image`
// is a dithered 8-bit copy that the tools keep using. Operations that understand deep pixels make new ones with a new copy; painting
// changes the copy in place, and where it differs from the copy as made, the paint is taken (`flattened`); any other operation makes
// a new `image`, which leaves `deep` behind (it belongs to the raster it was made with), and the layer is 8-bit from then on.
export type Deep = {
  hdr: boolean
  width: number
  height: number
  pixels: Uint16Array
  // The 8-bit copy this goes with, its version and pixels as made, before any paint.
  raster: Raster
  version: number
  base: Uint8Array
  // The file it came from (16-bit PNG or OpenEXR) while it's unchanged, so a save writes it back as it was.
  file?: { kind: 'png' | 'exr'; bytes: Uint8Array }
}

// The layer's deep pixels, while they still go with its 8-bit copy.
export const deepOf = (layer: Pick<Layer, 'deep' | 'image'>) => layer.deep && layer.image && layer.deep.raster === layer.image ? layer.deep : null
export const isDeep = (layer: Pick<Layer, 'deep' | 'image'>) => !!deepOf(layer)
export const isHDR = (layer: Pick<Layer, 'deep' | 'image'>) => !!deepOf(layer)?.hdr

// MARK: Half floats

const halves = (() => {
  const table = new Float32Array(65536)
  for (let h = 0; h < 65536; h++) {
    const sign = h & 0x8000 ? -1 : 1, exponent = (h >> 10) & 0x1f, mantissa = h & 0x3ff
    table[h] = exponent === 0 ? sign * mantissa * 2 ** -24 : exponent === 31 ? (mantissa ? NaN : sign * Infinity) : sign * (1 + mantissa / 1024) * 2 ** (exponent - 15)
  }
  return table
})()
export const fromHalf = (h: number) => halves[h]
// 16-bit values as half floats, for the canvas's textures.
export const sixteenToHalf = (() => { const table = new Uint16Array(65536); for (let v = 0; v < 65536; v++) table[v] = toHalf(v / 65535); return table })()
export function halvesToFloats(pixels: Uint16Array) { const out = new Float32Array(pixels.length); for (let i = 0; i < pixels.length; i++) out[i] = halves[pixels[i]]; return out }
export function floatsToHalves(data: ArrayLike<number>) { const out = new Uint16Array(data.length); for (let i = 0; i < data.length; i++) out[i] = toHalf(data[i]); return out }

const encodeSRGB = (v: number) => v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055
const decodeSRGB = (v: number) => v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
const extended = (f: (v: number) => number) => (v: number) => v < 0 ? -f(-v) : f(v)
export const toExtendedSRGB = extended(encodeSRGB), toLinearLight = extended(decodeSRGB)

// Premultiplied linear light (an OpenEXR's, Radiance HDR's) to an HDR layer's half floats in extended sRGB, and back.
export function linearToHDR(data: Float32Array) {
  const out = new Uint16Array(data.length)
  for (let i = 0; i < data.length; i += 4) {
    const a = Math.min(1, Math.max(0, data[i + 3]))
    out[i + 3] = toHalf(a)
    for (let c = 0; c < 3; c++) out[i + c] = a > 0 ? toHalf(toExtendedSRGB(data[i + c] / a) * a) : 0
  }
  return out
}
export function hdrToLinear(pixels: Uint16Array) {
  const out = new Float32Array(pixels.length)
  for (let i = 0; i < pixels.length; i += 4) {
    const a = halves[pixels[i + 3]]
    out[i + 3] = a
    for (let c = 0; c < 3; c++) out[i + c] = a > 0 ? toLinearLight(halves[pixels[i + c]] / a) * a : 0
  }
  return out
}

// HDR half floats clipped to white, at 16 bits: what an HDR layer shows as, and becomes when converted to 16 bits.
export function hdrTo16(pixels: Uint16Array) {
  const out = new Uint16Array(pixels.length)
  for (let i = 0; i < pixels.length; i += 4) {
    const a = Math.min(1, Math.max(0, halves[pixels[i + 3]]))
    out[i + 3] = Math.round(a * 65535)
    for (let c = 0; c < 3; c++) out[i + c] = Math.round(Math.min(a, Math.max(0, halves[pixels[i + c]])) * 65535)
  }
  return out
}

// The brightest color channel, unpremultiplied (`deep_half_peak`): above 1 where an image holds light brighter than white.
export function halfPeak(pixels: Uint16Array, width: number, height: number) {
  return withBuffers([{ data: pixels }], ([p]) => call('deep_half_peak', p, width * 8, width, height)) as number
}

// Deep pixels as floats (white is 1), and back: 16-bit ones clipped to white and to their alpha, as premultiplied colors must be.
export function deepToFloats(pixels: Uint16Array, hdr: boolean) {
  const out = new Float32Array(pixels.length)
  for (let i = 0; i < out.length; i++) out[i] = hdr ? halves[pixels[i]] : pixels[i] / 65535
  return out
}
export function floatsToDeep(data: ArrayLike<number>, hdr: boolean) {
  const out = new Uint16Array(data.length)
  for (let i = 0; i < out.length; i += 4) {
    const a = Math.min(1, Math.max(0, data[i + 3]))
    out[i + 3] = hdr ? toHalf(a) : Math.round(a * 65535)
    for (let c = 0; c < 3; c++) { const v = Math.max(0, data[i + c]); out[i + c] = hdr ? toHalf(v) : Math.round(Math.min(a, v) * 65535) }
  }
  return out
}

// MARK: Making deep layers

// A layer's 8-bit copy of deep pixels: rounded with a fine noise rather than straight down, so gradients don't step.
export const dithered = (pixels: Uint16Array, width: number, height: number, hdr: boolean) => quantize16(hdr ? hdrTo16(pixels) : pixels, width, height)

// Deep pixels as a layer keeps them, with their 8-bit copy. HDR pixels stay HDR only while they still go brighter than white (a
// thousandth over: a file brushing white through rounding isn't HDR); otherwise they're kept at 16 bits, as most such files are.
export function makeDeep(pixels: Uint16Array, width: number, height: number, hdr: boolean, file?: Deep['file']): { image: Raster; deep: Deep } {
  if (hdr && !(halfPeak(pixels, width, height) > 1.001)) { pixels = hdrTo16(pixels); hdr = false; file = undefined }
  const image = dithered(pixels, width, height, hdr)
  return { image, deep: { hdr, width, height, pixels, raster: image, version: image.version, base: image.data.slice(), file } }
}

// Deep pixels with an 8-bit copy made from them some other way (cut from a larger copy), taken as they are.
export const bound = (raster: Raster, pixels: Uint16Array, hdr: boolean): Deep => ({ hdr, width: raster.width, height: raster.height, pixels, raster, version: raster.version, base: raster.data.slice() })

// A rectangle of deep pixels.
export function cutDeep(pixels: Uint16Array, width: number, x: number, y: number, w: number, h: number) {
  const out = new Uint16Array(w * h * 4)
  for (let j = 0; j < h; j++) out.set(pixels.subarray(((y + j) * width + x) * 4, ((y + j) * width + x + w) * 4), j * w * 4)
  return out
}

// A copy of a layer's deep pixels for a copy of its 8-bit ones (a duplicated layer).
export const rebound = (deep: Deep, raster: Raster): Deep => ({ ...deep, raster, version: raster.version, pixels: flattened(deep), base: raster.data.slice(), file: flattened(deep) === deep.pixels ? deep.file : undefined })

// 8-bit pixels at 16 bits, exactly (Convert to 16-Bit).
export function widened(raster: Raster) {
  const out = new Uint16Array(raster.data.length)
  for (let i = 0; i < out.length; i++) out[i] = raster.data[i] * 257
  return out
}

// The whole layer at its full depth: its deep pixels, with any paint on its 8-bit copy laid over them (`deep_take_painted`). Paint has
// no more depth than 8 bits, so most of a painted layer keeps its precision. Made once per version of the copy.
const flattenedCache = new WeakMap<Deep, { version: number; pixels: Uint16Array }>()
export function flattened(deep: Deep): Uint16Array {
  const raster = deep.raster, found = flattenedCache.get(deep)
  if (found?.version === raster.version) return found.pixels
  let pixels = deep.pixels
  if (raster.version !== deep.version) {
    pixels = deep.pixels.slice()
    withBuffers([{ data: pixels, out: true }, { data: raster.data }, { data: deep.base }], ([d, p, b]) => call(deep.hdr ? 'deep_take_painted_hdr' : 'deep_take_painted', d, deep.width * 8, p, b, deep.width * 4, deep.width, deep.height))
  }
  flattenedCache.set(deep, { version: raster.version, pixels })
  return pixels
}

// MARK: Files

// A 16-bit PNG's pixels, premultiplied as a layer keeps them.
export function from16BitPNG(data: ArrayLike<number>, channels: number, width: number, height: number) {
  const count = width * height, out = new Uint16Array(count * 4)
  for (let i = 0; i < count; i++) {
    const s = i * channels, d = i * 4, gray = channels < 3, a = channels === 4 || channels === 2 ? data[s + channels - 1] : 65535
    out[d + 3] = a
    for (let c = 0; c < 3; c++) out[d + c] = Math.round(data[s + (gray ? 0 : c)] * a / 65535)
  }
  return out
}

// Deep pixels as the file a project keeps them in: a 16-bit PNG (straight alpha, as PNG holds it), or an OpenEXR for an HDR layer.
export function deepFile(deep: Deep, pixels = flattened(deep)): { kind: 'png' | 'exr'; bytes: Uint8Array } {
  if (deep.file && pixels === deep.pixels) return deep.file
  if (deep.hdr) return { kind: 'exr', bytes: encodeEXR(hdrToLinear(pixels), deep.width, deep.height) }
  return { kind: 'png', bytes: encode({ width: deep.width, height: deep.height, data: unpremultiplied16(pixels), channels: 4, depth: 16 }, { zlib: { level: 3 } }) }
}

export function unpremultiplied16(pixels: Uint16Array) {
  const out = new Uint16Array(pixels.length)
  for (let i = 0; i < pixels.length; i += 4) {
    const a = pixels[i + 3]
    out[i + 3] = a
    if (a) for (let c = 0; c < 3; c++) out[i + c] = Math.min(65535, Math.round(pixels[i + c] * 65535 / a))
  }
  return out
}
