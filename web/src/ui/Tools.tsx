import { useEffect, useState, useSyncExternalStore } from 'react'
import { useEditor } from './hooks'
import { openColorPicker } from './ColorPicker'
import { store, type HealMode, type ShapeKind, type SmearMode, type Tool } from '../editor/store'
import { Icon } from './icons'
import { Scrub } from './Inspector'
import { isMac, shortcutText } from '../editor/shortcuts'
import { applyGradient, cancelGradient, refreshGradient } from '../tools/gradient'
import { applyCrop, cancelCrop, cropRatios, setCropRatio } from '../tools/crop'
import { applyDistort, cancelDistort, isDistorting, maskAlone } from '../tools/move'
import { armModifier, subscribeModifiers, touchModifiers } from './canvasState'
import { useCoarse } from './layout'
import { prefs, setPrefs, subscribePrefs } from '../editor/prefs'

export const tools: { tool: Tool; label: string; shortcut: string; icon: string }[] = [
  { tool: 'move', label: 'Move / Transform', shortcut: 'Move / Transform tool', icon: 'move' },
  { tool: 'marquee', label: 'Marquee', shortcut: 'Marquee / cycle shape', icon: 'marquee' },
  { tool: 'lasso', label: 'Lasso', shortcut: 'Lasso / cycle mode', icon: 'lasso' },
  { tool: 'wand', label: 'Magic Wand', shortcut: 'Magic', icon: 'wand' },
  { tool: 'crop', label: 'Crop', shortcut: 'Crop tool', icon: 'crop' },
  { tool: 'brush', label: 'Brush', shortcut: 'Brush tool', icon: 'brush' },
  { tool: 'eraser', label: 'Eraser', shortcut: 'Eraser', icon: 'eraser' },
  { tool: 'heal', label: 'Spot Healing', shortcut: 'Spot Healing', icon: 'heal' },
  { tool: 'clone', label: 'Clone Stamp', shortcut: 'Clone Stamp', icon: 'clone' },
  { tool: 'smear', label: 'Smear', shortcut: 'Blur / Smudge / Liquify', icon: 'smear' },
  { tool: 'gradient', label: 'Gradient', shortcut: 'Gradient tool', icon: 'gradient' },
  { tool: 'shape', label: 'Shape', shortcut: 'Shape tool', icon: 'shape' },
  { tool: 'eyedropper', label: 'Eyedropper', shortcut: 'Eyedropper tool', icon: 'eyedropper' },
  { tool: 'hand', label: 'Hand', shortcut: 'Hand tool', icon: 'hand' },
  { tool: 'zoom', label: 'Zoom', shortcut: 'Zoom tool', icon: 'zoom' },
]

const option = isMac ? '⌥' : 'Alt', command = isMac ? '⌘' : 'Ctrl'

// The foreground swatch over the background one. Each opens the color picker; with a mask targeted they're black and white only,
// and a click offers Black · Hide or White · Reveal.
function Palette() {
  const state = useEditor()
  const [maskMenu, setMaskMenu] = useState<'foreground' | 'background' | null>(null)
  const pick = (which: 'foreground' | 'background') => {
    if (state.editingMask) { setMaskMenu(maskMenu === which ? null : which); return }
    const original = store.state[which]
    openColorPicker({ title: `Color Picker (${which === 'foreground' ? 'Foreground' : 'Background'} Color)`, initial: original, onChange: c => { store.set({ [which]: c }); refreshGradient() }, onCommit: c => { store.set({ [which]: c }); refreshGradient() }, onCancel: () => { store.set({ [which]: original }); refreshGradient() } })
  }
  const fg = store.paletteColor('foreground'), bg = store.paletteColor('background')
  return (
    <div className="swatches" title={state.editingMask ? 'Mask colors: black hides, white reveals (X swaps, D resets)' : 'Foreground and background colors (X swaps, D resets)'}>
      <button className="swatch fg" style={{ background: `rgb(${fg.join(',')})` }} onClick={() => pick('foreground')} />
      <button className="swatch bg" style={{ background: `rgb(${bg.join(',')})` }} onClick={() => pick('background')} />
      {maskMenu && <div className="menu-list" style={{ position: 'absolute', left: 38, top: 0, minWidth: 150 }}>
        <div className="muted" style={{ padding: '4px 10px' }}>Mask {maskMenu}</div>
        {[['Black · Hide', false], ['White · Reveal', true]].map(([label, white]) => <button key={label as string} onClick={() => { store.set({ maskPaintWhite: maskMenu === 'foreground' ? white as boolean : !white }); setMaskMenu(null); refreshGradient() }}><span>{label}</span></button>)}
      </div>}
    </div>
  )
}

