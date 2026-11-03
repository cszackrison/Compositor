import { Raster } from '../model/raster'
import { maxSide, maxSurfacePixels } from '../model/types'

// GIFTimelineLimits and GIFSource.byteLimit (ImageImporter.swift, GIFAnimation.swift).
export const gifLimits = { maxFrames: 4096, frameIdentityLimit: 8192, byteLimit: 512 * 1024 * 1024, defaultDelay: 0.1, minimumDelay: 0.02, maximumDelay: 655.35 }

export class GIFError extends Error {
  constructor(readonly reason: 'unreadable' | 'tooLarge' | 'tooManyFrames', message = reason === 'unreadable' ? 'This GIF could not be read.' : reason === 'tooLarge' ? 'This GIF is too large to open.' : `A GIF can have at most ${gifLimits.maxFrames.toLocaleString()} frames.`) { super(message) }
}

type FrameRecord = { left: number; top: number; width: number; height: number; interlaced: boolean; palette: Uint8Array | null; transparent: number; disposal: number; minCodeSize: number; data: number }

// The delay a frame shows for, as GIFDecoder.duration reads it from ImageIO: none or zero is a tenth of a second, anything else at
// least 20 ms.
export const sourceDelay = (centiseconds: number) => centiseconds > 0 ? Math.max(gifLimits.minimumDelay, centiseconds / 100) : gifLimits.defaultDelay

function subBlocksEnd(bytes: Uint8Array, p: number) {
  while (p < bytes.length) { const size = bytes[p]; if (size === 0) return p + 1; p += size + 1 }
  return bytes.length
}

function parse(bytes: Uint8Array) {
  if (bytes.length < 13 || String.fromCharCode(...bytes.subarray(0, 6)) !== 'GIF89a' && String.fromCharCode(...bytes.subarray(0, 6)) !== 'GIF87a') throw new GIFError('unreadable')
  const u16 = (p: number) => bytes[p] | bytes[p + 1] << 8, n = bytes.length
  let width = u16(6), height = u16(8), p = 13, loopCount: number | null = null
  const flags = bytes[10]
  let global: Uint8Array | null = null
  if (flags & 0x80) { const size = 3 << ((flags & 7) + 1); global = bytes.subarray(p, p + size); p += size }
  const records: FrameRecord[] = [], delays: number[] = []
  let gce = { disposal: 0, transparent: -1, delay: 0 }
  while (p < n) {
    const type = bytes[p++]
    if (type === 0x3b) break
    if (type === 0x21) {
      const label = bytes[p++]
      if (label === 0xf9 && bytes[p] >= 4 && p + 5 < n) { const f = bytes[p + 1]; gce = { disposal: (f >> 2) & 7, transparent: f & 1 ? bytes[p + 4] : -1, delay: u16(p + 2) } }
      else if (label === 0xff && bytes[p] === 11 && p + 16 < n && /^(NETSCAPE2\.0|ANIMEXTS1\.0)$/.test(String.fromCharCode(...bytes.subarray(p + 1, p + 12))) && bytes[p + 12] >= 3 && bytes[p + 13] === 1) loopCount = u16(p + 14)
      p = subBlocksEnd(bytes, p)
    } else if (type === 0x2c) {
      if (p + 9 > n) break
      const left = u16(p), top = u16(p + 2), w = u16(p + 4), h = u16(p + 6), f = bytes[p + 8]
      p += 9
      let palette = global
      if (f & 0x80) { const size = 3 << ((f & 7) + 1); palette = bytes.subarray(p, p + size); p += size }
      if (p >= n) break
      const minCodeSize = bytes[p++]
      if (minCodeSize < 1 || minCodeSize > 11) throw new GIFError('unreadable')
      records.push({ left, top, width: w, height: h, interlaced: (f & 0x40) !== 0, palette, transparent: gce.transparent, disposal: gce.disposal, minCodeSize, data: p })
      delays.push(sourceDelay(gce.delay))
      if (records.length > gifLimits.maxFrames) throw new GIFError('tooManyFrames')
      p = subBlocksEnd(bytes, p)
      gce = { disposal: 0, transparent: -1, delay: 0 }
    } else break
  }
  if (!records.length) throw new GIFError('unreadable')
  // A screen of no size takes the first frame's.
  if (!width || !height) { width = records[0].left + records[0].width; height = records[0].top + records[0].height }
  if (width < 1 || height < 1) throw new GIFError('unreadable')
  if (width > maxSide || height > maxSide || width * height > maxSurfacePixels) throw new GIFError('tooLarge')
  return { width, height, loopCount, records, delays }
}

