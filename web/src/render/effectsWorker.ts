import { renderEffects } from './effects'
import { Raster } from '../model/raster'

// Layer effects worked out off the main thread, so a brush stroke on a layer with a drop shadow never stalls while it's redone.
type Pixels = { width: number; height: number; channels: 1 | 4; data: Uint8Array }

self.onmessage = (event: MessageEvent<{ id: number; image: Pixels; mask: Pixels | null; effects: Parameters<typeof renderEffects>[2] }>) => {
  const { id, image, mask, effects } = event.data
  const raster = (p: Pixels) => new Raster(p.width, p.height, p.channels, p.data)
  const { raster: out, inset } = renderEffects(raster(image), mask ? raster(mask) : null, effects)
  self.postMessage({ id, width: out.width, height: out.height, data: out.data, inset }, { transfer: [out.data.buffer as ArrayBuffer] })
}
