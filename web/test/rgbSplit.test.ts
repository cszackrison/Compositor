import { describe, expect, it } from 'vitest'
import { Raster } from '../src/model/raster'
import { rgbSplit, type RGBSplitSettings } from '../src/editor/rgbSplit'

const settings = (overrides: Partial<RGBSplitSettings>): RGBSplitSettings => ({ distance: 10, blur: 0, angle: 0, radial: false, center: [32, 32], reach: 1000, ...overrides })
const at = (r: Raster, x: number, y: number) => [...r.data.subarray((y * r.width + x) * 4, (y * r.width + x) * 4 + 4)]

// A white vertical line, 2 pixels wide, at x = 31–32 on opaque black.
function line(size = 64) {
  const image = Raster.filled(size, size, 4, [0, 0, 0, 255])
  for (let y = 0; y < size; y++) for (const x of [31, 32]) image.data.set([255, 255, 255, 255], (y * size + x) * 4)
  return image
}

describe('RGB Split', () => {
  it('leaves the image unchanged with no distance or blur', () => {
    const image = line(), out = rgbSplit(image, settings({ distance: 0, blur: 0 }))
    expect(out).not.toBe(image)
    expect(Buffer.from(out.data).equals(Buffer.from(image.data))).toBe(true)
  })

  it('fans a line into colored fringes along the angle, red ahead and blue behind', () => {
    const out = rgbSplit(line(), settings({ distance: 12 }))
    const ahead = at(out, 37, 20), behind = at(out, 26, 20)
    expect(ahead[0]).toBeGreaterThan(ahead[2] + 20)
    expect(behind[2]).toBeGreaterThan(behind[0] + 20)
    for (const p of [ahead, behind]) expect(p[3]).toBe(255)
    // At 90°, a vertical line splits along itself and stays put.
    const along = rgbSplit(line(), settings({ distance: 12, angle: 90 }))
    expect(at(along, 37, 20)).toEqual([0, 0, 0, 255])
  })

  it('keeps colors within alpha and smears with blur', () => {
    const image = new Raster(64, 64, 4)
    for (let y = 20; y < 44; y++) for (let x = 20; x < 44; x++) image.data.set([200, 100, 50, 255], (y * 64 + x) * 4)
    const out = rgbSplit(image, settings({ distance: 6, blur: 16 }))
    for (let i = 0; i < out.data.length; i += 4) for (let c = 0; c < 3; c++) expect(out.data[i + c]).toBeLessThanOrEqual(out.data[i + 3])
    expect(at(out, 12, 32)[3]).toBeGreaterThan(0)
    expect(at(out, 32, 12)[3]).toBe(0)
  })

  it('leaves the center sharp when radial', () => {
    const image = new Raster(64, 64, 4)
    for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) image.data.set((x >> 3) % 2 ? [255, 255, 255, 255] : [0, 0, 0, 255], (y * 64 + x) * 4)
    const out = rgbSplit(image, settings({ distance: 12, radial: true, center: [36, 32], reach: 32 }))
    for (const x of [34, 35, 36, 37, 38]) expect(at(out, x, 32)).toEqual(at(image, x, 32))
    const fringes = [56, 57, 58, 59, 60, 61, 62, 63].map(x => at(out, x, 32)).map(p => Math.abs(p[0] - p[2]))
    expect(Math.max(...fringes)).toBeGreaterThan(40)
  })

  it('carries the edge on past the canvas sides', () => {
    const image = Raster.filled(32, 32, 4, [255, 255, 255, 255])
    expect(at(rgbSplit(image, settings({ distance: 8, center: [16, 16] })), 0, 16)[3]).toBeLessThan(255)
    expect(at(rgbSplit(image, settings({ distance: 8, center: [16, 16] }), { left: true, right: true, top: true, bottom: true }), 0, 16)).toEqual([255, 255, 255, 255])
  })

  it('runs a 1024 px layer with blur in reasonable time', () => {
    const size = 1024, image = new Raster(size, size, 4)
    for (let i = 0; i < image.data.length; i += 4) { const v = (i >> 2) * 2654435761 >>> 24; image.data.set([v, v >> 1, 255 - v, 255], i) }
    const start = performance.now()
    rgbSplit(image, settings({ distance: 40, blur: 60, center: [512, 512] }))
    expect(performance.now() - start).toBeLessThan(8000)
  }, 30000)
})
