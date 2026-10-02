// Recently opened or saved project folders (RecentProjects.swift), most recent first, at most 10. Browsers can only hand back a
// folder through the handle it was opened with, so they're kept in IndexedDB; this works where folders can be opened (Chrome, Edge).
export type Recent = { name: string; handle: FileSystemDirectoryHandle; openedAt: number }

const limit = 10
let cached: Recent[] = []
const listeners = new Set<() => void>()
export const recentProjects = () => cached
export function subscribeRecent(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } }

function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('compositor', 1)
    request.onupgradeneeded = () => request.result.createObjectStore('recent')
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function write(list: Recent[]) {
  cached = list
  listeners.forEach(l => l())
  try {
    const db = await database()
    await new Promise<void>((resolve, reject) => { const t = db.transaction('recent', 'readwrite'); t.objectStore('recent').put(list, 'list'); t.oncomplete = () => resolve(); t.onerror = () => reject(t.error) })
  } catch { /* storage unavailable: the list lasts for this session */ }
}

export async function loadRecent() {
  try {
    const db = await database()
    cached = await new Promise<Recent[]>((resolve, reject) => { const request = db.transaction('recent').objectStore('recent').get('list'); request.onsuccess = () => resolve(request.result ?? []); request.onerror = () => reject(request.error) })
    listeners.forEach(l => l())
  } catch { cached = [] }
}

// Moves a folder to the top of the list after it's opened or saved.
export async function noteRecent(handle: FileSystemDirectoryHandle) {
  const rest: Recent[] = []
  for (const entry of cached) if (!(await entry.handle.isSameEntry(handle))) rest.push(entry)
  await write([{ name: handle.name.replace(/\.comp$/, ''), handle, openedAt: Date.now() }, ...rest].slice(0, limit))
}

export async function forgetRecent(handle: FileSystemDirectoryHandle) {
  const rest: Recent[] = []
  for (const entry of cached) if (!(await entry.handle.isSameEntry(handle))) rest.push(entry)
  await write(rest)
}

export const clearRecent = () => write([])
