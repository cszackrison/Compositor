import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { store, tabForOpening } from '../editor/store'
import { answerUnsaved, encodeExport, newCanvas, documentName, placeImages, saveFile } from '../editor/actions'
import { prefs, setPrefs, gridColors } from '../editor/prefs'
import { chordLabel, chordOf, currentOverrides, definitions, effective, problem, saveOverrides, unassigned, type Chord } from '../editor/shortcuts'
import { color_range, colorRangeMask } from './colorRange'
import { canvasPicker, renderFull, renderLinear, requestRender } from './canvasState'
import { EffectPanel, Scrub } from './Inspector'
import { ColorSwatch } from './ColorPicker'
import { useEditor } from './hooks'
import type { Raster } from '../model/raster'
import { type Transform, isHDRLayer, maxSide } from '../model/types'
import { chosenProfile, pickProfile, subscribeProfiles } from '../io/cmyk'
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

// New Canvas (NewCanvasSheet.swift): presets for screens and common formats, grouped as the Mac's menu divides them.
const presetGroups = [
  [['4K', 3840, 2160], ['1440p', 2560, 1440], ['1080p', 1920, 1080]],
  [['iPhone 18 Pro', 1206, 2622], ['iPhone 18 Pro Max', 1320, 2868], ['MacBook Pro 14"', 3024, 1964], ['MacBook Pro 16"', 3456, 2234], ['Studio Display', 5120, 2880]],
  [['Instagram Square', 1080, 1080], ['Instagram Portrait', 1080, 1350], ['Instagram Story', 1080, 1920], ['YouTube Thumb', 1080, 608]],
] as const
// Units sizes can be typed in, with how many make an inch; print units turn into pixels at the chosen DPI.
const canvasUnits = [['px', 'Pixels', 0], ['in', 'Inches', 1], ['cm', 'Centimeters', 2.54], ['mm', 'Millimeters', 25.4]] as const
const canvasFills = ['transparent', 'white', 'black'] as const

