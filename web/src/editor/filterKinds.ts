import { Raster } from '../model/raster'
import { blurFloats, blurRaster, kernelInPlace } from '../model/pixels'
import { call, floats, withBuffers } from '../kernels'
import { apply, invert } from '../render/gl'
import type { FilterInput, FilterOutput } from './filters'
import type { Adjustment } from '../model/types'
import { applyCameraRaw, type CameraRawSettings, type CameraRawView } from '../model/cameraRaw'
import { channelTables, cubeSize, hueSaturationCube } from '../model/adjustments'

const clamp01 = (v: number) => Math.min(1, Math.max(0, v))

// Pixels as floats on the 0–255 scale, nothing rounded or clipped: a 16-bit or HDR layer's, for the blurs and Bloom, which run on them
// directly (model/deep.ts, `runsAtFullDepth`) as the Mac runs them in Core Image at full depth.
export class FloatPixels {
  constructor(readonly width: number, readonly height: number, readonly channels: 4 = 4, readonly data: Float32Array = new Float32Array(width * height * 4)) {}
}
const isFloat = (pixels: Raster | FloatPixels): pixels is FloatPixels => pixels instanceof FloatPixels
const like = (pixels: Raster | FloatPixels, width: number, height: number) => isFloat(pixels) ? new FloatPixels(width, height) as unknown as Raster : new Raster(width, height, 4)
const put = (pixels: Raster | FloatPixels, v: number) => isFloat(pixels) ? v : Math.round(v)

// Pads a raster by `margin` transparent pixels on every side, for filters that spread past the layer's edges.
function padded(pixels: Raster, margin: number): { pixels: Raster; origin: [number, number] } {
  return paddedSides(pixels, margin, noSides)
}

// A layer's sides (in its own pixels, top is row 0) at or past the canvas's edge.
export type Sides = { left: boolean; right: boolean; top: boolean; bottom: boolean }
export const noSides: Sides = { left: false, right: false, top: false, bottom: false }
const anySide = (sides: Sides) => sides.left || sides.right || sides.top || sides.bottom

// Pads by `margin` transparent pixels on every side but `sides`, which Gaussian and Motion Blur then carry their edge pixels on past
// (blurring with clamped edges), as Photoshop's do at the canvas's edge: a picture filling the canvas keeps solid edges.
function paddedSides(pixels: Raster, margin: number, sides: Sides): { pixels: Raster; origin: [number, number] } {
  const left = sides.left ? 0 : margin, top = sides.top ? 0 : margin
  const out = like(pixels, pixels.width + left + (sides.right ? 0 : margin), pixels.height + top + (sides.bottom ? 0 : margin))
  for (let y = 0; y < pixels.height; y++) out.data.set(pixels.data.subarray(y * pixels.width * 4, (y + 1) * pixels.width * 4), ((y + top) * out.width + left) * 4)
  return { pixels: out, origin: [left ? -left : 0, top ? -top : 0] }
}

// `preserveTransparency` blurs only the colors, from the layer's own pixels, and keeps every pixel's alpha, so the outline stays put.
export function gaussianBlur(input: FilterInput, radius: number, preserveTransparency = false, sides: Sides = noSides): FilterOutput {
  if (radius <= 0) return null
  if (preserveTransparency && !input.isMask) {
    const { pixels } = input, blurred = blurFloats(Float32Array.from(pixels.data), pixels.width, pixels.height, 4, radius)
    // Dividing by the blurred alpha takes out the pull of the clear pixels around, which would darken the colors near the outline.
    for (let i = 0; i < pixels.data.length; i += 4) {
      const a = pixels.data[i + 3], b = blurred[i + 3]
      for (let c = 0; c < 3; c++) pixels.data[i + c] = b > 0 ? put(pixels, Math.min(a, blurred[i + c] / b * a)) : 0
    }
    return pixels
  }
  const margin = input.isMask ? 0 : Math.ceil(radius * 3 + 2)
  const grid = margin ? paddedSides(input.pixels, margin, sides) : { pixels: input.pixels, origin: [0, 0] as [number, number] }
  const clamped = input.isMask || anySide(sides)
  if (isFloat(grid.pixels)) return { pixels: new FloatPixels(grid.pixels.width, grid.pixels.height, 4, blurFloats(grid.pixels.data, grid.pixels.width, grid.pixels.height, 4, radius, clamped)) as unknown as Raster, origin: grid.origin }
  return { pixels: blurRaster(grid.pixels, radius, clamped), origin: grid.origin }
}

