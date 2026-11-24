import { Store, store, type LineCap, type LineStyle, type ShapeKind } from '../editor/store'
import { Raster, premultiply } from '../model/raster'
import { fullTransform, newLayer, type Layer, type Transform } from '../model/types'
import { requestOverlay, requestRender, view } from '../ui/canvasState'
import { clearSnap, snapPoint } from './snap'
import { drawHudLabel, type ToolHandler } from './tool'

// A shape layer's style, as LayerShapeStyle saves it: colors 0–1, the corner radius and line width in document pixels, smooth
// corners on a rectangle (format 14), a line's ends as fractions of the layer box, its dashes and caps (format 15; missing is solid
// with round caps, as every line was before), and an optional inside stroke for rectangles and ellipses (format 22).
export type ShapeStyle = {
  kind: ShapeKind
  red: number; green: number; blue: number
  cornerRadius: number
  smoothing?: boolean
  lineWidth?: number
  start?: [number, number]
  end?: [number, number]
  lineStyle?: LineStyle
  lineCap?: LineCap
  strokeWidth?: number
  strokeRed?: number
  strokeGreen?: number
  strokeBlue?: number
}

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

function setStrokeFields(style: ShapeStyle, width: number, color: [number, number, number]): ShapeStyle {
  const next: ShapeStyle = { ...style }
  if (style.kind === 'Line' || !Number.isFinite(width) || width <= 0 || width > 5000) {
    delete next.strokeWidth; delete next.strokeRed; delete next.strokeGreen; delete next.strokeBlue
    return next
  }
  next.strokeWidth = width
  next.strokeRed = Math.min(1, Math.max(0, color[0] / 255))
  next.strokeGreen = Math.min(1, Math.max(0, color[1] / 255))
  next.strokeBlue = Math.min(1, Math.max(0, color[2] / 255))
  return next
}

const rgbCSS = (r: number, g: number, b: number) => `rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)})`

// Draws a rectangle or ellipse with an optional inside stroke: the whole shape in the stroke color, then the inside in the fill
// color, so each outer edge pixel is drawn once and carries no fringe of the fill (EditorSession.fillShape).
function drawFilledShape(
  context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  kind: 'Rectangle' | 'Ellipse', x: number, y: number, w: number, h: number,
  cornerRadius: number, smooth: boolean, fill: string, strokeWidth: number, stroke: string | null,
) {
  const sw = stroke && strokeWidth > 0 ? Math.min(strokeWidth, Math.min(w, h) / 2) : 0
  const trace = (ix: number, iy: number, iw: number, ih: number, r: number) => {
    context.beginPath()
    if (kind === 'Ellipse') context.ellipse(ix + iw / 2, iy + ih / 2, iw / 2, ih / 2, 0, 0, Math.PI * 2)
    else rectanglePath(context, ix, iy, iw, ih, r, smooth)
  }
  if (sw > 0 && stroke) {
    context.fillStyle = stroke
    trace(x, y, w, h, cornerRadius)
    context.fill()
    const iw = w - 2 * sw, ih = h - 2 * sw
    if (iw > 0.01 && ih > 0.01) {
      context.fillStyle = fill
      const outerR = Math.min(Math.max(0, cornerRadius), w / 2, h / 2)
      trace(x + sw, y + sw, iw, ih, Math.max(0, outerR - sw))
      context.fill()
    }
    return
  }
  context.fillStyle = fill
  trace(x, y, w, h, cornerRadius)
  context.fill()
}

