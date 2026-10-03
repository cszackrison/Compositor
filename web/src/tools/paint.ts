import { store, tipFamily } from '../editor/store'
import { prefs } from '../editor/prefs'
import { BrushStroke, type StrokeMode } from './brush'
import { Raster } from '../model/raster'
import { lazyBlur } from '../model/pixels'
import { call, withBuffers } from '../kernels'
import { apply, invert, type Mat3 } from '../render/gl'
import { pixelToDocument } from '../render/compositor'
import { GPUBrush } from '../render/gpuBrush'
import { grownTransform, placeOnGrid } from '../editor/filters'
import { padMask } from '../editor/floating'
import { compositor, requestOverlay, requestRender, samplePixels, view } from '../ui/canvasState'
import type { ToolHandler } from './tool'

type Stroke = { stroke: BrushStroke; layerId: string; isMask: boolean; heal: boolean; kept: { x: number; y: number; w: number; h: number } | null; maskKept: { x: number; y: number; w: number; h: number } | null; axis: 'x' | 'y' | null; anchor: [number, number] }
let current: Stroke | null = null
let lastEnd: { point: [number, number]; layerId: string; isMask: boolean } | null = null
let tipDrag: { start: number; diameter: number; hardness: number; hardnessMode: boolean } | null = null
let pointer: [number, number] | null = null
let altHeld = false

// Painting can reach past a layer's pixels to the whole canvas: the grid grows first, and shrinks back to what was painted after.
function growToCanvas(layerId: string): { x: number; y: number; w: number; h: number } | null {
  const layer = store.layer(layerId)!, image = layer.image!
  const toPixel = invert(pixelToDocument(layer.transform, image.width, image.height))
  const { width, height } = store.doc
  const corners = [[0, 0], [width, 0], [width, height], [0, height]].map(([x, y]) => apply(toPixel, x, y))
  const x0 = Math.min(0, Math.floor(Math.min(...corners.map(c => c[0])))), y0 = Math.min(0, Math.floor(Math.min(...corners.map(c => c[1]))))
  const x1 = Math.max(image.width, Math.ceil(Math.max(...corners.map(c => c[0])))), y1 = Math.max(image.height, Math.ceil(Math.max(...corners.map(c => c[1]))))
  if (x0 === 0 && y0 === 0 && x1 === image.width && y1 === image.height) return null
  if ((x1 - x0) * (y1 - y0) > 120_000_000) return null
  const grown = placeOnGrid(image, [x0, y0], x1 - x0, y1 - y0)
  const transform = grownTransform(layer.transform, pixelToDocument(layer.transform, image.width, image.height), image.width, image.height, [x0, y0], grown.width, grown.height)
  // A mask on the layer's own grid is padded with white (reveal) to the grown grid, so its coverage stays where it was.
  const mask = layer.mask && !layer.maskPlacement && !layer.mask.isUniform() ? padMask(layer.mask, image, [x0, y0], grown.width, grown.height, 255) : layer.mask
  store.updateLayerLive(layerId, { image: grown, transform, mask })
  return { x: -x0, y: -y0, w: image.width, h: image.height }
}

// The edge-majority tone of a mask (LayerMask.background): white when most edge pixels are light.
export function maskBackground(mask: Raster) {
  let sum = 0, count = 0
  for (let x = 0; x < mask.width; x++) { sum += mask.data[x] + mask.data[(mask.height - 1) * mask.width + x]; count += 2 }
  for (let y = 0; y < mask.height; y++) { sum += mask.data[y * mask.width] + mask.data[y * mask.width + mask.width - 1]; count += 2 }
  return sum * 2 >= count * 255 ? 255 : 0
}

