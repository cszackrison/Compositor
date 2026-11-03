import { Raster } from '../model/raster'
import { curveValue } from '../model/adjustments'

// Filter › Lens Effects, after LensEffects.swift: what light does inside a camera's lens and the filters in front of it, each effect
// made from the picture's own light, in linear light as optics work. Planes of floats (one per color) stand in for Core Image's
// images: past the picture's edge is black unless a step carries the edge on, as clampedToExtent does there.
export const lensEffects = ['Anamorphic Flare', 'Starburst', 'Mist', 'Prism', 'Bokeh'] as const
export const bokehShapes = ['Round', 'Hexagon', 'Oval', "Cat's Eye"] as const
export const starPointChoices = [4, 6, 8, 12, 14]
export type LensEffectName = typeof lensEffects[number]
export type BokehShape = typeof bokehShapes[number]

// The project's `lens` object (format 18 and 20): lengths given as percentages are of the document's longer side.
export type LensSettings = {
  effect: LensEffectName; threshold: number
  flareAmount: number; flareLength: number; flareBlue: number
  starAmount: number; starLength: number; starPoints: number; starAngle: number
  mistStrength: number; mistSize: number
  prismAmount: number; prismCopies: number; prismOffset: number; prismAngle: number; prismBothWays: boolean; prismBlur: number; prismFringe: number
  bokehRadius: number; bokehBrightness: number; bokehRing: number; bokehShape: BokehShape
}

export const defaultLens: LensSettings = {
  effect: 'Anamorphic Flare', threshold: 90, flareAmount: 50, flareLength: 60, flareBlue: 80, starAmount: 50, starLength: 12, starPoints: 6, starAngle: 15,
  mistStrength: 50, mistSize: 30, prismAmount: 80, prismCopies: 5, prismOffset: 6, prismAngle: 180, prismBothWays: false, prismBlur: 0, prismFringe: 30,
  bokehRadius: 2, bokehBrightness: 50, bokehRing: 100, bokehShape: 'Round',
}

const ranges: [keyof LensSettings, number, number][] = [
  ['threshold', 50, 100], ['flareAmount', 0, 100], ['flareLength', 1, 100], ['flareBlue', 0, 100], ['starAmount', 0, 100], ['starLength', 2, 40], ['starAngle', -180, 180],
  ['mistStrength', 0, 100], ['mistSize', 0, 100], ['prismAmount', 0, 100], ['prismCopies', 1, 8], ['prismOffset', 0, 50], ['prismAngle', -180, 180], ['prismBlur', 0, 100],
  ['prismFringe', 0, 100], ['bokehRadius', 0.5, 6], ['bokehBrightness', 0, 100], ['bokehRing', 0, 100],
]

// Each setting read if it's there and its default if not, clamped as LensEffectSettings.normalized does.
export function normalizedLens(raw: Partial<LensSettings> | undefined): LensSettings {
  const r = (raw ?? {}) as Record<string, unknown>, out: Record<string, unknown> = { ...defaultLens }
  for (const [key, lo, hi] of ranges) { const v = r[key]; if (typeof v === 'number' && Number.isFinite(v)) out[key] = Math.min(hi, Math.max(lo, v)) }
  out.prismCopies = Math.round(out.prismCopies as number)
  if (lensEffects.includes(r.effect as LensEffectName)) out.effect = r.effect
  if (bokehShapes.includes(r.bokehShape as BokehShape)) out.bokehShape = r.bokehShape
  if (starPointChoices.includes(r.starPoints as number)) out.starPoints = r.starPoints
  if (typeof r.prismBothWays === 'boolean') out.prismBothWays = r.prismBothWays
  return out as LensSettings
}

// Nothing to do: OK closes as Cancel does.
export function lensIsIdentity(s: LensSettings) {
  return s.effect === 'Anamorphic Flare' ? s.flareAmount === 0 : s.effect === 'Starburst' ? s.starAmount === 0 : s.effect === 'Mist' ? s.mistStrength === 0 : s.effect === 'Prism' ? s.prismAmount === 0 : false
}

type Planes = Float32Array[]
type Frame = { w: number; h: number; side: number; lin: Planes; luma: Float32Array }

// The effect on premultiplied 8-bit pixels, its sizes proportions of `side` pixels (the document's longer side). The light arithmetic
// runs on opaque colors and each pixel's own alpha goes back on at the end, as the Mac's does.
export function lensEffect(pixels: Raster, settings: LensSettings, side: number): Raster {
  const s = normalizedLens(settings), { width: w, height: h } = pixels
  if (!w || !h || lensIsIdentity(s)) return pixels.clone()
  const f = decode(pixels, Math.max(1, side))
  const light = s.effect === 'Anamorphic Flare' ? anamorphic(f, s) : s.effect === 'Starburst' ? starburst(f, s) : s.effect === 'Mist' ? mist(f, s) : s.effect === 'Prism' ? prism(f, s) : bokeh(f, s)
  return encode(light, pixels)
}

const toLinear = (v: number) => v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
const byteLinear = Float32Array.from({ length: 256 }, (_, i) => toLinear(i / 255))
let gammaTable: Float32Array | undefined
const gammaOf = () => gammaTable ??= Float32Array.from({ length: 65537 }, (_, i) => { const v = i / 65536; return (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055) * 255 })

