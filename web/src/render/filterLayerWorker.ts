import { loadKernels } from '../kernels'
import * as kinds from '../editor/filterKinds'
import { Raster } from '../model/raster'
import type { Mat3 } from './gl'

// Filter adjustment layers worked out off the main thread (Compositor.filterLayer): the canvas below, through the filter of the same name.
type Request = { id: number; name: keyof typeof kinds; args: unknown[]; toDocument: Mat3; pixels: { width: number; height: number; data: Uint8Array } }
let ready: Promise<void> | undefined

self.onmessage = async (event: MessageEvent<Request | WebAssembly.Module>) => {
  if (event.data instanceof WebAssembly.Module) { ready = loadKernels(event.data); return }
  const { id, name, args, toDocument, pixels } = event.data
  try {
    await ready
    const given = new Raster(pixels.width, pixels.height, 4, pixels.data)
    const run = kinds[name] as unknown as (input: kinds.FilterKindInput, ...args: unknown[]) => kinds.FilterKindOutput
    const out = run({ pixels: given, isMask: false, toDocument, layerId: '', transform: { origin: [0, 0], size: [pixels.width, pixels.height], rotation: 0, flipX: false, flipY: false, sampling: 'Smooth' } }, ...args)
    const raster = kinds.onGrid(out, given)
    self.postMessage({ id, width: raster.width, height: raster.height, data: raster.data }, { transfer: [raster.data.buffer as ArrayBuffer] })
  } catch (error) { self.postMessage({ id, error: (error as Error).message }) }
}
