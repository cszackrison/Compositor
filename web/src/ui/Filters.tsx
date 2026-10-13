import { useEffect, useMemo, useRef, useState } from 'react'
import { store } from '../editor/store'
import { FilterDialog } from './FilterDialog'
import { Slider, AdjustmentEditor } from './Inspector'
import { useEditor } from './hooks'
import { defaultDither, defaultScanlines, ditherGroups, ditherStyles, ditherUses, type DitherSettings, type Sides, type VignetteSettings } from '../editor/filterKinds'
import { FilterSession, canvasSides, job, type FilterJob } from '../editor/filters'
import { RemoveBackgroundDialog } from '../ai/RemoveBackground'
import { type Adjustment, type AdjustmentKind, type LevelRange, newAdjustment, identityRange } from '../model/types'
import { applyRange } from '../model/adjustments'
import { call, withBuffers } from '../kernels'
import type { Raster } from '../model/raster'
import { canvasGesture, canvasPicker, requestRender, view } from './canvasState'
import { ColorSwatch } from './ColorPicker'
import { apply, invert } from '../render/gl'
import { CameraRawPanel, hasView, type CameraRawParams } from './CameraRaw'
import { defaultCameraRaw, hiding } from '../model/cameraRaw'
import { pixelToDocument } from '../render/compositor'

// Settings are remembered between openings for the rest of the session, as the Mac app does.
const remembered = new Map<string, unknown>()
function recall<T>(name: string, initial: T): T { return (remembered.get(name) as T) ?? initial }
const close = () => store.set({ panel: null })
const seed = () => Math.floor(Math.random() * 2 ** 32)

// What a Filter-menu filter reads from the layer it runs on, worked out when it starts: before a blur's preview grows the layer.
type FilterContext = { sides: Sides; fillsClear: boolean; seed: number }
const filterContext = (): FilterContext => ({ sides: canvasSides(), fillsClear: !store.active?.image, seed: seed() })

// The Filter menu's own filters, by name: each one's job from its settings, so Last Filter can run it again on whatever layer is active.
const repeatable: Record<string, { job: (p: any, context: FilterContext) => FilterJob; trim?: boolean; growEmpty?: boolean }> = {
  'Gaussian Blur': { job: (p, c) => job('gaussianBlur', p.radius, p.preserveTransparency, c.sides), trim: true },
  'Motion Blur': { job: (p, c) => job('motionBlur', p.angle, p.distance, c.sides), trim: true },
  'Progressive Blur': { job: (p, c) => job('progressiveBlur', p.from, p.to, p.start, p.end, p.radial, p.inverted, c.sides), trim: true },
  'Add Noise': { job: (p, c) => job('addNoise', p.amount, p.gaussian, p.monochromatic, c.seed) },
  Vignette: { job: (p, c) => job('vignette', p, c.fillsClear), growEmpty: true },
  'Bloom / Glow': { job: p => job('bloom', p.amount, p.radius), trim: true },
  Dither: { job: p => job('dither', p) },
  Scanlines: { job: p => job('scanlines', p) },
  'Tonal Contrast': { job: p => job('tonalContrast', p.amount, p.shadows, p.midtones, p.highlights, p.radius) },
  'Lens Correction': { job: p => job('lensCorrection', p.distortion) },
  'Camera Raw Filter': { job: (p, c) => job('cameraRaw', hiding(p.settings, p.hidden), c.seed, 1, p.view ?? {}) },
}

// Filter › Last Filter (⌃⌘F): the last of those applied, again with the same settings and no dialog, as in Photoshop.
let lastFilter: { name: string; params: unknown } | null = null
export const lastFilterName = () => lastFilter?.name ?? null
export async function repeatLastFilter() {
  if (!lastFilter || store.state.panel) return
  const { name, params } = lastFilter, spec = repeatable[name], context = filterContext()
  const session = FilterSession.start({ growEmpty: spec.growEmpty })
  if (!session) return
  session.onError = message => { if (message) store.notify(message) }
  await session.commit(name, spec.job(params, context), spec.trim)
}

