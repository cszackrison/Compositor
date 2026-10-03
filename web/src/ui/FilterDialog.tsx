import { useEffect, useRef, useState, type ReactNode } from 'react'
import { FilterSession, isJob, type FilterJob, type FilterRun } from '../editor/filters'

// A filter's sheet: controls on the left of OK/Cancel, the canvas previewing every change live on the layer itself.
export function FilterDialog<P>({ title, initial, run, onClose, onCommit, children, preview = true, trim = false, masks = false, growEmpty = false }: { title: string; initial: P; run: (params: P) => FilterRun | FilterJob; onClose: () => void; onCommit?: (params: P) => void; children: (params: P, set: (changes: Partial<P>) => void) => ReactNode; preview?: boolean; trim?: boolean; masks?: boolean; growEmpty?: boolean }) {
  const session = useRef<FilterSession | null>(null)
  const [params, setParams] = useState(initial)
  const [live, setLive] = useState(preview)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    session.current = FilterSession.start({ masks, growEmpty })
    if (!session.current) onClose()
    else { session.current.onError = setError; session.current.onBusy = setBusy }
    return () => { session.current?.cancel(); session.current = null }
  }, [])
  // A filter that throws (Content-Aware Fill with nothing to sample) shows why under the controls instead of changing anything.
  const guarded = (filter: FilterRun | FilterJob): FilterRun | FilterJob => isJob(filter) ? filter : input => { try { const out = filter(input); setError(null); return out } catch (e) { setError((e as Error).message); return null } }
  useEffect(() => { if (session.current) session.current.preview(live ? guarded(run(params)) : () => null) }, [params, live])
  const set = (changes: Partial<P>) => setParams(p => ({ ...p, ...changes }))
  const cancelRef = useRef<() => void>(() => {})
  const [finishing, setFinishing] = useState(false)
  const finish = async (ok: boolean) => {
    const s = session.current
    if (!s || finishing) return
    if (!ok || error) { session.current = null; s.cancel(); onClose(); return }
    // OK waits for a filter still working in the background; one that fails changes nothing.
    setFinishing(true)
    const kept = await s.commit(title, live ? undefined : guarded(run(params)), trim)
    session.current = null
    if (kept) onCommit?.(params)
    onClose()
  }
  cancelRef.current = () => finish(false)
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); cancelRef.current() } }
    window.addEventListener('keydown', escape)
    return () => window.removeEventListener('keydown', escape)
  }, [])
  return (
    <div className="modal-back filter-back">
      <form noValidate className="modal filter" onSubmit={e => { e.preventDefault(); finish(true) }} onKeyDown={e => { if (e.key === 'Escape') finish(false); e.stopPropagation() }}>
        <h2>{title}</h2>
        {children(params, set)}
        {error && <span style={{ color: '#ffb35c' }}>{error}</span>}
        {(busy || finishing) && !error && <span className="muted">Working…</span>}
        <div className="buttons">
          <label style={{ marginRight: 'auto' }}><input type="checkbox" checked={live} onChange={e => setLive(e.target.checked)} /> Preview</label>
          <button type="button" onClick={() => finish(false)}>Cancel</button>
          <button type="submit" className="primary" autoFocus disabled={finishing}>OK</button>
        </div>
      </form>
    </div>
  )
}