function decode(pixels: Raster, side: number): Frame {
  const { width: w, height: h, data } = pixels, n = w * h, lin = [new Float32Array(n), new Float32Array(n), new Float32Array(n)], luma = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const a = data[i * 4 + 3]
    if (!a) continue
    const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2]
    if (a === 255) { lin[0][i] = byteLinear[r]; lin[1][i] = byteLinear[g]; lin[2][i] = byteLinear[b]; luma[i] = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255; continue }
    const sr = Math.min(1, r / a), sg = Math.min(1, g / a), sb = Math.min(1, b / a)
    lin[0][i] = toLinear(sr); lin[1][i] = toLinear(sg); lin[2][i] = toLinear(sb); luma[i] = 0.2126 * sr + 0.7152 * sg + 0.0722 * sb
  }
  return { w, h, side, lin, luma }
}

function encode(light: Planes, pixels: Raster) {
  const out = new Raster(pixels.width, pixels.height, 4), table = gammaOf(), src = pixels.data, d = out.data
  for (let i = 0; i < light[0].length; i++) {
    const a = src[i * 4 + 3]
    if (!a) continue
    for (let c = 0; c < 3; c++) { const v = light[c][i], k = v <= 0 ? 0 : v >= 1 ? 65536 : (v * 65536 + 0.5) | 0; d[i * 4 + c] = Math.round(table[k] * a / 255) }
    d[i * 4 + 3] = a
  }
  return out
}

// Core Image's tone curve, as a table over 0–1: a smooth curve through the points (Curves' spline), flat past the ends.
function toneTable(points: number[][]) {
  const p = points.map(([x, y]) => ({ x: x * 255, y: y * 255 })), t = new Float32Array(1025)
  for (let i = 0; i <= 1024; i++) t[i] = curveValue(p, i / 1024 * 255) / 255
  return t
}
function tone(t: Float32Array, v: number) { const u = (v <= 0 ? 0 : v >= 1 ? 1 : v) * 1024, i = Math.min(1023, u | 0); return t[i] + (t[i + 1] - t[i]) * (u - i) }
const softTable = toneTable([[0, 0], [0.0625, 0.224], [0.125, 0.398], [0.25, 0.638], [1, 1]])
const brightnessTables = new Map<number, Float32Array>()

// Light compressed smoothly toward `limit`: nearly unchanged when dim, never past it.
const softClip = (v: number, limit: number) => tone(softTable, v / (4 * limit)) * limit

// How far each pixel is above `threshold` in brightness (of its sRGB tones), 0–1.
function brightness(luma: Float32Array, threshold: number) {
  const t = Math.min(0.95, Math.max(0, threshold)), k = 1 - t
  let table = brightnessTables.get(t)
  if (!table) brightnessTables.set(t, table = toneTable([[0, 0], [t, 0], [t + k * 0.4, 0.25], [t + k * 0.75, 0.7], [1, 1]]))
  const out = new Float32Array(luma.length)
  for (let i = 0; i < luma.length; i++) if (luma[i] > t) out[i] = tone(table, luma[i])
  return out
}

const masked = (f: Frame, mask: Float32Array, gain = 1) => f.lin.map(p => { const out = new Float32Array(p.length); for (let i = 0; i < p.length; i++) out[i] = p[i] * mask[i] * gain; return out })
const highlights = (f: Frame, threshold: number, gain = 1) => masked(f, brightness(f.luma, threshold), gain)

// The lights a flare or starburst is made from (LensOptics.sources): up to 0.95 by how bright they are; past it, by how big and solid,
// a pixel staying only where its surroundings are lit too, measured against the picture's strongest source. Worked on a copy shrunk
// to a few pixels per radius, as everything there is a wide blur.
function sources(f: Frame, threshold: number): Planes {
  if (threshold <= 0.95) return highlights(f, threshold)
  const { w, h, side } = f, density = Math.min(1, (threshold - 0.95) / 0.05), lit = brightness(f.luma, 0.95), radius = side * 0.03 * density
  const k = Math.max(1, Math.ceil(radius / 4)), sw = Math.max(1, Math.round(w / k)), sh = Math.max(1, Math.round(h / k))
  const small = k > 1 ? resample(lit, w, h, sw, sh) : lit, r = radius * sw / w
  const around = gauss(small, sw, sh, r, radius * sh / h, true)
  let peak = 0
  for (let i = 0; i < around.length; i++) if (around[i] > peak) peak = around[i]
  if (peak <= 0.001) return highlights(f, 0.95)
  const cut = 0.25 + 0.6 * density, soft = 0.05, curve = toneTable([[0, 0], [Math.max(0, cut - soft), 0], [cut, 0.5], [cut + soft, 1], [Math.max(1, cut + soft * 2), 1]])
  for (let i = 0; i < around.length; i++) around[i] = tone(curve, around[i] / peak)
  const grown = dilate(around, sw, sh, r), whole = k > 1 ? enlarge(grown, sw, sh, w, h) : grown
  for (let i = 0; i < lit.length; i++) lit[i] *= whole[i]
  return masked(f, lit)
}

// Each value spread over a disc of `radius`, the largest kept (Core Image's CIMorphologyMaximum), from the lit pixels only.
function dilate(src: Float32Array, w: number, h: number, radius: number) {
  const out = src.slice(), reach = Math.floor(radius), spans: [number, number][] = []
  for (let dy = -reach; dy <= reach; dy++) spans.push([dy, Math.floor(Math.sqrt(Math.max(0, radius * radius - dy * dy)))])
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = src[y * w + x]
    if (v <= 0) continue
    for (const [dy, half] of spans) {
      const yy = y + dy
      if (yy < 0 || yy >= h) continue
      const row = yy * w, x1 = Math.min(w - 1, x + half)
      for (let xx = Math.max(0, x - half); xx <= x1; xx++) if (out[row + xx] < v) out[row + xx] = v
    }
  }
  return out
}

