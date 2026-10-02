import { Store, store, tabs } from './store'
import { Raster, encodePNG, decodeImageFile } from '../model/raster'
import { bounds, offsetSelection } from '../model/selection'
import { type Layer, fullTransform, newLayer, uuid } from '../model/types'
import { pixelToDocument } from '../render/compositor'
import { apply, invert } from '../render/gl'
import { grownTransform, placeOnGrid } from './filters'
import { padMask } from './floating'

// The app's own clipboard, shared by every tab: copied pixels keep where they came from, copied layers stay whole. A PNG of copied
// pixels also goes to the system clipboard; a paste that brings back that same PNG uses the richer copy kept here.
type Clip = { kind: 'pixels'; pixels: Raster; origin: [number, number]; pngSize: number } | { kind: 'layers'; layers: Layer[]; from: Store; ids: string[] }
let clip: Clip | null = null

// A layer's own pixels drawn through its transform onto the canvas (no mask, opacity, blend mode or effects), or its mask as gray.
function layerOnCanvas(layer: Layer, mask: boolean): Raster {
  const doc = store.doc
  if (mask && layer.mask) {
    const out = new Raster(doc.width, doc.height, 4)
    const placement = layer.maskPlacement && !layer.isGroup && !layer.adjustment ? layer.maskPlacement : layer.transform
    const toMask = invert(pixelToDocument(placement, layer.mask.width, layer.mask.height))
    for (let y = 0; y < doc.height; y++) for (let x = 0; x < doc.width; x++) {
      const [mx, my] = apply(toMask, x + 0.5, y + 0.5), sx = Math.floor(mx), sy = Math.floor(my)
      const v = sx >= 0 && sy >= 0 && sx < layer.mask.width && sy < layer.mask.height ? layer.mask.data[sy * layer.mask.width + sx] : 0
      out.data.set([v, v, v, 255], (y * doc.width + x) * 4)
    }
    return out
  }
  return Store.renderer!({ ...doc, layers: [{ ...layer, parentId: null, clipTo: null, opacity: 1, blendMode: 'Normal', visible: true, effects: null, mask: null }] })
}

// The selection's region of `pixels` (canvas-sized), faded by its coverage; the whole canvas without a selection.
function selectedRegion(pixels: Raster): { pixels: Raster; origin: [number, number] } | null {
  const selection = store.state.selection
  const box = selection ? bounds(selection) : { x: 0, y: 0, w: pixels.width, h: pixels.height }
  if (!box) return null
  const out = new Raster(box.w, box.h, 4, pixels.read(box.x, box.y, box.w, box.h))
  if (selection) for (let y = 0; y < box.h; y++) for (let x = 0; x < box.w; x++) {
    const k = selection.data[(y + box.y) * selection.width + x + box.x] / 255, p = (y * box.w + x) * 4
    for (let c = 0; c < 4; c++) out.data[p + c] = Math.round(out.data[p + c] * k)
  }
  return { pixels: out, origin: [box.x, box.y] }
}

async function toSystemClipboard(pixels: Raster) {
  const png = encodePNG(pixels)
  try { await navigator.clipboard.write([new ClipboardItem({ 'image/png': new Blob([png as Uint8Array<ArrayBuffer>], { type: 'image/png' }) })]) } catch { /* not allowed here; the app clipboard still has it */ }
  return png.length
}

export async function copy(merged = false) {
  const layer = store.active
  if (!merged && !store.state.selection && !store.state.editingMask) {
    if (!layer) return
    const ids = store.state.selectedIds.length ? store.state.selectedIds : [layer.id]
    clip = { kind: 'layers', layers: [], from: store, ids: ids.filter(id => !store.ancestors(id).some(a => ids.includes(a.id))) }
    clip.layers = clip.ids.flatMap(id => [store.layer(id)!, ...store.descendants(id)])
    store.notify(clip.ids.length > 1 ? `Copied ${clip.ids.length} layers` : `Copied ${layer.name}`, 'info')
    return
  }
  const source = merged ? Store.renderer!(store.doc) : layer ? layerOnCanvas(layer, store.state.editingMask) : null
  if (!source) return
  const region = selectedRegion(source)
  if (!region) return
  clip = { kind: 'pixels', ...region, pngSize: 0 }
  clip.pngSize = await toSystemClipboard(region.pixels)
}

export async function cut() {
  if (!store.state.selection) { store.notify('Make a selection to cut.'); return }
  await copy()
  store.fill(store.state.editingMask ? store.state.background : null)
  store.history.renameLast(store.state.editingMask ? 'Fill Mask' : 'Clear')
}

