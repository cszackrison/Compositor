import { decode, encode } from 'fast-png'

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

// Any 8-bit-or-less PNG to premultiplied RGBA, or to one-channel coverage for masks (gray, or the first channel).
export function decodePNG(bytes: Uint8Array, channels: 1 | 4): Raster {
  const png = decode(bytes)
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

export function encodePNG(raster: Raster) {
  const data = raster.channels === 4 ? unpremultiply(raster.data.slice()) : raster.data
  return encode({ width: raster.width, height: raster.height, data, channels: raster.channels, depth: 8 }, { zlib: { level: 3 } })
}

// JPEG, HEIC (where supported), WebP, GIF and the like, through the browser's decoder. Opaque images lose nothing to the canvas's premultiplication.
export async function decodeImageFile(file: Blob): Promise<Raster> {
  if (file.type === 'image/png') return decodePNG(new Uint8Array(await file.arrayBuffer()), 4)
  const bitmap = await createImageBitmap(file, { premultiplyAlpha: 'premultiply', colorSpaceConversion: 'default' })
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
  const context = canvas.getContext('2d')!
  context.drawImage(bitmap, 0, 0)
  const data = new Uint8Array(context.getImageData(0, 0, bitmap.width, bitmap.height).data.buffer)
  return new Raster(bitmap.width, bitmap.height, 4, premultiply(data))
}
