import { Store, store } from '../editor/store'
import { apply, invert, type Mat3 } from '../render/gl'
import { pixelToDocument, effectivelyVisible, drawOrder } from '../render/compositor'
import { requestOverlay, requestRender, view } from '../ui/canvasState'
import { type Layer, type Transform, fullTransform, newLayer } from '../model/types'
import { type RGB01, type TextStyle, colorAt, defaultTextStyle, fontAt, isValidText, lineHeight, readTextStyle, replaceText, setTextColor, setTextFont, textLayerName, textPadding, writeTextStyle } from '../model/text'
import { type TextLayout, caretAt, indexAt, rasterizeText, selectionRects, subscribeFonts, verticalMove, wordAt } from '../render/text'
import type { Pointer, ToolHandler } from './tool'

// The Type tool (TypeTool.swift, InlineTextEditor.swift). A click starts point text with its first baseline on the pointer; a drag draws a
// paragraph box; a click on a text layer edits it. While text is open it's drawn as the layer's own pixels, redrawn as it's typed,
// all inside one undo step that Done keeps and Escape takes back. Typing goes through a hidden text field, so the keyboard, input
// methods and the clipboard work as in any text field; the caret, selection and box are drawn over the canvas from the text's layout.

type Draft = {
  owner: Store; layerId: string; isNew: boolean; style: TextStyle; original: TextStyle | null
  transform: Transform; size: [number, number]; layout: TextLayout
  selection: [number, number]; anchor: number; stickyX: number | null; preview: TextStyle | null
}
let draft: Draft | null = null
let boxDrag: { start: [number, number]; end: [number, number] } | null = null
let pointerDrag: { kind: 'select' } | { kind: 'resize'; handle: number; startBox: [number, number, number, number]; toPixel: Mat3; toDoc: Mat3; size: [number, number]; transform: Transform } | null = null
let defaults: TextStyle = defaultTextStyle()
let field: HTMLTextAreaElement | null = null
let blink = 0

const listeners = new Set<() => void>()
export function subscribeType(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } }
let version = 0
export const typeVersion = () => version
const changed = () => { version++; listeners.forEach(l => l()) }

// A layer's text while its pixels are still the text drawn.
export const liveText = (layer: Layer | undefined | null) => layer?.image && !layer.isGroup && !layer.adjustment ? readTextStyle(layer.text) : null
export const isEditingText = () => !!draft
export const currentTextStyle = () => draft?.style ?? liveText(store.active) ?? defaults
export const textSelection = () => draft?.selection ?? null

// MARK: The hidden field

function input(): HTMLTextAreaElement {
  if (field) return field
  field = document.createElement('textarea')
  field.setAttribute('aria-label', 'Text')
  field.spellcheck = false
  field.autocapitalize = 'off'
  Object.assign(field.style, { position: 'fixed', left: '0', top: '0', width: '1px', height: '1px', opacity: '0', padding: '0', border: '0', resize: 'none', overflow: 'hidden', whiteSpace: 'pre', zIndex: '-1' })
  document.body.appendChild(field)
  field.addEventListener('input', () => typed())
  field.addEventListener('keydown', keydown)
  document.addEventListener('selectionchange', () => { if (draft && document.activeElement === field) fromField() })
  return field
}

function focusField() {
  const f = input()
  if (!draft) return
  if (f.value !== draft.style.content) f.value = draft.style.content
  const [a, b] = draft.selection
  f.setSelectionRange(a, b, draft.anchor > a ? 'backward' : 'forward')
  placeField()
  f.focus({ preventScroll: true })
}

// The field sits under the caret, so an input method's candidates open beside the text.
function placeField() {
  if (!field || !draft) return
  const caret = caretAt(draft.layout, draft.selection[1]), [x, y] = view.toScreen(...apply(toDocument(draft), caret.x, caret.bottom))
  const stage = document.querySelector('.stage')?.getBoundingClientRect()
  field.style.left = `${(stage?.left ?? 0) + x}px`; field.style.top = `${(stage?.top ?? 0) + y}px`
}

function fromField() {
  if (!draft || !field) return
  const a = field.selectionStart, b = field.selectionEnd, backward = field.selectionDirection === 'backward'
  if (draft.selection[0] === a && draft.selection[1] === b) return
  draft.selection = [a, b]
  draft.anchor = backward ? b : a
  draft.stickyX = null
  blink = performance.now()
  requestOverlay(); changed()
}

