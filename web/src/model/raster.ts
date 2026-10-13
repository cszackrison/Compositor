import type { CMYKProfile } from '../io/cmyk'
import { type Deep, from16BitPNG, linearToHDR, makeDeep } from './deep'
import { decode, encode } from 'fast-png'
import { call, withBuffers } from '../kernels'
import { maxSide } from './types'

let nextVersion = 1

// Pixels in memory: premultiplied RGBA (4 channels) for layers, coverage (1 channel) for masks. `version` changes on every edit so
// GPU textures and caches know to refresh.
export class Raster {
  version = nextVersion++
  // What changed since `dirtyFrom`, so a texture at that version can upload just this rectangle.
  dirty: { x: number; y: number; w: number; h: number } | null = null
  dirtyFrom = 0
  constructor(readonly width: number, readonly height: number, readonly channels: 1 | 4, readonly data: Uint8Array = new Uint8Array(width * height * channels)) {}
  touch() { this.version = nextVersion++; this.dirty = null }
  markDirty(rect: { x: number; y: number; w: number; h: number }) {
    if (!this.dirty) { this.dirty = { ...rect }; this.dirtyFrom = this.version }
    else {
      const x0 = Math.min(this.dirty.x, rect.x), y0 = Math.min(this.dirty.y, rect.y)
      this.dirty = { x: x0, y: y0, w: Math.max(this.dirty.x + this.dirty.w, rect.x + rect.w) - x0, h: Math.max(this.dirty.y + this.dirty.h, rect.y + rect.h) - y0 }
    }
    this.version = nextVersion++
  }
  clone() { return new Raster(this.width, this.height, this.channels, this.data.slice()) }
  static filled(width: number, height: number, channels: 1 | 4, value: number[]) {
    const raster = new Raster(width, height, channels)
    if (value.every(v => v === 0)) return raster
    for (let i = 0; i < raster.data.length; i += channels) raster.data.set(value, i)
    return raster
  }
  read(x: number, y: number, w: number, h: number) {
    const out = new Uint8Array(w * h * this.channels), row = w * this.channels
    for (let j = 0; j < h; j++) out.set(this.data.subarray(((y + j) * this.width + x) * this.channels, ((y + j) * this.width + x) * this.channels + row), j * row)
    return out
  }
  write(x: number, y: number, w: number, h: number, pixels: Uint8Array) {
    const row = w * this.channels
    for (let j = 0; j < h; j++) this.data.set(pixels.subarray(j * row, j * row + row), ((y + j) * this.width + x) * this.channels)
    this.touch()
  }
  isUniform() {
    const { data, channels } = this
    for (let i = channels; i < data.length; i++) if (data[i] !== data[i % channels]) return false
    return true
  }
}

export function premultiply(data: Uint8Array) {
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3]
    if (a === 255) continue
    data[i] = Math.round(data[i] * a / 255); data[i + 1] = Math.round(data[i + 1] * a / 255); data[i + 2] = Math.round(data[i + 2] * a / 255)
  }
  return data
}

export function unpremultiply(data: Uint8Array) {
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3]
    if (a === 255) continue
    if (a === 0) { data[i] = data[i + 1] = data[i + 2] = 0; continue }
    data[i] = Math.min(255, Math.round(data[i] * 255 / a)); data[i + 1] = Math.min(255, Math.round(data[i + 1] * 255 / a)); data[i + 2] = Math.min(255, Math.round(data[i + 2] * 255 / a))
  }
  return data
}

function to8Bit(data: ArrayLike<number>, depth: number) {
  if (depth === 8 && data instanceof Uint8Array) return data
  const out = new Uint8Array(data.length), shift = depth === 16 ? 8 : 0, scale = depth < 8 ? 255 / ((1 << depth) - 1) : 1
  for (let i = 0; i < data.length; i++) out[i] = depth === 16 ? data[i] >> shift : Math.round(data[i] * scale)
  return out
}

function expandPalette(png: ReturnType<typeof decode>) {
  const palette = png.palette!, out = new Uint8Array(png.width * png.height * 4), indices = png.data
  for (let i = 0; i < png.width * png.height; i++) {
    const entry = palette[indices[i]] ?? [0, 0, 0, 255]
    out.set([entry[0], entry[1], entry[2], entry[3] ?? 255], i * 4)
  }
  return out
}

