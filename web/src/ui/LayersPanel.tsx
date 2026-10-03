import { Fragment, useCallback, useRef, useState, useSyncExternalStore, type DragEvent } from 'react'
import { useEditor } from './hooks'
import { store } from '../editor/store'
import { type Layer, adjustmentKinds, blendModeGroups, effectKinds, effectNames, type BlendMode, type EffectKind } from '../model/types'
import { subscribeThumbnails, thumbnail, thumbnailsVersion } from './thumbnails'
import { Icon } from './icons'
import { defaultEffect } from './Inspector'
import { ContextMenu, type MenuItem } from './Menu'
import { isMac } from '../editor/shortcuts'
import { setDraggedLayers } from './Tabs'
import { useCoarse } from './layout'

const command = isMac ? '⌘' : 'Ctrl'
const commandKey = (e: React.MouseEvent) => isMac ? e.metaKey : e.ctrlKey
// Option-click in the bottom strip of a row (the boundary with the row below) toggles that layer's clipping. Folders have no strip.
const clipZone = (e: React.MouseEvent, layer: Layer) => { if (layer.isGroup) return false; const box = (e.currentTarget as HTMLElement).getBoundingClientRect(); return e.clientY >= box.bottom - Math.min(10, box.height / 3) }

type Row = { layer: Layer; depth: number; hiddenByParent: boolean }

function rows(layers: Layer[], collapsed: Set<string>): Row[] {
  const out: Row[] = []
  const walk = (parent: string | null, depth: number, hidden: boolean) => {
    for (const layer of layers.filter(l => l.parentId === parent).reverse()) {
      out.push({ layer, depth, hiddenByParent: hidden })
      if (layer.isGroup && !collapsed.has(layer.id)) walk(layer.id, depth + 1, hidden || !layer.visible)
    }
  }
  walk(null, 0, false)
  return out
}

export function BlendSelect({ value, onChange }: { value: BlendMode; onChange: (mode: BlendMode) => void }) {
  return (
    <select value={value} onChange={e => onChange(e.target.value as BlendMode)}>
      {blendModeGroups.map((group, i) => <optgroup key={i} label={i ? '──────' : ''}>{group.map(mode => <option key={mode}>{mode}</option>)}</optgroup>)}
    </select>
  )
}

function Appearance() {
  const state = useEditor()
  const layer = store.layer(state.activeId)
  if (!layer) return <section className="appearance"><span className="muted" style={{ gridColumn: '1 / -1' }}>No layer selected</span></section>
  const opacity = Math.round(layer.opacity * 100)
  return (
    <section className="appearance">
      <span className="muted">Blend</span>
      {layer.isGroup ? <select disabled value="Pass Through"><option>Pass Through</option></select> : <BlendSelect value={layer.blendMode} onChange={mode => store.setBlend(layer.id, mode)} />}
      <span className="muted">Opacity</span>
      <input type="range" min={0} max={100} value={opacity} onChange={e => store.updateLayer(layer.id, { opacity: +e.target.value / 100 }, 'Opacity', 'opacity')} />
      <input type="number" min={0} max={100} value={opacity} style={{ width: 52 }} onChange={e => store.updateLayer(layer.id, { opacity: Math.min(100, Math.max(0, +e.target.value)) / 100 }, 'Opacity', 'opacity')} />
    </section>
  )
}

function Popup({ label, icon, items, disabled }: { label: string; icon: string; items: { label: string; action: () => void; disabled?: boolean }[]; disabled?: boolean }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="menu" style={{ position: 'relative' }} onPointerLeave={e => { if (e.pointerType === 'mouse') setOpen(false) }}>
      <button className="icon" title={label} disabled={disabled} onClick={() => setOpen(!open)}><Icon name={icon} /></button>
      {open && <div className="menu-list" style={{ top: 'auto', bottom: '100%', left: 0 }}>{items.map(item => <button key={item.label} disabled={item.disabled} onClick={() => { setOpen(false); item.action() }}><span>{item.label}</span></button>)}</div>}
    </div>
  )
}