function NewCanvas() {
  // Always starting from the common case: transparent, in pixels, at 72 DPI.
  const [width, setWidth] = useState('1920'), [height, setHeight] = useState('1080')
  const [unit, setUnit] = useState(0), [resolution, setResolution] = useState(72), [fill, setFill] = useState(0)
  const pixels = (text: string) => {
    const value = Number(text.trim().replace(',', '.')), perInch = canvasUnits[unit][2]
    if (!(value > 0) || !Number.isFinite(value)) return null
    const px = perInch ? Math.round(value / perInch * resolution) : value
    return Number.isInteger(px) && px >= 1 && px <= maxSide ? px : null
  }
  const text = (px: number, u = unit) => { const perInch = canvasUnits[u][2]; return perInch ? String(+(px / resolution * perInch).toFixed(2)) : String(px) }
  const pixelWidth = pixels(width), pixelHeight = pixels(height)
  const setPixels = (w: number, h: number) => { setWidth(text(w)); setHeight(text(h)) }
  const switchUnit = () => { const next = (unit + 1) % canvasUnits.length; if (pixelWidth && pixelHeight) { setWidth(text(pixelWidth, next)); setHeight(text(pixelHeight, next)) } setUnit(next) }
  const preset = presetGroups.flat().findIndex(p => p[1] === pixelWidth && p[2] === pixelHeight)
  // An image pasted here makes the canvas from it, as pasting on the Mac's New Canvas screen does.
  useEffect(() => {
    const paste = (event: ClipboardEvent) => {
      const file = [...event.clipboardData?.files ?? []].find(f => f.type.startsWith('image/'))
      if (!file) return
      event.preventDefault(); event.stopPropagation()
      close(); tabForOpening(); store.close(); placeImages([file])
    }
    window.addEventListener('paste', paste, true)
    return () => window.removeEventListener('paste', paste, true)
  }, [])
  const field = (label: string, value: string, set: (v: string) => void, focus = false) => (
    <label style={{ flex: 1, flexDirection: 'column', alignItems: 'stretch', gap: 6 }}><span className="muted">{label}</span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}><input type="text" inputMode="decimal" value={value} onChange={e => set(e.target.value)} autoFocus={focus} style={{ flex: 1, padding: '7px 9px' }} /><span className="muted">{canvasUnits[unit][0]}</span></span>
    </label>
  )
  return (
    <Modal title="New Canvas" onSubmit={() => pixelWidth && pixelHeight && newCanvas(pixelWidth, pixelHeight, canvasFills[fill], resolution)} submit="Create Canvas" disabled={!pixelWidth || !pixelHeight}>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10 }}>
        {field('Width', width, setWidth, true)}<span className="muted" style={{ paddingBottom: 8 }}>×</span>{field('Height', height, setHeight)}
        <span className="icon-select" title="Preset sizes for screens and common formats">▾
          <select value={preset} onChange={e => { const p = presetGroups.flat()[+e.target.value]; if (p) setPixels(p[1], p[2]) }}>
            <option value={-1}>Custom</option>
            {presetGroups.map((group, g) => <optgroup key={g} label={g ? '──────' : 'Sizes'}>{group.map(p => <option key={p[0]} value={presetGroups.flat().indexOf(p)}>{p[0]} · {p[1]} × {p[2]}</option>)}</optgroup>)}
          </select>
        </span>
      </div>
      <div className="muted" style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
        <button type="button" className="pill" title="Start see-through, or with a white or black Background layer. Click to switch." onClick={() => setFill((fill + 1) % canvasFills.length)}>{canvasFills[fill][0].toUpperCase() + canvasFills[fill].slice(1)} canvas</button>·
        <button type="button" className="pill" title="Units: pixels, inches, centimeters or millimeters. Click to switch." onClick={switchUnit}>{canvasUnits[unit][1]}</button>·
        <button type="button" className="pill" title={`Resolution: 72 for screens, 300 for print. Click to switch.${unit && pixelWidth && pixelHeight ? ` · ${resolution} DPI: ${pixelWidth} × ${pixelHeight} pixels` : ''}`} onClick={() => setResolution(resolution === 300 ? 72 : 300)}>{resolution} DPI</button>
      </div>
      {(!pixelWidth || !pixelHeight) && <span style={{ color: '#ffb35c' }}>{unit ? `Enter a size up to ${maxSide.toLocaleString()} pixels at this DPI.` : `Enter whole numbers from 1 to ${maxSide.toLocaleString()} pixels.`}</span>}
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
// File › Export As… (ExportAsSheet.swift): the flattened canvas as a JPEG, a PNG or a one-page PDF, at its own size or scaled,
// previewed as it will be written, on the checkerboard where it keeps transparency. With an HDR layer, EXR too: flattened in half
// floats, the one format that keeps light brighter than white. JPEG, TIFF and PDF can be written in a CMYK profile's inks instead, for
// print: RGB at each opening, as most exports are for screens.
type ExportFormat = 'JPEG' | 'PNG' | 'TIFF' | 'PDF' | 'EXR'
let lastExportFormat: ExportFormat = 'PNG'
function ExportAs({ start }: { start?: ExportFormat }) {
  const pixels = useMemo(() => renderFull(store.state.doc), [])
  const linear = useMemo(() => store.state.doc.layers.some(isHDRLayer) ? renderLinear(store.state.doc) : null, [])
  const others: ExportFormat[] = linear ? ['TIFF', 'PDF', 'EXR'] : ['TIFF', 'PDF']
  const resolution = store.state.doc.resolution || 72
  const [format, setFormat] = useState<ExportFormat>(() => { const f = start ?? lastExportFormat; return f === 'EXR' && !linear ? 'PNG' : f })
  const [cmyk, setCMYK] = useState(false), profile = useSyncExternalStore(subscribeProfiles, chosenProfile)
  const takesCMYK = format === 'JPEG' || format === 'TIFF' || format === 'PDF', inks = cmyk && takesCMYK
  const [width, setWidth] = useState(pixels.width), [height, setHeight] = useState(pixels.height)
  const [quality, setQuality] = useState(prefs.jpegQuality)
  const [background, setBackground] = useState<[number, number, number]>([255, 255, 255])
  const [result, setResult] = useState<{ blob: Blob; url: string; key: string } | null>(null)
  const shownUrl = useRef<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [zoom, setZoom] = useState<'fit' | number>('fit')
  const keepsClear = format === 'PNG' || format === 'EXR' || (format === 'TIFF' && !inks)
  const key = JSON.stringify([format, width, height, format === 'JPEG' ? quality : 0, keepsClear ? 0 : background, inks ? profile?.name ?? '' : ''])
  const ready = result?.key === key && !error
  useEffect(() => {
    const timer = setTimeout(async () => {
      try {
        if (inks && !profile) throw new Error('Load a CMYK profile to export in inks.')
        const encoded = await encodeExport(pixels, format, width, height, { quality, background, resolution, linear, cmyk: inks ? profile : null })
        if (shownUrl.current) URL.revokeObjectURL(shownUrl.current)
        shownUrl.current = URL.createObjectURL(encoded.preview)
        setResult({ blob: encoded.blob, url: shownUrl.current, key })
        setError(null)
      } catch (e) { setError((e as Error).message) }
    }, 200)
    return () => clearTimeout(timer)
  }, [key])
  useEffect(() => () => { if (shownUrl.current) URL.revokeObjectURL(shownUrl.current) }, [])
  // Both sides follow one, keeping the canvas's proportions, within the export limits.
  const setScale = (scale: number) => {
    const largest = Math.min(maxSide / Math.max(pixels.width, pixels.height), Math.sqrt(200_000_000 / (pixels.width * pixels.height)))
    const clamped = Math.min(largest, Math.max(0.01, Number.isFinite(scale) ? scale : 1))
    setWidth(Math.max(1, Math.round(pixels.width * clamped))); setHeight(Math.max(1, Math.round(pixels.height * clamped)))
  }
  // What's being typed stays as typed, so "800" isn't clamped to 1% at its first digit; the field shows the size it made once left.
  const [typed, setTyped] = useState<{ side: 'width' | 'height'; text: string } | null>(null)
  const type = (side: 'width' | 'height', text: string) => { setTyped({ side, text }); if (+text >= 1) setScale(+text / pixels[side]) }
  const percent = Math.round(width / pixels.width * 100)
  const steps = [0.25, 0.5, 1, 2, 4, 8]
  const step = (up: boolean) => setZoom(z => { const current = z === 'fit' ? 0.25 : z; return up ? steps.find(s => s > current * 1.001) ?? current : [...steps].reverse().find(s => s < current * 0.999) ?? current })
  const size = result?.blob.size ?? 0
  const finish = () => {
    lastExportFormat = format
    if (format === 'JPEG') setPrefs({ jpegQuality: quality })
    if (result) saveFile(`${documentName()}.${format === 'JPEG' ? 'jpg' : format.toLowerCase()}`, result.blob).catch(e => store.notify((e as Error).message))
  }
  return (
    <Modal title="Export As" wide submit="Export…" disabled={!ready} onSubmit={finish}>
      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', marginTop: -30 }}>
        <button type="button" disabled={zoom === 'fit'} onClick={() => setZoom('fit')}>Fit</button>
        <button type="button" onClick={() => step(false)}>−</button><button type="button" onClick={() => step(true)}>+</button>
      </div>
      <div className="export-preview" style={{ overflow: zoom === 'fit' ? 'hidden' : 'auto', display: zoom === 'fit' ? 'flex' : 'block' }} onDoubleClick={() => setZoom(zoom === 'fit' ? 1 : 'fit')} title="Double-click switches between Fit and 100%">
        {result && <img src={result.url} alt="" className={keepsClear ? 'checkered' : ''} style={zoom === 'fit' ? { maxWidth: '100%', maxHeight: '100%' } : { width: width * zoom / devicePixelRatio, imageRendering: zoom >= 1 ? 'pixelated' : 'auto' }} />}
        {!ready && !error && <span className="muted" style={{ position: 'absolute', right: 10, bottom: 8 }}>Updating…</span>}
      </div>
      <div className="grid" style={{ gridTemplateColumns: '84px 1fr', gridTemplateRows: 'repeat(5, minmax(28px, auto))', alignContent: 'start' }}>
        <span className="muted">Format</span>
        <span style={{ display: 'flex', gap: 10 }}>
          <span className="segmented">{(['JPEG', 'PNG'] as const).map(f => <button key={f} type="button" className={format === f ? 'on' : ''} onClick={() => setFormat(f)}>{f}</button>)}</span>
          <select title={`Other formats: TIFF and PDF${linear ? ', and EXR to keep light brighter than white' : ''}`} className={others.includes(format) ? 'on' : ''} value={others.includes(format) ? format : ''} onChange={e => e.target.value && setFormat(e.target.value as ExportFormat)}><option value="" disabled>More</option>{others.map(f => <option key={f}>{f}</option>)}</select>
        </span>
        {takesCMYK && <><span className="muted">Color</span><span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <select value={cmyk ? 'CMYK' : 'RGB'} title="CMYK writes a printer's inks through the profile in View › CMYK › Profile" onChange={e => setCMYK(e.target.value === 'CMYK')}><option>RGB</option><option>CMYK</option></select>
          {cmyk && <button type="button" title="Use a CMYK ICC profile, such as the one your printer gave you" onClick={() => { pickProfile().catch(e => setError((e as Error).message)) }}>Load Profile…</button>}
        </span></>}
        <span className="muted">Size</span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input type="number" min={1} style={{ width: 72 }} value={typed?.side === 'width' ? typed.text : width} title="Width in pixels; the height follows, keeping the proportions" onChange={e => type('width', e.target.value)} onBlur={() => setTyped(null)} />×
          <input type="number" min={1} style={{ width: 72 }} value={typed?.side === 'height' ? typed.text : height} title="Height in pixels; the width follows, keeping the proportions" onChange={e => type('height', e.target.value)} onBlur={() => setTyped(null)} /><span className="muted">px</span>
          <select title="Scale the export: the document stays as it is" value="" onChange={e => setScale(+e.target.value / 100)}><option value="" disabled>{percent}%</option>{[25, 50, 75, 100, 200].map(p => <option key={p} value={p}>{p}%</option>)}</select>
        </span>
        {format === 'JPEG' && <><span className="muted">Quality</span><span style={{ display: 'flex', alignItems: 'center', gap: 8 }}><input type="range" min={0} max={1} step={0.01} value={quality} onChange={e => setQuality(+e.target.value)} style={{ width: 300 }} /><span>{Math.round(quality * 100)}%</span></span></>}
        {format === 'PDF' && <><span className="muted">Page</span><span className="muted">{+(width / resolution).toFixed(2)} × {+(height / resolution).toFixed(2)} in at {Math.round(resolution)} DPI</span></>}
        {!keepsClear && <><span className="muted">Background</span><ColorSwatch title="Export Background" sampling={false} value={background} onChange={setBackground} /></>}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
        <span className="muted">{format === 'EXR' ? 'Brighter than white kept · Transparency kept' : inks ? `CMYK – ${profile?.name ?? 'No profile'}` : keepsClear ? 'Transparency kept · sRGB' : 'sRGB'}</span>
        {error ? <span style={{ color: 'var(--danger)' }}>{error}</span> : <span className="muted">{ready ? (size > 1e6 ? `${(size / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(size / 1e3))} KB`) : 'Updating…'}</span>}
      </div>
    </Modal>
  )
}

