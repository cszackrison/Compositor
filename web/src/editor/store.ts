import { History, type PixelPatch } from '../model/history'
import { Raster } from '../model/raster'
import { type Adjustment, type AdjustmentKind, type BlendMode, type Doc, type EffectKind, effectNames, type Layer, type LayerEffects, type Transform, fullTransform, newAdjustment, newLayer, uuid } from '../model/types'
import { combine, contractSelection, coverageFromRaster, expandSelection, featherSelection, invertSelection, isEmpty, offsetSelection, type SelectionMode } from '../model/selection'
import { blurRaster } from '../model/pixels'
import type { PackageTarget } from '../io/files'
import type { BrushSettings } from '../tools/brush'
import { drawOrder, effectivelyVisible, following, pixelToDocument, transformCorners } from '../render/compositor'
import { apply, invert } from '../render/gl'
import { maskOnGrid } from '../model/masks'

export type Tool = 'move' | 'marquee' | 'lasso' | 'wand' | 'brush' | 'eraser' | 'heal' | 'clone' | 'smear' | 'gradient' | 'shape' | 'crop' | 'eyedropper' | 'hand' | 'zoom'
export type HealMode = 'Content-Aware' | 'Create Texture' | 'Proximity Match'
export type SmearMode = 'Liquify' | 'Blur' | 'Smudge'
export type ShapeKind = 'Rectangle' | 'Ellipse' | 'Line'
export type Tip = { diameter: number; hardness: number; opacity: number }
// Brush and Spot Healing share a tip; Clone Stamp and Smear each keep their own, as in the Mac app.
export const tipFamily = (tool: Tool) => tool === 'clone' ? 'clone' : tool === 'smear' ? 'smear' : tool === 'brush' || tool === 'eraser' || tool === 'heal' ? 'brush' : null
export type GridSettings = { spacing: number; subdivisions: number; color: [number, number, number]; style: 'Lines' | 'Dashed Lines' | 'Dots'; opacity: number }
export type Snapshot = { doc: Doc; activeId: string | null; selectedIds: string[]; selection: Raster | null; editingMask: boolean }

export type State = Snapshot & {
  tool: Tool
  marqueeShape: 'rect' | 'ellipse'
  lassoKind: 'freehand' | 'polygonal'
  wand: { tolerance: number; contiguous: boolean; sampleAll: boolean; sampleSize: number }
  // The selection tools' header: the sticky mode (Shift and Option override it) and anti-aliasing for new selections.
  selectionMode: SelectionMode
  selectionAntialias: boolean
  modifyAmounts: { expand: number; contract: number; feather: number }
  healMode: HealMode
  clone: { aligned: boolean; sampleAll: boolean; source: [number, number] | null; offset: [number, number] | null }
  smearMode: SmearMode
  blurRadius: number
  gradient: { shape: 'Linear' | 'Radial'; style: 'Foreground to Transparent' | 'Foreground to Background'; reversed: boolean; opacity: number }
  shape: { kind: ShapeKind; cornerRadius: number; lineWidth: number }
  crop: { ratio: string; rect: { x: number; y: number; w: number; h: number } | null }
  tips: Record<'brush' | 'clone' | 'smear', Tip>
  brush: BrushSettings
  foreground: [number, number, number]
  background: [number, number, number]
  target: PackageTarget | null
  saved: boolean
  revision: number
  pixelRevision: number
  message: { text: string; kind: 'error' | 'info' } | null
  inspector: string | null
  // The open filter or dialog panel, by name.
  panel: string | null
  // An effect row picked in the Layers panel, which Delete removes and the effect editor edits.
  effectSelection: { layerId: string; kind: EffectKind; isNew?: boolean; before?: unknown } | null
  // With a mask targeted the palette is black and white only: whether the foreground is white (reveal).
  maskPaintWhite: boolean
}

// Renders a document (or part of one) into premultiplied pixels; the canvas view supplies it once WebGL is up.
export type Renderer = (doc: Doc) => Raster

const emptyDoc: Doc = { id: '', width: 1, height: 1, resolution: 72, layers: [], guides: [], extra: {} }

export class Store {
  state: State = {
    doc: emptyDoc, activeId: null, selectedIds: [], selection: null, editingMask: false, tool: 'move', marqueeShape: 'rect', lassoKind: 'freehand',
    wand: { tolerance: 32, contiguous: true, sampleAll: false, sampleSize: 0 }, selectionMode: 'replace', selectionAntialias: true, modifyAmounts: { expand: 1, contract: 1, feather: 2 },
    brush: { diameter: 40, hardness: 1, opacity: 1, smoothing: 0, erasing: false },
    healMode: 'Content-Aware', clone: { aligned: true, sampleAll: false, source: null, offset: null }, smearMode: 'Liquify', blurRadius: 5,
    gradient: { shape: 'Linear', style: 'Foreground to Transparent', reversed: false, opacity: 1 }, shape: { kind: 'Rectangle', cornerRadius: 0, lineWidth: 4 }, crop: { ratio: 'Free', rect: null },
    tips: { brush: { diameter: 40, hardness: 1, opacity: 1 }, clone: { diameter: 40, hardness: 0, opacity: 1 }, smear: { diameter: 40, hardness: 0, opacity: 1 } },
    foreground: [0, 0, 0], background: [255, 255, 255], target: null, saved: true, revision: 0, pixelRevision: 0, message: null, inspector: null, panel: null, effectSelection: null, maskPaintWhite: false,
  }
  hasDocument = false
  history = new History<Snapshot>()
  static renderer: Renderer | null = null
  // Where this project's view was, restored when its tab comes back.
  view: { zoom: number; offsetX: number; offsetY: number } | null = null
  private listeners = new Set<() => void>()
  private coalesce: { key: string; at: number } | null = null

  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  getState = () => this.state
  private emit() { this.listeners.forEach(listener => listener()) }

  set(changes: Partial<State>) {
    this.state = { ...this.state, ...changes, revision: this.state.revision + 1 }
    this.emit()
  }
  pixelsChanged() { this.set({ pixelRevision: this.state.pixelRevision + 1, saved: false }) }
  notify(text: string, kind: 'error' | 'info' = 'error') {
    this.set({ message: { text, kind } })
    setTimeout(() => { if (this.state.message?.text === text) this.set({ message: null }) }, kind === 'error' ? 6000 : 2500)
  }

  snapshot(): Snapshot {
    const { doc, activeId, selectedIds, selection, editingMask } = this.state
    return { doc, activeId, selectedIds, selection, editingMask }
  }

