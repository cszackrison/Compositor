import { describe, expect, it } from 'vitest'
import { GIFSource, decodeGIF, encodeGIF, exportSchedule, framePositionAt } from '../src/io/gif'
import { Raster } from '../src/model/raster'
import { deleteFrame, duplicateFrame, frameDelays, frameRaster, frameReferences, frameSize, gifFrames, openGIF, readGIF, resizeGIF, setFrameDelay, setFramePixels, setUniformDelay, useOriginalDelays, writeGIF } from '../src/model/gif'
import { fullTransform } from '../src/model/types'

const pixel = (r: Raster, x: number, y: number) => [...r.data.subarray((y * r.width + x) * 4, (y * r.width + x) * 4 + 4)]
const near = (a: number[], b: number[], tolerance: number) => a.every((v, i) => Math.abs(v - b[i]) <= tolerance)

// A gradient with far more than 256 colors, a solid frame with a clear hole, and a half-covered frame.
function frames() {
  const gradient = new Raster(40, 30, 4)
  for (let y = 0; y < 30; y++) for (let x = 0; x < 40; x++) gradient.data.set([Math.round(x * 255 / 39), Math.round(y * 255 / 29), 128, 255], (y * 40 + x) * 4)
  const holed = Raster.filled(40, 30, 4, [0, 0, 255, 255])
  for (let y = 10; y < 20; y++) for (let x = 10; x < 20; x++) holed.data.set([0, 0, 0, 0], (y * 40 + x) * 4)
  const soft = Raster.filled(40, 30, 4, [100, 50, 0, 200])
  for (let x = 0; x < 40; x++) soft.data.set([10, 10, 10, 60], x * 4)
  return [{ image: gradient, delay: 0.04 }, { image: holed, delay: 0.16 }, { image: soft, delay: 0.5 }]
}

// A GIF written by hand: LZW with a clear code before every two pixels, so codes stay three bits wide.
function handGIF(width: number, height: number, palette: number[][], list: { left: number; top: number; width: number; height: number; indices: number[]; disposal: number; transparent?: number; delay?: number; interlaced?: boolean }[]) {
  const out = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61, width & 255, width >> 8, height & 255, height >> 8, 0x81, 0, 0]
  for (let i = 0; i < 4; i++) out.push(...(palette[i] ?? [0, 0, 0]))
  for (const f of list) {
    const delay = f.delay ?? 10
    out.push(0x21, 0xf9, 4, f.disposal << 2 | (f.transparent !== undefined ? 1 : 0), delay & 255, delay >> 8, f.transparent ?? 0, 0)
    out.push(0x2c, f.left, 0, f.top, 0, f.width, 0, f.height, 0, f.interlaced ? 0x40 : 0, 2)
    const codes: number[] = []
    for (let i = 0; i < f.indices.length; i += 2) codes.push(4, ...f.indices.slice(i, i + 2))
    codes.push(5)
    const bytes: number[] = []
    let current = 0, bits = 0
    for (const code of codes) { current |= code << bits; bits += 3; while (bits >= 8) { bytes.push(current & 255); current >>= 8; bits -= 8 } }
    if (bits) bytes.push(current & 255)
    out.push(bytes.length, ...bytes, 0)
  }
  out.push(0x3b)
  return new Uint8Array(out)
}

