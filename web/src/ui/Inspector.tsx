import { useEffect, useMemo, useRef, useState } from 'react'
import { useEditor } from './hooks'
import { Store, store } from '../editor/store'
import { drawOrder } from '../render/compositor'
import { LevelsTools } from './Filters'
import { ColorSwatch } from './ColorPicker'
import { canvasDrag, canvasPicker } from './canvasState'
import { centered, exclude, handleDegrees, include, rangeAt, shiftedHue, toHSB, withHandle } from '../model/hueBands'
import { isMac } from '../editor/shortcuts'
import { type Adjustment, type ColorRange, type HueSaturationSettings, type CurvePoint, identityCurve, type EffectKind, type RGB, colorRanges, effectNames, defaultBands } from '../model/types'
import { curveValue } from '../model/adjustments'

export function defaultEffect(kind: EffectKind): any {
  const black = { red: 0, green: 0, blue: 0 }, white = { red: 1, green: 1, blue: 1 }
  return { stroke: { size: 4, ...black, opacity: 1, inside: false }, shadow: { angle: 90, distance: 20, blur: 20, ...black, opacity: 0.5 }, colorOverlay: { ...black, opacity: 1 }, innerShadow: { angle: 90, distance: 10, blur: 10, ...black, opacity: 0.5 }, outerGlow: { size: 20, ...white, opacity: 0.75 }, innerGlow: { size: 10, ...white, opacity: 0.75 } }[kind]
}

// A label you can drag sideways to change its number, as in Photoshop: the value moves by `sensitivity` per point dragged.
export function Scrub({ label, value, min, max, step = 0, sensitivity = 1, onChange }: { label: string; value: number; min: number; max: number; step?: number; sensitivity?: number; onChange: (value: number) => void }) {
  const start = useRef<{ x: number; value: number } | null>(null)
  return (
    <span className="muted scrub" onPointerDown={e => { (e.target as Element).setPointerCapture(e.pointerId); start.current = { x: e.clientX, value } }}
      onPointerMove={e => {
        if (!start.current) return
        let next = start.current.value + (e.clientX - start.current.x) * sensitivity
        if (step > 0) next = Math.round(next / step) * step
        onChange(Math.min(max, Math.max(min, next)))
      }}
      onPointerUp={() => { start.current = null }}>{label}</span>
  )
}

export function Slider({ label, value, min, max, step, onChange, digits = 0, log = false, sensitivity, fieldMax, suffix }: { label: string; value: number; min: number; max: number; step?: number; digits?: number; log?: boolean; sensitivity?: number; fieldMax?: number; suffix?: string; onChange: (value: number) => void }) {
  step ??= Math.pow(10, -digits)
  // The slider covers the usual range; the number field (and scrubbing) may go further, up to `fieldMax`.
  const limit = fieldMax ?? max
  const clamp = (v: number) => Math.min(limit, Math.max(min, v))
  const round = (v: number) => +clamp(v).toFixed(digits)
  return (
    <div className="row">
      <Scrub label={label} value={value} min={min} max={limit} step={Math.pow(10, -digits)} sensitivity={sensitivity ?? Math.pow(10, -digits)} onChange={v => onChange(round(v))} />
      {log
        ? <input type="range" min={Math.log(min)} max={Math.log(max)} step={0.001} value={Math.log(Math.max(min, value))} onChange={e => onChange(round(Math.exp(+e.target.value)))} />
        : <input type="range" min={min} max={max} step={step} value={value} onChange={e => onChange(+e.target.value)} onDoubleClick={() => onChange(clamp(0))} />}
      <input type="number" min={min} max={limit} step={step} value={+value.toFixed(digits)} title={suffix} onChange={e => Number.isFinite(+e.target.value) && onChange(clamp(+e.target.value))} />
    </div>
  )
}


function ColorField({ label, value, onChange }: { label: string; value: RGB; onChange: (c: RGB) => void }) {
  return <div className="row"><span className="muted">{label}</span><ColorSwatch title={`Gradient Map ${label}`} value={[value.red, value.green, value.blue].map(v => Math.round(v * 255)) as [number, number, number]} onChange={c => onChange({ red: c[0] / 255, green: c[1] / 255, blue: c[2] / 255 })} /><span /></div>
}