export function rasterizeShape(style: ShapeStyle, width: number, height: number): Raster {
  const canvas = new OffscreenCanvas(width, height)
  const context = canvas.getContext('2d', { willReadFrequently: true })!
  const fill = rgbCSS(style.red, style.green, style.blue)
  context.fillStyle = context.strokeStyle = fill
  if (style.kind === 'Line') {
    const t = Math.max(1, style.lineWidth ?? 4)
    const [s, e] = style.start && style.end ? [style.start, style.end] : [[Math.min(t, width) / 2 / width, Math.min(t, height) / 2 / height], [1 - Math.min(t, width) / 2 / width, 1 - Math.min(t, height) / 2 / height]]
    strokeLine(context, [s[0] * width, s[1] * height], [e[0] * width, e[1] * height], t, style.lineStyle ?? 'Solid', style.lineCap ?? 'Round')
  } else {
    const stroke = style.strokeWidth && style.strokeWidth > 0 && style.strokeRed !== undefined && style.strokeGreen !== undefined && style.strokeBlue !== undefined
      ? rgbCSS(style.strokeRed, style.strokeGreen, style.strokeBlue) : null
    drawFilledShape(context, style.kind, 0, 0, width, height, style.cornerRadius, style.smoothing === true, fill, style.strokeWidth ?? 0, stroke)
  }
  const data = new Uint8Array(context.getImageData(0, 0, width, height).data.buffer)
  return new Raster(width, height, 4, premultiply(data))
}

// After a shape layer is scaled, it's drawn again at its new size instead of being resampled; a scaled line stretches as pixels
// and drops its shape metadata (EditorSession.redrawShape).
export function redrawShape(layer: Layer): Partial<Layer> | null {
  const style = layer.shape as ShapeStyle | undefined
  if (!style || !layer.image) return null
  const w = Math.max(1, Math.round(layer.transform.size[0])), h = Math.max(1, Math.round(layer.transform.size[1]))
  if (w === layer.image.width && h === layer.image.height) return null
  if (style.kind === 'Line') return { shape: undefined }
  if (w * h > 200_000_000) return null
  return { image: rasterizeShape(style, w, h), ...(layer.mask && !layer.maskPlacement ? { maskPlacement: layer.transform } : {}) }
}

// MARK: Live shape inspection & editing

export const liveShapeStyle = (layer: Layer | undefined | null): ShapeStyle | null =>
  layer?.image && !layer.isGroup && !layer.adjustment && layer.shape ? (layer.shape as ShapeStyle) : null

export function editingShapeLayer(): Layer | null {
  if (store.state.tool !== 'shape' || store.state.editingMask || store.state.selectedIds.length > 1) return null
  const layer = store.active, style = liveShapeStyle(layer)
  return layer && style && style.kind !== 'Line' ? layer : null
}

export function editingLineLayer(): Layer | null {
  if (store.state.tool !== 'shape' || store.state.editingMask || store.state.selectedIds.length > 1) return null
  const layer = store.active, style = liveShapeStyle(layer)
  return layer && style && style.kind === 'Line' ? layer : null
}

const sameRGB = (a: [number, number, number], b: [number, number, number]) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2]

// The next shape's color: the fill last picked in the Shape bar until the foreground changes, otherwise the foreground.
export function nextShapeFill(): [number, number, number] {
  const choice = store.state.shape.fillChoice
  return choice && sameRGB(choice.foreground, store.state.foreground) ? choice.fill : store.state.foreground
}

export function displayedShapeStroke(): [number, number, number] {
  const s = liveShapeStyle(editingShapeLayer())
  if (s && s.strokeRed !== undefined && s.strokeGreen !== undefined && s.strokeBlue !== undefined) {
    return [Math.round(s.strokeRed * 255), Math.round(s.strokeGreen * 255), Math.round(s.strokeBlue * 255)]
  }
  return store.state.shape.strokeColor
}

export function displayedStrokeWidth(): number {
  const layer = editingShapeLayer()
  if (!layer) return store.state.shape.strokeWidth
  return liveShapeStyle(layer)?.strokeWidth ?? 0
}

export function displayedCornerRadius(): number {
  const s = liveShapeStyle(editingShapeLayer())
  return s?.kind === 'Rectangle' ? s.cornerRadius : store.state.shape.cornerRadius
}

