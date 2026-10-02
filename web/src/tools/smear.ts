import { store } from '../editor/store'
import { apply, invert, type Mat3 } from '../render/gl'
import { pixelToDocument } from '../render/compositor'
import { requestRender, view } from '../ui/canvasState'
import { paint } from './paint'
import type { Raster } from '../model/raster'
import type { ToolHandler } from './tool'

// Smudge and Liquify (SmudgeLiquify.swift), worked in the layer's own pixels. Liquify keeps a field of offsets into the stroke's
// starting pixels, so pushing the same area again stays sharp; Smudge carries a patch of color along and lays it down as it goes.
type Warp = {
  kind: 'Liquify' | 'Smudge'; layerId: string; raster: Raster; original: Uint8Array; toPixel: Mat3; scale: number
  offsets: Float32Array | null; carried: Float32Array | null; last: [number, number] | null; dirty: { x0: number; y0: number; x1: number; y1: number } | null
}
let warp: Warp | null = null
let pointer: [number, number] | null = null

const weight = (u: number, h: number) => { if (u >= 1) return 0; if (u <= h) return 1; const t = (1 - u) / (1 - h); return t * t * (3 - 2 * t) }

function settings(w: Warp) {
  const brush = store.state.brush
  const diameter = Math.max(2, brush.diameter) * w.scale
  return { diameter, hardness: Math.min(0.98, Math.max(0, brush.hardness)), strength: Math.min(1, Math.max(0.01, brush.opacity)), radius: Math.ceil(diameter / 2) }
}

function include(w: Warp, x0: number, y0: number, x1: number, y1: number) {
  const d = w.dirty
  w.dirty = d ? { x0: Math.min(d.x0, x0), y0: Math.min(d.y0, y0), x1: Math.max(d.x1, x1), y1: Math.max(d.y1, y1) } : { x0, y0, x1, y1 }
}

function sampleOriginal(w: Warp, x: number, y: number, c: number) {
  const { raster, original } = w, width = raster.width, height = raster.height
  const sx = Math.min(width - 1.001, Math.max(0, x)), sy = Math.min(height - 1.001, Math.max(0, y))
  const ix = Math.floor(sx), iy = Math.floor(sy), fx = sx - ix, fy = sy - iy
  const at = (px: number, py: number) => original[(py * width + px) * 4 + c]
  return (at(ix, iy) * (1 - fx) + at(ix + 1, iy) * fx) * (1 - fy) + (at(ix, iy + 1) * (1 - fx) + at(ix + 1, iy + 1) * fx) * fy
}

