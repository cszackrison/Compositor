import { useEffect, useState, useSyncExternalStore } from 'react'
import { useEditor } from './hooks'
import { store, tabs, type Tool } from '../editor/store'
import { clearRecent, loadRecent, recentProjects, subscribeRecent } from '../io/recent'
import { closeProject, openRecent, documentName, downloadZip, exportImage, importImage, openFiles, openProject, openSample, openZip, placeImages, save } from '../editor/actions'
import { copy, cut, layerViaCopy, paste } from '../editor/clipboard'
import { readDrop, canWriteDirectories } from '../io/files'
import { adjustmentKinds, blendModes } from '../model/types'
import { MenuBar, type MenuItem } from './Menu'
import { Stage, actualSize, fit, zoomBy, activeHandler } from './Stage'
import { LayersPanel } from './LayersPanel'
import { Inspector } from './Inspector'
import { ToolRail, ToolHeader } from './Tools'
import { TabBar } from './Tabs'
import { DialogHost } from './Dialogs'
import { ColorPickerHost } from './ColorPicker'
import { FilterHost } from './Filters'
import { prefs, setPrefs, subscribePrefs } from '../editor/prefs'
import { definitionFor, shortcutText, subscribeShortcuts } from '../editor/shortcuts'
import { brushKey } from '../tools/paint'
import { beginTransformSelection } from '../editor/floating'
import { clearGuides } from '../tools/guides'
import { requestRender } from './canvasState'

const open = (panel: string) => () => store.set({ panel })
const has = () => store.hasDocument
const busy = () => !!activeHandler().busy?.()
const pixelLayer = () => { const l = store.active; return !!l?.image && !l.isGroup && !l.adjustment && !store.state.editingMask }
const filterable = () => has() && pixelLayer()

// Every command a shortcut can run, by its title in the shortcut list.
const commands: Record<string, { run: () => void; enabled?: () => boolean }> = {
  Undo: { run: () => store.undo(), enabled: () => store.history.canUndo && !busy() },
  Redo: { run: () => store.redo(), enabled: () => store.history.canRedo && !busy() },
  'New Canvas': { run: open('New Canvas') },
  'Open Project': { run: openProject },
  Save: { run: () => save(), enabled: has },
  'Save As': { run: () => save(true), enabled: () => has() && canWriteDirectories },
  'Export PNG': { run: () => exportImage('png'), enabled: has },
  'Export JPEG': { run: open('Export JPEG'), enabled: has },
  'Close Project': { run: () => closeProject(), enabled: has },
  'Fit Canvas': { run: fit, enabled: has },
  'Actual Pixels': { run: actualSize, enabled: has },
  'Zoom In': { run: () => zoomBy(2), enabled: has },
  'Zoom Out': { run: () => zoomBy(0.5), enabled: has },
  'Show Transform Controls': { run: () => setPrefs({ transformControls: !prefs.transformControls }) },
  Cut: { run: () => cut(), enabled: () => has() && !!store.state.selection },
  Copy: { run: () => copy(), enabled: has },
  'Copy Merged': { run: () => copy(true), enabled: has },
  Paste: { run: () => paste() },
  'Fill with Foreground': { run: () => store.fill(store.paletteColor('foreground')), enabled: () => !!store.active },
  'Fill with Background': { run: () => store.fill(store.paletteColor('background')), enabled: () => !!store.active },
  'Content-Aware Fill': { run: open('Content-Aware Fill'), enabled: () => filterable() && !!store.state.selection },
  'Select All': { run: () => store.selectAll(), enabled: has },
  Deselect: { run: () => store.deselect(), enabled: () => !!store.state.selection },
  'Inverse Selection': { run: () => store.invertSelection(), enabled: has },
  Curves: { run: open('Curves'), enabled: filterable },
  Levels: { run: open('Levels'), enabled: filterable },
  'Hue/Saturation': { run: open('Hue/Saturation'), enabled: filterable },
  'Invert Pixels / Mask': { run: () => store.invertPixels(), enabled: () => !!store.active },
  'Canvas Size': { run: open('Canvas Size'), enabled: has },
  'Image Size': { run: open('Image Size'), enabled: has },
  'Transform Layer / Selection': { run: () => { if (!beginTransformSelection()) store.setTool('move') }, enabled: has },
  'Duplicate / Layer via Copy': { run: layerViaCopy, enabled: () => !!store.active },
  'Toggle Clipping Mask': { run: () => store.toggleClip(), enabled: () => store.canToggleClip },
  'Group Layers': { run: () => store.group(), enabled: () => !!store.active },
  'Ungroup Layers': { run: () => store.ungroup(), enabled: () => !!store.active?.isGroup },
  'New Blank Layer': { run: () => store.addBlankLayer(), enabled: has },
  'Move Layer Up': { run: () => store.stepLayer(1), enabled: () => !!store.active },
  'Move Layer Down': { run: () => store.stepLayer(-1), enabled: () => !!store.active },
  'Merge Layers': { run: () => store.mergeDown(), enabled: () => store.canMerge },
  'Show Grid': { run: () => setPrefs({ grid: !prefs.grid }) },
  'Show Guides': { run: () => setPrefs({ guides: !prefs.guides }) },
  'Show Rulers': { run: () => setPrefs({ rulers: !prefs.rulers }) },
  Snap: { run: () => setPrefs({ snap: !prefs.snap }) },
  'Lock Guides': { run: () => setPrefs({ lockGuides: !prefs.lockGuides }) },
}

