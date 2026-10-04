import { describe, expect, it } from 'vitest'
import { contrast, guided, refined, resize, shiftEdge } from '../src/ai/matte'

const disc = (size: number, radius: number) => Float32Array.from({ length: size * size }, (_, i) => Math.hypot((i % size) - size / 2, Math.floor(i / size) - size / 2) < radius ? 1 : 0)
const area = (mask: Float32Array) => mask.reduce((sum, v) => sum + v, 0)

describe('remove background matte', () => {
  it('leaves a Basic mask as it is', () => {
    const mask = disc(32, 10)
    expect(refined(mask, new Uint8Array(32 * 32 * 4), 32, 32, { quality: 'Basic', refine: 12, contrast: 25, shiftEdge: -5 })).toBe(mask)
  })
  it('keeps constant images constant through resizing either way', () => {
    const flat = new Float32Array(40 * 30).fill(0.4)
    for (const v of resize(flat, 40, 30, 13, 9)) expect(v).toBeCloseTo(0.4, 5)
    for (const v of resize(flat, 40, 30, 97, 61)) expect(v).toBeCloseTo(0.4, 5)
  })
  it('contrast: 0 changes nothing, 100 cuts at the middle', () => {
    const ramp = Float32Array.from({ length: 11 }, (_, i) => i / 10)
    contrast(ramp, 0).forEach((v, i) => expect(v).toBeCloseTo(ramp[i], 6))
    const hard = contrast(ramp, 100)
    expect(hard[2]).toBe(0); expect(hard[8]).toBe(1)
  })
  it('shift edge shrinks the mask for negative amounts and grows it for positive ones', () => {
    const mask = disc(64, 16)
    expect(area(shiftEdge(mask, 64, 64, -4))).toBeLessThan(area(mask))
    expect(area(shiftEdge(mask, 64, 64, 4))).toBeGreaterThan(area(mask))
  })
  it('the guided filter pulls a rough mask onto the guide’s edge', () => {
    const size = 48, guide = disc(size, 12), rough = disc(size, 14)
    const pulled = guided(rough, guide, size, size, 6, 1e-4)
    expect(Math.abs(area(pulled) - area(guide))).toBeLessThan(Math.abs(area(rough) - area(guide)))
  })
})