// `fresh` settings start anew at each opening, over the remembered ones.
// `clean` takes out what only the preview shows, before OK runs the filter and before its settings are remembered.
function Simple<P extends object>({ name, initial, fresh, docked, clean, children }: { name: string; initial: P; fresh?: Partial<P>; docked?: boolean; clean?: (p: P) => P; children: (p: P, set: (c: Partial<P>) => void) => React.ReactNode }) {
  const context = useMemo(filterContext, []), spec = repeatable[name], tidy = clean ?? ((p: P) => p)
  return <FilterDialog title={name} initial={{ ...recall(name, initial), ...fresh }} run={p => spec.job(p, context)} trim={spec.trim} growEmpty={spec.growEmpty} docked={docked} final={clean ? p => { const c = clean(p); return c === p ? undefined : spec.job(c, context) } : undefined} onClose={close} onCommit={p => { const c = tidy(p); remembered.set(name, c); lastFilter = { name, params: c } }}>{children}</FilterDialog>
}

function GaussianBlurDialog() {
  return <Simple name="Gaussian Blur" initial={{ radius: 5, preserveTransparency: false }}>{(p, set) => <>
    <Slider label="Radius" value={p.radius} min={0.1} max={250} digits={1} log onChange={radius => set({ radius })} />
    <label title="Blur only the colors and keep every pixel's transparency, so the outline stays where it is"><input type="checkbox" checked={!!p.preserveTransparency} onChange={e => set({ preserveTransparency: e.target.checked })} /> Preserve Transparency</label>
  </>}</Simple>
}

function MotionBlurDialog() {
  return <Simple name="Motion Blur" initial={{ angle: 0, distance: 10 }}>{(p, set) => <>
    <Slider label="Angle" value={p.angle} min={-90} max={90} onChange={angle => set({ angle })} />
    <Slider label="Distance" value={p.distance} min={1} max={2000} log onChange={distance => set({ distance })} />
  </>}</Simple>
}

type ProgressiveSettings = { from: number; to: number; start: [number, number]; end: [number, number]; radial: boolean; inverted: boolean }

// Progressive Blur starts sharp at 35% down the layer's visible part, blurring to its foot; dragging on the canvas moves either end or
// starts a new line, Shift keeping it to 45° steps. The line shows a solid handle where it's sharp and a ring where it's fully blurred.
function ProgressiveBlurDialog() {
  const fresh = useMemo(() => {
    const doc = store.state.doc, t = store.active?.transform
    const x0 = Math.max(0, t?.origin[0] ?? 0), y0 = Math.max(0, t?.origin[1] ?? 0), x1 = Math.min(doc.width, t ? t.origin[0] + t.size[0] : doc.width), y1 = Math.min(doc.height, t ? t.origin[1] + t.size[1] : doc.height)
    const [left, top, right, bottom] = x1 > x0 && y1 > y0 ? [x0, y0, x1, y1] : [0, 0, doc.width, doc.height]
    return { start: [(left + right) / 2, top + (bottom - top) * 0.35] as [number, number], end: [(left + right) / 2, bottom] as [number, number] }
  }, [])
  return <Simple name="Progressive Blur" initial={{ from: 0, to: 20, radial: false, inverted: false, ...fresh } as ProgressiveSettings} fresh={fresh}>{(p, set) => <>
    <ProgressiveLine settings={p} set={set} />
    <span className="muted">Click and drag two points on the canvas.</span>
    <div className="row"><span className="muted">Shape</span><span className="segmented">{(['Linear', 'Radial'] as const).map(shape => <button key={shape} type="button" className={p.radial === (shape === 'Radial') ? 'on' : ''} title="Linear blurs along the line; Radial keeps the start sharp and blurs outwards" onClick={() => set({ radial: shape === 'Radial' })}>{shape}</button>)}</span><span /></div>
    <Slider label="From" value={p.from} min={0} max={250} digits={1} onChange={from => set({ from })} />
    <Slider label="To" value={p.to} min={0} max={250} digits={1} onChange={to => set({ to })} />
    <label title="Swap From and To: blur the start and sharpen toward the end"><input type="checkbox" checked={p.inverted} onChange={e => set({ inverted: e.target.checked })} /> Invert</label>
  </>}</Simple>
}