// Only the lights shorter than `height` pixels: the light less its vertical opening, so a wide bright area drops out and a lamp stays.
function compact(light: Float32Array, w: number, h: number, height: number) {
  const size = Math.max(3, Math.floor(height) | 1), turned = transpose(light, w, h)
  const opened = transpose(rowFilter(rowFilter(turned, h, w, size, false), h, w, size, true), h, w), out = new Float32Array(light.length)
  for (let i = 0; i < out.length; i++) out[i] = Math.max(0, light[i] - opened[i])
  return out
}

// In tiles, so both sides stay in the cache.
function transpose(src: Float32Array, w: number, h: number) {
  const out = new Float32Array(src.length)
  for (let ty = 0; ty < h; ty += 64) for (let tx = 0; tx < w; tx += 64) {
    const y1 = Math.min(h, ty + 64), x1 = Math.min(w, tx + 64)
    for (let y = ty; y < y1; y++) for (let x = tx; x < x1; x++) out[x * h + y] = src[y * w + x]
  }
  return out
}

const emptyRow = (p: Float32Array, base: number, w: number) => { for (let x = 0; x < w; x++) if (p[base + x] !== 0) return false; return true }
function liveRows(p: Float32Array, w: number, h: number) { const live = new Uint8Array(h); for (let y = 0; y < h; y++) live[y] = emptyRow(p, y * w, w) ? 0 : 1; return live }
// The first and last lit pixels of a row, [w, −1] for an empty one.
function litSpan(p: Float32Array, base: number, w: number): [number, number] {
  let lo = 0, hi = w - 1
  while (lo < w && p[base + lo] === 0) lo++
  if (lo === w) return [w, -1]
  while (p[base + hi] === 0) hi--
  return [lo, hi]
}

// The largest (or smallest) value in a centered run of `size` along each row, black past the ends (van Herk–Gil–Werman). Only a
// row's lit span and `size` around it can change.
function rowFilter(src: Float32Array, w: number, h: number, size: number, largest: boolean) {
  const r = (size - 1) >> 1, p = new Float32Array(w + 2 * r), g = new Float32Array(w + 2 * r), q = new Float32Array(w + 2 * r), out = new Float32Array(w * h)
  for (let y = 0; y < h; y++) {
    const base = y * w, [lo, hi] = litSpan(src, base, w)
    if (hi < 0) continue
    const a = Math.max(0, lo - r), b = Math.min(w - 1, hi + r), L = b - a + 1 + 2 * r
    p.fill(0, 0, L); p.set(src.subarray(base + lo, base + hi + 1), lo - a + r)
    for (let start = 0; start < L; start += size) {
      const end = Math.min(L, start + size)
      let m = g[start] = p[start]
      if (largest) for (let i = start + 1; i < end; i++) { const v = p[i]; if (v > m) m = v; g[i] = m }
      else for (let i = start + 1; i < end; i++) { const v = p[i]; if (v < m) m = v; g[i] = m }
      m = q[end - 1] = p[end - 1]
      if (largest) for (let i = end - 2; i >= start; i--) { const v = p[i]; if (v > m) m = v; q[i] = m }
      else for (let i = end - 2; i >= start; i--) { const v = p[i]; if (v < m) m = v; q[i] = m }
    }
    const o = base + a
    if (largest) for (let x = 0; x <= b - a; x++) { const u = q[x], v = g[x + size - 1]; out[o + x] = u > v ? u : v }
    else for (let x = 0; x <= b - a; x++) { const u = q[x], v = g[x + size - 1]; out[o + x] = u < v ? u : v }
  }
  return out
}

// Area-averaged reduction to `sw`×`sh`, a row pass then a column pass.
function resample(src: Float32Array, w: number, h: number, sw: number, sh: number) {
  const along = (n: number, m: number) => {
    const scale = n / m, from: number[] = [], weights: number[][] = []
    for (let i = 0; i < m; i++) {
      const lo = i * scale, hi = Math.min(n, (i + 1) * scale), j0 = Math.floor(lo), ws: number[] = []
      for (let j = j0; j < Math.min(n, Math.ceil(hi)); j++) ws.push((Math.min(hi, j + 1) - Math.max(lo, j)) / scale)
      from.push(j0); weights.push(ws)
    }
    return { from, weights }
  }
  let rows = src
  if (sw !== w) {
    const { from, weights } = along(w, sw)
    rows = new Float32Array(sw * h)
    for (let y = 0; y < h; y++) {
      const [lo, hi] = litSpan(src, y * w, w)
      if (hi >= 0) for (let i = Math.max(0, Math.floor(lo * sw / w) - 1); i < Math.min(sw, Math.ceil(hi * sw / w) + 2); i++) { let s = 0; const ws = weights[i], b = y * w + from[i]; for (let k = 0; k < ws.length; k++) s += ws[k] * src[b + k]; rows[y * sw + i] = s }
    }
  }
  if (sh === h) return rows
  const { from, weights } = along(h, sh), out = new Float32Array(sw * sh)
  for (let i = 0; i < sh; i++) for (let k = 0; k < weights[i].length; k++) {
    const wt = weights[i][k], b = (from[i] + k) * sw, o = i * sw
    for (let x = 0; x < sw; x++) out[o + x] += wt * rows[b + x]
  }
  return out
}

