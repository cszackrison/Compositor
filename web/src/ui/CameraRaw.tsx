import { useEffect, useMemo, useRef, useState } from 'react'
import { store } from '../editor/store'
import { useEditor } from './hooks'
import { Scrub, CurvesEditor } from './Inspector'
import { canvasPicker, requestRender } from './canvasState'
import { pixelToDocument } from '../render/compositor'
import { apply, invert } from '../render/gl'
import { newAdjustment, type CurvePoint } from '../model/types'
import { curveValue } from '../model/adjustments'
import type { Raster } from '../model/raster'
import { type CameraRawGroup, type CameraRawSettings, type CurveSettings, type Wheel, adjusts, autoBalance, cameraRawGroups, loadCameraRawTables, mixerCenters, mixerNames, neutralize, processVersions, resetGroup } from '../model/cameraRaw'

export type CameraRawParams = { settings: CameraRawSettings; hidden: CameraRawGroup[] }
type Set = (change: (s: CameraRawSettings) => CameraRawSettings) => void

// Track colors, left to right, as CameraRawSlider draws Camera Raw's color sliders.
const hsb = (degrees: number, s: number, b: number) => { const l = b * (1 - s / 2), sl = l <= 0 || l >= 1 ? 0 : (b - l) / Math.min(l, 1 - l); return `hsl(${((degrees % 360) + 360) % 360} ${Math.round(sl * 100)}% ${Math.round(l * 100)}%)` }
const tracks = {
  temperature: ['rgb(56,117,242)', 'rgb(250,209,46)'], tint: ['rgb(71,179,87)', 'rgb(179,102,163)'], chroma: ['rgb(158,158,163)', 'rgb(219,46,51)'],
  hue: (d: number) => [hsb(d - 50, 0.85, 0.9), hsb(d + 50, 0.85, 0.9)], saturation: (d: number) => ['rgb(140,140,143)', hsb(d, 0.9, 0.9)], luminance: (d: number) => [hsb(d, 0.55, 0.18), hsb(d, 0.35, 0.95)],
  spectrum: (d: number) => Array.from({ length: 13 }, (_, i) => hsb(d - 180 + i * 30, 0.85, 0.9)),
}

// One Camera Raw slider: a label to scrub, the slider (double-click puts it back), and the number.
function RawSlider({ label, value, min, max, reset = 0, digits = 0, track, title, disabled, onChange }: { label: string; value: number; min: number; max: number; reset?: number; digits?: number; track?: string[]; title?: string; disabled?: boolean; onChange: (v: number) => void }) {
  const step = Math.pow(10, -digits), round = (v: number) => +Math.min(max, Math.max(min, v)).toFixed(digits)
  return (
    <div className="row" title={title} style={disabled ? { opacity: 0.45, pointerEvents: 'none' } : undefined}>
      <span onDoubleClick={() => onChange(reset)}><Scrub label={label} value={value} min={min} max={max} step={step} sensitivity={(max - min) / 300} onChange={v => onChange(round(v))} /></span>
      <input type="range" className={track ? 'track' : ''} style={track ? { '--track': `linear-gradient(to right, ${track.join(', ')})` } as React.CSSProperties : undefined} min={min} max={max} step={step} value={value} onChange={e => onChange(round(+e.target.value))} onDoubleClick={() => onChange(reset)} />
      <input type="number" min={min} max={max} step={step} value={+value.toFixed(digits)} onChange={e => Number.isFinite(+e.target.value) && onChange(round(+e.target.value))} />
    </div>
  )
}

const Heading = ({ children }: { children: React.ReactNode }) => <span className="muted" style={{ fontWeight: 600, marginTop: 4 }}>{children}</span>
function Choice<T extends string>({ label, value, options, title, onChange }: { label: string; value: T; options: readonly T[]; title?: string; onChange: (v: T) => void }) {
  return <div className="row" title={title}><span className="muted">{label}</span><select value={value} onChange={e => onChange(e.target.value as T)}>{options.map(o => <option key={o}>{o}</option>)}</select><span /></div>
}