// Filter › Progressive Blur: a Gaussian blur whose radius changes evenly along a line (document coordinates), `from` at its start and
// `to` at its end and past it, or radially from the start out to the circle through the end. Made from blurs at a few radii, each
// pixel blending the two either side of its own, one pair at a time so a large layer holds only three copies.
export function progressiveBlur(input: FilterInput, from: number, to: number, start: [number, number], end: [number, number], radial: boolean, inverted: boolean, sides: Sides = noSides): FilterOutput {
  if (inverted) [from, to] = [to, from]
  const strongest = Math.max(from, to)
  if (strongest <= 0) return null
  const margin = input.isMask ? 0 : Math.ceil(strongest * 3 + 2)
  const grid = margin ? paddedSides(input.pixels, margin, sides) : { pixels: input.pixels, origin: [0, 0] as [number, number] }
  const { width, height } = grid.pixels, clamp = input.isMask || anySide(sides)
  const toPixel = invert(input.toDocument), at = (point: [number, number]) => { const [x, y] = apply(toPixel, ...point); return [x - grid.origin[0], y - grid.origin[1]] }
  const [sx, sy] = at(start), [ex, ey] = at(end)
  let [dx, dy] = [ex - sx, ey - sy]
  if (Math.hypot(dx, dy) < 1) [dx, dy] = [0, 1]
  const length = Math.hypot(dx, dy), radius = new Float32Array(width * height)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const px = x + 0.5 - sx, py = y + 0.5 - sy, t = radial ? Math.hypot(px, py) / length : (px * dx + py * dy) / (length * length)
    radius[y * width + x] = from + (to - from) * clamp01(t)
  }
  const levels = [0]
  for (let r = strongest; r >= 0.5 && levels.length < 7; r /= 2) levels.splice(1, 0, r)
  const source = Float32Array.from(grid.pixels.data), out = like(grid.pixels, width, height)
  let lower: Float32Array = source
  for (let k = 1; k < levels.length; k++) {
    const upper = blurFloats(source, width, height, 4, levels[k], clamp), low = levels[k - 1], span = levels[k] - low
    for (let i = 0; i < radius.length; i++) {
      const r = radius[i]
      if (r > levels[k] || (k > 1 && r <= low)) continue
      const w = (r - low) / span
      for (let c = i * 4; c < i * 4 + 4; c++) out.data[c] = put(out, lower[c] + (upper[c] - lower[c]) * w)
    }
    lower = upper
  }
  return { pixels: out, origin: grid.origin }
}