// One frame's LZW data to palette indices; returns how many it decoded, short for a truncated or damaged frame.
function lzw(bytes: Uint8Array, p: number, minCodeSize: number, out: Uint8Array) {
  const clear = 1 << minCodeSize, eoi = clear + 1, n = bytes.length
  const prefix = new Uint16Array(4096), suffix = new Uint8Array(4096), stack = new Uint8Array(4097)
  for (let i = 0; i < clear; i++) suffix[i] = i
  let size = minCodeSize + 1, mask = (1 << size) - 1, next = clear + 2, old = -1, first = 0, bits = 0, datum = 0, left = 0, o = 0
  read: while (o < out.length) {
    while (bits < size) {
      if (left === 0) { if (p >= n || (left = bytes[p++]) === 0) break read }
      if (p >= n) break read
      datum |= bytes[p++] << bits; bits += 8; left--
    }
    let code = datum & mask
    datum >>>= size; bits -= size
    if (code === clear) { size = minCodeSize + 1; mask = (1 << size) - 1; next = clear + 2; old = -1; continue }
    if (code === eoi) break
    if (old < 0) { if (code > clear) break; out[o++] = first = old = code; continue }
    const incoming = code
    let top = 0
    if (code >= next) { if (code > next) break; stack[top++] = first; code = old }
    while (code > clear) { stack[top++] = suffix[code]; code = prefix[code] }
    first = code
    stack[top++] = first
    if (next < 4096) { prefix[next] = old; suffix[next] = first; next++; if (next === mask + 1 && size < 12) { size++; mask = (1 << size) - 1 } }
    old = incoming
    while (top > 0 && o < out.length) out[o++] = stack[--top]
  }
  return o
}

const interlacedRows = (height: number) => {
  const rows: number[] = []
  for (const [start, step] of [[0, 8], [4, 8], [2, 4], [1, 2]]) for (let y = start; y < height; y += step) rows.push(y)
  return rows
}

type State = { index: number; canvas: Uint8Array; saved: Uint8Array | null }

// An animated GIF kept as its unchanged bytes, whose frames are composed on its logical screen when asked for (disposal, transparency,
// interlacing, local palettes), as browsers and ImageIO show them. Like GIFSource's kept reader, it carries on from the frame it
// composed last, and keeps a composed frame every few so going back doesn't start from the first.
export class GIFSource {
  readonly width: number
  readonly height: number
  readonly delays: number[]
  readonly loopCount: number | null
  private records: FrameRecord[]
  private state: State | null = null
  private checkpoints = new Map<number, State>()
  private checkpointBytes = 0

  constructor(readonly bytes: Uint8Array) {
    if (!bytes.length || bytes.length > gifLimits.byteLimit) throw new GIFError('tooLarge')
    const parsed = parse(bytes)
    this.width = parsed.width; this.height = parsed.height; this.delays = parsed.delays; this.loopCount = parsed.loopCount; this.records = parsed.records
  }

  get frameCount() { return this.records.length }

  // Frame `index` composed, as premultiplied RGBA (every pixel is opaque or clear, so it's the same as straight).
  frame(index: number): Raster {
    if (!Number.isInteger(index) || index < 0 || index >= this.records.length) throw new GIFError('unreadable')
    if (!this.state || this.state.index > index) {
      let best: State | null = null
      for (const [at, state] of this.checkpoints) if (at <= index && (!best || at > best.index)) best = state
      this.state = best ? { index: best.index, canvas: best.canvas.slice(), saved: best.saved?.slice() ?? null } : { index: -1, canvas: new Uint8Array(this.width * this.height * 4), saved: null }
    }
    while (this.state.index < index) this.advance(this.state)
    return new Raster(this.width, this.height, 4, this.state.canvas.slice())
  }

