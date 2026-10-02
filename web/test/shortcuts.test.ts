import { describe, expect, it } from 'vitest'
import { chordOf, definitions, problem } from '../src/editor/shortcuts'

describe('keyboard shortcuts', () => {
  it('ship without conflicts or browser-reserved chords', () => {
    expect(problem({})).toBeNull()
    expect(new Set(definitions.map(d => d.id)).size).toBe(definitions.length)
  })

  it('reports a conflict by name', () => {
    expect(problem({ 'Menus:Copy': { key: 'z', modifiers: 1 } })).toMatch(/assigned to both Undo and Copy/)
  })

  it('reads keys the way the Mac app stores them', () => {
    const event = (init: KeyboardEventInit & { code: string }) => ({ metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...init }) as KeyboardEvent
    expect(chordOf(event({ key: 'Z', code: 'KeyZ', ctrlKey: true, shiftKey: true }))).toEqual({ key: 'z', modifiers: 9 })
    expect(chordOf(event({ key: '}', code: 'BracketRight', shiftKey: true }))).toEqual({ key: ']', modifiers: 8 })
    expect(chordOf(event({ key: 'Backspace', code: 'Backspace', altKey: true }))).toEqual({ key: '\u007f', modifiers: 2 })
  })
})
