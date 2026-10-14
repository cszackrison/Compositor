import { XzReadableStream } from 'xz-decompress'
import { call, heap, withBuffers } from '../kernels'
import { curveValue } from './adjustments'
import { Raster } from './raster'
import type { CurvePoint } from './types'

// Camera Raw Filter (CameraRaw.swift and its neighbors): settings that leave the image unchanged by default, and the Mac's pipeline
// over the same C kernels, with Light, Color, Calibration, the parametric curve, Color Mixer and Color Grading drawn from tables
// measured from Photoshop's own Camera Raw Filter.

export type GlowStyle = 'Diffusion' | 'Bloom' | 'Halation'
export type VignetteStyle = 'Highlight Priority' | 'Color Priority' | 'Paint Overlay'
export type Wheel = { hue: number; saturation: number; luminance: number }
export type CurveSettings = { shadows: number; darks: number; lights: number; highlights: number; shadowSplit: number; darkSplit: number; lightSplit: number; rgb: CurvePoint[]; red: CurvePoint[]; green: CurvePoint[]; blue: CurvePoint[]; refineSaturation: number }
export type PointColor = { hue: number; saturation: number; luminance: number; hueShift: number; saturationShift: number; luminanceShift: number; hueRange: number; saturationRange: number; luminanceRange: number; visualize: boolean }
export type MixerSettings = { hue: number[]; saturation: number[]; luminance: number[]; points: PointColor[] }
export type GradingSettings = { shadows: Wheel; midtones: Wheel; highlights: Wheel; global: Wheel; blending: number; balance: number }
export type DetailSettings = { sharpenAmount: number; sharpenRadius: number; sharpenDetail: number; sharpenMasking: number; noiseLuminance: number; noiseLuminanceDetail: number; noiseLuminanceContrast: number; noiseColor: number; noiseColorDetail: number; noiseColorSmoothness: number }
export type OpticsSettings = { removeChromaticAberration: boolean; enableLensProfile: boolean; profileDistortion: number; profileVignetting: number; distortion: number; purpleAmount: number; purpleHueLow: number; purpleHueHigh: number; greenAmount: number; greenHueLow: number; greenHueHigh: number; vignetteAmount: number; vignetteMidpoint: number }
// A guide line drawn on the layer, its ends as fractions of the layer's width and height from its lower left.
export type Guide = { startX: number; startY: number; endX: number; endY: number }
export type GeometrySettings = { upright: 'Off' | 'Guided'; guides: Guide[]; projection: 'Perspective' | 'Rectilinear'; vertical: number; horizontal: number; rotate: number; aspect: number; scale: number; offsetX: number; offsetY: number; constrainCrop: boolean }
export const processVersions = ['Version 1', 'Version 2', 'Version 3', 'Version 4', 'Version 5', 'Version 6'] as const
export type CalibrationSettings = { process: typeof processVersions[number]; shadowTint: number; redHue: number; redSaturation: number; greenHue: number; greenSaturation: number; blueHue: number; blueSaturation: number }
export type CameraRawSettings = {
  whiteBalance: 'Custom' | 'Auto'; temperature: number; tint: number
  exposure: number; contrast: number; highlights: number; shadows: number; whites: number; blacks: number; vibrance: number; saturation: number
  texture: number; clarity: number; dehaze: number
  glow: number; glowStyle: GlowStyle; glowRange: number; glowSpread: number; glowWarmth: number
  vignetteAmount: number; vignetteStyle: VignetteStyle; vignetteMidpoint: number; vignetteRoundness: number; vignetteFeather: number; vignetteHighlights: number
  grainAmount: number; grainSize: number; grainRoughness: number
  curve: CurveSettings; mixer: MixerSettings; grading: GradingSettings; detail: DetailSettings; optics: OpticsSettings; geometry: GeometrySettings; calibration: CalibrationSettings
}

const linear = (): CurvePoint[] => [{ x: 0, y: 0 }, { x: 1, y: 1 }]
const wheel = (): Wheel => ({ hue: 0, saturation: 0, luminance: 0 })
export const defaultCurve = (): CurveSettings => ({ shadows: 0, darks: 0, lights: 0, highlights: 0, shadowSplit: 25, darkSplit: 50, lightSplit: 75, rgb: linear(), red: linear(), green: linear(), blue: linear(), refineSaturation: 0 })
export const defaultMixer = (): MixerSettings => ({ hue: Array(8).fill(0), saturation: Array(8).fill(0), luminance: Array(8).fill(0), points: [] })
export const newPointColor = (hue: number, saturation: number, luminance: number): PointColor => ({ hue, saturation, luminance, hueShift: 0, saturationShift: 0, luminanceShift: 0, hueRange: 30, saturationRange: 0.4, luminanceRange: 0.4, visualize: false })
export const defaultGrading = (): GradingSettings => ({ shadows: wheel(), midtones: wheel(), highlights: wheel(), global: wheel(), blending: 50, balance: 0 })
export const defaultDetail = (): DetailSettings => ({ sharpenAmount: 0, sharpenRadius: 10, sharpenDetail: 25, sharpenMasking: 0, noiseLuminance: 0, noiseLuminanceDetail: 50, noiseLuminanceContrast: 0, noiseColor: 0, noiseColorDetail: 50, noiseColorSmoothness: 50 })
export const defaultOptics = (): OpticsSettings => ({ removeChromaticAberration: false, enableLensProfile: false, profileDistortion: 100, profileVignetting: 100, distortion: 0, purpleAmount: 0, purpleHueLow: 270, purpleHueHigh: 310, greenAmount: 0, greenHueLow: 60, greenHueHigh: 120, vignetteAmount: 0, vignetteMidpoint: 50 })
export const defaultGeometry = (): GeometrySettings => ({ upright: 'Off', guides: [], projection: 'Perspective', vertical: 0, horizontal: 0, rotate: 0, aspect: 0, scale: 0, offsetX: 0, offsetY: 0, constrainCrop: false })
export const defaultCalibration = (): CalibrationSettings => ({ process: 'Version 6', shadowTint: 0, redHue: 0, redSaturation: 0, greenHue: 0, greenSaturation: 0, blueHue: 0, blueSaturation: 0 })
export const defaultCameraRaw = (): CameraRawSettings => ({
  whiteBalance: 'Custom', temperature: 0, tint: 0, exposure: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0, vibrance: 0, saturation: 0,
  texture: 0, clarity: 0, dehaze: 0, glow: 0, glowStyle: 'Diffusion', glowRange: 0, glowSpread: 0, glowWarmth: 0,
  vignetteAmount: 0, vignetteStyle: 'Highlight Priority', vignetteMidpoint: 50, vignetteRoundness: 0, vignetteFeather: 50, vignetteHighlights: 0,
  grainAmount: 0, grainSize: 25, grainRoughness: 50,
  curve: defaultCurve(), mixer: defaultMixer(), grading: defaultGrading(), detail: defaultDetail(), optics: defaultOptics(), geometry: defaultGeometry(), calibration: defaultCalibration(),
})

