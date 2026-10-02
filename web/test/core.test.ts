import { describe, expect, it, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { loadKernels, withBuffers, call, floats } from '../src/kernels'
import { Raster, decodePNG, encodePNG } from '../src/model/raster'
import { readProject, writeProject } from '../src/io/project'
import { channelTables, curveValue, hueSaturationCube, kernelCube } from '../src/model/adjustments'
import { newAdjustment, newLayer, fullTransform, type Doc } from '../src/model/types'
import { wand } from '../src/model/selection'
import { BrushStroke } from '../src/tools/brush'
import { History } from '../src/model/history'
import { pixelToDocument } from '../src/render/compositor'
import { zipPackage, unzipPackage } from '../src/io/files'

beforeAll(async () => { await loadKernels(readFileSync(new URL('../public/kernels.wasm', import.meta.url))) })

function sampleDoc(): Doc {
  const image = Raster.filled(4, 3, 4, [200, 100, 50, 255])
  image.data.set([0, 0, 0, 0], 0)
  image.data.set([64, 32, 16, 128], 4)
  const hsv = newAdjustment('Hue/Saturation')
  hsv.hsvSettings!.adjustments.Reds = { hue: 10, saturation: -20, lightness: 5 }
  const group = newLayer({ name: 'Folder', isGroup: true, transform: fullTransform(8, 6), opacity: 0.5 })
  return {
    id: 'D0C', width: 8, height: 6, resolution: 300, guides: [{ id: 'G1', axis: 'vertical', position: 3 }], extra: { future: 1 },
    layers: [
      group,
      newLayer({ name: 'Pixels', image, parentId: group.id, mask: Raster.filled(1, 1, 1, [255]), transform: { ...fullTransform(4, 3, 1, 1), rotation: 30 }, blendMode: 'Soft Light', text: { content: 'Hi' }, extra: { unknownField: [1, 2] } }),
      newLayer({ name: 'Hue', adjustment: hsv, transform: fullTransform(8, 6) }),
    ],
  }
}

describe('project format', () => {
  it('round-trips layers, masks, adjustments and unknown fields', async () => {
    const doc = sampleDoc()
    const files = writeProject(doc, doc.layers[1].id)
    const manifest = JSON.parse(new TextDecoder().decode(files.get('manifest.json')))
    expect(manifest.version).toBe(11)
    expect(Object.keys(manifest)).toEqual([...Object.keys(manifest)].sort())
    const record = manifest.layers[1]
    expect(record.imageFile).toBe(`${record.id}.png`)
    expect(record.maskFile).toBe(`${record.id}.mask.png`)
    expect(record.parentID).toBe(manifest.layers[0].id)
    expect(record.unknownField).toEqual([1, 2])
    expect(manifest.layers[2].adjustment.hsvSettings.adjustments).toContain('Reds')
    expect(manifest.layers[2].imageFile).toBeUndefined()
    const { doc: back, activeId } = await readProject(unzipPackage(zipPackage('Test', files)))
    expect(activeId).toBe(doc.layers[1].id)
    expect(back.resolution).toBe(300)
    expect(back.extra).toEqual({ future: 1 })
    expect(back.layers[1].transform.rotation).toBe(30)
    expect(back.layers[1].blendMode).toBe('Soft Light')
    expect(back.layers[1].image!.data).toEqual(doc.layers[1].image!.data)
    expect(back.layers[1].mask!.width).toBe(1)
    expect(back.layers[2].adjustment!.hsvSettings!.adjustments.Reds).toEqual({ hue: 10, saturation: -20, lightness: 5 })
  })

  it('rejects a newer format version', async () => {
    const files = writeProject(sampleDoc(), null)
    const manifest = JSON.parse(new TextDecoder().decode(files.get('manifest.json')))
    manifest.version = 12
    files.set('manifest.json', new TextEncoder().encode(JSON.stringify(manifest)))
    await expect(readProject(files)).rejects.toThrow(/version 12/)
  })

  it('keeps PNG pixels exact', () => {
    const raster = new Raster(3, 1, 4, new Uint8Array([255, 0, 0, 255, 10, 20, 30, 40, 0, 0, 0, 0]))
    expect(decodePNG(encodePNG(raster), 4).data).toEqual(raster.data)
  })
})

describe('adjustments', () => {
  it('Levels tables match the C levels_apply path', () => {
    const levels = newAdjustment('Levels')
    levels.levels.ranges[0] = { black: 20, gamma: 1.4, white: 230, outputBlack: 10, outputWhite: 250 }
    const tables = channelTables(levels)!
    const pixels = new Uint8Array([128, 64, 200, 255, 30, 30, 30, 128])
    withBuffers([{ data: pixels, out: true }, floats(tables)], ([p, t]) => call('levels_apply', p, 2, t))
    const expected = Math.round(tables[128] * 255)
    expect(pixels[0]).toBe(expected)
    expect(pixels[7]).toBe(128)
  })

  it('identity curves are identity', () => {
    for (const x of [0, 17, 128, 255]) expect(curveValue([{ x: 0, y: 0 }, { x: 255, y: 255 }], x)).toBeCloseTo(x)
  })

  it('identity Hue/Saturation cube reproduces its lattice', () => {
    const cube = hueSaturationCube(newAdjustment('Hue/Saturation'))
    const index = (5 + 7 * 33 + 30 * 33 * 33) * 4
    expect(cube[index]).toBeCloseTo(5 / 32, 4)
    expect(cube[index + 1]).toBeCloseTo(7 / 32, 4)
    expect(cube[index + 2]).toBeCloseTo(30 / 32, 4)
  })

  it('Black & White cube comes from the C kernel', () => {
    const cube = kernelCube(newAdjustment('Black & White'))!
    const red = 32 * 4
    expect(cube[red]).toBeCloseTo(0.4, 1)
    expect(cube[red]).toBeCloseTo(cube[red + 1], 5)
  })
})

describe('pixel tools', () => {
  it('Magic Wand selects the contiguous region through wasm', () => {
    const image = Raster.filled(4, 4, 4, [255, 255, 255, 255])
    for (const [x, y] of [[0, 0], [1, 0], [0, 1], [3, 3]]) image.data.set([0, 0, 0, 255], (y * 4 + x) * 4)
    const selection = wand(image, 0, 0, 10, true)
    expect([...selection.data].filter(v => v).length).toBe(3)
    expect([...wand(image, 0, 0, 10, false).data].filter(v => v).length).toBe(4)
  })

  it('brush strokes paint, cap at opacity, and undo exactly', () => {
    const raster = new Raster(20, 20, 4)
    const stroke = new BrushStroke(raster, pixelToDocument(fullTransform(20, 20), 20, 20), { diameter: 6, hardness: 1, opacity: 0.5, smoothing: 0, erasing: false }, [255, 0, 0], null)
    stroke.moveTo(5, 10); stroke.lineTo(15, 10); stroke.lineTo(5, 10)
    const patch = stroke.finish()!
    const center = (10 * 20 + 10) * 4
    expect(raster.data[center + 3]).toBe(128)
    expect(raster.data[center]).toBe(128)
    const history = new History<number>()
    history.push({ name: 'Brush', before: 0, after: 1, patches: [patch] })
    history.undo()
    expect(raster.data.every(v => v === 0)).toBe(true)
    history.redo()
    expect(raster.data[center + 3]).toBe(128)
  })
})