const toolKeys: Record<string, Tool> = {
  'Move / Transform tool': 'move', 'Hand tool': 'hand', 'Zoom tool': 'zoom', 'Brush tool': 'brush', Eraser: 'eraser', 'Spot Healing': 'heal', 'Clone Stamp': 'clone',
  'Gradient tool': 'gradient', 'Shape tool': 'shape', 'Eyedropper tool': 'eyedropper', 'Marquee / cycle shape': 'marquee', Magic: 'wand', 'Lasso / cycle mode': 'lasso',
  'Blur / Smudge / Liquify': 'smear', 'Crop tool': 'crop',
}

// Tab steps through the active tool's modes, as in the Mac app.
function cycleMode() {
  const s = store.state
  const next = <T,>(list: T[], value: T) => list[(list.indexOf(value) + 1) % list.length]
  switch (s.tool) {
    case 'marquee': store.set({ marqueeShape: s.marqueeShape === 'rect' ? 'ellipse' : 'rect' }); break
    case 'lasso': store.set({ lassoKind: s.lassoKind === 'freehand' ? 'polygonal' : 'freehand' }); break
    case 'brush': case 'eraser': store.setTool(s.tool === 'brush' ? 'eraser' : 'brush'); break
    case 'shape': store.set({ shape: { ...s.shape, kind: next(['Rectangle', 'Ellipse', 'Line'], s.shape.kind) } }); break
    case 'smear': store.set({ smearMode: next(['Liquify', 'Blur', 'Smudge'], s.smearMode) }); break
    case 'heal': store.set({ healMode: next(['Content-Aware', 'Create Texture', 'Proximity Match'], s.healMode) }); break
    case 'clone': store.set({ clone: { ...s.clone, sampleAll: !s.clone.sampleAll } }); break
    case 'gradient': store.set({ gradient: { ...s.gradient, shape: s.gradient.shape === 'Linear' ? 'Radial' : 'Linear' } }); break
  }
}

function canvasCommand(title: string): boolean {
  const s = store.state
  if (toolKeys[title]) {
    const tool = toolKeys[title]
    if (tool === 'marquee' && s.tool === 'marquee') { cycleMode(); return true }
    if (tool === 'lasso' && s.tool === 'lasso') { cycleMode(); return true }
    store.setTool(tool)
    return true
  }
  if (title === 'Select tool') { store.setTool('move'); return true }
  if (title === 'Swap foreground/background') { store.swapColors(); return true }
  if (title === 'Reset colors') { store.resetColors(); return true }
  if (title === 'Cycle tool mode') { cycleMode(); return true }
  if (title === 'Cycle shape kind') { if (s.tool === 'shape') cycleMode(); else store.setTool('shape'); return true }
  if (title === 'Delete selection / layer / effect') { if (s.selection && !s.editingMask) store.fill(null); else if (s.selection) store.fill([0, 0, 0]); else store.deleteSelected(); return true }
  if (title === 'Previous blend mode' || title === 'Next blend mode') {
    const layer = store.active
    if (!layer || layer.isGroup) return true
    const index = blendModes.indexOf(layer.blendMode), step = title === 'Next blend mode' ? 1 : -1
    store.setBlend(layer.id, blendModes[(index + step + blendModes.length) % blendModes.length])
    return true
  }
  const nudge = /^(Nudge|Move selected pixels) (Left|Right|Up|Down) (1|10) px$/.exec(title)
  if (nudge && has()) {
    const n = +nudge[3], [dx, dy] = { Left: [-n, 0], Right: [n, 0], Up: [0, -n], Down: [0, n] }[nudge[2] as 'Left']
    if (nudge[1] === 'Move selected pixels') { import('../editor/clipboard').then(({ beginPixelMove }) => { const move = beginPixelMove(false); if (move) { move.preview(dx, dy); move.finish() } }); return true }
    if (['marquee', 'lasso', 'wand'].includes(s.tool) && s.selection) { store.moveSelectionBy(dx, dy); return true }
    if (s.tool === 'move' && store.active) { store.commit('Nudge', { doc: { ...store.doc, layers: store.movedLayers(dx, dy) } }, { coalesce: 'nudge' }); return true }
    return false
  }
  return false
}

