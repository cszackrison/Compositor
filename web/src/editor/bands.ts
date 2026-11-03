import { Raster } from '../model/raster'
import { blurReach } from '../model/pixels'
import { chain, translate } from '../render/gl'
import type { FilterInput, FilterOutput } from './filters'
import * as kinds from './filterKinds'

// Filters that can be worked a band of rows at a time, each band on a core of its own: every pixel depends only on the rows within
// `reach` of it, so a band read with that many rows more above and below comes out as the same rows of the whole. Reduce Noise
// measures the whole picture's noise first (`prepared`), which every band then smooths by.
// `reach` is for the band keeping rows `y0` to `y1`.
type Banded = { reach: (input: FilterInput, args: unknown[], y0: number, y1: number) => number | null; prepared?: (input: FilterInput, args: unknown[]) => unknown[] }
const banded: Partial<Record<keyof typeof kinds, Banded>> = {
  sharpen: { reach: (_, [, radius]) => Math.ceil(blurReach(radius as number)) + 1 },
  tonalContrast: { reach: (_, [, , , , radius]) => Math.ceil(blurReach(radius as number)) + 1 },
  reduceNoise: {
    // The search window and patch (at most 7 and 2), then Color's blur and the color edges it looks for, each up to 64 across.
    reach: (_, [, , color, scale = 1]) => 7 + 2 + 2 * Math.min(64, Math.max(1, Math.round((1.5 + (color as number) / 100 * 4 * 1) * ((scale as number) > 0 ? scale as number : 1)))) + 2,
    prepared: (input, args) => (args[0] as number) > 0 ? [...args.slice(0, 4), args[3] ?? 1, kinds.noiseSigma(input.pixels)] : args,
  },
  // Up and down only: the spectrum reaches the split's distance along it (Radial's grows with the distance from its center, the same
  // along a row), and the streaks it reads half the blur further, from where it lands.
  rgbSplit: {
    reach: (input, [distance, blur, angle, radial, center, reach], y0, y1) => {
      const s = kinds.rgbSplitSettings(input, distance as number, blur as number, angle as number, radial as boolean, center as [number, number] | null, reach as number)
      if (!s.radial) { const up = Math.abs(Math.sin(s.angle * Math.PI / 180)); return Math.ceil((s.distance + s.blur / 2) * up) + 3 }
      const r = Math.max(s.reach, 1), far = Math.max(Math.abs(y0 - s.center[1]), Math.abs(y1 - s.center[1])), spectrum = far * s.distance / r
      return Math.ceil(spectrum + (far + spectrum) * s.blur / 2 / r) + 3
    },
  },
}

// The rows each band keeps (`y0` to `y1`) and reads (`top` to `bottom`), or null when the picture is too small to be worth it, the
// filter can't be banded, or its reach would leave too little for each band to keep.
export function bandPlan(name: keyof typeof kinds, input: FilterInput, args: unknown[], lanes: number) {
  const spec = banded[name], { width, height } = input.pixels
  if (!spec || lanes < 2 || input.band || width * height < 512 * 512) return null
  const count = Math.min(lanes, Math.floor(height / 64))
  if (count < 2) return null
  const bands = []
  for (let i = 0; i < count; i++) {
    const y0 = Math.floor(height * i / count), y1 = Math.floor(height * (i + 1) / count), reach = spec.reach(input, args, y0, y1)
    if (reach === null || !Number.isFinite(reach)) return null
    bands.push({ y0, y1, top: Math.max(0, y0 - reach), bottom: Math.min(height, y1 + reach) })
  }
  // Bands that would read nearly the whole picture each gain little for the copies they cost.
  if (bands.reduce((sum, b) => sum + b.bottom - b.top, 0) > height * count * 0.7) return null
  return { args: spec.prepared?.(input, args) ?? args, bands }
}
export type BandPlan = NonNullable<ReturnType<typeof bandPlan>>

// A band's own input: its rows, placed in the document as they were and told where they sit in the whole.
export function bandInput(input: FilterInput, band: BandPlan['bands'][number]): FilterInput {
  const { width, height, channels } = input.pixels, rows = band.bottom - band.top
  const pixels = new Raster(width, rows, channels, input.pixels.data.slice(band.top * width * channels, band.bottom * width * channels))
  return { ...input, pixels, toDocument: chain(input.toDocument, translate(0, band.top)), band: { offset: [0, band.top], size: [width, height] } }
}

// The bands' results put together, each giving the rows it keeps; null when a band changed nothing, as the filter would.
export function stitched(input: FilterInput, plan: BandPlan, results: FilterOutput[]): Raster | null {
  if (results.every(r => !r)) return null
  const { width, height, channels } = input.pixels, out = new Raster(width, height, channels), row = width * channels
  plan.bands.forEach((band, i) => {
    const r = results[i], from = r ? kinds.onGrid(r, new Raster(width, band.bottom - band.top, channels, input.pixels.data.subarray(band.top * row, band.bottom * row))) : null
    out.data.set(from ? from.data.subarray((band.y0 - band.top) * row, (band.y1 - band.top) * row) : input.pixels.data.subarray(band.y0 * row, band.y1 * row), band.y0 * row)
  })
  return out
}

// Every band one after another, here: what the workers do side by side, for tests.
export function runInBands(name: keyof typeof kinds, input: FilterInput, args: unknown[], lanes: number): FilterOutput | undefined {
  const plan = bandPlan(name, input, args, lanes)
  if (!plan) return undefined
  const run = kinds[name] as unknown as (input: FilterInput, ...args: unknown[]) => FilterOutput
  return stitched(input, plan, plan.bands.map(band => run(bandInput(input, band), ...plan.args)))
}