// A reduced plane stretched back to `w`×`h`, sampled smoothly (bilinear), its edge carried on; added into `into`, times `gain`, when
// it's given.
function enlarge(src: Float32Array, sw: number, sh: number, w: number, h: number, into?: Float32Array, gain = 1) {
  const axis = (n: number, m: number) => {
    const i0 = new Int32Array(n), i1 = new Int32Array(n), f = new Float32Array(n)
    for (let x = 0; x < n; x++) { const u = Math.min(m - 1, Math.max(0, (x + 0.5) * m / n - 0.5)), a = Math.floor(u); i0[x] = a; i1[x] = Math.min(m - 1, a + 1); f[x] = u - a }
    return { i0, i1, f }
  }
  const X = axis(w, sw), Y = axis(h, sh), out = into ?? new Float32Array(w * h), live = liveRows(src, sw, sh), row = new Float32Array(sw)
  for (let y = 0; y < h; y++) {
    const j0 = Y.i0[y], j1 = Y.i1[y], fy = Y.f[y], o = y * w
    if (!live[j0] && !live[j1]) continue
    for (let x = 0; x < sw; x++) row[x] = (src[j0 * sw + x] + (src[j1 * sw + x] - src[j0 * sw + x]) * fy) * gain
    const [lo, hi] = litSpan(row, 0, sw), x1 = Math.min(w, Math.ceil((hi + 2) * w / sw))
    for (let x = Math.max(0, Math.floor((lo - 1) * w / sw)); x < x1; x++) { const a = X.i0[x]; out[o + x] += row[a] + (row[X.i1[x]] - row[a]) * X.f[x] }
  }
  return out
}

function gaussKernel(sigma: number) {
  if (sigma < 0.2) return new Float32Array([1])
  const K = Math.ceil(sigma * 3), g = new Float32Array(K * 2 + 1)
  let sum = 0
  for (let k = -K; k <= K; k++) sum += g[k + K] = Math.exp(-k * k / (2 * sigma * sigma))
  for (let k = 0; k < g.length; k++) g[k] /= sum
  return g
}

function convRows(src: Float32Array, w: number, h: number, sigma: number, clamp: boolean) {
  const g = gaussKernel(sigma), K = (g.length - 1) / 2
  if (!K) return src.slice()
  const out = new Float32Array(w * h), row = new Float32Array(w + 2 * K)
  for (let y = 0; y < h; y++) {
    const base = y * w
    const [lo, hi] = litSpan(src, base, w)
    if (hi < 0) continue
    row.fill(clamp ? src[base] : 0, 0, K); row.set(src.subarray(base, base + w), K); row.fill(clamp ? src[base + w - 1] : 0, K + w)
    const x1 = clamp ? w : Math.min(w, hi + K + 1)
    for (let x = clamp ? 0 : Math.max(0, lo - K); x < x1; x++) { let s = 0; for (let k = 0; k < g.length; k++) s += g[k] * row[x + k]; out[base + x] = s }
  }
  return out
}

function convColumns(src: Float32Array, w: number, h: number, sigma: number, clamp: boolean) {
  const g = gaussKernel(sigma), K = (g.length - 1) / 2
  if (!K) return src
  const out = new Float32Array(w * h), live = liveRows(src, w, h)
  for (let o = 0; o < h; o++) for (let k = -K; k <= K; k++) {
    let j = o + k
    if (j < 0 || j >= h) { if (!clamp) continue; j = j < 0 ? 0 : h - 1 }
    if (!live[j]) continue
    const gk = g[k + K], ib = j * w, ob = o * w
    for (let x = 0; x < w; x++) out[ob + x] += gk * src[ib + x]
  }
  return out
}

// A Gaussian blur of one plane, `sx` pixels across and `sy` down; `clamp` carries the edge pixels on past the edge, otherwise past it
// is black. Along a wide axis it runs on a copy reduced to a few pixels per sigma and stretched back, as Core Image's own blur and
// the Mac's streaks do, so a long streak costs no more than a short one. Added into `into`, times `gain`, when it's given.
function gauss(src: Float32Array, w: number, h: number, sx: number, sy: number, clamp: boolean, into?: Float32Array, gain = 1) {
  const qx = sx < 5 ? 1 : Math.floor(sx / 2.5), qy = sy < 5 ? 1 : Math.floor(sy / 2.5)
  const sw = qx > 1 ? Math.max(1, Math.round(w / qx)) : w, sh = qy > 1 ? Math.max(1, Math.round(h / qy)) : h, reduced = sw !== w || sh !== h
  const blurred = convColumns(convRows(reduced ? resample(src, w, h, sw, sh) : src, sw, sh, sx * sw / w, clamp), sw, sh, sy * sh / h, clamp)
  if (reduced) return enlarge(blurred, sw, sh, w, h, into, gain)
  if (into) addInto(into, blurred, gain)
  return into ?? blurred
}

// LensOptics.streak: blurred `along` pixels along the rows and `across` down them, black past the edges.
const streak = (src: Float32Array, w: number, h: number, along: number, across: number, into?: Float32Array, gain = 1) => { const a = Math.max(0.5, across); return gauss(src, w, h, Math.max(along, a), a, false, into, gain) }

function addInto(into: Float32Array, src: Float32Array, k = 1) { for (let i = 0; i < into.length; i++) into[i] += src[i] * k }

// A large picture's streaks are drawn on a copy reduced until their thinnest line (`thin` pixels) is under two pixels across, so the
// work stays near a 2,000-pixel picture's however large it is; they're stretched back and added to the full-size picture.
function streaked(f: Frame, light: Planes, thin: number, draw: (light: Planes, w: number, h: number, side: number) => Planes): Planes {
  const { w, h, side } = f, k = 1.6 / thin, out = f.lin.map(p => p.slice())
  if (k >= 0.85) { draw(light, w, h, side).forEach((p, c) => addInto(out[c], p)); return out }
  const sw = Math.max(1, Math.round(w * k)), sh = Math.max(1, Math.round(h * k))
  draw(light.map(p => resample(p, w, h, sw, sh)), sw, sh, side * sw / w).forEach((p, c) => enlarge(p, sw, sh, w, h, out[c]))
  return out
}

