import { store, type LineCap, type LineStyle, type ShapeKind } from '../editor/store'
import { Raster, premultiply } from '../model/raster'
import { fullTransform, newLayer, type Layer, type Transform } from '../model/types'
import { requestOverlay, view } from '../ui/canvasState'
import { clearSnap, snapPoint } from './snap'
import type { ToolHandler } from './tool'

// A shape layer's style, as LayerShapeStyle saves it: colors 0–1, the corner radius and line width in document pixels, smooth
// corners on a rectangle (format 14), a line's ends as fractions of the layer box, and its dashes and caps (format 15; missing is solid
// with round caps, as every line was before).
export type ShapeStyle = { kind: ShapeKind; red: number; green: number; blue: number; cornerRadius: number; smoothing?: boolean; lineWidth?: number; start?: [number, number]; end?: [number, number]; lineStyle?: LineStyle; lineCap?: LineCap }

// Dash and gap lengths in multiples of the line's width, as they look with their caps on: a dot is as long as the line is wide.
const linePattern: Record<LineStyle, number[]> = { Solid: [], Dashed: [3, 2], 'Long Dash': [7, 2], Dotted: [1, 1] }

// A square cap reaches half the width every way, and its corners further on a slanted line; in whole pixels, so a 1-pixel line stays
// one crisp row (ShapeLineCap.reach).
export function lineReach(start: [number, number], end: [number, number], width: number, cap: LineCap) {
  const length = Math.hypot(end[0] - start[0], end[1] - start[1])
  if (cap !== 'Square' || !(length > 0)) return width / 2
  const corner = width / 2 * (Math.abs(end[0] - start[0]) + Math.abs(end[1] - start[1])) / length
  return width / 2 + Math.ceil(corner - width / 2 - 0.0001)
}

// Half a pixel for an odd width, so the line's edges land on pixel edges (lineGridShift).
export const lineGridShift = (width: number) => width / 2 - Math.floor(width / 2)

// Strokes a line in the context's colors (strokeShapeLine): a square cap is a flat-ended line half the width past each end, cut into
// full-length dashes; with round caps each dash is its own stroke and each dot a circle.
export function strokeLine(context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, start: [number, number], end: [number, number], width: number, style: LineStyle, cap: LineCap) {
  context.lineWidth = width
  context.setLineDash([])
  const length = Math.hypot(end[0] - start[0], end[1] - start[1]), dir = length > 0 ? [(end[0] - start[0]) / length, (end[1] - start[1]) / length] : [1, 0]
  const along = (d: number): [number, number] => [start[0] + dir[0] * (d - width / 2), start[1] + dir[1] * (d - width / 2)]
  const total = length + width, pattern = linePattern[style].map(v => v * width)
  if (cap === 'Square') {
    context.lineCap = 'butt'
    context.setLineDash(pattern)
    context.beginPath(); context.moveTo(...along(0)); context.lineTo(...along(total)); context.stroke()
    context.setLineDash([])
    return
  }
  context.lineCap = 'round'
  if (!pattern.length) {
    context.beginPath()
    if (length > 0) { context.moveTo(...start); context.lineTo(...end); context.stroke() } else { context.arc(start[0], start[1], width / 2, 0, Math.PI * 2); context.fill() }
    return
  }
  const dashes = new Path2D(), dots = new Path2D()
  for (let distance = 0, index = 0; distance < total; index++) {
    const next = Math.min(total, distance + pattern[index % pattern.length])
    if (index % 2 === 0) {
      const a = distance + width / 2, b = next - width / 2
      if (b - a > 0.001) { dashes.moveTo(...along(a)); dashes.lineTo(...along(b)) }
      else { const m = along((distance + next) / 2); dots.moveTo(m[0] + width / 2, m[1]); dots.arc(m[0], m[1], width / 2, 0, Math.PI * 2) }
    }
    distance = next
  }
  context.stroke(dashes)
  context.fill(dots)
}