export const mixerNames = ['Reds', 'Oranges', 'Yellows', 'Greens', 'Aquas', 'Blues', 'Purples', 'Magentas']
export const mixerCenters = [0, 30, 60, 120, 180, 240, 270, 300]

// The panel's sections, each with what it adjusts, what its eye hides and what its reset puts back.
export type CameraRawGroup = 'Light' | 'Color' | 'Color Grading' | 'Effects' | 'Curve' | 'Color Mixer' | 'Detail' | 'Optics' | 'Geometry' | 'Calibration'
export const cameraRawGroups: CameraRawGroup[] = ['Light', 'Color', 'Color Grading', 'Effects', 'Curve', 'Color Mixer', 'Detail', 'Optics', 'Geometry', 'Calibration']
const isLinear = (p: CurvePoint[]) => p.length === 2 && p[0].x === 0 && p[0].y === 0 && p[1].x === 1 && p[1].y === 1
const same = (a: object, b: object) => JSON.stringify(a) === JSON.stringify(b)
export function adjusts(s: CameraRawSettings, group: CameraRawGroup): boolean {
  switch (group) {
    case 'Light': return !!(s.exposure || s.contrast || s.highlights || s.shadows || s.whites || s.blacks)
    case 'Color': return !!(s.temperature || s.tint || s.vibrance || s.saturation)
    case 'Effects': return !!(s.texture || s.clarity || s.dehaze || s.glow || s.vignetteAmount || s.grainAmount)
    case 'Curve': { const c = s.curve; return !!(c.shadows || c.darks || c.lights || c.highlights || c.refineSaturation) || ![c.rgb, c.red, c.green, c.blue].every(isLinear) }
    case 'Color Mixer': return [...s.mixer.hue, ...s.mixer.saturation, ...s.mixer.luminance].some(v => v !== 0) || s.mixer.points.some(p => p.hueShift || p.saturationShift || p.luminanceShift)
    case 'Color Grading': return [s.grading.shadows, s.grading.midtones, s.grading.highlights, s.grading.global].some(w => w.saturation !== 0 || w.luminance !== 0)
    case 'Detail': return !!(s.detail.sharpenAmount || s.detail.noiseLuminance || s.detail.noiseColor)
    case 'Optics': { const o = s.optics; return o.removeChromaticAberration || o.enableLensProfile || !!(o.distortion || o.purpleAmount || o.greenAmount || o.vignetteAmount) }
    case 'Geometry': { const g = s.geometry; return usesGuides(g) || !!(g.vertical || g.horizontal || g.rotate || g.aspect || g.scale || g.offsetX || g.offsetY) }
    case 'Calibration': { const c = s.calibration; return !!(c.shadowTint || c.redHue || c.redSaturation || c.greenHue || c.greenSaturation || c.blueHue || c.blueSaturation) }
  }
}
// Guided counts only once a guide is long enough to read: an empty Guided choice mustn't warp the picture.
const longEnough = (g: Guide) => Math.hypot(g.endX - g.startX, g.endY - g.startY) > 0.01
const usesGuides = (g: GeometrySettings) => g.upright === 'Guided' && g.guides.some(longEnough)
export const isIdentity = (s: CameraRawSettings) => cameraRawGroups.every(g => !adjusts(s, g))

// A section put back to its defaults (its header's reset), or left out of the result (its eye turned off).
export function resetGroup(s: CameraRawSettings, group: CameraRawGroup): CameraRawSettings {
  const d = defaultCameraRaw()
  switch (group) {
    case 'Light': return { ...s, exposure: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0 }
    case 'Color': return { ...s, whiteBalance: 'Custom', temperature: 0, tint: 0, vibrance: 0, saturation: 0 }
    case 'Effects': return { ...s, texture: 0, clarity: 0, dehaze: 0, glow: 0, glowStyle: d.glowStyle, glowRange: 0, glowSpread: 0, glowWarmth: 0, vignetteAmount: 0, vignetteStyle: d.vignetteStyle, vignetteMidpoint: 50, vignetteRoundness: 0, vignetteFeather: 50, vignetteHighlights: 0, grainAmount: 0, grainSize: 25, grainRoughness: 50 }
    case 'Curve': return { ...s, curve: d.curve }
    case 'Color Mixer': return { ...s, mixer: d.mixer }
    case 'Color Grading': return { ...s, grading: d.grading }
    case 'Detail': return { ...s, detail: d.detail }
    case 'Optics': return { ...s, optics: d.optics }
    case 'Geometry': return { ...s, geometry: d.geometry }
    case 'Calibration': return { ...s, calibration: d.calibration }
  }
}
export function hiding(s: CameraRawSettings, hidden: CameraRawGroup[]): CameraRawSettings {
  let out = s
  for (const group of hidden) out = group === 'Effects' ? { ...out, texture: 0, clarity: 0, dehaze: 0, glow: 0, vignetteAmount: 0, grainAmount: 0 } : group === 'Color' ? { ...out, temperature: 0, tint: 0, vibrance: 0, saturation: 0 } : resetGroup(out, group)
  return out
}
export const isDefault = (s: CameraRawSettings) => same(s, defaultCameraRaw())

