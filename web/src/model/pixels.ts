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

// Running-sum box passes over `channels`-interleaved floats. `clamp` repeats the edge, otherwise past the edge is transparent zero.
// Along rows the edges are worked apart, so the middle needs no checks; down the columns every column's sum is kept in `sums` and the
// image is read a row at a time, in order. Each step adds `incoming - outgoing` as one, so the sums round as they always have.
function rowPass(source: Float32Array, out: Float32Array, width: number, height: number, channels: number, radius: number, clamp: boolean) {
  const scale = 1 / (radius * 2 + 1), lo = Math.min(radius, width), hi = Math.max(lo, width - radius - 1)
  if (channels === 4) return rowPass4(source, out, width, height, radius, clamp, scale, lo, hi, (radius + 1) * 4, radius * 4)
  if (channels === 1) for (let y = 0; y < height; y += 2) lanes(source, out, y * width, Math.min(y + 1, height - 1) * width, 1, width, radius, clamp, scale, lo, hi)
  else for (let base = 0; base < height * width * channels; base += width * channels) for (let c = 0; c < channels; c += 2) lanes(source, out, base + c, base + Math.min(c + 1, channels - 1), channels, width, radius, clamp, scale, lo, hi)
}

// Two of rowPass's sums run side by side, one along `p`, one along `q`, each `step` apart: two rows of one channel, or two channels of
// a row. A lane on its own runs as both.
function lanes(source: Float32Array, out: Float32Array, p: number, q: number, step: number, width: number, radius: number, clamp: boolean, scale: number, lo: number, hi: number) {
  const reach = (radius + 1) * step, back = radius * step, d = q - p, last = (width - 1) * step
  const fp = clamp ? source[p] : 0, ep = clamp ? source[p + last] : 0, fq = clamp ? source[q] : 0, eq = clamp ? source[q + last] : 0
  let sp = 0, sq = 0, i = 0, o = p
  for (let k = -radius; k <= radius; k++) { sp += k < 0 ? fp : k >= width ? ep : source[p + k * step]; sq += k < 0 ? fq : k >= width ? eq : source[q + k * step] }
  for (; i < lo; i++, o += step) { const inside = i + radius + 1 < width; out[o] = sp * scale; out[o + d] = sq * scale; sp += (inside ? source[o + reach] : ep) - fp; sq += (inside ? source[o + d + reach] : eq) - fq }
  for (; i < hi; i++, o += step) { const r = o + d; out[o] = sp * scale; out[r] = sq * scale; sp += source[o + reach] - source[o - back]; sq += source[r + reach] - source[r - back] }
  for (; i < width; i++, o += step) { const inside = i >= radius; out[o] = sp * scale; out[o + d] = sq * scale; sp += ep - (inside ? source[o - back] : fp); sq += eq - (inside ? source[o + d - back] : fq) }
}

// rowPass for RGBA, the four sums side by side in one sweep.
function rowPass4(source: Float32Array, out: Float32Array, width: number, height: number, radius: number, clamp: boolean, scale: number, lo: number, hi: number, reach: number, back: number) {
  for (let base = 0; base < height * width * 4; base += width * 4) {
    const e = base + width * 4 - 4, f0 = clamp ? source[base] : 0, f1 = clamp ? source[base + 1] : 0, f2 = clamp ? source[base + 2] : 0, f3 = clamp ? source[base + 3] : 0
    const e0 = clamp ? source[e] : 0, e1 = clamp ? source[e + 1] : 0, e2 = clamp ? source[e + 2] : 0, e3 = clamp ? source[e + 3] : 0
    let s0 = 0, s1 = 0, s2 = 0, s3 = 0, i = 0, o = base
    for (let k = -radius; k <= radius; k++) {
      if (k < 0) { s0 += f0; s1 += f1; s2 += f2; s3 += f3 } else if (k >= width) { s0 += e0; s1 += e1; s2 += e2; s3 += e3 } else { const j = base + k * 4; s0 += source[j]; s1 += source[j + 1]; s2 += source[j + 2]; s3 += source[j + 3] }
    }
    for (; i < lo; i++, o += 4) {
      out[o] = s0 * scale; out[o + 1] = s1 * scale; out[o + 2] = s2 * scale; out[o + 3] = s3 * scale
      if (i + radius + 1 < width) { const a = o + reach; s0 += source[a] - f0; s1 += source[a + 1] - f1; s2 += source[a + 2] - f2; s3 += source[a + 3] - f3 } else { s0 += e0 - f0; s1 += e1 - f1; s2 += e2 - f2; s3 += e3 - f3 }
    }
    for (; i < hi; i++, o += 4) {
      const a = o + reach, b = o - back
      out[o] = s0 * scale; out[o + 1] = s1 * scale; out[o + 2] = s2 * scale; out[o + 3] = s3 * scale
      s0 += source[a] - source[b]; s1 += source[a + 1] - source[b + 1]; s2 += source[a + 2] - source[b + 2]; s3 += source[a + 3] - source[b + 3]
    }
    for (; i < width; i++, o += 4) {
      out[o] = s0 * scale; out[o + 1] = s1 * scale; out[o + 2] = s2 * scale; out[o + 3] = s3 * scale
      if (i >= radius) { const b = o - back; s0 += e0 - source[b]; s1 += e1 - source[b + 1]; s2 += e2 - source[b + 2]; s3 += e3 - source[b + 3] } else { s0 += e0 - f0; s1 += e1 - f1; s2 += e2 - f2; s3 += e3 - f3 }
    }
  }
}

