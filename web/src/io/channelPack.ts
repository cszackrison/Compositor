import { zlibSync } from 'fflate'
import { Raster } from '../model/raster'
import type { Doc, Layer } from '../model/types'

// Game textures pack four grayscale maps into one image's red, green, blue and alpha (metallic, ambient occlusion, detail and smoothness,
// say). Export As › Channel Pack writes one from layers, keeping a pixel's color where its alpha is 0, which an ordinary PNG throws away
// (its color is stored multiplied by alpha) but a packed texture needs (ChannelPack.swift).
export const packChannels = ['Red', 'Green', 'Blue', 'Alpha'] as const
export type PackChannel = typeof packChannels[number]
// What fills a channel: solid black or white, or a layer or folder's id, read as grayscale.
export type ChannelSource = 'black' | 'white' | (string & {})

// A channel's source when none has been chosen: the topmost layer named for it (R, Red, …), otherwise black, or white for alpha, so an
// unused alpha leaves the texture opaque.
export function defaultSource(channel: PackChannel, layers: Layer[]): ChannelSource {
  const names = [channel[0].toLowerCase(), channel.toLowerCase()]
  return layers.findLast(l => names.includes(l.name.trim().toLowerCase()))?.id ?? (channel === 'Alpha' ? 'white' : 'black')
}

// `doc` with only `id` showing: it and the folders it's in shown, the layers inside it as they are, every other layer hidden. A layer
// picked for a channel is used even when it's hidden in the document.
export function isolatingChannel(doc: Doc, id: string): Doc {
  const parent = new Map(doc.layers.map(l => [l.id, l.parentId])), folders = new Set<string>([id])
  for (let p = parent.get(id); p && !folders.has(p); p = parent.get(p)) folders.add(p)
  const inside = (layer: string) => { const seen = new Set<string>(); for (let p = parent.get(layer); p && !seen.has(p); p = parent.get(p)) { if (p === id) return true; seen.add(p) } return false }
  return { ...doc, layers: doc.layers.map(l => folders.has(l.id) ? { ...l, visible: true } : inside(l.id) ? l : { ...l, visible: false }) }
}

// Premultiplied pixels read as grayscale: over black, so transparency counts as black, weighed by how bright each color looks.
export function grayPlane(pixels: Raster) {
  const { data } = pixels, plane = new Uint8Array(pixels.width * pixels.height)
  for (let i = 0; i < plane.length; i++) plane[i] = Math.min(255, Math.round(0.2126 * data[i * 4] + 0.7152 * data[i * 4 + 1] + 0.0722 * data[i * 4 + 2]))
  return plane
}

// Export As › Channel Pack: each channel's source read as grayscale at `width` × `height`, packed into a PNG of straight RGBA, and its
// color channels opaque to show (the alpha would hide them). `pixelsOf` renders a layer on its own at the canvas's size; `resize` scales
// premultiplied pixels.
export function channelPack(sources: ChannelSource[], width: number, height: number, resolution: number, pixelsOf: (id: string) => Raster, resize: (pixels: Raster, width: number, height: number) => Raster) {
  const rendered = new Map<string, Uint8Array>(), count = width * height
  const planes = sources.map(source => {
    if (source === 'black' || source === 'white') return new Uint8Array(count).fill(source === 'white' ? 255 : 0)
    if (!rendered.has(source)) rendered.set(source, grayPlane(resize(pixelsOf(source), width, height)))
    return rendered.get(source)!
  })
  const bytes = new Uint8Array(count * 4), preview = new Raster(width, height, 4)
  for (let i = 0; i < count; i++) for (let c = 0; c < 4; c++) { bytes[i * 4 + c] = planes[c][i]; preview.data[i * 4 + c] = c === 3 ? 255 : planes[c][i] }
  return { png: straightPNG(bytes, width, height, resolution), preview }
}

// Split Channels: a layer's red, green, blue and alpha, each an opaque gray image of the same size. The color is divided back out of the
// alpha it was stored multiplied by, so it's only as fine as the alpha allows, and where alpha is 0 it's gone.
export function channelPlanes(image: Raster): Raster[] {
  const { width, height, data } = image
  return [0, 1, 2, 3].map(channel => {
    const out = new Raster(width, height, 4)
    for (let i = 0; i < data.length; i += 4) {
      const a = data[i + 3], value = channel === 3 ? a : a ? Math.min(255, Math.round(data[i + channel] * 255 / a)) : 0
      out.data[i] = out.data[i + 1] = out.data[i + 2] = value; out.data[i + 3] = 255
    }
    return out
  })
}

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
const crc32 = (bytes: Uint8Array) => { let c = 0xffffffff; for (const b of bytes) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }

// Straight RGBA bytes as a PNG that keeps them exactly, color under transparent pixels included: unfiltered rows, zlib-compressed, sRGB,
// at `resolution` pixels an inch.
export function straightPNG(bytes: Uint8Array, width: number, height: number, resolution: number): Uint8Array<ArrayBuffer> {
  const row = width * 4, raw = new Uint8Array((row + 1) * height)
  for (let y = 0; y < height; y++) raw.set(bytes.subarray(y * row, (y + 1) * row), y * (row + 1) + 1)
  const parts: Uint8Array[] = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])]
  const chunk = (type: string, payload: Uint8Array) => {
    const out = new Uint8Array(payload.length + 12), view = new DataView(out.buffer)
    view.setUint32(0, payload.length); for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
    out.set(payload, 8); view.setUint32(payload.length + 8, crc32(out.subarray(4, payload.length + 8)))
    parts.push(out)
  }
  const header = new Uint8Array(13), perMeter = Math.max(1, Math.round(resolution / 0.0254)), physical = new Uint8Array(9)
  new DataView(header.buffer).setUint32(0, width); new DataView(header.buffer).setUint32(4, height); header.set([8, 6, 0, 0, 0], 8)
  new DataView(physical.buffer).setUint32(0, perMeter); new DataView(physical.buffer).setUint32(4, perMeter); physical[8] = 1
  chunk('IHDR', header); chunk('sRGB', new Uint8Array([0])); chunk('pHYs', physical); chunk('IDAT', zlibSync(raw, { level: 6 })); chunk('IEND', new Uint8Array())
  const file = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  parts.reduce((at, p) => { file.set(p, at); return at + p.length }, 0)
  return file
}
