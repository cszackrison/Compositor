import { describe, expect, it } from 'vitest'
import { Raster } from '../src/model/raster'
import { defaultRimLight, maximumRimLights, nextRimLight, rimLight, type RimLightSettings } from '../src/editor/rimLight'

const size = 300, center = 150, radius = 90

// A flat warm disc on a clear layer.
function disc() {
  const image = new Raster(size, size, 4)
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (Math.hypot(x + 0.5 - center, y + 0.5 - center) < radius) image.data.set([140, 105, 90, 255], (y * size + x) * 4)
  return image
}
const at = (r: Raster, x: number, y: number) => Array.from(r.data.subarray((y * r.width + x) * 4, (y * r.width + x) * 4 + 4))
const fromLeft = (glow = 0, width = 30, choke = 0): RimLightSettings => ({ glow, lights: [{ angle: 180, color: [255, 255, 255], strength: 80, width, choke }] })

describe('rim light', () => {
  it('starts as the Mac does', () => {
    expect(defaultRimLight).toEqual({ glow: 10, lights: [{ angle: 135, color: [255, 219, 179], strength: 50, width: 30, choke: 0 }] })
    expect(maximumRimLights).toBe(3)
    const second = nextRimLight(defaultRimLight)
    expect(second).toEqual({ angle: -45, color: [179, 214, 255], strength: 50, width: 30, choke: 0 })
    expect(nextRimLight({ ...defaultRimLight, lights: [defaultRimLight.lights[0], second] }).color).toEqual([255, 255, 255])
  })

  it('leaves a clear layer clear', () => {
    const out = rimLight(new Raster(64, 48, 4), { ...defaultRimLight, glow: 100 })
    expect(out.width).toBe(64)
    expect(out.data.every(v => v === 0)).toBe(true)
  })

  it('lights the edge facing the light and not the one across from it', () => {
    const image = disc(), lit = rimLight(image, fromLeft())
    expect(lit.width).toBe(size)
    const row = center, left = center - radius + 2, right = center + radius - 3
    const lift = (x: number) => at(lit, x, row)[1] - at(image, x, row)[1]
    expect(lift(left)).toBeGreaterThan(25)
    expect(lift(right)).toBeLessThanOrEqual(1)
    expect(lift(center)).toBeLessThanOrEqual(1)
    expect(at(lit, 5, 5)).toEqual([0, 0, 0, 0])
    expect(at(lit, left, row)[3]).toBe(255)
  })

  it('reaches further in with Width and Choke, and Glow wraps across the lit edge', () => {
    const image = disc(), x = center - radius + 9, lift = (s: RimLightSettings) => at(rimLight(image, s), x, center)[1] - at(image, x, center)[1]
    expect(lift(fromLeft(0, 100))).toBeGreaterThan(lift(fromLeft(0, 0)) + 10)
    expect(lift({ glow: 0, lights: [{ ...fromLeft().lights[0], strength: 15, width: 100, choke: 100 }] })).toBeGreaterThan(lift({ glow: 0, lights: [{ ...fromLeft().lights[0], strength: 15, width: 100, choke: 0 }] }))
    const inside = center - radius + 3, edge = (glow: number) => at(rimLight(image, fromLeft(glow, 0, 100)), inside, center)[1]
    expect(edge(100)).toBeGreaterThan(edge(0) + 4)
    expect(at(rimLight(image, fromLeft(100)), center, center)).toEqual(at(image, center, center))
  })
})
