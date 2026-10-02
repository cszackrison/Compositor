import { Store, store } from './store'
import { Raster } from '../model/raster'
import { bounds } from '../model/selection'
import { newLayer, type Transform } from '../model/types'
import { pixelToDocument } from '../render/compositor'
import { apply, invert, multiply, type Mat3 } from '../render/gl'
import { grownTransform, placeOnGrid } from './filters'

// ⌘T with a selection (FloatingSelection.swift): the selected pixels are lifted onto a temporary "Floating Selection" layer just
// above their layer and the hole is cleared, all inside one "Transform Selection" step that stays open while the Move tool
// transforms the floating pixels. Applying merges them back; Escape restores everything exactly.
type Floating = { sourceId: string; floatingId: string; original: Transform; selection: Raster; region: { x: number; y: number; w: number; h: number } }
let floating: Floating | null = null
export const isFloating = () => !!floating
export const floatingLayerId = () => floating?.floatingId

// Draws `source` (through its document transform) over `dest` (in its own grid), bilinear, normal source-over at full opacity.
function drawOver(dest: Raster, destToDoc: Mat3, source: Raster, sourceToDoc: Mat3) {
  const toSource = multiply(invert(sourceToDoc), destToDoc)
  for (let y = 0; y < dest.height; y++) for (let x = 0; x < dest.width; x++) {
    const [sx, sy] = apply(toSource, x + 0.5, y + 0.5)
    if (sx < 0 || sy < 0 || sx > source.width || sy > source.height) continue
    const fx = sx - 0.5, fy = sy - 0.5, ix = Math.floor(fx), iy = Math.floor(fy), tx = fx - ix, ty = fy - iy
    const px = [0, 0, 0, 0]
    for (const [qx, qy, w] of [[ix, iy, (1 - tx) * (1 - ty)], [ix + 1, iy, tx * (1 - ty)], [ix, iy + 1, (1 - tx) * ty], [ix + 1, iy + 1, tx * ty]]) {
      if (qx < 0 || qy < 0 || qx >= source.width || qy >= source.height || w <= 0) continue
      const i = (qy * source.width + qx) * 4
      for (let c = 0; c < 4; c++) px[c] += source.data[i + c] * w
    }
    if (px[3] <= 0) continue
    const d = (y * dest.width + x) * 4, keep = 1 - px[3] / 255
    for (let c = 0; c < 4; c++) dest.data[d + c] = Math.round(px[c] + dest.data[d + c] * keep)
  }
}

export function canTransformSelection() {
  const layer = store.active
  return !floating && !!store.state.selection && !!layer?.image && !layer.isGroup && !layer.adjustment && !store.state.editingMask
}

export function beginTransformSelection() {
  if (!canTransformSelection()) return false
  const layer = store.active!, selection = store.state.selection!, image = layer.image!
  const box = bounds(selection)
  if (!box) return false
  store.beginGesture('Transform Selection')
  // Lift: the layer's own pixels (not its mask or opacity) through the selection's soft coverage, in the selection's bounds.
  const toDoc = pixelToDocument(layer.transform, image.width, image.height)
  const lifted = new Raster(box.w, box.h, 4)
  drawOver(lifted, [1, 0, 0, 0, 1, 0, box.x, box.y, 1], image, toDoc)
  for (let y = 0; y < box.h; y++) for (let x = 0; x < box.w; x++) {
    const k = selection.data[(y + box.y) * selection.width + x + box.x] / 255, i = (y * box.w + x) * 4
    for (let c = 0; c < 4; c++) lifted.data[i + c] = Math.round(lifted.data[i + c] * k)
  }
  // Clear the hole in the source (on a copy, so the step's starting point keeps the original).
  const cleared = image.clone()
  for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
    const [dx, dy] = apply(toDoc, x + 0.5, y + 0.5), sx = Math.floor(dx), sy = Math.floor(dy)
    const k = sx >= 0 && sy >= 0 && sx < selection.width && sy < selection.height ? selection.data[sy * selection.width + sx] / 255 : 0
    if (k <= 0) continue
    const i = (y * image.width + x) * 4
    for (let c = 0; c < 4; c++) cleared.data[i + c] = Math.round(cleared.data[i + c] * (1 - k))
  }
  const transform: Transform = { origin: [box.x, box.y], size: [box.w, box.h], rotation: 0, flipX: false, flipY: false, sampling: 'High quality' }
  const temp = newLayer({ name: 'Floating Selection', image: lifted, transform, parentId: layer.parentId, opacity: layer.opacity, blendMode: layer.blendMode })
  const layers = store.doc.layers.flatMap(l => l.id === layer.id ? [{ ...l, image: cleared, text: undefined, shape: undefined }, temp] : [l])
  store.set({ doc: { ...store.doc, layers }, activeId: temp.id, selectedIds: [temp.id] })
  floating = { sourceId: layer.id, floatingId: temp.id, original: transform, selection, region: box }
  if (store.state.tool !== 'move') store.setTool('move')
  store.pixelsChanged()
  return true
}

