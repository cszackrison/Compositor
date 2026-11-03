import { describe, expect, it } from 'vitest'
import { pdfPageName, pdfPageSize, pdfPageSizes, pdfResolution, tooLargeMessage } from '../src/io/pdfImport'
import { isImageFile, isPDF } from '../src/io/files'
import { maxSide } from '../src/model/types'
import { Raster } from '../src/model/raster'
import { Store } from '../src/editor/store'

// PDFImportTests.swift: the pages' sizes and names. Drawing them needs a browser's canvas, which Node hasn't got.

const letter = { width: 612, height: 792 }

describe('PDF import', () => {
  it('makes a new canvas at 300 DPI, so a Letter page is 2550 × 3300', () => {
    expect(pdfResolution).toBe(300)
    expect(pdfPageSize(letter)).toEqual({ width: 2550, height: 3300 })
    // Landscape, as a page's rotation turns it upright.
    expect(pdfPageSize({ width: 792, height: 612 })).toEqual({ width: 3300, height: 2550 })
  })

  it('fits pages to an open canvas, as an SVG is', () => {
    expect(pdfPageSize(letter, { width: 1000, height: 1000 })).toEqual({ width: 773, height: 1000 })
    expect(pdfPageSize({ width: 792, height: 612 }, { width: 1000, height: 1000 })).toEqual({ width: 1000, height: 773 })
    // Enlarged to fit too, as the page is drawn, not scaled.
    expect(pdfPageSize({ width: 100, height: 50 }, { width: 4000, height: 3000 })).toEqual({ width: 4000, height: 2000 })
  })

  it('names one page for the file, and several Page 1, Page 2', () => {
    expect(pdfPageName('Brochure', 1, 1)).toBe('Brochure')
    expect([1, 2, 3].map(n => pdfPageName('Brochure', n, 3))).toEqual(['Page 1', 'Page 2', 'Page 3'])
  })

  it('refuses pages beyond the side limit or the pixels left', () => {
    expect(() => pdfPageSizes([{ width: maxSide, height: 10 }])).toThrow(tooLargeMessage)
    expect(pdfPageSizes([letter, letter], undefined, 2550 * 3300 * 2)).toHaveLength(2)
    expect(() => pdfPageSizes([letter, letter], undefined, 2550 * 3300 * 2 - 1)).toThrow(tooLargeMessage)
  })

  it('takes a PDF by its type or its name', () => {
    expect(isPDF({ name: 'scan', type: 'application/pdf' }) && isPDF({ name: 'Scan.PDF', type: '' })).toBe(true)
    expect(isImageFile({ name: 'scan.pdf', type: '' }) && isImageFile({ name: 'scan', type: 'application/pdf' })).toBe(true)
    expect(isPDF({ name: 'scan.png', type: 'image/png' })).toBe(false)
  })

  it('puts the pages in an open canvas with page 1 on top, as one step', () => {
    const store = new Store()
    store.open({ id: 'd', width: 40, height: 20, resolution: 72, layers: [], guides: [], extra: {} }, null, null)
    store.addImageLayers([1, 2, 3].map(n => ({ image: Raster.filled(10, 20, 4, [n, 0, 0, 255]), name: `Page ${n}` })), [10, 10])
    expect(store.doc.layers.map(l => l.name)).toEqual(['Page 3', 'Page 2', 'Page 1'])
    expect(store.doc.layers.map(l => l.transform.origin)).toEqual([[5, 0], [5, 0], [5, 0]])
    expect(store.state.activeId).toBe(store.doc.layers[2].id)
    store.undo()
    expect(store.doc.layers).toEqual([])
  })
})
