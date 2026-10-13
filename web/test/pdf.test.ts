import { describe, expect, it } from 'vitest'
import { unzlibSync } from 'fflate'
import { pdfOfImage } from '../src/io/pdf'

describe('PDF export', () => {
  it('writes one page at the given size, its image losslessly, with a cross-reference table that points at each object', () => {
    const rgb = new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255, 9, 9, 9])
    const pdf = pdfOfImage(rgb, 2, 2, 144, 72.5)
    const text = new TextDecoder('latin1').decode(pdf)
    expect(text.startsWith('%PDF-1.4')).toBe(true)
    expect(text).toContain('/MediaBox [0 0 144 72.5]')
    const xref = +text.match(/startxref\n(\d+)/)![1]
    expect(text.slice(xref, xref + 4)).toBe('xref')
    const offsets = [...text.slice(xref).matchAll(/(\d{10}) 00000 n/g)].map(m => +m[1])
    offsets.forEach((offset, i) => expect(text.slice(offset, offset + 8)).toBe(`${i + 1} 0 obj\n`))
    const start = text.indexOf('stream\n', text.indexOf('/Subtype /Image')) + 7, length = +text.match(/\/FlateDecode \/Length (\d+)/)![1]
    expect([...unzlibSync(pdf.subarray(start, start + length))]).toEqual([...rgb])
  })
})