// What the field now holds against the text: one stretch replaced, found from what's unchanged at each end.
function typed() {
  if (!draft || !field) return
  const before = draft.style.content, after = field.value
  let start = 0
  while (start < before.length && start < after.length && before[start] === after[start]) start++
  let end = 0
  while (end < before.length - start && end < after.length - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end++
  const next = replaceText(draft.style, start, before.length - end, after.slice(start, after.length - end))
  if (!isValidText(next)) { field.value = before; return }
  draft.selection = [field.selectionStart, field.selectionEnd]
  draft.anchor = draft.selection[0]
  update(next)
}

function keydown(event: KeyboardEvent) {
  if (!draft) return
  event.stopPropagation()
  if (event.key === 'Escape') { event.preventDefault(); cancelText(); return }
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); finishText(); return }
  if (event.altKey && event.key.startsWith('Arrow')) {
    // Option with the arrows sets spacing, as in Photoshop: left and right the tracking, up and down the leading. Shift makes each
    // step ten.
    event.preventDefault()
    const step = event.shiftKey ? 10 : 1, style = draft.style
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') update({ ...style, tracking: Math.min(1000, Math.max(-100, style.tracking + (event.key === 'ArrowRight' ? step : -step))) })
    else update({ ...style, leading: Math.min(5000, Math.max(1, Math.round(lineHeight(style)) + (event.key === 'ArrowDown' ? step : -step))) })
    return
  }
  if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') && !event.metaKey && !event.ctrlKey) {
    // Up and down follow the lines as they're drawn, which the field doesn't know.
    event.preventDefault()
    const d = draft, head = d.selection[0] === d.anchor ? d.selection[1] : d.selection[0]
    const x = d.stickyX ?? caretAt(d.layout, head).x
    const next = verticalMove(d.layout, head, event.key === 'ArrowUp' ? -1 : 1, x)
    select(event.shiftKey ? d.anchor : next, next)
    d.stickyX = x
  }
}

function select(anchor: number, head: number) {
  if (!draft) return
  draft.anchor = anchor
  draft.selection = [Math.min(anchor, head), Math.max(anchor, head)]
  draft.stickyX = null
  blink = performance.now()
  focusField()
  requestOverlay(); changed()
}

// MARK: Drafts

const toDocument = (d: Draft) => pixelToDocument(d.transform, d.size[0], d.size[1])

// Redraws the text being edited as the layer's pixels. The layer keeps its scale and rotation, and the corner its text starts at
// stays put as point text grows; `corner` moves that corner (a box resized from its top or left).
function update(style: TextStyle, corner?: [number, number]) {
  const d = draft
  if (!d) return
  const { raster, layout } = rasterizeText(style)
  const t = d.transform, sx = t.size[0] / d.size[0], sy = t.size[1] / d.size[1]
  const pinned = apply(toDocument(d), ...(corner ?? [0, 0]))
  const next: Transform = { ...t, size: [raster.width * sx, raster.height * sy] }
  const moved = apply(pixelToDocument(next, raster.width, raster.height), 0, 0)
  next.origin = [next.origin[0] + pinned[0] - moved[0], next.origin[1] + pinned[1] - moved[1]]
  d.style = style; d.layout = layout; d.transform = next; d.size = [raster.width, raster.height]
  d.selection = [Math.min(d.selection[0], style.content.length), Math.min(d.selection[1], style.content.length)]
  d.owner.updateLayerLive(d.layerId, { image: raster, transform: next, text: writeTextStyle(style), deep: undefined, ...(d.isNew ? { name: textLayerName(style.content) } : {}) })
  d.owner.pixelsChanged()
  if (field && field.value !== style.content) { field.value = style.content; field.setSelectionRange(d.selection[0], d.selection[1]) }
  placeField()
  blink = performance.now()
  requestRender(); requestOverlay(); changed()
}

function open(owner: Store, layer: Layer, style: TextStyle, isNew: boolean, selection: [number, number]) {
  const { layout } = rasterizeText(style)
  draft = { owner, layerId: layer.id, isNew, style, original: isNew ? null : style, transform: layer.transform, size: [layer.image!.width, layer.image!.height], layout, selection, anchor: selection[0], stickyX: null, preview: null }
  focusField()
  blinking()
  requestOverlay(); changed()
}