// The histogram of what the layer shows now, the grade included: every other pixel each way, as the Mac counts it.
function Histogram({ layerId }: { layerId: string }) {
  const state = useEditor(), ref = useRef<HTMLCanvasElement>(null)
  const image = store.layer(layerId)?.image
  useEffect(() => {
    const canvas = ref.current
    if (!canvas || !image) return
    const bins = [new Float64Array(256), new Float64Array(256), new Float64Array(256)], { width, height, data } = image
    for (let y = 0; y < height; y += 2) for (let x = 0; x < width; x += 2) {
      const i = (y * width + x) * 4, a = data[i + 3]
      if (a) for (let c = 0; c < 3; c++) bins[c][Math.min(255, Math.round(data[i + c] * 255 / a))] += a / 255
    }
    // Scaled to the tallest bin short of the ends, where clipping piles up.
    const peak = Math.max(1e-9, ...bins.flatMap(b => [...b.subarray(1, 255)])) * 1.05
    const dpr = window.devicePixelRatio || 1, w = canvas.clientWidth, h = canvas.clientHeight
    canvas.width = w * dpr; canvas.height = h * dpr
    const c = canvas.getContext('2d')!
    c.setTransform(dpr, 0, 0, dpr, 0, 0)
    c.clearRect(0, 0, w, h)
    c.globalCompositeOperation = 'lighter'
    bins.forEach((b, k) => {
      c.beginPath(); c.moveTo(0, h)
      for (let i = 0; i < 256; i++) c.lineTo(i * w / 255, h - h * Math.min(1, b[i] / peak))
      c.lineTo(w, h); c.closePath(); c.fillStyle = ['rgba(230,60,60,0.6)', 'rgba(60,200,80,0.6)', 'rgba(70,120,240,0.6)'][k]; c.fill()
    })
  }, [image, state.pixelRevision])
  return <canvas ref={ref} className="raw-histogram" title="Tones from black on the left to white on the right: blacks, shadows, midtones, highlights, whites" />
}

// A color wheel for Color Grading: angle is hue, distance from the middle is saturation. Double-click empties it.
function GradeWheel({ wheel, size, onChange }: { wheel: Wheel; size: number; onChange: (w: Wheel) => void }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = ref.current!, dpr = window.devicePixelRatio || 1
    canvas.width = canvas.height = size * dpr
    const c = canvas.getContext('2d')!, r = size / 2
    c.setTransform(dpr, 0, 0, dpr, 0, 0)
    const hues = c.createConicGradient(-Math.PI / 2, r, r)
    for (let i = 0; i <= 12; i++) hues.addColorStop(i / 12, `hsl(${i * 30} 80% 55%)`)
    c.beginPath(); c.arc(r, r, r - 1, 0, Math.PI * 2); c.fillStyle = hues; c.fill()
    const fade = c.createRadialGradient(r, r, 0, r, r, r)
    fade.addColorStop(0, 'rgba(128,128,128,1)'); fade.addColorStop(1, 'rgba(128,128,128,0)')
    c.fillStyle = fade; c.fill()
    const angle = wheel.hue * Math.PI / 180 - Math.PI / 2, d = wheel.saturation / 100 * (r - 6)
    c.beginPath(); c.arc(r + Math.cos(angle) * d, r + Math.sin(angle) * d, 5, 0, Math.PI * 2); c.strokeStyle = '#fff'; c.lineWidth = 2; c.stroke(); c.strokeStyle = '#000'; c.lineWidth = 1; c.stroke()
  }, [wheel.hue, wheel.saturation, size])
  const pick = (event: React.PointerEvent) => {
    const box = ref.current!.getBoundingClientRect(), x = event.clientX - box.left - size / 2, y = event.clientY - box.top - size / 2
    const hue = ((Math.atan2(y, x) * 180 / Math.PI + 90) % 360 + 360) % 360, saturation = Math.min(100, Math.hypot(x, y) / (size / 2 - 6) * 100)
    onChange({ ...wheel, hue: Math.round(hue), saturation: Math.round(saturation) })
  }
  return <canvas ref={ref} className="grade-wheel" style={{ width: size, height: size }} title="Drag inside the wheel: angle sets hue, distance sets saturation. Double-click to reset."
    onPointerDown={e => { (e.target as Element).setPointerCapture(e.pointerId); pick(e) }} onPointerMove={e => { if (e.buttons) pick(e) }} onDoubleClick={() => onChange({ ...wheel, hue: 0, saturation: 0 })} />
}

