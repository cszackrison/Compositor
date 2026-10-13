import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { Raster } from '../src/model/raster'
import { Store } from '../src/editor/store'
import { isPSD } from '../src/io/files'
import { type PSDDocument, type PSDDrawing, decodeChannel, hueAdjustment, levelsAdjustment, makeImport, maskOnLayerGrid, psdRecord, readPSD } from '../src/io/psd'
import { fauxNote, firstStyleNote, missingFontNote, parseText, rasterizedNote, warpNote } from '../src/io/psdText'
import { vectorLive, vectorRaster } from '../src/io/psdVector'
import { fromInks, readProfile, toInks } from '../src/io/cmyk'
import { fullTransform } from '../src/model/types'
import { Buffer, psdFixture, tySh } from './psdFixture'

// PSDRoundTripTests.swift, PSBImportTests.swift, PSDAdjustmentTests.swift, CropToCanvasImportTests.swift and CMYKTests.swift's
// Photoshop cases, on files built in code (psdFixture.ts). The canvas isn't there in Node, so text and shapes are drawn as plain boxes.

const drawing: PSDDrawing = {
  async text(style) { return { raster: Raster.filled(Math.ceil(style.content.length * style.fontSize * 0.6 + 24), Math.ceil(style.fontSize * 1.2 + 24), 4, [0, 0, 0, 255]), baseline: 12 + style.fontSize } },
  shape: (style, width, height) => Raster.filled(width, height, 4, [Math.round(style.red * 255), Math.round(style.green * 255), Math.round(style.blue * 255), 255]),
  path: (_commands, _box, width, height) => Raster.filled(width, height, 4, [0, 0, 0, 255]),
  fontInstalled: async name => name !== 'DefinitelyMissingFontXYZ',
}
const read = (bytes: Uint8Array, remaining?: number) => readPSD(bytes, drawing, remaining)
const importOf = async (bytes: Uint8Array) => makeImport(await read(bytes), drawing)

const colorImage = (width: number, height: number, red: number, green: number, blue: number, alpha = 1) => Raster.filled(width, height, 4, [red * alpha * 255, green * alpha * 255, blue * alpha * 255, alpha * 255].map(Math.round))
const grayImage = (width: number, height: number, value: number) => Raster.filled(width, height, 1, [Math.round(value * 255)])
const doc = (width: number, height: number, layers: Parameters<typeof psdRecord>[0][], resolution = 72) => ({ width, height, resolution, layers })
const record = psdRecord

function header({ version = 1, width = 8, height = 8, depth = 8, mode = 3 } = {}) {
  const b = new Buffer()
  b.string('8BPS'); b.u16(version); b.data(new Uint8Array(6)); b.u16(3); b.u32(height); b.u32(width); b.u16(depth); b.u16(mode)
  return b
}

const rawChannel = (plane: Uint8Array) => new Uint8Array([0, 0, ...plane])

function layerFile({ canvasWidth = 8, canvasHeight = 8, layerWidth, layerHeight, channels }: { canvasWidth?: number; canvasHeight?: number; layerWidth: number; layerHeight: number; channels: { id: number; payload: Uint8Array }[] }) {
  const data = header({ width: canvasWidth, height: canvasHeight })
  data.u32(0); data.u32(0)
  const records = new Buffer(), payloads = new Buffer()
  records.i16(1); records.i32(0); records.i32(0); records.i32(layerHeight); records.i32(layerWidth); records.u16(channels.length)
  for (const channel of channels) { records.i16(channel.id); records.u32(channel.payload.length); payloads.data(channel.payload) }
  records.string('8BIMnorm'); records.data([255, 0, 0, 0]); records.u32(12); records.u32(0); records.u32(0); records.u8(3); records.string('Big')
  const info = new Buffer()
  info.u32(records.length + payloads.length); info.data(records.bytes); info.data(payloads.bytes); info.u32(0)
  data.u32(info.length); data.data(info.bytes)
  return data.build()
}