// New text at `point` (its first baseline there), or in `box` (a paragraph box exactly where it was drawn).
function beginNew(point: [number, number], box?: [number, number]) {
  const owner = store
  if (!owner.hasDocument) return
  const color = owner.state.editingMask ? [defaults.red, defaults.green, defaults.blue] : owner.paletteColor('foreground').map(v => v / 255)
  const { colorRuns: _c, fontRuns: _f, boxSize: _b, ...base } = defaults
  const style: TextStyle = { ...base, content: '', red: color[0], green: color[1], blue: color[2], ...(box ? { boxSize: box } : {}) }
  const { raster, layout } = rasterizeText(style)
  const baseline = textPadding + lineHeight(style) - layout.descent
  const origin: [number, number] = box ? point : [point[0] - textPadding, point[1] - baseline]
  owner.beginGesture('New Text Layer')
  const layer = newLayer({ name: 'Text', transform: fullTransform(raster.width, raster.height, origin[0], origin[1]), image: raster, text: writeTextStyle(style) })
  owner.insertLive(layer)
  open(owner, layer, style, true, [0, 0])
}

// Opens the selected text layer, the caret after its text unless a click places it.
export function editActiveText(at?: number) {
  if (draft) return
  const layer = store.active, style = liveText(layer)
  if (!layer || !style) return
  if (store.state.tool !== 'type') store.setTool('type')
  store.beginGesture('Edit Text')
  const index = at ?? style.content.length
  open(store, layer, style, false, [index, index])
}

// Keeps the text being edited as one undo step; new text with nothing typed leaves no layer.
export function finishText() {
  const d = draft
  if (!d) return
  draft = null
  field?.blur()
  if (d.isNew && !d.style.content.trim()) d.owner.cancelGesture()
  else if (!d.isNew && JSON.stringify(d.style) === JSON.stringify(d.original)) d.owner.cancelGesture()
  else {
    d.owner.endGesture()
    d.owner.history.renameLast(d.isNew ? 'New Text Layer' : 'Edit Text')
    const { colorRuns: _c, fontRuns: _f, ...kept } = d.style
    defaults = kept
  }
  d.owner.pixelsChanged()
  requestRender(); requestOverlay(); changed()
}

export function cancelText() {
  const d = draft
  if (!d) return
  draft = null
  field?.blur()
  d.owner.cancelGesture()
  d.owner.pixelsChanged()
  requestRender(); requestOverlay(); changed()
}

// A change from the Type bar: to the text being edited (its selected letters, for color and face), or the selected text layer, which
// opens for it, or the settings new text starts with.
export function changeTextStyle(change: (style: TextStyle, selection: [number, number]) => TextStyle) {
  if (!draft && liveText(store.active)) editActiveText()
  if (draft) { const next = change(draft.style, draft.selection); if (isValidText(next)) update(next); return }
  const next = change(defaults, [0, 0])
  if (isValidText(next)) { defaults = next; changed() }
}

export const setTypeColor = (color: RGB01) => changeTextStyle((s, [a, b]) => setTextColor(s, color, a, b))
export const typeColor = (): RGB01 => { const s = currentTextStyle(); return draft ? colorAt(s, draft.selection[0] === draft.selection[1] ? Math.max(0, draft.selection[0] - 1) : draft.selection[0]) : [s.red, s.green, s.blue] }
export const typeFont = () => { const s = currentTextStyle(); return draft && draft.selection[1] > draft.selection[0] ? fontAt(s, draft.selection[0]) : s.fontName }

// While the font menu is open the text shows the face under the pointer; `endFontPreview` puts it back.
export function previewFont(name: string) {
  if (!draft) return
  draft.preview ??= draft.style
  update(setTextFont(draft.preview, name, ...draft.selection))
}
export function keepFontPreview() { if (draft) draft.preview = null }
export function endFontPreview() { if (draft?.preview) { const original = draft.preview; draft.preview = null; update(original) } }

subscribeFonts(() => { if (draft) update(draft.style) })

// A text layer recolored whole, staying text (Fill with Foreground or Background on it).
export function recolorText(owner: Store, layer: Layer, color: RGB01) {
  const style = liveText(layer)
  if (!style) return false
  const next = setTextColor(style, color, 0, 0), { raster } = rasterizeText(next)
  owner.updateLayer(layer.id, { image: raster, text: writeTextStyle(next), deep: undefined }, 'Fill Text')
  owner.pixelsChanged()
  return true
}

Store.recolorText = recolorText

