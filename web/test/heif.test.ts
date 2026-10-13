import { describe, expect, it, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { loadKernels } from '../src/kernels'
import { decodeHEIF } from '../src/io/heif'

beforeAll(async () => { await loadKernels(readFileSync(new URL('../public/kernels.wasm', import.meta.url))) })

// Made with ImageMagick's libheif: a gradient, the same in Adobe RGB with its profile, and a gentle 10-bit gradient.
const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)))
describe('HEIF', () => {
  it('reads a photo, converts an embedded profile to sRGB, and keeps 10 bits at 16', async () => {
    const plain = await decodeHEIF(fixture('small.heic')), adobe = await decodeHEIF(fixture('small-adobergb.heic'))
    const at = (r: { image: { data: Uint8Array; width: number } }, x: number, y: number) => [...r.image.data.subarray((y * r.image.width + x) * 4, (y * r.image.width + x) * 4 + 3)]
    expect([plain.image.width, plain.deep === undefined]).toEqual([64, true])
    for (const [x, y] of [[32, 32], [5, 5], [60, 58]]) at(adobe, x, y).forEach((v, c) => expect(Math.abs(v - at(plain, x, y)[c]), `${x},${y}`).toBeLessThan(8))
    const deep = await decodeHEIF(fixture('gradient-10bit.heic'))
    expect(deep.deep?.hdr).toBe(false)
    expect(new Set([...deep.deep!.pixels].filter((_, i) => i % 4 === 0)).size).toBeGreaterThan(20)
  })
})
