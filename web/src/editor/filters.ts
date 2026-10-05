import { store } from './store'
import { Raster } from '../model/raster'
import { apply, type Mat3 } from '../render/gl'
import type { Layer, Transform } from '../model/types'
import { call, withBuffers } from '../kernels'
import { pixelToDocument } from '../render/compositor'
import * as kinds from './filterKinds'

export type FilterInput = { pixels: Raster; isMask: boolean; toDocument: Mat3; layerId: string; transform: Transform }
// A filter's result: pixels on the layer's own grid, or on a grown one whose top-left sits at `origin` in the original's pixels.
export type FilterOutput = Raster | { pixels: Raster; origin: [number, number] } | null
// Works on premultiplied RGBA (a mask arrives as opaque gray) and returns the result.
export type FilterRun = (input: FilterInput) => FilterOutput

// A filter to run in the worker (filterWorker.ts): a function of filterKinds by name, and its arguments after the input.
export type FilterJob = { job: keyof typeof kinds; args: unknown[] }
export const job = (name: keyof typeof kinds, ...args: unknown[]): FilterJob => ({ job: name, args })
export const isJob = (run: FilterRun | FilterJob | undefined | null): run is FilterJob => !!run && typeof run === 'object' && 'job' in run

let worker: Worker | null | undefined
let nextId = 1
const waiting = new Map<number, { resolve: (out: FilterOutput) => void; reject: (error: Error) => void }>()
const onMainThread = (j: FilterJob, input: FilterInput) => (kinds[j.job] as unknown as (input: FilterInput, ...args: unknown[]) => FilterOutput)(input, ...j.args)

function filterWorker(): Worker | null {
  if (worker !== undefined) return worker
  try {
    worker = new Worker(new URL('./filterWorker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (event: MessageEvent<{ id: number; error?: string; result?: { width: number; height: number; channels: 1 | 4; data: Uint8Array; origin: [number, number] | null } | null }>) => {
      const { id, error, result } = event.data, pending = waiting.get(id)
      waiting.delete(id)
      if (!pending) return
      if (error) pending.reject(new Error(error))
      else if (!result) pending.resolve(null)
      else { const raster = new Raster(result.width, result.height, result.channels, result.data); pending.resolve(result.origin ? { pixels: raster, origin: result.origin } : raster) }
    }
    worker.onerror = () => { waiting.forEach(p => p.reject(new Error('The filter stopped unexpectedly.'))); waiting.clear() }
  } catch { worker = null }
  return worker
}

// Runs a filter job in the worker, or here where workers can't start. The input's pixels move to the worker.
// The filters whose settings are in pixels, by which arguments: a preview of a large layer scales those with the copy it runs on.
const previewLimit = 2048
const pixelSettings: Partial<Record<keyof typeof kinds, number[]>> = { gaussianBlur: [0], motionBlur: [1], bloom: [1], tonalContrast: [4] }
const previewScale = (j: FilterJob, input: FilterInput) => pixelSettings[j.job] ? Math.min(1, previewLimit / Math.max(input.pixels.width, input.pixels.height)) : 1

function runJob(j: FilterJob, input: FilterInput, scale = 1): Promise<FilterOutput> {
  const w = filterWorker()
  if (!w) { try { return Promise.resolve(onMainThread(j, input)) } catch (error) { return Promise.reject(error) } }
  const id = nextId++, { pixels, ...rest } = input
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject })
    w.postMessage({ id, name: j.job, args: j.args, scale, scaled: pixelSettings[j.job] ?? [], input: { ...rest, pixels: { width: pixels.width, height: pixels.height, channels: pixels.channels, data: pixels.data } } }, [pixels.data.buffer])
  })
}

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