describe('GIF files', () => {
  it('encodes frames and decodes them back with their sizes, delays and colors', () => {
    const bytes = encodeGIF(frames())
    const decoded = decodeGIF(bytes)
    expect([decoded.width, decoded.height, decoded.loopCount, decoded.frames.length]).toEqual([40, 30, 0, 3])
    expect(decoded.frames.map(f => f.delay)).toEqual([0.04, 0.16, 0.5])
    const [gradient, holed, soft] = decoded.frames.map(f => f.image), source = frames()[0].image
    let worst = 0
    for (let i = 0; i < source.data.length; i++) worst = Math.max(worst, Math.abs(source.data[i] - gradient.data[i]))
    expect(worst).toBeLessThanOrEqual(12)
    expect(pixel(holed, 0, 0)).toEqual([0, 0, 255, 255])
    expect(pixel(holed, 15, 15)).toEqual([0, 0, 0, 0])
    expect(near(pixel(soft, 5, 5), [128, 64, 0, 255], 1)).toBe(true)
    expect(pixel(soft, 5, 0)).toEqual([0, 0, 0, 0])
  })

  it('flattens over a color and writes no loop when asked', () => {
    const decoded = decodeGIF(encodeGIF(frames(), { keepsTransparency: false, loopsForever: false, background: { red: 1, green: 0, blue: 0 } }))
    expect(decoded.loopCount).toBe(null)
    expect(pixel(decoded.frames[1].image, 15, 15)).toEqual([255, 0, 0, 255])
    expect(near(pixel(decoded.frames[2].image, 5, 5), [100 + 55, 50, 0, 255], 1)).toBe(true)
  })

  it('composes frames through each disposal method', () => {
    const red = Array(16).fill(1), blue = [2, 2, 2, 2]
    const make = (disposal: number) => new GIFSource(handGIF(4, 4, [[0, 0, 0], [255, 0, 0], [0, 0, 255]], [
      { left: 0, top: 0, width: 4, height: 4, indices: red, disposal },
      { left: 1, top: 1, width: 2, height: 2, indices: blue, disposal: 0 },
      { left: 0, top: 0, width: 1, height: 1, indices: [0], disposal: 0, transparent: 0 },
    ]))
    const kept = make(1).frame(1), cleared = make(2).frame(1)
    expect([pixel(kept, 0, 0), pixel(kept, 1, 1)]).toEqual([[255, 0, 0, 255], [0, 0, 255, 255]])
    expect([pixel(cleared, 0, 0), pixel(cleared, 1, 1), pixel(cleared, 3, 3)]).toEqual([[0, 0, 0, 0], [0, 0, 255, 255], [0, 0, 0, 0]])
    // Restore to previous: the second frame (drawn after the cleared first) goes, so the third shows only what came before it.
    const restoring = new GIFSource(handGIF(4, 4, [[0, 0, 0], [255, 0, 0], [0, 0, 255]], [
      { left: 0, top: 0, width: 4, height: 4, indices: red, disposal: 1 },
      { left: 1, top: 1, width: 2, height: 2, indices: blue, disposal: 3 },
      { left: 0, top: 0, width: 1, height: 1, indices: [0], disposal: 0, transparent: 0 },
    ]))
    expect(pixel(restoring.frame(2), 1, 1)).toEqual([255, 0, 0, 255])
    expect(pixel(restoring.frame(1), 1, 1)).toEqual([0, 0, 255, 255])
    expect(pixel(restoring.frame(2), 1, 1)).toEqual([255, 0, 0, 255])
  })

  it('reads interlaced rows and applies the minimum delay', () => {
    // Rows stored in interlaced order: 0, 4, 2, 6, 1, 3, 5, 7.
    const stored = [0, 4, 2, 6, 1, 3, 5, 7].map(row => row % 2 ? 1 : 2)
    const source = new GIFSource(handGIF(1, 8, [[0, 0, 0], [255, 0, 0], [0, 255, 0]], [
      { left: 0, top: 0, width: 1, height: 8, indices: stored, disposal: 0, interlaced: true, delay: 0 },
      { left: 0, top: 0, width: 1, height: 8, indices: Array(8).fill(1), disposal: 0, delay: 1 },
    ]))
    const frame = source.frame(0)
    expect([0, 1, 2, 3].map(y => pixel(frame, 0, y))).toEqual([[0, 255, 0, 255], [255, 0, 0, 255], [0, 255, 0, 255], [255, 0, 0, 255]])
    expect(source.delays).toEqual([0.1, 0.02])
  })

  it('schedules several tracks on one clock', () => {
    const { frames: out, starts } = exportSchedule([[0.04, 0.16], [0.1, 0.1]])
    expect(out.map(f => [f.start, f.ticks])).toEqual([[0, 4], [4, 6], [10, 10]])
    expect(out.map(f => framePositionAt(starts[0], f.sample))).toEqual([0, 1, 1])
    expect(out.map(f => framePositionAt(starts[1], f.sample))).toEqual([0, 0, 1])
  })
})

