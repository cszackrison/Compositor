// A baseline JPEG of CMYK inks (4 bytes a pixel, top row first), as Photoshop writes one: an Adobe marker saying the four channels are
// stored as they are (no color transform) and inverted, every channel at full resolution, the profile embedded. Browsers only encode RGB
// JPEGs, so CMYK export has its own encoder: the standard tables, scaled for `quality` (0…1) as libjpeg scales them.

const zigzag = [0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63]
const baseTable = [16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62, 18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99]
const dcBits = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0], dcValues = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]
const acBits = [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d]
const acValues = [0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07, 0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0,
  0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49,
  0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
  0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5,
  0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa]
// The AAN transform's per-row and per-column scale, folded into the quantization.
const aan = [1, 1.387039845, 1.306562965, 1.175875602, 1, 0.785694958, 0.5411961, 0.275899379]

// Canonical Huffman codes from the counts of each length: [code, length] by symbol.
function codes(bits: number[], values: number[]) {
  const out: [number, number][] = []
  let code = 0, k = 0
  for (let length = 1; length <= 16; length++) { for (let i = 0; i < bits[length - 1]; i++) out[values[k++]] = [code++, length]; code <<= 1 }
  return out
}
const dcCodes = codes(dcBits, dcValues), acCodes = codes(acBits, acValues)

// The AAN floating-point forward DCT (libjpeg's jfdctflt.c), rows then columns, in place.
function fdct(d: Float64Array) {
  for (let pass = 0; pass < 2; pass++) for (let i = 0; i < 8; i++) {
    const at = (k: number) => pass ? i + k * 8 : i * 8 + k
    const d0 = d[at(0)], d1 = d[at(1)], d2 = d[at(2)], d3 = d[at(3)], d4 = d[at(4)], d5 = d[at(5)], d6 = d[at(6)], d7 = d[at(7)]
    const t0 = d0 + d7, t7 = d0 - d7, t1 = d1 + d6, t6 = d1 - d6, t2 = d2 + d5, t5 = d2 - d5, t3 = d3 + d4, t4 = d3 - d4
    let t10 = t0 + t3, t13 = t0 - t3, t11 = t1 + t2, t12 = t1 - t2
    d[at(0)] = t10 + t11; d[at(4)] = t10 - t11
    const z1 = (t12 + t13) * 0.707106781
    d[at(2)] = t13 + z1; d[at(6)] = t13 - z1
    t10 = t4 + t5; t11 = t5 + t6; t12 = t6 + t7
    const z5 = (t10 - t12) * 0.382683433, z2 = 0.5411961 * t10 + z5, z4 = 1.306562965 * t12 + z5, z3 = t11 * 0.707106781
    const z11 = t7 + z3, z13 = t7 - z3
    d[at(5)] = z13 + z2; d[at(3)] = z13 - z2; d[at(1)] = z11 + z4; d[at(7)] = z11 - z4
  }
}

export function encodeCMYKJPEG(inks: Uint8Array, width: number, height: number, quality = 0.9, icc?: Uint8Array): Uint8Array {
  const q = Math.min(100, Math.max(1, Math.round(quality * 100))), scale = q < 50 ? 5000 / q : 200 - q * 2
  const table = baseTable.map(v => Math.min(255, Math.max(1, Math.floor((v * scale + 50) / 100))))
  const divisors = table.map((v, i) => 1 / (v * aan[i >> 3] * aan[i & 7] * 8))
  let out = new Uint8Array(1 << 16), length = 0
  const write = (bytes: ArrayLike<number>) => { for (let i = 0; i < bytes.length; i++) { if (length === out.length) { const grown = new Uint8Array(out.length * 2); grown.set(out); out = grown } out[length++] = bytes[i] } }
  const push = (...bytes: number[]) => write(bytes)
  const marker = (code: number, ...body: ArrayLike<number>[]) => { const size = body.reduce((n, b) => n + b.length, 2); push(0xff, code, size >> 8, size & 0xff); body.forEach(write) }
  const text = (s: string) => [...s].map(c => c.charCodeAt(0))
  push(0xff, 0xd8)
  marker(0xee, [...text('Adobe'), 0, 100, 0, 0, 0, 0, 0])
  if (icc) {
    const size = 65519, chunks = Math.ceil(icc.length / size)
    for (let i = 0; i < chunks; i++) marker(0xe2, [...text('ICC_PROFILE'), 0, i + 1, chunks], icc.subarray(i * size, (i + 1) * size))
  }
  marker(0xdb, [0, ...zigzag.map(i => table[i])])
  marker(0xc0, [8, height >> 8, height & 0xff, width >> 8, width & 0xff, 4, ...[1, 2, 3, 4].flatMap(id => [id, 0x11, 0])])
  marker(0xc4, [0x00, ...dcBits, ...dcValues, 0x10, ...acBits, ...acValues])
  marker(0xda, [4, ...[1, 2, 3, 4].flatMap(id => [id, 0x00]), 0, 63, 0])
  // The scan: each 8 × 8 block of each channel in turn, edges repeated to fill the last blocks.
  let bits = 0, count = 0
  const put = (code: number, length: number) => {
    bits = (bits << length) | (code & ((1 << length) - 1)); count += length
    while (count >= 8) { const byte = (bits >> (count - 8)) & 0xff; push(byte); if (byte === 0xff) push(0); count -= 8 }
    bits &= (1 << count) - 1
  }
  const category = (v: number) => { let n = 0, a = Math.abs(v); while (a) { n++; a >>= 1 } return n }
  const value = (v: number, n: number) => v < 0 ? v + (1 << n) - 1 : v
  const block = new Float64Array(64), previous = [0, 0, 0, 0]
  for (let by = 0; by < height; by += 8) for (let bx = 0; bx < width; bx += 8) for (let c = 0; c < 4; c++) {
    for (let y = 0; y < 8; y++) {
      const row = Math.min(height - 1, by + y) * width
      for (let x = 0; x < 8; x++) block[y * 8 + x] = 255 - inks[(row + Math.min(width - 1, bx + x)) * 4 + c] - 128
    }
    fdct(block)
    const coefficients = zigzag.map(i => Math.round(block[i] * divisors[i]))
    const diff = coefficients[0] - previous[c], dcSize = category(diff)
    previous[c] = coefficients[0]
    put(...dcCodes[dcSize])
    if (dcSize) put(value(diff, dcSize), dcSize)
    let run = 0
    for (let k = 1; k < 64; k++) {
      const v = coefficients[k]
      if (!v) { run++; continue }
      while (run > 15) { put(...acCodes[0xf0]); run -= 16 }
      const size = category(v)
      put(...acCodes[(run << 4) | size]); put(value(v, size), size)
      run = 0
    }
    if (run) put(...acCodes[0x00])
  }
  if (count) put(0x7f, 8 - count)
  push(0xff, 0xd9)
  return out.slice(0, length)
}