export function ToolRail() {
  const state = useEditor()
  return (
    <nav className="toolrail">
      {tools.map(t => <button key={t.tool} className={`icon ${state.tool === t.tool ? 'on' : ''}`} title={`${t.label} (${shortcutText(t.shortcut, 'Canvas & Layers')})`} onClick={() => store.setTool(t.tool)}><Icon name={t.tool === 'marquee' && state.marqueeShape === 'ellipse' ? 'ellipse' : t.icon} /></button>)}
      <Palette />
      <button className="icon" title="Swap colors (X)" onClick={() => { store.swapColors(); refreshGradient() }}><Icon name="swap" size={14} /></button>
      <button className="icon" title="Default colors (D)" onClick={() => { store.resetColors(); refreshGradient() }}>↺</button>
    </nav>
  )
}

function Range({ label, value, min, max, step = 1, suffix = '', sensitivity = 1, onChange }: { label: string; value: number; min: number; max: number; step?: number; suffix?: string; sensitivity?: number; onChange: (v: number) => void }) {
  const clamp = (v: number) => Math.min(max, Math.max(min, v))
  return <label><Scrub label={label} value={value} min={min} max={max} step={step} sensitivity={sensitivity} onChange={v => onChange(clamp(v))} /><input type="range" min={min} max={max} step={step} value={value} onChange={e => onChange(+e.target.value)} /><input type="number" min={min} max={max} step={step} value={value} onChange={e => onChange(clamp(+e.target.value))} />{suffix}</label>
}

function Choice<T extends string>({ value, options, onChange }: { value: T; options: readonly T[]; onChange: (v: T) => void }) {
  return <span style={{ display: 'inline-flex', gap: 2 }}>{options.map(o => <button key={o} className={`icon ${o === value ? 'on' : ''}`} style={{ padding: '3px 8px' }} onClick={() => onChange(o)}>{o}</button>)}</span>
}

function TipControls({ strength = false }: { strength?: boolean }) {
  const state = useEditor()
  const brush = state.brush
  const set = (changes: Partial<typeof brush>) => store.set({ brush: { ...brush, ...changes } })
  return <>
    <Range label="Size" value={brush.diameter} min={1} max={2000} onChange={diameter => set({ diameter })} suffix="px" />
    <Range label="Hardness" value={Math.round(brush.hardness * 100)} min={0} max={100} onChange={v => set({ hardness: v / 100 })} suffix="%" />
    <Range label={strength ? 'Strength' : 'Opacity'} value={Math.round(brush.opacity * 100)} min={1} max={100} onChange={v => set({ opacity: v / 100 })} suffix="%" />
  </>
}

