import type { Raster } from './raster'

export const formatVersion = 11
export const maxSide = 30_000

export type Sampling = 'Nearest' | 'Smooth' | 'High quality'
export type Transform = { origin: [number, number]; size: [number, number]; rotation: number; flipX: boolean; flipY: boolean; sampling: Sampling }

export const blendModes = ['Normal', 'Darken', 'Multiply', 'Color Burn', 'Linear Burn', 'Lighten', 'Screen', 'Color Dodge', 'Linear Dodge (Add)', 'Overlay', 'Soft Light', 'Hard Light', 'Vivid Light', 'Linear Light', 'Pin Light', 'Hard Mix', 'Difference', 'Exclusion', 'Subtract', 'Divide', 'Hue', 'Saturation', 'Color', 'Luminosity'] as const
export type BlendMode = typeof blendModes[number]
// Where the Layers panel's picker draws its dividers, as in Photoshop.
export const blendModeGroups: BlendMode[][] = [['Normal'], ['Darken', 'Multiply', 'Color Burn', 'Linear Burn'], ['Lighten', 'Screen', 'Color Dodge', 'Linear Dodge (Add)'], ['Overlay', 'Soft Light', 'Hard Light', 'Vivid Light', 'Linear Light', 'Pin Light', 'Hard Mix'], ['Difference', 'Exclusion', 'Subtract', 'Divide'], ['Hue', 'Saturation', 'Color', 'Luminosity']]

export const adjustmentKinds = ['Hue/Saturation', 'Levels', 'Curves', 'Exposure', 'Gradient Map', 'Grain', 'Add Noise', 'Gaussian Blur', 'Motion Blur', 'Invert', 'Black & White', 'Color Balance'] as const
export type AdjustmentKind = typeof adjustmentKinds[number]

export type LevelRange = { black: number; gamma: number; white: number; outputBlack: number; outputWhite: number }
export type CurvePoint = { x: number; y: number }
export type ColorRange = 'Master' | 'Reds' | 'Yellows' | 'Greens' | 'Cyans' | 'Blues' | 'Magentas'
export const colorRanges: ColorRange[] = ['Master', 'Reds', 'Yellows', 'Greens', 'Cyans', 'Blues', 'Magentas']
export type RangeAdjustment = { hue: number; saturation: number; lightness: number }
export type HueBand = { falloffStart: number; rangeStart: number; rangeEnd: number; falloffEnd: number }
export type RGB = { red: number; green: number; blue: number }

// Swift encodes a dictionary keyed by an enum as a flat [key, value, key, value] array; the web keeps it as an object while editing.
export type HueSaturationSettings = { range: ColorRange; colorize: boolean; invertRange: boolean; adjustments: Partial<Record<ColorRange, RangeAdjustment>>; bands: Partial<Record<ColorRange, HueBand>> }

export type Adjustment = {
  kind: AdjustmentKind
  hue: number; saturation: number; lightness: number; colorize: boolean
  hsvSettings?: HueSaturationSettings
  levels: { channel: 'RGB' | 'Red' | 'Green' | 'Blue'; ranges: LevelRange[] }
  curves: { channel: 'RGB' | 'Red' | 'Green' | 'Blue'; channels: CurvePoint[][] }
  exposureSettings?: { exposure: number; offset: number; gamma: number }
  gradientMapSettings?: { shadows: RGB; highlights: RGB; reversed: boolean }
  grainSettings?: { amount: number; size: number; roughness: number; seed: number }
  blackWhiteSettings?: { reds: number; yellows: number; greens: number; cyans: number; blues: number; magentas: number; tint: boolean; tintHue: number; tintSaturation: number }
  colorBalanceSettings?: { shadowCyanRed: number; shadowMagentaGreen: number; shadowYellowBlue: number; midCyanRed: number; midMagentaGreen: number; midYellowBlue: number; highlightCyanRed: number; highlightMagentaGreen: number; highlightYellowBlue: number; preserveLuminosity: boolean }
  blurRadius?: number
  motionAngle?: number; motionDistance?: number
  noiseAmount?: number; noiseGaussian?: boolean; noiseMonochromatic?: boolean; noiseSeed?: number
}

export type EffectBase = { enabled?: boolean; red: number; green: number; blue: number; opacity: number }
export type LayerEffects = {
  stroke?: EffectBase & { size: number; inside: boolean }
  shadow?: EffectBase & { angle: number; distance: number; blur: number }
  colorOverlay?: EffectBase
  innerShadow?: EffectBase & { angle: number; distance: number; blur: number }
  outerGlow?: EffectBase & { size: number }
  innerGlow?: EffectBase & { size: number }
}
export const effectKinds = ['stroke', 'shadow', 'colorOverlay', 'innerShadow', 'outerGlow', 'innerGlow'] as const
export type EffectKind = typeof effectKinds[number]
export const effectNames: Record<EffectKind, string> = { stroke: 'Stroke', shadow: 'Drop Shadow', colorOverlay: 'Color Overlay', innerShadow: 'Inner Shadow', outerGlow: 'Outer Glow', innerGlow: 'Inner Glow' }