  // Replaces the document state as one undoable step.
  commit(name: string, changes: Partial<Snapshot>, options: { patches?: PixelPatch[]; coalesce?: string } = {}) {
    const before = this.snapshot()
    this.set({ ...changes, saved: false })
    const after = this.snapshot()
    const now = performance.now()
    if (options.coalesce && this.coalesce?.key === options.coalesce && now - this.coalesce.at < 1500 && !options.patches?.length) {
      if (this.history.amendLast(after)) { this.coalesce.at = now; return }
    }
    this.coalesce = options.coalesce ? { key: options.coalesce, at: now } : null
    this.history.push({ name, before, after, patches: options.patches ?? [] })
    this.set({})
  }

  // Gestures nest, as the Mac's beginEdit/endEdit do: only the outermost one becomes an undo step, and cancelling restores where
  // the innermost began.
  private gestures: { before: Snapshot; name: string }[] = []
  private pendingPatches: PixelPatch[] = []
  beginGesture(name: string) { this.gestures.push({ before: this.snapshot(), name }) }
  endGesture(patches: PixelPatch[] = []) {
    const gesture = this.gestures.pop()
    if (!gesture) return
    if (this.gestures.length) { this.pendingPatches.push(...patches); return }
    const all = [...this.pendingPatches, ...patches]
    this.pendingPatches = []
    const { before, name } = gesture
    if (before.doc === this.state.doc && !all.length && before.selection === this.state.selection) return
    this.history.push({ name, before, after: this.snapshot(), patches: all })
    this.coalesce = null
    this.set({ saved: false })
  }
  cancelGesture() {
    const gesture = this.gestures.pop()
    if (!gesture) return
    if (!this.gestures.length) {
      for (const patch of [...this.pendingPatches].reverse()) patch.raster.write(patch.x, patch.y, patch.w, patch.h, patch.before)
      this.pendingPatches = []
    }
    this.set(gesture.before)
  }
  get inGesture() { return this.gestures.length > 0 }

  undo() {
    const entry = this.history.undo()
    if (!entry) return
    this.set({ ...entry.before, saved: false, pixelRevision: this.state.pixelRevision + 1 })
  }
  redo() {
    const entry = this.history.redo()
    if (!entry) return
    this.set({ ...entry.after, saved: false, pixelRevision: this.state.pixelRevision + 1 })
  }

  open(doc: Doc, activeId: string | null, target: PackageTarget | null) {
    this.history.clear()
    this.hasDocument = true
    this.set({ doc, activeId, selectedIds: activeId ? [activeId] : [], selection: null, editingMask: false, target, saved: true, inspector: null })
  }

  close() {
    this.hasDocument = false
    this.history.clear()
    this.set({ doc: emptyDoc, activeId: null, selectedIds: [], selection: null, target: null, saved: true })
  }

  // Layer queries

  get doc() { return this.state.doc }
  layer(id: string | null | undefined) { return id ? this.state.doc.layers.find(layer => layer.id === id) : undefined }
  get active() { return this.layer(this.state.activeId) }
  children(parentId: string | null) { return this.doc.layers.filter(layer => layer.parentId === parentId) }
  descendants(id: string): Layer[] {
    return this.children(id).flatMap(child => [child, ...(child.isGroup ? this.descendants(child.id) : [])])
  }
  ancestors(id: string): Layer[] {
    const out: Layer[] = []
    let parent = this.layer(this.layer(id)?.parentId)
    while (parent) { out.push(parent); parent = this.layer(parent.parentId) }
    return out
  }

  // Layer edits

  private replaceLayers(layers: Layer[]): Doc { return { ...this.doc, layers } }

  updateLayer(id: string, changes: Partial<Layer>, name = 'Change Layer', coalesce?: string) {
    this.commit(name, { doc: this.replaceLayers(this.doc.layers.map(layer => layer.id === id ? { ...layer, ...changes } : layer)) }, { coalesce: coalesce ? `${coalesce}:${id}` : undefined })
  }

  updateLayerLive(id: string, changes: Partial<Layer>) {
    this.set({ doc: this.replaceLayers(this.doc.layers.map(layer => layer.id === id ? { ...layer, ...changes } : layer)) })
  }

  // Picking another layer applies a pending floating selection first (set by the floating module).
  static beforeLayerChange: ((store: Store, next: string | null) => void) | null = null

  setActive(id: string | null, extend: 'none' | 'toggle' | 'range' = 'none') {
    Store.beforeLayerChange?.(this, id)
    let selectedIds = id ? [id] : []
    if (id && extend === 'toggle') selectedIds = this.state.selectedIds.includes(id) ? this.state.selectedIds.filter(x => x !== id) : [...this.state.selectedIds, id]
    if (id && extend === 'range' && this.state.activeId) {
      const ids = this.doc.layers.map(layer => layer.id), a = ids.indexOf(this.state.activeId), b = ids.indexOf(id)
      selectedIds = ids.slice(Math.min(a, b), Math.max(a, b) + 1)
    }
    const layer = this.layer(id)
    this.set({ activeId: id, selectedIds, editingMask: this.state.editingMask && !!layer?.mask && layer.id === this.state.activeId, inspector: layer?.adjustment ? layer.id : this.state.inspector === id ? id : null, effectSelection: null })
  }

  // Inserts above the active layer, in its folder, as the Mac app does.
  private insert(layers: Layer[], above = this.state.activeId): Layer[] {
    const all = [...this.doc.layers]
    const anchor = this.layer(above)
    const parentId = anchor?.parentId ?? null
    const placed = layers.map(layer => layers.some(l => l.id === layer.parentId) ? layer : { ...layer, parentId })
    let index = all.length
    if (anchor) {
      const subtree = anchor.isGroup ? this.descendants(anchor.id).map(l => l.id) : []
      index = Math.max(...[anchor.id, ...subtree].map(id => all.findIndex(l => l.id === id))) + 1
    }
    all.splice(index, 0, ...placed)
    return all
  }

  addLayer(layer: Layer, name = 'New Layer') {
    if (!this.hasDocument) return
    this.commit(name, { doc: this.replaceLayers(this.insert([layer])), activeId: layer.id, selectedIds: [layer.id], editingMask: false })
  }

  addBlankLayer() {
    const count = this.doc.layers.filter(l => !l.isGroup && !l.adjustment).length
    this.addLayer(newLayer({ name: `Layer ${count + 1}`, transform: fullTransform(this.doc.width, this.doc.height), image: new Raster(this.doc.width, this.doc.height, 4) }), 'New Layer')
  }

  addImageLayer(image: Raster, name: string) {
    const { width, height } = this.doc
    const fit = Math.min(1, width / image.width, height / image.height)
    const w = image.width * fit, h = image.height * fit
    this.addLayer(newLayer({ name, transform: fullTransform(w, h, Math.round((width - w) / 2), Math.round((height - h) / 2)), image }), 'Place Image')
  }

