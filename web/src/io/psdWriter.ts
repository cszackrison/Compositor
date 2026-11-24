import { type BlendMode, type Doc, type Layer, type Transform, maxSide } from '../model/types'
import { Raster } from '../model/raster'
import { deepOf, flattened, hdrTo16, isDeep } from '../model/deep'
import { maskOnGrid } from '../model/masks'
import { hasVisibleEffects, renderEffects } from '../render/effects'
import { pixelToDocument, transformCorners } from '../render/compositor'
import { apply, invert } from '../render/gl'

// Layered Photoshop .psd writer (PSDWriter.swift): writes pixel layers with their names, places, opacity, visibility, blend
// modes and masks, folders as groups, and clipping stacks, plus a flattened composite for apps that don't read layers. Text and
// effects go out as pixels; adjustment layers are left out. With any 16-bit or HDR layer in the document, the file is 16 bits a
// channel.

export type PSDNote = { layerName: string; change: 'textAsPixels' | 'effectsAsPixels' | 'adjustmentLeftOut' }

// What writePSD will change, in layer order, top first.
export function psdNotes(doc: Doc): PSDNote[] {
  const notes: PSDNote[] = []
  for (let i = doc.layers.length - 1; i >= 0; i--) {
    const layer = doc.layers[i]
    if (layer.adjustment) { notes.push({ layerName: layer.name, change: 'adjustmentLeftOut' }); continue }
    if (layer.isGroup) continue
    if (hasVisibleEffects(layer.effects)) { notes.push({ layerName: layer.name, change: 'effectsAsPixels' }); continue }
    if (layer.text !== undefined && layer.text !== null) notes.push({ layerName: layer.name, change: 'textAsPixels' })
  }
  return notes
}

// The notes as a line or two for the Export As sheet, null when nothing changes.
export function psdSummary(notes: PSDNote[]): string | null {
  const names = (change: PSDNote['change']) => {
    const matching = notes.filter(n => n.change === change).map(n => n.layerName)
    if (!matching.length) return null
    const shown = matching.slice(0, 3).map(n => `“${n}”`).join(', ')
    return matching.length > 3 ? `${shown} and ${matching.length - 3} more` : shown
  }
  const lines = [
    names('textAsPixels') && `Text drawn as pixels: ${names('textAsPixels')}`,
    names('effectsAsPixels') && `Effects drawn into the pixels: ${names('effectsAsPixels')}`,
    names('adjustmentLeftOut') && `Adjustment layers left out: ${names('adjustmentLeftOut')}`,
  ].filter(Boolean) as string[]
  return lines.length ? lines.join('\n') : null
}

const psdBlendKeys: Record<BlendMode, string> = {
  Normal: 'norm', Multiply: 'mul ', Screen: 'scrn', Overlay: 'over', 'Soft Light': 'sLit', Darken: 'dark', Lighten: 'lite',
  Difference: 'diff', 'Color Dodge': 'div ', 'Color Burn': 'idiv', Hue: 'hue ', Saturation: 'sat ', Color: 'colr',
  Luminosity: 'lum ', 'Linear Burn': 'lbrn', 'Linear Dodge (Add)': 'lddg', 'Hard Light': 'hLit', 'Vivid Light': 'vLit',
  'Linear Light': 'lLit', 'Pin Light': 'pLit', 'Hard Mix': 'hMix', Exclusion: 'smud', Subtract: 'fsub', Divide: 'fdiv',
}