export function displayedShapeSmoothing(): boolean {
  const s = liveShapeStyle(editingShapeLayer())
  return s?.kind === 'Rectangle' ? s.smoothing === true : store.state.shape.smoothing
}

export function displayedLineWidth(): number {
  const s = liveShapeStyle(editingLineLayer())
  return s?.lineWidth ?? store.state.shape.lineWidth
}

export function displayedLineStyle(): LineStyle {
  const layer = editingLineLayer()
  if (!layer) return store.state.shape.lineStyle
  return liveShapeStyle(layer)?.lineStyle ?? 'Solid'
}

export function displayedLineCap(): LineCap {
  const layer = editingLineLayer()
  if (!layer) return store.state.shape.lineCap
  return liveShapeStyle(layer)?.lineCap ?? 'Round'
}

function updateLiveShape(mutate: (style: ShapeStyle) => ShapeStyle, coalesce?: string) {
  const layer = editingShapeLayer()
  if (!layer?.image) return
  const before = liveShapeStyle(layer)!
  const next = mutate(before)
  if (JSON.stringify(next) === JSON.stringify(before)) return
  const image = rasterizeShape(next, layer.image.width, layer.image.height)
  store.updateLayer(layer.id, { image, shape: next, deep: undefined }, 'Shape Style', coalesce)
  store.pixelsChanged()
}

// Rebuilds a line layer's box around the same two endpoints when its width or cap changes (EditorSession.relayoutLine).
function relayoutLine(style: ShapeStyle, transform: Transform, width: number, cap: LineCap): { style: ShapeStyle; transform: Transform } {
  const w = Math.min(5000, Math.max(1, width))
  const oldWidth = style.lineWidth ?? w
  const oldShift = lineGridShift(oldWidth), newShift = lineGridShift(w)
  const placed = (u: [number, number]): [number, number] => [transform.origin[0] + u[0] * transform.size[0], transform.origin[1] + u[1] * transform.size[1]]
  let from: [number, number], to: [number, number]
  if (style.start && style.end) {
    const nudge = newShift - oldShift
    const s = placed(style.start), e = placed(style.end)
    from = [s[0] + nudge, s[1] + nudge]; to = [e[0] + nudge, e[1] + nudge]
  } else {
    const reach = oldWidth / 2
    from = [transform.origin[0] + reach + newShift, transform.origin[1] + reach + newShift]
    to = [transform.origin[0] + transform.size[0] - reach + newShift, transform.origin[1] + transform.size[1] - reach + newShift]
  }
  const reach = lineReach(from, to, w, cap)
  const x0 = Math.min(from[0], to[0]) - reach, y0 = Math.min(from[1], to[1]) - reach
  const bw = Math.max(1, Math.abs(to[0] - from[0]) + reach * 2), bh = Math.max(1, Math.abs(to[1] - from[1]) + reach * 2)
  const unit = (p: [number, number]): [number, number] => [(p[0] - x0) / bw, (p[1] - y0) / bh]
  const nextStyle: ShapeStyle = { ...style, lineWidth: w, start: unit(from), end: unit(to) }
  if (cap === 'Round') delete nextStyle.lineCap; else nextStyle.lineCap = cap
  return { style: nextStyle, transform: { ...transform, origin: [x0, y0], size: [bw, bh] } }
}

function updateLiveLine(mutate: (style: ShapeStyle, transform: Transform) => { style: ShapeStyle; transform: Transform }, coalesce?: string) {
  const layer = editingLineLayer()
  if (!layer?.image) return
  const before = liveShapeStyle(layer)!
  const { style, transform } = mutate(before, layer.transform)
  const w = Math.max(1, Math.round(transform.size[0])), h = Math.max(1, Math.round(transform.size[1]))
  if (w * h > 200_000_000) return
  const image = rasterizeShape(style, w, h)
  const maskPlacement = (layer.image.width !== w || layer.image.height !== h) && layer.mask && !layer.maskPlacement ? layer.transform : layer.maskPlacement
  store.updateLayer(layer.id, { image, shape: style, transform: { ...transform, size: [w, h] }, maskPlacement, deep: undefined }, 'Shape Style', coalesce)
  store.pixelsChanged()
}

