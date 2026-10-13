import type { Raster } from '../model/raster'
import { maxSide, maxSurfacePixels, documentPixelBudget } from '../model/types'
import type { ShapeStyle } from '../tools/shape'
import { type PSDDrawing, type RGB, PSDError, ascii } from './psd'

// Rasterizes Photoshop vector masks (vmsk/vsms) and maps fill rectangles and ellipses onto live shape layers, as PSDVector.swift does,
// from Adobe's 2019 Photoshop File Formats Specification (additional layer information: vmsk, vogk, SoCo, vstk).

export type PathCommand = ['M', number, number] | ['C', number, number, number, number, number, number] | ['Z']
type Box = { x: number; y: number; width: number; height: number }
type Size = { width: number; height: number }

export function vectorLive(extra: Map<string, Uint8Array>, canvas: Size, draw: PSDDrawing, remainingPixels = documentPixelBudget): { style: ShapeStyle; bounds: Box; image: Raster; notes: string[] } | null {
  const stroke = extra.get('vstk'), soco = extra.get('SoCo')
  const fillEnabled = (stroke && bool(stroke, 'fillEnabled')) ?? !!soco
  const strokeEnabled = (stroke && bool(stroke, 'strokeEnabled')) ?? false
  const fill = soco && rgb(soco)
  if (!fillEnabled || !fill) return null
  const vmsk = extra.get('vmsk') ?? extra.get('vsms')
  const origin = origination(extra.get('vogk')) ?? (vmsk ? sharpRect(vmsk, canvas) : null)
  if (!origin) return null
  const box = integral(origin.bounds)
  if (!Number.isFinite(box.x) || !Number.isFinite(box.y)) return null
  const size = pixelSize(box, remainingPixels)
  if (!size) return null
  const style: ShapeStyle = { kind: origin.kind, red: fill[0], green: fill[1], blue: fill[2], cornerRadius: origin.cornerRadius }
  const image = draw.shape(style, size.width, size.height)
  const notes = [...(strokeEnabled ? ['The Photoshop stroke isn’t supported on shape layers and was omitted.'] : []), ...origin.notes]
  return { style, bounds: { x: box.x, y: box.y, ...size }, image, notes }
}

export function vectorRaster(extra: Map<string, Uint8Array>, canvas: Size, draw: PSDDrawing, remainingPixels = documentPixelBudget): { image: Raster; bounds: Box } | null {
  const mask = extra.get('vmsk') ?? extra.get('vsms'), commands = mask ? path(mask, canvas) : null
  if (!commands) return null
  const soco = extra.get('SoCo'), fill = soco ? rgb(soco) : null, stroke = extra.get('vstk')
  const fillEnabled = (stroke && bool(stroke, 'fillEnabled')) ?? !!fill
  const strokeEnabled = (stroke && bool(stroke, 'strokeEnabled')) ?? false
  const strokeColor = stroke ? rgb(stroke) : null
  const strokeWidth = (stroke && unit(stroke, 'strokeStyleLineWidth')) ?? 1
  if (!((fillEnabled && fill) || (strokeEnabled && strokeColor))) return null
  if (!Number.isFinite(strokeWidth)) return null
  if (strokeEnabled && !(strokeWidth >= 0 && strokeWidth <= maxSide)) throw new PSDError('tooLarge')
  let box = bounds(commands)
  if (strokeEnabled) { const grow = Math.ceil(strokeWidth / 2 + 1); box = { x: box.x - grow, y: box.y - grow, width: box.width + grow * 2, height: box.height + grow * 2 } }
  box = integral(box)
  if (!Number.isFinite(box.x) || !Number.isFinite(box.y)) return null
  const size = pixelSize(box, remainingPixels)
  if (!size) return null
  const image = draw.path(commands, box, size.width, size.height, fillEnabled ? fill : null, strokeEnabled && strokeColor ? { color: strokeColor, width: strokeWidth } : null)
  return { image, bounds: { x: box.x, y: box.y, ...size } }
}

// Rejects sizes that would overflow or exceed the 30,000 px side or the remaining-pixel budget.
function pixelSize(size: Size, remainingPixels: number): Size | null {
  if (!Number.isFinite(size.width) || !Number.isFinite(size.height)) return null
  if (Math.abs(size.width) > maxSide || Math.abs(size.height) > maxSide) throw new PSDError('tooLarge')
  const budget = Math.min(maxSurfacePixels, Math.max(0, remainingPixels))
  if (size.width * size.height > budget) throw new PSDError('tooLarge')
  const width = Math.max(1, Math.trunc(size.width)), height = Math.max(1, Math.trunc(size.height))
  if (width * height > budget) throw new PSDError('tooLarge')
  return { width, height }
}

