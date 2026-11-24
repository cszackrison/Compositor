import { beforeAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { loadKernels } from '../src/kernels'
import { packBitsRow, psdNotes, psdSummary, writePSD } from '../src/io/psdWriter'
import { makeImport, readPSD, type PSDDrawing } from '../src/io/psd'
import { isPSD } from '../src/io/files'
import { Raster } from '../src/model/raster'
import { makeDeep } from '../src/model/deep'
import { fullTransform, newAdjustment, newLayer, type Doc, type LayerEffects } from '../src/model/types'

beforeAll(async () => { await loadKernels(readFileSync(new URL('../public/kernels.wasm', import.meta.url))) })

const drawing: PSDDrawing = {
  text: async () => ({ raster: Raster.filled(10, 10, 4, [0, 0, 0, 255]), baseline: 10 }),
  shape: (_style, w, h) => Raster.filled(w, h, 4, [0, 0, 0, 255]),
  path: (_c, _b, w, h) => Raster.filled(w, h, 4, [0, 0, 0, 255]),
  fontInstalled: async () => true,
}

describe('PSD export', () => {
  it('PackBits compresses runs and literals cleanly', () => {
    const row = new Uint8Array([7, 7, 7, 7, 1, 2, 3, 9, 9, 9])
    const packed = packBitsRow(row)
    expect(packed.length).toBeLessThan(row.length)
    // Decode PackBits back and verify exact match.
    const out: number[] = []
    for (let i = 0; i < packed.length;) {
      const h = packed[i] < 128 ? packed[i] : packed[i] - 256
      i++
      if (h >= 0) { for (let k = 0; k <= h; k++) out.push(packed[i++]) }
      else if (h !== -128) { const v = packed[i++]; for (let k = 0; k <= -h; k++) out.push(v) }
    }
    expect(new Uint8Array(out)).toEqual(row)
  })

  it('round-trips layers, folders, masks, clipping, blend modes and visibility', async () => {
    const folder = newLayer({ name: 'Group', isGroup: true, opacity: 0.75, transform: fullTransform(16, 16) })
    const base = newLayer({
      name: 'Base', parentId: folder.id, transform: fullTransform(8, 8, 2, 3),
      image: Raster.filled(8, 8, 4, [200, 100, 50, 255]),
      mask: Raster.filled(8, 8, 1, [128]),
      blendMode: 'Multiply', opacity: 0.5,
    })
    const clipped = newLayer({
      name: 'Clipped', parentId: folder.id, clipTo: base.id, transform: fullTransform(8, 8, 2, 3),
      image: Raster.filled(8, 8, 4, [0, 200, 0, 255]),
    })
    const hidden = newLayer({
      name: 'Hidden', visible: false, transform: fullTransform(4, 4, 10, 10),
      image: Raster.filled(4, 4, 4, [0, 0, 255, 255]),
      blendMode: 'Soft Light',
    })
    const doc: Doc = { id: 'D', width: 16, height: 16, resolution: 144, layers: [folder, base, clipped, hidden], guides: [], extra: {} }
    const composite = Raster.filled(16, 16, 4, [100, 50, 25, 255])

    const bytes = writePSD(doc, composite)
    expect(isPSD(bytes)).toBe(true)
    const parsed = await readPSD(bytes, drawing)
    expect(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(22)).toBe(8)
    expect([parsed.width, parsed.height, parsed.resolution]).toEqual([16, 16, 144])
    const imported = await makeImport(parsed, drawing)
    const groupOut = imported.layers.find(l => l.isGroup)!
    const baseOut = imported.layers.find(l => l.name === 'Base')!
    const clippedOut = imported.layers.find(l => l.name === 'Clipped')!
    const hiddenOut = imported.layers.find(l => l.name === 'Hidden')!
    expect(groupOut.name).toBe('Group')
    expect(Math.abs(groupOut.opacity - 0.75)).toBeLessThan(0.01)
    expect([baseOut.parentId, clippedOut.parentId]).toEqual([groupOut.id, groupOut.id])
    expect(baseOut.blendMode).toBe('Multiply')
    expect(Math.abs(baseOut.opacity - 0.5)).toBeLessThan(0.01)
    expect(baseOut.transform.origin).toEqual([2, 3])
    expect(baseOut.mask).not.toBeNull()
    expect(clippedOut.clipTo).toBe(baseOut.id)
    expect(hiddenOut.visible).toBe(false)
    expect(hiddenOut.blendMode).toBe('Soft Light')
  })

  it('reports text, effects and adjustment changes and omits adjustment layers', async () => {
    const textLayer = newLayer({ name: 'Title', text: { content: 'Hi' }, transform: fullTransform(8, 8), image: Raster.filled(8, 8, 4, [255, 255, 255, 255]) })
    const effectLayer = newLayer({
      name: 'Glow', transform: fullTransform(8, 8), image: Raster.filled(8, 8, 4, [255, 0, 0, 255]),
      effects: { colorOverlay: { red: 0, green: 1, blue: 0, opacity: 1 } } as LayerEffects,
    })
    const adj = newLayer({ name: 'Levels 1', adjustment: newAdjustment('Levels'), transform: fullTransform(8, 8) })
    const doc: Doc = { id: 'D', width: 8, height: 8, resolution: 72, layers: [textLayer, effectLayer, adj], guides: [], extra: {} }
    const notes = psdNotes(doc)
    expect(notes).toEqual([
      { layerName: 'Levels 1', change: 'adjustmentLeftOut' },
      { layerName: 'Glow', change: 'effectsAsPixels' },
      { layerName: 'Title', change: 'textAsPixels' },
    ])
    const summary = psdSummary(notes)!
    expect(summary).toContain('Text drawn as pixels: “Title”')
    expect(summary).toContain('Effects drawn into the pixels: “Glow”')
    expect(summary).toContain('Adjustment layers left out: “Levels 1”')

    const parsed = await readPSD(writePSD(doc, Raster.filled(8, 8, 4, [0, 255, 0, 255])), drawing)
    expect(parsed.layers.map(l => l.name)).toEqual(['Title', 'Glow'])
    // Color overlay was baked into Glow's pixels (now green instead of red).
    expect([...parsed.layers[1].image!.data.subarray(0, 4)]).toEqual([0, 255, 0, 255])
  })

  it('writes a 16-bit PSD when any layer is 16-bit', async () => {
    const data16 = new Uint16Array(4 * 4 * 4)
    for (let i = 0; i < 16; i++) data16.set([32768, 16384, 8192, 65535], i * 4)
    const { image, deep } = makeDeep(data16, 4, 4, false)
    const layer = newLayer({ name: 'Wide', transform: fullTransform(4, 4), image, deep })
    const doc: Doc = { id: 'D', width: 4, height: 4, resolution: 72, layers: [layer], guides: [], extra: {} }
    const bytes = writePSD(doc, image)
    expect(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(22)).toBe(16)
    const parsed = await readPSD(bytes, drawing)
    expect(parsed.layers[0].name).toBe('Wide')
    expect(parsed.layers[0].deep).not.toBeNull()
  })
})
