import { zlibSync } from 'fflate'

// Float to IEEE half, rounded to nearest; out-of-range values become infinity and NaN stays NaN.
const floatView = new Float32Array(1), intView = new Uint32Array(floatView.buffer)
export function toHalf(value: number) {
  floatView[0] = value
  const x = intView[0], sign = (x >>> 16) & 0x8000, exponent = (x >>> 23) & 0xff, mantissa = x & 0x7fffff
  if (exponent === 0xff) return sign | 0x7c00 | (mantissa ? 0x200 : 0)
  const e = exponent - 127 + 15
  if (e >= 0x1f) return sign | 0x7c00
  if (e <= 0) {
    if (e < -10) return sign
    const m = mantissa | 0x800000, shift = 14 - e, half = m >>> shift, rest = m & ((1 << shift) - 1), mid = 1 << (shift - 1)
    return sign | (half + (rest > mid || (rest === mid && half & 1) ? 1 : 0))
  }
  const half = (e << 10) | (mantissa >>> 13), rest = mantissa & 0x1fff
  return sign | (half + (rest > 0x1000 || (rest === 0x1000 && half & 1) ? 1 : 0))
}

// An OpenEXR of premultiplied linear-light RGBA floats (top row first), as the Mac's HDR layers and EXR exports keep them: half
// floats, ZIP-compressed 16 rows at a time, with the document's resolution.
export function encodeEXR(data: Float32Array, width: number, height: number, resolution = 72): Uint8Array {
  const text = new TextEncoder()
  const header: number[] = [0x76, 0x2f, 0x31, 0x01, 2, 0, 0, 0]
  const int32 = (v: number) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]
  const float32 = (v: number) => { floatView[0] = v; return int32(intView[0]) }
  const attribute = (name: string, type: string, value: number[]) => header.push(...text.encode(name), 0, ...text.encode(type), 0, ...int32(value.length), ...value)
  // Channels in the alphabetical order EXR stores them: half floats, sampled at every pixel.
  const channels = ['A', 'B', 'G', 'R']
  attribute('channels', 'chlist', [...channels.flatMap(c => [...text.encode(c), 0, ...int32(1), 0, 0, 0, 0, ...int32(1), ...int32(1)]), 0])
  attribute('compression', 'compression', [3])
  const box = [...int32(0), ...int32(0), ...int32(width - 1), ...int32(height - 1)]
  attribute('dataWindow', 'box2i', box)
  attribute('displayWindow', 'box2i', box)
  attribute('lineOrder', 'lineOrder', [0])
  attribute('pixelAspectRatio', 'float', float32(1))
  attribute('screenWindowCenter', 'v2f', [...float32(0), ...float32(0)])
  attribute('screenWindowWidth', 'float', float32(1))
  // Pixels per inch, in OpenEXR's standard attribute.
  attribute('xDensity', 'float', float32(resolution))
  header.push(0)
  const rows = 16, blocks = Math.ceil(height / rows), chunks: Uint8Array[] = []
  const order = [3, 2, 1, 0]
  for (let block = 0; block < blocks; block++) {
    const y0 = block * rows, count = Math.min(rows, height - y0), raw = new Uint8Array(count * width * 4 * 2)
    let at = 0
    for (let y = y0; y < y0 + count; y++) for (const c of order) for (let x = 0; x < width; x++) {
      const h = toHalf(data[(y * width + x) * 4 + c]); raw[at++] = h & 0xff; raw[at++] = h >>> 8
    }
    // ZIP's preparation: the bytes split into evens then odds, each stored as the difference from the one before.
    const prepared = new Uint8Array(raw.length), half = (raw.length + 1) >> 1
    for (let i = 0; i < raw.length; i++) prepared[(i & 1 ? half : 0) + (i >> 1)] = raw[i]
    for (let i = prepared.length - 1; i > 0; i--) prepared[i] = (prepared[i] - prepared[i - 1] + 128) & 0xff
    const zipped = zlibSync(prepared, { level: 6 }), body = zipped.length < raw.length ? zipped : raw
    const chunk = new Uint8Array(8 + body.length)
    chunk.set(int32(y0), 0); chunk.set(int32(body.length), 4); chunk.set(body, 8)
    chunks.push(chunk)
  }
  const tableAt = header.length, out = new Uint8Array(tableAt + blocks * 8 + chunks.reduce((n, c) => n + c.length, 0))
  out.set(header, 0)
  let offset = tableAt + blocks * 8
  chunks.forEach((chunk, i) => {
    const table = tableAt + i * 8
    out.set(int32(offset % 2 ** 32), table); out.set(int32(Math.floor(offset / 2 ** 32)), table + 4)
    out.set(chunk, offset); offset += chunk.length
  })
  return out
}
