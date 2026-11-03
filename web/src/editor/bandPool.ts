import { Raster } from '../model/raster'
import type { FilterInput, FilterOutput } from './filters'
import type * as kinds from './filterKinds'
import { bandInput, bandPlan, stitched } from './bands'

// The workers a filter worker shares a filter's bands out to (bands.ts): one per core spared from the page, fewer where memory is
// short, started on first use and let go after a while unused.
let module: WebAssembly.Module | null = null, workers: Worker[] = [], nextId = 1, idle = 0, active = 0
const waiting = new Map<number, { resolve: (out: FilterOutput) => void; reject: (error: Error) => void }>()
export const setBandKernels = (kernels: WebAssembly.Module) => { module = kernels }

export function bandLanes() {
  const cores = Math.max(1, (navigator.hardwareConcurrency || 2) - 1), memory = (navigator as { deviceMemory?: number }).deviceMemory ?? 8
  return Math.min(cores, memory >= 8 ? 6 : 3)
}

function lane(index: number): Worker {
  if (workers[index]) return workers[index]
  const worker = new Worker(new URL('./bandWorker.ts', import.meta.url), { type: 'module' })
  worker.onmessage = (event: MessageEvent<{ id: number; error?: string; result: { width: number; height: number; channels: 1 | 4; data: Uint8Array } | null }>) => {
    const { id, error, result } = event.data, pending = waiting.get(id)
    waiting.delete(id)
    if (error) pending?.reject(new Error(error))
    else pending?.resolve(result && new Raster(result.width, result.height, result.channels, result.data))
  }
  worker.onerror = () => { waiting.forEach(p => p.reject(new Error('A band stopped unexpectedly.'))); waiting.clear(); release() }
  worker.postMessage(module)
  return workers[index] = worker
}
function release() { workers.forEach(w => w.terminate()); workers = [] }

// The filter worked in bands side by side, or undefined when it isn't one that can be (or workers can't start here), for the caller
// to run it whole.
export async function runBanded(name: keyof typeof kinds, input: FilterInput, args: unknown[]): Promise<FilterOutput | undefined> {
  if (!module || typeof Worker === 'undefined') return undefined
  const plan = bandPlan(name, input, args, bandLanes())
  if (!plan) return undefined
  clearTimeout(idle)
  active++
  try {
    const results = await Promise.all(plan.bands.map((band, index) => new Promise<FilterOutput>((resolve, reject) => {
      const id = nextId++, { pixels, ...rest } = bandInput(input, band)
      waiting.set(id, { resolve, reject })
      lane(index).postMessage({ id, name, args: plan.args, input: rest, pixels: { width: pixels.width, height: pixels.height, channels: pixels.channels, data: pixels.data } }, [pixels.data.buffer])
    })))
    return stitched(input, plan, results)
  } catch { return undefined } finally { if (--active === 0) idle = self.setTimeout(release, 60_000) }
}
