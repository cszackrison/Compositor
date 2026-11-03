import { beforeAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { loadKernels } from '../src/kernels'
import * as kinds from '../src/editor/filterKinds'
import { bandPlan, runInBands } from '../src/editor/bands'
import type { FilterInput, FilterOutput } from '../src/editor/filters'
import { Raster } from '../src/model/raster'
import { chain, identity, scale, translate } from '../src/render/gl'

beforeAll(async () => { await loadKernels(readFileSync(new URL('../public/kernels.wasm', import.meta.url))) })

// Grain, edges and lights over a gradient; `cut` clears a corner and fades an edge, so coverage counts too.
function picture(width: number, height: number, cut = false) {
  const r = new Raster(width, height, 4)
  let seed = 3
  const random = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4, lit = (x - width * 0.6) ** 2 + (y - height * 0.3) ** 2 < 400, a = !cut ? 255 : x + y < 120 ? 0 : x > width - 40 ? Math.round(255 * (width - x) / 40) : 255
    const base = [40 + 120 * x / width, 30 + 100 * y / height, x % 97 < 50 ? 60 : 180].map(v => lit ? 255 : Math.max(0, Math.min(255, v + (random() - 0.5) * 40)))
    r.data.set([...base.map(v => Math.round(v * a / 255)), a], i)
  }
  return r
}
const input = (pixels: Raster, toDocument = identity()): FilterInput => ({ pixels, isMask: false, toDocument, layerId: 'L', transform: { origin: [0, 0], size: [pixels.width, pixels.height], rotation: 0, flipX: false, flipY: false, sampling: 'Smooth' } })
const pixelsOf = (o: FilterOutput | undefined) => !o ? null : 'pixels' in o ? o.pixels : o
const every = { left: true, right: true, top: true, bottom: true }, some = { left: true, right: false, top: true, bottom: false }

function expectSame(name: keyof typeof kinds, args: unknown[], tolerance = 0, pictures = [picture(620, 880), picture(613, 871, true)], toDocument = identity()) {
  for (const p of pictures) for (const lanes of [2, 3, 7]) {
    const whole = pixelsOf((kinds[name] as unknown as (i: FilterInput, ...a: unknown[]) => FilterOutput)(input(p.clone(), toDocument), ...args)), banded = pixelsOf(runInBands(name, input(p.clone(), toDocument), args, lanes))
    expect(banded, `${name} ${lanes} lanes ran in bands`).not.toBeNull()
    let worst = 0
    for (let i = 0; i < whole!.data.length; i++) worst = Math.max(worst, Math.abs(whole!.data[i] - banded!.data[i]))
    expect(worst, `${name} ${JSON.stringify(args)} in ${lanes} bands`).toBeLessThanOrEqual(tolerance)
  }
}

describe('filters in bands', { timeout: 120_000 }, () => {
  it('Sharpen matches the whole picture', () => { expectSame('sharpen', [120, 3, every]); expectSame('sharpen', [80, 12.5, some]) })
  it('Tonal Contrast matches', () => expectSame('tonalContrast', [60, 30, -20, 40, 25]))
  it('Reduce Noise matches, smoothing every band by the whole picture’s noise', () => { expectSame('reduceNoise', [70, 40, 0], 1); expectSame('reduceNoise', [50, 50, 80], 1); expectSame('reduceNoise', [0, 50, 100], 0) })
  it('RGB Split matches, Linear and Radial, with and without Blur', () => {
    expectSame('rgbSplit', [12, 0, 0, false, null, 300, every])
    expectSame('rgbSplit', [9, 0, 30, false, null, 300, some])
    expectSame('rgbSplit', [10, 24, 75, false, null, 300, every])
    expectSame('rgbSplit', [14, 0, 0, true, null, 400, every])
    expectSame('rgbSplit', [8, 16, 0, true, [200, 650], 350, some])
    expectSame('rgbSplit', [30, 60, 0, true, null, 250, every], 0, [picture(620, 880)])
    expectSame('rgbSplit', [40, 70, 95, false, null, 300, some], 0, [picture(620, 880)])
    // On a layer that sits scaled and moved in the document.
    expectSame('rgbSplit', [10, 12, 20, true, [500, 400], 300, every], 0, [picture(640, 900)], chain(translate(100, 50), scale(1.5)))
  })
  it('leaves out small pictures, filters that can’t be banded, and reaches too long for the bands', () => {
    expect(bandPlan('sharpen', input(picture(100, 100)), [100, 3, every], 4)).toBeNull()
    expect(bandPlan('bloom', input(picture(700, 900)), [50, 30], 4)).toBeNull()
    expect(bandPlan('rgbSplit', input(picture(700, 900)), [600, 0, 90, false, null, 300, every], 8)).toBeNull()
    expect(bandPlan('sharpen', input(picture(700, 900)), [100, 3, every], 1)).toBeNull()
  })
})
