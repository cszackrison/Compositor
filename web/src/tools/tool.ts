// A pointer event on the canvas, in document pixels and stage (CSS) pixels, with the Mac's modifier names. On Windows and Linux,
// Control plays Command's part, as browsers expect, so `command` is Control there and `control` stays false.
export type Pointer = { point: [number, number]; screen: [number, number]; shift: boolean; alt: boolean; command: boolean; control: boolean; button: number; clicks: number; coalesced: [number, number][] }

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
