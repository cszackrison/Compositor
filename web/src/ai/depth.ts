import type { Raster } from '../model/raster'
import { guided, resize } from './matte'

// The main thread's side of the depth model (depthWorker.ts, DepthModel.swift): loads it on first use, reports the download, and works
// out how far away each part of an image is, 1 nearest and 0 farthest, at the image's size. The model's map is soft and a little off
// the photo's edges, so it's enlarged to 640 across and pulled onto those edges with a guided filter, as the Mac does, then drawn to
// the image's size. The last image's depth is kept, so reopening the filter doesn't run it again.
export type DepthStatus = { stage: 'downloading'; received: number; total: number } | { stage: 'preparing' } | { stage: 'estimating' }

const refinedSide = 640
let worker: Worker | null = null
let nextId = 1
const waiting = new Map<number, { resolve: (result: { depth: Float32Array; width: number; height: number }) => void; reject: (error: Error) => void }>()
const statusListeners = new Set<(status: DepthStatus) => void>()
let kept: { raster: Raster; version: number; depth: Float32Array } | null = null

function depthWorker() {
  if (worker) return worker
  worker = new Worker(new URL('./depthWorker.ts', import.meta.url), { type: 'module' })
  worker.onmessage = (event: MessageEvent) => {
    const m = event.data
    if (m.kind === 'progress') statusListeners.forEach(l => l({ stage: 'downloading', received: m.received, total: m.total }))
    else if (m.kind === 'preparing' || m.kind === 'estimating') statusListeners.forEach(l => l({ stage: m.kind }))
    else if (m.kind === 'warning') console.warn(m.message)
    else if (m.kind === 'depth') { const w = waiting.get(m.id); waiting.delete(m.id); w?.resolve({ depth: m.depth, width: m.width, height: m.height }) }
    else if (m.kind === 'error') {
      const fail = (w: { reject: (e: Error) => void }) => w.reject(new Error(m.message))
      if (m.id !== undefined) { const w = waiting.get(m.id); waiting.delete(m.id); if (w) fail(w) } else { waiting.forEach(fail); waiting.clear() }
    }
  }
  worker.onerror = event => { waiting.forEach(w => w.reject(new Error(event.message || 'The depth model stopped unexpectedly.'))); waiting.clear(); worker = null }
  return worker
}

// `pixels`' depth (premultiplied RGBA), width × height values, rows down, 1 nearest and 0 farthest.
export async function estimateDepth(pixels: Raster, onProgress?: (status: DepthStatus) => void): Promise<Float32Array> {
  if (kept && kept.raster === pixels && kept.version === pixels.version) return kept.depth
  if (onProgress) statusListeners.add(onProgress)
  try {
    const w = depthWorker(), id = nextId++, data = pixels.data.slice()
    const found = await new Promise<{ depth: Float32Array; width: number; height: number }>((resolve, reject) => {
      waiting.set(id, { resolve, reject })
      w.postMessage({ kind: 'run', id, width: pixels.width, height: pixels.height, data }, { transfer: [data.buffer] })
    })
    const depth = refinedDepth(found.depth, found.width, found.height, pixels)
    kept = { raster: pixels, version: pixels.version, depth }
    return depth
  } finally { if (onProgress) statusListeners.delete(onProgress) }
}

// The model's map enlarged to `refinedSide` across and pulled onto the photo's edges, its brightness the guide, then to its size.
export function refinedDepth(depth: Float32Array, columns: number, rows: number, pixels: Raster): Float32Array {
  const { width: W, height: H, data } = pixels, scale = refinedSide / Math.max(W, H)
  const width = Math.max(8, Math.round(W * scale)), height = Math.max(8, Math.round(H * scale)), luma = new Float32Array(W * H)
  for (let i = 0; i < luma.length; i++) luma[i] = (0.2126 * data[i * 4] + 0.7152 * data[i * 4 + 1] + 0.0722 * data[i * 4 + 2]) / 255
  const pulled = guided(resize(depth, columns, rows, width, height), resize(luma, W, H, width, height), width, height, Math.max(2, Math.round(refinedSide / 48)), 1e-3)
  return resize(pulled, width, height, W, H)
}

export function describeDepth(status: DepthStatus) {
  if (status.stage === 'downloading') return `Downloading the depth model… ${Math.round(status.received / status.total * 100)}% of ${Math.round(status.total / 1e6)} MB (once only)`
  return status.stage === 'preparing' ? 'Starting the depth model…' : 'Getting depth…'
}