describe('Photoshop files', () => {
  it('round-trips layer order, visibility, opacity and blend', async () => {
    const red = colorImage(2, 2, 1, 0, 0), blue = colorImage(2, 2, 0, 0, 1)
    const data = await psdFixture(doc(4, 4, [{ name: 'Red', bounds: { x: 0, y: 0, width: 2, height: 2 }, image: red, opacity: 0.5, blendKey: 'mul ' }, { name: 'Blue', bounds: { x: 2, y: 0, width: 2, height: 2 }, image: blue, visible: false }], 144))
    expect(isPSD(data)).toBe(true)
    const document = await read(data)
    expect([document.width, document.height, document.resolution]).toEqual([4, 4, 144])
    expect(document.layers.map(l => l.name)).toEqual(['Red', 'Blue'])
    expect(document.layers.map(l => l.visible)).toEqual([true, false])
    expect(Math.abs(document.layers[0].opacity - 0.5)).toBeLessThan(0.01)
    expect(document.layers[0].blendKey).toBe('mul ')
    expect(document.layers[0].image?.width).toBe(2)
    expect([...document.layers[0].image!.data.subarray(0, 4)]).toEqual([255, 0, 0, 255])
    const imported = await makeImport(document, drawing)
    expect(imported.conversions).toEqual([])
    expect(imported.layers.map(l => l.name)).toEqual(['Red', 'Blue'])
    expect(imported.layers[0].blendMode).toBe('Multiply')
    expect(imported.layers[1].visible).toBe(false)
    expect(imported.layers[1].transform.origin).toEqual([2, 0])
  })

  it('round-trips groups, masks and clipping', async () => {
    const groupId = 'GROUP'
    const data = await psdFixture(doc(4, 4, [
      { id: groupId, name: 'Stack', isGroup: true, blendKey: 'pass' },
      { name: 'Base', parentId: groupId, bounds: { x: 0, y: 0, width: 2, height: 2 }, image: colorImage(2, 2, 0, 1, 0), mask: grayImage(2, 2, 1) },
      { name: 'Clipped', parentId: groupId, bounds: { x: 0, y: 0, width: 2, height: 2 }, image: colorImage(2, 2, 1, 1, 0), clipping: true },
    ]))
    const imported = await importOf(data)
    expect(imported.conversions).toEqual([])
    const folder = imported.layers.find(l => l.isGroup)!, base = imported.layers.find(l => l.name === 'Base')!, child = imported.layers.find(l => l.name === 'Clipped')!
    expect(folder.name).toBe('Stack')
    expect([base.parentId, child.parentId]).toEqual([folder.id, folder.id])
    expect(base.mask).not.toBeNull()
    expect(child.clipTo).toBe(base.id)
  })

  it('follows Photoshop\'s lsct order for groups', async () => {
    const data = await psdFixture(doc(4, 4, [{ id: 'G', name: 'Stack', isGroup: true }, { name: 'Base', parentId: 'G', bounds: { x: 0, y: 0, width: 2, height: 2 }, image: colorImage(2, 2, 0, 1, 0) }]))
    const types: number[] = []
    for (let i = 0; i + 12 <= data.length; i++) if (String.fromCharCode(...data.subarray(i, i + 4)) === 'lsct') types.push(new DataView(data.buffer).getUint32(i + 8))
    expect(types).toEqual([3, 1])
    const imported = await importOf(data), folder = imported.layers.find(l => l.isGroup)!
    expect(folder.name).toBe('Stack')
    expect(imported.layers.find(l => l.name === 'Base')!.parentId).toBe(folder.id)
  })

  it('rejects oversized layer bounds', async () => {
    const blank = [-1, 0, 1, 2].map(id => ({ id, payload: new Uint8Array([0, 0]) }))
    await expect(read(layerFile({ layerWidth: 30_000, layerHeight: 30_000, channels: blank }), 50)).rejects.toMatchObject({ code: 'tooLarge' })
    const fill = colorImage(20, 20, 1, 0, 0)
    const data = await psdFixture(doc(20, 20, [{ name: 'Huge', bounds: { x: 0, y: 0, width: 20, height: 20 }, image: fill }]), { composite: fill })
    await expect(read(data, 50)).rejects.toMatchObject({ code: 'tooLarge' })
  })

  it('skips unused spot channels before decoding them', async () => {
    const pixels = new Uint8Array(4).fill(255)
    // Compression 99 would throw if these planes were unpacked. 52 extras fill the 56-channel cap.
    const channels = [...[-1, 0, 1, 2].map(id => ({ id, payload: rawChannel(pixels) })), ...Array.from({ length: 52 }, (_, i) => ({ id: i + 3, payload: new Uint8Array([0, 99, 0, 0]) }))]
    const document = await read(layerFile({ layerWidth: 2, layerHeight: 2, channels }))
    expect(document.layers.length).toBe(1)
    expect([document.layers[0].image?.width, document.layers[0].image?.height]).toEqual([2, 2])
  })

  it('still rejects an unsupported compression on a color channel', async () => {
    const pixels = new Uint8Array(4).fill(255)
    const channels = [{ id: -1, payload: rawChannel(pixels) }, { id: 0, payload: new Uint8Array([0, 99, 0, 0]) }, { id: 1, payload: rawChannel(pixels) }, { id: 2, payload: rawChannel(pixels) }]
    await expect(read(layerFile({ layerWidth: 2, layerHeight: 2, channels }))).rejects.toMatchObject({ code: 'unsupportedCompression' })
  })

  it('needs Photoshop\'s signature', () => {
    expect(isPSD(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe(false)
    expect(isPSD(new TextEncoder().encode('8BPS'))).toBe(true)
  })

  // Vivid Light is supported, so an unsupported key has to be one Photoshop has and Compositor doesn't: Dissolve scatters pixels by
  // opacity rather than blending, and comes in as Normal.
  it('reports an unsupported blend mode', async () => {
    const fill = colorImage(2, 2, 1, 0, 0)
    const imported = await importOf(await psdFixture(doc(2, 2, [{ name: 'Dissolved', bounds: { x: 0, y: 0, width: 2, height: 2 }, image: fill, blendKey: 'diss' }]), { composite: fill }))
    expect(imported.conversions.some(c => c.layerName === 'Dissolved' && c.message.includes('diss'))).toBe(true)
    expect(imported.layers[0].blendMode).toBe('Normal')
  })

  it('imports Soft Light without a conversion', async () => {
    const fill = colorImage(2, 2, 1, 0, 0)
    const imported = await importOf(await psdFixture(doc(2, 2, [{ name: 'Soft', bounds: { x: 0, y: 0, width: 2, height: 2 }, image: fill, blendKey: 'sLit' }]), { composite: fill }))
    expect(imported.conversions).toEqual([])
    expect(imported.layers[0].blendMode).toBe('Soft Light')
  })

  it('puts a folder\'s opacity on the folder', async () => {
    const imported = await importOf(await psdFixture(doc(4, 4, [{ id: 'G', name: 'Stack', isGroup: true, opacity: 0.5 }, { name: 'Base', parentId: 'G', bounds: { x: 0, y: 0, width: 2, height: 2 }, image: colorImage(2, 2, 0, 1, 0) }])))
    const folder = imported.layers.find(l => l.isGroup)!
    // Photoshop stores opacity in one byte, so a half-opaque group comes back as 128/255.
    expect(Math.abs(folder.opacity - 0.5)).toBeLessThan(0.01)
    expect(imported.conversions.some(c => c.layerName === 'Stack' && c.message.includes('opacity'))).toBe(false)
  })

  it('rejects headers it can\'t read', async () => {
    await expect(read(header({ version: 3 }).build())).rejects.toMatchObject({ code: 'unsupportedVersion' })
    // Lab (9): RGB and CMYK come in, other color modes don't.
    await expect(read(header({ mode: 9 }).build())).rejects.toMatchObject({ code: 'unsupportedColorMode' })
    await expect(read(header({ depth: 1 }).build())).rejects.toMatchObject({ code: 'unsupportedDepth' })
    await expect(read(header({ width: 30_001, height: 10 }).build())).rejects.toMatchObject({ code: 'tooLarge' })
    await expect(read(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).rejects.toMatchObject({ code: 'unreadable' })
  })

  it('opens as a new document, and comes into an open one as a folder', async () => {
    const fill = colorImage(4, 2, 0, 0, 1)
    const imported = await importOf(await psdFixture(doc(4, 2, [{ name: 'Sky', bounds: { x: 0, y: 0, width: 4, height: 2 }, image: fill }]), { composite: fill }))
    const store = new Store()
    store.addPhotoshop(imported, 'Clouds')
    expect([store.doc.width, store.doc.height]).toEqual([4, 2])
    expect(store.doc.layers.map(l => l.name)).toEqual(['Sky'])
    expect(store.state.activeId).toBe(store.doc.layers[0].id)
    store.addPhotoshop(await importOf(await psdFixture(doc(4, 2, [{ name: 'Sky', bounds: { x: 0, y: 0, width: 4, height: 2 }, image: fill }]), { composite: fill })), 'Clouds')
    const folder = store.doc.layers.find(l => l.isGroup && l.name === 'Clouds')!
    expect(folder).toBeDefined()
    expect(store.doc.layers.filter(l => l.name === 'Sky').map(l => l.parentId)).toEqual([null, folder.id])
    expect(store.state.activeId).toBe(folder.id)
    store.undo()
    expect(store.doc.layers.map(l => l.name)).toEqual(['Sky'])
  })

  it('centers a dropped file’s layers on the drop', async () => {
    const fill = colorImage(4, 2, 0, 0, 1), store = new Store()
    store.open({ id: 'd', width: 40, height: 20, resolution: 72, layers: [], guides: [], extra: {} }, null, null)
    store.addPhotoshop(await importOf(await psdFixture(doc(40, 20, [{ name: 'Sky', bounds: { x: 2, y: 4, width: 4, height: 2 }, image: fill }]), { composite: Raster.filled(40, 20, 4, [0, 0, 0, 0]) })), 'Clouds', [30, 10])
    expect(store.doc.layers.find(l => l.name === 'Sky')!.transform.origin).toEqual([28, 9])
    store.addImageLayer(fill, 'Placed', undefined, [10, 5])
    expect(store.doc.layers.find(l => l.name === 'Placed')!.transform.origin).toEqual([8, 4])
  })

  it('reads a file without layer records as its merged image', async () => {
    const composite = Raster.filled(3, 2, 4, [10, 200, 30, 255])
    const document = await read(await psdFixture(doc(3, 2, []), { composite }))
    expect(document.layers).toEqual([])
    expect([...document.merged!.data]).toEqual([...composite.data])
  })
})

describe('Photoshop vector layers', () => {
  const corners = (canvas: { width: number; height: number }, points: [number, number][]) => {
    const b = new Buffer(), pad = () => b.data(new Uint8Array(24)), point = ([x, y]: [number, number]) => { b.i32(Math.trunc(y / canvas.height * 0x1000000)); b.i32(Math.trunc(x / canvas.width * 0x1000000)) }
    b.u32(3); b.u32(0); b.i16(6); pad(); b.i16(8); pad(); b.i16(0); b.i16(points.length); b.data(new Uint8Array(22))
    for (const p of points) { b.i16(1); point(p); point(p); point(p) }
    return b.build()
  }
  const colorDescriptor = (red: number, green: number, blue: number) => { const b = new Buffer(); b.string('RGBC'); for (const [key, v] of [['Rd  ', red], ['Grn ', green], ['Bl  ', blue]] as const) { b.string(key); b.string('doub'); b.f64(v) } return b.build() }
  const strokeStyle = (fill: boolean, stroke: boolean, width: number, red: number, green: number, blue: number) => {
    const b = new Buffer()
    b.string('strokeEnabled'); b.string('bool'); b.u8(stroke ? 1 : 0); b.string('fillEnabled'); b.string('bool'); b.u8(fill ? 1 : 0)
    b.string('strokeStyleLineWidth'); b.string('UntF'); b.string('#Pxl'); b.f64(width); b.data(colorDescriptor(red, green, blue))
    return b.build()
  }
  const origination = (type: number, [x, y, w, h]: [number, number, number, number], radii: number[] = []) => {
    const b = new Buffer(), unit = (key: string, v: number) => { b.string(key); b.string('UntF'); b.string('#Pxl'); b.f64(v) }
    b.string('keyOriginType'); b.string('long'); b.u32(type)
    b.string('keyOriginShapeBBox'); unit('Left', x); unit('Top ', y); unit('Rght', x + w); unit('Btom', y + h)
    if (radii.length === 4) { b.string('keyOriginRRectRadii'); ['topLeft', 'topRight', 'bottomRight', 'bottomLeft'].forEach((key, i) => unit(key, radii[i])) }
    return b.build()
  }
  const b64 = (s: string) => new Uint8Array(globalThis.Buffer.from(s, 'base64'))
  const canvas = { width: 1920, height: 1080 }
  // PSDVectorFixtures.swift: a filled circle and a stroked rectangle from a real Photoshop file.
  const circle = () => new Map([
    ['vmsk', b64('AAAAAwAAAAAABgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAABAAEAAAAAAAAAAAAAAAAAAAAAAAAAAQDHWSAAXn4FAMdZIABSZmYAx1kgAEZOxwABALX4sAA8iIgAoHlcADyIiACK+gkAPIiIAAEAeZmZAEZOxwB5mZkAUmZmAHmZmQBefgUAAQCK+gkAaEREAKB5XABoREQAtfiwAGhERAAA')],
    ['SoCo', b64('AAAAEAAAAAEAAAAAAABudWxsAAAAAQAAAABDbHIgT2JqYwAAAAEAAAAAAABSR0JDAAAAAwAAAABSZCAgZG91YgAAAAAAAAAAAAAAAEdybiBkb3ViQFuAAAAAAAAAAAAAQmwgIGRvdWJAb+AAAAAAAA==')],
    ['vstk', b64('AAAAEAAAAAEAAAAAAAtzdHJva2VTdHlsZQAAABAAAAASc3Ryb2tlU3R5bGVWZXJzaW9ubG9uZwAAAAIAAAANc3Ryb2tlRW5hYmxlZGJvb2wAAAAAC2ZpbGxFbmFibGVkYm9vbAEAAAAUc3Ryb2tlU3R5bGVMaW5lV2lkdGhVbnRGI1B4bEAjvQfpGNNeAAAAGXN0cm9rZVN0eWxlTGluZURhc2hPZmZzZXRVbnRGI1BudAAAAAAAAAAAAAAAFXN0cm9rZVN0eWxlTWl0ZXJMaW1pdGRvdWJAWQAAAAAAAAAAABZzdHJva2VTdHlsZUxpbmVDYXBUeXBlZW51bQAAABZzdHJva2VTdHlsZUxpbmVDYXBUeXBlAAAAEnN0cm9rZVN0eWxlQnV0dENhcAAAABdzdHJva2VTdHlsZUxpbmVKb2luVHlwZWVudW0AAAAXc3Ryb2tlU3R5bGVMaW5lSm9pblR5cGUAAAAUc3Ryb2tlU3R5bGVNaXRlckpvaW4AAAAYc3Ryb2tlU3R5bGVMaW5lQWxpZ25tZW50ZW51bQAAABhzdHJva2VTdHlsZUxpbmVBbGlnbm1lbnQAAAAWc3Ryb2tlU3R5bGVBbGlnbkNlbnRlcgAAABRzdHJva2VTdHlsZVNjYWxlTG9ja2Jvb2wAAAAAF3N0cm9rZVN0eWxlU3Ryb2tlQWRqdXN0Ym9vbAAAAAAWc3Ryb2tlU3R5bGVMaW5lRGFzaFNldFZsTHMAAAAAAAAAFHN0cm9rZVN0eWxlQmxlbmRNb2RlZW51bQAAAABCbG5NAAAAAE5ybWwAAAASc3Ryb2tlU3R5bGVPcGFjaXR5VW50RiNQcmNAWQAAAAAAAAAAABJzdHJva2VTdHlsZUNvbnRlbnRPYmpjAAAAAQAAAAAAD3NvbGlkQ29sb3JMYXllcgAAAAEAAAAAQ2xyIE9iamMAAAABAAAAAAAAUkdCQwAAAAMAAAAAUmQgIGRvdWJAb+AAAAAAAAAAAABHcm4gZG91YkBv4AAAAAAAAAAAAEJsICBkb3ViAAAAAAAAAAAAAAAVc3Ryb2tlU3R5bGVSZXNvbHV0aW9uZG91YkBSAAAAAAAA')],
  ])
  const rectangle = () => new Map([
    ['vmsk', b64('AAAAAwAAAAAABgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAABAAEAAAAAAAAAAAAAAAAAAAAAAAAAAQAkREQA1CIiACRERADUIiIAJEREANQiIgABAE9oSwDUIiIAT2hLANQiIgBPaEsA1CIiAAEAT2hLAH4AAABPaEsAfgAAAE9oSwB+AAAAAQAkREQAfgAAACRERAB+AAAAJEREAH4AAAAA')],
    ['SoCo', b64('AAAAEAAAAAEAAAAAAABudWxsAAAAAQAAAABDbHIgT2JqYwAAAAEAAAAAAABSR0JDAAAAAwAAAABSZCAgZG91YgAAAAAAAAAAAAAAAEdybiBkb3ViAAAAAAAAAAAAAAAAQmwgIGRvdWIAAAAAAAAAAA==')],
    ['vstk', b64('AAAAEAAAAAEAAAAAAAtzdHJva2VTdHlsZQAAABAAAAASc3Ryb2tlU3R5bGVWZXJzaW9ubG9uZwAAAAIAAAANc3Ryb2tlRW5hYmxlZGJvb2wBAAAAC2ZpbGxFbmFibGVkYm9vbAEAAAAUc3Ryb2tlU3R5bGVMaW5lV2lkdGhVbnRGI1B4bEAjvQfpGNNeAAAAGXN0cm9rZVN0eWxlTGluZURhc2hPZmZzZXRVbnRGI1BudAAAAAAAAAAAAAAAFXN0cm9rZVN0eWxlTWl0ZXJMaW1pdGRvdWJAWQAAAAAAAAAAABZzdHJva2VTdHlsZUxpbmVDYXBUeXBlZW51bQAAABZzdHJva2VTdHlsZUxpbmVDYXBUeXBlAAAAEnN0cm9rZVN0eWxlQnV0dENhcAAAABdzdHJva2VTdHlsZUxpbmVKb2luVHlwZWVudW0AAAAXc3Ryb2tlU3R5bGVMaW5lSm9pblR5cGUAAAAUc3Ryb2tlU3R5bGVNaXRlckpvaW4AAAAYc3Ryb2tlU3R5bGVMaW5lQWxpZ25tZW50ZW51bQAAABhzdHJva2VTdHlsZUxpbmVBbGlnbm1lbnQAAAAWc3Ryb2tlU3R5bGVBbGlnbkNlbnRlcgAAABRzdHJva2VTdHlsZVNjYWxlTG9ja2Jvb2wAAAAAF3N0cm9rZVN0eWxlU3Ryb2tlQWRqdXN0Ym9vbAAAAAAWc3Ryb2tlU3R5bGVMaW5lRGFzaFNldFZsTHMAAAAAAAAAFHN0cm9rZVN0eWxlQmxlbmRNb2RlZW51bQAAAABCbG5NAAAAAE5ybWwAAAASc3Ryb2tlU3R5bGVPcGFjaXR5VW50RiNQcmNAWQAAAAAAAAAAABJzdHJva2VTdHlsZUNvbnRlbnRPYmpjAAAAAQAAAAAAD3NvbGlkQ29sb3JMYXllcgAAAAEAAAAAQ2xyIE9iamMAAAABAAAAAAAAUkdCQwAAAAMAAAAAUmQgIGRvdWJAb+AAAAAAAAAAAABHcm4gZG91YkBv4AAAAAAAAAAAAEJsICBkb3ViAAAAAAAAAAAAAAAVc3Ryb2tlU3R5bGVSZXNvbHV0aW9uZG91YkBSAAAAAAAA')],
  ])
  const quad = { width: 200, height: 200 }, box: [number, number][] = [[120, 30], [120, 80], [20, 80], [20, 30]]

  it('rasterizes a vector mask with its fill and stroke', () => {
    const extra = new Map([['vmsk', corners(quad, box)], ['SoCo', colorDescriptor(0, 110, 255)], ['vstk', strokeStyle(true, false, 1, 255, 255, 0)]])
    const raster = vectorRaster(extra, quad, drawing)!
    expect(raster.bounds.width >= 99 && raster.bounds.height >= 49).toBe(true)
    expect(raster.image.width >= 99 && raster.image.height >= 49).toBe(true)
    extra.set('vstk', strokeStyle(true, true, 10, 255, 255, 0)); extra.set('SoCo', colorDescriptor(0, 0, 0))
    const stroked = vectorRaster(extra, quad, drawing)!
    expect(stroked.bounds.width).toBeGreaterThan(raster.bounds.width)
    expect(stroked.bounds.height).toBeGreaterThan(raster.bounds.height)
  })

  it('rasterizes Photoshop\'s shapes in place', () => {
    const c = vectorRaster(circle(), canvas, drawing)!.bounds
    expect(Math.abs(c.x + c.width / 2 - 618)).toBeLessThan(8)
    expect(Math.abs(c.y + c.height / 2 - 677)).toBeLessThan(8)
    expect(Math.abs(c.width - 328)).toBeLessThan(12)
    expect(Math.abs(c.height - 328)).toBeLessThan(12)
    const r = vectorRaster(rectangle(), canvas, drawing)!.bounds
    expect(r.width).toBeGreaterThan(640)
    expect(r.height).toBeGreaterThan(170)
    expect(Math.abs(r.x + r.width / 2 - 1268)).toBeLessThan(20)
    expect(Math.abs(r.y + r.height / 2 - 244)).toBeLessThan(20)
  })

  it('imports a filled ellipse as a live shape', async () => {
    const extra = circle()
    extra.set('vogk', origination(5, [454, 513, 328, 328]))
    const live = vectorLive(extra, canvas, drawing)!
    expect(live.style.kind).toBe('Ellipse')
    expect(Math.abs(live.style.green - 110 / 255)).toBeLessThan(0.01)
    expect(Math.abs(live.style.blue - 1)).toBeLessThan(0.01)
    expect(live.notes).toEqual([])
    expect(Math.abs(live.bounds.x - 454) < 1 && Math.abs(live.bounds.width - 328) < 1).toBe(true)
    const imported = await makeImport({ ...doc(1920, 1080, []), cmykProfile: null, layers: [record({ name: 'cercle-bleu', kind: 'vector', image: live.image, bounds: live.bounds, shape: live.style })] }, drawing)
    expect((imported.layers[0].shape as { kind: string }).kind).toBe('Ellipse')
    expect(imported.layers[0].image).toBe(live.image)
    expect(imported.conversions).toEqual([])
  })

  it('imports a stroked rectangle as a live shape and reports the stroke', async () => {
    const extra = rectangle()
    extra.set('vogk', origination(2, [945, 153, 646, 182], [0, 0, 0, 0]))
    const live = vectorLive(extra, canvas, drawing)!
    expect([live.style.kind, live.style.cornerRadius]).toEqual(['Rectangle', 0])
    expect(live.notes.some(n => n.includes('stroke'))).toBe(true)
    const imported = await makeImport({ ...doc(1920, 1080, []), cmykProfile: null, layers: [record({ name: 'rectangle-contour-jaune', kind: 'vector', image: live.image, bounds: live.bounds, shape: live.style, shapeNotes: live.notes })] }, drawing)
    expect((imported.layers[0].shape as { kind: string }).kind).toBe('Rectangle')
    expect(imported.conversions.some(c => c.layerName === 'rectangle-contour-jaune' && c.message.includes('stroke'))).toBe(true)
    expect(imported.conversions.some(c => c.message.includes('rasterized'))).toBe(false)
  })

  it('reads four sharp corners as a rectangle without an origination', () => {
    const extra = new Map([['vmsk', corners(quad, box)], ['SoCo', colorDescriptor(0, 110, 255)], ['vstk', strokeStyle(true, false, 1, 255, 255, 0)]])
    const live = vectorLive(extra, quad, drawing)!
    expect(live.style.kind).toBe('Rectangle')
    expect(live.notes).toEqual([])
    expect(live.bounds.width >= 99 && live.bounds.height >= 49).toBe(true)
  })

  it('rejects huge sizes and stroke widths, and ignores ones that aren\'t finite', () => {
    const style = () => new Map([['SoCo', colorDescriptor(0, 110, 255)], ['vstk', strokeStyle(true, false, 1, 255, 255, 0)]])
    const huge = style(); huge.set('vogk', origination(5, [0, 0, 1e20, 1e20]))
    expect(() => vectorLive(huge, canvas, drawing)).toThrow(expect.objectContaining({ code: 'tooLarge' }))
    const infinite = style(); infinite.set('vogk', origination(5, [10, 10, Infinity, 100]))
    expect(vectorLive(infinite, canvas, drawing)).toBeNull()
    const stroke = new Map([['vmsk', corners(quad, box)], ['SoCo', colorDescriptor(0, 0, 0)], ['vstk', strokeStyle(true, true, 1e20, 255, 255, 0)]])
    expect(() => vectorRaster(stroke, quad, drawing)).toThrow(expect.objectContaining({ code: 'tooLarge' }))
  })
})

describe('Photoshop type layers', () => {
  const parse = (options: Parameters<typeof tySh>[0]) => parseText(new Map([['TySh', tySh(options)]]))

  it('imports point text as an editable text layer', async () => {
    const parsed = parse({ text: 'Hello', tx: 40, ty: 50 })!
    expect([parsed.style.content, parsed.style.fontName, parsed.style.fontSize, parsed.style.red, parsed.style.green, parsed.style.blue, parsed.style.alignment]).toEqual(['Hello', 'Helvetica', 24, 0, 0, 0, 'Left'])
    expect(parsed.notes).toEqual([])
    const data = await psdFixture(doc(32, 32, [{ id: 'T', name: 'Greeting', image: colorImage(8, 8, 0, 0, 0), bounds: { x: 1, y: 2, width: 8, height: 8 } }]), { composite: colorImage(32, 32, 1, 1, 1), extras: { T: { TySh: tySh({ text: 'Hello', tx: 40, ty: 50 }) } } })
    const document = await read(data), first = document.layers[0]
    expect(first.kind).toBe('text')
    expect(first.text?.style.content).toBe('Hello')
    const imported = await makeImport(document, drawing), layer = imported.layers[0], text = layer.text as { content: string; fontName: string; fontSize: number }
    expect([text.content, text.fontName, text.fontSize]).toEqual(['Hello', 'Helvetica', 24])
    expect(layer.image).not.toBe(first.image)
    expect(imported.conversions.some(c => c.message === rasterizedNote)).toBe(false)
    expect(Math.abs(layer.transform.origin[0] - 40)).toBeLessThan(80)
    expect(Math.abs(layer.transform.origin[1] - 50)).toBeLessThan(80)
    // The first baseline lands on Photoshop's anchor.
    expect(layer.transform.origin[0] + 12).toBeCloseTo(40)
    expect(layer.transform.origin[1] + 12 + 24).toBeCloseTo(50)
  })

  it('sizes text by the matrix, not the document resolution', () => {
    expect(parse({ text: 'Hello' })?.style.fontSize).toBe(24)
    expect(parse({ text: 'Hello', xx: 2, yy: 2 })?.style.fontSize).toBe(48)
    expect(parse({ text: 'Hello', fontSize: 25, xx: 2, yy: 2 })?.style.fontSize).toBe(50)
  })

  it('keeps the first style and reports the rest', () => {
    const parsed = parse({ text: 'Hello', red: 1, green: 0, blue: 0, justification: 2, tracking: 1000, leading: 30, secondSize: 48 })!
    expect([parsed.style.content, parsed.style.alignment, parsed.style.tracking, parsed.style.leading, parsed.style.red, parsed.style.fontSize]).toEqual(['Hello', 'Center', 24, 30, 1, 24])
    expect(parsed.notes).toContain(firstStyleNote)
  })

  it('reports styles that differ only by leading or scale', () => {
    const byLeading = parse({ text: 'Hello', leading: 30, secondLeading: 48 })!
    expect(byLeading.style.leading).toBe(30)
    expect(byLeading.notes).toContain(firstStyleNote)
    expect(parse({ text: 'Hello', secondHorizontalScale: 1.2 })!.notes).toContain(firstStyleNote)
  })

  it('keeps a paragraph\'s box', () => {
    const parsed = parse({ text: 'Hello', tx: 10, ty: 30, bounds: [0, 0, 200, 80], glyphBounds: [0, -10, 40, 10] })!
    expect(parsed.anchorIsFrame).toBe(true)
    expect(parsed.style.boxSize).toEqual([224, 104])
    expect(parsed.documentAnchor).toEqual([10, 30])
  })

  it('leaves an oversized paragraph frame as pixels', async () => {
    expect(parse({ text: 'Hello', bounds: [0, 0, 40_000, 100], glyphBounds: [0, 0, 40, 10] })).toBeNull()
    const data = await psdFixture(doc(16, 16, [{ id: 'B', name: 'Billboard', image: colorImage(4, 4, 0, 1, 0), bounds: { x: 0, y: 0, width: 4, height: 4 } }]), { composite: colorImage(16, 16, 1, 1, 1), extras: { B: { TySh: tySh({ text: 'Hello', bounds: [0, 0, 40_000, 100], glyphBounds: [0, 0, 40, 10] }) } } })
    const imported = await importOf(data), layer = imported.layers[0]
    expect(layer.text).toBeUndefined()
    expect(layer.image?.width).toBe(4)
    expect(imported.conversions.some(c => c.message === rasterizedNote)).toBe(true)
  })

  it('keeps warped text editable and says so', () => {
    const parsed = parse({ text: 'Hello', fauxBold: true, warp: true })!
    expect(parsed.style.content).toBe('Hello')
    expect(parsed.notes).toContain(warpNote)
    expect(parsed.notes).toContain(fauxNote)
  })

  it('leaves vertical or broken text as pixels', async () => {
    expect(parse({ text: 'Hello', vertical: true })).toBeNull()
    expect(parseText(new Map([['TySh', new Uint8Array([0, 1])]]))).toBeNull()
    expect(parse({ text: 'Hello', xx: 2, yy: 1 })).toBeNull()
    const data = await psdFixture(doc(16, 16, [{ id: 'S', name: 'Sideways', image: colorImage(4, 4, 0, 0, 1), bounds: { x: 0, y: 0, width: 4, height: 4 } }]), { composite: colorImage(16, 16, 1, 1, 1), extras: { S: { TySh: tySh({ text: 'Hello', vertical: true }) } } })
    const imported = await importOf(data)
    expect(imported.layers[0].text).toBeUndefined()
    expect(imported.layers[0].image?.width).toBe(4)
    expect(imported.conversions.some(c => c.message === rasterizedNote)).toBe(true)
  })

  it('reports a missing font but keeps the text editable', async () => {
    const parsed = parse({ text: 'Hello', font: 'DefinitelyMissingFontXYZ' })!
    const imported = await makeImport({ ...doc(64, 64, []), cmykProfile: null, layers: [record({ name: 'Missing', kind: 'text', text: parsed, image: colorImage(2, 2, 0, 0, 0) })] }, drawing)
    expect((imported.layers[0].text as { fontName: string }).fontName).toBe('DefinitelyMissingFontXYZ')
    expect(imported.conversions.some(c => c.message === missingFontNote('DefinitelyMissingFontXYZ'))).toBe(true)
  })

  it('keeps rotated text\'s angle', () => {
    const parsed = parse({ text: 'Hello', xx: 0, xy: -1, yx: 1, yy: 0 })!
    expect(Math.abs(parsed.rotation - 90)).toBeLessThan(0.01)
    expect(parsed.flipY).toBe(false)
  })
})

describe('Photoshop adjustment layers', () => {
  const shorts = (values: number[]) => { const b = new Buffer(); values.forEach(v => b.i16(v)); return b.build() }
  const join = (...parts: Uint8Array[]) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); parts.reduce((at, p) => { out.set(p, at); return at + p.length }, 0); return out }

  it('reads Levels gamma in hundredths', () => {
    // RGB: input 2–254, gamma 1.00 (stored as 100); red, green and blue untouched; padded to Photoshop's 29 records.
    const data = new Uint8Array(292)
    data.set(shorts([2, 2, 254, 0, 255, 100, ...[0, 1, 2].flatMap(() => [0, 255, 0, 255, 100])]))
    const levels = levelsAdjustment(data)!.levels
    expect(levels.ranges[0]).toEqual({ black: 2, gamma: 1, white: 254, outputBlack: 0, outputWhite: 255 })
    expect(levels.ranges.slice(1).every(r => r.gamma === 1)).toBe(true)
  })

  it('reads Hue/Saturation\'s Master and each range', () => {
    // Version 2, Colorize off; Colorize values (ignored), Master +5/+4/0; Reds' band and −30 saturation, +10 light.
    const data = join(shorts([2]), new Uint8Array([0, 0]), shorts([23, 25, 0, 5, 4, 0, 315, 345, 15, 45, 0, -30, 10]), shorts(Array(35).fill(0)))
    const settings = hueAdjustment(data)!.hsvSettings!
    expect(settings.colorize).toBe(false)
    expect(settings.adjustments.Master).toEqual({ hue: 5, saturation: 4, lightness: 0 })
    expect(settings.adjustments.Reds).toEqual({ hue: 0, saturation: -30, lightness: 10 })
    expect(settings.bands.Reds).toEqual({ falloffStart: 315, rangeStart: 345, rangeEnd: 15, falloffEnd: 45 })
    data[2] = 1 // Colorize on: its own values apply.
    const colorized = hueAdjustment(data)!.hsvSettings!
    expect(colorized.colorize).toBe(true)
    expect(colorized.adjustments.Master).toEqual({ hue: 23, saturation: 25, lightness: 0 })
  })

  it('puts a mask\'s patch where it sits on the canvas', () => {
    // A 2 × 2 white patch at (3, 1) on a 6 × 4 canvas, black everywhere else, on an adjustment layer (no pixels of its own, so it covers
    // the canvas): the patch must land at (3, 1), not stretch over the whole layer.
    const mask = maskOnLayerGrid(grayImage(2, 2, 1), { maskBounds: { x: 3, y: 1, width: 2, height: 2 }, maskDefault: 0 }, { image: null, transform: fullTransform(6, 4) }, { width: 6, height: 4 })!
    expect([mask.width, mask.height]).toEqual([6, 4])
    const rows = [0, 1, 2, 3].map(y => [0, 1, 2, 3, 4, 5].map(x => mask.data[y * 6 + x] > 127 ? '#' : '.').join(''))
    expect(rows).toEqual(['......', '...##.', '...##.', '......'])
  })

  it('imports Levels as an adjustment layer and reports it', async () => {
    const levels = new Uint8Array(292)
    levels.set(shorts([2, 10, 245, 0, 255, 120, ...[0, 1, 2].flatMap(() => [0, 255, 0, 255, 100])]))
    const imported = await importOf(await psdFixture(doc(4, 4, [{ id: 'L', name: 'Levels 1' }]), { extras: { L: { levl: levels } } }))
    expect(imported.layers[0].adjustment?.kind).toBe('Levels')
    expect(imported.layers[0].adjustment?.levels.ranges[0]).toEqual({ black: 10, gamma: 1.2, white: 245, outputBlack: 0, outputWhite: 255 })
    expect(imported.conversions.map(c => c.message)).toEqual(['Adjustment parameters may not match Photoshop exactly.'])
  })
})

describe('PSB', () => {
  it('reads the same layers as the PSD', async () => {
    const source = doc(5, 5, [
      { name: 'Red', bounds: { x: 0, y: 0, width: 3, height: 2 }, image: colorImage(3, 2, 1, 0, 0) },
      { name: 'Green', bounds: { x: 1, y: 1, width: 2, height: 3 }, image: colorImage(2, 3, 0, 1, 0) },
      { name: 'Blue mask', bounds: { x: 2, y: 2, width: 2, height: 2 }, image: colorImage(2, 2, 0, 0, 1), mask: grayImage(2, 2, 0.5) },
    ], 144)
    const composite = colorImage(5, 5, 0, 0, 0)
    const psd = await read(await psdFixture(source, { composite })), psb = await read(await psdFixture(source, { composite, large: true }))
    expect(psb.layers.map(l => l.name)).toEqual(psd.layers.map(l => l.name))
    expect(psb.layers.map(l => l.bounds)).toEqual(psd.layers.map(l => l.bounds))
    psd.layers.forEach((layer, i) => expect([...psb.layers[i].image!.data]).toEqual([...layer.image!.data]))
    expect([...psb.layers[2].mask!.data]).toEqual([...psd.layers[2].mask!.data])
  })

  it('rejects a canvas past the side limit', async () => {
    const image = colorImage(2, 2, 1, 0, 0)
    const data = await psdFixture(doc(2, 2, [{ name: 'Large', bounds: { x: 0, y: 0, width: 2, height: 2 }, image }]), { composite: image, large: true })
    data.set([0, 0, 0x75, 0x31], 18)
    await expect(read(data)).rejects.toMatchObject({ code: 'tooLarge' })
  })

  it('doesn\'t let a large additional info block hide the Unicode name', async () => {
    const image = colorImage(2, 2, 1, 0, 0)
    const data = await psdFixture(doc(2, 2, [{ name: 'Café layer', bounds: { x: 0, y: 0, width: 2, height: 2 }, image }]), { composite: image, large: true, additional: { key: 'LMsk', payload: new Uint8Array([1, 2, 3]) } })
    expect((await read(data)).layers.map(l => l.name)).toEqual(['Café layer'])
  })
})

describe('Cropping Photoshop layers to the canvas', () => {
  const rgba = (width: number, height: number) => {
    const raster = new Raster(width, height, 4)
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) raster.data.set([(x * 30 + y) & 255, (y * 50) & 255, (255 - x * 20) & 255, 255], (y * width + x) * 4)
    return raster
  }
  const gray = (width: number, height: number) => new Raster(width, height, 1, Uint8Array.from({ length: width * height }, (_, i) => (i * 10) & 255))
  const source = () => doc(4, 4, [{ name: 'Overhang', bounds: { x: -2, y: 1, width: 6, height: 3 }, image: rgba(6, 3), mask: gray(6, 3) }])
  const rows = (data: Uint8Array, width: number, channels: number, x: number, w: number, h: number) => Array.from({ length: h }, (_, row) => [...data.subarray((row * width + x) * channels, (row * width + x + w) * channels)]).flat()

  it('keeps an overhanging layer\'s pixels when the document fits', async () => {
    const parsed = await read(await psdFixture(source(), { composite: rgba(4, 4) }), 100), layer = parsed.layers[0]
    expect(layer.bounds).toEqual({ x: -2, y: 1, width: 6, height: 3 })
    expect(layer.croppedToCanvas).toBe(false)
    expect([...layer.image!.data]).toEqual([...rgba(6, 3).data])
    expect((await makeImport(parsed, drawing)).conversions.some(c => c.message.includes('Cropped to the canvas'))).toBe(false)
  })

  it('crops image and mask to the canvas when the document is over budget', async () => {
    const parsed = await read(await psdFixture(source(), { composite: rgba(4, 4) }), 12), layer = parsed.layers[0]
    expect(layer.bounds).toEqual({ x: 0, y: 1, width: 4, height: 3 })
    expect(layer.croppedToCanvas).toBe(true)
    expect([layer.image!.width, layer.image!.height]).toEqual([4, 3])
    expect([...layer.image!.data]).toEqual(rows(rgba(6, 3).data, 6, 4, 2, 4, 3))
    expect([layer.mask!.width, layer.mask!.height]).toEqual([4, 3])
    expect([...layer.mask!.data]).toEqual(rows(gray(6, 3).data, 6, 1, 2, 4, 3))
    expect((await makeImport(parsed, drawing)).conversions.filter(c => c.message.includes('Cropped to the canvas')).map(c => c.layerName)).toEqual(['Overhang'])
  })

  it('rejects a document still over budget once cropped', async () => {
    await expect(read(await psdFixture(source(), { composite: rgba(4, 4) }), 11)).rejects.toMatchObject({ code: 'tooLarge' })
  })

  it('keeps an off-canvas layer without pixels when cropping', async () => {
    const parsed = await read(await psdFixture(doc(4, 4, [{ name: 'Outside', bounds: { x: 5, y: 0, width: 2, height: 2 }, image: rgba(2, 2) }]), { composite: rgba(4, 4) }), 1)
    expect(parsed.layers[0].image).toBeNull()
    expect(parsed.layers[0].croppedToCanvas).toBe(true)
    expect((await makeImport(parsed, drawing)).conversions.some(c => c.layerName === 'Outside' && c.message.includes('Cropped to the canvas'))).toBe(true)
  })

  it('crops channels as full decodes would', () => {
    const width = 5, height = 4, plane = Uint8Array.from({ length: width * height }, (_, i) => i), crop = { x: 1, y: 1, width: 3, height: 2 }
    const sliced = (full: Uint8Array) => Array.from({ length: crop.height }, (_, r) => [...full.subarray((crop.y + r) * width + crop.x, (crop.y + r) * width + crop.x + crop.width)]).flat()
    expect([...decodeChannel(0, width, height, plane, false, crop)]).toEqual(sliced(decodeChannel(0, width, height, plane)))
    for (const large of [false, true]) {
      const counts = new Buffer(), rowsData = new Buffer()
      for (let row = 0; row < height; row++) { const packed = [width - 1, ...plane.subarray(row * width, (row + 1) * width)]; if (large) counts.u32(packed.length); else counts.u16(packed.length); rowsData.data(packed) }
      const packed = new Uint8Array([...counts.bytes, ...rowsData.bytes])
      expect([...decodeChannel(1, width, height, packed, large, crop)]).toEqual(sliced(decodeChannel(1, width, height, packed, large)))
    }
  })

  it('reads ZIP channels, with and without prediction', async () => {
    const { zlibSync } = await import('fflate')
    const width = 4, height = 2, plane = Uint8Array.from([10, 20, 30, 40, 5, 5, 6, 250])
    expect([...decodeChannel(2, width, height, zlibSync(plane))]).toEqual([...plane])
    const deltas = plane.map((v, i) => i % width === 0 ? v : (v - plane[i - 1]) & 255)
    expect([...decodeChannel(3, width, height, zlibSync(deltas))]).toEqual([...plane])
  })
})

