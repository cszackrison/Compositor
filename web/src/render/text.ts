import { Raster, premultiply } from '../model/raster'
import { type TextStyle, colorAt, fontAt, lineHeight, textPadding } from '../model/text'

// Text set and drawn with the browser's 2D canvas, as the Mac sets it with Core Text (TypeTool.textImage): lines of a fixed height
// (the leading), each baseline the face's descent up from the bottom of its line; point text as wide as its longest line, a paragraph
// box wrapping words at its width and showing only the lines that fit. The same layout places the caret and maps clicks to letters,
// so what's edited is exactly what's drawn. Browser text layout isn't Core Text's, so letters can sit a little differently from the Mac.

// MARK: Faces

// A PostScript name (what the Mac saves) to a family and face the browser can draw: the installed face itself through
// @font-face's local(), which finds faces by PostScript name; failing that, a guess from the name ("Helvetica-Bold" → Helvetica, bold).
type Face = { css: string; ready: boolean; loaded: Promise<boolean> }
const faces = new Map<string, Face>()
const fontListeners = new Set<() => void>()
export function subscribeFonts(listener: () => void) { fontListeners.add(listener); return () => { fontListeners.delete(listener) } }

const known: Record<string, string> = { ArialMT: 'Arial', 'TimesNewRomanPSMT': 'Times New Roman', 'CourierNewPSMT': 'Courier New', HelveticaNeue: 'Helvetica Neue', 'Helvetica': 'Helvetica', '.AppleSystemUIFont': 'system-ui', 'SFProText-Regular': 'system-ui', 'SFPro-Regular': 'system-ui' }
const weights: [RegExp, number][] = [[/thin|hairline/i, 100], [/extralight|ultralight/i, 200], [/light/i, 300], [/medium/i, 500], [/semibold|demibold/i, 600], [/extrabold|ultrabold/i, 800], [/bold/i, 700], [/black|heavy/i, 900]]

// The face's guessed family and style, for a name the browser can't find by itself.
export function guessFace(name: string) {
  const [familyPart, stylePart = ''] = name.split('-')
  const family = known[name] ?? known[familyPart] ?? familyPart.replace(/(PS)?MT$/, '').replace(/([a-z])([A-Z])/g, '$1 $2')
  const weight = weights.find(([pattern]) => pattern.test(stylePart))?.[1] ?? 400
  return { family, weight, italic: /italic|oblique/i.test(stylePart) }
}

// The CSS font for a face, SIZE standing for its size: the installed face itself when it was found (`found`), then its guessed family.
// Weight and style lead, as the shorthand needs: anywhere else the browser rejects the whole font and draws at 10 px.
export function faceCSS(name: string, found: boolean) {
  const guess = guessFace(name)
  return `${guess.italic ? 'italic ' : ''}${guess.weight} SIZE ${found ? `"ps ${name}", ` : ''}"${guess.family}", Helvetica, Arial, sans-serif`
}

function face(name: string): Face {
  const found = faces.get(name)
  if (found) return found
  const guess = guessFace(name)
  const entry: Face = { css: faceCSS(name, false), ready: false, loaded: Promise.resolve(true) }
  faces.set(name, entry)
  const fonts = typeof document !== 'undefined' ? document.fonts : null
  if (fonts && typeof FontFace !== 'undefined') {
    // The face found is declared with the weight and style asked for, so the browser draws it as it is rather than making it bolder
    // or slanting it.
    const family = `ps ${name}`, loading = new FontFace(family, `local("${name.replace(/"/g, '')}")`, { weight: String(guess.weight), style: guess.italic ? 'italic' : 'normal' })
    entry.loaded = loading.load().then(loaded => { fonts.add(loaded); entry.css = faceCSS(name, true); entry.ready = true; fontListeners.forEach(l => l()); return true }, () => { entry.ready = true; return false })
  } else entry.ready = true
  return entry
}
// Whether the installed face itself was found by its PostScript name, once the browser has looked.
export const faceInstalled = (name: string) => face(name).loaded
const cssFont = (name: string, size: number) => face(name).css.replace('SIZE', `${size}px`)