export function App() {
  const state = useEditor()
  useSyncExternalStore(subscribePrefs, () => prefs)
  const recent = useSyncExternalStore(subscribeRecent, recentProjects)
  useEffect(() => { loadRecent() }, [])
  const [, setShortcutVersion] = useState(0)
  useEffect(() => subscribeShortcuts(() => setShortcutVersion(v => v + 1)), [])
  const [dragging, setDragging] = useState(false)
  const active = store.active
  const doc = has()
  const sc = (title: string) => shortcutText(title)
  const item = (label: string, command: string, extra: Partial<Exclude<MenuItem, 'divider'>> = {}): MenuItem => ({ label, shortcut: sc(command), action: commands[command].run, disabled: commands[command].enabled ? !commands[command].enabled!() : false, ...extra })
  const filter = (name: string): MenuItem => ({ label: `${name}…`, action: open(name), disabled: !filterable() })

  const menus: { title: string; items: MenuItem[] }[] = [
    { title: 'File', items: [
      item('New Canvas…', 'New Canvas'),
      item(canWriteDirectories ? 'Open Project…' : 'Open Project Folder (read only)…', 'Open Project'),
      { label: 'Open Recent', disabled: !canWriteDirectories, submenu: [
        ...recent.map(r => ({ label: r.name, action: () => openRecent(r) })),
        ...(recent.length ? ['divider' as const] : []),
        { label: 'Clear Menu', action: clearRecent, disabled: !recent.length },
      ] },
      { label: 'Open Zipped Project…', action: openZip },
      { label: 'Import Images…', action: importImage },
      { label: 'Open Sample Project', action: openSample },
      'divider',
      item(canWriteDirectories ? 'Save' : 'Save (Download Zip)', 'Save'),
      item('Save As…', 'Save As'),
      { label: 'Download as Zip', action: downloadZip, disabled: !doc },
      'divider',
      item('Export PNG…', 'Export PNG'),
      item('Export JPEG…', 'Export JPEG'),
      'divider',
      item('Close Project', 'Close Project'),
    ] },
    { title: 'Edit', items: [
      item(store.history.undoName ? `Undo ${store.history.undoName}` : 'Undo', 'Undo'),
      item(store.history.redoName ? `Redo ${store.history.redoName}` : 'Redo', 'Redo'),
      'divider',
      item('Cut', 'Cut'), item('Copy', 'Copy'), item('Copy Merged', 'Copy Merged'), item('Paste', 'Paste'),
      'divider',
      { label: 'Keyboard Shortcuts…', action: open('Keyboard Shortcuts') },
      item('Fill with Foreground Color', 'Fill with Foreground'),
      item('Fill with Background Color', 'Fill with Background'),
      { label: 'Clear Selection Pixels', action: () => store.fill(null), disabled: !state.selection || !active },
      item('Content-Aware Fill…', 'Content-Aware Fill'),
    ] },
    { title: 'Select', items: [
      item('All', 'Select All'), item('Deselect', 'Deselect'), item('Inverse', 'Inverse Selection'),
      { label: 'Layer’s Pixels', action: () => active && store.loadSelection(active.id, false), disabled: !active?.image || active.isGroup },
      { label: 'Color Range…', action: open('Color Range'), disabled: !doc },
      { label: 'Mask’s Black Areas', action: () => active && store.loadSelection(active.id, true), disabled: !active?.mask },
      'divider',
      { label: 'Expand…', action: open('Expand Selection'), disabled: !state.selection },
      { label: 'Contract…', action: open('Contract Selection'), disabled: !state.selection },
      { label: 'Feather…', action: open('Feather Selection'), disabled: !state.selection },
    ] },
    { title: 'Image', items: [
      item('Curves…', 'Curves'), item('Levels…', 'Levels'), item('Hue/Saturation…', 'Hue/Saturation'),
      filter('Black & White'), filter('Color Balance'), filter('Exposure'), filter('Gradient Map'), filter('Grain'),
      item(state.editingMask ? 'Invert Mask' : 'Invert', 'Invert Pixels / Mask'),
      'divider',
      item('Canvas Size…', 'Canvas Size'), item('Image Size…', 'Image Size'),
      { label: 'Trim…', action: open('Trim'), disabled: !doc },
      { label: 'Crop to Selection', action: () => store.cropToSelection(), disabled: !state.selection },
      'divider',
      { label: 'Flip Canvas Horizontal', action: () => store.flipCanvas('x'), disabled: !doc },
      { label: 'Flip Canvas Vertical', action: () => store.flipCanvas('y'), disabled: !doc },
    ] },
    { title: 'Filter', items: ['Gaussian Blur', 'Motion Blur', 'Add Noise'].map(filter).concat([
      { label: 'Vignette…', action: open('Vignette'), disabled: !doc || !active || active.isGroup || !!active.adjustment || state.editingMask },
      ...['Bloom / Glow', 'Dither', 'Tonal Contrast', 'Lens Correction'].map(filter),
    ]) },
    { title: 'Layer', items: [
      { label: 'New Adjustment Layer', disabled: !doc, submenu: adjustmentKinds.map(kind => ({ label: kind === 'Invert' ? kind : `${kind}…`, action: () => store.addAdjustment(kind) })) },
      { label: 'Edit Adjustment…', action: () => active && store.set({ inspector: active.id }), disabled: !active?.adjustment },
      'divider',
      item(state.selection ? 'Transform Selection' : 'Transform Layer', 'Transform Layer / Selection'),
      item(state.selection ? 'Layer via Copy' : 'Duplicate Layer', 'Duplicate / Layer via Copy'),
      'divider',
      item(active?.clipTo ? 'Release Clipping Mask' : 'Create Clipping Mask', 'Toggle Clipping Mask'),
      'divider',
      item('Group Selected Layers', 'Group Layers'), item('Ungroup Layers', 'Ungroup Layers'),
      { label: 'Move Out of Folder', action: () => store.moveOutOfFolder(), disabled: !active?.parentId },
      item('New Blank Layer', 'New Blank Layer'),
      { label: active?.visible === false ? 'Show Layer' : 'Hide Layer', action: () => active && store.updateLayer(active.id, { visible: !active.visible }, active.visible ? 'Hide Layer' : 'Show Layer'), disabled: !active },
      'divider',
      item('Move Layer Up', 'Move Layer Up'), item('Move Layer Down', 'Move Layer Down'), item(store.mergeTitle, 'Merge Layers'),
      'divider',
      { label: 'Flip Layer Horizontal', action: () => store.flipLayer('x'), disabled: !active },
      { label: 'Flip Layer Vertical', action: () => store.flipLayer('y'), disabled: !active },
      'divider',
      { label: state.editingMask && active?.mask ? 'Delete Layer Mask' : state.selectedIds.length > 1 ? 'Delete Layers' : 'Delete Layer', action: () => store.deleteSelected(), disabled: !active },
    ] },
    { title: 'View', items: [
      item('Fit Canvas', 'Fit Canvas'), item('Actual Pixels', 'Actual Pixels'), item('Zoom In', 'Zoom In'), item('Zoom Out', 'Zoom Out'),
      { label: 'Pixel Grid (800% and above)', checked: prefs.pixelGrid, action: () => setPrefs({ pixelGrid: !prefs.pixelGrid }) },
      item('Show Transform Controls', 'Show Transform Controls', { checked: prefs.transformControls }),
      'divider',
      item('Grid', 'Show Grid', { checked: prefs.grid }),
      item('Guides', 'Show Guides', { checked: prefs.guides }),
      { label: 'Grid Settings…', action: open('Grid Settings') },
      item('Rulers', 'Show Rulers', { checked: prefs.rulers }),
      'divider',
      item('Snap', 'Snap', { checked: prefs.snap }),
      { label: 'Snap To', submenu: (['guides', 'grid', 'layers', 'bounds'] as const).map(key => ({ label: { guides: 'Guides', grid: 'Grid', layers: 'Layers', bounds: 'Document Bounds' }[key], checked: prefs.snapTo[key], action: () => setPrefs({ snapTo: { ...prefs.snapTo, [key]: !prefs.snapTo[key] } }) })) },
      'divider',
      item('Lock Guides', 'Lock Guides', { checked: prefs.lockGuides }),
      { label: 'Clear Guides', action: clearGuides, disabled: !state.doc.guides.length },
    ] },
    { title: 'Help', items: [{ label: 'About Compositor for the Web', action: open('About') }] },
  ]

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement
      if (target.closest('input, select, textarea') && !(target as HTMLInputElement).type?.match(/range|checkbox|radio|color|button/)) return
      if (store.state.panel && !['Color Range'].includes(store.state.panel)) return
      const run = (action: () => void) => { event.preventDefault(); action(); requestRender(false) }
      // The tool first: Return applies, Escape cancels, and painting tools take their own keys.
      if (activeHandler().key?.(event)) { event.preventDefault(); return }
      if (brushKey(event)) { event.preventDefault(); return }
      const definition = definitionFor(event)
      if (!definition) return
      if (definition.group === 'Menus') {
        const command = commands[definition.title]
        if (!command || (command.enabled && !command.enabled())) { event.preventDefault(); return }
        return run(command.run)
      }
      if (busy() && !definition.title.startsWith('Opacity')) return
      if (definition.title.startsWith('Opacity digit')) return
      if (!has() && !toolKeys[definition.title]) return
      if (canvasCommand(definition.title)) event.preventDefault()
    }
    const unload = (event: BeforeUnloadEvent) => { if (tabs.some(tab => tab.hasDocument && !tab.state.saved)) event.preventDefault() }
    const onPaste = (event: ClipboardEvent) => {
      const target = event.target as HTMLElement
      if (target.closest('input, textarea')) return
      event.preventDefault()
      paste(event)
    }
    const onCopy = (event: ClipboardEvent) => { if (!(event.target as HTMLElement).closest('input, textarea')) { event.preventDefault(); copy() } }
    const onCut = (event: ClipboardEvent) => { if (!(event.target as HTMLElement).closest('input, textarea') && store.state.selection) { event.preventDefault(); cut() } }
    window.addEventListener('keydown', keydown)
    window.addEventListener('beforeunload', unload)
    window.addEventListener('paste', onPaste)
    window.addEventListener('copy', onCopy)
    window.addEventListener('cut', onCut)
    return () => { window.removeEventListener('keydown', keydown); window.removeEventListener('beforeunload', unload); window.removeEventListener('paste', onPaste); window.removeEventListener('copy', onCopy); window.removeEventListener('cut', onCut) }
  }, [])

  useEffect(() => { document.title = doc ? `${documentName()}${state.saved ? '' : ' — Edited'} · Compositor` : 'Compositor' }, [doc, state.saved, state.target])

  const onDrop = async (event: React.DragEvent) => {
    if (event.dataTransfer.types.includes('application/x-compositor-layers') || event.dataTransfer.types.includes('application/x-compositor-tab')) return
    event.preventDefault()
    setDragging(false)
    const { project, images } = await readDrop(event.dataTransfer).catch(error => { store.notify(error.message); return { project: undefined, images: [] } })
    if (project) await openFiles(project.files, project.target)
    if (images.length) await placeImages(images)
  }

  return (
    <div className="app" onDragOver={e => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDragging(true) } }} onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false) }} onDrop={onDrop}>
      <header className="menubar">
        <span className="title"><img src="./icon.png" alt="" />Compositor</span>
        <MenuBar menus={menus} />
        <span className="doc">{doc ? `${documentName()}${state.saved ? '' : ' — Edited'}` : ''}</span>
      </header>
      <ToolHeader />
      <ToolRail />
      <main style={{ gridRow: 3, gridColumn: 2, position: 'relative', minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <TabBar />
        <div style={{ flex: 1, position: 'relative' }}>
          <Stage />
          {!doc && <Welcome />}
          {dragging && <div className="drop" />}
        </div>
      </main>
      <div style={{ gridRow: 3, gridColumn: 3, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <LayersPanel />
        <Inspector />
      </div>
      <DialogHost />
      <ColorPickerHost />
      <FilterHost />
      {state.message && <div className={`toast ${state.message.kind}`}>{state.message.text}</div>}
    </div>
  )
}

function Welcome() {
  return (
    <div className="welcome">
      <div className="card">
        <img src="./icon.png" alt="" />
        <h1>Compositor</h1>
        <p className="muted">Open a <code>.comp</code> project from the Mac app, start a new canvas, or drop an image here.</p>
        <div className="actions">
          <button className="primary" onClick={open('New Canvas')}>New Canvas…</button>
          <button onClick={openProject}>Open Project Folder…</button>
          <button onClick={openZip}>Open Zipped Project…</button>
          <button onClick={importImage}>Open Image…</button>
          <button onClick={openSample}>Open Sample Project</button>
        </div>
      </div>
    </div>
  )
}