export function setDisplayedStrokeWidth(width: number) {
  const w = Number.isFinite(width) ? Math.min(5000, Math.max(0, width)) : 0
  if (!editingShapeLayer()) { store.set({ shape: { ...store.state.shape, strokeWidth: w } }); return }
  updateLiveShape(s => setStrokeFields(s, w, displayedShapeStroke()), 'shape-stroke-width')
}

export function setDisplayedCornerRadius(radius: number) {
  const r = Number.isFinite(radius) ? Math.min(5000, Math.max(0, radius)) : 0
  const layer = editingShapeLayer()
  if (!layer || liveShapeStyle(layer)?.kind !== 'Rectangle') { store.set({ shape: { ...store.state.shape, cornerRadius: r } }); return }
  updateLiveShape(s => ({ ...s, cornerRadius: r }), 'shape-radius')
}

export function setDisplayedShapeSmoothing(on: boolean) {
  const layer = editingShapeLayer()
  if (!layer || liveShapeStyle(layer)?.kind !== 'Rectangle') { store.set({ shape: { ...store.state.shape, smoothing: on } }); return }
  updateLiveShape(s => { const next = { ...s }; if (on) next.smoothing = true; else delete next.smoothing; return next })
}

export function setDisplayedLineWidth(width: number) {
  const w = Number.isFinite(width) ? Math.min(5000, Math.max(1, width)) : 4
  if (!editingLineLayer()) { store.set({ shape: { ...store.state.shape, lineWidth: w } }); return }
  updateLiveLine((s, t) => relayoutLine(s, t, w, s.lineCap ?? 'Round'), 'shape-line-width')
}

export function setDisplayedLineStyle(lineStyle: LineStyle) {
  if (!editingLineLayer()) { store.set({ shape: { ...store.state.shape, lineStyle } }); return }
  updateLiveLine((s, t) => { const next = { ...s }; if (lineStyle === 'Solid') delete next.lineStyle; else next.lineStyle = lineStyle; return { style: next, transform: t } })
}

export function setDisplayedLineCap(cap: LineCap) {
  if (!editingLineLayer()) { store.set({ shape: { ...store.state.shape, lineCap: cap } }); return }
  updateLiveLine((s, t) => relayoutLine(s, t, s.lineWidth ?? store.state.shape.lineWidth, cap))
}

// Live preview while choosing a shape's fill or stroke color in the Color Picker: the committed layer isn't changed until OK, so
// Cancel records nothing in history and leaves the saved pixels untouched (ShapeTool.previewShapeColor / finishShapeColorPick).
let colorPreview: { layerId: string; originalImage: Raster; originalShape: unknown } | null = null

export function previewShapeColor(layerId: string, fill: boolean, color: [number, number, number]) {
  const layer = store.layer(layerId), style = liveShapeStyle(layer)
  if (!layer?.image || !style) return
  if (!fill && (style.kind === 'Line' || !(style.strokeWidth && style.strokeWidth > 0))) return
  if (!colorPreview || colorPreview.layerId !== layerId) {
    colorPreview = { layerId, originalImage: layer.image, originalShape: layer.shape }
  }
  const base = colorPreview.originalShape as ShapeStyle
  const next = fill
    ? { ...base, red: color[0] / 255, green: color[1] / 255, blue: color[2] / 255 }
    : setStrokeFields(base, base.strokeWidth ?? 0, color)
  const image = rasterizeShape(next, colorPreview.originalImage.width, colorPreview.originalImage.height)
  store.updateLayerLive(layerId, { image, shape: next })
  requestRender()
}

