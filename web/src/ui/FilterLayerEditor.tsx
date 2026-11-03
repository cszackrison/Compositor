import { useEffect, useRef } from 'react'
import { Slider } from './Inspector'
import { ColorSwatch } from './ColorPicker'
import { ProgressiveLine } from './Filters'
import { LensControls } from './LensControls'
import { canvasGesture, requestRender, view } from './canvasState'
import { type AdjustmentKind, type FilterLayerSettings, type Point, defaultFilterLayer, defaultReduceNoiseLayer, defaultSharpenLayer, defaultTonalLayer, defaultVignetteLayer } from '../model/types'

// The settings of the filters that can also be adjustment layers (FilterSheet.swift), on FilterLayerSettings: the Inspector edits a
// layer's with them and the Filter menu's Sharpen, Reduce Noise, RGB Split and Lens Effects their own.
export function FilterLayerControls({ kind, settings, onChange }: { kind: AdjustmentKind; settings: FilterLayerSettings | undefined; onChange: (s: FilterLayerSettings) => void }) {
  const f = { ...defaultFilterLayer(), ...settings }, set = (changes: Partial<FilterLayerSettings>) => onChange({ ...f, ...changes })
  switch (kind) {
    case 'Progressive Blur': return <>
      {f.progressiveStart && f.progressiveEnd && <ProgressiveLine settings={{ start: f.progressiveStart, end: f.progressiveEnd, radial: f.progressiveRadial }} set={c => set({ ...(c.start ? { progressiveStart: c.start } : {}), ...(c.end ? { progressiveEnd: c.end } : {}) })} />}
      <span className="muted">Click and drag two points on the canvas.</span>
      <Segmented label="Shape" options={['Linear', 'Radial']} value={f.progressiveRadial ? 'Radial' : 'Linear'} title="Linear blurs along the line; Radial keeps the start sharp and blurs outwards" onChange={v => set({ progressiveRadial: v === 'Radial' })} />
      <Slider label="From" value={f.progressiveFrom} min={0} max={250} digits={1} onChange={progressiveFrom => set({ progressiveFrom })} />
      <Slider label="To" value={f.progressiveTo} min={0} max={250} digits={1} onChange={progressiveTo => set({ progressiveTo })} />
      <label title="Swap From and To: blur the start and sharpen toward the end"><input type="checkbox" checked={f.progressiveInverted} onChange={e => set({ progressiveInverted: e.target.checked })} /> Invert</label>
    </>
    case 'Bloom / Glow': return <>
      <Slider label="Amount" value={f.bloomAmount} min={0} max={100} onChange={bloomAmount => set({ bloomAmount })} />
      <Slider label="Radius" value={f.bloomRadius} min={1} max={150} log onChange={bloomRadius => set({ bloomRadius })} />
    </>
    case 'RGB Split': return <>
      <Segmented label="Shape" options={['Linear', 'Radial']} value={f.rgbSplitRadial ? 'Radial' : 'Linear'} title="Linear splits along one direction; Radial splits outwards from a center, sharp there" onChange={v => set({ rgbSplitRadial: v === 'Radial' })} />
      {f.rgbSplitRadial && <><CenterPicker center={f.rgbSplitCenter} onChange={rgbSplitCenter => set({ rgbSplitCenter })} /><span className="muted">Click or drag on the canvas to move the center</span></>}
      <Slider label="Distance" value={f.rgbSplitDistance} min={0} max={200} suffix="px" onChange={rgbSplitDistance => set({ rgbSplitDistance })} />
      <Slider label="Blur" value={f.rgbSplitBlur} min={0} max={400} suffix="px" onChange={rgbSplitBlur => set({ rgbSplitBlur })} />
      {!f.rgbSplitRadial && <Slider label="Angle" value={f.rgbSplitAngle} min={-180} max={180} suffix="°" onChange={rgbSplitAngle => set({ rgbSplitAngle })} />}
    </>
    case 'Vignette': {
      const v = { ...defaultVignetteLayer(), ...f.vignette }, write = (c: Partial<typeof v>) => set({ vignette: { ...v, ...c } })
      return <>
        <div className="row"><span className="muted">Color</span><ColorSwatch title="Vignette Color" value={[v.color.red, v.color.green, v.color.blue].map(c => Math.round(c * 255)) as [number, number, number]} onChange={c => write({ color: { red: c[0] / 255, green: c[1] / 255, blue: c[2] / 255 } })} /><span /></div>
        <Slider label="Amount" value={v.amount} min={0} max={100} onChange={amount => write({ amount })} />
        <Slider label="Midpoint" value={v.midpoint} min={0} max={100} onChange={midpoint => write({ midpoint })} />
        <Slider label="Roundness" value={v.roundness} min={-100} max={100} onChange={roundness => write({ roundness })} />
        <Slider label="Feather" value={v.feather} min={0} max={100} onChange={feather => write({ feather })} />
        <Slider label="Highlights" value={v.highlights} min={0} max={100} onChange={highlights => write({ highlights })} />
      </>
    }
    case 'Tonal Contrast': {
      const t = { ...defaultTonalLayer(), ...f.tonal }, write = (c: Partial<typeof t>) => set({ tonal: { ...t, ...c } })
      return <>
        <Slider label="Amount" value={t.amount} min={0} max={100} onChange={amount => write({ amount })} />
        <Slider label="Shadows" value={t.shadows} min={-100} max={100} onChange={shadows => write({ shadows })} />
        <Slider label="Midtones" value={t.midtones} min={-100} max={100} onChange={midtones => write({ midtones })} />
        <Slider label="Highlights" value={t.highlights} min={-100} max={100} onChange={highlights => write({ highlights })} />
        <Slider label="Radius" value={t.radius} min={1} max={100} log onChange={radius => write({ radius })} />
      </>
    }
    case 'Sharpen': {
      const s = { ...defaultSharpenLayer(), ...f.sharpen }, write = (c: Partial<typeof s>) => set({ sharpen: { ...s, ...c } })
      return <>
        <Slider label="Amount" value={s.amount} min={0} max={300} suffix="%" onChange={amount => write({ amount })} />
        <Slider label="Radius" value={s.radius} min={0.1} max={20} digits={1} log suffix="px" onChange={radius => write({ radius })} />
      </>
    }
    case 'Reduce Noise': {
      const r = { ...defaultReduceNoiseLayer(), ...f.reduceNoise }, write = (c: Partial<typeof r>) => set({ reduceNoise: { ...r, ...c } })
      return <>
        <Slider label="Strength" value={r.strength} min={0} max={100} suffix="%" onChange={strength => write({ strength })} />
        <Slider label="Preserve Details" value={r.details} min={0} max={100} suffix="%" onChange={details => write({ details })} />
        <Slider label="Color Noise" value={r.color} min={0} max={100} suffix="%" onChange={color => write({ color })} />
      </>
    }
    case 'Lens Effects': return <LensControls settings={f.lens ?? {}} onChange={lens => set({ lens })} />
    default: return null
  }
}

