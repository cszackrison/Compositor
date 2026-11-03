import { Raster } from '../model/raster'
import { resize } from '../ai/matte'
import { type VolumetricCache, type VolumetricSettings, depthPicture, volumetricLight } from './volumetricLight'

// Volumetric Light off the main thread, for its panel: the layer, its depth and subject are sent once, and a copy at most
// `previewSide` across is made for the preview; each piece the sliders don't change is kept between runs (VolumetricCache).
type Source = { pixels: Raster; depth: Float32Array | null; subject: Uint8Array | null; cache: VolumetricCache }
type Request = { kind: 'source'; width: number; height: number; data: Uint8Array; depth: Float32Array | null; subject: Uint8Array | null; previewSide: number }
  | { kind: 'run'; id: number; full: boolean; settings: VolumetricSettings; center: [number, number]; enlarge: boolean }
  | { kind: 'depth'; id: number; settings: VolumetricSettings }

let full: Source | null = null, preview: Source | null = null

// Premultiplied RGBA shrunk by averaging each output pixel's footprint, or enlarged bilinearly.
function resized(raster: Raster, width: number, height: number): Raster {
  if (raster.width === width && raster.height === height) return raster
  const out = new Raster(width, height, 4), plane = new Float32Array(raster.width * raster.height)
  for (let c = 0; c < 4; c++) {
    for (let i = 0; i < plane.length; i++) plane[i] = raster.data[i * 4 + c]
    const done = resize(plane, raster.width, raster.height, width, height)
    for (let i = 0; i < done.length; i++) out.data[i * 4 + c] = Math.round(done[i])
  }
  return out
}

self.onmessage = (event: MessageEvent<Request>) => {
  const m = event.data
  try {
    if (m.kind === 'source') {
      const pixels = new Raster(m.width, m.height, 4, m.data), k = Math.min(1, m.previewSide / Math.max(m.width, m.height))
      full = { pixels, depth: m.depth, subject: m.subject, cache: {} }
      if (k >= 1) { preview = full; return }
      const width = Math.max(1, Math.round(m.width * k)), height = Math.max(1, Math.round(m.height * k))
      const subject = m.subject && Uint8Array.from(resize(Float32Array.from(m.subject), m.width, m.height, width, height), v => Math.round(v))
      preview = { pixels: resized(pixels, width, height), depth: m.depth && resize(m.depth, m.width, m.height, width, height), subject, cache: {} }
      return
    }
    if (!full || !preview) throw new Error('Volumetric Light has no image to work on.')
    let out: Raster
    if (m.kind === 'depth') {
      if (!full.depth) throw new Error('There’s no depth for this layer.')
      out = depthPicture(full.depth, full.subject, full.pixels.width, full.pixels.height, m.settings)
      // Not needed again once the depth is a layer.
      full.cache = {}
    } else {
      const source = m.full ? full : preview, k = source.pixels.width / full.pixels.width
      out = volumetricLight(source.pixels, source.depth, source.subject, m.settings, [m.center[0] * k, m.center[1] * k], source.cache)
      // The full-size run happens once, at OK: nothing of it is kept.
      if (m.full) full.cache = {}
      if (m.enlarge) out = resized(out, full.pixels.width, full.pixels.height)
    }
    self.postMessage({ id: m.id, width: out.width, height: out.height, data: out.data }, { transfer: [out.data.buffer] })
  } catch (error) {
    self.postMessage({ id: m.kind === 'source' ? undefined : m.id, error: (error as Error).message })
  }
}
