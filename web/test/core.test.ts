import { describe, expect, it, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { decode, encode } from 'fast-png'
import { loadKernels, withBuffers, call, floats } from '../src/kernels'
import { Raster, decodeHDR, decodeLayerFile, decodePNG, encodePNG, pngDepth, readEXR, resizeLinear, decodeTIFF } from '../src/model/raster'
import { encodeEXR, toHalf } from '../src/io/exr'
import { readProject, writeProject } from '../src/io/project'
import { channelTables, curveValue, hueSaturationCube, kernelCube } from '../src/model/adjustments'
import { newAdjustment, newLayer, fullTransform, type Doc } from '../src/model/types'
import { wand } from '../src/model/selection'
import { BrushStroke } from '../src/tools/brush'
import { History } from '../src/model/history'
import { pixelToDocument } from '../src/render/compositor'
import { zipPackage, unzipPackage } from '../src/io/files'
import { contentAwareFill, defaultDither, defaultScanlines, dither, gaussianBlur, noSides, progressiveBlur, scanlines } from '../src/editor/filterKinds'
import { identity } from '../src/render/gl'
import { rectanglePath } from '../src/tools/shape'

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
    expect(manifest.version).toBe(14)
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
    manifest.version = 15
    files.set('manifest.json', new TextEncoder().encode(JSON.stringify(manifest)))
    await expect(readProject(files)).rejects.toThrow(/version 15/)
  })

  it('keeps a shape\'s smooth corners, which need format version 14', async () => {
    const doc = sampleDoc(), style = { kind: 'Rectangle', red: 1, green: 0, blue: 0, cornerRadius: 1, smoothing: true }
    doc.layers[1] = { ...doc.layers[1], shape: style }
    const files = writeProject(doc, null)
    expect((await readProject(files)).doc.layers[1].shape).toEqual(style)
    const manifest = JSON.parse(new TextDecoder().decode(files.get('manifest.json')))
    manifest.version = 13
    files.set('manifest.json', new TextEncoder().encode(JSON.stringify(manifest)))
    await expect(readProject(files)).rejects.toThrow(/smooth corners, which need format version 14/)
  })

  it('rejects folders inside themselves', async () => {
    const files = writeProject(sampleDoc(), null)
    const manifest = JSON.parse(new TextDecoder().decode(files.get('manifest.json')))
    const records = manifest.layers as { id: string; isGroup?: boolean; parentID?: string }[]
    records[0].isGroup = true; records[1].isGroup = true
    records[0].parentID = records[1].id; records[1].parentID = records[0].id
    files.set('manifest.json', new TextEncoder().encode(JSON.stringify(manifest)))
    await expect(readProject(files)).rejects.toThrow(/inside itself/)
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

  it('keeps a 16-bit layer at 16 bits, its file saved back until it is painted, paint taken at 8 bits', async () => {
    const wide = new Uint16Array(64 * 4)
    for (let i = 0; i < 64; i++) wide.set([i * 1000 + 300, 40000, 65535 - i * 1000, 65535], i * 4)
    const bytes = encode({ width: 64, height: 1, data: wide, channels: 4, depth: 16 })
    const { files, name } = withLayerImage(bytes, 'png')
    const { doc } = await readProject(files)
    const layer = doc.layers[1]
    expect([layer.deep?.hdr, layer.deep?.file?.kind]).toEqual([false, 'png'])
    for (let i = 0; i < 64; i++) expect(Math.abs(layer.image!.data[i * 4] - (i * 1000 + 300) / 257)).toBeLessThan(1.5)
    expect(writeProject(doc, null).get(name)).toBe(bytes)
    layer.image!.write(3, 0, 1, 1, new Uint8Array([10, 20, 30, 255]))
    const painted = decode(writeProject(doc, null).get(name)!)
    expect(painted.depth).toBe(16)
    expect([...painted.data.subarray(12, 16)]).toEqual([2570, 5140, 7710, 65535])
    expect([...painted.data.subarray(16, 20)]).toEqual([4300, 40000, 61535, 65535])
    const replaced = { ...layer, image: layer.image!.clone() }
    expect(pngDepth(writeProject({ ...doc, layers: [doc.layers[0], replaced, ...doc.layers.slice(2)] }, null).get(name)!)).toBe(8)
  })

  it('reads an OpenEXR within white as a 16-bit layer, top row first', async () => {
    const bytes = new Uint8Array(readFileSync(new URL('./fixtures/quad-piz.exr', import.meta.url)))
    await expect(readProject(withLayerImage(bytes, 'exr', 12).files)).rejects.toThrow(/version 13/)
    const { doc } = await readProject(withLayerImage(bytes, 'exr').files)
    const expected = [255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]
    ;[...doc.layers[1].image!.data].forEach((v, i) => expect(Math.abs(v - expected[i])).toBeLessThanOrEqual(1))
    expect(doc.layers[1].deep?.hdr).toBe(false)
    expect(pngDepth(writeProject(doc, null).get(`images/${doc.layers[1].id}.png`)!)).toBe(16)
  })

  it('shows an HDR layer\'s linear light in sRGB, clipped to white, and saves its OpenEXR back', async () => {
    // Linear light, as ImageIO writes EXR: 0.2158 (sRGB mid-gray) and four times white, ZIP-compressed half floats.
    const bytes = new Uint8Array(readFileSync(new URL('./fixtures/linear-zip.exr', import.meta.url)))
    const { files, name } = withLayerImage(bytes, 'exr')
    const { doc } = await readProject(files)
    const expected = [128, 128, 128, 255, 255, 255, 255, 255]
    ;[...doc.layers[1].image!.data].forEach((v, i) => expect(Math.abs(v - expected[i])).toBeLessThanOrEqual(1))
    expect(doc.layers[1].deep?.hdr).toBe(true)
    expect(writeProject(doc, null).get(name)).toBe(bytes)
    doc.layers[1].image!.write(0, 0, 1, 1, new Uint8Array([255, 0, 0, 255]))
    const read = await readEXR(writeProject(doc, null).get(name)!)
    expect([...read.data].map(v => Math.round(v * 100) / 100)).toEqual([1, 0, 0, 1, 4, 4, 4, 1])
  })

  it('imports Radiance HDR top row first, and 16-bit PNGs and HDR images at their full depth', async () => {
    const hdr = await decodeHDR(new Uint8Array(readFileSync(new URL('./fixtures/quad.hdr', import.meta.url))))
    const expected = [255, 0, 0, 255, 255, 0, 0, 255, 0, 255, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 0, 0, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255]
    expect([hdr.width, hdr.height]).toEqual([4, 2])
    ;[...hdr.data].forEach((v, i) => expect(Math.abs(v - expected[i])).toBeLessThanOrEqual(1))
    const radiance = await decodeLayerFile(new File([readFileSync(new URL('./fixtures/quad.hdr', import.meta.url))], 'Sky.hdr'))
    expect([radiance.deep?.width, radiance.deep?.hdr]).toEqual([4, true])
    const placed = await decodeLayerFile(new File([readFileSync(new URL('./fixtures/linear-zip.exr', import.meta.url))], 'Render.exr'))
    expect([placed.deep?.hdr, placed.deep?.raster]).toEqual([true, placed.image])
    const png = await decodeLayerFile(new File([encodePNG(Raster.filled(2, 2, 4, [1, 2, 3, 255])) as Uint8Array<ArrayBuffer>], 'Flat.png', { type: 'image/png' }))
    expect(png.deep).toBeUndefined()
  })

  it('writes OpenEXR that reads back, highlights and transparency kept', async () => {
    expect([toHalf(1), toHalf(-2), toHalf(65504), toHalf(1e6), toHalf(2 ** -24), toHalf(0.1)]).toEqual([0x3c00, 0xc000, 0x7bff, 0x7c00, 1, 0x2e66])
    const width = 37, height = 21, data = new Float32Array(width * height * 4)
    for (let i = 0; i < width * height; i++) { const a = (i % 5) / 4; data.set([(i % 7) * 1.5 * a, (i % 3) * 0.2158 * a, 16 * a, a], i * 4) }
    const read = await readEXR(encodeEXR(data, width, height))
    expect([read.width, read.height]).toEqual([width, height])
    read.data.forEach((v, i) => expect(Math.abs(v - data[i])).toBeLessThanOrEqual(Math.abs(data[i]) / 1024 + 1e-6))
  })

  it('resizes floats, averaging down and interpolating up, past white', () => {
    const image = { width: 4, height: 2, data: new Float32Array([0, 0, 0, 1, 8, 8, 8, 1, 2, 2, 2, 1, 4, 4, 4, 1, 0, 0, 0, 1, 8, 8, 8, 1, 2, 2, 2, 1, 4, 4, 4, 1]) }
    resizeLinear(image, 2, 1).data.forEach((v, i) => expect(v).toBeCloseTo(i % 4 === 3 ? 1 : 6.5 / 1.75, 5))
    const up = resizeLinear({ width: 2, height: 1, data: new Float32Array([0, 0, 0, 0, 4, 4, 4, 1]) }, 4, 1).data
    expect([up[0], up[4], up[8], up[12]]).toEqual([0, 1, 3, 4])
  })

  it('reads TIFF where the browser can\'t: LZW with transparency, 16 bits and CMYK', async () => {
    const tiff = async (name: string) => [...(await decodeTIFF(new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url))))).data]
    expect((await tiff('quad-lzw.tif')).slice(0, 8)).toEqual([255, 0, 0, 255, 0, 128, 0, 128])
    expect((await tiff('quad-lzw.tif')).slice(28)).toEqual([0, 0, 255, 255])
    expect((await tiff('quad16.tif')).slice(0, 4)).toEqual([255, 128, 0, 255])
    ;(await tiff('quad-cmyk.tif')).slice(0, 4).forEach((v, i) => expect(Math.abs(v - [255, 128, 0, 255][i])).toBeLessThanOrEqual(2))
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

  it('Gaussian Blur keeps solid edges at the canvas, and Preserve Transparency keeps the outline and its color', () => {
    const solid = () => Raster.filled(10, 10, 4, [90, 90, 90, 255])
    const filled = gaussianBlur(input(solid()), 3, false, { left: true, right: true, top: true, bottom: true }) as { pixels: Raster; origin: [number, number] }
    expect([filled.pixels.width, filled.pixels.height, ...filled.origin]).toEqual([10, 10, 0, 0])
    expect(filled.pixels.data.every((v, i) => v === (i % 4 === 3 ? 255 : 90))).toBe(true)
    const faded = gaussianBlur(input(solid()), 3, false, noSides) as { pixels: Raster; origin: [number, number] }
    expect(faded.pixels.width).toBeGreaterThan(10)
    expect(faded.pixels.data[faded.pixels.data.length - 1]).toBeLessThan(255)
    const cutout = new Raster(12, 12, 4)
    for (let y = 3; y < 9; y++) for (let x = 3; x < 9; x++) cutout.data.set([200, 0, 0, 255], (y * 12 + x) * 4)
    cutout.data.set([100, 0, 0, 128], (3 * 12 + 2) * 4)
    const kept = gaussianBlur(input(cutout.clone()), 2, true) as Raster
    for (let i = 0; i < kept.data.length; i += 4) {
      expect(kept.data[i + 3]).toBe(cutout.data[i + 3])
      expect(Math.abs(kept.data[i] - Math.round(cutout.data[i + 3] * 200 / 255))).toBeLessThanOrEqual(1)
    }
  })

  it('Progressive Blur is sharp where its line starts and blurred at its end, along it or out from the start', () => {
    const stripes = () => { const r = new Raster(40, 40, 4); for (let y = 0; y < 40; y++) for (let x = 0; x < 40; x++) r.data.set(x % 4 < 2 ? [255, 255, 255, 255] : [0, 0, 0, 255], (y * 40 + x) * 4); return r }
    const all = { left: true, right: true, top: true, bottom: true }
    const at = (out: Raster, x: number, y: number) => out.data[(y * out.width + x) * 4]
    const linear = progressiveBlur(input(stripes()), 0, 6, [20, 0], [20, 40], false, false, all) as { pixels: Raster; origin: [number, number] }
    expect([linear.pixels.width, linear.pixels.height]).toEqual([40, 40])
    expect(at(linear.pixels, 0, 0)).toBeGreaterThan(240); expect(at(linear.pixels, 2, 0)).toBeLessThan(15)
    expect(Math.abs(at(linear.pixels, 0, 39) - at(linear.pixels, 2, 39))).toBeLessThan(20)
    const radial = progressiveBlur(input(stripes()), 0, 6, [20, 20], [20, 30], true, false, all) as { pixels: Raster }
    const contrast = (x: number, y: number) => Math.abs(at(radial.pixels, x, y) - at(radial.pixels, x + 2, y))
    expect(contrast(20, 20)).toBeGreaterThan(60)
    expect(contrast(0, 0)).toBeLessThan(20)
    const inverted = progressiveBlur(input(stripes()), 0, 6, [20, 0], [20, 40], false, true, all) as { pixels: Raster }
    expect(at(inverted.pixels, 0, 39)).toBeGreaterThan(240); expect(at(inverted.pixels, 2, 39)).toBeLessThan(15)
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

describe('shape corners', () => {
  // The calls a path receives, with every point it passes through.
  function trace(width: number, height: number, radius: number, smooth: boolean) {
    const calls: string[] = [], points: [number, number][] = []
    const record = (name: string) => (...args: number[]) => { calls.push(name); for (let i = 0; i + 1 < args.length && name !== 'arc'; i += 2) points.push([args[i], args[i + 1]]); if (name === 'arc') points.push([args[0], args[1]]) }
    const path = { moveTo: record('moveTo'), lineTo: record('lineTo'), bezierCurveTo: record('bezierCurveTo'), arc: record('arc'), closePath: record('closePath'), rect: record('rect'), roundRect: record('roundRect') } as unknown as CanvasPath
    rectanglePath(path, 0, 0, width, height, radius, smooth)
    return { calls, points }
  }

  it('starts a smooth corner 60% further along the edge than the radius, and stays in the box', () => {
    const { calls, points } = trace(200, 100, 20, true)
    expect(calls.filter(c => c === 'arc')).toHaveLength(4)
    expect(points[0][0]).toBeCloseTo(200 - 1.6 * 20, 9)
    expect(points[0][1]).toBe(0)
    for (const [x, y] of points) { expect(x).toBeGreaterThanOrEqual(-1e-9); expect(x).toBeLessThanOrEqual(200 + 1e-9); expect(y).toBeGreaterThanOrEqual(-1e-9); expect(y).toBeLessThanOrEqual(100 + 1e-9) }
  })

  it('backs off smoothing where the corners have no room, and keeps a zero radius square', () => {
    expect(trace(40, 40, 20, true).calls).toEqual(['roundRect'])
    expect(trace(48, 40, 18, true).points[0][0]).toBeCloseTo(48 - (1 + (40 / 36 - 1)) * 18, 9)
    expect(trace(40, 40, 0, true).calls).toEqual(['rect'])
    expect(trace(200, 100, 20, false).calls).toEqual(['roundRect'])
  })
})