const channelNames = ['RGB', 'Red', 'Green', 'Blue'] as const
const channelColors = ['#ddd', '#ff5d5d', '#5dde6a', '#5d9bff']

// CurvesControls: press within 14 units of a point to grab it, or add one (up to 32, not within 1 of another); interior points stay
// between their neighbors, the end points move only up and down.
function CurvesEditor({ adjustment, onChange }: { adjustment: Adjustment; onChange: (a: Adjustment) => void }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const channel = channelNames.indexOf(adjustment.curves.channel)
  const points = adjustment.curves.channels[channel]
  const [selected, setSelected] = useState<number | null>(null)
  const [hover, setHover] = useState<CurvePoint | null>(null)
  const drag = useRef<number | null>(null)
  useEffect(() => {
    const canvas = ref.current!, dpr = window.devicePixelRatio || 1, size = canvas.clientWidth
    canvas.width = canvas.height = size * dpr
    const c = canvas.getContext('2d')!
    c.setTransform(dpr * size / 256, 0, 0, dpr * size / 256, 0, 0)
    c.clearRect(0, 0, 256, 256)
    c.strokeStyle = '#333'; c.lineWidth = 0.6
    for (let i = 64; i < 256; i += 64) { c.beginPath(); c.moveTo(i, 0); c.lineTo(i, 256); c.moveTo(0, i); c.lineTo(256, i); c.stroke() }
    c.beginPath(); c.moveTo(0, 256); c.lineTo(256, 0); c.strokeStyle = '#444'; c.stroke()
    adjustment.curves.channels.forEach((list, index) => {
      if (index !== channel && list.length === 2 && list[0].y === 0 && list[1].y === 255) return
      c.beginPath()
      for (let x = 0; x <= 255; x++) { const y = 255 - curveValue(list, x); if (x) c.lineTo(x + 0.5, y + 0.5); else c.moveTo(x + 0.5, y + 0.5) }
      c.strokeStyle = index === channel ? '#fff' : channelColors[index]; c.globalAlpha = index === channel ? 1 : 0.35; c.lineWidth = index === channel ? 2 : 1.2; c.stroke(); c.globalAlpha = 1
    })
    points.forEach((p, i) => { c.beginPath(); c.arc(p.x, 255 - p.y, 4, 0, Math.PI * 2); c.fillStyle = i === selected ? '#3d8bfd' : '#fff'; c.fill() })
  }, [adjustment, channel, points, selected])
  const at = (event: React.PointerEvent): CurvePoint => {
    const box = ref.current!.getBoundingClientRect()
    return { x: Math.round(Math.min(255, Math.max(0, (event.clientX - box.left) / box.width * 255))), y: Math.round(Math.min(255, Math.max(0, 255 - (event.clientY - box.top) / box.height * 255))) }
  }
  const write = (list: CurvePoint[]) => onChange({ ...adjustment, curves: { ...adjustment.curves, channels: adjustment.curves.channels.map((l, i) => i === channel ? list : l) } })
  const readout = selected !== null && points[selected] ? points[selected] : hover
  return <>
    <canvas ref={ref} className="curves-editor"
      onPointerDown={e => {
        (e.target as Element).setPointerCapture(e.pointerId)
        const p = at(e)
        let index = -1, best = 14
        points.forEach((q, i) => { const d = Math.hypot(q.x - p.x, q.y - p.y); if (d <= best) { best = d; index = i } })
        if (index < 0 && points.length < 32 && p.x > 1 && p.x < 254 && points.every(q => Math.abs(q.x - p.x) > 1)) {
          const list = [...points, p].sort((a, b) => a.x - b.x)
          index = list.indexOf(p)
          write(list)
        }
        drag.current = index >= 0 ? index : null
        setSelected(index >= 0 ? index : null)
      }}
      onPointerMove={e => {
        const p = at(e)
        setHover(p)
        const index = drag.current
        if (index === null) return
        const list = [...points], last = list.length - 1
        const x = index === 0 ? 0 : index === last ? 255 : Math.min(list[index + 1].x - 1, Math.max(list[index - 1].x + 1, p.x))
        list[index] = { x, y: p.y }
        write(list)
      }}
      onPointerUp={() => { drag.current = null }} onPointerLeave={() => setHover(null)} />
    <span className="muted">{readout ? `Input ${readout.x} · Output ${readout.y}` : 'Click to add a point. Drag to adjust.'}</span>
    <div style={{ display: 'flex', gap: 6 }}>
      <button type="button" disabled={selected === null || selected === 0 || selected === points.length - 1} onClick={() => { if (selected === null) return; write(points.filter((_, i) => i !== selected)); setSelected(null) }}>Remove Point</button>
      <button type="button" onClick={() => { write(identityCurve()); setSelected(null) }}>Reset Curve</button>
    </div>
  </>
}