function ProgressiveLine({ settings, set }: { settings: ProgressiveSettings; set: (c: Partial<ProgressiveSettings>) => void }) {
  const latest = useRef(settings)
  latest.current = settings
  useEffect(() => {
    let dragging: 'start' | 'end' | null = null
    const snapped = (point: [number, number], anchor: [number, number]): [number, number] => {
      const angle = Math.round(Math.atan2(point[1] - anchor[1], point[0] - anchor[0]) / (Math.PI / 4)) * Math.PI / 4, length = Math.hypot(point[0] - anchor[0], point[1] - anchor[1])
      return [anchor[0] + Math.cos(angle) * length, anchor[1] + Math.sin(angle) * length]
    }
    canvasGesture.current = {
      down: (point, screen) => {
        const { start, end } = latest.current, near = (p: [number, number]) => { const [x, y] = view.toScreen(...p); return Math.hypot(x - screen[0], y - screen[1]) <= 10 }
        if (near(end)) dragging = 'end'
        else if (near(start)) dragging = 'start'
        else { dragging = 'end'; set({ start: point, end: point }) }
      },
      move: (point, shift) => {
        if (!dragging) return
        const anchor = dragging === 'start' ? latest.current.end : latest.current.start
        set({ [dragging]: shift ? snapped(point, anchor) : point })
      },
      up: () => { dragging = null },
      draw: c => {
        const { start, end, radial } = latest.current, [x0, y0] = view.toScreen(...start), [x1, y1] = view.toScreen(...end)
        if (radial) {
          c.beginPath(); c.arc(x0, y0, Math.hypot(x1 - x0, y1 - y0), 0, Math.PI * 2)
          c.setLineDash([4, 4]); c.strokeStyle = 'rgba(0,0,0,0.5)'; c.lineWidth = 2; c.stroke(); c.strokeStyle = 'rgba(255,255,255,0.8)'; c.lineWidth = 1; c.stroke(); c.setLineDash([])
        }
        c.beginPath(); c.moveTo(x0, y0); c.lineTo(x1, y1)
        c.strokeStyle = 'rgba(0,0,0,0.7)'; c.lineWidth = 3; c.stroke(); c.strokeStyle = '#fff'; c.lineWidth = 1; c.stroke()
        c.beginPath(); c.arc(x0, y0, 6, 0, Math.PI * 2); c.fillStyle = '#fff'; c.fill(); c.strokeStyle = '#000'; c.lineWidth = 1; c.stroke()
        c.beginPath(); c.arc(x1, y1, 6, 0, Math.PI * 2); c.fillStyle = 'rgba(153,153,153,0.9)'; c.fill(); c.strokeStyle = '#000'; c.stroke()
        c.beginPath(); c.arc(x1, y1, 5, 0, Math.PI * 2); c.strokeStyle = '#fff'; c.lineWidth = 2; c.stroke()
      },
    }
    requestRender(false)
    return () => { canvasGesture.current = null; requestRender(false) }
  }, [])
  useEffect(() => { requestRender(false) }, [settings.start, settings.end, settings.radial])
  return null
}

function AddNoiseDialog() {
  return <Simple name="Add Noise" initial={{ amount: 10, gaussian: false, monochromatic: false }}>{(p, set) => <>
    <Slider label="Amount" value={p.amount} min={0.1} max={400} digits={1} onChange={amount => set({ amount })} />
    <div className="row"><span className="muted">Distribution</span><select value={p.gaussian ? 'g' : 'u'} onChange={e => set({ gaussian: e.target.value === 'g' })}><option value="u">Uniform</option><option value="g">Gaussian</option></select><span /></div>
    <label><input type="checkbox" checked={p.monochromatic} onChange={e => set({ monochromatic: e.target.checked })} /> Monochromatic</label>
  </>}</Simple>
}