export function commitShapeColor(layerId: string, fill: boolean, color: [number, number, number]) {
  const prev = colorPreview
  colorPreview = null
  if (prev && prev.layerId === layerId) {
    store.updateLayerLive(layerId, { image: prev.originalImage, shape: prev.originalShape })
  }
  const layer = store.layer(layerId), style = liveShapeStyle(layer)
  if (!layer?.image || !style) return
  if (!fill && (style.kind === 'Line' || !(style.strokeWidth && style.strokeWidth > 0))) return
  const next = fill
    ? { ...style, red: color[0] / 255, green: color[1] / 255, blue: color[2] / 255 }
    : setStrokeFields(style, style.strokeWidth ?? 0, color)
  if (JSON.stringify(next) !== JSON.stringify(style)) {
    const image = rasterizeShape(next, layer.image.width, layer.image.height)
    store.updateLayer(layer.id, { image, shape: next, deep: undefined }, 'Shape Style')
    store.pixelsChanged()
  }
  if (fill) store.set({ shape: { ...store.state.shape, fillChoice: { fill: color, foreground: [...store.state.foreground] as [number, number, number] } } })
}

export function cancelShapeColor(layerId: string) {
  const prev = colorPreview
  colorPreview = null
  if (prev && prev.layerId === layerId) {
    store.updateLayerLive(layerId, { image: prev.originalImage, shape: prev.originalShape })
    requestRender()
  }
}

// Fill with Foreground/Background on a live shape with no selection: recolors its fill and keeps its stroke and shape metadata.
export function recolorShape(owner: Store, layer: Layer, color: [number, number, number]): boolean {
  const style = liveShapeStyle(layer)
  if (!style || !layer.image) return false
  const next: ShapeStyle = { ...style, red: color[0], green: color[1], blue: color[2] }
  if (next.red === style.red && next.green === style.green && next.blue === style.blue) return true
  const image = rasterizeShape(next, layer.image.width, layer.image.height)
  owner.updateLayer(layer.id, { image, shape: next, deep: undefined }, 'Fill')
  owner.pixelsChanged()
  return true
}

Store.recolorShape = recolorShape

// Selecting a live shape or switching to the Shape tool opens the tool on that shape's kind (adoptShapeKindFromSelection).
const prevSelectionChange = Store.onSelectionOrToolChange
Store.onSelectionOrToolChange = owner => {
  prevSelectionChange?.(owner)
  if (owner.state.tool !== 'shape' || owner.state.selectedIds.length > 1) return
  const kind = liveShapeStyle(owner.active)?.kind
  if (kind && owner.state.shape.kind !== kind) owner.set({ shape: { ...owner.state.shape, kind } })
}

// MARK: Dragging a new shape

type Draft = {
  kind: ShapeKind
  anchor: [number, number]
  point: [number, number]
  square: boolean
  center: boolean
  radius: number
  smoothing: boolean
  fill: [number, number, number]
  lineWidth: number
  lineStyle: LineStyle
  lineCap: LineCap
  strokeWidth: number
  strokeColor: [number, number, number]
}
let draft: Draft | null = null
let shiftHeld = false

function rect(d: Draft) {
  let dx = Math.round(d.point[0]) - d.anchor[0], dy = Math.round(d.point[1]) - d.anchor[1]
  if (d.square) { const s = Math.max(Math.abs(dx), Math.abs(dy)); dx = Math.sign(dx || 1) * s; dy = Math.sign(dy || 1) * s }
  return d.center ? { x: d.anchor[0] - Math.abs(dx), y: d.anchor[1] - Math.abs(dy), w: 2 * Math.abs(dx), h: 2 * Math.abs(dy) } : { x: Math.min(d.anchor[0], d.anchor[0] + dx), y: Math.min(d.anchor[1], d.anchor[1] + dy), w: Math.abs(dx), h: Math.abs(dy) }
}

