import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useEditor } from './hooks'
import { Store, store, type Tool } from '../editor/store'
import { prefs, subscribePrefs, gridLines } from '../editor/prefs'
import { Compositor } from '../render/compositor'
import { outline } from '../model/selection'
import { Raster } from '../model/raster'
import { ContextMenu, type MenuItem } from './Menu'
import { copyMerged } from '../editor/actions'
import { copyLayersInto, paste } from '../editor/clipboard'
import { draggedFromOtherProject, takeDraggedLayers } from './Tabs'
import { actualSize, canvasDrag, canvasPicker, compositor, fit, onFrame, renderFull, renderScaleFor, requestRender, setCompositor, snapLines, view, viewChanged, modifierHeld, releaseOnceModifiers, subscribeModifiers, tapModifier, touchModifiers, type ModifierKey } from './canvasState'
import { useCoarse } from './layout'
import type { Pointer, ToolHandler } from '../tools/tool'
import { eyedropper, paint } from '../tools/paint'
import { smear } from '../tools/smear'
import { lasso, magic, marquee } from '../tools/select'
import { move } from '../tools/move'
import { gradient } from '../tools/gradient'
import { shapeTool } from '../tools/shape'
import { crop, startCrop } from '../tools/crop'
import { cancelGuideDrag, endGuideDrag, guideDrag, moveGuideDrag, rulerSize, startGuideDrag } from '../tools/guides'
import { isMac } from '../editor/shortcuts'

export { actualSize, fit, renderFull, requestRender, view, viewChanged, zoomBy } from './canvasState'

const idle: ToolHandler = {}
const zoomTool: ToolHandler = { down: p => { view.zoomAt(p.alt ? 0.5 : 2, ...p.screen); viewChanged(); requestRender(false) }, cursor: () => 'zoom-in' }
export const handlers: Record<Tool, ToolHandler> = {
  move, marquee, lasso, wand: magic, brush: paint, eraser: paint, heal: paint, clone: paint, smear, gradient, shape: shapeTool, crop, eyedropper, hand: idle, zoom: zoomTool,
}
export const activeHandler = () => handlers[store.state.tool]
const brushTools = new Set<Tool>(['brush', 'eraser', 'heal', 'clone', 'smear'])

let stageCanvas: HTMLCanvasElement | null = null
let overlayCanvas: HTMLCanvasElement | null = null
let antsFor: { selection: Raster | null; loops: Int32Array[] | null } = { selection: null, loops: null }

// The composite, then everything drawn over it: grid, guides, snap lines, the selection's marching ants, the tool's own marks, rulers.
function frame(contentDirty: boolean) {
  if (!compositor || !stageCanvas) return
  const { doc } = store.state
  const dpr = window.devicePixelRatio || 1
  if (store.hasDocument && contentDirty) compositor.render(doc, renderScaleFor(doc, compositor.maxSize))
  const style = getComputedStyle(document.documentElement).getPropertyValue('--canvas').trim() || '#161617'
  const rgb = [1, 3, 5].map(i => parseInt(style.slice(i, i + 2), 16) / 255) as [number, number, number]
  if (store.hasDocument) compositor.present([view.zoom * dpr, 0, 0, 0, view.zoom * dpr, 0, view.offsetX * dpr, view.offsetY * dpr, 1], stageCanvas.width, stageCanvas.height, rgb)
  else { const gl = compositor.gl; gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.clearColor(...rgb, 1); gl.clear(gl.COLOR_BUFFER_BIT) }
  drawOverlay()
}

