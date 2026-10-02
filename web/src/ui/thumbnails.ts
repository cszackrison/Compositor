import type { Raster } from '../model/raster'

const cache = new WeakMap<Raster, { version: number; url: string }>()
const size = 64

// A small data URL of a raster, refreshed when its pixels change.
export function thumbnail(raster: Raster): string {
  const cached = cache.get(raster)
  if (cached?.version === raster.version) return cached.url
  const fit = Math.min(1, size / Math.max(raster.width, raster.height))
  const w = Math.max(1, Math.round(raster.width * fit)), h = Math.max(1, Math.round(raster.height * fit))
  const canvas = document.createElement('canvas')
  canvas.width = w; canvas.height = h
  const context = canvas.getContext('2d')!
  const image = context.createImageData(w, h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const sx = Math.min(raster.width - 1, Math.floor((x + 0.5) / fit)), sy = Math.min(raster.height - 1, Math.floor((y + 0.5) / fit))
    const d = (y * w + x) * 4
    if (raster.channels === 1) { const v = raster.data[sy * raster.width + sx]; image.data[d] = image.data[d + 1] = image.data[d + 2] = v; image.data[d + 3] = 255; continue }
    const s = (sy * raster.width + sx) * 4, a = raster.data[s + 3]
    for (let c = 0; c < 3; c++) image.data[d + c] = a ? Math.min(255, raster.data[s + c] * 255 / a) : 0
    image.data[d + 3] = a
  }
  context.putImageData(image, 0, 0)
  const url = canvas.toDataURL()
  cache.set(raster, { version: raster.version, url })
  return url
}
