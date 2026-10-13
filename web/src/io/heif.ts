import { Raster, premultiply } from '../model/raster'
import { type Deep, makeDeep } from '../model/deep'
import { lcms } from './cmyk'

// HEIC and HEIF (iPhone photos, cameras' .hif) through libheif compiled to WebAssembly (libheif-js, LGPL-3.0, loaded on first use), as
// browsers other than Safari can't read them. The main image comes in as the Mac's ImageIO brings it: in sRGB through its embedded
// profile or its color description, and kept at 16 bits when it has more than 8 (cameras' 10-bit HEIF).

type Heif = {
  HeifDecoder: new () => { decode(bytes: Uint8Array): { handle: { $$: { ptr: number } } }[] }
  heif_js_decode_image2(handle: unknown, colorspace: number, chroma: number): { width: number; height: number; channels: { data: Uint8Array; stride: number; bits_per_pixel: number }[] } | { code: number; message?: string }
  heif_image_handle_is_primary_image(handle: unknown): number
  heif_image_handle_has_alpha_channel(handle: unknown): number
  heif_colorspace: { heif_colorspace_RGB: number }
  heif_chroma: { heif_chroma_interleaved_RRGGBBAA_LE: number; heif_chroma_interleaved_RGBA: number }
  _heif_image_handle_get_luma_bits_per_pixel(handle: number): number
  _heif_image_handle_get_color_profile_type(handle: number): number
  _heif_image_handle_get_raw_color_profile_size(handle: number): number
  _heif_image_handle_get_raw_color_profile(error: number, handle: number, out: number): void
  _heif_image_handle_get_nclx_color_profile(error: number, handle: number, out: number): void
  _heif_nclx_color_profile_free(profile: number): void
  _malloc(size: number): number
  _free(pointer: number): void
  HEAPU8: Uint8Array
}

let library: Promise<Heif> | null = null
const heif = () => library ??= import('libheif-js/libheif-wasm/libheif-bundle.mjs').then(module => (module.default as unknown as () => Heif)())

export const isHEIF = (name: string, type: string) => /\.(heic|heif|hif)$/i.test(name) || /^image\/hei[cf]/.test(type)
const fourcc = (s: string) => [...s].reduce((n, c) => n * 256 + c.charCodeAt(0), 0)

// What the image says its colors are: an ICC profile, or the primaries and transfer of a color description (nclx).
function colorOf(lib: Heif, handle: number): { icc?: Uint8Array; primaries?: number; transfer?: number } {
  const type = lib._heif_image_handle_get_color_profile_type(handle), error = lib._malloc(16)
  try {
    if (type === fourcc('prof') || type === fourcc('rICC')) {
      const size = lib._heif_image_handle_get_raw_color_profile_size(handle), out = lib._malloc(size)
      lib._heif_image_handle_get_raw_color_profile(error, handle, out)
      const icc = lib.HEAPU8.slice(out, out + size)
      lib._free(out)
      return { icc }
    }
    if (type === fourcc('nclx')) {
      const out = lib._malloc(4)
      lib._heif_image_handle_get_nclx_color_profile(error, handle, out)
      const view = new DataView(lib.HEAPU8.buffer), profile = view.getUint32(out, true), primaries = view.getInt32(profile + 4, true), transfer = view.getInt32(profile + 8, true)
      lib._heif_nclx_color_profile_free(profile); lib._free(out)
      return { primaries, transfer }
    }
    return {}
  } finally { lib._free(error) }
}

// Linear light to sRGB primaries from Display P3 (nclx 12) and BT.2020 (nclx 9), both D65.
const toSRGB: Record<number, number[]> = {
  12: [1.2249, -0.2247, 0, -0.042, 1.0419, 0, -0.0197, -0.0786, 1.0979],
  9: [1.6605, -0.5876, -0.0728, -0.1246, 1.1329, -0.0083, -0.0182, -0.1006, 1.1187],
}
const linear = (v: number) => v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
const encoded = (v: number) => v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055