export function drawOverlay() {
  const canvas = overlayCanvas
  if (!canvas) return
  const c = canvas.getContext('2d')!
  const dpr = window.devicePixelRatio || 1
  c.setTransform(1, 0, 0, 1, 0, 0)
  c.clearRect(0, 0, canvas.width, canvas.height)
  if (!store.hasDocument) return
  c.setTransform(dpr, 0, 0, dpr, 0, 0)
  const { doc, selection } = store.state
  const px = (v: number) => Math.round(v * dpr) / dpr + 0.5 / dpr
  const [docX0, docY0] = view.toScreen(0, 0), [docX1, docY1] = view.toScreen(doc.width, doc.height)
  // A pixel grid at 800% and above.
  if (prefs.pixelGrid && view.zoom >= 8) {
    c.strokeStyle = 'rgba(128,128,128,0.35)'; c.lineWidth = 1 / dpr; c.beginPath()
    const v = view.visible(doc.width, doc.height)
    for (let x = Math.floor(v.x); x <= Math.ceil(v.x + v.w); x++) { const sx = px(view.toScreen(x, 0)[0]); c.moveTo(sx, Math.max(0, docY0)); c.lineTo(sx, Math.min(view.height, docY1)) }
    for (let y = Math.floor(v.y); y <= Math.ceil(v.y + v.h); y++) { const sy = px(view.toScreen(0, y)[1]); c.moveTo(Math.max(0, docX0), sy); c.lineTo(Math.min(view.width, docX1), sy) }
    c.stroke()
  }
  if (prefs.grid) {
    const g = prefs.gridSettings, alpha = g.opacity / 100, color = g.color.map(v => Math.round(v * 255)).join(',')
    const step = g.spacing / Math.max(1, Math.min(g.subdivisions, g.spacing))
    c.lineWidth = 1 / dpr
    for (const major of [false, true]) {
      if (!major && step * view.zoom < 4) continue
      c.beginPath()
      for (const x of gridLines(doc.width)) if ((Math.round(x) % g.spacing === 0) === major) { const sx = px(view.toScreen(x, 0)[0]); c.moveTo(sx, docY0); c.lineTo(sx, docY1) }
      for (const y of gridLines(doc.height)) if ((Math.round(y) % g.spacing === 0) === major) { const sy = px(view.toScreen(0, y)[1]); c.moveTo(docX0, sy); c.lineTo(docX1, sy) }
      c.setLineDash(major ? (g.style === 'Dashed Lines' ? [4, 3] : g.style === 'Dots' ? [1, 2] : []) : [1, 2])
      c.strokeStyle = `rgba(${color},${major ? alpha : alpha * 28 / 45})`; c.stroke()
    }
    c.setLineDash([])
  }
  if (prefs.guides) {
    c.strokeStyle = 'rgba(0,255,255,0.9)'; c.lineWidth = 1 / dpr; c.beginPath()
    for (const guide of doc.guides) {
      if (guide.axis === 'vertical') { const x = px(view.toScreen(guide.position, 0)[0]); c.moveTo(x, 0); c.lineTo(x, view.height) }
      else { const y = px(view.toScreen(0, guide.position)[1]); c.moveTo(0, y); c.lineTo(view.width, y) }
    }
    c.stroke()
  }
  if (snapLines.x.length || snapLines.y.length) {
    c.strokeStyle = '#3d8bfd'; c.lineWidth = 1; c.beginPath()
    for (const x of snapLines.x) { const sx = px(view.toScreen(x, 0)[0]); c.moveTo(sx, docY0); c.lineTo(sx, docY1) }
    for (const y of snapLines.y) { const sy = px(view.toScreen(0, y)[1]); c.moveTo(docX0, sy); c.lineTo(docX1, sy) }
    c.stroke()
  }
  if (selection) {
    if (antsFor.selection !== selection) antsFor = { selection, loops: outline(selection) }
    c.beginPath()
    if (antsFor.loops) for (const loop of antsFor.loops) for (let i = 0; i < loop.length; i += 2) {
      const [x, y] = view.toScreen(loop[i], loop[i + 1])
      if (i === 0) c.moveTo(px(x), px(y)); else c.lineTo(px(x), px(y))
      if (i === loop.length - 2) c.closePath()
    }
    c.lineWidth = 1
    c.setLineDash([4, 4])
    c.strokeStyle = '#fff'; c.lineDashOffset = 0; c.stroke()
    c.strokeStyle = '#000'; c.lineDashOffset = -(performance.now() / 60 % 8) + 4; c.stroke()
    c.setLineDash([])
  }
  activeHandler().draw?.(c)
  if (prefs.rulers) drawRulers(c)
}

