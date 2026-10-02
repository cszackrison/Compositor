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

// Squared Euclidean distance from every pixel to the nearest pixel where `inside` is true (Felzenszwalb–Huttenlocher).
function distanceTo(inside: (i: number) => boolean, width: number, height: number) {
  const big = 1e20, d = new Float64Array(width * height)
  for (let i = 0; i < d.length; i++) d[i] = inside(i) ? 0 : big
  const pass = (f: Float64Array, n: number) => {
    const out = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1)
    let k = 0
    v[0] = 0; z[0] = -big; z[1] = big
    for (let q = 1; q < n; q++) {
      let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k])
      while (s <= z[k]) { k--; s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]) }
      k++; v[k] = q; z[k] = s; z[k + 1] = big
    }
    k = 0
    for (let q = 0; q < n; q++) { while (z[k + 1] < q) k++; out[q] = (q - v[k]) * (q - v[k]) + f[v[k]] }
    return out
  }
  const column = new Float64Array(height)
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) column[y] = d[y * width + x]
    const out = pass(column, height)
    for (let y = 0; y < height; y++) d[y * width + x] = out[y]
  }
  const row = new Float64Array(width)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) row[x] = d[y * width + x]
    d.set(pass(row, width), y * width)
  }
  return d
}

// Select › Modify › Expand: everything within `amount` pixels of the selection, with a round, antialiased edge, kept on the canvas.
export function expandSelection(selection: Raster, amount: number): Raster {
  const { width, height, data } = selection
  const distance = distanceTo(i => data[i] >= 128, width, height)
  const out = new Raster(width, height, 1)
  for (let i = 0; i < out.data.length; i++) out.data[i] = Math.max(data[i], Math.round(255 * Math.min(1, Math.max(0, amount - Math.sqrt(distance[i]) + 0.5))))
  return out
}

// Contract: pulls the edge in by `amount`, away from the canvas edges too, as stroking the outline and cutting it away does.
export function contractSelection(selection: Raster, amount: number): Raster {
  const { width, height, data } = selection
  const padded = new Raster(width + 2, height + 2, 1)
  for (let y = 0; y < height; y++) padded.data.set(data.subarray(y * width, (y + 1) * width), (y + 1) * (width + 2) + 1)
  const distance = distanceTo(i => padded.data[i] < 128, width + 2, height + 2)
  const out = new Raster(width, height, 1)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = y * width + x, d = Math.sqrt(distance[(y + 1) * (width + 2) + x + 1]) - 0.5
    out.data[i] = Math.min(data[i], Math.round(255 * Math.min(1, Math.max(0, d - amount + 0.5))))
  }
  return out
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