const clamp = (v: number, low: number, high: number, fallback: number) => Number.isFinite(v) ? Math.min(high, Math.max(low, v)) : fallback
// The curve's points kept in order and apart, its ends at 0 and 1, as the Mac repairs them.
function repair(points: CurvePoint[]): CurvePoint[] {
  const sorted = points.filter(p => Number.isFinite(p.x) && Number.isFinite(p.y)).sort((a, b) => a.x - b.x)
  if (sorted.length < 2) return linear()
  const kept = [{ x: 0, y: clamp(sorted[0].y, 0, 1, 0) }]
  for (const p of sorted.slice(1, -1)) { const x = clamp(p.x, 0.01, 0.99, 0.5); if (x > kept[kept.length - 1].x + 0.01) kept.push({ x, y: clamp(p.y, 0, 1, 0) }) }
  kept.push({ x: 1, y: clamp(sorted[sorted.length - 1].y, 0, 1, 1) })
  return kept
}
export function normalized(s: CameraRawSettings): CameraRawSettings {
  const t = (v: number) => clamp(v, -100, 100, 0), u = (v: number, f = 0) => clamp(v, 0, 100, f)
  const c = s.curve, shadowSplit = clamp(c.shadowSplit, 5, 90, 25), darkSplit = clamp(c.darkSplit, shadowSplit + 2, 95, 50)
  const o = s.optics, hue = (v: number, f: number) => clamp(v, 0, 360, f)
  const [purpleHueLow, purpleHueHigh] = [hue(o.purpleHueLow, 270), hue(o.purpleHueHigh, 310)].sort((a, b) => a - b), [greenHueLow, greenHueHigh] = [hue(o.greenHueLow, 60), hue(o.greenHueHigh, 120)].sort((a, b) => a - b)
  const w = (x: Wheel): Wheel => ({ hue: hue(x.hue, 0), saturation: u(x.saturation), luminance: t(x.luminance) })
  return {
    ...s, exposure: clamp(s.exposure, -5, 5, 0), contrast: t(s.contrast), highlights: t(s.highlights), shadows: t(s.shadows), whites: t(s.whites), blacks: t(s.blacks),
    temperature: t(s.temperature), tint: t(s.tint), vibrance: t(s.vibrance), saturation: t(s.saturation), texture: t(s.texture), clarity: t(s.clarity), dehaze: t(s.dehaze),
    glow: u(s.glow), glowRange: t(s.glowRange), glowSpread: t(s.glowSpread), glowWarmth: t(s.glowWarmth),
    vignetteAmount: t(s.vignetteAmount), vignetteMidpoint: u(s.vignetteMidpoint, 50), vignetteRoundness: t(s.vignetteRoundness), vignetteFeather: u(s.vignetteFeather, 50), vignetteHighlights: u(s.vignetteHighlights),
    grainAmount: u(s.grainAmount), grainSize: u(s.grainSize, 25), grainRoughness: u(s.grainRoughness, 50),
    curve: { shadows: t(c.shadows), darks: t(c.darks), lights: t(c.lights), highlights: t(c.highlights), refineSaturation: t(c.refineSaturation), shadowSplit, darkSplit, lightSplit: clamp(c.lightSplit, darkSplit + 2, 98, 75), rgb: repair(c.rgb), red: repair(c.red), green: repair(c.green), blue: repair(c.blue) },
    mixer: { hue: s.mixer.hue.map(t), saturation: s.mixer.saturation.map(t), luminance: s.mixer.luminance.map(t), points: s.mixer.points.slice(0, 8).map(p => ({ ...p, hue: clamp(p.hue, 0, 360, 0), saturation: clamp(p.saturation, 0, 1, 0), luminance: clamp(p.luminance, 0, 1, 0), hueShift: t(p.hueShift), saturationShift: t(p.saturationShift), luminanceShift: t(p.luminanceShift), hueRange: clamp(p.hueRange, 5, 180, 30), saturationRange: clamp(p.saturationRange, 0.05, 1, 0.4), luminanceRange: clamp(p.luminanceRange, 0.05, 1, 0.4) })) },
    grading: { shadows: w(s.grading.shadows), midtones: w(s.grading.midtones), highlights: w(s.grading.highlights), global: w(s.grading.global), blending: u(s.grading.blending, 50), balance: t(s.grading.balance) },
    detail: { sharpenAmount: clamp(s.detail.sharpenAmount, 0, 150, 0), sharpenRadius: u(s.detail.sharpenRadius, 10), sharpenDetail: u(s.detail.sharpenDetail, 25), sharpenMasking: u(s.detail.sharpenMasking), noiseLuminance: u(s.detail.noiseLuminance), noiseLuminanceDetail: u(s.detail.noiseLuminanceDetail, 50), noiseLuminanceContrast: u(s.detail.noiseLuminanceContrast), noiseColor: u(s.detail.noiseColor), noiseColorDetail: u(s.detail.noiseColorDetail, 50), noiseColorSmoothness: u(s.detail.noiseColorSmoothness, 50) },
    optics: { ...o, profileDistortion: u(o.profileDistortion, 100), profileVignetting: u(o.profileVignetting, 100), distortion: t(o.distortion), purpleAmount: u(o.purpleAmount), greenAmount: u(o.greenAmount), vignetteAmount: t(o.vignetteAmount), vignetteMidpoint: u(o.vignetteMidpoint, 50), purpleHueLow, purpleHueHigh, greenHueLow, greenHueHigh },
    geometry: { ...s.geometry, guides: s.geometry.guides.filter(longEnough), vertical: t(s.geometry.vertical), horizontal: t(s.geometry.horizontal), rotate: clamp(s.geometry.rotate, -45, 45, 0), aspect: t(s.geometry.aspect), scale: t(s.geometry.scale), offsetX: t(s.geometry.offsetX), offsetY: t(s.geometry.offsetY) },
    calibration: { ...s.calibration, shadowTint: t(s.calibration.shadowTint), redHue: t(s.calibration.redHue), redSaturation: t(s.calibration.redSaturation), greenHue: t(s.calibration.greenHue), greenSaturation: t(s.calibration.greenSaturation), blueHue: t(s.calibration.blueHue), blueSaturation: t(s.calibration.blueSaturation) },
  }
}

// MARK: The measured tables (CameraRawTables.swift)

const size = 17, grid = 33, entries = size * size * size * 3, count = 763
// Shadows' tables (from 236) are no longer read: see CameraRawShadows below.
const exposureStart = 81, whitesStart = 102, blacksStart = 111, saturationStart = 120, vibranceStart = 129
const contrastStart = 138, highlightsStart = 187, mixerStart = 285, calibrationStart = 405, parametricStart = 435
const gradingStart = 455, gradingLuminanceStart = 743
const brightnesses = [53, 80, 104, 130, 160, 190, 224], adaptiveValues = [-100, -50, -25, 0, 25, 50, 100]

// Where the tables sit in this wasm instance's memory, once loaded: each page and worker loads its own.
let tablesAt = 0
let loading: Promise<void> | null = null
// Where the page's own files are: a worker's relative URLs would resolve against its script, in assets/, so the page tells it.
let assetBase: string | null = null
export function setAssetBase(url: string) { assetBase = url }