class PSDBytes {
  private buf = new Uint8Array(4096)
  private pos = 0
  get length() { return this.pos }
  private ensure(extra: number) {
    const need = this.pos + extra
    if (need <= this.buf.length) return
    let size = this.buf.length * 2
    while (size < need) size *= 2
    const next = new Uint8Array(size)
    next.set(this.buf.subarray(0, this.pos))
    this.buf = next
  }
  u8(v: number) { this.ensure(1); this.buf[this.pos++] = v & 0xff }
  u16(v: number) { this.ensure(2); this.buf[this.pos++] = (v >> 8) & 0xff; this.buf[this.pos++] = v & 0xff }
  i16(v: number) { this.u16(v < 0 ? v + 0x10000 : v) }
  u32(v: number) { this.ensure(4); this.buf[this.pos++] = (v >>> 24) & 0xff; this.buf[this.pos++] = (v >>> 16) & 0xff; this.buf[this.pos++] = (v >>> 8) & 0xff; this.buf[this.pos++] = v & 0xff }
  i32(v: number) { this.u32(v | 0) }
  zeros(n: number) { if (n > 0) { this.ensure(n); this.buf.fill(0, this.pos, this.pos + n); this.pos += n } }
  ascii(text: string) {
    this.ensure(text.length)
    for (let i = 0; i < text.length; i++) this.buf[this.pos++] = text.charCodeAt(i) & 0xff
  }
  data(bytes: Uint8Array, lengthPrefixed = false) {
    if (lengthPrefixed) this.u32(bytes.length)
    if (bytes.length) { this.ensure(bytes.length); this.buf.set(bytes, this.pos); this.pos += bytes.length }
  }
  block(key: string, body: Uint8Array) {
    this.ascii('8BIM'); this.ascii(key)
    const padded = body.length + (body.length % 2)
    this.u32(padded); this.data(body); this.zeros(padded - body.length)
  }
  toBytes(): Uint8Array<ArrayBuffer> {
    return this.buf.slice(0, this.pos) as Uint8Array<ArrayBuffer>
  }
}

// Photoshop's PackBits run-length compression, one row at a time.
export function packBitsRow(row: Uint8Array): Uint8Array {
  const n = row.length
  const out = new Uint8Array(n + Math.ceil(n / 128) + 2)
  let o = 0, i = 0
  while (i < n) {
    const v = row[i]
    let run = 1
    while (i + run < n && run < 128 && row[i + run] === v) run++
    if (run >= 3) {
      out[o++] = (257 - run) & 0xff
      out[o++] = v
      i += run
      continue
    }
    let end = i + run
    while (end < n && end - i < 128) {
      if (end + 2 < n && row[end] === row[end + 1] && row[end] === row[end + 2]) break
      end++
    }
    const len = end - i
    out[o++] = len - 1
    out.set(row.subarray(i, end), o)
    o += len
    i = end
  }
  return out.subarray(0, o)
}

function packBitsRows(plane: Uint8Array, width: number, height: number): Uint8Array[] {
  const rows: Uint8Array[] = []
  for (let y = 0; y < height; y++) rows.push(packBitsRow(plane.subarray(y * width, (y + 1) * width)))
  return rows
}

function channelData(plane: Uint8Array, width: number, height: number, sixteenBit: boolean): Uint8Array {
  const out = new PSDBytes()
  if (sixteenBit || width === 0 || height === 0) {
    out.u16(0); out.data(plane)
    return out.toBytes()
  }
  const rows = packBitsRows(plane, width, height)
  out.u16(1)
  for (const row of rows) out.u16(row.length)
  for (const row of rows) out.data(row)
  return out.toBytes()
}

type Rect = { top: number; left: number; bottom: number; right: number }
const emptyRect: Rect = { top: 0, left: 0, bottom: 0, right: 0 }

type LayerRecord = {
  name: string
  rect: Rect
  channels: { id: number; data: Uint8Array }[]
  blendKey: string
  opacity: number
  clipping: boolean
  hidden: boolean
  mask?: { rect: Rect; defaultValue: number; disabled: boolean; unlinked: boolean }
  section?: number
}

const emptyChannels = (): { id: number; data: Uint8Array }[] => [0, 1, 2, -1].map(id => ({ id, data: new Uint8Array([0, 0]) }))

