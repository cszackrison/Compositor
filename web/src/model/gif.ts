import { GIFError, GIFSource, gifLimits } from '../io/gif'
import type { PackageFiles } from '../io/files'
import { Raster, decodePNG, encodePNG, pngDepth } from './raster'
import { type Sampling, type Transform, maxSide, maxSurfacePixels } from './types'
import { type Mat3, chain, identity, invert, scale } from '../render/gl'
import { unitToDocument } from '../render/compositor'

// An animated GIF layer (GIFAnimation.swift, format version 17's `gif` object). The source bytes stay unchanged and are saved as they
// came; only edited frames keep pixels of their own, the rest compose from the source when shown.
export type GIFDelayMode = 'Frame delay' | 'Same for all'
export type GIFFrameTiming = { mode: GIFDelayMode; uniformDelay: number; frameDelays: ReadonlyMap<number, number> }
// Image Size's output size and the affine map from the source's unit square to the output's (both row 0 at the top).
export type GIFFrameGeometry = { width: number; height: number; a: number; b: number; c: number; d: number; tx: number; ty: number; sampling: Sampling }
// A stable frame identity (`index`) and the source frame it shows. Copies take identities from the source's frame count up.
export type GIFFrameReference = { index: number; sourceIndex: number }
export type GIFLayerData = {
  source: GIFSource
  selectedFrameIndex: number
  geometry: GIFFrameGeometry | null
  framePixels: ReadonlyMap<number, Raster>
  deletedFrameIndices: ReadonlySet<number>
  // Null plays the surviving source frames in order; a copy makes it explicit.
  frameOrder: readonly GIFFrameReference[] | null
  timing: GIFFrameTiming
}
export type GIFFrame = GIFFrameReference & { duration: number; delay: number }

export const delayRange = [gifLimits.minimumDelay, gifLimits.maximumDelay] as const
export const defaultTiming = (): GIFFrameTiming => ({ mode: 'Frame delay', uniformDelay: gifLimits.defaultDelay, frameDelays: new Map() })
const isDefaultTiming = (t: GIFFrameTiming) => t.mode === 'Frame delay' && t.uniformDelay === gifLimits.defaultDelay && t.frameDelays.size === 0
const inDelayRange = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= delayRange[0] && v <= delayRange[1]
const clampDelay = (v: number) => Math.min(delayRange[1], Math.max(delayRange[0], v))

// The source's usual cadence; tied frequencies take the mean, keeping its loop's length.
export function defaultUniformDelay(durations: number[]) {
  if (!durations.length) return gifLimits.defaultDelay
  const counts = new Map<number, number>()
  for (const d of durations) counts.set(d, (counts.get(d) ?? 0) + 1)
  const most = Math.max(...counts.values()), winners = [...counts].filter(([, n]) => n === most)
  return winners.length === 1 ? winners[0][0] : durations.reduce((a, b) => a + b, 0) / durations.length
}

// A GIF placed as a layer (ImageImporter.importGIF). Its first frame, `frameRaster(data, 0)`, is the layer's image.
export function openGIF(bytes: Uint8Array): GIFLayerData {
  const source = new GIFSource(bytes)
  return { source, selectedFrameIndex: 0, geometry: null, framePixels: new Map(), deletedFrameIndices: new Set(), frameOrder: null, timing: { ...defaultTiming(), uniformDelay: defaultUniformDelay(source.delays) } }
}

export function frameReferences(data: GIFLayerData): GIFFrameReference[] {
  if (data.frameOrder) return [...data.frameOrder]
  const out: GIFFrameReference[] = []
  for (let i = 0; i < data.source.frameCount; i++) if (!data.deletedFrameIndices.has(i)) out.push({ index: i, sourceIndex: i })
  return out
}

export const delayFor = (timing: GIFFrameTiming, index: number, duration: number) => timing.mode === 'Same for all' ? timing.uniformDelay : timing.frameDelays.get(index) ?? duration

// The frames in playing order, each with its source delay (`duration`) and the one it plays for (`delay`).
export const gifFrames = (data: GIFLayerData): GIFFrame[] => frameReferences(data).filter(r => r.sourceIndex < data.source.frameCount).map(r => {
  const duration = data.source.delays[r.sourceIndex]
  return { ...r, duration, delay: delayFor(data.timing, r.index, duration) }
})
export const frameDelays = (data: GIFLayerData) => gifFrames(data).map(f => f.delay)

