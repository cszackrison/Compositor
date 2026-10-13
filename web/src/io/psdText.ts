import { type TextStyle, defaultTextStyle, isValidText, textPadding } from '../model/text'
import type { Transform } from '../model/types'

// Reads a Photoshop 6 type layer (TySh) into the editor's text model, as PSDText.swift does. Adobe's Photoshop File Formats
// Specification (2019), Type Tool Object Setting: version, a 2×3 transform, a text descriptor, and a warp descriptor. The engine
// dictionary inside EngineData supplies the font, size, color, tracking, leading and alignment. Anything this model cannot represent
// (vertical text, shear, uneven scale) stays a raster.

// `documentAnchor`: the document point the image's anchor lands on, the paragraph frame's top-left when `anchorIsFrame`, otherwise
// the point text's baseline.
export type PSDTextSource = { style: TextStyle; notes: string[]; documentAnchor: [number, number]; rotation: number; flipY: boolean; anchorIsFrame: boolean }

export const rasterizedNote = 'Editable Photoshop text becomes pixels and can’t be retyped.'
export const firstStyleNote = 'Only the first text style was kept.'
export const warpNote = 'The Photoshop text warp was omitted.'
export const fauxNote = 'Faux bold or faux italic was omitted.'
export const justifyNote = 'Full justification was imported as left alignment.'
export const missingFontNote = (name: string) => `The font “${name}” isn’t installed, so the text was drawn with the system font.`

// Swift's `rounded()`: halves away from zero.
const rounded = (n: number) => Math.sign(n) * Math.round(Math.abs(n))

export function parseText(extra: Map<string, Uint8Array>): PSDTextSource | null {
  const data = extra.get('TySh') ?? extra.get('tySh')
  if (!data || data.length > 8_000_000) return null
  const reader = new Reader(data)
  if (reader.u16() !== 1) return null
  const matrix = [reader.f64(), reader.f64(), reader.f64(), reader.f64(), reader.f64(), reader.f64()]
  if (!matrix.every(v => v !== null && Number.isFinite(v))) return null
  const [xx, xy, yx, yy, tx, ty] = matrix as number[]
  if (reader.u16() !== 50) return null
  const text = reader.descriptor(true)
  if (!text) return null
  if (enumeration(text, 'Ornt') === 'Vrtc') return null
  const placed = placement(xx, xy, yx, yy, tx, ty)
  if (!placed) return null

  const notes: string[] = []
  if (reader.remaining >= 2 && reader.u16() === 1) {
    const warp = reader.descriptor(true), style = warp && enumeration(warp, 'warpStyle')
    if (style && style !== 'warpNone' && style !== 'none') notes.push(warpNote)
  }

  const engineData = data_(text, 'EngineData'), engine = engineData ? engineValue(engineData) : null
  const content = cleaned(string_(text, 'Txt ') ?? string_(text, 'Txt')) ?? (engine ? cleaned(str(walk(engine, 'EngineDict', 'Editor', 'Text'))) : null)
  if (!content || content.length > 100_000) return null

  let style: TextStyle = { ...defaultTextStyle(), content }
  if (engine) applyStyle(style, engine, placed.pixelScale, notes)
  else style.fontSize = Math.min(2000, Math.max(1, 12 * placed.pixelScale))
  if (!Number.isFinite(style.fontSize) || style.fontSize <= 0) return null

  let anchor: [number, number] = [placed.tx, placed.ty], anchorIsFrame = false
  const bounds = rect(text, 'bounds'), glyphs = rect(text, 'boundingBox')
  if (bounds && glyphs && bounds.width > glyphs.width + 4 && bounds.height > glyphs.height + 4 && bounds.width > 1 && bounds.height > 1) {
    const boxed: TextStyle = { ...style, boxSize: [bounds.width * placed.pixelScale + textPadding * 2, bounds.height * placed.pixelScale + textPadding * 2] }
    // A paragraph frame the model cannot store is dropped entirely: importing as point text would lose the wrap without saying so.
    // Vertical text already falls back the same way.
    if (!isValidText(boxed)) return null
    style = boxed
    anchor = placed.map(bounds.x, bounds.y)
    anchorIsFrame = true
  }
  if (!isValidText(style)) return null
  return { style, notes, documentAnchor: anchor, rotation: placed.rotation, flipY: placed.flipY, anchorIsFrame }
}

