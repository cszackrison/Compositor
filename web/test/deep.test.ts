import { describe, expect, it, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { loadKernels } from '../src/kernels'
import { deepMerge, deepRun, deepRunCount, runDeep } from '../src/editor/deepFilters'
import * as kinds from '../src/editor/filterKinds'
import type { FilterInput, FilterOutput } from '../src/editor/filters'
import { newAdjustment } from '../src/model/types'
import { flattened, fromHalf, makeDeep } from '../src/model/deep'
import { toHalf } from '../src/io/exr'
import { identity } from '../src/render/gl'
import { Store } from '../src/editor/store'
import { Raster } from '../src/model/raster'
import { fullTransform, newLayer } from '../src/model/types'
import { deepOf } from '../src/model/deep'

beforeAll(async () => { await loadKernels(readFileSync(new URL('../public/kernels.wasm', import.meta.url))) })

const input = { isMask: false, toDocument: identity(), layerId: 'L', transform: { origin: [0, 0], size: [256, 1], rotation: 0, flipX: false, flipY: false, sampling: 'High quality' } } as Omit<FilterInput, 'pixels'>
const job = (name: keyof typeof kinds, ...args: unknown[]) => (pixels: FilterInput) => (kinds[name] as unknown as (input: FilterInput, ...args: unknown[]) => FilterOutput)(pixels, ...args)
// A gentle 16-bit ramp, opaque: 256 pixels across 16 8-bit levels, from 38 to 54.
const ramp = () => { const pixels = new Uint16Array(256 * 4); for (let x = 0; x < 256; x++) { const v = Math.round((38 + x / 16) * 257); pixels.set([v, v, v, 65535], x * 4) } return pixels }

describe('16-bit and HDR layers through filters (DeepLayerTests.swift)', () => {
  it('runs Levels through the 8-bit runs to a smooth 16-bit result', () => {
    const levels = newAdjustment('Levels')
    levels.levels.ranges[0] = { black: 36, gamma: 1, white: 56, outputBlack: 0, outputWhite: 255 }
    const out = runDeep('adjustPixels', job('adjustPixels', levels), input, { pixels: ramp(), width: 256, height: 1, hdr: false }, null, levels).pixels
    const values = new Set<number>()
    for (let x = 0; x < 256; x++) {
      const expected = ((38 + x / 16) - 36) / 20 * 65535
      expect(Math.abs(out[x * 4] - expected), `x ${x}`).toBeLessThan(65535 / 255)
      values.add(out[x * 4])
    }
    // An 8-bit Levels would give 17 values here; at full depth nearly every pixel has its own.
    expect(values.size).toBeGreaterThan(200)
  })

  it('takes Hue/Saturation through its color lookup at 16 bits', () => {
    const hue = newAdjustment('Hue/Saturation')
    hue.hsvSettings!.adjustments.Master = { hue: 0, saturation: 0, lightness: 50 }
    const out = runDeep('adjustPixels', job('adjustPixels', hue), input, { pixels: ramp(), width: 256, height: 1, hdr: false }, null, hue).pixels
    expect(new Set([...out].filter((_, i) => i % 4 === 0)).size).toBeGreaterThan(150)
  })

  it('blurs at full depth on the grid an 8-bit run grew to', () => {
    const pixels = new Uint16Array(9 * 4)
    pixels.set([40000, 20000, 1000, 65535], 4 * 4)
    const out = runDeep('gaussianBlur', job('gaussianBlur', 1, false, kinds.noSides), input, { pixels, width: 9, height: 1, hdr: false }, { width: 15, height: 7, x: 3, y: 3 })
    expect([out.width, out.height]).toEqual([15, 7])
    const center = (3 * 15 + 7) * 4
    expect(out.pixels[center + 3]).toBeGreaterThan(5000)
    expect(out.pixels[center] / out.pixels[center + 3]).toBeCloseTo(40000 / 65535, 3)
  })

  it('turns an HDR layer\'s Exposure down exactly, and keeps highlights through a blur', () => {
    const hdr = new Uint16Array([toHalf(4), toHalf(2), toHalf(0.5), toHalf(1), toHalf(0.25), toHalf(0.25), toHalf(0.25), toHalf(1)])
    const exposure = newAdjustment('Exposure')
    exposure.exposureSettings = { exposure: -2, offset: 0, gamma: 1 }
    const down = runDeep('adjustPixels', job('adjustPixels', exposure), input, { pixels: hdr, width: 2, height: 1, hdr: true }, null, exposure).pixels
    // Two stops down in linear light: 4 in extended sRGB is about 23 in linear light, a quarter of that back in sRGB is about 2.09.
    expect(fromHalf(down[0])).toBeGreaterThan(1.9)
    expect(fromHalf(down[0])).toBeLessThan(2.3)
    const blurred = runDeep('gaussianBlur', job('gaussianBlur', 0.5, false, { left: true, right: true, top: true, bottom: true }), input, { pixels: hdr, width: 2, height: 1, hdr: true }, null).pixels
    expect(fromHalf(blurred[0])).toBeGreaterThan(1)
  })

  it('makes the same result from its 8-bit runs one at a time, as workers share them', () => {
    const hdr = new Uint16Array(256 * 4)
    for (let x = 0; x < 256; x++) hdr.set([toHalf(x / 64), toHalf(0.3), toHalf(x / 300), toHalf(1)], x * 4)
    for (const pixels of [ramp(), hdr]) {
      const deep = { pixels, width: 256, height: 1, hdr: pixels === hdr }, run = job('tonalContrast', 60, 20, 30, 40, 4)
      const count = deepRunCount('tonalContrast')
      const parts = Array.from({ length: count }, (_, i) => deepRun('tonalContrast', run, input, deep, null, i))
      expect(count).toBe(10)
      expect(deepMerge('tonalContrast', deep, null, parts).pixels).toEqual(runDeep('tonalContrast', run, input, deep, null).pixels)
      // Merged a band of rows at a time, as the workers share it.
      const square = { ...deep, width: 16, height: 16 }, squareParts = Array.from({ length: count }, (_, i) => deepRun('tonalContrast', run, input, square, null, i))
      const band = (y0: number, y1: number) => deepMerge('tonalContrast', { ...square, pixels: pixels.slice(y0 * 64, y1 * 64), height: y1 - y0 }, null, squareParts.map(r => new Raster(16, y1 - y0, 4, r.data.slice(y0 * 64, y1 * 64))), y0).pixels
      expect([...band(0, 5), ...band(5, 16)]).toEqual([...deepMerge('tonalContrast', square, null, squareParts).pixels])
    }
    expect(deepRunCount('gaussianBlur')).toBe(0)
  })

  it('keeps HDR pixels HDR only while they go past white', () => {
    expect(makeDeep(new Uint16Array([toHalf(0.5), toHalf(0.5), toHalf(0.5), toHalf(1)]), 1, 1, true).deep.hdr).toBe(false)
    const kept = makeDeep(new Uint16Array([toHalf(3), toHalf(0.5), toHalf(0.5), toHalf(1)]), 1, 1, true).deep
    expect(kept.hdr).toBe(true)
    expect(flattened(kept)).toBe(kept.pixels)
  })
})

describe('16-bit layers through the store', () => {
  function deepDoc() {
    const store = new Store()
    const pixels = new Uint16Array(4 * 4 * 4)
    for (let i = 0; i < 16; i++) pixels.set([10000 + i * 1000, 30000, 50000, 65535], i * 4)
    const made = makeDeep(pixels, 4, 4, false)
    const layer = newLayer({ name: 'Deep', transform: fullTransform(4, 4), image: made.image, deep: made.deep })
    store.open({ id: 'D', width: 4, height: 4, resolution: 72, layers: [layer], guides: [], extra: {} }, layer.id, null)
    return { store, pixels, deep: () => { const l = store.doc.layers[0]; return deepOf(l) ? flattened(deepOf(l)!) : null } }
  }

  it('inverts exactly, duplicates and undoes at 16 bits', () => {
    const { store, pixels, deep } = deepDoc()
    store.invertPixels()
    expect(deep()![0]).toBe(65535 - 10000)
    store.duplicate()
    expect(flattened(deepOf(store.active!)!)[4]).toBe(65535 - 11000)
    store.undo(); store.undo()
    expect([...deep()!]).toEqual([...pixels])
    store.redo()
    expect(deep()![0]).toBe(65535 - 10000)
  })

  it('fills through a soft selection, converts, and resamples at 16 bits', () => {
    const { store, deep } = deepDoc()
    store.set({ selection: Raster.filled(4, 4, 1, [128]) })
    store.fill(null)
    expect(Math.abs(deep()![3] - 65535 * 127 / 255)).toBeLessThan(2)
    store.set({ selection: null })
    store.imageSize(2, 2, 72, 'High quality', true)
    expect([store.doc.layers[0].image!.width, deep()!.length]).toEqual([2, 16])
    store.convertDepth()
    expect([store.doc.layers[0].deep, deep()]).toEqual([undefined, null])
    store.convertDepth()
    expect(deep()![3]).toBe(store.doc.layers[0].image!.data[3] * 257)
  })
})
