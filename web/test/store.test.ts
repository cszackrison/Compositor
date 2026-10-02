import { describe, expect, it } from 'vitest'
import { Store } from '../src/editor/store'
import { Raster } from '../src/model/raster'
import { fullTransform, newLayer, type Doc } from '../src/model/types'

function setup() {
  const store = new Store()
  const layers = ['A', 'B', 'C'].map(name => newLayer({ name, transform: fullTransform(4, 4), image: new Raster(4, 4, 4) }))
  const doc: Doc = { id: 'D', width: 4, height: 4, resolution: 72, layers, guides: [], extra: {} }
  store.open(doc, layers[2].id, null)
  // Bottom to top in drawing order (a folder's contents just below the folder), which is all the format defines.
  const names = () => { const out: string[] = []; const walk = (parent: string | null, prefix: string) => { for (const l of store.doc.layers.filter(l => l.parentId === parent)) { if (l.isGroup) walk(l.id, `${prefix}${l.name}/`); out.push(prefix + l.name) } }; walk(null, ''); return out }
  const id = (name: string) => store.doc.layers.find(l => l.name === name)!.id
  return { store, names, id }
}

describe('layer operations', () => {
  it('groups, moves into and out of folders, ungroups, and undoes each step', () => {
    const { store, names, id } = setup()
    store.setActive(id('A')); store.setActive(id('B'), 'toggle')
    store.group()
    expect(names()).toEqual(['Group 1/A', 'Group 1/B', 'Group 1', 'C'])
    store.move([id('C')], { into: id('Group 1') })
    expect(names()).toEqual(['Group 1/A', 'Group 1/B', 'Group 1/C', 'Group 1'])
    store.move([id('A')], { above: id('Group 1') })
    expect(names()).toEqual(['Group 1/B', 'Group 1/C', 'Group 1', 'A'])
    store.setActive(id('Group 1'))
    store.ungroup()
    expect(names()).toEqual(['B', 'C', 'A'])
    store.undo(); store.undo(); store.undo(); store.undo()
    expect(names()).toEqual(['A', 'B', 'C'])
    store.redo()
    expect(names()).toEqual(['Group 1/A', 'Group 1/B', 'Group 1', 'C'])
  })

  it('duplicates a folder with fresh IDs and its own pixels', () => {
    const { store, names, id } = setup()
    store.setActive(id('B')); store.group()
    store.duplicate()
    expect(names()).toEqual(['A', 'Group 1/B', 'Group 1', 'Group 1 copy/B', 'Group 1 copy', 'C'])
    const [first, second] = store.doc.layers.filter(l => l.name === 'B')
    expect(first.id).not.toBe(second.id)
    expect(first.image).not.toBe(second.image)
  })

  it('clips to the layer below and releases when the base is deleted', () => {
    const { store, id } = setup()
    store.setActive(id('C')); store.toggleClip()
    expect(store.layer(id('C'))!.clipTo).toBe(id('B'))
    store.setActive(id('B')); store.deleteSelected()
    expect(store.layer(id('C'))!.clipTo).toBeNull()
  })

  it('coalesces slider drags into one undo step', () => {
    const { store, id } = setup()
    for (const opacity of [0.9, 0.8, 0.7]) store.updateLayer(id('A'), { opacity }, 'Opacity', 'opacity')
    store.undo()
    expect(store.layer(id('A'))!.opacity).toBe(1)
  })

  it('fills only the selection, and undo restores the pixels', () => {
    const { store, id } = setup()
    store.setActive(id('A'))
    const selection = new Raster(4, 4, 1); selection.data[5] = 255
    store.setSelection(selection)
    store.fill([255, 0, 0])
    const image = store.layer(id('A'))!.image!
    expect([...image.data.slice(20, 24)]).toEqual([255, 0, 0, 255])
    expect(image.data[3]).toBe(0)
    store.undo()
    expect(image.data.every(v => v === 0)).toBe(true)
  })

  it('moves a layer out of its folder, just above it', () => {
    const { store, names, id } = setup()
    store.setActive(id('A')); store.setActive(id('B'), 'toggle'); store.group()
    store.setActive(id('A')); store.moveOutOfFolder()
    expect(names()).toEqual(['Group 1/B', 'Group 1', 'A', 'C'])
  })

  it('unlinks a mask, which then saves its own placement and stays put', async () => {
    const { store, id } = setup()
    const { writeProject } = await import('../src/io/project')
    store.setActive(id('A')); store.addMask(id('A'))
    expect(store.mergeTitle).toBe('Merge Down')
    store.toggleMaskLink(id('A'))
    expect(store.layer(id('A'))!.maskLinked).toBe(false)
    store.set({ doc: { ...store.doc, layers: store.movedLayers(5, 0) } })
    const layer = store.layer(id('A'))!
    expect(layer.transform.origin).toEqual([5, 0])
    expect(layer.maskPlacement!.origin).toEqual([0, 0])
    const record = JSON.parse(new TextDecoder().decode(writeProject(store.doc, null).get('manifest.json'))).layers.find((l: any) => l.id === id('A'))
    expect(record.maskLinked).toBe(false)
    expect(record.maskPlacement.origin).toEqual([0, 0])
  })

  it('duplicates every selected layer, and a folder keeps its clipping inside the copy', () => {
    const { store, names, id } = setup()
    store.setActive(id('A')); store.setActive(id('B'), 'toggle')
    store.duplicate()
    expect(names()).toEqual(['A', 'B', 'A copy', 'B copy', 'C'])
    expect(store.history.undoName).toBe('Duplicate Layers')
    store.undo()
    store.setActive(id('C')); store.toggleClip()
    store.setActive(id('B')); store.setActive(id('C'), 'toggle'); store.group()
    store.duplicate()
    const copy = store.doc.layers.find(l => l.name === 'C' && l.id !== id('C'))!
    const copyBase = store.doc.layers.find(l => l.name === 'B' && l.id !== id('B'))!
    expect(copy.clipTo).toBe(copyBase.id)
    expect(store.layer(id('C'))!.clipTo).toBe(id('B'))
  })
})
