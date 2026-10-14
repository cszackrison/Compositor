import { savingProject, watchProject, watching } from '../io/watch'
import { isRAW } from '../io/raw'
import { encode } from 'fast-png'
import { floatsToDeep, unpremultiplied16 } from '../model/deep'
import { commitFloating } from './floating'
import { Store, activateTab, closeTab, store, tabForOpening, tabs } from './store'
import { forgetRecent, noteRecent, type Recent } from '../io/recent'
import { deleteFromBrowser, readFromBrowser, saveToBrowser, type BrowserProject } from '../io/browserProjects'
import { canWriteDirectories, download, filesInHandle, isPSD, imagesIn, projectFolder, readDirectoryHandle, readFileList, rootedAtManifest, unzipPackage, writeDirectory, zipPackage, type PackageFiles, type PackageTarget } from '../io/files'
import { readProject, writeProject } from '../io/project'
import { pdfOfImage } from '../io/pdf'
import { encodeEXR } from '../io/exr'
import { encodeTIFF } from '../io/tiff'
import { encodeCMYKJPEG } from '../io/jpeg'
import { flatten, fromInks, toInks, type CMYKProfile } from '../io/cmyk'
import { type LinearImage, Raster, decodeLayerFile, encodePNG, resizeLinear } from '../model/raster'
import { type Doc, type Layer, documentPixelBudget, fullTransform, newLayer, uuid, maxSide } from '../model/types'
import type { PSDConversion, PSDImport } from '../io/psd'
import { renderFull } from '../ui/Stage'

function guard<T extends unknown[]>(body: (...args: T) => Promise<void> | void) {
  return async (...args: T) => {
    try { await body(...args) } catch (error) {
      if ((error as Error).name === 'AbortError') return
      console.error(error)
      store.notify((error as Error).message || String(error))
    }
  }
}

// Closes a tab, asking first when its project has unsaved changes.
// The unsaved-changes prompt, answered from its dialog: Save, Don't Save or Cancel.
export type UnsavedChoice = 'save' | 'discard' | 'cancel'
let answer: ((choice: UnsavedChoice) => void) | null = null
export function answerUnsaved(choice: UnsavedChoice) { const settle = answer; answer = null; settle?.(choice) }

// Closes a project's tab, first asking whether to save its changes. False when it stays open.
export async function closeProject(target: Store = store): Promise<boolean> {
  if (target.hasDocument && !target.state.saved) {
    answerUnsaved('cancel')
    activateTab(target)
    const choice = await new Promise<UnsavedChoice>(resolve => { answer = resolve; target.set({ panel: 'Unsaved Changes' }) })
    if (target.state.panel === 'Unsaved Changes') target.set({ panel: null })
    if (choice === 'cancel') return false
    if (choice === 'save') { await save(); if (!target.state.saved) return false }
  }
  closeTab(target)
  return true
}

// A project's name: its file's, or for one never saved "Untitled", else the lowest "Untitled N" no other tab shows, as Finder and Safari
// number them.
export function documentName(of: Store = store) {
  if (of.state.target) return of.state.target.name.replace(/\.comp$/, '')
  if (!of.untitled) {
    const taken = new Set(tabs.filter(tab => tab !== of && tab.hasDocument && !tab.state.target).map(tab => tab.untitled))
    let n = 1
    while (taken.has(n === 1 ? 'Untitled' : `Untitled ${n}`)) n++
    of.untitled = n === 1 ? 'Untitled' : `Untitled ${n}`
  }
  return of.untitled
}

export const newCanvas = guard((width: number, height: number, fill: 'white' | 'black' | 'transparent', resolution: number = 72) => {
  width = Math.round(Math.min(maxSide, Math.max(1, width))); height = Math.round(Math.min(maxSide, Math.max(1, height)))
  const color = fill === 'white' ? [255, 255, 255, 255] : fill === 'black' ? [0, 0, 0, 255] : [0, 0, 0, 0]
  const layer = newLayer({ name: fill === 'transparent' ? 'Layer 1' : 'Background', transform: fullTransform(width, height), image: Raster.filled(width, height, 4, color) })
  const doc: Doc = { id: uuid(), width, height, resolution, layers: [layer], guides: [], extra: {} }
  tabForOpening().open(doc, layer.id, null)
})

