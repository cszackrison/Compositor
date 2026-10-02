import type { Raster } from '../model/raster'
import type { PixelPatch } from '../model/history'
import { type Mat3, apply, invert } from '../render/gl'

export type BrushSettings = { diameter: number; hardness: number; opacity: number; smoothing: number; erasing: boolean }
// Where a stroke's color comes from: the brush color, or another image sampled at each pixel of the raster's grid (Clone Stamp,
// Blur). `wash` shows the original under a dark wash while Spot Healing gathers its coverage.
export type StrokeMode = { kind: 'paint' } | { kind: 'source'; sample: (x: number, y: number, out: Float32Array) => void } | { kind: 'wash' }

type Rect = { x0: number; y0: number; x1: number; y1: number }

// Soft-brush falloff across the region between the hardness radius and the rim: a normalized Gaussian that reaches zero at the rim.
export function falloff(u: number) {
  const k = 2.5
  return Math.max(0, (Math.exp(-k * u * u) - Math.exp(-k)) / (1 - Math.exp(-k)))
}
// The same, tabulated, for the inner loop of every dab.
const falloffTable = Float32Array.from({ length: 2049 }, (_, i) => falloff(i / 2048))

// One brush stroke on a layer's pixels or mask. Dabs build coverage (lighten for a hard tip, screen for a soft one), and the
// stroke's color is laid over the untouched original at coverage × opacity, so overlapping dabs never pass the stroke's opacity.
export class BrushStroke {
  private coverage: Float32Array
  private original: Uint8Array
  private dirty: Rect | null = null
  private touched: Rect | null = null
  private toPixel: Mat3
  private pixelScale: number
  private last: [number, number] | null = null
  private trail: [number, number] | null = null
  private carry = 0