// Where the drawn text goes: its anchor (the frame's corner inside the padding, or the first baseline where the alignment puts it) on
// the document anchor, flipped then turned clockwise about the image's center, as BrushRaster.pixelToDocument does.
export function textTransform(source: PSDTextSource, width: number, height: number, baseline: number): Transform {
  const { style } = source
  const anchorX = source.anchorIsFrame ? textPadding : style.alignment === 'Center' ? width / 2 : style.alignment === 'Right' ? width - textPadding : textPadding
  const anchorY = source.anchorIsFrame ? textPadding : baseline
  let lx = anchorX - width / 2, ly = anchorY - height / 2
  if (source.flipY) ly = -ly
  const radians = source.rotation * Math.PI / 180
  const rx = lx * Math.cos(radians) - ly * Math.sin(radians), ry = lx * Math.sin(radians) + ly * Math.cos(radians)
  const cx = source.documentAnchor[0] - rx, cy = source.documentAnchor[1] - ry
  return { origin: [cx - width / 2, cy - height / 2], size: [width, height], rotation: source.rotation, flipX: false, flipY: source.flipY, sampling: 'High quality' }
}

// Uniform scale, rotation and an optional vertical flip. Shear and uneven scale return null. Engine sizes are already in text-space
// units that the matrix maps into document pixels; document PPI is print metadata and must not multiply that product again.
function placement(xx: number, xy: number, yx: number, yy: number, tx: number, ty: number) {
  const scaleX = Math.hypot(xx, yx)
  if (!(scaleX > 1e-6)) return null
  const cos = xx / scaleX, sin = yx / scaleX
  const localX = cos * xy + sin * yy, localY = -sin * xy + cos * yy, scaleY = Math.abs(localY)
  if (!(scaleY > 1e-6)) return null
  const largest = Math.max(scaleX, scaleY)
  if (Math.abs(localX) > 0.02 * largest || Math.abs(scaleX - scaleY) > 0.02 * largest) return null
  const pixelScale = scaleX
  if (!Number.isFinite(pixelScale) || pixelScale <= 0) return null
  const ySign = localY < 0 ? -1 : 1
  const exx = cos * pixelScale, eyx = sin * pixelScale, exy = -sin * pixelScale * ySign, eyy = cos * pixelScale * ySign
  return { pixelScale, rotation: Math.atan2(sin, cos) * 180 / Math.PI, flipY: localY < 0, tx, ty, map: (x: number, y: number): [number, number] => [exx * x + exy * y + tx, eyx * x + eyy * y + ty] }
}

