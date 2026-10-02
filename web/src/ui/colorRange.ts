import { Raster } from '../model/raster'
import { call, withBuffers } from '../kernels'

export const color_range = {
  // The straight color averaged over the 3×3 pixels around a point, or null on transparent pixels or off the canvas.
  sample(pixels: Raster, point: [number, number]): [number, number, number] | null {
    const cx = Math.floor(point[0]), cy = Math.floor(point[1])
    if (cx < 0 || cy < 0 || cx >= pixels.width || cy >= pixels.height) return null
    const sum = [0, 0, 0]
    let alpha = 0
    for (let y = cy - 1; y <= cy + 1; y++) for (let x = cx - 1; x <= cx + 1; x++) {
      if (x < 0 || y < 0 || x >= pixels.width || y >= pixels.height) continue
      const i = (y * pixels.width + x) * 4
      for (let c = 0; c < 3; c++) sum[c] += pixels.data[i + c]
      alpha += pixels.data[i + 3]
    }
    if (!alpha) return null
    return sum.map(s => Math.min(255, Math.round((s * 255 + alpha / 2) / alpha))) as [number, number, number]
  },
}

export function colorRangeMask(pixels: Raster, include: [number, number, number][], exclude: [number, number, number][], fuzziness: number, invert: boolean): Raster {
  const out = new Raster(pixels.width, pixels.height, 1)
  withBuffers([{ data: pixels.data }, { data: new Uint8Array(include.flat()) }, { data: new Uint8Array(exclude.flat().length ? exclude.flat() : [0]) }, { data: out.data, out: true }], ([p, inc, exc, mask]) =>
    call('color_range_mask', p, pixels.width, pixels.height, pixels.width * 4, inc, include.length, exc, exclude.length, fuzziness, invert ? 1 : 0, mask))
  return out
}
