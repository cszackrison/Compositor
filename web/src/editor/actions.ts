import { commitFloating } from './floating'
import { Store, activateTab, closeTab, store, tabForOpening, tabs } from './store'
import { forgetRecent, noteRecent, type Recent } from '../io/recent'
import { deleteFromBrowser, readFromBrowser, saveToBrowser, type BrowserProject } from '../io/browserProjects'
import { canWriteDirectories, download, readDirectoryHandle, readFileList, rootedAtManifest, unzipPackage, writeDirectory, zipPackage, type PackageFiles, type PackageTarget } from '../io/files'
import { readProject, writeProject } from '../io/project'
import { Raster, decodeImageFile, encodePNG } from '../model/raster'
import { type Doc, fullTransform, newLayer, uuid, maxSide } from '../model/types'
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
export function closeProject(target: Store = store) {
  if (target.hasDocument && !target.state.saved && !confirm(`Close “${documentName(target)}” without saving its changes?`)) return
  closeTab(target)
}

export const documentName = (of: Store = store) => of.state.target?.name.replace(/\.comp$/, '') ?? 'Untitled'

export const newCanvas = guard((width: number, height: number, fill: 'white' | 'transparent' | 'background', resolution: number = 72) => {
  width = Math.round(Math.min(maxSide, Math.max(1, width))); height = Math.round(Math.min(maxSide, Math.max(1, height)))
  const color = fill === 'white' ? [255, 255, 255, 255] : fill === 'background' ? [...store.state.background, 255] : [0, 0, 0, 0]
  const layer = newLayer({ name: fill === 'transparent' ? 'Layer 1' : 'Background', transform: fullTransform(width, height), image: Raster.filled(width, height, 4, color) })
  const doc: Doc = { id: uuid(), width, height, resolution, layers: [layer], guides: [], extra: {} }
  tabForOpening().open(doc, layer.id, null)
})

export const openFiles = guard(async (files: PackageFiles, target: PackageTarget) => {
  const { doc, activeId } = await readProject(files)
  tabForOpening().open(doc, activeId, target)
  if (target.kind === 'directory') noteRecent(target.handle)
})

export const openProject = guard(async () => {
  if (canWriteDirectories) {
    const handle: FileSystemDirectoryHandle = await (window as any).showDirectoryPicker({ id: 'compositor-projects', mode: 'readwrite' })
    const files = rootedAtManifest(await readDirectoryHandle(handle))
    await openFiles(files, { kind: 'directory', handle, name: handle.name })
    return
  }
  const input = Object.assign(document.createElement('input'), { type: 'file' })
  input.setAttribute('webkitdirectory', '')
  input.onchange = () => input.files?.length && guard(async () => openFiles(await readFileList(input.files!), { kind: 'download', name: input.files![0].webkitRelativePath.split('/')[0] }))()
  input.click()
})

export const openZip = guard(async () => {
  const input = Object.assign(document.createElement('input'), { type: 'file', accept: '.zip,application/zip' })
  input.onchange = () => {
    const file = input.files?.[0]
    if (file) guard(async () => openFiles(unzipPackage(new Uint8Array(await file.arrayBuffer())), { kind: 'download', name: file.name.replace(/\.zip$/, '') }))()
  }
  input.click()
})

// Opens an image as a new document when nothing is open, or places it as a layer.
export const placeImages = guard(async (files: File[]) => {
  for (const file of files) {
    const image = await decodeImageFile(file)
    const name = file.name.replace(/\.[^.]+$/, '')
    if (!store.hasDocument) {
      const layer = newLayer({ name, transform: fullTransform(image.width, image.height), image })
      store.open({ id: uuid(), width: image.width, height: image.height, resolution: 72, layers: [layer], guides: [], extra: {} }, layer.id, null)
      store.set({ target: { kind: 'download', name } })
    } else store.addImageLayer(image, name)
  }
})

export const importImage = guard(async () => {
  const input = Object.assign(document.createElement('input'), { type: 'file', accept: 'image/*', multiple: true })
  input.onchange = () => input.files?.length && placeImages([...input.files])
  input.click()
})

export const save = guard(async (as: boolean = false) => {
  if (!store.hasDocument) return
  commitFloating()
  const files = writeProject(store.state.doc, store.state.activeId)
  let target = store.state.target
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
      store.set({ saved: true, target: { kind: 'browser', id, name } })
      store.notify(`Saved ${name} in this browser. Download as Zip to keep a copy elsewhere.`, 'info')
      return
    }
  }
  await writeDirectory(target.handle, files)
  noteRecent(target.handle)
  store.set({ saved: true, target })
  store.notify(`Saved ${target.name}`, 'info')
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

export const exportImage = guard(async (format: 'png' | 'jpeg', quality: number = 0.85) => {
  if (!store.hasDocument) return
  commitFloating()
  const pixels = renderFull(store.state.doc)
  if (format === 'png') {
    const png = encodePNG(pixels)
    // A save dialog where the browser has one (Chrome, Edge); otherwise a download.
    if ('showSaveFilePicker' in window) {
      const handle: FileSystemFileHandle = await (window as any).showSaveFilePicker({ suggestedName: `${documentName()}.png`, types: [{ description: 'PNG image', accept: { 'image/png': ['.png'] } }] })
      const writable = await handle.createWritable()
      await writable.write(png as Uint8Array<ArrayBuffer>)
      await writable.close()
    } else download(`${documentName()}.png`, png, 'image/png')
    return
  }
  const canvas = new OffscreenCanvas(pixels.width, pixels.height)
  const context = canvas.getContext('2d')!
  const image = context.createImageData(pixels.width, pixels.height)
  for (let i = 0; i < pixels.data.length; i += 4) {
    const a = pixels.data[i + 3]
    for (let c = 0; c < 3; c++) image.data[i + c] = pixels.data[i + c] + (255 - a)
    image.data[i + 3] = 255
  }
  context.putImageData(image, 0, 0)
  download(`${documentName()}.jpg`, await canvas.convertToBlob({ type: 'image/jpeg', quality }))
})

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
  const bytes = new Uint8Array(await (await fetch(`${import.meta.env.BASE_URL}samples/Sample.comp.zip`)).arrayBuffer())
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
