import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { store } from '../editor/store'
import { useEditor } from './hooks'
import { Scrub, CurvesEditor } from './Inspector'
import { Icon } from './icons'
import { canvasGesture, canvasPicker, requestRender, view as stage } from './canvasState'
import { pixelToDocument } from '../render/compositor'
import { apply, invert } from '../render/gl'
import { newAdjustment, type CurvePoint } from '../model/types'
import { curveValue } from '../model/adjustments'
import type { Raster } from '../model/raster'
import { type CameraRawGroup, type CameraRawSettings, type CameraRawView, type CurveSettings, type Guide, type Wheel, adjusts, newPointColor, autoBalance, cameraRawGroups, loadCameraRawTables, mixerCenters, mixerNames, neutralize, processVersions, resetGroup } from '../model/cameraRaw'

export type CameraRawParams = { settings: CameraRawSettings; hidden: CameraRawGroup[]; view: CameraRawView }
type Set = (change: (s: CameraRawSettings) => CameraRawSettings) => void
// Whether the preview shows something OK won't keep: then OK runs the grade alone.
export const hasView = (v?: CameraRawView) => !!v && (!!v.clipping || !!v.sharpenMask || !!v.shadows || !!v.highlights || (v.visualize ?? -1) >= 0)

// The canvas tool the panel has on: an eyedropper (white balance, defringe, point color), a targeted drag (Curve, Color Mixer), or
// drawing Upright guides. One at a time.
type Tool = 'white' | 'defringe' | 'point' | 'curve' | 'mixer' | 'guides' | null
type Ui = { curvePage: 'Parametric' | 'Point'; channel: number; mixerPage: 'HSL' | 'Color' | 'Point Color'; mixerTab: 'hue' | 'saturation' | 'luminance'; mixerColor: number; point: number; tool: Tool }
type UiProps = { ui: Ui; setUi: (u: Partial<Ui>) => void }

// Option held while a Light slider moves shows what clips (1 highlights, 2 shadows); on Detail's Masking, the sharpening mask.
let optionHeld = false
const ShowView = createContext<(kind: 1 | 2 | 'mask' | null) => void>(() => {})

// Track colors, left to right, as CameraRawSlider draws Camera Raw's color sliders.
const hsb = (degrees: number, s: number, b: number) => { const l = b * (1 - s / 2), sl = l <= 0 || l >= 1 ? 0 : (b - l) / Math.min(l, 1 - l); return `hsl(${((degrees % 360) + 360) % 360} ${Math.round(sl * 100)}% ${Math.round(l * 100)}%)` }
const tracks = {
  temperature: ['rgb(56,117,242)', 'rgb(250,209,46)'], tint: ['rgb(71,179,87)', 'rgb(179,102,163)'], chroma: ['rgb(158,158,163)', 'rgb(219,46,51)'],
  hue: (d: number) => [hsb(d - 50, 0.85, 0.9), hsb(d + 50, 0.85, 0.9)], saturation: (d: number) => ['rgb(140,140,143)', hsb(d, 0.9, 0.9)], luminance: (d: number) => [hsb(d, 0.55, 0.18), hsb(d, 0.35, 0.95)],
  spectrum: (d: number) => Array.from({ length: 13 }, (_, i) => hsb(d - 180 + i * 30, 0.85, 0.9)),
}

