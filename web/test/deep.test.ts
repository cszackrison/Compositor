import { describe, expect, it, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { loadKernels } from '../src/kernels'
import { runDeep } from '../src/editor/deepFilters'
import * as kinds from '../src/editor/filterKinds'
import type { FilterInput, FilterOutput } from '../src/editor/filters'
import { newAdjustment } from '../src/model/types'
import { flattened, fromHalf, makeDeep } from '../src/model/deep'
import { toHalf } from '../src/io/exr'
import { identity } from '../src/render/gl'

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

  it('keeps HDR pixels HDR only while they go past white', () => {
    expect(makeDeep(new Uint16Array([toHalf(0.5), toHalf(0.5), toHalf(0.5), toHalf(1)]), 1, 1, true).deep.hdr).toBe(false)
    const kept = makeDeep(new Uint16Array([toHalf(3), toHalf(0.5), toHalf(0.5), toHalf(1)]), 1, 1, true).deep
    expect(kept.hdr).toBe(true)
    expect(flattened(kept)).toBe(kept.pixels)
  })
})
