// Projects saved inside the browser, for where folders can't be opened (Safari, Firefox, phones): each is the zipped package, kept
// in IndexedDB under an id. Browsers may clear this storage, so it's asked to persist, and Download as Zip stays the safe copy.
export type BrowserProject = { id: string; name: string; savedAt: number; size: number }

let cached: BrowserProject[] = []
const listeners = new Set<() => void>()
export const browserProjects = () => cached
export function subscribeBrowserProjects(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } }

function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('compositor-projects', 1)
    request.onupgradeneeded = () => { request.result.createObjectStore('index'); request.result.createObjectStore('zips') }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function run<T>(db: IDBDatabase, stores: string[], mode: IDBTransactionMode, work: (t: IDBTransaction) => IDBRequest<T> | void): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode)
    const request = work(t)
    t.oncomplete = () => resolve(request ? request.result : undefined)
    t.onerror = () => reject(t.error)
  })
}

const publish = (list: BrowserProject[]) => { cached = [...list].sort((a, b) => b.savedAt - a.savedAt); listeners.forEach(l => l()) }

export async function loadBrowserProjects() {
  try { publish((await run<BrowserProject[]>(await database(), ['index'], 'readonly', t => t.objectStore('index').get('list'))) ?? []) } catch { publish([]) }
}

export async function saveToBrowser(id: string, name: string, zip: Uint8Array) {
  navigator.storage?.persist?.().catch(() => {})
  const db = await database()
  const entry: BrowserProject = { id, name, savedAt: Date.now(), size: zip.byteLength }
  const list = [entry, ...cached.filter(p => p.id !== id)]
  await run(db, ['index', 'zips'], 'readwrite', t => { t.objectStore('zips').put(zip, id); t.objectStore('index').put(list, 'list') })
  publish(list)
}

export async function readFromBrowser(id: string): Promise<Uint8Array> {
  const zip = await run<Uint8Array>(await database(), ['zips'], 'readonly', t => t.objectStore('zips').get(id))
  if (!zip) throw new Error('That project is no longer saved in this browser.')
  return zip
}

export async function deleteFromBrowser(id: string) {
  const list = cached.filter(p => p.id !== id)
  await run(await database(), ['index', 'zips'], 'readwrite', t => { t.objectStore('zips').delete(id); t.objectStore('index').put(list, 'list') })
  publish(list)
}
