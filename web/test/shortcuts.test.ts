import { describe, expect, it, vi } from 'vitest'
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

  it('takes ⌥⇧⌘W for Export As only while no shortcut has been given that key', async () => {
    vi.stubGlobal('localStorage', { getItem: () => '{}', setItem: () => {} })
    vi.resetModules()
    const { isExportAsAlias, isMac, saveOverrides } = await import('../src/editor/shortcuts')
    const event = { key: 'W', code: 'KeyW', metaKey: isMac, ctrlKey: !isMac, altKey: true, shiftKey: true } as KeyboardEvent
    expect(isExportAsAlias(event)).toBe(true)
    expect(isExportAsAlias({ ...event, shiftKey: false } as KeyboardEvent)).toBe(false)
    saveOverrides({ 'Menus:Close Project': { key: 'w', modifiers: 11 } })
    expect(isExportAsAlias(event)).toBe(false)
    vi.unstubAllGlobals()
  })

  it('loads saved shortcuts one at a time, keeping cleared ones and dropping only those that no longer fit', async () => {
    const saved = { 'Menus:Copy': { key: 'k', modifiers: 1 }, 'Menus:Cut': { key: '', modifiers: 0 }, 'Menus:Paste': { key: 'z', modifiers: 1 }, 'Menus:Gone': { key: 'q', modifiers: 3 } }
    vi.stubGlobal('localStorage', { getItem: () => JSON.stringify(saved), setItem: () => {} })
    vi.resetModules()
    const { shortcut, shortcutText, problem: check } = await import('../src/editor/shortcuts')
    expect(shortcut('Copy')).toEqual({ key: 'k', modifiers: 1 })
    expect(shortcutText('Cut')).toBe('')
    expect(shortcut('Paste')).toEqual({ key: 'v', modifiers: 1 })
    expect(check({ 'Menus:Cut': { key: '', modifiers: 0 }, 'Menus:Copy': { key: '', modifiers: 0 } })).toBeNull()
    vi.unstubAllGlobals()
  })
})
