import { describe, expect, it } from 'vitest'
import { Raster } from '../src/model/raster'
import { rgbSplit, rgbSplitSpread, rgbSplitTaps, type RGBSplitSettings } from '../src/editor/rgbSplit'

const settings = (overrides: Partial<RGBSplitSettings>): RGBSplitSettings => ({ distance: 10, blur: 0, angle: 0, radial: false, center: [32, 32], reach: 1000, ...overrides })
const at = (r: Raster, x: number, y: number) => [...r.data.subarray((y * r.width + x) * 4, (y * r.width + x) * 4 + 4)]

// A white vertical line, 2 pixels wide, at x = 31–32 on opaque black.
function line(size = 64) {
  const image = Raster.filled(size, size, 4, [0, 0, 0, 255])
  for (let y = 0; y < size; y++) for (const x of [31, 32]) image.data.set([255, 255, 255, 255], (y * size + x) * 4)
  return image
}

describe('RGB Split', () => {
  it('leaves the image unchanged with no distance or blur', () => {
    const image = line(), out = rgbSplit(image, settings({ distance: 0, blur: 0 }))
    expect(out).not.toBe(image)
    expect(Buffer.from(out.data).equals(Buffer.from(image.data))).toBe(true)
  })

  it('fans a line into colored fringes along the angle, red ahead and blue behind', () => {
    const out = rgbSplit(line(), settings({ distance: 12 }))
    const ahead = at(out, 37, 20), behind = at(out, 26, 20)
    expect(ahead[0]).toBeGreaterThan(ahead[2] + 20)
    expect(behind[2]).toBeGreaterThan(behind[0] + 20)
    for (const p of [ahead, behind]) expect(p[3]).toBe(255)
    // At 90°, a vertical line splits along itself and stays put.
    const along = rgbSplit(line(), settings({ distance: 12, angle: 90 }))
    expect(at(along, 37, 20)).toEqual([0, 0, 0, 255])
  })

  it('keeps colors within alpha and smears with blur', () => {
    const image = new Raster(64, 64, 4)
    for (let y = 20; y < 44; y++) for (let x = 20; x < 44; x++) image.data.set([200, 100, 50, 255], (y * 64 + x) * 4)
    const out = rgbSplit(image, settings({ distance: 6, blur: 16 }))
    for (let i = 0; i < out.data.length; i += 4) for (let c = 0; c < 3; c++) expect(out.data[i + c]).toBeLessThanOrEqual(out.data[i + 3])
    expect(at(out, 12, 32)[3]).toBeGreaterThan(0)
    expect(at(out, 32, 12)[3]).toBe(0)
  })

  it('leaves the center sharp when radial', () => {
    const image = new Raster(64, 64, 4)
    for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) image.data.set((x >> 3) % 2 ? [255, 255, 255, 255] : [0, 0, 0, 255], (y * 64 + x) * 4)
    const out = rgbSplit(image, settings({ distance: 12, radial: true, center: [36, 32], reach: 32 }))
    for (const x of [34, 35, 36, 37, 38]) expect(at(out, x, 32)).toEqual(at(image, x, 32))
    const fringes = [56, 57, 58, 59, 60, 61, 62, 63].map(x => at(out, x, 32)).map(p => Math.abs(p[0] - p[2]))
    expect(Math.max(...fringes)).toBeGreaterThan(40)
  })

  it('carries the edge on past the canvas sides', () => {
    const image = Raster.filled(32, 32, 4, [255, 255, 255, 255])
    expect(at(rgbSplit(image, settings({ distance: 8, center: [16, 16] })), 0, 16)[3]).toBeLessThan(255)
    expect(at(rgbSplit(image, settings({ distance: 8, center: [16, 16] }), { left: true, right: true, top: true, bottom: true }), 0, 16)).toEqual([255, 255, 255, 255])
  })

  it('runs a 1024 px layer with blur in reasonable time', () => {
    const size = 1024, image = new Raster(size, size, 4)
    for (let i = 0; i < image.data.length; i += 4) { const v = (i >> 2) * 2654435761 >>> 24; image.data.set([v, v >> 1, 255 - v, 255], i) }
    const start = performance.now()
    rgbSplit(image, settings({ distance: 40, blur: 60, center: [512, 512] }))
    expect(performance.now() - start).toBeLessThan(8000)
  }, 30000)
})