function liquifyDab(w: Warp, a: [number, number], b: [number, number]) {
  const { diameter, hardness, strength, radius } = settings(w)
  const { raster } = w, width = raster.width, height = raster.height, offsets = w.offsets!
  const mx = (b[0] - a[0]) * strength, my = (b[1] - a[1]) * strength
  const margin = Math.ceil(Math.max(Math.abs(mx), Math.abs(my))) + 2
  const cx = Math.round(b[0]), cy = Math.round(b[1])
  const x0 = Math.max(0, cx - radius - margin), y0 = Math.max(0, cy - radius - margin), x1 = Math.min(width, cx + radius + margin + 1), y1 = Math.min(height, cy + radius + margin + 1)
  const aw = x1 - x0, ah = y1 - y0
  if (aw < 2 || ah < 2) return
  const before = new Float32Array(aw * ah * 2)
  for (let y = 0; y < ah; y++) before.set(offsets.subarray(((y + y0) * width + x0) * 2, ((y + y0) * width + x1) * 2), y * aw * 2)
  for (let y = Math.max(y0, cy - radius); y < Math.min(y1, cy + radius + 1); y++) for (let x = Math.max(x0, cx - radius); x < Math.min(x1, cx + radius + 1); x++) {
    const k = weight(Math.hypot(x - b[0], y - b[1]) / (diameter / 2), hardness)
    if (k <= 0) continue
    const sx = Math.min(aw - 1, Math.max(0, x - x0 - mx * k)), sy = Math.min(ah - 1, Math.max(0, y - y0 - my * k))
    const ix = Math.min(aw - 2, Math.floor(sx)), iy = Math.min(ah - 2, Math.floor(sy))
    if (ix < 0 || iy < 0) continue
    const fx = sx - ix, fy = sy - iy
    const o = (px: number, py: number, c: number) => before[((py) * aw + px) * 2 + c]
    const ox = (o(ix, iy, 0) * (1 - fx) + o(ix + 1, iy, 0) * fx) * (1 - fy) + (o(ix, iy + 1, 0) * (1 - fx) + o(ix + 1, iy + 1, 0) * fx) * fy - mx * k
    const oy = (o(ix, iy, 1) * (1 - fx) + o(ix + 1, iy, 1) * fx) * (1 - fy) + (o(ix, iy + 1, 1) * (1 - fx) + o(ix + 1, iy + 1, 1) * fx) * fy - my * k
    const i = y * width + x
    offsets[i * 2] = ox; offsets[i * 2 + 1] = oy
    for (let c = 0; c < 4; c++) raster.data[i * 4 + c] = Math.round(sampleOriginal(w, x + ox, y + oy, c))
  }
  include(w, x0, y0, x1, y1)
}

function smudgeDab(w: Warp, b: [number, number], pickUp: boolean) {
  const { diameter, hardness, strength, radius } = settings(w)
  const { raster } = w, width = raster.width, height = raster.height
  const cx = Math.round(b[0]), cy = Math.round(b[1]), size = radius * 2 + 1
  if (pickUp || !w.carried) {
    w.carried = new Float32Array(size * size * 4)
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const px = cx - radius + x, py = cy - radius + y
      if (px < 0 || py < 0 || px >= width || py >= height) continue
      for (let c = 0; c < 4; c++) w.carried[(y * size + x) * 4 + c] = raster.data[(py * width + px) * 4 + c]
    }
    return
  }
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const px = cx - radius + x, py = cy - radius + y
    if (px < 0 || py < 0 || px >= width || py >= height) continue
    const k = weight(Math.hypot(px - b[0], py - b[1]) / (diameter / 2), hardness) * strength
    if (k <= 0) continue
    const i = (py * width + px) * 4, j = (y * size + x) * 4
    for (let c = 0; c < 4; c++) { const painted = raster.data[i + c] + (w.carried[j + c] - raster.data[i + c]) * k; raster.data[i + c] = Math.min(255, Math.max(0, Math.round(painted))); w.carried[j + c] = painted }
  }
  include(w, cx - radius, cy - radius, cx + radius + 1, cy + radius + 1)
}

function moveTo(w: Warp, doc: [number, number]) {
  const p = apply(w.toPixel, doc[0], doc[1])
  if (!w.last) { w.last = p; if (w.kind === 'Smudge') smudgeDab(w, p, true); return }
  const { diameter } = settings(w)
  const spacing = Math.max(1, diameter * (w.kind === 'Smudge' ? 0.005 : 0.025))
  const [lx, ly] = w.last, length = Math.hypot(p[0] - lx, p[1] - ly)
  let prev: [number, number] = w.last
  for (let along = spacing; along <= length; along += spacing) {
    const q: [number, number] = [lx + (p[0] - lx) * along / length, ly + (p[1] - ly) * along / length]
    if (w.kind === 'Liquify') liquifyDab(w, prev, q); else smudgeDab(w, q, false)
    prev = q
  }
  w.last = prev
  const d = w.dirty
  if (d) { const x0 = Math.max(0, d.x0), y0 = Math.max(0, d.y0); w.raster.markDirty({ x: x0, y: y0, w: Math.min(w.raster.width, d.x1) - x0, h: Math.min(w.raster.height, d.y1) - y0 }) }
}