  addAdjustment(kind: AdjustmentKind) {
    const layer = newLayer({ name: kind, transform: fullTransform(this.doc.width, this.doc.height), adjustment: newAdjustment(kind) })
    this.addLayer(layer, `New ${kind} Layer`)
    this.set({ inspector: layer.id })
  }

  setAdjustment(id: string, adjustment: Adjustment) { this.updateLayer(id, { adjustment }, 'Change Adjustment', 'adjustment') }
  setEffects(id: string, effects: LayerEffects | null) { this.updateLayer(id, { effects }, 'Change Effects', 'effects') }

  // Effects, one at a time, as the Layers panel's effect rows edit them.
  addEffect(id: string, kind: EffectKind, effect: object) {
    const layer = this.layer(id)
    if (!layer?.image || layer.isGroup) return
    const existing = layer.effects?.[kind]
    if (!existing) this.updateLayer(id, { effects: { ...(layer.effects ?? {}), [kind]: effect } }, `Add ${effectNames[kind]}`)
    this.set({ activeId: id, selectedIds: [id], effectSelection: { layerId: id, kind, isNew: !existing, before: existing }, panel: 'Effect', editingMask: false })
  }

  removeEffect(id: string, kind: EffectKind, name = `Remove ${effectNames[kind]}`) {
    const layer = this.layer(id)
    if (!layer?.effects?.[kind]) return
    const effects = { ...layer.effects }
    delete effects[kind]
    this.updateLayer(id, { effects: Object.keys(effects).length ? effects : null }, name)
    if (this.state.effectSelection?.layerId === id && this.state.effectSelection.kind === kind) this.set({ effectSelection: null, panel: this.state.panel === 'Effect' ? null : this.state.panel })
  }

  copyEffect(from: string, kind: EffectKind, to: string) {
    const source = this.layer(from)?.effects?.[kind], target = this.layer(to)
    if (!source || !target?.image || target.isGroup || from === to) return
    this.updateLayer(to, { effects: { ...(target.effects ?? {}), [kind]: structuredClone(source) } }, `Copy ${effectNames[kind]}`)
    this.set({ activeId: to, selectedIds: [to], effectSelection: { layerId: to, kind } })
  }

  deleteSelected() {
    const picked = this.state.effectSelection
    if (picked) { this.removeEffect(picked.layerId, picked.kind); return }
    const ids = new Set(this.state.selectedIds.length ? this.state.selectedIds : this.state.activeId ? [this.state.activeId] : [])
    if (!ids.size) return
    if (this.state.editingMask && ids.size === 1 && this.active?.mask) { this.deleteMask(this.active.id); return }
    for (const id of [...ids]) for (const d of this.descendants(id)) ids.add(d.id)
    const remaining = this.doc.layers.filter(layer => !ids.has(layer.id)).map(layer => layer.clipTo && ids.has(layer.clipTo) ? { ...layer, clipTo: null } : layer)
    const removedIndex = this.doc.layers.findIndex(layer => ids.has(layer.id))
    const next = remaining[Math.min(removedIndex, remaining.length - 1)] ?? remaining.at(-1)
    this.commit(ids.size > 1 ? 'Delete Layers' : 'Delete Layer', { doc: this.replaceLayers(remaining), activeId: next?.id ?? null, selectedIds: next ? [next.id] : [], editingMask: false })
  }

  private cloneLayer(layer: Layer, ids: Map<string, string>): Layer {
    return { ...layer, id: ids.get(layer.id)!, parentId: layer.parentId && ids.has(layer.parentId) ? ids.get(layer.parentId)! : layer.parentId, clipTo: layer.clipTo && ids.has(layer.clipTo) ? ids.get(layer.clipTo)! : layer.clipTo, image: layer.image?.clone() ?? null, mask: layer.mask?.clone() ?? null, adjustment: layer.adjustment ? structuredClone(layer.adjustment) : null, effects: layer.effects ? structuredClone(layer.effects) : null }
  }

  // ⌘J and Option-drag (SelectionClipboard.duplicateLayers): every selected layer, folders with their contents, copied under fresh
  // IDs and named "… copy". One copy sits just above its original; several stack above the topmost original, in its folder.
  // A clipped layer copied with its base (inside the same folder) clips to the copy; on its own it stays clipped to the original.
  private duplicated() {
    const chosen = this.state.selectedIds.length ? this.state.selectedIds : this.state.activeId ? [this.state.activeId] : []
    const roots = this.doc.layers.filter(l => chosen.includes(l.id) && !this.ancestors(l.id).some(a => chosen.includes(a.id))).map(l => l.id)
    if (!roots.length) return null
    const families = roots.map(root => {
      const family = this.doc.layers.filter(l => l.id === root || this.descendants(root).some(d => d.id === l.id))
      const ids = new Map(family.map(l => [l.id, uuid()]))
      return { root, copy: ids.get(root)!, layers: family.map(l => l.id === root ? { ...this.cloneLayer(l, ids), name: `${l.name} copy` } : this.cloneLayer(l, ids)) }
    })
    const layers = [...this.doc.layers]
    const end = (id: string) => Math.max(...[id, ...this.descendants(id).map(d => d.id)].map(x => layers.findIndex(l => l.id === x))) + 1
    if (families.length === 1) layers.splice(end(roots[0]), 0, ...families[0].layers)
    else {
      const top = this.doc.layers.find(l => l.id === roots.at(-1))!
      layers.splice(end(top.id), 0, ...families.flatMap(f => f.layers.map(l => l.id === f.copy ? { ...l, parentId: top.parentId } : l)))
    }
    const copies = families.map(f => f.copy)
    const activeCopy = families.find(f => f.root === this.state.activeId)?.copy ?? copies.at(-1)!
    return { doc: this.replaceLayers(layers), activeId: activeCopy, selectedIds: copies }
  }

  duplicate() {
    const next = this.duplicated()
    if (next) this.commit(next.selectedIds.length > 1 ? 'Duplicate Layers' : 'Duplicate Layer', next)
  }

  // The same, within a gesture that's already recording (Option-drag).
  duplicateSelected() {
    const next = this.duplicated()
    if (next) this.set(next)
  }

