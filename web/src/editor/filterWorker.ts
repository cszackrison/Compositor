import { loadKernels } from '../kernels'
import * as kinds from './filterKinds'
import { Raster } from '../model/raster'
import type { FilterInput, FilterOutput } from './filters'
import { multiply, scale as scaleBy } from '../render/gl'
import { loadCameraRawTables, setAssetBase } from '../model/cameraRaw'
import { type DeepGrid, type DeepPixels, deepMerge, deepRun, runDeep } from './deepFilters'
import type { Adjustment } from '../model/types'

// Filter previews off the main thread: the same filter functions and wasm kernels, so a slow one never freezes the page.
type Request = { id: number; name: keyof typeof kinds; args: unknown[]; scale?: number; scaled?: number[]; source?: number; enlarge?: boolean; input: Omit<FilterInput, 'pixels'> & { pixels: { width: number; height: number; channels: 1 | 4; data: Uint8Array } } }
// A 16-bit or HDR layer's OK: the filter at full depth (deepFilters.ts), or one of its 8-bit runs (`part`), or all their results put
// together (`runs`).
type DeepRequest = { id: number; name: keyof typeof kinds; args: unknown[]; input: Omit<FilterInput, 'pixels'>; deep: DeepPixels; grid: DeepGrid | null; single?: boolean; part?: number; runs?: { width: number; height: number; data: Uint8Array }[]; firstRow?: number }

let ready: Promise<void> | undefined
// The last reduced copy, by the session that sent its pixels: every preview in a session starts from the same original.
let reduced: { source: number; pixels: Raster } | null = null

self.onmessage = async (event: MessageEvent<Request | DeepRequest | WebAssembly.Module | { assetBase: string }>) => {
  if (event.data instanceof WebAssembly.Module) { ready = loadKernels(event.data); return }
  if ('assetBase' in event.data) { setAssetBase(event.data.assetBase); return }
  if ('deep' in event.data) {
    const { id, name, args, input, deep, grid, single, part, runs, firstRow } = event.data
    try {
      await ready
      if (name === 'cameraRaw') await loadCameraRawTables()
      const run = kinds[name] as unknown as (input: FilterInput, ...args: unknown[]) => FilterOutput
      if (runs) {
        const result = deepMerge(name, deep, grid, runs.map(r => new Raster(r.width, r.height, 4, r.data)), firstRow)
        self.postMessage({ id, deep: result }, { transfer: [result.pixels.buffer as ArrayBuffer] })
        return
      }
      if (part !== undefined) {
        const low = deepRun(name, pixels => run(pixels, ...args), input, deep, grid, part)
        self.postMessage({ id, result: { width: low.width, height: low.height, channels: 4, data: low.data, origin: null } }, { transfer: [low.data.buffer as ArrayBuffer] })
        return
      }
      const result = runDeep(name, pixels => run(pixels, ...args), input, deep, grid, name === 'adjustPixels' ? args[0] as Adjustment : undefined, single)
      self.postMessage({ id, deep: result }, { transfer: [result.pixels.buffer as ArrayBuffer] })
    } catch (error) { self.postMessage({ id, error: (error as Error).message }) }
    return
  }
  const { id, name, args, input, scale = 1, scaled = [], source, enlarge = true } = event.data
  try {
    await ready
    if (name === 'cameraRaw') await loadCameraRawTables()
    const full = new Raster(input.pixels.width, input.pixels.height, input.pixels.channels, input.pixels.data)
    const run = kinds[name] as unknown as (input: FilterInput, ...args: unknown[]) => FilterOutput
    // A preview of a large layer runs on a copy at most 2048 px on its longest side, its pixel-sized settings scaled to match,
    // and comes back enlarged to the layer's grid, as the Mac app previews (FilterJob.scale), or as it is when `enlarge` is off and
    // it's on the copy's own grid. OK always runs at full size.
    const width = Math.max(1, Math.round(full.width * scale)), height = Math.max(1, Math.round(full.height * scale))
    const cached = reduced && reduced.source === source && reduced.pixels.width === width && reduced.pixels.height === height ? reduced.pixels : null
    const pixels = scale >= 1 ? full : cached?.clone() ?? resample(full, width, height)
    if (scale < 1 && !cached && source !== undefined) reduced = { source, pixels: pixels.clone() }
    // The copy's pixels map to the document through the layer's mapping, scaled up to the layer's own pixels first.
    const toDocument = scale < 1 ? multiply(input.toDocument, scaleBy(full.width / pixels.width, full.height / pixels.height)) : input.toDocument
    let out = run({ ...input, pixels, toDocument }, ...args.map((a, i) => scaled.includes(i) && typeof a === 'number' ? a * scale : a))
    if (scale < 1 && out && (enlarge || !(out instanceof Raster))) {
      // Enlarged by the copy's own ratios, so a result on the copy's grid comes back exactly on the layer's.
      const small = out instanceof Raster ? out : out.pixels, origin = out instanceof Raster ? [0, 0] : out.origin, fx = full.width / pixels.width, fy = full.height / pixels.height
      const big = resample(small, Math.max(1, Math.round(small.width * fx)), Math.max(1, Math.round(small.height * fy)))
      out = out instanceof Raster ? big : { pixels: big, origin: [Math.round(origin[0] * fx), Math.round(origin[1] * fy)] }
    }
    const raster = out instanceof Raster ? out : out?.pixels
    const result = raster ? { width: raster.width, height: raster.height, channels: raster.channels, data: raster.data, origin: out instanceof Raster ? null : out!.origin } : null
    self.postMessage({ id, result }, { transfer: result ? [result.data.buffer as ArrayBuffer] : [] })
  } catch (error) { self.postMessage({ id, error: (error as Error).message }) }
}

// Bilinear resampling to a new size (pixel centers mapped onto each other), for previews only.
function resample(source: Raster, width: number, height: number) {
  const out = new Raster(width, height, source.channels), c = source.channels, sx = source.width / width, sy = source.height / height
  for (let y = 0; y < height; y++) {
    const fy = Math.min(source.height - 1, Math.max(0, (y + 0.5) * sy - 0.5)), y0 = Math.floor(fy), y1 = Math.min(source.height - 1, y0 + 1), ty = fy - y0
    for (let x = 0; x < width; x++) {
      const fx = Math.min(source.width - 1, Math.max(0, (x + 0.5) * sx - 0.5)), x0 = Math.floor(fx), x1 = Math.min(source.width - 1, x0 + 1), tx = fx - x0
      const a = (y0 * source.width + x0) * c, b = (y0 * source.width + x1) * c, d = (y1 * source.width + x0) * c, e = (y1 * source.width + x1) * c, o = (y * width + x) * c
      for (let k = 0; k < c; k++) out.data[o + k] = Math.round((source.data[a + k] * (1 - tx) + source.data[b + k] * tx) * (1 - ty) + (source.data[d + k] * (1 - tx) + source.data[e + k] * tx) * ty)
    }
  }
  return out
}
