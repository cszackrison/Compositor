import { Raster } from './raster'
import { call, heap, withBuffers } from '../kernels'

export type SelectionMode = 'replace' | 'add' | 'subtract' | 'intersect'
export type Shape = { kind: 'rect' | 'ellipse'; x: number; y: number; w: number; h: number } | { kind: 'polygon'; points: [number, number][] }

// A selection is document-sized coverage (255 selected), so any tool can make one and any edit can clip by it.
export function shapeCoverage(width: number, height: number, shape: Shape, antialias = true): Raster {
  const canvas = new OffscreenCanvas(width, height)
  const context = canvas.getContext('2d', { willReadFrequently: true })!
  context.imageSmoothingEnabled = antialias
  context.fillStyle = '#fff'
  context.beginPath()
  if (shape.kind === 'rect') context.rect(shape.x, shape.y, shape.w, shape.h)
  else if (shape.kind === 'ellipse') context.ellipse(shape.x + shape.w / 2, shape.y + shape.h / 2, Math.abs(shape.w / 2), Math.abs(shape.h / 2), 0, 0, Math.PI * 2)
  else if (shape.kind === 'polygon') shape.points.forEach(([x, y], index) => index ? context.lineTo(x, y) : context.moveTo(x, y))
  context.fill()
  const rgba = context.getImageData(0, 0, width, height).data
  const out = new Raster(width, height, 1)
  for (let i = 0; i < out.data.length; i++) out.data[i] = rgba[i * 4 + 3]
  return out
}

export function combine(current: Raster | null, next: Raster, mode: SelectionMode): Raster {
  if (!current || mode === 'replace') return next
  const out = new Raster(next.width, next.height, 1), a = current.data, b = next.data, o = out.data
  for (let i = 0; i < o.length; i++) {
    o[i] = mode === 'add' ? Math.max(a[i], b[i]) : mode === 'subtract' ? Math.max(0, a[i] - b[i]) : Math.round(a[i] * b[i] / 255)
  }
  return out
}

export function invertSelection(selection: Raster) {
  const out = new Raster(selection.width, selection.height, 1)
  for (let i = 0; i < out.data.length; i++) out.data[i] = 255 - selection.data[i]
  return out
}

export function isEmpty(selection: Raster) { return !selection.data.some(v => v > 0) }

export function bounds(coverage: Raster): { x: number; y: number; w: number; h: number } | null {
  const { width, height, data } = coverage
  let minX = width, minY = height, maxX = -1, maxY = -1
  for (let y = 0; y < height; y++) {
    const row = y * width
    for (let x = 0; x < width; x++) if (data[row + x]) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; maxY = y }
  }
  return maxX < 0 ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 }
}

// Magic Wand over premultiplied RGBA in document pixels, through the app's own C matcher.
export function wand(rgba: Raster, x: number, y: number, tolerance: number, contiguous: boolean, sampleRadius = 0): Raster {
  const out = new Raster(rgba.width, rgba.height, 1)
  if (x < 0 || y < 0 || x >= rgba.width || y >= rgba.height) return out
  withBuffers([{ data: rgba.data }, { data: out.data, out: true }], ([pixels, mask]) => {
    call('wand_mask', pixels, rgba.width, rgba.height, rgba.width * 4, x, y, sampleRadius, tolerance, contiguous ? 1 : 0, mask)
  })
  return out
}

// The marching-ants outline: pixel-edge loops around coverage at or above half, from the C tracer.
export function outline(coverage: Raster): Int32Array[] | null {
  const binary = new Uint8Array(coverage.data.length)
  for (let i = 0; i < binary.length; i++) binary[i] = coverage.data[i] >= 128 ? 255 : 0
  return withBuffers([{ data: binary }, { data: new Uint32Array(4) }], ([mask, outputs], k) => {
    const status = call('wand_trace', mask, coverage.width, coverage.height, outputs, outputs + 4, outputs + 8, outputs + 12)
    if (status !== 0) return null
    const view = new Uint32Array(heap().buffer, outputs, 4)
    const [pointsPointer, pointCount, loopsPointer, loopCount] = [view[0], view[1], view[2], view[3]]
    const points = new Int32Array(heap().buffer, pointsPointer, pointCount * 2).slice()
    const loops = new Int32Array(heap().buffer, loopsPointer, loopCount).slice()
    k.wasm_free(pointsPointer); k.wasm_free(loopsPointer)
    const result: Int32Array[] = []
    let offset = 0
    for (const count of loops) { result.push(points.subarray(offset * 2, (offset + count) * 2)); offset += count }
    return result
  })
}

