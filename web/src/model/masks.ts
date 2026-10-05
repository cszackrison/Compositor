import { Raster } from './raster'
import { apply, invert, multiply, type Mat3 } from '../render/gl'
import { pixelToDocument } from '../render/compositor'
import type { Transform } from './types'

// The tone past a mask's edges, as the compositor shows a placed mask there: white when most edge pixels are light.
export function maskEdgeTone(mask: Raster) {
  let sum = 0, count = 0
  for (let x = 0; x < mask.width; x++) { sum += mask.data[x] + mask.data[(mask.height - 1) * mask.width + x]; count += 2 }
  for (let y = 0; y < mask.height; y++) { sum += mask.data[y * mask.width] + mask.data[y * mask.width + mask.width - 1]; count += 2 }
  return sum / count / 255 >= 0.5 ? 1 : 0
}

// From a layer's pixels to its mask's pixels, for a mask with a placement of its own.
export function layerToMask(mask: Raster, placement: Transform, transform: Transform, width: number, height: number): Mat3 {
  return multiply(invert(pixelToDocument(placement, mask.width, mask.height)), pixelToDocument(transform, width, height))
}

// A mask with a placement of its own, read onto a layer's `width`×`height` grid: bilinear (as the compositor draws it), and past
// its edges as its edge tone. 0–1 per layer pixel.
export function maskOnGrid(mask: Raster, placement: Transform, transform: Transform, width: number, height: number): Float32Array {
  const toMask = layerToMask(mask, placement, transform, width, height), outside = maskEdgeTone(mask)
  const out = new Float32Array(width * height), d = mask.data, w = mask.width
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const [mx, my] = apply(toMask, x + 0.5, y + 0.5)
    if (mx < 0 || my < 0 || mx > mask.width || my > mask.height) { out[y * width + x] = outside; continue }
    const fx = Math.min(mask.width - 1, Math.max(0, mx - 0.5)), fy = Math.min(mask.height - 1, Math.max(0, my - 0.5))
    const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(mask.width - 1, x0 + 1), y1 = Math.min(mask.height - 1, y0 + 1), tx = fx - x0, ty = fy - y0
    out[y * width + x] = ((d[y0 * w + x0] * (1 - tx) + d[y0 * w + x1] * tx) * (1 - ty) + (d[y1 * w + x0] * (1 - tx) + d[y1 * w + x1] * tx) * ty) / 255
  }
  return out
}