// Brush strokes and gradients on a mask can reach the whole canvas: its grid grows first, the new area in the mask's edge tone, and
// is cropped back to what the stroke touched (plus the old pixels) afterwards, the mask then keeping its own placement.
export function growMaskToCanvas(layerId: string): { kept: { x: number; y: number; w: number; h: number }; base: import('../model/types').Transform } | null {
  const layer = store.layer(layerId)!
  let mask = layer.mask!
  let base = layer.maskPlacement ?? layer.transform
  if (mask.isUniform() && mask.width <= 2 && mask.height <= 2) mask = Raster.filled(Math.max(1, Math.round(base.size[0])), Math.max(1, Math.round(base.size[1])), 1, [mask.data[0]])
  const toDoc = pixelToDocument(base, mask.width, mask.height), toPixel = invert(toDoc)
  const { width, height } = store.doc
  const corners = [[0, 0], [width, 0], [width, height], [0, height]].map(([x, y]) => apply(toPixel, x, y))
  const x0 = Math.min(0, Math.floor(Math.min(...corners.map(c => c[0])))), y0 = Math.min(0, Math.floor(Math.min(...corners.map(c => c[1]))))
  const x1 = Math.max(mask.width, Math.ceil(Math.max(...corners.map(c => c[0])))), y1 = Math.max(mask.height, Math.ceil(Math.max(...corners.map(c => c[1]))))
  if ((x1 - x0) * (y1 - y0) > 120_000_000) return null
  const fill = maskBackground(mask)
  const grown = Raster.filled(x1 - x0, y1 - y0, 1, [fill])
  for (let y = 0; y < mask.height; y++) grown.data.set(mask.data.subarray(y * mask.width, (y + 1) * mask.width), (y - y0) * grown.width - x0)
  base = grownTransform(base, toDoc, mask.width, mask.height, [x0, y0], grown.width, grown.height)
  store.updateLayerLive(layerId, { mask: grown, maskPlacement: base })
  return { kept: { x: -x0, y: -y0, w: mask.width, h: mask.height }, base }
}

export function trimGrownMask(layerId: string, kept: { x: number; y: number; w: number; h: number }, touched: { x: number; y: number; w: number; h: number } | null) {
  const layer = store.layer(layerId)!, mask = layer.mask!, base = layer.maskPlacement!
  const x0 = Math.min(kept.x, touched?.x ?? kept.x), y0 = Math.min(kept.y, touched?.y ?? kept.y)
  const x1 = Math.max(kept.x + kept.w, touched ? touched.x + touched.w : 0), y1 = Math.max(kept.y + kept.h, touched ? touched.y + touched.h : 0)
  const cropped = new Raster(x1 - x0, y1 - y0, 1, mask.read(x0, y0, x1 - x0, y1 - y0))
  const placement = grownTransform(base, pixelToDocument(base, mask.width, mask.height), mask.width, mask.height, [x0, y0], cropped.width, cropped.height)
  const same = JSON.stringify({ ...placement, sampling: 0 }) === JSON.stringify({ ...layer.transform, sampling: 0 })
  store.updateLayerLive(layerId, { mask: cropped, maskPlacement: same ? null : placement })
}

// After a stroke on a grown grid: crop to the original pixels plus whatever the stroke left behind.
function trimToPainted(layerId: string, kept: { x: number; y: number; w: number; h: number }) {
  const layer = store.layer(layerId)!, image = layer.image!
  const bounds = new Uint32Array(4)
  withBuffers([{ data: image.data }, { data: bounds, out: true }], ([p, b]) => call('brush_alpha_bounds', p, image.width, image.height, image.width * 4, b))
  const empty = bounds[2] <= bounds[0]
  const x0 = Math.min(kept.x, empty ? kept.x : bounds[0]), y0 = Math.min(kept.y, empty ? kept.y : bounds[1])
  const x1 = Math.max(kept.x + kept.w, empty ? 0 : bounds[2]), y1 = Math.max(kept.y + kept.h, empty ? 0 : bounds[3])
  if (x0 === 0 && y0 === 0 && x1 === image.width && y1 === image.height) return
  const cropped = new Raster(x1 - x0, y1 - y0, 4, image.read(x0, y0, x1 - x0, y1 - y0))
  store.updateLayerLive(layerId, { image: cropped, transform: grownTransform(layer.transform, pixelToDocument(layer.transform, image.width, image.height), image.width, image.height, [x0, y0], cropped.width, cropped.height) })
}