export const openFiles = guard(async (files: PackageFiles, target: PackageTarget) => {
  const { doc, activeId } = await readProject(files)
  const tab = tabForOpening()
  tab.open(doc, activeId, target)
  if (target.kind === 'directory') { noteRecent(target.handle); watchProject(tab, target.handle, files) }
})

export const openProject = guard(async () => {
  if (canWriteDirectories) {
    const picked: FileSystemDirectoryHandle = await (window as any).showDirectoryPicker({ id: 'compositor-projects', mode: 'readwrite' })
    const handle = await projectFolder(picked)
    if (!handle) throw new Error('No manifest.json found. Choose a .comp project folder.')
    await openFiles(rootedAtManifest(await readDirectoryHandle(handle)), { kind: 'directory', handle, name: handle.name })
    return
  }
  const input = Object.assign(document.createElement('input'), { type: 'file' })
  input.setAttribute('webkitdirectory', '')
  input.onchange = () => input.files?.length && guard(async () => openFiles(await readFileList(input.files!), { kind: 'download', name: input.files![0].webkitRelativePath.split('/')[0] }))()
  input.click()
})

// Opens an image as a new document when nothing is open, or places it as a layer. A Photoshop file brings its layers. Dropped on the
// canvas, each is centered where it was dropped (`at`, in document pixels).
export const placeImages = guard(async (files: File[], at?: [number, number]) => {
  for (const file of files) {
    const name = file.name.replace(/\.[^.]+$/, '')
    if (isPSD(new Uint8Array(await file.slice(0, 4).arrayBuffer()))) { await placePhotoshop(file, name, at); continue }
    // A camera RAW is developed first, in its sheet; cancelled, it's skipped.
    const developed = isRAW(file.name) ? await (await import('../ui/RawDevelop')).developRaw(file) : null
    if (isRAW(file.name) && !developed) continue
    const { image, deep, profile }: Awaited<ReturnType<typeof decodeLayerFile>> = developed ?? await decodeLayerFile(file, store.hasDocument ? store.state.doc : undefined)
    await placeImage(image, name, deep, profile, at)
  }
})

async function placeImage(image: Raster, name: string, deep?: Layer['deep'], profile?: CMYKProfile | null, at?: [number, number]) {
  if (!store.hasDocument) {
    // A CMYK file starting a project: its profile is kept and chosen, so proofing and CMYK export go back to the inks it was made for.
    if (profile) await (await import('../io/cmyk')).adoptProfile(profile)
    const layer = newLayer({ name, transform: fullTransform(image.width, image.height), image, deep })
    store.open({ id: uuid(), width: image.width, height: image.height, resolution: 72, layers: [layer], guides: [], extra: {} }, layer.id, null)
    store.set({ target: { kind: 'download', name } })
  } else store.addImageLayer(image, name, deep, at)
}

// The Photoshop conversion report (PSDConversionSheet.swift): up while the file is read, so a big one doesn't leave the click unanswered,
// then what will be converted, or taken away when there is nothing to report. Nothing is applied until Import.
export type ConversionRequest = { title: string; conversions: PSDConversion[]; reading: boolean }
let conversion: { request: ConversionRequest; owner: Store; settle: ((confirmed: boolean) => void) | null; cancelled: boolean } | null = null
const conversionListeners = new Set<() => void>()
export const conversionRequest = () => conversion?.request ?? null
export function subscribeConversion(listener: () => void) { conversionListeners.add(listener); return () => { conversionListeners.delete(listener) } }
const conversionChanged = () => conversionListeners.forEach(listener => listener())
const hideConversion = (owner: Store) => { if (owner.state.panel === 'Photoshop Conversion') owner.set({ panel: null }) }

