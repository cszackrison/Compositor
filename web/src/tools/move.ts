import { store } from '../editor/store'
import { prefs } from '../editor/prefs'
import { apply } from '../render/gl'
import { drawOrder, effectivelyVisible, following, transformCorners, unitToDocument } from '../render/compositor'
import { Raster } from '../model/raster'
import { type Layer, type Transform } from '../model/types'
import { call, withBuffers } from '../kernels'
import { requestOverlay, requestRender, view, hitSlop } from '../ui/canvasState'
import { redrawShape } from './shape'
import { clearSnap, snapMove, snapPoint } from './snap'
import { guideAt, startGuideDrag } from './guides'
import { cancelFloating, commitFloating, isFloating } from '../editor/floating'
import type { ToolHandler } from './tool'

type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'
const handleNames: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']
const handleUnit: Record<Handle, [number, number]> = { nw: [0, 0], n: [0.5, 0], ne: [1, 0], e: [1, 0.5], se: [1, 1], s: [0.5, 1], sw: [0, 1], w: [0, 0.5] }

// What the handles transform: one layer's own box, or the upright box around several layers (or a folder's contents).
function members(): Layer[] {
  const ids = store.state.selectedIds.length ? store.state.selectedIds : store.state.activeId ? [store.state.activeId] : []
  const visible = new Set(drawOrder(store.doc).filter(effectivelyVisible).map(e => e.layer.id))
  const chosen = new Set(ids)
  return store.doc.layers.filter(l => !l.isGroup && l.image && visible.has(l.id) && (chosen.has(l.id) || store.ancestors(l.id).some(a => chosen.has(a.id))))
}
const asGroup = () => { const ids = store.state.selectedIds; return ids.length > 1 || !!store.layer(store.state.activeId)?.isGroup }

function groupBox(layers: Layer[]): Transform | null {
  const corners = layers.flatMap(l => transformCorners(l.transform))
  if (!corners.length) return null
  const x0 = Math.min(...corners.map(c => c[0])), y0 = Math.min(...corners.map(c => c[1])), x1 = Math.max(...corners.map(c => c[0])), y1 = Math.max(...corners.map(c => c[1]))
  return { origin: [x0, y0], size: [Math.max(1, x1 - x0), Math.max(1, y1 - y0)], rotation: 0, flipX: false, flipY: false, sampling: 'High quality' }
}

// An unlinked mask targeted on its own: the handles move the mask's own box (its placement), not the layer.
export function maskAlone() {
  const layer = store.active
  return !!layer?.mask && store.state.editingMask && !layer.maskLinked && !layer.isGroup && !layer.adjustment && store.state.selectedIds.length <= 1 ? layer : null
}
const sameBox = (a: Transform, b: Transform) => JSON.stringify({ ...a, sampling: 0 }) === JSON.stringify({ ...b, sampling: 0 })
function setMaskBox(layer: Layer, next: Transform) { store.updateLayerLive(layer.id, { maskPlacement: sameBox(next, layer.transform) ? null : next }) }

export function currentBox(): Transform | null {
  const alone = maskAlone()
  if (alone) return alone.maskPlacement ?? alone.transform
  const list = members()
  if (!list.length) return null
  if (!asGroup() && list.length === 1) return list[0].transform
  return groupBox(list)
}