export function AdjustmentEditor({ adjustment, onChange }: { adjustment: Adjustment; onChange: (a: Adjustment) => void }) {
  const set = (changes: Partial<Adjustment>) => onChange({ ...adjustment, ...changes })
  switch (adjustment.kind) {
    case 'Levels': {
      const channel = channelNames.indexOf(adjustment.levels.channel), range = adjustment.levels.ranges[channel]
      const write = (changes: Partial<typeof range>) => {
        const next = { ...range, ...changes }
        next.black = Math.min(next.black, 254); next.white = Math.max(next.white, next.black + 1)
        set({ levels: { ...adjustment.levels, ranges: adjustment.levels.ranges.map((r, i) => i === channel ? next : r) } })
      }
      return <>
        <select value={adjustment.levels.channel} onChange={e => set({ levels: { ...adjustment.levels, channel: e.target.value as any } })}>{channelNames.map(n => <option key={n}>{n}</option>)}</select>
        <Slider label="Black" value={range.black} min={0} max={254} onChange={black => write({ black })} />
        <Slider label="Gamma" value={range.gamma} min={0.1} max={9.99} step={0.01} digits={2} onChange={gamma => write({ gamma })} />
        <Slider label="White" value={range.white} min={1} max={255} onChange={white => write({ white })} />
        <Slider label="Output black" value={range.outputBlack} min={0} max={255} onChange={outputBlack => write({ outputBlack })} />
        <Slider label="Output white" value={range.outputWhite} min={0} max={255} onChange={outputWhite => write({ outputWhite })} />
      </>
    }
    case 'Curves':
      return <>
        <select value={adjustment.curves.channel} onChange={e => set({ curves: { ...adjustment.curves, channel: e.target.value as any } })}>{channelNames.map(n => <option key={n}>{n}</option>)}</select>
        <CurvesEditor adjustment={adjustment} onChange={onChange} />
      </>
    case 'Hue/Saturation': {
      const settings = adjustment.hsvSettings ?? { range: 'Master' as ColorRange, colorize: adjustment.colorize, invertRange: false, adjustments: { Master: { hue: adjustment.hue, saturation: adjustment.saturation, lightness: adjustment.lightness } }, bands: { ...defaultBands } }
      const current = settings.adjustments[settings.range] ?? { hue: 0, saturation: 0, lightness: 0 }
      const write = (changes: Partial<typeof current>) => set({ hsvSettings: { ...settings, adjustments: { ...settings.adjustments, [settings.range]: { ...current, ...changes } } } })
      return <>
        <select value={settings.range} onChange={e => set({ hsvSettings: { ...settings, range: e.target.value as ColorRange } })}>{colorRanges.map(r => <option key={r}>{r}</option>)}</select>
        <Slider label="Hue" value={current.hue} min={settings.colorize ? 0 : -180} max={settings.colorize ? 360 : 180} onChange={hue => write({ hue })} />
        <Slider label="Saturation" value={current.saturation} min={settings.colorize ? 0 : -100} max={100} onChange={saturation => write({ saturation })} />
        <Slider label="Lightness" value={current.lightness} min={-100} max={100} onChange={lightness => write({ lightness })} />
        {!settings.colorize && <HueSaturationTools settings={settings} onChange={hsvSettings => set({ hsvSettings })} />}
        <label><input type="checkbox" checked={settings.colorize} onChange={e => set({ hsvSettings: { range: 'Master', colorize: e.target.checked, invertRange: false, bands: { ...defaultBands }, adjustments: { Master: e.target.checked ? { hue: 0, saturation: 25, lightness: 0 } : { hue: 0, saturation: 0, lightness: 0 } } } })} /> Colorize</label>
      </>
    }
    case 'Exposure': {
      const s = adjustment.exposureSettings ?? { exposure: 0, offset: 0, gamma: 1 }
      return <>
        <Slider label="Exposure" value={s.exposure} min={-20} max={20} step={0.01} digits={2} onChange={exposure => set({ exposureSettings: { ...s, exposure } })} />
        <Slider label="Offset" value={s.offset} min={-0.5} max={0.5} step={0.001} digits={3} onChange={offset => set({ exposureSettings: { ...s, offset } })} />
        <Slider label="Gamma" value={s.gamma} min={0.01} max={9.99} step={0.01} digits={2} onChange={gamma => set({ exposureSettings: { ...s, gamma } })} />
      </>
    }
    case 'Gradient Map': {
      const s = adjustment.gradientMapSettings!
      return <>
        <ColorField label="Shadows" value={s.shadows} onChange={shadows => set({ gradientMapSettings: { ...s, shadows } })} />
        <ColorField label="Highlights" value={s.highlights} onChange={highlights => set({ gradientMapSettings: { ...s, highlights } })} />
        <label><input type="checkbox" checked={s.reversed} onChange={e => set({ gradientMapSettings: { ...s, reversed: e.target.checked } })} /> Reverse</label>
      </>
    }
    case 'Grain': {
      const s = adjustment.grainSettings!
      return <>
        <Slider label="Amount" value={s.amount} min={0} max={100} onChange={amount => set({ grainSettings: { ...s, amount } })} />
        <Slider label="Size" value={s.size} min={0.5} max={20} step={0.1} digits={1} onChange={size => set({ grainSettings: { ...s, size } })} />
        <Slider label="Roughness" value={s.roughness} min={0} max={100} onChange={roughness => set({ grainSettings: { ...s, roughness } })} />
        <button onClick={() => set({ grainSettings: { ...s, seed: Math.floor(Math.random() * 2 ** 32) } })}>New Pattern</button>
      </>
    }
    case 'Black & White': {
      const s = adjustment.blackWhiteSettings!
      const keys = ['reds', 'yellows', 'greens', 'cyans', 'blues', 'magentas'] as const
      return <>
        {keys.map(key => <Slider key={key} label={key[0].toUpperCase() + key.slice(1)} value={s[key]} min={-200} max={300} onChange={v => set({ blackWhiteSettings: { ...s, [key]: v } })} />)}
        <label><input type="checkbox" checked={s.tint} onChange={e => set({ blackWhiteSettings: { ...s, tint: e.target.checked } })} /> Tint</label>
        {s.tint && <><Slider label="Hue" value={s.tintHue} min={0} max={360} onChange={tintHue => set({ blackWhiteSettings: { ...s, tintHue } })} /><Slider label="Saturation" value={s.tintSaturation} min={0} max={100} onChange={tintSaturation => set({ blackWhiteSettings: { ...s, tintSaturation } })} /></>}
      </>
    }
    case 'Color Balance': return <ColorBalanceEditor adjustment={adjustment} onChange={onChange} />
    case 'Gaussian Blur': return <Slider label="Radius" value={adjustment.blurRadius ?? 10} min={0.1} max={250} step={0.1} digits={1} onChange={blurRadius => set({ blurRadius })} />
    case 'Motion Blur': return <>
      <Slider label="Angle" value={adjustment.motionAngle ?? 0} min={-90} max={90} onChange={motionAngle => set({ motionAngle })} />
      <Slider label="Distance" value={adjustment.motionDistance ?? 10} min={1} max={2000} onChange={motionDistance => set({ motionDistance })} />
    </>
    case 'Add Noise': return <>
      <Slider label="Amount" value={adjustment.noiseAmount ?? 10} min={0.1} max={400} step={0.1} digits={1} onChange={noiseAmount => set({ noiseAmount })} />
      <label><input type="checkbox" checked={!!adjustment.noiseGaussian} onChange={e => set({ noiseGaussian: e.target.checked })} /> Gaussian</label>
      <label><input type="checkbox" checked={!!adjustment.noiseMonochromatic} onChange={e => set({ noiseMonochromatic: e.target.checked })} /> Monochromatic</label>
    </>
    case 'Invert': return <span className="muted">Inverts every color below.</span>
  }
}