// Rulers in document pixels along the top and left, ticked at the first round step at least 70 points apart.
function drawRulers(c: CanvasRenderingContext2D) {
  const steps = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000, 20000, 25000]
  const major = steps.find(s => s * view.zoom >= 70) ?? 50000, minor = major / 10
  c.fillStyle = 'rgb(51,51,51)'; c.fillRect(0, 0, view.width, rulerSize); c.fillRect(0, 0, rulerSize, view.height)
  c.strokeStyle = 'rgb(158,158,158)'; c.fillStyle = 'rgb(199,199,199)'; c.lineWidth = 1
  c.font = '8px ui-monospace, Menlo, monospace'
  c.beginPath()
  const [startX] = view.toDocument(rulerSize, 0), [endX] = view.toDocument(view.width, 0)
  for (let v = Math.floor(startX / minor) * minor; v <= endX; v += minor) {
    const x = Math.round(view.toScreen(v, 0)[0]) + 0.5, i = Math.round(v / minor), length = i % 10 === 0 ? 8 : i % 5 === 0 ? 5 : 3
    if (x < rulerSize) continue
    c.moveTo(x, rulerSize); c.lineTo(x, rulerSize - length)
    if (i % 10 === 0) c.fillText(String(Math.round(v)), x + 2, 8)
  }
  const [, startY] = view.toDocument(0, rulerSize), [, endY] = view.toDocument(0, view.height)
  for (let v = Math.floor(startY / minor) * minor; v <= endY; v += minor) {
    const y = Math.round(view.toScreen(0, v)[1]) + 0.5, i = Math.round(v / minor), length = i % 10 === 0 ? 8 : i % 5 === 0 ? 5 : 3
    if (y < rulerSize) continue
    c.moveTo(rulerSize, y); c.lineTo(rulerSize - length, y)
    if (i % 10 === 0) { const label = String(Math.round(v)); c.save(); c.translate(8, y - 2); c.rotate(-Math.PI / 2); c.fillText(label, 0, 0); c.restore() }
  }
  c.stroke()
  c.fillStyle = 'rgb(51,51,51)'; c.fillRect(0, 0, rulerSize, rulerSize)
  c.strokeStyle = 'rgba(0,0,0,0.5)'; c.beginPath(); c.moveTo(0, rulerSize + 0.5); c.lineTo(view.width, rulerSize + 0.5); c.moveTo(rulerSize + 0.5, 0); c.lineTo(rulerSize + 0.5, view.height); c.stroke()
}

// The canvas's right-click menu: what applies to the selection when there is one, otherwise to the layers under the pointer.
function canvasMenu(point: [number, number]): MenuItem[] {
  const { selection } = store.state
  const layer = store.active
  const undo = store.history.undoName, redo = store.history.redoName
  const history: MenuItem[] = [
    { label: undo ? `Undo ${undo}` : 'Undo', shortcut: '⌘Z', action: () => store.undo(), disabled: !undo },
    { label: redo ? `Redo ${redo}` : 'Redo', shortcut: '⇧⌘Z', action: () => store.redo(), disabled: !redo },
  ]
  const tail: MenuItem[] = [
    { label: 'Copy Merged', shortcut: '⇧⌘C', action: copyMerged },
    { label: 'Paste', shortcut: '⌘V', action: () => paste() },
    'divider',
    { label: 'Fit Canvas', shortcut: '⌘0', action: fit },
    { label: 'Actual Pixels', shortcut: '⌘1', action: actualSize },
  ]
  const paintable = !!layer && (store.state.editingMask ? !!layer.mask : !layer.isGroup && !layer.adjustment)
  if (selection) return [
    ...history, 'divider',
    { label: 'Deselect', shortcut: '⌘D', action: () => store.deselect() },
    { label: 'Select Inverse', shortcut: '⇧⌘I', action: () => store.invertSelection() },
    'divider',
    { label: 'Fill with Foreground', shortcut: '⌥⌫', action: () => store.fill(store.paletteColor('foreground')), disabled: !paintable },
    { label: 'Fill with Background', shortcut: '⌘⌫', action: () => store.fill(store.paletteColor('background')), disabled: !paintable },
    { label: 'Clear', shortcut: '⌫', action: () => store.fill(null), disabled: !paintable },
    { label: 'Content-Aware Fill…', shortcut: '⇧⌫', action: () => store.set({ panel: 'Content-Aware Fill' }), disabled: !layer?.image || store.state.editingMask },
    'divider',
    { label: 'Crop to Selection', action: () => store.cropToSelection() },
    { label: 'Mask to Selection', action: () => layer && store.addMask(layer.id, false, true), disabled: !layer || !!layer.mask },
    'divider', ...tail,
  ]
  const under = store.layersAt(...point)
  return [
    ...history, 'divider',
    { label: 'Select Layer', disabled: !under.length, submenu: under.map(l => ({ label: l.name, checked: l.id === layer?.id, action: () => store.setActive(l.id) })) },
    { label: 'Select All', shortcut: '⌘A', action: () => store.selectAll() },
    'divider',
    { label: 'Transform', shortcut: 'V', action: () => store.setTool('move'), disabled: !layer?.image || layer.isGroup },
    { label: 'Duplicate Layer', shortcut: '⌘J', action: () => store.duplicate(), disabled: !layer },
    { label: store.mergeTitle, shortcut: '⌘E', action: () => store.mergeDown(), disabled: !store.canMerge },
    { label: 'Flip Horizontal', action: () => store.flipLayer('x'), disabled: !layer },
    { label: 'Flip Vertical', action: () => store.flipLayer('y'), disabled: !layer },
    { label: layer?.visible === false ? 'Show Layer' : 'Hide Layer', action: () => layer && store.updateLayer(layer.id, { visible: !layer.visible }, layer.visible ? 'Hide Layer' : 'Show Layer'), disabled: !layer },
    'divider', ...tail,
  ]
}

