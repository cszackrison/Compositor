import { store } from '../editor/store'
import { pixelToDocument } from '../render/compositor'
import { grownTransform, placeOnGrid } from '../editor/filters'
import { padMask } from '../editor/floating'
import { growMaskToCanvas } from './paint'
import { apply, invert } from '../render/gl'
import { requestOverlay, requestRender, view } from '../ui/canvasState'
import { Raster } from '../model/raster'
import { call, withBuffers } from '../kernels'
import type { ToolHandler } from './tool'

// A gradient waiting to be applied (Gradient.swift): its line can be dragged by either end until Return, another tool or another
// layer applies it. It draws straight onto the active layer or its mask, never a new layer.
type Pending = { layerId: string; isMask: boolean; start: [number, number]; end: [number, number]; original: Raster; transform: import('../model/types').Transform; grown: boolean }
let pending: Pending | null = null
let dragging: 'start' | 'end' | null = null

const snap45 = (from: [number, number], to: [number, number]): [number, number] => {
  const dx = to[0] - from[0], dy = to[1] - from[1], length = Math.hypot(dx, dy), angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * Math.PI / 4
  return [from[0] + Math.cos(angle) * length, from[1] + Math.sin(angle) * length]
}

function colors(): [number, number, number, number][] {
  const { gradient } = store.state, f = store.paletteColor('foreground'), b = store.paletteColor('background')
  const stops: [number, number, number, number][] = gradient.style === 'Foreground to Background' ? [[...f, 1], [...b, 1]] : [[...f, 1], [...f, 0]]
  return gradient.reversed ? stops.reverse() : stops
}

// Redraws the pending gradient over the original pixels: through the canvas and the selection, at the gradient's opacity.
function render() {
  const p = pending!
  const layer = store.layer(p.layerId)!
  const raster = p.original.clone()
  const placement = p.isMask ? (layer.maskPlacement && !layer.isGroup && !layer.adjustment ? layer.maskPlacement : layer.transform) : layer.transform
  const toDoc = pixelToDocument(placement, raster.width, raster.height)
  const { shape, opacity } = store.state.gradient
  const [c0, c1] = colors()
  const [sx, sy] = p.start, dx = p.end[0] - sx, dy = p.end[1] - sy, length2 = dx * dx + dy * dy, radius = Math.sqrt(length2)
  const selection = store.state.selection, { width, height } = store.doc
  for (let y = 0; y < raster.height; y++) for (let x = 0; x < raster.width; x++) {
    const [qx, qy] = apply(toDoc, x + 0.5, y + 0.5)
    if (qx < 0 || qy < 0 || qx >= width || qy >= height) continue
    let k = opacity
    if (selection) k *= selection.data[Math.floor(qy) * selection.width + Math.floor(qx)] / 255
    if (k <= 0) continue
    const t = Math.min(1, Math.max(0, shape === 'Radial' ? Math.hypot(qx - sx, qy - sy) / Math.max(1e-6, radius) : ((qx - sx) * dx + (qy - sy) * dy) / Math.max(1e-6, length2)))
    const a = (c0[3] + (c1[3] - c0[3]) * t) * k
    if (a <= 0) continue
    const i = y * raster.width + x
    if (raster.channels === 1) { raster.data[i] = Math.round((c0[0] + (c1[0] - c0[0]) * t) * a + raster.data[i] * (1 - a)); continue }
    const keep = 1 - a
    for (let c = 0; c < 3; c++) {
      // Colors blend in straight sRGB, weighted by each end's alpha, as Core Graphics gradients do.
      const w0 = c0[3] * (1 - t), w1 = c1[3] * t, color = w0 + w1 > 0 ? (c0[c] * w0 + c1[c] * w1) / (w0 + w1) : c0[c]
      raster.data[i * 4 + c] = Math.round(color * a + raster.data[i * 4 + c] * keep)
    }
    raster.data[i * 4 + 3] = Math.round(255 * a + raster.data[i * 4 + 3] * keep)
  }
  store.updateLayerLive(p.layerId, p.isMask ? { mask: raster } : { image: raster })
  requestRender()
}

function begin(point: [number, number]): boolean {
  store.beginGesture(store.state.editingMask ? 'Gradient Mask' : 'Gradient')
  const target = store.editTarget()
  if (!target) { store.cancelGesture(); store.notify('Choose a layer or mask for the gradient.'); return false }
  let layer = store.layer(target.layer.id)!
  let grown = false
  if (!target.isMask) {
    // Grow the layer to the canvas so the gradient fills it; it's cropped to what was drawn when applied.
    const image = layer.image!, toPixel = invert(pixelToDocument(layer.transform, image.width, image.height))
    const corners = [[0, 0], [store.doc.width, 0], [store.doc.width, store.doc.height], [0, store.doc.height]].map(([x, y]) => apply(toPixel, x, y))
    const x0 = Math.min(0, Math.floor(Math.min(...corners.map(c => c[0])))), y0 = Math.min(0, Math.floor(Math.min(...corners.map(c => c[1]))))
    const x1 = Math.max(image.width, Math.ceil(Math.max(...corners.map(c => c[0])))), y1 = Math.max(image.height, Math.ceil(Math.max(...corners.map(c => c[1]))))
    if ((x0 || y0 || x1 !== image.width || y1 !== image.height) && (x1 - x0) * (y1 - y0) < 120_000_000) {
      const bigger = placeOnGrid(image, [x0, y0], x1 - x0, y1 - y0)
      store.updateLayerLive(layer.id, { image: bigger, transform: grownTransform(layer.transform, pixelToDocument(layer.transform, image.width, image.height), image.width, image.height, [x0, y0], bigger.width, bigger.height), mask: layer.mask && !layer.maskPlacement && !layer.mask.isUniform() ? padMask(layer.mask, image, [x0, y0], bigger.width, bigger.height, 255) : layer.mask })
      layer = store.layer(layer.id)!
      grown = true
    }
  }
  if (target.isMask) growMaskToCanvas(layer.id)
  pending = { layerId: layer.id, isMask: target.isMask, start: point, end: point, original: target.isMask ? store.layer(layer.id)!.mask! : layer.image!, transform: layer.transform, grown }
  return true
}