function applyStyle(style: TextStyle, engine: Engine, pixelScale: number, notes: string[]) {
  const runs = array(walk(engine, 'EngineDict', 'StyleRun', 'RunArray'))
  const first = runs[0] ?? engine
  const data = walk(first, 'StyleSheet', 'StyleSheetData') ?? walk(engine, 'EngineDict', 'StyleRun', 'RunArray') ?? first
  const points = num(walk(data, 'FontSize')) ?? 12
  if (!Number.isFinite(points) || points <= 0) return
  style.fontSize = Math.min(2000, Math.max(1, points * pixelScale))
  const fonts = array(walk(engine, 'ResourceDict', 'FontSet')), index = rounded(num(walk(data, 'Font')) ?? 0)
  const name = index >= 0 && index < fonts.length ? str(walk(fonts[index], 'Name')) : null
  if (name) style.fontName = name
  const values = array(walk(data, 'FillColor', 'Values'))
  if (values.length) [style.red, style.green, style.blue] = color(values.map(num).filter((v): v is number => v !== null))
  const tracking = num(walk(data, 'Tracking')) ?? 0
  if (Number.isFinite(tracking)) style.tracking = Math.min(1000, Math.max(-100, tracking * style.fontSize / 1000))
  const leading = num(walk(data, 'Leading'))
  if (!(bool(walk(data, 'AutoLeading')) ?? true) && leading !== null && Number.isFinite(leading) && leading > 0) style.leading = Math.min(5000, Math.max(0, leading * pixelScale))
  if (bool(walk(data, 'FauxBold')) === true || bool(walk(data, 'FauxItalic')) === true) notes.push(fauxNote)
  if (runs.length > 1) { const base = signature(first); if (runs.slice(1).some(run => signature(run) !== base)) notes.push(firstStyleNote) }
  const paragraphs = array(walk(engine, 'EngineDict', 'ParagraphRun', 'RunArray'))
  const justification = rounded(num(walk(paragraphs[0] ?? engine, 'ParagraphSheet', 'Properties', 'Justification')) ?? 0)
  style.alignment = justification === 1 ? 'Right' : justification === 2 ? 'Center' : 'Left'
  if (justification !== 0 && justification !== 1 && justification !== 2) notes.push(justifyNote)
}

// What tells one style run from another, as text.
function signature(run: Engine) {
  const data = walk(run, 'StyleSheet', 'StyleSheetData') ?? run, n = (key: string, fallback: number) => num(walk(data, key)) ?? fallback
  const channels = array(walk(data, 'FillColor', 'Values')).map(num).filter((v): v is number => v !== null)
  return JSON.stringify([n('Font', 0), n('FontSize', 0), n('Tracking', 0), bool(walk(data, 'AutoLeading')) ?? true, n('Leading', 0), n('HorizontalScale', 1), n('VerticalScale', 1), bool(walk(data, 'FauxBold')) ?? false, bool(walk(data, 'FauxItalic')) ?? false, ...color(channels)])
}

function color(values: number[]): [number, number, number] {
  const unit = (v: number) => v > 1 ? Math.min(255, Math.max(0, v)) / 255 : Math.min(1, Math.max(0, v))
  if (values.length >= 4) return [unit(values[1]), unit(values[2]), unit(values[3])]
  if (values.length === 3) return [unit(values[0]), unit(values[1]), unit(values[2])]
  if (values.length) { const g = unit(values[0]); return [g, g, g] }
  return [0, 0, 0]
}