// Horizontal streaks as an anamorphic lens's cylindrical glass draws them: each light throws a thin line across the frame inside a
// softer band, a white core and a veil, turning blue along its length as the coatings do.
function anamorphic(f: Frame, s: LensSettings): Planes {
  const amount = s.flareAmount / 50, blue = s.flareBlue / 100, lengths = [1 - 0.7 * blue, 1 - 0.4 * blue, 1], coat = [1 - blue * 0.9, 1 - blue * 0.62, 1]
  return streaked(f, sources(f, s.threshold / 100), Math.max(0.5, f.side * 0.0008), (lights, w, h, side) => lights.map((light, c) => {
    const reach = side * s.flareLength / 100, thin = Math.max(0.5, side * 0.0008), src = gauss(light, w, h, side * 0.004, side * 0.004, true), o = new Float32Array(src.length)
    for (let i = 0; i < src.length; i++) src[i] = 1.6 * src[i] * (src[i] + 0.12)
    if (!src.some(v => v > 0)) return o
    // The thin line comes from compact lights only: drawn from a big one it would be as tall as the light.
    const line = streak(compact(src, w, h, side * 0.012), w, h, reach * lengths[c], thin)
    for (let i = 0; i < o.length; i++) o[i] = coat[c] * softClip(4 * amount * line[i], 0.6)
    const band = new Float32Array(src.length)
    for (const [fraction, weight] of [[0.08, 0.8], [0.3, 0.35], [0.9, 0.15]]) {
      const along = reach * fraction * lengths[c]
      streak(src, w, h, along, side * 0.006, band, weight * Math.sqrt(along / (side * 0.08)) * amount)
    }
    for (let i = 0; i < o.length; i++) o[i] += coat[c] * softClip(band[i], 0.7)
    streak(src, w, h, side * 0.015, thin * 3, o, 1.2 * amount)
    return gauss(src, w, h, side * 0.04, side * 0.04, true, o, 0.5 * amount * coat[c])
  }))
}

// `planes` (w×h) sampled into dw×dh: destination pixel (i, j) reads the source at (ax·i + bx·j + cx, ay·i + by·j + cy) in pixel
// indices, smoothly, black outside; only columns [from, to) are read, the rest left black.
function warp(planes: Planes, w: number, h: number, dw: number, dh: number, ax: number, bx: number, cx: number, ay: number, by: number, cy: number, from = 0, to = dw) {
  const out = planes.map(() => new Float32Array(dw * dh)), [p0, p1, p2] = planes, [o0, o1, o2] = out
  // Where a·i + b falls within [−1, n], for each row's run of columns that can read the source.
  const within = (a: number, b: number, n: number): [number, number] => Math.abs(a) < 1e-9 ? (b >= -1 && b <= n ? [-Infinity, Infinity] : [1, 0]) : a > 0 ? [(-1 - b) / a, (n - b) / a] : [(n - b) / a, (-1 - b) / a]
  for (let j = 0; j < dh; j++) {
    const [xa, xb] = within(ax, bx * j + cx, w), [ya, yb] = within(ay, by * j + cy, h)
    for (let i = Math.max(0, from, Math.floor(Math.max(xa, ya)) - 1); i < Math.min(dw, to, Math.ceil(Math.min(xb, yb)) + 2); i++) {
    const X = ax * i + bx * j + cx, Y = ay * i + by * j + cy, x0 = Math.floor(X), y0 = Math.floor(Y)
    if (x0 < -1 || x0 >= w || y0 < -1 || y0 >= h) continue
    const fx = X - x0, fy = Y - y0, o = j * dw + i
    let w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy, i00 = y0 * w + x0, i10 = i00 + 1, i01 = i00 + w, i11 = i01 + 1
    if (x0 < 0 || y0 < 0 || x0 + 1 >= w || y0 + 1 >= h) {
      if (x0 < 0 || y0 < 0) w00 = 0; if (x0 + 1 >= w || y0 < 0) w10 = 0; if (x0 < 0 || y0 + 1 >= h) w01 = 0; if (x0 + 1 >= w || y0 + 1 >= h) w11 = 0
      const xa = Math.max(0, x0), xb = Math.min(w - 1, x0 + 1), ya = Math.max(0, y0) * w, yb = Math.min(h - 1, y0 + 1) * w
      i00 = ya + xa; i10 = ya + xb; i01 = yb + xa; i11 = yb + xb
    }
    o0[o] = w00 * p0[i00] + w10 * p0[i10] + w01 * p0[i01] + w11 * p0[i11]
    o1[o] = w00 * p1[i00] + w10 * p1[i10] + w01 * p1[i01] + w11 * p1[i11]
    o2[o] = w00 * p2[i00] + w10 * p2[i10] + w01 * p2[i01] + w11 * p2[i11]
    }
  }
  return out
}

