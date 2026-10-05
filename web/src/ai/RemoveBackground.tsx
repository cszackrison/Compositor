import { useEffect, useRef, useState } from 'react'
import { store } from '../editor/store'
import { Raster } from '../model/raster'
import type { Transform } from '../model/types'
import { pixelToDocument } from '../render/compositor'
import { renderFull } from '../ui/canvasState'
import { Slider } from '../ui/Inspector'
import { bytes, defaultBackground, refined, type BackgroundSettings } from './matte'
import { describe, findSubject } from './subject'

// Select → Subject: the foreground the model finds in the canvas as it shows, as the selection (EditorSession.selectSubject).
let selecting = false
export async function selectSubject() {
  if (selecting || !store.hasDocument) return
  selecting = true
  try {
    const shown = renderFull(store.doc)
    const mask = await findSubject(shown, status => store.notify(describe(status), 'info'))
    const selection = new Raster(shown.width, shown.height, 1)
    let any = false
    for (let i = 0; i < mask.length; i++) if (mask[i] >= 0.5) { selection.data[i] = 255; any = true }
    if (!any) { store.notify('No foreground subject was found. Try an image with a more distinct subject.'); return }
    store.setSelection(selection, 'replace', 'Select Subject')
    store.set({ message: null })
  } catch (error) { store.notify((error as Error).message) } finally { selecting = false }
}

let remembered: BackgroundSettings = defaultBackground

// Filter › Remove Background: hides the background behind a layer mask, keeping the foreground (SubjectRemoval and
// commitBackgroundMask). The preview is the mask itself on the layer; an existing mask on the layer's grid stays, multiplied,
// and with a selection only the selected part changes.
export function RemoveBackgroundDialog() {
  const [settings, setSettings] = useState(remembered)
  const [status, setStatus] = useState<string | null>('Finding the subject…')
  const [error, setError] = useState<string | null>(null)
  const session = useRef<{ layerId: string; image: Raster; base: Raster | null; transform: Transform; found: Float32Array | null } | null>(null)
  const frame = useRef(0)

  // The mask the layer gets: the subject, refined, under the existing mask, through the selection.
  const maskFor = (s: BackgroundSettings, limit: number) => {
    const { image, base, transform, found } = session.current!
    const { width, height } = image, subject = bytes(refined(found!, image.data, width, height, s, limit))
    if (base) for (let i = 0; i < subject.length; i++) subject[i] = Math.round(subject[i] * base.data[i] / 255)
    const selection = store.state.selection
    if (selection) {
      const m = pixelToDocument(transform, width, height)
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const sx = Math.floor(m[0] * (x + 0.5) + m[3] * (y + 0.5) + m[6]), sy = Math.floor(m[1] * (x + 0.5) + m[4] * (y + 0.5) + m[7])
        const k = sx >= 0 && sy >= 0 && sx < selection.width && sy < selection.height ? selection.data[sy * selection.width + sx] / 255 : 0
        const i = y * width + x, before = base ? base.data[i] : 255
        subject[i] = Math.round(before + (subject[i] - before) * k)
      }
    }
    return new Raster(width, height, 1, subject)
  }
  const show = (s: BackgroundSettings, limit: number) => {
    if (!session.current?.found) return
    store.updateLayerLive(session.current.layerId, { mask: maskFor(s, limit), maskEnabled: true, maskPlacement: null })
    store.pixelsChanged()
  }

  useEffect(() => {
    const layer = store.active
    if (!layer?.image || layer.isGroup || layer.adjustment || store.state.editingMask) { store.notify('Remove Background works on a layer’s pixels.'); store.set({ panel: null }); return }
    store.beginGesture('Remove Background')
    // As on the Mac, an existing mask on the layer's grid is kept (multiplied) whether or not it's switched on.
    const base = layer.mask && !layer.maskPlacement && layer.mask.width === layer.image.width && layer.mask.height === layer.image.height ? layer.mask : null
    session.current = { layerId: layer.id, image: layer.image, base, transform: layer.transform, found: null }
    let alive = true
    findSubject(layer.image, s => alive && setStatus(describe(s))).then(found => {
      if (!alive || !session.current) return
      let any = false
      for (let i = 0; i < found.length && !any; i++) if (found[i] >= 0.5) any = true
      if (!any) { setError('No foreground subject was detected in this layer. Try an image with a more distinct subject.'); setStatus(null); return }
      session.current.found = found
      setStatus(null)
      show(settings, 1400)
    }, e => { if (alive) { setError((e as Error).message); setStatus(null) } })
    return () => { alive = false; cancelAnimationFrame(frame.current); if (session.current) { store.cancelGesture(); store.pixelsChanged(); session.current = null } }
  }, [])

  const set = (changes: Partial<BackgroundSettings>) => {
    const next = { ...settings, ...changes }
    setSettings(next)
    cancelAnimationFrame(frame.current)
    frame.current = requestAnimationFrame(() => show(next, 1400))
  }
  const finish = (ok: boolean) => {
    const s = session.current
    cancelAnimationFrame(frame.current)
    if (s && ok && s.found && !error) {
      // The preview refines on a copy at most 1400 px across; what's kept is refined at full size.
      if (settings.quality === 'Advanced') show(settings, Infinity)
      store.set({ editingMask: true })
      store.endGesture()
      store.history.renameLast('Remove Background')
      store.pixelsChanged()
      remembered = settings
      session.current = null
    }
    store.set({ panel: null })
  }

  return (
    <div className="modal-back filter-back">
      <form noValidate className="modal filter" onSubmit={e => { e.preventDefault(); finish(true) }} onKeyDown={e => { if (e.key === 'Escape') finish(false); e.stopPropagation() }}>
        <h2>Remove Background</h2>
        <span className="muted">Hide the background behind a layer mask, keeping the foreground subjects. The pixels stay, so the background can be painted back at any time.</span>
        <span style={{ display: 'inline-flex', gap: 2 }}>{(['Basic', 'Advanced'] as const).map(q => <button type="button" key={q} className={`icon ${settings.quality === q ? 'on' : ''}`} style={{ padding: '3px 10px' }} title={q === 'Basic' ? 'The model’s mask as it comes' : 'Refines the mask against the layer’s own detail, for hair and fur'} onClick={() => set({ quality: q })}>{q}</button>)}</span>
        {settings.quality === 'Advanced' && <>
          <Slider label="Refine" value={settings.refine} min={0} max={40} suffix="px" onChange={refine => set({ refine })} />
          <Slider label="Contrast" value={settings.contrast} min={0} max={100} suffix="%" onChange={contrast => set({ contrast })} />
          <Slider label="Shift Edge" value={settings.shiftEdge} min={-10} max={10} suffix="px" onChange={shiftEdge => set({ shiftEdge })} />
        </>}
        {status && <span className="muted">{status}</span>}
        {error && <span style={{ color: '#ffb35c' }}>{error}</span>}
        <span className="muted" style={{ fontSize: 11 }}>Uses the ormbg model (Apache-2.0) in your browser; your image never leaves this device.</span>
        <div className="buttons">
          <button type="button" onClick={() => finish(false)}>Cancel</button>
          <button type="submit" className="primary" disabled={!!status || !!error}>OK</button>
        </div>
      </form>
    </div>
  )
}
