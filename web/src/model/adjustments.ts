import { type Adjustment, type ColorRange, type CurvePoint, type HueBand, type LevelRange, type RangeAdjustment, colorRanges, defaultBands } from './types'
import { call, withBuffers, floats } from '../kernels'

const clamp01 = (v: number) => Math.min(1, Math.max(0, v))

export function isIdentityRange(r: LevelRange) { return r.black === 0 && r.gamma === 1 && r.white === 255 && r.outputBlack === 0 && r.outputWhite === 255 }

export function applyRange(r: LevelRange, v: number) {
  const input = clamp01((v * 255 - r.black) / (r.white - r.black))
  return (r.outputBlack + Math.pow(input, 1 / r.gamma) * (r.outputWhite - r.outputBlack)) / 255
}

// Monotone cubic Hermite through the points, with Fritsch–Butland harmonic-mean slopes, as Curves.swift draws it.
export function curveValue(points: CurvePoint[], x: number) {
  const n = points.length
  if (n < 2) return x
  let i = 0
  for (let k = 0; k < n; k++) if (points[k].x <= x) i = k
  i = Math.min(Math.max(i, 0), n - 2)
  const d = (k: number) => (points[k + 1].y - points[k].y) / (points[k + 1].x - points[k].x)
  const slope = (j: number) => j === 0 ? d(0) : j === n - 1 ? d(n - 2) : d(j - 1) * d(j) <= 0 ? 0 : 2 / (1 / d(j - 1) + 1 / d(j))
  const h = points[i + 1].x - points[i].x, t = clamp01((x - points[i].x) / h)
  const t2 = t * t, t3 = t2 * t
  const y = (2 * t3 - 3 * t2 + 1) * points[i].y + (t3 - 2 * t2 + t) * h * slope(i) + (-2 * t3 + 3 * t2) * points[i + 1].y + (t3 - t2) * h * slope(i + 1)
  return Math.min(255, Math.max(0, y))
}

// 3 × 256 floats (red, green, blue), each the output for an unpremultiplied input i/255; null means the adjustment changes nothing.
export function channelTables(adjustment: Adjustment): Float32Array | null {
  const tables = new Float32Array(768)
  if (adjustment.kind === 'Levels') {
    const ranges = adjustment.levels.ranges
    if (ranges.every(isIdentityRange)) return null
    for (let c = 0; c < 3; c++) for (let i = 0; i < 256; i++) tables[c * 256 + i] = applyRange(ranges[0], applyRange(ranges[c + 1], i / 255))
  } else if (adjustment.kind === 'Curves') {
    const channels = adjustment.curves.channels
    for (let c = 0; c < 3; c++) for (let i = 0; i < 256; i++) tables[c * 256 + i] = curveValue(channels[0], curveValue(channels[c + 1], i)) / 255
  } else if (adjustment.kind === 'Exposure') {
    const { exposure, offset, gamma } = adjustment.exposureSettings ?? { exposure: 0, offset: 0, gamma: 1 }
    for (let i = 0; i < 256; i++) {
      const e = i / 255
      let lin = e <= 0.04045 ? e / 12.92 : Math.pow((e + 0.055) / 1.055, 2.4)
      lin = Math.pow(Math.max(0, lin * Math.pow(2, exposure) + offset), 1 / gamma)
      const out = clamp01(lin <= 0.0031308 ? lin * 12.92 : 1.055 * Math.pow(lin, 1 / 2.4) - 0.055)
      tables[i] = tables[256 + i] = tables[512 + i] = out
    }
  } else return null
  return tables
}

export function forward(a: number, b: number) { let d = (b - a) % 360; if (d < 0) d += 360; return d }

export function bandWeight(band: HueBand, h: number) {
  const span = forward(band.falloffStart, band.falloffEnd)
  if (span === 0) return 1
  const pos = forward(band.falloffStart, h)
  if (pos > span) return 0
  const into = forward(band.falloffStart, band.rangeStart), plateau = forward(band.falloffStart, band.rangeEnd)
  if (pos < into) return into > 0 ? pos / into : 1
  if (pos <= plateau) return 1
  const out = span - plateau
  return out > 0 ? (span - pos) / out : 1
}

function toHSL(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, delta = max - min
  if (delta === 0) return [0, 0, l]
  const s = Math.min(1, delta / (1 - Math.abs(2 * l - 1)))
  let h = max === r ? 60 * ((g - b) / delta) : max === g ? 60 * ((b - r) / delta + 2) : 60 * ((r - g) / delta + 4)
  if (h < 0) h += 360
  return [h, s, l]
}

function toRGB(h: number, s: number, l: number): [number, number, number] {
  if (s <= 0) return [l, l, l]
  const c = (1 - Math.abs(2 * l - 1)) * s, sector = h / 60, x = c * (1 - Math.abs(sector % 2 - 1)), m = l - c / 2
  const [r, g, b] = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c]][Math.floor(sector)] ?? [c, 0, x]
  return [clamp01(r + m), clamp01(g + m), clamp01(b + m)]
}

function adjustedSaturation(s: number, amount: number) {
  const a = Math.min(1, Math.max(-1, amount / 100))
  if (a <= 0) return Math.max(0, s * (1 + a))
  if (a >= 1) return s > 0 ? 1 : 0
  return Math.min(1, s / (1 - a))
}