export function resize(original: Transform, handle: Handle, pointer: [number, number], proportional: boolean, fromCenter: boolean): Transform {
  const radians = original.rotation * Math.PI / 180, cos = Math.cos(radians), sin = Math.sin(radians)
  const cx = original.origin[0] + original.size[0] / 2, cy = original.origin[1] + original.size[1] / 2
  const lx = (pointer[0] - cx) * cos + (pointer[1] - cy) * sin, ly = -(pointer[0] - cx) * sin + (pointer[1] - cy) * cos
  const hw = original.size[0] / 2, hh = original.size[1] / 2
  const movesX = handle.includes('e') || handle.includes('w'), movesY = handle.includes('n') || handle.includes('s')
  // Where the box is pinned on each axis, and which way the dragged side normally lies from it.
  const fixedX = fromCenter ? 0 : handle.includes('w') ? hw : -hw, fixedY = fromCenter ? 0 : handle.includes('n') ? hh : -hh
  const dirX = handle.includes('w') ? -1 : 1, dirY = handle.includes('n') ? -1 : 1
  let sx = movesX ? lx - fixedX : dirX * (fromCenter ? hw : 2 * hw), sy = movesY ? ly - fixedY : dirY * (fromCenter ? hh : 2 * hh)
  if (proportional && movesX && movesY) {
    const ratio = original.size[0] / original.size[1]
    if (Math.abs(sx) / Math.max(1e-9, Math.abs(sy)) > ratio) sy = Math.sign(sy || dirY) * Math.abs(sx) / ratio
    else sx = Math.sign(sx || dirX) * Math.abs(sy) * ratio
  }
  const flipX = original.flipX !== (Math.sign(sx) === -dirX && movesX), flipY = original.flipY !== (Math.sign(sy) === -dirY && movesY)
  const width = Math.max(1, Math.round(Math.abs(sx) * (fromCenter ? 2 : 1))), height = Math.max(1, Math.round(Math.abs(sy) * (fromCenter ? 2 : 1)))
  const mx = movesX ? (fromCenter ? 0 : fixedX + sx / 2) : 0, my = movesY ? (fromCenter ? 0 : fixedY + sy / 2) : 0
  const ncx = cx + mx * cos - my * sin, ncy = cy + mx * sin + my * cos
  return { ...original, origin: [Math.round(ncx - width / 2), Math.round(ncy - height / 2)], size: [width, height], flipX, flipY }
}

type Drag =
  | { kind: 'move'; start: [number, number]; originals: Map<string, Layer>; box: Transform }
  | { kind: 'scale' | 'rotate'; handle: Handle | 'rotate'; start: [number, number]; box: Transform; originals: Map<string, Layer>; group: boolean }
  | { kind: 'distort'; corner: number; start: [number, number]; corners: [number, number][] }
let drag: Drag | null = null
// Free distort waiting for Return: the layer and where its four corners (top-left, top-right, bottom-right, bottom-left) now are.
let distort: { ids: string[]; box: [number, number][]; corners: [number, number][]; mask?: string } | null = null

function hitHandle(screen: [number, number]): Handle | 'rotate' | 'body' | null {
  const box = distort ? null : currentBox()
  if (distort) {
    const i = distort.corners.findIndex(c => { const [x, y] = view.toScreen(...c); return Math.abs(x - screen[0]) <= 6 * hitSlop() && Math.abs(y - screen[1]) <= 6 * hitSlop() })
    return i >= 0 ? handleNames[[0, 2, 4, 6][i]] : null
  }
  if (!box || !prefs.transformControls) return null
  const m = unitToDocument(box)
  for (const name of handleNames) {
    const [x, y] = view.toScreen(...apply(m, ...handleUnit[name]))
    if (Math.abs(x - screen[0]) <= 6 * hitSlop() && Math.abs(y - screen[1]) <= 6 * hitSlop()) return name
  }
  const corners = transformCorners(box).map(c => view.toScreen(...c))
  if (pointInPolygon(screen, corners)) return 'body'
  if (corners.some(([x, y]) => Math.hypot(x - screen[0], y - screen[1]) < 26 * hitSlop())) return 'rotate'
  return null
}

function pointInPolygon([x, y]: [number, number], polygon: [number, number][]) {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i], [xj, yj] = polygon[j]
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

function bbox(t: Transform) {
  const c = transformCorners(t), xs = c.map(p => p[0]), ys = c.map(p => p[1])
  return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) }
}

// A homography from the unit square onto four corners (TL, TR, BR, BL), as a 3×3 column-major matrix.
function squareToQuad(q: [number, number][]): number[] {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = q
  const dx1 = x1 - x2, dx2 = x3 - x2, dy1 = y1 - y2, dy2 = y3 - y2, sx = x0 - x1 + x2 - x3, sy = y0 - y1 + y2 - y3
  let g = 0, h = 0
  if (sx !== 0 || sy !== 0) { const det = dx1 * dy2 - dx2 * dy1; g = (sx * dy2 - dx2 * sy) / det; h = (dx1 * sy - sx * dy1) / det }
  return [x1 - x0 + g * x1, y1 - y0 + g * y1, g, x3 - x0 + h * x3, y3 - y0 + h * y3, h, x0, y0, 1]
}
function invert3(m: number[]) {
  const [a, b, c, d, e, f, g, h, i] = m
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g, det = a * A + b * B + c * C
  return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det, B / det, (a * i - c * g) / det, -(a * f - c * d) / det, C / det, -(a * h - b * g) / det, (a * e - b * d) / det]
}
const project = (m: number[], x: number, y: number): [number, number] => { const w = m[2] * x + m[5] * y + m[8]; return [(m[0] * x + m[3] * y + m[6]) / w, (m[1] * x + m[4] * y + m[7]) / w] }

