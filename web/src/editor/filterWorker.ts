import { loadKernels } from '../kernels'
import * as kinds from './filterKinds'
import { Raster } from '../model/raster'
import type { FilterInput, FilterOutput } from './filters'

// Filter previews off the main thread: the same filter functions and wasm kernels, so a slow one never freezes the page.
type Request = { id: number; name: keyof typeof kinds; args: unknown[]; scale?: number; scaled?: number[]; input: Omit<FilterInput, 'pixels'> & { pixels: { width: number; height: number; channels: 1 | 4; data: Uint8Array } } }

let ready: Promise<void> | undefined

self.onmessage = async (event: MessageEvent<Request | WebAssembly.Module>) => {
  if (event.data instanceof WebAssembly.Module) { ready = loadKernels(event.data); return }
  const { id, name, args, input, scale = 1, scaled = [] } = event.data
  try {
    await ready
    const full = new Raster(input.pixels.width, input.pixels.height, input.pixels.channels, input.pixels.data)
    const run = kinds[name] as unknown as (input: FilterInput, ...args: unknown[]) => FilterOutput
    // A preview of a large layer runs on a copy at most 2048 px on its longest side, its pixel-sized settings scaled to match,
    // and comes back enlarged to the layer's grid, as the Mac app previews (FilterJob.scale). OK always runs at full size.
    const pixels = scale < 1 ? resample(full, Math.max(1, Math.round(full.width * scale)), Math.max(1, Math.round(full.height * scale))) : full
    let out = run({ ...input, pixels }, ...args.map((a, i) => scaled.includes(i) && typeof a === 'number' ? a * scale : a))
    if (scale < 1 && out) {
      const small = out instanceof Raster ? out : out.pixels, origin = out instanceof Raster ? [0, 0] : out.origin
      const big = resample(small, Math.max(1, Math.round(small.width / scale)), Math.max(1, Math.round(small.height / scale)))
      out = out instanceof Raster ? big : { pixels: big, origin: [Math.round(origin[0] / scale), Math.round(origin[1] / scale)] }
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
