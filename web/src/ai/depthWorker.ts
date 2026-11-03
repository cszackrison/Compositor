import * as ort from 'onnxruntime-web/webgpu'
import wasm from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url'
import { downloadModel, gpuDevice } from './models'

// The depth model off the main thread: Depth Anything V2 Small (Apache-2.0), downloaded from Hugging Face the first time and kept in
// the browser's cache. The Mac app runs DepthMini, a Core ML model distilled from it, which browsers can't run. On WebGPU it runs in
// half precision where the GPU has it (50 MB) or full (99 MB); without WebGPU, a quantized copy (27 MB) runs on the CPU. It takes the
// image at most 518 across (a multiple of 14 each way, as it's made of 14-pixel patches) and gives each pixel's relative nearness.
const repository = 'https://huggingface.co/onnx-community/depth-anything-v2-small/resolve/main/onnx/'
const variants = { half: { file: 'model_fp16.onnx', size: 49_642_442 }, full: { file: 'model.onnx', size: 99_060_839 }, cpu: { file: 'model_quantized.onnx', size: 27_258_801 } }
type Variant = keyof typeof variants
const longest = 518, patch = 14, mean = [0.485, 0.456, 0.406], deviation = [0.229, 0.224, 0.225]

ort.env.wasm.wasmPaths = { wasm }
// Threads need a cross-origin isolated page, which this isn't.
ort.env.wasm.numThreads = 1

type Request = { kind: 'load' } | { kind: 'run'; id: number; width: number; height: number; data: Uint8Array }

let session: Promise<ort.InferenceSession> | null = null
let backend = ''

const download = (variant: Variant) => downloadModel(repository + variants[variant].file, variants[variant].size, 'depth')

function create(bytes: Uint8Array, device: GPUDevice | null) {
  return ort.InferenceSession.create(bytes, { executionProviders: device ? [{ name: 'webgpu', device } as ort.InferenceSession.ExecutionProviderConfig] : ['wasm'], graphOptimizationLevel: 'all' })
}

function load() {
  session ??= (async () => {
    const device = await gpuDevice()
    if (device) {
      try {
        const bytes = await download(device.features.has('shader-f16') ? 'half' : 'full')
        self.postMessage({ kind: 'preparing' })
        backend = 'webgpu'
        return await create(bytes, device)
      } catch (error) { self.postMessage({ kind: 'warning', message: `The depth model couldn’t start on the GPU: ${(error as Error).message}` }) }
    }
    return onCPU()
  })()
  session.catch(() => { session = null })
  return session
}

// Without WebGPU, or a GPU that can't run some part of the model (which shows at the first run, not when it loads): the CPU.
async function onCPU() {
  const bytes = await download('cpu')
  self.postMessage({ kind: 'preparing' })
  backend = 'wasm'
  session = create(bytes, null)
  return session
}

// The model's size for the image: its longer side 518, the other in proportion, both multiples of 14.
function shape(width: number, height: number) {
  const k = longest / Math.max(width, height), fit = (v: number) => Math.max(patch, Math.round(v * k / patch) * patch)
  return [fit(width), fit(height)]
}

// RGBA (premultiplied, so as drawn over black) to the model's normalized planes, each pixel the average of its footprint so a large
// photo's detail isn't skipped (bilinear where the image is smaller than the model's size).
function input(width: number, height: number, data: Uint8Array, columns: number, rows: number) {
  const planes = new Float32Array(3 * columns * rows), sx = width / columns, sy = height / rows, plane = columns * rows
  for (let y = 0; y < rows; y++) for (let x = 0; x < columns; x++) {
    const sum = [0, 0, 0]
    if (sx >= 1 && sy >= 1) {
      const xa = Math.floor(x * sx), xb = Math.max(xa + 1, Math.min(width, Math.floor((x + 1) * sx))), ya = Math.floor(y * sy), yb = Math.max(ya + 1, Math.min(height, Math.floor((y + 1) * sy))), n = (xb - xa) * (yb - ya)
      for (let j = ya; j < yb; j++) for (let i = xa; i < xb; i++) { const o = (j * width + i) * 4; sum[0] += data[o]; sum[1] += data[o + 1]; sum[2] += data[o + 2] }
      for (let k = 0; k < 3; k++) sum[k] /= n
    } else {
      const fy = Math.min(height - 1, Math.max(0, (y + 0.5) * sy - 0.5)), y0 = Math.floor(fy), y1 = Math.min(height - 1, y0 + 1), ty = fy - y0
      const fx = Math.min(width - 1, Math.max(0, (x + 0.5) * sx - 0.5)), x0 = Math.floor(fx), x1 = Math.min(width - 1, x0 + 1), tx = fx - x0
      const a = (y0 * width + x0) * 4, b = (y0 * width + x1) * 4, c = (y1 * width + x0) * 4, d = (y1 * width + x1) * 4
      for (let k = 0; k < 3; k++) sum[k] = (data[a + k] * (1 - tx) + data[b + k] * tx) * (1 - ty) + (data[c + k] * (1 - tx) + data[d + k] * tx) * ty
    }
    for (let k = 0; k < 3; k++) planes[k * plane + y * columns + x] = (sum[k] / 255 - mean[k]) / deviation[k]
  }
  return planes
}

self.onmessage = async (event: MessageEvent<Request>) => {
  const request = event.data
  try {
    const model = await load()
    if (request.kind === 'load') { self.postMessage({ kind: 'ready', backend }); return }
    self.postMessage({ kind: 'estimating' })
    const [columns, rows] = shape(request.width, request.height), started = performance.now()
    const feeds = { [model.inputNames[0]]: new ort.Tensor('float32', input(request.width, request.height, request.data, columns, rows), [1, 3, rows, columns]) }
    let outputs: ort.InferenceSession.OnnxValueMapType
    try { outputs = await model.run(feeds) } catch (error) {
      if (backend !== 'webgpu') throw error
      self.postMessage({ kind: 'warning', message: `The depth model moved to the CPU: ${(error as Error).message}` })
      outputs = await (await onCPU()).run(feeds)
    }
    // Relative nearness (disparity), larger nearer, at the model's size: spread 0–1, 1 nearest, as the Mac's DepthMap.
    const output = Object.values(outputs)[0], raw = output.data as Float32Array, dims = output.dims, outRows = Number(dims[dims.length - 2]), outColumns = Number(dims[dims.length - 1])
    let low = Infinity, high = -Infinity
    for (let i = 0; i < outRows * outColumns; i++) { const v = raw[i]; if (v < low) low = v; if (v > high) high = v }
    if (!(high > low)) throw new Error('The depth model found no depth in this image.')
    const depth = new Float32Array(outRows * outColumns)
    for (let i = 0; i < depth.length; i++) depth[i] = (raw[i] - low) / (high - low)
    self.postMessage({ kind: 'depth', id: request.id, width: outColumns, height: outRows, depth, backend, ms: performance.now() - started }, { transfer: [depth.buffer] })
  } catch (error) {
    self.postMessage({ kind: 'error', id: request.kind === 'run' ? request.id : undefined, message: (error as Error).message })
  }
}
