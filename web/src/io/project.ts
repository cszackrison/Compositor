import { decodePNG, encodePNG } from '../model/raster'
import { type Adjustment, type BlendMode, type ColorRange, type Doc, type Layer, type Transform, blendModes, formatVersion, maxSide, adjustmentKinds } from '../model/types'
import type { PackageFiles } from './files'

const known = new Set(['id', 'name', 'isVisible', 'transform', 'imageFile', 'parentID', 'isGroup', 'opacity', 'blendMode', 'maskFile', 'maskEnabled', 'maskSourceID', 'adjustment', 'maskPlacement', 'maskLinked', 'shape', 'effects', 'text'])
const knownTop = new Set(['format', 'version', 'colorSpace', 'resolution', 'documentID', 'width', 'height', 'activeLayerID', 'layers', 'guides'])

function fail(message: string): never { throw new Error(`This is not a valid Compositor project: ${message}.`) }

function validTransform(t: any): t is Transform {
  return t && Array.isArray(t.origin) && Array.isArray(t.size) && [...t.origin, ...t.size, t.rotation].every(Number.isFinite) && t.size[0] >= 1 && t.size[1] >= 1 && ['Nearest', 'Smooth', 'High quality'].includes(t.sampling)
}

// Swift writes [ColorRange: X] as ["Master", {...}, "Reds", {...}]; accept that or a plain object.
function fromPairs<T>(value: unknown): Partial<Record<ColorRange, T>> {
  if (!Array.isArray(value)) return (value ?? {}) as Partial<Record<ColorRange, T>>
  const out: Partial<Record<ColorRange, T>> = {}
  for (let i = 0; i + 1 < value.length; i += 2) out[value[i] as ColorRange] = value[i + 1]
  return out
}
const toPairs = (value: object) => Object.entries(value).flat()

function readAdjustment(raw: any): Adjustment {
  if (!adjustmentKinds.includes(raw.kind)) fail(`unknown adjustment kind "${raw.kind}"`)
  const adjustment = structuredClone(raw) as Adjustment
  if (raw.hsvSettings) adjustment.hsvSettings = { ...raw.hsvSettings, adjustments: fromPairs(raw.hsvSettings.adjustments), bands: fromPairs(raw.hsvSettings.bands) }
  return adjustment
}

function writeAdjustment(adjustment: Adjustment) {
  const out: any = structuredClone(adjustment)
  if (adjustment.hsvSettings) {
    out.hsvSettings = { ...adjustment.hsvSettings, adjustments: toPairs(adjustment.hsvSettings.adjustments), bands: toPairs(adjustment.hsvSettings.bands) }
    const master = adjustment.hsvSettings.adjustments[adjustment.hsvSettings.range]
    Object.assign(out, { hue: master?.hue ?? 0, saturation: master?.saturation ?? 0, lightness: master?.lightness ?? 0, colorize: adjustment.hsvSettings.colorize })
  }
  return out
}