// Another layer chosen, or another tab: the text being edited is kept first.
const previous = Store.beforeLayerChange
Store.beforeLayerChange = (owner, next) => { previous?.(owner, next); if (draft && (owner !== draft.owner || next !== draft.layerId)) finishText() }

function blinking() {
  const tick = () => { if (!draft) return; requestOverlay(); setTimeout(tick, 250) }
  setTimeout(tick, 250)
}

// MARK: The canvas

// The box's edges and corners, clockwise from the top-left, in layer pixels.
const handlePoints = (w: number, h: number): [number, number][] => [[0, 0], [w / 2, 0], [w, 0], [w, h / 2], [w, h], [w / 2, h], [0, h], [0, h / 2]]

function handleAt(d: Draft, screen: [number, number]) {
  const toDoc = toDocument(d), [w, h] = d.size
  const reach = 8
  return handlePoints(w, h).findIndex(p => { const [x, y] = view.toScreen(...apply(toDoc, ...p)); return Math.abs(x - screen[0]) <= reach && Math.abs(y - screen[1]) <= reach })
}

function insideBox(d: Draft, point: [number, number]) {
  const [x, y] = apply(invert(toDocument(d)), ...point)
  return x >= -4 / view.zoom && y >= -4 / view.zoom && x <= d.size[0] + 4 / view.zoom && y <= d.size[1] + 4 / view.zoom
}

function textLayerAt(point: [number, number]) {
  return drawOrder(store.doc).filter(effectivelyVisible).reverse().map(e => e.layer).find(layer => {
    if (!liveText(layer)) return false
    const [x, y] = apply(invert(pixelToDocument(layer.transform, layer.image!.width, layer.image!.height)), ...point)
    return x >= 0 && y >= 0 && x <= layer.image!.width && y <= layer.image!.height
  })
}

const pixelIndex = (d: Draft, point: [number, number]) => { const [x, y] = apply(invert(toDocument(d)), ...point); return indexAt(d.layout, x, y) }