  // Moves layers (with their folders' contents) to sit above `anchorId` in its folder, or into `intoId` at its top.
  move(ids: string[], target: { above?: string; below?: string; into?: string }) {
    const moving = new Set(ids)
    for (const id of ids) for (const d of this.descendants(id)) moving.add(d.id)
    const destination = target.into ?? target.above ?? target.below
    if (destination && moving.has(destination)) return
    const parentId = target.into ?? this.layer(target.above ?? target.below)?.parentId ?? null
    const block = this.doc.layers.filter(layer => moving.has(layer.id)).map(layer => ids.includes(layer.id) ? { ...layer, parentId } : layer)
    const rest = this.doc.layers.filter(layer => !moving.has(layer.id))
    let index: number
    if (target.into) {
      const subtree = [target.into, ...this.descendants(target.into).map(l => l.id)].filter(id => !moving.has(id))
      index = Math.max(...subtree.map(id => rest.findIndex(l => l.id === id))) + 1
    } else if (target.above) {
      const subtree = [target.above, ...(this.layer(target.above)?.isGroup ? this.descendants(target.above).map(l => l.id) : [])].filter(id => !moving.has(id))
      index = Math.max(...subtree.map(id => rest.findIndex(l => l.id === id))) + 1
    } else {
      const below = this.layer(target.below)!
      const subtree = [below.id, ...(below.isGroup ? this.descendants(below.id).map(l => l.id) : [])]
      index = Math.min(...subtree.map(id => rest.findIndex(l => l.id === id)))
    }
    rest.splice(index, 0, ...block)
    this.commit('Move Layer', { doc: this.replaceLayers(this.releaseBrokenClips(rest)) })
  }

  // Clipped layers moved out of the contiguous run above their base stay linked: the renderer falls back to plain coverage.
  private releaseBrokenClips(layers: Layer[]) {
    return layers.map(layer => layer.clipTo && !layers.some(l => l.id === layer.clipTo && !l.isGroup && !l.adjustment) ? { ...layer, clipTo: null } : layer)
  }

  stepLayer(direction: 1 | -1) {
    const layer = this.active
    if (!layer) return
    const siblings = this.children(layer.parentId)
    const index = siblings.findIndex(l => l.id === layer.id)
    const neighbor = siblings[index + direction]
    if (!neighbor) return
    this.move([layer.id], direction === 1 ? { above: neighbor.id } : { below: neighbor.id })
  }

  group() {
    const chosen = this.state.selectedIds.length ? this.state.selectedIds : this.state.activeId ? [this.state.activeId] : []
    const ids = chosen.filter(id => !this.ancestors(id).some(a => chosen.includes(a.id)))
    if (!ids.length) return
    const moving = new Set(ids)
    for (const id of ids) for (const d of this.descendants(id)) moving.add(d.id)
    const topmost = this.doc.layers.filter(l => ids.includes(l.id)).at(-1)!
    const folder = newLayer({ name: `Group ${this.doc.layers.filter(l => l.isGroup).length + 1}`, isGroup: true, transform: fullTransform(this.doc.width, this.doc.height), parentId: topmost.parentId })
    const block = this.doc.layers.filter(l => moving.has(l.id)).map(l => ids.includes(l.id) ? { ...l, parentId: folder.id } : l)
    const last = Math.max(...[...moving].map(id => this.doc.layers.findIndex(l => l.id === id)))
    const rest = this.doc.layers.filter(l => !moving.has(l.id))
    rest.splice(this.doc.layers.slice(0, last + 1).filter(l => !moving.has(l.id)).length, 0, folder, ...block)
    this.commit('Group Layers', { doc: this.replaceLayers(this.releaseBrokenClips(rest)), activeId: folder.id, selectedIds: [folder.id] })
  }

  ungroup() {
    const folder = this.active
    if (!folder?.isGroup) return
    const layers = this.doc.layers.filter(l => l.id !== folder.id).map(l => l.parentId === folder.id ? { ...l, parentId: folder.parentId, opacity: l.opacity * folder.opacity } : l)
    const first = this.children(folder.id)[0]
    this.commit('Ungroup Layers', { doc: this.replaceLayers(layers), activeId: first?.id ?? null, selectedIds: this.children(folder.id).map(l => l.id) })
  }

  moveOutOfFolder() {
    const layer = this.active
    if (!layer?.parentId) return
    this.move(this.state.selectedIds.length ? this.state.selectedIds.filter(id => this.layer(id)?.parentId === layer.parentId) : [layer.id], { above: layer.parentId })
  }

  toggleMaskLink(id: string) {
    const layer = this.layer(id)
    if (!layer?.mask || layer.isGroup || layer.adjustment) return
    this.updateLayer(id, { maskLinked: !layer.maskLinked }, layer.maskLinked ? 'Unlink Layer Mask' : 'Link Layer Mask')
  }

  get mergeTitle() {
    if (this.state.selectedIds.length > 1) return 'Merge Layers'
    return this.active?.isGroup ? 'Merge Group' : 'Merge Down'
  }

  get canMerge() {
    const layer = this.active
    if (!layer) return false
    if (this.state.selectedIds.length > 1 || layer.isGroup) return true
    const siblings = this.children(layer.parentId)
    const below = siblings[siblings.findIndex(l => l.id === layer.id) - 1]
    return !!below && !below.isGroup
  }

  // Clipping (toggleClippingMask): a clipped layer is released, with the clipped layers just above it that share its base; otherwise
  // it clips to the layer just below in its folder, sharing that layer's base when it's clipped itself.
  canToggleClipFor(id: string | null | undefined) {
    const layer = this.layer(id)
    if (!layer || layer.isGroup) return false
    if (layer.clipTo) return true
    const siblings = this.children(layer.parentId), below = siblings[siblings.findIndex(l => l.id === layer.id) - 1]
    if (!below || below.isGroup) return false
    const base = this.layer(below.clipTo ?? below.id)
    return !!base && !base.isGroup && !base.adjustment
  }
  get canToggleClip() { return this.canToggleClipFor(this.state.activeId) }

  toggleClip(id = this.state.activeId) {
    const layer = this.layer(id)
    if (!layer || layer.isGroup) return
    const siblings = this.children(layer.parentId), index = siblings.findIndex(l => l.id === layer.id)
    if (layer.clipTo) {
      const released = new Set([layer.id])
      for (const above of siblings.slice(index + 1)) { if (above.clipTo !== layer.clipTo) break; released.add(above.id) }
      this.commit('Release Clipping Mask', { doc: this.replaceLayers(this.doc.layers.map(l => released.has(l.id) ? { ...l, clipTo: null } : l)) })
      return
    }
    if (!this.canToggleClipFor(layer.id)) { this.notify('Clipping needs a layer with pixels directly below.'); return }
    const below = siblings[index - 1]
    this.updateLayer(layer.id, { clipTo: below.clipTo ?? below.id }, 'Create Clipping Mask')
  }

  // Masks