// The parametric curve drawn with its dividers, which drag sideways.
function ParametricCurve({ curve, onChange }: { curve: CurveSettings; onChange: (c: CurveSettings) => void }) {
  const ref = useRef<HTMLCanvasElement>(null), dragging = useRef<'shadowSplit' | 'darkSplit' | 'lightSplit' | null>(null)
  useEffect(() => {
    const canvas = ref.current!, dpr = window.devicePixelRatio || 1, w = canvas.clientWidth, h = canvas.clientHeight
    canvas.width = w * dpr; canvas.height = h * dpr
    const c = canvas.getContext('2d')!
    c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, w, h)
    c.strokeStyle = '#333'; c.lineWidth = 1
    for (const split of [curve.shadowSplit, curve.darkSplit, curve.lightSplit]) { c.beginPath(); c.moveTo(split / 100 * w, 0); c.lineTo(split / 100 * w, h); c.stroke() }
    c.beginPath(); c.moveTo(0, h); c.lineTo(w, 0); c.strokeStyle = '#444'; c.stroke()
    c.beginPath()
    for (let i = 0; i <= 64; i++) { const x = i / 64, y = rawTone(curve, x); if (i) c.lineTo(x * w, h - y * h); else c.moveTo(0, h - y * h) }
    c.strokeStyle = '#fff'; c.lineWidth = 2; c.stroke()
    for (const split of [curve.shadowSplit, curve.darkSplit, curve.lightSplit]) { c.beginPath(); c.moveTo(split / 100 * w - 5, h); c.lineTo(split / 100 * w + 5, h); c.lineTo(split / 100 * w, h - 8); c.fillStyle = '#ccc'; c.fill() }
  }, [curve])
  const at = (event: React.PointerEvent) => { const box = ref.current!.getBoundingClientRect(); return (event.clientX - box.left) / box.width * 100 }
  return <canvas ref={ref} className="parametric-curve" title="Drag a divider under the curve to change where each region starts"
    onPointerDown={e => { (e.target as Element).setPointerCapture(e.pointerId); const x = at(e); const keys = ['shadowSplit', 'darkSplit', 'lightSplit'] as const; dragging.current = keys.reduce((best, k) => Math.abs(curve[k] - x) < Math.abs(curve[best] - x) ? k : best, keys[0]) }}
    onPointerMove={e => {
      const key = dragging.current
      if (!key) return
      const x = Math.round(at(e)), next = { ...curve }
      if (key === 'shadowSplit') next.shadowSplit = Math.min(next.darkSplit - 2, Math.max(5, x))
      else if (key === 'darkSplit') next.darkSplit = Math.min(next.lightSplit - 2, Math.max(next.shadowSplit + 2, x))
      else next.lightSplit = Math.min(98, Math.max(next.darkSplit + 2, x))
      onChange(next)
    }}
    onPointerUp={() => { dragging.current = null }} />
}

// The curve as drawn (an approximation of the measured tables, the same bend the curve pass uses for moved dividers).
function rawTone(c: CurveSettings, x: number) {
  const bend = (t: number, lower: number, low: number, upper: number, high: number) => t < lower && lower > 0 ? lower * Math.pow(t / lower, Math.pow(2, -low / 100 * 1.66)) : t > upper && upper < 1 ? 1 - (1 - upper) * Math.pow((1 - t) / (1 - upper), Math.pow(2, high / 100 * 1.66)) : t
  const y = bend(bend(x, c.shadowSplit / 100, c.shadows, c.lightSplit / 100, c.highlights), c.darkSplit / 100, c.darks, c.darkSplit / 100, c.lights)
  return curveValue(c.rgb.map(p => ({ x: p.x * 255, y: p.y * 255 })), y * 255) / 255
}

const presets: Record<string, CurvePoint[]> = { Linear: [{ x: 0, y: 0 }, { x: 1, y: 1 }], 'Medium Contrast': [{ x: 0, y: 0 }, { x: 0.25, y: 0.18 }, { x: 0.75, y: 0.82 }, { x: 1, y: 1 }], 'Strong Contrast': [{ x: 0, y: 0 }, { x: 0.25, y: 0.1 }, { x: 0.75, y: 0.9 }, { x: 1, y: 1 }] }
const channelKeys = ['rgb', 'red', 'green', 'blue'] as const, channelLabels = ['RGB', 'Red', 'Green', 'Blue'] as const