function columnPass(source: Float32Array, out: Float32Array, width: number, height: number, channels: number, radius: number, clamp: boolean, sums: Float64Array) {
  const scale = 1 / (radius * 2 + 1), n = width * channels, last = (height - 1) * n
  const row = (k: number) => k < 0 ? (clamp ? 0 : -1) : k >= height ? (clamp ? last : -1) : k * n
  sums.fill(0)
  for (let k = -radius; k <= radius; k++) { const r = row(k); if (r >= 0) for (let x = 0; x < n; x++) sums[x] += source[r + x] }
  for (let y = 0, o = 0; y < height; y++, o += n) {
    const add = row(y + radius + 1), sub = row(y - radius)
    if (add >= 0 && sub >= 0) for (let x = 0; x < n; x++) { const v = sums[x]; out[o + x] = v * scale; sums[x] = v + (source[add + x] - source[sub + x]) }
    else if (add >= 0) for (let x = 0; x < n; x++) { const v = sums[x]; out[o + x] = v * scale; sums[x] = v + source[add + x] }
    else if (sub >= 0) for (let x = 0; x < n; x++) { const v = sums[x]; out[o + x] = v * scale; sums[x] = v - source[sub + x] }
    else for (let x = 0; x < n; x++) out[o + x] = sums[x] * scale
  }
}

// `data` is left as it is, unless `overwrite`, for a copy the caller has no more use for, which the blur then works in and returns.
export function blurFloats(data: Float32Array, width: number, height: number, channels: number, sigma: number, clamp = false, overwrite = false) {
  if (sigma < 0.3) return data
  // A one-pixel box leaves the image as it is, so it's skipped.
  const radii = boxes(sigma).map(size => (size - 1) / 2).filter(radius => radius > 0)
  if (!radii.length) return overwrite ? data : data.slice()
  const a = overwrite ? data : new Float32Array(data.length), b = new Float32Array(data.length), sums = new Float64Array(width * channels)
  let from = data
  for (const radius of radii) {
    rowPass(from, b, width, height, channels, radius, clamp)
    columnPass(b, a, width, height, channels, radius, clamp, sums)
    from = a
  }
  return a
}

// A Gaussian blur of premultiplied pixels; `clamp` extends the edge pixels, otherwise outside is transparent.
export function blurRaster(raster: Raster, sigma: number, clamp = false): Raster {
  const blurred = blurFloats(new Float32Array(raster.data), raster.width, raster.height, raster.channels, sigma, clamp, true)
  const out = new Raster(raster.width, raster.height, raster.channels), data = out.data
  // A float's half added and the fraction dropped by the store rounds it as Math.round does (a blur never dips to −½), and quicker.
  for (let i = 0; i < data.length; i++) data[i] = blurred[i] + 0.5
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
    const entry = { data: blurFloats(region, w, h, channels, sigma, clamp, true), x0, y0, w }
    tiles.set(ty * across + tx, entry)
    return entry
  }
  // Fills `out` with the blurred pixel at (x, y), rounded like blurRaster. Strokes read neighbors, so the last tile is kept at hand.
  let last = -1, current: { data: Float32Array; x0: number; y0: number; w: number } | undefined
  const sample = (x: number, y: number, out: ArrayLike<number> & { [i: number]: number }) => {
    const tx = (x / tile) | 0, ty = (y / tile) | 0, key = ty * across + tx
    if (key !== last) { current = tiles.get(key) ?? blurTile(tx, ty); last = key }
    const t = current!, i = ((y - t.y0) * t.w + x - t.x0) * channels
    for (let c = 0; c < channels; c++) out[c] = Math.round(t.data[i + c])
  }
  // Hands each tile over the rectangle [x0, x1) × [y0, y1) to `use` once, rounded, for the GPU's copy of the blur.
  const handed = new Set<number>()
  const handOver = (x0: number, y0: number, x1: number, y1: number, use: (x: number, y: number, w: number, h: number, bytes: Uint8Array) => void) => {
    for (let ty = Math.max(0, (y0 / tile) | 0); ty * tile < Math.min(height, y1); ty++) for (let tx = Math.max(0, (x0 / tile) | 0); tx * tile < Math.min(width, x1); tx++) {
      const key = ty * across + tx
      if (handed.has(key)) continue
      handed.add(key)
      const t = tiles.get(key) ?? blurTile(tx, ty), cx = tx * tile, cy = ty * tile, w = Math.min(width, cx + tile) - cx, h = Math.min(height, cy + tile) - cy
      const bytes = new Uint8Array(w * h * channels)
      for (let y = 0; y < h; y++) for (let i = 0; i < w * channels; i++) bytes[y * w * channels + i] = Math.round(t.data[((y + cy - t.y0) * t.w + cx - t.x0) * channels + i])
      use(cx, cy, w, h, bytes)
    }
  }
  return Object.assign(sample, { tiles: handOver })
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