function beginPSDReading(title: string) {
  conversion = { request: { title, conversions: [], reading: true }, owner: store, settle: null, cancelled: false }
  store.set({ panel: 'Photoshop Conversion' })
  conversionChanged()
}
// Takes the report away without an answer: nothing to report, or the read failed.
function endPSDReading() {
  if (!conversion || conversion.settle) return
  const { owner } = conversion
  conversion = null
  hideConversion(owner)
  conversionChanged()
}
function finishPSDReading(conversions: PSDConversion[]): Promise<boolean> {
  const current = conversion
  if (!current || current.cancelled) { endPSDReading(); return Promise.resolve(false) }
  if (!conversions.length) { endPSDReading(); return Promise.resolve(true) }
  return new Promise(resolve => { current.settle = resolve; current.request = { ...current.request, conversions, reading: false }; conversionChanged() })
}
// Import or Cancel; cancelling while the file is still being read drops it once it's read.
export function answerConversion(confirmed: boolean) {
  const current = conversion
  if (!current) return
  if (!current.settle) { if (!confirmed) { current.cancelled = true; hideConversion(current.owner) } return }
  conversion = null
  hideConversion(current.owner)
  conversionChanged()
  current.settle(confirmed)
}

// A Photoshop file's layers (EditorSession.drainImports), after the conversion report; one with no layer records comes in as its
// merged image, like any other picture.
async function placePhotoshop(file: File, name: string, at?: [number, number]) {
  const { readPSD, makeImport } = await import('../io/psd'), { canvasDrawing } = await import('../io/psdDrawing')
  const used = store.hasDocument ? store.doc.layers.reduce((total, layer) => total + (layer.image ? layer.image.width * layer.image.height : 0), 0) : 0
  beginPSDReading(`Open “${file.name}”?`)
  let parsed: Awaited<ReturnType<typeof readPSD>>, imported: PSDImport
  try {
    parsed = await readPSD(new Uint8Array(await file.arrayBuffer()), canvasDrawing, documentPixelBudget - used)
    if (parsed.merged) { endPSDReading(); await placeImage(parsed.merged, name, parsed.mergedDeep, parsed.cmykProfile, at); return }
    imported = await makeImport(parsed, canvasDrawing)
  } catch (error) { endPSDReading(); throw error }
  if (!(await finishPSDReading(imported.conversions))) return
  // A CMYK file making a new document: its profile is kept and chosen, for proofing and for CMYK export when it's asked for.
  if (!store.hasDocument && parsed.cmykProfile) await (await import('../io/cmyk')).adoptProfile(parsed.cmykProfile)
  store.addPhotoshop(imported, name, at)
}

// File › Import Folder…: the images directly inside a folder, as layers, in name order.
export const importFolder = guard(async () => {
  if (canWriteDirectories) {
    const handle: FileSystemDirectoryHandle = await (window as any).showDirectoryPicker({ id: 'compositor-import', mode: 'read' })
    const images = imagesIn(await filesInHandle(handle))
    if (images.length) await placeImages(images)
    else store.notify(`There are no images in “${handle.name}”.`)
    return
  }
  const input = Object.assign(document.createElement('input'), { type: 'file', multiple: true })
  input.setAttribute('webkitdirectory', '')
  input.onchange = () => {
    const files = [...input.files ?? []], name = files[0]?.webkitRelativePath.split('/')[0] ?? 'folder'
    const images = imagesIn(files.filter(file => file.webkitRelativePath.split('/').length === 2))
    if (images.length) placeImages(images)
    else store.notify(`There are no images in “${name}”.`)
  }
  input.click()
})

const imageTypes = 'image/*,.hif,.heif,.heic,.tif,.tiff,.svg,.exr,.hdr,.psd,.psb,.dng,.cr2,.cr3,.nef,.nrw,.arw,.raf,.orf,.rw2,.pef,.srw,.3fr,.iiq,.erf,.kdc,.mos,.mrw,.raw,.rwl,.x3f'

export const importImage = guard(async () => {
  const input = Object.assign(document.createElement('input'), { type: 'file', accept: imageTypes, multiple: true })
  input.onchange = () => input.files?.length && placeImages([...input.files])
  input.click()
})

