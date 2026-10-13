import { describe, expect, it } from 'vitest'
import { defaultTextStyle, readTextStyle, replaceText, setTextColor, setTextFont, textLayerName, uniformFont, writeTextStyle } from '../src/model/text'

// TypeTool.swift's LayerTextStyle: runs of letters in other colors and faces, kept through typing, saved as the Mac saves them.
describe('text layers', () => {
  const style = () => ({ ...defaultTextStyle(), content: 'Hello world' })
  it('colors and sets faces on letters, merging runs, and takes the whole text back to one', () => {
    let s = setTextColor(style(), [1, 0, 0], 0, 5)
    expect(s.colorRuns).toEqual([{ location: 0, length: 5, red: 1, green: 0, blue: 0 }])
    s = setTextColor(s, [1, 0, 0], 5, 6)
    expect(s.colorRuns).toEqual([{ location: 0, length: 6, red: 1, green: 0, blue: 0 }])
    s = setTextColor(s, [0, 0, 1], 0, 0)
    expect([s.colorRuns, s.blue]).toEqual([undefined, 1])
    s = setTextFont(s, 'Georgia', 6, 11)
    expect(s.fontRuns).toEqual([{ location: 6, length: 5, fontName: 'Georgia' }])
    expect([uniformFont(s, 6, 11), uniformFont(s, 0, 11)]).toEqual(['Georgia', null])
    expect(setTextFont(s, 'Georgia', 0, 6).fontRuns).toBeUndefined()
  })
  it('gives typed letters the color and face of the letter before', () => {
    const s = setTextFont(setTextColor(style(), [0, 1, 0], 6, 11), 'Georgia', 6, 11)
    const typed = replaceText(s, 11, 11, '!!')
    expect(typed.content).toBe('Hello world!!')
    expect(typed.colorRuns).toEqual([{ location: 6, length: 7, red: 0, green: 1, blue: 0 }])
    expect(typed.fontRuns).toEqual([{ location: 6, length: 7, fontName: 'Georgia' }])
    const deleted = replaceText(typed, 5, 13, '')
    expect([deleted.content, deleted.colorRuns, deleted.fontRuns]).toEqual(['Hello', undefined, undefined])
  })
  it('reads the Mac\'s metadata and rejects what it would', () => {
    const saved = writeTextStyle({ ...style(), boxSize: [300, 120] })
    expect(saved.boxSize).toEqual([300, 120])
    expect(readTextStyle(JSON.parse(JSON.stringify(saved)))?.boxSize).toEqual([300, 120])
    expect(readTextStyle({ ...saved, fontSize: 5000 })).toBeNull()
    expect(readTextStyle({ ...saved, colorRuns: [{ location: 8, length: 9, red: 0, green: 0, blue: 0 }] })).toBeNull()
    expect(textLayerName('  Big\n\nTitle   here ')).toBe('Big Title here')
  })
})