export function Segmented({ label, options, value, title, onChange }: { label: string; options: string[]; value: string; title?: string; onChange: (v: string) => void }) {
  return <div className="row"><span className="muted">{label}</span><span className="segmented" title={title}>{options.map(o => <button key={o} type="button" className={o === value ? 'on' : ''} onClick={() => onChange(o)}>{o}</button>)}</span><span /></div>
}

// A point on the canvas, moved by clicking or dragging there: RGB Split's Radial center, drawn as a crosshair.
export function CenterPicker({ center, onChange }: { center: Point | undefined; onChange: (p: Point) => void }) {
  const latest = useRef({ center, onChange })
  latest.current = { center, onChange }
  useEffect(() => {
    let dragging = false
    canvasGesture.current = {
      down: point => { dragging = true; latest.current.onChange(point) },
      move: point => { if (dragging) latest.current.onChange(point) },
      up: () => { dragging = false },
      draw: c => {
        const p = latest.current.center
        if (!p) return
        const [x, y] = view.toScreen(...p)
        for (const [style, width] of [['rgba(0,0,0,0.7)', 3], ['#fff', 1]] as const) {
          c.beginPath(); c.moveTo(x - 10, y); c.lineTo(x + 10, y); c.moveTo(x, y - 10); c.lineTo(x, y + 10); c.strokeStyle = style; c.lineWidth = width; c.stroke()
          c.beginPath(); c.arc(x, y, 6, 0, Math.PI * 2); c.stroke()
        }
      },
    }
    requestRender(false)
    return () => { canvasGesture.current = null; requestRender(false) }
  }, [])
  useEffect(() => { requestRender(false) }, [center])
  return null
}
