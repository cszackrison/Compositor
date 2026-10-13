import { maxSide } from './types'

// A text layer's source (TypeTool.swift's LayerTextStyle), saved as the layer's `text` metadata: its content, PostScript font name, size
// in layer pixels, color (0–1), alignment, tracking, leading and an optional paragraph box, with letters colored or set in other faces
// by runs of UTF-16 offsets. The layer's pixels are the text drawn; any pixel edit leaves plain pixels and drops this.
export type TextAlignment = 'Left' | 'Center' | 'Right'
export type ColorRun = { location: number; length: number; red: number; green: number; blue: number }
export type FontRun = { location: number; length: number; fontName: string }
export type TextStyle = {
  content: string; fontName: string; fontSize: number; red: number; green: number; blue: number
  alignment: TextAlignment; tracking: number
  // Baseline to baseline, in layer pixels, as Photoshop's Leading is; 0 is Auto, 120% of the size.
  leading: number
  // Fixed paragraph bounds in layer pixels; point text (none) is as big as what's typed.
  boxSize?: [number, number]
  colorRuns?: ColorRun[]
  fontRuns?: FontRun[]
}
export type RGB01 = [number, number, number]

// The gap between the text and its box, in layer pixels, the same for point text and a box.
export const textPadding = 12
export const defaultTextStyle = (): TextStyle => ({ content: 'Text', fontName: 'Helvetica', fontSize: 72, red: 0, green: 0, blue: 0, alignment: 'Left', tracking: 0, leading: 0 })
export const lineHeight = (style: TextStyle) => style.leading > 0 ? style.leading : style.fontSize * 1.2
const units = (content: string) => content.length
const finite01 = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1

function runsValid<T extends { location: number; length: number }>(runs: T[] | undefined, content: string, each: (run: T) => boolean) {
  if (runs === undefined) return true
  if (!Array.isArray(runs) || !runs.length) return false
  let end = 0
  for (const run of runs) {
    if (!Number.isInteger(run.location) || !Number.isInteger(run.length) || run.location < end || run.length <= 0 || !each(run)) return false
    end = run.location + run.length
  }
  return end <= units(content)
}

// A layer's `text` metadata as a style, or null when it isn't one this app can edit (as the Mac's `isValid` reads it).
export function readTextStyle(value: unknown): TextStyle | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>, base = defaultTextStyle()
  const box = v.boxSize
  const style: TextStyle = {
    content: typeof v.content === 'string' ? v.content : base.content, fontName: typeof v.fontName === 'string' ? v.fontName : base.fontName,
    fontSize: typeof v.fontSize === 'number' ? v.fontSize : base.fontSize, red: v.red as number ?? 0, green: v.green as number ?? 0, blue: v.blue as number ?? 0,
    alignment: v.alignment === 'Center' || v.alignment === 'Right' ? v.alignment : 'Left', tracking: typeof v.tracking === 'number' ? v.tracking : 0, leading: typeof v.leading === 'number' ? v.leading : 0,
    ...(Array.isArray(box) && box.length === 2 ? { boxSize: [box[0], box[1]] as [number, number] } : box && typeof box === 'object' && 'width' in box ? { boxSize: [(box as unknown as { width: number }).width, (box as unknown as { height: number }).height] as [number, number] } : {}),
    ...(v.colorRuns !== undefined ? { colorRuns: v.colorRuns as ColorRun[] } : {}),
    ...(v.fontRuns !== undefined ? { fontRuns: v.fontRuns as FontRun[] } : {}),
  }
  return isValidText(style) ? style : null
}

export function isValidText(s: TextStyle) {
  const boxValid = !s.boxSize || (s.boxSize.every(n => Number.isFinite(n) && n >= 16 && n <= maxSide) && s.boxSize[0] * s.boxSize[1] <= 200_000_000)
  return units(s.content) <= 100_000 && boxValid && Number.isFinite(s.fontSize) && s.fontSize >= 1 && s.fontSize <= 2000
    && [s.red, s.green, s.blue].every(finite01) && Number.isFinite(s.tracking) && s.tracking >= -100 && s.tracking <= 1000
    && Number.isFinite(s.leading) && s.leading >= 0 && s.leading <= 5000
    && runsValid(s.colorRuns, s.content, r => [r.red, r.green, r.blue].every(finite01))
    && runsValid(s.fontRuns, s.content, r => typeof r.fontName === 'string' && r.fontName.length > 0 && r.fontName.length <= 200 && !/[\n\r]/.test(r.fontName))
}

// The metadata as the Mac writes it: the paragraph box as [width, height], runs only when there are some.
export function writeTextStyle(s: TextStyle) {
  const { colorRuns, fontRuns, boxSize, ...rest } = s
  return { ...rest, ...(boxSize ? { boxSize } : {}), ...(colorRuns?.length ? { colorRuns } : {}), ...(fontRuns?.length ? { fontRuns } : {}) }
}

// MARK: Letters in other colors and faces