// Installed faces the browser lets the page list (Chrome and Edge, with permission): PostScript name, family and style.
export type FaceInfo = { postscriptName: string; family: string; style: string }
let installed: FaceInfo[] | null = null
export const installedFaces = () => installed
export async function listInstalledFaces(): Promise<FaceInfo[] | null> {
  const query = (window as unknown as { queryLocalFonts?: () => Promise<FaceInfo[]> }).queryLocalFonts
  if (!query) return null
  try { installed = (await query()).map(f => ({ postscriptName: f.postscriptName, family: f.family, style: f.style })) } catch { return null }
  fontListeners.forEach(l => l())
  return installed
}

// Faces most systems have, offered where the browser can't list what's installed; those it can't draw are left out.
const common = ['Helvetica', 'Helvetica-Bold', 'HelveticaNeue', 'HelveticaNeue-Bold', 'ArialMT', 'Arial-BoldMT', 'Arial-ItalicMT', 'TimesNewRomanPSMT', 'TimesNewRomanPS-BoldMT', 'Georgia', 'Georgia-Bold', 'Verdana', 'Verdana-Bold', 'TrebuchetMS', 'CourierNewPSMT', 'Futura-Medium', 'Futura-Bold', 'Avenir-Book', 'Avenir-Heavy', 'GillSans', 'Optima-Regular', 'Didot', 'Baskerville', 'Palatino-Roman', 'AmericanTypewriter', 'Menlo-Regular', 'Monaco', 'Impact', 'ComicSansMS', 'DejaVuSans', 'DejaVuSans-Bold', 'DejaVuSerif', 'LiberationSans', 'LiberationSerif', 'NotoSans-Regular', 'Ubuntu', 'Cantarell-Regular', 'SegoeUI', 'Calibri', 'Cambria']
export function commonFaces(): string[] {
  const context = measurer()
  const width = (font: string) => { context.font = font; return context.measureText('mmmmmmmmmmlliWW').width }
  return common.filter(name => {
    const { family } = guessFace(name)
    return ['monospace', 'serif'].some(base => width(`72px "${family}", ${base}`) !== width(`72px ${base}`))
  })
}

// MARK: Layout

let shared: OffscreenCanvasRenderingContext2D | null = null
function measurer() { return shared ??= new OffscreenCanvas(1, 1).getContext('2d')! }
const spacingSupported = () => 'letterSpacing' in measurer()

export type TextLine = { start: number; end: number; top: number; baseline: number; left: number; xs: number[]; width: number }
// `fits`: how many lines a paragraph box has room for.
export type TextLayout = { style: TextStyle; width: number; height: number; lines: TextLine[]; fits: number; overflow: boolean; ascent: number; descent: number }

// Pieces of a paragraph in one face and color.
function pieces(style: TextStyle, start: number, end: number) {
  const out: { start: number; end: number; font: string; color: string }[] = []
  for (let i = start; i < end; i++) {
    const font = cssFont(fontAt(style, i), style.fontSize), [r, g, b] = colorAt(style, i), color = `rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)})`
    const last = out.at(-1)
    if (last && last.font === font && last.color === color && last.end === i) last.end = i + 1
    else out.push({ start: i, end: i + 1, font, color })
  }
  return out
}

function setFont(context: OffscreenCanvasRenderingContext2D, font: string, tracking: number) {
  context.font = font
  if (spacingSupported()) (context as unknown as { letterSpacing: string }).letterSpacing = `${tracking}px`
}

// Each letter's left edge across a paragraph, from its start: x[i - start], with one more at its end.
function positions(style: TextStyle, start: number, end: number) {
  const context = measurer(), xs = [0], text = style.content, manual = !spacingSupported()
  let x = 0
  for (const piece of pieces(style, start, end)) {
    setFont(context, piece.font, style.tracking)
    const s = text.slice(piece.start, piece.end)
    // Prefix widths keep the face's kerning; a long piece is measured letter by letter instead.
    for (let i = 1; i <= s.length; i++) {
      const prefix = s.length <= 400 ? context.measureText(s.slice(0, i)).width : null
      const w = prefix ?? (xs[xs.length - 1] - x) + context.measureText(s[i - 1]).width
      const low = s.charCodeAt(i - 1) >= 0xdc00 && s.charCodeAt(i - 1) <= 0xdfff
      xs.push(x + w + (manual && !low ? style.tracking * i : 0))
    }
    x = xs[xs.length - 1]
  }
  return xs
}

