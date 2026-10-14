import { store } from '../editor/store'
import { isCoarse } from './layout'
import { Compositor } from '../render/compositor'
import { Viewport } from '../render/viewport'
import { type LinearImage, Raster } from '../model/raster'
import type { Doc } from '../model/types'
import { chosenProfile, pickProfile, proofLookups, subscribeProfiles } from '../io/cmyk'

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


// How far into a tile the document's blur adjustments reach from outside it, in its pixels: each tile is rendered with that much
// around it, so the seams don't show.
export function blurReach(doc: Doc) {
  let reach = 2
  for (const layer of doc.layers) {
    const a = layer.adjustment
    if (!a || !layer.visible) continue
    if (a.kind === 'Gaussian Blur') reach += 3 * Math.max(0.1, a.blurRadius ?? 10)
    else if (a.kind === 'Motion Blur') reach += a.motionDistance ?? 10
  }
  return Math.ceil(reach)
}

// Composites `doc` at full size and reads it back: in one piece when the GPU allows, otherwise a tile at a time. The live view's own
// frame is left as it is. Floats (premultiplied, extended sRGB) are null for a document with no deep layer, or a GPU without floats.
function composite(doc: Doc, floats: true): Float32Array | null
function composite(doc: Doc, floats: false): Raster
function composite(doc: Doc, floats: boolean): Raster | Float32Array | null {
  const c = compositor
  if (!c) throw new Error('The canvas is not ready')
  const { width, height } = doc, fits = Math.max(width, height) <= c.maxSize
  const margin = fits ? 0 : blurReach(doc), size = fits ? Math.max(width, height) : Math.min(4096, c.maxSize - 2 * margin - 32)
  if (size < 256) throw new Error('A blur on this canvas reaches too far to render it in pieces this GPU can take.')
  let out: Raster | Float32Array | null = null
  for (let ty = 0; ty < height; ty += size) for (let tx = 0; tx < width; tx += size) {
    const x0 = Math.max(0, tx - margin), y0 = Math.max(0, ty - margin), x1 = Math.min(width, tx + size + margin), y1 = Math.min(height, ty + size + margin)
    const target = c.renderRegion(doc, x0, y0, x1 - x0, y1 - y0)
    try {
      if (floats && target.format !== 'rgba16f') return null
      const tile = floats ? c.readFloat(target) : c.read(target).data
      if (fits) return floats ? tile as Float32Array : new Raster(width, height, 4, tile as Uint8Array)
      out ??= floats ? new Float32Array(width * height * 4) : new Raster(width, height, 4)
      const into = out instanceof Raster ? out.data : out, w = Math.min(width, tx + size) - tx
      for (let y = ty; y < Math.min(height, ty + size); y++) {
        const from = ((y - y0) * (x1 - x0) + tx - x0) * 4
        into.set(tile.subarray(from, from + w * 4), (y * width + tx) * 4)
      }
    } finally { target.dispose() }
  }
  return out
}

// The composite at full size, for export, merging and sampling.
export const renderFull = (doc: Doc): Raster => composite(doc, false)

// The composite at full depth, for merging 16-bit and HDR layers: premultiplied floats in extended sRGB, top row first. Null for a
// document without such a layer, or a GPU that can't render floats.
export const renderDeep = (doc: Doc): Float32Array | null => composite(doc, true)

// The composite in linear light with what's brighter than white kept, for an EXR export: premultiplied floats, top row first. Null
// for a document without an HDR layer, or a GPU that can't render floats.
export function renderLinear(doc: Doc): LinearImage | null {
  const data = composite(doc, true)
  if (!data) return null
  const linear = (v: number) => v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3]
    for (let c = 0; c < 3; c++) { const v = a > 0 ? data[i + c] / a : 0; data[i + c] = (v < 0 ? -linear(-v) : linear(v)) * a }
  }
  return { width: doc.width, height: doc.height, data }
}

// View › CMYK: Proof Colors shows the canvas as the chosen profile will print it, on white paper; Gamut Warning marks gray what it can't
// print as it is, over the proof or the document's own colors. Turning either on with no profile kept asks for one.
export const proofing = { colors: false, gamut: false }
const proofListeners = new Set<() => void>()
export function subscribeProofing(listener: () => void) { proofListeners.add(listener); return () => { proofListeners.delete(listener) } }
let proofRequest = 0
async function updateProof() {
  const request = ++proofRequest, profile = chosenProfile(), { colors, gamut } = proofing
  const lookups = (colors || gamut) && profile ? await proofLookups(profile).catch(() => null) : null
  if (request !== proofRequest) return
  compositor?.setProof(lookups ? colors ? gamut ? lookups.warning : lookups.proof : lookups.marked : null)
  requestRender(false)
}
export async function setProofing(change: Partial<typeof proofing>) {
  if ((change.colors || change.gamut) && !chosenProfile() && !(await pickProfile().catch(e => { store.notify((e as Error).message); return null }))) return
  Object.assign(proofing, change)
  proofListeners.forEach(l => l())
  updateProof()
}
if (typeof window !== 'undefined') subscribeProfiles(() => { if (proofing.colors || proofing.gamut) updateProof() })

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
