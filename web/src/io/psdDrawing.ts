import { Raster, premultiply } from '../model/raster'
import { faceInstalled, rasterizeText } from '../render/text'
import { rasterizeShape } from '../tools/shape'
import type { PSDDrawing, RGB } from './psd'

const css = ([r, g, b]: RGB) => `rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)})`

// The browser's canvas drawing for a Photoshop import: text set as the Type tool sets it (once its face has loaded or failed to), live
// shapes as the Shape tool draws them, and vector masks filled and stroked as Core Graphics does (nonzero winding, miter joins, butt caps).
export const canvasDrawing: PSDDrawing = {
  async text(style) {
    await faceInstalled(style.fontName)
    const { raster, layout } = rasterizeText(style)
    return { raster, baseline: layout.lines[0]?.baseline ?? 12 + style.fontSize * 0.8 }
  },
  shape: (style, width, height) => rasterizeShape(style, width, height),
  path(commands, box, width, height, fill, stroke) {
    const context = new OffscreenCanvas(width, height).getContext('2d', { willReadFrequently: true })!, path = new Path2D()
    for (const command of commands) {
      if (command[0] === 'M') path.moveTo(command[1], command[2])
      else if (command[0] === 'C') path.bezierCurveTo(command[1], command[2], command[3], command[4], command[5], command[6])
      else path.closePath()
    }
    context.translate(-box.x, -box.y)
    if (fill) { context.fillStyle = css(fill); context.fill(path, 'nonzero') }
    if (stroke) {
      Object.assign(context, { strokeStyle: css(stroke.color), lineWidth: stroke.width, lineJoin: 'miter', miterLimit: 10, lineCap: 'butt' })
      context.stroke(path)
    }
    return new Raster(width, height, 4, premultiply(new Uint8Array(context.getImageData(0, 0, width, height).data.buffer)))
  },
  fontInstalled: faceInstalled,
}