// A rectangle's outline into `path`, its corners rounded by `radius` (at most half the shorter side). Smooth corners are Figma's
// cubic–arc–cubic construction at 60% smoothing (the iOS squircle), backing off where the corners run out of room
// (ShapeKind.smoothedRectangle). https://www.figma.com/blog/desperately-seeking-squircles/
export function rectanglePath(path: CanvasPath, x: number, y: number, width: number, height: number, cornerRadius: number, smooth = false) {
  const radius = Math.min(Math.max(0, cornerRadius), width / 2, height / 2)
  const smoothing = smooth && radius > 0 ? Math.min(0.6, Math.max(0, Math.min(width, height) / (2 * radius) - 1)) : 0
  if (!(radius > 0)) { path.rect(x, y, width, height); return }
  if (!(smoothing > 0)) { path.roundRect(x, y, width, height, radius); return }
  const reach = (1 + smoothing) * radius, angle = smoothing * Math.PI / 4, tangent = radius * Math.tan(angle / 2), c = tangent * Math.cos(angle), d = tangent * Math.sin(angle)
  const arcLength = radius * Math.SQRT2 * Math.sin((1 - smoothing) * Math.PI / 4), b = (reach - arcLength - c - d) / 3, a = 2 * b
  const corners = [[x + width, y], [x + width, y + height], [x, y + height], [x, y]]
  corners.forEach(([cx, cy], index) => {
    const rotation = index * Math.PI / 2, cos = Math.cos(rotation), sin = Math.sin(rotation)
    const at = (u: number, v: number): [number, number] => [cx + u * cos - v * sin, cy + u * sin + v * cos]
    if (index === 0) path.moveTo(...at(-reach, 0)); else path.lineTo(...at(-reach, 0))
    path.bezierCurveTo(...at(-reach + a, 0), ...at(-reach + a + b, 0), ...at(-reach + a + b + c, d))
    path.arc(...at(-radius, radius), radius, -Math.PI / 2 + angle + rotation, -angle + rotation)
    path.bezierCurveTo(...at(0, reach - a - b), ...at(0, reach - a), ...at(0, reach))
  })
  path.closePath()
}

