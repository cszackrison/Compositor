import type { Raster } from './raster'
import type { Layer } from './types'
import { type GIFLayerData, frameRaster, frameSize, selectFrame, setFramePixels } from './gif'

// A GIF layer's `image` is its selected frame. What was put there, and at which version, is kept by the GIF data it came with, so an
// edit to those pixels (any brush, filter or fill) is folded into the frame's own pixels when the frame changes or the project saves.
const shown = new WeakMap<GIFLayerData, { raster: Raster; version: number }>()

export function showing(gif: GIFLayerData, raster: Raster): GIFLayerData { shown.set(gif, { raster, version: raster.version }); return gif }

// The layer's GIF with any edit to its image kept as the selected frame's pixels; none once an edit has changed the image's size (a
// filter that grew it), which no longer fits the frames.
export function syncedGIF(layer: Layer): GIFLayerData | undefined {
  const gif = layer.gif, image = layer.image
  if (!gif || !image) return gif
  const last = shown.get(gif)
  if (last && last.raster === image && last.version === image.version) return gif
  const { width, height } = frameSize(gif)
  if (image.width !== width || image.height !== height) return undefined
  return showing(setFramePixels(gif, gif.selectedFrameIndex, image), image)
}

// The changes that show frame `index` of a GIF layer, its current frame's edits kept first.
export function showFrame(layer: Layer, index: number): Partial<Layer> | null {
  const gif = syncedGIF(layer)
  if (!gif) return null
  const next = selectFrame(gif, index), image = frameRaster(next, index)
  return { gif: showing(next, image), image }
}

// A new GIF state (after duplicating or deleting frames, or retiming) with the layer's image as its selected frame.
export function withGIF(gif: GIFLayerData): Partial<Layer> {
  const image = frameRaster(gif, gif.selectedFrameIndex)
  return { gif: showing(gif, image), image }
}