function ColorBalanceEditor({ adjustment, onChange }: { adjustment: Adjustment; onChange: (a: Adjustment) => void }) {
  const [tone, setTone] = useState<'shadow' | 'mid' | 'highlight'>('mid')
  const s = adjustment.colorBalanceSettings!
  const write = (key: string, v: number) => onChange({ ...adjustment, colorBalanceSettings: { ...s, [key]: v } })
  return <>
    <select value={tone} onChange={e => setTone(e.target.value as any)}><option value="shadow">Shadows</option><option value="mid">Midtones</option><option value="highlight">Highlights</option></select>
    <Slider label="Cyan · Red" value={(s as any)[`${tone}CyanRed`]} min={-100} max={100} onChange={v => write(`${tone}CyanRed`, v)} />
    <Slider label="Magenta · Green" value={(s as any)[`${tone}MagentaGreen`]} min={-100} max={100} onChange={v => write(`${tone}MagentaGreen`, v)} />
    <Slider label="Yellow · Blue" value={(s as any)[`${tone}YellowBlue`]} min={-100} max={100} onChange={v => write(`${tone}YellowBlue`, v)} />
    <label><input type="checkbox" checked={s.preserveLuminosity} onChange={e => onChange({ ...adjustment, colorBalanceSettings: { ...s, preserveLuminosity: e.target.checked } })} /> Preserve luminosity</label>
  </>
}

