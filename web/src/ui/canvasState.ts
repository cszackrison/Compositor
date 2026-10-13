import { store } from '../editor/store'
import { isCoarse } from './layout'
import { Compositor } from '../render/compositor'
import { Viewport } from '../render/viewport'
import type { LinearImage, Raster } from '../model/raster'
import type { Doc } from '../model/types'

// What the canvas shares with the tools: the view, the compositor, and when to draw again.
export const view = new Viewport()
export let compositor: Compositor | null = null
export function setCompositor(next: Compositor) { compositor = next }

const viewListeners = new Set<() => void>()
export function subscribeView(listener: () => void) { viewListeners.add(listener); return () => { viewListeners.delete(listener) } }
export function viewChanged() { viewListeners.forEach(listener => listener()) }

// Canvas Only (View › Toggle Fullscreen, F): the canvas alone on black over the whole screen, every bar and panel put away.
export let canvasOnly = false
const canvasOnlyListeners = new Set<() => void>()
export function subscribeCanvasOnly(listener: () => void) { canvasOnlyListeners.add(listener); return () => { canvasOnlyListeners.delete(listener) } }
export function setCanvasOnly(on: boolean) {
  if (on === canvasOnly) return
  canvasOnly = on
  if (on) document.documentElement.requestFullscreen?.().catch(() => {})
  else if (document.fullscreenElement) document.exitFullscreen().catch(() => {})
  canvasOnlyListeners.forEach(listener => listener())
  requestRender(false)
}
// The browser's own Escape leaves fullscreen without a key event reaching the page.
if (typeof document !== 'undefined') document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement) setCanvasOnly(false) })

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

// The composite in linear light with what's brighter than white kept, for an EXR export: premultiplied floats, top row first. Null
// for a document without an HDR layer, or a GPU that can't render floats.
export function renderLinear(doc: Doc): LinearImage | null {
  if (!compositor) throw new Error('The canvas is not ready')
  if (Math.max(doc.width, doc.height) > compositor.maxSize) throw new Error(`This canvas is larger than this GPU can render in one piece (${compositor.maxSize} px).`)
  compositor.render(doc, 1)
  const data = compositor.hdr ? compositor.readFloat() : null
  requestRender()
  if (!data) return null
  const linear = (v: number) => v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3]
    for (let c = 0; c < 3; c++) { const v = a > 0 ? data[i + c] / a : 0; data[i + c] = (v < 0 ? -linear(-v) : linear(v)) * a }
  }
  return { width: compositor.output!.width, height: compositor.output!.height, data }
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
// A dialog's own drag on the canvas (Progressive Blur's line), taking the pointer before the tool, in document coordinates, and
// drawing over the canvas in screen coordinates.
export type CanvasGesture = { down: (point: [number, number], screen: [number, number]) => void; move: (point: [number, number], shift: boolean) => void; up: () => void; draw: (context: CanvasRenderingContext2D) => void }
export const canvasGesture: { current: CanvasGesture | null } = { current: null }
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
