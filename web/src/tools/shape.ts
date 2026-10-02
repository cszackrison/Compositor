import { store, type ShapeKind } from '../editor/store'
import { Raster, premultiply } from '../model/raster'
import { fullTransform, newLayer, type Layer, type Transform } from '../model/types'
import { requestOverlay, view } from '../ui/canvasState'
import { clearSnap, snapPoint } from './snap'
import type { ToolHandler } from './tool'

// A shape layer's style, as LayerShapeStyle saves it: colors 0–1, the corner radius and line width in document pixels, and a
// line's ends as fractions of the layer box.
export type ShapeStyle = { kind: ShapeKind; red: number; green: number; blue: number; cornerRadius: number; lineWidth?: number; start?: [number, number]; end?: [number, number] }

export function rasterizeShape(style: ShapeStyle, width: number, height: number): Raster {
  const canvas = new OffscreenCanvas(width, height)
  const context = canvas.getContext('2d', { willReadFrequently: true })!
  const color = `rgb(${Math.round(style.red * 255)}, ${Math.round(style.green * 255)}, ${Math.round(style.blue * 255)})`
  context.fillStyle = context.strokeStyle = color
  if (style.kind === 'Line') {
    const t = Math.max(1, style.lineWidth ?? 4)
    const [s, e] = style.start && style.end ? [style.start, style.end] : [[Math.min(t, width) / 2 / width, Math.min(t, height) / 2 / height], [1 - Math.min(t, width) / 2 / width, 1 - Math.min(t, height) / 2 / height]]
    context.lineWidth = t; context.lineCap = 'round'
    context.beginPath(); context.moveTo(s[0] * width, s[1] * height); context.lineTo(e[0] * width, e[1] * height); context.stroke()
  } else if (style.kind === 'Ellipse') {
    context.beginPath(); context.ellipse(width / 2, height / 2, width / 2, height / 2, 0, 0, Math.PI * 2); context.fill()
  } else {
    const r = Math.min(Math.max(0, style.cornerRadius), width / 2, height / 2)
    context.beginPath()
    if (r > 0) context.roundRect(0, 0, width, height, r); else context.rect(0, 0, width, height)
    context.fill()
  }
  const data = new Uint8Array(context.getImageData(0, 0, width, height).data.buffer)
  return new Raster(width, height, 4, premultiply(data))
}

// After a shape layer is scaled, it's drawn again at its new size instead of being resampled.
export function redrawShape(layer: Layer): Partial<Layer> | null {
  const style = layer.shape as ShapeStyle | undefined
  if (!style || !layer.image) return null
  const w = Math.max(1, Math.round(layer.transform.size[0])), h = Math.max(1, Math.round(layer.transform.size[1]))
  if (w === layer.image.width && h === layer.image.height) return null
  if (w * h > 200_000_000) return null
  return { image: rasterizeShape(style, w, h), ...(layer.mask && !layer.maskPlacement ? { maskPlacement: layer.transform } : {}) }
}

let draft: { anchor: [number, number]; point: [number, number]; square: boolean; center: boolean; radius: number } | null = null

function rect(d: NonNullable<typeof draft>) {
  let dx = Math.round(d.point[0]) - d.anchor[0], dy = Math.round(d.point[1]) - d.anchor[1]
  if (d.square) { const s = Math.max(Math.abs(dx), Math.abs(dy)); dx = Math.sign(dx || 1) * s; dy = Math.sign(dy || 1) * s }
  return d.center ? { x: d.anchor[0] - Math.abs(dx), y: d.anchor[1] - Math.abs(dy), w: 2 * Math.abs(dx), h: 2 * Math.abs(dy) } : { x: Math.min(d.anchor[0], d.anchor[0] + dx), y: Math.min(d.anchor[1], d.anchor[1] + dy), w: Math.abs(dx), h: Math.abs(dy) }
}

function lineEnd(d: NonNullable<typeof draft>, shift: boolean): [number, number] {
  if (!shift) return d.point
  const dx = d.point[0] - d.anchor[0], dy = d.point[1] - d.anchor[1], length = Math.hypot(dx, dy), angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * Math.PI / 4
  return [d.anchor[0] + Math.cos(angle) * length, d.anchor[1] + Math.sin(angle) * length]
}