export function rasterizeShape(style: ShapeStyle, width: number, height: number): Raster {
  const canvas = new OffscreenCanvas(width, height)
  const context = canvas.getContext('2d', { willReadFrequently: true })!
  const color = `rgb(${Math.round(style.red * 255)}, ${Math.round(style.green * 255)}, ${Math.round(style.blue * 255)})`
  context.fillStyle = context.strokeStyle = color
  if (style.kind === 'Line') {
    const t = Math.max(1, style.lineWidth ?? 4)
    const [s, e] = style.start && style.end ? [style.start, style.end] : [[Math.min(t, width) / 2 / width, Math.min(t, height) / 2 / height], [1 - Math.min(t, width) / 2 / width, 1 - Math.min(t, height) / 2 / height]]
    strokeLine(context, [s[0] * width, s[1] * height], [e[0] * width, e[1] * height], t, style.lineStyle ?? 'Solid', style.lineCap ?? 'Round')
  } else if (style.kind === 'Ellipse') {
    context.beginPath(); context.ellipse(width / 2, height / 2, width / 2, height / 2, 0, 0, Math.PI * 2); context.fill()
  } else {
    context.beginPath()
    rectanglePath(context, 0, 0, width, height, style.cornerRadius, style.smoothing === true)
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

let draft: { anchor: [number, number]; point: [number, number]; square: boolean; center: boolean; radius: number; smoothing: boolean } | null = null

function rect(d: NonNullable<typeof draft>) {
  let dx = Math.round(d.point[0]) - d.anchor[0], dy = Math.round(d.point[1]) - d.anchor[1]
  if (d.square) { const s = Math.max(Math.abs(dx), Math.abs(dy)); dx = Math.sign(dx || 1) * s; dy = Math.sign(dy || 1) * s }
  return d.center ? { x: d.anchor[0] - Math.abs(dx), y: d.anchor[1] - Math.abs(dy), w: 2 * Math.abs(dx), h: 2 * Math.abs(dy) } : { x: Math.min(d.anchor[0], d.anchor[0] + dx), y: Math.min(d.anchor[1], d.anchor[1] + dy), w: Math.abs(dx), h: Math.abs(dy) }
}

// Whole pixels, like the anchor; a 45° line rounds both ways alike, so it stays at 45°.
function lineEnd(d: NonNullable<typeof draft>, shift: boolean): [number, number] {
  if (!shift) return [Math.round(d.point[0]), Math.round(d.point[1])]
  const dx = d.point[0] - d.anchor[0], dy = d.point[1] - d.anchor[1], length = Math.hypot(dx, dy), angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * Math.PI / 4
  return [Math.round(d.anchor[0] + Math.cos(angle) * length), Math.round(d.anchor[1] + Math.sin(angle) * length)]
}

let shiftHeld = false

export const shapeTool: ToolHandler = {
  down(p) {
    const [x, y] = snapPoint(Math.round(p.point[0]), Math.round(p.point[1]), p.control)
    const { kind, cornerRadius, smoothing } = store.state.shape
    draft = { anchor: [Math.round(x), Math.round(y)], point: [x, y], square: false, center: false, radius: cornerRadius, smoothing: kind === 'Rectangle' && smoothing && cornerRadius > 0 }
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
    const { kind, lineWidth, lineStyle, lineCap } = store.state.shape
    const [r, g, b] = store.state.foreground.map(v => v / 255)
    let box: { x: number; y: number; w: number; h: number }, style: ShapeStyle
    if (kind === 'Line') {
      const t = lineWidth, shift = lineGridShift(t), dragged = lineEnd(d, shiftHeld)
      const from: [number, number] = [d.anchor[0] + shift, d.anchor[1] + shift], end: [number, number] = [dragged[0] + shift, dragged[1] + shift], reach = lineReach(from, end, t, lineCap)
      const x0 = Math.min(from[0], end[0]) - reach, y0 = Math.min(from[1], end[1]) - reach
      box = { x: x0, y: y0, w: Math.abs(end[0] - from[0]) + reach * 2, h: Math.abs(end[1] - from[1]) + reach * 2 }
      if (Math.hypot(end[0] - from[0], end[1] - from[1]) < 1) return
      style = { kind, red: r, green: g, blue: b, cornerRadius: 0, lineWidth: t, start: [(from[0] - x0) / box.w, (from[1] - y0) / box.h], end: [(end[0] - x0) / box.w, (end[1] - y0) / box.h], ...(lineStyle !== 'Solid' ? { lineStyle } : {}), ...(lineCap !== 'Round' ? { lineCap } : {}) }
    } else {
      box = rect(d)
      style = { kind, red: r, green: g, blue: b, cornerRadius: kind === 'Rectangle' ? d.radius : 0, ...(d.smoothing ? { smoothing: true } : {}) }
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
      const { lineWidth, lineStyle, lineCap } = store.state.shape, shift = lineGridShift(lineWidth), end = lineEnd(draft, shiftHeld)
      const a = view.toScreen(draft.anchor[0] + shift, draft.anchor[1] + shift), b = view.toScreen(end[0] + shift, end[1] + shift)
      context.fillStyle = context.strokeStyle = `rgba(${store.state.foreground.join(',')},0.6)`
      strokeLine(context, a, b, Math.max(1, lineWidth * view.zoom), lineStyle, lineCap)
      context.lineCap = 'butt'
      return
    }
    const box = rect(draft), [x, y] = view.toScreen(box.x, box.y), w = box.w * view.zoom, h = box.h * view.zoom
    if (kind === 'Ellipse') context.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2)
    else rectanglePath(context, x, y, w, h, draft.radius * view.zoom, draft.smoothing)
    context.fill(); context.stroke()
  },
}
