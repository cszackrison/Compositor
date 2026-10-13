import type { Raster } from '../model/raster'
import type { PixelPatch } from '../model/history'
import { type Mat3, apply, invert } from '../render/gl'
import type { GPUBrush, GPUSource } from '../render/gpuBrush'

export type BrushSettings = { diameter: number; hardness: number; opacity: number; smoothing: number; erasing: boolean }
// Where a stroke's color comes from: the brush color, or another image sampled at each pixel of the raster's grid (Clone Stamp,
// Blur). `wash` shows the original under a dark wash while Spot Healing gathers its coverage.
// A source the GPU can sample itself carries `gpu`.
export type StrokeMode = { kind: 'paint' } | { kind: 'source'; sample: (x: number, y: number, out: Float32Array) => void; gpu?: GPUSource } | { kind: 'wash' }

type Rect = { x0: number; y0: number; x1: number; y1: number }

// A layer-sized buffer kept only where a stroke reaches, in 64-pixel tiles, so a stroke on a large layer doesn't hold the whole
// layer's worth twice over.
class Tiles<A extends Float32Array | Uint8Array> {
  readonly columns: number
  readonly tiles: (A | undefined)[]
  constructor(width: number, height: number, readonly channels: number, private make: (length: number) => A) {
    this.columns = Math.ceil(width / 64)
    this.tiles = new Array(this.columns * Math.ceil(height / 64))
  }
  get(x: number, y: number) { return this.tiles[(y >> 6) * this.columns + (x >> 6)] }
  at(x: number, y: number) { return this.tiles[(y >> 6) * this.columns + (x >> 6)] ??= this.make(4096 * this.channels) }
}
// A pixel's place within its tile.
const inTile = (x: number, y: number) => ((y & 63) << 6) + (x & 63)

// Soft-brush falloff across the region between the hardness radius and the rim: a normalized Gaussian that reaches zero at the rim.
export function falloff(u: number) {
  const k = 2.5
  return Math.max(0, (Math.exp(-k * u * u) - Math.exp(-k)) / (1 - Math.exp(-k)))
}
// The same, tabulated finely and read with linear interpolation (within about a millionth), for the inner loop of every dab.
const falloffSteps = 16384, falloffTable = Float64Array.from({ length: falloffSteps + 2 }, (_, i) => falloff(Math.min(1, i / falloffSteps)))

// One brush stroke on a layer's pixels or mask. Dabs build coverage (lighten for a hard tip, screen for a soft one), and the
// stroke's color is laid over the untouched original at coverage × opacity, so overlapping dabs never pass the stroke's opacity.
export class BrushStroke {
  private coverage: Tiles<Float32Array>
  // The raster as the stroke found it, kept a tile at a time just before the stroke first writes there.
  private original: Tiles<Uint8Array>
  private dirty: Rect | null = null
  private touched: Rect | null = null
  private toPixel: Mat3
  private pixelScale: number
  private last: [number, number] | null = null
  private trail: [number, number] | null = null
  private carry = 0
  // A pen's pressure (0–1) for the dabs being laid now; it scales the tip, and stays 1 without a pen or with pressure off.
  pressure = 1
  // The coverage and the pixels live on the GPU when it can take the stroke (see gpuBrush.ts).
  private brush: GPUBrush | null = null
  get gpu() { return this.brush }
  set gpu(gpu: GPUBrush | null) { this.brush = gpu; if (gpu) gpu.beforeRead = rect => this.keep(rect) }

  constructor(readonly raster: Raster, readonly pixelToDocument: Mat3, readonly settings: BrushSettings, readonly color: [number, number, number], readonly selection: Raster | null, readonly mode: StrokeMode = { kind: 'paint' }) {
    this.coverage = new Tiles(raster.width, raster.height, 1, n => new Float32Array(n))
    this.original = new Tiles(raster.width, raster.height, raster.channels, n => new Uint8Array(n))
    this.toPixel = invert(pixelToDocument)
    const [ox, oy] = apply(this.toPixel, 0, 0), [ux, uy] = apply(this.toPixel, 1, 0), [vx, vy] = apply(this.toPixel, 0, 1)
    this.pixelScale = Math.sqrt(Math.abs((ux - ox) * (vy - oy) - (uy - oy) * (vx - ox)))
  }

