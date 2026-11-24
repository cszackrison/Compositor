import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { canvasPicker, sampleComposite } from './canvasState'
import { store } from '../editor/store'
import { NumberField, Scrub } from './Inspector'

export type RGB255 = [number, number, number]
type Request = { title: string; initial: RGB255; onChange?: (c: RGB255) => void; onCommit: (c: RGB255) => void; onCancel?: () => void; sampling?: boolean }

// One picker at a time (ColorPickerSheet.swift): whoever opens it previews the working color live, OK keeps it, Cancel puts the
// original back. While it's open, clicking the canvas or the tool rail's foreground/background swatches samples them into it.
let request: Request | null = null
let activeSetter: ((c: RGB255) => void) | null = null
const listeners = new Set<() => void>()
const changed = () => listeners.forEach(l => l())
export function openColorPicker(next: Request) { if (request) request.onCancel?.(); request = next; changed() }
export function isColorPickerOpen() { return request !== null }
export function sampleIntoColorPicker(color: RGB255): boolean {
  if (!request || !activeSetter || request.sampling === false) return false
  activeSetter(color)
  return true
}
function closePicker() { request = null; activeSetter = null; changed() }

type HSB = { h: number; s: number; b: number }
function toRGB({ h, s, b }: HSB): RGB255 {
  const c = b * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = b - c
  const [r, g, bl] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x]
  return [r, g, bl].map(v => Math.round((v + m) * 255)) as RGB255
}
// Keeps the previous hue for grays and the previous saturation for black, so dragging through them doesn't lose either.
function fromRGB([r, g, b]: RGB255, previous: HSB): HSB {
  const [R, G, B] = [r / 255, g / 255, b / 255], hi = Math.max(R, G, B), lo = Math.min(R, G, B), d = hi - lo
  const next = { ...previous, b: hi }
  if (hi > 0) next.s = d / hi
  if (d <= 0) return next
  let h = hi === R ? (G - B) / d : hi === G ? (B - R) / d + 2 : (R - G) / d + 4
  h *= 60
  next.h = h < 0 ? h + 360 : h
  return next
}
const hex = (c: RGB255) => c.map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase()

