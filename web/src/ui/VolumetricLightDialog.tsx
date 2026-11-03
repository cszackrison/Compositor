import { useEffect, useRef, useState } from 'react'
import { store } from '../editor/store'
import { FilterSession } from '../editor/filters'
import { Raster } from '../model/raster'
import { apply, invert } from '../render/gl'
import { Slider } from './Inspector'
import { ColorSwatch } from './ColorPicker'
import { canvasGesture, requestRender, view } from './canvasState'
import { brightestPoint, defaultVolumetric, type VolumetricSettings } from '../editor/volumetricLight'
import { describeDepth, estimateDepth } from '../ai/depth'
import { describe as describeSubject, findSubject } from '../ai/subject'
import { bytes } from '../ai/matte'

// Settings are remembered between openings, as the Mac app does; the light starts afresh each time on the layer's biggest bright area.
let remembered: VolumetricSettings = defaultVolumetric
const previewSide = 1024

type Session = { filter: FilterSession; worker: Worker; ready: boolean; hasDepth: boolean; waiting: Map<number, { resolve: (r: Raster) => void; reject: (e: Error) => void }>; nextId: number }

function ask(s: Session, message: object): Promise<Raster> {
  const id = s.nextId++
  return new Promise((resolve, reject) => { s.waiting.set(id, { resolve, reject }); s.worker.postMessage({ ...message, id }) })
}

