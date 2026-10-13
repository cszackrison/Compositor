import { describe, expect, it } from 'vitest'
import { imagesIn, readDrop } from '../src/io/files'

describe('image folders', () => {
  it('take images in Finder name order, camera HEIF by name, and skip hidden and other files', () => {
    const file = (name: string, type = '') => new File([new Uint8Array(1)], name, { type })
    const files = [file('10 Ten.png', 'image/png'), file('2 Two.jpeg', 'image/jpeg'), file('.Hidden.png', 'image/png'), file('Notes.txt', 'text/plain'), file('DSC1.HIF')]
    expect(imagesIn(files).map(f => f.name)).toEqual(['2 Two.jpeg', '10 Ten.png', 'DSC1.HIF'])
  })
})

// A drop as the browser hands it over: readable while its event runs, empty once the handler first awaits.
function drop(files: File[], links = '') {
  let open = true
  queueMicrotask(() => { open = false })
  const items = files.map(file => ({ kind: 'file', getAsFile: () => open ? file : null, webkitGetAsEntry: () => open ? { isDirectory: false, name: file.name } : null, getAsFileSystemHandle: async () => open ? { kind: 'file', name: file.name } : null }))
  return { items, getData: (type: string) => open && type === 'text/uri-list' ? links : '' } as unknown as DataTransfer
}

describe('drops', () => {
  const file = (name: string, type = '') => new File([new Uint8Array(1)], name, { type })
  it('read every file before the drop closes', async () => {
    expect((await readDrop(drop([file('sky.exr'), file('villa.tif', 'image/tiff'), file('badge.svg', 'image/svg+xml')]))).images.map(f => f.name)).toEqual(['sky.exr', 'villa.tif', 'badge.svg'])
  })
  it('say so when nothing dropped can be opened', async () => {
    await expect(readDrop(drop([file('notes.txt', 'text/plain')]))).rejects.toThrow('isn’t an image')
  })
})