  private advance(state: State) {
    const { width: W, height: H } = this, canvas = state.canvas
    const rect = (r: FrameRecord) => ({ x0: Math.min(W, r.left), y0: Math.min(H, r.top), x1: Math.min(W, r.left + r.width), y1: Math.min(H, r.top + r.height) })
    if (state.index >= 0) {
      const previous = this.records[state.index], { x0, y0, x1, y1 } = rect(previous)
      if (previous.disposal === 2) for (let y = y0; y < y1; y++) canvas.fill(0, (y * W + x0) * 4, (y * W + x1) * 4)
      else if (previous.disposal === 3 && state.saved) for (let y = y0, i = 0; y < y1; y++, i += (x1 - x0) * 4) canvas.set(state.saved.subarray(i, i + (x1 - x0) * 4), (y * W + x0) * 4)
    }
    const r = this.records[state.index + 1], { x0, y0, x1, y1 } = rect(r)
    state.saved = null
    if (r.disposal === 3) {
      const saved = new Uint8Array((x1 - x0) * (y1 - y0) * 4)
      for (let y = y0, i = 0; y < y1; y++, i += (x1 - x0) * 4) saved.set(canvas.subarray((y * W + x0) * 4, (y * W + x1) * 4), i)
      state.saved = saved
    }
    if (r.palette && r.width && r.height) {
      const indices = new Uint8Array(r.width * r.height), count = lzw(this.bytes, r.data, r.minCodeSize, indices), palette = r.palette
      const rows = r.interlaced ? interlacedRows(r.height) : null
      for (let row = 0; row < r.height; row++) {
        const y = r.top + (rows ? rows[row] : row)
        if (y >= H) continue
        for (let x = 0; x < r.width; x++) {
          const i = row * r.width + x
          if (i >= count) break
          const k = indices[i], X = r.left + x
          if (k === r.transparent || k * 3 + 2 >= palette.length || X >= W) continue
          const d = (y * W + X) * 4
          canvas[d] = palette[k * 3]; canvas[d + 1] = palette[k * 3 + 1]; canvas[d + 2] = palette[k * 3 + 2]; canvas[d + 3] = 255
        }
      }
    }
    state.index++
    const size = canvas.length + (state.saved?.length ?? 0)
    if (state.index % 8 === 7 && !this.checkpoints.has(state.index) && this.checkpointBytes + size <= 128 * 1024 * 1024) {
      this.checkpoints.set(state.index, { index: state.index, canvas: canvas.slice(), saved: state.saved?.slice() ?? null })
      this.checkpointBytes += size
    }
  }
}

// Every frame composed, with its delay in seconds.
export function decodeGIF(bytes: Uint8Array): { width: number; height: number; loopCount: number | null; frames: { image: Raster; delay: number }[] } {
  const source = new GIFSource(bytes)
  return { width: source.width, height: source.height, loopCount: source.loopCount, frames: source.delays.map((delay, i) => ({ image: source.frame(i), delay })) }
}

class Writer {
  data = new Uint8Array(1 << 16)
  length = 0
  reserve(n: number) { if (this.length + n > this.data.length) { const grown = new Uint8Array(Math.max(this.data.length * 2, this.length + n)); grown.set(this.data.subarray(0, this.length)); this.data = grown } }
  byte(v: number) { this.reserve(1); this.data[this.length++] = v }
  u16(v: number) { this.reserve(2); this.data[this.length++] = v & 255; this.data[this.length++] = v >> 8 & 255 }
  bytes(v: ArrayLike<number>) { this.reserve(v.length); this.data.set(v, this.length); this.length += v.length }
  result() { return this.data.slice(0, this.length) }
}