  constructor(readonly raster: Raster, readonly pixelToDocument: Mat3, readonly settings: BrushSettings, readonly color: [number, number, number], readonly selection: Raster | null, readonly mode: StrokeMode = { kind: 'paint' }) {
    this.coverage = new Float32Array(raster.width * raster.height)
    this.original = raster.data.slice()
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

  private drawTail(from: [number, number], to: [number, number]) {
    const { width, height } = this.raster
    const r = this.settings.diameter / 2 * this.pixelScale + 2
    const [ax, ay] = apply(this.toPixel, ...from), [bx, by] = apply(this.toPixel, ...to)
    const rect = { x0: Math.max(0, Math.floor(Math.min(ax, bx) - r)), y0: Math.max(0, Math.floor(Math.min(ay, by) - r)), x1: Math.min(width, Math.ceil(Math.max(ax, bx) + r)), y1: Math.min(height, Math.ceil(Math.max(ay, by) + r)) }
    const w = Math.max(0, rect.x1 - rect.x0), h = Math.max(0, rect.y1 - rect.y0), data = new Float32Array(w * h)
    for (let y = 0; y < h; y++) data.set(this.coverage.subarray((y + rect.y0) * width + rect.x0, (y + rect.y0) * width + rect.x0 + w), y * w)
    this.tail = { last: this.last, carry: this.carry, rect, data }
    this.lineTo(to[0], to[1])
    this.last = this.tail.last
    this.carry = this.tail.carry
  }

  private removeTail() {
    const tail = this.tail
    if (!tail) return
    this.tail = null
    const { rect, data } = tail, w = rect.x1 - rect.x0, width = this.raster.width
    for (let y = 0; y < rect.y1 - rect.y0; y++) this.coverage.set(data.subarray(y * w, (y + 1) * w), (y + rect.y0) * width + rect.x0)
    if (w > 0 && rect.y1 > rect.y0) this.include(rect)
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
    const spacing = Math.max(0.25, this.settings.diameter * (this.settings.hardness >= 1 ? 0.015 : 0.025))
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
    const radius = this.settings.diameter / 2 * this.pixelScale
    if (radius <= 0) return
    const x0 = Math.max(0, Math.floor(cx - radius - 1)), y0 = Math.max(0, Math.floor(cy - radius - 1))
    const x1 = Math.min(width, Math.ceil(cx + radius + 1)), y1 = Math.min(height, Math.ceil(cy + radius + 1))
    if (x0 >= x1 || y0 >= y1) return
    const hard = this.settings.hardness >= 1, inner = radius * this.settings.hardness, band = Math.max(1e-6, radius - inner)
    const coverage = this.coverage, outer = radius + 0.5, outer2 = outer * outer, solid = Math.max(0, radius - 0.5), solid2 = solid * solid, inner2 = inner * inner
    const lutScale = (falloffTable.length - 1) / band
    for (let y = y0; y < y1; y++) {
      const dy = y + 0.5 - cy, dy2 = dy * dy
      if (dy2 >= outer2) continue
      // Only the pixels on this row that the circle reaches.
      const chord = Math.sqrt(outer2 - dy2)
      const from = Math.max(x0, Math.floor(cx - chord - 0.5)), to = Math.min(x1, Math.ceil(cx + chord + 0.5))
      let i = y * width + from
      for (let x = from; x < to; x++, i++) {
        const dx = x + 0.5 - cx, d2 = dx * dx + dy2
        let v: number
        if (hard) {
          if (d2 >= outer2) continue
          v = d2 <= solid2 ? 1 : radius - Math.sqrt(d2) + 0.5
          if (v > 1) v = 1
          if (v <= 0) continue
          const c = coverage[i]
          if (v > c) coverage[i] = v
        } else {
          if (d2 >= radius * radius) continue
          v = d2 <= inner2 ? 1 : falloffTable[((Math.sqrt(d2) - inner) * lutScale) | 0]
          if (v <= 0) continue
          const c = coverage[i]
          coverage[i] = c + v - c * v
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
    const { raster, coverage, original, selection, settings } = this
    const { width, data, channels } = raster
    const opacity = this.mode.kind === 'wash' ? 0.45 : settings.opacity, [r, g, b] = this.color
    const gray = Math.round(0.299 * r + 0.587 * g + 0.114 * b)
    const toDoc = this.pixelToDocument
    const mode = this.mode, sample = new Float32Array(4), washed = Math.round(0.12 * 255)
    for (let y = dirty.y0; y < dirty.y1; y++) {
      for (let x = dirty.x0; x < dirty.x1; x++) {
        const i = y * width + x
        let a = coverage[i] * opacity
        if (a <= 0) continue
        if (selection) {
          const px = x + 0.5, py = y + 0.5
          const sx = Math.floor(toDoc[0] * px + toDoc[3] * py + toDoc[6]), sy = Math.floor(toDoc[1] * px + toDoc[4] * py + toDoc[7])
          a *= sx >= 0 && sy >= 0 && sx < selection.width && sy < selection.height ? selection.data[sy * selection.width + sx] / 255 : 0
          if (a <= 0) continue
        }
        if (mode.kind === 'source') {
          mode.sample(x, y, sample)
          if (channels === 1) { data[i] = Math.round(sample[0] * a + original[i] * (1 - a)); continue }
          const p = i * 4, keep = 1 - sample[3] / 255 * a
          for (let c = 0; c < 4; c++) data[p + c] = Math.round(sample[c] * a + original[p + c] * keep)
          continue
        }
        if (channels === 1) {
          const target = mode.kind === 'wash' ? washed : settings.erasing ? 0 : gray
          data[i] = Math.round(target * a + original[i] * (1 - a))
          continue
        }
        const p = i * 4, keep = 1 - a
        if (mode.kind === 'wash') {
          data[p] = Math.round(washed * a + original[p] * keep); data[p + 1] = Math.round(washed * a + original[p + 1] * keep); data[p + 2] = Math.round(washed * a + original[p + 2] * keep); data[p + 3] = Math.round(255 * a + original[p + 3] * keep)
        } else if (settings.erasing) {
          data[p] = Math.round(original[p] * keep); data[p + 1] = Math.round(original[p + 1] * keep); data[p + 2] = Math.round(original[p + 2] * keep); data[p + 3] = Math.round(original[p + 3] * keep)
        } else {
          data[p] = Math.round(r * a + original[p] * keep); data[p + 1] = Math.round(g * a + original[p + 1] * keep); data[p + 2] = Math.round(b * a + original[p + 2] * keep); data[p + 3] = Math.round(255 * a + original[p + 3] * keep)
        }
      }
    }
    const rect = { x: dirty.x0, y: dirty.y0, w: dirty.x1 - dirty.x0, h: dirty.y1 - dirty.y0 }
    raster.markDirty(rect)
    return rect
  }

  // The raster as the stroke found it, and its coverage as bytes (for Spot Healing).
  get originalPixels() { return this.original }
  coverageBytes() {
    const out = new Uint8Array(this.coverage.length)
    for (let i = 0; i < out.length; i++) out[i] = Math.round(Math.min(1, this.coverage[i]) * 255)
    return out
  }
  get touchedRect() { const t = this.touched; return t ? { x: t.x0, y: t.y0, w: t.x1 - t.x0, h: t.y1 - t.y0 } : null }

  // Replaces what the stroke drew in `rect` (raster pixels) with `pixels`, clipped by the selection, before `finish`.
  replace(rect: { x: number; y: number; w: number; h: number }, pixels: Uint8Array) {
    const { raster, selection, original } = this, c = raster.channels
    for (let y = 0; y < rect.h; y++) for (let x = 0; x < rect.w; x++) {
      const gx = x + rect.x, gy = y + rect.y, i = gy * raster.width + gx
      let k = 1
      if (selection) {
        const [dx, dy] = apply(this.pixelToDocument, gx + 0.5, gy + 0.5), sx = Math.floor(dx), sy = Math.floor(dy)
        k = sx >= 0 && sy >= 0 && sx < selection.width && sy < selection.height ? selection.data[sy * selection.width + sx] / 255 : 0
      }
      for (let ch = 0; ch < c; ch++) raster.data[i * c + ch] = Math.round(original[i * c + ch] + (pixels[(y * rect.w + x) * c + ch] - original[i * c + ch]) * k)
    }
    raster.markDirty(rect)
  }

  finish(): PixelPatch | null {
    if (this.samples.length > 1 || this.tail) this.settle()
    if (this.mode.kind !== 'wash') this.render()
    const t = this.touched
    if (!t) return null
    const { raster, original } = this
    const x = t.x0, y = t.y0, w = t.x1 - t.x0, h = t.y1 - t.y0, c = raster.channels
    const before = new Uint8Array(w * h * c)
    for (let j = 0; j < h; j++) before.set(original.subarray(((y + j) * raster.width + x) * c, ((y + j) * raster.width + x + w) * c), j * w * c)
    return { raster, x, y, w, h, before, after: raster.read(x, y, w, h) }
  }

  cancel() {
    this.raster.data.set(this.original)
    this.raster.touch()
  }
}