export function ToolHeader() {
  const state = useEditor()
  const coarse = useCoarse()
  useSyncExternalStore(subscribeModifiers, touchModifiers)
  useSyncExternalStore(subscribePrefs, () => prefs)
  const tool = tools.find(t => t.tool === state.tool)!
  const target = store.active
  const mask = state.editingMask && target?.mask
  return (
    <div className="toolheader">
      <span className="name">{state.tool === 'move' && maskAlone() ? 'Transform Mask' : tool.label}</span>
      {(state.tool === 'brush' || state.tool === 'eraser') && <>
        <Choice value={state.tool === 'brush' ? 'Paint' : 'Erase'} options={['Paint', 'Erase'] as const} onChange={v => store.setTool(v === 'Paint' ? 'brush' : 'eraser')} />
        <TipControls />
        <Range label="Smoothing" value={state.brush.smoothing} min={0} max={100} onChange={smoothing => store.set({ brush: { ...state.brush, smoothing } })} />
        <label title="A pen's pressure sets the brush size"><input type="checkbox" checked={prefs.penPressure} onChange={e => setPrefs({ penPressure: e.target.checked })} /> Pen Pressure</label>
        {target && <span className="muted">On {mask ? `${target.name}’s mask` : target.name}</span>}
      </>}
      {state.tool === 'heal' && <>
        <Choice value={state.healMode} options={['Content-Aware', 'Create Texture', 'Proximity Match'] as HealMode[]} onChange={healMode => store.set({ healMode })} />
        <TipControls />
      </>}
      {state.tool === 'clone' && <>
        <label><input type="checkbox" checked={state.clone.aligned} onChange={e => store.set({ clone: { ...state.clone, aligned: e.target.checked } })} /> Aligned</label>
        <Choice value={state.clone.sampleAll ? 'All Layers' : 'This Layer'} options={['This Layer', 'All Layers'] as const} onChange={v => store.set({ clone: { ...state.clone, sampleAll: v === 'All Layers' } })} />
        {coarse && <button className={touchModifiers().alt !== 'off' ? 'primary' : ''} onClick={() => armModifier('alt')}>{state.clone.source ? 'Set New Source' : 'Set Source'}</button>}
        <TipControls />
        <span className="muted">{state.clone.source ? `${option}-click sets a new source` : `${option}-click where to copy from`}</span>
      </>}
      {state.tool === 'smear' && <>
        <Choice value={state.smearMode} options={['Liquify', 'Blur', 'Smudge'] as SmearMode[]} onChange={smearMode => store.set({ smearMode })} />
        <TipControls strength />
        {state.smearMode === 'Blur' && <Range label="Radius" value={state.blurRadius} min={0.5} max={20} step={0.1} sensitivity={0.1} onChange={blurRadius => store.set({ blurRadius })} suffix="px" />}
      </>}
      {state.tool === 'gradient' && <>
        <Choice value={state.gradient.shape} options={['Linear', 'Radial'] as const} onChange={shape => { store.set({ gradient: { ...state.gradient, shape } }); refreshGradient() }} />
        <select value={state.gradient.style} onChange={e => { store.set({ gradient: { ...state.gradient, style: e.target.value as typeof state.gradient.style } }); refreshGradient() }}><option>Foreground to Transparent</option><option>Foreground to Background</option></select>
        <label><input type="checkbox" checked={state.gradient.reversed} onChange={e => { store.set({ gradient: { ...state.gradient, reversed: e.target.checked } }); refreshGradient() }} /> Reverse</label>
        <Range label="Opacity" value={Math.round(state.gradient.opacity * 100)} min={1} max={100} onChange={v => { store.set({ gradient: { ...state.gradient, opacity: v / 100 } }); refreshGradient() }} suffix="%" />
        <button onClick={applyGradient}>Apply</button><button onClick={cancelGradient}>Cancel</button>
      </>}
      {state.tool === 'shape' && <>
        <Choice value={state.shape.kind} options={['Rectangle', 'Ellipse', 'Line'] as ShapeKind[]} onChange={kind => store.set({ shape: { ...state.shape, kind } })} />
        {state.shape.kind === 'Rectangle' && <Range label="Corner Radius" value={state.shape.cornerRadius} min={0} max={200} onChange={cornerRadius => store.set({ shape: { ...state.shape, cornerRadius } })} suffix="px" />}
        {state.shape.kind === 'Line' && <Range label="Line Width" value={state.shape.lineWidth} min={1} max={100} onChange={lineWidth => store.set({ shape: { ...state.shape, lineWidth } })} suffix="px" />}
        <span className="muted">Fills with the foreground color. Shift for squares and 45° lines, {option} from the center</span>
      </>}
      {state.tool === 'crop' && <>
        <select value={state.crop.ratio} onChange={e => setCropRatio(e.target.value)}>{cropRatios.map(r => <option key={r}>{r}</option>)}</select>
        {state.crop.rect && <span className="muted">{state.crop.rect.w} × {state.crop.rect.h} px</span>}
        <button className="primary" onClick={applyCrop}>Apply Crop</button><button onClick={cancelCrop}>Cancel</button>
        <span className="muted">{option} crops symmetrically · Return applies</span>
      </>}
      {state.tool === 'marquee' && <>
        <Choice value={state.marqueeShape === 'rect' ? 'Rectangle' : 'Ellipse'} options={['Rectangle', 'Ellipse'] as const} onChange={v => store.set({ marqueeShape: v === 'Rectangle' ? 'rect' : 'ellipse' })} />
        <SelectionHeader />
      </>}
      {state.tool === 'lasso' && <>
        <Choice value={state.lassoKind === 'freehand' ? 'Freehand' : 'Polygonal'} options={['Freehand', 'Polygonal'] as const} onChange={v => store.set({ lassoKind: v === 'Freehand' ? 'freehand' : 'polygonal' })} />
        <SelectionHeader />
      </>}
      {state.tool === 'wand' && <>
        <Range label="Tolerance" value={state.wand.tolerance} min={0} max={255} onChange={tolerance => store.set({ wand: { ...state.wand, tolerance } })} />
        <select value={state.wand.sampleSize} onChange={e => store.set({ wand: { ...state.wand, sampleSize: +e.target.value } })}><option value={0}>Point Sample</option><option value={1}>3 by 3 Average</option><option value={2}>5 by 5 Average</option></select>
        <Choice value={state.wand.sampleAll ? 'All Layers' : 'This Layer'} options={['This Layer', 'All Layers'] as const} onChange={v => store.set({ wand: { ...state.wand, sampleAll: v === 'All Layers' } })} />
        <label><input type="checkbox" checked={state.wand.contiguous} onChange={e => store.set({ wand: { ...state.wand, contiguous: e.target.checked } })} /> Contiguous</label>
        <SelectionHeader />
      </>}
      {state.tool === 'move' && <MoveHeader />}
      {state.tool === 'eyedropper' && <span className="muted">Click to pick the foreground color; {option}-click picks the background</span>}
      {state.tool === 'hand' && <span className="muted">Drag to pan. Hold Space with any tool.</span>}
      {state.tool === 'zoom' && <span className="muted">Click to zoom in, {option}-click to zoom out. Pinch or {command}-scroll anywhere.</span>}
    </div>
  )
}