// Palette indices to GIF's LZW in 255-byte sub-blocks, with the hashed string table of Unix compress (and so of most GIF writers).
function lzwEncode(indices: Uint8Array, minCodeSize: number, out: Writer) {
  out.byte(minCodeSize)
  const clear = 1 << minCodeSize, eoi = clear + 1, hsize = 5003, hashes = new Int32Array(hsize).fill(-1), codes = new Int32Array(hsize)
  const block = new Uint8Array(255)
  let size = minCodeSize + 1, next = eoi + 1, current = 0, bits = 0, used = 0
  const flushBlock = () => { if (used) { out.byte(used); out.bytes(block.subarray(0, used)); used = 0 } }
  const emit = (code: number) => {
    current |= code << bits; bits += size
    while (bits >= 8) { block[used++] = current & 255; if (used === 255) flushBlock(); current >>>= 8; bits -= 8 }
  }
  emit(clear)
  let entry = indices[0]
  for (let i = 1; i < indices.length; i++) {
    const c = indices[i], key = (c << 12) + entry
    let h = (c << 4) ^ entry
    if (hashes[h] === key) { entry = codes[h]; continue }
    if (hashes[h] >= 0) {
      const step = h === 0 ? 1 : hsize - h
      let found = false
      do { h -= step; if (h < 0) h += hsize; if (hashes[h] === key) { entry = codes[h]; found = true; break } } while (hashes[h] >= 0)
      if (found) continue
    }
    emit(entry)
    if (next > (1 << size) - 1 && size < 12) size++
    entry = c
    if (next < 4096) { codes[h] = next++; hashes[h] = key }
    else { emit(clear); hashes.fill(-1); next = eoi + 1; size = minCodeSize + 1 }
  }
  emit(entry)
  if (next > (1 << size) - 1 && size < 12) size++
  emit(eoi)
  if (bits > 0) { block[used++] = current & 255; if (used === 255) flushBlock() }
  flushBlock()
  out.byte(0)
}

// Up to `limit` colors for the opaque pixels of straight RGBA: the exact colors when there are few enough, otherwise a median cut of a
// 5-bit-a-channel histogram, each box its pixels' average. Returns the palette (RGB triples) and each pixel's entry (clear: `limit`).
export function quantize(rgba: Uint8Array, limit: number): { palette: Uint8Array; indices: Uint8Array } {
  const count = rgba.length / 4, indices = new Uint8Array(count), exact = new Map<number, number>()
  for (let i = 0; i < count && exact.size <= limit; i++) if (rgba[i * 4 + 3]) { const key = rgba[i * 4] << 16 | rgba[i * 4 + 1] << 8 | rgba[i * 4 + 2]; if (!exact.has(key)) exact.set(key, exact.size) }
  if (exact.size <= limit) {
    const palette = new Uint8Array(exact.size * 3)
    for (const [key, i] of exact) palette.set([key >> 16, key >> 8 & 255, key & 255], i * 3)
    for (let i = 0; i < count; i++) indices[i] = rgba[i * 4 + 3] ? exact.get(rgba[i * 4] << 16 | rgba[i * 4 + 1] << 8 | rgba[i * 4 + 2])! : limit
    return { palette, indices }
  }
  const bins = new Float64Array(32768 * 4), bin = (i: number) => (rgba[i] >> 3) << 10 | (rgba[i + 1] >> 3) << 5 | rgba[i + 2] >> 3
  for (let i = 0; i < count; i++) if (rgba[i * 4 + 3]) { const b = bin(i * 4) * 4; bins[b]++; bins[b + 1] += rgba[i * 4]; bins[b + 2] += rgba[i * 4 + 1]; bins[b + 3] += rgba[i * 4 + 2] }
  const filled: number[] = []
  for (let b = 0; b < 32768; b++) if (bins[b * 4]) filled.push(b)
  const channel = (b: number, c: number) => b >> (10 - c * 5) & 31
  type Box = { bins: number[]; pixels: number; axis: number; range: number }
  const box = (list: number[]): Box => {
    let pixels = 0, axis = 0, range = -1
    const lo = [31, 31, 31], hi = [0, 0, 0]
    for (const b of list) { pixels += bins[b * 4]; for (let c = 0; c < 3; c++) { const v = channel(b, c); if (v < lo[c]) lo[c] = v; if (v > hi[c]) hi[c] = v } }
    for (let c = 0; c < 3; c++) if (hi[c] - lo[c] > range) { range = hi[c] - lo[c]; axis = c }
    return { bins: list, pixels, axis, range }
  }
  const boxes = [box(filled)]
  while (boxes.length < limit) {
    let best = -1, score = 0
    for (let i = 0; i < boxes.length; i++) { const s = boxes[i].bins.length > 1 ? boxes[i].pixels * (boxes[i].range + 1) : 0; if (s > score) { score = s; best = i } }
    if (best < 0) break
    const { bins: list, axis, pixels } = boxes[best]
    list.sort((a, b) => channel(a, axis) - channel(b, axis))
    let split = 1, total = 0
    for (let i = 0; i < list.length - 1; i++) { total += bins[list[i] * 4]; split = i + 1; if (total >= pixels / 2) break }
    boxes.splice(best, 1, box(list.slice(0, split)), box(list.slice(split)))
  }
  const palette = new Uint8Array(boxes.length * 3)
  boxes.forEach((b, i) => {
    let n = 0, r = 0, g = 0, bl = 0
    for (const k of b.bins) { n += bins[k * 4]; r += bins[k * 4 + 1]; g += bins[k * 4 + 2]; bl += bins[k * 4 + 3] }
    palette.set([Math.round(r / n), Math.round(g / n), Math.round(bl / n)], i * 3)
  })
  const nearest = new Int16Array(32768).fill(-1)
  for (let i = 0; i < count; i++) {
    if (!rgba[i * 4 + 3]) { indices[i] = limit; continue }
    const b = bin(i * 4)
    if (nearest[b] < 0) {
      const n = bins[b * 4], r = bins[b * 4 + 1] / n, g = bins[b * 4 + 2] / n, bl = bins[b * 4 + 3] / n
      let best = 0, distance = Infinity
      for (let k = 0; k < boxes.length; k++) { const dr = palette[k * 3] - r, dg = palette[k * 3 + 1] - g, db = palette[k * 3 + 2] - bl, d = dr * dr + dg * dg + db * db; if (d < distance) { distance = d; best = k } }
      nearest[b] = best
    }
    indices[i] = nearest[b]
  }
  return { palette, indices }
}

