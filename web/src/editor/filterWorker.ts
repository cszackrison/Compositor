import { loadKernels } from '../kernels'
import * as kinds from './filterKinds'
import { Raster } from '../model/raster'
import type { FilterInput, FilterOutput } from './filters'

// Filter previews off the main thread: the same filter functions and wasm kernels, so a slow one never freezes the page.
type Request = { id: number; name: keyof typeof kinds; args: unknown[]; input: Omit<FilterInput, 'pixels'> & { pixels: { width: number; height: number; channels: 1 | 4; data: Uint8Array } } }

const ready = loadKernels()

self.onmessage = async (event: MessageEvent<Request>) => {
  const { id, name, args, input } = event.data
  try {
    await ready
    const pixels = new Raster(input.pixels.width, input.pixels.height, input.pixels.channels, input.pixels.data)
    const run = kinds[name] as unknown as (input: FilterInput, ...args: unknown[]) => FilterOutput
    const out = run({ ...input, pixels }, ...args)
    const raster = out instanceof Raster ? out : out?.pixels
    const result = raster ? { width: raster.width, height: raster.height, channels: raster.channels, data: raster.data, origin: out instanceof Raster ? null : out!.origin } : null
    self.postMessage({ id, result }, { transfer: result ? [result.data.buffer as ArrayBuffer] : [] })
  } catch (error) { self.postMessage({ id, error: (error as Error).message }) }
}