function CurveControls({ s, set }: { s: CameraRawSettings; set: Set }) {
  const [page, setPage] = useState<'Parametric' | 'Point'>('Parametric'), [channel, setChannel] = useState(0)
  const curve = s.curve, write = (c: Partial<CurveSettings>) => set(x => ({ ...x, curve: { ...x.curve, ...c } }))
  const points = curve[channelKeys[channel]], preset = Object.keys(presets).find(k => JSON.stringify(presets[k]) === JSON.stringify(points)) ?? 'Custom'
  const adjustment = { ...newAdjustment('Curves'), curves: { channel: channelLabels[channel], channels: channelKeys.map(k => curve[k].map(p => ({ x: Math.round(p.x * 255), y: Math.round(p.y * 255) }))) } } as ReturnType<typeof newAdjustment>
  return <>
    <span className="segmented" title="Parametric lifts tonal regions. Point places anchors on the curve.">{(['Parametric', 'Point'] as const).map(p => <button key={p} type="button" className={page === p ? 'on' : ''} onClick={() => setPage(p)}>{p}</button>)}</span>
    {page === 'Parametric' ? <>
      <ParametricCurve curve={curve} onChange={c => write(c)} />
      <RawSlider label="Highlights" value={curve.highlights} min={-100} max={100} onChange={highlights => write({ highlights })} title="Moves the brightest region of the curve." />
      <RawSlider label="Lights" value={curve.lights} min={-100} max={100} onChange={lights => write({ lights })} title="Moves the light region of the curve." />
      <RawSlider label="Darks" value={curve.darks} min={-100} max={100} onChange={darks => write({ darks })} title="Moves the dark region of the curve." />
      <RawSlider label="Shadows" value={curve.shadows} min={-100} max={100} onChange={shadows => write({ shadows })} title="Moves the darkest region of the curve." />
    </> : <>
      <div className="row"><span className="muted">Channel</span><select value={channel} title="RGB changes brightness. Red, green, and blue also shift the color." onChange={e => setChannel(+e.target.value)}>{channelLabels.map((l, i) => <option key={l} value={i}>{l}</option>)}</select><span /></div>
      <CurvesEditor adjustment={adjustment} onChange={a => write({ [channelKeys[channel]]: a.curves.channels[channel].map(p => ({ x: p.x / 255, y: p.y / 255 })) })} />
      <div className="row"><span className="muted">Preset</span><select value={preset} title="Replaces this curve with a straight line or a contrast curve." onChange={e => presets[e.target.value] && write({ [channelKeys[channel]]: presets[e.target.value] })}><option disabled>Custom</option>{Object.keys(presets).map(k => <option key={k}>{k}</option>)}</select><span /></div>
    </>}
    <RawSlider label="Refine Saturation" value={curve.refineSaturation} min={-100} max={100} onChange={refineSaturation => write({ refineSaturation })} title="How much the curve also changes color strength. Zero matches Photoshop; lower keeps it to brightness, higher adds color." />
  </>
}

function MixerControls({ s, set }: { s: CameraRawSettings; set: Set }) {
  const [page, setPage] = useState<'HSL' | 'Color'>('HSL'), [tab, setTab] = useState<'hue' | 'saturation' | 'luminance'>('hue'), [color, setColor] = useState(0)
  const write = (kind: 'hue' | 'saturation' | 'luminance', index: number, v: number) => set(x => ({ ...x, mixer: { ...x.mixer, [kind]: x.mixer[kind].map((old, i) => i === index ? v : old) } }))
  const track = (kind: 'hue' | 'saturation' | 'luminance', index: number) => tracks[kind](mixerCenters[index])
  return <>
    <span className="segmented" title="HSL lists every color. Color edits one family.">{(['HSL', 'Color'] as const).map(p => <button key={p} type="button" className={page === p ? 'on' : ''} onClick={() => setPage(p)}>{p}</button>)}</span>
    {page === 'HSL' ? <>
      <span className="segmented" title="Hue shifts the color, Saturation its strength, and Luminance its brightness.">{(['hue', 'saturation', 'luminance'] as const).map(t => <button key={t} type="button" className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>{t[0].toUpperCase() + t.slice(1)}</button>)}</span>
      {mixerNames.map((name, i) => <RawSlider key={name} label={name} value={s.mixer[tab][i]} min={-100} max={100} track={track(tab, i)} onChange={v => write(tab, i, v)} />)}
    </> : <>
      <div style={{ display: 'flex', gap: 6 }}>{mixerNames.map((name, i) => <button key={name} type="button" title={`Edit ${name}`} className={`swatch-dot ${color === i ? 'on' : ''}`} style={{ background: hsb(mixerCenters[i], 0.85, 0.9) }} onClick={() => setColor(i)} />)}</div>
      {(['hue', 'saturation', 'luminance'] as const).map(kind => <RawSlider key={kind} label={kind[0].toUpperCase() + kind.slice(1)} value={s.mixer[kind][color]} min={-100} max={100} track={track(kind, color)} onChange={v => write(kind, color, v)} />)}
    </>}
  </>
}

