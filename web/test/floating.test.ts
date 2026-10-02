import { describe, expect, it } from 'vitest'
import { store } from '../src/editor/store'
import { beginTransformSelection, cancelFloating, commitFloating, isFloating } from '../src/editor/floating'
import { Raster } from '../src/model/raster'
import { fullTransform, newLayer } from '../src/model/types'

function open() {
  const image = new Raster(4, 4, 4)
  image.data.set([255, 0, 0, 255], (1 * 4 + 1) * 4)
  const layer = newLayer({ name: 'A', image, transform: fullTransform(4, 4) })
  store.open({ id: 'D', width: 4, height: 4, resolution: 72, layers: [layer], guides: [], extra: {} }, layer.id, null)
  const selection = new Raster(4, 4, 1)
  selection.data[1 * 4 + 1] = 255
  store.set({ selection })
  return layer.id
}
const red = (id: string, x: number, y: number) => store.layer(id)!.image!.data[(y * 4 + x) * 4]

describe('Transform Selection', () => {
  it('lifts, moves and merges the selected pixels as one step, the selection following', () => {
    const id = open()
    expect(beginTransformSelection()).toBe(true)
    expect(store.doc.layers.map(l => l.name)).toEqual(['A', 'Floating Selection'])
    expect(red(id, 1, 1)).toBe(0)
    const temp = store.active!
    store.beginGesture('Move')
    store.updateLayerLive(temp.id, { transform: { ...temp.transform, origin: [2, 1] } })
    store.endGesture()
    commitFloating()
    expect(isFloating()).toBe(false)
    expect(store.doc.layers.map(l => l.name)).toEqual(['A'])
    expect(red(id, 2, 1)).toBe(255)
    expect(red(id, 1, 1)).toBe(0)
    expect(store.state.selection!.data[1 * 4 + 2]).toBe(255)
    expect(store.history.undoName).toBe('Transform Selection')
    store.undo()
    expect(red(id, 1, 1)).toBe(255)
    expect(red(id, 2, 1)).toBe(0)
  })

  it('restores everything on Escape', () => {
    const id = open()
    beginTransformSelection()
    cancelFloating()
    expect(store.doc.layers.map(l => l.name)).toEqual(['A'])
    expect(red(id, 1, 1)).toBe(255)
    expect(store.state.activeId).toBe(id)
  })
})