// Thin spikes from each light, as an aperture's blades diffract it: fading quickly, a little longer in red than in blue. Each
// direction turns the lights once onto a grid along it, only as tall as the lights reach, and turns the spikes back once.
function starburst(f: Frame, s: LensSettings): Planes {
  return streaked(f, sources(f, s.threshold / 100), Math.max(0.5, f.side * 0.0006), (light, w, h, side) => {
    const reach = side * s.starLength / 100, thin = Math.max(0.5, side * 0.0006), rays = [0, 1, 2].map(() => new Float32Array(w * h))
    let x0 = w, x1 = -1, y0 = h, y1 = -1
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = y * w + x; if (light[0][i] > 0 || light[1][i] > 0 || light[2][i] > 0) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; y1 = y } }
    if (x1 < 0) return rays
    const spokes = Math.max(1, Math.floor(s.starPoints / 2)), margin = Math.ceil(3 * thin) + 3, cx = w / 2, cy = h / 2
    for (let spoke = 0; spoke < spokes; spoke++) {
      // Counterclockwise as on the Mac, whose rows run up: u along the spike, v across it, in rows running down.
      const theta = s.starAngle * Math.PI / 180 + spoke * Math.PI / spokes, ux = Math.cos(theta), uy = -Math.sin(theta), vx = -uy, vy = ux
      const along = [[0, 0], [w, 0], [0, h], [w, h]].map(([X, Y]) => (X - cx) * ux + (Y - cy) * uy)
      const corners = [[x0, y0], [x1 + 1, y0], [x0, y1 + 1], [x1 + 1, y1 + 1]], across = corners.map(([X, Y]) => (X - cx) * vx + (Y - cy) * vy), lit = corners.map(([X, Y]) => (X - cx) * ux + (Y - cy) * uy)
      const s0 = Math.floor(Math.min(...along)) - 1, t0 = Math.floor(Math.min(...across)) - margin, gw = Math.ceil(Math.max(...along)) + 1 - s0, gh = Math.ceil(Math.max(...across)) + margin - t0
      const turned = warp(light, w, h, gw, gh, ux, vx, cx + (s0 + 0.5) * ux + (t0 + 0.5) * vx - 0.5, uy, vy, cy + (s0 + 0.5) * uy + (t0 + 0.5) * vy - 0.5, Math.floor(Math.min(...lit)) - s0 - 2, Math.ceil(Math.max(...lit)) - s0 + 2)
      const spikes = [0, 1, 2].map(() => new Float32Array(gw * gh))
      for (const [fraction, weight] of [[0.04, 1.8], [0.12, 0.9], [0.35, 0.35], [1, 0.1]]) {
        // Each light drawn out along the spike first, so a small light spikes as a big one does.
        const width = Math.max(thin * 2, reach * fraction) * 0.8, size = Math.min(301, Math.floor(width) | 1)
        const spread = width >= 3 ? turned.map(p => rowFilter(p, gw, gh, size, true)) : turned, gain = weight * s.starAmount / 50
        for (const [c, stretch] of [[0, 1], [1, 0.9], [2, 0.8]]) streak(spread[c], gw, gh, Math.max(thin * 2, reach * fraction * stretch), thin, spikes[c], gain)
      }
      warp(spikes, gw, gh, w, h, ux, uy, ux * (0.5 - cx) + uy * (0.5 - cy) - s0 - 0.5, vx, vy, vx * (0.5 - cx) + vy * (0.5 - cy) - t0 - 0.5).forEach((p, c) => addInto(rays[c], p))
    }
    return rays
  })
}

// A diffusion filter, as a black mist one: a share of every pixel's light scatters into a near halo and a wide veil rather than
// being added, so bright areas soften and spill and the shadows lift a little. The brightest lights scatter a little extra.
function mist(f: Frame, s: LensSettings): Planes {
  const { w, h, side, lin } = f, scale = side * (0.2 + s.mistSize / 100 * 1.8) / 100, glow = highlights(f, 0.75), strength = s.mistStrength / 100, scatter = strength * 0.4
  return lin.map((p, c) => {
    const near = gauss(p, w, h, scale * 0.6, scale * 0.6, true), far = gauss(p, w, h, scale * 4, scale * 4, true), halo = gauss(glow[c], w, h, scale * 1.5, scale * 1.5, true), out = new Float32Array(p.length)
    for (let i = 0; i < p.length; i++) out[i] = halo[i] * strength * 0.35 + far[i] * scatter * 0.4 + near[i] * scatter * 0.6 + p[i] * (1 - scatter)
    return out
  })
}

// A prism held before the lens: copies of the picture stepped along a line, one way or both, each fainter than the last, with a
// color fringe from the glass. Copies combine as Core Image's Lighten blend does, with their coverage, so a copy shows where it's
// brighter than what's behind it. Blur softens the copies over the area they cover, its edge carried on, as clampedToExtent does.
function prism(f: Frame, s: LensSettings): Planes {
  const { w, h, side, lin } = f, theta = s.prismAngle * Math.PI / 180, dx = Math.cos(theta), dy = -Math.sin(theta), shift = side * s.prismOffset / 100
  const result = lin.map(p => p.slice()), ways = s.prismBothWays ? [1, -1] : [1], fringe = side * s.prismFringe / 10_000
  for (let copy = s.prismCopies; copy >= 1; copy--) {
    const step = shift * copy, layers: { c: number; tx: number; ty: number }[] = []
    for (const way of ways) {
      if (!s.prismFringe) layers.push({ c: -1, tx: dx * step * way, ty: dy * step * way })
      else for (const [c, along] of [[0, step + fringe], [1, step], [2, step - fringe]]) layers.push({ c, tx: dx * along * way, ty: dy * along * way })
    }
    const sigma = s.prismBlur > 0 ? side * s.prismBlur / 10_000 * copy : 0
    let gx0 = 0, gy0 = 0, gw = w, gh = h
    if (sigma) {
      const m = Math.ceil(sigma * 3) + 2, xs = layers.map(l => l.tx), ys = layers.map(l => l.ty)
      gx0 = Math.floor(Math.max(Math.min(...xs), -m)); gy0 = Math.floor(Math.max(Math.min(...ys), -m))
      gw = Math.ceil(Math.min(Math.max(...xs) + w, w + m)) - gx0; gh = Math.ceil(Math.min(Math.max(...ys) + h, h + m)) - gy0
    }
    let ghost: Planes = [0, 1, 2, 3].map(() => new Float32Array(gw * gh))
    for (const layer of layers) lightenCopy(ghost, gx0, gy0, gw, gh, lin, w, h, layer)
    if (sigma) ghost = ghost.map(p => gauss(p, gw, gh, sigma, sigma, true))
    const fade = Math.pow(0.78, copy - 1) * s.prismAmount / 100, [gr, gg, gb, ga] = ghost
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x, g = Math.min(gh - 1, Math.max(0, y - gy0)) * gw + Math.min(gw - 1, Math.max(0, x - gx0)), a = ga[g]
      if (a <= 0) continue
      const r = result[0][i], gn = result[1][i], b = result[2][i]
      result[0][i] = r * (1 - a) + Math.max(r * a, gr[g] * fade); result[1][i] = gn * (1 - a) + Math.max(gn * a, gg[g] * fade); result[2][i] = b * (1 - a) + Math.max(b * a, gb[g] * fade)
    }
  }
  return result
}