export function motionBlur(input: FilterInput, angle: number, distance: number, sides: Sides = noSides): FilterOutput {
  if (distance <= 0) return null
  const sigma = distance / Math.sqrt(12), reach = Math.ceil(sigma * 3)
  const margin = input.isMask ? 0 : reach + 2
  const grid = margin ? paddedSides(input.pixels, margin, sides) : { pixels: input.pixels, origin: [0, 0] as [number, number] }
  const { width, height, data } = grid.pixels, clamped = input.isMask || anySide(sides)
  const out = like(grid.pixels, width, height)
  const dx = Math.cos(angle * Math.PI / 180), dy = -Math.sin(angle * Math.PI / 180)
  const taps = Math.min(96, Math.max(1, reach)), step = reach / taps
  const weights: number[] = []
  let total = 0
  for (let k = -taps; k <= taps; k++) { const d = k * step, w = Math.exp(-d * d / (2 * sigma * sigma)); weights.push(w); total += w }
  const sample = (x: number, y: number, c: number) => {
    if (clamped) { x = Math.min(width - 1, Math.max(0, x)); y = Math.min(height - 1, Math.max(0, y)) }
    const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0
    const at = (px: number, py: number) => px < 0 || py < 0 || px >= width || py >= height ? 0 : data[(py * width + px) * 4 + c]
    return (at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx) * (1 - fy) + (at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx) * fy
  }
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) for (let c = 0; c < 4; c++) {
    let sum = 0
    for (let k = -taps; k <= taps; k++) sum += sample(x + dx * k * step, y + dy * k * step, c) * weights[k + taps]
    out.data[(y * width + x) * 4 + c] = put(out, sum / total)
  }
  return { pixels: out, origin: grid.origin }
}

export function addNoise(input: FilterInput, amount: number, gaussian: boolean, monochromatic: boolean, seed: number): FilterOutput {
  return kernelInPlace(input.pixels, 'noise_add', amount, gaussian ? 1 : 0, monochromatic ? 1 : 0, seed >>> 0)
}

// Takes the selection as an argument (not from the store) so it can run in the filter worker.
export function contentAwareFill(input: FilterInput, selection: { width: number; height: number; data: Uint8Array } | null, seed: number): FilterOutput {
  if (!selection) throw new Error('Make a selection to fill.')
  // Grow to cover the selection's bounds on the canvas, then fill whatever the selection touches.
  const toPixel = invert(input.toDocument)
  let minX = selection.width, minY = selection.height, maxX = -1, maxY = -1
  for (let y = 0; y < selection.height; y++) for (let x = 0; x < selection.width; x++) if (selection.data[y * selection.width + x]) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; maxY = y }
  if (maxX < 0) throw new Error('Make a selection to fill.')
  const corners = [[minX, minY], [maxX + 1, minY], [maxX + 1, maxY + 1], [minX, maxY + 1]].map(([x, y]) => apply(toPixel, x, y))
  const x0 = Math.min(0, Math.floor(Math.min(...corners.map(c => c[0])))), y0 = Math.min(0, Math.floor(Math.min(...corners.map(c => c[1]))))
  const x1 = Math.max(input.pixels.width, Math.ceil(Math.max(...corners.map(c => c[0])))), y1 = Math.max(input.pixels.height, Math.ceil(Math.max(...corners.map(c => c[1]))))
  const width = x1 - x0, height = y1 - y0
  const pixels = new Raster(width, height, 4)
  for (let y = 0; y < input.pixels.height; y++) pixels.data.set(input.pixels.data.subarray(y * input.pixels.width * 4, (y + 1) * input.pixels.width * 4), ((y - y0) * width - x0) * 4)
  const mask = new Uint8Array(width * height)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const [dx, dy] = apply(input.toDocument, x + x0 + 0.5, y + y0 + 0.5)
    const sx = Math.floor(dx), sy = Math.floor(dy)
    if (sx >= 0 && sy >= 0 && sx < selection.width && sy < selection.height) mask[y * width + x] = selection.data[sy * selection.width + sx]
  }
  const status = withBuffers([{ data: pixels.data, out: true }, { data: mask }], ([p, m]) => call('patch_fill', p, width * 4, m, width, width, height, seed >>> 0))
  if (status === 0) throw new Error('Not enough unselected, opaque image pixels to synthesize a fill. Use a smaller selection with some surrounding image.')
  if (status !== 1) throw new Error('Out of memory while filling.')
  return { pixels, origin: [x0, y0] }
}