  addMask(id: string, hideAll = false, fromSelection = false) {
    const layer = this.layer(id)
    if (!layer || layer.mask) return
    const { width, height } = layer.image ?? { width: Math.max(1, Math.round(layer.transform.size[0])), height: Math.max(1, Math.round(layer.transform.size[1])) }
    let mask: Raster
    const selection = this.state.selection
    if (selection && fromSelection) {
      mask = new Raster(width, height, 1)
      const toDoc = pixelToDocument(layer.transform, width, height)
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const [dx, dy] = apply(toDoc, x + 0.5, y + 0.5)
        const sx = Math.floor(dx), sy = Math.floor(dy)
        mask.data[y * width + x] = sx >= 0 && sy >= 0 && sx < selection.width && sy < selection.height ? selection.data[sy * selection.width + sx] : 0
      }
    } else mask = Raster.filled(width, height, 1, [hideAll ? 0 : 255])
    this.commit('Add Layer Mask', { doc: this.replaceLayers(this.doc.layers.map(l => l.id === id ? { ...l, mask, maskEnabled: true, maskLinked: true, maskPlacement: null } : l)), editingMask: true, selection: fromSelection ? null : this.state.selection })
  }

  deleteMask(id: string, applyIt = false) {
    const layer = this.layer(id)
    if (!layer?.mask) return
    let image = layer.image
    if (applyIt && image) {
      image = image.clone()
      const mask = layer.mask
      // A mask with a placement of its own is read where it sits on the canvas; one on the layer's grid pixel for pixel.
      const placed = layer.maskPlacement && !layer.isGroup && !layer.adjustment ? maskOnGrid(mask, layer.maskPlacement, layer.transform, image.width, image.height) : null
      for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
        const m = placed ? placed[y * image.width + x] : mask.data[Math.min(mask.height - 1, Math.floor((y + 0.5) * mask.height / image.height)) * mask.width + Math.min(mask.width - 1, Math.floor((x + 0.5) * mask.width / image.width))] / 255
        const p = (y * image.width + x) * 4
        for (let c = 0; c < 4; c++) image.data[p + c] = Math.round(image.data[p + c] * m)
      }
    }
    this.commit(applyIt ? 'Apply Layer Mask' : 'Delete Layer Mask', { doc: this.replaceLayers(this.doc.layers.map(l => l.id === id ? { ...l, image, mask: null, maskPlacement: null, text: applyIt ? undefined : l.text, shape: applyIt ? undefined : l.shape } : l)), editingMask: false })
  }

  // The layer raster a pixel tool works on (its image or its mask), made full-size first if it's a 1×1 placeholder mask.
  editTarget(): { layer: Layer; raster: Raster; toDocument: ReturnType<typeof pixelToDocument>; isMask: boolean } | null {
    const layer = this.active
    if (!layer) return null
    if (this.state.editingMask && layer.mask) {
      let mask = layer.mask
      const expected = layer.image ?? { width: Math.max(1, Math.round(layer.transform.size[0])), height: Math.max(1, Math.round(layer.transform.size[1])) }
      if ((mask.width !== expected.width || mask.height !== expected.height) && mask.isUniform() && !layer.maskPlacement) {
        mask = Raster.filled(expected.width, expected.height, 1, [mask.data[0]])
        this.updateLayerLive(layer.id, { mask })
      }
      const placement = layer.maskPlacement && !layer.isGroup && !layer.adjustment ? layer.maskPlacement : layer.transform
      return { layer: this.layer(layer.id)!, raster: mask, toDocument: pixelToDocument(placement, mask.width, mask.height), isMask: true }
    }
    if (layer.adjustment || layer.isGroup) return null
    if (!layer.image) {
      const image = new Raster(this.doc.width, this.doc.height, 4)
      this.updateLayerLive(layer.id, { image, transform: fullTransform(this.doc.width, this.doc.height) })
    }
    const current = this.layer(layer.id)!
    return { layer: current, raster: current.image!, toDocument: pixelToDocument(current.transform, current.image!.width, current.image!.height), isMask: false }
  }

  // Selection

  setSelection(next: Raster | null, mode: SelectionMode = 'replace', name = 'Select') {
    if (mode === 'subtract' && !this.state.selection) return
    const combined = next ? combine(this.state.selection, next, mode) : null
    this.commit(name, { selection: combined && !isEmpty(combined) ? combined : null })
  }
  selectAll() { this.setSelection(Raster.filled(this.doc.width, this.doc.height, 1, [255]), 'replace', 'Select All') }
  deselect() { if (this.state.selection) this.commit('Deselect', { selection: null }) }

  modifySelection(kind: 'expand' | 'contract' | 'feather', amount: number) {
    const selection = this.state.selection
    if (!selection) return
    const next = kind === 'expand' ? expandSelection(selection, amount) : kind === 'contract' ? contractSelection(selection, amount) : featherSelection(selection, amount, (r, sigma) => blurRaster(r, sigma, true))
    this.commit(kind === 'expand' ? 'Expand Selection' : kind === 'contract' ? 'Contract Selection' : 'Feather Selection', { selection: isEmpty(next) ? null : next })
  }

  // ⌘-click a thumbnail: a layer's opaque pixels, or a mask's hidden areas, become the selection (⇧ adds, ⌥ subtracts).
  loadSelection(id: string, fromMask: boolean, mode: SelectionMode = 'replace') {
    const layer = this.layer(id)
    const raster = fromMask ? layer?.mask : layer?.image
    if (!layer || !raster || layer.isGroup && !fromMask) return
    const placement = fromMask && layer.maskPlacement && !layer.isGroup && !layer.adjustment ? layer.maskPlacement : layer.transform
    const coverage = coverageFromRaster(raster, pixelToDocument(placement, raster.width, raster.height), this.doc.width, this.doc.height, fromMask)
    if (isEmpty(coverage) && mode === 'replace') { this.notify('There is nothing there to select.'); return }
    this.setSelection(coverage, mode, fromMask ? 'Load Mask Selection' : 'Load Layer Selection')
  }

  moveSelectionBy(dx: number, dy: number, live = false) {
    const selection = this.state.selection
    if (!selection) return
    const moved = offsetSelection(selection, dx, dy)
    if (live) this.set({ selection: moved })
    else this.commit('Move Selection', { selection: moved }, { coalesce: 'move-selection' })
  }

  invertSelection() { this.commit('Inverse Selection', { selection: this.state.selection ? invertSelection(this.state.selection) : null }) }

  // Fills or clears the selection (or everything) on the edit target.
  fill(color: [number, number, number] | null) {
    const target = this.editTarget()
    if (!target) return
    const { raster, toDocument, layer, isMask } = target
    const before = raster.data.slice()
    const selection = this.state.selection
    const gray = Math.round(color ? 0.299 * color[0] + 0.587 * color[1] + 0.114 * color[2] : 0)
    for (let y = 0; y < raster.height; y++) for (let x = 0; x < raster.width; x++) {
      let a = 1
      if (selection) {
        const [dx, dy] = apply(toDocument, x + 0.5, y + 0.5)
        const sx = Math.floor(dx), sy = Math.floor(dy)
        a = sx >= 0 && sy >= 0 && sx < selection.width && sy < selection.height ? selection.data[sy * selection.width + sx] / 255 : 0
      }
      if (a <= 0) continue
      const i = y * raster.width + x
      if (isMask) { raster.data[i] = Math.round(gray * a + raster.data[i] * (1 - a)); continue }
      const p = i * 4
      for (let c = 0; c < 4; c++) raster.data[p + c] = Math.round((color ? (c === 3 ? 255 : color[c]) : 0) * a + raster.data[p + c] * (1 - a))
    }
    raster.touch()
    const patch: PixelPatch = { raster, x: 0, y: 0, w: raster.width, h: raster.height, before, after: raster.data.slice() }
    this.commit(isMask ? 'Fill Mask' : color ? 'Fill' : 'Clear', { doc: this.replaceLayers(this.doc.layers.map(l => l.id === layer.id ? { ...l, text: isMask ? l.text : undefined, shape: isMask ? l.shape : undefined } : l)) }, { patches: [patch] })
    this.pixelsChanged()
  }

  invertPixels() {
    const target = this.editTarget()
    if (!target) return
    const { raster, layer, isMask } = target
    const before = raster.data.slice()
    if (isMask) for (let i = 0; i < raster.data.length; i++) raster.data[i] = 255 - raster.data[i]
    else for (let i = 0; i < raster.data.length; i += 4) { const a = raster.data[i + 3]; raster.data[i] = a - raster.data[i]; raster.data[i + 1] = a - raster.data[i + 1]; raster.data[i + 2] = a - raster.data[i + 2] }
    raster.touch()
    this.commit(isMask ? 'Invert Mask' : 'Invert', { doc: this.replaceLayers(this.doc.layers.map(l => l.id === layer.id ? { ...l, text: isMask ? l.text : undefined, shape: isMask ? l.shape : undefined } : l)) }, { patches: [{ raster, x: 0, y: 0, w: raster.width, h: raster.height, before, after: raster.data.slice() }] })
    this.pixelsChanged()
  }

  // Merging flattens through the renderer, so blend modes, masks, clips and adjustments come out as they look.
  merge(ids: string[], name: string) {
    if (!Store.renderer || ids.length < 1) return
    const members = new Set(ids)
    for (const id of ids) for (const d of this.descendants(id)) members.add(d.id)
    const layers = this.doc.layers.filter(l => members.has(l.id)).map(l => ({ ...l, parentId: l.parentId && members.has(l.parentId) ? l.parentId : null, clipTo: l.clipTo && members.has(l.clipTo) ? l.clipTo : null }))
    const image = Store.renderer({ ...this.doc, layers })
    const top = this.doc.layers.filter(l => ids.includes(l.id)).at(-1)!
    const bottom = this.doc.layers.filter(l => ids.includes(l.id))[0]
    const merged = newLayer({ name: top.isGroup ? top.name : bottom.name, transform: fullTransform(this.doc.width, this.doc.height), image, parentId: bottom.parentId })
    const remaining = this.doc.layers.flatMap(l => l.id === bottom.id ? [merged] : members.has(l.id) ? [] : [l])
    this.commit(name, { doc: this.replaceLayers(this.releaseBrokenClips(remaining)), activeId: merged.id, selectedIds: [merged.id], editingMask: false })
  }

  mergeDown() {
    const layer = this.active
    if (!layer) return
    if (this.state.selectedIds.length > 1) { this.merge(this.state.selectedIds, 'Merge Layers'); return }
    if (layer.isGroup) { this.merge([layer.id], 'Merge Group'); return }
    const siblings = this.children(layer.parentId)
    const below = siblings[siblings.findIndex(l => l.id === layer.id) - 1]
    if (!below || below.isGroup) { this.notify('There is no layer below to merge into.'); return }
    this.merge([below.id, layer.id], 'Merge Down')
  }

  // A new transform for a layer from the Move tool's fields: a linked mask with a placement of its own goes with it, an unlinked
  // one stays where it is (as dragging does).
  setTransform(id: string, transform: Transform, name: string, coalesce?: string) {
    const layer = this.layer(id)
    if (!layer) return
    const maskPlacement = !layer.mask ? layer.maskPlacement : layer.maskLinked ? (layer.maskPlacement ? following(layer.maskPlacement, layer.transform, transform) : null) : layer.maskPlacement ?? layer.transform
    this.updateLayer(id, { transform, maskPlacement }, name, coalesce)
  }

  // Flips the selected layer about its own middle, or several selected layers (or a folder's contents) about the middle of the
  // box around them (LayerFlip.swift): each is mirrored, its angle turning the other way. A linked mask flips with its layer; an
  // unlinked one stays where it is.
  flipLayer(axis: 'x' | 'y') {
    const ids = new Set<string>()
    for (const id of this.state.selectedIds.length ? this.state.selectedIds : this.state.activeId ? [this.state.activeId] : []) {
      const layer = this.layer(id)
      if (!layer) continue
      if (!layer.isGroup) ids.add(id)
      for (const d of this.descendants(id)) if (!d.isGroup) ids.add(d.id)
    }
    const members = this.doc.layers.filter(l => ids.has(l.id))
    if (!members.length) return
    const corners = members.flatMap(l => transformCorners(l.transform)), along = axis === 'x' ? 0 : 1
    const middle = members.length === 1 ? members[0].transform.origin[along] + members[0].transform.size[along] / 2 : (Math.min(...corners.map(c => c[along])) + Math.max(...corners.map(c => c[along]))) / 2
    const mirrored = (t: Transform): Transform => {
      const origin: [number, number] = [...t.origin]
      origin[along] = 2 * middle - (t.origin[along] + t.size[along] / 2) - t.size[along] / 2
      return axis === 'x' ? { ...t, origin, rotation: -t.rotation, flipX: !t.flipX } : { ...t, origin, rotation: -t.rotation, flipY: !t.flipY }
    }
    const layers = this.doc.layers.map(l => {
      if (!ids.has(l.id)) return l
      const transform = mirrored(l.transform)
      if (!l.mask) return { ...l, transform }
      const maskPlacement = l.maskLinked ? (l.maskPlacement ? following(l.maskPlacement, l.transform, transform) : null) : l.maskPlacement ?? l.transform
      return { ...l, transform, maskPlacement }
    })
    this.commit(axis === 'x' ? 'Flip Horizontal' : 'Flip Vertical', { doc: this.replaceLayers(layers) })
  }

  // Crops the canvas to a document rectangle; layers keep their pixels and shift.
  resizeCanvas(width: number, height: number, offsetX: number, offsetY: number, name = 'Canvas Size') {
    const shift = (t: Transform): Transform => ({ ...t, origin: [t.origin[0] + offsetX, t.origin[1] + offsetY] })
    const layers = this.doc.layers.map(l => ({ ...l, transform: l.isGroup || l.adjustment ? { ...fullTransform(width, height), sampling: l.transform.sampling, ...(l.mask ? shift(l.transform) : {}) } : shift(l.transform), maskPlacement: l.maskPlacement ? shift(l.maskPlacement) : null }))
    this.commit(name, { doc: { ...this.doc, width, height, layers, guides: this.doc.guides.map(g => ({ ...g, position: g.position + (g.axis === 'vertical' ? offsetX : offsetY) })) }, selection: null })
    this.pixelsChanged()
  }

  // Image Size (ImageResizer.swift): every layer is redrawn into an upright box scaled by the new size; guides scale too. Unlike
  // the Mac app, layer effects are kept, their sizes scaled with the image; text and shape metadata go with the old pixels.
  imageSize(width: number, height: number, resolution: number, sampling: Transform['sampling'], resample: boolean) {
    const doc = this.doc
    if (!resample || (width === doc.width && height === doc.height)) { this.commit('Image Size', { doc: { ...doc, resolution } }); return }
    const sx = width / doc.width, sy = height / doc.height
    const bake = (raster: Raster, t: Transform) => {
      const corners = [[0, 0], [1, 0], [1, 1], [0, 1]].map(([u, v]) => apply(pixelToDocument(t, 1, 1), u, v)).map(([x, y]) => [x * sx, y * sy])
      const left = Math.floor(Math.min(...corners.map(c => c[0]))), top = Math.floor(Math.min(...corners.map(c => c[1])))
      const w = Math.max(1, Math.ceil(Math.max(...corners.map(c => c[0]))) - left), h = Math.max(1, Math.ceil(Math.max(...corners.map(c => c[1]))) - top)
      const toSource = invert(pixelToDocument(t, raster.width, raster.height))
      const out = new Raster(w, h, raster.channels), c = raster.channels
      const nearest = sampling === 'Nearest'
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const [qx, qy] = apply(toSource, (x + left + 0.5) / sx, (y + top + 0.5) / sy)
        if (qx < 0 || qy < 0 || qx >= raster.width || qy >= raster.height) continue
        const i = (y * w + x) * c
        if (nearest) { const s = (Math.floor(qy) * raster.width + Math.floor(qx)) * c; for (let k = 0; k < c; k++) out.data[i + k] = raster.data[s + k]; continue }
        // A box filter over the source pixels each new pixel covers when shrinking; the nearest one when enlarging.
        const rx = Math.max(0.5, 0.5 * raster.width / t.size[0] / sx), ry = Math.max(0.5, 0.5 * raster.height / t.size[1] / sy)
        const sum = [0, 0, 0, 0]
        let n = 0
        for (let yy = Math.floor(qy - ry + 0.5); yy <= Math.floor(qy + ry - 0.5); yy++) for (let xx = Math.floor(qx - rx + 0.5); xx <= Math.floor(qx + rx - 0.5); xx++) {
          const px = Math.min(raster.width - 1, Math.max(0, xx)), py = Math.min(raster.height - 1, Math.max(0, yy)), s = (py * raster.width + px) * c
          for (let k = 0; k < c; k++) sum[k] += raster.data[s + k]
          n++
        }
        for (let k = 0; k < c; k++) out.data[i + k] = Math.round(sum[k] / n)
      }
      return { raster: out, transform: { origin: [left, top], size: [w, h], rotation: 0, flipX: false, flipY: false, sampling } as Transform }
    }
    const scaleEffects = (effects: Layer['effects']) => {
      if (!effects) return effects
      const f = Math.sqrt(sx * sy), out: any = structuredClone(effects)
      for (const effect of Object.values(out) as any[]) for (const key of ['size', 'distance', 'blur']) if (key in effect) effect[key] *= f
      return out
    }
    const layers = doc.layers.map(l => {
      if (l.isGroup || l.adjustment) {
        const transform = { ...fullTransform(width, height), sampling: l.transform.sampling }
        return { ...l, transform, mask: l.mask && !l.mask.isUniform() ? bake(l.mask, l.transform).raster : l.mask }
      }
      if (!l.image) return { ...l, transform: { ...l.transform, origin: [l.transform.origin[0] * sx, l.transform.origin[1] * sy] as [number, number], size: [l.transform.size[0] * sx, l.transform.size[1] * sy] as [number, number] } }
      const baked = bake(l.image, l.transform)
      const mask = l.mask && !l.maskPlacement && !l.mask.isUniform() ? bake(l.mask, l.transform).raster : l.mask
      const maskPlacement = l.maskPlacement ? { ...l.maskPlacement, origin: [l.maskPlacement.origin[0] * sx, l.maskPlacement.origin[1] * sy] as [number, number], size: [l.maskPlacement.size[0] * sx, l.maskPlacement.size[1] * sy] as [number, number] } : null
      return { ...l, image: baked.raster, transform: baked.transform, mask, maskPlacement, effects: scaleEffects(l.effects), text: undefined, shape: undefined }
    })
    const guides = doc.guides.map(g => ({ ...g, position: g.position * (g.axis === 'vertical' ? sx : sy) }))
    this.commit('Image Size', { doc: { ...doc, width, height, resolution, layers, guides }, selection: null })
    this.pixelsChanged()
  }

  // Trim (ImageTrim.swift): crops the canvas to what isn't transparent, or isn't the top-left or bottom-right pixel's color.
  trim(basis: 'transparent' | 'topLeft' | 'bottomRight', sides: { top: boolean; bottom: boolean; left: boolean; right: boolean }) {
    if (!Store.renderer) return
    const pixels = Store.renderer(this.doc), { width, height, data } = pixels
    const sample = basis === 'topLeft' ? 0 : (width * height - 1) * 4
    const differs = (i: number) => basis === 'transparent' ? data[i * 4 + 3] > 0 : [0, 1, 2, 3].some(c => data[i * 4 + c] !== data[sample + c])
    let x0 = width, y0 = height, x1 = -1, y1 = -1
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (differs(y * width + x)) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; y1 = y }
    if (x1 < 0) { this.notify('There is nothing to trim to.', 'info'); return }
    const left = sides.left ? x0 : 0, top = sides.top ? y0 : 0, right = sides.right ? x1 + 1 : width, bottom = sides.bottom ? y1 + 1 : height
    if (left === 0 && top === 0 && right === width && bottom === height) return
    this.resizeCanvas(right - left, bottom - top, -left, -top, 'Trim')
  }

  // Flip Canvas: every layer, mask and guide mirrored across the canvas.
  flipCanvas(axis: 'x' | 'y') {
    const { width, height } = this.doc
    const mirror = (t: Transform): Transform => axis === 'x'
      ? { ...t, origin: [width - t.origin[0] - t.size[0], t.origin[1]], rotation: -t.rotation, flipX: !t.flipX }
      : { ...t, origin: [t.origin[0], height - t.origin[1] - t.size[1]], rotation: -t.rotation, flipY: !t.flipY }
    const layers = this.doc.layers.map(l => ({ ...l, transform: mirror(l.transform), maskPlacement: l.maskPlacement ? mirror(l.maskPlacement) : null }))
    const guides = this.doc.guides.map(g => (axis === 'x') === (g.axis === 'vertical') ? { ...g, position: (axis === 'x' ? width : height) - g.position } : g)
    this.commit(axis === 'x' ? 'Flip Canvas Horizontal' : 'Flip Canvas Vertical', { doc: { ...this.doc, layers, guides }, selection: null })
  }

  cropToSelection() {
    const selection = this.state.selection
    if (!selection) return
    let minX = selection.width, minY = selection.height, maxX = -1, maxY = -1
    for (let y = 0; y < selection.height; y++) for (let x = 0; x < selection.width; x++) if (selection.data[y * selection.width + x]) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y) }
    if (maxX < 0) return
    this.resizeCanvas(maxX - minX + 1, maxY - minY + 1, -minX, -minY, 'Crop')
  }

  // Visible layers with pixels under a document point, topmost first in drawing order.
  layersAt(x: number, y: number): Layer[] {
    return drawOrder(this.doc).filter(effectivelyVisible).reverse().map(entry => entry.layer).filter(layer => {
      if (!layer.image || layer.isGroup) return false
      const [px, py] = apply(invert(pixelToDocument(layer.transform, layer.image.width, layer.image.height)), x, y)
      const ix = Math.floor(px), iy = Math.floor(py)
      return ix >= 0 && iy >= 0 && ix < layer.image.width && iy < layer.image.height && layer.image.data[(iy * layer.image.width + ix) * 4 + 3] > 10
    })
  }

  // The layers with the selection moved by (dx, dy) from `originals`: folders carry their contents, linked masks follow and
  // unlinked masks stay where they are, taking the layer's old place as their own.
  movedLayers(dx: number, dy: number, originals?: Map<string, Layer>): Layer[] {
    const ids = new Set(this.state.selectedIds.length ? this.state.selectedIds : this.state.activeId ? [this.state.activeId] : [])
    for (const id of [...ids]) for (const d of this.descendants(id)) ids.add(d.id)
    const shift = (t: Transform): Transform => ({ ...t, origin: [t.origin[0] + dx, t.origin[1] + dy] })
    return this.doc.layers.map(layer => {
      const original = originals?.get(layer.id) ?? layer
      if (!ids.has(layer.id)) return layer
      const staying = original.mask && !original.maskLinked && !original.isGroup && !original.adjustment ? original.maskPlacement ?? original.transform : null
      return { ...layer, transform: shift(original.transform), maskPlacement: staying ?? (original.maskPlacement ? shift(original.maskPlacement) : null) }
    })
  }

  // The palette's color for painting: on a mask, black or white (white reveals); otherwise the foreground or background color.
  paletteColor(which: 'foreground' | 'background'): [number, number, number] {
    if (this.state.editingMask) { const white = this.state.maskPaintWhite !== (which === 'background'); return white ? [255, 255, 255] : [0, 0, 0] }
    return this.state[which]
  }
  swapColors() { if (this.state.editingMask) this.set({ maskPaintWhite: !this.state.maskPaintWhite }); else this.set({ foreground: this.state.background, background: this.state.foreground }) }
  resetColors() { if (this.state.editingMask) this.set({ maskPaintWhite: false }); else this.set({ foreground: [0, 0, 0], background: [255, 255, 255] }) }

  // Switching tools parks the current tip in its family and brings back the new family's.
  setTool(tool: Tool) {
    const { brush, tips } = this.state
    const from = tipFamily(this.state.tool), to = tipFamily(tool)
    const parked = from ? { ...tips, [from]: { diameter: brush.diameter, hardness: brush.hardness, opacity: brush.opacity } } : tips
    const restored = to && to !== from ? { ...brush, ...parked[to] } : brush
    this.set({ tool, tips: parked, brush: { ...restored, erasing: tool === 'eraser' } })
  }

  setBlend(id: string, blendMode: BlendMode) { this.updateLayer(id, { blendMode }, 'Blend Mode') }
}

