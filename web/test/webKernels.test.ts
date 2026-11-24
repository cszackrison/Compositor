import { beforeAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { loadKernels } from '../src/kernels'
import { Raster } from '../src/model/raster'
import { blurRaster } from '../src/model/pixels'
import * as kinds from '../src/editor/filterKinds'
import { runInBands, bandPlan } from '../src/editor/bands'
import { renderEffects } from '../src/render/effects'
import { renderEffects as referenceEffects } from './fixtures/effectsReference'
import { rgbSplit, type RGBSplitSettings } from '../src/editor/rgbSplit'
import { defaultLens, lensEffect } from '../src/editor/lensEffects'
import { defaultVolumetric, volumetricLight } from '../src/editor/volumetricLight'
import { identity } from '../src/render/gl'
import type { FilterInput, FilterOutput } from '../src/editor/filters'
import type { LayerEffects } from '../src/model/types'

beforeAll(async () => {
  await loadKernels(readFileSync(new URL('../public/kernels.wasm', import.meta.url)))
})

function sampleImage(width: number, height: number, cutout = false) {
  const r = new Raster(width, height, 4)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4
    const inside = Math.hypot(x - width / 2, y - height / 2) < Math.min(width, height) * 0.35
    const a = !cutout ? 255 : inside ? 255 : (x * 7 + y * 5) % 90 === 0 ? 128 : 0
    const red = (x * 5 + y * 3) & 255, green = (x * 3 + y * 7) & 255, blue = ((x ^ y) * 11) & 255
    r.data[i] = Math.round(red * a / 255)
    r.data[i + 1] = Math.round(green * a / 255)
    r.data[i + 2] = Math.round(blue * a / 255)
    r.data[i + 3] = a
  }
  return r
}

const allSides: kinds.Sides = { left: true, right: true, top: true, bottom: true }
const inputOf = (pixels: Raster): FilterInput => ({
  pixels, isMask: false, toDocument: identity(), layerId: 'L',
  transform: { origin: [0, 0], size: [pixels.width, pixels.height], rotation: 0, flipX: false, flipY: false, sampling: 'Smooth' },
})
const pixelsOf = (out: FilterOutput | undefined) => !out ? null : 'pixels' in out ? out.pixels : out

describe('WASM SIMD web kernels parity', () => {
  it('renderEffects with WASM blur matches reference byte for byte above threshold', () => {
    const image = sampleImage(160, 140, true)
    const mask = new Raster(80, 70, 1, Uint8Array.from({ length: 80 * 70 }, (_, i) => (i * 37) & 255))
    const color = { red: 0.2, green: 0.5, blue: 0.85 }
    const cases: LayerEffects[] = [
      { shadow: { ...color, angle: 120, distance: 6.5, blur: 10, opacity: 0.7 } } as LayerEffects,
      { innerShadow: { ...color, angle: 35, distance: 4, blur: 8, opacity: 0.6 }, outerGlow: { ...color, size: 10, opacity: 0.8 }, innerGlow: { ...color, size: 8, opacity: 0.5 }, colorOverlay: { ...color, opacity: 0.35 } } as LayerEffects,
    ]
    for (const fx of cases) for (const m of [null, mask]) {
      const fast = renderEffects(image, m, fx), slow = referenceEffects(image, m, fx)
      expect(fast.inset).toBe(slow.inset)
      expect(Buffer.from(fast.raster.data).equals(Buffer.from(slow.raster.data))).toBe(true)
    }
  })

  it('motionBlur matches across bands and handles axis-aligned and diagonal angles cleanly', () => {
    const image = sampleImage(560, 560)
    // Diagonal banded matches whole pixel for pixel.
    const whole = pixelsOf(kinds.motionBlur(inputOf(image.clone()), 30, 36, allSides))!
    const banded = pixelsOf(runInBands('motionBlur', inputOf(image.clone()), [30, 36, allSides], 4))!
    let worst = 0
    for (let i = 0; i < whole.data.length; i++) worst = Math.max(worst, Math.abs(whole.data[i] - banded.data[i]))
    expect(worst).toBe(0)
    // Axis-aligned horizontal blur preserves solid color and matches 1D blur behavior.
    const solid = Raster.filled(160, 160, 4, [120, 180, 60, 255])
    const blurredH = pixelsOf(kinds.motionBlur(inputOf(solid.clone()), 0, 40, allSides))!
    expect(Buffer.from(blurredH.data).equals(Buffer.from(solid.data))).toBe(true)
    // Unclamped floating layer is not banded so its grown grid stays intact.
    expect(bandPlan('motionBlur', inputOf(image), [30, 36, kinds.noSides], 4)).toBeNull()
  })

  it('WASM blurRaster, rgbSplit, lensEffect, and volumetricLight produce valid results above SIMD thresholds', () => {
    const image = sampleImage(160, 160)
    const blurred = blurRaster(image, 8, true)
    expect(blurred.width).toBe(160)
    expect(blurred.data[3]).toBe(255)

    const splitSettings: RGBSplitSettings = { distance: 12, blur: 10, angle: 30, radial: true, center: [80, 80], reach: 60 }
    const split = rgbSplit(image, splitSettings, allSides)
    expect(split.data[3]).toBe(255)

    const mist = lensEffect(image, { ...defaultLens, effect: 'Mist', mistStrength: 60, mistSize: 30 }, 160)
    expect(mist.data[3]).toBe(255)

    const depth = Float32Array.from({ length: 160 * 160 }, (_, i) => (i % 160) / 160)
    const vol = volumetricLight(image, depth, null, { ...defaultVolumetric, intensity: 60, length: 50, haze: 50, shafts: 40 }, [40, 40])
    expect(vol.data[3]).toBe(255)
  })
})