export function Stage() {
  const ref = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const overlayRef = useRef<HTMLCanvasElement>(null)
  const pan = useRef<{ x: number; y: number; offsetX: number; offsetY: number } | null>(null)
  const guideGesture = useRef(false)
  const lastPointer = useRef<Pointer | null>(null)
  const [space, setSpace] = useState(false)
  const statusRef = useRef<HTMLDivElement>(null)
  // Touch: fingers on the stage, a two-finger pinch (zoom and pan around the document point first under the fingers), and the
  // one-finger gesture so far — whether it reached the tool, and `dead` once a second finger or a long press took it over.
  const touches = useRef(new Map<number, [number, number]>())
  const pinch = useRef<{ doc: [number, number]; distance: number; zoom: number } | null>(null)
  const touch = useRef<{ tool: boolean; dead: boolean; start: [number, number]; timer: number } | null>(null)
  const lastPointerType = useRef('mouse')
  const [error, setError] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)
  const closeMenu = useCallback(() => setMenu(null), [])
  const state = useEditor()
  const coarse = useCoarse()

  useEffect(() => {
    try { setCompositor(new Compositor(canvasRef.current!)) } catch (e) { setError((e as Error).message); return }
    stageCanvas = canvasRef.current
    overlayCanvas = overlayRef.current
    Store.renderer = renderFull
    onFrame(frame)
    compositor!.onStale = () => requestRender()
    const resize = () => {
      const box = ref.current!.getBoundingClientRect(), dpr = window.devicePixelRatio || 1
      for (const canvas of [canvasRef.current!, overlayRef.current!]) { canvas.width = Math.round(box.width * dpr); canvas.height = Math.round(box.height * dpr) }
      const first = view.width <= 1
      view.width = box.width; view.height = box.height
      if (first && store.hasDocument) view.fit(store.doc.width, store.doc.height)
      requestRender(false)
    }
    const observer = new ResizeObserver(resize)
    observer.observe(ref.current!)
    resize()
    const stop = subscribePrefs(() => requestRender(false))
    return () => { observer.disconnect(); stop() }
  }, [])

  // Each tab keeps its own view: switching away saves it, coming back restores it, a newly opened project is fitted.
  const shown = useRef<{ tab: Store; id: string } | null>(null)
  useEffect(() => {
    const previous = shown.current
    if (previous?.tab !== store || previous.id !== state.doc.id) {
      if (previous && previous.tab !== store) previous.tab.view = { zoom: view.zoom, offsetX: view.offsetX, offsetY: view.offsetY }
      if (store.view && previous?.tab !== store) Object.assign(view, store.view)
      else if (store.hasDocument) view.fit(state.doc.width, state.doc.height)
      viewChanged()
    }
    shown.current = { tab: store, id: state.doc.id }
    requestRender()
  }, [state.doc, state.pixelRevision])
  useEffect(() => requestRender(false), [state.selection, state.activeId, state.selectedIds, state.editingMask, state.crop, state.brush])

  // Leaving a tool applies or cancels whatever it had pending (a gradient, a distort, a polygon), and the Crop tool starts its frame.
  const lastTool = useRef<Tool>(state.tool)
  useEffect(() => {
    if (lastTool.current !== state.tool) { handlers[lastTool.current].settle?.(); if (state.tool === 'crop') startCrop() }
    lastTool.current = state.tool
    requestRender(false)
  }, [state.tool])

  useEffect(() => {
    const interval = setInterval(() => { if (store.state.selection) drawOverlay() }, 100)
    return () => clearInterval(interval)
  }, [])

  const pointerFrom = (event: React.PointerEvent, coalesced = false): Pointer => {
    const box = ref.current!.getBoundingClientRect()
    const screen: [number, number] = [event.clientX - box.left, event.clientY - box.top]
    const native = event.nativeEvent
    const points = coalesced && 'getCoalescedEvents' in native ? native.getCoalescedEvents().map(e => view.toDocument(e.clientX - box.left, e.clientY - box.top)) : []
    return { point: view.toDocument(...screen), screen, shift: event.shiftKey || modifierHeld('shift'), alt: event.altKey || modifierHeld('alt'), command: (isMac ? event.metaKey : event.ctrlKey) || modifierHeld('command'), control: isMac && event.ctrlKey, button: event.button, clicks: event.detail, coalesced: points, pressure: event.pointerType === 'pen' ? event.pressure : undefined }
  }

  // The cursor follows hover without a React render per pointer move.
  function updateCursor() { if (ref.current) { const next = cursorFor(); if (ref.current.style.cursor !== next) ref.current.style.cursor = next } }

  const fingers = () => {
    const box = ref.current!.getBoundingClientRect(), [a, b] = [...touches.current.values()]
    return { mid: [(a[0] + b[0]) / 2 - box.left, (a[1] + b[1]) / 2 - box.top] as [number, number], distance: Math.max(1, Math.hypot(a[0] - b[0], a[1] - b[1])) }
  }

  // A second finger or a long press takes over: whatever the first finger started is undone.
  function abandonTouch() {
    const t = touch.current
    if (!t || t.dead) return
    clearTimeout(t.timer)
    t.dead = true
    if (t.tool) activeHandler().key?.(new KeyboardEvent('keydown', { key: 'Escape' }))
    if (guideGesture.current) { cancelGuideDrag(); guideGesture.current = false }
    if (canvasDrag.current) canvasDrag.current.up()
    pan.current = null
    requestRender()
  }

  function longPress() {
    const t = touch.current
    if (!t || t.dead || brushTools.has(store.state.tool)) return
    abandonTouch()
    const box = ref.current!.getBoundingClientRect()
    setMenu({ x: t.start[0], y: t.start[1], items: canvasMenu(view.toDocument(t.start[0] - box.left, t.start[1] - box.top)) })
  }

  const onPointerDown = (event: React.PointerEvent) => {
    if (!store.hasDocument || menu) return
    lastPointerType.current = event.pointerType
    if (event.pointerType === 'touch') {
      touches.current.set(event.pointerId, [event.clientX, event.clientY])
      if (touches.current.size > 1) {
        ;(event.target as Element).setPointerCapture(event.pointerId)
        abandonTouch()
        if (touches.current.size === 2) { const { mid, distance } = fingers(); pinch.current = { doc: view.toDocument(...mid), distance, zoom: view.zoom } }
        return
      }
      touch.current = { tool: false, dead: false, start: [event.clientX, event.clientY], timer: window.setTimeout(longPress, 550) }
    }
    ref.current!.focus()
    ;(event.target as Element).setPointerCapture(event.pointerId)
    const p = pointerFrom(event)
    lastPointer.current = p
    if (space || store.state.tool === 'hand' || event.button === 1) { pan.current = { x: event.clientX, y: event.clientY, offsetX: view.offsetX, offsetY: view.offsetY }; updateCursor(); return }
    if (prefs.rulers && event.button === 0 && (p.screen[0] < rulerSize || p.screen[1] < rulerSize)) {
      if ((p.screen[0] >= rulerSize || p.screen[1] >= rulerSize) && !prefs.lockGuides) { startGuideDrag(p.screen[1] < rulerSize ? 'horizontal' : 'vertical', null, p); guideGesture.current = true }
      return
    }
    if (canvasPicker.current && event.button === 0) { canvasPicker.current(p.point, p.shift, p.alt); canvasDrag.startX = event.clientX; return }
    if (event.button === 2 && !brushTools.has(store.state.tool)) return
    activeHandler().down?.(p)
    if (touch.current) touch.current.tool = true
    guideGesture.current = !!guideDrag()
  }

  const onPointerMove = (event: React.PointerEvent) => {
    if (event.pointerType === 'touch' && touches.current.has(event.pointerId)) {
      touches.current.set(event.pointerId, [event.clientX, event.clientY])
      if (pinch.current && touches.current.size === 2) {
        const { mid, distance } = fingers(), start = pinch.current
        view.zoom = Math.min(64, Math.max(0.01, start.zoom * distance / start.distance))
        view.offsetX = mid[0] - start.doc[0] * view.zoom; view.offsetY = mid[1] - start.doc[1] * view.zoom
        viewChanged(); requestRender(false)
        return
      }
      const t = touch.current
      if (!t || t.dead) return
      if (Math.hypot(event.clientX - t.start[0], event.clientY - t.start[1]) > 10) clearTimeout(t.timer)
    }
    const p = pointerFrom(event, true)
    lastPointer.current = p
    // Straight to the DOM: re-rendering the canvas component on every pointer move just for this costs more than it shows.
    if (statusRef.current) statusRef.current.textContent = `${Math.floor(p.point[0])}, ${Math.floor(p.point[1])}  ·  ${Math.round(view.zoom * 100)}%`
    if (pan.current) { view.offsetX = pan.current.offsetX + event.clientX - pan.current.x; view.offsetY = pan.current.offsetY + event.clientY - pan.current.y; viewChanged(); requestRender(false); return }
    if (guideGesture.current) { moveGuideDrag(p); return }
    if (canvasDrag.current && event.buttons) { canvasDrag.current.move(event.clientX - canvasDrag.startX, p.command); return }
    if (event.buttons) activeHandler().move?.(p)
    else { activeHandler().hover?.(p); updateCursor() }
  }

  const onPointerUp = (event: React.PointerEvent) => {
    if (event.pointerType === 'touch' && touches.current.has(event.pointerId)) {
      touches.current.delete(event.pointerId)
      if (touches.current.size < 2) pinch.current = null
      const t = touch.current
      if (t) clearTimeout(t.timer)
      if (touches.current.size === 0) touch.current = null
      // A finger's brush circle shouldn't stay behind once it lifts.
      if (touches.current.size === 0) queueMicrotask(() => { activeHandler().leave?.(); requestRender(false) })
      if (!t || t.dead) return
    }
    const p = pointerFrom(event)
    releaseOnceModifiers()
    if (pan.current) { pan.current = null; updateCursor(); return }
    if (guideGesture.current) { guideGesture.current = false; endGuideDrag(p); return }
    if (canvasDrag.current) { canvasDrag.current.up(); return }
    if (canvasPicker.current) return
    activeHandler().up?.(p)
  }

  useEffect(() => {
    const element = ref.current!
    const wheel = (event: WheelEvent) => {
      event.preventDefault()
      const box = element.getBoundingClientRect()
      if (event.ctrlKey || event.metaKey) view.zoomAt(Math.exp(-event.deltaY * 0.01), event.clientX - box.left, event.clientY - box.top)
      else { view.offsetX -= event.deltaX; view.offsetY -= event.deltaY }
      viewChanged()
      requestRender(false)
    }
    element.addEventListener('wheel', wheel, { passive: false })
    // Safari's own pinch would zoom the page instead of the canvas.
    const gesture = (event: Event) => event.preventDefault()
    element.addEventListener('gesturestart', gesture)
    const typing = (event: KeyboardEvent) => event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement
    const down = (event: KeyboardEvent) => {
      if (typing(event)) return
      if (event.code === 'Space') { setSpace(true); event.preventDefault() }
      if (event.key === 'Escape' && guideDrag()) { cancelGuideDrag(); guideGesture.current = false; event.preventDefault() }
      if (event.key === 'Alt' && lastPointer.current) { activeHandler().hover?.({ ...lastPointer.current, alt: true }); updateCursor() }
    }
    const up = (event: KeyboardEvent) => {
      if (event.code === 'Space') setSpace(false)
      if (event.key === 'Alt' && lastPointer.current) { activeHandler().hover?.({ ...lastPointer.current, alt: false }); updateCursor() }
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => { element.removeEventListener('wheel', wheel); element.removeEventListener('gesturestart', gesture); window.removeEventListener('keydown', down); window.removeEventListener('keyup', up) }
  }, [])

  const handler = activeHandler()
  const cursorFor = () => space || store.state.tool === 'hand' ? (pan.current ? 'grabbing' : 'grab') : canvasPicker.current ? 'crosshair' : activeHandler().cursor?.(lastPointer.current) ?? 'default'
  useLayoutEffect(updateCursor)
  return (
    <div ref={ref} className="stage" tabIndex={0} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
      onPointerLeave={() => { lastPointer.current = null; activeHandler().leave?.(); if (statusRef.current) statusRef.current.textContent = `${state.doc.width} × ${state.doc.height}  ·  ${Math.round(view.zoom * 100)}%`; requestRender(false) }}
      onDragOver={e => { if (draggedFromOtherProject()) { e.preventDefault(); e.stopPropagation() } }}
      onDrop={e => {
        if (!draggedFromOtherProject()) return
        e.preventDefault(); e.stopPropagation()
        const box = ref.current!.getBoundingClientRect(), layers = takeDraggedLayers()
        if (layers?.length) copyLayersInto(store, layers, 'Copy Layers from Project', view.toDocument(e.clientX - box.left, e.clientY - box.top))
      }}
      onContextMenu={e => { e.preventDefault(); if (lastPointerType.current !== 'touch' && store.hasDocument && !handler.busy?.() && !brushTools.has(state.tool)) { const box = ref.current!.getBoundingClientRect(); setMenu({ x: e.clientX, y: e.clientY, items: canvasMenu(view.toDocument(e.clientX - box.left, e.clientY - box.top)) }) } }}>
      <canvas ref={canvasRef} />
      <canvas ref={overlayRef} style={{ pointerEvents: 'none' }} />
      {store.hasDocument && <div ref={statusRef} className="status">{`${state.doc.width} × ${state.doc.height}  ·  ${Math.round(view.zoom * 100)}%`}</div>}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={closeMenu} />}
      {coarse && store.hasDocument && <ModifierPad />}
      {error && <div className="welcome"><div className="card"><h1>Can’t start the canvas</h1><p className="muted">{error}</p></div></div>}
    </div>
  )
}

// Shift, Option and Command for fingers, along the canvas's left edge.
function ModifierPad() {
  const held = useSyncExternalStore(subscribeModifiers, touchModifiers)
  const labels: Record<ModifierKey, string> = isMac ? { shift: '⇧', alt: '⌥', command: '⌘' } : { shift: 'Shift', alt: 'Alt', command: 'Ctrl' }
  return (
    <div className="modifier-pad" onPointerDown={e => e.stopPropagation()} onPointerUp={e => e.stopPropagation()} onPointerMove={e => e.stopPropagation()}>
      {(['shift', 'alt', 'command'] as const).map(key => <button key={key} className={held[key]} title={`${labels[key]}: tap holds it for the next touch, tap again to lock it`} onClick={() => tapModifier(key)}>{labels[key]}</button>)}
    </div>
  )
}
