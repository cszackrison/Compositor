import { useEffect, useMemo, useRef, useState } from 'react'
import { store, type Tool } from '../editor/store'
import { chordOf, sameChord, shortcut, shortcutText } from '../editor/shortcuts'
import { rankPalette, type PaletteEntry } from '../editor/palette'
import { requestRender } from './canvasState'
import type { MenuItem } from './Menu'

const close = () => store.set({ panel: null })

// The menu bar as entries: every item, by its path ("Layer › Rename Layer…"), with its key and whether it's enabled and checked now.
// Help and the palette itself are left out; a disabled submenu disables its items.
function menuEntries(menus: { title: string; items: MenuItem[] }[]) {
  const out: PaletteEntry[] = [], seen = new Map<string, number>()
  const walk = (items: MenuItem[], path: string[], off = false) => {
    for (const item of items) {
      if (item === 'divider' || item.label === 'Search Commands…') continue
      const titles = [...path, item.label]
      if (item.submenu) { walk(item.submenu, titles, off || !!item.disabled); continue }
      const title = titles.join(' › '), count = seen.get(title) ?? 0
      seen.set(title, count + 1)
      out.push({ id: count ? `${title} (${count + 1})` : title, title, shortcut: item.shortcut, enabled: !off && !item.disabled && !!item.action, on: item.checked, run: item.action ?? (() => {}) })
    }
  }
  for (const menu of menus) if (menu.title !== 'Help') walk(menu.items, [menu.title])
  return out
}

// Adding a layer mask lives on a Layers panel button rather than in a menu, so the palette lists it too.
function maskEntries(): PaletteEntry[] {
  const active = store.active, can = !!active && !active.mask && store.hasDocument, selected = !!store.state.selection
  return [
    { id: 'mask', title: selected ? 'Layer › Add Layer Mask from Selection' : 'Layer › Add Layer Mask', enabled: can, run: () => active && store.addMask(active.id, false, selected) },
    { id: 'mask hide', title: selected ? 'Layer › Add Layer Mask Hiding Selection' : 'Layer › Add Layer Mask (Hide All)', enabled: can, run: () => active && store.addMask(active.id, true) },
  ]
}

// Every tool, and each of a tool's modes on its own, by the name someone would search for: Liquify is a mode of the Smear tool and
// Polygonal Lasso a mode of the Lasso. The tool's key shows where a command's shortcut would.
function toolEntries(): PaletteEntry[] {
  const s = () => store.state
  const tools: [string, Tool, string, (() => void)?][] = [
    ['Move / Transform', 'move', 'Move / Transform tool'],
    ['Rectangular Marquee', 'marquee', 'Marquee / cycle shape', () => store.set({ marqueeShape: 'rect' })],
    ['Elliptical Marquee', 'marquee', 'Marquee / cycle shape', () => store.set({ marqueeShape: 'ellipse' })],
    ['Lasso', 'lasso', 'Lasso / cycle mode', () => store.set({ lassoKind: 'freehand' })],
    ['Polygonal Lasso', 'lasso', 'Lasso / cycle mode', () => store.set({ lassoKind: 'polygonal' })],
    ['Magic Wand', 'wand', 'Magic'],
    ['Crop', 'crop', 'Crop tool'],
    ['Brush', 'brush', 'Brush tool'],
    ['Eraser', 'eraser', 'Eraser'],
    ['Spot Healing Brush', 'heal', 'Spot Healing'],
    ['Clone Stamp', 'clone', 'Clone Stamp'],
    ['Liquify', 'smear', 'Blur / Smudge / Liquify', () => store.set({ smearMode: 'Liquify' })],
    ['Blur', 'smear', 'Blur / Smudge / Liquify', () => store.set({ smearMode: 'Blur' })],
    ['Smudge', 'smear', 'Blur / Smudge / Liquify', () => store.set({ smearMode: 'Smudge' })],
    ['Gradient', 'gradient', 'Gradient tool'],
    ['Rectangle', 'shape', 'Shape tool', () => store.set({ shape: { ...s().shape, kind: 'Rectangle' } })],
    ['Ellipse', 'shape', 'Shape tool', () => store.set({ shape: { ...s().shape, kind: 'Ellipse' } })],
    ['Line', 'shape', 'Shape tool', () => store.set({ shape: { ...s().shape, kind: 'Line' } })],
    ['Eyedropper', 'eyedropper', 'Eyedropper tool'],
    ['Hand', 'hand', 'Hand tool'],
    ['Zoom', 'zoom', 'Zoom tool'],
  ]
  return tools.map(([name, tool, key, setup]) => ({
    id: `Tool › ${name}`, title: `Tool › ${name}`, shortcut: shortcutText(key, 'Canvas & Layers'), enabled: store.hasDocument,
    run: () => { store.setTool(tool); if (store.state.tool === tool) setup?.() },
  }))
}

// View › Search Commands (⌘F): a search over every menu command and tool. ↑ and ↓ choose, Return runs, Escape or ⌘F again closes.
export function CommandPalette({ menus }: { menus: { title: string; items: MenuItem[] }[] }) {
  // Read once as it opens, so titles that follow the state ("Last Filter: Gaussian Blur") are current.
  const entries = useMemo(() => [...menuEntries(menus), ...maskEntries(), ...toolEntries()], [])
  const [query, setQuery] = useState(''), [chosen, setChosen] = useState(0)
  const results = useMemo(() => rankPalette(entries, query), [entries, query])
  const list = useRef<HTMLDivElement>(null)
  useEffect(() => { list.current?.children[chosen]?.scrollIntoView({ block: 'nearest' }) }, [chosen, results])
  // Closed first, so the command finds the editor as it was, with no panel open.
  const run = (entry: PaletteEntry | undefined) => { if (!entry?.enabled) return; close(); setTimeout(() => { entry.run(); requestRender(false) }) }
  const key = (event: React.KeyboardEvent) => {
    const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0
    if (step) { event.preventDefault(); if (results.length) setChosen(c => ((c + step) % results.length + results.length) % results.length) }
    else if (event.key === 'Enter') { event.preventDefault(); run(results[chosen]) }
    else if (event.key === 'Escape' || sameChord(chordOf(event.nativeEvent) ?? undefined, shortcut('Search Commands'))) { event.preventDefault(); close() }
    event.stopPropagation()
  }
  return (
    <div className="modal-back" onPointerDown={e => { if (e.target === e.currentTarget) close() }}>
      <div className="palette" onKeyDown={key}>
        <input type="text" placeholder="Search commands and tools" value={query} onChange={e => { setQuery(e.target.value); setChosen(0) }} autoFocus spellCheck={false} />
        <div className="results" ref={list}>
          {results.map((entry, index) => (
            <div key={entry.id} className={`row ${index === chosen ? 'chosen' : ''} ${entry.enabled ? '' : 'off'}`} onPointerMove={() => setChosen(index)} onClick={() => run(entry)}>
              {entry.on && <span className="check">✓</span>}<span className="title">{entry.title}</span>{entry.shortcut && <span className="key">{entry.shortcut}</span>}
            </div>
          ))}
          {!results.length && <div className="empty muted">No commands match</div>}
        </div>
      </div>
    </div>
  )
}