// Filter › Volumetric Light (FilterSheet's volumetricLightControls): fog lit by a light placed on the image, clicked or dragged on the
// canvas. Its first preview waits for the layer's depth (the model downloads the first time) and its subject; without depth the fog
// guesses from where each part sits, as the Mac's does without its model. The preview runs on a copy at most 1024 across, in a worker;
// OK runs it at full size. Extract Depth closes the filter and hands the depth the haze goes by to `onExtractDepth`, white near.
export function VolumetricLightDialog({ onExtractDepth }: { onExtractDepth?: (gray: Raster) => void }) {
  const [settings, setSettings] = useState(remembered)
  const [center, setCenter] = useState<[number, number] | null>(null)
  const [live, setLive] = useState(true)
  const [status, setStatus] = useState<string | null>('Getting depth…')
  const [note, setNote] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [finishing, setFinishing] = useState(false)
  const session = useRef<Session | null>(null)
  const pending = useRef<{ settings: VolumetricSettings; center: [number, number]; live: boolean } | null>(null)
  const running = useRef(false)
  const latest = useRef({ settings, center })
  latest.current = { settings, center }

  const toPixel = (s: Session, point: [number, number]) => apply(invert(s.filter.toDocument), ...point)
  const close = (s: Session | null) => (s?.filter.owner ?? store).set({ panel: null })

  // Only the newest settings wait while a preview runs, so a slider never builds a backlog.
  const pump = () => {
    const s = session.current, next = pending.current
    if (!s?.ready || running.current || !next) return
    pending.current = null
    if (!next.live) { s.filter.preview(() => null); return }
    running.current = true; setBusy(true)
    ask(s, { kind: 'run', full: false, settings: next.settings, center: toPixel(s, next.center), enlarge: !!s.filter.owner.state.selection })
      .then(raster => { if (session.current === s) { s.filter.preview(() => raster); setError(null) } }, e => { if (session.current === s) setError((e as Error).message) })
      .finally(() => { running.current = false; if (!pending.current) setBusy(false); pump() })
  }

  useEffect(() => {
    const filter = FilterSession.start()
    if (!filter) { close(null); return }
    const worker = new Worker(new URL('../editor/volumetricWorker.ts', import.meta.url), { type: 'module' })
    const s: Session = { filter, worker, ready: false, hasDepth: false, waiting: new Map(), nextId: 1 }
    session.current = s
    worker.onmessage = (event: MessageEvent<{ id?: number; error?: string; width: number; height: number; data: Uint8Array }>) => {
      const { id, error, width, height, data } = event.data, w = id !== undefined ? s.waiting.get(id) : undefined
      if (id === undefined) { if (error) setError(error); return }
      s.waiting.delete(id)
      if (error) w?.reject(new Error(error)); else w?.resolve(new Raster(width, height, 4, data))
    }
    worker.onerror = () => { s.waiting.forEach(w => w.reject(new Error('Volumetric Light stopped unexpectedly.'))); s.waiting.clear() }
    const image = filter.original
    setCenter(apply(filter.toDocument, ...brightestPoint(image)))
    let depthStatus = 'Getting depth…', subjectStatus = 'Finding the subject…'
    const show = () => session.current === s && setStatus(`${depthStatus} ${subjectStatus}`.trim())
    const depth = estimateDepth(image, d => { depthStatus = describeDepth(d); show() }).then(d => d, (e: Error) => { console.warn(e.message); return null }).finally(() => { depthStatus = ''; show() })
    const subject = findSubject(image, d => { subjectStatus = describeSubject(d); show() }).then(found => {
      for (let i = 0; i < found.length; i++) if (found[i] >= 0.5) return bytes(found)
      return null
    }, (e: Error) => { console.warn(e.message); return null }).finally(() => { subjectStatus = ''; show() })
    Promise.all([depth, subject]).then(([d, m]) => {
      if (session.current !== s) return
      const data = image.data.slice(), depthCopy = d && d.slice()
      worker.postMessage({ kind: 'source', width: image.width, height: image.height, data, depth: depthCopy, subject: m, previewSide }, [data.buffer, ...(depthCopy ? [depthCopy.buffer] : []), ...(m ? [m.buffer] : [])])
      s.ready = true; s.hasDepth = !!d
      setStatus(null)
      if (!d) setNote('The depth model couldn’t be had, so the haze guesses how far away each part is.')
      pending.current ??= { settings: latest.current.settings, center: latest.current.center ?? [0, 0], live: true }
      pump()
    })
    // Closed by leaving its tab, it's cancelled in its own tab, which shows no sheet on return.
    return () => {
      const current = session.current
      session.current = null
      worker.terminate()
      if (current) { current.filter.cancel(); if (current.filter.owner !== store) current.filter.owner.set({ panel: null }) }
    }
  }, [])

  useEffect(() => { if (center) { pending.current = { settings, center, live }; pump() } }, [settings, center, live])

  // Clicking or dragging on the canvas moves the light, shown as a ring with a dot.
  useEffect(() => {
    let dragging = false
    canvasGesture.current = {
      down: point => { dragging = true; setCenter(point) },
      move: point => { if (dragging) setCenter(point) },
      up: () => { dragging = false },
      draw: c => {
        const at = latest.current.center
        if (!at) return
        const [x, y] = view.toScreen(...at)
        c.beginPath(); c.arc(x, y, 9, 0, Math.PI * 2); c.strokeStyle = 'rgba(0,0,0,0.7)'; c.lineWidth = 3; c.stroke(); c.strokeStyle = '#fff'; c.lineWidth = 1.5; c.stroke()
        c.beginPath(); c.arc(x, y, 2.5, 0, Math.PI * 2); c.fillStyle = '#fff'; c.fill(); c.strokeStyle = '#000'; c.lineWidth = 1; c.stroke()
      },
    }
    requestRender(false)
    return () => { canvasGesture.current = null; requestRender(false) }
  }, [])
  useEffect(() => { requestRender(false) }, [center])

  const cancelRef = useRef<() => void>(() => {})
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); cancelRef.current() } }
    window.addEventListener('keydown', escape)
    return () => window.removeEventListener('keydown', escape)
  }, [])

  const set = (changes: Partial<VolumetricSettings>) => setSettings(p => ({ ...p, ...changes }))
  const finish = async (ok: boolean) => {
    const s = session.current
    if (!s || finishing) return
    if (!ok || error || !s.ready || !center) { session.current = null; s.filter.cancel(); s.worker.terminate(); close(s); return }
    setFinishing(true)
    try {
      const result = await ask(s, { kind: 'run', full: true, settings, center: toPixel(s, center), enlarge: false })
      if (session.current !== s) return
      session.current = null
      if (await s.filter.commit('Volumetric Light', () => result)) remembered = settings
    } catch (e) {
      session.current = null
      s.filter.cancel()
      s.filter.owner.notify((e as Error).message)
    }
    s.worker.terminate()
    close(s)
  }
  cancelRef.current = () => finish(false)
  const extractDepth = async () => {
    const s = session.current
    if (!s?.hasDepth || finishing) return
    setFinishing(true)
    try {
      const gray = await ask(s, { kind: 'depth', settings })
      if (session.current !== s) return
      session.current = null
      s.filter.cancel(); s.worker.terminate(); close(s)
      onExtractDepth?.(gray)
    } catch (e) { setError((e as Error).message); setFinishing(false) }
  }

  const waiting = !!status || !session.current?.ready
  return (
    <div className="modal-back filter-back">
      <form noValidate className="modal filter" onSubmit={e => { e.preventDefault(); finish(true) }} onKeyDown={e => { if (e.key === 'Escape') finish(false); e.stopPropagation() }}>
        <h2>Volumetric Light</h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><span className="muted" style={{ flex: 1 }}>Click or drag on the canvas to move the light</span><ColorSwatch title="Volumetric Light Color" value={settings.color} onChange={color => set({ color })} /></div>
        <Slider label="Haze" value={settings.haze} min={0} max={100} suffix="%" onChange={haze => set({ haze })} />
        <Slider label="Distance" value={settings.distance} min={0} max={100} suffix="%" onChange={distance => set({ distance })} />
        <Slider label="Depth Contrast" value={settings.depthContrast} min={0} max={100} suffix="%" onChange={depthContrast => set({ depthContrast })} />
        <Slider label="Size" value={settings.size} min={0} max={100} suffix="%" onChange={size => set({ size })} />
        <Slider label="Intensity" value={settings.intensity} min={0} max={100} suffix="%" onChange={intensity => set({ intensity })} />
        <Slider label="Length" value={settings.length} min={0} max={100} suffix="%" onChange={length => set({ length })} />
        <Slider label="Shafts" value={settings.shafts} min={0} max={100} suffix="%" onChange={shafts => set({ shafts })} />
        <label title="Keep the subject clear of the haze; off, it's hazed by its own distance, so a figure far off is misted"><input type="checkbox" checked={settings.keepsSubjectClear} onChange={e => set({ keepsSubjectClear: e.target.checked })} /> Keep Subject Clear</label>
        {status && <span className="muted">{status}</span>}
        {note && <span className="muted">{note}</span>}
        {error && <span style={{ color: '#ffb35c' }}>{error}</span>}
        {(busy || finishing) && !error && !status && <span className="muted">Working…</span>}
        <span className="muted" style={{ fontSize: 11 }}>Uses the Depth Anything V2 Small and ormbg models (Apache-2.0) in your browser; your image never leaves this device.</span>
        <div className="buttons">
          <label style={{ marginRight: 'auto' }}><input type="checkbox" checked={live} onChange={e => setLive(e.target.checked)} /> Preview</label>
          {onExtractDepth && <button type="button" title="Close the filter and add the depth the haze goes by as a new layer: white is near, black is far" disabled={waiting || finishing || !session.current?.hasDepth} onClick={extractDepth}>Extract Depth</button>}
          <button type="button" onClick={() => finish(false)}>Cancel</button>
          <button type="submit" className="primary" disabled={waiting || finishing}>OK</button>
        </div>
      </form>
    </div>
  )
}