function About() {
  const link = (href: string, text: string) => <a href={href} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>{text}</a>
  return (
    <Modal title="Compositor for the web">
      <p style={{ margin: 0, maxWidth: 400 }}>Compositor was created by <strong>Robbie Tilton</strong>. It’s a free, open-source image editor for Mac: get it from {link('https://robbietilton.com/compositor', 'robbietilton.com/compositor')}, with source code at {link('https://github.com/robbietilton/Compositor', 'github.com/robbietilton/Compositor')}.</p>
      <p style={{ margin: 0, maxWidth: 400 }}>This is an unofficial web port of his Mac app by <strong>Scott Zackrison</strong>, in a fork of the project: {link('https://github.com/cszackrison/Compositor', 'github.com/cszackrison/Compositor')}. It opens and saves the same <code>.comp</code> projects and runs the app’s own C pixel code, compiled to WebAssembly.</p>
      <p className="muted" style={{ margin: 0, maxWidth: 400 }}>MIT License · © 2026 Wonder Assembly LLC · {link('./LICENSE.txt', 'license')}. Select Subject and Remove Background use the {link('https://huggingface.co/onnx-community/ormbg-ONNX', 'ormbg')} model (Apache-2.0) with ONNX Runtime Web (MIT).</p>
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
      <span className="muted">Click a shortcut, then press its new key combination, or ⊗ to remove it. Changes apply when you save.</span>
      <input type="text" placeholder="Search shortcuts" value={search} onChange={e => setSearch(e.target.value)} />
      <div style={{ maxHeight: 420, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
        {groups.map(group => <div key={group}>
          <h3 style={{ margin: '10px 0 4px' }}>{group}</h3>
          {definitions.filter(d => d.group === group && d.title.toLowerCase().includes(search.toLowerCase())).map(d => (
            <div key={d.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '2px 0' }}>
              <span>{d.title}</span>
              <span style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                {recording === d.id && effective(d.id, draft)?.key && <button type="button" className="icon" title="Remove this shortcut" onClick={() => { setDraft(dr => ({ ...dr, [d.id]: unassigned })); setRecording(null) }}>⊗</button>}
                <button type="button" style={{ width: 150, background: recording === d.id ? 'var(--accent-soft)' : undefined }} onClick={() => setRecording(recording === d.id ? null : d.id)}>{recording === d.id ? 'Press keys…' : chordLabel(effective(d.id, draft))}</button>
              </span>
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

// Closing a project with unsaved changes: Save the one colored button, Don't Save as quiet as Cancel. Escape or a click outside cancels.
function UnsavedChanges() {
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); answerUnsaved('cancel') } }
    window.addEventListener('keydown', escape)
    return () => { window.removeEventListener('keydown', escape); answerUnsaved('cancel') }
  }, [])
  return (
    <div className="modal-back" onPointerDown={e => { if (e.target === e.currentTarget) answerUnsaved('cancel') }}>
      <form noValidate className="modal" style={{ width: 380 }} onSubmit={e => { e.preventDefault(); answerUnsaved('save') }}>
        <h2>Do you want to save the changes you made to “{documentName()}”?</h2>
        <span className="muted">Your changes will be lost if you don't save them.</span>
        <div className="buttons">
          <button type="button" style={{ marginRight: 'auto' }} onClick={() => answerUnsaved('discard')}>Don't Save</button>
          <button type="button" onClick={() => answerUnsaved('cancel')}>Cancel</button>
          <button type="submit" className="primary" autoFocus>Save</button>
        </div>
      </form>
    </div>
  )
}

export const panels: Record<string, () => React.ReactNode> = {
  'New Canvas': () => <NewCanvas />, 'Canvas Size': () => <CanvasSize />, 'Image Size': () => <ImageSize />, Trim: () => <Trim />, 'Export JPEG': () => <ExportAs start="JPEG" />, 'Export As': () => <ExportAs />,
  About: () => <About />, 'Expand Selection': () => <Amount kind="expand" />, 'Contract Selection': () => <Amount kind="contract" />, 'Feather Selection': () => <Amount kind="feather" />,
  Effect: () => <EffectPanel />, 'Grid Settings': () => <GridSettings />, 'Keyboard Shortcuts': () => <KeyboardShortcuts />, 'Color Range': () => <ColorRange />,
  'Unsaved Changes': () => <UnsavedChanges />,
}

export function DialogHost() {
  const state = useEditor()
  const panel = state.panel && panels[state.panel]
  return panel ? <>{panel()}</> : null
}
