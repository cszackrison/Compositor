import { beforeAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { loadKernels } from '../src/kernels'
import { reduceNoise } from '../src/editor/filterKinds'
import { Raster } from '../src/model/raster'
import { identity } from '../src/render/gl'

beforeAll(async () => { await loadKernels(readFileSync(new URL('../public/kernels.wasm', import.meta.url))) })

// Gray grain over a hard vertical edge, seeded so every run sees the same noise.
function grainy(width: number, height: number, alpha = 255) {
  const r = new Raster(width, height, 4)
  let seed = 7
  const random = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const v = Math.max(0, Math.min(255, (x < width / 2 ? 60 : 190) + Math.round((random() - 0.5) * 50))), i = (y * width + x) * 4
    r.data.set([v * alpha / 255, v * alpha / 255, v * alpha / 255, alpha].map(Math.round), i)
  }
  return r
}
const input = (pixels: Raster) => ({ pixels, isMask: false, toDocument: identity(), layerId: 'L', transform: { origin: [0, 0] as [number, number], size: [pixels.width, pixels.height] as [number, number], rotation: 0, flipX: false, flipY: false, sampling: 'Smooth' as const } })
const spread = (r: Raster, x0: number, x1: number) => {
  const values: number[] = []
  for (let y = 4; y < r.height - 4; y++) for (let x = x0; x < x1; x++) values.push(r.data[(y * r.width + x) * 4])
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  return { mean, deviation: Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length) }
}

describe('Reduce Noise', () => {
  it('smooths grain on either side of an edge and keeps the edge', () => {
    for (const [w, h] of [[160, 120], [301, 77]]) {
      const before = grainy(w, h), out = reduceNoise(input(before.clone()), 80, 20, 0) as Raster
      for (const [x0, x1] of [[4, w / 2 - 6], [w / 2 + 6, w - 4]]) {
        const a = spread(before, x0, x1), b = spread(out, x0, x1)
        expect(b.deviation).toBeLessThan(a.deviation * 0.6)
        expect(Math.abs(b.mean - a.mean)).toBeLessThan(3)
      }
      const left = out.data[((h >> 1) * w + (w >> 1) - 3) * 4], right = out.data[((h >> 1) * w + (w >> 1) + 2) * 4]
      expect(right - left).toBeGreaterThan(90)
    }
  })

  it('keeps alpha and color within it on a partly clear layer', () => {
    const before = grainy(96, 64, 128), out = reduceNoise(input(before.clone()), 80, 20, 50) as Raster
    for (let i = 0; i < out.data.length; i += 4) { expect(out.data[i + 3]).toBe(128); for (let c = 0; c < 3; c++) expect(out.data[i + c]).toBeLessThanOrEqual(128) }
  })

  it('changes nothing at zero strength and color', () => {
    expect(reduceNoise(input(grainy(40, 40)), 0, 50, 0)).toBeNull()
  })
})