  get lastPoint() { return this.last }

  // Pointer samples are joined by a centripetal Catmull-Rom curve (knots spaced by the square root of the distance). Each piece is
  // settled once the sample after it is known; meanwhile a provisional straight tail runs to the newest sample, so the stroke never
  // lags the pointer, and is taken back (coverage and dab spacing both) before the real curve is drawn (BrushStroke.append).
  private samples: [number, number][] = []
  private tail: { last: [number, number] | null; carry: number; rect: Rect; data: Float32Array } | null = null
  // The smoothing string's length in document pixels (the Brush's Smoothing is in screen points, so the caller divides by zoom).
  stringLength = 0

  private curveSegment(before: [number, number], a: [number, number], b: [number, number], after: [number, number]) {
    const knot = (t: number, p: [number, number], q: [number, number]) => t + Math.max(0.0001, Math.sqrt(Math.hypot(q[0] - p[0], q[1] - p[1])))
    const t0 = 0, t1 = knot(t0, before, a), t2 = knot(t1, a, b), t3 = knot(t2, b, after)
    const mix = (p: [number, number], q: [number, number], tp: number, tq: number, t: number): [number, number] => {
      const w = tq - tp < 1e-9 ? 0 : (t - tp) / (tq - tp)
      return [p[0] + (q[0] - p[0]) * w, p[1] + (q[1] - p[1]) * w]
    }
    const steps = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 2))
    for (let i = 1; i <= steps; i++) {
      if (i === steps) { this.lineTo(b[0], b[1]); break }
      const t = t1 + (t2 - t1) * i / steps
      const a1 = mix(before, a, t0, t1, t), a2 = mix(a, b, t1, t2, t), a3 = mix(b, after, t2, t3, t)
      const p = mix(mix(a1, a2, t0, t2, t), mix(a2, a3, t1, t3, t), t1, t2, t)
      this.lineTo(p[0], p[1])
    }
  }

  // The provisional tail: straight lines from the last settled sample through `points` (the newest sample, and where the pointer
  // is predicted to be next), with the coverage under them saved so it can be taken back.
  private drawTail(from: [number, number], ...points: [number, number][]) {
    const { width, height } = this.raster
    const r = this.settings.diameter / 2 * this.pixelScale + 2
    const pixels = [from, ...points].map(p => apply(this.toPixel, ...p))
    const xs = pixels.map(p => p[0]), ys = pixels.map(p => p[1])
    const rect = { x0: Math.max(0, Math.floor(Math.min(...xs) - r)), y0: Math.max(0, Math.floor(Math.min(...ys) - r)), x1: Math.min(width, Math.ceil(Math.max(...xs) + r)), y1: Math.min(height, Math.ceil(Math.max(...ys) + r)) }
    const data = this.gpu ? new Float32Array(0) : this.readCoverage(rect)
    if (this.gpu) this.gpu.saveTail(rect)
    this.tail = { last: this.last, carry: this.carry, rect, data }
    for (const p of points) this.lineTo(p[0], p[1])
    this.last = this.tail.last
    this.carry = this.tail.carry
  }

  // Runs the provisional tail on to where the pointer is predicted to be, so the stroke keeps up with a fast finger or pen. The
  // next sample takes it back like any tail, so the finished stroke never includes it. Not with smoothing, which trails on purpose.
  predict(ahead: [number, number]) {
    const s = this.samples, n = s.length
    if (!this.tail || this.stringLength > 0 || n < 2 || !Number.isFinite(ahead[0]) || !Number.isFinite(ahead[1])) return
    this.removeTail()
    this.drawTail(s[n - 2], s[n - 1], ahead)
  }

  private removeTail() {
    const tail = this.tail
    if (!tail) return
    this.tail = null
    const { rect, data } = tail
    if (this.gpu) this.gpu.restoreTail(rect)
    else this.writeCoverage(rect, data)
    if (rect.x1 > rect.x0 && rect.y1 > rect.y0) this.include(rect)
  }

  // The coverage over `rect`, a row of its width at a time, and back.
  private readCoverage(rect: Rect) {
    const w = Math.max(0, rect.x1 - rect.x0), h = Math.max(0, rect.y1 - rect.y0), out = new Float32Array(w * h)
    for (let y = rect.y0; y < rect.y1; y++) for (let x = rect.x0; x < rect.x1; x++) { const t = this.coverage.get(x, y); if (t) out[(y - rect.y0) * w + x - rect.x0] = t[inTile(x, y)] }
    return out
  }
  private writeCoverage(rect: Rect, values: Float32Array) {
    const w = rect.x1 - rect.x0
    for (let y = rect.y0; y < rect.y1; y++) for (let x = rect.x0; x < rect.x1; x++) {
      const v = values[(y - rect.y0) * w + x - rect.x0], t = v ? this.coverage.at(x, y) : this.coverage.get(x, y)
      if (t) t[inTile(x, y)] = v
    }
  }
  private coverageAt(x: number, y: number) { const t = this.coverage.get(x, y); return t ? t[inTile(x, y)] : 0 }

  // Keeps the raster's pixels in `rect` as they are now, where they haven't been kept already: called before the stroke writes them.
  private keep(rect: Rect) {
    const { width, height, channels, data } = this.raster
    const x0 = Math.max(0, rect.x0), y0 = Math.max(0, rect.y0), x1 = Math.min(width, rect.x1), y1 = Math.min(height, rect.y1)
    if (x1 <= x0 || y1 <= y0) return
    for (let ty = y0 >> 6; ty <= (y1 - 1) >> 6; ty++) for (let tx = x0 >> 6; tx <= (x1 - 1) >> 6; tx++) {
      if (this.original.get(tx << 6, ty << 6)) continue
      const tile = this.original.at(tx << 6, ty << 6), w = Math.min(64, width - (tx << 6))
      for (let y = 0; y < 64 && (ty << 6) + y < height; y++) {
        const from = (((ty << 6) + y) * width + (tx << 6)) * channels
        tile.set(data.subarray(from, from + w * channels), y * 64 * channels)
      }
    }
  }
  // The raster as the stroke found it over `rect`, `channels` bytes a pixel, a row of its width at a time.
  originalPixels(rect: { x: number; y: number; w: number; h: number }) {
    const { width, channels, data } = this.raster, out = new Uint8Array(rect.w * rect.h * channels)
    for (let y = rect.y; y < rect.y + rect.h; y++) for (let x = rect.x; x < rect.x + rect.w; x++) {
      const t = this.original.get(x, y), o = (((y - rect.y) * rect.w) + x - rect.x) * channels, i = t ? inTile(x, y) * channels : (y * width + x) * channels, from = t ?? data
      for (let c = 0; c < channels; c++) out[o + c] = from[i + c]
    }
    return out
  }

  private curveTo(point: [number, number]) {
    this.removeTail()
    const s = this.samples
    const previous = s.at(-1)
    if (previous && previous[0] === point[0] && previous[1] === point[1]) return
    s.push(point)
    if (s.length > 4) s.shift()
    const n = s.length
    if (n >= 3) this.curveSegment(s[Math.max(0, n - 4)], s[n - 3], s[n - 2], s[n - 1])
    if (n >= 2) this.drawTail(s[n - 2], point)
  }

  // Ends the stroke's path: the provisional tail goes, the last piece settles at the final sample (repeated as its own
  // successor), and with smoothing the stroke is carried on to where the pointer actually stopped.
  settle(pointer?: [number, number]) {
    if (pointer && this.trail && (pointer[0] !== this.trail[0] || pointer[1] !== this.trail[1])) this.curveTo(pointer)
    this.removeTail()
    const s = this.samples, n = s.length
    if (n >= 2) this.curveSegment(s[Math.max(0, n - 3)], s[n - 2], s[n - 1], s[n - 1])
    this.samples = s.slice(-1)
  }

  // Moves the stroke toward a document point. With smoothing, the brush trails the pointer on a string: slack is ignored, and once
  // it's taut the brush moves only as far as the pointer pulls it.
  moveTo(x: number, y: number) {
    if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 1e7 || Math.abs(y) > 1e7) return
    if (!this.trail) { this.trail = [x, y]; this.dabAt(x, y); this.last = [x, y]; this.samples = [[x, y]]; return }
    let target: [number, number] = [x, y]
    const string = this.stringLength
    if (string > 0) {
      const [tx, ty] = this.trail, distance = Math.hypot(x - tx, y - ty)
      if (distance <= string) return
      target = [tx + (x - tx) * (distance - string) / distance, ty + (y - ty) * (distance - string) / distance]
    }
    this.curveTo(target)
    this.trail = target
  }

  lineTo(x: number, y: number) {
    if (!this.last) { this.dabAt(x, y); this.last = [x, y]; return }
    const [lx, ly] = this.last
    const spacing = Math.max(0.25, this.settings.diameter * (this.pressure < 1 ? Math.max(0.05, this.pressure) : 1) * (this.settings.hardness >= 1 ? 0.015 : 0.025))
    const length = Math.hypot(x - lx, y - ly)
    let along = spacing - this.carry
    while (along <= length) {
      this.dabAt(lx + (x - lx) * along / length, ly + (y - ly) * along / length)
      along += spacing
    }
    this.carry = length - (along - spacing)
    this.last = [x, y]
  }

  private dabAt(docX: number, docY: number) {
    const { width, height } = this.raster
    const m = this.toPixel, cx = m[0] * docX + m[3] * docY + m[6], cy = m[1] * docX + m[4] * docY + m[7]
    const radius = this.settings.diameter / 2 * this.pixelScale * (this.pressure < 1 ? Math.max(0.05, this.pressure) : 1)
    if (radius <= 0) return
    const x0 = Math.max(0, Math.floor(cx - radius - 1)), y0 = Math.max(0, Math.floor(cy - radius - 1))
    const x1 = Math.min(width, Math.ceil(cx + radius + 1)), y1 = Math.min(height, Math.ceil(cy + radius + 1))
    if (x0 >= x1 || y0 >= y1) return
    if (this.gpu) { this.gpu.dab(cx, cy, radius, this.settings.hardness, { x0, y0, x1, y1 }); this.include({ x0, y0, x1, y1 }); return }
    const hard = this.settings.hardness >= 1, inner = radius * this.settings.hardness, band = Math.max(1e-6, radius - inner)
    const coverage = this.coverage, outer = radius + 0.5, outer2 = outer * outer, solid = Math.max(0, radius - 0.5), solid2 = solid * solid, inner2 = inner * inner
    const lutScale = falloffSteps / band
    for (let y = y0; y < y1; y++) {
      const dy = y + 0.5 - cy, dy2 = dy * dy
      if (dy2 >= outer2) continue
      // Only the pixels on this row that the circle reaches.
      const chord = Math.sqrt(outer2 - dy2)
      const from = Math.max(x0, Math.floor(cx - chord - 0.5)), to = Math.min(x1, Math.ceil(cx + chord + 0.5))
      const row = (y & 63) << 6
      for (let x = from; x < to; x++) {
        const dx = x + 0.5 - cx, d2 = dx * dx + dy2
        let v: number
        if (hard) {
          if (d2 >= outer2) continue
          v = d2 <= solid2 ? 1 : radius - Math.sqrt(d2) + 0.5
          if (v > 1) v = 1
          if (v <= 0) continue
          const tile = coverage.at(x, y), i = row + (x & 63), c = tile[i]
          if (v > c) tile[i] = v
        } else {
          if (d2 >= radius * radius) continue
          if (d2 <= inner2) v = 1
          else { const t = (Math.sqrt(d2) - inner) * lutScale, j = t | 0; v = falloffTable[j] + (falloffTable[j + 1] - falloffTable[j]) * (t - j) }
          if (v <= 0) continue
          const tile = coverage.at(x, y), i = row + (x & 63), c = tile[i]
          tile[i] = c + v - c * v
        }
      }
    }
    this.include({ x0, y0, x1, y1 })
  }

  private include(rect: Rect) {
    const grow = (a: Rect | null) => a ? { x0: Math.min(a.x0, rect.x0), y0: Math.min(a.y0, rect.y0), x1: Math.max(a.x1, rect.x1), y1: Math.max(a.y1, rect.y1) } : { ...rect }
    this.dirty = grow(this.dirty)
    this.touched = grow(this.touched)
  }

  // Writes the stroke so far into the raster; returns the region that changed since the last call, in raster pixels.
  render(): { x: number; y: number; w: number; h: number } | null {
    const dirty = this.dirty
    if (!dirty) return null
    this.dirty = null
    if (this.gpu) {
      this.gpu.composite(dirty)
      return { x: dirty.x0, y: dirty.y0, w: dirty.x1 - dirty.x0, h: dirty.y1 - dirty.y0 }
    }
    this.keep(dirty)
    const { raster, coverage, selection, settings } = this
    const { width, data, channels } = raster
    const opacity = this.mode.kind === 'wash' ? 0.45 : settings.opacity, [r, g, b] = this.color
    const gray = Math.round(0.299 * r + 0.587 * g + 0.114 * b)
    const toDoc = this.pixelToDocument
    const mode = this.mode, sample = new Float32Array(4), washed = Math.round(0.12 * 255)
    for (let y = dirty.y0; y < dirty.y1; y++) {
      for (let x = dirty.x0; x < dirty.x1; x++) {
        const i = y * width + x, t = inTile(x, y), covered = coverage.get(x, y), original = this.original.get(x, y)!, q = t * channels
        const restore = () => { if (channels === 1) data[i] = original[q]; else { const p = i * 4; data[p] = original[q]; data[p + 1] = original[q + 1]; data[p + 2] = original[q + 2]; data[p + 3] = original[q + 3] } }
        let a = covered ? covered[t] * opacity : 0
        // Nothing here (any more: a provisional tail taken back leaves none), so the pixel is as the stroke found it.
        if (a <= 0) { restore(); continue }
        if (selection) {
          const px = x + 0.5, py = y + 0.5
          const sx = Math.floor(toDoc[0] * px + toDoc[3] * py + toDoc[6]), sy = Math.floor(toDoc[1] * px + toDoc[4] * py + toDoc[7])
          a *= sx >= 0 && sy >= 0 && sx < selection.width && sy < selection.height ? selection.data[sy * selection.width + sx] / 255 : 0
          if (a <= 0) { restore(); continue }
        }
        if (mode.kind === 'source') {
          mode.sample(x, y, sample)
          if (channels === 1) { data[i] = Math.round(sample[0] * a + original[q] * (1 - a)); continue }
          const p = i * 4, keep = 1 - sample[3] / 255 * a
          for (let c = 0; c < 4; c++) data[p + c] = Math.round(sample[c] * a + original[q + c] * keep)
          continue
        }
        if (channels === 1) {
          const target = mode.kind === 'wash' ? washed : settings.erasing ? 0 : gray
          data[i] = Math.round(target * a + original[q] * (1 - a))
          continue
        }
        const p = i * 4, keep = 1 - a
        if (mode.kind === 'wash') {
          data[p] = Math.round(washed * a + original[q] * keep); data[p + 1] = Math.round(washed * a + original[q + 1] * keep); data[p + 2] = Math.round(washed * a + original[q + 2] * keep); data[p + 3] = Math.round(255 * a + original[q + 3] * keep)
        } else if (settings.erasing) {
          data[p] = Math.round(original[q] * keep); data[p + 1] = Math.round(original[q + 1] * keep); data[p + 2] = Math.round(original[q + 2] * keep); data[p + 3] = Math.round(original[q + 3] * keep)
        } else {
          data[p] = Math.round(r * a + original[q] * keep); data[p + 1] = Math.round(g * a + original[q + 1] * keep); data[p + 2] = Math.round(b * a + original[q + 2] * keep); data[p + 3] = Math.round(255 * a + original[q + 3] * keep)
        }
      }
    }
    const rect = { x: dirty.x0, y: dirty.y0, w: dirty.x1 - dirty.x0, h: dirty.y1 - dirty.y0 }
    raster.markDirty(rect)
    return rect
  }

  // Ends the GPU's part early, leaving its texture to be drawn again from the bytes (Spot Healing writes its result itself), its
  // coverage brought back first.
  leaveGPU() {
    const t = this.touched
    if (!this.gpu) return
    if (t) this.takeCoverage(t)
    this.gpu.dispose(); this.gpu = null
  }
  private takeCoverage(rect: Rect) { const read = this.gpu!.readCoverage(rect); if (read) this.writeCoverage(read, read.values) }
  // The coverage over `rect` as bytes (for Spot Healing).
  coverageBytes(rect: { x: number; y: number; w: number; h: number }) {
    const values = this.readCoverage({ x0: rect.x, y0: rect.y, x1: rect.x + rect.w, y1: rect.y + rect.h }), out = new Uint8Array(values.length)
    for (let i = 0; i < out.length; i++) out[i] = Math.round(Math.min(1, values[i]) * 255)
    return out
  }
  // How much of the stroke's source a pixel took: its coverage times the stroke's opacity, within the selection.
  weight(x: number, y: number) {
    let a = Math.min(1, this.coverageAt(x, y)) * (this.mode.kind === 'wash' ? 0.45 : this.settings.opacity)
    const selection = this.selection, m = this.pixelToDocument
    if (a > 0 && selection) {
      const sx = Math.floor(m[0] * (x + 0.5) + m[3] * (y + 0.5) + m[6]), sy = Math.floor(m[1] * (x + 0.5) + m[4] * (y + 0.5) + m[7])
      a *= sx >= 0 && sy >= 0 && sx < selection.width && sy < selection.height ? selection.data[sy * selection.width + sx] / 255 : 0
    }
    return a
  }
  get touchedRect() { const t = this.touched; return t ? { x: t.x0, y: t.y0, w: t.x1 - t.x0, h: t.y1 - t.y0 } : null }

  // Replaces what the stroke drew in `rect` (raster pixels) with `pixels`, clipped by the selection, before `finish`.
  replace(rect: { x: number; y: number; w: number; h: number }, pixels: Uint8Array) {
    const { raster, selection } = this, c = raster.channels, original = this.originalPixels(rect)
    this.keep({ x0: rect.x, y0: rect.y, x1: rect.x + rect.w, y1: rect.y + rect.h })
    const m = this.pixelToDocument
    for (let y = 0; y < rect.h; y++) for (let x = 0; x < rect.w; x++) {
      const gx = x + rect.x, gy = y + rect.y, i = gy * raster.width + gx
      let k = 1
      if (selection) {
        const sx = Math.floor(m[0] * (gx + 0.5) + m[3] * (gy + 0.5) + m[6]), sy = Math.floor(m[1] * (gx + 0.5) + m[4] * (gy + 0.5) + m[7])
        k = sx >= 0 && sy >= 0 && sx < selection.width && sy < selection.height ? selection.data[sy * selection.width + sx] / 255 : 0
      }
      for (let ch = 0; ch < c; ch++) raster.data[i * c + ch] = Math.round(original[(y * rect.w + x) * c + ch] + (pixels[(y * rect.w + x) * c + ch] - original[(y * rect.w + x) * c + ch]) * k)
    }
    raster.markDirty(rect)
  }

  finish(): PixelPatch | null {
    if (this.samples.length > 1 || this.tail) this.settle()
    if (this.mode.kind !== 'wash') this.render()
    const t = this.touched
    if (this.gpu) { if (t) { this.gpu.read(t); this.takeCoverage(t) } this.gpu.dispose(); this.gpu = null }
    if (!t) return null
    const raster = this.raster, x = t.x0, y = t.y0, w = t.x1 - t.x0, h = t.y1 - t.y0
    return { raster, x, y, w, h, before: this.originalPixels({ x, y, w, h }), after: raster.read(x, y, w, h) }
  }

  cancel() {
    this.gpu?.dispose()
    this.gpu = null
    const { width, height, channels, data } = this.raster
    this.original.tiles.forEach((tile, k) => {
      if (!tile) return
      const tx = (k % this.original.columns) << 6, ty = Math.floor(k / this.original.columns) << 6, w = Math.min(64, width - tx)
      for (let y = 0; y < 64 && ty + y < height; y++) data.set(tile.subarray(y * 64 * channels, (y * 64 + w) * channels), ((ty + y) * width + tx) * channels)
    })
    this.raster.touch()
  }
}