// The tables file as the Mac keeps it (Resources/CameraRawTables.bin, copied beside the page at build time): a header, then each
// table and channel's change from no change in steps, as a running difference, packed with xz. Decoded into wasm memory once.
// `shadowsFile`: Resources/CameraRawShadows.bin, fetched beside the tables when not given; without it Shadows changes nothing, as on
// the Mac.
export function loadCameraRawTables(file?: Uint8Array, shadowsFile?: Uint8Array): Promise<void> {
  if (tablesAt) return Promise.resolve()
  return loading ??= (async () => {
    const fetched = async (name: string) => {
      const response = await fetch(new URL(`${name}?v=${typeof __BUILD__ === 'undefined' ? '' : __BUILD__}`, assetBase ?? new URL(import.meta.env.BASE_URL, location.href)))
      if (!response.ok) throw new Error('Camera Raw’s color tables could not be loaded.')
      return new Uint8Array(await response.arrayBuffer())
    }
    shadowTables = readShadowTables(shadowsFile ?? await fetched('CameraRawShadows.bin').catch(() => new Uint8Array(0)))
    const bytes = file ?? await fetched('CameraRawTables.bin')
    const field = (at: number) => bytes[at] | bytes[at + 1] << 8
    if (String.fromCharCode(...bytes.subarray(0, 4)) !== 'CRT3' || field(4) !== size || field(6) !== count) throw new Error('Camera Raw’s color tables could not be read.')
    const step = field(8)
    const planes = new Uint8Array(await new Response(new XzReadableStream(new Blob([bytes.slice(10)]).stream())).arrayBuffer())
    if (planes.length !== count * entries) throw new Error('Camera Raw’s color tables could not be read.')
    const cells = size * size * size, level = Array.from({ length: size }, (_, i) => Math.round(i * 255 / (size - 1)))
    const tables = new Uint8Array(count * entries)
    for (let table = 0; table < count; table++) for (let channel = 0; channel < 3; channel++) {
      const base = (table * 3 + channel) * cells
      let running = 0
      for (let cell = 0; cell < cells; cell++) {
        running = (running + planes[base + cell]) & 0xff
        const axis = channel === 0 ? (cell / (size * size)) | 0 : channel === 1 ? ((cell / size) | 0) % size : cell % size
        tables[table * entries + cell * 3 + channel] = Math.min(255, Math.max(0, level[axis] + ((running << 24) >> 24) * step))
      }
    }
    const at = call('wasm_alloc', tables.length)
    if (!at) throw new Error('Out of memory for Camera Raw’s color tables.')
    heap().set(tables, at)
    tablesAt = at
  })().catch(error => { loading = null; throw error })
}
export const cameraRawTablesLoaded = () => tablesAt !== 0

// Camera Raw's Shadows as Photoshop's Camera Raw Filter draws it (CameraRawShadows.swift): it adapts to the picture region by region,
// lifting a dark region below brighter ones far more than the same tone in a picture dark all over, so it's a pass of its own
// (`adjust_camera_raw_shadows`) on coefficients fitted to Photoshop's renders. A picture under about 1020 pixels on its long side
// takes Photoshop's gentler set.
type ShadowTables = { normalFrom: number; amounts: number[]; coefficients: Float32Array[][]; xCount: number; kCount: number; xLow: number; xStep: number; kLow: number; kStep: number }
let shadowTables: ShadowTables | null = null

// "CRS2"; then, as 16-bit integers, the number of sets, amounts, x columns, K rows and terms; as 32-bit floats, the long side the
// second set starts at, x's low end and step, K's low end and step, the amounts, and each set's coefficients amount by amount.
export function readShadowTables(bytes: Uint8Array): ShadowTables | null {
  if (bytes.length <= 34 || String.fromCharCode(...bytes.subarray(0, 4)) !== 'CRS2') return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), int16 = (at: number) => view.getInt16(at, true), float = (at: number) => view.getFloat32(at, true)
  const sets = int16(4), amounts = int16(6), xCount = int16(8), kCount = int16(10), terms = int16(12), per = xCount * kCount * terms, header = 34
  if (sets !== 2 || amounts <= 0 || terms !== 3 || bytes.length !== header + amounts * 4 + sets * amounts * per * 4) return null
  const start = header + amounts * 4
  const coefficients = Array.from({ length: sets }, (_, set) => Array.from({ length: amounts }, (_, a) => Float32Array.from({ length: per }, (_, i) => float(start + ((set * amounts + a) * per + i) * 4))))
  return { normalFrom: float(14), amounts: Array.from({ length: amounts }, (_, i) => float(header + i * 4)), coefficients, xCount, kCount, xLow: float(18), xStep: float(22), kLow: float(26), kStep: float(30) }
}

// The coefficients at `amount` (−100…100) for one set: the fitted amounts either side blended, zero itself being no change.
function shadowCoefficients(amount: number, set: number, tables: ShadowTables): Float32Array {
  const points: [number, Float32Array | null][] = tables.amounts.map((a, i) => [a, tables.coefficients[set][i]])
  points.push([0, null])
  points.sort((a, b) => a[0] - b[0])
  const value = Math.min(points[points.length - 1][0], Math.max(points[0][0], amount))
  let index = 0
  while (index < points.length - 2 && value > points[index + 1][0]) index++
  const [low, lower] = points[index], [high, upper] = points[index + 1], t = (value - low) / (high - low), count = tables.coefficients[set][0].length
  return Float32Array.from({ length: count }, (_, i) => (lower?.[i] ?? 0) * (1 - t) + (upper?.[i] ?? 0) * t)
}
const table = (index: number) => tablesAt + index * entries