// Open…: any file the app reads, as a drop would take it: a zipped project opens in a tab of its own, images and Photoshop and RAW
// files open (the first as the canvas, when none is open) or come in as layers. A project folder can't be picked with files, so it
// keeps its own command.
export const openAnything = guard(async () => {
  const input = Object.assign(document.createElement('input'), { type: 'file', accept: `${imageTypes},.zip,application/zip`, multiple: true })
  input.onchange = () => guard(async () => {
    const files = [...input.files ?? []], zips = files.filter(file => file.name.toLowerCase().endsWith('.zip')), images = files.filter(file => !zips.includes(file))
    for (const zip of zips) await openFiles(unzipPackage(new Uint8Array(await zip.arrayBuffer())), { kind: 'download', name: zip.name.replace(/\.zip$/i, '') })
    if (images.length) await placeImages(images)
  })()
  input.click()
})

export const save = guard(async (as: boolean = false) => {
  if (!store.hasDocument) return
  commitFloating()
  // The tab and the document as they were when Save was chosen: another tab may show, or edits come in, while the files are written.
  const owner = store, doc = owner.state.doc, written = () => owner.state.doc === doc
  const files = writeProject(doc, owner.state.activeId)
  let target = owner.state.target
  if (as || !target || target.kind !== 'directory') {
    if (canWriteDirectories) {
      const parent: FileSystemDirectoryHandle = await (window as any).showDirectoryPicker({ id: 'compositor-save', mode: 'readwrite' })
      const name = prompt('Save project as', `${documentName()}.comp`)
      if (!name) return
      const handle = await parent.getDirectoryHandle(name.endsWith('.comp') ? name : `${name}.comp`, { create: true })
      target = { kind: 'directory', handle, name: handle.name }
    } else {
      // Without folder access, Save keeps the project in this browser (Download as Zip makes a copy elsewhere).
      const name = as ? prompt('Save project as', documentName())?.trim() : documentName()
      if (!name) return
      const id = !as && target?.kind === 'browser' ? target.id : uuid()
      await saveToBrowser(id, name, zipPackage(name, files))
      owner.set({ saved: written(), target: { kind: 'browser', id, name } })
      // Kept unless space runs out where the browser grants it; Safari on iOS clears what a site stores after a week without a visit
      // unless it's on the Home Screen, so it says so.
      const kept = await navigator.storage?.persist?.().catch(() => false)
      const ios = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
      const homeScreen = (navigator as Navigator & { standalone?: boolean }).standalone || matchMedia('(display-mode: standalone)').matches
      owner.notify(ios && !homeScreen && !kept ? `Saved ${name} in this browser. Safari can clear it after a week without a visit: add Compositor to the Home Screen, or Download as Zip to keep a copy.` : `Saved ${name} in this browser. Download as Zip to keep a copy elsewhere.`, 'info')
      return
    }
  }
  await savingProject(owner, () => writeDirectory(target.handle, files))
  if (!(await watching(owner, target.handle))) watchProject(owner, target.handle)
  noteRecent(target.handle)
  owner.set({ saved: written(), target })
  owner.notify(`Saved ${target.name}`, 'info')
})

export const openBrowserProject = guard(async (project: BrowserProject) => {
  await openFiles(unzipPackage(await readFromBrowser(project.id)), { kind: 'browser', id: project.id, name: project.name })
})

export const deleteBrowserProject = guard(async (project: BrowserProject) => {
  if (confirm(`Delete “${project.name}” from this browser? This can’t be undone.`)) await deleteFromBrowser(project.id)
})

export const downloadZip = guard(() => {
  if (!store.hasDocument) return
  download(`${documentName()}.comp.zip`, zipPackage(documentName(), writeProject(store.state.doc, store.state.activeId)), 'application/zip')
})

// A save dialog where the browser has one (Chrome, Edge); otherwise a download. Choosing Cancel in the dialog saves nothing.
export async function saveFile(name: string, blob: Blob) {
  if (!('showSaveFilePicker' in window)) { download(name, blob); return }
  const extension = name.slice(name.lastIndexOf('.'))
  try {
    const handle: FileSystemFileHandle = await (window as any).showSaveFilePicker({ suggestedName: name, types: [{ description: `${extension.slice(1).toUpperCase()} file`, accept: { [blob.type || 'application/octet-stream']: [extension] } }] })
    const writable = await handle.createWritable()
    await writable.write(blob)
    await writable.close()
  } catch (error) { if ((error as Error).name !== 'AbortError') throw error }
}