// Draws a premultiplied RGBA source (8-bit bytes or 16-bit Uint16Array) through `transform` onto `area` of the document,
// returning straight R, G, B, A planes (big-endian bytes at 16 bits).
function drawPlacedRGBA(
  source: Uint8Array | Uint16Array, srcW: number, srcH: number, transform: Transform,
  area: Rect, sixteenBit: boolean,
): Uint8Array[] {
  const w = area.right - area.left, h = area.bottom - area.top, bytes = sixteenBit ? 2 : 1
  const rP = new Uint8Array(w * h * bytes), gP = new Uint8Array(w * h * bytes), bP = new Uint8Array(w * h * bytes), aP = new Uint8Array(w * h * bytes)
  const planes = [rP, gP, bP, aP]
  const is16 = source instanceof Uint16Array
  const scale = is16 ? 1 : sixteenBit ? 257 : 1
  const maxVal = sixteenBit ? 65535 : 255

  // Fast path for unrotated, unflipped, 1:1 integer-aligned layers (the common case for shapes, painted layers, and baked effects).
  const ox = Math.round(transform.origin[0]), oy = Math.round(transform.origin[1])
  if (
    transform.rotation === 0 && !transform.flipX && !transform.flipY &&
    Math.abs(transform.size[0] - srcW) < 1e-4 && Math.abs(transform.size[1] - srcH) < 1e-4 &&
    Math.abs(transform.origin[0] - ox) < 1e-4 && Math.abs(transform.origin[1] - oy) < 1e-4
  ) {
    const xStart = Math.max(0, ox - area.left), xEnd = Math.min(w, ox + srcW - area.left)
    const yStart = Math.max(0, oy - area.top), yEnd = Math.min(h, oy + srcH - area.top)
    if (!sixteenBit) {
      for (let y = yStart; y < yEnd; y++) {
        const sy = area.top + y - oy, srcRow = sy * srcW, dstRow = y * w
        for (let x = xStart; x < xEnd; x++) {
          const sp = (srcRow + (area.left + x - ox)) * 4
          const a = source[sp + 3]
          if (a === 0) continue
          const i = dstRow + x
          if (a === 255) {
            rP[i] = source[sp]; gP[i] = source[sp + 1]; bP[i] = source[sp + 2]; aP[i] = 255
          } else {
            const inv = 255 / a
            const rv = (source[sp] * inv + 0.5) | 0, gv = (source[sp + 1] * inv + 0.5) | 0, bv = (source[sp + 2] * inv + 0.5) | 0
            rP[i] = rv > 255 ? 255 : rv; gP[i] = gv > 255 ? 255 : gv; bP[i] = bv > 255 ? 255 : bv; aP[i] = a
          }
        }
      }
      return planes
    }
    for (let y = yStart; y < yEnd; y++) {
      const sy = area.top + y - oy, srcRow = sy * srcW, dstRow = y * w
      for (let x = xStart; x < xEnd; x++) {
        const sp = (srcRow + (area.left + x - ox)) * 4
        const a = source[sp + 3] * scale
        if (a === 0) continue
        let rv: number, gv: number, bv: number
        if (a === 65535) {
          rv = source[sp] * scale; gv = source[sp + 1] * scale; bv = source[sp + 2] * scale
        } else {
          const inv = 65535 / a
          rv = Math.min(65535, Math.round(source[sp] * scale * inv))
          gv = Math.min(65535, Math.round(source[sp + 1] * scale * inv))
          bv = Math.min(65535, Math.round(source[sp + 2] * scale * inv))
        }
        const i2 = (dstRow + x) * 2
        rP[i2] = (rv >> 8) & 0xff; rP[i2 + 1] = rv & 0xff
        gP[i2] = (gv >> 8) & 0xff; gP[i2 + 1] = gv & 0xff
        bP[i2] = (bv >> 8) & 0xff; bP[i2 + 1] = bv & 0xff
        aP[i2] = (a >> 8) & 0xff; aP[i2 + 1] = a & 0xff
      }
    }
    return planes
  }

  const toSrc = invert(pixelToDocument(transform, srcW, srcH))
  const m0 = toSrc[0], m1 = toSrc[1], m3 = toSrc[3], m4 = toSrc[4], m6 = toSrc[6], m7 = toSrc[7]
  const nearest = transform.sampling === 'Nearest'
  const aLeft = area.left + 0.5, aTop = area.top + 0.5
  for (let y = 0; y < h; y++) {
    const dy = aTop + y, rowSx = m3 * dy + m6, rowSy = m4 * dy + m7, dstRow = y * w
    for (let x = 0; x < w; x++) {
      const dx = aLeft + x
      const sx = m0 * dx + rowSx, sy = m1 * dx + rowSy
      if (sx < -0.5 || sy < -0.5 || sx > srcW + 0.5 || sy > srcH + 0.5) continue
      let r = 0, g = 0, b = 0, a = 0
      if (nearest) {
        const ix = Math.floor(sx), iy = Math.floor(sy)
        if (ix < 0 || iy < 0 || ix >= srcW || iy >= srcH) continue
        const p = (iy * srcW + ix) * 4
        r = source[p] * scale; g = source[p + 1] * scale; b = source[p + 2] * scale; a = source[p + 3] * scale
      } else {
        const fx = sx - 0.5, fy = sy - 0.5, x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0
        const w00 = (1 - tx) * (1 - ty), w10 = tx * (1 - ty), w01 = (1 - tx) * ty, w11 = tx * ty
        const x1 = x0 + 1, y1 = y0 + 1
        if (x0 >= 0 && y0 >= 0 && x1 < srcW && y1 < srcH) {
          const p00 = (y0 * srcW + x0) * 4, p10 = p00 + 4, p01 = p00 + srcW * 4, p11 = p01 + 4
          r = (source[p00] * w00 + source[p10] * w10 + source[p01] * w01 + source[p11] * w11) * scale
          g = (source[p00 + 1] * w00 + source[p10 + 1] * w10 + source[p01 + 1] * w01 + source[p11 + 1] * w11) * scale
          b = (source[p00 + 2] * w00 + source[p10 + 2] * w10 + source[p01 + 2] * w01 + source[p11 + 2] * w11) * scale
          a = (source[p00 + 3] * w00 + source[p10 + 3] * w10 + source[p01 + 3] * w01 + source[p11 + 3] * w11) * scale
        } else {
          const add = (ix: number, iy: number, wt: number) => {
            if (ix < 0 || iy < 0 || ix >= srcW || iy >= srcH) return
            const p = (iy * srcW + ix) * 4, ws = wt * scale
            r += source[p] * ws; g += source[p + 1] * ws; b += source[p + 2] * ws; a += source[p + 3] * ws
          }
          add(x0, y0, w00); add(x1, y0, w10); add(x0, y1, w01); add(x1, y1, w11)
        }
      }
      const alpha = a <= 0 ? 0 : a >= maxVal ? maxVal : (a + 0.5) | 0
      if (alpha === 0) continue
      const inv = maxVal / alpha
      let rv = (r * inv + 0.5) | 0, gv = (g * inv + 0.5) | 0, bv = (b * inv + 0.5) | 0
      if (rv < 0) rv = 0; else if (rv > maxVal) rv = maxVal
      if (gv < 0) gv = 0; else if (gv > maxVal) gv = maxVal
      if (bv < 0) bv = 0; else if (bv > maxVal) bv = maxVal
      const i = dstRow + x
      if (sixteenBit) {
        const i2 = i * 2
        rP[i2] = (rv >> 8) & 0xff; rP[i2 + 1] = rv & 0xff
        gP[i2] = (gv >> 8) & 0xff; gP[i2 + 1] = gv & 0xff
        bP[i2] = (bv >> 8) & 0xff; bP[i2 + 1] = bv & 0xff
        aP[i2] = (alpha >> 8) & 0xff; aP[i2 + 1] = alpha & 0xff
      } else {
        rP[i] = rv; gP[i] = gv; bP[i] = bv; aP[i] = alpha
      }
    }
  }
  return planes
}