function VignetteDialog() {
  const initial: VignetteSettings = { color: [0, 0, 0], amount: 35, midpoint: 50, roundness: 100, feather: 60, highlights: 25 }
  return <Simple name="Vignette" initial={initial}>{(p, set) => <>
    <div className="row"><span className="muted">Color</span><ColorSwatch title="Vignette Color" value={p.color} onChange={color => set({ color })} /><span /></div>
    <Slider label="Amount" value={p.amount} min={0} max={100} onChange={amount => set({ amount })} />
    <Slider label="Midpoint" value={p.midpoint} min={0} max={100} onChange={midpoint => set({ midpoint })} />
    <Slider label="Roundness" value={p.roundness} min={-100} max={100} onChange={roundness => set({ roundness })} />
    <Slider label="Feather" value={p.feather} min={0} max={100} onChange={feather => set({ feather })} />
    <Slider label="Highlights" value={p.highlights} min={0} max={100} onChange={highlights => set({ highlights })} />
  </>}</Simple>
}

function BloomDialog() {
  return <Simple name="Bloom / Glow" initial={{ amount: 40, radius: 24 }}>{(p, set) => <>
    <Slider label="Amount" value={p.amount} min={0} max={100} onChange={amount => set({ amount })} />
    <Slider label="Radius" value={p.radius} min={1} max={150} log onChange={radius => set({ radius })} />
  </>}</Simple>
}

// Filter › Camera Raw Filter: the Mac's adjustment column, docked at the window's right. Its settings are remembered; hidden sections
// show again at each opening.
function CameraRawDialog() {
  const layerId = useMemo(() => store.active?.id ?? '', [])
  return <Simple name="Camera Raw Filter" docked initial={{ settings: defaultCameraRaw(), hidden: [], view: {} } as CameraRawParams} fresh={{ hidden: [], view: {} }} clean={p => hasView(p.view) ? { ...p, view: {} } : p}>{(p, set) => <CameraRawPanel params={p} set={set} layerId={layerId} />}</Simple>
}

function TonalContrastDialog() {
  return <Simple name="Tonal Contrast" initial={{ amount: 50, shadows: 40, midtones: 60, highlights: 30, radius: 16 }}>{(p, set) => <>
    <Slider label="Amount" value={p.amount} min={0} max={100} onChange={amount => set({ amount })} />
    <Slider label="Shadows" value={p.shadows} min={-100} max={100} onChange={shadows => set({ shadows })} />
    <Slider label="Midtones" value={p.midtones} min={-100} max={100} onChange={midtones => set({ midtones })} />
    <Slider label="Highlights" value={p.highlights} min={-100} max={100} onChange={highlights => set({ highlights })} />
    <Slider label="Radius" value={p.radius} min={1} max={100} log onChange={radius => set({ radius })} />
  </>}</Simple>
}

function LensDialog() {
  return <Simple name="Lens Correction" initial={{ distortion: 0 }}>{(p, set) => <>
    <Slider label="Remove Distortion" value={p.distortion} min={-100} max={100} onChange={distortion => set({ distortion })} />
    <span className="muted">Positive straightens lines that bow outward (barrel); negative, lines that bow inward (pincushion).</span>
  </>}</Simple>
}

function ContentAwareDialog() {
  const fillSeed = useMemo(seed, [])
  return <FilterDialog title="Content-Aware Fill" initial={{}} onClose={close} run={() => job('contentAwareFill', store.state.selection, fillSeed)}>{() => <>
    <span>Fill the selection using surrounding pixels from this layer.</span>
    <span className="muted">Limited to the selection.</span>
  </>}</FilterDialog>
}