export function lensCorrection(input: FilterInput, distortion: number): FilterOutput {
  if (!distortion) return null
  const { pixels } = input, out = new Raster(pixels.width, pixels.height, 4)
  withBuffers([{ data: pixels.data }, { data: out.data, out: true }], ([s, d]) => call('lens_distort', s, d, pixels.width, pixels.height, pixels.width * 4, distortion / 100 * 0.35))
  return out
}

export type VignetteSettings = { color: [number, number, number]; amount: number; midpoint: number; roundness: number; feather: number; highlights: number }
export function vignette(input: FilterInput, s: VignetteSettings, fillsClear = false): FilterOutput {
  if (!s.amount) return null
  const { pixels } = input
  return kernelInPlace(pixels, 'adjust_colored_vignette', 0, 0, pixels.width, pixels.height, fillsClear ? 1 : 0, s.amount, s.midpoint, s.roundness, s.feather, s.highlights, s.color[0] / 255, s.color[1] / 255, s.color[2] / 255)
}

// Bloom / Glow, standing in for Core Image's CIBloom: the image's blur, brightened and screened back over it.
export function bloom(input: FilterInput, amount: number, radius: number): FilterOutput {
  if (!amount) return null
  const margin = input.isMask ? 0 : Math.ceil(radius * 3 + 2)
  const grid = margin ? padded(input.pixels, margin) : { pixels: input.pixels, origin: [0, 0] as [number, number] }
  const source = grid.pixels, intensity = amount / 50
  const blurred = blurFloats(Float32Array.from(source.data), source.width, source.height, 4, radius)
  // At full depth an HDR layer's highlights glow past white rather than stopping there.
  const out = like(source, source.width, source.height), float = isFloat(source), limit = (v: number) => float ? Math.max(0, v) : clamp01(v)
  for (let i = 0; i < out.data.length; i += 4) {
    const glowA = clamp01(blurred[i + 3] / 255 * intensity), a = source.data[i + 3] / 255
    const outA = a + glowA * (1 - a)
    out.data[i + 3] = put(out, outA * 255)
    for (let c = 0; c < 3; c++) {
      const base = source.data[i + c] / 255, glow = limit(blurred[i + c] / 255 * intensity)
      out.data[i + c] = put(out, (float ? Math.max(0, base + glow - Math.min(1, base) * Math.min(1, glow)) : clamp01(Math.min(outA, base + glow - base * glow))) * 255)
    }
  }
  return { pixels: out, origin: grid.origin }
}

export function tonalContrast(input: FilterInput, amount: number, shadows: number, midtones: number, highlights: number, radius: number): FilterOutput {
  if (amount <= 0 || (!shadows && !midtones && !highlights)) return null
  const blurred = blurRaster(input.pixels, radius)
  const { pixels } = input
  withBuffers([{ data: pixels.data, out: true }, { data: blurred.data }], ([p, b]) => call('adjust_tonal_contrast', p, b, pixels.width, pixels.height, pixels.width * 4, pixels.width * 4, amount, shadows, midtones, highlights))
  return pixels
}

export const ditherStyles = ['Atkinson (Classic Mac)', 'Floyd–Steinberg', 'Bayer 2 × 2', 'Bayer 4 × 4', 'Bayer 8 × 8', 'Halftone Dots', 'Halftone Lines', 'Halftone Diamonds', 'Mac Patterns', 'ASCII'] as const
export const ditherGroups = [[0, 1], [2, 3, 4], [5, 6, 7], [8, 9]]
export type DitherSettings = {
  style: number; pixelSize: number; pixelShape: 'Square' | 'Dot'; cellSize: number; angle: number; textSize: number; characters: string
  levels: number; diffusion: number; density: number; contrast: number
  colors: 'Black & White' | 'Two Colors' | 'Original'; dark: [number, number, number]; light: [number, number, number]; lightOnDark: boolean
}
export const defaultDither: DitherSettings = { style: 0, pixelSize: 2, pixelShape: 'Square', cellSize: 8, angle: 45, textSize: 14, characters: ' .:-=+*#%@', levels: 2, diffusion: 100, density: 0, contrast: 0, colors: 'Black & White', dark: [0, 0, 0], light: [255, 255, 255], lightOnDark: true }
export const ditherUses = (s: DitherSettings) => ({
  pixelSize: s.style !== 9, halftone: s.style >= 5 && s.style <= 7, ascii: s.style === 9,
  tones: s.style <= 4, diffuses: s.style <= 1, marks: (s.style >= 5 && s.style <= 9),
})