export type GIFEncodeOptions = { loopsForever?: boolean; keepsTransparency?: boolean; background?: { red: number; green: number; blue: number } }

// Premultiplied frames to an animated GIF as GIFExporter writes one: a palette of its own for each frame and no global one, the loop
// forever (when there's more than one frame and `loopsForever`), each frame's delay in hundredths of a second. Kept transparency is
// thresholded at half coverage, keeping the color of what stays rather than darkening soft edges; otherwise the frames are flattened
// over `background` (0–1 sRGB).
export function encodeGIF(frames: { image: Raster; delay: number }[], options: GIFEncodeOptions = {}): Uint8Array {
  const { loopsForever = true, keepsTransparency = true, background = { red: 1, green: 1, blue: 1 } } = options
  if (!frames.length || frames.length > gifLimits.maxFrames) throw new GIFError(frames.length ? 'tooManyFrames' : 'unreadable')
  const { width, height } = frames[0].image
  if (width < 1 || height < 1 || width > 65535 || height > 65535 || frames.some(f => f.image.width !== width || f.image.height !== height || f.image.channels !== 4)) throw new GIFError('unreadable')
  const out = new Writer()
  out.bytes([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]); out.u16(width); out.u16(height); out.bytes([0, 0, 0])
  if (frames.length > 1 && loopsForever) { out.bytes([0x21, 0xff, 11, ...[...'NETSCAPE2.0'].map(c => c.charCodeAt(0)), 3, 1]); out.u16(0); out.byte(0) }
  const bg = [background.red, background.green, background.blue].map(v => Math.round(Math.min(1, Math.max(0, v)) * 255))
  const prepared = frames.map(({ image }) => {
    const src = image.data, rgba = new Uint8Array(src.length)
    let clear = false
    for (let i = 0; i < src.length; i += 4) {
      const a = src[i + 3]
      if (keepsTransparency) {
        if (a < 128) { clear = true; continue }
        for (let c = 0; c < 3; c++) rgba[i + c] = a === 255 ? src[i + c] : Math.min(255, Math.floor((src[i + c] * 255 + (a >> 1)) / a))
      } else for (let c = 0; c < 3; c++) rgba[i + c] = Math.min(255, Math.round(src[i + c] + bg[c] * (255 - a) / 255))
      rgba[i + 3] = 255
    }
    return { rgba, clear }
  })
  // A frame with clear pixels mustn't show the one before through them, so every frame is cleared once shown.
  const disposal = prepared.some(p => p.clear) ? 2 : 1
  frames.forEach(({ delay }, f) => {
    const { rgba, clear } = prepared[f], { palette, indices } = quantize(rgba, clear ? 255 : 256)
    const entries = palette.length / 3 + (clear ? 1 : 0), bits = Math.max(1, Math.ceil(Math.log2(Math.max(2, entries))))
    const ticks = Math.min(65535, Math.max(2, Math.round((Number.isFinite(delay) ? delay : gifLimits.defaultDelay) * 100)))
    out.bytes([0x21, 0xf9, 4, disposal << 2 | (clear ? 1 : 0)]); out.u16(ticks); out.byte(clear ? palette.length / 3 : 0); out.byte(0)
    out.byte(0x2c); out.u16(0); out.u16(0); out.u16(width); out.u16(height); out.byte(0x80 | (bits - 1))
    const table = new Uint8Array(3 << bits)
    table.set(palette)
    out.bytes(table)
    if (clear) { const index = palette.length / 3; if (index !== 255) for (let i = 0; i < indices.length; i++) if (indices[i] === 255) indices[i] = index }
    lzwEncode(indices, Math.max(2, bits), out)
    if (out.length > gifLimits.byteLimit) throw new GIFError('tooLarge')
  })
  out.byte(0x3b)
  return out.result()
}