// A stage: up to eight tables and their weights, as CameraRawStage (eight pointers, then eight floats).
type Stage = [number, number][]
function stagesBuffer(stages: Stage[]) {
  const buffer = new ArrayBuffer(stages.length * 64), pointers = new Uint32Array(buffer), weights = new Float32Array(buffer)
  stages.forEach((parts, s) => parts.slice(0, 8).forEach(([pointer, weight], i) => { pointers[s * 16 + i] = pointer; weights[s * 16 + 8 + i] = weight }))
  return new Uint8Array(buffer)
}
function between(value: number, points: number[]): [number, number] {
  const v = Math.min(points[points.length - 1], Math.max(points[0], value))
  let index = 0
  while (index < points.length - 2 && v > points[index + 1]) index++
  return [index, (v - points[index]) / (points[index + 1] - points[index])]
}
function betweenRun(value: number, low: number, step: number, tables: number): [number, number] {
  const position = Math.min(tables - 1, Math.max(0, (value - low) / step)), index = Math.min(tables - 2, Math.floor(position))
  return [index, position - index]
}
const run = (start: number, value: number, low: number, step: number, tables: number): Stage => { const [i, f] = betweenRun(value, low, step, tables); return [[table(start + i), 1 - f], [table(start + i + 1), f]] }
const fifty = (start: number, value: number) => run(start, value, -100, 50, 5)
function adaptive(start: number, value: number, brightness: number): Stage {
  const [row, down] = between(brightness, brightnesses), [column, across] = between(value, adaptiveValues), width = adaptiveValues.length, base = start + row * width + column
  return [[table(base), (1 - down) * (1 - across)], [table(base + 1), (1 - down) * across], [table(base + width), down * (1 - across)], [table(base + width + 1), down * across]]
}
function whiteBalance(temperature: number, tint: number): Stage {
  const [row, down] = betweenRun(temperature, -100, 25, 9), [column, across] = betweenRun(tint, -100, 25, 9)
  return [[table(row * 9 + column), (1 - down) * (1 - across)], [table(row * 9 + column + 1), (1 - down) * across], [table((row + 1) * 9 + column), down * (1 - across)], [table((row + 1) * 9 + column + 1), down * across]]
}
type Brightness = { brightest: number; luminance: number; logBrightest: number }
const hasMeasuredDividers = (c: CurveSettings) => c.shadowSplit === 25 && c.darkSplit === 50 && c.lightSplit === 75 && c.refineSaturation === 0

// How many of the stages come before Shadows, which runs as a pass of its own between them and the rest: Calibration, Exposure,
// white balance, Contrast and Highlights.
function beforeShadows(s: CameraRawSettings) {
  const c = s.calibration
  return [c.redHue, c.redSaturation, c.greenHue, c.greenSaturation, c.blueHue, c.blueSaturation].filter(v => v).length + +!!s.exposure + +!!(s.temperature || s.tint) + +!!s.contrast + +!!s.highlights
}

function stages(s: CameraRawSettings, b: Brightness): Stage[] {
  const out: Stage[] = [], c = s.calibration
  ;[c.redHue, c.redSaturation, c.greenHue, c.greenSaturation, c.blueHue, c.blueSaturation].forEach((v, i) => { if (v) out.push(fifty(calibrationStart + i * 5, v)) })
  if (s.exposure) out.push(run(exposureStart, s.exposure, -5, 0.5, 21))
  if (s.temperature || s.tint) out.push(whiteBalance(s.temperature, s.tint))
  if (s.contrast) out.push(adaptive(contrastStart, s.contrast, b.brightest))
  if (s.highlights) out.push(adaptive(highlightsStart, s.highlights, b.logBrightest))
  if (s.whites) out.push(run(whitesStart, s.whites, -100, 25, 9))
  if (s.blacks) out.push(run(blacksStart, s.blacks, -100, 25, 9))
  if (s.saturation) out.push(run(saturationStart, s.saturation, -100, 25, 9))
  if (s.vibrance) out.push(run(vibranceStart, s.vibrance, -100, 25, 9))
  if (hasMeasuredDividers(s.curve)) [s.curve.shadows, s.curve.darks, s.curve.lights, s.curve.highlights].forEach((v, i) => { if (v) out.push(fifty(parametricStart + i * 5, v)) })
  return out
}

function gradingStages(g: GradingSettings): Stage[] {
  const out: Stage[] = []
  ;[g.shadows, g.midtones, g.highlights, g.global].forEach((w, i) => { if (w.luminance) out.push(fifty(gradingLuminanceStart + i * 5, w.luminance)) })
  const balance = g.balance / 100
  const highlightShare = Math.max(0, balance < 0 ? 1 + 1.4 * balance : 1 + 2 * balance), shadowShare = Math.max(0, balance < 0 ? 1 - 1.2 * balance : 1 - 1.4 * balance)
  const [blendLow, blendUp] = between(g.blending, [0, 50, 100])
  const section = (blendIndex: number, wheel: number) => blendIndex === 0 ? gradingStart + wheel * 36 : blendIndex === 1 ? gradingStart + 72 + wheel * 36 : gradingStart + 216 + wheel * 36
  for (const [wheel, color, share, blends] of [[3, g.global, 1, false], [2, g.midtones, 1, false], [1, g.highlights, highlightShare, true], [0, g.shadows, shadowShare, true]] as [number, Wheel, number, boolean][]) {
    if (!(color.saturation * share > 0)) continue
    const position = (color.hue % 360) / 30, first = Math.floor(position) % 12, second = (first + 1) % 12, around = position - Math.floor(position)
    const [level, up] = between(color.saturation * share, [0, 25, 50, 100])
    const parts: Stage = []
    for (const [blendIndex, blendWeight] of blends ? [[blendLow, 1 - blendUp], [blendLow + 1, blendUp]] : [[1, 1]]) {
      const base = section(blendIndex, wheel)
      for (const [hue, hueWeight] of [[first, 1 - around], [second, around]]) for (const [sat, satWeight] of [[level, 1 - up], [level + 1, up]]) parts.push([sat === 0 ? 0 : table(base + hue * 3 + sat - 1), blendWeight * hueWeight * satWeight])
    }
    out.push(parts)
  }
  return out
}

function mixerStages(m: MixerSettings): Stage[] {
  const out: Stage[] = []
  ;[m.luminance, m.saturation, m.hue].forEach((values, kind) => values.forEach((v, color) => { if (v) out.push(fifty(mixerStart + (kind * 8 + color) * 5, v)) }))
  return out
}

// The stages run over the composing grid (`onto` a table made already, or from no change), or null when there are none.
function compose(list: Stage[], onto?: Float32Array): Float32Array | null {
  if (!list.length && !onto) return null
  const out = onto ?? new Float32Array(grid * grid * grid * 3)
  withBuffers([{ data: out, out: true }, { data: stagesBuffer(list.length ? list : [[]]) }], ([o, s]) => call(onto ? 'camera_raw_compose_onto' : 'camera_raw_compose', o, grid, s, list.length, size))
  return out
}

