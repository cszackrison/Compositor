import { Raster } from './raster'
import { call, withBuffers, floats } from '../kernels'

// Box sizes whose three passes approximate a Gaussian of `sigma` (Kovesi).
function boxes(sigma: number, n = 3) {
  const ideal = Math.sqrt(12 * sigma * sigma / n + 1)
  let lower = Math.floor(ideal); if (lower % 2 === 0) lower--
  const upper = lower + 2
  const m = Math.round((12 * sigma * sigma - n * lower * lower - 4 * n * lower - 3 * n) / (-4 * lower - 4))
  return Array.from({ length: n }, (_, i) => i < m ? lower : upper)
}

// One running-sum box pass over `channels`-interleaved floats, along rows (horizontal) or columns. `clamp` repeats the edge,
// otherwise past the edge is transparent zero. Straight indexing, no per-sample calls: this runs for every pixel of every blur.
function boxPass(source: Float32Array, out: Float32Array, width: number, height: number, channels: number, radius: number, horizontal: boolean, clamp: boolean) {
  const length = horizontal ? width : height, lines = horizontal ? height : width
  const step = (horizontal ? 1 : width) * channels, lineStep = (horizontal ? width : 1) * channels
  const scale = 1 / (radius * 2 + 1), last = (length - 1) * step
  for (let line = 0; line < lines; line++) {
    const base = line * lineStep
    for (let c = 0; c < channels; c++) {
      const first = source[base + c], end = source[base + last + c]
      let sum = 0
      for (let i = -radius; i <= radius; i++) sum += i < 0 ? (clamp ? first : 0) : i >= length ? (clamp ? end : 0) : source[base + i * step + c]
      let o = base + c, add = base + (radius + 1) * step + c, sub = base - radius * step + c
      for (let i = 0; i < length; i++, o += step, add += step, sub += step) {
        out[o] = sum * scale
        const incoming = i + radius + 1 < length ? source[add] : clamp ? end : 0
        const outgoing = i - radius >= 0 ? source[sub] : clamp ? first : 0
        sum += incoming - outgoing
      }
    }
  }
}

export function blurFloats(data: Float32Array, width: number, height: number, channels: number, sigma: number, clamp = false) {
  if (sigma < 0.3) return data
  let a = data.slice(), b = new Float32Array(data.length)
  for (const size of boxes(sigma)) {
    const radius = (size - 1) / 2
    boxPass(a, b, width, height, channels, radius, true, clamp)
    boxPass(b, a, width, height, channels, radius, false, clamp)
  }
  return a
}

// A Gaussian blur of premultiplied pixels; `clamp` extends the edge pixels, otherwise outside is transparent.
export function blurRaster(raster: Raster, sigma: number, clamp = false): Raster {
  const floatsIn = Float32Array.from(raster.data)
  const blurred = blurFloats(floatsIn, raster.width, raster.height, raster.channels, sigma, clamp)
  const out = new Raster(raster.width, raster.height, raster.channels)
  for (let i = 0; i < out.data.length; i++) out.data[i] = Math.round(blurred[i])
  return out
}

// A Gaussian blur worked out a tile at a time, the first time something reads it. Each tile blurs with a margin as wide as the
// three box passes reach, so it matches blurRaster exactly; a stroke only pays for the area it touches.
export function lazyBlur(raster: Raster, sigma: number, clamp = false) {
  const { width, height, channels } = raster
  const reach = sigma < 0.3 ? 0 : boxes(sigma).reduce((sum, size) => sum + (size - 1) / 2, 0)
  const tile = Math.max(128, Math.min(512, reach * 2)), across = Math.ceil(width / tile)
  const tiles = new Map<number, { data: Float32Array; x0: number; y0: number; w: number }>()
  function blurTile(tx: number, ty: number) {
    const x0 = Math.max(0, tx * tile - reach), y0 = Math.max(0, ty * tile - reach)
    const x1 = Math.min(width, (tx + 1) * tile + reach), y1 = Math.min(height, (ty + 1) * tile + reach), w = x1 - x0, h = y1 - y0
    const region = new Float32Array(w * h * channels)
    for (let y = 0; y < h; y++) { const from = ((y + y0) * width + x0) * channels; for (let i = 0; i < w * channels; i++) region[y * w * channels + i] = raster.data[from + i] }
    // Region edges inside the image sit a full reach from the tile, so how they're treated never reaches it.
    const entry = { data: blurFloats(region, w, h, channels, sigma, clamp), x0, y0, w }
    tiles.set(ty * across + tx, entry)
    return entry
  }
  // Fills `out` with the blurred pixel at (x, y), rounded like blurRaster. Strokes read neighbors, so the last tile is kept at hand.
  let last = -1, current: { data: Float32Array; x0: number; y0: number; w: number } | undefined
  return (x: number, y: number, out: ArrayLike<number> & { [i: number]: number }) => {
    const tx = (x / tile) | 0, ty = (y / tile) | 0, key = ty * across + tx
    if (key !== last) { current = tiles.get(key) ?? blurTile(tx, ty); last = key }
    const t = current!, i = ((y - t.y0) * t.w + x - t.x0) * channels
    for (let c = 0; c < channels; c++) out[c] = Math.round(t.data[i + c])
  }
}

// Runs a C kernel that works in place on premultiplied RGBA (`rgba, width, height, stride, ...rest`).
export function kernelInPlace(raster: Raster, name: string, ...rest: (number | { data: ArrayBufferView })[]) {
  const buffers = [{ data: raster.data, out: true }, ...rest.filter((r): r is { data: ArrayBufferView } => typeof r === 'object')]
  withBuffers(buffers, (pointers) => {
    let next = 1
    const args = rest.map(r => typeof r === 'object' ? pointers[next++] : r)
    call(name, pointers[0], raster.width, raster.height, raster.width * 4, ...args)
  })
  return raster
}

export { floats }
