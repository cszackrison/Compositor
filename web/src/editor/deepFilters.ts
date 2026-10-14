import { Raster, quantize16 } from '../model/raster'
import { call, heap, withBuffers } from '../kernels'
import { cubeSize, hueSaturationCube, kernelCube } from '../model/adjustments'
import { fromHalf } from '../model/deep'
import { toHalf } from '../io/exr'
import { FloatPixels } from './filterKinds'
import type { FilterInput, FilterOutput } from './filters'
import type { Adjustment } from '../model/types'

// Filters and adjustments on a 16-bit or HDR layer's pixels at their full depth (DeepLayers.swift, FilterEdit.commit). The blurs and
// Bloom run on them as floats; Exposure on an HDR layer works on its light exactly; the color adjustments whose channels mix go
// through their color lookup at 16 bits; every other 8-bit operation runs on 8-bit values a little below each color and one, two and
// four steps up, and the result is read off between them (`deep_split`, `deep_merge`). An HDR layer's highlights are divided down
// to within white for those and multiplied back (`deep_hdr_normalize`).

export type DeepPixels = { pixels: Uint16Array; width: number; height: number; hdr: boolean }
// The grid an 8-bit run of the same filter grew to, and where the layer's pixels sat in it, for a blur to spread into.
export type DeepGrid = { width: number; height: number; x: number; y: number }

// Filters made of blurs, run on floats once rather than through the 8-bit runs.
export const runsAtFullDepth = new Set(['gaussianBlur', 'motionBlur', 'progressiveBlur', 'bloom'])
// Filters whose output channels each depend on all three input channels: each input channel is stepped on its own, ten runs.
export const mixesChannels = new Set(['cameraRaw', 'tonalContrast', 'scanlines'])
// Filters that make a layer 8-bit: Content-Aware Fill makes new pixels; Dither's result is a few levels by design.
export const rasterizes = new Set(['contentAwareFill', 'dither'])

const stride = (width: number) => width * 8

export function placed(source: DeepPixels, grid: DeepGrid | null): DeepPixels {
  if (!grid || (grid.width === source.width && grid.height === source.height && !grid.x && !grid.y)) return source
  const out = new Uint16Array(grid.width * grid.height * 4), row = source.width * 4
  for (let y = 0; y < source.height; y++) out.set(source.pixels.subarray(y * row, (y + 1) * row), ((y + grid.y) * grid.width + grid.x) * 4)
  return { ...source, pixels: out, width: grid.width, height: grid.height }
}

// A filter's result put back on the grid it was given: cut from a grid it grew to (`origin` its corner in the given one's pixels).
function onGrid<T extends { width: number; height: number; data: ArrayLike<number> & { subarray(a: number, b: number): ArrayLike<number> } }>(out: FilterOutput | T, given: T, make: (w: number, h: number) => T & { data: { set(values: ArrayLike<number>, offset: number): void } }): T {
  if (!out) return given
  const result = ('pixels' in out ? out.pixels : out) as unknown as T, origin = 'pixels' in out ? out.origin : [0, 0]
  if (result.width === given.width && result.height === given.height && !origin[0] && !origin[1]) return result
  const made = make(given.width, given.height), row = given.width * 4
  for (let y = 0; y < given.height; y++) {
    const sy = y - origin[1], sx = -origin[0]
    if (sy < 0 || sy >= result.height) continue
    made.data.set(result.data.subarray((sy * result.width + sx) * 4, (sy * result.width + sx) * 4 + row), y * row)
  }
  return made
}

// The 16-bit or HDR result of `run` (an 8-bit filter, given 8-bit pixels) on `deep`, on `grid` when the filter spreads past the layer.
// `single`: one 8-bit run rather than several read between, for previews (the Mac's previewHDR), too fine to see and too slow for every
// slider move.
export function runDeep(name: string, run: (input: FilterInput) => FilterOutput, input: Omit<FilterInput, 'pixels'>, deep: DeepPixels, grid: DeepGrid | null, adjustment?: Adjustment, single = false): DeepPixels {
  const source = placed(deep, grid), { width, height, hdr } = source
  if (adjustment && hdr && adjustment.kind === 'Exposure') return { ...source, pixels: exposure(source, adjustment) }
  const cube = adjustment ? adjustment.kind === 'Hue/Saturation' ? hueSaturationCube(adjustment) : kernelCube(adjustment) : null
  if (cube) return { ...source, pixels: normalizing(source, sixteen => lookup(sixteen, width, height, cube)) }
  if (runsAtFullDepth.has(name)) {
    const floatsIn = new FloatPixels(width, height), data = floatsIn.data
    for (let i = 0; i < data.length; i++) data[i] = hdr ? fromHalf(source.pixels[i]) * 255 : source.pixels[i] / 257
    const result = onGrid(run({ ...input, pixels: floatsIn as unknown as Raster }) as unknown as FloatPixels, floatsIn, (w, h) => new FloatPixels(w, h)).data
    const out = new Uint16Array(result.length)
    for (let i = 0; i < out.length; i += 4) {
      const a = Math.min(255, Math.max(0, result[i + 3]))
      out[i + 3] = hdr ? toHalf(a / 255) : Math.round(a * 257)
      for (let c = 0; c < 3; c++) { const v = Math.max(0, result[i + c]); out[i + c] = hdr ? toHalf(v / 255) : Math.round(Math.min(a, v) * 257) }
    }
    return { ...source, pixels: out }
  }
  const operation = (pixels: Raster) => onGrid(run({ ...input, pixels }), pixels, (w, h) => new Raster(w, h, 4))
  if (single) return { ...source, pixels: normalizing(source, sixteen => { const once = operation(quantize16(sixteen, width, height)), out = new Uint16Array(once.data.length); for (let i = 0; i < out.length; i++) out[i] = once.data[i] * 257; return out }) }
  return { ...source, pixels: normalizing(source, sixteen => split(sixteen, width, height, mixesChannels.has(name), operation)) }
}