// Coverage maps of each distinct character in a bold monospace face, least inked first, as Dither.swift draws them.
function glyphMaps(characters: string, textSize: number) {
  const unique = [...new Set([...(characters.replace(/\n/g, '') || defaultDither.characters)])]
  const size = textSize / 1.2
  const canvas = new OffscreenCanvas(1, 1)
  let context = canvas.getContext('2d', { willReadFrequently: true })!
  const font = `bold ${size}px ui-monospace, "SF Mono", Menlo, Consolas, monospace`
  context.font = font
  const width = Math.max(1, Math.round(context.measureText('M').width)), height = Math.max(1, Math.round(textSize))
  canvas.width = width; canvas.height = height
  context = canvas.getContext('2d', { willReadFrequently: true })!
  context.font = font
  context.textBaseline = 'middle'
  const maps = unique.map(character => {
    context.fillStyle = '#000'; context.fillRect(0, 0, width, height)
    context.fillStyle = '#fff'
    context.fillText(character, Math.round((width - context.measureText(character).width) / 2), height / 2)
    const rgba = context.getImageData(0, 0, width, height).data
    const map = new Uint8Array(width * height)
    let sum = 0
    for (let i = 0; i < map.length; i++) { map[i] = rgba[i * 4]; sum += map[i] }
    return { map, coverage: sum / (255 * width * height) }
  }).sort((a, b) => a.coverage - b.coverage)
  const glyphs = new Uint8Array(maps.length * width * height)
  maps.forEach((m, i) => glyphs.set(m.map, i * width * height))
  return { glyphs, coverage: Float32Array.from(maps.map(m => m.coverage)), width, height, count: maps.length }
}

function resampleArea(source: Raster, width: number, height: number) {
  const out = new Raster(width, height, 4), fx = source.width / width, fy = source.height / height
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const sx0 = Math.floor(x * fx), sx1 = Math.min(source.width, Math.ceil((x + 1) * fx)), sy0 = Math.floor(y * fy), sy1 = Math.min(source.height, Math.ceil((y + 1) * fy))
    const sum = [0, 0, 0, 0]
    let n = 0
    for (let sy = sy0; sy < sy1; sy++) for (let sx = sx0; sx < sx1; sx++) { const i = (sy * source.width + sx) * 4; for (let c = 0; c < 4; c++) sum[c] += source.data[i + c]; n++ }
    out.data.set(sum.map(v => Math.round(v / Math.max(1, n))), (y * width + x) * 4)
  }
  return out
}