export const colorAt = (s: TextStyle, index: number): RGB01 => { const run = s.colorRuns?.find(r => r.location <= index && index < r.location + r.length); return run ? [run.red, run.green, run.blue] : [s.red, s.green, s.blue] }
export const fontAt = (s: TextStyle, index: number) => s.fontRuns?.find(r => r.location <= index && index < r.location + r.length)?.fontName ?? s.fontName
const sameColor = (a: RGB01, b: RGB01) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2]
const clampRange = (s: TextStyle, start: number, end: number) => { const n = units(s.content), a = Math.max(0, Math.min(start, n)); return [a, Math.max(a, Math.min(end, n))] }

function unitColors(s: TextStyle): RGB01[] {
  const colors: RGB01[] = Array.from({ length: units(s.content) }, () => [s.red, s.green, s.blue])
  for (const r of s.colorRuns ?? []) for (let i = Math.max(0, r.location); i < Math.min(colors.length, r.location + r.length); i++) colors[i] = [r.red, r.green, r.blue]
  return colors
}
function withUnitColors(s: TextStyle, colors: RGB01[]): TextStyle {
  const base: RGB01 = [s.red, s.green, s.blue], runs: ColorRun[] = []
  colors.forEach((c, i) => {
    if (sameColor(c, base)) return
    const last = runs.at(-1)
    if (last && last.location + last.length === i && sameColor([last.red, last.green, last.blue], c)) last.length++
    else runs.push({ location: i, length: 1, red: c[0], green: c[1], blue: c[2] })
  })
  const { colorRuns: _, ...rest } = s
  return runs.length ? { ...rest, colorRuns: runs } : rest
}
function unitFonts(s: TextStyle) {
  const fonts = Array.from({ length: units(s.content) }, () => s.fontName)
  for (const r of s.fontRuns ?? []) for (let i = Math.max(0, r.location); i < Math.min(fonts.length, r.location + r.length); i++) fonts[i] = r.fontName
  return fonts
}
function withUnitFonts(s: TextStyle, fonts: string[]): TextStyle {
  const { fontRuns: _, ...rest } = s
  if (fonts.length && fonts.every(f => f === fonts[0])) return { ...rest, fontName: fonts[0] }
  const runs: FontRun[] = []
  fonts.forEach((name, i) => {
    if (name === s.fontName) return
    const last = runs.at(-1)
    if (last && last.location + last.length === i && last.fontName === name) last.length++
    else runs.push({ location: i, length: 1, fontName: name })
  })
  return runs.length ? { ...rest, fontRuns: runs } : rest
}

// Paints [start, end) in `color`; an empty range, or the whole text, recolors all of it.
export function setTextColor(s: TextStyle, color: RGB01, start: number, end: number): TextStyle {
  const [a, b] = clampRange(s, start, end)
  if (a === b || (a === 0 && b === units(s.content))) { const { colorRuns: _, ...rest } = s; return { ...rest, red: color[0], green: color[1], blue: color[2] } }
  const colors = unitColors(s)
  for (let i = a; i < b; i++) colors[i] = color
  return withUnitColors(s, colors)
}

// Sets the face of [start, end); an empty range, or the whole text, changes all of it.
export function setTextFont(s: TextStyle, name: string, start: number, end: number): TextStyle {
  if (!name || name.length > 200 || /[\n\r]/.test(name)) return s
  const [a, b] = clampRange(s, start, end)
  if (a === b || (a === 0 && b === units(s.content))) { const { fontRuns: _, ...rest } = s; return { ...rest, fontName: name } }
  const fonts = unitFonts(s)
  for (let i = a; i < b; i++) fonts[i] = name
  return withUnitFonts(s, fonts)
}

// The one face covering [start, end), or null when it's empty or uses more than one.
export function uniformFont(s: TextStyle, start: number, end: number) {
  const [a, b] = clampRange(s, start, end)
  if (b <= a) return null
  const fonts = unitFonts(s).slice(a, b)
  return fonts.every(f => f === fonts[0]) ? fonts[0] : null
}

// The text with [start, end) replaced by `text`, each new letter taking the color and face of the letter before, as typing does.
export function replaceText(s: TextStyle, start: number, end: number, text: string): TextStyle {
  const [a, b] = clampRange(s, start, end), content = s.content.slice(0, a) + text + s.content.slice(b)
  let next: TextStyle = { ...s, content }
  if (s.colorRuns) {
    const colors = unitColors(s), inherited = a > 0 ? colors[a - 1] : b > a ? colors[a] : colors[0] ?? [s.red, s.green, s.blue]
    colors.splice(a, b - a, ...Array.from({ length: text.length }, () => inherited))
    next = withUnitColors(next, colors)
  }
  if (s.fontRuns) {
    const fonts = unitFonts(s), inherited = a > 0 ? fonts[a - 1] : b > a ? fonts[a] : fonts[0] ?? s.fontName
    fonts.splice(a, b - a, ...Array.from({ length: text.length }, () => inherited))
    next = withUnitFonts({ ...next, fontName: s.fontName }, fonts)
  }
  return next
}

// A text layer's name: its first words on one line.
export function textLayerName(content: string) {
  const flat = content.split(/\s+/).filter(Boolean).join(' ')
  return flat ? flat.slice(0, 40) : 'Text'
}