export function sourceFrameIndex(data: GIFLayerData, index: number): number | null {
  if (data.frameOrder) return data.frameOrder.find(r => r.index === index)?.sourceIndex ?? null
  return Number.isInteger(index) && index >= 0 && index < data.source.frameCount && !data.deletedFrameIndices.has(index) ? index : null
}
export const containsFrame = (data: GIFLayerData, index: number) => sourceFrameIndex(data, index) !== null
export const frameSize = (data: GIFLayerData) => ({ width: data.geometry?.width ?? data.source.width, height: data.geometry?.height ?? data.source.height })

export function hasValidFrameOrder(data: GIFLayerData) {
  const order = data.frameOrder, count = data.source.frameCount
  if (!order) return true
  if (!order.length || order.length > gifLimits.maxFrames) return false
  const seen = new Set<number>()
  for (const f of order) {
    if (!Number.isInteger(f.index) || f.index < 0 || f.index >= gifLimits.frameIdentityLimit || seen.has(f.index) || !Number.isInteger(f.sourceIndex) || f.sourceIndex < 0 || f.sourceIndex >= count) return false
    if (f.index < count && (f.index !== f.sourceIndex || data.deletedFrameIndices.has(f.index))) return false
    seen.add(f.index)
  }
  for (let i = 0; i < count; i++) if (seen.has(i) === data.deletedFrameIndices.has(i)) return false
  return true
}

export const validGeometry = (g: GIFFrameGeometry) => Number.isInteger(g.width) && Number.isInteger(g.height) && g.width >= 1 && g.width <= maxSide && g.height >= 1 && g.height <= maxSide && g.width * g.height <= maxSurfacePixels
  && [g.a, g.b, g.c, g.d, g.tx, g.ty].every(v => Number.isFinite(v) && Math.abs(v) <= 1_000_000) && Math.abs(g.a * g.d - g.b * g.c) > 1e-15 && ['Nearest', 'Smooth', 'High quality'].includes(g.sampling)

export const validTiming = (t: GIFFrameTiming, indices?: ReadonlySet<number>) => (t.mode === 'Frame delay' || t.mode === 'Same for all') && inDelayRange(t.uniformDelay) && t.frameDelays.size <= gifLimits.maxFrames
  && [...t.frameDelays].every(([i, d]) => inDelayRange(d) && (!indices || indices.has(i)))

const geometryMatrix = (g: GIFFrameGeometry | null): Mat3 => g ? [g.a, g.b, 0, g.c, g.d, 0, g.tx, g.ty, 1] : identity()

// `source` drawn into a width × height raster through `map`, from its unit square to the output's: Nearest takes the pixel under each
// output pixel's center; Smooth interpolates; High quality also averages the source pixels an output pixel covers when it shrinks.
// What falls outside the source is clear, with soft edges for High quality.
export function resampleAffine(source: Raster, width: number, height: number, map: Mat3, sampling: Sampling): Raster {
  const sw = source.width, sh = source.height, src = source.data, out = new Raster(width, height, 4), o = out.data
  const [a, b, , c, d, , tx, ty] = chain(scale(sw, sh), invert(map), scale(1 / width, 1 / height))
  const high = sampling === 'High quality', nearest = sampling === 'Nearest'
  const nx = high ? Math.min(8, Math.max(1, Math.ceil(Math.hypot(a, b) - 1e-9))) : 1, ny = high ? Math.min(8, Math.max(1, Math.ceil(Math.hypot(c, d) - 1e-9))) : 1
  const taps = nx * ny, sum = [0, 0, 0, 0]
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    sum[0] = sum[1] = sum[2] = sum[3] = 0
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const px = x + (i + 0.5) / nx, py = y + (j + 0.5) / ny, sx = a * px + c * py + tx, sy = b * px + d * py + ty
      if (!(sx >= 0 && sy >= 0 && sx < sw && sy < sh)) continue
      if (nearest) { const s = (Math.floor(sy) * sw + Math.floor(sx)) * 4; for (let k = 0; k < 4; k++) sum[k] += src[s + k]; continue }
      const fx = sx - 0.5, fy = sy - 0.5, x0 = Math.floor(fx), y0 = Math.floor(fy), wx = fx - x0, wy = fy - y0
      const xa = Math.max(0, x0), xb = Math.min(sw - 1, x0 + 1), ya = Math.max(0, y0), yb = Math.min(sh - 1, y0 + 1)
      const p00 = (ya * sw + xa) * 4, p10 = (ya * sw + xb) * 4, p01 = (yb * sw + xa) * 4, p11 = (yb * sw + xb) * 4
      for (let k = 0; k < 4; k++) sum[k] += (src[p00 + k] * (1 - wx) + src[p10 + k] * wx) * (1 - wy) + (src[p01 + k] * (1 - wx) + src[p11 + k] * wx) * wy
    }
    const p = (y * width + x) * 4
    for (let k = 0; k < 4; k++) o[p + k] = Math.round(sum[k] / taps)
  }
  return out
}

