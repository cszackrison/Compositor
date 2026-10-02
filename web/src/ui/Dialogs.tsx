import { useEffect, useMemo, useRef, useState } from 'react'
import { store } from '../editor/store'
import { newCanvas, documentName } from '../editor/actions'
import { download } from '../io/files'
import { prefs, setPrefs, gridColors } from '../editor/prefs'
import { chordLabel, chordOf, currentOverrides, definitions, effective, problem, saveOverrides, type Chord } from '../editor/shortcuts'
import { color_range, colorRangeMask } from './colorRange'
import { canvasPicker, renderFull, requestRender } from './canvasState'
import { EffectPanel, Scrub } from './Inspector'
import { ColorSwatch } from './ColorPicker'
import { useEditor } from './hooks'
import type { Raster } from '../model/raster'
import type { Transform } from '../model/types'
import { outline } from '../model/selection'

const close = () => store.set({ panel: null })

function Modal({ title, children, onSubmit, submit = 'OK', wide, floating, disabled, onCancel }: { title: string; children: React.ReactNode; onSubmit?: () => void; submit?: string; wide?: boolean; floating?: boolean; disabled?: boolean; onCancel?: () => void }) {
  const cancel = () => { onCancel?.(); close() }
  // Escape closes the dialog wherever focus is.
  const latest = useRef(cancel)
  latest.current = cancel
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); latest.current() } }
    window.addEventListener('keydown', escape)
    return () => window.removeEventListener('keydown', escape)
  }, [])
  return (
    <div className={`modal-back ${floating ? 'filter-back' : ''}`} onPointerDown={e => { if (e.target === e.currentTarget && !floating) cancel() }}>
      <form noValidate className={`modal ${floating ? 'filter' : ''}`} style={wide ? { width: 660, maxWidth: 'calc(100vw - 40px)' } : undefined} onSubmit={e => { e.preventDefault(); if (disabled) return; onSubmit?.(); close() }} onKeyDown={e => { if (e.key === 'Escape') cancel(); e.stopPropagation() }}>
        <h2>{title}</h2>
        {children}
        <div className="buttons">{onSubmit && <button type="button" onClick={cancel}>Cancel</button>}<button type="submit" className="primary" disabled={disabled}>{submit}</button></div>
      </form>
    </div>
  )
}

const presets = [['1920 × 1080', 1920, 1080], ['3840 × 2160', 3840, 2160], ['1080 × 1080', 1080, 1080], ['1080 × 1350', 1080, 1350], ['A4 at 300 ppi', 2480, 3508], ['4000 × 3000', 4000, 3000]] as const

function NewCanvas() {
  const [width, setWidth] = useState(1920), [height, setHeight] = useState(1080)
  const [fill, setFill] = useState<'white' | 'transparent' | 'background'>('white')
  return (
    <Modal title="New Canvas" onSubmit={() => newCanvas(width, height, fill)} submit="Create">
      <div className="grid">
        <span className="muted">Preset</span>
        <select onChange={e => { const p = presets[+e.target.value]; setWidth(p[1]); setHeight(p[2]) }} defaultValue=""><option value="" disabled>Choose…</option>{presets.map((p, i) => <option key={p[0]} value={i}>{p[0]}</option>)}</select>
        <span className="muted">Width</span><input type="number" min={1} max={30000} value={width} onChange={e => setWidth(+e.target.value)} autoFocus />
        <span className="muted">Height</span><input type="number" min={1} max={30000} value={height} onChange={e => setHeight(+e.target.value)} />
        <span className="muted">Background</span>
        <select value={fill} onChange={e => setFill(e.target.value as typeof fill)}><option value="white">White</option><option value="background">Background color</option><option value="transparent">Transparent</option></select>
      </div>
    </Modal>
  )
}

const anchors = ['nw', 'n', 'ne', 'w', 'c', 'e', 'sw', 's', 'se']

