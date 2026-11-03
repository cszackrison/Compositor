import type { AdjustmentKind, FilterLayerSettings } from '../model/types'
import { defaultFilterLayer, defaultReduceNoiseLayer, defaultSharpenLayer, defaultTonalLayer, defaultVignetteLayer } from '../model/types'
import type * as kinds from './filterKinds'
import type { Sides } from './filterKinds'

export type FilterLayerJob = { job: keyof typeof kinds; args: unknown[] }

// Where a filter adjustment layer, or a filter of the same name run on a layer, works: `scale` is its pixels per document (or layer)
// pixel, for the settings in pixels; `side` the document's longer side in its pixels, which Lens Effects measures itself by; `sides`
// those at the canvas's edge, which the blurs carry their edge pixels on past.
export type FilterPlace = { scale: number; side: number; sides: Sides }

// The filter job a filter kind makes of its settings (LayerAdjustment.apply, FilterLayerSettings.applied), positions left in document
// points for the job's own mapping; null when the settings change nothing.
export function filterLayerJob(kind: AdjustmentKind, raw: FilterLayerSettings | undefined, place: FilterPlace): FilterLayerJob | null {
  const f = { ...defaultFilterLayer(), ...raw }, { scale, side, sides } = place
  switch (kind) {
    case 'Progressive Blur': return f.progressiveStart && f.progressiveEnd ? { job: 'progressiveBlur', args: [f.progressiveFrom * scale, f.progressiveTo * scale, f.progressiveStart, f.progressiveEnd, f.progressiveRadial, f.progressiveInverted, sides] } : null
    case 'Bloom / Glow': return f.bloomAmount > 0 ? { job: 'bloom', args: [f.bloomAmount, f.bloomRadius * scale] } : null
    case 'RGB Split': return f.rgbSplitDistance > 0 || f.rgbSplitBlur > 0 ? { job: 'rgbSplit', args: [f.rgbSplitDistance * scale, f.rgbSplitBlur * scale, f.rgbSplitAngle, f.rgbSplitRadial, f.rgbSplitCenter ?? null, f.rgbSplitReach, sides] } : null
    case 'Vignette': {
      const v = { ...defaultVignetteLayer(), ...f.vignette }
      return v.amount > 0 ? { job: 'vignette', args: [{ color: [v.color.red, v.color.green, v.color.blue].map(c => Math.round(c * 255)), amount: v.amount, midpoint: v.midpoint, roundness: v.roundness, feather: v.feather, highlights: v.highlights }, false] } : null
    }
    case 'Tonal Contrast': {
      const t = { ...defaultTonalLayer(), ...f.tonal }
      return { job: 'tonalContrast', args: [t.amount, t.shadows, t.midtones, t.highlights, t.radius * scale] }
    }
    case 'Lens Effects': return { job: 'lensEffects', args: [f.lens ?? {}, side] }
    case 'Sharpen': {
      const s = { ...defaultSharpenLayer(), ...f.sharpen }
      return s.amount > 0 ? { job: 'sharpen', args: [s.amount, s.radius * scale, sides] } : null
    }
    case 'Reduce Noise': {
      const r = { ...defaultReduceNoiseLayer(), ...f.reduceNoise }
      return r.strength > 0 || r.color > 0 ? { job: 'reduceNoise', args: [r.strength, r.details, r.color, scale] } : null
    }
    default: return null
  }
}