function bilinear(raster: Raster | Uint8Array, width: number, height: number, channels: number, x: number, y: number, out: Float32Array) {
  const data = raster instanceof Raster ? raster.data : raster
  const fx = x - 0.5, fy = y - 0.5, x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0
  out.fill(0)
  // The four neighbors in turn, no arrays: Clone Stamp calls this for every pixel it paints.
  for (let n = 0; n < 4; n++) {
    const ix = x0 + (n & 1), iy = y0 + (n >> 1), w = (n & 1 ? tx : 1 - tx) * (n >> 1 ? ty : 1 - ty)
    if (ix < 0 || iy < 0 || ix >= width || iy >= height || w <= 0) continue
    const p = (iy * width + ix) * channels
    for (let c = 0; c < channels; c++) out[c] += data[p + c] * w
  }
}

// Where Clone Stamp copies from for a stroke starting at `point`: aligned keeps the first stroke's offset.
function cloneOffset(point: [number, number]): [number, number] | null {
  const { clone } = store.state
  if (!clone.source) return null
  return (clone.aligned ? clone.offset : null) ?? [Math.round(clone.source[0] - point[0]), Math.round(clone.source[1] - point[1])]
}

function strokeMode(tool: string, raster: Raster, toDoc: Mat3, isMask: boolean, original: Uint8Array, point: [number, number]): StrokeMode | null {
  if (tool === 'heal') return { kind: 'wash' }
  if (tool === 'smear') {
    // The Smear tool's Blur: a Gaussian of the layer as the stroke found it, painted back through the tip.
    const perPixel = Math.sqrt(Math.abs(toDoc[0] * toDoc[4] - toDoc[1] * toDoc[3]))
    const sigma = Math.min(Math.min(50, Math.max(0.5, store.state.blurRadius)) / perPixel, Math.max(raster.width, raster.height) / 2)
    const blurred = lazyBlur(new Raster(raster.width, raster.height, raster.channels, original), sigma, isMask)
    return { kind: 'source', sample: raster.channels === 1 ? (x, y, out) => { blurred(x, y, out); out[3] = 255 } : blurred }
  }
  if (tool === 'clone') {
    const offset = cloneOffset(point)!
    store.set({ clone: { ...store.state.clone, offset } })
    if (store.state.clone.sampleAll) {
      const composite = samplePixels(true)!
      return { kind: 'source', sample: (x, y, out) => bilinear(composite, composite.width, composite.height, 4, toDoc[0] * (x + 0.5) + toDoc[3] * (y + 0.5) + toDoc[6] + offset[0], toDoc[1] * (x + 0.5) + toDoc[4] * (y + 0.5) + toDoc[7] + offset[1], out), gpu: { kind: 'composite', image: composite, offset } }
    }
    const toPixel = invert(toDoc), [ox, oy] = apply(toPixel, 0, 0), [qx, qy] = apply(toPixel, offset[0], offset[1])
    const lx = qx - ox, ly = qy - oy
    return { kind: 'source', sample: (x, y, out) => bilinear(original, raster.width, raster.height, raster.channels, x + 0.5 + lx, y + 0.5 + ly, out), gpu: { kind: 'layer', shift: [lx, ly] } }
  }
  return { kind: 'paint' }
}

