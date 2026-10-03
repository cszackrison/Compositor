import { store } from '../editor/store'
import { isCoarse } from './layout'
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

// While a finger is on the canvas of a touch screen, the live view composites at about the resolution the screen shows (a power
// of two at or above it, never more than full), then at full resolution once it lifts. Zoomed out on a phone that's a fraction
// of the pixels, which keeps transforms and big edits smooth.
let gesture = false
export function setGesture(active: boolean) {
  if (gesture === active) return
  gesture = active
  if (!active) requestRender()
}
export function liveScaleFor(doc: Doc, maxSize: number) {
  const full = renderScaleFor(doc, maxSize)
  if (!gesture || !isCoarse()) return full
  const shown = view.zoom * (window.devicePixelRatio || 1)
  return Math.min(full, Math.max(1 / 8, 2 ** Math.ceil(Math.log2(shown))))
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
// A panel's drag on the canvas (Hue/Saturation's targeted hand): screen x since the press, and whether ⌘ is held.
export const canvasDrag: { current: { move: (dx: number, command: boolean) => void; up: () => void } | null; startX: number } = { current: null, startX: 0 }

// On-screen stand-ins for Shift, Option and Command on touch screens. A tap holds the key for the next gesture on the canvas, a
// second tap locks it on, a third lets it go.
export type ModifierKey = 'shift' | 'alt' | 'command'
export type ModifierState = 'off' | 'once' | 'locked'
let modifiers: Record<ModifierKey, ModifierState> = { shift: 'off', alt: 'off', command: 'off' }
const modifierListeners = new Set<() => void>()
const setModifiers = (next: Record<ModifierKey, ModifierState>) => { modifiers = next; modifierListeners.forEach(l => l()) }
export const touchModifiers = () => modifiers
export function subscribeModifiers(listener: () => void) { modifierListeners.add(listener); return () => { modifierListeners.delete(listener) } }
export function tapModifier(key: ModifierKey) { setModifiers({ ...modifiers, [key]: ({ off: 'once', once: 'locked', locked: 'off' } as const)[modifiers[key]] }) }
export function armModifier(key: ModifierKey) { setModifiers({ ...modifiers, [key]: 'once' }) }
export function releaseOnceModifiers() {
  if (Object.values(modifiers).includes('once')) setModifiers(Object.fromEntries(Object.entries(modifiers).map(([k, v]) => [k, v === 'once' ? 'off' : v])) as typeof modifiers)
}
export const modifierHeld = (key: ModifierKey) => modifiers[key] !== 'off'

// How much farther a finger can be from a handle than a mouse and still grab it.
export const hitSlop = () => isCoarse() ? 2 : 1
