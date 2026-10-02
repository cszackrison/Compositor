import { store } from '../editor/store'
import { prefs, gridLines } from '../editor/prefs'
import { drawOrder, effectivelyVisible, transformCorners } from '../render/compositor'
import { snapLines, view } from '../ui/canvasState'

type Targets = { x: number[]; y: number[] }

// What drags snap to (Guides.swift alignmentSnapTargets): canvas bounds, layer edges, grid lines and guides, as switched on.
export function snapTargets(centers: boolean, exclude: Set<string> = new Set()): Targets {
  const { doc } = store.state
  const out: Targets = { x: [], y: [] }
  if (!prefs.snap || !prefs.snapSession) return out
  if (prefs.snapTo.bounds) { out.x.push(0, doc.width); out.y.push(0, doc.height); if (centers) { out.x.push(doc.width / 2); out.y.push(doc.height / 2) } }
  if (prefs.snapTo.layers) for (const { layer } of drawOrder(doc).filter(effectivelyVisible)) {
    if (!layer.image || layer.isGroup || exclude.has(layer.id)) continue
    const corners = transformCorners(layer.transform)
    const xs = corners.map(c => c[0]), ys = corners.map(c => c[1])
    const [x0, x1, y0, y1] = [Math.round(Math.min(...xs)), Math.round(Math.max(...xs)), Math.round(Math.min(...ys)), Math.round(Math.max(...ys))]
    out.x.push(x0, x1); out.y.push(y0, y1)
    if (centers) { out.x.push(Math.round((x0 + x1) / 2)); out.y.push(Math.round((y0 + y1) / 2)) }
  }
  if (prefs.snapTo.grid && prefs.grid) { out.x.push(...gridLines(doc.width)); out.y.push(...gridLines(doc.height)) }
  if (prefs.snapTo.guides && prefs.guides) for (const guide of doc.guides) (guide.axis === 'vertical' ? out.x : out.y).push(guide.position)
  return out
}

const tolerance = (points = 10) => points / view.zoom

function nearest(values: number[], targets: number[], within: number): { delta: number; target: number } | null {
  let best: { delta: number; target: number } | null = null
  for (const v of values) for (const t of targets) { const d = t - v; if (Math.abs(d) <= within && (!best || Math.abs(d) < Math.abs(best.delta))) best = { delta: d, target: t } }
  return best
}

// A box moved by (dx, dy): its min, mid or max on each axis meets the nearest target. Control turns snapping off for the drag.
export function snapMove(box: { x: number; y: number; w: number; h: number }, dx: number, dy: number, control: boolean, exclude?: Set<string>, centers = true, lock?: 'x' | 'y'): [number, number] {
  clearSnap()
  if (control) return [dx, dy]
  const targets = snapTargets(centers, exclude), within = tolerance()
  const sx = lock === 'y' ? null : nearest([box.x + dx, box.x + dx + box.w / 2, box.x + dx + box.w], targets.x, within)
  const sy = lock === 'x' ? null : nearest([box.y + dy, box.y + dy + box.h / 2, box.y + dy + box.h], targets.y, within)
  if (sx) snapLines.x = [sx.target]
  if (sy) snapLines.y = [sy.target]
  return [dx + (sx?.delta ?? 0), dy + (sy?.delta ?? 0)]
}

// A single point (a marquee or shape corner, a resized edge): each axis to its nearest target, without centers.
export function snapPoint(x: number, y: number, control: boolean, centers = false, points = 10, exclude?: Set<string>): [number, number] {
  clearSnap()
  if (control) return [x, y]
  const targets = snapTargets(centers, exclude), within = tolerance(points)
  const sx = nearest([x], targets.x, within), sy = nearest([y], targets.y, within)
  if (sx) snapLines.x = [sx.target]
  if (sy) snapLines.y = [sy.target]
  return [x + (sx?.delta ?? 0), y + (sy?.delta ?? 0)]
}

// A guide being dragged: grid, other guides on its axis, the canvas bounds and center, and layer edges and centers.
export function snapGuide(axis: 'horizontal' | 'vertical', position: number, id?: string): number {
  if (!prefs.snap) return position
  const { doc } = store.state
  const length = axis === 'vertical' ? doc.width : doc.height
  const targets = [0, length / 2, length, ...doc.guides.filter(g => g.axis === axis && g.id !== id).map(g => g.position), ...(prefs.grid ? gridLines(length) : [])]
  for (const { layer } of drawOrder(doc).filter(effectivelyVisible)) {
    if (!layer.image || layer.isGroup) continue
    const values = transformCorners(layer.transform).map(c => axis === 'vertical' ? c[0] : c[1])
    targets.push(Math.round(Math.min(...values)), Math.round(Math.max(...values)), Math.round((Math.min(...values) + Math.max(...values)) / 2))
  }
  const hit = nearest([position], targets, tolerance())
  return hit ? hit.target : position
}

export function clearSnap() { snapLines.x = []; snapLines.y = [] }
