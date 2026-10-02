import { describe, expect, it } from 'vitest'
import { centered, exclude, include, rangeAt, withHandle } from '../src/model/hueBands'
import { defaultBands, type HueSaturationSettings } from '../src/model/types'

const reds = defaultBands.Reds
const settings: HueSaturationSettings = { range: 'Reds', colorize: false, invertRange: false, adjustments: {}, bands: { ...defaultBands } }

describe('Hue/Saturation bands', () => {
  it('centers a band on a sampled hue, keeping its widths', () => {
    expect(centered(reds, 60)).toEqual({ falloffStart: 15, rangeStart: 45, rangeEnd: 75, falloffEnd: 105 })
  })
  it('widens to include a hue and narrows to exclude one', () => {
    expect(include(reds, 60)).toEqual({ ...reds, rangeEnd: 60, falloffEnd: 90 })
    expect(exclude(reds, 30)).toEqual({ ...reds, falloffEnd: 29, rangeEnd: -1 + 360 })
  })
  it('ignores handle moves that would break the band', () => {
    expect(withHandle(reds, 1, 20)).toEqual(reds)
    expect(withHandle(reds, 1, 340)).toEqual({ ...reds, rangeStart: 340 })
  })
  it('picks the range that covers a hue most', () => {
    expect(rangeAt(settings, 120)).toBe('Greens')
    expect(rangeAt(settings, 0)).toBe('Reds')
  })
})
