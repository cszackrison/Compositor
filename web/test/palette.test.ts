import { describe, expect, it } from 'vitest'
import { paletteScore, rankPalette, type PaletteEntry } from '../src/editor/palette'

const entry = (title: string, enabled = true): PaletteEntry => ({ id: title, title, enabled, run: () => {} })
const ids = (entries: PaletteEntry[], query: string) => rankPalette(entries, query).map(e => e.id)

// CommandPaletteTests.swift's cases.
describe('command palette search', () => {
  it('matches letters in order, any case, favoring word starts', () => {
    expect(paletteScore('gb', 'Filter › Gaussian Blur…')).not.toBeNull()
    expect(paletteScore('BLUR', 'Filter › Gaussian Blur…')).not.toBeNull()
    expect(paletteScore('bg', 'Filter › Gaussian Blur…')).toBeNull()
    expect(paletteScore('', 'Anything')).toBe(0)
    expect(paletteScore('gb', 'Filter › Gaussian Blur…')!).toBeGreaterThan(paletteScore('gb', 'Edit › Debug Tab')!)
  })

  it('ranks the best and the enabled first', () => {
    const entries = [entry('Edit › Paste'), entry('Layer › Flip Layer Horizontal'), entry('Filter › Gaussian Blur…'), entry('Filter › Motion Blur…'), entry('Edit › Undo', false), entry('Image › Levels…')]
    expect(ids(entries, 'gau')[0]).toBe('Filter › Gaussian Blur…')
    expect(new Set(ids(entries, 'blur'))).toEqual(new Set(['Filter › Gaussian Blur…', 'Filter › Motion Blur…']))
    expect(ids(entries, 'fl')[0]).toBe('Layer › Flip Layer Horizontal')
    const all = ids(entries, '')
    expect([all.length, all[0], all.at(-1)]).toEqual([entries.length, 'Edit › Paste', 'Edit › Undo'])
    expect(ids(entries, 'e u').at(-1)).toBe('Edit › Undo')
  })

  it('puts whole words before scattered letters, and typed words starting words first', () => {
    expect(ids([entry('Layer › New Adjustment Layer › Hue/Saturation…'), entry('Tool › Lasso'), entry('Tool › Polygonal Lasso')], 'lasso')).toEqual(['Tool › Lasso', 'Tool › Polygonal Lasso', 'Layer › New Adjustment Layer › Hue/Saturation…'])
    expect(ids([entry('Tool › Spot Healing Brush'), entry('Filter › Gaussian Blur…')], 'gb')[0]).toBe('Filter › Gaussian Blur…')
    expect(ids([entry('Filter › Gaussian Blur…'), entry('Layer › New Layer')], 'newlayer')).toEqual(['Layer › New Layer'])
    expect(ids([entry('Layer › New Adjustment Layer › Curves…'), entry('Layer › New Adjustment Layer › Exposure…'), entry('Layer › Duplicate Layer'), entry('Layer › New Blank Layer')], 'new layer')[0]).toBe('Layer › New Blank Layer')
  })
})
