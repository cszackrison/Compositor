import type { Raster } from '../model/raster'
import { resize } from './matte'

// The main thread's side of the subject model (subjectWorker.ts): loads it on first use, reports the download, and finds the
// foreground of an image as a 0–1 mask the image's size. The last image's mask is kept, so a panel's sliders don't run it again
// (SubjectRemoval's MaskCache).
export type SubjectStatus = { stage: 'downloading'; received: number; total: number } | { stage: 'preparing' } | { stage: 'finding' }

let worker: Worker | null = null
let nextId = 1
const waiting = new Map<number, { resolve: (result: { mask: Float32Array; side: number }) => void; reject: (error: Error) => void }>()
const statusListeners = new Set<(status: SubjectStatus) => void>()
let kept: { raster: Raster; version: number; mask: Float32Array } | null = null

function subjectWorker() {
  if (worker) return worker
  worker = new Worker(new URL('./subjectWorker.ts', import.meta.url), { type: 'module' })
  worker.onmessage = (event: MessageEvent) => {
    const m = event.data
    if (m.kind === 'progress') statusListeners.forEach(l => l({ stage: 'downloading', received: m.received, total: m.total }))
    else if (m.kind === 'preparing' || m.kind === 'finding') statusListeners.forEach(l => l({ stage: m.kind }))
    else if (m.kind === 'warning') console.warn(m.message)
    else if (m.kind === 'mask') { const w = waiting.get(m.id); waiting.delete(m.id); w?.resolve({ mask: m.mask, side: m.side }) }
    else if (m.kind === 'error') {
      const fail = (w: { reject: (e: Error) => void }) => w.reject(new Error(m.message))
      if (m.id !== undefined) { const w = waiting.get(m.id); waiting.delete(m.id); if (w) fail(w) } else { waiting.forEach(fail); waiting.clear() }
    }
  }
  worker.onerror = event => { waiting.forEach(w => w.reject(new Error(event.message || 'The subject model stopped unexpectedly.'))); waiting.clear(); worker = null }
  return worker
}

// The foreground of `image` (premultiplied RGBA), white over the subject, at the image's size.
export async function findSubject(image: Raster, onStatus?: (status: SubjectStatus) => void): Promise<Float32Array> {
  if (kept && kept.raster === image && kept.version === image.version) return kept.mask
  if (onStatus) statusListeners.add(onStatus)
  try {
    const w = subjectWorker(), id = nextId++, data = image.data.slice()
    const found = await new Promise<{ mask: Float32Array; side: number }>((resolve, reject) => {
      waiting.set(id, { resolve, reject })
      w.postMessage({ kind: 'run', id, width: image.width, height: image.height, data }, { transfer: [data.buffer] })
    })
    const mask = resize(found.mask, found.side, found.side, image.width, image.height)
    kept = { raster: image, version: image.version, mask }
    return mask
  } finally { if (onStatus) statusListeners.delete(onStatus) }
}

export function describe(status: SubjectStatus) {
  if (status.stage === 'downloading') return `Downloading the subject model… ${Math.round(status.received / status.total * 100)}% of ${Math.round(status.total / 1e6)} MB (once only)`
  return status.stage === 'preparing' ? 'Starting the subject model…' : 'Finding the subject…'
}