// One layer effect in its own floating panel (EffectsSheet.swift): every change applies live as an "Edit {Kind}" step, Cancel puts
// the effect back as it was when the panel opened (or removes it if it was just added), OK keeps it.
export function EffectPanel() {
  const state = useEditor()
  const picked = state.effectSelection
  const layer = store.layer(picked?.layerId)
  const effect: any = picked && layer?.effects?.[picked.kind]
  const closePanel = () => store.set({ panel: null })
  const cancel = () => {
    if (picked && layer) {
      if (picked.isNew) store.removeEffect(layer.id, picked.kind, `Cancel ${effectNames[picked.kind]}`)
      else if (picked.before) store.updateLayer(layer.id, { effects: { ...layer.effects, [picked.kind]: picked.before } }, `Cancel ${effectNames[picked.kind]}`)
    }
    closePanel()
  }
  const latest = useRef(cancel)
  latest.current = cancel
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); latest.current() } else if (e.key === 'Enter' && !(e.target instanceof HTMLInputElement)) { e.preventDefault(); closePanel() } }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [])
  useEffect(() => { if (picked && layer && !picked.before && !picked.isNew && effect) store.set({ effectSelection: { ...picked, before: effect } }) }, [])
  if (!picked || !layer || !effect) return null
  const kind = picked.kind as EffectKind
  const write = (changes: object) => store.updateLayer(layer.id, { effects: { ...layer.effects, [kind]: { ...effect, ...changes } } }, `Edit ${effectNames[kind]}`, `effect-${kind}`)
  const opacity = <Slider label="Opacity" value={Math.round(effect.opacity * 100)} min={0} max={100} onChange={v => write({ opacity: v / 100 })} />
  return (
    <div className="modal-back filter-back">
      <form noValidate className="modal filter" onSubmit={e => { e.preventDefault(); closePanel() }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <h2 style={{ flex: 1 }}>{effectNames[kind]}</h2>
          {kind === 'stroke' && <span style={{ display: 'inline-flex', gap: 2 }}>{(['Outside', 'Inside'] as const).map(o => <button key={o} type="button" className={`icon ${(o === 'Inside') === effect.inside ? 'on' : ''}`} onClick={() => write({ inside: o === 'Inside' })}>{o}</button>)}</span>}
          <ColorSwatch title={`${effectNames[kind]} Color`} value={[effect.red, effect.green, effect.blue].map((v: number) => Math.round(v * 255)) as [number, number, number]} onChange={c => write({ red: c[0] / 255, green: c[1] / 255, blue: c[2] / 255 })} />
        </div>
        {'size' in effect && <Slider label="Size" value={effect.size} min={0} max={kind === 'stroke' ? 20 : 100} fieldMax={500} onChange={size => write({ size })} />}
        {opacity}
        {'angle' in effect && <Slider label="Angle" value={effect.angle} min={-180} max={180} onChange={angle => write({ angle })} />}
        {'distance' in effect && <Slider label="Distance" value={effect.distance} min={0} max={kind === 'shadow' ? 100 : 50} fieldMax={5000} onChange={distance => write({ distance })} />}
        {'blur' in effect && <Slider label="Blur" value={effect.blur} min={0} max={100} fieldMax={500} onChange={blur => write({ blur })} />}
        <div className="buttons"><button type="button" onClick={cancel}>Cancel</button><button type="submit" className="primary">OK</button></div>
      </form>
    </div>
  )
}