// Modifier keys held right now, so the mode switch can show what a click would do.
function useHeldKeys() {
  const [held, setHeld] = useState({ shift: false, alt: false })
  const touch = useSyncExternalStore(subscribeModifiers, touchModifiers)
  useEffect(() => {
    const update = (e: KeyboardEvent) => setHeld({ shift: e.shiftKey, alt: e.altKey })
    window.addEventListener('keydown', update); window.addEventListener('keyup', update)
    return () => { window.removeEventListener('keydown', update); window.removeEventListener('keyup', update) }
  }, [])
  return { shift: held.shift || touch.shift !== 'off', alt: held.alt || touch.alt !== 'off' }
}

// The rest of the Marquee, Lasso and Magic headers (LassoControls): the selection mode, anti-alias, and Expand, Contract and
// Feather applied to the current selection straight away.
function SelectionHeader() {
  const state = useEditor()
  const held = useHeldKeys()
  const shown = held.alt ? 'subtract' : held.shift ? 'add' : state.selectionMode
  const amounts = state.modifyAmounts
  const setAmount = (key: keyof typeof amounts, value: number, max: number) => store.set({ modifyAmounts: { ...amounts, [key]: Math.min(max, Math.max(1, Math.round(value) || 1)) } })
  const can = !!state.selection
  const showsAntialias = state.tool !== 'marquee' || state.marqueeShape === 'ellipse'
  return <>
    <Choice value={({ replace: 'New', add: 'Add', subtract: 'Subtract', intersect: 'New' } as const)[shown]} options={['New', 'Add', 'Subtract'] as const} onChange={v => store.set({ selectionMode: v === 'New' ? 'replace' : v === 'Add' ? 'add' : 'subtract' })} />
    {showsAntialias && <label><input type="checkbox" checked={state.selectionAntialias} onChange={e => store.set({ selectionAntialias: e.target.checked })} /> Anti-alias</label>}
    <span className="divider" />
    {(['expand', 'contract', 'feather'] as const).map(key => {
      const max = key === 'feather' ? 250 : 500
      return <label key={key}>
        <button disabled={!can} onClick={() => store.modifySelection(key, amounts[key])}>{key[0].toUpperCase() + key.slice(1)}</button>
        <input type="number" min={1} max={max} style={{ width: key === 'feather' ? 48 : 40 }} value={amounts[key]} onChange={e => setAmount(key, +e.target.value, max)} />
        <Scrub label="px" value={amounts[key]} min={1} max={max} onChange={v => setAmount(key, v, max)} />
      </label>
    })}
    <span style={{ flex: 1 }} />
    {state.selection && <button onClick={() => store.deselect()}>Deselect</button>}
  </>
}

