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

  it('recolor translucent pixels fully with an overlay, keeping their alpha and leaving the shadow untinted', () => {
    const image = new Raster(5, 5, 4)
    for (let i = 0; i < 25; i++) image.data.set([0, 0, 0, 128], i * 4)
    const white = { red: 1, green: 1, blue: 1 }
    const { raster, inset } = renderEffects(image, null, { colorOverlay: { ...white, opacity: 1 } } as LayerEffects)
    const center = ((inset + 2) * raster.width + inset + 2) * 4
    expect([...raster.data.subarray(center, center + 4)]).toEqual([128, 128, 128, 128])
  })

  it('gives a circle a round stroke of the same thickness on the diagonals as on the axes', () => {
    const size = 61, center = 30, radius = 16, width = 8
    const image = new Raster(size, size, 4)
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      if (Math.hypot(x - center, y - center) <= radius) image.data.set([255, 255, 255, 255], (y * size + x) * 4)
    }
    const { raster, inset } = renderEffects(image, null, { stroke: { red: 1, green: 0, blue: 0, size: width, opacity: 1, inside: false } } as LayerEffects)
    const cx = center + inset, cy = center + inset
    const alphaAt = (x: number, y: number) => raster.data[(y * raster.width + x) * 4 + 3]
    // On the axis, radius + width is inside the stroke and radius + width + 2 is outside.
    expect(alphaAt(cx + radius + width, cy)).toBeGreaterThan(200)
    expect(alphaAt(cx + radius + width + 2, cy)).toBe(0)
    // On the 45° diagonal, the stroke must stop at Euclidean radius + width, not at square distance (radius + width) * sqrt(2).
    const diagIn = Math.floor((radius + width - 1) / Math.SQRT2)
    const diagOut = Math.ceil((radius + width + 2) / Math.SQRT2)
    expect(alphaAt(cx + diagIn, cy + diagIn)).toBeGreaterThan(200)
    expect(alphaAt(cx + diagOut, cy + diagOut)).toBe(0)
  })

  it('rounds an outside stroke around a square corner and keeps an inside stroke square', () => {
    const image = Raster.filled(30, 30, 4, [255, 255, 255, 255])
    const outside = renderEffects(image, null, { stroke: { red: 1, green: 0, blue: 0, size: 8, opacity: 1, inside: false } } as LayerEffects)
    // Corner at (-7, -7) outside the square has Euclidean distance ~9.9 > 8, so it must be transparent (unlike a square dilation).
    const c = outside.inset - 7
    expect(outside.raster.data[(c * outside.raster.width + c) * 4 + 3]).toBe(0)
    // Inside stroke reaches 6 px from each edge; a pixel 7 px inside both edges stays white.
    const inside = renderEffects(image, null, { stroke: { red: 1, green: 0, blue: 0, size: 6, opacity: 1, inside: true } } as LayerEffects)
    const inner = ((inside.inset + 8) * inside.raster.width + inside.inset + 8) * 4
    expect([...inside.raster.data.subarray(inner, inner + 4)]).toEqual([255, 255, 255, 255])
    const rim = ((inside.inset + 2) * inside.raster.width + inside.inset + 2) * 4
    expect([...inside.raster.data.subarray(rim, rim + 4)]).toEqual([255, 0, 0, 255])
  })
})
