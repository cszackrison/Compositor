import { blurFloats } from '../model/pixels'

// What Remove Background does to the model's mask before it becomes a layer mask (SubjectRemoval.refined and GuidedMatte.swift).
// Basic uses the mask as it comes; Advanced pulls it onto the image's own edges (Refine), moves its edge (Shift Edge) and
// clears its haze (Contrast), in that order.
export type BackgroundSettings = { quality: 'Basic' | 'Advanced'; refine: number; contrast: number; shiftEdge: number }
export const defaultBackground: BackgroundSettings = { quality: 'Basic', refine: 12, contrast: 25, shiftEdge: 0 }

// Bilinear resampling of a one-channel 0–1 image, pixel centers onto pixel centers; shrinking averages each output pixel's
// footprint so detail isn't skipped.
export function resize(source: Float32Array, width: number, height: number, toWidth: number, toHeight: number): Float32Array {
  if (width === toWidth && height === toHeight) return source
  const out = new Float32Array(toWidth * toHeight), sx = width / toWidth, sy = height / toHeight
  if (sx >= 2 || sy >= 2) {
    for (let y = 0; y < toHeight; y++) {
      const ya = Math.floor(y * sy), yb = Math.max(ya + 1, Math.min(height, Math.floor((y + 1) * sy)))
      for (let x = 0; x < toWidth; x++) {
        const xa = Math.floor(x * sx), xb = Math.max(xa + 1, Math.min(width, Math.floor((x + 1) * sx)))
        let sum = 0
        for (let j = ya; j < yb; j++) for (let i = xa; i < xb; i++) sum += source[j * width + i]
        out[y * toWidth + x] = sum / ((yb - ya) * (xb - xa))
      }
    }
    return out
  }
  for (let y = 0; y < toHeight; y++) {
    const fy = Math.min(height - 1, Math.max(0, (y + 0.5) * sy - 0.5)), y0 = Math.floor(fy), y1 = Math.min(height - 1, y0 + 1), ty = fy - y0
    for (let x = 0; x < toWidth; x++) {
      const fx = Math.min(width - 1, Math.max(0, (x + 0.5) * sx - 0.5)), x0 = Math.floor(fx), x1 = Math.min(width - 1, x0 + 1), tx = fx - x0
      out[y * toWidth + x] = (source[y0 * width + x0] * (1 - tx) + source[y0 * width + x1] * tx) * (1 - ty) + (source[y1 * width + x0] * (1 - tx) + source[y1 * width + x1] * tx) * ty
    }
  }
  return out
}

// The image's gray levels, 0–1 (premultiplied RGBA reads as drawn over black, as the Mac's gray guide does).
export function grayLevels(rgba: Uint8Array, width: number, height: number): Float32Array {
  const out = new Float32Array(width * height)
  for (let i = 0; i < out.length; i++) out[i] = (0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2]) / 255
  return out
}

// Mean over a (2r+1)² square, edges held, as two running-sum passes (GuidedMatte.box).
export function box(source: Float32Array, width: number, height: number, radius: number): Float32Array {
  const span = radius * 2 + 1, pass = new Float32Array(width * height), out = new Float32Array(width * height)
  for (let y = 0; y < height; y++) {
    const row = y * width
    let sum = 0
    for (let x = -radius; x <= radius; x++) sum += source[row + Math.min(width - 1, Math.max(0, x))]
    for (let x = 0; x < width; x++) {
      pass[row + x] = sum / span
      sum -= source[row + Math.min(width - 1, Math.max(0, x - radius))]
      sum += source[row + Math.min(width - 1, Math.max(0, x + radius + 1))]
    }
  }
  for (let x = 0; x < width; x++) {
    let sum = 0
    for (let y = -radius; y <= radius; y++) sum += pass[Math.min(height - 1, Math.max(0, y)) * width + x]
    for (let y = 0; y < height; y++) {
      out[y * width + x] = sum / span
      sum -= pass[Math.min(height - 1, Math.max(0, y - radius)) * width + x]
      sum += pass[Math.min(height - 1, Math.max(0, y + radius + 1)) * width + x]
    }
  }
  return out
}