// The Smear tool: Liquify and Smudge here, Blur through the shared paint strokes.
export const smear: ToolHandler = {
  down(p) {
    const mode = store.state.smearMode
    if (mode === 'Blur') { paint.down!(p); return }
    if (p.button === 2) { paint.down!(p); return }
    if (store.state.editingMask) { store.notify('Smudge and Liquify work on a layer’s pixels, not its mask.'); return }
    store.beginGesture(mode)
    const target = store.editTarget()
    if (!target || target.isMask) { store.cancelGesture(); store.notify('Choose a layer with pixels.'); return }
    const raster = target.raster
    const toDoc = pixelToDocument(target.layer.transform, raster.width, raster.height)
    const scale = 1 / Math.sqrt(Math.abs(toDoc[0] * toDoc[4] - toDoc[1] * toDoc[3]))
    warp = { kind: mode, layerId: target.layer.id, raster, original: raster.data.slice(), toPixel: invert(toDoc), scale, offsets: mode === 'Liquify' ? new Float32Array(raster.width * raster.height * 2) : null, carried: null, last: null, dirty: null }
    moveTo(warp, p.point)
  },
  move(p) {
    pointer = p.point
    if (store.state.smearMode === 'Blur' || !warp) { paint.move!(p); return }
    for (const q of p.coalesced.length ? p.coalesced : [p.point]) moveTo(warp, q)
    requestRender()
  },
  up(p) {
    if (!warp) { paint.up!(p); return }
    const w = warp
    warp = null
    const d = w.dirty
    if (!d) { store.cancelGesture(); return }
    // The selection limits what changes, applied when the stroke ends.
    const selection = store.state.selection, toDoc = invert(w.toPixel)
    const x0 = Math.max(0, d.x0), y0 = Math.max(0, d.y0), x1 = Math.min(w.raster.width, d.x1), y1 = Math.min(w.raster.height, d.y1)
    if (selection) for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const [dx, dy] = apply(toDoc, x + 0.5, y + 0.5), sx = Math.floor(dx), sy = Math.floor(dy)
      const k = sx >= 0 && sy >= 0 && sx < selection.width && sy < selection.height ? selection.data[sy * selection.width + sx] / 255 : 0
      const i = (y * w.raster.width + x) * 4
      for (let c = 0; c < 4; c++) w.raster.data[i + c] = Math.round(w.original[i + c] + (w.raster.data[i + c] - w.original[i + c]) * k)
    }
    w.raster.touch()
    const width = x1 - x0, height = y1 - y0, before = new Uint8Array(width * height * 4)
    for (let y = 0; y < height; y++) before.set(w.original.subarray(((y + y0) * w.raster.width + x0) * 4, ((y + y0) * w.raster.width + x1) * 4), y * width * 4)
    store.updateLayerLive(w.layerId, { text: undefined, shape: undefined })
    store.endGesture([{ raster: w.raster, x: x0, y: y0, w: width, h: height, before, after: w.raster.read(x0, y0, width, height) }])
    store.pixelsChanged()
  },
  hover(p) { pointer = p.point; paint.hover!(p) },
  key(event) {
    if (event.key === 'Escape' && warp) { warp.raster.data.set(warp.original); warp.raster.touch(); warp = null; store.cancelGesture(); requestRender(); return true }
    return paint.key!(event)
  },
  busy: () => !!warp || !!paint.busy!(),
  cursor: () => 'none',
  draw(context) {
    if (!pointer) return
    const [x, y] = view.toScreen(...pointer)
    context.beginPath(); context.arc(x, y, Math.max(1, store.state.brush.diameter / 2 * view.zoom), 0, Math.PI * 2)
    context.strokeStyle = '#fff'; context.lineWidth = 2.5; context.stroke(); context.strokeStyle = '#000'; context.lineWidth = 1; context.stroke()
  },
}
