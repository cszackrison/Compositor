import * as ort from 'onnxruntime-web/webgpu'
import wasm from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url'

// The subject model off the main thread: ormbg (Apache-2.0, an ISNet trained for cutting out subjects), downloaded from Hugging
// Face the first time and kept in the browser's cache. On WebGPU it runs in half precision where the GPU has it (88 MB) or full
// (176 MB); without WebGPU, a quantized copy (44 MB) runs on the CPU. It takes the image at 1024 × 1024 and gives how likely each
// pixel is to be foreground, which subject.ts turns into a mask (the Mac app uses Apple's Vision for this).
const repository = 'https://huggingface.co/onnx-community/ormbg-ONNX/resolve/main/onnx/'
const variants = { half: { file: 'model_fp16.onnx', size: 88_117_930 }, full: { file: 'model.onnx', size: 176_116_019 }, cpu: { file: 'model_quantized.onnx', size: 44_315_205 } }
type Variant = keyof typeof variants
const side = 1024

ort.env.wasm.wasmPaths = { wasm }
// Threads need a cross-origin isolated page, which this isn't.
ort.env.wasm.numThreads = 1

type Request = { kind: 'load' } | { kind: 'run'; id: number; width: number; height: number; data: Uint8Array }

let session: Promise<ort.InferenceSession> | null = null
let backend = ''

async function download(variant: Variant): Promise<Uint8Array> {
  const url = repository + variants[variant].file
  const cache = typeof caches !== 'undefined' ? await caches.open('compositor-models').catch(() => null) : null
  const cached = await cache?.match(url)
  if (cached) return new Uint8Array(await cached.arrayBuffer())
  const response = await fetch(url)
  if (!response.ok || !response.body) throw new Error(`Couldn’t download the subject model (${response.status}).`)
  const total = Number(response.headers.get('content-length')) || variants[variant].size
  const reader = response.body.getReader(), parts: Uint8Array[] = []
  let received = 0, reported = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    parts.push(value)
    received += value.byteLength
    if (received - reported > total / 100) { reported = received; self.postMessage({ kind: 'progress', received, total }) }
  }
  const bytes = new Uint8Array(received)
  let at = 0
  for (const part of parts) { bytes.set(part, at); at += part.byteLength }
  await cache?.put(url, new Response(bytes, { headers: { 'content-type': 'application/octet-stream' } })).catch(() => {})
  return bytes
}

// A WebGPU device asking for the adapter's real limits: the model has shaders with more storage buffers than WebGPU's default
// allows (17 against 16), which most GPUs support when asked.
async function gpuDevice(): Promise<GPUDevice | null> {
  const adapter = await navigator.gpu?.requestAdapter().catch(() => null)
  if (!adapter) return null
  const limits = adapter.limits as unknown as Record<string, number>
  const wanted = ['maxStorageBuffersPerShaderStage', 'maxStorageBufferBindingSize', 'maxBufferSize', 'maxComputeWorkgroupStorageSize', 'maxComputeInvocationsPerWorkgroup', 'maxComputeWorkgroupSizeX', 'maxComputeWorkgroupSizeY', 'maxComputeWorkgroupSizeZ']
  return adapter.requestDevice({
    requiredFeatures: (['shader-f16', 'subgroups'] as GPUFeatureName[]).filter(f => adapter.features.has(f)),
    requiredLimits: Object.fromEntries(wanted.filter(name => name in limits).map(name => [name, limits[name]])),
  }).catch(() => null)
}

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
      } catch (error) { self.postMessage({ kind: 'warning', message: `The subject model couldn’t start on the GPU: ${(error as Error).message}` }) }
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

// RGBA (premultiplied, so as drawn over black) to the model's 1024² planes of 0–1, bilinearly.
function input(width: number, height: number, data: Uint8Array) {
  const planes = new Float32Array(3 * side * side)
  for (let y = 0; y < side; y++) {
    const fy = Math.min(height - 1, Math.max(0, (y + 0.5) * height / side - 0.5)), y0 = Math.floor(fy), y1 = Math.min(height - 1, y0 + 1), ty = fy - y0
    for (let x = 0; x < side; x++) {
      const fx = Math.min(width - 1, Math.max(0, (x + 0.5) * width / side - 0.5)), x0 = Math.floor(fx), x1 = Math.min(width - 1, x0 + 1), tx = fx - x0
      const a = (y0 * width + x0) * 4, b = (y0 * width + x1) * 4, c = (y1 * width + x0) * 4, d = (y1 * width + x1) * 4
      for (let k = 0; k < 3; k++) {
        const v = (data[a + k] * (1 - tx) + data[b + k] * tx) * (1 - ty) + (data[c + k] * (1 - tx) + data[d + k] * tx) * ty
        planes[k * side * side + y * side + x] = v / 255
      }
    }
  }
  return planes
}

self.onmessage = async (event: MessageEvent<Request>) => {
  const request = event.data
  try {
    const model = await load()
    if (request.kind === 'load') { self.postMessage({ kind: 'ready', backend }); return }
    self.postMessage({ kind: 'finding' })
    const name = model.inputNames[0], started = performance.now(), feeds = { [name]: new ort.Tensor('float32', input(request.width, request.height, request.data), [1, 3, side, side]) }
    let outputs: ort.InferenceSession.OnnxValueMapType
    try { outputs = await model.run(feeds) } catch (error) {
      if (backend !== 'webgpu') throw error
      self.postMessage({ kind: 'warning', message: `The subject model moved to the CPU: ${(error as Error).message}` })
      outputs = await (await onCPU()).run(feeds)
    }
    // Probabilities already, or logits to squash.
    const raw = Object.values(outputs)[0].data as Float32Array, mask = new Float32Array(side * side)
    let low = Infinity, high = -Infinity
    for (let i = 0; i < mask.length; i++) { const v = raw[i]; if (v < low) low = v; if (v > high) high = v }
    const logits = low < -0.001 || high > 1.001
    for (let i = 0; i < mask.length; i++) mask[i] = logits ? 1 / (1 + Math.exp(-raw[i])) : Math.min(1, Math.max(0, raw[i]))
    self.postMessage({ kind: 'mask', id: request.id, side, mask, backend, ms: performance.now() - started }, { transfer: [mask.buffer] })
  } catch (error) {
    self.postMessage({ kind: 'error', id: request.kind === 'run' ? request.id : undefined, message: (error as Error).message })
  }
}