// The picture moved by (tx, ty), one channel of it or all (c −1), lightened over `ghost` (premultiplied color and coverage, on a
// grid whose corner sits at (gx0, gy0) in the picture's pixels): Core Image's Lighten, cs(1−ab) + cb(1−as) + max(cs·ab, cb·as).
function lightenCopy(ghost: Planes, gx0: number, gy0: number, gw: number, gh: number, lin: Planes, w: number, h: number, { c, tx, ty }: { c: number; tx: number; ty: number }) {
  const axis = (n: number, origin: number, t: number, size: number) => {
    const shift = origin - t, k = Math.floor(shift), f = shift - k, a = new Int32Array(n), b = new Int32Array(n), wa = new Float32Array(n), wb = new Float32Array(n)
    for (let i = 0; i < n; i++) { const j = i + k; a[i] = Math.min(size - 1, Math.max(0, j)); b[i] = Math.min(size - 1, Math.max(0, j + 1)); wa[i] = j >= 0 && j < size ? 1 - f : 0; wb[i] = j + 1 >= 0 && j + 1 < size ? f : 0 }
    return { a, b, wa, wb }
  }
  const X = axis(gw, gx0, tx, w), Y = axis(gh, gy0, ty, h), alpha = ghost[3]
  for (let gy = 0; gy < gh; gy++) {
    const wya = Y.wa[gy], wyb = Y.wb[gy]
    if (wya + wyb <= 0) continue
    const ra = Y.a[gy] * w, rb = Y.b[gy] * w, o = gy * gw
    for (let k = c < 0 ? 0 : c; k <= (c < 0 ? 2 : c); k++) {
      const p = lin[k], g = ghost[k]
      for (let gx = 0; gx < gw; gx++) {
        const wxa = X.wa[gx], wxb = X.wb[gx], as = (wya + wyb) * (wxa + wxb)
        if (as <= 0) continue
        const xa = X.a[gx], xb = X.b[gx], i = o + gx, ab = alpha[i], cb = g[i], cs = wya * (wxa * p[ra + xa] + wxb * p[ra + xb]) + wyb * (wxa * p[rb + xa] + wxb * p[rb + xb])
        g[i] = cs * (1 - ab) + cb * (1 - as) + Math.max(cs * ab, cb * as)
      }
    }
    for (let gx = 0; gx < gw; gx++) { const as = (wya + wyb) * (X.wa[gx] + X.wb[gx]), i = o + gx; alpha[i] = as + alpha[i] - as * alpha[i] }
  }
}

const smoothstep = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t) }

// MetalBokeh's aperture: how far `(x, y)` (in disc radii) is toward the edge, 1 on it.
function aperture(x: number, y: number, shape: number, ox: number, oy: number) {
  if (shape === 1) { const qx = Math.abs(x), qy = Math.abs(y); return Math.max(qx * 0.866025 + qy * 0.5, qy) / 0.866025 * 0.93 }
  if (shape === 2) return Math.hypot(x, y * 0.62)
  if (shape === 3) return Math.max(Math.hypot(x, y), Math.hypot(x + ox * 1.25, y + oy * 1.25))
  return Math.hypot(x, y)
}

// A disc's weights as MetalBokeh works them out, by row: equal weights in a run (the inside of a disc is all 1) summed from the
// row's running totals, the rest (its rim) one sample at a time.
type Disc = { dy: Int32Array; a: Int32Array; b: Int32Array; weight: Float32Array; run: Uint8Array; total: number; cost: number }
function discTable(radius: number, shape: number, ring: number, ox = 0, oy = 0): Disc {
  const R = Math.max(radius, 0.5), reachX = Math.ceil(R), reachY = Math.ceil(R * (shape === 2 ? 1.62 : 1)), segments: number[][] = [], row = new Float32Array(reachX * 2 + 1)
  let total = 0, cost = 0
  for (let dy = -reachY; dy <= reachY; dy++) {
    for (let dx = -reachX; dx <= reachX; dx++) {
      const d = aperture(dx / R, dy / R, shape, ox, oy), inside = 1 - smoothstep(1 - 1 / R, 1, d)
      row[dx + reachX] = inside <= 0 ? 0 : inside * (1 + ring * 2.5 * smoothstep(0.6, 0.97, d))
    }
    for (let i = 0; i < row.length;) {
      const wt = row[i]
      if (wt <= 0) { i++; continue }
      let j = i
      while (j + 1 < row.length && row[j + 1] === wt) j++
      if (j - i >= 2) { segments.push([dy, i - reachX, j - reachX, wt, 1]); cost += 1.5 }
      else for (let k = i; k <= j; k++) { segments.push([dy, k - reachX, k - reachX, wt, 0]); cost++ }
      total += wt * (j - i + 1); i = j + 1
    }
  }
  const pick = (k: number) => segments.map(s => s[k])
  return { dy: Int32Array.from(pick(0)), a: Int32Array.from(pick(1)), b: Int32Array.from(pick(2)), weight: Float32Array.from(pick(3)), run: Uint8Array.from(pick(4)), total, cost }
}