let shiftHeld = false

export const shapeTool: ToolHandler = {
  down(p) {
    const [x, y] = snapPoint(Math.round(p.point[0]), Math.round(p.point[1]), p.control)
    draft = { anchor: [Math.round(x), Math.round(y)], point: [x, y], square: false, center: false, radius: store.state.shape.cornerRadius }
  },
  move(p) {
    if (!draft) return
    draft.point = store.state.shape.kind === 'Line' ? p.point : snapPoint(p.point[0], p.point[1], p.control)
    draft.square = p.shift; draft.center = p.alt; shiftHeld = p.shift
    requestOverlay()
  },
  up() {
    const d = draft
    draft = null
    clearSnap()
    if (!d) return
    const { kind, lineWidth } = store.state.shape
    const [r, g, b] = store.state.foreground.map(v => v / 255)
    let box: { x: number; y: number; w: number; h: number }, style: ShapeStyle
    if (kind === 'Line') {
      const end = lineEnd(d, shiftHeld), t = lineWidth
      const x0 = Math.min(d.anchor[0], end[0]) - t / 2, y0 = Math.min(d.anchor[1], end[1]) - t / 2
      box = { x: x0, y: y0, w: Math.abs(end[0] - d.anchor[0]) + t, h: Math.abs(end[1] - d.anchor[1]) + t }
      if (Math.hypot(end[0] - d.anchor[0], end[1] - d.anchor[1]) < 1) return
      style = { kind, red: r, green: g, blue: b, cornerRadius: 0, lineWidth: t, start: [(d.anchor[0] - x0) / box.w, (d.anchor[1] - y0) / box.h], end: [(end[0] - x0) / box.w, (end[1] - y0) / box.h] }
    } else {
      box = rect(d)
      style = { kind, red: r, green: g, blue: b, cornerRadius: kind === 'Rectangle' ? d.radius : 0 }
    }
    if (box.w < 1 || box.h < 1) return
    const w = Math.floor(box.w), h = Math.floor(box.h)
    if (w * h > 200_000_000) { store.notify('That shape is too large. Make it smaller than 200 megapixels.'); return }
    const used = new Set(store.doc.layers.map(l => l.name))
    let n = 1
    while (used.has(`${kind} ${n}`)) n++
    const active = store.active
    const transform: Transform = { ...fullTransform(w, h, box.x, box.y), size: [w, h] }
    const layer = newLayer({ name: `${kind} ${n}`, transform, image: rasterizeShape(style, w, h), shape: style, parentId: active?.isGroup ? active.id : active?.parentId ?? null })
    const selection = store.state.selection
    store.addLayer(layer, kind)
    if (active?.isGroup) store.move([layer.id], { into: active.id })
    store.set({ selection })
  },
  key(event) { if (event.key === 'Escape' && draft) { draft = null; clearSnap(); requestOverlay(); return true } return false },
  busy: () => !!draft,
  cursor: () => 'crosshair',
  draw(context) {
    if (!draft) return
    const kind = store.state.shape.kind
    context.fillStyle = `rgba(${store.state.foreground.join(',')},0.5)`
    context.strokeStyle = '#3d8bfd'
    context.lineWidth = 1
    context.beginPath()
    if (kind === 'Line') {
      const [x0, y0] = view.toScreen(...draft.anchor), [x1, y1] = view.toScreen(...lineEnd(draft, shiftHeld))
      context.moveTo(x0, y0); context.lineTo(x1, y1)
      context.lineWidth = Math.max(1, store.state.shape.lineWidth * view.zoom); context.lineCap = 'round'
      context.strokeStyle = `rgba(${store.state.foreground.join(',')},0.6)`; context.stroke(); context.lineCap = 'butt'
      return
    }
    const box = rect(draft), [x, y] = view.toScreen(box.x, box.y), w = box.w * view.zoom, h = box.h * view.zoom
    if (kind === 'Ellipse') context.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2)
    else context.roundRect(x, y, w, h, Math.min(draft.radius * view.zoom, w / 2, h / 2))
    context.fill(); context.stroke()
  },
}