export function layoutText(style: TextStyle): TextLayout {
  const context = measurer(), height = lineHeight(style)
  setFont(context, cssFont(style.fontName, style.fontSize), 0)
  const metrics = context.measureText('Hg')
  const ascent = metrics.fontBoundingBoxAscent ?? style.fontSize * 0.8, descent = metrics.fontBoundingBoxDescent ?? style.fontSize * 0.2
  const boxed = style.boxSize, available = boxed ? Math.max(1, boxed[0] - 2 * textPadding) : Infinity
  const lines: TextLine[] = []
  const content = style.content
  let paragraphStart = 0
  for (const paragraph of content.split('\n')) {
    const start = paragraphStart, end = start + paragraph.length
    paragraphStart = end + 1
    const xs = positions(style, start, end)
    const at = (i: number) => xs[i - start]
    let lineStart = start
    while (true) {
      let lineEnd = end
      if (boxed && at(end) - at(lineStart) > available) {
        // Words that fit, the spaces after the last one hanging past the edge; a word too long for a line on its own is broken.
        let breakAt = -1
        for (let i = lineStart + 1; i <= end; i++) {
          const visibleEnd = trimmedEnd(content, lineStart, i)
          if (at(visibleEnd) - at(lineStart) > available) break
          if (i === end || (content[i] === ' ' && content[i - 1] !== ' ')) breakAt = i
          if (content[i - 1] === ' ' && i < end && content[i] !== ' ') breakAt = i
        }
        if (breakAt <= lineStart) { breakAt = lineStart + 1; while (breakAt < end && (insidePair(content, breakAt) || at(breakAt + 1) - at(lineStart) <= available)) breakAt++ }
        while (breakAt < end && content[breakAt] === ' ') breakAt++
        lineEnd = breakAt
      }
      lines.push({ start: lineStart, end: lineEnd, top: 0, baseline: 0, left: 0, xs: xs.slice(lineStart - start, lineEnd - start + 1).map(v => v - at(lineStart)), width: at(trimmedEnd(content, lineStart, lineEnd)) - at(lineStart) })
      if (lineEnd >= end) break
      lineStart = lineEnd
    }
  }
  const widest = Math.max(0, ...lines.map(l => l.width))
  const width = boxed ? boxed[0] : Math.max(16, Math.ceil(widest + textPadding * 2 + style.fontSize * 0.1))
  const textHeight = lines.length * height
  const boxHeight = boxed ? boxed[1] : Math.max(16, Math.ceil(Math.max(textHeight, Math.ceil(height)) + textPadding * 2))
  const container = width - 2 * textPadding
  lines.forEach((line, i) => {
    line.top = textPadding + i * height
    line.baseline = line.top + height - descent
    line.left = textPadding + (style.alignment === 'Left' ? 0 : (container - line.width) * (style.alignment === 'Center' ? 0.5 : 1))
  })
  // A box shows the lines that fit in it; the rest wait for it to grow.
  const fits = boxed ? Math.max(0, Math.floor((boxHeight - 2 * textPadding) / height + 1e-6)) : lines.length
  return { style, width, height: boxHeight, lines, fits, overflow: lines.length > fits && content.slice(lines[Math.min(fits, lines.length - 1)].start).trim().length > 0, ascent, descent }
}

const trimmedEnd = (content: string, start: number, end: number) => { let e = end; while (e > start && content[e - 1] === ' ') e--; return e }

