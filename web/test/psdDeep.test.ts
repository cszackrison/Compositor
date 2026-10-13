import { beforeAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { zlibSync } from 'fflate'
import { loadKernels } from '../src/kernels'
import { type PSDDrawing, makeImport, readPSD } from '../src/io/psd'
import { fromHalf, toExtendedSRGB } from '../src/model/deep'
import { Raster } from '../src/model/raster'
import { Buffer } from './psdFixture'

beforeAll(async () => { await loadKernels(readFileSync(new URL('../public/kernels.wasm', import.meta.url))) })

const drawing: PSDDrawing = { text: async () => ({ raster: new Raster(1, 1, 4), baseline: 1 }), shape: () => new Raster(1, 1, 4), path: () => new Raster(1, 1, 4), fontInstalled: async () => true }

// 16- and 32-bit Photoshop files, written as Photoshop writes them: samples big-endian, the layers in an 'Lr16' or 'Lr32' block after
// the global mask (or, as other writers do, in the layer info itself), each channel raw, PackBits or ZIP with or without prediction.
type DeepLayer = { name: string; left: number; top: number; width: number; height: number; channels: [number, number[]][]; compression: 0 | 1 | 2 | 3 }

function samples(values: number[], depth: 16 | 32) {
  const b = new Buffer()
  for (const v of values) {
    if (depth === 16) b.u16(Math.round(Math.min(1, Math.max(0, v)) * 65535))
    else { const view = new DataView(new ArrayBuffer(4)); view.setFloat32(0, v); b.data(new Uint8Array(view.buffer)) }
  }
  return b.build()
}

function encode(bytes: Uint8Array, width: number, height: number, depth: 16 | 32, compression: number) {
  const sample = depth / 8, row = width * sample, b = new Buffer()
  b.u16(compression)
  if (compression === 0) b.data(bytes)
  else if (compression === 1) {
    const rows = Array.from({ length: height }, (_, y) => {
      const r = new Buffer(), line = bytes.subarray(y * row, (y + 1) * row)
      for (let at = 0; at < line.length; at += 128) { const chunk = line.subarray(at, at + 128); r.u8(chunk.length - 1); r.data(chunk) }
      return r.build()
    })
    rows.forEach(r => b.u16(r.length)); rows.forEach(r => b.data(r))
  } else {
    const out = bytes.slice()
    if (compression === 3) for (let y = 0; y < height; y++) {
      const start = y * row
      if (depth === 16) for (let x = width - 1; x > 0; x--) {
        const at = start + x * 2, v = (((out[at] << 8) | out[at + 1]) - ((out[at - 2] << 8) | out[at - 1])) & 0xffff
        out[at] = v >> 8; out[at + 1] = v & 255
      } else {
        const planar = new Uint8Array(row)
        for (let x = 0; x < width; x++) for (let k = 0; k < 4; k++) planar[k * width + x] = out[start + x * 4 + k]
        for (let x = row - 1; x > 0; x--) planar[x] = (planar[x] - planar[x - 1]) & 255
        out.set(planar, start)
      }
    }
    b.data(zlibSync(out))
  }
  return b.build()
}

function deepPSD(depth: 16 | 32, width: number, height: number, layers: DeepLayer[], tagged = true) {
  const info = new Buffer()
  info.i16(layers.length)
  const data = layers.map(layer => layer.channels.map(([id, values]) => [id, encode(samples(values, depth), layer.width, layer.height, depth, layer.compression)] as const))
  layers.forEach((layer, i) => {
    info.i32(layer.top); info.i32(layer.left); info.i32(layer.top + layer.height); info.i32(layer.left + layer.width)
    info.u16(layer.channels.length)
    for (const [id, payload] of data[i]) { info.i16(id); info.u32(payload.length) }
    info.string('8BIMnorm'); info.u8(255); info.u8(0); info.u8(0); info.u8(0)
    const extra = new Buffer()
    extra.u32(0); extra.u32(0); extra.u8(layer.name.length); extra.string(layer.name)
    while ((extra.length - 8) % 4) extra.u8(0)
    info.u32(extra.length); info.data(extra.bytes)
  })
  data.forEach(channels => channels.forEach(([, payload]) => info.data(payload)))
  if (info.length % 2) info.u8(0)
  const section = new Buffer()
  if (tagged) {
    section.u32(0); section.u32(0)
    while (info.length % 4) info.u8(0)
    section.string('8BIM'); section.string(depth === 16 ? 'Lr16' : 'Lr32'); section.u32(info.length); section.data(info.bytes)
  } else { section.u32(info.length); section.data(info.bytes); section.u32(0) }
  const file = new Buffer()
  file.string('8BPS'); file.u16(1); file.data(new Uint8Array(6)); file.u16(3); file.u32(height); file.u32(width); file.u16(depth); file.u16(3)
  file.u32(0); file.u32(0)
  file.u32(section.length); file.data(section.bytes)
  file.u16(0); file.data(new Uint8Array(width * height * 3 * depth / 8))
  return file.build()
}

// Two pixels a row, two rows: red, green, blue, and a half-transparent gray.
const red = [1, 0, 0, 0.5], green = [0, 1, 0, 0.5], blue = [0, 0, 1, 0.5], alpha = [1, 1, 1, 0.5]
const channels: [number, number[]][] = [[-1, alpha], [0, red], [1, green], [2, blue]]

describe('16- and 32-bit Photoshop files', () => {
  for (const compression of [0, 1, 2, 3] as const) for (const tagged of [true, false]) {
    it(`reads 16-bit layers as 16-bit deep layers (compression ${compression}${tagged ? ', in Lr16' : ''})`, async () => {
      const document = await readPSD(deepPSD(16, 4, 4, [{ name: 'Deep', left: 1, top: 1, width: 2, height: 2, channels, compression }], tagged), drawing)
      expect(document.layers).toHaveLength(1)
      const [record] = document.layers, deep = record.deep!
      expect(record.bounds).toEqual({ x: 1, y: 1, width: 2, height: 2 })
      expect(deep.hdr).toBe(false)
      expect(deep.raster).toBe(record.image)
      expect([...deep.pixels.subarray(0, 4)]).toEqual([65535, 0, 0, 65535])
      expect([...deep.pixels.subarray(12, 16)]).toEqual([16384, 16384, 16384, 32768])
      ;[64, 64, 64, 128].forEach((v, i) => expect(Math.abs(record.image!.data[12 + i] - v)).toBeLessThanOrEqual(1))
      const imported = await makeImport(document, drawing)
      expect(imported.layers[0].deep).toBe(deep)
    })
  }

  for (const compression of [0, 1, 3] as const) it(`reads 32-bit layers as linear light, HDR where brighter than white (compression ${compression})`, async () => {
    const bright = [[-1, [1, 1, 1, 1]], [0, [4, 0.5, 0, 0.214]], [1, [0, 0.5, 0, 0.214]], [2, [0, 0.5, 1, 0.214]]] as [number, number[]][]
    const document = await readPSD(deepPSD(32, 2, 2, [{ name: 'Light', left: 0, top: 0, width: 2, height: 2, channels: bright, compression }]), drawing)
    const deep = document.layers[0].deep!
    expect(deep.hdr).toBe(true)
    expect(fromHalf(deep.pixels[0])).toBeCloseTo(toExtendedSRGB(4), 2)
    expect(fromHalf(deep.pixels[4])).toBeCloseTo(toExtendedSRGB(0.5), 2)
    expect(fromHalf(deep.pixels[12])).toBeCloseTo(0.5, 2)
  })

  it('keeps a 32-bit file within white at 16 bits', async () => {
    const document = await readPSD(deepPSD(32, 2, 2, [{ name: 'Light', left: 0, top: 0, width: 2, height: 2, channels, compression: 0 }]), drawing)
    expect(document.layers[0].deep!.hdr).toBe(false)
  })

  it('reads a merged-only 16-bit file as a deep image', async () => {
    const file = new Buffer()
    file.string('8BPS'); file.u16(1); file.data(new Uint8Array(6)); file.u16(3); file.u32(1); file.u32(2); file.u16(16); file.u16(3)
    file.u32(0); file.u32(0); file.u32(0)
    file.u16(0); file.data(samples([1, 0.25, 0, 0.5, 0, 0.75], 16))
    const document = await readPSD(file.build(), drawing)
    expect(document.layers).toHaveLength(0)
    expect([...document.mergedDeep!.pixels]).toEqual([65535, 0, 0, 65535, 16384, 32768, 49151, 65535])
    expect(document.mergedDeep!.raster).toBe(document.merged)
  })
})