function CanvasSize() {
  const doc = store.state.doc
  const [width, setWidth] = useState(doc.width), [height, setHeight] = useState(doc.height)
  const [anchor, setAnchor] = useState('c')
  const submit = () => {
    const fx = anchor.includes('w') ? 0 : anchor.includes('e') ? 1 : 0.5, fy = anchor.includes('n') ? 0 : anchor.includes('s') ? 1 : 0.5
    store.resizeCanvas(Math.round(width), Math.round(height), Math.round((width - doc.width) * fx), Math.round((height - doc.height) * fy))
  }
  return (
    <Modal title="Canvas Size" onSubmit={submit}>
      <div className="grid">
        <span className="muted">Width</span><input type="number" min={1} max={30000} value={width} onChange={e => setWidth(+e.target.value)} autoFocus />
        <span className="muted">Height</span><input type="number" min={1} max={30000} value={height} onChange={e => setHeight(+e.target.value)} />
        <span className="muted">Anchor</span>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 26px)', gap: 3 }}>{anchors.map(a => <button key={a} type="button" style={{ height: 22, padding: 0, background: a === anchor ? 'var(--accent)' : undefined }} onClick={() => setAnchor(a)} />)}</div>
      </div>
    </Modal>
  )
}

type Unit = 'Pixels' | 'Percent' | 'Inches' | 'Centimeters'
function ImageSize() {
  const doc = store.state.doc
  const [width, setWidth] = useState(doc.width), [height, setHeight] = useState(doc.height)
  const [resolution, setResolution] = useState(doc.resolution)
  const [unit, setUnit] = useState<Unit>('Pixels')
  const [locked, setLocked] = useState(true), [resample, setResample] = useState(true)
  const [sampling, setSampling] = useState<Transform['sampling']>('High quality')
  const toUnit = (px: number, original: number) => unit === 'Pixels' ? px : unit === 'Percent' ? px / original * 100 : unit === 'Inches' ? px / resolution : px / resolution * 2.54
  const fromUnit = (v: number, original: number) => Math.round(unit === 'Pixels' ? v : unit === 'Percent' ? v / 100 * original : unit === 'Inches' ? v * resolution : v / 2.54 * resolution)
  const setW = (px: number) => { px = Math.min(30000, Math.max(1, px)); setWidth(px); if (locked) setHeight(Math.min(30000, Math.max(1, Math.round(px * doc.height / doc.width)))) }
  const setH = (px: number) => { px = Math.min(30000, Math.max(1, px)); setHeight(px); if (locked) setWidth(Math.min(30000, Math.max(1, Math.round(px * doc.width / doc.height)))) }
  const digits = unit === 'Pixels' ? 0 : 2
  const sensitivity = unit === 'Pixels' ? 1 : unit === 'Percent' ? 100 / doc.width : unit === 'Inches' ? 1 / resolution : 2.54 / resolution
  const valid = width * height <= 200_000_000
  return (
    <Modal title="Image Size" disabled={!valid} onSubmit={() => store.imageSize(width, height, resolution, sampling, resample)}>
      <div className="grid">
        <span className="muted">Units</span><select value={unit} onChange={e => setUnit(e.target.value as Unit)}>{['Pixels', 'Percent', 'Inches', 'Centimeters'].map(u => <option key={u}>{u}</option>)}</select>
        <Scrub label="Width" value={toUnit(width, doc.width)} min={0} max={1e6} sensitivity={sensitivity} onChange={v => setW(fromUnit(v, doc.width))} /><input type="number" step={digits ? 0.01 : 1} value={+toUnit(width, doc.width).toFixed(digits)} disabled={!resample} onChange={e => setW(fromUnit(+e.target.value, doc.width))} autoFocus />
        <Scrub label="Height" value={toUnit(height, doc.height)} min={0} max={1e6} sensitivity={sensitivity} onChange={v => setH(fromUnit(v, doc.height))} /><input type="number" step={digits ? 0.01 : 1} value={+toUnit(height, doc.height).toFixed(digits)} disabled={!resample} onChange={e => setH(fromUnit(+e.target.value, doc.height))} />
        <span className="muted">Resolution</span><label><input type="number" min={1} max={9600} value={resolution} onChange={e => setResolution(Math.min(9600, Math.max(1, +e.target.value)))} /> pixels/inch</label>
        <span /><label><input type="checkbox" checked={locked} onChange={e => setLocked(e.target.checked)} /> Keep proportions</label>
        <span /><label><input type="checkbox" checked={resample} onChange={e => { setResample(e.target.checked); if (!e.target.checked) { setWidth(doc.width); setHeight(doc.height) } }} /> Resample</label>
        <span className="muted">Sampling</span><select value={sampling} disabled={!resample} onChange={e => setSampling(e.target.value as Transform['sampling'])}><option>High quality</option><option>Smooth</option><option>Nearest</option></select>
      </div>
      <span className="muted">{width} × {height} px{valid ? '' : ' — too large (200 megapixels at most)'}</span>
    </Modal>
  )
}