function finishHeal(s: Stroke) {
  const { stroke } = s
  const painted = stroke.touchedRect
  if (!painted) return
  const raster = stroke.raster
  const reach = (Math.max(painted.w, painted.h) + 32) * 3.2
  const x0 = Math.max(0, Math.floor(painted.x - reach)), y0 = Math.max(0, Math.floor(painted.y - reach))
  const x1 = Math.min(raster.width, Math.ceil(painted.x + painted.w + reach)), y1 = Math.min(raster.height, Math.ceil(painted.y + painted.h + reach))
  const w = x1 - x0, h = y1 - y0
  const original = stroke.originalPixels, coverage = stroke.coverageBytes()
  const pixels = new Uint8Array(w * h * 4), gray = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    pixels.set(original.subarray(((y + y0) * raster.width + x0) * 4, ((y + y0) * raster.width + x1) * 4), y * w * 4)
    gray.set(coverage.subarray((y + y0) * raster.width + x0, (y + y0) * raster.width + x1), y * w)
  }
  const modes = ['Content-Aware', 'Create Texture', 'Proximity Match']
  const unhealed = pixels.slice()
  const status = withBuffers([{ data: pixels, out: true }, { data: gray }], ([p, g]) => call('spot_heal', p, g, w, h, w * 4, store.state.brush.opacity, modes.indexOf(store.state.healMode), (Math.random() * 2 ** 32) >>> 0))
  if (status !== 0) { store.notify('That area is too large to heal.'); stroke.replace({ x: x0, y: y0, w, h }, unhealed); return }
  stroke.replace({ x: x0, y: y0, w, h }, pixels)
}