// Draws a 1-channel mask raster through `transform` onto `area` (filled with `bg` outside), returning one plane (big-endian at 16 bits).
function drawPlacedGray(mask: Raster, transform: Transform, area: Rect, bg: number, sixteenBit: boolean): Uint8Array {
  const w = area.right - area.left, h = area.bottom - area.top, bytes = sixteenBit ? 2 : 1
  const out = new Uint8Array(w * h * bytes)
  const toSrc = invert(pixelToDocument(transform, mask.width, mask.height))
  const scale = sixteenBit ? 257 : 1
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [sx, sy] = apply(toSrc, area.left + x + 0.5, area.top + y + 0.5)
      let v = bg
      if (sx >= 0 && sy >= 0 && sx < mask.width && sy < mask.height) {
        const fx = sx - 0.5, fy = sy - 0.5, x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0
        const sample = (ix: number, iy: number) => mask.data[Math.min(mask.height - 1, Math.max(0, iy)) * mask.width + Math.min(mask.width - 1, Math.max(0, ix))]
        v = (sample(x0, y0) * (1 - tx) + sample(x0 + 1, y0) * tx) * (1 - ty) + (sample(x0, y0 + 1) * (1 - tx) + sample(x0 + 1, y0 + 1) * tx) * ty
      }
      const val = Math.min(sixteenBit ? 65535 : 255, Math.max(0, Math.round(v * scale)))
      const i = y * w + x
      if (sixteenBit) { out[i * 2] = (val >> 8) & 0xff; out[i * 2 + 1] = val & 0xff } else out[i] = val
    }
  }
  return out
}