export const exportImage = guard(async () => {
  if (!store.hasDocument) return
  commitFloating()
  await saveFile(`${documentName()}.png`, new Blob([encodePNG(renderFull(store.state.doc)) as Uint8Array<ArrayBuffer>], { type: 'image/png' }))
})

// Premultiplied pixels to straight RGBA ImageData, laid over `background` when given (JPEG and PDF have no transparency).
function imageData(pixels: Raster, background?: [number, number, number]) {
  const out = new ImageData(pixels.width, pixels.height), d = out.data, p = pixels.data
  for (let i = 0; i < p.length; i += 4) {
    const a = p[i + 3]
    if (background) { for (let c = 0; c < 3; c++) d[i + c] = Math.round(p[i + c] + background[c] * (1 - a / 255)); d[i + 3] = 255 }
    else if (a) { for (let c = 0; c < 3; c++) d[i + c] = Math.min(255, Math.round(p[i + c] * 255 / a)); d[i + 3] = a }
  }
  return out
}

// Export As's file and an image to preview it by: the flattened canvas sized at high quality, then PNG keeping transparency, or JPEG
// or a one-page PDF (at the document's resolution) over `background`.
// `deep`: the flattening at full depth (premultiplied floats in extended sRGB), for a 16-bit PNG.
export type ExportOptions = { quality: number; background: [number, number, number]; resolution: number; linear?: LinearImage | null; cmyk?: CMYKProfile | null; deep?: Float32Array | null }
// The flattened pixels as JPEG, PNG, TIFF, PDF or EXR, resized first. With `cmyk`, JPEG, TIFF and PDF are written in the profile's inks
// over the background, the profile embedded, and previewed as they'll print.
export async function encodeExport(pixels: Raster, format: 'JPEG' | 'PNG' | 'TIFF' | 'PDF' | 'EXR', width: number, height: number, { quality, background, resolution, linear = null, cmyk = null, deep = null }: ExportOptions): Promise<{ blob: Blob; preview: Blob }> {
  let sized = pixels
  if (width !== pixels.width || height !== pixels.height) {
    const source = new OffscreenCanvas(pixels.width, pixels.height), target = new OffscreenCanvas(width, height), context = target.getContext('2d')!
    source.getContext('2d')!.putImageData(imageData(pixels), 0, 0)
    context.imageSmoothingQuality = 'high'
    context.drawImage(source, 0, 0, width, height)
    const data = new Uint8Array(context.getImageData(0, 0, width, height).data.buffer)
    for (let i = 0; i < data.length; i += 4) { const a = data[i + 3]; for (let c = 0; c < 3; c++) data[i + c] = Math.round(data[i + c] * a / 255) }
    sized = new Raster(width, height, 4, data)
  }
  const png = (raster: Raster) => new Blob([encodePNG(raster) as Uint8Array<ArrayBuffer>], { type: 'image/png' })
  if (format === 'PNG' && deep) {
    const floats = resizeLinear({ width: pixels.width, height: pixels.height, data: deep }, width, height).data
    const bytes = encode({ width, height, data: unpremultiplied16(floatsToDeep(floats, false)), channels: 4, depth: 16 }, { zlib: { level: 6 } })
    return { blob: new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'image/png' }), preview: png(sized) }
  }
  if (format === 'PNG') { const blob = png(sized); return { blob, preview: blob } }
  // An EXR from the half-float flattening, previewed as the screen shows it, clipped to white.
  if (format === 'EXR') {
    if (!linear) throw new Error('EXR keeps HDR layers, and this document has none.')
    const exr = resizeLinear(linear, width, height)
    return { blob: new Blob([encodeEXR(exr.data, width, height, resolution) as Uint8Array<ArrayBuffer>], { type: 'image/x-exr' }), preview: png(sized) }
  }
  if (cmyk) {
    const inks = await toInks(flatten(sized, background), cmyk), shown = await fromInks(inks, cmyk), preview = new Raster(width, height, 4)
    for (let i = 0, j = 0; j < shown.length; i += 4, j += 3) { preview.data[i] = shown[j]; preview.data[i + 1] = shown[j + 1]; preview.data[i + 2] = shown[j + 2]; preview.data[i + 3] = 255 }
    const bytes = format === 'JPEG' ? encodeCMYKJPEG(inks, width, height, quality, cmyk.data) : format === 'TIFF' ? encodeTIFF({ width, height, samples: inks, cmyk: true, icc: cmyk.data, resolution }) : pdfOfImage(inks, width, height, width * 72 / resolution, height * 72 / resolution, cmyk.data)
    return { blob: new Blob([bytes as Uint8Array<ArrayBuffer>], { type: { JPEG: 'image/jpeg', TIFF: 'image/tiff', PDF: 'application/pdf' }[format] }), preview: png(preview) }
  }
  // An RGB TIFF keeps its transparency, as PNG does.
  if (format === 'TIFF') {
    const samples = new Uint8Array(sized.data)
    for (let i = 0; i < samples.length; i += 4) { const a = samples[i + 3]; if (a && a < 255) for (let c = 0; c < 3; c++) samples[i + c] = Math.min(255, Math.round(samples[i + c] * 255 / a)) }
    return { blob: new Blob([encodeTIFF({ width, height, samples, alpha: true, resolution }) as Uint8Array<ArrayBuffer>], { type: 'image/tiff' }), preview: png(sized) }
  }
  const flat = imageData(sized, background), canvas = new OffscreenCanvas(width, height)
  canvas.getContext('2d')!.putImageData(flat, 0, 0)
  if (format === 'JPEG') { const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality }); return { blob, preview: blob } }
  const rgb = new Uint8Array(width * height * 3)
  for (let i = 0, j = 0; i < flat.data.length; i += 4, j += 3) { rgb[j] = flat.data[i]; rgb[j + 1] = flat.data[i + 1]; rgb[j + 2] = flat.data[i + 2] }
  const pdf = pdfOfImage(rgb, width, height, width * 72 / resolution, height * 72 / resolution)
  return { blob: new Blob([pdf as Uint8Array<ArrayBuffer>], { type: 'application/pdf' }), preview: await canvas.convertToBlob({ type: 'image/png' }) }
}