// Premultiplied 16-bit RGBA rounded to 8 bits with a fine noise (dither_quantize16), as the Mac makes a 16-bit layer's 8-bit copy, so
// gradients don't band.
export function quantize16(wide: Uint16Array, width: number, height: number) {
  const out = new Raster(width, height, 4)
  withBuffers([{ data: wide }, { data: out.data, out: true }], ([w, o]) => call('dither_quantize16', w, o, width, height, width * 4))
  return out
}

function decodePNG16(png: ReturnType<typeof decode>) {
  const count = png.width * png.height, source = png.data, n = png.channels, wide = new Uint16Array(count * 4)
  for (let i = 0; i < count; i++) {
    const s = i * n, d = i * 4, gray = n < 3, a = n === 4 || n === 2 ? source[s + n - 1] : 65535
    wide[d + 3] = a
    for (let c = 0; c < 3; c++) wide[d + c] = Math.round(source[s + (gray ? 0 : c)] * a / 65535)
  }
  return quantize16(wide, png.width, png.height)
}

// The bit depth in a PNG's header, without decoding it.
export const pngDepth = (bytes: Uint8Array) => bytes.length > 24 ? bytes[24] : 8

// Any PNG to premultiplied RGBA, or to one-channel coverage for masks (gray, or the first channel). 16-bit color is dithered to 8.
export function decodePNG(bytes: Uint8Array, channels: 1 | 4): Raster {
  const png = decode(bytes)
  if (channels === 4 && png.depth === 16 && !png.palette) return decodePNG16(png)
  const source = png.palette ? expandPalette(png) : to8Bit(png.data, png.depth)
  const sourceChannels = png.palette ? 4 : png.channels
  const count = png.width * png.height
  const out = new Uint8Array(count * channels)
  if (channels === 1) {
    for (let i = 0; i < count; i++) out[i] = source[i * sourceChannels]
    return new Raster(png.width, png.height, 1, out)
  }
  for (let i = 0; i < count; i++) {
    const s = i * sourceChannels, d = i * 4
    if (sourceChannels >= 3) { out[d] = source[s]; out[d + 1] = source[s + 1]; out[d + 2] = source[s + 2]; out[d + 3] = sourceChannels === 4 ? source[s + 3] : 255 }
    else { out[d] = out[d + 1] = out[d + 2] = source[s]; out[d + 3] = sourceChannels === 2 ? source[s + 1] : 255 }
  }
  return new Raster(png.width, png.height, 4, premultiply(out))
}

// Floats in linear light (4 a pixel, premultiplied) as the Mac shows an HDR layer: clipped to white, in sRGB, rounded to 8 bits with a
// fine noise, top row first.
export function fromLinear(data: Float32Array, width: number, height: number) {
  const wide = new Uint16Array(width * height * 4)
  const toSRGB = (v: number) => v <= 0 ? 0 : v >= 1 ? 1 : v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const s = (y * width + x) * 4, d = (y * width + x) * 4, a = Math.min(1, Math.max(0, data[s + 3]))
    wide[d + 3] = Math.round(a * 65535)
    if (a > 0) for (let c = 0; c < 3; c++) wide[d + c] = Math.round(toSRGB(data[s + c] / a) * a * 65535)
  }
  return quantize16(wide, width, height)
}

export type LinearImage = { width: number; height: number; data: Float32Array }

// three's EXR reader, kept once loaded so the canvas can read an HDR layer's pixels while it draws.
let exrReader: ((bytes: Uint8Array) => LinearImage) | null = null
export async function loadEXRReader() {
  if (exrReader) return exrReader
  const { EXRLoader } = await import('three/examples/jsm/loaders/EXRLoader.js')
  const { FloatType } = await import('three')
  const loader = new EXRLoader().setDataType(FloatType)
  return exrReader = bytes => {
    const exr = loader.parse(bytes.slice().buffer) as unknown as LinearImage
    const { width, height } = exr, data = new Float32Array(width * height * 4), row = width * 4
    for (let y = 0; y < height; y++) data.set(exr.data.subarray((height - 1 - y) * row, (height - y) * row), y * row)
    return { width, height, data }
  }
}

// An OpenEXR's pixels: premultiplied linear light, RGBA floats, top row first. `readEXRNow` is null until the reader has loaded.
export async function readEXR(bytes: Uint8Array): Promise<LinearImage> { return (await loadEXRReader())(bytes) }
export function readEXRNow(bytes: Uint8Array): LinearImage | null { if (!exrReader) loadEXRReader(); return exrReader?.(bytes) ?? null }

