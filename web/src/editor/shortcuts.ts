// Keyboard chords as KeyboardShortcuts.swift stores them: one key plus modifier bits Command 1, Option 2, Control 4, Shift 8.
// Overrides of the defaults live in localStorage under the Mac app's own key, in the same shape.
export type Chord = { key: string; modifiers: number }
export const Command = 1, Option = 2, Control = 4, Shift = 8

export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)

const special: Record<string, string> = { Backspace: '\u007f', Delete: '\u007f', Enter: '\r', Escape: '\u001b', Tab: '\t', ' ': ' ', ArrowLeft: '', ArrowRight: '', ArrowDown: '', ArrowUp: '' }
const codes: Record<string, string> = { BracketLeft: '[', BracketRight: ']', Equal: '=', Minus: '-', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backslash: '\\', Backquote: '`', Space: ' ' }
const folds: Record<string, string> = { '{': '[', '}': ']', '+': '=', '_': '-' }

// The chord a key event makes. On Windows and Linux, Control plays Command's part, as browsers expect.
export function chordOf(event: KeyboardEvent): Chord | null {
  if (['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'].includes(event.key)) return null
  let key = special[event.key]
  if (!key) {
    const letter = /^Key([A-Z])$/.exec(event.code), digit = /^(?:Digit|Numpad)(\d)$/.exec(event.code)
    key = letter ? letter[1].toLowerCase() : digit ? digit[1] : codes[event.code] ?? event.key.toLowerCase()
    key = folds[key] ?? key
  }
  if ([...key].length !== 1) return null
  const command = isMac ? event.metaKey : event.ctrlKey
  const control = isMac && event.ctrlKey
  return { key, modifiers: (command ? Command : 0) | (event.altKey ? Option : 0) | (control ? Control : 0) | (event.shiftKey ? Shift : 0) }
}

const keyNames: Record<string, string> = { '\u007f': 'Delete', '\r': 'Return', '\u001b': 'Esc', '\t': 'Tab', ' ': 'Space', '': '←', '': '→', '': '↓', '': '↑' }
export function chordLabel(chord: Chord | undefined) {
  if (!chord) return ''
  const key = keyNames[chord.key] ?? chord.key.toUpperCase()
  const m = chord.modifiers
  if (isMac) return `${m & Control ? '⌃' : ''}${m & Option ? '⌥' : ''}${m & Shift ? '⇧' : ''}${m & Command ? '⌘' : ''}${key}`
  return `${m & Command ? 'Ctrl+' : ''}${m & Control ? 'Ctrl+' : ''}${m & Option ? 'Alt+' : ''}${m & Shift ? 'Shift+' : ''}${key === 'Delete' ? 'Backspace' : key}`
}

export const sameChord = (a?: Chord, b?: Chord) => !!a && !!b && a.key === b.key && a.modifiers === b.modifiers
const c = (key: string, modifiers = 0): Chord => ({ key, modifiers })

export type ShortcutGroup = 'Menus' | 'Canvas & Layers'
export type ShortcutDefinition = { id: string; group: ShortcutGroup; title: string; chord: Chord }