// MetalBokeh's gather: every pixel the weighted mean of the pixels around it within the aperture, the edge carried on. Cat's Eye's
// discs change shape across the frame, worked out once per 8×8 block.
function discBlur(planes: Planes, w: number, h: number, radius: number, shape: number, ring: number): Planes {
  const R = Math.max(radius, 0.5), reachX = Math.ceil(R), pw = w + reachX * 2, block = 8
  const sources = planes.map(p => {
    const V = new Float32Array(pw * h), P = new Float64Array((pw + 1) * h), lo = new Int32Array(h).fill(pw), hi = new Int32Array(h).fill(-1)
    for (let y = 0; y < h; y++) {
      let sum = 0
      for (let i = 0; i < pw; i++) {
        const v = p[y * w + Math.min(w - 1, Math.max(0, i - reachX))]
        V[y * pw + i] = v; P[y * (pw + 1) + i] = sum; sum += v
        if (v !== 0) { if (lo[y] === pw) lo[y] = i; hi[y] = i }
      }
      P[y * (pw + 1) + pw] = sum
    }
    return { V, P, lo, hi }
  })
  const fixed = shape === 3 ? null : discTable(R, shape, ring), blocks = Math.ceil(w / block), outs = planes.map(() => new Float32Array(w * h))
  let tables: Disc[] = []
  for (let y = 0; y < h; y++) {
    if (!fixed && y % block === 0) tables = Array.from({ length: blocks }, (_, bx) => {
      const mx = ((bx * block + Math.min(w, bx * block + block)) / 2 - w / 2) / (Math.max(w, h) / 2), my = ((y + Math.min(h, y + block)) / 2 - h / 2) / (Math.max(w, h) / 2), k = Math.min(1, Math.hypot(mx, my))
      return discTable(R, 3, ring, mx * k, my * k)
    })
    const o = y * w
    for (let bx = 0; bx < (fixed ? 1 : blocks); bx++) {
      const t = fixed ?? tables[bx], xs = fixed ? 0 : bx * block, xe = fixed ? w : Math.min(w, xs + block)
      planes.forEach((_, c) => {
        const { V, P, lo, hi } = sources[c], out = outs[c]
        for (let s = 0; s < t.dy.length; s++) {
          const j = Math.min(h - 1, Math.max(0, y + t.dy[s]))
          if (hi[j] < 0) continue
          const a = t.a[s], b = t.b[s], wt = t.weight[s], x0 = Math.max(xs, lo[j] - reachX - b), x1 = Math.min(xe - 1, hi[j] - reachX - a)
          if (t.run[s]) { const pb = j * (pw + 1) + reachX; for (let x = x0; x <= x1; x++) out[o + x] += wt * (P[pb + x + b + 1] - P[pb + x + a]) }
          else { const vb = j * pw + reachX + a; for (let x = x0; x <= x1; x++) out[o + x] += wt * V[vb + x] }
        }
        const scale = 1 / Math.max(t.total, 1e-5)
        for (let x = xs; x < xe; x++) out[o + x] *= scale
      })
    }
  }
  return outs
}

// What the gather may cost, in weighted samples: past it, the discs are drawn on a smaller copy and stretched back, as the Mac draws
// any disc wider than 20 pixels.
const bokehBudget = 3e8

// The blur of a lens focused elsewhere: every point spreads into a disc of the aperture's shape. In a real photo a light is far
// brighter than white, so its disc stays bright: the lights are boosted, blurred on their own and eased back.
function bokeh(f: Frame, s: LensSettings): Planes {
  const { w, h, side, lin } = f, radius = side * s.bokehRadius / 100, shape = bokehShapes.indexOf(s.bokehShape), ring = s.bokehRing / 100
  let shrink = Math.min(1, 20 / Math.max(radius, 0.5)), sw = w, sh = h
  for (let tries = 0; tries < 8; tries++) {
    sw = Math.max(1, Math.round(w * shrink)); sh = Math.max(1, Math.round(h * shrink))
    const cost = sw * sh * 6 * discTable(radius * sw / w, shape === 3 ? 0 : shape, ring).cost
    if (cost <= bokehBudget) break
    shrink *= Math.sqrt(bokehBudget / cost) * 0.97
  }
  const reduced = sw !== w || sh !== h, lights = highlights(f, 0.8, 12 + s.bokehBrightness * 0.7)
  const blurred = discBlur([...lin, ...lights].map(p => reduced ? resample(p, w, h, sw, sh) : p), sw, sh, radius * sw / w, shape, ring).map(p => reduced ? enlarge(p, sw, sh, w, h) : p)
  return [0, 1, 2].map(c => { const base = blurred[c], glow = blurred[c + 3]; for (let i = 0; i < base.length; i++) base[i] += softClip(glow[i], 0.8); return base })
}