export const paint: ToolHandler = {
  down(p) {
    const tool = store.state.tool
    // Option: a temporary eyedropper in the Brush and Spot Healing, and setting the source in Clone Stamp.
    if (p.alt && tool === 'clone') { store.set({ clone: { ...store.state.clone, source: p.point, offset: null } }); requestOverlay(); return }
    if (p.alt && (tool === 'brush' || tool === 'heal')) { pickColor(p.point, false); return }
    if (p.button === 2) { tipDrag = { start: p.screen[0], diameter: store.state.brush.diameter, hardness: store.state.brush.hardness, hardnessMode: p.shift }; return }
    if (tool === 'clone' && !store.state.clone.source) { store.notify('Option-click where Clone Stamp should copy from first.'); return }
    if ((tool === 'heal' || tool === 'clone') && store.state.editingMask) return
    store.beginGesture({ brush: 'Brush Stroke', eraser: 'Erase', heal: 'Spot Healing', clone: 'Clone Stamp', smear: 'Blur' }[tool as 'brush'] ?? 'Brush Stroke')
    const target = store.editTarget()
    if (!target) { store.cancelGesture(); store.notify(store.active?.adjustment ? 'Paint on an adjustment layer’s mask: add one first.' : 'Choose a layer to paint on.'); return }
    const kept = target.isMask ? null : growToCanvas(target.layer.id)
    const maskGrowth = target.isMask && (tool === 'brush' || tool === 'eraser') ? growMaskToCanvas(target.layer.id) : null
    const layer = store.layer(target.layer.id)!
    const raster = target.isMask ? layer.mask! : layer.image!
    const toDoc = target.isMask ? (maskGrowth ? pixelToDocument(maskGrowth.base, raster.width, raster.height) : target.toDocument) : pixelToDocument(layer.transform, raster.width, raster.height)
    const original = raster.data.slice()
    const mode = strokeMode(tool, raster, toDoc, target.isMask, original, p.point)!
    const settings = { ...store.state.brush, erasing: tool === 'eraser', smoothing: tool === 'brush' || tool === 'eraser' ? store.state.brush.smoothing : 0 }
    const color = store.paletteColor('foreground')
    const stroke = new BrushStroke(raster, toDoc, settings, color, store.state.selection, mode)
    // Brush, Eraser and Clone Stamp run on the GPU where they can; Spot Healing and the Blur smear need their pixels on the CPU.
    if (mode.kind === 'paint' || (mode.kind === 'source' && mode.gpu)) {
      stroke.gpu = GPUBrush.create(compositor, raster, { erasing: settings.erasing, color, opacity: settings.opacity, toDocument: toDoc, selection: store.state.selection, source: mode.kind === 'source' ? mode.gpu : undefined })
    }
    stroke.stringLength = settings.smoothing / Math.max(0.01, view.zoom)
    const same = lastEnd && lastEnd.layerId === layer.id && lastEnd.isMask === target.isMask
    if (prefs.penPressure && p.pressure !== undefined) stroke.pressure = p.pressure
    if (p.shift && same) { stroke.lineTo(...lastEnd!.point); stroke.lineTo(...p.point) } else stroke.moveTo(...p.point)
    stroke.render()
    current = { stroke, layerId: layer.id, isMask: target.isMask, heal: tool === 'heal', kept, maskKept: maskGrowth?.kept ?? null, axis: null, anchor: p.point }
    requestRender()
  },
  move(p) {
    pointer = p.point
    if (tipDrag) {
      const brush = store.state.brush, dx = p.screen[0] - tipDrag.start
      store.set({ brush: tipDrag.hardnessMode ? { ...brush, hardness: Math.min(1, Math.max(0, tipDrag.hardness + dx / 200)) } : { ...brush, diameter: Math.min(2000, Math.max(1, Math.round(tipDrag.diameter + 2 * dx / view.zoom))) } })
      requestOverlay()
      return
    }
    if (!current) { requestOverlay(); return }
    // Shift locks the stroke to the axis it first travels 3 px along.
    const lock = (q: [number, number]): [number, number] => {
      if (!p.shift) return q
      const [ax, ay] = current!.anchor
      if (!current!.axis) { if (Math.hypot(q[0] - ax, q[1] - ay) < 3) return [ax, ay]; current!.axis = Math.abs(q[0] - ax) >= Math.abs(q[1] - ay) ? 'x' : 'y' }
      return current!.axis === 'x' ? [q[0], ay] : [ax, q[1]]
    }
    if (prefs.penPressure && p.pressure !== undefined) current.stroke.pressure = p.pressure
    for (const q of p.coalesced.length ? p.coalesced : [p.point]) current.stroke.moveTo(...lock(q))
    if (p.predicted && !p.shift) current.stroke.predict(p.predicted)
    current.stroke.render()
    requestRender()
  },
  up(p) {
    if (tipDrag) { tipDrag = null; return }
    const s = current
    current = null
    if (!s) return
    s.stroke.settle(s.stroke.stringLength > 0 && !s.axis ? p.point : undefined)
    if (s.heal) finishHeal(s)
    const patch = s.stroke.finish()
    lastEnd = s.stroke.lastPoint ? { point: s.stroke.lastPoint, layerId: s.layerId, isMask: s.isMask } : null
    if (!s.isMask) { store.updateLayerLive(s.layerId, { text: undefined, shape: undefined }); if (s.kept) trimToPainted(s.layerId, s.kept) }
    if (s.maskKept) trimGrownMask(s.layerId, s.maskKept, s.stroke.touchedRect)
    store.endGesture(patch && !s.kept && !s.maskKept ? [patch] : [])
    store.pixelsChanged()
  },
  hover(p) { pointer = p.point; altHeld = p.alt; requestOverlay() },
  leave() { if (!current) pointer = null },
  key(event) {
    if (event.key === 'Escape' && current) { current.stroke.cancel(); current = null; store.cancelGesture(); requestRender(); return true }
    return false
  },
  busy: () => !!current,
  cursor: () => altHeld && (store.state.tool === 'brush' || store.state.tool === 'heal') ? 'crosshair' : 'none',
  draw(context) {
    const tool = store.state.tool
    if (tool === 'clone' && store.state.clone.source && pointer) {
      const { clone } = store.state
      const sample = current || clone.aligned ? (clone.offset ? [pointer[0] + clone.offset[0], pointer[1] + clone.offset[1]] : clone.source) : clone.source
      const [x, y] = view.toScreen(sample![0], sample![1])
      context.beginPath(); context.moveTo(x - 7, y); context.lineTo(x + 7, y); context.moveTo(x, y - 7); context.lineTo(x, y + 7)
      context.lineCap = 'round'; context.strokeStyle = '#fff'; context.lineWidth = 3; context.stroke(); context.strokeStyle = '#000'; context.lineWidth = 1; context.stroke(); context.lineCap = 'butt'
    }
    if (!pointer || (altHeld && tool !== 'clone')) return
    const [x, y] = view.toScreen(...pointer)
    const radius = Math.max(1, store.state.brush.diameter / 2 * view.zoom)
    context.beginPath(); context.arc(x, y, radius, 0, Math.PI * 2)
    context.strokeStyle = '#fff'; context.lineWidth = 2.5; context.stroke(); context.strokeStyle = '#000'; context.lineWidth = 1; context.stroke()
    if (tipDrag?.hardnessMode && store.state.brush.hardness < 1) {
      context.beginPath(); context.arc(x, y, radius * store.state.brush.hardness, 0, Math.PI * 2)
      context.setLineDash([3, 3]); context.strokeStyle = '#fff'; context.stroke(); context.setLineDash([])
    }
  },
}

