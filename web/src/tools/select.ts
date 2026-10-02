import { store } from '../editor/store'
import { beginPixelMove } from '../editor/clipboard'
import { bounds, offsetSelection, shapeCoverage, wand, type SelectionMode } from '../model/selection'
import type { Raster } from '../model/raster'
import { requestOverlay, samplePixels, view } from '../ui/canvasState'
import { clearSnap, snapMove, snapPoint } from './snap'
import { dashedPath, type Pointer, type ToolHandler } from './tool'

type Drag =
  | { kind: 'marquee'; start: [number, number]; current: [number, number]; mode: SelectionMode; square: boolean; center: boolean }
  | { kind: 'lasso'; points: [number, number][]; mode: SelectionMode }
  | { kind: 'outline'; start: [number, number]; original: Raster; box: { x: number; y: number; w: number; h: number }; moved: boolean }
  | { kind: 'pixels'; start: [number, number]; move: NonNullable<ReturnType<typeof beginPixelMove>>; moved: boolean }
  | { kind: 'click'; start: [number, number]; mode: SelectionMode }
let drag: Drag | null = null
let polygon: { points: [number, number][]; hover: [number, number] | null; mode: SelectionMode } | null = null

// Shift adds, Option subtracts (and wins over Shift), both together intersect.
// Option subtracts and Shift adds (Option wins), otherwise the header's sticky mode applies.
export const modeFor = (p: { shift: boolean; alt: boolean }): SelectionMode => p.alt ? 'subtract' : p.shift ? 'add' : store.state.selectionMode

const inside = (point: [number, number]) => {
  const s = store.state.selection
  if (!s) return false
  const x = Math.floor(point[0]), y = Math.floor(point[1])
  return x >= 0 && y >= 0 && x < s.width && y < s.height && s.data[y * s.width + x] >= 128
}

// The marquee's box (DragBox.rect): Shift makes it square, Option draws it from the center.
function box(start: [number, number], point: [number, number], square: boolean, center: boolean) {
  let dx = Math.round(point[0]) - start[0], dy = Math.round(point[1]) - start[1]
  if (square) { const s = Math.max(Math.abs(dx), Math.abs(dy)); dx = Math.sign(dx || 1) * s; dy = Math.sign(dy || 1) * s }
  return center ? { x: start[0] - Math.abs(dx), y: start[1] - Math.abs(dy), w: 2 * Math.abs(dx), h: 2 * Math.abs(dy) } : { x: Math.min(start[0], start[0] + dx), y: Math.min(start[1], start[1] + dy), w: Math.abs(dx), h: Math.abs(dy) }
}

function axisLock(dx: number, dy: number, shift: boolean): [number, number, 'x' | 'y' | undefined] {
  if (!shift) return [dx, dy, undefined]
  return Math.abs(dx) >= Math.abs(dy) ? [dx, 0, 'x'] : [0, dy, 'y']
}

function finishPolygon() {
  if (!polygon) return
  const { points, mode } = polygon
  polygon = null
  if (points.length > 2) store.setSelection(shapeCoverage(store.doc.width, store.doc.height, { kind: 'polygon', points }, store.state.selectionAntialias), mode, 'Polygonal Lasso')
  requestOverlay()
}

function startMoves(p: Pointer): boolean {
  if (!store.state.selection || !inside(p.point)) return false
  if (p.command) {
    const move = beginPixelMove(p.alt)
    if (!move) { store.notify('Select a layer’s pixels to move them.'); return true }
    drag = { kind: 'pixels', start: p.point, move, moved: false }
    return true
  }
  if (p.shift || p.alt) return false
  const original = store.state.selection!
  drag = { kind: 'outline', start: p.point, original, box: bounds(original)!, moved: false }
  store.beginGesture('Move Selection')
  return true
}

export const marquee: ToolHandler = {
  down(p) {
    if (startMoves(p)) return
    const start = snapPoint(Math.round(p.point[0]), Math.round(p.point[1]), p.control)
    drag = { kind: 'marquee', start: [Math.round(start[0]), Math.round(start[1])], current: p.point, mode: modeFor(p), square: false, center: false }
  },
  move: p => dragMove(p),
  up: () => dragUp(),
  key: event => event.key === 'Escape' && !!drag && (cancelDrag(), true),
  busy: () => !!drag,
  cursor: () => 'crosshair',
  draw: context => drawDrag(context),
}

export const lasso: ToolHandler = {
  down(p) {
    if (!polygon && startMoves(p)) return
    if (store.state.lassoKind === 'polygonal') {
      if (!polygon) polygon = { points: [p.point], hover: null, mode: modeFor(p) }
      else {
        const [sx, sy] = view.toScreen(...polygon.points[0]), [px, py] = view.toScreen(...p.point)
        if (Math.hypot(sx - px, sy - py) < 8 || p.clicks >= 2) finishPolygon()
        else polygon.points.push(p.point)
      }
      requestOverlay()
      return
    }
    drag = { kind: 'lasso', points: [p.point], mode: modeFor(p) }
  },
  move: p => dragMove(p),
  hover(p) { if (polygon) { polygon.hover = p.point; requestOverlay() } },
  up: () => dragUp(),
  key(event) {
    if (polygon && event.key === 'Enter') { finishPolygon(); return true }
    if (polygon && event.key === 'Escape') { polygon = null; requestOverlay(); return true }
    if (polygon && (event.key === 'Backspace' || event.key === 'Delete')) { polygon.points.pop(); if (!polygon.points.length) polygon = null; requestOverlay(); return true }
    if (event.key === 'Escape' && drag) { cancelDrag(); return true }
    return false
  },
  busy: () => !!drag,
  cursor: () => 'crosshair',
  draw: context => drawDrag(context),
  settle: () => finishPolygon(),
}

