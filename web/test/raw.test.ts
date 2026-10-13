import { describe, expect, it } from 'vitest'
import { asShotFromCamera, developPixels, rawSettings, temperatureOf, whiteBalance } from '../src/model/rawDevelop'

describe('RAW develop', () => {
  it('reads the light\'s temperature and leaves white alone as shot', () => {
    expect(Math.abs(temperatureOf([1, 1, 1]).temperature - 6500)).toBeLessThan(150)
    const warm = temperatureOf([1, 0.75, 0.45])
    expect(warm.temperature).toBeLessThan(5000)
    const m = whiteBalance(rawSettings(5200, 10))
    ;[1, 0, 0, 0, 1, 0, 0, 0, 1].forEach((v, i) => expect(m[i]).toBeCloseTo(v, 4))
    // Daylight multipliers as shot read as daylight.
    expect(Math.abs(asShotFromCamera([2, 1, 1.5, 1], [2, 1, 1.5, 1], [[1, 0, 0], [0, 1, 0], [0, 0, 1]]).temperature - 6500)).toBeLessThan(150)
  })
  it('warms the picture when the temperature goes up, and keeps gray gray as shot', () => {
    const gray = new Uint16Array([12000, 12000, 12000]), shot = rawSettings(5000, 0)
    const asShot = developPixels(gray, 1, shot)
    expect(asShot[0]).toBe(asShot[1]); expect(asShot[1]).toBe(asShot[2])
    const warmer = developPixels(gray, 1, { ...shot, temperature: 7500 })
    expect(warmer[0]).toBeGreaterThan(warmer[2])
    const brighter = developPixels(gray, 1, { ...shot, exposure: 1 })
    expect(brighter[1]).toBeGreaterThan(asShot[1])
    const flat = developPixels(gray, 1, { ...shot, boost: 0 })
    expect(flat[1]).not.toBe(asShot[1])
  })
})
