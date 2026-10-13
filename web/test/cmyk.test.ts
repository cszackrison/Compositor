import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { flatten, fromInks, jpegColor, openCMYK, proofLookups, proofSize, readProfile, toInks, type CMYKProfile } from '../src/io/cmyk'
import { encodeTIFF } from '../src/io/tiff'
import { encodeCMYKJPEG } from '../src/io/jpeg'
import { pdfOfImage } from '../src/io/pdf'
import { Raster } from '../src/model/raster'

// Browsers ship no CMYK profile and this repository carries none, so these use Ghostscript's where it's installed.
const cmykPath = '/usr/share/ghostscript/iccprofiles/default_cmyk.icc', rgbPath = '/usr/share/ghostscript/iccprofiles/srgb.icc'
const profile = async () => (await readProfile('default_cmyk.icc', new Uint8Array(readFileSync(cmykPath))))!

// CMYKTests.swift's cases, through LittleCMS.
describe.skipIf(!existsSync(cmykPath))('CMYK', () => {
  it('reads CMYK profiles and turns others down', async () => {
    const p = await profile()
    expect(p.name.length).toBeGreaterThan(0)
    if (existsSync(rgbPath)) expect(await readProfile('srgb.icc', new Uint8Array(readFileSync(rgbPath)))).toBeNull()
  })

  it('proofs: mid gray prints as it is, saturated blue comes back duller and the gamut warning marks it', async () => {
    const lookups = await proofLookups(await profile()), n = proofSize
    const entry = (data: Float32Array, r: number, g: number, b: number) => { const i = ((b * n + g) * n + r) * 4; return [data[i], data[i + 1], data[i + 2]] }
    const gray = entry(lookups.proof, 16, 16, 16)
    expect(gray.every(v => Math.abs(v - 0.5) < 0.04), `${gray}`).toBe(true)
    const blue = entry(lookups.proof, 0, 0, n - 1)
    expect(blue[2] < 0.95 || blue[0] > 0.05, `${blue}`).toBe(true)
    expect(entry(lookups.warning, 0, 0, n - 1)).toEqual([0.5, 0.5, 0.5])
    expect(entry(lookups.warning, 16, 16, 16)).toEqual(gray)
    expect(entry(lookups.marked, 0, 0, n - 1)).toEqual([0.5, 0.5, 0.5])
    expect(entry(lookups.marked, n - 1, n - 1, n - 1)).toEqual([1, 1, 1])
  })

  it('converts to inks over the paper and back', async () => {
    const p: CMYKProfile = await profile(), pixels = new Raster(2, 1, 4, new Uint8Array([128, 128, 128, 255, 0, 0, 0, 0]))
    const rgb = flatten(pixels, [255, 255, 255])
    expect([...rgb]).toEqual([128, 128, 128, 255, 255, 255])
    const inks = await toInks(rgb, p)
    expect(inks.length).toBe(8)
    expect([...inks.subarray(4)].every(v => v <= 2), 'paper takes no ink').toBe(true)
    const back = await fromInks(inks, p)
    expect([...back.subarray(0, 3)].every(v => Math.abs(v - 128) <= 6), `${back}`).toBe(true)
  })

  it('writes CMYK TIFF, JPEG and PDF with the profile', async () => {
    const p = await profile(), inks = await toInks(new Uint8Array(16 * 16 * 3).fill(128), p)
    const tiff = encodeTIFF({ width: 16, height: 16, samples: inks, cmyk: true, icc: p.data, resolution: 300 })
    const UTIF = (await import('utif')).default as typeof import('utif'), [ifd] = UTIF.decode(tiff.slice().buffer)
    expect([(ifd.t262 as unknown as number[])[0], (ifd.t277 as unknown as number[])[0], (ifd.t34675 as unknown as Uint8Array).length]).toEqual([5, 4, p.data.length])
    const jpeg = encodeCMYKJPEG(inks, 16, 16, 0.9, p.data), text = String.fromCharCode(...jpeg.subarray(0, 64))
    expect([jpeg[0], jpeg[1], jpeg.at(-2), jpeg.at(-1)]).toEqual([0xff, 0xd8, 0xff, 0xd9])
    expect(text.includes('Adobe')).toBe(true)
    const pdf = new TextDecoder('latin1').decode(pdfOfImage(inks, 16, 16, 72, 72, p.data))
    expect(pdf.includes('/ICCBased') && pdf.includes('/N 4')).toBe(true)
  })
})

describe.skipIf(!existsSync(cmykPath))('Opening CMYK', () => {
  it('opens a CMYK TIFF through its own profile', async () => {
    const p = await profile(), inks = await toInks(new Uint8Array([200, 60, 40, 30, 120, 220]), p)
    const opened = await openCMYK(new Blob([encodeTIFF({ width: 2, height: 1, samples: inks, cmyk: true, icc: p.data }) as BlobPart]))
    expect(opened?.profile.data).toEqual(p.data)
    const back = await fromInks(inks, p)
    expect([...opened!.image.data]).toEqual([...back.subarray(0, 3), 255, ...back.subarray(3), 255])
  })

  it('finds a JPEG’s inks and its profile', async () => {
    const p = await profile(), jpeg = encodeCMYKJPEG(new Uint8Array(8 * 8 * 4).fill(60), 8, 8, 0.9, p.data)
    const color = jpegColor(jpeg)
    expect(color?.cmyk).toBe(true)
    expect(color?.icc).toEqual(p.data)
    expect(jpegColor(encodeCMYKJPEG(new Uint8Array(8 * 8 * 4), 8, 8))).toEqual({ cmyk: true })
    expect(await openCMYK(new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])]))).toBeNull()
  })
})

describe('TIFF', () => {
  it('writes RGB with transparency that reads back', async () => {
    const samples = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 0, 10, 20, 30, 255])
    const tiff = encodeTIFF({ width: 2, height: 2, samples, alpha: true, resolution: 144 })
    const UTIF = (await import('utif')).default as typeof import('utif'), [ifd] = UTIF.decode(tiff.slice().buffer)
    UTIF.decodeImage(tiff.slice().buffer, ifd)
    expect([...UTIF.toRGBA8(ifd)]).toEqual([...samples])
    expect((ifd.t282 as unknown as number[])[0]).toBe(144)
  })
})
