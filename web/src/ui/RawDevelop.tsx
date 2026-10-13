import { useEffect, useRef, useState } from 'react'
import { store } from '../editor/store'
import { useEditor } from './hooks'
import { RawSource } from '../io/raw'
import { type RawDevelopSettings, developPixels, isAsShot, resetRaw } from '../model/rawDevelop'
import { type Deep, makeDeep } from '../model/deep'
import type { Raster } from '../model/raster'

// The develop sheet for a camera RAW (RawDevelopSheet.swift): a RAW holds more range than a layer can, so what to keep is chosen
// here. The preview develops a small copy as the sliders move; Import develops the full frame once, as a 16-bit layer.

type Pending = { source: RawSource; settings: RawDevelopSettings; resolve: (result: { image: Raster; deep: Deep } | null) => void }
let pending: Pending | null = null

// Puts the sheet up for `file` and waits for the choice; null when it's cancelled.
export async function developRaw(file: File): Promise<{ image: Raster; deep: Deep } | null> {
  const source = new RawSource(new Uint8Array(await file.arrayBuffer()), file.name)
  const settings = await source.asShot()
  return new Promise(resolve => {
    pending = { source, settings, resolve: result => { source.dispose(); resolve(result) } }
    store.set({ panel: 'Develop RAW' })
  })
}

// A small copy of the decoded frame, its long edge at most `limit`, averaged in linear light.
function shrink(decoded: { width: number; height: number; pixels: Uint16Array }, limit: number) {
  const scale = Math.max(1, Math.ceil(Math.max(decoded.width, decoded.height) / limit)), width = Math.floor(decoded.width / scale), height = Math.floor(decoded.height / scale)
  const out = new Uint16Array(width * height * 3)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) for (let c = 0; c < 3; c++) {
    let sum = 0
    for (let j = 0; j < scale; j++) for (let i = 0; i < scale; i++) sum += decoded.pixels[((y * scale + j) * decoded.width + x * scale + i) * 3 + c]
    out[(y * width + x) * 3 + c] = Math.round(sum / (scale * scale))
  }
  return { width, height, pixels: out }
}

export function RawDevelop() {
  useEditor()
  const job = pending
  const [settings, setSettings] = useState(job?.settings)
  const [working, setWorking] = useState(true), [importing, setImporting] = useState(false), [error, setError] = useState<string | null>(null)
  const canvas = useRef<HTMLCanvasElement>(null), small = useRef<{ key: string; frame: ReturnType<typeof shrink> } | null>(null)
  useEffect(() => {
    if (!job || !settings) return
    let live = true
    const timer = setTimeout(async () => {
      setWorking(true)
      try {
        const key = JSON.stringify([settings.highlightRecovery, settings.noiseReduction])
        if (small.current?.key !== key) small.current = { key, frame: shrink(await job.source.decode(true, settings), 800) }
        const { width, height, pixels } = small.current.frame, developed = developPixels(pixels, width * height, settings)
        if (!live || !canvas.current) return
        canvas.current.width = width; canvas.current.height = height
        const image = new ImageData(width, height)
        for (let i = 0; i < developed.length; i++) image.data[i] = developed[i] >> 8
        canvas.current.getContext('2d')!.putImageData(image, 0, 0)
        setError(null)
      } catch (e) { if (live) setError((e as Error).message) } finally { if (live) setWorking(false) }
    }, 60)
    return () => { live = false; clearTimeout(timer) }
  }, [settings])
  if (!job || !settings) return null
  const finish = (result: { image: Raster; deep: Deep } | null) => { pending = null; store.set({ panel: null }); job.resolve(result) }
  const importFrame = async () => {
    setImporting(true)
    try {
      const frame = await job.source.develop(false, settings)
      finish(makeDeep(frame.pixels, frame.width, frame.height, false))
    } catch (e) { setImporting(false); setError((e as Error).message) }
  }
  const set = (change: Partial<RawDevelopSettings>) => setSettings({ ...settings, ...change })
  const slider = (title: string, key: 'exposure' | 'temperature' | 'tint' | 'boost' | 'noiseReduction', min: number, max: number, step: number, unit: string, digits: number, disabled = false, help?: string) => (
    <div className="row" title={help} style={disabled ? { opacity: 0.45 } : undefined}><span style={{ width: 110 }}>{title}</span><input type="range" min={min} max={max} step={step} disabled={disabled || importing} value={settings[key]} onChange={e => set({ [key]: +e.target.value })} style={{ width: 300 }} /><span className="muted" style={{ width: 80, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{settings[key].toFixed(digits)}{unit}</span></div>
  )
  return (
    <div className="modal-back">
      <form className="modal" style={{ width: 620, maxWidth: 'calc(100vw - 40px)' }} onSubmit={e => { e.preventDefault(); if (!importing) importFrame() }} onKeyDown={e => { if (e.key === 'Escape' && !importing) finish(null); e.stopPropagation() }}>
        <h2>Develop “{job.source.name}”</h2>
        <div style={{ position: 'relative', height: 340, background: 'rgba(0,0,0,0.35)', borderRadius: 6, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
          <canvas ref={canvas} style={{ maxWidth: '100%', maxHeight: '100%', borderRadius: 6 }} />
          {(importing || working) && <span className="muted" style={{ position: 'absolute', right: 10, bottom: 8 }}>{importing ? 'Importing…' : 'Developing…'}</span>}
        </div>
        {slider('Exposure', 'exposure', -3, 3, 0.01, ' EV', 2)}
        {slider('Temperature', 'temperature', 2000, 12000, 10, ' K', 0)}
        {slider('Tint', 'tint', -150, 150, 1, '', 0)}
        {slider('Boost', 'boost', 0, 1, 0.01, '', 2)}
        {slider('Noise Reduction', 'noiseReduction', 0, 1, 0.01, '', 2, !settings.supportsNoiseReduction, 'Smooths grain, at the cost of fine detail')}
        <div className="row" style={{ paddingLeft: 120, gap: 20 }}>
          <label title="This file has no lens profile the web can apply" style={{ opacity: 0.45, whiteSpace: 'nowrap' }}><input type="checkbox" disabled checked={settings.lensCorrection} /> Lens Correction</label>
          <label title="Brings back detail in bright areas the camera partly clipped" style={{ whiteSpace: 'nowrap' }}><input type="checkbox" disabled={importing} checked={settings.highlightRecovery} onChange={e => set({ highlightRecovery: e.target.checked })} /> Highlight Recovery</label>
        </div>
        {error && <span style={{ color: 'var(--danger)' }}>{error}</span>}
        <div className="buttons" style={{ justifyContent: 'space-between' }}>
          <button type="button" disabled={isAsShot(settings) || importing} onClick={() => setSettings(resetRaw(settings))}>Reset</button>
          <span style={{ display: 'flex', gap: 8 }}><button type="button" disabled={importing} onClick={() => finish(null)}>Cancel</button><button type="submit" className="primary" disabled={importing}>Import</button></span>
        </div>
      </form>
    </div>
  )
}