// CGRect.integral: the smallest whole-pixel rectangle holding it.
function integral(r: Box): Box {
  const x0 = Math.min(r.x, r.x + r.width), y0 = Math.min(r.y, r.y + r.height), x = Math.floor(x0), y = Math.floor(y0)
  return { x, y, width: Math.ceil(x0 + Math.abs(r.width)) - x, height: Math.ceil(y0 + Math.abs(r.height)) - y }
}

type Origination = { kind: 'Rectangle' | 'Ellipse'; bounds: Box; cornerRadius: number; notes: string[] }

// Photoshop vogk origination: 1 and 2 are rectangles (2 rounded), 5 an ellipse.
function origination(data: Uint8Array | undefined): Origination | null {
  const type = data ? int32(data, 'keyOriginType') : null
  if (!data || type === null) return null
  const kind = type === 1 || type === 2 ? 'Rectangle' : type === 5 ? 'Ellipse' : null
  if (!kind) return null
  const from = offset('keyOriginShapeBBox', data) ?? 0
  const left = unit(data, 'Left', from), top = unit(data, 'Top ', from), right = unit(data, 'Rght', from), bottom = unit(data, 'Btom', from)
  if (left === null || top === null || right === null || bottom === null) return null
  const box = { x: left, y: top, width: right - left, height: bottom - top }
  if (!(Math.abs(box.width) >= 1 && Math.abs(box.height) >= 1 && [box.x, box.y, box.width, box.height].every(Number.isFinite))) return null
  const origin: Origination = { kind, bounds: box, cornerRadius: 0, notes: [] }
  const radiiAt = kind === 'Rectangle' ? offset('keyOriginRRectRadii', data) : null
  if (radiiAt !== null) {
    const radii = ['topLeft', 'topRight', 'bottomRight', 'bottomLeft'].map(key => unit(data, key, radiiAt)).filter((r): r is number => r !== null)
    if (radii.length === 4) {
      const lo = Math.min(...radii), hi = Math.max(...radii)
      if (hi - lo > 0.5) return null
      origin.cornerRadius = hi
    }
  }
  return origin
}

// Four sharp corners and nothing else: a rectangle, though nothing says it was drawn as one.
function sharpRect(data: Uint8Array, canvas: Size): Origination | null {
  const commands = path(data, canvas)
  if (!commands) return null
  let at = 8, remaining = 0, sharp = true
  const anchors: [number, number][] = []
  while (at + 26 <= data.length) {
    const type = i16(data, at), body = data.subarray(at + 2, at + 26)
    at += 26
    if (type === 0 || type === 3) { if (anchors.length) return null; remaining = i16(body, 0) }
    else if (type === 1 || type === 2 || type === 4 || type === 5) {
      if (remaining <= 0) continue
      remaining--
      const incoming = point(body, 0, canvas), anchor = point(body, 8, canvas), outgoing = point(body, 16, canvas)
      if (Math.hypot(incoming[0] - anchor[0], incoming[1] - anchor[1]) > 0.5 || Math.hypot(outgoing[0] - anchor[0], outgoing[1] - anchor[1]) > 0.5) sharp = false
      anchors.push(anchor)
    }
  }
  if (!sharp || anchors.length !== 4) return null
  const box = bounds(commands)
  return box.width >= 1 && box.height >= 1 ? { kind: 'Rectangle', bounds: box, cornerRadius: 0, notes: [] } : null
}

// A vector mask's path records as document-pixel path commands: subpaths of Bézier knots, closed unless their record says open.
export function path(data: Uint8Array, canvas: Size): PathCommand[] | null {
  if (data.length < 8 || canvas.width <= 0 || canvas.height <= 0) return null
  const commands: PathCommand[] = []
  let at = 8, remaining = 0, closed = true, first = true, previousOut: [number, number] = [0, 0]
  while (at + 26 <= data.length) {
    const type = i16(data, at), body = data.subarray(at + 2, at + 26)
    at += 26
    if (type === 0 || type === 3) {
      if (!first && closed) commands.push(['Z'])
      remaining = i16(body, 0); closed = type === 0; first = true
    } else if (type === 1 || type === 2 || type === 4 || type === 5) {
      if (remaining <= 0) continue
      remaining--
      const incoming = point(body, 0, canvas), anchor = point(body, 8, canvas), outgoing = point(body, 16, canvas)
      if (first) { commands.push(['M', anchor[0], anchor[1]]); first = false }
      else commands.push(['C', previousOut[0], previousOut[1], incoming[0], incoming[1], anchor[0], anchor[1]])
      previousOut = outgoing
    }
  }
  if (!first && closed) commands.push(['Z'])
  return commands.length ? commands : null
}