// Floats resized with a triangle filter as wide as a source pixel or an output one, whichever is larger, so shrinking averages and
// enlarging interpolates.
export function resizeLinear(image: LinearImage, width: number, height: number): LinearImage {
  if (width === image.width && height === image.height) return image
  const pass = (data: Float32Array, from: number, to: number, lines: number, horizontal: boolean) => {
    const out = new Float32Array(to * lines * 4), scale = from / to, support = Math.max(1, scale)
    for (let o = 0; o < to; o++) {
      const center = (o + 0.5) * scale - 0.5, first = Math.max(0, Math.ceil(center - support)), last = Math.min(from - 1, Math.floor(center + support))
      const taps: [number, number][] = []
      let total = 0
      for (let i = first; i <= last; i++) { const w = Math.max(0, 1 - Math.abs(i - center) / support); if (w > 0) { taps.push([i, w]); total += w } }
      if (!total) taps.push([Math.min(from - 1, Math.max(0, Math.round(center))), total = 1])
      for (let line = 0; line < lines; line++) {
        const d = (horizontal ? line * to + o : o * lines + line) * 4
        for (const [i, w] of taps) {
          const s = (horizontal ? line * from + i : i * lines + line) * 4, k = w / total
          for (let c = 0; c < 4; c++) out[d + c] += data[s + c] * k
        }
      }
    }
    return out
  }
  const across = pass(image.data, image.width, width, image.height, true)
  return { width, height, data: pass(across, image.height, height, width, false) }
}

// A Radiance HDR image (linear light, opaque).
export async function readHDR(bytes: Uint8Array): Promise<LinearImage> {
  const { RGBELoader } = await import('three/examples/jsm/loaders/RGBELoader.js')
  const { FloatType } = await import('three')
  const { width, height, data } = new RGBELoader().setDataType(FloatType).parse(bytes.slice().buffer) as unknown as LinearImage
  return { width, height, data }
}
export async function decodeHDR(bytes: Uint8Array): Promise<Raster> {
  const hdr = await readHDR(bytes)
  return fromLinear(hdr.data, hdr.width, hdr.height)
}

// A project's layer image at its full depth: a 16-bit PNG or an OpenEXR becomes a 16-bit or HDR layer (model/deep.ts), any other PNG an
// 8-bit one.
export async function decodeLayerImage(bytes: Uint8Array, exr: boolean): Promise<{ image: Raster; deep?: Deep }> {
  if (exr) { const read = await readEXR(bytes); return makeDeep(linearToHDR(read.data), read.width, read.height, true, { kind: 'exr', bytes }) }
  if (pngDepth(bytes) === 16) {
    const png = decode(bytes)
    if (!png.palette) return makeDeep(from16BitPNG(png.data, png.channels, png.width, png.height), png.width, png.height, false, { kind: 'png', bytes })
  }
  return { image: decodePNG(bytes, 4) }
}

// An image file placed as a layer: 16-bit PNGs, OpenEXR and Radiance HDR at their full depth, CMYK through its profile (`profile`, to
// adopt when it starts a project), SVG drawn to fit `fitting`.
export async function decodeLayerFile(file: File, fitting?: { width: number; height: number }): Promise<{ image: Raster; deep?: Deep; profile?: CMYKProfile }> {
  const name = file.name.toLowerCase()
  if (file.type === 'image/svg+xml' || name.endsWith('.svg')) return { image: await decodeSVG(file, fitting) }
  if (/\.(jpe?g|tiff?)$/.test(name) || /^image\/(jpeg|tiff)$/.test(file.type)) { const cmyk = await (await import('../io/cmyk')).openCMYK(file); if (cmyk) return cmyk }
  if (/\.(heic|heif|hif)$/.test(name) || /^image\/hei[cf]/.test(file.type)) return (await import('../io/heif')).decodeHEIF(new Uint8Array(await file.arrayBuffer()))
  if (name.endsWith('.hdr')) { const hdr = await readHDR(new Uint8Array(await file.arrayBuffer())); await loadEXRReader(); return makeDeep(linearToHDR(hdr.data), hdr.width, hdr.height, true) }
  if (name.endsWith('.exr') || file.type === 'image/png' || name.endsWith('.png')) return decodeLayerImage(new Uint8Array(await file.arrayBuffer()), name.endsWith('.exr'))
  return { image: await decodeImageFile(file) }
}

