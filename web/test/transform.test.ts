import { describe, expect, it } from 'vitest'
import { resize } from '../src/tools/move'
import { fullTransform } from '../src/model/types'

describe('resizing with handles', () => {
  const box = fullTransform(100, 50, 10, 10)
  it('keeps the opposite corner fixed and the ratio on corners', () => {
    const t = resize(box, 'se', [310, 60], true, false)
    expect(t.origin).toEqual([10, 10]); expect(t.size).toEqual([300, 150])
  })
  it('scales one axis from an edge, and frees the ratio with Shift', () => {
    expect(resize(box, 'e', [60, 999], true, false).size).toEqual([50, 50])
    expect(resize(box, 'se', [60, 110], false, false).size).toEqual([50, 100])
  })
  it('scales from the center with Option', () => {
    const t = resize(box, 'e', [140, 35], false, true)
    expect(t.size).toEqual([160, 50]); expect(t.origin).toEqual([-20, 10])
  })
  it('flips when dragged past the opposite side', () => {
    const t = resize(box, 'e', [-40, 35], false, false)
    expect(t.flipX).toBe(true); expect(t.size).toEqual([50, 50]); expect(t.origin).toEqual([-40, 10])
  })
})