function pastePixels(pixels: Raster, origin: [number, number] | null, name = 'Paste') {
  const doc = store.doc
  const at = origin ?? [Math.floor((doc.width - pixels.width) / 2), Math.floor((doc.height - pixels.height) / 2)]
  const count = doc.layers.filter(l => /^Layer \d+$/.test(l.name)).length + 1
  store.addLayer(newLayer({ name: `Layer ${count}`, transform: fullTransform(pixels.width, pixels.height, at[0], at[1]), image: pixels }), name)
  store.set({ selection: null })
}

// Copies of `layers` (with their folders' contents) under fresh IDs, clips that lost their base released.
export function cloneLayers(layers: Layer[]): Layer[] {
  const ids = new Map(layers.map(l => [l.id, uuid()]))
  return layers.map(l => ({ ...l, id: ids.get(l.id)!, parentId: l.parentId && ids.has(l.parentId) ? ids.get(l.parentId)! : null, clipTo: l.clipTo && ids.has(l.clipTo) ? ids.get(l.clipTo)! : null, image: l.image?.clone() ?? null, mask: l.mask?.clone() ?? null, adjustment: l.adjustment ? structuredClone(l.adjustment) : null, effects: l.effects ? structuredClone(l.effects) : null }))
}

// Layers from another project, centered on this canvas (or on `at`), on top of the stack, as one undo step.
export function copyLayersInto(target: Store, layers: Layer[], name = 'Copy Layers from Project', at?: [number, number]) {
  const copies = cloneLayers(layers)
  const placed = copies.filter(l => !l.isGroup && (l.image || l.mask))
  const corners = placed.flatMap(l => [[0, 0], [1, 1], [1, 0], [0, 1]].map(([u, v]) => apply(pixelToDocument(l.transform, 1, 1), u, v)))
  const center: [number, number] = corners.length ? [(Math.min(...corners.map(c => c[0])) + Math.max(...corners.map(c => c[0]))) / 2, (Math.min(...corners.map(c => c[1])) + Math.max(...corners.map(c => c[1]))) / 2] : [0, 0]
  const goal = at ?? [target.doc.width / 2, target.doc.height / 2]
  const dx = Math.round(goal[0] - center[0]), dy = Math.round(goal[1] - center[1])
  const moved = copies.map(l => l.isGroup || l.adjustment ? l : { ...l, transform: { ...l.transform, origin: [l.transform.origin[0] + dx, l.transform.origin[1] + dy] as [number, number] }, maskPlacement: l.maskPlacement ? { ...l.maskPlacement, origin: [l.maskPlacement.origin[0] + dx, l.maskPlacement.origin[1] + dy] as [number, number] } : null })
  const roots = moved.filter(l => !l.parentId || !moved.some(m => m.id === l.parentId)).map(l => l.id)
  target.commit(name, { doc: { ...target.doc, layers: [...target.doc.layers, ...moved] }, activeId: roots.at(-1) ?? null, selectedIds: roots })
}

export async function paste(event?: ClipboardEvent) {
  const file = event?.clipboardData ? [...event.clipboardData.files].find(f => f.type.startsWith('image/')) : undefined
  // An image on the clipboard that isn't the one we put there came from elsewhere: it wins.
  if (file && !(clip?.kind === 'pixels' && file.size === clip.pngSize)) {
    const image = await decodeImageFile(file)
    if (!store.hasDocument) { const { placeImages } = await import('./actions'); await placeImages([file]); return }
    pastePixels(image, null)
    return
  }
  if (!clip) {
    if (!event) { const { pasteImage } = await import('./actions'); await pasteImage(); return }
    return
  }
  if (!store.hasDocument) return
  if (clip.kind === 'pixels') { pastePixels(clip.pixels.clone(), clip.origin); return }
  if (clip.from === store && clip.ids.every(id => store.layer(id))) {
    const originals = clip.ids.flatMap(id => [store.layer(id)!, ...store.descendants(id)])
    const copies = cloneLayers(originals)
    const roots = copies.filter(l => !l.parentId || !copies.some(m => m.id === l.parentId))
    const top = store.doc.layers.filter(l => clip!.kind === 'layers' && clip!.ids.includes(l.id)).at(-1)!
    const layers = [...store.doc.layers]
    const subtree = [top.id, ...store.descendants(top.id).map(l => l.id)]
    layers.splice(Math.max(...subtree.map(id => layers.findIndex(l => l.id === id))) + 1, 0, ...copies.map(c => roots.includes(c) ? { ...c, parentId: top.parentId } : c))
    store.commit('Paste', { doc: { ...store.doc, layers }, activeId: roots.at(-1)!.id, selectedIds: roots.map(r => r.id) })
    return
  }
  if (tabs.includes(clip.from) || clip.layers.length) copyLayersInto(store, clip.layers)
}