const cross = (a: [number, number], b: [number, number], c: [number, number]) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
// A quad whose corners all turn the same way.
function convex(q: [number, number][]) {
  const turns = q.map((_, i) => cross(q[i], q[(i + 1) % 4], q[(i + 2) % 4]))
  return turns.every(t => t > 0) || turns.every(t => t < 0)
}
// The affine map taking triangle `from` onto `to`, as a function of a point.
function triangleMap(from: [number, number][], to: [number, number][]) {
  const [[x0, y0], [x1, y1], [x2, y2]] = from, [[u0, v0], [u1, v1], [u2, v2]] = to
  const det = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0)
  return (x: number, y: number): [number, number] => {
    const a = ((x - x0) * (y2 - y0) - (x2 - x0) * (y - y0)) / det, b = ((x1 - x0) * (y - y0) - (x - x0) * (y1 - y0)) / det
    return [u0 + a * (u1 - u0) + b * (u2 - u0), v0 + a * (v1 - v0) + b * (v2 - v0)]
  }
}
const inTriangle = (p: [number, number], t: [number, number][]) => {
  const d1 = cross(t[0], t[1], p), d2 = cross(t[1], t[2], p), d3 = cross(t[2], t[0], p)
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0))
}

// Warps a raster onto four document corners, given in the raster's own corner order (its pixel (0,0) corner first, then along
// its rows, as transformCorners lists them). A convex shape is a true homography; a folded one is two affine triangles split on
// the first diagonal (Distort.swift). `outside` fills a mask past the shape.
function warp(image: Raster, corners: [number, number][], outside = 0): { raster: Raster; origin: [number, number] } {
  const x0 = Math.floor(Math.min(...corners.map(c => c[0]))), y0 = Math.floor(Math.min(...corners.map(c => c[1])))
  const x1 = Math.ceil(Math.max(...corners.map(c => c[0]))), y1 = Math.ceil(Math.max(...corners.map(c => c[1])))
  const width = Math.max(1, x1 - x0), height = Math.max(1, y1 - y0)
  const unit: [number, number][] = [[0, 0], [1, 0], [1, 1], [0, 1]]
  let toUnit: (x: number, y: number) => [number, number] | null
  if (convex(corners)) { const m = invert3(squareToQuad(corners)); toUnit = (x, y) => project(m, x, y) }
  else {
    const a = [corners[0], corners[1], corners[2]], b = [corners[0], corners[2], corners[3]]
    const ma = triangleMap(a, [unit[0], unit[1], unit[2]]), mb = triangleMap(b, [unit[0], unit[2], unit[3]])
    toUnit = (x, y) => inTriangle([x, y], a) ? ma(x, y) : inTriangle([x, y], b) ? mb(x, y) : null
  }
  const out = new Raster(width, height, image.channels)
  const c = image.channels
  if (outside) out.data.fill(outside)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const uv = toUnit(x + x0 + 0.5, y + y0 + 0.5)
    if (!uv) continue
    const [u, v] = uv
    if (u < 0 || v < 0 || u > 1 || v > 1) continue
    const sx = u * image.width - 0.5, sy = v * image.height - 0.5
    const ix = Math.floor(sx), iy = Math.floor(sy), fx = sx - ix, fy = sy - iy
    for (let ch = 0; ch < c; ch++) {
      const at = (px: number, py: number) => image.data[(Math.min(image.height - 1, Math.max(0, py)) * image.width + Math.min(image.width - 1, Math.max(0, px))) * c + ch]
      out.data[(y * width + x) * c + ch] = Math.round((at(ix, iy) * (1 - fx) + at(ix + 1, iy) * fx) * (1 - fy) + (at(ix, iy + 1) * (1 - fx) + at(ix + 1, iy + 1) * fx) * fy)
    }
  }
  return { raster: out, origin: [x0, y0] }
}