function MoveHeader() {
  const state = useEditor()
  const target = store.active
  const distorting = !!target && isDistorting()
  return <>
    {target?.image && !target.isGroup && state.selectedIds.length <= 1 && !maskAlone() && <>
      <label><span className="muted">X</span><input type="number" value={Math.round(target.transform.origin[0])} onChange={e => store.updateLayer(target.id, { transform: { ...target.transform, origin: [+e.target.value, target.transform.origin[1]] } }, 'Move', 'position')} /></label>
      <label><span className="muted">Y</span><input type="number" value={Math.round(target.transform.origin[1])} onChange={e => store.updateLayer(target.id, { transform: { ...target.transform, origin: [target.transform.origin[0], +e.target.value] } }, 'Move', 'position')} /></label>
      <label><span className="muted">W</span><input type="number" min={1} value={Math.round(target.transform.size[0])} onChange={e => store.updateLayer(target.id, { transform: { ...target.transform, size: [Math.max(1, +e.target.value), target.transform.size[1]] } }, 'Scale', 'size')} /></label>
      <label><span className="muted">H</span><input type="number" min={1} value={Math.round(target.transform.size[1])} onChange={e => store.updateLayer(target.id, { transform: { ...target.transform, size: [target.transform.size[0], Math.max(1, +e.target.value)] } }, 'Scale', 'size')} /></label>
      <label><span className="muted">Angle</span><input type="number" step={0.1} value={+target.transform.rotation.toFixed(1)} onChange={e => store.updateLayer(target.id, { transform: { ...target.transform, rotation: +e.target.value } }, 'Rotate', 'rotation')} />°</label>
      <select value={target.transform.sampling} onChange={e => store.updateLayer(target.id, { transform: { ...target.transform, sampling: e.target.value as typeof target.transform.sampling } }, 'Sampling')}><option>High quality</option><option>Smooth</option><option>Nearest</option></select>
    </>}
    {target && <><button onClick={() => store.flipLayer('x')}>Flip H</button><button onClick={() => store.flipLayer('y')}>Flip V</button></>}
    {distorting && <><button className="primary" onClick={applyDistort}>Apply</button><button onClick={cancelDistort}>Cancel</button></>}
    <span className="muted">Shift frees the ratio, {option} scales from the center, {command}-drag a handle distorts, {option}-drag duplicates, {command}-click picks a layer</span>
  </>
}
