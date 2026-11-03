import { describe, expect, it } from 'vitest'
import { bokehShapes, defaultLens, lensEffect, lensEffects, type LensSettings, normalizedLens } from '../src/editor/lensEffects'
import { Raster } from '../src/model/raster'

const size = 96

// An opaque black square with a small white light at (x, y).
function point(x = 48, y = 48) {
  const image = Raster.filled(size, size, 4, [0, 0, 0, 255])
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) image.data.set([255, 255, 255, 255], ((y + dy) * size + x + dx) * 4)
  return image
}
const at = (image: Raster, x: number, y: number) => [...image.data.subarray((y * size + x) * 4, (y * size + x) * 4 + 4)]
const lit = (image: Raster, x: number, y: number) => at(image, x, y).slice(0, 3).some(v => v > 0)

describe('lens effects', () => {
  it('fill in defaults and clamp as the Mac does', () => {
    expect(normalizedLens(undefined)).toEqual(defaultLens)
    expect(normalizedLens({})).toEqual(defaultLens)
    expect(defaultLens.prismFringe).toBe(30)
    const n = normalizedLens({ threshold: 20, flareLength: 0, starLength: 99, starPoints: 5, prismCopies: 3.6, prismOffset: -4, bokehRadius: 9, prismAngle: NaN, effect: 'Glow' as LensSettings['effect'], bokehShape: 'Square' as LensSettings['bokehShape'], prismBothWays: 1 as unknown as boolean })
    expect(n).toMatchObject({ threshold: 50, flareLength: 1, starLength: 40, starPoints: 6, prismCopies: 4, prismOffset: 0, bokehRadius: 6, prismAngle: 180, effect: 'Anamorphic Flare', bokehShape: 'Round', prismBothWays: false })
    expect(normalizedLens({ effect: 'Bokeh', bokehShape: "Cat's Eye", starPoints: 14, prismBothWays: true, prismFringe: 0 })).toMatchObject({ effect: 'Bokeh', bokehShape: "Cat's Eye", starPoints: 14, prismBothWays: true, prismFringe: 0 })
  })

  it('leave a black picture black', () => {
    const black = Raster.filled(size, size, 4, [0, 0, 0, 255])
    for (const effect of lensEffects) {
      const out = lensEffect(black, { ...defaultLens, effect }, size)
      expect(out.data.every((v, i) => i % 4 === 3 ? v === 255 : v === 0), effect).toBe(true)
    }
  })

  it('spread a bright light the way each effect draws it', () => {
    const run = (s: Partial<LensSettings>) => lensEffect(point(), { ...defaultLens, ...s }, size)
    // Flare: a horizontal streak, and nothing straight up.
    const flare = run({ effect: 'Anamorphic Flare' })
    expect(lit(flare, 78, 48) && lit(flare, 18, 48)).toBe(true)
    expect(at(flare, 78, 48)[2]).toBeGreaterThan(at(flare, 78, 48)[0])
    expect(lit(flare, 48, 20)).toBe(false)
    // Starburst: spikes at 15° and every 60° after it, counterclockwise, rows running down.
    const star = run({ effect: 'Starburst', starLength: 30 })
    const spike = (degrees: number, distance: number) => lit(star, Math.round(48 + Math.cos(degrees * Math.PI / 180) * distance), Math.round(48 - Math.sin(degrees * Math.PI / 180) * distance))
    expect(spike(15, 6) && spike(75, 6) && spike(135, 6) && spike(195, 6)).toBe(true)
    expect(spike(45, 10)).toBe(false)
    expect(lit(run({ effect: 'Mist' }), 52, 48)).toBe(true)
    // Prism: copies stepped left (180°), 6% of the side apart.
    const prism = run({ effect: 'Prism', prismFringe: 0 })
    expect(lit(prism, 48 - 6, 48) && lit(prism, 48 - 11, 48)).toBe(true)
    expect(lit(prism, 48 + 6, 48)).toBe(false)
    expect(lit(run({ effect: 'Prism', prismBothWays: true, prismBlur: 50 }), 48 + 6, 48)).toBe(true)
    for (const bokehShape of bokehShapes) {
      const disc = run({ effect: 'Bokeh', bokehRadius: 4, bokehShape })
      expect(lit(disc, 48, 48 - 3) && lit(disc, 48 - 3, 48), bokehShape).toBe(true)
      expect(lit(disc, 48, 48 - 9), bokehShape).toBe(false)
    }
  })

  it("keep the layer's transparency and leave it alone when there's nothing to do", () => {
    const image = point()
    for (let i = 0; i < size * 10; i++) image.data.set([0, 0, 0, 0], i * 4)
    const out = lensEffect(image, { ...defaultLens, effect: 'Mist' }, size)
    expect(out.data.every((v, i) => i % 4 !== 3 || v === image.data[i])).toBe(true)
    expect(Buffer.from(lensEffect(image, { ...defaultLens, flareAmount: 0 }, size).data).equals(Buffer.from(image.data))).toBe(true)
  })

  it('measure its lengths by the document, not the layer', () => {
    const short = lensEffect(point(), { ...defaultLens, effect: 'Anamorphic Flare', flareLength: 20 }, size), long = lensEffect(point(), { ...defaultLens, effect: 'Anamorphic Flare', flareLength: 20 }, size * 4)
    expect(at(long, 90, 48)[2]).toBeGreaterThan(at(short, 90, 48)[2])
  })
})