export function cancelFloating() {
  if (!floating) return
  floating = null
  store.cancelGesture()
  store.pixelsChanged()
}

// Merges the floating pixels back into their layer's own grid, which grows if they moved past it, and carries the selection along.
export function commitFloating() {
  const f = floating
  if (!f) return
  const temp = store.layer(f.floatingId), source = store.layer(f.sourceId)
  if (!temp?.image || !source?.image) { cancelFloating(); return }
  const unchanged = JSON.stringify(temp.transform) === JSON.stringify(f.original) && temp.image.width === f.region.w && temp.image.height === f.region.h
  if (unchanged) { cancelFloating(); return }
  floating = null
  const image = source.image, toDoc = pixelToDocument(source.transform, image.width, image.height), toPixel = invert(toDoc)
  const tempToDoc = pixelToDocument(temp.transform, temp.image.width, temp.image.height)
  const corners = [[0, 0], [temp.image.width, 0], [temp.image.width, temp.image.height], [0, temp.image.height]].map(([x, y]) => apply(toPixel, ...apply(tempToDoc, x, y)))
  const x0 = Math.min(0, Math.floor(Math.min(...corners.map(c => c[0])))), y0 = Math.min(0, Math.floor(Math.min(...corners.map(c => c[1]))))
  const x1 = Math.max(image.width, Math.ceil(Math.max(...corners.map(c => c[0])))), y1 = Math.max(image.height, Math.ceil(Math.max(...corners.map(c => c[1]))))
  const merged = placeOnGrid(image, [x0, y0], x1 - x0, y1 - y0)
  const grown = x0 || y0 || merged.width !== image.width || merged.height !== image.height
  const transform = grown ? grownTransform(source.transform, toDoc, image.width, image.height, [x0, y0], merged.width, merged.height) : source.transform
  drawOver(merged, pixelToDocument(transform, merged.width, merged.height), temp.image, tempToDoc)
  // An unplaced mask is padded with white (reveal) to the grown grid, so its coverage stays where it was.
  const mask = grown && source.mask && !source.maskPlacement && !source.mask.isUniform() ? padMask(source.mask, image, [x0, y0], merged.width, merged.height, 255) : source.mask
  // The selection follows the pixels.
  const move = multiply(pixelToDocument(temp.transform, f.region.w, f.region.h), invert(pixelToDocument(f.original, f.region.w, f.region.h)))
  const back = invert(move), sel = f.selection, moved = new Raster(sel.width, sel.height, 1)
  for (let y = 0; y < sel.height; y++) for (let x = 0; x < sel.width; x++) {
    const [sx, sy] = apply(back, x + 0.5, y + 0.5), ix = Math.floor(sx), iy = Math.floor(sy)
    if (ix >= 0 && iy >= 0 && ix < sel.width && iy < sel.height) moved.data[y * sel.width + x] = sel.data[iy * sel.width + ix]
  }
  const layers = store.doc.layers.filter(l => l.id !== temp.id).map(l => l.id === source.id ? { ...l, image: merged, transform, mask } : l)
  store.set({ doc: { ...store.doc, layers }, activeId: source.id, selectedIds: [source.id], selection: moved.data.some(v => v) ? moved : null })
  store.endGesture()
  store.pixelsChanged()
}

// A mask on its layer's own grid, carried onto that grid grown to `width`×`height` with its corner at `origin`; `fill` covers the new area.
export function padMask(mask: Raster, image: Raster, origin: [number, number], width: number, height: number, fill: number) {
  const out = Raster.filled(width, height, 1, [fill])
  for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
    const mx = Math.min(mask.width - 1, Math.floor((x + 0.5) * mask.width / image.width)), my = Math.min(mask.height - 1, Math.floor((y + 0.5) * mask.height / image.height))
    out.data[(y - origin[1]) * width + x - origin[0]] = mask.data[my * mask.width + mx]
  }
  return out
}

Store.beforeLayerChange = (_, next) => { if (floating && next !== floating.floatingId) commitFloating() }