function Trim() {
  const [basis, setBasis] = useState<'transparent' | 'topLeft' | 'bottomRight'>('transparent')
  const [sides, setSides] = useState({ top: true, bottom: true, left: true, right: true })
  const any = Object.values(sides).some(Boolean)
  return (
    <Modal title="Trim" disabled={!any} onSubmit={() => store.trim(basis, sides)}>
      <span className="muted">Based on</span>
      <label><input type="radio" checked={basis === 'transparent'} onChange={() => setBasis('transparent')} /> Transparent Pixels</label>
      <label><input type="radio" checked={basis === 'topLeft'} onChange={() => setBasis('topLeft')} /> Top Left Pixel Color</label>
      <label><input type="radio" checked={basis === 'bottomRight'} onChange={() => setBasis('bottomRight')} /> Bottom Right Pixel Color</label>
      <span className="muted">Trim away</span>
      <div style={{ display: 'flex', gap: 12 }}>{(['top', 'bottom', 'left', 'right'] as const).map(side => <label key={side}><input type="checkbox" checked={sides[side]} onChange={e => setSides({ ...sides, [side]: e.target.checked })} /> {side[0].toUpperCase() + side.slice(1)}</label>)}</div>
    </Modal>
  )
}

// Export JPEG with a live preview of the encoded file, so its artifacts and size show before saving.
function ExportJPEG() {
  const pixels = useMemo(() => renderFull(store.state.doc), [])
  const [quality, setQuality] = useState(prefs.jpegQuality)
  const [background, setBackground] = useState('#ffffff')
  const [result, setResult] = useState<{ blob: Blob; url: string } | null>(null)
  const [busy, setBusy] = useState(true)
  const [zoom, setZoom] = useState<'fit' | number>('fit')
  useEffect(() => {
    setBusy(true)
    const timer = setTimeout(async () => {
      const canvas = new OffscreenCanvas(pixels.width, pixels.height), context = canvas.getContext('2d')!
      const image = context.createImageData(pixels.width, pixels.height)
      const bg = [1, 3, 5].map(i => parseInt(background.slice(i, i + 2), 16))
      for (let i = 0; i < pixels.data.length; i += 4) { const a = pixels.data[i + 3] / 255; for (let c = 0; c < 3; c++) image.data[i + c] = Math.round(pixels.data[i + c] + bg[c] * (1 - a)); image.data[i + 3] = 255 }
      context.putImageData(image, 0, 0)
      const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality })
      setResult(old => { if (old) URL.revokeObjectURL(old.url); return { blob, url: URL.createObjectURL(blob) } })
      setBusy(false)
    }, 200)
    return () => clearTimeout(timer)
  }, [quality, background])
  useEffect(() => () => { if (result) URL.revokeObjectURL(result.url) }, [])
  const steps = [0.25, 0.5, 1, 2, 4, 8]
  const step = (up: boolean) => setZoom(z => { const current = z === 'fit' ? 0.25 : z; return up ? steps.find(s => s > current * 1.001) ?? current : [...steps].reverse().find(s => s < current * 0.999) ?? current })
  return (
    <Modal title="Export JPEG" wide submit="Export…" disabled={busy || !result} onSubmit={() => { setPrefs({ jpegQuality: quality }); if (result) download(`${documentName()}.jpg`, result.blob) }}>
      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', marginTop: -30 }}>
        <button type="button" disabled={zoom === 'fit'} onClick={() => setZoom('fit')}>Fit</button>
        <button type="button" onClick={() => step(false)}>−</button><button type="button" onClick={() => step(true)}>+</button>
      </div>
      <div style={{ width: '100%', height: 330, background: 'rgb(31,31,31)', overflow: zoom === 'fit' ? 'hidden' : 'auto', borderRadius: 6, position: 'relative', display: zoom === 'fit' ? 'flex' : 'block', alignItems: 'center', justifyContent: 'center' }} onDoubleClick={() => setZoom(zoom === 'fit' ? 1 : 'fit')} title="Double-click switches between Fit and 100%">
        {result && <img src={result.url} alt="" style={zoom === 'fit' ? { maxWidth: '100%', maxHeight: '100%' } : { width: pixels.width * zoom / devicePixelRatio, imageRendering: zoom >= 1 ? 'pixelated' : 'auto' }} />}
        {busy && <span className="muted" style={{ position: 'absolute', right: 10, bottom: 8 }}>Updating…</span>}
      </div>
      <div className="row" style={{ gridTemplateColumns: '92px 1fr 52px' }}><span className="muted">Quality</span><input type="range" min={0} max={1} step={0.01} value={quality} onChange={e => setQuality(+e.target.value)} /><span>{Math.round(quality * 100)}%</span></div>
      <label><span className="muted">Background for transparency</span><ColorSwatch title="JPEG Background" sampling={false} value={[1, 3, 5].map(i => parseInt(background.slice(i, i + 2), 16)) as [number, number, number]} onChange={c => setBackground('#' + c.map(v => v.toString(16).padStart(2, '0')).join(''))} /></label>
      <div style={{ display: 'flex', justifyContent: 'space-between' }}><span className="muted">{pixels.width} × {pixels.height} px · sRGB</span><span className="muted">{busy ? 'Updating…' : result ? `${(result.blob.size / 1024 / 1024).toFixed(result.blob.size > 1e6 ? 1 : 2)} MB` : ''}</span></div>
    </Modal>
  )
}