// Guided filtering (He, Sun & Tang): `mask` pulled onto the edges of `guide`, both 0–1 and the same size (GuidedMatte.filter).
export function guided(mask: Float32Array, guide: Float32Array, width: number, height: number, radius: number, epsilon: number): Float32Array {
  const count = width * height
  const meanGuide = box(guide, width, height, radius), meanMask = box(mask, width, height, radius)
  const squares = new Float32Array(count), products = new Float32Array(count)
  for (let i = 0; i < count; i++) { squares[i] = guide[i] * guide[i]; products[i] = guide[i] * mask[i] }
  const meanSquares = box(squares, width, height, radius), meanProducts = box(products, width, height, radius)
  const slope = new Float32Array(count), offset = new Float32Array(count)
  for (let i = 0; i < count; i++) {
    const variance = meanSquares[i] - meanGuide[i] * meanGuide[i], covariance = meanProducts[i] - meanGuide[i] * meanMask[i]
    slope[i] = covariance / (variance + epsilon)
    offset[i] = meanMask[i] - slope[i] * meanGuide[i]
  }
  const meanSlope = box(slope, width, height, radius), meanOffset = box(offset, width, height, radius)
  const out = new Float32Array(count)
  for (let i = 0; i < count; i++) out[i] = Math.min(1, Math.max(0, meanSlope[i] * guide[i] + meanOffset[i]))
  return out
}

// Refine: done on a copy at most `limit` on its longest side (the radius shrinks with it), then drawn back up (GuidedMatte.refine).
export function refine(mask: Float32Array, rgba: Uint8Array, width: number, height: number, radius: number, limit: number): Float32Array {
  const factor = Math.min(1, limit / Math.max(width, height))
  const w = Math.max(1, Math.round(width * factor)), h = Math.max(1, Math.round(height * factor))
  const steps = Math.max(1, Math.round(radius * factor))
  const small = guided(resize(mask, width, height, w, h), resize(grayLevels(rgba, width, height), width, height, w, h), w, h, steps, 1e-4)
  return resize(small, w, h, width, height)
}

// Shift Edge: a blur then a hard threshold at the matching level moves the edge by the blur's reach; negative shrinks.
export function shiftEdge(mask: Float32Array, width: number, height: number, amount: number): Float32Array {
  const reach = Math.abs(amount), level = amount < 0 ? 0.75 : 0.25
  const blurred = blurFloats(Float32Array.from(mask), width, height, 1, reach / 2, true)
  const out = new Float32Array(mask.length)
  for (let i = 0; i < out.length; i++) out[i] = Math.min(1, Math.max(0, (Math.min(level + 0.001, Math.max(level, blurred[i])) - level) * 1000))
  return out
}

// Contrast: 0 leaves the mask as it is; 100 is a hard cut at the middle.
export function contrast(mask: Float32Array, amount: number): Float32Array {
  const slope = 1 / Math.max(0.02, 1 - amount / 100 * 0.98), out = new Float32Array(mask.length)
  for (let i = 0; i < out.length; i++) out[i] = Math.min(1, Math.max(0, mask[i] * slope + (1 - slope) / 2))
  return out
}

export function refined(mask: Float32Array, rgba: Uint8Array, width: number, height: number, s: BackgroundSettings, limit = Infinity): Float32Array {
  if (s.quality !== 'Advanced') return mask
  let out = mask
  if (s.refine > 0) out = refine(out, rgba, width, height, s.refine, limit)
  if (s.shiftEdge !== 0) out = shiftEdge(out, width, height, s.shiftEdge)
  if (s.contrast > 0) out = contrast(out, s.contrast)
  return out
}

export function bytes(mask: Float32Array): Uint8Array {
  const out = new Uint8Array(mask.length)
  for (let i = 0; i < out.length; i++) out[i] = Math.min(255, Math.max(0, Math.floor(mask[i] * 255 + 0.5)))
  return out
}
