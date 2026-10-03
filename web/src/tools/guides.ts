import { store } from '../editor/store'
import { prefs, setPrefs } from '../editor/prefs'
import { uuid, type Guide } from '../model/types'
import { requestOverlay, view, hitSlop } from '../ui/canvasState'
import { snapGuide } from './snap'
import type { Pointer } from './tool'

export const rulerSize = 18

// The guide within 5 points of a stage point, if any.
export function guideAt(screen: [number, number]): Guide | undefined {
  return store.doc.guides.find(g => g.axis === 'vertical' ? Math.abs(view.toScreen(g.position, 0)[0] - screen[0]) <= 5 * hitSlop() : Math.abs(view.toScreen(0, g.position)[1] - screen[1]) <= 5 * hitSlop())
}

let dragging: { id: string; axis: Guide['axis']; isNew: boolean } | null = null
export const guideDrag = () => dragging

// Starts dragging a guide: an existing one (Move tool), or a new one pulled out of a ruler. The top ruler makes horizontal guides.
export function startGuideDrag(axis: Guide['axis'], id: string | null, p: Pointer) {
  store.beginGesture(id ? 'Move Guide' : 'New Guide')
  const isNew = !id
  if (!id) {
    if (!prefs.guides) setPrefs({ guides: true })
    const guide: Guide = { id: uuid(), axis, position: axis === 'vertical' ? Math.round(p.point[0]) : Math.round(p.point[1]) }
    store.set({ doc: { ...store.doc, guides: [...store.doc.guides, guide] } })
    id = guide.id
  }
  dragging = { id, axis, isNew }
}

export function moveGuideDrag(p: Pointer) {
  if (!dragging) return false
  const { id, axis } = dragging
  const position = Math.round(snapGuide(axis, axis === 'vertical' ? p.point[0] : p.point[1], id))
  store.set({ doc: { ...store.doc, guides: store.doc.guides.map(g => g.id === id ? { ...g, position } : g) } })
  requestOverlay()
  return true
}

// Dropping a guide back on a ruler removes it.
export function endGuideDrag(p: Pointer) {
  if (!dragging) return false
  const { id, isNew } = dragging
  dragging = null
  const overRuler = p.screen[0] < (prefs.rulers ? rulerSize : 0) || p.screen[1] < (prefs.rulers ? rulerSize : 0)
  if (overRuler && isNew) store.cancelGesture()
  else if (overRuler) {
    store.set({ doc: { ...store.doc, guides: store.doc.guides.filter(g => g.id !== id) } })
    store.endGesture()
    store.history.renameLast('Delete Guide')
  } else store.endGesture()
  requestOverlay()
  return true
}

export function cancelGuideDrag() { if (dragging) { dragging = null; store.cancelGesture(); requestOverlay() } }

export function clearGuides() { if (store.doc.guides.length) store.commit('Clear Guides', { doc: { ...store.doc, guides: [] } }) }