// Separable sliding-window max (expand) or min (contract) of radius `reach`: O(W×H) regardless of reach, keeping square corners
// sharp so repeated Expand and Contract keep a rectangle a rectangle and never round or lose a corner (Selection.resizeSelection).
function resizeMask(data: Uint8Array, width: number, height: number, reach: number, dilate: boolean): Uint8Array {
  const r = Math.max(0, Math.round(reach))
  if (r === 0) return data.slice()
  let minX = width, minY = height, maxX = -1, maxY = -1
  for (let y = 0; y < height; y++) {
    const row = y * width
    for (let x = 0; x < width; x++) if (data[row + x]) {
      if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; maxY = y
    }
  }
  const out = new Uint8Array(data.length)
  if (maxX < 0) return out
  const x0 = dilate ? Math.max(0, minX - r) : Math.max(r, minX), x1 = dilate ? Math.min(width - 1, maxX + r) : Math.min(width - 1 - r, maxX)
  const y0 = dilate ? Math.max(0, minY - r) : Math.max(r, minY), y1 = dilate ? Math.min(height - 1, maxY + r) : Math.min(height - 1 - r, maxY)
  if (x0 > x1 || y0 > y1) return out

  const temp = new Uint8Array(data.length), queue = new Int32Array(Math.max(width, height))
  if (dilate) {
    // Horizontal max over rows that contain any non-zero pixel.
    for (let y = minY; y <= maxY; y++) {
      const base = y * width
      let head = 0, tail = 0, next = Math.max(0, x0 - r)
      for (let x = x0; x <= x1; x++) {
        const hi = Math.min(width - 1, x + r)
        while (next <= hi) {
          const v = data[base + next]
          while (tail > head && data[base + queue[tail - 1]] <= v) tail--
          queue[tail++] = next++
        }
        while (head < tail && queue[head] < x - r) head++
        temp[base + x] = data[base + queue[head]]
      }
    }
    // Vertical max over columns that can become non-zero.
    for (let x = x0; x <= x1; x++) {
      let head = 0, tail = 0, next = Math.max(0, y0 - r)
      for (let y = y0; y <= y1; y++) {
        const hi = Math.min(height - 1, y + r)
        while (next <= hi) {
          const v = temp[next * width + x]
          while (tail > head && temp[queue[tail - 1] * width + x] <= v) tail--
          queue[tail++] = next++
        }
        while (head < tail && queue[head] < y - r) head++
        out[y * width + x] = temp[queue[head] * width + x]
      }
    }
  } else {
    // Horizontal min (pixels within `r` of left/right canvas edges are 0, so only x in [x0, x1] can survive).
    for (let y = minY; y <= maxY; y++) {
      const base = y * width
      let head = 0, tail = 0, next = x0 - r
      for (let x = x0; x <= x1; x++) {
        const hi = x + r
        while (next <= hi) {
          const v = data[base + next]
          while (tail > head && data[base + queue[tail - 1]] >= v) tail--
          queue[tail++] = next++
        }
        while (head < tail && queue[head] < x - r) head++
        temp[base + x] = data[base + queue[head]]
      }
    }
    // Vertical min (only y in [y0, y1] can survive).
    for (let x = x0; x <= x1; x++) {
      let head = 0, tail = 0, next = y0 - r
      for (let y = y0; y <= y1; y++) {
        const hi = y + r
        while (next <= hi) {
          const v = temp[next * width + x]
          while (tail > head && temp[queue[tail - 1] * width + x] >= v) tail--
          queue[tail++] = next++
        }
        while (head < tail && queue[head] < y - r) head++
        out[y * width + x] = temp[queue[head] * width + x]
      }
    }
  }
  return out
}

// Select › Modify › Expand: grows the selection by `amount` pixels, keeping its corners sharp, clipped to the canvas.
export function expandSelection(selection: Raster, amount: number): Raster {
  return new Raster(selection.width, selection.height, 1, resizeMask(selection.data, selection.width, selection.height, amount, true))
}

// Contract: pulls the edge in by `amount` pixels, including away from the canvas edges, keeping corners sharp.
export function contractSelection(selection: Raster, amount: number): Raster {
  return new Raster(selection.width, selection.height, 1, resizeMask(selection.data, selection.width, selection.height, amount, false))
}

// Feather: a Gaussian of σ = amount/2 over the coverage, clamped at the canvas edge (successive feathers add in quadrature).
export function featherSelection(selection: Raster, amount: number, blur: (r: Raster, sigma: number) => Raster): Raster {
  return blur(selection, amount / 2)
}

export function offsetSelection(selection: Raster, dx: number, dy: number): Raster {
  const { width, height, data } = selection
  const out = new Raster(width, height, 1)
  for (let y = 0; y < height; y++) {
    const sy = y - dy
    if (sy < 0 || sy >= height) continue
    for (let x = 0; x < width; x++) { const sx = x - dx; if (sx >= 0 && sx < width) out.data[y * width + x] = data[sy * width + sx] }
  }
  return out
}

// Document coverage from a layer's pixels (alpha ≥ 50%) or, for a mask, its hidden areas (gray < 50%), through `pixelToDocument`.
export function coverageFromRaster(raster: Raster, toDocument: number[], width: number, height: number, mask: boolean): Raster {
  const [a, b, , c, d, , tx, ty] = toDocument
  const det = a * d - b * c, ia = d / det, ib = -b / det, ic = -c / det, id = a / det
  const out = new Raster(width, height, 1)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const px = x + 0.5 - tx, py = y + 0.5 - ty
    const sx = Math.floor(ia * px + ic * py), sy = Math.floor(ib * px + id * py)
    if (sx < 0 || sy < 0 || sx >= raster.width || sy >= raster.height) continue
    const v = mask ? raster.data[sy * raster.width + sx] : raster.data[(sy * raster.width + sx) * 4 + 3]
    out.data[y * width + x] = mask ? (v < 128 ? 255 : 0) : (v >= 128 ? 255 : 0)
  }
  return out
}
