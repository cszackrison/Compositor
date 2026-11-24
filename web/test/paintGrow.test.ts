import { beforeAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { loadKernels } from '../src/kernels'
import { store } from '../src/editor/store'
import { growToCanvas } from '../src/tools/paint'
import { Raster } from '../src/model/raster'
import { deepOf, makeDeep } from '../src/model/deep'
import { fullTransform, newLayer, type Layer } from '../src/model/types'

// A 400 px layer shown at 40 px on a 1200 px canvas: grown at its own resolution it would be 144 megapixels, past the budget.
function open(layer: Layer) {
  store.open({ id: 'D', width: 1200, height: 1200, resolution: 72, layers: [layer], guides: [], extra: {} }, layer.id, null)
  return layer.id
}
const scaledDown = { ...fullTransform(40, 40), origin: [100, 100] as [number, number] }

beforeAll(async () => { await loadKernels(readFileSync(new URL('../public/kernels.wasm', import.meta.url))) })

describe('painting past a scaled-down layer', () => {
  it('resamples an 8-bit layer to its displayed size, averaging what each pixel covers', () => {
    const image = new Raster(400, 400, 4)
    for (let y = 0; y < 400; y++) for (let x = 0; x < 400; x++) image.data.set((x + y) % 2 ? [255, 255, 255, 255] : [0, 0, 0, 255], (y * 400 + x) * 4)
    const id = open(newLayer({ name: 'A', image, transform: scaledDown }))
    const kept = growToCanvas(id)!
    expect(kept).toMatchObject({ w: 40, h: 40 })
    const grown = store.layer(id)!.image!
    expect([grown.width, grown.height]).toEqual([1200, 1200])
    const p = ((kept.y + 20) * grown.width + kept.x + 20) * 4
    expect(grown.data[p]).toBeGreaterThan(100)
    expect(grown.data[p]).toBeLessThan(155)
  })

  it('leaves a 16-bit layer at its resolution and depth', () => {
    const pixels = new Uint16Array(400 * 400 * 4)
    for (let i = 0; i < pixels.length; i += 4) pixels.set([30000, 40000, 50000, 65535], i)
    const made = makeDeep(pixels, 400, 400, false)
    const id = open(newLayer({ name: 'A', image: made.image, deep: made.deep, transform: scaledDown }))
    expect(growToCanvas(id)).toBeNull()
    const layer = store.layer(id)!
    expect(layer.image!.width).toBe(400)
    expect(deepOf(layer)?.pixels[1]).toBe(40000)
  })

  it('leaves a scaled-down layer untouched if even its displayed size would exceed the growth budget', () => {
    const image = new Raster(400, 400, 4)
    const layer = newLayer({ name: 'A', image, transform: scaledDown })
    store.open({ id: 'D', width: 12000, height: 12000, resolution: 72, layers: [layer], guides: [], extra: {} }, layer.id, null)
    expect(growToCanvas(layer.id)).toBeNull()
    expect(store.layer(layer.id)!.image).toBe(image)
  })
})
