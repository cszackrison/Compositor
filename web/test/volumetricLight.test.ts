import { describe, expect, it } from 'vitest'
import { Raster } from '../src/model/raster'
import { brightestPoint, defaultVolumetric, depthPicture, equalized, ramp, volumetricLight } from '../src/editor/volumetricLight'

const W = 96, H = 64
const flat = (value: number) => Raster.filled(W, H, 4, [value, value, value, 255])
// Near at the left, far at the right: 1 nearest, 0 farthest, as the Mac's DepthMap.
const ramped = Float32Array.from({ length: W * H }, (_, i) => 1 - (i % W) / (W - 1))
const at = (r: Raster, x: number, y: number) => Array.from(r.read(x, y, 1, 1))
const change = (a: Raster, b: Raster, x: number, y: number) => at(a, x, y).slice(0, 3).reduce((sum, v, c) => sum + Math.abs(v - at(b, x, y)[c]), 0)
const square = (x0: number, y0: number, x1: number, y1: number) => Uint8Array.from({ length: W * H }, (_, i) => { const x = i % W, y = Math.floor(i / W); return x >= x0 && x < x1 && y >= y0 && y < y1 ? 255 : 0 })

describe('volumetric light', () => {
  it('leaves black dark away from the light, and lights it near the light', () => {
    const black = flat(0), out = volumetricLight(black, ramped, null, { ...defaultVolumetric, intensity: 60 }, [6, 6])
    expect(Math.max(...at(out, W - 2, H - 2).slice(0, 3))).toBeLessThan(12)
    expect(at(out, 6, 6)[0]).toBeGreaterThan(at(out, W - 2, H - 2)[0] + 20)
    expect(at(out, W - 2, H - 2)[3]).toBe(255)
  })

  it('thickens the haze with distance', () => {
    const gray = flat(128), out = volumetricLight(gray, ramped, null, { ...defaultVolumetric, intensity: 0, haze: 100, distance: 0 }, [W / 2, -1e6])
    const columns = [4, 24, 48, 72, 92].map(x => change(out, gray, x, H / 2))
    for (let i = 1; i < columns.length; i++) expect(columns[i]).toBeGreaterThanOrEqual(columns[i - 1])
    expect(columns[4]).toBeGreaterThan(columns[0] + 20)
  })

  it('keeps the subject clear of the haze when asked, and hazes it by its own depth otherwise', () => {
    const gray = flat(128), subject = square(64, 20, 84, 44), s = { ...defaultVolumetric, intensity: 0, haze: 100 }, light: [number, number] = [W / 2, -1e6]
    const clear = volumetricLight(gray, ramped, subject, s, light), hazed = volumetricLight(gray, ramped, subject, { ...s, keepsSubjectClear: false }, light)
    expect(change(clear, gray, 74, 32)).toBeLessThan(change(clear, gray, 74, 4) / 2)
    expect(change(hazed, gray, 74, 32)).toBeGreaterThan(change(clear, gray, 74, 32) + 10)
  })

  it('guesses the depth without a depth map, hazing the top more than the foot', () => {
    const gray = flat(128), out = volumetricLight(gray, null, null, { ...defaultVolumetric, intensity: 0, haze: 100 }, [W / 2, -1e6])
    expect(change(out, gray, W / 2, 2)).toBeGreaterThan(change(out, gray, W / 2, H - 2))
  })

  it('changes nothing with no haze and no intensity', () => {
    const gray = flat(90), out = volumetricLight(gray, ramped, null, { ...defaultVolumetric, intensity: 0, haze: 0 }, [0, 0])
    expect(out.data).toEqual(gray.data)
  })

  it('reads Distance off the photo’s own spread of depths', () => {
    const distances = new Uint32Array(65536)
    distances[0] = 50; distances[65535] = 50
    expect(ramp(0, distances)[0]).toBeLessThan(0.01)
    ramp(30, null).forEach((v, i) => expect(v).toBeCloseTo([0.18, 0.68][i], 6))
  })

  it('spreads bunched depths apart and keeps their order', () => {
    const bunched = Float32Array.from({ length: 100 }, (_, i) => 0.5 + i * 0.001), spread = equalized(bunched, 1)
    expect(spread[0]).toBeCloseTo(0, 2); expect(spread[99]).toBeCloseTo(1, 2)
    for (let i = 1; i < 100; i++) expect(spread[i]).toBeGreaterThan(spread[i - 1])
  })

  it('extracts the depth as opaque gray, white near', () => {
    const map = depthPicture(ramped, null, W, H, defaultVolumetric)
    expect(at(map, 2, 10)[0]).toBeGreaterThan(240); expect(at(map, W - 3, 10)[0]).toBeLessThan(15); expect(at(map, 50, 10)[3]).toBe(255)
  })

  it('starts the light in the biggest bright area rather than a smaller, hotter one', () => {
    const image = flat(20)
    for (let y = 30; y < 60; y++) for (let x = 10; x < 50; x++) image.data.set([220, 220, 220, 255], (y * W + x) * 4)
    for (let y = 5; y < 9; y++) for (let x = 80; x < 84; x++) image.data.set([255, 255, 255, 255], (y * W + x) * 4)
    const [x, y] = brightestPoint(image)
    expect(x).toBeGreaterThan(10); expect(x).toBeLessThan(50); expect(y).toBeGreaterThan(30); expect(y).toBeLessThan(60)
  })
})
