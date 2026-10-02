import { store } from './store'
import { Raster } from '../model/raster'
import { apply, type Mat3 } from '../render/gl'
import type { Transform } from '../model/types'
import { call, withBuffers } from '../kernels'
import { pixelToDocument } from '../render/compositor'

export type FilterInput = { pixels: Raster; isMask: boolean; toDocument: Mat3; layerId: string; transform: Transform }
// A filter's result: pixels on the layer's own grid, or on a grown one whose top-left sits at `origin` in the original's pixels.
export type FilterOutput = Raster | { pixels: Raster; origin: [number, number] } | null
// Works on premultiplied RGBA (a mask arrives as opaque gray) and returns the result.
export type FilterRun = (input: FilterInput) => FilterOutput

function maskToRGBA(mask: Raster) {
  const out = new Raster(mask.width, mask.height, 4)
  for (let i = 0; i < mask.data.length; i++) { const v = mask.data[i]; out.data[i * 4] = out.data[i * 4 + 1] = out.data[i * 4 + 2] = v; out.data[i * 4 + 3] = 255 }
  return out
}

// The layer's transform for a grid that grew to `width`×`height` with its corner at `origin` in the old grid's pixels.
export function grownTransform(t: Transform, toDocument: Mat3, oldWidth: number, oldHeight: number, origin: [number, number], width: number, height: number): Transform {
  const [cx, cy] = apply(toDocument, origin[0] + width / 2, origin[1] + height / 2)
  const w = width * t.size[0] / oldWidth, h = height * t.size[1] / oldHeight
  return { ...t, origin: [cx - w / 2, cy - h / 2], size: [w, h] }
}

// Copies `source` into a transparent grid of `width`×`height` with its corner at `origin` (negative when the grid is larger).
export function placeOnGrid(source: Raster, origin: [number, number], width: number, height: number) {
  const out = new Raster(width, height, source.channels)
  const ox = -origin[0], oy = -origin[1], row = source.width * source.channels
  for (let y = 0; y < source.height; y++) out.data.set(source.data.subarray(y * row, y * row + row), ((y + oy) * width + ox) * source.channels)
  return out
}

// A filter being previewed on the active layer (or its mask). Each preview runs on the untouched original and shows the result in
// place; `commit` keeps it as one undo step, `cancel` puts the original back. With a selection only the selected part changes,
// blended by its soft edge.
export class FilterSession {
  private pending = 0
  private queued: FilterRun | null = null
  private shown: Raster | null = null
  private last: { raster: Raster; transform: Transform } | null = null

  // Filters work on a layer's own pixels; only Invert also takes a mask. An empty layer gets a canvas-sized grid when `growEmpty`.
  static start(options: { masks?: boolean; growEmpty?: boolean } = {}): FilterSession | null {
    const active = store.active
    if (!options.masks && store.state.editingMask) { store.notify('Filters work on a layer’s pixels. Select the layer thumbnail, not its mask.'); return null }
    if (active && !active.image && !options.growEmpty && !active.adjustment && !active.isGroup) { store.notify('This layer has no pixels to filter yet.'); return null }
    store.beginGesture('Filter')
    const target = store.editTarget()
    if (!target) { store.cancelGesture(); store.notify('Choose a layer with pixels, or its mask, to filter.'); return null }
    return new FilterSession(target.raster, target.isMask, target.layer.id, target.toDocument, target.layer.transform)
  }

  private constructor(readonly original: Raster, readonly isMask: boolean, readonly layerId: string, readonly toDocument: Mat3, readonly transform: Transform) {}

  input(): FilterInput {
    const pixels = this.isMask ? maskToRGBA(this.original) : this.original.clone()
    return { pixels, isMask: this.isMask, toDocument: this.toDocument, layerId: this.layerId, transform: this.transform }
  }

  // Runs on the next frame, so dragging a slider filters only as often as the screen draws.
  preview(run: FilterRun) {
    cancelAnimationFrame(this.pending)
    this.queued = run
    this.pending = requestAnimationFrame(() => { this.queued = null; this.applyNow(run) })
  }