export function pickColor(point: [number, number], background: boolean) {
  const pixels = samplePixels(true)
  if (!pixels) return
  const x = Math.floor(point[0]), y = Math.floor(point[1])
  if (x < 0 || y < 0 || x >= pixels.width || y >= pixels.height) return
  const i = (y * pixels.width + x) * 4, a = pixels.data[i + 3]
  const color: [number, number, number] = a ? [0, 1, 2].map(c => Math.round(pixels.data[i + c] * 255 / a)) as [number, number, number] : [255, 255, 255]
  store.set(background ? { background: color } : { foreground: color })
}

export const eyedropper: ToolHandler = { down: p => pickColor(p.point, p.alt), cursor: () => 'crosshair' }

// [ and ] resize the tip, { and } step hardness in quarters, digits set opacity (two quick digits for an exact percentage).
let lastDigit: { value: number; at: number } | null = null
export function brushKey(event: KeyboardEvent): boolean {
  const tool = store.state.tool
  const brushTool = !!tipFamily(tool)
  if (current) return false
  const brush = store.state.brush
  if (brushTool && (event.code === 'BracketLeft' || event.code === 'BracketRight') && !event.metaKey && !event.ctrlKey && !event.altKey) {
    const up = event.code === 'BracketRight'
    if (event.shiftKey) {
      const step = up ? Math.floor(4 * brush.hardness + 0.001) + 1 : Math.ceil(4 * brush.hardness - 0.001) - 1
      store.set({ brush: { ...brush, hardness: Math.min(4, Math.max(0, step)) / 4 } })
    } else {
      const d = brush.diameter
      store.set({ brush: { ...brush, diameter: Math.min(2000, Math.max(1, up ? Math.max(d + 1, Math.round(d * 1.2)) : Math.min(d - 1, Math.round(d / 1.2)))) } })
    }
    requestOverlay()
    return true
  }
  const digit = /^Digit(\d)$/.exec(event.code)
  if (digit && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && (brushTool || tool === 'gradient' || tool === 'move')) {
    const n = +digit[1], now = performance.now()
    let percent = n === 0 ? 100 : n * 10
    if (lastDigit && now - lastDigit.at < 600) { percent = Math.max(1, lastDigit.value * 10 + n); lastDigit = null } else lastDigit = { value: n, at: now }
    if (tool === 'move') { const layer = store.active; if (layer) store.updateLayer(layer.id, { opacity: percent / 100 }, 'Opacity', 'opacity') }
    else if (tool === 'gradient') store.set({ gradient: { ...store.state.gradient, opacity: percent / 100 } })
    else store.set({ brush: { ...brush, opacity: percent / 100 } })
    return true
  }
  return false
}