describe('GIF layers', () => {
  it('duplicates, edits, retimes and deletes frames, and survives saving', () => {
    let data = openGIF(encodeGIF(frames()))
    expect(gifFrames(data).map(f => f.index)).toEqual([0, 1, 2])
    expect(data.timing.uniformDelay).toBeCloseTo((0.04 + 0.16 + 0.5) / 3)
    data = duplicateFrame(data, 1)!
    expect(frameReferences(data)).toEqual([{ index: 0, sourceIndex: 0 }, { index: 1, sourceIndex: 1 }, { index: 3, sourceIndex: 1 }, { index: 2, sourceIndex: 2 }])
    expect(data.selectedFrameIndex).toBe(3)
    const painted = Raster.filled(40, 30, 4, [0, 128, 0, 255])
    data = setFramePixels(data, 3, painted)
    data = setFrameDelay(data, 3, 0.3)!
    expect(frameDelays(data)).toEqual([0.04, 0.16, 0.3, 0.5])
    data = deleteFrame(data, 0)!
    expect(data.deletedFrameIndices.has(0)).toBe(true)
    data = setUniformDelay(data, 0.25)!
    expect(frameDelays(data)).toEqual([0.25, 0.25, 0.25])
    expect(useOriginalDelays(data) && frameDelays(useOriginalDelays(data)!)).toEqual([0.16, 0.3, 0.5])
    const id = 'A1B2C3D4-0000-4000-8000-000000000000'
    const { gif, files } = writeGIF(data, id)
    expect([...files.keys()].sort()).toEqual([`images/${id}.frame-3.png`, `images/${id}.gif`])
    const read = readGIF(JSON.parse(JSON.stringify(gif)), files, id)
    expect(frameReferences(read)).toEqual(frameReferences(data))
    expect([read.selectedFrameIndex, read.timing.mode, read.timing.uniformDelay, [...read.timing.frameDelays]]).toEqual([3, 'Same for all', 0.25, [[3, 0.3]]])
    expect(pixel(frameRaster(read, 3), 5, 5)).toEqual([0, 128, 0, 255])
    expect(pixel(frameRaster(read, 1), 0, 0)).toEqual([0, 0, 255, 255])
    expect(read.source.bytes).toBe(data.source.bytes)
    expect(deleteFrame(deleteFrame(read, 1)!, 3)!.selectedFrameIndex).toBe(2)
    expect(deleteFrame(deleteFrame(deleteFrame(read, 1)!, 3)!, 2)).toBe(null)
  })

  it('rejects a project whose GIF record doesn\'t fit its files', () => {
    const id = 'A1B2C3D4-0000-4000-8000-000000000001', data = setFramePixels(openGIF(encodeGIF(frames())), 0, Raster.filled(40, 30, 4, [1, 2, 3, 255]))
    const { gif, files } = writeGIF(data, id)
    expect(() => readGIF({ ...gif, sourceFile: 'other.gif' }, files, id)).toThrow()
    expect(() => readGIF({ ...gif, selectedFrameIndex: 7 }, files, id)).toThrow()
    expect(() => readGIF({ ...gif, deletedFrameIndices: [0, 1, 2] }, files, id)).toThrow()
    expect(() => readGIF({ ...gif, frameOrder: [{ index: 0, sourceIndex: 1 }] }, files, id)).toThrow()
    expect(() => readGIF({ ...gif, timing: { mode: 'Same for all', uniformDelay: 0.001, frameDelays: [] } }, files, id)).toThrow()
    expect(() => readGIF({ ...gif, geometry: { width: 20, height: 15, a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 } }, files, id)).toThrow()
    expect(() => readGIF(gif, new Map([...files].filter(([k]) => k.endsWith('.gif'))), id)).toThrow()
  })

  it('resizes through the geometry, sampling the source lazily', () => {
    let data = openGIF(encodeGIF(frames()))
    data = resizeGIF(data, fullTransform(40, 30), { ...fullTransform(20, 15), sampling: 'Nearest' }, 0.5, 0.5)
    expect(frameSize(data)).toEqual({ width: 20, height: 15 })
    const holed = frameRaster(data, 1)
    expect([holed.width, holed.height]).toEqual([20, 15])
    expect([pixel(holed, 0, 0), pixel(holed, 7, 7), pixel(holed, 2, 9)]).toEqual([[0, 0, 255, 255], [0, 0, 0, 0], [0, 0, 255, 255]])
    const smooth = frameRaster(resizeGIF(openGIF(encodeGIF(frames())), fullTransform(40, 30), fullTransform(20, 15), 0.5, 0.5), 1)
    expect(pixel(smooth, 4, 4)).toEqual([0, 0, 255, 255])
    expect(pixel(smooth, 7, 7)).toEqual([0, 0, 0, 0])
    const { gif, files } = writeGIF(data, 'X')
    expect(frameSize(readGIF(gif, files, 'X'))).toEqual({ width: 20, height: 15 })
  })
})
