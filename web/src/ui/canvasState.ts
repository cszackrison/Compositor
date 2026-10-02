import { store } from '../editor/store'
import { Compositor } from '../render/compositor'
import { Viewport } from '../render/viewport'
import type { Raster } from '../model/raster'
import type { Doc } from '../model/types'

// What the canvas shares with the tools: the view, the compositor, and when to draw again.
export const view = new Viewport()
export let compositor: Compositor | null = null
export function setCompositor(next: Compositor) { compositor = next }

const viewListeners = new Set<() => void>()
export function subscribeView(listener: () => void) { viewListeners.add(listener); return () => { viewListeners.delete(listener) } }
export function viewChanged() { viewListeners.forEach(listener => listener()) }

const pixelBudget = 36_000_000
export function renderScaleFor(doc: Doc, maxSize: number) {
  return Math.min(1, maxSize / Math.max(doc.width, doc.height), Math.sqrt(pixelBudget / (doc.width * doc.height)))
}

// Composites `doc` at full size and reads it back, for export, merging and sampling. The live view redraws afterwards.
export function renderFull(doc: Doc): Raster {
  if (!compositor) throw new Error('The canvas is not ready')
  if (Math.max(doc.width, doc.height) > compositor.maxSize) throw new Error(`This canvas is larger than this GPU can render in one piece (${compositor.maxSize} px).`)
  compositor.render(doc, 1)
  const pixels = compositor.read()
  requestRender()
  return pixels
}

export function zoomBy(factor: number) { view.zoomAt(factor, view.width / 2, view.height / 2); viewChanged(); requestRender(false) }
export function fit() { view.fit(store.doc.width, store.doc.height); viewChanged(); requestRender(false) }
export function actualSize() { view.zoomAt(1 / view.zoom, view.width / 2, view.height / 2); viewChanged(); requestRender(false) }

let renderQueued = false
let contentDirty = true
let frameHandler: (contentDirty: boolean) => void = () => {}
export function onFrame(handler: (contentDirty: boolean) => void) { frameHandler = handler }
export function requestRender(content = true) {
  contentDirty ||= content
  if (renderQueued) return
  renderQueued = true
  requestAnimationFrame(() => { renderQueued = false; const dirty = contentDirty; contentDirty = false; frameHandler(dirty) })
}
// Redraws only the overlay (selection outline, handles, cursors), not the composite.
export function requestOverlay() { requestRender(false) }

// Snap lines shown while a drag is snapped, in document pixels.
export const snapLines: { x: number[]; y: number[] } = { x: [], y: [] }

// What the eyedropper, wand and clone see: the composite, or the active layer by itself, on the canvas.
export function samplePixels(allLayers: boolean): Raster | null {
  const { doc } = store.state
  const layer = store.active
  if (allLayers) return renderFull(doc)
  if (!layer || layer.isGroup || layer.adjustment) return null
  return renderFull({ ...doc, layers: [{ ...layer, parentId: null, clipTo: null, opacity: 1, blendMode: 'Normal', visible: true, effects: null }] })
}

// While a panel samples from the canvas (Color Range, Levels' eyedroppers), clicks go to it instead of the tool.
export const canvasPicker: { current: ((point: [number, number], shift: boolean, alt: boolean) => void) | null } = { current: null }