// Where a point inside the original box lands once the box's corners have moved: its place in the box's unit square, through
// the new corners (a homography, or the two triangles of a folded shape).
function carry(box: [number, number][], corners: [number, number][]) {
  const toBoxUnit = invert3(squareToQuad(box))
  if (convex(corners)) { const m = squareToQuad(corners); return (p: [number, number]) => project(m, ...project(toBoxUnit, ...p)) }
  const ta = triangleMap([[0, 0], [1, 0], [1, 1]], [corners[0], corners[1], corners[2]]), tb = triangleMap([[0, 0], [1, 1], [0, 1]], [corners[0], corners[2], corners[3]])
  return (p: [number, number]) => { const [u, v] = project(toBoxUnit, ...p); return u >= v ? ta(u, v) : tb(u, v) }
}

function trimmed(raster: Raster, origin: [number, number], sampling: Transform['sampling']) {
  const box = new Uint32Array(4)
  withBuffers([{ data: raster.data }, { data: box, out: true }], ([p, b]) => call('brush_alpha_bounds', p, raster.width, raster.height, raster.width * 4, b))
  const crop = box[2] > box[0] ? { x: box[0], y: box[1], w: box[2] - box[0], h: box[3] - box[1] } : { x: 0, y: 0, w: raster.width, h: raster.height }
  return { crop, image: new Raster(crop.w, crop.h, 4, raster.read(crop.x, crop.y, crop.w, crop.h)), transform: { origin: [origin[0] + crop.x, origin[1] + crop.y], size: [crop.w, crop.h], rotation: 0, flipX: false, flipY: false, sampling } as Transform }
}

export function applyDistort() {
  const d = distort
  if (!d) return
  distort = null
  if (d.box.every((c, i) => Math.abs(c[0] - d.corners[i][0]) < 1e-6 && Math.abs(c[1] - d.corners[i][1]) < 1e-6)) { requestOverlay(); return }
  if (d.mask) {
    // A mask distorted on its own is warped into the shape over the shape's bounds, its edge tone outside.
    const layer = store.layer(d.mask)
    if (!layer?.mask) return
    const placement = layer.maskPlacement ?? layer.transform
    const warped = warp(layer.mask, transformCorners(placement).map(c => carry(d.box, d.corners)(c as [number, number])), layer.mask.data[0])
    const box: Transform = { origin: warped.origin, size: [warped.raster.width, warped.raster.height], rotation: 0, flipX: false, flipY: false, sampling: placement.sampling }
    store.updateLayer(layer.id, { mask: warped.raster, maskPlacement: sameBox(box, layer.transform) ? null : box }, 'Distort Layer Mask')
    store.pixelsChanged()
    requestOverlay()
    return
  }
  const moved = carry(d.box, d.corners)
  const changes = new Map<string, Partial<Layer>>()
  for (const id of d.ids) {
    const layer = store.layer(id)
    if (!layer?.image) continue
    const corners = transformCorners(layer.transform).map(c => moved(c as [number, number]))
    const { raster, origin } = warp(layer.image, corners)
    const { crop, image, transform } = trimmed(raster, origin, layer.transform.sampling)
    let mask = layer.mask, maskPlacement = layer.maskPlacement
    if (mask && layer.maskLinked && !layer.maskPlacement && !(mask.width === 1 && mask.height === 1)) {
      const warped = warp(mask, corners).raster
      mask = new Raster(crop.w, crop.h, 1, warped.read(crop.x, crop.y, crop.w, crop.h))
    } else if (mask && layer.maskLinked && layer.maskPlacement) {
      // A placed mask carries its own corners through the same warp, its edge tone outside the shape.
      const edge = mask.data[0]
      const warped = warp(mask, transformCorners(layer.maskPlacement).map(c => moved(c as [number, number])), edge)
      mask = warped.raster
      maskPlacement = { origin: warped.origin, size: [warped.raster.width, warped.raster.height], rotation: 0, flipX: false, flipY: false, sampling: layer.maskPlacement.sampling }
    }
    changes.set(id, { image, transform, mask, maskPlacement, text: undefined, shape: undefined })
  }
  const layers = store.doc.layers.map(l => changes.has(l.id) ? { ...l, ...changes.get(l.id) } : l)
  // Inside a floating Transform Selection the warp is part of that one step.
  if (isFloating()) store.set({ doc: { ...store.doc, layers } })
  else store.commit(d.ids.length > 1 ? 'Distort Layers' : 'Distort', { doc: { ...store.doc, layers } })
  store.pixelsChanged()
  requestOverlay()
}