function GradingControls({ s, set }: { s: CameraRawSettings; set: Set }) {
  const [page, setPage] = useState<'Three-Way' | 'Shadows' | 'Midtones' | 'Highlights' | 'Global'>('Three-Way')
  const g = s.grading, write = (key: 'shadows' | 'midtones' | 'highlights' | 'global', w: Wheel) => set(x => ({ ...x, grading: { ...x.grading, [key]: w } }))
  const one = (key: 'shadows' | 'midtones' | 'highlights' | 'global', title: string, size: number) => (
    <div key={key} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
      <span className="muted">{title}</span>
      <GradeWheel wheel={g[key]} size={size} onChange={w => write(key, w)} />
      {size > 100 && <><RawSlider label="Hue" value={g[key].hue} min={0} max={360} track={tracks.spectrum(180)} onChange={hue => write(key, { ...g[key], hue })} /><RawSlider label="Saturation" value={g[key].saturation} min={0} max={100} onChange={saturation => write(key, { ...g[key], saturation })} /></>}
      {size > 100 ? <RawSlider label="Luminance" value={g[key].luminance} min={-100} max={100} onChange={luminance => write(key, { ...g[key], luminance })} />
        : <input type="range" min={-100} max={100} step={1} value={g[key].luminance} title={`${title} luminance: ${g[key].luminance}`} style={{ width: size }} onChange={e => write(key, { ...g[key], luminance: +e.target.value })} onDoubleClick={() => write(key, { ...g[key], luminance: 0 })} />}
    </div>
  )
  return <>
    <select value={page} title="Three-Way shows shadows, midtones, and highlights. The other choices show one wheel." onChange={e => setPage(e.target.value as typeof page)}>{['Three-Way', 'Shadows', 'Midtones', 'Highlights', 'Global'].map(p => <option key={p}>{p}</option>)}</select>
    {page === 'Three-Way' ? <>{one('midtones', 'Midtones', 96)}<div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>{one('shadows', 'Shadows', 96)}{one('highlights', 'Highlights', 96)}</div></> : one(page.toLowerCase() as 'shadows', page, 160)}
    <RawSlider label="Blending" value={g.blending} min={0} max={100} reset={50} onChange={blending => set(x => ({ ...x, grading: { ...x.grading, blending } }))} title="Controls how much the three tonal wheels overlap." />
    <RawSlider label="Balance" value={g.balance} min={-100} max={100} onChange={balance => set(x => ({ ...x, grading: { ...x.grading, balance } }))} title="Shifts the wheels toward shadows or highlights." />
  </>
}

// What the eyedroppers read: the layer as it was before the filter, at a point on the canvas.
function sampleOriginal(original: Raster, layerId: string, point: [number, number]): [number, number, number] | null {
  const layer = store.layer(layerId)
  if (!layer) return null
  const [x, y] = apply(invert(pixelToDocument(layer.transform, original.width, original.height)), ...point).map(Math.floor)
  if (x < 0 || y < 0 || x >= original.width || y >= original.height) return null
  const i = (y * original.width + x) * 4, a = original.data[i + 3]
  return a ? [0, 1, 2].map(c => Math.min(1, original.data[i + c] / a)) as [number, number, number] : null
}