// The Mac app's list, in its order, limited to what the web edition has. Browsers keep ⌘N, ⌘W and ⌘T (and their Shift forms)
// for themselves, so New Canvas, Close Project, New Blank Layer and Transform add Option here.
export const definitions: ShortcutDefinition[] = ([
  ['Menus', 'Undo', c('z', 1)], ['Menus', 'Redo', c('z', 9)], ['Menus', 'New Canvas', c('n', 3)], ['Menus', 'Open Project', c('o', 1)],
  ['Menus', 'Save', c('s', 1)], ['Menus', 'Save As', c('s', 9)], ['Menus', 'Export PNG', c('e', 9)], ['Menus', 'Export JPEG', c('s', 11)],
  ['Menus', 'Close Project', c('w', 3)], ['Menus', 'Fit Canvas', c('0', 1)], ['Menus', 'Actual Pixels', c('1', 1)], ['Menus', 'Zoom In', c('=', 1)],
  ['Menus', 'Zoom Out', c('-', 1)], ['Menus', 'Show Transform Controls', c('h', 1)], ['Menus', 'Cut', c('x', 1)], ['Menus', 'Copy', c('c', 1)],
  ['Menus', 'Copy Merged', c('c', 9)], ['Menus', 'Paste', c('v', 1)], ['Menus', 'Fill with Foreground', c('\u007f', 2)], ['Menus', 'Fill with Background', c('\u007f', 1)],
  ['Menus', 'Content-Aware Fill', c('\u007f', 8)], ['Menus', 'Select All', c('a', 1)], ['Menus', 'Deselect', c('d', 1)], ['Menus', 'Inverse Selection', c('i', 9)], ['Menus', 'Select Subject', c('a', 3)],
  ['Menus', 'Curves', c('m', 1)], ['Menus', 'Levels', c('l', 1)], ['Menus', 'Hue/Saturation', c('u', 1)], ['Menus', 'Invert Pixels / Mask', c('i', 1)],
  ['Menus', 'Canvas Size', c('c', 3)], ['Menus', 'Image Size', c('i', 3)], ['Menus', 'Transform Layer / Selection', c('t', 3)], ['Menus', 'Duplicate / Layer via Copy', c('j', 1)],
  ['Menus', 'Toggle Clipping Mask', c('g', 3)], ['Menus', 'Group Layers', c('g', 1)], ['Menus', 'Ungroup Layers', c('g', 9)], ['Menus', 'New Blank Layer', c('n', 11)],
  ['Menus', 'Move Layer Up', c(']', 1)], ['Menus', 'Move Layer Down', c('[', 1)], ['Menus', 'Merge Layers', c('e', 1)], ['Menus', 'Show Grid', c("'", 1)],
  ['Menus', 'Show Guides', c(';', 1)], ['Menus', 'Show Rulers', c('r', 1)], ['Menus', 'Snap', c(';', 9)], ['Menus', 'Lock Guides', c(';', 3)],
  ['Canvas & Layers', 'Select tool', c('a')], ['Canvas & Layers', 'Move / Transform tool', c('v')], ['Canvas & Layers', 'Hand tool', c('h')], ['Canvas & Layers', 'Zoom tool', c('z')],
  ['Canvas & Layers', 'Brush tool', c('b')], ['Canvas & Layers', 'Eraser', c('e')], ['Canvas & Layers', 'Spot Healing', c('j')], ['Canvas & Layers', 'Clone Stamp', c('s')],
  ['Canvas & Layers', 'Gradient tool', c('g')], ['Canvas & Layers', 'Shape tool', c('u')], ['Canvas & Layers', 'Eyedropper tool', c('i')], ['Canvas & Layers', 'Marquee / cycle shape', c('m')],
  ['Canvas & Layers', 'Magic', c('w')], ['Canvas & Layers', 'Lasso / cycle mode', c('l')], ['Canvas & Layers', 'Blur / Smudge / Liquify', c('r')], ['Canvas & Layers', 'Crop tool', c('c')],
  ['Canvas & Layers', 'Swap foreground/background', c('x')], ['Canvas & Layers', 'Reset colors', c('d')], ['Canvas & Layers', 'Cycle tool mode', c('\t')],
  ['Canvas & Layers', 'Delete selection / layer / effect', c('\u007f')], ['Canvas & Layers', 'Apply current canvas operation', c('\r')], ['Canvas & Layers', 'Cancel current canvas operation', c('\u001b')],
  ['Canvas & Layers', 'Decrease brush size', c('[')], ['Canvas & Layers', 'Increase brush size', c(']')], ['Canvas & Layers', 'Decrease brush hardness', c('[', 8)], ['Canvas & Layers', 'Increase brush hardness', c(']', 8)],
  ['Canvas & Layers', 'Previous blend mode', c('-', 8)], ['Canvas & Layers', 'Next blend mode', c('=', 8)], ['Canvas & Layers', 'Cycle shape kind', c('u', 8)],
  ...Array.from({ length: 10 }, (_, n) => ['Canvas & Layers', `Opacity digit ${n} (type two for exact %)`, c(String(n))]),
  ...(['Left', 'Right', 'Up', 'Down'] as const).flatMap((d, i) => { const key = ['', '', '', ''][i]; return [['Canvas & Layers', `Nudge ${d} 1 px`, c(key)], ['Canvas & Layers', `Nudge ${d} 10 px`, c(key, 8)], ['Canvas & Layers', `Move selected pixels ${d} 1 px`, c(key, 1)], ['Canvas & Layers', `Move selected pixels ${d} 10 px`, c(key, 9)]] }),
] as [ShortcutGroup, string, Chord][]).map(([group, title, chord]) => ({ id: `${group}:${title}`, group, title, chord }))

const reserved = [c('q', 1), c(',', 1), ...['n', 'w', 't'].flatMap(key => [c(key, 1), c(key, 9)])]
const storageKey = 'keyboardShortcuts.v1'
let overrides: Record<string, Chord> = load()

function load(): Record<string, Chord> {
  try {
    const raw = JSON.parse(localStorage.getItem(storageKey) ?? '{}')
    return problem(raw) ? {} : raw
  } catch { return {} }
}

export const effective = (id: string, from = overrides) => from[id] ?? definitions.find(d => d.id === id)?.chord
export const shortcut = (title: string, group: ShortcutGroup = 'Menus') => effective(`${group}:${title}`)
export const shortcutText = (title: string, group: ShortcutGroup = 'Menus') => chordLabel(shortcut(title, group))
export const currentOverrides = () => ({ ...overrides })

// The first reason a set of overrides can't be saved, or null.
export function problem(draft: Record<string, Chord>): string | null {
  const seen = new Map<string, string>()
  for (const definition of definitions) {
    const chord = effective(definition.id, draft)!
    if ([...chord.key].length !== 1 || chord.modifiers < 0 || chord.modifiers > 15) return 'Choose a single key with optional modifiers.'
    if (reserved.some(r => sameChord(r, chord))) return `${chordLabel(chord)} is reserved by the browser.`
    const key = `${chord.key}|${chord.modifiers}`
    const first = seen.get(key)
    if (first) return `${chordLabel(chord)} is assigned to both ${first} and ${definition.title}.`
    seen.set(key, definition.title)
  }
  return null
}

const listeners = new Set<() => void>()
export function subscribeShortcuts(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } }
export function saveOverrides(next: Record<string, Chord>) {
  overrides = Object.fromEntries(Object.entries(next).filter(([id, chord]) => !sameChord(chord, definitions.find(d => d.id === id)?.chord)))
  try { localStorage.setItem(storageKey, JSON.stringify(overrides)) } catch { /* private mode: keep them for this session */ }
  listeners.forEach(listener => listener())
}

// Which definition a key event triggers, by effective chord.
export function definitionFor(event: KeyboardEvent): ShortcutDefinition | undefined {
  const chord = chordOf(event)
  if (!chord) return
  return definitions.find(d => sameChord(effective(d.id), chord))
}