// The split as the Mac's kernel reads it, one sample at a time, to hold the fast paths (grid, padding, opacity, the streaks' spans) to.
function reference(pixels: Raster, s: RGBSplitSettings, sides?: { left: boolean; right: boolean; top: boolean; bottom: boolean }) {
  const { width: w, height: h } = pixels, { spectral: n, smear: m } = rgbSplitTaps(s), bits = sides ? (sides.left ? 1 : 0) | (sides.right ? 2 : 0) | (sides.top ? 4 : 0) | (sides.bottom ? 8 : 0) : 0
  const [cx, cy] = s.center, reach = Math.max(s.reach, 1), dx = Math.cos(s.angle * Math.PI / 180), dy = -Math.sin(s.angle * Math.PI / 180)
  const level = (x: number, y: number) => { const v = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453; return Math.floor((v - Math.floor(v)) * 64) }
  const axis = (ax: number, ay: number, scale: number) => s.radial ? [(ax - cx) / reach * scale, (ay - cy) / reach * scale] : [dx * scale, dy * scale]
  const sample = (src: ArrayLike<number>, iw: number, ih: number, origin: number, sides: number, qx: number, qy: number) => {
    const tx = qx - origin, ty = qy - origin
    if ((tx < 0 && !(sides & 1)) || (tx > iw && !(sides & 2)) || (ty < 0 && !(sides & 4)) || (ty > ih && !(sides & 8))) return [0, 0, 0, 0]
    const x = tx - 0.5, y = ty - 0.5, x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0, cl = (v: number, size: number) => Math.min(size - 1, Math.max(0, v))
    const at = (xx: number, yy: number) => (cl(yy, ih) * iw + cl(xx, iw)) * 4
    return [0, 1, 2, 3].map(c => src[at(x0, y0) + c] * (1 - fx) * (1 - fy) + src[at(x0 + 1, y0) + c] * fx * (1 - fy) + src[at(x0, y0 + 1) + c] * (1 - fx) * fy + src[at(x0 + 1, y0 + 1) + c] * fx * fy)
  }
  let input: ArrayLike<number> = Array.from(pixels.data, v => v * 256), iw = w, ih = h, origin = 0, inputSides = bits
  if (m > 1) {
    const pad = Math.ceil(rgbSplitSpread(s, 0, 0, w, h)) + 2, source = input, streaks = new Uint16Array((w + pad * 2) * (h + pad * 2) * 4)
    iw = w + pad * 2; ih = h + pad * 2
    for (let y = 0; y < ih; y++) for (let x = 0; x < iw; x++) {
      const ax = x - pad + 0.5, ay = y - pad + 0.5, [vx, vy] = axis(ax, ay, s.blur), sum = [0, 0, 0, 0]
      for (let j = 0; j < m; j++) { const u = (j + level(x, y) / 64) / m - 0.5; sample(source, w, h, 0, bits, ax - vx * u, ay - vy * u).forEach((v, c) => sum[c] += v) }
      sum.forEach((v, c) => streaks[(y * iw + x) * 4 + c] = v / m + 0.5)
    }
    input = streaks; origin = -pad; inputSides = 15
  }
  const out = new Raster(w, h, 4)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const ax = x + 0.5, ay = y + 0.5, [px, py] = axis(ax, ay, s.distance), c = [0, 0, 0], alpha = [0, 0, 0], total = [0, 0, 0]
    for (let i = 0; i < n; i++) {
      const t = n === 1 ? 0 : (i + level(x, y) / 64) / n * 2 - 1, smooth = (v: number) => { const k = Math.min(1, Math.max(0, v)); return k * k * (3 - 2 * k) }
      const tint = [smooth((t + 0.3) / 1.3), 1.05 - smooth(Math.abs(t)), smooth((0.3 - t) / 1.3)], v = sample(input, iw, ih, origin, inputSides, ax - px * t, ay - py * t)
      for (let k = 0; k < 3; k++) { c[k] += tint[k] * v[k]; alpha[k] += tint[k] * v[3]; total[k] += tint[k] * 256 }
    }
    const a = Math.min(255, Math.max(...alpha.map((v, k) => v / total[k])))
    out.data.set([...c.map((v, k) => Math.round(Math.min(v / total[k], a))), Math.round(a)], (y * w + x) * 4)
  }
  return out
}

describe('RGB Split fast paths', () => {
  // Opaque or cut out, hard edges and soft, so every path (grid, placed, clamped, opaque or not) is crossed.
  const picture = (clear: boolean) => {
    const image = new Raster(40, 30, 4)
    for (let y = 0; y < 30; y++) for (let x = 0; x < 40; x++) {
      const a = clear && Math.hypot(x - 20, y - 15) > 12 ? 0 : clear && Math.hypot(x - 20, y - 15) > 9 ? 128 : 255, v = (x * 7 + y * 13) % 256
      image.data.set([v, x * 6, x > 18 && x < 23 ? 255 : y * 8, 255].map(c => Math.round(c * a / 255)), (y * 40 + x) * 4)
    }
    return image
  }
  const all = { left: true, right: true, top: true, bottom: true }, some = { left: true, right: false, top: false, bottom: true }
  const cases: [string, Partial<RGBSplitSettings>][] = [
    ['along a row', { distance: 9 }], ['along a column', { distance: 7, angle: 90 }], ['backwards', { distance: 6, angle: 180 }], ['at an angle', { distance: 11, angle: 30 }],
    ['blurred', { distance: 5, blur: 12, angle: -135 }], ['blur alone', { distance: 0, blur: 9, angle: 20 }], ['radial', { distance: 8, radial: true, center: [14, 18], reach: 16 }],
    ['radial blurred', { distance: 6, blur: 10, radial: true, center: [26, 10], reach: 20 }], ['radial off the layer', { distance: 5, blur: 6, radial: true, center: [-30, 50], reach: 25 }],
  ]
  for (const [name, overrides] of cases) for (const clear of [false, true]) for (const [edge, sides] of [['no sides', undefined], ['every side', all], ['some sides', some]] as const) {
    it(`matches one sample at a time: ${name}, ${clear ? 'cut out' : 'opaque'}, ${edge}`, () => {
      const image = picture(clear), s = settings({ center: [20, 15], ...overrides }), fast = rgbSplit(image, s, sides), slow = reference(image, s, sides)
      let worst = 0
      for (let i = 0; i < fast.data.length; i++) worst = Math.max(worst, Math.abs(fast.data[i] - slow.data[i]))
      expect(worst).toBeLessThanOrEqual(1)
    })
  }
})