export const typeTool: ToolHandler = {
  down(p: Pointer) {
    if (draft && draft.owner === store && insideBox(draft, p.point)) {
      const handle = handleAt(draft, p.screen)
      if (handle >= 0) {
        // Dragging a handle turns point text into a box of the size it is now, which then wraps it rather than scaling it.
        const toDoc = toDocument(draft)
        pointerDrag = { kind: 'resize', handle, startBox: [0, 0, draft.size[0], draft.size[1]], toPixel: invert(toDoc), toDoc, size: draft.size, transform: draft.transform }
        if (!draft.style.boxSize) draft.style = { ...draft.style, boxSize: [draft.size[0], draft.size[1]] }
        return
      }
      const index = pixelIndex(draft, p.point)
      if (p.clicks === 2) { const [a, b] = wordAt(draft.style.content, index); select(a, b); return }
      if (p.clicks >= 3) {
        const content = draft.style.content, a = content.lastIndexOf('\n', index - 1) + 1, e = content.indexOf('\n', index)
        select(a, e < 0 ? content.length : e); return
      }
      select(p.shift ? draft.anchor : index, index)
      pointerDrag = { kind: 'select' }
      return
    }
    if (draft) finishText()
    const layer = textLayerAt(p.point)
    if (layer) {
      store.setActive(layer.id)
      const style = liveText(layer)!, { layout } = rasterizeText(style)
      const [x, y] = apply(invert(pixelToDocument(layer.transform, layer.image!.width, layer.image!.height)), ...p.point)
      editActiveText(indexAt(layout, x, y))
      pointerDrag = { kind: 'select' }
      return
    }
    boxDrag = { start: p.point, end: p.point }
  },
  move(p: Pointer) {
    if (boxDrag) { boxDrag.end = p.point; requestOverlay(); return }
    if (!draft || !pointerDrag) return
    if (pointerDrag.kind === 'select') { const index = pixelIndex(draft, p.point); select(draft.anchor, index); return }
    // A box's edge or corner follows the pointer in the layer's own pixels; the opposite side stays put.
    const r = pointerDrag, [x, y] = apply(r.toPixel, ...p.point), box = [...r.startBox]
    if ([0, 6, 7].includes(r.handle)) box[0] = Math.min(x, box[2] - 16)
    if ([2, 3, 4].includes(r.handle)) box[2] = Math.max(x, box[0] + 16)
    if ([0, 1, 2].includes(r.handle)) box[1] = Math.min(y, box[3] - 16)
    if ([4, 5, 6].includes(r.handle)) box[3] = Math.max(y, box[1] + 16)
    const size: [number, number] = [Math.round(box[2] - box[0]), Math.round(box[3] - box[1])]
    draft.transform = r.transform; draft.size = r.size
    update({ ...draft.style, boxSize: size }, [box[0], box[1]])
  },
  up() {
    pointerDrag = null
    const b = boxDrag
    boxDrag = null
    if (!b) return
    const x = Math.min(b.start[0], b.end[0]), y = Math.min(b.start[1], b.end[1]), w = Math.abs(b.end[0] - b.start[0]), h = Math.abs(b.end[1] - b.start[1])
    if (w < 4 && h < 4) beginNew(b.start)
    else beginNew([Math.round(x), Math.round(y)], [Math.max(16, Math.round(w)), Math.max(16, Math.round(h))])
  },
  key(event) {
    if (!draft) {
      // Return opens the selected text layer.
      if (event.key === 'Enter' && liveText(store.active)) { editActiveText(); return true }
      return false
    }
    if (event.key === 'Escape') { cancelText(); return true }
    if (event.key === 'Enter') { finishText(); return true }
    focusField()
    return false
  },
  busy: () => !!draft || !!boxDrag || !!pointerDrag,
  settle: () => finishText(),
  cursor: (p) => {
    if (draft && p && insideBox(draft, p.point)) {
      const handle = handleAt(draft, p.screen)
      if (handle >= 0) return ['nwse-resize', 'ns-resize', 'nesw-resize', 'ew-resize', 'nwse-resize', 'ns-resize', 'nesw-resize', 'ew-resize'][handle]
    }
    return 'text'
  },
  draw(context) {
    if (boxDrag) {
      const [x0, y0] = view.toScreen(...boxDrag.start), [x1, y1] = view.toScreen(...boxDrag.end)
      context.strokeStyle = '#3d8bfd'; context.lineWidth = 1; context.strokeRect(Math.min(x0, x1) + 0.5, Math.min(y0, y1) + 0.5, Math.abs(x1 - x0), Math.abs(y1 - y0))
    }
    const d = draft
    if (!d || d.owner !== store) return
    const toDoc = toDocument(d), screen = (x: number, y: number) => view.toScreen(...apply(toDoc, x, y))
    const [w, h] = d.size, corners = [[0, 0], [w, 0], [w, h], [0, h]].map(([x, y]) => screen(x, y))
    context.beginPath(); corners.forEach(([x, y], i) => i ? context.lineTo(x, y) : context.moveTo(x, y)); context.closePath()
    context.strokeStyle = 'rgba(61,139,253,0.9)'; context.lineWidth = 1; context.stroke()
    // The selection, translucent over the letters drawn beneath.
    context.fillStyle = 'rgba(61,139,253,0.35)'
    for (const r of selectionRects(d.layout, ...d.selection)) {
      context.beginPath(); [[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]].forEach(([x, y], i) => { const [sx, sy] = screen(x, y); if (i) context.lineTo(sx, sy); else context.moveTo(sx, sy) }); context.fill()
    }
    if (d.selection[0] === d.selection[1] && (performance.now() - blink) % 1000 < 600) {
      const caret = caretAt(d.layout, d.selection[0]), [ax, ay] = screen(caret.x, caret.top), [bx, by] = screen(caret.x, caret.bottom)
      context.beginPath(); context.moveTo(ax, ay); context.lineTo(bx, by); context.strokeStyle = '#3d8bfd'; context.lineWidth = 1.5; context.stroke()
    }
    // Handles for a box, as the Move tool's; a box with text that doesn't fit shows a plus in its last one.
    for (const [i, p] of handlePoints(w, h).entries()) {
      const [x, y] = screen(...p)
      context.fillStyle = '#fff'; context.strokeStyle = '#3d8bfd'
      context.fillRect(x - 3.5, y - 3.5, 7, 7); context.strokeRect(x - 3.5, y - 3.5, 7, 7)
      if (i === 4 && d.layout.overflow) { context.beginPath(); context.moveTo(x - 2.5, y); context.lineTo(x + 2.5, y); context.moveTo(x, y - 2.5); context.lineTo(x, y + 2.5); context.strokeStyle = '#d33'; context.stroke() }
    }
  },
}