// Browsers ship no CMYK profile and this repository carries none, so these use Ghostscript's where it's installed.
const cmykPath = '/usr/share/ghostscript/iccprofiles/default_cmyk.icc'
describe.skipIf(!existsSync(cmykPath))('CMYK Photoshop files', () => {
  // Its layers come in as RGB through the file's own profile: red as ink prints it (duller than screen red), gray as it is; the profile
  // comes with them.
  it('opens a layered CMYK file through its own profile', async () => {
    const profile = (await readProfile('default_cmyk.icc', new Uint8Array(readFileSync(cmykPath))))!
    const data = await psdFixture({ width: 8, height: 4, resolution: 300, cmykProfile: profile, layers: [{ name: 'Red', bounds: { x: 0, y: 0, width: 4, height: 4 }, image: colorImage(4, 4, 1, 0, 0) }, { name: 'Gray', bounds: { x: 4, y: 0, width: 4, height: 4 }, image: Raster.filled(4, 4, 4, [128, 128, 128, 255]) }] }, { composite: colorImage(8, 4, 1, 1, 1) })
    const document: PSDDocument = await read(data)
    expect(document.cmykProfile?.name).toBe(profile.name)
    expect(document.cmykProfile?.data.length).toBe(profile.data.length)
    expect(document.layers.map(l => l.name)).toEqual(['Red', 'Gray'])
    const printed = await fromInks(await toInks(new Uint8Array([255, 0, 0]), profile), profile), red = [...document.layers[0].image!.data.subarray(0, 4)]
    expect(red.slice(0, 3).every((v, i) => Math.abs(v - printed[i]) <= 3), `${red} against ${[...printed]}`).toBe(true)
    expect(red[0] < 250 || red[1] > 5, 'duller than screen red').toBe(true)
    const grayPixel = [...document.layers[1].image!.data.subarray(0, 4)]
    expect(grayPixel.slice(0, 3).every(v => Math.abs(v - 128) <= 4) && grayPixel[3] === 255, `${grayPixel}`).toBe(true)
  })

  it('reads a CMYK file without layers as its merged image', async () => {
    const profile = (await readProfile('default_cmyk.icc', new Uint8Array(readFileSync(cmykPath))))!
    const document = await read(await psdFixture({ width: 2, height: 2, resolution: 72, cmykProfile: profile, layers: [] }, { composite: Raster.filled(2, 2, 4, [128, 128, 128, 255]) }))
    expect([...document.merged!.data.subarray(0, 3)].every(v => Math.abs(v - 128) <= 4)).toBe(true)
  })
})