export function applyGradient() {
  const p = pending
  if (!p) return
  pending = null
  dragging = null
  if (Math.hypot(p.end[0] - p.start[0], p.end[1] - p.start[1]) < 0.5) { store.cancelGesture(); requestRender(); return }
  if (!p.isMask) {
    const layer = store.layer(p.layerId)!, image = layer.image!
    const box = new Uint32Array(4)
    withBuffers([{ data: image.data }, { data: box, out: true }], ([px, b]) => call('brush_alpha_bounds', px, image.width, image.height, image.width * 4, b))
    if (box[2] > box[0] && (box[0] || box[1] || box[2] !== image.width || box[3] !== image.height)) {
      const cropped = new Raster(box[2] - box[0], box[3] - box[1], 4, image.read(box[0], box[1], box[2] - box[0], box[3] - box[1]))
      store.updateLayerLive(p.layerId, { image: cropped, transform: grownTransform(layer.transform, pixelToDocument(layer.transform, image.width, image.height), image.width, image.height, [box[0], box[1]], cropped.width, cropped.height) })
    }
    store.updateLayerLive(p.layerId, { text: undefined, shape: undefined })
  }
  store.endGesture()
  store.pixelsChanged()
}

export function cancelGradient() {
  if (!pending) return
  pending = null
  dragging = null
  store.cancelGesture()
  requestRender()
}

// Settings changes re-render a pending gradient.
export function refreshGradient() { if (pending && Math.hypot(pending.end[0] - pending.start[0], pending.end[1] - pending.start[1]) >= 0.5) render() }

export const gradient: ToolHandler = {
  down(p) {
    if (pending) {
      const near = (q: [number, number]) => { const [a, b] = view.toScreen(...q); return Math.hypot(a - p.screen[0], b - p.screen[1]) <= 10 }
      if (near(pending.end)) { dragging = 'end'; return }
      if (near(pending.start)) { dragging = 'start'; return }
      if (store.active?.id === pending.layerId && store.state.editingMask === pending.isMask) {
        pending.start = p.point; pending.end = p.point; dragging = 'end'; return
      }
      applyGradient()
    }
    if (begin(p.point)) dragging = 'end'
  },
  move(p) {
    if (!pending || !dragging) return
    const other = dragging === 'end' ? pending.start : pending.end
    const point = p.shift ? snap45(other, p.point) : p.point
    if (dragging === 'end') pending.end = point; else pending.start = point
    if (Math.hypot(pending.end[0] - pending.start[0], pending.end[1] - pending.start[1]) >= 0.5) render()
    requestOverlay()
  },
  up() {
    dragging = null
    if (pending && Math.hypot(pending.end[0] - pending.start[0], pending.end[1] - pending.start[1]) < 0.5) cancelGradient()
  },
  key(event) {
    if (!pending) return false
    if (event.key === 'Enter') { applyGradient(); return true }
    if (event.key === 'Escape') { cancelGradient(); return true }
    return false
  },
  busy: () => !!dragging,
  settle: () => applyGradient(),
  cursor: () => 'crosshair',
  draw(context) {
    if (!pending) return
    const [x0, y0] = view.toScreen(...pending.start), [x1, y1] = view.toScreen(...pending.end)
    context.beginPath(); context.moveTo(x0, y0); context.lineTo(x1, y1)
    context.strokeStyle = 'rgba(0,0,0,0.7)'; context.lineWidth = 3; context.stroke(); context.strokeStyle = '#fff'; context.lineWidth = 1; context.stroke()
    if (store.state.gradient.shape === 'Radial') {
      context.beginPath(); context.arc(x0, y0, Math.hypot(x1 - x0, y1 - y0), 0, Math.PI * 2)
      context.setLineDash([4, 4]); context.strokeStyle = 'rgba(0,0,0,0.5)'; context.lineWidth = 2; context.stroke(); context.strokeStyle = 'rgba(255,255,255,0.8)'; context.lineWidth = 1; context.stroke(); context.setLineDash([])
    }
    const [c0, c1] = colors()
    for (const [[x, y], c] of [[[x0, y0], c0], [[x1, y1], c1]] as [[number, number], number[]][]) {
      context.beginPath(); context.arc(x, y, 6, 0, Math.PI * 2); context.fillStyle = '#fff'; context.fill(); context.strokeStyle = '#000'; context.lineWidth = 1; context.stroke()
      context.beginPath(); context.arc(x, y, 3.5, 0, Math.PI * 2); context.fillStyle = 'rgb(191,191,191)'; context.fill(); context.fillStyle = `rgba(${c[0]},${c[1]},${c[2]},${c[3]})`; context.fill()
    }
  },
}