// The text drawn as a layer's pixels, as the layout sets it.
export function rasterizeText(style: TextStyle): { raster: Raster; layout: TextLayout } {
  const layout = layoutText(style), width = Math.max(1, Math.ceil(layout.width)), height = Math.max(1, Math.ceil(layout.height))
  const canvas = new OffscreenCanvas(width, height), context = canvas.getContext('2d', { willReadFrequently: true })!
  for (const line of layout.lines.slice(0, layout.fits)) {
    for (const piece of pieces(style, line.start, line.end)) {
      setFont(context, piece.font, style.tracking)
      context.fillStyle = piece.color
      const x = line.left + line.xs[piece.start - line.start], text = style.content.slice(piece.start, piece.end)
      if (spacingSupported() || !style.tracking) context.fillText(text, x, line.baseline)
      else for (let i = 0; i < text.length; i++) context.fillText(text[i], line.left + line.xs[piece.start - line.start + i], line.baseline)
    }
  }
  const data = new Uint8Array(context.getImageData(0, 0, width, height).data.buffer)
  return { raster: new Raster(width, height, 4, premultiply(data)), layout }
}

// MARK: Caret and selection

const lineOf = (layout: TextLayout, index: number) => {
  for (let i = 0; i < layout.lines.length; i++) { const line = layout.lines[i], next = layout.lines[i + 1]; if (index < line.end || (index === line.end && (!next || next.start > index))) return i }
  return Math.max(0, layout.lines.length - 1)
}

// Where the caret stands before letter `index`, in layer pixels.
export function caretAt(layout: TextLayout, index: number) {
  const line = layout.lines[lineOf(layout, index)]
  const x = line.left + (line.xs[Math.max(0, Math.min(line.xs.length - 1, index - line.start))] ?? 0)
  return { x, top: line.baseline - layout.ascent, bottom: line.baseline + layout.descent, line: lineOf(layout, index) }
}

// Between the two halves of a character outside the Basic Multilingual Plane (an emoji): never a place for the caret or a break.
const insidePair = (content: string, index: number) => index > 0 && index < content.length && content.charCodeAt(index) >= 0xdc00 && content.charCodeAt(index) <= 0xdfff && content.charCodeAt(index - 1) >= 0xd800 && content.charCodeAt(index - 1) <= 0xdbff

// The letter boundary nearest a point in layer pixels.
export function indexAt(layout: TextLayout, x: number, y: number) {
  const lineHeightPx = lineHeight(layout.style)
  const i = Math.max(0, Math.min(layout.lines.length - 1, Math.floor((y - textPadding) / lineHeightPx)))
  const line = layout.lines[i]
  let best = line.start, distance = Infinity
  for (let k = 0; k < line.xs.length; k++) {
    const index = line.start + k
    if (index > line.end) break
    if (insidePair(layout.style.content, index)) continue
    const d = Math.abs(line.left + line.xs[k] - x)
    if (d < distance) { distance = d; best = index }
  }
  return best
}

// The index on the line above or below `index`, nearest the same x (`x` kept across moves, as text editors do).
export function verticalMove(layout: TextLayout, index: number, direction: 1 | -1, x: number) {
  const target = lineOf(layout, index) + direction
  if (target < 0) return 0
  if (target >= layout.lines.length) return layout.style.content.length
  const line = layout.lines[target]
  return indexAt(layout, x, line.top + 1)
}

// The selection's highlight, one rectangle a line, in layer pixels.
export function selectionRects(layout: TextLayout, start: number, end: number) {
  const rects: { x: number; y: number; w: number; h: number }[] = []
  if (end <= start) return rects
  for (const line of layout.lines) {
    const a = Math.max(start, line.start), b = Math.min(end, line.end)
    const newline = end > line.end && line.end < layout.style.content.length && layout.style.content[line.end] === '\n'
    if (b < a || (b === a && !newline)) continue
    const x0 = line.left + line.xs[a - line.start], x1 = line.left + line.xs[b - line.start] + (newline ? layout.style.fontSize * 0.25 : 0)
    rects.push({ x: x0, y: line.baseline - layout.ascent, w: Math.max(1, x1 - x0), h: layout.ascent + layout.descent })
  }
  return rects
}

// The word around `index`, for a double-click.
export function wordAt(content: string, index: number): [number, number] {
  const word = /[\p{L}\p{N}_']/u
  let a = index, b = index
  while (a > 0 && word.test(content[a - 1])) a--
  while (b < content.length && word.test(content[b])) b++
  return a === b ? [index, Math.min(content.length, index + 1)] : [a, b]
}