function About() {
  return (
    <Modal title="Compositor for the web">
      <p style={{ margin: 0, maxWidth: 380 }}>The browser edition of Compositor. It opens and saves the same <code>.comp</code> projects as the Mac app, composites on the GPU with WebGL 2, and runs the app’s own C pixel code compiled to WebAssembly.</p>
      <p className="muted" style={{ margin: 0, maxWidth: 380 }}>In Chrome and Edge, projects open and save in place as folders. Other browsers open a project folder or zip and save by downloading a zip.</p>
    </Modal>
  )
}

function Amount({ kind }: { kind: 'expand' | 'contract' | 'feather' }) {
  const [amount, setAmount] = useState(store.state.modifyAmounts[kind])
  const max = kind === 'feather' ? 250 : 500, title = kind === 'expand' ? 'Expand Selection' : kind === 'contract' ? 'Contract Selection' : 'Feather Selection'
  return (
    <Modal title={title} onSubmit={() => { store.set({ modifyAmounts: { ...store.state.modifyAmounts, [kind]: amount } }); store.modifySelection(kind, amount) }}>
      <div className="grid"><Scrub label={kind === 'feather' ? 'Feather radius' : kind === 'expand' ? 'Expand by' : 'Contract by'} value={amount} min={1} max={max} onChange={v => setAmount(Math.round(v))} /><label><input type="number" min={1} max={max} value={amount} onChange={e => setAmount(Math.min(max, Math.max(1, +e.target.value)))} autoFocus /> px</label></div>
    </Modal>
  )
}