export const magic: ToolHandler = {
  down(p) {
    if (startMoves(p)) return
    drag = { kind: 'click', start: p.point, mode: modeFor(p) }
  },
  move: p => dragMove(p),
  up() {
    const d = drag
    drag = null
    if (d?.kind === 'click') {
      const pixels = samplePixels(store.state.wand.sampleAll)
      if (!pixels) { store.notify('Choose a layer with pixels, or sample all layers.'); return }
      store.setSelection(wand(pixels, Math.floor(d.start[0]), Math.floor(d.start[1]), store.state.wand.tolerance, store.state.wand.contiguous, store.state.wand.sampleSize), d.mode, 'Magic Wand')
      return
    }
    drag = d
    dragUp()
  },
  busy: () => !!drag,
  cursor: () => 'crosshair',
}

function dragMove(p: Pointer) {
  const d = drag
  if (!d) return
  if (d.kind === 'marquee') {
    d.current = snapPoint(p.point[0], p.point[1], p.control)
    d.square = p.shift && d.mode !== 'add'
    d.center = p.alt && d.mode !== 'subtract'
  } else if (d.kind === 'lasso') d.points.push(p.point)
  else if (d.kind === 'outline') {
    const [lx, ly, lock] = axisLock(Math.round(p.point[0] - d.start[0]), Math.round(p.point[1] - d.start[1]), p.shift)
    const [dx, dy] = snapMove(d.box, lx, ly, p.control, undefined, false, lock)
    d.moved = d.moved || dx !== 0 || dy !== 0
    store.set({ selection: offsetSelection(d.original, Math.round(dx), Math.round(dy)) })
  } else if (d.kind === 'pixels') {
    const [dx, dy] = axisLock(Math.round(p.point[0] - d.start[0]), Math.round(p.point[1] - d.start[1]), p.shift)
    d.moved = true
    d.move.preview(dx, dy)
  }
  requestOverlay()
}

function dragUp() {
  const d = drag
  drag = null
  clearSnap()
  if (!d) return
  if (d.kind === 'marquee') {
    const shape = box(d.start, d.current, d.square, d.center)
    if (shape.w < 1 || shape.h < 1) { if (d.mode === 'replace') store.deselect() }
    else store.setSelection(shapeCoverage(store.doc.width, store.doc.height, { kind: store.state.marqueeShape, ...shape }, store.state.marqueeShape === 'ellipse' && store.state.selectionAntialias), d.mode, store.state.marqueeShape === 'ellipse' ? 'Elliptical Marquee' : 'Rectangular Marquee')
  } else if (d.kind === 'lasso') {
    if (d.points.length > 2) store.setSelection(shapeCoverage(store.doc.width, store.doc.height, { kind: 'polygon', points: d.points }, store.state.selectionAntialias), d.mode, 'Lasso')
    else if (d.mode === 'replace') store.deselect()
  } else if (d.kind === 'outline') {
    if (d.moved) store.endGesture()
    else { store.cancelGesture(); if (store.state.tool !== 'wand') store.deselect() }
  } else if (d.kind === 'pixels') d.move.finish()
  requestOverlay()
}

function cancelDrag() {
  const d = drag
  drag = null
  clearSnap()
  if (d?.kind === 'outline') store.cancelGesture()
  if (d?.kind === 'pixels') d.move.cancel()
  requestOverlay()
}

function drawDrag(context: CanvasRenderingContext2D) {
  const d = drag
  if (d?.kind === 'marquee') {
    const shape = box(d.start, d.current, d.square, d.center)
    const [x0, y0] = view.toScreen(shape.x, shape.y), [x1, y1] = view.toScreen(shape.x + shape.w, shape.y + shape.h)
    context.beginPath()
    if (store.state.marqueeShape === 'ellipse') context.ellipse((x0 + x1) / 2, (y0 + y1) / 2, Math.abs(x1 - x0) / 2, Math.abs(y1 - y0) / 2, 0, 0, Math.PI * 2)
    else context.rect(x0 + 0.5, y0 + 0.5, x1 - x0, y1 - y0)
    dashedPath(context)
  }
  const points = d?.kind === 'lasso' ? d.points : polygon ? [...polygon.points, ...(polygon.hover ? [polygon.hover] : [])] : null
  if (points?.length) {
    context.beginPath()
    points.forEach(([x, y], i) => { const [sx, sy] = view.toScreen(x, y); if (i) context.lineTo(sx, sy); else context.moveTo(sx, sy) })
    dashedPath(context)
  }
}
