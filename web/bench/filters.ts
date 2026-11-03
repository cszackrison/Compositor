// The slow filters timed at a size (2048 by default), each the best of a few runs, their results kept so a faster version can be checked
// against them: `npx vite-node bench/filters.ts -- [size] [names,…] [--save dir | --compare dir]`.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { loadKernels } from '../src/kernels'
import { Raster } from '../src/model/raster'
import { identity } from '../src/render/gl'
import * as kinds from '../src/editor/filterKinds'
import { defaultLens, type LensSettings } from '../src/editor/lensEffects'
import { defaultRimLight } from '../src/editor/rimLight'
import { defaultVolumetric, volumetricLight } from '../src/editor/volumetricLight'
import type { FilterInput } from '../src/editor/filters'

const args = process.argv.slice(2).filter(a => a !== '--'), flag = (name: string) => { const i = args.indexOf(name); return i < 0 ? null : args.splice(i, 2)[1] }
const save = flag('--save'), compare = flag('--compare'), runs = Number(flag('--runs') ?? 3)
const size = Number(args[0] ?? 2048), only = args[1]?.split(',')
await loadKernels(readFileSync(new URL('../public/kernels.wasm', import.meta.url)))

// A night photo stand-in: gradients, texture, a bright sky band, lamps and a window, a figure's opaque silhouette over transparency.
function scene(n: number, clear = false) {
  const r = new Raster(n, n, 4)
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const i = (y * n + x) * 4, u = x / n, v = y / n, grain = ((x * 73856093 ^ y * 19349663) >>> 0) % 23
    let c = [20 + 60 * u + grain, 25 + 40 * v + grain, 50 + 50 * (1 - v) + grain], a = 255
    if (v < 0.12) c = [235, 235, 240]
    for (const [lx, ly, lr] of [[0.3, 0.5, 0.006], [0.6, 0.55, 0.004], [0.75, 0.3, 0.01], [0.2, 0.8, 0.003]]) if (Math.hypot(u - lx, v - ly) < lr) c = [255, 255, 255]
    if (u > 0.45 && u < 0.52 && v > 0.7 && v < 0.78) c = [255, 230, 160]
    if (clear && Math.hypot(u - 0.5, (v - 0.55) * 0.6) > 0.3) a = 0
    r.data.set([...c.map(k => Math.round(Math.min(255, k) * a / 255)), a], i)
  }
  return r
}
const opaque = scene(size), cutout = scene(size, true)
const input = (pixels: Raster): FilterInput => ({ pixels: pixels.clone(), isMask: false, toDocument: identity(), layerId: 'L', transform: { origin: [0, 0], size: [size, size], rotation: 0, flipX: false, flipY: false, sampling: 'High quality' } })
const out = (o: ReturnType<typeof kinds.sharpen>) => !o ? null : 'pixels' in o ? o.pixels : o
const lens = (s: Partial<LensSettings>) => () => out(kinds.lensEffects(input(opaque), { ...defaultLens, ...s }, size))
const sides = { left: true, right: true, top: true, bottom: true }
const depth = new Float32Array(size * size).map((_, i) => (i / size) / size)

const cases: [string, () => Raster | null][] = [
  ['rgbSplit', () => out(kinds.rgbSplit(input(opaque), 10, 0, 0, false, null, 1000, sides))],
  ['rgbSplitBlur', () => out(kinds.rgbSplit(input(opaque), 10, 20, 30, false, null, 1000, sides))],
  ['rgbSplitRadial', () => out(kinds.rgbSplit(input(opaque), 10, 0, 0, true, null, size / 2, sides))],
  ['rgbSplitFar', () => out(kinds.rgbSplit(input(opaque), 200, 0, 30, false, null, 1000, sides))],
  ['rgbSplitFarBlur', () => out(kinds.rgbSplit(input(opaque), 200, 400, 30, false, null, 1000, sides))],
  ['rgbSplitRadialFarBlur', () => out(kinds.rgbSplit(input(opaque), 200, 400, 0, true, null, size / 2, sides))],
  ['flare', lens({ effect: 'Anamorphic Flare' })], ['star', lens({ effect: 'Starburst' })], ['star14', lens({ effect: 'Starburst', starPoints: 14, starLength: 30 })],
  ['mist', lens({ effect: 'Mist' })], ['prism', lens({ effect: 'Prism' })], ['prismBlur', lens({ effect: 'Prism', prismBlur: 60, prismBothWays: true })],
  ['bokeh', lens({ effect: 'Bokeh' })], ['bokehCat', lens({ effect: 'Bokeh', bokehShape: "Cat's Eye", bokehRadius: 3 })],
  ['rimLight', () => out(kinds.rimLight(input(cutout), defaultRimLight))],
  ['volumetric', () => volumetricLight(opaque.clone(), depth, null, { ...defaultVolumetric, shafts: 50, length: 50 }, [size * 0.7, size * 0.2])],
  ['sharpen', () => out(kinds.sharpen(input(opaque), 100, 3, sides))],
  ['reduceNoise', () => out(kinds.reduceNoise(input(opaque), 50, 50, 50))],
  ['bloom', () => out(kinds.bloom(input(opaque), 50, 40))],
  ['tonalContrast', () => out(kinds.tonalContrast(input(opaque), 50, 20, 20, 20, 20))],
]

let worst = 0
for (const [name, run] of cases) {
  if (only && !only.includes(name)) continue
  let best = Infinity, result: Raster | null = null
  for (let i = 0; i < (name.startsWith('rgbSplitRadialFar') || name === 'star14' ? 1 : runs); i++) { const t = performance.now(); result = run(); best = Math.min(best, performance.now() - t) }
  let note = ''
  const file = (dir: string) => `${dir}/${name}-${size}.bin`
  if (save && result) { mkdirSync(save, { recursive: true }); writeFileSync(file(save), result.data) }
  if (compare && result && existsSync(file(compare))) {
    const ref = readFileSync(file(compare)); let max = 0, sum = 0
    for (let i = 0; i < ref.length; i++) { const d = Math.abs(ref[i] - result.data[i]); sum += d; if (d > max) max = d }
    note = `  max diff ${max}, mean ${(sum / ref.length).toFixed(4)}`; worst = Math.max(worst, max)
  }
  console.log(`${name.padEnd(22)} ${Math.round(best).toString().padStart(6)} ms${note}`)
}
if (compare) console.log('worst max diff', worst)