// A layer's pixels cut down to `w`×`h` at (x, y) of its grid, with the transform that keeps them in place. A mask on the layer's
// own grid (the same size as its pixels) is cut the same way, so it stays lined up.
export function croppedLayer(layer: Layer, x: number, y: number, w: number, h: number): Pick<Layer, 'image' | 'mask' | 'transform'> {
  const image = layer.image!, cropped = new Raster(w, h, 4, image.read(x, y, w, h))
  const onGrid = layer.mask && !layer.maskPlacement && layer.mask.width === image.width && layer.mask.height === image.height
  return {
    image: cropped,
    mask: onGrid ? new Raster(w, h, 1, layer.mask!.read(x, y, w, h)) : layer.mask,
    transform: grownTransform(layer.transform, pixelToDocument(layer.transform, image.width, image.height), image.width, image.height, [x, y], w, h),
  }
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
  // Worker jobs: the newest waiting to run, the one running, and whether the session is over.
  private queuedJob: FilterJob | null = null
  private running: Promise<void> | null = null
  private closed = false
  private failed = false
  // The job last shown, and whether it was a reduced preview that OK has to run again at full size.
  private shownJob: FilterJob | null = null
  private shownReduced = false
  private finalRun = false
  onError?: (message: string | null) => void
  onBusy?: (busy: boolean) => void

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

  // Runs on the next frame, so dragging a slider filters only as often as the screen draws. A worker job runs as soon as the one
  // before it finishes; only the newest waits, so a slow filter never builds a backlog.
  preview(run: FilterRun | FilterJob) {
    cancelAnimationFrame(this.pending)
    if (isJob(run)) { this.queued = null; this.queuedJob = run; this.pump(); return }
    this.queuedJob = null
    this.queued = run
    this.pending = requestAnimationFrame(() => { this.queued = null; this.applyNow(run) })
  }

  private pump() {
    if (this.running || this.closed) return
    const next = this.queuedJob
    this.queuedJob = null
    if (!next) { this.onBusy?.(false); return }
    this.onBusy?.(true)
    const input = this.input(), scale = this.finalRun ? 1 : previewScale(next, input)
    this.running = runJob(next, input, scale)
      .then(out => { if (!this.closed) { this.failed = false; this.applyResult(out); this.shownJob = next; this.shownReduced = scale < 1; this.onError?.(null) } }, (error: Error) => { if (!this.closed) { this.failed = true; this.onError?.(error.message) } })
      .finally(() => { this.running = null; this.pump() })
  }

  applyNow(run: FilterRun) { this.applyResult(run(this.input())) }

  private applyResult(result: FilterOutput) {
    if (!result) { this.show(this.original, this.transform); return }
    const pixels = result instanceof Raster ? result : result.pixels
    const origin: [number, number] = result instanceof Raster ? [0, 0] : result.origin
    const { original, toDocument } = this
    const grown = origin[0] !== 0 || origin[1] !== 0 || pixels.width !== original.width || pixels.height !== original.height
    const channels = original.channels
    const transformFor = () => grown && !this.isMask ? grownTransform(this.transform, toDocument, original.width, original.height, origin, pixels.width, pixels.height) : this.transform
    // Without a selection every pixel takes the filter's result, so a layer's result is shown as it came.
    if (!store.state.selection && channels === 4) { pixels.touch(); this.show(pixels, transformFor()); return }
    const base = grown ? placeOnGrid(original, origin, pixels.width, pixels.height) : original
    const reuse = this.shown && this.shown !== original && this.shown.width === pixels.width && this.shown.height === pixels.height
    const out = reuse ? this.shown! : new Raster(pixels.width, pixels.height, channels)
    const selection = store.state.selection
    const [m0, m1, , m3, m4, , m6, m7] = toDocument, src = base.data, dst = out.data, next = pixels.data
    for (let y = 0; y < pixels.height; y++) {
      for (let x = 0, i = y * pixels.width; x < pixels.width; x++, i++) {
        let k = 1
        if (selection) {
          const px = x + origin[0] + 0.5, py = y + origin[1] + 0.5, sx = Math.floor(m0 * px + m3 * py + m6), sy = Math.floor(m1 * px + m4 * py + m7)
          k = sx >= 0 && sy >= 0 && sx < selection.width && sy < selection.height ? selection.data[sy * selection.width + sx] / 255 : 0
        }
        const o = i * channels, n = i * 4
        if (k >= 1) for (let c = 0; c < channels; c++) dst[o + c] = next[n + c]
        else if (k <= 0) for (let c = 0; c < channels; c++) dst[o + c] = src[o + c]
        else for (let c = 0; c < channels; c++) dst[o + c] = Math.round(src[o + c] + (next[n + c] - src[o + c]) * k)
      }
    }
    out.touch()
    this.show(out, transformFor())
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

  // Keeps the result, once any worker job still running has finished; false when the filter failed. `trim` crops a result that
  // spread past the layer to the pixels it has, as blurs and Bloom do.
  async commit(name: string, run?: FilterRun | FilterJob, trim = false): Promise<boolean> {
    cancelAnimationFrame(this.pending)
    this.finalRun = true
    // A preview made from a reduced copy is run again at full size.
    while (this.running) await this.running
    const next = run ?? this.queuedJob ?? this.queued ?? (this.shownReduced ? this.shownJob : null)
    this.queued = null
    if (isJob(next)) { this.queuedJob = next; this.pump() }
    else if (next) this.applyNow(next)
    while (this.running) await this.running
    this.closed = true
    if (this.failed) { store.cancelGesture(); store.pixelsChanged(); return false }
    if (!this.last || this.last.raster === this.original) { store.cancelGesture(); return true }
    if (trim && !this.isMask) this.trim()
    if (!this.isMask) store.updateLayerLive(this.layerId, { text: undefined, shape: undefined })
    store.endGesture()
    store.history.renameLast(name)
    store.pixelsChanged()
    return true
  }

  private trim() {
    const { raster, transform } = this.last!
    const bounds = new Uint32Array(4)
    withBuffers([{ data: raster.data }, { data: bounds, out: true }], ([pixels, out]) => call('brush_alpha_bounds', pixels, raster.width, raster.height, raster.width * 4, out))
    const [x0, y0, x1, y1] = bounds
    if (x1 <= x0 || y1 <= y0 || (x0 === 0 && y0 === 0 && x1 === raster.width && y1 === raster.height)) return
    store.updateLayerLive(this.layerId, croppedLayer({ ...store.layer(this.layerId)!, image: raster, transform }, x0, y0, x1 - x0, y1 - y0))
  }

  cancel() {
    cancelAnimationFrame(this.pending)
    this.closed = true
    this.queuedJob = null
    store.cancelGesture()
    store.pixelsChanged()
  }
}