// A frame's pixels: its edit when it has one (that raster itself, not a copy), otherwise its source frame through the geometry.
export function frameRaster(data: GIFLayerData, index: number): Raster {
  const edited = data.framePixels.get(index)
  if (edited) return edited
  const sourceIndex = sourceFrameIndex(data, index)
  if (sourceIndex === null || sourceIndex >= data.source.frameCount) throw new GIFError('unreadable')
  const frame = data.source.frame(sourceIndex), g = data.geometry
  return g ? resampleAffine(frame, g.width, g.height, geometryMatrix(g), g.sampling) : frame
}

export const selectFrame = (data: GIFLayerData, index: number): GIFLayerData => containsFrame(data, index) ? { ...data, selectedFrameIndex: index } : data

// A painted or filtered frame: `pixels` must be the frame's size (frameSize), on the layer's own grid.
export function setFramePixels(data: GIFLayerData, index: number, pixels: Raster): GIFLayerData {
  const { width, height } = frameSize(data)
  if (!containsFrame(data, index) || pixels.width !== width || pixels.height !== height || pixels.channels !== 4) throw new GIFError('unreadable')
  return { ...data, framePixels: new Map(data.framePixels).set(index, pixels) }
}

// A copy right after the frame, with its edit and delay, and selected (EditorSession.duplicateGIFFrame).
export function duplicateFrame(data: GIFLayerData, index: number): GIFLayerData | null {
  const order = frameReferences(data), position = order.findIndex(r => r.index === index)
  if (position < 0 || order.length >= gifLimits.maxFrames) return null
  const used = new Set(order.map(r => r.index))
  let fresh = data.source.frameCount
  while (fresh < gifLimits.frameIdentityLimit && used.has(fresh)) fresh++
  if (fresh >= gifLimits.frameIdentityLimit) return null
  order.splice(position + 1, 0, { index: fresh, sourceIndex: order[position].sourceIndex })
  const framePixels = new Map(data.framePixels), edited = data.framePixels.get(index)
  if (edited) framePixels.set(fresh, edited.clone())
  const frameDelays = new Map(data.timing.frameDelays), delay = data.timing.frameDelays.get(index)
  if (delay !== undefined) frameDelays.set(fresh, delay)
  return { ...data, frameOrder: order, framePixels, timing: { ...data.timing, frameDelays }, selectedFrameIndex: fresh }
}

// Removes frames, never the last one. A removed selection moves to the next surviving frame, or the last (EditorSession.deleteGIFFrames).
export function deleteFrames(data: GIFLayerData, indices: Iterable<number>): GIFLayerData | null {
  const doomed = new Set(indices), order = frameReferences(data), present = new Set(order.map(r => r.index))
  if (!doomed.size || [...doomed].some(i => !present.has(i)) || doomed.size >= order.length) return null
  const remaining = order.filter(r => !doomed.has(r.index)), position = order.findIndex(r => r.index === data.selectedFrameIndex)
  if (position < 0) return null
  const next = doomed.has(data.selectedFrameIndex) ? (order.slice(position + 1).find(r => !doomed.has(r.index)) ?? remaining.at(-1)!).index : data.selectedFrameIndex
  const deletedFrameIndices = new Set(data.deletedFrameIndices), framePixels = new Map(data.framePixels), frameDelays = new Map(data.timing.frameDelays)
  for (const i of doomed) { if (i < data.source.frameCount) deletedFrameIndices.add(i); framePixels.delete(i); frameDelays.delete(i) }
  return { ...data, deletedFrameIndices, framePixels, frameOrder: data.frameOrder ? data.frameOrder.filter(r => !doomed.has(r.index)) : null, timing: { ...data.timing, frameDelays }, selectedFrameIndex: next }
}
export const deleteFrame = (data: GIFLayerData, index: number) => deleteFrames(data, [index])