export const copyMerged = guard(async () => {
  if (!store.hasDocument) return
  const pixels = renderFull(store.state.doc)
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': new Blob([encodePNG(pixels) as Uint8Array<ArrayBuffer>], { type: 'image/png' }) })])
  store.notify('Copied the merged image', 'info')
})

export const pasteImage = guard(async () => {
  const items = await navigator.clipboard.read()
  for (const item of items) {
    const type = item.types.find(t => t.startsWith('image/'))
    if (type) { await placeImages([new File([await item.getType(type)], 'Pasted Image.png', { type })]); return }
  }
  store.notify('There is no image on the clipboard.')
})

export const openSample = guard(async () => {
  const bytes = new Uint8Array(await (await fetch(`${import.meta.env.BASE_URL}samples/Sample.comp.bin`)).arrayBuffer())
  await openFiles(unzipPackage(bytes), { kind: 'download', name: 'Sample' })
})

// Open Recent: a project that's already open is just brought forward; one that's gone is dropped from the list.
export const openRecent = guard(async (recent: Recent) => {
  for (const tab of tabs) if (tab.state.target?.kind === 'directory' && await tab.state.target.handle.isSameEntry(recent.handle)) { activateTab(tab); return }
  if ((await (recent.handle as any).requestPermission?.({ mode: 'readwrite' })) === 'denied') return
  let files: PackageFiles
  try { files = rootedAtManifest(await readDirectoryHandle(recent.handle)) }
  catch (error) { await forgetRecent(recent.handle); throw new Error(`Couldn’t open the project “${recent.name}”: ${(error as Error).message}`) }
  await openFiles(files, { kind: 'directory', handle: recent.handle, name: recent.handle.name })
})