// `runDeep`'s 8-bit runs one at a time, so several workers can share them (`deepRun`, then `deepMerge` on all their results, which
// can go a band of rows at a time). Only filters go this way; adjustments mostly take a color lookup instead.
export const deepRunCount = (name: string, adjustment?: Adjustment) => adjustment || runsAtFullDepth.has(name) || rasterizes.has(name) ? 0 : splitSteps(mixesChannels.has(name)).length

export function deepRun(name: string, run: (input: FilterInput) => FilterOutput, input: Omit<FilterInput, 'pixels'>, deep: DeepPixels, grid: DeepGrid | null, index: number): Raster {
  const source = placed(deep, grid), pixels = splitAt(normalized(source).sixteen, source.width, source.height, splitSteps(mixesChannels.has(name))[index])
  return onGrid(run({ ...input, pixels }), pixels, (w, h) => new Raster(w, h, 4))
}

// `firstRow`: where a band of rows starts in the whole picture.
export function deepMerge(name: string, deep: DeepPixels, grid: DeepGrid | null, runs: Raster[], firstRow = 0): DeepPixels {
  const source = placed(deep, grid), { sixteen, restore } = normalized(source)
  return { ...source, pixels: restore(merged(sixteen, source.width, source.height, mixesChannels.has(name), runs, firstRow)) }
}

// `body` on 16-bit pixels: an HDR layer's with each highlight divided down to within white, its result multiplied back.
export function normalizing(source: DeepPixels, body: (sixteen: Uint16Array) => Uint16Array): Uint16Array {
  const { sixteen, restore } = normalized(source)
  return restore(body(sixteen))
}

function normalized(source: DeepPixels): { sixteen: Uint16Array; restore: (result: Uint16Array) => Uint16Array } {
  if (!source.hdr) return { sixteen: source.pixels, restore: result => result }
  const { width, height } = source, normal = new Uint16Array(source.pixels.length), scales = new Float32Array(width * height)
  withBuffers([{ data: source.pixels }, { data: normal, out: true }, { data: scales, out: true }], ([h, n, s]) => call('deep_hdr_normalize', h, stride(width), n, stride(width), s, width, height))
  return { sixteen: normal, restore: result => {
    const out = new Uint16Array(result.length)
    withBuffers([{ data: result }, { data: scales }, { data: out, out: true }], ([n, s, h]) => call('deep_hdr_restore', n, stride(width), s, h, stride(width), width, height))
    return out
  } }
}

function lookup(pixels: Uint16Array, width: number, height: number, cube: Float32Array) {
  const out = pixels.slice()
  withBuffers([{ data: out, out: true }, { data: cube }], ([p, c]) => call('deep_cube_apply', p, stride(width), width, height, c, cubeSize))
  return out
}

// Exposure on HDR pixels exactly, nothing clipped at white (`deep_hdr_exposure`).
function exposure(source: DeepPixels, adjustment: Adjustment) {
  const s = adjustment.exposureSettings ?? { exposure: 0, offset: 0, gamma: 1 }, out = source.pixels.slice()
  withBuffers([{ data: out, out: true }], ([p]) => call('deep_hdr_exposure', p, stride(source.width), source.width, source.height, Math.pow(2, s.exposure), s.offset, 1 / Math.max(0.01, s.gamma)))
  return out
}

// An 8-bit operation on 16-bit pixels without losing their precision (`DeepLayer.run`).
function split(pixels: Uint16Array, width: number, height: number, mixes: boolean, operation: (pixels: Raster) => Raster): Uint16Array {
  return merged(pixels, width, height, mixes, splitSteps(mixes).map(step => operation(splitAt(pixels, width, height, step))))
}

// The 8-bit runs' steps up, and the channel each steps (-1 for all three).
const splitSteps = (mixes: boolean) => [[0, -1], ...[1, 2, 4].flatMap(step => (mixes ? [0, 1, 2] : [-1]).map(channel => [step, channel]))]

function splitAt(pixels: Uint16Array, width: number, height: number, [step, channel]: number[]) {
  const low = new Raster(width, height, 4)
  withBuffers([{ data: pixels }, { data: low.data, out: true }], ([d, o]) => call('deep_split', d, stride(width), o, width * 4, width, height, step, channel))
  return low
}

function merged(pixels: Uint16Array, width: number, height: number, mixes: boolean, runs: Raster[], firstRow = 0): Uint16Array {
  const out = new Uint16Array(pixels.length), per = mixes ? 3 : 1
  const triple = (index: number) => [0, 1, 2].map(c => runs[1 + index * per + (mixes ? c : 0)])
  const buffers = [runs[0], ...triple(0), ...triple(1), ...triple(2)]
  return withBuffers([{ data: pixels }, ...buffers.map(r => ({ data: r.data })), { data: out, out: true }, { data: new Uint32Array(9) }], (pointers) => {
    const [d, low, ...rest] = pointers, results = rest.slice(0, 9), o = rest[9], table = rest[10]
    new Uint32Array(heap().buffer, table, 9).set(results)
    call('deep_merge_rows', d, stride(width), low, table, table + 12, table + 24, width * 4, o, stride(width), width, height, mixes ? 1 : 0, firstRow)
    return out
  })
}