export async function readProject(files: PackageFiles): Promise<{ doc: Doc; activeId: string | null }> {
  const bytes = files.get('manifest.json')
  if (!bytes) fail('manifest.json is missing')
  let manifest: any
  try { manifest = JSON.parse(new TextDecoder().decode(bytes)) } catch { fail('manifest.json is not valid JSON') }
  if (manifest.format !== 'com.compositor.project') fail('the manifest is not a Compositor manifest')
  if (!Number.isInteger(manifest.version) || manifest.version < 1 || manifest.version > formatVersion) throw new Error(`This project uses format version ${manifest.version}. This app supports versions 1–${formatVersion}.`)
  if (!(manifest.width >= 1 && manifest.width <= maxSide && manifest.height >= 1 && manifest.height <= maxSide)) fail('the canvas size is out of range')
  const records: any[] = manifest.layers ?? []
  const ids = new Set<string>()
  const layers: Layer[] = []
  for (const record of records) {
    const id = String(record.id).toUpperCase()
    if (ids.has(id)) fail('two layers share an ID')
    ids.add(id)
    if (!validTransform(record.transform)) fail(`layer "${record.name}" has an invalid transform`)
    const image = record.imageFile ? files.get(`images/${record.imageFile}`) : undefined
    if (record.imageFile && !image) fail(`the image for "${record.name}" is missing`)
    const mask = record.maskFile ? files.get(`images/${record.maskFile}`) : undefined
    if (record.maskFile && !mask) fail(`the mask for "${record.name}" is missing`)
    const blendMode = (record.blendMode ?? 'Normal') as BlendMode
    if (!blendModes.includes(blendMode)) fail(`unknown blend mode "${record.blendMode}"`)
    const extra = Object.fromEntries(Object.entries(record).filter(([key]) => !known.has(key)))
    layers.push({
      id, name: String(record.name), visible: record.isVisible !== false, isGroup: record.isGroup === true, parentId: record.parentID ? String(record.parentID).toUpperCase() : null,
      transform: record.transform, opacity: record.opacity ?? 1, blendMode,
      image: image ? decodePNG(image, 4) : null, mask: mask ? decodePNG(mask, 1) : null, maskEnabled: record.maskEnabled !== false, maskLinked: record.maskLinked !== false,
      maskPlacement: record.maskPlacement && validTransform(record.maskPlacement) ? record.maskPlacement : null,
      clipTo: record.maskSourceID ? String(record.maskSourceID).toUpperCase() : null,
      adjustment: record.adjustment ? readAdjustment(record.adjustment) : null, effects: record.effects ?? null, text: record.text, shape: record.shape, extra,
    })
    await Promise.resolve()
  }
  for (const layer of layers) {
    if (layer.parentId && !layers.find(other => other.id === layer.parentId)?.isGroup) fail(`layer "${layer.name}" is inside a folder that doesn't exist`)
    if (layer.clipTo && !ids.has(layer.clipTo)) layer.clipTo = null
  }
  const activeId = manifest.activeLayerID ? String(manifest.activeLayerID).toUpperCase() : null
  return {
    doc: { id: String(manifest.documentID ?? crypto.randomUUID()).toUpperCase(), width: manifest.width, height: manifest.height, resolution: manifest.resolution ?? 72, layers, guides: manifest.guides ?? [], extra: Object.fromEntries(Object.entries(manifest).filter(([key]) => !knownTop.has(key))) },
    activeId: activeId && ids.has(activeId) ? activeId : layers.at(-1)?.id ?? null,
  }
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortKeys((value as any)[key])]))
  return value
}

// Writes the package the way the Mac app does: pretty-printed sorted-key JSON, a PNG per layer image and mask, named by layer ID.
export function writeProject(doc: Doc, activeId: string | null): PackageFiles {
  const files: PackageFiles = new Map()
  const layers = doc.layers.map(layer => {
    const record: any = { ...layer.extra, id: layer.id, name: layer.name.trim() || 'Layer', isVisible: layer.visible, transform: layer.transform, isGroup: layer.isGroup, opacity: layer.opacity, blendMode: layer.isGroup ? 'Normal' : layer.blendMode }
    if (layer.parentId) record.parentID = layer.parentId
    if (layer.image && !layer.isGroup && !layer.adjustment) {
      record.imageFile = `${layer.id}.png`
      files.set(`images/${record.imageFile}`, encodePNG(layer.image))
    }
    if (layer.mask) {
      record.maskFile = `${layer.id}.mask.png`
      record.maskEnabled = layer.maskEnabled
      record.maskLinked = layer.maskLinked
      if (layer.maskPlacement && !layer.isGroup && !layer.adjustment) record.maskPlacement = layer.maskPlacement
      files.set(`images/${record.maskFile}`, encodePNG(layer.mask))
    }
    if (layer.clipTo) record.maskSourceID = layer.clipTo
    if (layer.adjustment) record.adjustment = writeAdjustment(layer.adjustment)
    if (layer.effects && Object.keys(layer.effects).length) record.effects = layer.effects
    if (layer.text !== undefined && record.imageFile) record.text = layer.text
    if (layer.shape !== undefined && record.imageFile) record.shape = layer.shape
    return record
  })
  const manifest: any = { ...doc.extra, format: 'com.compositor.project', version: formatVersion, colorSpace: 'sRGB', resolution: doc.resolution, documentID: doc.id, width: doc.width, height: doc.height, layers }
  if (activeId && doc.layers.some(layer => layer.id === activeId)) manifest.activeLayerID = activeId
  if (doc.guides.length) manifest.guides = doc.guides
  files.set('manifest.json', new TextEncoder().encode(JSON.stringify(sortKeys(manifest), null, 2)))
  return files
}