function DitherDialog() {
  return <Simple name="Dither" initial={defaultDither}>{(p, set) => {
    const uses = ditherUses(p)
    return <>
      <div className="row"><span className="muted">Style</span>
        <select value={p.style} onChange={e => set({ style: +e.target.value })}>{ditherGroups.map((group, i) => <optgroup key={i} label={i ? '──────' : ''}>{group.map(style => <option key={style} value={style}>{ditherStyles[style]}</option>)}</optgroup>)}</select><span /></div>
      {uses.pixelSize && <Slider label="Pixel Size" value={p.pixelSize} min={1} max={32} onChange={pixelSize => set({ pixelSize })} />}
      {uses.pixelSize && p.pixelSize > 1 && <div className="row"><span className="muted">Pixel Shape</span><select value={p.pixelShape} onChange={e => set({ pixelShape: e.target.value as DitherSettings['pixelShape'] })}><option>Square</option><option>Dot</option></select><span /></div>}
      {uses.halftone && <><Slider label="Cell Size" value={p.cellSize} min={4} max={64} onChange={cellSize => set({ cellSize })} /><Slider label="Angle" value={p.angle} min={-90} max={90} onChange={angle => set({ angle })} /></>}
      {uses.ascii && <><Slider label="Text Size" value={p.textSize} min={6} max={64} onChange={textSize => set({ textSize })} /><div className="row"><span className="muted">Characters</span><input type="text" style={{ fontFamily: 'ui-monospace, monospace' }} value={p.characters} maxLength={64} onChange={e => set({ characters: e.target.value.replace(/\n/g, '') })} /><span /></div></>}
      {uses.tones && <Slider label="Tones" value={p.levels} min={2} max={8} onChange={levels => set({ levels })} />}
      {uses.diffuses && <Slider label="Diffusion" value={p.diffusion} min={0} max={100} onChange={diffusion => set({ diffusion })} />}
      <Slider label="Density" value={p.density} min={-100} max={100} onChange={density => set({ density })} />
      <Slider label="Contrast" value={p.contrast} min={-100} max={100} onChange={contrast => set({ contrast })} />
      <div className="row"><span className="muted">Colors</span><select value={p.colors} onChange={e => set({ colors: e.target.value as DitherSettings['colors'] })}><option>Black & White</option><option>Two Colors</option><option>Original</option></select><span /></div>
      {p.colors === 'Two Colors' && <div className="row"><span className="muted">Dark · Light</span><span style={{ display: 'flex', gap: 6 }}><ColorSwatch title="Dither Dark Color" value={p.dark} onChange={dark => set({ dark })} /><ColorSwatch title="Dither Light Color" value={p.light} onChange={light => set({ light })} /></span><span /></div>}
      {uses.marks && <label><input type="checkbox" checked={p.lightOnDark} onChange={e => set({ lightOnDark: e.target.checked })} /> Light on Dark</label>}
    </>
  }}</Simple>
}

function ScanlinesDialog() {
  return <Simple name="Scanlines" initial={defaultScanlines}>{(p, set) => <>
    <Slider label="Line Spacing" value={p.lineSpacing} min={2} max={32} onChange={lineSpacing => set({ lineSpacing })} />
    <Slider label="Thickness" value={p.thickness} min={5} max={100} onChange={thickness => set({ thickness })} />
    <Slider label="Glow" value={p.glow} min={0} max={100} onChange={glow => set({ glow })} />
    <Slider label="Dots" value={p.dots} min={0} max={100} onChange={dots => set({ dots })} />
    <Slider label="Displace" value={p.displace} min={-100} max={100} onChange={displace => set({ displace })} />
    <Slider label="Smoothness" value={p.smoothness} min={0} max={100} onChange={smoothness => set({ smoothness })} />
    <Slider label="Threshold" value={p.threshold} min={0} max={100} onChange={threshold => set({ threshold })} />
    <Slider label="Wobble" value={p.wobble} min={0} max={64} onChange={wobble => set({ wobble })} />
    <Slider label="Color Split" value={p.split} min={0} max={16} onChange={split => set({ split })} />
    <Slider label="Density" value={p.density} min={-100} max={100} onChange={density => set({ density })} />
    <Slider label="Contrast" value={p.contrast} min={-100} max={100} onChange={contrast => set({ contrast })} />
    <Slider label="Black Level" value={p.blackLevel} min={0} max={100} onChange={blackLevel => set({ blackLevel })} />
    <div className="row"><span className="muted">Colors</span><select value={p.colors} onChange={e => set({ colors: e.target.value as DitherSettings['colors'] })}><option>Black & White</option><option>Two Colors</option><option>Original</option></select><span /></div>
    {p.colors === 'Two Colors' && <div className="row"><span className="muted">Dark · Light</span><span style={{ display: 'flex', gap: 6 }}><ColorSwatch title="Scanlines Screen Color" value={p.dark} onChange={dark => set({ dark })} /><ColorSwatch title="Scanlines Line Color" value={p.light} onChange={light => set({ light })} /></span><span /></div>}
  </>}</Simple>
}

