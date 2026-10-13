import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { store } from '../editor/store'
import { useEditor } from './hooks'
import { NumberField } from './Inspector'
import { openColorPicker } from './ColorPicker'
import { type TextAlignment, type TextStyle, setTextFont, uniformFont } from '../model/text'
import { commonFaces, guessFace, installedFaces, listInstalledFaces, subscribeFonts } from '../render/text'
import { cancelText, changeTextStyle, currentTextStyle, editActiveText, endFontPreview, finishText, isEditingText, keepFontPreview, liveText, previewFont, setTypeColor, subscribeType, textSelection, typeColor, typeVersion } from '../tools/type'

// The Type tool's bar (TypeControls.swift): the face, size, color, alignment, tracking and leading of the text being edited (its selected
// letters, for face and color), of the selected text layer, or of new text; Done and Cancel while text is open.
export function TypeBar() {
  useEditor()
  useSyncExternalStore(subscribeType, typeVersion)
  const style = currentTextStyle(), editing = isEditingText(), selection = textSelection()
  const set = (change: Partial<TextStyle>) => changeTextStyle(s => ({ ...s, ...change }))
  const color = typeColor().map(v => Math.round(v * 255)) as [number, number, number]
  const face = selection && selection[1] > selection[0] ? uniformFont(style, ...selection) : style.fontName
  const pickColor = () => {
    const before = currentTextStyle()
    openColorPicker({ title: 'Text Color', initial: color, onChange: c => setTypeColor(c.map(v => v / 255) as [number, number, number]), onCommit: c => setTypeColor(c.map(v => v / 255) as [number, number, number]), onCancel: () => changeTextStyle(() => before) })
  }
  return <>
    <FontMenu value={face} />
    <label title="Size in pixels"><NumberField min={1} max={2000} digits={1} value={style.fontSize} style={{ width: 58 }} onChange={fontSize => set({ fontSize })} /> px</label>
    <button className="swatch-button" title="Text color: the selected letters, or all of it" style={{ background: `rgb(${color.join(',')})` }} onClick={pickColor} />
    <span className="segmented">{(['Left', 'Center', 'Right'] as TextAlignment[]).map(a => <button key={a} className={style.alignment === a ? 'on' : ''} onClick={() => set({ alignment: a })}>{a}</button>)}</span>
    <label title="Tracking: the space added after each letter, in pixels (Option with ← →)">Tracking <NumberField min={-100} max={1000} value={style.tracking} style={{ width: 52 }} onChange={tracking => set({ tracking })} /></label>
    <label title="Leading: baseline to baseline, in pixels; 0 is Auto, 120% of the size (Option with ↑ ↓)">Leading <NumberField min={0} max={5000} value={style.leading} style={{ width: 58 }} onChange={leading => set({ leading })} /></label>
    {editing ? <><button onClick={cancelText}>Cancel</button><button className="primary" onClick={finishText}>Done</button></>
      : <button disabled={!liveText(store.active)} onClick={() => editActiveText()}>Edit Text</button>}
  </>
}

// The face menu: every face the browser can list (Chrome and Edge, once allowed), or the common ones it can draw, each in itself.
// While it's open the text shows the face under the pointer; closing it without a choice puts the text back.
function FontMenu({ value }: { value: string | null }) {
  const [open, setOpen] = useState<{ left: number; top: number } | null>(null), [query, setQuery] = useState('')
  const listed = useSyncExternalStore(subscribeFonts, installedFaces)
  const fallback = useMemo(() => open && !listed ? commonFaces() : [], [open, listed])
  const chosen = useRef(false), box = useRef<HTMLDivElement>(null)
  const names = (listed ? listed.map(f => f.postscriptName) : fallback).filter(n => !query || n.toLowerCase().includes(query.toLowerCase()))
  const label = (name: string) => { const f = listed?.find(x => x.postscriptName === name); return f ? `${f.family} ${f.style}`.replace(/ Regular$/, '') : name }
  const close = () => { setOpen(null); setQuery(''); if (!chosen.current) endFontPreview(); chosen.current = false }
  useEffect(() => {
    if (!open) return
    const away = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) close() }
    window.addEventListener('pointerdown', away)
    return () => window.removeEventListener('pointerdown', away)
  }, [open])
  const choose = (name: string) => { chosen.current = true; keepFontPreview(); changeTextStyle((s, [a, b]) => setTextFont(s, name, a, b)); close() }
  return (
    <div ref={box} style={{ position: 'relative' }}>
      <button title="Font" style={{ minWidth: 150, maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'left' }} onClick={e => { if (open) { close(); return } const r = e.currentTarget.getBoundingClientRect(); setOpen({ left: r.left, top: r.bottom + 4 }) }}>{value ? label(value) : 'Multiple Fonts'}</button>
      {/* Fixed, so the bar's own scrolling doesn't clip it. */}
      {open && <div className="menu-list" style={{ position: 'fixed', top: open.top, left: open.left, width: 260, maxHeight: 'min(420px, 70vh)', overflowY: 'auto', zIndex: 50 }}>
        <input autoFocus placeholder="Search fonts" value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => { if (e.key === 'Escape') close(); if (e.key === 'Enter' && names[0]) choose(names[0]); e.stopPropagation() }} style={{ margin: 6, width: 'calc(100% - 12px)' }} />
        {!listed && 'queryLocalFonts' in window && <button onClick={() => listInstalledFaces()}><span className="muted">Show all installed fonts…</span></button>}
        {names.slice(0, 600).map(name => { const g = guessFace(name); return <button key={name} className={name === value ? 'on' : ''} onPointerEnter={() => isEditingText() && previewFont(name)} onClick={() => choose(name)}><span style={{ fontFamily: `"ps ${name}", "${g.family}"`, fontWeight: g.weight, fontStyle: g.italic ? 'italic' : 'normal' }}>{label(name)}</span></button> })}
        {!names.length && <div className="muted" style={{ padding: '6px 10px' }}>No fonts match.</div>}
      </div>}
    </div>
  )
}