// Whole pixels, like the anchor; a 45° line rounds both ways alike, so it stays at 45°.
function lineEnd(d: Draft, shift: boolean): [number, number] {
  if (!shift) return [Math.round(d.point[0]), Math.round(d.point[1])]
  const dx = d.point[0] - d.anchor[0], dy = d.point[1] - d.anchor[1], length = Math.hypot(dx, dy), angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * Math.PI / 4
  return [Math.round(d.anchor[0] + Math.cos(angle) * length), Math.round(d.anchor[1] + Math.sin(angle) * length)]
}

// Status bar readout while dragging a shape or line (de6837b).
export function shapeDragStatus(): string | null {
  if (!draft) return null
  if (draft.kind === 'Line') {
    const end = lineEnd(draft, shiftHeld), len = Math.round(Math.hypot(end[0] - draft.anchor[0], end[1] - draft.anchor[1]))
    return len >= 1 ? `Line ${len} px` : null
  }
  const box = rect(draft)
  return box.w >= 1 && box.h >= 1 ? `Shape ${Math.round(box.w)} × ${Math.round(box.h)} px` : null
}

export const shapeTool: ToolHandler = {
  down(p) {
    const [x, y] = snapPoint(Math.round(p.point[0]), Math.round(p.point[1]), p.control)
    const { kind, cornerRadius, smoothing, lineWidth, lineStyle, lineCap, strokeWidth, strokeColor } = store.state.shape
    const editing = kind === 'Line' ? null : liveShapeStyle(editingShapeLayer())
    const line = kind === 'Line' ? liveShapeStyle(editingLineLayer()) : null
    const radius = editing?.kind === 'Rectangle' ? editing.cornerRadius : cornerRadius
    const smooth = editing?.kind === 'Rectangle' ? editing.smoothing === true : smoothing
    const sw = kind === 'Line' ? 0 : (editing ? (editing.strokeWidth ?? 0) : strokeWidth)
    const sc: [number, number, number] = editing && editing.strokeRed !== undefined && editing.strokeGreen !== undefined && editing.strokeBlue !== undefined
      ? [Math.round(editing.strokeRed * 255), Math.round(editing.strokeGreen * 255), Math.round(editing.strokeBlue * 255)]
      : strokeColor
    draft = {
      kind, anchor: [Math.round(x), Math.round(y)], point: [x, y], square: false, center: false,
      radius: kind === 'Rectangle' ? radius : 0, smoothing: kind === 'Rectangle' && smooth && radius > 0,
      fill: nextShapeFill(),
      lineWidth: line?.lineWidth ?? lineWidth,
      lineStyle: line?.lineStyle ?? lineStyle,
      lineCap: line ? (line.lineCap ?? 'Round') : lineCap,
      strokeWidth: sw, strokeColor: sc,
    }
  },
  move(p) {
    if (!draft) return
    draft.point = draft.kind === 'Line' ? p.point : snapPoint(p.point[0], p.point[1], p.control)
    draft.square = p.shift; draft.center = p.alt; shiftHeld = p.shift
    requestOverlay()
  },
  up() {
    const d = draft
    draft = null
    clearSnap()
    requestOverlay()
    if (!d) return
    const [r, g, b] = d.fill.map(v => v / 255)
    let box: { x: number; y: number; w: number; h: number }, style: ShapeStyle
    if (d.kind === 'Line') {
      const t = d.lineWidth, shift = lineGridShift(t), dragged = lineEnd(d, shiftHeld)
      const from: [number, number] = [d.anchor[0] + shift, d.anchor[1] + shift], end: [number, number] = [dragged[0] + shift, dragged[1] + shift], reach = lineReach(from, end, t, d.lineCap)
      const x0 = Math.min(from[0], end[0]) - reach, y0 = Math.min(from[1], end[1]) - reach
      box = { x: x0, y: y0, w: Math.abs(end[0] - from[0]) + reach * 2, h: Math.abs(end[1] - from[1]) + reach * 2 }
      if (Math.hypot(end[0] - from[0], end[1] - from[1]) < 1) return
      style = { kind: d.kind, red: r, green: g, blue: b, cornerRadius: 0, lineWidth: t, start: [(from[0] - x0) / box.w, (from[1] - y0) / box.h], end: [(end[0] - x0) / box.w, (end[1] - y0) / box.h], ...(d.lineStyle !== 'Solid' ? { lineStyle: d.lineStyle } : {}), ...(d.lineCap !== 'Round' ? { lineCap: d.lineCap } : {}) }
    } else {
      box = rect(d)
      style = setStrokeFields({ kind: d.kind, red: r, green: g, blue: b, cornerRadius: d.kind === 'Rectangle' ? d.radius : 0, ...(d.smoothing ? { smoothing: true } : {}) }, d.strokeWidth, d.strokeColor)
    }
    if (box.w < 1 || box.h < 1) return
    const w = Math.floor(box.w), h = Math.floor(box.h)
    if (w * h > 200_000_000) { store.notify('That shape is too large. Make it smaller than 200 megapixels.'); return }
    const used = new Set(store.doc.layers.map(l => l.name))
    let n = 1
    while (used.has(`${d.kind} ${n}`)) n++
    const transform: Transform = { ...fullTransform(w, h, box.x, box.y), size: [w, h] }
    const layer = newLayer({ name: `${d.kind} ${n}`, transform, image: rasterizeShape(style, w, h), shape: style })
    const selection = store.state.selection, feather = store.state.selectionFeather, base = store.state.selectionBase
    store.addLayer(layer, d.kind)
    store.set({ selection, selectionFeather: feather, selectionBase: base })
  },
  key(event) { if (event.key === 'Escape' && draft) { draft = null; clearSnap(); requestOverlay(); return true } return false },
  busy: () => !!draft,
  cursor: () => 'crosshair',
  draw(context) {
    if (!draft) return
    if (draft.kind === 'Line') {
      const shift = lineGridShift(draft.lineWidth), end = lineEnd(draft, shiftHeld)
      const a = view.toScreen(draft.anchor[0] + shift, draft.anchor[1] + shift), b = view.toScreen(end[0] + shift, end[1] + shift)
      context.fillStyle = context.strokeStyle = `rgba(${draft.fill.join(',')},0.75)`
      strokeLine(context, a, b, Math.max(1, draft.lineWidth * view.zoom), draft.lineStyle, draft.lineCap)
      context.lineCap = 'butt'
      const len = Math.round(Math.hypot(end[0] - draft.anchor[0], end[1] - draft.anchor[1]))
      if (len >= 1) drawHudLabel(context, `${len} px`, view.toScreen(end[0], end[1]), view.width, view.height)
      return
    }
    const box = rect(draft), [x, y] = view.toScreen(box.x, box.y), w = box.w * view.zoom, h = box.h * view.zoom
    if (w >= 1 && h >= 1) {
      drawFilledShape(
        context, draft.kind, x, y, w, h, draft.radius * view.zoom, draft.smoothing,
        `rgba(${draft.fill.join(',')},0.7)`,
        draft.strokeWidth * view.zoom,
        draft.strokeWidth > 0 ? `rgba(${draft.strokeColor.join(',')},0.9)` : null,
      )
      context.strokeStyle = '#3d8bfd'; context.lineWidth = 1
      context.beginPath()
      if (draft.kind === 'Ellipse') context.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2)
      else rectanglePath(context, x, y, w, h, draft.radius * view.zoom, draft.smoothing)
      context.stroke()
      const corners: [number, number][] = [[box.x, box.y], [box.x + box.w, box.y], [box.x, box.y + box.h], [box.x + box.w, box.y + box.h]]
      const far = corners.reduce((best, c) => Math.hypot(c[0] - draft!.anchor[0], c[1] - draft!.anchor[1]) > Math.hypot(best[0] - draft!.anchor[0], best[1] - draft!.anchor[1]) ? c : best)
      drawHudLabel(context, `${Math.round(box.w)} × ${Math.round(box.h)} px`, view.toScreen(...far), view.width, view.height)
    }
  },
}