function GridSettings() {
  const before = useRef(prefs.gridSettings)
  const [settings, setSettings] = useState(prefs.gridSettings)
  const update = (changes: Partial<typeof settings>) => { const next = { ...settings, ...changes }; next.subdivisions = Math.min(next.subdivisions, next.spacing); setSettings(next); setPrefs({ gridSettings: next, grid: true }) }
  const preset = gridColors.find(([, c]) => c.every((v, i) => Math.abs(v - settings.color[i]) < 0.01))?.[0] ?? 'Custom'
  return (
    <Modal title="Grid" onSubmit={() => {}} onCancel={() => setPrefs({ gridSettings: before.current })}>
      <div className="grid">
        <Scrub label="Gridline every" value={settings.spacing} min={2} max={4096} onChange={v => update({ spacing: Math.round(v) })} /><label><input type="number" min={2} max={4096} value={settings.spacing} onChange={e => update({ spacing: Math.min(4096, Math.max(2, +e.target.value)) })} /> pixels</label>
        <Scrub label="Subdivisions" value={settings.subdivisions} min={1} max={64} sensitivity={0.2} onChange={v => update({ subdivisions: Math.round(v) })} /><input type="number" min={1} max={64} value={settings.subdivisions} onChange={e => update({ subdivisions: Math.min(64, Math.max(1, +e.target.value)) })} />
        <span className="muted">Color</span>
        <span style={{ display: 'flex', gap: 6 }}><select value={preset} onChange={e => { const c = gridColors.find(([n]) => n === e.target.value); if (c) update({ color: c[1] }) }}>{gridColors.map(([n]) => <option key={n}>{n}</option>)}<option>Custom</option></select><ColorSwatch title="Grid Color" sampling={false} value={settings.color.map(v => Math.round(v * 255)) as [number, number, number]} onChange={c => update({ color: c.map(v => v / 255) as [number, number, number] })} /></span>
        <span className="muted">Style</span><select value={settings.style} onChange={e => update({ style: e.target.value as typeof settings.style })}><option>Lines</option><option>Dashed Lines</option><option>Dots</option></select>
        <Scrub label="Opacity" value={settings.opacity} min={1} max={100} sensitivity={0.5} onChange={v => update({ opacity: Math.round(v) })} /><label><input type="range" min={1} max={100} value={settings.opacity} onChange={e => update({ opacity: +e.target.value })} /> {settings.opacity}%</label>
      </div>
    </Modal>
  )
}