// Each open project is a tab with its own store; `store` is always the active one (a live binding, so importers follow it).
export let store = new Store()
export const tabs: Store[] = [store]
const tabListeners = new Set<() => void>()
export const tabsVersion = { value: 0 }
export function subscribeTabs(listener: () => void) { tabListeners.add(listener); return () => { tabListeners.delete(listener) } }
function tabsChanged() { tabsVersion.value++; tabListeners.forEach(listener => listener()) }

export function activateTab(next: Store) {
  if (next === store) return
  Store.beforeLayerChange?.(store, null)
  store = next
  tabsChanged()
}

// A tab for a project about to open: the current one if it's empty, otherwise a new one after it.
export function tabForOpening(): Store {
  if (!store.hasDocument) return store
  const next = new Store()
  next.state = { ...next.state, tool: store.state.tool, brush: store.state.brush, foreground: store.state.foreground, background: store.state.background }
  tabs.splice(tabs.indexOf(store) + 1, 0, next)
  activateTab(next)
  return next
}

export function closeTab(target: Store) {
  const index = tabs.indexOf(target)
  if (index < 0) return
  if (tabs.length === 1) { target.close(); tabsChanged(); return }
  tabs.splice(index, 1)
  if (target === store) activateTab(tabs[Math.min(index, tabs.length - 1)])
  else tabsChanged()
}

export function moveTab(from: number, to: number) {
  const [moved] = tabs.splice(from, 1)
  tabs.splice(to, 0, moved)
  tabsChanged()
}