// Straight RGBA at `max` (255 or 65535), converted in place to sRGB.
async function intoSRGB(pixels: Uint8Array | Uint16Array, max: number, color: ReturnType<typeof colorOf>) {
  const count = pixels.length / 4
  if (color.icc) {
    const l = await lcms(), { TYPE_RGB_8, TYPE_RGB_16, INTENT_RELATIVE_COLORIMETRIC, cmsFLAGS_BLACKPOINTCOMPENSATION } = await import('../../vendor/lcms/lcms.js')
    const source = l.cmsOpenProfileFromMem(color.icc, color.icc.length)
    if (!source) return
    const srgb = l.cmsCreate_sRGBProfile(), format = max > 255 ? TYPE_RGB_16 : TYPE_RGB_8
    const transform = l.cmsCreateTransform(source, format, srgb, format, INTENT_RELATIVE_COLORIMETRIC, cmsFLAGS_BLACKPOINTCOMPENSATION)
    try {
      if (!transform) return
      const step = 1 << 20, rgb = max > 255 ? new Uint16Array(Math.min(step, count) * 3) : new Uint8Array(Math.min(step, count) * 3)
      for (let at = 0; at < count; at += step) {
        const n = Math.min(step, count - at), chunk = rgb.subarray(0, n * 3)
        for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) chunk[i * 3 + c] = pixels[(at + i) * 4 + c]
        const out = l.cmsDoTransform(transform, chunk, n)
        for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) pixels[(at + i) * 4 + c] = out[i * 3 + c]
      }
    } finally { if (transform) l.cmsDeleteTransform(transform); l.cmsCloseProfile(source); l.cmsCloseProfile(srgb) }
    return
  }
  const matrix = color.primaries !== undefined ? toSRGB[color.primaries] : undefined
  if (!matrix) return
  for (let i = 0; i < pixels.length; i += 4) {
    const r = linear(pixels[i] / max), g = linear(pixels[i + 1] / max), b = linear(pixels[i + 2] / max)
    for (let c = 0; c < 3; c++) pixels[i + c] = Math.round(encoded(Math.min(1, Math.max(0, matrix[c * 3] * r + matrix[c * 3 + 1] * g + matrix[c * 3 + 2] * b))) * max)
  }
}

export async function decodeHEIF(bytes: Uint8Array): Promise<{ image: Raster; deep?: Deep }> {
  const lib = await heif(), images = new lib.HeifDecoder().decode(bytes)
  const main = images.find(image => lib.heif_image_handle_is_primary_image(image.handle)) ?? images[0]
  if (!main) throw new Error('This HEIF file has no image Compositor can read.')
  const handle = main.handle.$$.ptr, bits = lib._heif_image_handle_get_luma_bits_per_pixel(handle), deep = bits > 8
  const decoded = lib.heif_js_decode_image2(main.handle, lib.heif_colorspace.heif_colorspace_RGB, deep ? lib.heif_chroma.heif_chroma_interleaved_RRGGBBAA_LE : lib.heif_chroma.heif_chroma_interleaved_RGBA)
  if (!('channels' in decoded) || !decoded.channels?.length) throw new Error('This HEIF image could not be decoded.')
  const { width, height } = decoded, channel = decoded.channels[0], color = colorOf(lib, handle)
  if (!deep) {
    const pixels = new Uint8Array(width * height * 4)
    for (let y = 0; y < height; y++) pixels.set(channel.data.subarray(y * channel.stride, y * channel.stride + width * 4), y * width * 4)
    await intoSRGB(pixels, 255, color)
    return { image: new Raster(width, height, 4, premultiply(pixels)) }
  }
  const top = (1 << channel.bits_per_pixel) - 1, source = new Uint16Array(channel.data.buffer, channel.data.byteOffset, channel.data.byteLength >> 1), row = channel.stride >> 1
  const pixels = new Uint16Array(width * height * 4)
  for (let y = 0; y < height; y++) for (let x = 0; x < width * 4; x++) pixels[y * width * 4 + x] = Math.round(source[y * row + x] * 65535 / top)
  await intoSRGB(pixels, 65535, color)
  for (let i = 0; i < pixels.length; i += 4) { const a = pixels[i + 3]; if (a < 65535) for (let c = 0; c < 3; c++) pixels[i + c] = Math.round(pixels[i + c] * a / 65535) }
  return makeDeep(pixels, width, height, false)
}
