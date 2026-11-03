import { describe, expect, it } from 'vitest'
import { unzlibSync } from 'fflate'
import { decode } from 'fast-png'
import { Store } from '../src/editor/store'
import { Raster } from '../src/model/raster'
import { fullTransform, newLayer, type Doc, type Layer } from '../src/model/types'
import { type ChannelSource, channelPack, channelPlanes, defaultSource, isolatingChannel, packChannels } from '../src/io/channelPack'

const solid = (gray: number, alpha = 255, width = 8, height = 4) => Raster.filled(width, height, 4, [Math.round(gray * alpha / 255), Math.round(gray * alpha / 255), Math.round(gray * alpha / 255), alpha])

// The canvas as the app draws it, for layers at the canvas's size and Normal blending: each shown layer over the ones below.
function render(doc: Doc): Raster {
  const out = new Raster(doc.width, doc.height, 4), byId = new Map(doc.layers.map(l => [l.id, l]))
  const shown = (l: Layer): boolean => l.visible && (!l.parentId || shown(byId.get(l.parentId)!))
  for (const layer of doc.layers.filter(l => l.image && !l.isGroup && shown(l))) {
    const src = layer.image!.data, d = out.data
    for (let i = 0; i < d.length; i += 4) { const k = 1 - src[i + 3] / 255; for (let c = 0; c < 4; c++) d[i + c] = Math.round(src[i + c] + d[i + c] * k) }
  }
  return out
}
const nearest = (pixels: Raster, width: number, height: number) => {
  const out = new Raster(width, height, 4)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) out.data.set(pixels.data.subarray(((Math.floor(y * pixels.height / height) * pixels.width) + Math.floor(x * pixels.width / width)) * 4).subarray(0, 4), (y * width + x) * 4)
  return out
}
const pack = (doc: Doc, sources: ChannelSource[], width = doc.width, height = doc.height) => channelPack(sources, width, height, doc.resolution, id => render(isolatingChannel(doc, id)), nearest)

// The first pixel of a Channel Pack PNG exactly as stored, read from the file's own bytes; the file must decode too.
function firstPixel(png: Uint8Array) {
  expect(decode(png).width).toBeGreaterThan(0)
  const view = new DataView(png.buffer, png.byteOffset), types: string[] = []
  let offset = 8, stream = new Uint8Array()
  while (offset + 8 <= png.length) {
    const length = view.getUint32(offset), type = String.fromCharCode(...png.subarray(offset + 4, offset + 8))
    types.push(type)
    if (type === 'IDAT') stream = new Uint8Array([...stream, ...png.subarray(offset + 8, offset + 8 + length)])
    offset += 12 + length
  }
  expect(types).toEqual(['IHDR', 'sRGB', 'pHYs', 'IDAT', 'IEND'])
  const raw = unzlibSync(stream)
  expect(raw[0]).toBe(0)
  return [...raw.subarray(1, 5)]
}

function document(alpha: number): Doc {
  const layers = ([['Red', 51], ['Green', 153], ['Blue', 255], ['Alpha', alpha]] as const).map(([name, gray]) => newLayer({ name, transform: fullTransform(8, 4), image: solid(gray) }))
  return { id: 'D', width: 8, height: 4, resolution: 72, layers, guides: [], extra: {} }
}

describe('Channel Pack', () => {
  it('fills channels from layers named for them, keeping color under a fully transparent alpha', () => {
    const doc = document(0), sources = packChannels.map(c => defaultSource(c, doc.layers))
    expect(sources).toEqual(doc.layers.map(l => l.id))
    const packed = pack(doc, sources)
    expect(firstPixel(packed.png)).toEqual([51, 153, 255, 0])
    expect(decode(packed.png).resolution).toMatchObject({ x: 2835, y: 2835, unit: 1 })
    expect([...packed.preview.data.subarray(0, 4)]).toEqual([51, 153, 255, 255])
  })

  it('takes solid black and white, a hidden layer when it is picked, and another size', () => {
    const doc = document(128)
    doc.layers[0] = { ...doc.layers[0], visible: false }
    const packed = pack(doc, [doc.layers[0].id, 'black', 'white', 'white'], 4, 2)
    expect([packed.preview.width, packed.preview.height]).toEqual([4, 2])
    expect(firstPixel(packed.png)).toEqual([51, 0, 255, 255])
  })

  it('leaves color black and alpha white without named layers, and matches R/G/B/A in any case', () => {
    const layers = [newLayer({ name: 'Layer 1', transform: fullTransform(1, 1) })]
    expect(defaultSource('Red', layers)).toBe('black')
    expect(defaultSource('Alpha', layers)).toBe('white')
    const named = [newLayer({ name: ' g ', transform: fullTransform(1, 1) }), newLayer({ name: 'ALPHA', transform: fullTransform(1, 1) })]
    expect(defaultSource('Green', named)).toBe(named[0].id)
    expect(defaultSource('Alpha', named)).toBe(named[1].id)
  })

  it('reads a folder with its contents, shown even inside a hidden folder, and nothing else', () => {
    const outer = newLayer({ name: 'Outer', isGroup: true, visible: false, transform: fullTransform(8, 4) })
    const inner = newLayer({ name: 'Inner', isGroup: true, parentId: outer.id, transform: fullTransform(8, 4) })
    const child = newLayer({ name: 'Child', parentId: inner.id, transform: fullTransform(8, 4), image: solid(200) })
    const other = newLayer({ name: 'Other', transform: fullTransform(8, 4), image: solid(10) })
    const doc: Doc = { id: 'F', width: 8, height: 4, resolution: 72, layers: [outer, inner, child, other], guides: [], extra: {} }
    expect(isolatingChannel(doc, inner.id).layers.map(l => l.visible)).toEqual([true, true, true, false])
    expect(firstPixel(pack(doc, [inner.id, 'black', 'black', 'white']).png)).toEqual([200, 0, 0, 255])
  })
})

describe('Split Channels', () => {
  it('turns a layer into a folder of Red, Green, Blue and Alpha that Channel Pack packs back, and undoes', () => {
    const store = new Store()
    const texture = newLayer({ name: 'Texture', transform: fullTransform(8, 4), image: Raster.filled(8, 4, 4, [51, 153, 255, 255]) })
    store.open({ id: 'S', width: 8, height: 4, resolution: 72, layers: [texture], guides: [], extra: {} }, texture.id, null)
    expect(store.canSplitChannels).toBe(true)
    store.splitChannels()
    const layers = store.doc.layers
    expect(layers.map(l => l.name)).toEqual(['Texture', 'Alpha', 'Blue', 'Green', 'Red'])
    expect(layers[0].isGroup && layers.slice(1).every(l => l.parentId === layers[0].id)).toBe(true)
    expect(store.active?.name).toBe('Red')
    expect(store.canSplitChannels).toBe(true)
    store.setActive(layers[0].id)
    expect(store.canSplitChannels).toBe(false)

    const sources = packChannels.map(c => defaultSource(c, store.doc.layers))
    expect(firstPixel(pack(store.doc, sources).png)).toEqual([51, 153, 255, 255])

    store.undo()
    expect(store.doc.layers.map(l => l.name)).toEqual(['Texture'])
  })

  it('divides the color back out of the alpha, opaque gray each', () => {
    const planes = channelPlanes(Raster.filled(1, 1, 4, [26, 77, 128, 128]))
    expect(planes.map(p => [...p.data])).toEqual([[52, 52, 52, 255], [153, 153, 153, 255], [255, 255, 255, 255], [128, 128, 128, 255]])
  })
})