// Camera Raw's parametric curve, matched to Photoshop's, for dividers moved from where the tables were measured (CameraRawColor.swift).
function bend(tone: number, lower: number, low: number, upper: number, high: number) {
  const strength = 1.66
  if (tone < lower && lower > 0) return lower * Math.pow(tone / lower, Math.pow(2, -low / 100 * strength))
  if (tone > upper && upper < 1) { const rest = 1 - upper; return 1 - rest * Math.pow((1 - tone) / rest, Math.pow(2, high / 100 * strength)) }
  return tone
}
const point = (x: number, points: CurvePoint[]) => curveValue(points.map(p => ({ x: p.x * 255, y: p.y * 255 })), x * 255) / 255
function parametric(c: CurveSettings, tone: number) {
  if (!c.shadows && !c.darks && !c.lights && !c.highlights) return tone
  const anchors = Array.from({ length: 33 }, (_, i) => { const x = i / 32; return { x, y: bend(bend(x, c.shadowSplit / 100, c.shadows, c.lightSplit / 100, c.highlights), c.darkSplit / 100, c.darks, c.darkSplit / 100, c.lights) } })
  return point(tone, anchors)
}
const toneTable = (c: CurveSettings) => Float32Array.from({ length: 256 }, (_, i) => point(hasMeasuredDividers(c) ? i / 255 : parametric(c, i / 255), c.rgb))
const channelTable = (points: CurvePoint[]) => Float32Array.from({ length: 256 }, (_, i) => point(i / 255, points))

// What the adaptive sliders read from the picture before any of them, as sRGB levels.
function brightness(pixels: Raster): Brightness {
  const out = new Float64Array(3)
  withBuffers([{ data: pixels.data }, { data: out, out: true }], ([p, o]) => call('camera_raw_statistics', p, pixels.width, pixels.height, pixels.width * 4, o))
  return { brightest: out[0] * 255, luminance: out[1] * 255, logBrightest: out[2] * 255 }
}

const glowStyles: GlowStyle[] = ['Diffusion', 'Bloom', 'Halation'], vignetteStyles: VignetteStyle[] = ['Highlight Priority', 'Color Priority', 'Paint Overlay']

// What the preview shows instead of, or over, the grade, never kept by OK: the Option-drag clipping view (1 highlights, 2 shadows),
// Detail's sharpening mask, the histogram's clipping triangles, and a point color's range (its index).
export type CameraRawView = { clipping?: 0 | 1 | 2; sharpenMask?: boolean; shadows?: boolean; highlights?: boolean; visualize?: number }

// The whole grade on premultiplied RGBA (CameraRawSettings.apply): Geometry first, then Calibration's shadow tint, Light, Color and the
// measured stages as one composed lookup with Curve, Color Mixer and Color Grading folded in (or drawn by the curve pass when point
// colors, Refine Saturation or moved dividers need it), then Effects and Grain, then Optics and Detail. `scale` is preview pixels per
// layer pixel.
export function applyCameraRaw(source: Raster, raw: CameraRawSettings, seed = 0, scale = 1, view: CameraRawView = {}): Raster {
  const s = normalized(raw), clipping = view.clipping ?? 0, sharpenMask = !!view.sharpenMask, visualize = view.visualize ?? -1
  const overlay = !clipping && !sharpenMask && (!!view.shadows || !!view.highlights)
  if (isIdentity(s) && !clipping && !sharpenMask && visualize < 0 && !overlay) return source
  if (!tablesAt) throw new Error('Camera Raw’s color tables are not loaded.')
  const plain = !clipping && !sharpenMask
  const folds = plain && visualize < 0 && !s.mixer.points.length && s.curve.refineSaturation === 0
  const colorAdjusts = adjusts(s, 'Curve') || adjusts(s, 'Color Mixer') || adjusts(s, 'Color Grading')
  const paintColor = !folds && plain && (colorAdjusts || visualize >= 0)
  const pixels = plain && visualize < 0 && adjusts(s, 'Geometry') ? warp(source, s.geometry) : source.clone()
  const { width, height } = pixels, stride = width * 4
  const b = s.contrast || s.highlights ? brightness(pixels) : { brightest: 128, luminance: 128, logBrightest: 128 }
  // Shadows adapts region by region, so it can't join the color table: the stages before it run, then it, then the rest. Its set
  // goes by the layer's own size, so a preview drawn smaller matches the result.
  const shadows = s.shadows && shadowTables ? shadowTables : null, all = stages(s, b), split = shadows ? beforeShadows(s) : 0
  const before = shadows ? compose(all.slice(0, split)) : null
  const coefficients = shadows ? shadowCoefficients(s.shadows, Math.max(width, height) / (scale > 0 ? scale : 1) >= shadows.normalFrom ? 1 : 0, shadows) : null
  let lookup = compose(all.slice(split))
  if (folds && colorAdjusts) {
    lookup ??= identityTable()
    if (adjusts(s, 'Curve')) withBuffers([{ data: lookup, out: true }, { data: toneTable(s.curve) }, { data: channelTable(s.curve.red) }, { data: channelTable(s.curve.green) }, { data: channelTable(s.curve.blue) }], ([t, tone, r, g, bl]) => call('camera_raw_table_curves', t, grid, tone, r, g, bl))
    const more = [...mixerStages(s.mixer), ...gradingStages(s.grading)]
    if (more.length) compose(more, lookup)
  }
  withBuffers([{ data: pixels.data, out: true }, { data: lookup ?? new Float32Array(1) }, { data: before ?? new Float32Array(1) }, { data: coefficients ?? new Float32Array(1) }], ([p, t, early, c]) => {
    if (plain && s.calibration.shadowTint) call('adjust_camera_raw_calibration', p, width, height, stride, s.calibration.shadowTint, 0, 0, 0, 0, 0, 0, processVersions.indexOf(s.calibration.process) + 1)
    if (shadows) {
      if (before) call('adjust_camera_raw', p, width, height, stride, early, grid, 0)
      call('adjust_camera_raw_shadows', p, width, height, stride, c, shadows.xCount, shadows.xLow, shadows.xStep, shadows.kCount, shadows.kLow, shadows.kStep)
    }
    if (lookup || clipping) call('adjust_camera_raw', p, width, height, stride, lookup ? t : 0, grid, clipping)
  })
  if (paintColor) {
    const mixerTable = compose(mixerStages(s.mixer)), gradeTable = compose(gradingStages(s.grading))
    const points = Float32Array.from(s.mixer.points.flatMap(p => [p.hue / 360, p.saturation, p.luminance, p.hueShift / 100, p.saturationShift / 100, p.luminanceShift / 100, p.hueRange / 360, p.saturationRange, p.luminanceRange]))
    withBuffers([{ data: pixels.data, out: true }, { data: toneTable(s.curve) }, { data: channelTable(s.curve.red) }, { data: channelTable(s.curve.green) }, { data: channelTable(s.curve.blue) }, { data: new Float32Array(24) }, { data: points.length ? points : new Float32Array(9) }, { data: new Float32Array(12) }, { data: mixerTable ?? new Float32Array(1) }, { data: gradeTable ?? new Float32Array(1) }],
      ([p, tone, r, g, bl, mixer, pts, grade, mt, gt]) => call('adjust_camera_raw_curve_color', p, width, height, stride, tone, r, g, bl, s.curve.refineSaturation / 100, mixer, s.mixer.points.length, pts, grade, s.grading.blending / 100, s.grading.balance / 100, visualize, mixerTable ? mt : 0, gradeTable ? gt : 0, grid))
  }
  if (plain && adjusts(s, 'Effects')) withBuffers([{ data: pixels.data, out: true }], ([p]) => {
    if (s.texture || s.clarity || s.dehaze || s.glow || s.vignetteAmount) call('adjust_camera_raw_effects', p, width, height, stride, s.texture, s.clarity, s.dehaze, s.glow, glowStyles.indexOf(s.glowStyle), s.glowRange, s.glowSpread, s.glowWarmth, s.vignetteAmount, s.vignetteMidpoint, s.vignetteRoundness, s.vignetteFeather, s.vignetteHighlights, vignetteStyles.indexOf(s.vignetteStyle), scale)
    if (s.grainAmount > 0) call('adjust_grain', p, width, height, stride, s.grainAmount, 0.5 + s.grainSize / 100 * 19.5, s.grainRoughness, seed >>> 0, 0, 0, 1 / scale)
  })
  if (!clipping && (adjusts(s, 'Optics') || adjusts(s, 'Detail') || sharpenMask)) withBuffers([{ data: pixels.data, out: true }], ([p]) => {
    const o = s.optics, d = s.detail, lensStrength = 0.35
    if (sharpenMask) { call('adjust_camera_raw_sharpen_mask_overlay', p, width, height, stride, d.sharpenRadius, d.sharpenDetail, d.sharpenMasking, scale); return }
    if (adjusts(s, 'Optics')) call('adjust_camera_raw_optics', p, width, height, stride, +o.removeChromaticAberration, +o.enableLensProfile, o.profileDistortion, o.profileVignetting,
      o.distortion / 100 * lensStrength + (o.enableLensProfile ? o.profileDistortion / 100 * lensStrength : 0), o.purpleAmount, o.purpleHueLow, o.purpleHueHigh, o.greenAmount, o.greenHueLow, o.greenHueHigh, o.vignetteAmount, o.vignetteMidpoint, scale, table(exposureStart), size)
    if (adjusts(s, 'Detail')) call('adjust_camera_raw_detail', p, width, height, stride, d.sharpenAmount, d.sharpenRadius, d.sharpenDetail, d.sharpenMasking, d.noiseLuminance, d.noiseLuminanceDetail, d.noiseLuminanceContrast, d.noiseColor, d.noiseColorDetail, d.noiseColorSmoothness, scale)
  })
  if (overlay) withBuffers([{ data: pixels.data, out: true }], ([p]) => call('adjust_camera_raw_clip_overlay', p, width, height, stride, +!!view.shadows, +!!view.highlights))
  pixels.touch()
  return pixels
}

