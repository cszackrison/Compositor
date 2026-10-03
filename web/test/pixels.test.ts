import { describe, expect, it } from 'vitest'
import { blurFloats, blurRaster, lazyBlur } from '../src/model/pixels'
import { Raster } from '../src/model/raster'

// The straightforward version the fast pass replaced, for comparison.
function reference(source: Float32Array, width: number, height: number, sigma: number, clamp: boolean) {
  const ideal = Math.sqrt(12 * sigma * sigma / 3 + 1)
  let lower = Math.floor(ideal); if (lower % 2 === 0) lower--
  const m = Math.round((12 * sigma * sigma - 3 * lower * lower - 12 * lower - 9) / (-4 * lower - 4))
  let a = source.slice(), b = new Float32Array(source.length)
  for (let pass = 0; pass < 3; pass++) {
    const r = ((pass < m ? lower : lower + 2) - 1) / 2
    for (const horizontal of [true, false]) {
      const length = horizontal ? width : height, lines = horizontal ? height : width
      for (let line = 0; line < lines; line++) for (let i = 0; i < length; i++) {
        let sum = 0
        for (let k = -r; k <= r; k++) {
          let j = i + k
          if (j < 0 || j >= length) { if (!clamp) continue; j = Math.min(length - 1, Math.max(0, j)) }
          sum += a[horizontal ? line * width + j : j * width + line]
        }
        b[horizontal ? line * width + i : i * width + line] = sum / (2 * r + 1)
      }
      ;[a, b] = [b, a]
    }
  }
  return a
}

describe('blur', () => {
  it('matches a plain box blur, with and without clamped edges', () => {
    const width = 23, height = 17, source = new Float32Array(width * height).map((_, i) => (i * 37) % 255)
    for (const clamp of [false, true]) {
      const fast = blurFloats(source, width, height, 1, 3, clamp), slow = reference(source, width, height, 3, clamp)
      for (let i = 0; i < fast.length; i++) expect(fast[i]).toBeCloseTo(slow[i], 3)
    }
  })

  it('blurs a tile at a time to the same pixels as the whole image', () => {
    const raster = new Raster(300, 200, 4)
    for (let i = 0; i < raster.data.length; i++) raster.data[i] = (i * 53 + (i >> 9) * 17) % 256
    for (const clamp of [false, true]) for (const sigma of [2, 9]) {
      const whole = blurRaster(raster, sigma, clamp), tiled = lazyBlur(raster, sigma, clamp)
      for (let y = 0; y < raster.height; y += 3) for (let x = 0; x < raster.width; x += 2) { const out = [0, 0, 0, 0]; tiled(x, y, out); expect(out).toEqual([...whole.data.subarray((y * raster.width + x) * 4, (y * raster.width + x) * 4 + 4)]) }
    }
  })
})