  applyNow(run: FilterRun) {
    const result = run(this.input())
    if (!result) { this.show(this.original, this.transform); return }
    const pixels = result instanceof Raster ? result : result.pixels
    const origin: [number, number] = result instanceof Raster ? [0, 0] : result.origin
    const { original, toDocument } = this
    const grown = origin[0] !== 0 || origin[1] !== 0 || pixels.width !== original.width || pixels.height !== original.height
    const base = grown ? placeOnGrid(original, origin, pixels.width, pixels.height) : original
    const channels = original.channels
    const reuse = this.shown && this.shown !== original && this.shown.width === pixels.width && this.shown.height === pixels.height
    const out = reuse ? this.shown! : new Raster(pixels.width, pixels.height, channels)
    const selection = store.state.selection
    for (let y = 0; y < pixels.height; y++) for (let x = 0; x < pixels.width; x++) {
      let k = 1
      if (selection) {
        const [dx, dy] = apply(toDocument, x + origin[0] + 0.5, y + origin[1] + 0.5)
        const sx = Math.floor(dx), sy = Math.floor(dy)
        k = sx >= 0 && sy >= 0 && sx < selection.width && sy < selection.height ? selection.data[sy * selection.width + sx] / 255 : 0
      }
      const i = y * pixels.width + x
      for (let c = 0; c < channels; c++) {
        const before = base.data[i * channels + c], after = pixels.data[i * 4 + c]
        out.data[i * channels + c] = k >= 1 ? after : k <= 0 ? before : Math.round(before + (after - before) * k)
      }
    }
    out.touch()
    const transform = grown && !this.isMask ? grownTransform(this.transform, toDocument, original.width, original.height, origin, pixels.width, pixels.height) : this.transform
    this.show(out, transform)
  }

  private show(raster: Raster, transform: Transform) {
    this.shown = raster
    this.last = { raster, transform }
    const layer = store.layer(this.layerId)!
    if (this.isMask) store.updateLayerLive(this.layerId, { mask: raster })
    else {
      // A mask on the layer's own grid stays where it was when the grid grows, its edge tone continuing past the old edge.
      const keepMask = layer.mask && !layer.maskPlacement && transform !== this.transform ? { maskPlacement: this.transform } : {}
      store.updateLayerLive(this.layerId, { image: raster, transform, ...keepMask })
    }
    store.pixelsChanged()
  }

  // Keeps the result. `trim` crops a result that spread past the layer to the pixels it has, as blurs and Bloom do.
  commit(name: string, run?: FilterRun, trim = false) {
    cancelAnimationFrame(this.pending)
    const next = run ?? this.queued
    this.queued = null
    if (next) this.applyNow(next)
    if (!this.last || this.last.raster === this.original) { store.cancelGesture(); return }
    if (trim && !this.isMask) this.trim()
    if (!this.isMask) store.updateLayerLive(this.layerId, { text: undefined, shape: undefined })
    store.endGesture()
    store.history.renameLast(name)
    store.pixelsChanged()
  }

  private trim() {
    const { raster, transform } = this.last!
    const bounds = new Uint32Array(4)
    withBuffers([{ data: raster.data }, { data: bounds, out: true }], ([pixels, out]) => call('brush_alpha_bounds', pixels, raster.width, raster.height, raster.width * 4, out))
    const [x0, y0, x1, y1] = bounds
    if (x1 <= x0 || y1 <= y0 || (x0 === 0 && y0 === 0 && x1 === raster.width && y1 === raster.height)) return
    const cropped = new Raster(x1 - x0, y1 - y0, 4, raster.read(x0, y0, x1 - x0, y1 - y0))
    const toDocument = pixelToDocument(transform, raster.width, raster.height)
    store.updateLayerLive(this.layerId, { image: cropped, transform: grownTransform(transform, toDocument, raster.width, raster.height, [x0, y0], cropped.width, cropped.height) })
  }

  cancel() {
    cancelAnimationFrame(this.pending)
    store.cancelGesture()
    store.pixelsChanged()
  }
}