export function dither(input: FilterInput, s: DitherSettings): FilterOutput {
  const uses = ditherUses(s)
  const block = uses.pixelSize ? Math.max(1, Math.round(s.pixelSize)) : 1
  const full = input.pixels
  const work = block > 1 ? resampleArea(full, Math.ceil(full.width / block), Math.ceil(full.height / block)) : full
  const glyph = uses.ascii ? glyphMaps(s.characters, s.textSize) : { glyphs: new Uint8Array(1), coverage: new Float32Array(1), width: 1, height: 1, count: 0 }
  const two = s.colors === 'Two Colors'
  const dark = two ? s.dark : [0, 0, 0], light = two ? s.light : [255, 255, 255]
  // DitherParams, laid out as the C struct (4-byte fields, then the two color byte triples, then pointers).
  const params = new ArrayBuffer(64), view = new DataView(params)
  const ints = [s.style, Math.round(s.levels)]
  view.setInt32(0, ints[0], true); view.setInt32(4, ints[1], true)
  view.setFloat32(8, s.diffusion / 100, true); view.setFloat32(12, s.density / 100, true); view.setFloat32(16, s.contrast / 100, true)
  view.setInt32(20, Math.round(s.cellSize), true)
  view.setFloat32(24, s.angle * Math.PI / 180, true)
  view.setInt32(28, s.lightOnDark ? 1 : 0, true); view.setInt32(32, s.colors === 'Original' ? 1 : 0, true)
  dark.forEach((v, i) => view.setUint8(36 + i, v)); light.forEach((v, i) => view.setUint8(39 + i, v))
  view.setInt32(44, glyph.width, true); view.setInt32(48, glyph.height, true)
  view.setInt32(60, glyph.count, true)
  const ok = withBuffers([{ data: work.data, out: true }, { data: glyph.glyphs }, { data: glyph.coverage }, { data: new Uint8Array(params) }], ([pixels, glyphs, coverage, p], k) => {
    const memory = new DataView(k.memory.buffer)
    memory.setUint32(p + 52, glyphs, true); memory.setUint32(p + 56, coverage, true)
    return call('dither_apply', pixels, work.width, work.height, work.width * 4, p)
  })
  if (!ok) throw new Error('Dither ran out of memory.')
  if (block <= 1) return work
  const out = new Raster(full.width, full.height, 4)
  for (let y = 0; y < full.height; y++) for (let x = 0; x < full.width; x++) out.data.set(work.data.subarray(((Math.floor(y / block)) * work.width + Math.floor(x / block)) * 4, ((Math.floor(y / block)) * work.width + Math.floor(x / block)) * 4 + 4), (y * full.width + x) * 4)
  if (s.pixelShape === 'Dot') withBuffers([{ data: out.data, out: true }, { data: new Uint8Array(two ? dark : [0, 0, 0]) }], ([p, g]) => call('dither_dots', p, full.width, full.height, full.width * 4, block, g))
  return out
}

export type ScanlinesSettings = {
  lineSpacing: number; thickness: number; glow: number; dots: number; displace: number; smoothness: number; threshold: number; wobble: number; split: number
  density: number; contrast: number; blackLevel: number; colors: DitherSettings['colors']; dark: [number, number, number]; light: [number, number, number]
}
export const defaultScanlines: ScanlinesSettings = { lineSpacing: 4, thickness: 70, glow: 0, dots: 0, displace: 0, smoothness: 50, threshold: 0, wobble: 0, split: 0, density: 0, contrast: 0, blackLevel: 0, colors: 'Black & White', dark: [0, 0, 0], light: [255, 255, 255] }

// Filter › Scanlines (Scanlines.swift): scanlines_apply, then the lines' light blurred across a few spacings and added back as glow.
export function scanlines(input: FilterInput, s: ScanlinesSettings): FilterOutput {
  const pixels = input.pixels, two = s.colors === 'Two Colors'
  // ScanlinesParams, laid out as the C struct (an int, ten floats, an int, then the two color byte triples).
  const params = new ArrayBuffer(56), view = new DataView(params)
  view.setInt32(0, Math.round(s.lineSpacing), true)
  ;[s.thickness / 100, s.dots / 100, s.wobble, s.displace, s.threshold / 100, Math.round(s.split), s.density / 100, s.contrast / 100, s.blackLevel / 100, s.smoothness / 100].forEach((v, i) => view.setFloat32(4 + i * 4, v, true))
  view.setInt32(44, s.colors === 'Original' ? 1 : 0, true)
  ;(two ? s.dark : [0, 0, 0]).forEach((v, i) => view.setUint8(48 + i, v)); (two ? s.light : [255, 255, 255]).forEach((v, i) => view.setUint8(51 + i, v))
  const ok = withBuffers([{ data: pixels.data, out: true }, { data: new Uint8Array(params) }], ([p, q]) => call('scanlines_apply', p, pixels.width, pixels.height, pixels.width * 4, q))
  if (!ok) throw new Error('Scanlines ran out of memory.')
  if (s.glow <= 0) return pixels
  const blurred = blurRaster(pixels, Math.round(s.lineSpacing) * 3 + 3, true)
  withBuffers([{ data: pixels.data, out: true }, { data: blurred.data }], ([p, b]) => call('dither_glow', p, b, pixels.width, pixels.height, pixels.width * 4, s.glow / 100 * 2.5))
  return pixels
}