function trimAlpha(alpha: Uint8Array, w: number, h: number, sixteenBit: boolean): Rect | null {
  const bytes = sixteenBit ? 2 : 1
  let minX = w, minY = h, maxX = -1, maxY = -1
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * bytes
      if (alpha[p] !== 0 || (sixteenBit && alpha[p + 1] !== 0)) {
        if (x < minX) minX = x; if (x > maxX) maxX = x
        if (y < minY) minY = y; if (y > maxY) maxY = y
      }
    }
  }
  return maxX >= minX && maxY >= minY ? { left: minX, top: minY, right: maxX + 1, bottom: maxY + 1 } : null
}

function cropPlane(plane: Uint8Array, w: number, r: Rect, sixteenBit: boolean): Uint8Array {
  const bytes = sixteenBit ? 2 : 1, cw = r.right - r.left, ch = r.bottom - r.top
  if (r.left === 0 && r.top === 0 && cw === w) return plane.subarray(0, cw * ch * bytes)
  const out = new Uint8Array(cw * ch * bytes)
  for (let y = 0; y < ch; y++) {
    const start = ((r.top + y) * w + r.left) * bytes
    out.set(plane.subarray(start, start + cw * bytes), y * cw * bytes)
  }
  return out
}

function placedBounds(t: Transform, docW: number, docH: number): Rect | null {
  const c = transformCorners(t)
  const left = Math.max(0, Math.floor(Math.min(...c.map(p => p[0]))))
  const top = Math.max(0, Math.floor(Math.min(...c.map(p => p[1]))))
  const right = Math.min(docW, Math.ceil(Math.max(...c.map(p => p[0]))))
  const bottom = Math.min(docH, Math.ceil(Math.max(...c.map(p => p[1]))))
  return right > left && bottom > top ? { left, top, right, bottom } : null
}

function layerMaskGrid(layer: Layer): Raster | null {
  if (!layer.mask || !layer.image) return null
  if (!layer.maskPlacement) return layer.mask
  const { width, height } = layer.image, levels = maskOnGrid(layer.mask, layer.maskPlacement, layer.transform, width, height)
  const out = new Raster(width, height, 1)
  for (let i = 0; i < levels.length; i++) out.data[i] = Math.round(levels[i] * 255)
  return out
}