// Camera Raw's adjustment column (CameraRawControls.swift): the histogram, then each section, opened by its heading, with an eye that
// leaves it out of the preview and OK, and a reset, both shown once it adjusts something.
export function CameraRawPanel({ params, set, layerId }: { params: CameraRawParams; set: (p: Partial<CameraRawParams>) => void; layerId: string }) {
  const s = params.settings, update: Set = change => set({ settings: change(params.settings) })
  const latest = useRef(params)
  latest.current = params
  const original = useMemo(() => store.layer(layerId)?.image ?? null, [])
  const [open, setOpen] = useState<CameraRawGroup[]>(['Light', 'Color', 'Color Grading'])
  const [ready, setReady] = useState(false), [failed, setFailed] = useState<string | null>(null)
  const [sampling, setSampling] = useState<'white' | 'defringe' | null>(null)
  useEffect(() => { loadCameraRawTables().then(() => setReady(true), e => setFailed((e as Error).message)) }, [])
  useEffect(() => {
    if (!sampling || !original) return
    canvasPicker.current = point => {
      const rgb = sampleOriginal(original, layerId, point), current = latest.current.settings
      if (!rgb) return
      if (sampling === 'white') {
        const solved = neutralize(...rgb)
        if (solved) set({ settings: { ...current, whiteBalance: 'Custom', temperature: solved.temperature, tint: solved.tint } })
        return
      }
      const [r, g, b] = rgb, max = Math.max(r, g, b), chroma = max - Math.min(r, g, b)
      let hue = chroma <= 1e-6 ? 0 : max === r ? (g - b) / chroma : max === g ? 2 + (b - r) / chroma : 4 + (r - g) / chroma
      hue = (hue * 60 + 360) % 360
      const o = current.optics, purple = Math.abs(hue - 290) < Math.abs(hue - 90), clampHue = (v: number) => Math.min(360, Math.max(0, v))
      set({ settings: { ...current, optics: purple ? { ...o, purpleHueLow: clampHue(hue - 25), purpleHueHigh: clampHue(hue + 25), purpleAmount: o.purpleAmount || 50 } : { ...o, greenHueLow: clampHue(hue - 25), greenHueHigh: clampHue(hue + 25), greenAmount: o.greenAmount || 50 } } })
    }
    requestRender(false)
    return () => { canvasPicker.current = null }
  }, [sampling])
  const setWhiteBalance = (mode: 'Custom' | 'Auto') => {
    if (mode === 'Custom' || !original) { update(x => ({ ...x, whiteBalance: mode })); return }
    const solved = autoBalance(original)
    update(x => ({ ...x, whiteBalance: 'Auto', ...(solved ?? {}) }))
  }
  const toggle = (list: CameraRawGroup[], group: CameraRawGroup) => list.includes(group) ? list.filter(g => g !== group) : [...list, group]
  const num = (key: keyof CameraRawSettings) => s[key] as number
  const field = (label: string, key: keyof CameraRawSettings, min: number, max: number, extra: { reset?: number; digits?: number; track?: string[]; title?: string; disabled?: boolean } = {}) =>
    <RawSlider label={label} value={num(key)} min={min} max={max} {...extra} onChange={v => update(x => ({ ...x, [key]: v, ...(key === 'temperature' || key === 'tint' ? { whiteBalance: 'Custom' } : {}) }))} />
  const sub = <K extends 'detail' | 'optics' | 'geometry' | 'calibration'>(group: K, label: string, key: keyof CameraRawSettings[K], min: number, max: number, extra: { reset?: number; title?: string; disabled?: boolean } = {}) =>
    <RawSlider label={label} value={s[group][key] as number} min={min} max={max} {...extra} onChange={v => update(x => ({ ...x, [group]: { ...x[group], [key]: v } }))} />
  const check = <K extends 'optics' | 'geometry'>(group: K, label: string, key: keyof CameraRawSettings[K], title: string) =>
    <label title={title}><input type="checkbox" checked={!!s[group][key]} onChange={e => update(x => ({ ...x, [group]: { ...x[group], [key]: e.target.checked } }))} /> {label}</label>
  const section = (group: CameraRawGroup) => {
    switch (group) {
      case 'Light': return <>
        {field('Exposure', 'exposure', -5, 5, { digits: 2, title: 'Brightens or darkens the whole picture, in stops of light.' })}
        {field('Contrast', 'contrast', -100, 100, { title: 'Makes light and dark tones more or less different, mostly around the middle.' })}
        {field('Highlights', 'highlights', -100, 100, { title: 'Adjusts the bright parts of the picture.' })}
        {field('Shadows', 'shadows', -100, 100, { title: 'Adjusts the dark parts of the picture.' })}
        {field('Whites', 'whites', -100, 100, { title: 'Sets the brightest point.' })}
        {field('Blacks', 'blacks', -100, 100, { title: 'Sets the darkest point.' })}
      </>
      case 'Color': return <>
        <div className="row" title="Auto balances the average color. Custom follows Temperature and Tint."><span className="muted">White Balance</span><select value={s.whiteBalance} onChange={e => setWhiteBalance(e.target.value as 'Custom' | 'Auto')}><option>Custom</option><option>Auto</option></select>
          <button type="button" className={`icon ${sampling === 'white' ? 'on' : ''}`} title="White Balance Selector: click a pixel that should be neutral" onClick={() => setSampling(sampling === 'white' ? null : 'white')}>⌖</button></div>
        {sampling === 'white' && <span className="muted">Click the layer where it should be neutral. Click the eyedropper again to stop.</span>}
        {field('Temperature', 'temperature', -100, 100, { track: tracks.temperature, title: 'Shifts the picture from blue to yellow.' })}
        {field('Tint', 'tint', -100, 100, { track: tracks.tint, title: 'Shifts the picture from green to mauve.' })}
        {field('Vibrance', 'vibrance', -100, 100, { track: tracks.chroma, title: 'Strengthens quiet colors more than colors that are already strong, and protects skin tones.' })}
        {field('Saturation', 'saturation', -100, 100, { track: tracks.chroma, title: 'Strengthens or weakens every color by the same amount.' })}
      </>
      case 'Color Grading': return <GradingControls s={s} set={update} />
      case 'Effects': return <>
        {field('Texture', 'texture', -100, 100, { title: 'Adds or softens small detail.' })}
        {field('Clarity', 'clarity', -100, 100, { title: 'Adds or softens contrast along broader shapes.' })}
        {field('Dehaze', 'dehaze', -100, 100, { title: 'Clears haze when raised, and adds haze when lowered.' })}
        <Heading>Glow</Heading>
        {field('Glow', 'glow', 0, 100, { title: 'Spreads a glow from the bright areas.' })}
        <Choice label="Style" value={s.glowStyle} options={['Diffusion', 'Bloom', 'Halation'] as const} title="Diffusion is soft and wide, Bloom is tighter, and Halation is a red fringe." onChange={glowStyle => update(x => ({ ...x, glowStyle }))} />
        {field('Range', 'glowRange', -100, 100, { disabled: !s.glow, title: 'Chooses how bright an area must be to glow.' })}
        {field('Spread', 'glowSpread', -100, 100, { disabled: !s.glow, title: 'Sets how far the glow reaches.' })}
        {field('Warmth', 'glowWarmth', -100, 100, { disabled: !s.glow, title: 'Shifts the glow from cool to warm. Halation stays red.' })}
        <Heading>Vignette</Heading>
        {field('Amount', 'vignetteAmount', -100, 100, { title: 'Darkens or lightens the edges. The center does not change.' })}
        <Choice label="Style" value={s.vignetteStyle} options={['Highlight Priority', 'Color Priority', 'Paint Overlay'] as const} title="Highlight Priority protects bright edges. Color Priority also reduces color. Paint Overlay covers the edges evenly." onChange={vignetteStyle => update(x => ({ ...x, vignetteStyle }))} />
        {field('Midpoint', 'vignetteMidpoint', 0, 100, { reset: 50, title: 'Sets where the vignette begins, from the center outward.' })}
        {field('Roundness', 'vignetteRoundness', -100, 100, { title: 'Makes the vignette rounder or more square.' })}
        {field('Feather', 'vignetteFeather', 0, 100, { reset: 50, title: 'Softens the edge of the vignette.' })}
        {field('Highlights', 'vignetteHighlights', 0, 100, { title: 'Protects bright pixels while a dark vignette is applied. Used by Highlight Priority.' })}
        <Heading>Grain</Heading>
        {field('Amount', 'grainAmount', 0, 100, { title: 'Adds film grain, strongest in the middle tones.' })}
        {field('Size', 'grainSize', 0, 100, { reset: 25, title: 'Makes the grain coarser or finer.' })}
        {field('Roughness', 'grainRoughness', 0, 100, { reset: 50, title: 'Makes the grain smoother or more uneven.' })}
      </>
      case 'Curve': return <CurveControls s={s} set={update} />
      case 'Color Mixer': return <MixerControls s={s} set={update} />
      case 'Detail': return <>
        <Heading>Sharpening</Heading>
        {sub('detail', 'Amount', 'sharpenAmount', 0, 150, { title: 'Controls how strong the sharpening is.' })}
        {sub('detail', 'Radius', 'sharpenRadius', 0, 100, { reset: 10, title: 'How far from each edge the sharpening reaches, in pixels.' })}
        {sub('detail', 'Detail', 'sharpenDetail', 0, 100, { reset: 25, title: 'Emphasizes fine texture over broader edges.' })}
        {sub('detail', 'Masking', 'sharpenMasking', 0, 100, { title: 'Limits sharpening to stronger edges.' })}
        <Heading>Noise Reduction</Heading>
        {sub('detail', 'Luminance', 'noiseLuminance', 0, 100, { title: 'Smooths grain and noise in brightness.' })}
        {sub('detail', 'Luminance Detail', 'noiseLuminanceDetail', 0, 100, { reset: 50, disabled: !s.detail.noiseLuminance, title: 'Preserves fine texture while luminance noise is reduced.' })}
        {sub('detail', 'Luminance Contrast', 'noiseLuminanceContrast', 0, 100, { disabled: !s.detail.noiseLuminance, title: 'Keeps local contrast after luminance smoothing.' })}
        {sub('detail', 'Color', 'noiseColor', 0, 100, { title: 'Smooths colored speckles.' })}
        {sub('detail', 'Color Detail', 'noiseColorDetail', 0, 100, { reset: 50, disabled: !s.detail.noiseColor, title: 'Preserves colored edges while color noise is reduced.' })}
        {sub('detail', 'Color Smoothness', 'noiseColorSmoothness', 0, 100, { reset: 50, disabled: !s.detail.noiseColor, title: 'Makes the color smoothing softer or tighter.' })}
      </>
      case 'Optics': return <>
        {check('optics', 'Remove Chromatic Aberration', 'removeChromaticAberration', 'Pulls red and blue fringes apart toward the center to reduce color edging.')}
        {check('optics', 'Enable Lens Profile Corrections', 'enableLensProfile', 'Applies generic profile strength when camera metadata is not available.')}
        {s.optics.enableLensProfile && <>
          <span className="muted">No lens metadata on this layer. Profile sliders set generic correction strength.</span>
          {sub('optics', 'Distortion', 'profileDistortion', 0, 100, { reset: 100, title: 'How much of the profile distortion correction is applied.' })}
          {sub('optics', 'Vignetting', 'profileVignetting', 0, 100, { reset: 100, title: 'How much of the profile vignetting correction is applied.' })}
        </>}
        <Heading>Manual</Heading>
        {sub('optics', 'Distortion', 'distortion', -100, 100, { title: 'Straightens barrel or pincushion bending.' })}
        <div className="row" title="Click a purple or green fringe to set its hue range."><span className="muted">Defringe</span><button type="button" className={`icon ${sampling === 'defringe' ? 'on' : ''}`} style={{ justifySelf: 'start' }} title="Defringe Selector: click a purple or green fringe" onClick={() => setSampling(sampling === 'defringe' ? null : 'defringe')}>⌖</button><span /></div>
        {sampling === 'defringe' && <span className="muted">Click the fringe on the layer. Click the eyedropper again to stop.</span>}
        {sub('optics', 'Purple Amount', 'purpleAmount', 0, 100, { title: 'Weakens purple fringes inside the purple hue range.' })}
        {sub('optics', 'Purple Hue Low', 'purpleHueLow', 0, 360, { reset: 270, title: 'Start of the purple hue range, in degrees.' })}
        {sub('optics', 'Purple Hue High', 'purpleHueHigh', 0, 360, { reset: 310, title: 'End of the purple hue range, in degrees.' })}
        {sub('optics', 'Green Amount', 'greenAmount', 0, 100, { title: 'Weakens green fringes inside the green hue range.' })}
        {sub('optics', 'Green Hue Low', 'greenHueLow', 0, 360, { reset: 60, title: 'Start of the green hue range, in degrees.' })}
        {sub('optics', 'Green Hue High', 'greenHueHigh', 0, 360, { reset: 120, title: 'End of the green hue range, in degrees.' })}
        {sub('optics', 'Vignetting', 'vignetteAmount', -100, 100, { title: 'Brightens or darkens the corners to counter lens falloff.' })}
        {sub('optics', 'Midpoint', 'vignetteMidpoint', 0, 100, { reset: 50, title: 'Moves the vignette correction inward or outward.' })}
      </>
      case 'Geometry': return <>
        <Choice label="Projection" value={s.geometry.projection} options={['Perspective', 'Rectilinear'] as const} title="Perspective allows stronger keystone. Rectilinear keeps the warp gentler." onChange={projection => update(x => ({ ...x, geometry: { ...x.geometry, projection } }))} />
        {sub('geometry', 'Vertical', 'vertical', -100, 100, { title: 'Straightens vertical lines toward the center.' })}
        {sub('geometry', 'Horizontal', 'horizontal', -100, 100, { title: 'Straightens horizontal lines toward the center.' })}
        {sub('geometry', 'Rotate', 'rotate', -45, 45, { title: 'Rotates the picture around its center.' })}
        {sub('geometry', 'Aspect', 'aspect', -100, 100, { title: 'Stretches width relative to height.' })}
        {sub('geometry', 'Scale', 'scale', -100, 100, { title: 'Zooms the transformed picture within the frame.' })}
        {sub('geometry', 'Offset X', 'offsetX', -100, 100, { title: 'Moves the picture left or right.' })}
        {sub('geometry', 'Offset Y', 'offsetY', -100, 100, { title: 'Moves the picture up or down.' })}
        {check('geometry', 'Constrain Crop', 'constrainCrop', 'Crops empty edges after the transform and fits the result back into the frame.')}
      </>
      case 'Calibration': return <>
        <Choice label="Process" value={s.calibration.process} options={processVersions} title="Chooses how strongly the shadow tint below is applied. Version 6 is the current default." onChange={process => update(x => ({ ...x, calibration: { ...x.calibration, process } }))} />
        <Heading>Shadows</Heading>
        {sub('calibration', 'Tint', 'shadowTint', -100, 100, { title: 'Adds green or magenta to the darkest tones.' })}
        {(['red', 'green', 'blue'] as const).map(c => <div key={c} style={{ display: 'contents' }}>
          <Heading>{c[0].toUpperCase() + c.slice(1)} Primary</Heading>
          {sub('calibration', 'Hue', `${c}Hue`, -100, 100, { title: `Shifts how ${c} is interpreted.` })}
          {sub('calibration', 'Saturation', `${c}Saturation`, -100, 100, { title: `Strengthens or weakens the ${c} primary.` })}
        </div>)}
      </>
    }
  }
  return (
    <div className="camera-raw">
      <Histogram layerId={layerId} />
      {failed && <span style={{ color: '#ffb35c' }}>{failed}</span>}
      {!ready && !failed && <span className="muted">Loading Camera Raw’s color tables…</span>}
      <div className="raw-sections">
        {cameraRawGroups.map(group => {
          const edited = adjusts(s, group), shown = !params.hidden.includes(group), expanded = open.includes(group)
          return <div key={group} className="raw-section">
            <div className="raw-heading">
              <button type="button" className="disclosure" onClick={() => setOpen(toggle(open, group))}>{expanded ? '▾' : '▸'} {group}</button>
              {edited && <button type="button" className="icon" title={shown ? `Hide ${group} in the preview` : `Show ${group} in the preview`} onClick={() => set({ hidden: toggle(params.hidden, group) })}>{shown ? '◉' : '○'}</button>}
              {edited && <button type="button" className="icon" title={`Reset ${group} to its defaults`} onClick={() => set({ settings: resetGroup(s, group), hidden: params.hidden.filter(g => g !== group) })}>↺</button>}
            </div>
            {expanded && <div className="raw-controls">{section(group)}</div>}
          </div>
        })}
      </div>
    </div>
  )
}