export function LayersPanel() {
  const state = useEditor()
  useSyncExternalStore(subscribeThumbnails, thumbnailsVersion)
  const [collapsed, setCollapsed] = useState(new Set<string>())
  const [renaming, setRenaming] = useState<string | null>(null)
  const [drop, setDrop] = useState<{ id: string; where: 'above' | 'below' | 'into' } | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const closeMenu = useCallback(() => setMenu(null), [])
  const list = rows(state.doc.layers, collapsed)
  const active = store.layer(state.activeId)

  // The Mac app's layer menu, in its order: right-clicking a row outside the selection selects it, inside it makes it primary.
  const openMenu = (event: React.MouseEvent, layer: Layer) => {
    event.preventDefault()
    // A long press already opened it on touch; Android sends contextmenu too.
    if (Date.now() - touchedAt.current < 1500) return
    openMenuAt(event.clientX, event.clientY, layer, (event.target as HTMLElement).classList.contains('mask'))
  }
  const openMenuAt = (x: number, y: number, layer: Layer, onMask: boolean) => {
    if (store.state.selectedIds.includes(layer.id)) store.set({ activeId: layer.id, editingMask: onMask, inspector: layer.adjustment ? layer.id : store.state.inspector })
    else { store.setActive(layer.id); store.set({ editingMask: onMask }) }
    setMenu({ x, y })
  }
  // Touch has no right-click: holding a row still for half a second opens its menu.
  const coarse = useCoarse()
  const press = useRef<{ timer: number; x: number; y: number } | null>(null), touchedAt = useRef(0)
  const cancelPress = () => { if (press.current) clearTimeout(press.current.timer); press.current = null }
  const startPress = (event: React.PointerEvent, layer: Layer, effect?: EffectKind) => {
    if (event.pointerType !== 'touch') return
    touchedAt.current = Date.now()
    const { clientX: x, clientY: y } = event, onMask = (event.target as HTMLElement).classList.contains('mask')
    cancelPress()
    press.current = { x, y, timer: window.setTimeout(() => { press.current = null; touchedAt.current = Date.now(); openMenuAt(x, y, layer, onMask); if (effect) store.set({ effectSelection: { layerId: layer.id, kind: effect } }) }, 500) }
  }
  const movePress = (event: React.PointerEvent) => { if (press.current && Math.hypot(event.clientX - press.current.x, event.clientY - press.current.y) > 10) cancelPress() }
  const menuItems = (): MenuItem[] => {
    const layer = store.active
    if (!layer) return []
    const several = store.state.selectedIds.length > 1
    const plain = !layer.isGroup && !layer.adjustment
    const effect = store.state.effectSelection
    // What a double-click or a drag does with a mouse, for fingers.
    const touchItems: MenuItem[] = coarse ? [
      ...(effect ? [{ label: `Edit ${effectNames[effect.kind]}…`, action: () => store.set({ effectSelection: { ...effect, before: layer.effects?.[effect.kind] }, panel: 'Effect' }) }] : layer.adjustment || layer.effects ? [{ label: layer.adjustment ? 'Edit Adjustment…' : 'Edit Layer…', action: () => store.set({ inspector: layer.id }) }] : []),
      { label: 'Move Up', action: () => store.stepLayer(1) },
      { label: 'Move Down', action: () => store.stepLayer(-1) },
      'divider',
    ] : []
    return [
      ...touchItems,
      { label: 'Duplicate Layer', action: () => store.duplicate() },
      { label: 'Rename…', action: () => setRenaming(layer.id), disabled: several },
      { label: store.state.effectSelection ? `Delete ${effectNames[store.state.effectSelection.kind]}` : store.state.editingMask && layer.mask ? 'Delete Mask' : several ? 'Delete Selected Layers' : 'Delete Layer', action: () => store.deleteSelected() },
      'divider',
      { label: layer.clipTo ? 'Release Clipping Mask' : 'Create Clipping Mask', action: () => store.toggleClip(), disabled: !store.canToggleClip },
      { label: 'Group Selected Layers', action: () => store.group() },
      ...(layer.isGroup ? [{ label: 'Ungroup Layers', action: () => store.ungroup() }] : []),
      { label: 'Move Out of Folder', action: () => store.moveOutOfFolder(), disabled: !layer.parentId },
      { label: store.mergeTitle, action: () => store.mergeDown(), disabled: !store.canMerge },
      'divider',
      { label: 'Add Mask', disabled: !!layer.mask, submenu: [
        { label: 'Reveal All (White)', action: () => store.addMask(layer.id) },
        { label: 'Hide All (Black)', action: () => store.addMask(layer.id, true) },
        ...(store.state.selection ? [{ label: 'Reveal Selection', action: () => store.addMask(layer.id, false, true) }] : []),
      ] },
      { label: layer.mask && !layer.maskEnabled ? 'Enable Mask' : 'Disable Mask', action: () => store.updateLayer(layer.id, { maskEnabled: !layer.maskEnabled }, layer.maskEnabled ? 'Disable Layer Mask' : 'Enable Layer Mask'), disabled: !layer.mask },
      { label: 'Delete Mask', action: () => store.deleteMask(layer.id), disabled: !layer.mask },
      { label: layer.mask && !layer.maskLinked ? 'Link Mask' : 'Unlink Mask', action: () => store.toggleMaskLink(layer.id), disabled: !layer.mask || !plain },
      'divider',
      { label: layer.visible ? 'Hide Layer' : 'Show Layer', action: () => store.updateLayer(layer.id, { visible: !layer.visible }, layer.visible ? 'Hide Layer' : 'Show Layer') },
    ]
  }

  const onDragOver = (event: DragEvent, layer: Layer) => {
    if (event.dataTransfer.types.includes('application/x-compositor-effect')) { if (layer.image && !layer.isGroup) { event.preventDefault(); setDrop({ id: layer.id, where: 'into' }) } return }
    if (!event.dataTransfer.types.includes('application/x-compositor-layers')) return
    event.preventDefault()
    const box = (event.currentTarget as HTMLElement).getBoundingClientRect(), y = (event.clientY - box.top) / box.height
    setDrop({ id: layer.id, where: layer.isGroup && y > 0.3 && y < 0.7 ? 'into' : y < 0.5 ? 'above' : 'below' })
  }
  const onDrop = (event: DragEvent) => {
    event.preventDefault()
    const effect = event.dataTransfer.getData('application/x-compositor-effect')
    if (effect) { const { layerId, kind } = JSON.parse(effect); if (drop) store.copyEffect(layerId, kind, drop.id); setDrop(null); return }
    const ids = JSON.parse(event.dataTransfer.getData('application/x-compositor-layers') || '[]') as string[]
    if (drop && ids.length) {
      if (event.altKey) { store.setActive(ids[0]); store.duplicate(); ids.splice(0, ids.length, store.state.activeId!) }
      store.move(ids, drop.where === 'into' ? { into: drop.id } : drop.where === 'above' ? { above: drop.id } : { below: drop.id })
    }
    setDrop(null)
  }

  return (
    <aside className="side">
      <h2><span>Layers</span><span className="muted">{state.doc.layers.length}</span></h2>
      <Appearance />
      <div className="layers" onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDrop(null) }}>
        {!store.hasDocument && <p className="muted" style={{ padding: 16, textAlign: 'center' }}>Create a canvas or open a project.</p>}
        {list.map(({ layer, depth, hiddenByParent }) => {
          const selected = state.selectedIds.includes(layer.id), isActive = layer.id === state.activeId
          const classes = ['layer', isActive && 'active', selected && 'selected', hiddenByParent && 'hidden-by-parent', drop?.id === layer.id && `drop-${drop.where}`].filter(Boolean).join(' ')
          const editingMask = isActive && state.editingMask
          return (
            <Fragment key={layer.id}>
            <div className={classes} style={{ paddingLeft: 4 + depth * 16 }} draggable={renaming !== layer.id && !coarse} onPointerMoveCapture={movePress} onPointerUp={cancelPress} onPointerCancel={cancelPress}
              onDragStart={e => { const ids = selected ? state.selectedIds : [layer.id]; e.dataTransfer.setData('application/x-compositor-layers', JSON.stringify(ids)); setDraggedLayers(ids); e.dataTransfer.effectAllowed = 'copyMove' }} onDragEnd={() => setDraggedLayers(null)}
              onDragOver={e => onDragOver(e, layer)} onDrop={onDrop} onContextMenu={e => openMenu(e, layer)}
              onPointerDown={e => { startPress(e, layer); if (e.button === 0 && e.altKey && !commandKey(e) && clipZone(e, layer) && !(e.target as HTMLElement).classList.contains('mask')) { store.set({ effectSelection: null }); store.toggleClip(layer.id); e.preventDefault(); return } if (e.button === 0 && !(e.target as HTMLElement).closest('button,input')) { store.setActive(layer.id, e.shiftKey ? 'range' : e.metaKey || e.ctrlKey ? 'toggle' : 'none'); if (!(e.target as HTMLElement).classList.contains('mask')) store.set({ editingMask: false }) } }}
              onDoubleClick={e => { if ((e.target as HTMLElement).classList.contains('name')) setRenaming(layer.id); else if (layer.adjustment || layer.effects) store.set({ inspector: layer.id }) }}
              onPointerMove={e => { const zone = clipZone(e, layer); (e.currentTarget as HTMLElement).style.cursor = e.altKey && !commandKey(e) ? (zone ? (store.canToggleClipFor(layer.id) ? 'alias' : 'default') : 'copy') : '' }}>
              <button className={`icon eye ${layer.visible ? '' : 'off'}`} title={layer.visible ? 'Hide' : 'Show'} onClick={() => store.updateLayer(layer.id, { visible: !layer.visible }, layer.visible ? 'Hide Layer' : 'Show Layer')}><Icon name={layer.visible ? 'eye' : 'eyeOff'} /></button>
              {layer.isGroup ? <span className="chevron" onClick={() => { const next = new Set(collapsed); next.has(layer.id) ? next.delete(layer.id) : next.add(layer.id); setCollapsed(next) }}><Icon name={collapsed.has(layer.id) ? 'chevronRight' : 'chevronDown'} size={12} /></span> : <span className="clip" title={layer.clipTo ? 'Clipped to the layer below' : undefined}>{layer.clipTo ? '↳' : ''}</span>}
              {layer.isGroup ? <span className="thumb" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'none' }}><Icon name="folder" size={20} /></span>
                : layer.adjustment ? <span className="thumb" title={layer.adjustment.kind} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'none' }} onClick={() => store.set({ inspector: layer.id })}><Icon name="adjust" size={20} /></span>
                : layer.image ? <img className={`thumb ${isActive && !editingMask ? 'target' : ''}`} src={thumbnail(layer.image, `${layer.id}:image`)} alt="" title={`${command}-click loads the layer’s pixels as a selection`} onClick={e => { if (commandKey(e)) store.loadSelection(layer.id, false, e.altKey ? 'subtract' : e.shiftKey ? 'add' : 'replace'); else store.set({ editingMask: false }) }} /> : <span className="thumb" />}
              {layer.mask && <img className={`thumb mask ${editingMask ? 'target' : ''} ${layer.maskEnabled ? '' : 'disabled'}`} src={thumbnail(layer.mask, `${layer.id}:mask`)} alt="" title={`Layer mask: click to edit, Shift-click to disable, ${command}-click selects its black areas`} onClick={e => { if (commandKey(e)) store.loadSelection(layer.id, true, e.altKey ? 'subtract' : e.shiftKey ? 'add' : 'replace'); else if (e.shiftKey) store.updateLayer(layer.id, { maskEnabled: !layer.maskEnabled }, layer.maskEnabled ? 'Disable Mask' : 'Enable Mask'); else { store.setActive(layer.id); store.set({ editingMask: true }) } }} />}
              <span className="name">{renaming === layer.id ? <input autoFocus defaultValue={layer.name} onBlur={e => { const name = e.target.value.trim(); if (name && name !== layer.name) store.updateLayer(layer.id, { name }, 'Rename Layer'); setRenaming(null) }} onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setRenaming(null); e.stopPropagation() }} /> : layer.name}</span>
              {layer.effects && Object.values(layer.effects).some(Boolean) && <span className="badge" title="Layer effects">fx</span>}
              {layer.blendMode !== 'Normal' && !layer.isGroup && <span className="badge" title={layer.blendMode}>◐</span>}
            </div>
            {layer.effects && effectKinds.filter(kind => layer.effects![kind]).map(kind => {
              const effect = layer.effects![kind]!, shown = effect.enabled !== false
              return (
                <div key={kind} className={`layer effect-row ${state.effectSelection?.layerId === layer.id && state.effectSelection.kind === kind ? 'active' : ''}`} style={{ paddingLeft: 4 + depth * 16 }} title={`Click to select; double-click to edit; ${isMac ? 'Option' : 'Alt'}-drag to copy ${effectNames[kind].toLowerCase()}`}
                  draggable={!coarse} onPointerDown={e => startPress(e, layer, kind)} onPointerMove={movePress} onPointerUp={cancelPress} onPointerCancel={cancelPress} onDragStart={e => { e.stopPropagation(); e.dataTransfer.setData('application/x-compositor-effect', JSON.stringify({ layerId: layer.id, kind })); e.dataTransfer.effectAllowed = 'copy' }}
                  onClick={() => store.set({ activeId: layer.id, selectedIds: [layer.id], editingMask: false, effectSelection: { layerId: layer.id, kind } })}
                  onDoubleClick={() => store.set({ activeId: layer.id, selectedIds: [layer.id], effectSelection: { layerId: layer.id, kind, before: effect }, panel: 'Effect' })}
                  onContextMenu={e => { e.stopPropagation(); openMenu(e, layer); store.set({ effectSelection: { layerId: layer.id, kind } }) }}>
                  <button className={`icon eye ${shown ? '' : 'off'}`} title={shown ? 'Hide effect' : 'Show effect'} onClick={e => { e.stopPropagation(); store.updateLayer(layer.id, { effects: { ...layer.effects, [kind]: { ...effect, enabled: !shown } } }, `${shown ? 'Hide' : 'Show'} ${effectNames[kind]}`) }}><Icon name={shown ? 'eye' : 'eyeOff'} size={13} /></button>
                  <span className="name" style={{ paddingLeft: 40 }}>{effectNames[kind]}</span>
                </div>
              )
            })}
            </Fragment>
          )
        })}
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems()} onClose={closeMenu} />}
      <div className="footer">
        <button className="icon" title="New blank layer (⇧⌘N)" disabled={!store.hasDocument} onClick={() => store.addBlankLayer()}><Icon name="plus" /></button>
        <button className="icon" title="Group selected layers (⌘G)" disabled={!active} onClick={() => store.group()}><Icon name="folder" /></button>
        <Popup label="Layer mask" icon="mask" disabled={!active} items={active?.mask ? [
          { label: active.maskEnabled ? 'Disable Mask' : 'Enable Mask', action: () => store.updateLayer(active.id, { maskEnabled: !active.maskEnabled }, 'Toggle Mask') },
          { label: 'Apply Mask', action: () => store.deleteMask(active.id, true), disabled: !active.image },
          { label: 'Delete Mask', action: () => store.deleteMask(active.id) },
        ] : [
          { label: 'Reveal All', action: () => active && store.addMask(active.id) },
          ...(state.selection ? [{ label: 'Reveal Selection', action: () => active && store.addMask(active.id, false, true) }] : []),
          { label: 'Hide All', action: () => active && store.addMask(active.id, true) },
        ]} />
        <Popup label="Layer effects" icon="fx" disabled={!active?.image || active.isGroup} items={effectKinds.map(kind => ({ label: `${effectNames[kind]}…`, action: () => { if (!active) return; const bg = state.background.map(v => v / 255); store.addEffect(active.id, kind, kind === 'stroke' || kind === 'colorOverlay' ? { ...defaultEffect(kind), red: bg[0], green: bg[1], blue: bg[2] } : defaultEffect(kind)) } }))} />
        <Popup label="New adjustment layer" icon="adjust" disabled={!store.hasDocument} items={adjustmentKinds.map(kind => ({ label: kind, action: () => store.addAdjustment(kind) }))} />
        <span className="spacer" />
        <button className="icon" title={state.effectSelection ? 'Delete selected effect' : 'Delete layer'} disabled={!active} onClick={() => store.deleteSelected()}><Icon name="trash" /></button>
      </div>
    </aside>
  )
}