function layerRecord(layer: Layer, doc: Doc, sixteenBit: boolean): LayerRecord {
  const record: LayerRecord = {
    name: layer.name, rect: emptyRect, channels: emptyChannels(),
    blendKey: psdBlendKeys[layer.blendMode] ?? 'norm',
    opacity: layer.opacity, clipping: !!layer.clipTo, hidden: !layer.visible,
  }
  if (!layer.image) return record
  const maskGrid = layerMaskGrid(layer)
  const activeMask = layer.maskEnabled ? maskGrid : null
  const effects = hasVisibleEffects(layer.effects) ? renderEffects(layer.image, activeMask, layer.effects!) : null
  let placement = layer.transform
  let srcPixels: Uint8Array | Uint16Array = layer.image.data, srcW = layer.image.width, srcH = layer.image.height
  if (effects) {
    const sx = effects.raster.width / (effects.raster.width - 2 * effects.inset)
    const sy = effects.raster.height / (effects.raster.height - 2 * effects.inset)
    placement = {
      ...layer.transform,
      origin: [layer.transform.origin[0] + layer.transform.size[0] / 2 - layer.transform.size[0] * sx / 2, layer.transform.origin[1] + layer.transform.size[1] / 2 - layer.transform.size[1] * sy / 2],
      size: [layer.transform.size[0] * sx, layer.transform.size[1] * sy],
    }
    srcPixels = effects.raster.data; srcW = effects.raster.width; srcH = effects.raster.height
  } else if (sixteenBit) {
    const deep = deepOf(layer)
    if (deep) {
      const flat = flattened(deep)
      srcPixels = deep.hdr ? hdrTo16(flat) : flat
      srcW = deep.width; srcH = deep.height
    }
  }
  const area = placedBounds(placement, doc.width, doc.height)
  if (!area) return record
  const areaW = area.right - area.left, areaH = area.bottom - area.top
  let planes = drawPlacedRGBA(srcPixels, srcW, srcH, placement, area, sixteenBit)
  const trimmed = trimAlpha(planes[3], areaW, areaH, sixteenBit)
  if (!trimmed) return record
  planes = planes.map(p => cropPlane(p, areaW, trimmed, sixteenBit))
  const rect: Rect = { left: area.left + trimmed.left, top: area.top + trimmed.top, right: area.left + trimmed.right, bottom: area.top + trimmed.bottom }
  const rw = rect.right - rect.left, rh = rect.bottom - rect.top
  record.rect = rect
  record.channels = [0, 1, 2, -1].map((id, i) => ({ id, data: channelData(planes[i], rw, rh, sixteenBit) }))
  if (!effects && maskGrid && layer.mask) {
    const fullGray = drawPlacedGray(maskGrid, layer.transform, area, 255, sixteenBit)
    const gray = cropPlane(fullGray, areaW, trimmed, sixteenBit)
    record.mask = { rect, defaultValue: 255, disabled: !layer.maskEnabled, unlinked: !layer.maskLinked }
    record.channels.push({ id: -2, data: channelData(gray, rw, rh, sixteenBit) })
  }
  return record
}

function addFolderMask(folder: Layer, doc: Doc, record: LayerRecord, sixteenBit: boolean) {
  if (!folder.mask) return
  const canvas: Rect = { left: 0, top: 0, right: doc.width, bottom: doc.height }
  const gray = drawPlacedGray(folder.mask, folder.transform, canvas, 0, sixteenBit)
  record.mask = { rect: canvas, defaultValue: 0, disabled: !folder.maskEnabled, unlinked: false }
  record.channels.push({ id: -2, data: channelData(gray, doc.width, doc.height, sixteenBit) })
}

function resourcesSection(resolution: number): Uint8Array {
  const out = new PSDBytes()
  const info = new PSDBytes()
  const fixed = Math.round(Math.max(1, Math.min(9600, resolution)) * 65536)
  info.u32(fixed); info.u16(1); info.u16(1)
  info.u32(fixed); info.u16(1); info.u16(1)
  const body = info.toBytes()
  out.ascii('8BIM'); out.u16(1005); out.u16(0)
  out.u32(body.length); out.data(body)
  if (body.length % 2 === 1) out.zeros(1)
  return out.toBytes()
}