export const isDistorting = () => !!distort

export function cancelDistort() { if (distort) { distort = null; requestOverlay() } }

function snapshot() { return new Map(store.doc.layers.map(l => [l.id, l])) }

export const move: ToolHandler = {
  down(p) {
    if (!distort && prefs.guides && !prefs.lockGuides) {
      const guide = guideAt(p.screen)
      if (guide) { startGuideDrag(guide.axis, guide.id, p); return }
    }
    if (p.command && !distort) {
      const handle = hitHandle(p.screen)
      const layer = store.active
      const box = currentBox()
      if (handle && handle !== 'body' && handle !== 'rotate' && box && (layer?.image || asGroup() || maskAlone())) {
        const corners = transformCorners(box) as [number, number][]
        distort = { ids: maskAlone() ? [] : members().map(l => l.id), box: corners, corners: corners.map(c => [...c] as [number, number]), mask: maskAlone()?.id }
      }
      else { const hit = store.layersAt(...p.point)[0]; if (hit) store.setActive(hit.id) }
    }
    if (distort) {
      const handle = hitHandle(p.screen)
      const index = handle ? [0, 2, 4, 6].indexOf(handleNames.indexOf(handle as Handle)) : -1
      drag = { kind: 'distort', corner: index, start: p.point, corners: distort.corners.map(c => [...c] as [number, number]) }
      return
    }
    const handle = hitHandle(p.screen)
    const box = currentBox()
    if (handle && handle !== 'body' && box) {
      store.beginGesture(maskAlone() ? 'Transform Layer Mask' : asGroup() ? 'Transform Layers' : 'Transform Layer')
      drag = { kind: handle === 'rotate' ? 'rotate' : 'scale', handle, start: p.point, box, originals: snapshot(), group: asGroup() }
      return
    }
    if (!store.active || !box) return
    if (maskAlone()) { store.beginGesture('Transform Layer Mask'); drag = { kind: 'move', start: p.point, originals: snapshot(), box }; return }
    if (p.alt) {
      store.beginGesture(store.state.selectedIds.length > 1 ? 'Duplicate Layers' : 'Duplicate Layer')
      store.duplicateSelected()
    } else store.beginGesture('Move')
    drag = { kind: 'move', start: p.point, originals: snapshot(), box: currentBox()! }
  },
  move(p) {
    const d = drag
    if (!d) { move.hover!(p); return }
    if (d.kind === 'distort') {
      let dx = p.point[0] - d.start[0], dy = p.point[1] - d.start[1]
      if (p.shift) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0 }
      const corners = d.corners.map(c => [...c] as [number, number])
      if (d.corner >= 0) corners[d.corner] = [d.corners[d.corner][0] + dx, d.corners[d.corner][1] + dy]
      else corners.forEach(c => { c[0] += dx; c[1] += dy })
      distort!.corners = corners
      requestOverlay()
      return
    }
    if (d.kind === 'move') {
      let dx = Math.round(p.point[0] - d.start[0]), dy = Math.round(p.point[1] - d.start[1])
      let lock: 'x' | 'y' | undefined
      if (p.shift) { if (Math.abs(dx) > Math.abs(dy)) { dy = 0; lock = 'x' } else { dx = 0; lock = 'y' } }
      ;[dx, dy] = snapMove(bbox(d.box), dx, dy, p.control, new Set(members().map(l => l.id)), true, lock)
      const alone = maskAlone()
      if (alone) setMaskBox(alone, { ...d.box, origin: [d.box.origin[0] + Math.round(dx), d.box.origin[1] + Math.round(dy)] })
      else store.set({ doc: { ...store.doc, layers: store.movedLayers(Math.round(dx), Math.round(dy), d.originals) } })
      requestOverlay()
      return
    }
    let next: Transform
    if (d.kind === 'rotate') {
      const t = d.box, cx = t.origin[0] + t.size[0] / 2, cy = t.origin[1] + t.size[1] / 2
      let angle = t.rotation + (Math.atan2(p.point[1] - cy, p.point[0] - cx) - Math.atan2(d.start[1] - cy, d.start[0] - cx)) * 180 / Math.PI
      angle = p.shift ? Math.round(angle / 15) * 15 : Math.round(angle)
      next = { ...t, rotation: ((angle + 180) % 360 + 360) % 360 - 180 }
    } else {
      // An upright box's dragged edges snap to the canvas, other layers, guides and grid (snappedResizePoint).
      const pointer = d.box.rotation % 360 === 0 ? snapPoint(p.point[0], p.point[1], p.control, true, 10, new Set(members().map(l => l.id))) : p.point
      const handle = d.handle as Handle
      const snapped: [number, number] = [handle.includes('e') || handle.includes('w') ? pointer[0] : p.point[0], handle.includes('n') || handle.includes('s') ? pointer[1] : p.point[1]]
      next = resize(d.box, handle, snapped, !p.shift, p.alt)
    }
    const alone = maskAlone()
    if (alone) { setMaskBox(alone, next); requestOverlay(); return }
    const ids = new Set(members().map(l => l.id))
    store.set({ doc: { ...store.doc, layers: store.doc.layers.map(l => {
      if (!ids.has(l.id)) return l
      const original = d.originals.get(l.id)!
      const transform = d.group ? following(original.transform, d.box, next) : next
      const staying = l.mask && !l.maskLinked ? { maskPlacement: original.maskPlacement ?? original.transform } : l.maskPlacement ? { maskPlacement: following(original.maskPlacement!, original.transform, transform) } : {}
      return { ...l, transform, ...staying }
    }) } })
    requestOverlay()
  },
  up() {
    const d = drag
    drag = null
    clearSnap()
    if (!d || d.kind === 'distort') { requestOverlay(); return }
    if (d.kind === 'scale') for (const layer of members()) { const redraw = redrawShape(layer); if (redraw) store.updateLayerLive(layer.id, redraw) }
    store.endGesture()
    requestRender()
  },
  hover(p) {
    const handle = hitHandle(p.screen)
    hoverCursor = handle === 'rotate' ? 'alias' : !handle || handle === 'body' ? (guideAt(p.screen) && prefs.guides && !prefs.lockGuides ? (guideAt(p.screen)!.axis === 'vertical' ? 'col-resize' : 'row-resize') : 'default') : distort ? 'move' : ['n', 's'].includes(handle) ? 'ns-resize' : ['e', 'w'].includes(handle) ? 'ew-resize' : ['nw', 'se'].includes(handle) ? 'nwse-resize' : 'nesw-resize'
  },
  key(event) {
    if (distort && event.key === 'Enter') { applyDistort(); if (isFloating()) commitFloating(); return true }
    if (distort && event.key === 'Escape') { cancelDistort(); return true }
    if (isFloating() && event.key === 'Enter') { commitFloating(); return true }
    if (isFloating() && event.key === 'Escape' && !drag) { cancelFloating(); return true }
    if (drag && event.key === 'Escape') { drag = null; clearSnap(); store.cancelGesture(); requestRender(); return true }
    return false
  },
  busy: () => !!drag,
  settle: () => { applyDistort(); commitFloating() },
  cursor: () => hoverCursor,
  draw(context) {
    if (distort) {
      const pts = distort.corners.map(c => view.toScreen(...c))
      context.beginPath(); pts.forEach(([x, y], i) => i ? context.lineTo(x, y) : context.moveTo(x, y)); context.closePath()
      context.strokeStyle = '#3d8bfd'; context.lineWidth = 1; context.stroke()
      for (const [x, y] of pts) { context.fillStyle = '#fff'; context.fillRect(x - 4, y - 4, 8, 8); context.strokeRect(x - 3.5, y - 3.5, 7, 7) }
      return
    }
    const box = currentBox()
    if (!box || !prefs.transformControls) return
    const corners = transformCorners(box).map(c => view.toScreen(...c))
    context.strokeStyle = '#3d8bfd'; context.lineWidth = 1
    context.beginPath(); corners.forEach(([x, y], i) => i ? context.lineTo(x, y) : context.moveTo(x, y)); context.closePath(); context.stroke()
    const m = unitToDocument(box)
    for (const name of handleNames) {
      const [x, y] = view.toScreen(...apply(m, ...handleUnit[name]))
      context.fillStyle = '#fff'; context.fillRect(x - 4, y - 4, 8, 8); context.strokeRect(x - 3.5, y - 3.5, 7, 7)
    }
  },
}
let hoverCursor = 'default'