// The path's own extent, its curves' turning points included and control points not (CGPath.boundingBoxOfPath).
export function bounds(commands: PathCommand[]): Box {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, cx = 0, cy = 0
  const add = (x: number, y: number) => { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y) }
  const cubic = (p0: number, p1: number, p2: number, p3: number, t: number) => { const u = 1 - t; return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3 }
  const turns = (p0: number, p1: number, p2: number, p3: number) => {
    const a = p1 - p0 - 2 * (p2 - p1) + (p3 - p2), b = 2 * (p2 - p1 - (p1 - p0)), c = p1 - p0, out: number[] = []
    if (Math.abs(a) < 1e-12) { if (Math.abs(b) > 1e-12) out.push(-c / b) }
    else { const d = b * b - 4 * a * c; if (d >= 0) { const s = Math.sqrt(d); out.push((-b + s) / (2 * a), (-b - s) / (2 * a)) } }
    return out.filter(t => t > 0 && t < 1)
  }
  for (const command of commands) {
    if (command[0] === 'M') { cx = command[1]; cy = command[2]; add(cx, cy) }
    else if (command[0] === 'C') {
      const [, ax, ay, bx, by, x, y] = command
      add(x, y)
      for (const t of turns(cx, ax, bx, x)) add(cubic(cx, ax, bx, x, t), cubic(cy, ay, by, y, t))
      for (const t of turns(cy, ay, by, y)) add(cubic(cx, ax, bx, x, t), cubic(cy, ay, by, y, t))
      cx = x; cy = y
    }
  }
  return x0 > x1 ? { x: 0, y: 0, width: 0, height: 0 } : { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
}

// MARK: Descriptor values found by their keys, as Photoshop's shape blocks are read here

export function rgb(data: Uint8Array): RGB | null {
  const r = double(data, 'Rd  '), g = double(data, 'Grn '), b = double(data, 'Bl  ')
  if (r === null || g === null || b === null) return null
  const channel = (v: number) => v > 1 ? Math.min(255, Math.max(0, v)) / 255 : Math.min(1, Math.max(0, v))
  return [channel(r), channel(g), channel(b)]
}

export function bool(data: Uint8Array, key: string): boolean | null {
  const start = offset(key, data)
  if (start === null) return null
  const type = start + key.length
  return type + 5 <= data.length && ascii(data.subarray(type, type + 4)) === 'bool' ? data[type + 4] !== 0 : null
}

export function unit(data: Uint8Array, key: string, from = 0): number | null {
  const keyAt = offset(key, data, from), unitAt = keyAt === null ? null : offset('UntF', data, keyAt)
  return unitAt === null ? null : f64(data, unitAt + 8)
}

function int32(data: Uint8Array, key: string) {
  const start = offset(key, data)
  if (start === null) return null
  const type = start + key.length
  return type + 8 <= data.length && ascii(data.subarray(type, type + 4)) === 'long' ? view(data).getInt32(type + 4) : null
}

function double(data: Uint8Array, key: string) {
  const start = offset(key, data)
  if (start === null) return null
  const type = start + key.length
  return type + 12 <= data.length && ascii(data.subarray(type, type + 4)) === 'doub' ? f64(data, type + 4) : null
}

const view = (data: Uint8Array) => new DataView(data.buffer, data.byteOffset, data.byteLength)
const f64 = (data: Uint8Array, at: number) => at + 8 <= data.length ? view(data).getFloat64(at) : null
const i16 = (data: Uint8Array, at: number) => view(data).getInt16(at)
const point = (body: Uint8Array, at: number, canvas: Size): [number, number] => [view(body).getInt32(at + 4) / 0x1000000 * canvas.width, view(body).getInt32(at) / 0x1000000 * canvas.height]

function offset(key: string, data: Uint8Array, from = 0): number | null {
  const needle = [...key].map(c => c.charCodeAt(0))
  outer: for (let i = Math.max(0, from); i + needle.length <= data.length; i++) {
    for (let j = 0; j < needle.length; j++) if (data[i + j] !== needle[j]) continue outer
    return i
  }
  return null
}
