import { store } from '../editor/store'
import { bounds } from '../model/selection'
import { requestOverlay, view, hitSlop } from '../ui/canvasState'
import { clearSnap, snapPoint } from './snap'
import type { ToolHandler } from './tool'

type Rect = { x: number; y: number; w: number; h: number }
export const cropRatios = ['Free', 'Original', '1:1', '4:3', '3:4', '16:9', '9:16']

export function ratioValue(name = store.state.crop.ratio): number | null {
  if (name === 'Free') return null
  if (name === 'Original') return store.doc.width / store.doc.height
  const [a, b] = name.split(':').map(Number)
  return a / b
}

// Selecting the tool starts the frame at the selection's bounds on the canvas, or at the whole canvas.
export function startCrop() {
  const { doc, selection } = store.state
  const box = selection ? bounds(selection) : null
  store.set({ crop: { ratio: 'Free', rect: box ?? { x: 0, y: 0, w: doc.width, h: doc.height } } })
}

// A new ratio keeps the frame's width and centers the new height.
export function setCropRatio(ratio: string) {
  const rect = store.state.crop.rect
  const value = ratioValue(ratio)
  if (!rect || !value) { store.set({ crop: { ...store.state.crop, ratio } }); return }
  const h = Math.max(1, Math.round(rect.w / value))
  store.set({ crop: { ratio, rect: { ...rect, y: Math.round(rect.y + (rect.h - h) / 2), h } } })
}

export function applyCrop() {
  const rect = store.state.crop.rect
  if (!rect) return
  store.set({ crop: { ...store.state.crop, rect: null } })
  store.resizeCanvas(rect.w, rect.h, -rect.x, -rect.y, 'Crop')
  startCrop()
}

export function cancelCrop() { store.set({ crop: { ...store.state.crop, rect: null } }); requestOverlay() }

type Edge = { left?: boolean; right?: boolean; top?: boolean; bottom?: boolean }
let drag: { kind: 'new' | 'move' | 'resize'; start: [number, number]; original: Rect; edge: Edge } | null = null

function edgeAt(screen: [number, number], rect: Rect): Edge | null {
  const [x0, y0] = view.toScreen(rect.x, rect.y), [x1, y1] = view.toScreen(rect.x + rect.w, rect.y + rect.h)
  const [px, py] = screen, near = 10 * hitSlop()
  const insideX = px > x0 - near && px < x1 + near, insideY = py > y0 - near && py < y1 + near
  if (!insideX || !insideY) return null
  const edge: Edge = { left: Math.abs(px - x0) <= near, right: Math.abs(px - x1) <= near, top: Math.abs(py - y0) <= near, bottom: Math.abs(py - y1) <= near }
  return edge.left || edge.right || edge.top || edge.bottom ? edge : null
}

function normalized(x0: number, y0: number, x1: number, y1: number): Rect {
  const x = Math.round(Math.min(x0, x1)), y = Math.round(Math.min(y0, y1))
  return { x, y, w: Math.max(1, Math.round(Math.max(x0, x1)) - x), h: Math.max(1, Math.round(Math.max(y0, y1)) - y) }
}