// A hex value part-way through being typed, padded with zeros so the color follows each digit ("F" -> F00000, "FF8" -> FF8000).
export function parseTypedHex(text: string): RGB255 | null {
  const digits = text.trim().replace(/^#/, '')
  if (!/^[0-9a-f]{1,6}$/i.test(digits)) return null
  const padded = digits.padEnd(6, '0')
  return [0, 2, 4].map(i => parseInt(padded.slice(i, i + 2), 16)) as RGB255
}

function Picker({ request: r }: { request: Request }) {
  const [hsb, setHSB] = useState<HSB>(() => fromRGB(r.initial, { h: 0, s: 0, b: 0 }))
  const [hexText, setHexText] = useState(hex(r.initial))
  const editingHex = useRef(false)
  const color = toRGB(hsb)
  const field = useRef<HTMLDivElement>(null), strip = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState(() => remembered.get(r.title) ?? { x: Math.max(20, window.innerWidth / 2 - 260), y: 120 })
  useEffect(() => {
    r.onChange?.(color)
    if (!editingHex.current) setHexText(hex(color))
  }, [hsb])
  // Clicking the canvas or tool-rail swatches samples into this picker.
  useEffect(() => {
    activeSetter = c => { editingHex.current = false; setHSB(h => fromRGB(c, h)) }
    if (r.sampling === false) return () => { activeSetter = null }
    canvasPicker.current = point => {
      const pixel = sampleComposite(store.state.doc, point), a = pixel?.[3]
      if (!pixel || !a) return
      editingHex.current = false
      setHSB(h => fromRGB([0, 1, 2].map(c => Math.round(Math.min(a, pixel[c]) / a * 255)) as RGB255, h))
    }
    return () => { canvasPicker.current = null; activeSetter = null }
  }, [])
  const finish = (ok: boolean) => { remembered.set(r.title, position); closePicker(); if (ok) r.onCommit(color); else r.onCancel?.() }
  const latest = useRef(finish)
  latest.current = finish
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); latest.current(false) } }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  }, [])
  const dragIn = (element: HTMLDivElement | null, apply: (x: number, y: number) => void) => (e: React.PointerEvent) => {
    editingHex.current = false
    const box = element!.getBoundingClientRect()
    const at = (ev: PointerEvent | React.PointerEvent) => apply(Math.min(1, Math.max(0, (ev.clientX - box.left) / box.width)), Math.min(1, Math.max(0, (ev.clientY - box.top) / box.height)))
    at(e)
    const move = (ev: PointerEvent) => at(ev), up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up)
  }
  const moveWindow = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('input,button,.sb,.hue,.compare')) return
    const start = { x: e.clientX - position.x, y: e.clientY - position.y }
    const move = (ev: PointerEvent) => setPosition({ x: ev.clientX - start.x, y: ev.clientY - start.y }), up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up)
  }
  const setChannel = (index: number, value: number) => {
    editingHex.current = false
    const next = [...color] as RGB255
    next[index] = Math.min(255, Math.max(0, Math.round(value)))
    setHSB(h => fromRGB(next, h))
  }
  const onHexChange = (text: string) => {
    editingHex.current = true
    setHexText(text)
    const parsed = parseTypedHex(text)
    if (parsed) setHSB(h => fromRGB(parsed, h))
  }
  const pure = toRGB({ h: hsb.h, s: 1, b: 1 })
  return (
    <div className="color-picker" style={{ left: position.x, top: position.y }} onPointerDown={moveWindow}>
      <div className="picker-title">{r.title}</div>
      <div className="picker-body" style={{ display: 'flex', gap: 14 }}>
        <div ref={field} className="sb" style={{ background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, rgb(${pure.join(',')}))` }} onPointerDown={e => dragIn(field.current, (x, y) => setHSB(h => ({ ...h, s: x, b: 1 - y })))(e)}>
          <span className="marker" style={{ left: `${hsb.s * 100}%`, top: `${(1 - hsb.b) * 100}%`, background: `rgb(${color.join(',')})` }} />
        </div>
        <div ref={strip} className="hue" onPointerDown={e => dragIn(strip.current, (_, y) => setHSB(h => ({ ...h, h: (1 - y) * 360 % 360 })))(e)}>
          <span className="arrow" style={{ top: `${Math.min(99.5, Math.max(0.5, (1 - hsb.h / 360) * 100))}%` }} />
        </div>
        <div className="picker-controls" style={{ width: 148, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {/* New color over original color: clicking the bottom half puts the original back. */}
          <div className="compare" style={{ width: 64, height: 64, borderRadius: 6, overflow: 'hidden', border: '1px solid var(--line)', display: 'flex', flexDirection: 'column' }}>
            <div title="New color" style={{ flex: 1, background: `rgb(${color.join(',')})` }} />
            <div title="Original color — click to revert" style={{ flex: 1, background: `rgb(${r.initial.join(',')})`, cursor: 'pointer' }} onClick={() => { editingHex.current = false; setHSB(h => fromRGB(r.initial, h)) }} />
          </div>
          {(['R', 'G', 'B'] as const).map((label, i) => (
            <label key={label}>
              <Scrub label={label} value={color[i]} min={0} max={255} onChange={v => setChannel(i, v)} />
              <NumberField min={0} max={255} style={{ width: 58 }} value={color[i]} onChange={v => setChannel(i, v)}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); finish(true) } e.stopPropagation() }} />
            </label>
          ))}
          <label>
            <span className="muted">#</span>
            <input type="text" style={{ width: 84, fontFamily: 'ui-monospace, monospace' }} value={hexText}
              onChange={e => onHexChange(e.target.value)}
              onBlur={() => { editingHex.current = false; setHexText(hex(color)) }}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); finish(true) } e.stopPropagation() }} />
          </label>
        </div>
      </div>
      <div className="picker-footer">
        <span className="muted">{r.sampling !== false ? 'Click the canvas to sample' : ''}</span>
        <span style={{ display: 'flex', gap: 8 }}>
          <button type="button" onClick={() => finish(false)}>Cancel</button>
          <button type="button" className="primary" onClick={() => finish(true)}>OK</button>
        </span>
      </div>
    </div>
  )
}
const remembered = new Map<string, { x: number; y: number }>()

export function ColorPickerHost() {
  const current = useSyncExternalStore(l => { listeners.add(l); return () => { listeners.delete(l) } }, () => request)
  return current ? <Picker key={current.title + current.initial.join()} request={current} /> : null
}

// A swatch that opens the picker for its color, previewing live through `onChange` and putting the original back on Cancel.
export function ColorSwatch({ value, onChange, onCommit, onCancel, title, sampling, width = 22, height = 22 }: { value: RGB255; onChange: (c: RGB255) => void; onCommit?: (c: RGB255) => void; onCancel?: () => void; title: string; sampling?: boolean; width?: number; height?: number }) {
  return <button type="button" title={title} className="swatch" style={{ width, height, background: `rgb(${value.join(',')})` }}
    onClick={() => {
      const original = value
      openColorPicker({ title: `Color Picker (${title})`, initial: value, sampling, onChange, onCommit: onCommit ?? onChange, onCancel: onCancel ?? (() => onChange(original)) })
    }} />
}
