import { loadKernels } from '../kernels'
import * as kinds from './filterKinds'
import { Raster } from '../model/raster'
import type { FilterInput, FilterOutput } from './filters'

// One band of a filter worked in bands (bands.ts), for the worker that shares them out.
type Request = { id: number; name: keyof typeof kinds; args: unknown[]; input: Omit<FilterInput, 'pixels'>; pixels: { width: number; height: number; channels: 1 | 4; data: Uint8Array } }
let ready: Promise<void> | undefined

self.onmessage = async (event: MessageEvent<Request | WebAssembly.Module>) => {
  if (event.data instanceof WebAssembly.Module) { ready = loadKernels(event.data); return }
  const { id, name, args, input, pixels } = event.data
  try {
    await ready
    const given = new Raster(pixels.width, pixels.height, pixels.channels, pixels.data)
    const out = (kinds[name] as unknown as (input: FilterInput, ...args: unknown[]) => FilterOutput)({ ...input, pixels: given }, ...args)
    const raster = out && kinds.onGrid(out, given)
    self.postMessage({ id, result: raster && { width: raster.width, height: raster.height, channels: raster.channels, data: raster.data } }, raster ? { transfer: [raster.data.buffer as ArrayBuffer] } : {})
  } catch (error) { self.postMessage({ id, error: (error as Error).message }) }
}