// ⌘J with a selection: the selected pixels (or mask) as a new layer at the same place.
export function layerViaCopy() {
  const layer = store.active
  if (!layer || !store.state.selection || layer.isGroup) { store.duplicate(); return }
  const region = selectedRegion(layerOnCanvas(layer, store.state.editingMask))
  if (!region) return
  pastePixels(region.pixels, region.origin, 'Layer via Copy')
}

// ⌘-drag with a selection tool: the selected pixels of the active layer, lifted and moved by a whole number of document pixels.
// `duplicate` leaves the originals in place. Returns a function that previews an offset; call `finish` to keep it.
export function beginPixelMove(duplicate: boolean) {
  const layer = store.active
  const selection = store.state.selection
  if (!layer?.image || layer.isGroup || layer.adjustment || store.state.editingMask || !selection) return null
  store.beginGesture(duplicate ? 'Duplicate Pixels' : 'Move Pixels')
  const image = layer.image, toDoc = pixelToDocument(layer.transform, image.width, image.height), toPixel = invert(toDoc)
  const coverage = new Float32Array(image.width * image.height)
  for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
    const [dx, dy] = apply(toDoc, x + 0.5, y + 0.5), sx = Math.floor(dx), sy = Math.floor(dy)
    coverage[y * image.width + x] = sx >= 0 && sy >= 0 && sx < selection.width && sy < selection.height ? selection.data[sy * selection.width + sx] / 255 : 0
  }
  const [ox, oy] = apply(toPixel, 0, 0)
  let last: [number, number] = [0, 0]
  const preview = (dx: number, dy: number) => {
    last = [dx, dy]
    const [px, py] = apply(toPixel, dx, dy), lx = px - ox, ly = py - oy
    // Grow the grid to hold the moved pixels.
    const x0 = Math.min(0, Math.floor(lx)), y0 = Math.min(0, Math.floor(ly)), x1 = Math.max(image.width, Math.ceil(image.width + lx)), y1 = Math.max(image.height, Math.ceil(image.height + ly))
    const out = placeOnGrid(image, [x0, y0], x1 - x0, y1 - y0)
    if (!duplicate) for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
      const k = 1 - coverage[y * image.width + x], p = ((y - y0) * out.width + x - x0) * 4
      if (k < 1) for (let c = 0; c < 4; c++) out.data[p + c] = Math.round(out.data[p + c] * k)
    }
    const integer = Math.abs(lx - Math.round(lx)) < 1e-6 && Math.abs(ly - Math.round(ly)) < 1e-6
    for (let y = 0; y < out.height; y++) for (let x = 0; x < out.width; x++) {
      const sx = x + x0 - lx, sy = y + y0 - ly
      let r = 0, g = 0, b = 0, a = 0
      const take = (ix: number, iy: number, w: number) => {
        if (ix < 0 || iy < 0 || ix >= image.width || iy >= image.height || w <= 0) return
        const k = coverage[iy * image.width + ix] * w, p = (iy * image.width + ix) * 4
        r += image.data[p] * k; g += image.data[p + 1] * k; b += image.data[p + 2] * k; a += image.data[p + 3] * k
      }
      if (integer) take(Math.round(sx), Math.round(sy), 1)
      else { const fx = Math.floor(sx - 0.5), fy = Math.floor(sy - 0.5), tx = sx - 0.5 - fx, ty = sy - 0.5 - fy; take(fx, fy, (1 - tx) * (1 - ty)); take(fx + 1, fy, tx * (1 - ty)); take(fx, fy + 1, (1 - tx) * ty); take(fx + 1, fy + 1, tx * ty) }
      if (a <= 0) continue
      const p = (y * out.width + x) * 4, keep = 1 - a / 255
      out.data[p] = Math.round(r + out.data[p] * keep); out.data[p + 1] = Math.round(g + out.data[p + 1] * keep); out.data[p + 2] = Math.round(b + out.data[p + 2] * keep); out.data[p + 3] = Math.round(a + out.data[p + 3] * keep)
    }
    const transform = x0 || y0 || out.width !== image.width || out.height !== image.height ? grownTransform(layer.transform, toDoc, image.width, image.height, [x0, y0], out.width, out.height) : layer.transform
    const keepMask = layer.mask && !layer.maskPlacement && transform !== layer.transform && !layer.mask.isUniform() ? { mask: padMask(layer.mask, image, [x0, y0], out.width, out.height, 255) } : {}
    store.updateLayerLive(layer.id, { image: out, transform, text: undefined, shape: undefined, ...keepMask })
    store.set({ selection: offsetSelection(selection, dx, dy) })
    store.pixelsChanged()
  }
  return { preview, finish: () => { if (last[0] || last[1]) store.endGesture(); else store.cancelGesture() }, cancel: () => store.cancelGesture() }
}
