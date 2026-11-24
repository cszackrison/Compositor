import { describe, expect, it, vi } from 'vitest'
import { store } from '../src/editor/store'
import { beginPixelMove } from '../src/editor/clipboard'
import { beginTransformSelection, commitFloating } from '../src/editor/floating'
import { marquee } from '../src/tools/select'
import type { Pointer } from '../src/tools/tool'
import { Raster } from '../src/model/raster'
import { bounds } from '../src/model/selection'
import { fullTransform, newLayer } from '../src/model/types'

vi.stubGlobal('requestAnimationFrame', () => 0)

const size = 60
function open() {
  const image = new Raster(size, size, 4)
  for (let i = 0; i < image.data.length; i += 4) image.data.set([200, 0, 0, 255], i)
  const layer = newLayer({ name: 'A', image, transform: fullTransform(size, size) })
  store.open({ id: 'D', width: size, height: size, resolution: 72, layers: [layer], guides: [], extra: {} }, layer.id, null)
  const box = new Raster(size, size, 1)
  for (let y = 20; y < 30; y++) for (let x = 20; x < 30; x++) box.data[y * size + x] = 255
  store.setSelection(box)
  store.modifySelection('feather', 2)
}
const pointer = (x: number, y: number, more: Partial<Pointer> = {}): Pointer => ({ point: [x, y], screen: [x, y], shift: false, alt: false, command: false, control: false, button: 0, clicks: 1, coalesced: [], ...more })
const expandedBox = () => { store.modifySelection('expand', 3); return bounds(store.state.selection!)! }

describe('a feathered selection that is moved', () => {
  const still = (() => { open(); return expandedBox() })()

  it('keeps its place when expanded after its outline is dragged', () => {
    open()
    marquee.down!(pointer(25, 25)); marquee.move!(pointer(32, 25)); marquee.up!(pointer(32, 25))
    expect(store.state.selectionFeather).toBe(2)
    expect(expandedBox()).toEqual({ ...still, x: still.x + 7 })
  })

  it('keeps its place when expanded after its pixels are moved', () => {
    open()
    const move = beginPixelMove(false)!
    move.preview(0, 6); move.finish()
    expect(expandedBox()).toEqual({ ...still, y: still.y + 6 })
  })

  it('keeps its place and feather when expanded after a transformed selection is committed', () => {
    open()
    expect(beginTransformSelection()).toBe(true)
    const temp = store.active!
    store.beginGesture('Move')
    store.updateLayerLive(temp.id, { transform: { ...temp.transform, origin: [temp.transform.origin[0] + 5, temp.transform.origin[1] + 4] } })
    store.endGesture()
    commitFloating()
    expect(store.state.selectionFeather).toBe(2)
    expect(expandedBox()).toEqual({ ...still, x: still.x + 5, y: still.y + 4 })
  })

  it('clears feather and base when canvas geometry drops the selection', () => {
    open()
    store.flipCanvas('x')
    expect([store.state.selection, store.state.selectionFeather, store.state.selectionBase]).toEqual([null, 0, null])
    open()
    store.resizeCanvas(50, 50, 0, 0)
    expect([store.state.selection, store.state.selectionFeather, store.state.selectionBase]).toEqual([null, 0, null])
  })
})
