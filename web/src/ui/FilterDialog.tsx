import { useEffect, useRef, useState, type ReactNode } from 'react'
import { FilterSession, isJob, type FilterJob, type FilterRun } from '../editor/filters'
import { store } from '../editor/store'

// A filter's sheet: controls on the left of OK/Cancel, the canvas previewing every change live on the layer itself. `docked` stands it
// at the window's right, full height, as Camera Raw's column.
export function FilterDialog<P>({ title, initial, run, onClose, onCommit, children, preview = true, trim = false, masks = false, growEmpty = false, docked = false, final }: { title: string; initial: P; run: (params: P) => FilterRun | FilterJob; onClose: () => void; onCommit?: (params: P) => void; children: (params: P, set: (changes: Partial<P>) => void) => ReactNode; preview?: boolean; trim?: boolean; masks?: boolean; growEmpty?: boolean; docked?: boolean; final?: (params: P) => FilterRun | FilterJob | undefined }) {
  const session = useRef<FilterSession | null>(null)
  const [params, setParams] = useState(initial)
  const [live, setLive] = useState(preview)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    session.current = FilterSession.start({ masks, growEmpty })
    if (!session.current) onClose()
    else { session.current.onError = setError; session.current.onBusy = setBusy }
    // Closed by leaving its tab (the sheet belongs to the tab showing): it's cancelled in its own tab, which shows no sheet on return.
    return () => { const s = session.current; session.current = null; s?.cancel(); if (s && s.owner !== store) s.owner.set({ panel: null }) }
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
    // What OK keeps: the filter as previewed, or `final`'s run when the preview showed something OK leaves out.
    try {
      const clean = final?.(params)
      const kept = await s.commit(title, clean ? guarded(clean) : live ? undefined : guarded(run(params)), trim)
      session.current = null
      if (kept) onCommit?.(params)
    } catch (e) {
      // Something that failed while keeping the result leaves the layer as it was rather than the sheet stuck open.
      session.current = null
      s.cancel()
      s.owner.notify((e as Error).message)
    }
    onClose()
  }
  cancelRef.current = () => finish(false)
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); cancelRef.current() } }
    window.addEventListener('keydown', escape)
    return () => window.removeEventListener('keydown', escape)
  }, [])
  return (
    <div className={`modal-back filter-back ${docked ? 'docked' : ''}`}>
      <form noValidate className={`modal filter ${docked ? 'docked' : ''}`} onSubmit={e => { e.preventDefault(); finish(true) }} onKeyDown={e => { if (e.key === 'Escape') finish(false); e.stopPropagation() }}>
        <h2>{title}</h2>
        {children(params, set)}
        {error && <span style={{ color: '#ffb35c' }}>{error}</span>}
        {(busy || finishing) && !error && <span className="muted">Working…</span>}
        <div className="buttons">
          <label style={{ marginRight: 'auto' }}><input type="checkbox" checked={live} onChange={e => setLive(e.target.checked)} /> Preview</label>
          <button type="button" onClick={() => finish(false)}>Cancel</button>
          <button type="submit" className="primary" autoFocus={!docked} disabled={finishing}>OK</button>
        </div>
      </form>
    </div>
  )
}