function cleaned(text: string | null | undefined) {
  if (text === null || text === undefined) return null
  return text.replace(/^[﻿\0]+/, '').replace(/\0+$/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

// MARK: The text engine's dictionary: a small PostScript-like subset (<< >>, arrays, names, numbers, strings)

type Engine = number | boolean | string | Engine[] | { [key: string]: Engine }
const isDict = (v: Engine | null | undefined): v is { [key: string]: Engine } => !!v && typeof v === 'object' && !Array.isArray(v)
function walk(value: Engine | null | undefined, ...keys: string[]): Engine | null {
  let current = value ?? null
  for (const key of keys) { if (!isDict(current) || !Object.hasOwn(current, key)) return null; current = current[key] }
  return current
}
const num = (v: Engine | null) => typeof v === 'number' ? v : null
const bool = (v: Engine | null) => typeof v === 'boolean' ? v : null
const str = (v: Engine | null) => typeof v === 'string' ? v : null
const array = (v: Engine | null) => Array.isArray(v) ? v : []

const code = (c: string) => c.charCodeAt(0)
const LT = code('<'), GT = code('>'), SLASH = code('/'), OPEN = code('('), CLOSE = code(')'), LB = code('['), RB = code(']'), PERCENT = code('%'), BACKSLASH = code('\\')
const isDigit = (b: number | undefined) => b !== undefined && b >= 48 && b <= 57

function engineValue(data: Uint8Array): Engine | null {
  const at0 = dictionary(data, 0)
  if (at0) return at0
  let start = -1
  for (let i = 0; i + 1 < data.length; i++) if (data[i] === LT && data[i + 1] === LT) { start = i; break }
  return start > 0 ? dictionary(data, start) : null
}

function dictionary(data: Uint8Array, start: number): Engine | null {
  const cursor = new EngineCursor(data)
  cursor.index = start
  const value = cursor.value()
  return isDict(value) ? value : null
}

class EngineCursor {
  index = 0
  constructor(readonly bytes: Uint8Array) {}
  get peek(): number | undefined { return this.bytes[this.index] }

  value(): Engine | null {
    this.skipWhitespace()
    const byte = this.peek
    if (byte === undefined) return null
    if (byte === LT) return this.bytes[this.index + 1] === LT ? this.dict() : this.hex()
    if (byte === LB) return this.array()
    if (byte === OPEN) return this.string()
    if (byte === SLASH) { this.index++; return this.token() }
    if (byte === code('-') || byte === code('+') || byte === code('.') || isDigit(byte)) return this.number()
    if (this.word('true')) return true
    if (this.word('false')) return false
    if (this.word('null')) return ''
    return null
  }

  dict(): Engine | null {
    if (!this.take('<<')) return null
    const items: { [key: string]: Engine } = Object.create(null)
    for (;;) {
      this.skipWhitespace()
      if (this.peek === undefined || this.peek === GT) break
      if (this.peek !== SLASH) return null
      this.index++
      const key = this.token(), value = this.value()
      if (value === null) return null
      items[key] = value
    }
    return this.take('>>') ? items : null
  }

  array(): Engine | null {
    if (!this.take('[')) return null
    const items: Engine[] = []
    for (;;) {
      this.skipWhitespace()
      if (this.peek === undefined || this.peek === RB) break
      const value = this.value()
      if (value === null) return null
      items.push(value)
    }
    return this.take(']') ? items : null
  }

  number(): number | null {
    const start = this.index, digits = () => { while (isDigit(this.peek)) this.index++ }
    if (this.peek === code('+') || this.peek === code('-')) this.index++
    digits()
    if (this.peek === code('.')) { this.index++; digits() }
    if (this.peek === code('e') || this.peek === code('E')) { this.index++; if (this.peek === code('+') || this.peek === code('-')) this.index++; digits() }
    if (this.index <= start) return null
    const text = String.fromCharCode(...this.bytes.subarray(start, this.index))
    // Swift's Double(text): a lone sign or point isn't a number.
    if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(text)) return null
    return Number(text)
  }

  string(): Engine | null {
    if (!this.take('(')) return null
    const raw: number[] = []
    while (this.peek !== undefined) {
      const byte = this.bytes[this.index++]
      if (byte === CLOSE) break
      if (byte === BACKSLASH) {
        const escaped = this.peek
        if (escaped === undefined) return null
        this.index++
        if (escaped === code('n')) raw.push(0x0a)
        else if (escaped === code('r')) raw.push(0x0d)
        else if (escaped === code('t')) raw.push(0x09)
        else if (escaped >= 48 && escaped <= 55) {
          let value = escaped - 48
          for (let i = 0; i < 2; i++) { const digit = this.peek; if (digit === undefined || digit < 48 || digit > 55) break; this.index++; value = value * 8 + digit - 48 }
          raw.push(value & 0xff)
        } else if (escaped !== 0x0a && escaped !== 0x0d) raw.push(escaped)
      } else raw.push(byte)
    }
    return decodeEngine(raw)
  }

  hex(): Engine | null {
    if (!this.take('<')) return null
    const nibbles: number[] = []
    while (this.peek !== undefined && this.peek !== GT) {
      const byte = this.bytes[this.index++], nibble = parseInt(String.fromCharCode(byte), 16)
      if (!Number.isNaN(nibble)) nibbles.push(nibble)
    }
    if (!this.take('>')) return null
    const raw: number[] = []
    for (let i = 0; i + 1 < nibbles.length; i += 2) raw.push((nibbles[i] << 4) | nibbles[i + 1])
    return decodeEngine(raw)
  }

  token() {
    const start = this.index
    while (this.peek !== undefined && !isDelimiter(this.peek)) this.index++
    const bytes = this.bytes.subarray(start, this.index)
    return bytes.some(b => b > 127) ? '' : String.fromCharCode(...bytes)
  }

  word(word: string) {
    if (!this.matches(word)) return false
    const after = this.index + word.length
    if (after < this.bytes.length && !isDelimiter(this.bytes[after])) return false
    this.index = after
    return true
  }

  take(token: string) { if (!this.matches(token)) return false; this.index += token.length; return true }
  matches(token: string) { for (let i = 0; i < token.length; i++) if (this.bytes[this.index + i] !== token.charCodeAt(i)) return false; return true }

  skipWhitespace() {
    while (this.peek !== undefined && (this.peek <= 0x20 || this.peek === PERCENT)) {
      if (this.peek === PERCENT) { while (this.peek !== undefined && this.peek !== 0x0a && this.peek !== 0x0d) this.index++ }
      else this.index++
    }
  }
}

const isDelimiter = (b: number) => b <= 0x20 || b === SLASH || b === LT || b === GT || b === LB || b === RB || b === OPEN || b === CLOSE

function decodeEngine(raw: number[]) {
  if (raw.length >= 2 && raw[0] === 0xfe && raw[1] === 0xff) return new TextDecoder('utf-16be').decode(new Uint8Array(raw.slice(2)))
  let text = ''
  for (let i = 0; i < raw.length; i += 8192) text += String.fromCharCode(...raw.slice(i, i + 8192))
  return text
}

// MARK: Descriptors, from the same specification (class and keys are length-prefixed, or 4 bytes when the length is 0)

type Descriptor = Record<string, DescriptorValue>
type DescriptorValue = { text: string } | { number: number } | { enumeration: string } | { data: Uint8Array } | { descriptor: Descriptor } | { list: DescriptorValue[] }

const string_ = (d: Descriptor, key: string) => { const v = d[key]; return v && 'text' in v ? v.text : null }
const enumeration = (d: Descriptor, key: string) => { const v = d[key]; return v && 'enumeration' in v ? v.enumeration : null }
const data_ = (d: Descriptor, key: string) => { const v = d[key]; return v && 'data' in v ? v.data : null }
function rect(d: Descriptor, key: string) {
  const v = d[key]
  if (!v || !('descriptor' in v)) return null
  const side = (name: string) => { const s = v.descriptor[name] ?? v.descriptor[name.trim()]; return s && 'number' in s ? s.number : null }
  const left = side('Left'), top = side('Top '), right = side('Rght'), bottom = side('Btom')
  if (left === null || top === null || right === null || bottom === null || ![left, top, right, bottom].every(Number.isFinite)) return null
  return { x: left, y: top, width: right - left, height: bottom - top }
}

class Reader {
  offset = 0
  private view: DataView
  constructor(readonly data: Uint8Array) { this.view = new DataView(data.buffer, data.byteOffset, data.byteLength) }
  get remaining() { return this.data.length - this.offset }

  descriptor(versioned: boolean): Descriptor | null {
    if (versioned && this.u32() !== 16) return null
    if (this.unicode() === null || this.identifier() === null) return null
    const count = this.u32()
    if (count === null || count > 10_000) return null
    const items: Descriptor = Object.create(null)
    for (let i = 0; i < count; i++) {
      const key = this.identifier(), type = key === null ? null : this.fourCC(), value = type === null ? null : this.value(type)
      if (key === null || value === null) return null
      items[key] = value
    }
    return items
  }

  value(type: string): DescriptorValue | null {
    switch (type) {
      case 'doub': { const n = this.f64(); return n === null ? null : { number: n } }
      case 'UntF': { if (this.fourCC() === null) return null; const n = this.f64(); return n === null ? null : { number: n } }
      case 'long': { const n = this.i32(); return n === null ? null : { number: n } }
      case 'comp': { const raw = this.bytes(8); return raw ? { number: Number(new DataView(raw.buffer, raw.byteOffset, 8).getBigInt64(0)) } : null }
      case 'bool': return this.u8() === null ? null : { number: 0 }
      case 'TEXT': { const text = this.unicode(); return text === null ? null : { text } }
      case 'enum': { if (this.identifier() === null) return null; const name = this.identifier(); return name === null ? null : { enumeration: name } }
      case 'tdta': { const length = this.u32(); if (length === null || length > 8_000_000) return null; const raw = this.bytes(length); return raw ? { data: raw } : null }
      case 'Objc': case 'GlbO': { const nested = this.descriptor(false); return nested ? { descriptor: nested } : null }
      case 'VlLs': {
        const count = this.u32()
        if (count === null || count > 10_000) return null
        const items: DescriptorValue[] = []
        for (let i = 0; i < count; i++) { const itemType = this.fourCC(), item = itemType === null ? null : this.value(itemType); if (!item) return null; items.push(item) }
        return { list: items }
      }
      case 'alis': { const length = this.u32(); return length !== null && length <= 8_000_000 && this.bytes(length) ? { number: 0 } : null }
      case 'obj ': return this.reference() ? { number: 0 } : null
      case 'type': case 'GlbC': return this.unicode() !== null && this.identifier() !== null ? { number: 0 } : null
      default: return null
    }
  }

  // Skips a descriptor reference so a later EngineData item can still be read.
  reference() {
    const count = this.u32()
    if (count === null || count > 10_000) return false
    const ok = (...parts: unknown[]) => parts.every(p => p !== null)
    for (let i = 0; i < count; i++) {
      const form = this.fourCC()
      if (form === 'prop') { if (!ok(this.unicode(), this.identifier(), this.identifier())) return false }
      else if (form === 'Clss') { if (!ok(this.unicode(), this.identifier())) return false }
      else if (form === 'Enmr') { if (!ok(this.unicode(), this.identifier(), this.identifier(), this.identifier())) return false }
      else if (form === 'rele') { if (!ok(this.unicode(), this.identifier(), this.i32())) return false }
      else if (form === 'Idnt' || form === 'indx') { if (this.i32() === null) return false }
      else if (form === 'name') { if (this.unicode() === null) return false }
      else return false
    }
    return true
  }

  unicode(): string | null {
    const count = this.u32()
    if (count === null || count > 1_000_000) return null
    const raw = this.bytes(count * 2)
    if (!raw) return null
    return raw.length ? new TextDecoder('utf-16be').decode(raw) : ''
  }

  identifier(): string | null {
    const length = this.u32()
    if (length === null) return null
    if (length === 0) return this.fourCC()
    if (length > 10_000) return null
    const raw = this.bytes(length)
    return raw && !raw.some(b => b > 127) ? String.fromCharCode(...raw) : null
  }

  fourCC(): string | null { const raw = this.bytes(4); return raw && !raw.some(b => b > 127) ? String.fromCharCode(...raw) : null }
  bytes(count: number) { if (count < 0 || this.offset + count > this.data.length) return null; const v = this.data.subarray(this.offset, this.offset + count); this.offset += count; return v }
  u8() { return this.offset < this.data.length ? this.data[this.offset++] : null }
  u16() { if (this.offset + 2 > this.data.length) return null; const v = this.view.getUint16(this.offset); this.offset += 2; return v }
  u32() { if (this.offset + 4 > this.data.length) return null; const v = this.view.getUint32(this.offset); this.offset += 4; return v }
  i32() { if (this.offset + 4 > this.data.length) return null; const v = this.view.getInt32(this.offset); this.offset += 4; return v }
  f64() { if (this.offset + 8 > this.data.length) return null; const v = this.view.getFloat64(this.offset); this.offset += 8; return v }
}
