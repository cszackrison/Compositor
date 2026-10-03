import { describe, expect, it } from 'vitest'
import { renderEffects } from '../src/render/effects'
import { renderEffects as reference } from './fixtures/effectsReference'
import { Raster } from '../src/model/raster'
import type { LayerEffects } from '../src/model/types'

const color = { red: 0.2, green: 0.4, blue: 0.9 }

describe('layer effects', () => {
  it('match the previous renderer byte for byte', () => {
    const image = new Raster(37, 29, 4)
    for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
      const i = (y * image.width + x) * 4, inside = Math.hypot(x - 18, y - 14) < 11 ? 255 : (x * 7 + y * 3) % 40
      image.data.set([Math.round(inside * 0.8), Math.round(inside * 0.3), Math.round(inside * 0.5), inside], i)
    }
    const mask = new Raster(20, 15, 1).data.map((_, i) => (i * 37) % 256)
    const cases: LayerEffects[] = [
      { stroke: { ...color, size: 3, opacity: 0.9, inside: false } } as LayerEffects,
      { stroke: { ...color, size: 2, opacity: 1, inside: true } } as LayerEffects,
      { shadow: { ...color, angle: 120, distance: 4.5, blur: 6, opacity: 0.7 } } as LayerEffects,
      { innerShadow: { ...color, angle: 30, distance: 2, blur: 3, opacity: 0.6 }, outerGlow: { ...color, size: 5, opacity: 0.8 }, innerGlow: { ...color, size: 4, opacity: 0.5 }, colorOverlay: { ...color, opacity: 0.4 } } as LayerEffects,
    ]
    for (const effects of cases) for (const withMask of [false, true]) {
      const m = withMask ? new Raster(20, 15, 1, mask) : null
      const fast = renderEffects(image, m, effects), slow = reference(image, m, effects)
      expect(fast.inset).toBe(slow.inset)
      expect(Buffer.from(fast.raster.data).equals(Buffer.from(slow.raster.data))).toBe(true)
    }
  })
})
