import { unzipSync, zipSync } from 'fflate'

export type PackageFiles = Map<string, Uint8Array>

// Where a project came from and can be saved back to: a folder the browser lets us write (Chromium), or nothing (download a zip).
export type PackageTarget = { kind: 'directory'; handle: FileSystemDirectoryHandle; name: string } | { kind: 'download'; name: string } | { kind: 'browser'; id: string; name: string }

export const canWriteDirectories = typeof window !== 'undefined' && 'showDirectoryPicker' in window

// Keeps only the files under the folder holding manifest.json, keyed relative to it.
export function rootedAtManifest(files: PackageFiles): PackageFiles {
  const manifest = [...files.keys()].filter(path => path === 'manifest.json' || path.endsWith('/manifest.json')).sort((a, b) => a.length - b.length)[0]
  if (manifest === undefined) throw new Error('No manifest.json found. Choose a .comp project folder.')
  const prefix = manifest.slice(0, -'manifest.json'.length)
  return new Map([...files].filter(([path]) => path.startsWith(prefix) && !path.includes('__MACOSX')).map(([path, data]) => [path.slice(prefix.length), data]))
}

export function unzipPackage(bytes: Uint8Array): PackageFiles {
  return rootedAtManifest(new Map(Object.entries(unzipSync(bytes)).filter(([path]) => !path.endsWith('/'))))
}

export async function readDirectoryHandle(handle: FileSystemDirectoryHandle, prefix = '', files: PackageFiles = new Map()): Promise<PackageFiles> {
  for await (const [name, entry] of (handle as any).entries() as AsyncIterable<[string, FileSystemHandle]>) {
    if (name === 'QuickLook' || name.startsWith('.')) continue
    if (entry.kind === 'directory') await readDirectoryHandle(entry as FileSystemDirectoryHandle, `${prefix}${name}/`, files)
    else files.set(`${prefix}${name}`, new Uint8Array(await (await (entry as FileSystemFileHandle).getFile()).arrayBuffer()))
  }
  return files
}

export async function readFileList(list: Iterable<File>): Promise<PackageFiles> {
  const files: PackageFiles = new Map()
  for (const file of list) files.set((file as any).webkitRelativePath || file.name, new Uint8Array(await file.arrayBuffer()))
  return rootedAtManifest(files)
}

async function readEntry(entry: FileSystemEntry, prefix: string, files: PackageFiles): Promise<void> {
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject))
    files.set(prefix + entry.name, new Uint8Array(await file.arrayBuffer()))
    return
  }
  const reader = (entry as FileSystemDirectoryEntry).createReader()
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject))
    if (!batch.length) break
    for (const child of batch) await readEntry(child, `${prefix}${entry.name}/`, files)
  }
}

// Images by type, or by name where the browser gives none (cameras' .hif and .heif often come without one). Hidden files aren't.
export const isImageFile = (file: { name: string; type: string }) => !file.name.startsWith('.') && (file.type.startsWith('image/') || /\.(png|jpe?g|webp|gif|bmp|avif|heic|heif|hif|tiff?|exr|hdr)$/i.test(file.name))
// The images among `files` in the Finder's name order ("2" before "10").
export const imagesIn = (files: File[]) => files.filter(isImageFile).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))

export async function filesInHandle(handle: FileSystemDirectoryHandle) {
  const files: File[] = []
  for await (const entry of (handle as any).values() as AsyncIterable<FileSystemHandle>) if (entry.kind === 'file') files.push(await (entry as FileSystemFileHandle).getFile())
  return files
}

async function filesInEntry(entry: FileSystemDirectoryEntry) {
  const reader = entry.createReader(), files: File[] = []
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject))
    if (!batch.length) return files
    for (const child of batch) if (child.isFile) files.push(await new Promise<File>((resolve, reject) => (child as FileSystemFileEntry).file(resolve, reject)))
  }
}