// One Camera Raw slider: a label to scrub, the slider (double-click puts it back), and the number.
function RawSlider({ label, value, min, max, reset = 0, digits = 0, track, title, disabled, shows, onChange: set }: { label: string; value: number; min: number; max: number; reset?: number; digits?: number; track?: string[]; title?: string; disabled?: boolean; shows?: 1 | 2 | 'mask'; onChange: (v: number) => void }) {
  const step = Math.pow(10, -digits), round = (v: number) => +Math.min(max, Math.max(min, v)).toFixed(digits), show = useContext(ShowView)
  const onChange = (v: number) => { show(shows && optionHeld ? shows : null); set(v) }
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

// The histogram (or the vectorscope, from its menu) of what the layer shows now, the grade included: every other pixel each way, as
// the Mac counts them. The triangles paint clipped shadows blue and clipped highlights red on the preview.
function Histogram({ layerId, view, setView }: { layerId: string; view: CameraRawView; setView: (v: CameraRawView) => void }) {
  const state = useEditor(), ref = useRef<HTMLCanvasElement>(null), [scope, setScope] = useState<'Histogram' | 'Vectorscope'>('Histogram')
  // The Option views and Visualize Range replace the picture, so the scope holds still under them; the triangles only mark clipped pixels.
  const image = store.layer(layerId)?.image, frozen = !!view.clipping || !!view.sharpenMask || (view.visualize ?? -1) >= 0
  useEffect(() => {
    const canvas = ref.current
    if (!canvas || !image || frozen) return
    const bins = [new Float64Array(256), new Float64Array(256), new Float64Array(256)], side = 64, plot = new Float64Array(side * side), { width, height, data } = image
    for (let y = 0; y < height; y += 2) for (let x = 0; x < width; x += 2) {
      const i = (y * width + x) * 4, a = data[i + 3]
      if (!a) continue
      const r = Math.min(1, data[i] / a), g = Math.min(1, data[i + 1] / a), b = Math.min(1, data[i + 2] / a), w = a / 255
      bins[0][Math.round(r * 255)] += w; bins[1][Math.round(g * 255)] += w; bins[2][Math.round(b * 255)] += w
      const top = Math.max(r, g, b), chroma = top - Math.min(r, g, b)
      if (chroma <= 1e-4 || top <= 1e-4) continue
      let hue = (top === r ? (g - b) / chroma : top === g ? 2 + (b - r) / chroma : 4 + (r - g) / chroma) / 6
      if (hue < 0) hue += 1
      const angle = hue * 2 * Math.PI, saturation = chroma / top
      const column = Math.min(side - 1, Math.max(0, Math.floor((0.5 + Math.cos(angle) * saturation * 0.48) * side))), line = Math.min(side - 1, Math.max(0, Math.floor((0.5 + Math.sin(angle) * saturation * 0.48) * side)))
      plot[line * side + column] += w
    }
    const dpr = window.devicePixelRatio || 1, w = canvas.clientWidth, h = canvas.clientHeight
    canvas.width = w * dpr; canvas.height = h * dpr
    const c = canvas.getContext('2d')!
    c.setTransform(dpr, 0, 0, dpr, 0, 0)
    c.clearRect(0, 0, w, h)
    if (scope === 'Vectorscope') {
      const peak = Math.max(1e-9, ...plot), cell = Math.min(w, h) / side, left = (w - cell * side) / 2
      plot.forEach((v, i) => { if (v > 0) { c.fillStyle = `rgba(255,255,255,${0.15 + 0.85 * Math.min(1, v / peak)})`; c.fillRect(left + (i % side) * cell, h - (Math.floor(i / side) + 1) * cell, cell + 0.2, cell + 0.2) } })
      return
    }
    // Scaled to the tallest bin short of the ends, where clipping piles up.
    const peak = Math.max(1e-9, ...bins.flatMap(b => [...b.subarray(1, 255)])) * 1.05
    c.globalCompositeOperation = 'lighter'
    bins.forEach((b, k) => {
      c.beginPath(); c.moveTo(0, h)
      for (let i = 0; i < 256; i++) c.lineTo(i * w / 255, h - h * Math.min(1, b[i] / peak))
      c.lineTo(w, h); c.closePath(); c.fillStyle = ['rgba(230,60,60,0.6)', 'rgba(60,200,80,0.6)', 'rgba(70,120,240,0.6)'][k]; c.fill()
    })
  }, [image, state.pixelRevision, frozen, scope])
  const triangle = (shadows: boolean) => {
    const on = shadows ? view.shadows : view.highlights
    return <button type="button" className="clip-triangle" style={{ [shadows ? 'left' : 'right']: 4, color: on ? (shadows ? '#4a8cff' : '#ff5050') : 'rgba(255,255,255,0.55)' }} title={shadows ? 'Show clipped shadows in blue on the preview' : 'Show clipped highlights in red on the preview'} onClick={() => setView({ ...view, [shadows ? 'shadows' : 'highlights']: !on })}>▲</button>
  }
  return (
    <div className="raw-scope">
      <canvas ref={ref} className="raw-histogram" onContextMenu={e => { e.preventDefault(); setScope(scope === 'Histogram' ? 'Vectorscope' : 'Histogram') }}
        title={scope === 'Histogram' ? 'Tones from black on the left to white on the right: blacks, shadows, midtones, highlights, whites. Right-click to show the vectorscope.' : 'Hue around the wheel, saturation outward from the center. Right-click to show the histogram.'} />
      {scope === 'Histogram' && <>{triangle(true)}{triangle(false)}</>}
    </div>
  )
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

const Targeted = ({ on, onClick, title }: { on: boolean; onClick: () => void; title: string }) => <button type="button" className={on ? 'primary' : ''} title={title} onClick={onClick}>◎ Targeted Adjustment</button>

function CurveControls({ s, set, ui, setUi }: { s: CameraRawSettings; set: Set } & UiProps) {
  const curve = s.curve, write = (c: Partial<CurveSettings>) => set(x => ({ ...x, curve: { ...x.curve, ...c } }))
  const channel = ui.channel, points = curve[channelKeys[channel]], preset = Object.keys(presets).find(k => JSON.stringify(presets[k]) === JSON.stringify(points)) ?? 'Custom'
  const adjustment = { ...newAdjustment('Curves'), curves: { channel: channelLabels[channel], channels: channelKeys.map(k => curve[k].map(p => ({ x: Math.round(p.x * 255), y: Math.round(p.y * 255) }))) } } as ReturnType<typeof newAdjustment>
  return <>
    <span className="segmented" title="Parametric lifts tonal regions. Point places anchors on the curve.">{(['Parametric', 'Point'] as const).map(p => <button key={p} type="button" className={ui.curvePage === p ? 'on' : ''} onClick={() => setUi({ curvePage: p })}>{p}</button>)}</span>
    {ui.curvePage === 'Parametric' ? <>
      <ParametricCurve curve={curve} onChange={c => write(c)} />
      <RawSlider label="Highlights" value={curve.highlights} min={-100} max={100} onChange={highlights => write({ highlights })} title="Lifts or lowers the brightest tones." />
      <RawSlider label="Lights" value={curve.lights} min={-100} max={100} onChange={lights => write({ lights })} title="Lifts or lowers the light tones." />
      <RawSlider label="Darks" value={curve.darks} min={-100} max={100} onChange={darks => write({ darks })} title="Lifts or lowers the dark tones." />
      <RawSlider label="Shadows" value={curve.shadows} min={-100} max={100} onChange={shadows => write({ shadows })} title="Lifts or lowers the darkest tones." />
    </> : <>
      <div className="row"><span className="muted">Channel</span><select value={channel} title="RGB changes brightness. Red, green, and blue also shift the color." onChange={e => setUi({ channel: +e.target.value })}>{channelLabels.map((l, i) => <option key={l} value={i}>{l}</option>)}</select><span /></div>
      <CurvesEditor adjustment={adjustment} onChange={a => write({ [channelKeys[channel]]: a.curves.channels[channel].map(p => ({ x: p.x / 255, y: p.y / 255 })) })} />
      <div className="row"><span className="muted">Preset</span><select value={preset} title="Replaces this curve with a straight line or a contrast curve." onChange={e => presets[e.target.value] && write({ [channelKeys[channel]]: presets[e.target.value] })}><option disabled>Custom</option>{Object.keys(presets).map(k => <option key={k}>{k}</option>)}</select><span /></div>
    </>}
    <RawSlider label="Refine Saturation" value={curve.refineSaturation} min={-100} max={100} onChange={refineSaturation => write({ refineSaturation })} title="How much the curve also changes color strength. Zero matches Photoshop; lower keeps it to brightness, higher adds color." />
    <Targeted on={ui.tool === 'curve'} onClick={() => setUi({ tool: ui.tool === 'curve' ? null : 'curve' })} title="Drag up or down on the picture to lift or lower the tones under the pointer." />
  </>
}

function MixerControls({ s, set, ui, setUi, view, setView }: { s: CameraRawSettings; set: Set; view: CameraRawView; setView: (v: CameraRawView) => void } & UiProps) {
  const write = (kind: 'hue' | 'saturation' | 'luminance', index: number, v: number) => set(x => ({ ...x, mixer: { ...x.mixer, [kind]: x.mixer[kind].map((old, i) => i === index ? v : old) } }))
  const track = (kind: 'hue' | 'saturation' | 'luminance', index: number) => tracks[kind](mixerCenters[index])
  const points = s.mixer.points, point = points[ui.point]
  const writePoint = (change: Partial<typeof point>) => set(x => ({ ...x, mixer: { ...x.mixer, points: x.mixer.points.map((p, i) => i === ui.point ? { ...p, ...change } : p) } }))
  return <>
    <span className="segmented" title="HSL lists every color. Color edits one family. Point Color adjusts a color you pick.">{(['HSL', 'Color', 'Point Color'] as const).map(p => <button key={p} type="button" className={ui.mixerPage === p ? 'on' : ''} onClick={() => setUi({ mixerPage: p })}>{p}</button>)}</span>
    {ui.mixerPage === 'HSL' && <>
      <span className="segmented" title="Hue shifts the color, Saturation its strength, and Luminance its brightness.">{(['hue', 'saturation', 'luminance'] as const).map(t => <button key={t} type="button" className={ui.mixerTab === t ? 'on' : ''} onClick={() => setUi({ mixerTab: t })}>{t[0].toUpperCase() + t.slice(1)}</button>)}</span>
      {mixerNames.map((name, i) => <RawSlider key={name} label={name} value={s.mixer[ui.mixerTab][i]} min={-100} max={100} track={track(ui.mixerTab, i)} onChange={v => write(ui.mixerTab, i, v)} />)}
    </>}
    {ui.mixerPage === 'Color' && <>
      <div style={{ display: 'flex', gap: 6 }}>{mixerNames.map((name, i) => <button key={name} type="button" title={`Edit ${name}`} className={`swatch-dot ${ui.mixerColor === i ? 'on' : ''}`} style={{ background: hsb(mixerCenters[i], 0.85, 0.9) }} onClick={() => setUi({ mixerColor: i })} />)}</div>
      {(['hue', 'saturation', 'luminance'] as const).map(kind => <RawSlider key={kind} label={kind[0].toUpperCase() + kind.slice(1)} value={s.mixer[kind][ui.mixerColor]} min={-100} max={100} track={track(kind, ui.mixerColor)} onChange={v => write(kind, ui.mixerColor, v)} />)}
    </>}
    {ui.mixerPage === 'Point Color' && <>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <button type="button" className={`icon ${ui.tool === 'point' ? 'on' : ''}`} title="Click the picture to save a color. Up to eight colors." onClick={() => setUi({ tool: ui.tool === 'point' ? null : 'point' })}><Icon name="eyedropper" size={14} /></button>
        {points.map((p, i) => <button key={i} type="button" title="Select this picked color" className={`swatch-dot ${ui.point === i ? 'on' : ''}`} style={{ background: hsb(p.hue, p.saturation, p.luminance) }} onClick={() => setUi({ point: i })} />)}
        {point && <button type="button" title="Remove this picked color" onClick={() => { set(x => ({ ...x, mixer: { ...x.mixer, points: x.mixer.points.filter((_, i) => i !== ui.point) } })); setUi({ point: Math.max(0, ui.point - 1) }); if (view.visualize !== undefined) setView({ ...view, visualize: -1 }) }}>Remove</button>}
      </div>
      {ui.tool === 'point' && <span className="muted">Click the picture to save its color.</span>}
      {point && <>
        <RawSlider label="Hue Shift" value={point.hueShift} min={-100} max={100} track={tracks.hue(point.hue)} title="Shifts the picked color around the color wheel." onChange={hueShift => writePoint({ hueShift })} />
        <RawSlider label="Saturation Shift" value={point.saturationShift} min={-100} max={100} track={tracks.saturation(point.hue)} title="Makes the picked color stronger or quieter." onChange={saturationShift => writePoint({ saturationShift })} />
        <RawSlider label="Luminance Shift" value={point.luminanceShift} min={-100} max={100} track={tracks.luminance(point.hue)} title="Makes the picked color lighter or darker." onChange={luminanceShift => writePoint({ luminanceShift })} />
        <RawSlider label="Hue Range" value={point.hueRange} min={5} max={180} reset={30} title="How far in hue the adjustment reaches." onChange={hueRange => writePoint({ hueRange })} />
        <RawSlider label="Saturation Range" value={point.saturationRange} min={0.05} max={1} reset={0.4} digits={2} title="How far in saturation the adjustment reaches." onChange={saturationRange => writePoint({ saturationRange })} />
        <RawSlider label="Luminance Range" value={point.luminanceRange} min={0.05} max={1} reset={0.4} digits={2} title="How far in brightness the adjustment reaches." onChange={luminanceRange => writePoint({ luminanceRange })} />
        <label title="Dims the picture outside this color's range. It is not kept when you press OK."><input type="checkbox" checked={view.visualize === ui.point} onChange={e => setView({ ...view, visualize: e.target.checked ? ui.point : -1 })} /> Visualize Range</label>
      </>}
    </>}
    {ui.mixerPage !== 'Point Color' && <Targeted on={ui.tool === 'mixer'} onClick={() => setUi({ tool: ui.tool === 'mixer' ? null : 'mixer' })} title="Drag a color in the picture up or down. Nearby color families move together." />}
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

// What a layer's pixels hold at a point on the canvas: straight colors (0…1), or null outside or where it's clear.
function sample(image: Raster | null | undefined, layerId: string, point: [number, number]): [number, number, number] | null {
  const layer = store.layer(layerId)
  if (!layer || !image) return null
  const [x, y] = apply(invert(pixelToDocument(layer.transform, image.width, image.height)), ...point).map(Math.floor)
  if (x < 0 || y < 0 || x >= image.width || y >= image.height) return null
  const i = (y * image.width + x) * 4, a = image.data[i + 3]
  return a ? [0, 1, 2].map(c => Math.min(1, image.data[i + c] / a)) as [number, number, number] : null
}
const hueOf = ([r, g, b]: [number, number, number]) => { const max = Math.max(r, g, b), chroma = max - Math.min(r, g, b); if (chroma <= 1e-6) return 0; const h = (max === r ? (g - b) / chroma : max === g ? 2 + (b - r) / chroma : 4 + (r - g) / chroma) * 60; return h < 0 ? h + 360 : h }
// A point on the canvas as a fraction of the layer's grid from its lower left, as Upright's guides keep them.
function onGrid(layerId: string, image: Raster | null | undefined, point: [number, number]): [number, number] | null {
  const layer = store.layer(layerId)
  if (!layer || !image) return null
  const [x, y] = apply(invert(pixelToDocument(layer.transform, image.width, image.height)), ...point)
  return x < 0 || y < 0 || x > image.width || y > image.height ? null : [x / image.width, 1 - y / image.height]
}
const fromGrid = (layerId: string, image: Raster, x: number, y: number) => { const layer = store.layer(layerId)!; return stage.toScreen(...apply(pixelToDocument(layer.transform, image.width, image.height), x * image.width, (1 - y) * image.height)) }

// Camera Raw's adjustment column (CameraRawControls.swift): the histogram, then each section, opened by its heading, with an eye that
// leaves it out of the preview and OK, and a reset, both shown once it adjusts something.
export function CameraRawPanel({ params, set, layerId }: { params: CameraRawParams; set: (p: Partial<CameraRawParams>) => void; layerId: string }) {
  const s = params.settings, update: Set = change => set({ settings: change(params.settings) })
  const latest = useRef(params)
  latest.current = params
  const original = useMemo(() => store.layer(layerId)?.image ?? null, [])
  const [open, setOpen] = useState<CameraRawGroup[]>(['Light', 'Color', 'Color Grading'])
  const [ready, setReady] = useState(false), [failed, setFailed] = useState<string | null>(null)
  const [ui, setUiState] = useState<Ui>({ curvePage: 'Parametric', channel: 0, mixerPage: 'HSL', mixerTab: 'hue', mixerColor: 0, point: 0, tool: null })
  const uiRef = useRef(ui)
  uiRef.current = ui
  const setUi = (u: Partial<Ui>) => setUiState(old => ({ ...old, ...u }))
  const [readout, setReadout] = useState<number[] | null>(null)
  const setView = (view: CameraRawView) => set({ view })
  const showView = (kind: 1 | 2 | 'mask' | null) => {
    const v = latest.current.view, next = { ...v, clipping: typeof kind === 'number' ? kind : 0, sharpenMask: kind === 'mask' } as CameraRawView
    if (!!v.clipping !== !!next.clipping || v.clipping !== next.clipping || !!v.sharpenMask !== next.sharpenMask) set({ view: next })
  }
  useEffect(() => { loadCameraRawTables().then(() => setReady(true), e => setFailed((e as Error).message)) }, [])
  // Letting go of Option ends the clipping or sharpening-mask view.
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      optionHeld = event.altKey
      const v = latest.current.view
      if (!event.altKey && (v.clipping || v.sharpenMask)) set({ view: { ...v, clipping: 0, sharpenMask: false } })
    }
    window.addEventListener('keydown', key); window.addEventListener('keyup', key)
    return () => { window.removeEventListener('keydown', key); window.removeEventListener('keyup', key); optionHeld = false }
  }, [])
  // The color under the pointer, as the preview shows it.
  useEffect(() => {
    const move = (event: PointerEvent) => {
      const element = (event.target as Element | null)?.closest?.('.stage')
      if (!element) { setReadout(null); return }
      const box = element.getBoundingClientRect(), rgb = sample(store.layer(layerId)?.image, layerId, stage.toDocument(event.clientX - box.left, event.clientY - box.top))
      setReadout(rgb ? rgb.map(v => Math.round(v * 255)) : null)
    }
    window.addEventListener('pointermove', move)
    return () => window.removeEventListener('pointermove', move)
  }, [])
  // The tool on the canvas: eyedroppers take clicks, the targeted drag and guides take drags.
  useEffect(() => {
    const tool = ui.tool
    if (!tool) return
    const shown = () => store.layer(layerId)?.image
    if (tool === 'white' || tool === 'defringe' || tool === 'point') {
      canvasPicker.current = point => {
        const current = latest.current.settings
        if (tool === 'point') {
          const rgb = sample(shown(), layerId, point)
          if (!rgb) return
          const max = Math.max(...rgb), min = Math.min(...rgb), color = newPointColor(hueOf(rgb), max ? (max - min) / max : 0, (max + min) / 2)
          const points = current.mixer.points, index = uiRef.current.point
          if (points[index] && points.length >= 8) set({ settings: { ...current, mixer: { ...current.mixer, points: points.map((p, i) => i === index ? { ...color, hueShift: p.hueShift, saturationShift: p.saturationShift, luminanceShift: p.luminanceShift } : p) } } })
          else if (points.length < 8) { set({ settings: { ...current, mixer: { ...current.mixer, points: [...points, color] } } }); setUi({ point: points.length }) }
          return
        }
        const rgb = original && sample(original, layerId, point)
        if (!rgb) return
        if (tool === 'white') {
          const solved = neutralize(...rgb)
          if (solved) set({ settings: { ...current, whiteBalance: 'Custom', temperature: solved.temperature, tint: solved.tint } })
          return
        }
        const hue = hueOf(rgb), o = current.optics, purple = Math.abs(hue - 290) < Math.abs(hue - 90), clampHue = (v: number) => Math.min(360, Math.max(0, v))
        set({ settings: { ...current, optics: purple ? { ...o, purpleHueLow: clampHue(hue - 25), purpleHueHigh: clampHue(hue + 25), purpleAmount: o.purpleAmount || 50 } : { ...o, greenHueLow: clampHue(hue - 25), greenHueHigh: clampHue(hue + 25), greenAmount: o.greenAmount || 50 } } })
      }
      requestRender(false)
      return () => { canvasPicker.current = null; requestRender(false) }
    }
    // Targeted adjustment (EditorSession.dragCameraRaw): up raises what's under the pointer where the drag began, by 0.35 a point.
    let drag: { y: number; settings: CameraRawSettings; tone: number; hue: number } | null = null
    let draft: Guide | null = null
    canvasGesture.current = {
      down: (point, screen) => {
        if (tool === 'guides') { const at = onGrid(layerId, original, point); draft = at ? { startX: at[0], startY: at[1], endX: at[0], endY: at[1] } : null; return }
        const rgb = sample(shown(), layerId, point)
        drag = rgb ? { y: screen[1], settings: latest.current.settings, tone: 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2], hue: hueOf(rgb) } : null
      },
      move: point => {
        if (tool === 'guides') { const at = onGrid(layerId, original, point); if (draft && at) { draft = { ...draft, endX: at[0], endY: at[1] }; requestRender(false) } return }
        if (!drag) return
        const delta = (drag.y - stage.toScreen(...point)[1]) * 0.35, base = drag.settings, u = uiRef.current, clamp = (v: number) => Math.min(100, Math.max(-100, v))
        if (tool === 'curve') {
          const c = base.curve
          if (u.curvePage === 'Parametric') {
            const key = drag.tone < c.shadowSplit / 100 ? 'shadows' : drag.tone < c.darkSplit / 100 ? 'darks' : drag.tone < c.lightSplit / 100 ? 'lights' : 'highlights'
            set({ settings: { ...base, curve: { ...c, [key]: clamp(c[key] + delta) } } })
          } else {
            const key = channelKeys[u.channel], points = c[key], tone = drag.tone
            const index = points.reduce((best, p, i) => Math.abs(p.x - tone) < Math.abs(points[best].x - tone) ? i : best, 0)
            set({ settings: { ...base, curve: { ...c, [key]: points.map((p, i) => i === index ? { ...p, y: Math.min(1, Math.max(0, p.y + delta / 100)) } : p) } } })
          }
        } else {
          const weights = mixerCenters.map(center => { let d = Math.abs(drag!.hue - center); if (d > 180) d = 360 - d; return Math.max(0, 1 - d / 40) })
          const tab = u.mixerPage === 'HSL' ? u.mixerTab : 'hue'
          set({ settings: { ...base, mixer: { ...base.mixer, [tab]: base.mixer[tab].map((v, i) => weights[i] > 0 ? clamp(v + delta * weights[i]) : v) } } })
        }
      },
      up: () => {
        drag = null
        if (tool !== 'guides' || !draft) return
        const g = latest.current.settings.geometry, done = draft
        draft = null
        if (Math.hypot(done.endX - done.startX, done.endY - done.startY) > 0.01) set({ settings: { ...latest.current.settings, geometry: { ...g, upright: 'Guided', guides: [...g.guides, done] } } })
      },
      draw: c => {
        if (tool !== 'guides' || !original) return
        for (const guide of [...latest.current.settings.geometry.guides, ...(draft ? [draft] : [])]) {
          const [x0, y0] = fromGrid(layerId, original, guide.startX, guide.startY), [x1, y1] = fromGrid(layerId, original, guide.endX, guide.endY)
          c.beginPath(); c.moveTo(x0, y0); c.lineTo(x1, y1); c.strokeStyle = 'rgba(0,0,0,0.7)'; c.lineWidth = 3; c.stroke(); c.strokeStyle = '#ffd60a'; c.lineWidth = 1.5; c.stroke()
        }
      },
    }
    requestRender(false)
    return () => { canvasGesture.current = null; requestRender(false) }
  }, [ui.tool])
  useEffect(() => { if (ui.tool === 'guides') requestRender(false) }, [s.geometry.guides])
  const setWhiteBalance = (mode: 'Custom' | 'Auto') => {
    if (mode === 'Custom' || !original) { update(x => ({ ...x, whiteBalance: mode })); return }
    const solved = autoBalance(original)
    update(x => ({ ...x, whiteBalance: 'Auto', ...(solved ?? {}) }))
  }
  const toggle = (list: CameraRawGroup[], group: CameraRawGroup) => list.includes(group) ? list.filter(g => g !== group) : [...list, group]
  const pick = (tool: Tool) => setUi({ tool: ui.tool === tool ? null : tool })
  const num = (key: keyof CameraRawSettings) => s[key] as number
  const field = (label: string, key: keyof CameraRawSettings, min: number, max: number, extra: { reset?: number; digits?: number; track?: string[]; title?: string; disabled?: boolean; shows?: 1 | 2 } = {}) =>
    <RawSlider label={label} value={num(key)} min={min} max={max} {...extra} onChange={v => update(x => ({ ...x, [key]: v, ...(key === 'temperature' || key === 'tint' ? { whiteBalance: 'Custom' } : {}) }))} />
  const sub = <K extends 'detail' | 'optics' | 'geometry' | 'calibration'>(group: K, label: string, key: keyof CameraRawSettings[K], min: number, max: number, extra: { reset?: number; title?: string; disabled?: boolean; shows?: 'mask' } = {}) =>
    <RawSlider label={label} value={s[group][key] as number} min={min} max={max} {...extra} onChange={v => update(x => ({ ...x, [group]: { ...x[group], [key]: v } }))} />
  const check = <K extends 'optics' | 'geometry'>(group: K, label: string, key: keyof CameraRawSettings[K], title: string) =>
    <label title={title}><input type="checkbox" checked={!!s[group][key]} onChange={e => update(x => ({ ...x, [group]: { ...x[group], [key]: e.target.checked } }))} /> {label}</label>
  const section = (group: CameraRawGroup) => {
    switch (group) {
      case 'Light': return <>
        {field('Exposure', 'exposure', -5, 5, { digits: 2, shows: 1, title: 'Brightens or darkens the whole picture, in stops of light. Hold Option to see clipped highlights.' })}
        {field('Contrast', 'contrast', -100, 100, { title: 'Makes light and dark tones more or less different, mostly around the middle.' })}
        {field('Highlights', 'highlights', -100, 100, { shows: 1, title: 'Adjusts the bright parts of the picture. Hold Option to see clipped highlights.' })}
        {field('Shadows', 'shadows', -100, 100, { shows: 2, title: 'Adjusts the dark parts of the picture. Hold Option to see clipped shadows.' })}
        {field('Whites', 'whites', -100, 100, { shows: 1, title: 'Sets the brightest point. Hold Option to see clipped highlights.' })}
        {field('Blacks', 'blacks', -100, 100, { shows: 2, title: 'Sets the darkest point. Hold Option to see clipped shadows.' })}
      </>
      case 'Color': return <>
        <div className="row" title="Auto balances the average color. Custom follows Temperature and Tint."><span className="muted">White Balance</span><select value={s.whiteBalance} onChange={e => setWhiteBalance(e.target.value as 'Custom' | 'Auto')}><option>Custom</option><option>Auto</option></select>
          <button type="button" className={`icon ${ui.tool === 'white' ? 'on' : ''}`} title="White Balance Selector: click a pixel that should be neutral" onClick={() => pick('white')}><Icon name="eyedropper" size={14} /></button></div>
        {ui.tool === 'white' && <span className="muted">Click the layer where it should be neutral. Click the eyedropper again to stop.</span>}
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
      case 'Curve': return <CurveControls s={s} set={update} ui={ui} setUi={setUi} />
      case 'Color Mixer': return <MixerControls s={s} set={update} ui={ui} setUi={setUi} view={params.view} setView={setView} />
      case 'Detail': return <>
        <Heading>Sharpening</Heading>
        {sub('detail', 'Amount', 'sharpenAmount', 0, 150, { title: 'Controls how strong the sharpening is.' })}
        {sub('detail', 'Radius', 'sharpenRadius', 0, 100, { reset: 10, title: 'How far from each edge the sharpening reaches, in pixels.' })}
        {sub('detail', 'Detail', 'sharpenDetail', 0, 100, { reset: 25, title: 'Emphasizes fine texture over broader edges.' })}
        {sub('detail', 'Masking', 'sharpenMasking', 0, 100, { shows: 'mask', title: 'Limits sharpening to stronger edges. Hold Option to see the mask.' })}
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
        <div className="row" title="Click a purple or green fringe to set its hue range."><span className="muted">Defringe</span><button type="button" className={`icon ${ui.tool === 'defringe' ? 'on' : ''}`} style={{ justifySelf: 'start' }} title="Defringe Selector: click a purple or green fringe" onClick={() => pick('defringe')}><Icon name="eyedropper" size={14} /></button><span /></div>
        {ui.tool === 'defringe' && <span className="muted">Click the fringe on the layer. Click the eyedropper again to stop.</span>}
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
        <div className="row" title="Off leaves the picture as it is. Guided straightens from lines you draw on the picture."><span className="muted">Upright</span><span className="segmented">{(['Off', 'Guided'] as const).map(mode => <button key={mode} type="button" className={s.geometry.upright === mode ? 'on' : ''} onClick={() => { update(x => ({ ...x, geometry: { ...x.geometry, upright: mode } })); if (mode === 'Off' && ui.tool === 'guides') setUi({ tool: null }) }}>{mode}</button>)}</span><span /></div>
        {s.geometry.upright === 'Guided' && <div style={{ display: 'flex', gap: 6 }}>
          <button type="button" className={ui.tool === 'guides' ? 'primary' : ''} title="Draw two or more lines on the preview that should be level or vertical." onClick={() => pick('guides')}>Draw Guides</button>
          {s.geometry.guides.length > 0 && <button type="button" title="Remove every guide line" onClick={() => update(x => ({ ...x, geometry: { ...x.geometry, guides: [] } }))}>Clear Guides</button>}
        </div>}
        {ui.tool === 'guides' && <span className="muted">Drag on the layer to place a guide. Draw at least two lines.</span>}
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
    <ShowView.Provider value={showView}>
      <div className="camera-raw">
        <Histogram layerId={layerId} view={params.view} setView={setView} />
        <span className="muted readout" title="Red, green, and blue of the pixel under the pointer">{readout ? `R ${readout[0]}   G ${readout[1]}   B ${readout[2]}` : 'R —   G —   B —'}</span>
        {failed && <span style={{ color: '#ffb35c' }}>{failed}</span>}
        {!ready && !failed && <span className="muted">Loading Camera Raw’s color tables…</span>}
        <div className="raw-sections">
          {cameraRawGroups.map(group => {
            const edited = adjusts(s, group), shown = !params.hidden.includes(group), expanded = open.includes(group)
            return <div key={group} className="raw-section">
              <div className="raw-heading">
                <button type="button" className="disclosure" onClick={() => setOpen(toggle(open, group))}>{expanded ? '▾' : '▸'} {group}</button>
                {edited && <button type="button" className={`icon eye ${shown ? '' : 'off'}`} title={shown ? `Hide ${group} in the preview` : `Show ${group} in the preview`} onClick={() => set({ hidden: toggle(params.hidden, group) })}><Icon name={shown ? 'eye' : 'eyeOff'} size={14} /></button>}
                {edited && <button type="button" className="icon" title={`Reset ${group} to its defaults`} onClick={() => set({ settings: resetGroup(s, group), hidden: params.hidden.filter(g => g !== group) })}>↺</button>}
              </div>
              {expanded && <div className="raw-controls">{section(group)}</div>}
            </div>
          })}
        </div>
      </div>
    </ShowView.Provider>
  )
}