export const crop: ToolHandler = {
  down(p) {
    const rect = store.state.crop.rect ?? { x: 0, y: 0, w: store.doc.width, h: store.doc.height }
    const edge = edgeAt(p.screen, rect)
    const full = rect.x === 0 && rect.y === 0 && rect.w === store.doc.width && rect.h === store.doc.height
    const inside = p.point[0] > rect.x && p.point[0] < rect.x + rect.w && p.point[1] > rect.y && p.point[1] < rect.y + rect.h
    drag = { kind: edge ? 'resize' : inside && !full ? 'move' : 'new', start: p.point, original: rect, edge: edge ?? {} }
  },
  move(p) {
    const d = drag
    if (!d) { const rect = store.state.crop.rect; const e = rect && edgeAt(p.screen, rect); cursor = e ? ((e.left || e.right) && (e.top || e.bottom) ? ((e.left && e.top) || (e.right && e.bottom) ? 'nwse-resize' : 'nesw-resize') : e.left || e.right ? 'ew-resize' : 'ns-resize') : 'crosshair'; return }
    const ratio = ratioValue()
    const o = d.original
    let rect: Rect
    if (d.kind === 'move') {
      const dx = Math.round(p.point[0] - d.start[0]), dy = Math.round(p.point[1] - d.start[1])
      rect = { ...o, x: o.x + dx, y: o.y + dy }
    } else if (d.kind === 'new') {
      const [x, y] = ratio ? p.point : snapPoint(p.point[0], p.point[1], p.control, false, 8)
      let dx = x - d.start[0], dy = y - d.start[1]
      if (ratio) { if (Math.abs(dx) > Math.abs(dy) * ratio) dy = Math.sign(dy || 1) * Math.abs(dx) / ratio; else dx = Math.sign(dx || 1) * Math.abs(dy) * ratio }
      rect = p.alt ? normalized(d.start[0] - dx, d.start[1] - dy, d.start[0] + dx, d.start[1] + dy) : normalized(d.start[0], d.start[1], d.start[0] + dx, d.start[1] + dy)
    } else {
      const [px, py] = ratio ? p.point : snapPoint(p.point[0], p.point[1], p.control, false, 8)
      let x0 = o.x, y0 = o.y, x1 = o.x + o.w, y1 = o.y + o.h
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2
      if (d.edge.left) { x0 = px; if (p.alt) x1 = 2 * cx - px }
      if (d.edge.right) { x1 = px; if (p.alt) x0 = 2 * cx - px }
      if (d.edge.top) { y0 = py; if (p.alt) y1 = 2 * cy - py }
      if (d.edge.bottom) { y1 = py; if (p.alt) y0 = 2 * cy - py }
      if (ratio) {
        const w = Math.abs(x1 - x0), h = Math.abs(y1 - y0)
        if ((d.edge.left || d.edge.right) && !(d.edge.top || d.edge.bottom)) { const nh = w / ratio; y0 = cy - nh / 2; y1 = cy + nh / 2 }
        else if (!(d.edge.left || d.edge.right)) { const nw = h * ratio; x0 = cx - nw / 2; x1 = cx + nw / 2 }
        else { const nh = w / ratio; if (d.edge.top) y0 = y1 - nh; else y1 = y0 + nh }
      }
      rect = normalized(x0, y0, x1, y1)
    }
    store.set({ crop: { ...store.state.crop, rect } })
    requestOverlay()
  },
  up() { drag = null; clearSnap(); requestOverlay() },
  key(event) {
    if (event.key === 'Enter') { applyCrop(); return true }
    if (event.key === 'Escape') { if (drag) { store.set({ crop: { ...store.state.crop, rect: drag.original } }); drag = null } else cancelCrop(); return true }
    return false
  },
  busy: () => !!drag,
  settle: () => cancelCrop(),
  cursor: () => cursor,
  draw(context) {
    const rect = store.state.crop.rect
    if (!rect) return
    const [x0, y0] = view.toScreen(rect.x, rect.y), [x1, y1] = view.toScreen(rect.x + rect.w, rect.y + rect.h)
    context.beginPath(); context.rect(-10, -10, view.width + 20, view.height + 20); context.rect(x0, y0, x1 - x0, y1 - y0)
    context.fillStyle = 'rgba(0,0,0,0.6)'; context.fill('evenodd')
    context.strokeStyle = 'rgba(255,255,255,0.4)'; context.lineWidth = 1
    context.beginPath()
    for (const t of [1 / 3, 2 / 3]) { context.moveTo(x0 + (x1 - x0) * t, y0); context.lineTo(x0 + (x1 - x0) * t, y1); context.moveTo(x0, y0 + (y1 - y0) * t); context.lineTo(x1, y0 + (y1 - y0) * t) }
    context.stroke()
    context.strokeStyle = '#fff'; context.strokeRect(x0 + 0.5, y0 + 0.5, x1 - x0, y1 - y0)
    for (const [x, y] of [[x0, y0], [(x0 + x1) / 2, y0], [x1, y0], [x1, (y0 + y1) / 2], [x1, y1], [(x0 + x1) / 2, y1], [x0, y1], [x0, (y0 + y1) / 2]]) {
      context.fillStyle = '#fff'; context.fillRect(x - 4, y - 4, 8, 8); context.strokeStyle = '#000'; context.strokeRect(x - 3.5, y - 3.5, 7, 7)
    }
  },
}
let cursor = 'crosshair'
