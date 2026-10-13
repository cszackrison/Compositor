import { describe, expect, it, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { encode } from 'fast-png'
import { loadKernels, withBuffers, call, floats } from '../src/kernels'
import { Raster, decodePNG, encodePNG, pngDepth } from '../src/model/raster'
import { readProject, writeProject } from '../src/io/project'
import { channelTables, curveValue, hueSaturationCube, kernelCube } from '../src/model/adjustments'
import { newAdjustment, newLayer, fullTransform, type Doc } from '../src/model/types'
import { wand } from '../src/model/selection'
import { BrushStroke } from '../src/tools/brush'
import { History } from '../src/model/history'
import { pixelToDocument } from '../src/render/compositor'
import { zipPackage, unzipPackage } from '../src/io/files'
import { contentAwareFill, defaultDither, defaultScanlines, dither, scanlines } from '../src/editor/filterKinds'
import { identity } from '../src/render/gl'

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
    expect(manifest.version).toBe(13)
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
    manifest.version = 14
    files.set('manifest.json', new TextEncoder().encode(JSON.stringify(manifest)))
    await expect(readProject(files)).rejects.toThrow(/version 14/)
  })

  // The sample project with its pixel layer's image swapped for `bytes`, named `file`, at format `version`.
  function withLayerImage(bytes: Uint8Array, file: string, version = 13) {
    const files = writeProject(sampleDoc(), null)
    const manifest = JSON.parse(new TextDecoder().decode(files.get('manifest.json')))
    const record = manifest.layers[1]
    files.delete(`images/${record.imageFile}`)
    record.imageFile = `${record.id}.${file}`
    manifest.version = version
    files.set(`images/${record.imageFile}`, bytes)
    files.set('manifest.json', new TextEncoder().encode(JSON.stringify(manifest)))
    return { files, name: `images/${record.imageFile}` }
  }

  it('dithers a 16-bit layer to 8 bits and saves its 16-bit PNG back until it is edited', async () => {
    const wide = new Uint16Array(64 * 4)
    for (let i = 0; i < 64; i++) wide.set([i * 1000 + 300, 40000, 65535 - i * 1000, 65535], i * 4)
    const bytes = encode({ width: 64, height: 1, data: wide, channels: 4, depth: 16 })
    const { files, name } = withLayerImage(bytes, 'png')
    const { doc } = await readProject(files)
    const layer = doc.layers[1]
    expect(layer.wide?.file).toBe('png')
    for (let i = 0; i < 64; i++) expect(Math.abs(layer.image!.data[i * 4] - (i * 1000 + 300) / 257)).toBeLessThan(1.5)
    expect(writeProject(doc, null).get(name)).toBe(bytes)
    layer.image!.touch()
    const edited = writeProject(doc, null).get(name)!
    expect(pngDepth(edited)).toBe(8)
  })

  it('reads an HDR layer from a PIZ OpenEXR top row first, and saves it back as EXR', async () => {
    const bytes = new Uint8Array(readFileSync(new URL('./fixtures/quad-piz.exr', import.meta.url)))
    await expect(readProject(withLayerImage(bytes, 'exr', 12).files)).rejects.toThrow(/version 13/)
    const { files, name } = withLayerImage(bytes, 'exr')
    const { doc } = await readProject(files)
    const expected = [255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]
    ;[...doc.layers[1].image!.data].forEach((v, i) => expect(Math.abs(v - expected[i])).toBeLessThanOrEqual(1))
    expect(doc.layers[1].wide?.file).toBe('exr')
    expect(writeProject(doc, null).get(name)).toBe(bytes)
  })

  it('shows an HDR layer\'s linear light in sRGB, clipped to white', async () => {
    // Linear light, as ImageIO writes EXR: 0.2158 (sRGB mid-gray) and four times white, ZIP-compressed half floats.
    const bytes = new Uint8Array(readFileSync(new URL('./fixtures/linear-zip.exr', import.meta.url)))
    const { doc } = await readProject(withLayerImage(bytes, 'exr').files)
    const expected = [128, 128, 128, 255, 255, 255, 255, 255]
    ;[...doc.layers[1].image!.data].forEach((v, i) => expect(Math.abs(v - expected[i])).toBeLessThanOrEqual(1))
  })

  it('keeps PNG pixels exact', () => {
    const raster = new Raster(3, 1, 4, new Uint8Array([255, 0, 0, 255, 10, 20, 30, 40, 0, 0, 0, 0]))
    expect(decodePNG(encodePNG(raster), 4).data).toEqual(raster.data)
  })
})

describe('filters', () => {
  const input = (pixels: Raster) => ({ pixels, isMask: false, toDocument: identity(), layerId: 'L', transform: fullTransform(pixels.width, pixels.height) })

  it('Content-Aware Fill fills the selection from the stripes around it', () => {
    const pixels = new Raster(48, 48, 4)
    for (let y = 0; y < 48; y++) for (let x = 0; x < 48; x++) pixels.data.set(x % 8 < 4 ? [200, 40, 40, 255] : [40, 40, 200, 255], (y * 48 + x) * 4)
    const selection = { width: 48, height: 48, data: new Uint8Array(48 * 48) }
    for (let y = 18; y < 30; y++) for (let x = 18; x < 30; x++) selection.data[y * 48 + x] = 255
    const before = pixels.data.slice()
    const result = contentAwareFill(input(pixels.clone()), selection, 7)
    const out = (result as { pixels: Raster }).pixels
    expect(out.data.subarray(0, 18 * 48 * 4)).toEqual(before.subarray(0, 18 * 48 * 4))
    for (let y = 18; y < 30; y++) for (let x = 18; x < 30; x++) {
      const i = (y * 48 + x) * 4
      expect(out.data[i + 3]).toBe(255)
      expect(Math.max(out.data[i], out.data[i + 2])).toBeGreaterThan(120)
    }
  })

  it('Scanlines draws lines with dark gaps between them, and Dither still runs', () => {
    const gray = () => Raster.filled(16, 16, 4, [160, 160, 160, 255])
    const lines = scanlines(input(gray()), defaultScanlines) as Raster
    const rows = Array.from({ length: 16 }, (_, y) => lines.data[y * 16 * 4])
    expect(Math.max(...rows)).toBeGreaterThan(200)
    expect(Math.min(...rows)).toBeLessThan(60)
    expect(Array.from({ length: 16 }, (_, y) => lines.data[(y * 16 + 3) * 4 + 3]).every(a => a === 255)).toBe(true)
    const dithered = dither(input(gray()), defaultDither) as Raster
    expect(new Set(dithered.data.filter((_, i) => i % 4 === 0))).toEqual(new Set([0, 255]))
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