export function Inspector() {
  const state = useEditor()
  const layer = store.layer(state.inspector)
  if (!layer?.adjustment) return null
  return (
    <section className="inspector">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h3>{layer.adjustment.kind}</h3>
        <button className="icon" title="Close" onClick={() => store.set({ inspector: null })}>✕</button>
      </div>
      {<AdjustmentEditor adjustment={layer.adjustment} onChange={a => store.setAdjustment(layer.id, a)} />}
      {layer.adjustment?.kind === 'Levels' && <UnderlyingLevels layerId={layer.id} />}
    </section>
  )
}

// Levels on an adjustment layer reads its histogram, and its eyedroppers, from everything drawn below it ("Underlying pixels").
function UnderlyingLevels({ layerId }: { layerId: string }) {
  const layer = store.layer(layerId)!
  const below = useMemo(() => {
    const order = drawOrder(store.doc).map(e => e.layer.id)
    const hidden = new Set(order.slice(order.indexOf(layerId)))
    return Store.renderer?.({ ...store.doc, layers: store.doc.layers.map(l => hidden.has(l.id) && !l.isGroup ? { ...l, visible: false } : l) }) ?? null
  }, [layerId, store.state.pixelRevision])
  if (!below || !layer.adjustment) return null
  return <><LevelsTools source={below} toSource={p => p} adjustment={layer.adjustment} onChange={a => store.setAdjustment(layerId, a)} /><span className="muted">Underlying pixels · alpha-weighted histogram</span></>
}

