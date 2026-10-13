import { useEffect, useReducer, useRef, useSyncExternalStore } from 'react'
import { store } from '../editor/store'
import { prefs, subscribePrefs } from '../editor/prefs'
import { canvasOnly, compositor, requestRender, subscribeCanvasOnly, subscribeView, view, viewChanged } from './canvasState'
import { useEditor } from './hooks'

// The most room the document takes, fitted inside keeping its proportions, and the picture's pixels on its longer side.
const largest = [126, 90], picturePixels = 300

// View › Navigator (NavigatorMinimap.swift): from 300% zoom, the whole document in small in the canvas's top right, with a box in the
// accent color around what the canvas shows. Clicking or dragging in it moves the view there. Its picture is redrawn a moment after
// edits settle, and only while it shows.
export function Navigator() {
  const state = useEditor()
  useSyncExternalStore(subscribePrefs, () => prefs)
  const only = useSyncExternalStore(subscribeCanvasOnly, () => canvasOnly)
  const [, redraw] = useReducer((n: number) => n + 1, 0)
  useEffect(() => subscribeView(redraw), [])
  const canvas = useRef<HTMLCanvasElement>(null), drawn = useRef(false)
  const { width: docWidth, height: docHeight } = state.doc
  const shown = prefs.navigator && !only && store.hasDocument && view.zoom >= 3
  useEffect(() => {
    if (!shown) { drawn.current = false; return }
    // Edits settle first, so a stroke or a drag redraws the picture once, afterwards.
    const timer = setTimeout(() => {
      const picture = compositor?.thumbnail(picturePixels), element = canvas.current
      if (!picture || !element) return
      element.width = picture.width; element.height = picture.height
      const image = new ImageData(picture.width, picture.height), p = picture.data
      for (let i = 0; i < p.length; i += 4) { const a = p[i + 3]; if (a) for (let c = 0; c < 3; c++) image.data[i + c] = Math.min(255, Math.round(p[i + c] * 255 / a)); image.data[i + 3] = a }
      element.getContext('2d')!.putImageData(image, 0, 0)
      drawn.current = true
    }, drawn.current ? 250 : 30)
    return () => clearTimeout(timer)
  }, [shown, state.doc, state.pixelRevision])
  if (!shown) return null
  const scale = Math.min(largest[0] / docWidth, largest[1] / docHeight), width = Math.round(docWidth * scale), height = Math.round(docHeight * scale)
  const [x0, y0] = view.toDocument(0, 0), [x1, y1] = view.toDocument(view.width, view.height)
  const box = { left: Math.max(0, x0 * scale), top: Math.max(0, y0 * scale), right: Math.min(width, x1 * scale), bottom: Math.min(height, y1 * scale) }
  const move = (event: React.PointerEvent) => {
    const rect = event.currentTarget.getBoundingClientRect()
    const x = Math.min(docWidth, Math.max(0, (event.clientX - rect.left) / scale)), y = Math.min(docHeight, Math.max(0, (event.clientY - rect.top) / scale))
    view.offsetX = view.width / 2 - x * view.zoom; view.offsetY = view.height / 2 - y * view.zoom
    viewChanged(); requestRender(false)
  }
  return (
    <div className="navigator" style={{ width, height }} title="Navigator: click or drag to move the view"
      onPointerDown={e => { e.currentTarget.setPointerCapture(e.pointerId); move(e) }} onPointerMove={e => { if (e.buttons) move(e) }}>
      <canvas ref={canvas} style={{ width, height }} />
      {box.right > box.left && box.bottom > box.top && <div className="navigator-box" style={{ left: box.left, top: box.top, width: Math.max(3, box.right - box.left), height: Math.max(3, box.bottom - box.top) }} />}
    </div>
  )
}