// A plain folder (not a .comp project) brings in the images directly inside it, not its subfolders'.
async function folderImages(name: string, files: () => Promise<File[]>, project: () => Promise<PackageFiles>): Promise<File[] | null> {
  if (name.endsWith('.comp')) return null
  const inside = await files()
  if (inside.some(file => file.name === 'manifest.json')) return null
  const images = imagesIn(inside)
  if (images.length) return images
  // A folder holding a project further down still opens it.
  try { rootedAtManifest(await project()); return null } catch { throw new Error(`There are no images in “${name}”.`) }
}

// A drop is either a project folder, a zipped project, a folder of images, or image files to place as layers. `folder` names a folder
// whose images these are, which opens as one project.
export async function readDrop(transfer: DataTransfer): Promise<{ project?: { files: PackageFiles; target: PackageTarget }; images: File[]; folder?: string }> {
  const items = [...transfer.items].filter(item => item.kind === 'file')
  const handles = await Promise.all(items.map(item => 'getAsFileSystemHandle' in item ? (item as any).getAsFileSystemHandle().catch(() => null) as Promise<FileSystemHandle | null> : Promise.resolve(null)))
  const entries = items.map(item => item.webkitGetAsEntry())
  const images: File[] = []
  for (let index = 0; index < items.length; index++) {
    const handle = handles[index], entry = entries[index]
    if (handle?.kind === 'directory') {
      const directory = handle as FileSystemDirectoryHandle
      const found = await folderImages(directory.name, () => filesInHandle(directory), () => readDirectoryHandle(directory))
      if (found) return { images: found, folder: directory.name }
      return { project: { files: rootedAtManifest(await readDirectoryHandle(directory)), target: { kind: 'directory', handle: directory, name: directory.name } }, images }
    }
    if (entry?.isDirectory) {
      const found = await folderImages(entry.name, () => filesInEntry(entry as FileSystemDirectoryEntry), async () => { const files: PackageFiles = new Map(); await readEntry(entry, '', files); return files })
      if (found) return { images: found, folder: entry.name }
      const files: PackageFiles = new Map()
      await readEntry(entry, '', files)
      return { project: { files: rootedAtManifest(files), target: { kind: 'download', name: entry.name } }, images }
    }
    const file = items[index].getAsFile()
    if (!file) continue
    if (file.name.endsWith('.zip')) return { project: { files: unzipPackage(new Uint8Array(await file.arrayBuffer())), target: { kind: 'download', name: file.name.replace(/\.zip$/, '') } }, images }
    if (isImageFile(file)) images.push(file)
  }
  return { images }
}

export async function writeDirectory(handle: FileSystemDirectoryHandle, files: PackageFiles) {
  if ((await (handle as any).requestPermission?.({ mode: 'readwrite' })) === 'denied') throw new Error('Permission to save into this folder was denied.')
  const images = await handle.getDirectoryHandle('images', { create: true })
  const write = async (directory: FileSystemDirectoryHandle, name: string, data: Uint8Array) => {
    const writable = await (await directory.getFileHandle(name, { create: true })).createWritable()
    await writable.write(data as Uint8Array<ArrayBuffer>)
    await writable.close()
  }
  for (const [path, data] of files) if (path.startsWith('images/')) await write(images, path.slice(7), data)
  await write(handle, 'manifest.json', files.get('manifest.json')!)
  const kept = new Set([...files.keys()].filter(path => path.startsWith('images/')).map(path => path.slice(7)))
  for await (const name of (images as any).keys() as AsyncIterable<string>) if (!kept.has(name)) await images.removeEntry(name)
  await handle.removeEntry('QuickLook', { recursive: true }).catch(() => {})
}

export function zipPackage(name: string, files: PackageFiles) {
  const root = name.endsWith('.comp') ? name : `${name}.comp`
  return zipSync(Object.fromEntries([...files].map(([path, data]) => [`${root}/${path}`, [data, { level: path.endsWith('.png') ? 0 : 6 }]])))
}

export function download(name: string, data: Uint8Array | Blob, type = 'application/octet-stream') {
  const url = URL.createObjectURL(data instanceof Blob ? data : new Blob([data as Uint8Array<ArrayBuffer>], { type }))
  const link = Object.assign(document.createElement('a'), { href: url, download: name })
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