export const cubeSize = 33

// The Hue/Saturation 33³ RGBA float cube, red fastest, as HueSaturation.swift builds it.
export function hueSaturationCube(adjustment: Adjustment): Float32Array {
  const settings = adjustment.hsvSettings ?? { range: 'Master' as ColorRange, colorize: adjustment.colorize, invertRange: false, adjustments: { Master: { hue: adjustment.hue, saturation: adjustment.saturation, lightness: adjustment.lightness } }, bands: {} }
  const response = Array.from({ length: 361 }, () => ({ shift: 0, saturation: 0, lightness: 0 }))
  for (const range of colorRanges) {
    const a: RangeAdjustment | undefined = settings.adjustments[range]
    if (!a || (!a.hue && !a.saturation && !a.lightness)) continue
    const band = settings.bands[range] ?? defaultBands[range]
    for (let deg = 0; deg <= 360; deg++) {
      let w = range === 'Master' ? 1 : bandWeight(band, deg)
      if (settings.invertRange && range === settings.range) w = 1 - w
      response[deg].shift += a.hue * w; response[deg].saturation += a.saturation * w; response[deg].lightness += a.lightness * w
    }
  }
  const selected = settings.adjustments[settings.range] ?? { hue: 0, saturation: 0, lightness: 0 }
  const n = cubeSize, cube = new Float32Array(n * n * n * 4)
  let index = 0
  for (let b = 0; b < n; b++) for (let g = 0; g < n; g++) for (let r = 0; r < n; r++) {
    let [h, s, l] = toHSL(r / (n - 1), g / (n - 1), b / (n - 1))
    let amount: number
    if (settings.colorize) {
      h = ((selected.hue % 360) + 360) % 360
      s = clamp01(selected.saturation / 100)
      amount = selected.lightness / 100
    } else {
      const response1 = response[Math.min(360, Math.max(0, Math.round(h)))]
      amount = response1.lightness / 100
      h = (h + response1.shift) % 360
      if (h < 0) h += 360
      s = adjustedSaturation(s, response1.saturation)
    }
    const a = Math.min(1, Math.max(-1, amount))
    l = a >= 0 ? l + (1 - l) * a : l * (1 + a)
    const [ro, go, bo] = toRGB(h, s, clamp01(l))
    cube.set([ro, go, bo, 1], index)
    index += 4
  }
  return cube
}

// The other color-only kinds come from running the app's own C kernel over an opaque lattice of every cube color.
export function kernelCube(adjustment: Adjustment): Float32Array | null {
  const n = cubeSize, count = n * n * n
  const lattice = new Uint8Array(count * 4)
  let index = 0
  for (let b = 0; b < n; b++) for (let g = 0; g < n; g++) for (let r = 0; r < n; r++) {
    lattice[index] = Math.round(r * 255 / (n - 1)); lattice[index + 1] = Math.round(g * 255 / (n - 1)); lattice[index + 2] = Math.round(b * 255 / (n - 1)); lattice[index + 3] = 255
    index += 4
  }
  const stride = count * 4
  if (adjustment.kind === 'Black & White') {
    const s = adjustment.blackWhiteSettings!
    withBuffers([{ data: lattice, out: true }, floats([s.reds, s.yellows, s.greens, s.cyans, s.blues, s.magentas].map(v => v / 100))], ([pixels, weights]) => call('adjust_black_white', pixels, count, 1, stride, weights, s.tint ? 1 : 0, s.tintHue, s.tintSaturation / 100))
  } else if (adjustment.kind === 'Color Balance') {
    const s = adjustment.colorBalanceSettings!
    const values = [s.shadowCyanRed, s.shadowMagentaGreen, s.shadowYellowBlue, s.midCyanRed, s.midMagentaGreen, s.midYellowBlue, s.highlightCyanRed, s.highlightMagentaGreen, s.highlightYellowBlue]
    if (values.every(v => v === 0)) return null
    withBuffers([{ data: lattice, out: true }, floats(values.slice(0, 3).map(v => v / 100)), floats(values.slice(3, 6).map(v => v / 100)), floats(values.slice(6).map(v => v / 100))], ([pixels, shadows, mids, highs]) => call('adjust_color_balance', pixels, count, 1, stride, shadows, mids, highs, s.preserveLuminosity ? 1 : 0))
  } else if (adjustment.kind === 'Gradient Map') {
    const s = adjustment.gradientMapSettings!
    const [dark, light] = s.reversed ? [s.highlights, s.shadows] : [s.shadows, s.highlights]
    const table = new Uint8Array(768)
    for (let i = 0; i < 256; i++) ['red', 'green', 'blue'].forEach((c, k) => { const d = (dark as any)[c], l = (light as any)[c]; table[i * 3 + k] = Math.min(255, Math.max(0, Math.round((d + (l - d) * i / 255) * 255))) })
    withBuffers([{ data: lattice, out: true }, { data: table }], ([pixels, t]) => call('adjust_gradient_map', pixels, count, 1, stride, t))
  } else return null
  const cube = new Float32Array(count * 4)
  for (let i = 0; i < count * 4; i++) cube[i] = lattice[i] / 255
  return cube
}