function identityTable() {
  const out = new Float32Array(grid * grid * grid * 3)
  withBuffers([{ data: out, out: true }], ([o]) => call('camera_raw_compose', o, grid, 0, 0, size))
  return out
}

// MARK: Geometry (CameraRawGeometryCalibration.swift)

// The picture's corners moved by the sliders, top-left first, in pixels with y down; the image is mapped onto them.
// The guides' straightening, their angles taken in pixels so a line comes out level on a layer of any shape (the Mac measures them in
// fractions of the width and height).
function guided(guides: Guide[], w: number, h: number) {
  const first = guides[0]
  if (!first) return { vertical: 0, horizontal: 0, rotate: 0 }
  const length = Math.hypot(first.endX - first.startX, first.endY - first.startY)
  if (length <= 1e-4) return { vertical: 0, horizontal: 0, rotate: 0 }
  let rotate = -Math.atan2((first.endY - first.startY) * h, (first.endX - first.startX) * w) * 180 / Math.PI
  if (rotate > 45) rotate -= 90; else if (rotate < -45) rotate += 90
  let vertical = 0, horizontal = 0
  const second = guides[1]
  if (second && Math.hypot(second.endX - second.startX, second.endY - second.startY) > 1e-4) {
    const angle = Math.atan2((second.endY - second.startY) * h, (second.endX - second.startX) * w) * 180 / Math.PI
    vertical = Math.abs(angle) > 45 ? (angle > 0 ? 25 : -25) : 0
    horizontal = Math.abs(angle) <= 45 ? (angle > 0 ? 25 : -25) : 0
  }
  return { vertical, horizontal, rotate }
}

function corners(geometry: GeometrySettings, w: number, h: number): [number, number][] {
  const extra = geometry.upright === 'Guided' ? guided(geometry.guides, w, h) : { vertical: 0, horizontal: 0, rotate: 0 }
  const g = { ...geometry, vertical: geometry.vertical + extra.vertical, horizontal: geometry.horizontal + extra.horizontal, rotate: geometry.rotate + extra.rotate }
  const strength = g.projection === 'Perspective' ? 1 : 0.55
  const v = g.vertical / 100 * w * 0.18 * strength, hz = g.horizontal / 100 * h * 0.18 * strength
  const aspect = 1 + g.aspect / 200, zoom = 1 + g.scale / 100, shiftX = g.offsetX / 100 * w * 0.15, shiftY = g.offsetY / 100 * h * 0.15
  // As Core Image places them, y up from the bottom.
  let points: [number, number][] = [[-v + shiftX, h + shiftY], [w + v + shiftX, h + shiftY], [w + hz + shiftX, -shiftY], [-hz + shiftX, -shiftY]]
  const cx = w / 2 + shiftX, cy = h / 2 + shiftY, r = g.rotate * Math.PI / 180
  points = points.map(([x, y]) => [cx + (x - cx) * Math.cos(r) - (y - cy) * Math.sin(r), cy + (x - cx) * Math.sin(r) + (y - cy) * Math.cos(r)])
  points = points.map(([x, y]) => [cx + (x - cx) * aspect * zoom, cy + (y - cy) / aspect * zoom])
  return points.map(([x, y]) => [x, h - y])
}

