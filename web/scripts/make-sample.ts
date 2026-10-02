import { writeFileSync, mkdirSync } from 'node:fs'
import { Raster } from '../src/model/raster'
import { writeProject } from '../src/io/project'
import { zipPackage } from '../src/io/files'
import { fullTransform, newAdjustment, newLayer, type Doc } from '../src/model/types'

// Builds public/samples/Sample.comp.zip, a small project that exercises folders, masks, clipping, blend modes, effects and adjustments.
const W = 1600, H = 1000

function paint(width: number, height: number, color: (x: number, y: number) => [number, number, number, number]) {
  const raster = new Raster(width, height, 4)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const [r, g, b, a] = color(x, y), i = (y * width + x) * 4
    raster.data[i] = Math.round(r * a / 255); raster.data[i + 1] = Math.round(g * a / 255); raster.data[i + 2] = Math.round(b * a / 255); raster.data[i + 3] = Math.round(a)
  }
  return raster
}
const smooth = (e0: number, e1: number, x: number) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t) }

const sky = paint(W, H, (x, y) => { const t = y / H; return [20 + 200 * t, 30 + 90 * t, 90 + 60 * (1 - t), 255] })
const sun = paint(500, 500, (x, y) => { const d = Math.hypot(x - 250, y - 250); return [255, 210, 120, 255 * (1 - smooth(200, 240, d))] })
const hills = paint(W, 500, (x, y) => { const top = 220 + 80 * Math.sin(x / 210) + 40 * Math.sin(x / 67); return [30, 60 + y / 8, 50, 255 * smooth(top - 1.5, top + 1.5, y)] })
const stripes = paint(W, H, (x, y) => (Math.floor((x + y) / 40) % 2 ? [255, 120, 40, 255] : [40, 120, 255, 255]))
const card = paint(560, 340, (x, y) => { const r = 40, dx = Math.max(r - x, x - (560 - r), 0), dy = Math.max(r - y, y - (340 - r), 0); return [245, 245, 240, 255 * (1 - smooth(r - 1, r + 1, Math.hypot(dx, dy)))] })
const ring = paint(300, 300, (x, y) => { const d = Math.hypot(x - 150, y - 150); return [255, 255, 255, 255 * smooth(1.5, -1.5, Math.abs(d - 120) - 18)] })
const vignette = new Raster(64, 40, 1)
for (let y = 0; y < 40; y++) for (let x = 0; x < 64; x++) vignette.data[y * 64 + x] = Math.round(255 * (1 - smooth(0.55, 1.05, Math.hypot((x - 32) / 32, (y - 20) / 20))))

const folder = newLayer({ name: 'Landscape', isGroup: true, transform: fullTransform(W, H), mask: vignette })
const curves = newAdjustment('Curves')
curves.curves.channels[1] = [{ x: 0, y: 0 }, { x: 120, y: 147 }, { x: 255, y: 255 }]
curves.curves.channels[3] = [{ x: 0, y: 20 }, { x: 115, y: 97 }, { x: 255, y: 238 }]
const hue = newAdjustment('Hue/Saturation')
hue.hsvSettings!.adjustments.Master = { hue: 0, saturation: 25, lightness: 0 }
const grain = newAdjustment('Grain')
grain.grainSettings = { amount: 18, size: 1.5, roughness: 50, seed: 7 }
const cardLayer = newLayer({ name: 'Card', image: card, transform: { ...fullTransform(560, 340, 960, 560), rotation: -6 }, effects: { shadow: { angle: 90, distance: 24, blur: 30, red: 0, green: 0, blue: 0, opacity: 0.55 }, stroke: { size: 3, red: 0.1, green: 0.1, blue: 0.1, opacity: 1, inside: true } } })
const doc: Doc = {
  id: crypto.randomUUID().toUpperCase(), width: W, height: H, resolution: 72, guides: [], extra: {},
  layers: [
    newLayer({ name: 'Sky', image: sky, transform: fullTransform(W, H) }),
    folder,
    newLayer({ name: 'Sun', image: sun, transform: fullTransform(500, 500, 980, 120), parentId: folder.id, blendMode: 'Screen' }),
    newLayer({ name: 'Hills', image: hills, transform: fullTransform(W, 500, 0, 500), parentId: folder.id }),
    newLayer({ name: 'Warm Grade', adjustment: curves, transform: fullTransform(W, H), parentId: folder.id }),
    cardLayer,
    newLayer({ name: 'Stripes (clipped)', image: stripes, transform: fullTransform(W, H), clipTo: cardLayer.id, opacity: 0.35, blendMode: 'Multiply' }),
    newLayer({ name: 'Ring', image: ring, transform: fullTransform(300, 300, 200, 160), blendMode: 'Overlay', effects: { outerGlow: { size: 18, red: 1, green: 0.85, blue: 0.5, opacity: 0.8 } } }),
    newLayer({ name: 'Vibrance', adjustment: hue, transform: fullTransform(W, H) }),
    newLayer({ name: 'Film Grain', adjustment: grain, transform: fullTransform(W, H), opacity: 0.8 }),
  ],
}
mkdirSync(new URL('../public/samples', import.meta.url), { recursive: true })
writeFileSync(new URL('../public/samples/Sample.comp.zip', import.meta.url), zipPackage('Sample', writeProject(doc, cardLayer.id)))
console.log('wrote public/samples/Sample.comp.zip')
