import { store } from './store'
import { drawOrder, effectivelyVisible, transformCorners, following } from '../render/compositor'
import { bounds } from '../model/selection'
import type { Layer, Transform } from '../model/types'

// The Move tool's Align and Distribute (LayerAlign.swift), as in Photoshop.
export const alignments = ['Left Edges', 'Horizontal Centers', 'Right Edges', 'Top Edges', 'Vertical Centers', 'Bottom Edges'] as const
export type Alignment = typeof alignments[number]
export const distributions = ['Horizontal Centers', 'Vertical Centers', 'Horizontal Spacing', 'Vertical Spacing'] as const
export type Distribution = typeof distributions[number]
type Box = { x0: number; y0: number; x1: number; y1: number }

function offset(alignment: Alignment, b: Box, t: Box): [number, number] {
  switch (alignment) {
    case 'Left Edges': return [t.x0 - b.x0, 0]
    case 'Horizontal Centers': return [(t.x0 + t.x1) / 2 - (b.x0 + b.x1) / 2, 0]
    case 'Right Edges': return [t.x1 - b.x1, 0]
    case 'Top Edges': return [0, t.y0 - b.y0]
    case 'Vertical Centers': return [0, (t.y0 + t.y1) / 2 - (b.y0 + b.y1) / 2]
    case 'Bottom Edges': return [0, t.y1 - b.y1]
  }
}

// How far each box moves: the outermost two stay put and the rest spread evenly between them, their middles or the gaps between them.
export function distributionOffsets(distribution: Distribution, boxes: Box[]): [number, number][] {
  if (boxes.length <= 2) return boxes.map(() => [0, 0])
  const horizontal = distribution.startsWith('Horizontal'), start = (b: Box) => horizontal ? b.x0 : b.y0, length = (b: Box) => horizontal ? b.x1 - b.x0 : b.y1 - b.y0
  const order = boxes.map((_, i) => i).sort((a, b) => start(boxes[a]) + length(boxes[a]) / 2 - (start(boxes[b]) + length(boxes[b]) / 2))
  const first = boxes[order[0]], last = boxes[order.at(-1)!], steps = order.length - 1, offsets: [number, number][] = boxes.map(() => [0, 0])
  const along = (d: number): [number, number] => horizontal ? [d, 0] : [0, d]
  if (distribution.endsWith('Centers')) {
    const from = start(first) + length(first) / 2, to = start(last) + length(last) / 2
    order.forEach((index, rank) => { offsets[index] = along(from + (to - from) * rank / steps - (start(boxes[index]) + length(boxes[index]) / 2)) })
  } else {
    const gap = (start(last) + length(last) - start(first) - order.reduce((sum, i) => sum + length(boxes[i]), 0)) / steps
    let position = start(first)
    for (const index of order) { offsets[index] = along(position - start(boxes[index])); position += length(boxes[index]) + gap }
  }
  return offsets
}

// What moves: each selected layer on its own, and each selected folder's contents as one, with the upright box around them.
function items(): { members: Layer[]; box: Box }[] {
  const doc = store.doc, selected = new Set(store.state.selectedIds.length ? store.state.selectedIds : store.state.activeId ? [store.state.activeId] : [])
  const visible = new Set(drawOrder(doc).filter(effectivelyVisible).map(e => e.layer.id)), parent = new Map(doc.layers.map(l => [l.id, l.parentId]))
  const groups = new Map<string, Layer[]>()
  for (const layer of doc.layers) {
    if (!layer.image || layer.isGroup || layer.adjustment || !visible.has(layer.id)) continue
    let owner: string | null = selected.has(layer.id) ? layer.id : null
    for (let p = parent.get(layer.id), n = 0; p && n < 64; p = parent.get(p), n++) if (selected.has(p)) owner = p
    if (owner) groups.set(owner, [...(groups.get(owner) ?? []), layer])
  }
  return [...groups.values()].map(members => {
    const corners = members.flatMap(l => transformCorners(l.transform))
    return { members, box: { x0: Math.min(...corners.map(c => c[0])), y0: Math.min(...corners.map(c => c[1])), x1: Math.max(...corners.map(c => c[0])), y1: Math.max(...corners.map(c => c[1])) } }
  })
}

export const canAlign = () => store.hasDocument && (store.state.selectedIds.length > 0 || !!store.state.activeId)
export const canDistribute = () => store.hasDocument && store.state.selectedIds.length > 2

// Lines things up with the selection when there is one, with the canvas when one thing is selected, otherwise with the box around them all.
export function alignLayers(alignment: Alignment) {
  const list = items()
  if (!list.length) return
  const s = store.state.selection ? bounds(store.state.selection) : null
  const target = s ? { x0: s.x, y0: s.y, x1: s.x + s.w, y1: s.y + s.h } : list.length === 1 ? { x0: 0, y0: 0, x1: store.doc.width, y1: store.doc.height } : { x0: Math.min(...list.map(i => i.box.x0)), y0: Math.min(...list.map(i => i.box.y0)), x1: Math.max(...list.map(i => i.box.x1)), y1: Math.max(...list.map(i => i.box.y1)) }
  move(list, list.map(i => offset(alignment, i.box, target)), `Align ${alignment}`)
}

export function distributeLayers(distribution: Distribution) {
  const list = items()
  if (list.length > 2) move(list, distributionOffsets(distribution, list.map(i => i.box)), `Distribute ${distribution}`)
}

// Whole pixels, so nothing lands between them and has to be resampled; masks follow their link, as in a move.
function move(list: { members: Layer[] }[], offsets: [number, number][], name: string) {
  const moves = new Map<string, [number, number]>()
  list.forEach((item, i) => { const d: [number, number] = [Math.round(offsets[i][0]), Math.round(offsets[i][1])]; if (d[0] || d[1]) for (const l of item.members) moves.set(l.id, d) })
  if (!moves.size) return
  const layers = store.doc.layers.map(l => {
    const d = moves.get(l.id)
    if (!d) return l
    const transform: Transform = { ...l.transform, origin: [l.transform.origin[0] + d[0], l.transform.origin[1] + d[1]] }
    const maskPlacement = !l.mask ? l.maskPlacement : l.maskLinked ? (l.maskPlacement ? following(l.maskPlacement, l.transform, transform) : null) : l.maskPlacement ?? l.transform
    return { ...l, transform, maskPlacement }
  })
  store.commit(name, { doc: { ...store.doc, layers } })
}
