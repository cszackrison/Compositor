import { bandWeight, forward } from './adjustments'
import { colorRanges, defaultBands, type ColorRange, type HueBand, type HueSaturationSettings } from './types'

const wrap = (d: number) => ((d % 360) + 360) % 360

// How much a color range applies at a hue: Master everywhere, otherwise its band, flipped for the selected range when
// "Apply outside this range" is on.
export function rangeWeight(settings: HueSaturationSettings, range: ColorRange, hue: number) {
  if (range === 'Master') return 1
  const w = bandWeight(settings.bands[range] ?? defaultBands[range], hue)
  return settings.invertRange && range === settings.range ? 1 - w : w
}

// Wraps every handle into 0–360°, and keeps the band under 350° wide.
export function normalized(band: HueBand): HueBand {
  const b = { falloffStart: wrap(band.falloffStart), rangeStart: wrap(band.rangeStart), rangeEnd: wrap(band.rangeEnd), falloffEnd: wrap(band.falloffEnd) }
  if (forward(b.falloffStart, b.falloffEnd) > 350) b.falloffEnd = wrap(b.falloffStart + 350)
  return b
}

// Sample: the band moved to center on a hue, its core and shoulders keeping their widths.
export function centered(band: HueBand, hue: number): HueBand {
  const core = forward(band.rangeStart, band.rangeEnd), lead = forward(band.falloffStart, band.rangeStart), trail = forward(band.rangeEnd, band.falloffEnd)
  const start = wrap(hue - core / 2)
  return normalized({ falloffStart: start - lead, rangeStart: start, rangeEnd: start + core, falloffEnd: start + core + trail })
}

// Add: the nearer edge of the core reaches out to take in a hue the band doesn't fully cover.
export function include(band: HueBand, hue: number): HueBand {
  if (bandWeight(band, hue) >= 1) return band
  const shoulderIn = forward(band.falloffStart, band.rangeStart), shoulderOut = forward(band.rangeEnd, band.falloffEnd)
  if (forward(hue, band.rangeStart) <= forward(band.rangeEnd, hue)) return normalized({ ...band, rangeStart: hue, falloffStart: hue - shoulderIn })
  return normalized({ ...band, rangeEnd: hue, falloffEnd: hue + shoulderOut })
}

// Remove: the nearer edge pulls in until the hue falls outside the band.
export function exclude(band: HueBand, hue: number): HueBand {
  if (bandWeight(band, hue) <= 0) return band
  const shoulderIn = forward(band.falloffStart, band.rangeStart), shoulderOut = forward(band.rangeEnd, band.falloffEnd)
  if (forward(band.falloffStart, hue) <= forward(hue, band.falloffEnd)) return normalized({ ...band, falloffStart: hue + 1, rangeStart: hue + 1 + shoulderIn })
  return normalized({ ...band, falloffEnd: hue - 1, rangeEnd: hue - 1 - shoulderOut })
}

const handleKeys = ['falloffStart', 'rangeStart', 'rangeEnd', 'falloffEnd'] as const

// Moves one handle of the spectrum editor; a move that would put the handles out of order, or make the band narrower than 1° or
// wider than 350°, is ignored.
export function withHandle(band: HueBand, index: number, degrees: number): HueBand {
  const next = { ...band, [handleKeys[index]]: wrap(degrees) }
  const span = forward(next.falloffStart, next.falloffEnd), toStart = forward(next.falloffStart, next.rangeStart), toEnd = forward(next.falloffStart, next.rangeEnd)
  return span > 1 && span <= 350 && toStart <= toEnd && toEnd <= span ? next : band
}

export const handleDegrees = (band: HueBand) => handleKeys.map(k => band[k])

// The range a targeted drag adjusts: the color range that covers this hue most (Reds first on a tie).
export function rangeAt(settings: HueSaturationSettings, hue: number): ColorRange {
  let best: ColorRange = 'Reds', weight = -1
  for (const range of colorRanges.slice(1)) { const w = rangeWeight(settings, range, hue); if (w > weight) { best = range; weight = w } }
  return best
}

// Where a hue lands after every range's hue shift, for the spectrum's lower bar.
export function shiftedHue(settings: HueSaturationSettings, hue: number) {
  let shift = 0
  for (const range of colorRanges) shift += (settings.adjustments[range]?.hue ?? 0) * rangeWeight(settings, range, hue)
  return wrap(hue + shift)
}

export function toHSB(r: number, g: number, b: number) {
  const hi = Math.max(r, g, b), lo = Math.min(r, g, b), d = hi - lo
  let h = 0
  if (d > 0) { h = hi === r ? (g - b) / d : hi === g ? (b - r) / d + 2 : (r - g) / d + 4; h *= 60; if (h < 0) h += 360 }
  return { h, s: hi > 0 ? d / hi : 0, b: hi }
}