function layerSection(doc: Doc, sixteenBit: boolean): Uint8Array {
  const children = new Map<string | null, Layer[]>()
  for (const layer of doc.layers) children.set(layer.parentId, [...(children.get(layer.parentId) ?? []), layer])
  const records: LayerRecord[] = []
  const visit = (parent: string | null, depth: number) => {
    if (depth > 64) return
    for (const layer of children.get(parent) ?? []) {
      if (layer.isGroup) {
        records.push({ name: '</Layer group>', rect: emptyRect, channels: emptyChannels(), blendKey: 'norm', opacity: 1, clipping: false, hidden: false, section: 3 })
        visit(layer.id, depth + 1)
        const group: LayerRecord = { name: layer.name, rect: emptyRect, channels: emptyChannels(), blendKey: 'pass', opacity: layer.opacity, clipping: false, hidden: !layer.visible, section: 1 }
        addFolderMask(layer, doc, group, sixteenBit)
        records.push(group)
      } else if (!layer.adjustment) {
        records.push(layerRecord(layer, doc, sixteenBit))
      }
    }
  }
  visit(null, 0)

  const info = new PSDBytes()
  info.i16(-records.length)
  for (const record of records) {
    info.i32(record.rect.top); info.i32(record.rect.left); info.i32(record.rect.bottom); info.i32(record.rect.right)
    info.u16(record.channels.length)
    for (const ch of record.channels) { info.i16(ch.id); info.u32(ch.data.length) }
    info.ascii('8BIM'); info.ascii(record.blendKey)
    info.u8(Math.round(Math.min(1, Math.max(0, record.opacity)) * 255))
    info.u8(record.clipping ? 1 : 0)
    info.u8((record.hidden ? 2 : 0) | (record.section === undefined ? 0 : 8 | 16))
    info.u8(0)
    const extra = new PSDBytes()
    if (record.mask) {
      extra.u32(20)
      extra.i32(record.mask.rect.top); extra.i32(record.mask.rect.left); extra.i32(record.mask.rect.bottom); extra.i32(record.mask.rect.right)
      extra.u8(record.mask.defaultValue)
      extra.u8((record.mask.unlinked ? 1 : 0) | (record.mask.disabled ? 2 : 0))
      extra.zeros(2)
    } else extra.u32(0)
    extra.u32(0) // no blending ranges
    // Pascal string in ASCII/MacRoman, padded to a multiple of 4 bytes.
    const pascal = new Uint8Array(Math.min(255, record.name.length))
    for (let i = 0; i < pascal.length; i++) { const c = record.name.charCodeAt(i); pascal[i] = c >= 32 && c < 127 ? c : 63 }
    extra.u8(pascal.length); extra.data(pascal)
    extra.zeros((4 - (pascal.length + 1) % 4) % 4)
    const unicode = new PSDBytes()
    unicode.u32(record.name.length)
    for (let i = 0; i < record.name.length; i++) unicode.u16(record.name.charCodeAt(i))
    extra.block('luni', unicode.toBytes())
    if (record.section !== undefined) {
      const divider = new PSDBytes()
      divider.u32(record.section)
      if (record.section !== 3) { divider.ascii('8BIM'); divider.ascii(record.blendKey) }
      extra.block('lsct', divider.toBytes())
    }
    info.data(extra.toBytes(), true)
  }
  for (const record of records) for (const ch of record.channels) info.data(ch.data)
  if (info.length % 2 === 1) info.zeros(1)

  const section = new PSDBytes()
  section.data(info.toBytes(), true)
  section.u32(0) // no global layer mask
  return section.toBytes()
}