// Image > Curves…, Levels… and the other adjustments, run on the layer's pixels with the adjustment layers' editors.
function AdjustmentFilterDialog({ kind }: { kind: AdjustmentKind }) {
  const initial = useMemo(() => {
    const a = recall<Adjustment>(kind, newAdjustment(kind))
    if (kind === 'Gradient Map') {
      const [f, b] = [store.state.foreground, store.state.background].map(c => ({ red: c[0] / 255, green: c[1] / 255, blue: c[2] / 255 }))
      return { ...a, gradientMapSettings: { shadows: f, highlights: b, reversed: false } }
    }
    if (kind === 'Grain') return { ...a, grainSettings: { ...a.grainSettings!, seed: seed() } }
    return a
  }, [])
  const source = useMemo(() => store.active?.image ?? null, [])
  return <FilterDialog title={kind} initial={{ adjustment: initial }} onClose={close} onCommit={p => remembered.set(kind, p.adjustment)} run={p => job('adjustPixels', p.adjustment)}>{(p, set) => <>
    <AdjustmentEditor adjustment={p.adjustment} onChange={adjustment => set({ adjustment })} />
    {kind === 'Levels' && source && <LevelsTools source={source} toSource={point => apply(invert(pixelToDocument(store.active!.transform, source.width, source.height)), ...point)} adjustment={p.adjustment} onChange={adjustment => set({ adjustment })} />}
  </>}</FilterDialog>
}