// The Hue/Saturation extras (HueSaturationSheet.swift): eyedroppers that fit the selected color range to a clicked color, the
// targeted-adjustment hand (press a color, drag sideways for saturation, or hue with ⌘), and the spectrum with the band's handles.
function HueSaturationTools({ settings, onChange }: { settings: HueSaturationSettings; onChange: (s: HueSaturationSettings) => void }) {
  const [armed, setArmed] = useState<'sample' | 'add' | 'remove' | 'hand' | null>(null)
  const latest = useRef(settings)
  latest.current = settings
  const isRange = settings.range !== 'Master'
  const band = settings.bands[settings.range] ?? defaultBands[settings.range]
  useEffect(() => {
    if (!armed) { canvasPicker.current = null; canvasDrag.current = null; return }
    const hueAt = (point: [number, number]) => {
      const pixels = Store.renderer?.(store.doc)
      const x = Math.floor(point[0]), y = Math.floor(point[1])
      if (!pixels || x < 0 || y < 0 || x >= pixels.width || y >= pixels.height) return null
      const i = (y * pixels.width + x) * 4, a = pixels.data[i + 3]
      if (!a) return null
      const hsb = toHSB(...([0, 1, 2].map(c => Math.min(a, pixels.data[i + c]) / a) as [number, number, number]))
      return hsb.s <= 0.02 ? null : hsb.h
    }
    canvasPicker.current = point => {
      const s = latest.current, hue = hueAt(point)
      if (hue === null) { store.notify('That color has no hue to pick.', 'info'); return }
      if (armed === 'hand') {
        const range = rangeAt(s, hue), start = s.adjustments[range] ?? { hue: 0, saturation: 0, lightness: 0 }
        onChange({ ...s, range })
        canvasDrag.current = {
          move: (dx, command) => {
            const now = latest.current, adjustment = { ...start, ...(command ? { hue: Math.min(180, Math.max(-180, start.hue + dx / 2)) } : { saturation: Math.min(100, Math.max(-100, start.saturation + dx / 2)) }) }
            onChange({ ...now, range, adjustments: { ...now.adjustments, [range]: adjustment } })
          },
          up: () => { canvasDrag.current = null },
        }
        return
      }
      if (s.range === 'Master') return
      const b = s.bands[s.range] ?? defaultBands[s.range]
      const next = armed === 'sample' ? centered(b, hue) : armed === 'add' ? include(b, hue) : exclude(b, hue)
      onChange({ ...s, bands: { ...s.bands, [s.range]: next } })
    }
    return () => { canvasPicker.current = null; canvasDrag.current = null }
  }, [armed])
  const toggle = (mode: typeof armed) => setArmed(armed === mode ? null : mode)
  const spectrum = useRef<HTMLDivElement>(null)
  const dragging = useRef<number | null>(null)
  const dragHandle = (e: React.PointerEvent) => {
    const box = spectrum.current!.getBoundingClientRect()
    const at = (x: number) => Math.min(1, Math.max(0, (x - box.left) / box.width)) * 360
    const degrees = handleDegrees(band), d = at(e.clientX)
    const distance = (h: number) => { const r = Math.abs(h - d) % 360; return Math.min(r, 360 - r) }
    dragging.current = degrees.reduce((best, h, i) => distance(h) < distance(degrees[best]) ? i : best, 0)
    const move = (ev: PointerEvent) => { const s = latest.current, b = s.bands[s.range] ?? defaultBands[s.range]; onChange({ ...s, bands: { ...s.bands, [s.range]: withHandle(b, dragging.current!, at(ev.clientX)) } }) }
    const up = () => { dragging.current = null; window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up)
    move(e.nativeEvent)
  }
  const slices = (color: (h: number) => number) => `linear-gradient(to right, ${Array.from({ length: 73 }, (_, i) => `hsl(${color(i * 5)} 100% 50%) ${(i / 72 * 100).toFixed(2)}%`).join(', ')})`
  return <>
    <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
      {isRange && <>
        <button type="button" className={armed === 'sample' ? 'primary' : ''} title="Click the image to center this range on that color" onClick={() => toggle('sample')}>Sample</button>
        <button type="button" className={armed === 'add' ? 'primary' : ''} title="Click the image to widen this range to include that color" onClick={() => toggle('add')}>Add +</button>
        <button type="button" className={armed === 'remove' ? 'primary' : ''} title="Click the image to narrow this range to exclude that color" onClick={() => toggle('remove')}>Remove −</button>
      </>}
      <button type="button" className={armed === 'hand' ? 'primary' : ''} title={`Drag on the image: sideways changes saturation, with ${isMac ? '⌘' : 'Ctrl'} the hue`} onClick={() => toggle('hand')}>☝ Targeted</button>
    </div>
    {isRange && <>
      <div ref={spectrum} style={{ display: 'flex', flexDirection: 'column', gap: 5, touchAction: 'none', cursor: 'ew-resize' }} onPointerDown={dragHandle}>
        <div style={{ height: 16, borderRadius: 3, background: slices(h => h) }} />
        <div style={{ position: 'relative', height: 12 }}>
          {handleDegrees(band).map((d, i) => <span key={i} style={{ position: 'absolute', left: `${d / 360 * 100}%`, top: i === 1 || i === 2 ? 0 : 3.5, width: i === 1 || i === 2 ? 2 : 7, height: i === 1 || i === 2 ? 12 : 5, marginLeft: i === 1 || i === 2 ? -1 : -3.5, background: 'var(--text)' }} />)}
        </div>
        <div style={{ height: 16, borderRadius: 3, background: slices(h => shiftedHue(settings, h)) }} />
      </div>
      <span className="muted" style={{ fontVariantNumeric: 'tabular-nums' }}>{handleDegrees(band).map(d => `${Math.round(d)}°`).join('   ')}</span>
      <label><input type="checkbox" checked={settings.invertRange} onChange={e => onChange({ ...settings, invertRange: e.target.checked })} /> Apply outside this range instead</label>
    </>}
  </>
}