function KeyboardShortcuts() {
  const [draft, setDraft] = useState<Record<string, Chord>>(currentOverrides())
  const [recording, setRecording] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  useEffect(() => {
    if (!recording) return
    const key = (event: KeyboardEvent) => {
      event.preventDefault(); event.stopPropagation()
      const chord = chordOf(event)
      if (!chord) return
      setDraft(d => ({ ...d, [recording]: chord }))
      setRecording(null)
    }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  }, [recording])
  const issue = problem(draft)
  const groups = ['Menus', 'Canvas & Layers'] as const
  return (
    <Modal title="Keyboard Shortcuts" wide submit="Save" disabled={!!issue || !!recording} onSubmit={() => saveOverrides(draft)}>
      <span className="muted">Click a shortcut, then press its new key combination. Changes apply when you save.</span>
      <input type="text" placeholder="Search shortcuts" value={search} onChange={e => setSearch(e.target.value)} />
      <div style={{ maxHeight: 420, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
        {groups.map(group => <div key={group}>
          <h3 style={{ margin: '10px 0 4px' }}>{group}</h3>
          {definitions.filter(d => d.group === group && d.title.toLowerCase().includes(search.toLowerCase())).map(d => (
            <div key={d.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '2px 0' }}>
              <span>{d.title}</span>
              <button type="button" style={{ width: 150, background: recording === d.id ? 'var(--accent-soft)' : undefined }} onClick={() => setRecording(recording === d.id ? null : d.id)}>{recording === d.id ? 'Press keys…' : chordLabel(effective(d.id, draft))}</button>
            </div>
          ))}
        </div>)}
      </div>
      {issue && <span style={{ color: '#ffb35c' }}>{issue}</span>}
      <div><button type="button" onClick={() => setDraft({})}>Restore Defaults</button></div>
    </Modal>
  )
}

// Select › Color Range (ColorRangeSelection.swift): click the canvas for the color to select, Shift-click adds one, Option-click
// takes one away; Fuzziness widens the match. The live composite is sampled once when the panel opens.
function ColorRange() {
  const composite = useMemo(() => renderFull(store.state.doc), [])
  const original = useRef(store.state.selection)
  const [colors, setColors] = useState<{ include: [number, number, number][]; exclude: [number, number, number][] }>({ include: [], exclude: [] })
  const [mode, setMode] = useState<'sample' | 'add' | 'remove'>('sample')
  const [fuzziness, setFuzziness] = useState(40)
  const [invert, setInvert] = useState(false)
  const [mask, setMask] = useState<Raster | null>(null)
  const preview = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    canvasPicker.current = (point, shift, alt) => {
      const color = color_range.sample(composite, point)
      if (!color) return
      const m = alt ? 'remove' : shift ? 'add' : mode
      setColors(c => m === 'sample' ? { include: [color], exclude: [] } : m === 'add' ? { ...c, include: [...c.include, color] } : { ...c, exclude: [...c.exclude, color] })
    }
    return () => { canvasPicker.current = null }
  }, [mode])
  useEffect(() => {
    if (!colors.include.length) { setMask(null); store.set({ selection: original.current }); return }
    const result = colorRangeMask(composite, colors.include, colors.exclude, fuzziness, invert)
    setMask(result)
    store.set({ selection: result })
    requestRender(false)
  }, [colors, fuzziness, invert])
  useEffect(() => {
    const canvas = preview.current!, c = canvas.getContext('2d')!
    const fit = Math.min(292 / composite.width, 200 / composite.height), w = Math.max(1, Math.round(composite.width * fit)), h = Math.max(1, Math.round(composite.height * fit))
    canvas.width = w; canvas.height = h
    const image = c.createImageData(w, h)
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const v = mask ? mask.data[Math.floor(y / fit) * mask.width + Math.floor(x / fit)] : 0, i = (y * w + x) * 4; image.data[i] = image.data[i + 1] = image.data[i + 2] = v; image.data[i + 3] = 255 }
    c.putImageData(image, 0, 0)
  }, [mask])
  const tooDetailed = mask && outline(mask) === null
  return (
    <Modal title="Color Range" floating disabled={!colors.include.length || !!tooDetailed} onCancel={() => store.set({ selection: original.current })} onSubmit={() => { store.set({ selection: original.current }); if (mask && mask.data.some(v => v)) store.setSelection(mask, 'replace', 'Color Range'); else store.deselect() }}>
      <div style={{ display: 'flex', gap: 4 }}>{(['sample', 'add', 'remove'] as const).map(m => <button key={m} type="button" className={mode === m ? 'primary' : ''} onClick={() => setMode(m)}>{m === 'sample' ? 'Sample' : m === 'add' ? 'Add +' : 'Remove −'}</button>)}</div>
      <canvas ref={preview} style={{ alignSelf: 'center', background: '#000', borderRadius: 4 }} />
      <span className="muted">{colors.include.length ? 'Shift-click adds a color, Option-click takes one away.' : 'Click the image to pick the color to select.'}</span>
      <div className="row"><Scrub label="Fuzziness" value={fuzziness} min={0} max={200} onChange={v => setFuzziness(Math.round(v))} /><input type="range" min={0} max={200} value={fuzziness} onChange={e => setFuzziness(+e.target.value)} /><input type="number" min={0} max={200} value={fuzziness} onChange={e => setFuzziness(Math.min(200, Math.max(0, +e.target.value)))} /></div>
      <label><input type="checkbox" checked={invert} onChange={e => setInvert(e.target.checked)} /> Invert</label>
      {tooDetailed && <span style={{ color: '#ffb35c' }}>That selection is too detailed to outline. Try a different Fuzziness.</span>}
    </Modal>
  )
}

export const panels: Record<string, () => React.ReactNode> = {
  'New Canvas': () => <NewCanvas />, 'Canvas Size': () => <CanvasSize />, 'Image Size': () => <ImageSize />, Trim: () => <Trim />, 'Export JPEG': () => <ExportJPEG />,
  About: () => <About />, 'Expand Selection': () => <Amount kind="expand" />, 'Contract Selection': () => <Amount kind="contract" />, 'Feather Selection': () => <Amount kind="feather" />,
  Effect: () => <EffectPanel />, 'Grid Settings': () => <GridSettings />, 'Keyboard Shortcuts': () => <KeyboardShortcuts />, 'Color Range': () => <ColorRange />,
}

export function DialogHost() {
  const state = useEditor()
  const panel = state.panel && panels[state.panel]
  return panel ? <>{panel()}</> : null
}
