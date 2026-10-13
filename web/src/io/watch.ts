import { Store, tabs, store as activeStore } from '../editor/store'
import { readDirectoryHandle, rootedAtManifest } from './files'
import { readProject } from './project'

// An open project folder kept in step with the folder on disk (ProjectController+ExternalChanges.swift): when something else writes
// it (an agent, a script, a sync client) the document is reloaded in place, keeping the view and the chosen layers where they still
// exist. Browsers can't watch folders, so a project opened from one (Chrome and Edge) is looked at every second and a half while its
// tab shows. Only a real change in content counts: a folder merely touched, or caught half written, is left alone. Unsaved work is
// never replaced without asking.

type Watch = { owner: Store; handle: FileSystemDirectoryHandle; quick: string; digest: string | null; saving: boolean; checking: boolean; asking: boolean }
const watches = new Map<Store, Watch>()
let timer = 0

// What the files say about themselves (names, sizes, dates): cheap, and what decides whether to read the contents.
async function quickLook(handle: FileSystemDirectoryHandle): Promise<string> {
  const parts: string[] = []
  const walk = async (directory: FileSystemDirectoryHandle, prefix: string, depth: number) => {
    for await (const entry of (directory as unknown as { values(): AsyncIterable<FileSystemHandle> }).values()) {
      if (entry.kind === 'directory') { if (depth < 2 && !entry.name.startsWith('.') && entry.name !== 'QuickLook') await walk(entry as FileSystemDirectoryHandle, `${prefix}${entry.name}/`, depth + 1); continue }
      if (entry.name.startsWith('.')) continue
      const file = await (entry as FileSystemFileHandle).getFile()
      parts.push(`${prefix}${entry.name}:${file.size}:${file.lastModified}`)
    }
  }
  await walk(handle, '', 0)
  return parts.sort().join('|')
}

// The project's content, hashed: the manifest and every image, in name order.
function contentDigest(files: Map<string, Uint8Array>) {
  let hash = 2166136261
  for (const name of [...files.keys()].sort()) {
    for (let i = 0; i < name.length; i++) hash = Math.imul(hash ^ name.charCodeAt(i), 16777619)
    const bytes = files.get(name)!
    for (let i = 0; i < bytes.length; i++) hash = Math.imul(hash ^ bytes[i], 16777619)
  }
  return `${files.size}:${hash >>> 0}`
}

const read = async (handle: FileSystemDirectoryHandle) => rootedAtManifest(await readDirectoryHandle(handle))

// Starts watching a project opened from a folder; the folder as read now is what later looks are compared with.
export async function watchProject(owner: Store, handle: FileSystemDirectoryHandle, files?: Map<string, Uint8Array>) {
  const watch: Watch = { owner, handle, quick: '', digest: null, saving: false, checking: false, asking: false }
  watches.set(owner, watch)
  try { watch.quick = await quickLook(handle); watch.digest = contentDigest(files ?? await read(handle)) } catch { /* the next look starts it */ }
  timer ||= window.setInterval(look, 1500)
}

export const watching = async (owner: Store) => watches.has(owner)

// A save of our own: not a change to reload, and what's on disk afterwards is the new starting point.
export async function savingProject(owner: Store, save: () => Promise<void>) {
  const watch = watches.get(owner)
  if (!watch) return save()
  watch.saving = true
  try {
    await save()
    watch.quick = await quickLook(watch.handle)
    watch.digest = contentDigest(await read(watch.handle))
  } finally { watch.saving = false }
}

async function look() {
  for (const [owner, watch] of watches) {
    const target = owner.state.target
    if (!owner.hasDocument || target?.kind !== 'directory' || !tabs.includes(owner) || !(await target.handle.isSameEntry(watch.handle))) { watches.delete(owner); continue }
    if (document.hidden || watch.saving || watch.checking || watch.asking) continue
    watch.checking = true
    try { await check(watch) } catch { /* half written, or mid-sync: the next look tries again */ } finally { watch.checking = false }
  }
  if (!watches.size) { clearInterval(timer); timer = 0 }
}

async function check(watch: Watch) {
  const quick = await quickLook(watch.handle)
  if (quick === watch.quick) return
  const files = await read(watch.handle), digest = contentDigest(files)
  if (digest === watch.digest) { watch.quick = quick; return }
  const { owner } = watch
  // An edit in progress finishes first; the next look sees the change again.
  if (owner.inGesture) return
  if (!owner.state.saved) {
    if (owner !== activeStore) return
    watch.asking = true
    const revert = await Store.askToRevert?.(owner.state.target?.name ?? 'This project')
    watch.asking = false
    if (!revert) { watch.quick = quick; watch.digest = digest; return }
  }
  const { doc, activeId } = await readProject(files)
  owner.reload(doc, activeId)
  watch.quick = quick
  watch.digest = digest
}
