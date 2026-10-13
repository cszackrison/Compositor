import * as ort from 'onnxruntime-web/webgpu'
import wasm from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url'
import { downloadModel } from './models'

// The object model off the main thread: SlimSAM-77 (Apache-2.0, a pruned Segment Anything), quantized, 14 MB from Hugging Face the
// first time and kept in the browser's cache, run on the CPU. Its encoder reads an image once (a second or two); a click is then
// a fast decode, which gives three masks at 256 × 256 for the image fitted into 1024 × 1024: the smallest part under the point to
// the whole object. The Mac app uses Apple's Vision for this, which finds whole objects.
const repository = 'https://huggingface.co/Xenova/slimsam-77-uniform/resolve/main/onnx/'
const side = 1024, mean = [0.485, 0.456, 0.406], deviation = [0.229, 0.224, 0.225]

ort.env.wasm.wasmPaths = { wasm }
ort.env.wasm.numThreads = 1

type Request = { kind: 'embed'; key: string; width: number; height: number; data: Uint8Array } | { kind: 'select'; id: number; key: string; x: number; y: number }

let sessions: Promise<[ort.InferenceSession, ort.InferenceSession]> | null = null
function load() {
  sessions ??= (async () => {
    const encoder = await downloadModel(repository + 'vision_encoder_quantized.onnx', 8_882_165, 'object')
    const decoder = await downloadModel(repository + 'prompt_encoder_mask_decoder_quantized.onnx', 4_903_810, 'object')
    self.postMessage({ kind: 'preparing' })
    return Promise.all([encoder, decoder].map(bytes => ort.InferenceSession.create(bytes, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' }))) as Promise<[ort.InferenceSession, ort.InferenceSession]>
  })()
  sessions.catch(() => { sessions = null })
  return sessions
}

// The image fitted into the model's square (its long side 1024, the rest padded), normalized as SAM was trained, from premultiplied
// RGBA (so as drawn over black).
function input(width: number, height: number, data: Uint8Array) {
  const scale = side / Math.max(width, height), w = Math.round(width * scale), h = Math.round(height * scale), planes = new Float32Array(3 * side * side)
  for (let y = 0; y < h; y++) {
    const fy = Math.min(height - 1, Math.max(0, (y + 0.5) / scale - 0.5)), y0 = Math.floor(fy), y1 = Math.min(height - 1, y0 + 1), ty = fy - y0
    for (let x = 0; x < w; x++) {
      const fx = Math.min(width - 1, Math.max(0, (x + 0.5) / scale - 0.5)), x0 = Math.floor(fx), x1 = Math.min(width - 1, x0 + 1), tx = fx - x0
      const a = (y0 * width + x0) * 4, b = (y0 * width + x1) * 4, c = (y1 * width + x0) * 4, d = (y1 * width + x1) * 4
      for (let k = 0; k < 3; k++) {
        const v = (data[a + k] * (1 - tx) + data[b + k] * tx) * (1 - ty) + (data[c + k] * (1 - tx) + data[d + k] * tx) * ty
        planes[k * side * side + y * side + x] = (v / 255 - mean[k]) / deviation[k]
      }
    }
  }
  return { planes, scale }
}

let embedded: { key: string; scale: number; outputs: ort.InferenceSession.OnnxValueMapType } | null = null

self.onmessage = async (event: MessageEvent<Request>) => {
  const request = event.data
  try {
    const [encoder, decoder] = await load()
    if (request.kind === 'embed') {
      if (embedded?.key === request.key) { self.postMessage({ kind: 'embedded', key: request.key }); return }
      self.postMessage({ kind: 'finding' })
      const { planes, scale } = input(request.width, request.height, request.data)
      embedded = { key: request.key, scale, outputs: await encoder.run({ pixel_values: new ort.Tensor('float32', planes, [1, 3, side, side]) }) }
      self.postMessage({ kind: 'embedded', key: request.key })
      return
    }
    if (!embedded || embedded.key !== request.key) throw new Error('The picture changed before the object could be found.')
    const { outputs, scale } = embedded
    const result = await decoder.run({
      image_embeddings: outputs.image_embeddings, image_positional_embeddings: outputs.image_positional_embeddings,
      input_points: new ort.Tensor('float32', new Float32Array([request.x * scale, request.y * scale]), [1, 1, 1, 2]), input_labels: new ort.Tensor('int64', new BigInt64Array([1n]), [1, 1, 1]),
    })
    // The whole object rather than a part of it: the largest of the masks the model is nearly as sure of as its best.
    const scores = [...result.iou_scores.data as Float32Array], masks = result.pred_masks.data as Float32Array, n = 256 * 256, best = Math.max(...scores)
    let chosen = 0, area = -1
    scores.forEach((score, k) => {
      if (score < best - 0.15) return
      let count = 0
      for (let i = k * n; i < (k + 1) * n; i++) if (masks[i] > 0) count++
      if (count > area) { area = count; chosen = k }
    })
    const mask = masks.slice(chosen * n, (chosen + 1) * n)
    self.postMessage({ kind: 'mask', id: request.id, mask, scale }, { transfer: [mask.buffer] })
  } catch (error) {
    self.postMessage({ kind: 'error', id: request.kind === 'select' ? request.id : undefined, message: (error as Error).message })
  }
}
