import type { Raster } from './raster'

export type PixelPatch = { raster: Raster; x: number; y: number; w: number; h: number; before: Uint8Array; after: Uint8Array }

// Structural edits swap whole immutable states; pixel edits patch a raster in place. Rasters are shared between states, so entries
// must be undone strictly in order, which a stack guarantees.
export type HistoryEntry<S> = { name: string; before: S; after: S; patches: PixelPatch[] }

export class History<S> {
  private undoStack: HistoryEntry<S>[] = []
  private redoStack: HistoryEntry<S>[] = []
  private bytes = 0
  constructor(private limitBytes = 1024 * 1024 * 1024, private limitEntries = 200) {}

  push(entry: HistoryEntry<S>) {
    this.undoStack.push(entry)
    this.redoStack = []
    this.bytes += entry.patches.reduce((sum, patch) => sum + patch.before.length * 2, 0)
    while (this.undoStack.length > 1 && (this.bytes > this.limitBytes || this.undoStack.length > this.limitEntries)) {
      const dropped = this.undoStack.shift()!
      this.bytes -= dropped.patches.reduce((sum, patch) => sum + patch.before.length * 2, 0)
    }
  }
  undo(): HistoryEntry<S> | undefined {
    const entry = this.undoStack.pop()
    if (!entry) return
    for (const patch of [...entry.patches].reverse()) patch.raster.write(patch.x, patch.y, patch.w, patch.h, patch.before)
    this.redoStack.push(entry)
    return entry
  }
  redo(): HistoryEntry<S> | undefined {
    const entry = this.redoStack.pop()
    if (!entry) return
    for (const patch of entry.patches) patch.raster.write(patch.x, patch.y, patch.w, patch.h, patch.after)
    this.undoStack.push(entry)
    return entry
  }
  // Folds a continuing edit (a slider drag) into the step before it.
  amendLast(after: S) {
    const last = this.undoStack.at(-1)
    if (!last || last.patches.length || this.redoStack.length) return false
    last.after = after
    return true
  }
  renameLast(name: string) { const last = this.undoStack.at(-1); if (last) last.name = name }
  get canUndo() { return this.undoStack.length > 0 }
  get canRedo() { return this.redoStack.length > 0 }
  get undoName() { return this.undoStack.at(-1)?.name }
  get redoName() { return this.redoStack.at(-1)?.name }
  clear() { this.undoStack = []; this.redoStack = []; this.bytes = 0 }
}

// Records the region of `raster` an edit is about to change, then finishes into a patch with its new contents.
export function beginPatch(raster: Raster, x: number, y: number, w: number, h: number) {
  x = Math.max(0, Math.floor(x)); y = Math.max(0, Math.floor(y))
  w = Math.min(raster.width - x, Math.ceil(w)); h = Math.min(raster.height - y, Math.ceil(h))
  if (w <= 0 || h <= 0) return undefined
  const before = raster.read(x, y, w, h)
  return { finish: (): PixelPatch => ({ raster, x, y, w, h, before, after: raster.read(x, y, w, h) }) }
}