export type GIFExportFrame = { start: number; sample: number; ticks: number; duration: number }

// GIFExportSchedule: one clock for every animated layer's frames, in GIF's 10 ms ticks. `tracks` are each layer's frame delays in
// playing order; a shorter track holds its last frame. Starts where tracks' frames meet closer than the 20 ms minimum move rather
// than lengthen the export; near the end a frame samples ahead (`sample`) so every final frame still shows. Each output frame shows,
// for every track, the frame `framePositionAt(starts[track], frame.sample)`.
export function exportSchedule(tracks: number[][]): { frames: GIFExportFrame[]; starts: number[][]; usesMinimumDelay: boolean } {
  const scale = 100, minimumTicks = Math.round(gifLimits.minimumDelay * scale)
  const starts: number[][] = [], ends: number[] = []
  for (const delays of tracks) {
    if (!delays.length) throw new GIFError('unreadable')
    if (delays.length > gifLimits.maxFrames) throw new GIFError('tooManyFrames')
    let end = 0
    const list: number[] = []
    for (const delay of delays) {
      const kept = Math.min(gifLimits.maximumDelay, Math.max(gifLimits.minimumDelay, Number.isFinite(delay) ? delay : 0.1))
      list.push(end)
      end += Math.round(Math.round(kept * 100) / 100 * scale)
    }
    starts.push(list); ends.push(end)
  }
  if (!tracks.length) { const ticks = Math.round(gifLimits.defaultDelay * scale); return { frames: [{ start: 0, sample: 0, ticks, duration: ticks / scale }], starts, usesMinimumDelay: false } }
  const end = Math.max(...ends), frames: GIFExportFrame[] = [], positions = tracks.map(() => 1)
  let start = 0, sample = 0, minimum = false
  const appendFrames = (boundary: number) => {
    while (start < boundary) {
      if (frames.length >= gifLimits.maxFrames) throw new GIFError('tooManyFrames')
      let ticks = Math.min(65535, boundary - start)
      const remainder = boundary - start - ticks
      if (remainder > 0 && remainder < minimumTicks) ticks -= minimumTicks - remainder
      frames.push({ start, sample: Math.max(start, sample), ticks, duration: ticks / scale })
      start += ticks
      sample = start
    }
  }
  for (;;) {
    let next = end
    starts.forEach((list, i) => { if (positions[i] < list.length) next = Math.min(next, list[positions[i]]) })
    if (next === end) break
    starts.forEach((list, i) => { if (positions[i] < list.length && list[positions[i]] === next) positions[i]++ })
    if (next <= start) continue
    if (next - start >= minimumTicks) appendFrames(next)
    else {
      minimum = true
      if (end - start >= minimumTicks * 2) appendFrames(start + minimumTicks)
      else sample = next
    }
  }
  appendFrames(end)
  return { frames, starts, usesMinimumDelay: minimum }
}

// The frame of a track showing at `sample` ticks.
export function framePositionAt(starts: number[], sample: number) {
  let lo = 0, hi = starts.length - 1
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= sample) lo = mid; else hi = mid - 1 }
  return lo
}