// New delays, if they're valid for these frames and differ (EditorSession.setGIFFrameTiming).
export function setTiming(data: GIFLayerData, timing: GIFFrameTiming): GIFLayerData | null {
  if (!validTiming(timing, new Set(frameReferences(data).map(r => r.index)))) return null
  const t = data.timing
  if (t.mode === timing.mode && t.uniformDelay === timing.uniformDelay && t.frameDelays.size === timing.frameDelays.size && [...timing.frameDelays].every(([i, d]) => t.frameDelays.get(i) === d)) return null
  return { ...data, timing }
}
// The timeline's menu: every frame for the same time, kept within what GIF stores; or each for the GIF's own.
export const setUniformDelay = (data: GIFLayerData, seconds: number) => Number.isFinite(seconds) ? setTiming(data, { ...data.timing, mode: 'Same for all', uniformDelay: clampDelay(seconds) }) : null
export const useOriginalDelays = (data: GIFLayerData) => setTiming(data, { ...data.timing, mode: 'Frame delay' })
export const setFrameDelay = (data: GIFLayerData, index: number, seconds: number) => Number.isFinite(seconds) ? setTiming(data, { ...data.timing, frameDelays: new Map(data.timing.frameDelays).set(index, clampDelay(seconds)) }) : null

// Image Size (GIFAnimation.resizing, ImageResizer): the layer's box goes from `from` to the upright `to` on a canvas scaled by
// scaleX × scaleY. Source frames keep composing from the source through the new geometry; edited frames are resampled now.
export function resizeGIF(data: GIFLayerData, from: Transform, to: Transform, scaleX: number, scaleY: number): GIFLayerData {
  const width = Math.round(to.size[0]), height = Math.round(to.size[1])
  const placement = chain(invert(unitToDocument(to)), scale(scaleX, scaleY), unitToDocument(from)), map = chain(placement, geometryMatrix(data.geometry))
  const geometry: GIFFrameGeometry = { width, height, a: map[0], b: map[1], c: map[3], d: map[4], tx: map[6], ty: map[7], sampling: to.sampling }
  if (!validGeometry(geometry)) throw new GIFError('tooLarge')
  const framePixels = new Map([...data.framePixels].map(([i, r]) => [i, resampleAffine(r, width, height, placement, to.sampling)]))
  return { ...data, geometry, framePixels }
}

function fail(message: string): never { throw new Error(`This is not a valid Compositor project: ${message}.`) }
const isIndex = (v: unknown, limit: number): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) < limit