// The alpha-weighted histogram (levels_histogram), the draggable input and output triangles, the black/gray/white eyedroppers that
// sample the canvas, and the three Auto buttons, from LevelsSheet.swift and LevelsAutomatic.swift.
export function LevelsTools({ source, toSource, adjustment, onChange }: { source: Raster; toSource: (point: [number, number]) => [number, number]; adjustment: Adjustment; onChange: (a: Adjustment) => void }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const [sampling, setSampling] = useState<'black' | 'gray' | 'white' | null>(null)
  const bins = useMemo(() => {
    const out = new Float64Array(1024)
    withBuffers([{ data: source.data }, { data: out, out: true }], ([p, b]) => call('levels_histogram', p, 0, source.width * source.height, b))
    return out
  }, [source])
  const channel = ['RGB', 'Red', 'Green', 'Blue'].indexOf(adjustment.levels.channel)
  const range = adjustment.levels.ranges[channel]
  const writeRange = (next: LevelRange) => onChange({ ...adjustment, levels: { ...adjustment.levels, ranges: adjustment.levels.ranges.map((r, i) => i === channel ? next : r) } })
  useEffect(() => {
    const canvas = ref.current!, dpr = window.devicePixelRatio || 1, width = canvas.clientWidth, height = 110
    canvas.width = width * dpr; canvas.height = height * dpr
    const c = canvas.getContext('2d')!
    c.setTransform(dpr, 0, 0, dpr, 0, 0)
    c.fillStyle = 'rgba(0,0,0,0.25)'; c.fillRect(0, 0, width, height)
    const values = Array.from(bins.subarray(channel * 256, channel * 256 + 256))
    const peak = Math.max(0, ...values.filter(v => v > 0))
    const interior = values.slice(1, -1).filter(v => v > 0).sort((a, b) => a - b)
    const scale = interior.length ? Math.min(peak, interior[Math.floor((interior.length - 1) * 0.95)] * 4) : peak
    if (!scale) return
    c.fillStyle = ['#bbb', '#ff5d5d', '#5dde6a', '#5d9bff'][channel]
    values.forEach((v, i) => { const h = height * Math.min(1, v / scale); c.fillRect(i * width / 256, height - h, width / 256 + 0.1, h) })
  }, [bins, channel])

  // Eyedroppers: a click on the canvas reads one pixel of the source and sets that point for each channel.
  useEffect(() => {
    if (!sampling) { canvasPicker.current = null; return }
    canvasPicker.current = point => {
      const [x, y] = toSource(point).map(Math.floor)
      if (x < 0 || y < 0 || x >= source.width || y >= source.height) return
      const i = (y * source.width + x) * 4, a = source.data[i + 3]
      if (!a) return
      const rgb = [0, 1, 2].map(c => Math.min(1, source.data[i + c] / a))
      const ranges = adjustment.levels.ranges.map(r => ({ ...r }))
      ranges[0] = identityRange()
      for (const c of [1, 2, 3]) {
        const v = rgb[c - 1] * 255, r = ranges[c]
        if (sampling === 'black') r.black = Math.min(r.white - 1, Math.max(0, Math.round(v)))
        else if (sampling === 'white') r.white = Math.max(r.black + 1, Math.min(255, Math.round(v)))
        else { const f = (v - r.black) / (r.white - r.black); if (f > 0 && f < 1) r.gamma = Math.min(9.99, Math.max(0.1, Math.log(f) / Math.log(0.5))) }
        r.outputBlack = 0; r.outputWhite = 255
      }
      onChange({ ...adjustment, levels: { ...adjustment.levels, ranges } })
    }
    return () => { canvasPicker.current = null }
  }, [sampling, adjustment])

  const strip = (kind: 'input' | 'output') => {
    const handles = kind === 'input'
      ? [{ key: 'black', value: range.black, color: '#000' }, { key: 'gamma', value: range.black + (range.white - range.black) * Math.pow(0.5, range.gamma), color: '#888' }, { key: 'white', value: range.white, color: '#fff' }]
      : [{ key: 'outputBlack', value: range.outputBlack, color: '#000' }, { key: 'outputWhite', value: range.outputWhite, color: '#fff' }]
    const drag = (key: string, event: React.PointerEvent) => {
      const box = (event.currentTarget.parentElement as HTMLElement).getBoundingClientRect()
      const move = (e: PointerEvent) => {
        const v = Math.min(255, Math.max(0, (e.clientX - box.left) / box.width * 255))
        if (key === 'black') writeRange({ ...range, black: Math.min(range.white - 1, Math.round(v)) })
        else if (key === 'white') writeRange({ ...range, white: Math.max(range.black + 1, Math.round(v)) })
        else if (key === 'gamma') { const f = Math.min(0.999, Math.max(0.001, (v - range.black) / (range.white - range.black))); writeRange({ ...range, gamma: Math.min(9.99, Math.max(0.1, Math.log(f) / Math.log(0.5))) }) }
        else writeRange({ ...range, [key]: Math.round(v) })
      }
      const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
      window.addEventListener('pointermove', move); window.addEventListener('pointerup', up)
      event.preventDefault()
    }
    return <div style={{ position: 'relative', height: 14 }}>{handles.map(h => <span key={h.key} onPointerDown={e => drag(h.key, e)} style={{ position: 'absolute', left: `calc(${h.value / 255 * 100}% - 6px)`, top: 0, width: 0, height: 0, borderLeft: '6px solid transparent', borderRight: '6px solid transparent', borderBottom: `11px solid ${h.color}`, filter: 'drop-shadow(0 0 1px #aaa)', cursor: 'ew-resize' }} />)}</div>
  }
  const endpoints = (index: number) => {
    const h = bins.subarray(index * 256, index * 256 + 256), total = h.reduce((a, b) => a + b, 0)
    if (!total) return null
    let low = 0, high = 255, sum = 0
    for (let i = 0; i < 256; i++) { sum += h[i]; if (sum > total * 0.001) { low = i; break } }
    sum = 0
    for (let i = 255; i >= 0; i--) { sum += h[i]; if (sum > total * 0.001) { high = i; break } }
    return low < high ? { low, high, h, total } : null
  }
  const auto = (mode: 'contrast' | 'color' | 'neutral') => {
    setSampling(null)
    const ranges = [0, 1, 2, 3].map(identityRange)
    if (mode === 'contrast') {
      const e = [1, 2, 3].map(endpoints).filter(Boolean) as { low: number; high: number }[]
      const low = Math.min(...e.map(x => x.low)), high = Math.max(...e.map(x => x.high))
      if (e.length && low < high) ranges[0] = { ...identityRange(), black: low, white: high }
    } else for (const c of [1, 2, 3]) {
      const e = endpoints(c)
      if (!e) continue
      const r: LevelRange = { ...identityRange(), black: e.low, white: e.high }
      if (mode === 'neutral') {
        let mean = 0
        for (let i = 0; i < 256; i++) mean += applyRange(r, i / 255) * e.h[i]
        mean /= e.total
        if (mean > 0 && mean < 1) r.gamma = Math.min(9.99, Math.max(0.1, Math.log(mean) / Math.log(0.5)))
      }
      ranges[c] = r
    }
    onChange({ ...adjustment, levels: { channel: 'RGB', ranges } })
  }
  return <>
    <div>
      <canvas ref={ref} style={{ width: '100%', height: 110, borderRadius: 4, display: 'block' }} title="Linear histogram with automatic vertical scaling. Tall spikes may extend beyond the graph; all tones from 0 to 255 remain included." />
      {strip('input')}
      <div style={{ height: 10, borderRadius: 2, background: 'linear-gradient(to right, #000, #fff)', marginTop: 6 }} />
      {strip('output')}
    </div>
    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
      <span className="muted">Sample</span>
      {(['black', 'gray', 'white'] as const).map(m => <button key={m} type="button" className={sampling === m ? 'primary' : ''} onClick={() => setSampling(sampling === m ? null : m)}>{m[0].toUpperCase() + m.slice(1)}</button>)}
    </div>
    {sampling && <span className="muted">Click the image to set {sampling}. Click the eyedropper again to stop.</span>}
    <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}><span className="muted">Auto</span><button type="button" onClick={() => auto('contrast')}>Contrast</button><button type="button" onClick={() => auto('color')}>Color</button><button type="button" onClick={() => auto('neutral')}>Color + neutral midtones</button></div>
  </>
}

export const filterPanels: Record<string, () => React.ReactNode> = {
  'Gaussian Blur': () => <GaussianBlurDialog />, 'Motion Blur': () => <MotionBlurDialog />, 'Add Noise': () => <AddNoiseDialog />, Vignette: () => <VignetteDialog />,
  'Progressive Blur': () => <ProgressiveBlurDialog />, 'Bloom / Glow': () => <BloomDialog />, Dither: () => <DitherDialog />, Scanlines: () => <ScanlinesDialog />, 'Tonal Contrast': () => <TonalContrastDialog />, 'Lens Correction': () => <LensDialog />, 'Camera Raw Filter': () => <CameraRawDialog />,
  'Content-Aware Fill': () => <ContentAwareDialog />, 'Remove Background': () => <RemoveBackgroundDialog />,
  ...Object.fromEntries((['Curves', 'Levels', 'Hue/Saturation', 'Black & White', 'Color Balance', 'Exposure', 'Gradient Map', 'Grain'] as AdjustmentKind[]).map(kind => [kind, () => <AdjustmentFilterDialog kind={kind} />])),
}

export function FilterHost() {
  const state = useEditor()
  const panel = state.panel && filterPanels[state.panel]
  return panel ? <>{panel()}</> : null
}