// The projective map taking the unit square's corners (0,0), (1,0), (1,1), (0,1) to `q`.
function squareTo(q: [number, number][]) {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = q
  const sx = x0 - x1 + x2 - x3, sy = y0 - y1 + y2 - y3
  if (Math.abs(sx) < 1e-9 && Math.abs(sy) < 1e-9) return [x1 - x0, x2 - x1, x0, y1 - y0, y2 - y1, y0, 0, 0]
  const dx1 = x1 - x2, dx2 = x3 - x2, dy1 = y1 - y2, dy2 = y3 - y2, den = dx1 * dy2 - dx2 * dy1
  const g = (sx * dy2 - dx2 * sy) / den, h = (dx1 * sy - sx * dy1) / den
  return [x1 - x0 + g * x1, x3 - x0 + h * x3, x0, y1 - y0 + g * y1, y3 - y0 + h * y3, y0, g, h]
}

function warp(source: Raster, g: GeometrySettings): Raster {
  const { width: w, height: h } = source
  // Each output pixel's place in the unit square through the inverse of the corners' map, then in the source.
  const [a, b, c, d, e, f, gg, hh] = squareTo(corners(g, w, h))
  const A = e - f * hh, B = f * gg - d, C = d * hh - e * gg, D = c * hh - b, E = a - c * gg, F = b * gg - a * hh, G = b * f - c * e, H = c * d - a * f, I = a * e - b * d
  const out = new Raster(w, h, 4), src = source.data, dst = out.data
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const px = x + 0.5, py = y + 0.5, z = C * px + F * py + I
    const u = (A * px + D * py + G) / z * w - 0.5, v = (B * px + E * py + H) / z * h - 0.5
    if (!(u > -1 && v > -1 && u < w && v < h)) continue
    const u0 = Math.floor(u), v0 = Math.floor(v), tu = u - u0, tv = v - v0, o = (y * w + x) * 4
    for (let k = 0; k < 4; k++) {
      const at = (xx: number, yy: number) => xx < 0 || yy < 0 || xx >= w || yy >= h ? 0 : src[(yy * w + xx) * 4 + k]
      dst[o + k] = Math.round((at(u0, v0) * (1 - tu) + at(u0 + 1, v0) * tu) * (1 - tv) + (at(u0, v0 + 1) * (1 - tu) + at(u0 + 1, v0 + 1) * tu) * tv)
    }
  }
  return g.constrainCrop ? constrain(out) : out
}

// Constrain Crop: the empty edges cut away and what's left fitted back into the frame.
function constrain(image: Raster): Raster {
  const { width: w, height: h, data } = image
  let x0 = w, y0 = h, x1 = 0, y1 = 0
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (data[(y * w + x) * 4 + 3]) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x + 1); y1 = Math.max(y1, y + 1) }
  const cw = x1 - x0, ch = y1 - y0
  if (cw < 1 || ch < 1 || (cw >= w && ch >= h)) return image
  const scale = Math.min(w / cw, h / ch), dw = cw * scale, dh = ch * scale, left = (w - dw) / 2, top = (h - dh) / 2, out = new Raster(w, h, 4)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const u = (x + 0.5 - left) / scale + x0 - 0.5, v = (y + 0.5 - top) / scale + y0 - 0.5
    if (u < x0 - 0.5 || v < y0 - 0.5 || u > x1 - 0.5 || v > y1 - 0.5) continue
    const u0 = Math.max(x0, Math.min(x1 - 1, Math.floor(u))), v0 = Math.max(y0, Math.min(y1 - 1, Math.floor(v))), u1 = Math.min(x1 - 1, u0 + 1), v1 = Math.min(y1 - 1, v0 + 1), tu = Math.max(0, u - u0), tv = Math.max(0, v - v0), o = (y * w + x) * 4
    for (let k = 0; k < 4; k++) out.data[o + k] = Math.round((data[(v0 * w + u0) * 4 + k] * (1 - tu) + data[(v0 * w + u1) * 4 + k] * tu) * (1 - tv) + (data[(v1 * w + u0) * 4 + k] * (1 - tu) + data[(v1 * w + u1) * 4 + k] * tu) * tv)
  }
  return out
}

// MARK: White balance

// The Temperature and Tint that turn a straight sRGB color (0…1) most nearly gray: a coarse search over both, then finer ones around
// the best. Null when a channel is missing.
export function neutralize(red: number, green: number, blue: number): { temperature: number; tint: number } | null {
  if (!tablesAt || Math.min(red, green, blue) <= 1e-4) return null
  const color = new Float64Array(3)
  const cast = (temperature: number, tint: number) => {
    color.set([red, green, blue])
    withBuffers([{ data: stagesBuffer([whiteBalance(temperature, tint)]) }, { data: color, out: true }], ([st, c]) => call('camera_raw_stage_color', st, size, c))
    return Math.max(...color) - Math.min(...color)
  }
  let best = { temperature: 0, tint: 0, cast: cast(0, 0) }
  for (const [step, reach] of [[10, 100], [2, 10], [0.5, 2]]) {
    const center = best
    for (let temperature = center.temperature - reach; temperature <= center.temperature + reach + 1e-9; temperature += step)
      for (let tint = center.tint - reach; tint <= center.tint + reach + 1e-9; tint += step) {
        if (Math.abs(temperature) > 100 || Math.abs(tint) > 100) continue
        const found = cast(temperature, tint)
        if (found < best.cast) best = { temperature, tint, cast: found }
      }
  }
  return { temperature: best.temperature, tint: best.tint }
}

const encode = (v: number) => v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055
const decode = (v: number) => v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
// White Balance › Auto: the gray-world balance of the visible pixels, averaged in linear light.
export function autoBalance(pixels: Raster) {
  let r = 0, g = 0, b = 0, n = 0
  const data = pixels.data
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3]
    if (!a) continue
    r += decode(Math.min(1, data[i] / a)); g += decode(Math.min(1, data[i + 1] / a)); b += decode(Math.min(1, data[i + 2] / a)); n++
  }
  return n ? neutralize(encode(r / n), encode(g / n), encode(b / n)) : null
}