// A layer's `gif` object and the package's files (`images/<name>`) to the model, checked as ProjectStore checks it. Give `layerId` to
// check the file names too. The layer's own image must be frameSize(data), which the caller checks.
export function readGIF(record: any, files: PackageFiles, layerId?: string): GIFLayerData {
  if (!record || typeof record !== 'object' || typeof record.sourceFile !== 'string') fail('an animated layer has no GIF')
  const id = layerId ?? record.sourceFile.replace(/\.gif$/, '')
  if (record.sourceFile !== `${id}.gif` || record.sourceFile.includes('/')) fail('an animated layer\'s GIF is misnamed')
  const { maxFrames, frameIdentityLimit } = gifLimits
  if (!isIndex(record.selectedFrameIndex, frameIdentityLimit)) fail('an animated layer shows a frame that doesn\'t exist')
  let geometry: GIFFrameGeometry | null = null
  if (record.geometry != null) {
    const g = record.geometry
    geometry = { width: g.width, height: g.height, a: g.a, b: g.b, c: g.c, d: g.d, tx: g.tx, ty: g.ty, sampling: g.sampling ?? 'High quality' }
    if (!validGeometry(geometry)) fail('an animated layer\'s size is invalid')
  }
  const deleted: unknown[] = record.deletedFrameIndices ?? []
  if (!Array.isArray(deleted) || deleted.length > maxFrames || !deleted.every(i => isIndex(i, maxFrames)) || new Set(deleted).size !== deleted.length) fail('an animated layer\'s deleted frames are invalid')
  let frameOrder: GIFFrameReference[] | null = null
  if (record.frameOrder != null) {
    const order = record.frameOrder
    if (!Array.isArray(order) || !order.length || order.length > maxFrames || !order.every((f: any) => f && isIndex(f.index, frameIdentityLimit) && isIndex(f.sourceIndex, maxFrames)) || new Set(order.map((f: any) => f.index)).size !== order.length) fail('an animated layer\'s frame order is invalid')
    frameOrder = order.map((f: any) => ({ index: f.index, sourceIndex: f.sourceIndex }))
  }
  let timing = defaultTiming()
  if (record.timing != null) {
    const t = record.timing, delays = t.frameDelays
    if (!Array.isArray(delays) || delays.length > maxFrames || !delays.every((r: any) => r && isIndex(r.index, frameIdentityLimit) && inDelayRange(r.duration)) || new Set(delays.map((r: any) => r.index)).size !== delays.length) fail('an animated layer\'s delays are invalid')
    timing = { mode: t.mode, uniformDelay: t.uniformDelay, frameDelays: new Map(delays.map((r: any) => [r.index, r.duration])) }
    if (!validTiming(timing)) fail('an animated layer\'s delays are invalid')
  }
  const pixelRecords: unknown[] = record.framePixels ?? []
  if (!Array.isArray(pixelRecords) || pixelRecords.length > maxFrames || !pixelRecords.every((r: any) => r && isIndex(r.index, frameIdentityLimit) && r.imageFile === `${id}.frame-${r.index}.png`) || new Set(pixelRecords.map((r: any) => r.index)).size !== pixelRecords.length) fail('an animated layer\'s edited frames are invalid')
  const bytes = files.get(`images/${record.sourceFile}`)
  if (!bytes) fail('an animated layer\'s GIF is missing')
  let source: GIFSource
  try { source = new GIFSource(bytes) } catch (e) { if (e instanceof GIFError && e.reason !== 'unreadable') throw new Error('This project\'s GIF is too large to open.'); fail('an animated layer\'s GIF could not be read') }
  const data: GIFLayerData = { source, selectedFrameIndex: record.selectedFrameIndex, geometry, framePixels: new Map(), deletedFrameIndices: new Set(deleted as number[]), frameOrder, timing }
  if (!(deleted as number[]).every(i => i < source.frameCount) || !hasValidFrameOrder(data) || !containsFrame(data, data.selectedFrameIndex) || !validTiming(timing, new Set(frameReferences(data).map(r => r.index)))) fail('an animated layer\'s frames don\'t match its GIF')
  const { width, height } = frameSize(data), framePixels = new Map<number, Raster>()
  for (const r of pixelRecords as { index: number; imageFile: string }[]) {
    const png = files.get(`images/${r.imageFile}`)
    if (!png) fail('an animated layer\'s edited frame is missing')
    if (!containsFrame(data, r.index) || pngDepth(png) > 8) fail('an animated layer\'s edited frame is invalid')
    const raster = decodePNG(png, 4)
    if (raster.width !== width || raster.height !== height) fail('an animated layer\'s edited frame is the wrong size')
    framePixels.set(r.index, raster)
  }
  return { ...data, framePixels }
}

// The layer's `gif` object, as EditorSession.projectSnapshot records it, and the files it names (the source unchanged, a PNG per
// edited frame), keyed as the package's files are.
export function writeGIF(data: GIFLayerData, layerId: string): { gif: Record<string, unknown>; files: PackageFiles } {
  const files: PackageFiles = new Map([[`images/${layerId}.gif`, data.source.bytes]])
  const edited = [...data.framePixels.keys()].sort((a, b) => a - b)
  for (const i of edited) files.set(`images/${layerId}.frame-${i}.png`, encodePNG(data.framePixels.get(i)!))
  const gif: Record<string, unknown> = { sourceFile: `${layerId}.gif`, selectedFrameIndex: data.selectedFrameIndex, framePixels: edited.map(index => ({ index, imageFile: `${layerId}.frame-${index}.png` })), deletedFrameIndices: [...data.deletedFrameIndices].sort((a, b) => a - b) }
  if (data.geometry) gif.geometry = { ...data.geometry }
  if (data.frameOrder) gif.frameOrder = data.frameOrder.map(r => ({ index: r.index, sourceIndex: r.sourceIndex }))
  if (!isDefaultTiming(data.timing)) gif.timing = { mode: data.timing.mode, uniformDelay: data.timing.uniformDelay, frameDelays: [...data.timing.frameDelays.keys()].sort((a, b) => a - b).map(index => ({ index, duration: data.timing.frameDelays.get(index)! })) }
  return { gif, files }
}