export type Layer = {
  id: string
  name: string
  visible: boolean
  isGroup: boolean
  parentId: string | null
  transform: Transform
  opacity: number
  blendMode: BlendMode
  image: Raster | null
  mask: Raster | null
  maskEnabled: boolean
  maskLinked: boolean
  maskPlacement: Transform | null
  clipTo: string | null
  adjustment: Adjustment | null
  effects: LayerEffects | null
  // Metadata the web app shows but doesn't edit (text, shape), kept so a save loses nothing. Dropped when pixels change.
  text: unknown
  shape: unknown
  extra: Record<string, unknown>
}

export type Guide = { id: string; axis: 'horizontal' | 'vertical'; position: number }

export type Doc = {
  id: string
  width: number
  height: number
  resolution: number
  layers: Layer[]
  guides: Guide[]
  extra: Record<string, unknown>
}

// crypto.randomUUID only exists in secure contexts (https or localhost); a phone opening the dev server by its network address
// has getRandomValues alone.
export const uuid = () => {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID().toUpperCase()
  const b = crypto.getRandomValues(new Uint8Array(16))
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80
  const h = [...b].map(v => v.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`.toUpperCase()
}

export function fullTransform(width: number, height: number, x = 0, y = 0): Transform {
  return { origin: [x, y], size: [width, height], rotation: 0, flipX: false, flipY: false, sampling: 'High quality' }
}

export const identityRange = (): LevelRange => ({ black: 0, gamma: 1, white: 255, outputBlack: 0, outputWhite: 255 })
export const identityCurve = (): CurvePoint[] => [{ x: 0, y: 0 }, { x: 255, y: 255 }]

export const defaultBands: Record<ColorRange, HueBand> = {
  Master: { falloffStart: 0, rangeStart: 0, rangeEnd: 360, falloffEnd: 360 },
  Reds: { falloffStart: 315, rangeStart: 345, rangeEnd: 15, falloffEnd: 45 },
  Yellows: { falloffStart: 15, rangeStart: 45, rangeEnd: 75, falloffEnd: 105 },
  Greens: { falloffStart: 75, rangeStart: 105, rangeEnd: 135, falloffEnd: 165 },
  Cyans: { falloffStart: 135, rangeStart: 165, rangeEnd: 195, falloffEnd: 225 },
  Blues: { falloffStart: 195, rangeStart: 225, rangeEnd: 255, falloffEnd: 285 },
  Magentas: { falloffStart: 255, rangeStart: 285, rangeEnd: 315, falloffEnd: 345 },
}

export function newAdjustment(kind: AdjustmentKind): Adjustment {
  const adjustment: Adjustment = { kind, hue: 0, saturation: 0, lightness: 0, colorize: false, levels: { channel: 'RGB', ranges: [0, 1, 2, 3].map(identityRange) }, curves: { channel: 'RGB', channels: [0, 1, 2, 3].map(identityCurve) } }
  if (kind === 'Hue/Saturation') adjustment.hsvSettings = { range: 'Master', colorize: false, invertRange: false, adjustments: { Master: { hue: 0, saturation: 0, lightness: 0 } }, bands: { ...defaultBands } }
  if (kind === 'Exposure') adjustment.exposureSettings = { exposure: 0, offset: 0, gamma: 1 }
  if (kind === 'Gradient Map') adjustment.gradientMapSettings = { shadows: { red: 0, green: 0, blue: 0 }, highlights: { red: 1, green: 1, blue: 1 }, reversed: false }
  if (kind === 'Grain') adjustment.grainSettings = { amount: 25, size: 1.5, roughness: 50, seed: Math.floor(Math.random() * 2 ** 32) }
  if (kind === 'Black & White') adjustment.blackWhiteSettings = { reds: 40, yellows: 60, greens: 40, cyans: 60, blues: 20, magentas: 80, tint: false, tintHue: 40, tintSaturation: 20 }
  if (kind === 'Color Balance') adjustment.colorBalanceSettings = { shadowCyanRed: 0, shadowMagentaGreen: 0, shadowYellowBlue: 0, midCyanRed: 0, midMagentaGreen: 0, midYellowBlue: 0, highlightCyanRed: 0, highlightMagentaGreen: 0, highlightYellowBlue: 0, preserveLuminosity: true }
  if (kind === 'Gaussian Blur') adjustment.blurRadius = 10
  if (kind === 'Motion Blur') { adjustment.motionAngle = 0; adjustment.motionDistance = 10 }
  if (kind === 'Add Noise') Object.assign(adjustment, { noiseAmount: 10, noiseGaussian: false, noiseMonochromatic: false, noiseSeed: Math.floor(Math.random() * 2 ** 32) })
  return adjustment
}

export function newLayer(fields: Partial<Layer> & { name: string; transform: Transform }): Layer {
  return { id: uuid(), visible: true, isGroup: false, parentId: null, opacity: 1, blendMode: 'Normal', image: null, mask: null, maskEnabled: true, maskLinked: true, maskPlacement: null, clipTo: null, adjustment: null, effects: null, text: undefined, shape: undefined, extra: {}, ...fields }
}