export function encodePNG(raster: Raster) {
  const data = raster.channels === 4 ? unpremultiply(raster.data.slice()) : raster.data
  return encode({ width: raster.width, height: raster.height, data, channels: raster.channels, depth: 8 }, { zlib: { level: 3 } })
}

// JPEG, HEIC (where supported), WebP, GIF and the like, through the browser's decoder; TIFF here where the browser can't (all but
// Safari). Opaque images lose nothing to the canvas's premultiplication.
export async function decodeImageFile(file: Blob): Promise<Raster> {
  if (file.type === 'image/png') return decodePNG(new Uint8Array(await file.arrayBuffer()), 4)
  const tiff = file.type === 'image/tiff' || /\.tiff?$/i.test((file as File).name ?? '')
  const bitmap = await createImageBitmap(file, { premultiplyAlpha: 'premultiply', colorSpaceConversion: 'default' }).catch(e => { if (tiff) return null; throw e })
  if (!bitmap) return decodeTIFF(new Uint8Array(await file.arrayBuffer()))
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
  const context = canvas.getContext('2d')!
  context.drawImage(bitmap, 0, 0)
  const data = new Uint8Array(context.getImageData(0, 0, bitmap.width, bitmap.height).data.buffer)
  return new Raster(bitmap.width, bitmap.height, 4, premultiply(data))
}

// A TIFF's main image: the largest, so not a thumbnail.
export async function tiffMainPage(bytes: Uint8Array) {
  const module = await import('utif'), UTIF = (module as unknown as { default?: typeof module }).default ?? module
  const buffer = bytes.slice().buffer, pages = UTIF.decode(buffer)
  const size = (page: UTIF.IFD) => { const w = page.t256 as unknown as number[] | undefined, h = page.t257 as unknown as number[] | undefined; return (w?.[0] ?? 0) * (h?.[0] ?? 0) }
  const page = pages.reduce((best, p) => size(p) > size(best) ? p : best, pages[0])
  if (!page || !size(page)) throw new Error('This TIFF has no image Compositor can read.')
  return { page, UTIF, buffer }
}

// A TIFF's main image at 8 bits a channel.
export async function decodeTIFF(bytes: Uint8Array): Promise<Raster> {
  const { page, UTIF, buffer } = await tiffMainPage(bytes)
  UTIF.decodeImage(buffer, page)
  return new Raster(page.width, page.height, 4, premultiply(new Uint8Array(UTIF.toRGBA8(page))))
}

// An SVG drawn once into pixels by the browser: fitted to `fitting` (the canvas) when there is one, otherwise at the size the file
// declares, as the Mac imports one. It comes in as an ordinary image layer, so it doesn't stay vector.
export async function decodeSVG(file: Blob, fitting?: { width: number; height: number }): Promise<Raster> {
  const text = await file.text(), svg = new DOMParser().parseFromString(text, 'image/svg+xml').documentElement
  const length = (value: string | null) => { const n = parseFloat(value ?? ''); return n > 0 && !/%$/.test(value!.trim()) ? n : 0 }
  const box = (svg.getAttribute('viewBox') ?? '').split(/[\s,]+/).map(Number)
  let width = length(svg.getAttribute('width')), height = length(svg.getAttribute('height'))
  if (box.length === 4 && box[2] > 0 && box[3] > 0) {
    if (!width && !height) { width = box[2]; height = box[3] } else if (!width) width = height * box[2] / box[3]; else if (!height) height = width * box[3] / box[2]
  }
  if (!width || !height) { width = width || 300; height = height || 150 }
  const scale = fitting ? Math.min(fitting.width / width, fitting.height / height) : 1
  const w = Math.max(1, Math.round(width * scale)), h = Math.max(1, Math.round(height * scale))
  if (Math.max(w, h) > maxSide) throw new Error('This SVG is too large to import.')
  const url = URL.createObjectURL(new Blob([text], { type: 'image/svg+xml' }))
  try {
    const image = new Image()
    image.src = url
    await image.decode().catch(() => { throw new Error('This SVG could not be read.') })
    const canvas = new OffscreenCanvas(w, h), context = canvas.getContext('2d')!
    context.drawImage(image, 0, 0, w, h)
    return new Raster(w, h, 4, premultiply(new Uint8Array(context.getImageData(0, 0, w, h).data.buffer)))
  } finally { URL.revokeObjectURL(url) }
}
