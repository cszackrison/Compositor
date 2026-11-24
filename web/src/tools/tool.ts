// A pointer event on the canvas, in document pixels and stage (CSS) pixels, with the Mac's modifier names. On Windows and Linux,
// Control plays Command's part, as browsers expect, so `command` is Control there and `control` stays false.
export type Pointer = { point: [number, number]; screen: [number, number]; shift: boolean; alt: boolean; command: boolean; control: boolean; button: number; clicks: number; coalesced: [number, number][]; pressure?: number; predicted?: [number, number] }

// What a canvas tool does. Stage routes pointer and key events to the active tool and asks it to draw its overlay.
export interface ToolHandler {
  down?(p: Pointer): void
  move?(p: Pointer): void
  up?(p: Pointer): void
  hover?(p: Pointer): void
  // Return or Enter, Escape, and other keys while the tool is active; true when the tool used the key.
  key?(event: KeyboardEvent): boolean
  draw?(context: CanvasRenderingContext2D): void
  cursor?(p: Pointer | null): string
  // Whether a drag or pending edit is in progress (so menus and shortcuts that would disturb it wait).
  busy?(): boolean
  // The pointer left the canvas (or a finger lifted): forget where it was, so no cursor is drawn there.
  leave?(): void
  // Finishes or cancels a pending edit when the tool, layer or tab changes.
  settle?(): void
}

export const dashedPath = (context: CanvasRenderingContext2D) => {
  context.setLineDash([4, 4])
  context.strokeStyle = '#fff'; context.lineDashOffset = 0; context.stroke()
  context.strokeStyle = '#000'; context.lineDashOffset = 4; context.stroke()
  context.setLineDash([])
}

export const outlined = (context: CanvasRenderingContext2D, outer = 3, inner = 1) => {
  context.strokeStyle = 'rgba(0,0,0,0.7)'; context.lineWidth = outer; context.stroke()
  context.strokeStyle = '#fff'; context.lineWidth = inner; context.stroke()
}

// Dark floating label beside the pointer during drags: marquee size, shape size, line length, resize dimensions, or rotation angle
// (TransformOverlay.drawDragOutSize). Positioned above and right of `anchor`, flipping to stay inside the viewport.
export function drawHudLabel(context: CanvasRenderingContext2D, text: string, anchor: [number, number], viewWidth: number, viewHeight: number) {
  context.save()
  context.font = '500 11px ui-monospace, "SF Mono", Menlo, monospace'
  const metrics = context.measureText(text)
  const w = Math.ceil(metrics.width) + 12, h = 20
  let x = anchor[0] + 14, y = anchor[1] - 14 - h
  if (x + w > viewWidth - 4) x = anchor[0] - 14 - w
  if (y < 4) y = anchor[1] + 14
  if (x < 4) x = 4
  if (y + h > viewHeight - 4) y = viewHeight - 4 - h
  context.fillStyle = 'rgba(30, 30, 30, 0.9)'
  context.beginPath()
  context.roundRect(x, y, w, h, 4)
  context.fill()
  context.fillStyle = '#fff'
  context.textBaseline = 'middle'
  context.fillText(text, x + 6, y + h / 2 + 0.5)
  context.restore()
}

// Curved double-arrow rotate pointer rotated to wrap around a transform box corner (TransformOverlay.rotateCursor).
const rotateCursors = new Map<number, string>()
export function rotateCursor(angleDeg: number): string {
  const key = ((Math.round(angleDeg / 5) * 5) % 360 + 360) % 360
  let cached = rotateCursors.get(key)
  if (!cached) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><g transform="rotate(${key} 12 12)" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M7.5 15.5 A7 7 0 0 1 15.5 7.5" stroke="#fff" stroke-width="3.6"/><path d="M6 12.2 L7.5 16.5 L11.5 14.8 M12.2 6 L16.5 7.5 L14.8 11.5" stroke="#fff" stroke-width="3.2"/><path d="M7.5 15.5 A7 7 0 0 1 15.5 7.5" stroke="#000" stroke-width="1.6"/><path d="M6 12.2 L7.5 16.5 L11.5 14.8 M12.2 6 L16.5 7.5 L14.8 11.5" stroke="#000" stroke-width="1.4"/></g></svg>`
    cached = `url("data:image/svg+xml,${encodeURIComponent(svg)}") 12 12, alias`
    rotateCursors.set(key, cached)
  }
  return cached
}

// Photoshop's two stemless arrowheads for Option-drag duplication (547ae0e).
const dupSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path d="M8 7 L8 20 L12 16 L17 16 Z" fill="#fff" stroke="#000" stroke-width="1.2" stroke-linejoin="round"/><path d="M4 3 L4 16 L8 12 L13 12 Z" fill="#000" stroke="#fff" stroke-width="1.2" stroke-linejoin="round"/></svg>`
export const duplicateCursor = `url("data:image/svg+xml,${encodeURIComponent(dupSvg)}") 4 3, copy`