// Straight R, G, B, A planes of the flattened composite (big-endian at 16 bits).
function compositePlanes(composite: Raster, deep: Float32Array | null, sixteenBit: boolean): Uint8Array[] {
  const count = composite.width * composite.height, bytes = sixteenBit ? 2 : 1
  const rP = new Uint8Array(count * bytes), gP = new Uint8Array(count * bytes), bP = new Uint8Array(count * bytes), aP = new Uint8Array(count * bytes)
  const planes = [rP, gP, bP, aP]
  if (sixteenBit) {
    if (deep) {
      for (let i = 0; i < count; i++) {
        const p = i * 4, a = Math.min(1, Math.max(0, deep[p + 3])), alpha = Math.round(a * 65535)
        if (alpha === 0) continue
        const inv = 65535 / a
        const rv = Math.min(65535, Math.max(0, Math.round(deep[p] * inv)))
        const gv = Math.min(65535, Math.max(0, Math.round(deep[p + 1] * inv)))
        const bv = Math.min(65535, Math.max(0, Math.round(deep[p + 2] * inv)))
        const i2 = i * 2
        rP[i2] = (rv >> 8) & 0xff; rP[i2 + 1] = rv & 0xff
        gP[i2] = (gv >> 8) & 0xff; gP[i2 + 1] = gv & 0xff
        bP[i2] = (bv >> 8) & 0xff; bP[i2 + 1] = bv & 0xff
        aP[i2] = (alpha >> 8) & 0xff; aP[i2 + 1] = alpha & 0xff
      }
    } else {
      const d = composite.data
      for (let i = 0; i < count; i++) {
        const p = i * 4, a = d[p + 3]
        if (a === 0) continue
        const alpha = a * 257, inv = 65535 / a
        const rv = a === 255 ? d[p] * 257 : Math.min(65535, Math.round(d[p] * inv))
        const gv = a === 255 ? d[p + 1] * 257 : Math.min(65535, Math.round(d[p + 1] * inv))
        const bv = a === 255 ? d[p + 2] * 257 : Math.min(65535, Math.round(d[p + 2] * inv))
        const i2 = i * 2
        rP[i2] = (rv >> 8) & 0xff; rP[i2 + 1] = rv & 0xff
        gP[i2] = (gv >> 8) & 0xff; gP[i2 + 1] = gv & 0xff
        bP[i2] = (bv >> 8) & 0xff; bP[i2 + 1] = bv & 0xff
        aP[i2] = (alpha >> 8) & 0xff; aP[i2 + 1] = alpha & 0xff
      }
    }
    return planes
  }
  const d = composite.data
  for (let i = 0; i < count; i++) {
    const p = i * 4, a = d[p + 3]
    if (a === 0) continue
    if (a === 255) {
      rP[i] = d[p]; gP[i] = d[p + 1]; bP[i] = d[p + 2]; aP[i] = 255
    } else {
      const inv = 255 / a
      const rv = (d[p] * inv + 0.5) | 0, gv = (d[p + 1] * inv + 0.5) | 0, bv = (d[p + 2] * inv + 0.5) | 0
      rP[i] = rv > 255 ? 255 : rv; gP[i] = gv > 255 ? 255 : gv; bP[i] = bv > 255 ? 255 : bv; aP[i] = a
    }
  }
  return planes
}

export function writePSD(doc: Doc, composite: Raster, deepComposite: Float32Array | null = null): Uint8Array<ArrayBuffer> {
  const { width, height } = doc
  if (width < 1 || width > maxSide || height < 1 || height > maxSide) throw new Error('This document is too large to export as PSD.')
  if (composite.width !== width || composite.height !== height) throw new Error('Composite size does not match the document.')
  const sixteenBit = doc.layers.some(isDeep)
  const file = new PSDBytes()
  file.ascii('8BPS'); file.u16(1); file.zeros(6)
  file.u16(4); file.u32(height); file.u32(width); file.u16(sixteenBit ? 16 : 8); file.u16(3)
  file.u32(0) // no color mode data
  file.data(resourcesSection(doc.resolution || 72), true)
  file.data(layerSection(doc, sixteenBit), true)
  const planes = compositePlanes(composite, deepComposite, sixteenBit)
  if (sixteenBit) {
    file.u16(0)
    for (const plane of planes) file.data(plane)
  } else {
    file.u16(1)
    const packed = planes.map(p => packBitsRows(p, width, height))
    for (const plane of packed) for (const row of plane) file.u16(row.length)
    for (const plane of packed) for (const row of plane) file.data(row)
  }
  return file.toBytes()
}
