import { Raster, premultiply } from '../model/raster'
import { documentPixelBudget, maxSide } from '../model/types'

// A PDF's pages drawn into pixels (ImageImporter.decodePDF) with PDF.js (pdfjs-dist, Apache-2.0, loaded the first time one is opened),
// one image a page in page order: each fitted to the canvas when one is open, as an SVG is, otherwise at `pdfResolution`. Text and
// vectors become pixels, and the paper stays see-through, as in Photoshop. Its decoders for JPEG 2000 and JBIG2 images, the standard
// fonts and the CJK character maps are copied beside the build (vite.config.ts) and fetched only by a file that needs them.

// Pages make a new canvas at this resolution: sharp enough to print, and a Letter page 2550 × 3300.
export const pdfResolution = 300

export const tooLargeMessage = `This import exceeds the current ${Math.floor(documentPixelBudget / 1_000_000)}-megapixel document budget or ${maxSide.toLocaleString('en-US')}-pixel side limit.`
export const lockedMessage = 'This PDF is password-protected. Save an unlocked copy, then import that.'

// A page's size in pixels from its size in points, turned upright: fitted within `fitting`, or at `pdfResolution`.
export function pdfPageSize(points: { width: number; height: number }, fitting?: { width: number; height: number }) {
  const scale = fitting ? Math.min(fitting.width / points.width, fitting.height / points.height) : pdfResolution / 72
  return { width: Math.round(points.width * scale), height: Math.round(points.height * scale) }
}

// One page's layer is named for the file; several are Page 1, Page 2 and on.
export const pdfPageName = (file: string, page: number, count: number) => count === 1 ? file : `Page ${page}`

// The pages' sizes in order, each within the side limit, all within `remainingPixels`; otherwise the import is too large.
export function pdfPageSizes(pages: { width: number; height: number }[], fitting?: { width: number; height: number }, remainingPixels = documentPixelBudget) {
  let remaining = remainingPixels
  return pages.map(points => {
    const size = pdfPageSize(points, fitting)
    if (!(size.width >= 1 && size.height >= 1 && size.width <= maxSide && size.height <= maxSide && size.width * size.height <= remaining)) throw new Error(tooLargeMessage)
    remaining -= size.width * size.height
    return size
  })
}

let library: Promise<typeof import('pdfjs-dist')> | null = null
const pdfjs = () => library ??= Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url')]).then(([module, worker]) => { module.GlobalWorkerOptions.workerSrc = worker.default; return module })

export async function decodePDF(file: Blob, name: string, fitting?: { width: number; height: number }, remainingPixels = documentPixelBudget): Promise<{ image: Raster; name: string }[]> {
  const lib = await pdfjs(), assets = new URL(import.meta.env.DEV ? '/node_modules/pdfjs-dist/' : `./pdfjs-${lib.version}/`, document.baseURI).href
  const loading = lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()), wasmUrl: `${assets}wasm/`, standardFontDataUrl: `${assets}standard_fonts/`, cMapUrl: `${assets}cmaps/`, cMapPacked: true })
  const pdf = await loading.promise.catch((error: Error) => { throw new Error(error?.name === 'PasswordException' ? lockedMessage : 'This PDF could not be read. It may be damaged or unavailable.') })
  try {
    if (!pdf.numPages) throw new Error('This PDF has no pages.')
    const pages = await Promise.all(Array.from({ length: pdf.numPages }, (_, i) => pdf.getPage(i + 1)))
    const sizes = pdfPageSizes(pages.map(page => page.getViewport({ scale: 1 })), fitting, remainingPixels)
    const images: { image: Raster; name: string }[] = []
    for (const [i, page] of pages.entries()) {
      const { width, height } = sizes[i], points = page.getViewport({ scale: 1 }), viewport = page.getViewport({ scale: width / points.width })
      const canvas = Object.assign(document.createElement('canvas'), { width, height })
      try {
        // The page's crop box, turned upright, stretched the fraction of a pixel rounding left to fill the canvas exactly. Given its
        // canvas rather than a context, PDF.js would draw on an opaque one, losing the see-through paper.
        const context = canvas.getContext('2d', { willReadFrequently: true })!
        await page.render({ canvas: null, canvasContext: context, viewport, background: 'rgba(0,0,0,0)', transform: [1, 0, 0, height / viewport.height, 0, 0] }).promise
        const data = context.getImageData(0, 0, width, height).data
        images.push({ image: new Raster(width, height, 4, premultiply(new Uint8Array(data.buffer))), name: pdfPageName(name, i + 1, pdf.numPages) })
      } finally { canvas.width = canvas.height = 0; page.cleanup() }
    }
    return images
  } finally { await loading.destroy() }
}
