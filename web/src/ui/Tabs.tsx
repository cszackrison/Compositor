import { useCallback, useEffect, useRef, useState } from 'react'
import { copyLayersInto } from '../editor/clipboard'
import { activateTab, moveTab, store, tabForOpening, tabs, type Store } from '../editor/store'
import { closeProject, documentName, openFiles, placeImages } from '../editor/actions'
import { readDrop } from '../io/files'
import { useTabs } from './hooks'
import { ContextMenu, type MenuItem } from './Menu'
import type { Layer } from '../model/types'

// Layers being dragged from the Layers panel, so another project's tab (or canvas) can take a copy (Copy Layers from Project).
let dragged: { from: Store; ids: string[] } | null = null
export function setDraggedLayers(ids: string[] | null) { dragged = ids ? { from: store, ids } : null }
export const draggedFromOtherProject = () => !!dragged && dragged.from !== store

// The dragged layers with everything inside their folders, for copying elsewhere.
export function takeDraggedLayers(): Layer[] | null {
  if (!dragged) return null
  const source = dragged.from, ids = dragged.ids.filter(id => !source.ancestors(id).some(a => dragged!.ids.includes(a.id)))
  dragged = null
  return ids.flatMap(id => [source.layer(id)!, ...source.descendants(id)]).filter(Boolean)
}

const tabWidth = 170, overflowWidth = 120

export function TabBar() {
  useTabs()
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(1000)
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)
  const [dragging, setDragging] = useState<number | null>(null)
  const [airborne, setAirborne] = useState(false)
  const [target, setTarget] = useState<Store | 'new' | null>(null)
  const hover = useRef<{ tab: Store; timer: number } | null>(null)
  const closeMenu = useCallback(() => setMenu(null), [])

  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width))
    if (ref.current) observer.observe(ref.current)
    // A drag of files or layers anywhere in the window shows the "New" slot at the end of the strip.
    const enter = (e: DragEvent) => { if (e.dataTransfer?.types.some(t => t === 'Files' || t === 'application/x-compositor-layers')) setAirborne(true) }
    const end = () => { setAirborne(false); setTarget(null) }
    window.addEventListener('dragenter', enter)
    window.addEventListener('drop', end)
    window.addEventListener('dragend', end)
    return () => { observer.disconnect(); window.removeEventListener('dragenter', enter); window.removeEventListener('drop', end); window.removeEventListener('dragend', end) }
  }, [ref.current])

  const open = tabs.filter(tab => tab.hasDocument)
  if (!open.length) return null

  // When the tabs don't fit, the oldest fold into an "N more tabs" menu; the active tab always stays visible.
  const fits = Math.max(1, Math.floor((width - (airborne ? tabWidth : 0)) / tabWidth))
  let visible = open
  let hidden: Store[] = []
  if (open.length > fits) {
    const room = Math.max(1, Math.floor((width - overflowWidth - (airborne ? tabWidth : 0)) / tabWidth))
    visible = open.slice(-room)
    if (!visible.includes(store)) visible = [store, ...visible.slice(1)]
    hidden = open.filter(tab => !visible.includes(tab))
  }

  const items = (tab: Store): MenuItem[] => [
    { label: 'Close Tab', action: () => closeProject(tab) },
    { label: 'Close Other Tabs', action: () => tabs.filter(other => other !== tab).forEach(other => closeProject(other)), disabled: tabs.length < 2 },
    { label: 'Close Tabs to the Right', action: () => tabs.slice(tabs.indexOf(tab) + 1).forEach(other => closeProject(other)), disabled: tabs.indexOf(tab) === tabs.length - 1 },
  ]

  const dropInto = async (e: React.DragEvent, tab: Store | 'new') => {
    e.preventDefault(); e.stopPropagation()
    setTarget(null); setAirborne(false)
    const layers = takeDraggedLayers()
    if (layers?.length) {
      const destination = tab === 'new' ? tabForNewCopy(layers) : tab
      if (destination) { copyLayersInto(destination, layers); activateTab(destination) }
      return
    }
    const { project, images } = await readDrop(e.dataTransfer)
    if (project) { await openFiles(project.files, project.target); return }
    if (!images.length) return
    if (tab === 'new') { for (const image of images) { tabForOpening(); store.close(); await placeImages([image]) } }
    else { activateTab(tab); await placeImages(images) }
  }

  const leave = () => { if (hover.current) { clearTimeout(hover.current.timer); hover.current = null } }
  return (
    <div className="tabbar" ref={ref}>
      {hidden.length > 0 && <button className="tab overflow" onClick={e => setMenu({ x: e.clientX, y: e.clientY + 10, items: hidden.map(tab => ({ label: `${tab.state.saved ? '' : '• '}${documentName(tab)}`, action: () => activateTab(tab) })) })}>{hidden.length === 1 ? '1 more tab' : `${hidden.length} more tabs`} ▾</button>}
      {visible.map(tab => {
        const index = tabs.indexOf(tab)
        return (
          <div key={tab.state.doc.id + index} className={`tab ${tab === store ? 'active' : ''} ${target === tab ? 'drop-target' : ''}`} title={target === tab ? `Add to ${documentName(tab)}` : documentName(tab)} draggable
            onPointerDown={e => { if (e.button === 0) activateTab(tab) }}
            onAuxClick={e => { if (e.button === 1) closeProject(tab) }}
            onContextMenu={e => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, items: items(tab) }) }}
            onDragStart={e => { setDragging(index); e.dataTransfer.setData('application/x-compositor-tab', String(index)) }}
            onDragOver={e => {
              if (dragging !== null) { e.preventDefault(); return }
              const layers = dragged && dragged.from !== tab && !e.altKey, files = e.dataTransfer.types.includes('Files')
              if (!layers && !files) return
              e.preventDefault()
              setTarget(tab)
              // Holding a dragged layer over a tab opens that project, so the layer can be dropped right on its canvas.
              if (layers && tab !== store && hover.current?.tab !== tab) { leave(); hover.current = { tab, timer: window.setTimeout(() => activateTab(tab), 600) } }
            }}
            onDragLeave={() => { setTarget(t => t === tab ? null : t); leave() }}
            onDrop={e => { leave(); if (dragging !== null) { e.preventDefault(); e.stopPropagation(); if (dragging !== index) moveTab(dragging, index); setDragging(null) } else dropInto(e, tab) }}
            onDragEnd={() => setDragging(null)}>
            <span className="tab-name">{documentName(tab)}</span>
            {!tab.state.saved && <span className="tab-dot" title="Unsaved changes">●</span>}
            <button className="icon tab-close" title={`Close ${documentName(tab)}`} onPointerDown={e => e.stopPropagation()} onClick={() => closeProject(tab)}>✕</button>
          </div>
        )
      })}
      {airborne && dragging === null && <div className={`tab new-slot ${target === 'new' ? 'drop-target' : ''}`} title="Drop to open in a new canvas" onDragOver={e => { e.preventDefault(); setTarget('new') }} onDragLeave={() => setTarget(null)} onDrop={e => dropInto(e, 'new')}>+ New</div>}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={closeMenu} />}
    </div>
  )
}

// A new project the size of the one the layers come from, to copy them into.
function tabForNewCopy(layers: Layer[]): Store | null {
  const source = dragged?.from ?? tabs.find(t => t.doc.layers.some(l => l.id === layers[0]?.id)) ?? store
  const { width, height } = source.doc
  const next = tabForOpening()
  next.open({ id: crypto.randomUUID().toUpperCase(), width, height, resolution: source.doc.resolution, layers: [], guides: [], extra: {} }, null, null)
  return next
}
