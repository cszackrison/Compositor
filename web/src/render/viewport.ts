import { type Mat3, chain, invert, scale, translate, apply } from './gl'

// Where the document sits in the stage: document point p shows at screen point p * zoom + offset (CSS pixels).
export class Viewport {
  zoom = 1
  offsetX = 0
  offsetY = 0
  constructor(public width = 1, public height = 1) {}

  fit(docWidth: number, docHeight: number, margin = 48) {
    this.zoom = Math.min(1, Math.max(0.01, Math.min((this.width - margin * 2) / docWidth, (this.height - margin * 2) / docHeight)))
    this.offsetX = Math.round((this.width - docWidth * this.zoom) / 2)
    this.offsetY = Math.round((this.height - docHeight * this.zoom) / 2)
  }
  zoomAt(factor: number, screenX: number, screenY: number) {
    const next = Math.min(64, Math.max(0.01, this.zoom * factor))
    const [docX, docY] = this.toDocument(screenX, screenY)
    this.zoom = next
    this.offsetX = screenX - docX * next
    this.offsetY = screenY - docY * next
  }
  toDocument(x: number, y: number): [number, number] { return [(x - this.offsetX) / this.zoom, (y - this.offsetY) / this.zoom] }
  toScreen(x: number, y: number): [number, number] { return [x * this.zoom + this.offsetX, y * this.zoom + this.offsetY] }
  get documentToScreen(): Mat3 { return chain(translate(this.offsetX, this.offsetY), scale(this.zoom)) }
  get screenToDocument(): Mat3 { return invert(this.documentToScreen) }
  // The document rectangle visible on screen.
  visible(docWidth: number, docHeight: number) {
    const [x0, y0] = apply(this.screenToDocument, 0, 0), [x1, y1] = apply(this.screenToDocument, this.width, this.height)
    return { x: Math.max(0, x0), y: Math.max(0, y0), w: Math.min(docWidth, x1) - Math.max(0, x0), h: Math.min(docHeight, y1) - Math.max(0, y0) }
  }
}
