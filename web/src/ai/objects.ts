import { Raster } from '../model/raster'

// The main thread's side of the object model (objectWorker.ts, ObjectSelection.swift): the Magic tool's Object mode selects the
// object under a click. The picture is read once until it changes; the mask comes back at the model's size and is drawn up to the
// picture's, its edge moved by Edge (inward when positive, as the Mac's erosion, outward when negative) and softened a pixel.
export type ObjectStatus = { stage: 'downloading'; received: number; total: number } | { stage: 'preparing' } | { stage: 'finding' }

let worker: Worker | null = null
let nextId = 1
const waiting = new Map<number, { resolve: (result: { mask: Float32Array; scale: number }) => void; reject: (error: Error) => void }>()
const embeds = new Map<string, { resolve: () => void; reject: (error: Error) => void }>()
let statusListener: ((status: ObjectStatus) => void) | null = null

function objectWorker() {
  if (worker) return worker
  worker = new Worker(new URL('./objectWorker.ts', import.meta.url), { type: 'module' })
  worker.onmessage = (event: MessageEvent) => {
    const m = event.data
    if (m.kind === 'progress') statusListener?.({ stage: 'downloading', received: m.received, total: m.total })
    else if (m.kind === 'preparing' || m.kind === 'finding') statusListener?.({ stage: m.kind })
    else if (m.kind === 'embedded') { embeds.get(m.key)?.resolve(); embeds.delete(m.key) }
    else if (m.kind === 'mask') { const w = waiting.get(m.id); waiting.delete(m.id); w?.resolve({ mask: m.mask, scale: m.scale }) }
    else if (m.kind === 'error') {
      const error = new Error(m.message)
      if (m.id !== undefined) { const w = waiting.get(m.id); waiting.delete(m.id); w?.reject(error) } else { waiting.forEach(w => w.reject(error)); waiting.clear(); embeds.forEach(e => e.reject(error)); embeds.clear() }
    }
  }
  worker.onerror = event => { const error = new Error(event.message || 'The object model stopped unexpectedly.'); waiting.forEach(w => w.reject(error)); waiting.clear(); embeds.forEach(e => e.reject(error)); embeds.clear(); worker = null }
  return worker
}

// A cheap fingerprint of a picture, so the same one isn't read again on every click.
function fingerprint(image: Raster) {
  let hash = 2166136261
  const step = Math.max(1, Math.floor(image.data.length / 200_000))
  for (let i = 0; i < image.data.length; i += step) hash = Math.imul(hash ^ image.data[i], 16777619)
  return `${image.width}x${image.height}:${hash >>> 0}`
}

export function describeObject(status: ObjectStatus) {
  if (status.stage === 'downloading') return `Downloading the object model… ${Math.round(status.received / status.total * 100)}% of ${Math.round(status.total / 1e6)} MB (once only)`
  return status.stage === 'preparing' ? 'Starting the object model…' : 'Reading the picture…'
}

// The object at `point` (the picture's pixels) as a selection the picture's size, or null where there's none.
export async function selectObject(image: Raster, point: [number, number], edgeOffset: number, antialias: boolean, onStatus?: (status: ObjectStatus) => void): Promise<Raster | null> {
  const w = objectWorker(), key = fingerprint(image)
  statusListener = onStatus ?? null
  try {
    await new Promise<void>((resolve, reject) => {
      embeds.set(key, { resolve, reject })
      const data = image.data.slice()
      w.postMessage({ kind: 'embed', key, width: image.width, height: image.height, data }, { transfer: [data.buffer] })
    })
    const id = nextId++
    const { mask, scale } = await new Promise<{ mask: Float32Array; scale: number }>((resolve, reject) => {
      waiting.set(id, { resolve, reject })
      w.postMessage({ kind: 'select', id, key, x: point[0], y: point[1] })
    })
    return drawnUp(mask, scale, image.width, image.height, edgeOffset, antialias)
  } finally { statusListener = null }
}

// The model's 256² mask (for the picture fitted into 1024², scaled by `scale`) at the picture's size: its logits read bilinearly, so
// the edge is placed between the model's pixels, then moved and softened.
function drawnUp(logits: Float32Array, scale: number, width: number, height: number, edgeOffset: number, antialias: boolean): Raster | null {
  const n = 256, factor = scale * n / 1024
  let mask = new Uint8Array(width * height), any = false
  for (let y = 0; y < height; y++) {
    const fy = Math.min(n - 1, Math.max(0, (y + 0.5) * factor - 0.5)), y0 = Math.floor(fy), y1 = Math.min(n - 1, y0 + 1), ty = fy - y0
    for (let x = 0; x < width; x++) {
      const fx = Math.min(n - 1, Math.max(0, (x + 0.5) * factor - 0.5)), x0 = Math.floor(fx), x1 = Math.min(n - 1, x0 + 1), tx = fx - x0
      const v = (logits[y0 * n + x0] * (1 - tx) + logits[y0 * n + x1] * tx) * (1 - ty) + (logits[y1 * n + x0] * (1 - tx) + logits[y1 * n + x1] * tx) * ty
      if (v > 0) { mask[y * width + x] = 255; any = true }
    }
  }
  if (!any) return null
  const steps = Math.min(10, Math.abs(edgeOffset))
  if (steps) mask = morphology(mask, width, height, steps, edgeOffset > 0)
  if (antialias) mask = softened(mask, width, height)
  return mask.some(v => v) ? new Raster(width, height, 1, mask) : null
}

// Erosion (`shrink`) or dilation by a square `radius` pixels out, a row pass then a column pass.
function morphology(mask: Uint8Array, width: number, height: number, radius: number, shrink: boolean) {
  const pass = (source: Uint8Array, horizontal: boolean) => {
    const out = new Uint8Array(source.length), lines = horizontal ? height : width, length = horizontal ? width : height
    for (let line = 0; line < lines; line++) for (let i = 0; i < length; i++) {
      let v = shrink ? 255 : 0
      for (let k = Math.max(0, i - radius); k <= Math.min(length - 1, i + radius); k++) {
        const s = source[horizontal ? line * width + k : k * width + line]
        v = shrink ? Math.min(v, s) : Math.max(v, s)
      }
      out[horizontal ? line * width + i : i * width + line] = v
    }
    return out
  }
  return pass(pass(mask, true), false)
}

// A 3 × 3 average over the edge, so its steps don't show.
function softened(mask: Uint8Array, width: number, height: number) {
  const out = mask.slice()
  for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
    const i = y * width + x, v = mask[i]
    if (mask[i - 1] === v && mask[i + 1] === v && mask[i - width] === v && mask[i + width] === v) continue
    let sum = 0
    for (let j = -1; j <= 1; j++) for (let k = -1; k <= 1; k++) sum += mask[i + j * width + k]
    out[i] = Math.round(sum / 9)
  }
  return out
}