export { floats }

// An adjustment run straight on a layer's pixels (Image > Curves…, Levels…, and the rest), through the same math as adjustment layers.
export function adjustPixels(input: FilterInput, adjustment: Adjustment): FilterOutput {
  const { pixels } = input, count = pixels.width * pixels.height
  const tables = channelTables(adjustment)
  if (tables) { withBuffers([{ data: pixels.data, out: true }, floats(tables)], ([p, t]) => call('levels_apply', p, count, t)); return pixels }
  if (adjustment.kind === 'Levels' || adjustment.kind === 'Curves' || adjustment.kind === 'Exposure') return null
  if (adjustment.kind === 'Hue/Saturation') {
    const cube = hueSaturationCube(adjustment)
    withBuffers([{ data: pixels.data, out: true }, { data: cube }], ([p, c]) => call('cube_apply', p, count, c, cubeSize))
    return pixels
  }
  if (adjustment.kind === 'Black & White') {
    const s = adjustment.blackWhiteSettings!
    return kernelInPlace(pixels, 'adjust_black_white', floats([s.reds, s.yellows, s.greens, s.cyans, s.blues, s.magentas].map(v => v / 100)), s.tint ? 1 : 0, s.tintHue, s.tintSaturation / 100)
  }
  if (adjustment.kind === 'Color Balance') {
    const s = adjustment.colorBalanceSettings!
    const v = [s.shadowCyanRed, s.shadowMagentaGreen, s.shadowYellowBlue, s.midCyanRed, s.midMagentaGreen, s.midYellowBlue, s.highlightCyanRed, s.highlightMagentaGreen, s.highlightYellowBlue].map(x => x / 100)
    if (v.every(x => x === 0)) return null
    return kernelInPlace(pixels, 'adjust_color_balance', floats(v.slice(0, 3)), floats(v.slice(3, 6)), floats(v.slice(6)), s.preserveLuminosity ? 1 : 0)
  }
  if (adjustment.kind === 'Gradient Map') {
    const s = adjustment.gradientMapSettings!
    const [dark, light] = s.reversed ? [s.highlights, s.shadows] : [s.shadows, s.highlights]
    const table = new Uint8Array(768)
    for (let i = 0; i < 256; i++) (['red', 'green', 'blue'] as const).forEach((c, k) => { table[i * 3 + k] = Math.min(255, Math.max(0, Math.round((dark[c] + (light[c] - dark[c]) * i / 255) * 255))) })
    return kernelInPlace(pixels, 'adjust_gradient_map', { data: table })
  }
  if (adjustment.kind === 'Grain') {
    const g = adjustment.grainSettings!
    if (!(g.amount > 0)) return null
    return kernelInPlace(pixels, 'adjust_grain', g.amount, g.size, g.roughness, g.seed >>> 0, 0, 0, 1)
  }
  return null
}

// Filter › Camera Raw Filter: the whole grade (model/cameraRaw.ts). `scale` is preview pixels per layer pixel, so radii match a
// full-size render; the worker loads the measured tables first.
export function cameraRaw(input: FilterInput, settings: CameraRawSettings, seed: number, scale = 1, view: CameraRawView = {}): FilterOutput {
  const out = applyCameraRaw(input.pixels, settings, seed, scale, view)
  return out === input.pixels ? null : out
}
