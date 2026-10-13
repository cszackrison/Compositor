import { unzlibSync } from 'fflate'
import { Raster } from '../model/raster'
import { type Adjustment, type BlendMode, type ColorRange, type Layer, colorRanges, documentPixelBudget, fullTransform, maxSide, maxSurfacePixels, newAdjustment, newLayer, uuid } from '../model/types'
import { type TextStyle, writeTextStyle } from '../model/text'
import type { ShapeStyle } from '../tools/shape'
import { type CMYKProfile, chosenProfile, fromInks, readProfile } from './cmyk'
import { type PSDTextSource, parseText, missingFontNote, rasterizedNote, textTransform } from './psdText'
import { type PathCommand, vectorLive, vectorRaster } from './psdVector'

// Reads Photoshop .psd and .psb files from Adobe's Photoshop File Formats Specification (2019 HTML edition: File Header, Color Mode
// Data, Image Resources, Layer and Mask Information, Image Data), as PSDReader.swift does. An original implementation of the 8BPS
// header, layer records, PackBits and additional layer info, not copied, transcribed or adapted from GIMP, psd-tools or any other
// GPL-licensed PSD reader.

export type Rect = { x: number; y: number; width: number; height: number }

const messages = {
  truncated: 'The Photoshop file could not be read. It may be damaged or incomplete.',
  unsupportedVersion: 'This Photoshop file uses a format version Compositor can’t read.',
  unsupportedColorMode: 'Only 8-bit RGB and CMYK Photoshop files can be imported.',
  unsupportedDepth: 'Only 8-bit RGB and CMYK Photoshop files can be imported.',
  unsupportedCompression: 'This Photoshop file uses a layer compression method that isn’t supported.',
  unreadable: 'The image could not be read. It may be damaged or unavailable.',
  tooLarge: `This import exceeds the current ${Math.floor(documentPixelBudget / 1_000_000)}-megapixel document budget or ${maxSide.toLocaleString('en-US')}-pixel side limit.`,
  // The Mac falls back to Generic CMYK; browsers ship no CMYK profile.
  noProfile: 'This CMYK Photoshop file has no profile of its own. Load a CMYK profile (View › CMYK › Profile › Load Profile…) to open it.',
}
export type PSDErrorCode = keyof typeof messages
export class PSDError extends Error { constructor(readonly code: PSDErrorCode) { super(messages[code]) } }

export type PSDConversion = { layerName: string; message: string }
export type PSDLayerKind = 'raster' | 'group' | 'adjustment' | 'text' | 'smartObject' | 'effects' | 'vector' | 'other'

// One layer or folder as read, bottom to top. `maskBounds` is where `mask` sits on the document and `maskDefault` the value
// everywhere outside it: Photoshop stores only the part of a mask that isn't that default.
export type PSDRecord = {
  id: string; parentId: string | null; name: string; isGroup: boolean; visible: boolean; opacity: number; blendKey: string; clipping: boolean
  croppedToCanvas: boolean; bounds: Rect; image: Raster | null; mask: Raster | null; maskBounds: Rect; maskDefault: number; maskEnabled: boolean; maskLinked: boolean
  adjustment: Adjustment | null; kind: PSDLayerKind; shape: ShapeStyle | null; shapeNotes: string[]
  // Parsed Photoshop type, when the TySh block maps onto an editable text layer.
  text: PSDTextSource | null
}
export const psdRecord = (fields: Partial<PSDRecord> & { name: string }): PSDRecord => ({ id: uuid(), parentId: null, isGroup: false, visible: true, opacity: 1, blendKey: 'norm', clipping: false, croppedToCanvas: false, bounds: { x: 0, y: 0, width: 0, height: 0 }, image: null, mask: null, maskBounds: { x: 0, y: 0, width: 0, height: 0 }, maskDefault: 255, maskEnabled: true, maskLinked: true, adjustment: null, kind: 'raster', shape: null, shapeNotes: [], text: null, ...fields })

// `cmykProfile`: a CMYK file's, which its layers were converted to RGB through. `merged`: a file with no layer records (only a
// background) as its merged image, which the Mac reads through ImageIO.
export type PSDDocument = { width: number; height: number; resolution: number; cmykProfile: CMYKProfile | null; layers: PSDRecord[]; merged?: Raster | null }

// What the browser draws for the reader and the builder: text and shapes as the Type and Shape tools draw them, Photoshop paths, and
// whether a font is installed. Tests stand in for the canvas here.
export type PSDDrawing = {
  text(style: TextStyle): Promise<{ raster: Raster; baseline: number }>
  shape(style: ShapeStyle, width: number, height: number): Raster
  path(commands: PathCommand[], box: { x: number; y: number }, width: number, height: number, fill: RGB | null, stroke: { color: RGB; width: number } | null): Raster
  fontInstalled(name: string): Promise<boolean>
}
export type RGB = [number, number, number]

export const blendFromPSD: Record<string, BlendMode> = {
  'norm': 'Normal', 'mul ': 'Multiply', 'scrn': 'Screen', 'over': 'Overlay', 'sLit': 'Soft Light', 'dark': 'Darken', 'lite': 'Lighten', 'diff': 'Difference', 'div ': 'Color Dodge', 'idiv': 'Color Burn',
  'hue ': 'Hue', 'sat ': 'Saturation', 'colr': 'Color', 'lum ': 'Luminosity', 'lbrn': 'Linear Burn', 'lddg': 'Linear Dodge (Add)', 'hLit': 'Hard Light', 'vLit': 'Vivid Light', 'lLit': 'Linear Light',
  'pLit': 'Pin Light', 'hMix': 'Hard Mix', 'smud': 'Exclusion', 'fsub': 'Subtract', 'fdiv': 'Divide',
  // Dissolve, Darker Color and Lighter Color are deliberately absent: Compositor has no equivalent, so they fall through to Normal and
  // say so in the conversion report.
}
const blendMode = (key: string): BlendMode | null => Object.hasOwn(blendFromPSD, key) ? blendFromPSD[key] : null

// MARK: Reading

class Cursor {
  offset = 0
  private view: DataView
  constructor(readonly data: Uint8Array) { this.view = new DataView(data.buffer, data.byteOffset, data.byteLength) }
  need(count: number) { if (this.offset < 0 || this.offset + count > this.data.length) throw new PSDError('truncated') }
  skip(count: number) { if (count < 0) throw new PSDError('truncated'); this.need(count); this.offset += count }
  u8() { this.need(1); return this.data[this.offset++] }
  u16() { this.need(2); const v = this.view.getUint16(this.offset); this.offset += 2; return v }
  i16() { this.need(2); const v = this.view.getInt16(this.offset); this.offset += 2; return v }
  u32() { this.need(4); const v = this.view.getUint32(this.offset); this.offset += 4; return v }
  i32() { this.need(4); const v = this.view.getInt32(this.offset); this.offset += 4; return v }
  u64() { this.need(8); const v = this.view.getUint32(this.offset) * 2 ** 32 + this.view.getUint32(this.offset + 4); this.offset += 8; return v }
  bytes(count: number) { this.need(count); const v = this.data.subarray(this.offset, this.offset + count); this.offset += count; return v }
  string(count: number) { return ascii(this.bytes(count)) }
}
export const ascii = (bytes: Uint8Array) => bytes.some(b => b > 127) ? '' : String.fromCharCode(...bytes)
const checkedLength = (value: number) => { if (!Number.isSafeInteger(value)) throw new PSDError('tooLarge'); return value }
const u32At = (data: Uint8Array, at: number) => ((data[at] << 24) >>> 0) + (data[at + 1] << 16) + (data[at + 2] << 8) + data[at + 3]

type Crop = { x: number; y: number; width: number; height: number }
type RawLayer = {
  name: string; top: number; left: number; bottom: number; right: number; sourceTop: number; sourceLeft: number; sourceBottom: number; sourceRight: number
  opacity: number; fill: number; clipping: boolean; hidden: boolean; blendKey: string; channels: { id: number; length: number }[]; extra: Map<string, Uint8Array>
  maskTop: number; maskLeft: number; maskBottom: number; maskRight: number; sourceMaskTop: number; sourceMaskLeft: number; sourceMaskBottom: number; sourceMaskRight: number
  maskDefault: number; maskDisabled: boolean; maskLinked: boolean; maskFromRender: boolean; hasMask: boolean; section: number | null
  image: Raster | null; maskImage: Raster | null; imageCrop: Crop | null; maskCrop: Crop | null; cropped: boolean
}

const psbLargeAdditionalInfoKeys = new Set(['LMsk', 'Lr16', 'Lr32', 'Layr', 'Mt16', 'Mt32', 'Mtrn', 'Alph', 'FMsk', 'lnk2', 'FEid', 'FXid', 'PxSD'])
export const adjustmentKeys = new Set(['levl', 'curv', 'hue2', 'hue ', 'expA', 'grdm', 'brit', 'blnc', 'nvrt', 'thrs', 'post', 'mixr', 'selc', 'blwh', 'phfl', 'vibA'])
// Transparency, R, G, B (C, M, Y and K in a CMYK file), and the user mask. Spot and other extra IDs are skipped before decode.
const unpackedChannelIDs = new Set([-1, 0, 1, 2, -2]), unpackedCMYKChannelIDs = new Set([-1, 0, 1, 2, 3, -2])

export async function readPSD(bytes: Uint8Array, draw: PSDDrawing, remainingPixels = documentPixelBudget): Promise<PSDDocument> {
  const cursor = new Cursor(bytes)
  if (bytes.length < 4 || cursor.string(4) !== '8BPS') throw new PSDError('unreadable')
  const version = cursor.u16()
  if (version !== 1 && version !== 2) throw new PSDError('unsupportedVersion')
  const isPSB = version === 2
  cursor.skip(6)
  const channelCount = cursor.u16(), canvasHeight = cursor.u32(), canvasWidth = cursor.u32(), depth = cursor.u16(), mode = cursor.u16()
  if (!(canvasWidth >= 1 && canvasWidth <= maxSide && canvasHeight >= 1 && canvasHeight <= maxSide && canvasWidth * canvasHeight <= maxSurfacePixels)) throw new PSDError('tooLarge')
  if (depth !== 8) throw new PSDError('unsupportedDepth')
  // RGB, or CMYK, whose layers come in as RGB through the file's own profile (Photoshop's color mode 4).
  if (mode !== 3 && mode !== 4) throw new PSDError('unsupportedColorMode')
  cursor.skip(cursor.u32())
  const resourcesLength = cursor.u32(), resourcesEnd = cursor.offset + resourcesLength
  let resolution = 72, icc: Uint8Array | null = null
  while (cursor.offset + 12 <= resourcesEnd) {
    if (cursor.string(4) !== '8BIM') break
    const id = cursor.u16(), nameLength = cursor.u8()
    cursor.skip(nameLength)
    if ((nameLength + 1) % 2 === 1) cursor.skip(1)
    const length = cursor.u32(), start = cursor.offset
    if (id === 1005 && length >= 4) {
      resolution = cursor.u32() / 65536
      if (!Number.isFinite(resolution) || resolution < 1) resolution = 72
      resolution = Math.min(9600, Math.max(1, resolution))
    }
    if (id === 1039 && length > 0) icc = cursor.bytes(length)
    cursor.offset = start + length
    if (length % 2 === 1) cursor.skip(1)
  }
  cursor.offset = resourcesEnd
  let cmykProfile: CMYKProfile | null = null
  if (mode === 4) {
    cmykProfile = (icc && await readProfile('Embedded CMYK Profile', icc)) || chosenProfile()
    if (!cmykProfile) throw new PSDError('noProfile')
  }
  const layerSection = checkedLength(isPSB ? cursor.u64() : cursor.u32()), layerSectionEnd = cursor.offset + layerSection
  const document: PSDDocument = { width: canvasWidth, height: canvasHeight, resolution, cmykProfile, layers: [] }
  if (layerSection >= 4) {
    const layerInfoLength = checkedLength(isPSB ? cursor.u64() : cursor.u32())
    const count = layerInfoLength >= 2 ? Math.abs(cursor.i16()) : 0
    if (count > 10_000) throw new PSDError('tooLarge')
    const raw: RawLayer[] = []
    for (let i = 0; i < count; i++) raw.push(readRecord(cursor, isPSB))
    if (!fitsBudget(raw, remainingPixels)) {
      for (const layer of raw) cropToCanvas(layer, canvasWidth, canvasHeight)
      if (!fitsBudget(raw, remainingPixels)) throw new PSDError('tooLarge')
    }
    let usedPixels = 0
    for (const layer of raw) {
      await decodeChannels(cursor, layer, remainingPixels - usedPixels, isPSB, cmykProfile)
      if (layer.image) usedPixels += layer.image.width * layer.image.height
    }
    document.layers = assemble(raw, { width: canvasWidth, height: canvasHeight }, remainingPixels - usedPixels, draw)
  }
  // Only a background: Photoshop writes no layer records, just the merged image, so that is what comes in, as one layer.
  if (!document.layers.length) {
    cursor.offset = layerSectionEnd
    if (canvasWidth * canvasHeight > remainingPixels) throw new PSDError('tooLarge')
    document.merged = await readMerged(cursor, canvasWidth, canvasHeight, channelCount, isPSB, cmykProfile)
  }
  return document
}

function readRecord(cursor: Cursor, isPSB: boolean): RawLayer {
  const top = cursor.i32(), left = cursor.i32(), bottom = cursor.i32(), right = cursor.i32()
  const layer: RawLayer = {
    name: '', top, left, bottom, right, sourceTop: top, sourceLeft: left, sourceBottom: bottom, sourceRight: right, opacity: 255, fill: 255, clipping: false, hidden: false, blendKey: 'norm', channels: [], extra: new Map(),
    maskTop: 0, maskLeft: 0, maskBottom: 0, maskRight: 0, sourceMaskTop: 0, sourceMaskLeft: 0, sourceMaskBottom: 0, sourceMaskRight: 0, maskDefault: 255, maskDisabled: false, maskLinked: true, maskFromRender: false, hasMask: false, section: null,
    image: null, maskImage: null, imageCrop: null, maskCrop: null, cropped: false,
  }
  const channelCount = cursor.u16()
  if (channelCount > 56) throw new PSDError('tooLarge')
  for (let i = 0; i < channelCount; i++) layer.channels.push({ id: cursor.i16(), length: checkedLength(isPSB ? cursor.u64() : cursor.u32()) })
  if (cursor.string(4) !== '8BIM') throw new PSDError('truncated')
  layer.blendKey = cursor.string(4)
  layer.opacity = cursor.u8()
  layer.clipping = cursor.u8() !== 0
  layer.hidden = (cursor.u8() & 2) !== 0
  cursor.skip(1)
  const extraLength = cursor.u32(), extraEnd = cursor.offset + extraLength
  const maskLength = cursor.u32(), maskEnd = cursor.offset + maskLength
  if (maskLength >= 20) {
    layer.hasMask = true
    layer.maskTop = layer.sourceMaskTop = cursor.i32(); layer.maskLeft = layer.sourceMaskLeft = cursor.i32()
    layer.maskBottom = layer.sourceMaskBottom = cursor.i32(); layer.maskRight = layer.sourceMaskRight = cursor.i32()
    layer.maskDefault = cursor.u8()
    const flags = cursor.u8()
    layer.maskDisabled = (flags & 2) !== 0; layer.maskLinked = (flags & 1) === 0; layer.maskFromRender = (flags & 8) !== 0
  }
  cursor.offset = maskEnd
  cursor.skip(cursor.u32())
  const nameCount = cursor.u8()
  layer.name = macRoman(cursor.bytes(nameCount))
  cursor.skip((4 - ((nameCount + 1) % 4)) % 4)
  while (cursor.offset + 12 <= extraEnd) {
    const signature = cursor.string(4)
    if (signature !== '8BIM' && signature !== '8B64') break
    const key = cursor.string(4)
    let length: number
    if (signature === '8B64' || (isPSB && psbLargeAdditionalInfoKeys.has(key))) {
      if (cursor.offset + 8 > extraEnd) break
      length = checkedLength(cursor.u64())
    } else length = cursor.u32()
    const payload = cursor.bytes(length)
    if (length % 2 === 1) cursor.skip(1)
    layer.extra.set(key, payload)
    if (key === 'luni') { const unicode = unicodeName(payload); if (unicode !== null) layer.name = unicode }
    if (key === 'iOpa' && payload.length) layer.fill = payload[0]
    if ((key === 'lsct' || key === 'lsdk') && payload.length >= 4) layer.section = u32At(payload, 0)
  }
  cursor.offset = extraEnd
  return layer
}

function macRoman(bytes: Uint8Array) {
  try { return new TextDecoder('macintosh').decode(bytes) } catch { return String.fromCharCode(...bytes) }
}

function unicodeName(data: Uint8Array): string | null {
  if (data.length < 4) return null
  const count = u32At(data, 0)
  if (count <= 0 || data.length < 4 + count * 2) return null
  return new TextDecoder('utf-16be').decode(data.subarray(4, 4 + count * 2)).replace(/^\0+|\0+$/g, '')
}

function fitsBudget(layers: RawLayer[], remainingPixels: number) {
  let used = 0
  for (const layer of layers) {
    const width = Math.max(0, layer.right - layer.left), height = Math.max(0, layer.bottom - layer.top)
    if (!fitsLayer(width, height, Math.max(0, layer.maskRight - layer.maskLeft), Math.max(0, layer.maskBottom - layer.maskTop), layer.hasMask, remainingPixels - used)) return false
    if (width > 0 && height > 0) used += width * height
  }
  return true
}

function fitsLayer(width: number, height: number, maskWidth: number, maskHeight: number, hasMask: boolean, remainingPixels: number) {
  const budget = Math.max(0, remainingPixels)
  if (width > 0 && height > 0 && !(width <= maxSide && height <= maxSide && width * height <= budget)) return false
  if (hasMask && maskWidth > 0 && maskHeight > 0 && !(maskWidth <= maxSide && maskHeight <= maxSide && maskWidth * maskHeight <= budget)) return false
  return true
}

function cropToCanvas(layer: RawLayer, width: number, height: number) {
  const image = crop(layer.left, layer.top, layer.right, layer.bottom, width, height)
  if (image.x !== 0 || image.y !== 0 || image.width !== layer.right - layer.left || image.height !== layer.bottom - layer.top) {
    layer.left += image.x; layer.top += image.y; layer.right = layer.left + image.width; layer.bottom = layer.top + image.height
    layer.imageCrop = image; layer.cropped = true
  }
  if (!layer.hasMask) return
  const mask = crop(layer.maskLeft, layer.maskTop, layer.maskRight, layer.maskBottom, width, height)
  if (mask.x !== 0 || mask.y !== 0 || mask.width !== layer.maskRight - layer.maskLeft || mask.height !== layer.maskBottom - layer.maskTop) {
    layer.maskLeft += mask.x; layer.maskTop += mask.y; layer.maskRight = layer.maskLeft + mask.width; layer.maskBottom = layer.maskTop + mask.height
    layer.maskCrop = mask; layer.cropped = true
  }
}

function crop(left: number, top: number, right: number, bottom: number, canvasWidth: number, canvasHeight: number): Crop {
  const l = Math.min(canvasWidth, Math.max(0, left)), t = Math.min(canvasHeight, Math.max(0, top))
  const r = Math.max(l, Math.min(canvasWidth, right)), b = Math.max(t, Math.min(canvasHeight, bottom))
  return { x: l - left, y: t - top, width: r - l, height: b - t }
}

async function decodeChannels(cursor: Cursor, layer: RawLayer, remainingPixels: number, isPSB: boolean, cmyk: CMYKProfile | null) {
  const planes = new Map<number, Uint8Array>()
  const width = Math.max(0, layer.right - layer.left), height = Math.max(0, layer.bottom - layer.top)
  const maskWidth = Math.max(0, layer.maskRight - layer.maskLeft), maskHeight = Math.max(0, layer.maskBottom - layer.maskTop)
  if (!fitsLayer(width, height, maskWidth, maskHeight, layer.hasMask, remainingPixels)) throw new PSDError('tooLarge')
  const sourceWidth = Math.max(0, layer.sourceRight - layer.sourceLeft), sourceHeight = Math.max(0, layer.sourceBottom - layer.sourceTop)
  const sourceMaskWidth = Math.max(0, layer.sourceMaskRight - layer.sourceMaskLeft), sourceMaskHeight = Math.max(0, layer.sourceMaskBottom - layer.sourceMaskTop)
  for (const channel of layer.channels) {
    const start = cursor.offset
    if ((cmyk ? unpackedCMYKChannelIDs : unpackedChannelIDs).has(channel.id) && channel.length >= 2) {
      const compression = cursor.u16(), payload = cursor.bytes(channel.length - 2), isMask = channel.id === -2
      if ((isMask ? maskWidth : width) > 0 && (isMask ? maskHeight : height) > 0)
        planes.set(channel.id, decodeChannel(compression, isMask ? sourceMaskWidth : sourceWidth, isMask ? sourceMaskHeight : sourceHeight, payload, isPSB, isMask ? layer.maskCrop : layer.imageCrop))
    }
    cursor.offset = start + Math.max(0, channel.length)
  }
  const gray = planes.get(-2)
  if (layer.hasMask && maskWidth > 0 && maskHeight > 0 && gray && gray.length >= maskWidth * maskHeight) layer.maskImage = new Raster(maskWidth, maskHeight, 1, gray.slice(0, maskWidth * maskHeight))
  if (width <= 0 || height <= 0) return
  const count = width * height, opaque = new Uint8Array(count).fill(255), black = new Uint8Array(count)
  let red = planes.get(0) ?? black, green = planes.get(1) ?? black, blue = planes.get(2) ?? black
  const alpha = planes.get(-1) ?? opaque
  if (cmyk) {
    // Inks are stored inverted: a missing channel is no ink.
    const inks = [0, 1, 2, 3].map(id => planes.get(id) ?? opaque)
    if (!inks.every(plane => plane.length >= count)) throw new PSDError('truncated')
    ;[red, green, blue] = await rgbPlanes(count, inks, cmyk)
  }
  if (![red, green, blue, alpha].every(plane => plane.length >= count)) throw new PSDError('truncated')
  layer.image = rgbaImage(width, height, red, green, blue, alpha)
}

// A CMYK layer's ink channels as RGB ones, through the document's profile. Photoshop stores CMYK channels inverted (255 is no ink), and
// colors as they are, not premultiplied.
async function rgbPlanes(count: number, [cyan, magenta, yellow, black]: Uint8Array[], profile: CMYKProfile): Promise<Uint8Array[]> {
  const inks = new Uint8Array(count * 4)
  for (let i = 0; i < count; i++) { inks[i * 4] = 255 - cyan[i]; inks[i * 4 + 1] = 255 - magenta[i]; inks[i * 4 + 2] = 255 - yellow[i]; inks[i * 4 + 3] = 255 - black[i] }
  const rgb = await fromInks(inks, profile), planes = [new Uint8Array(count), new Uint8Array(count), new Uint8Array(count)]
  for (let i = 0; i < count; i++) { planes[0][i] = rgb[i * 3]; planes[1][i] = rgb[i * 3 + 1]; planes[2][i] = rgb[i * 3 + 2] }
  return planes
}

function rgbaImage(width: number, height: number, red: Uint8Array, green: Uint8Array, blue: Uint8Array, alpha: Uint8Array) {
  const count = width * height, pixels = new Uint8Array(count * 4)
  for (let i = 0; i < count; i++) {
    const a = alpha[i]
    pixels[i * 4] = ((red[i] * a + 127) / 255) | 0; pixels[i * 4 + 1] = ((green[i] * a + 127) / 255) | 0; pixels[i * 4 + 2] = ((blue[i] * a + 127) / 255) | 0; pixels[i * 4 + 3] = a
  }
  return new Raster(width, height, 4, pixels)
}

// The merged image of a file without layers: its color channels (extra ones are saved selections, not transparency), raw or PackBits.
async function readMerged(cursor: Cursor, width: number, height: number, channels: number, isPSB: boolean, cmyk: CMYKProfile | null) {
  const compression = cursor.u16(), needed = cmyk ? 4 : 3, count = width * height
  if (channels < needed) throw new PSDError('truncated')
  const planes: Uint8Array[] = []
  if (compression === 0) for (let c = 0; c < needed; c++) planes.push(cursor.bytes(count).slice())
  else if (compression === 1) {
    const counts: number[] = []
    for (let i = 0; i < channels * height; i++) counts.push(isPSB ? cursor.u32() : cursor.u16())
    for (let c = 0; c < needed; c++) {
      const plane = new Uint8Array(count)
      for (let y = 0; y < height; y++) unpackRow(cursor.bytes(counts[c * height + y]), plane, y * width, width)
      planes.push(plane)
    }
  } else throw new PSDError('unsupportedCompression')
  const color = cmyk ? await rgbPlanes(count, planes, cmyk) : planes
  return rgbaImage(width, height, color[0], color[1], color[2], new Uint8Array(count).fill(255))
}

// MARK: Channels (PSDChannelCoder.swift): raw, PackBits, and ZIP with or without prediction

export function decodeChannel(compression: number, width: number, height: number, data: Uint8Array, largeDocument = false, crop: Crop | null = null): Uint8Array {
  if (width <= 0 || height <= 0) return new Uint8Array(0)
  if (crop) {
    if (crop.x < 0 || crop.y < 0 || crop.width < 0 || crop.height < 0 || crop.x + crop.width > width || crop.y + crop.height > height) throw new PSDError('truncated')
    if (!crop.width || !crop.height) return new Uint8Array(0)
  }
  const expected = width * height
  let full: Uint8Array
  if (compression === 0) { if (data.length < expected) throw new PSDError('truncated'); full = data }
  else if (compression === 1) return unpackRLE(width, height, data, largeDocument, crop)
  else if (compression === 2 || compression === 3) full = inflate(data, width, height, compression === 3)
  else throw new PSDError('unsupportedCompression')
  if (!crop) return full.slice(0, expected)
  const plane = new Uint8Array(crop.width * crop.height)
  for (let row = 0; row < crop.height; row++) plane.set(full.subarray((crop.y + row) * width + crop.x, (crop.y + row) * width + crop.x + crop.width), row * crop.width)
  return plane
}

function inflate(data: Uint8Array, width: number, height: number, predicted: boolean) {
  let plane: Uint8Array
  try { plane = unzlibSync(data) } catch { throw new PSDError('truncated') }
  if (plane.length < width * height) throw new PSDError('truncated')
  if (predicted) for (let y = 0; y < height; y++) for (let x = 1, at = y * width + 1; x < width; x++, at++) plane[at] = (plane[at] + plane[at - 1]) & 255
  return plane
}

// One PackBits row into `out` at `at`.
function unpackRow(row: Uint8Array, out: Uint8Array, at: number, width: number) {
  let offset = 0, written = 0
  while (written < width) {
    if (offset >= row.length) throw new PSDError('truncated')
    const n = (row[offset++] << 24) >> 24
    if (n >= 0) {
      const count = n + 1
      if (written + count > width || offset + count > row.length) throw new PSDError('truncated')
      out.set(row.subarray(offset, offset + count), at + written)
      offset += count; written += count
    } else if (n !== -128) {
      const count = 1 - n
      if (written + count > width || offset >= row.length) throw new PSDError('truncated')
      out.fill(row[offset++], at + written, at + written + count)
      written += count
    }
  }
}

function unpackRLE(width: number, height: number, data: Uint8Array, largeDocument: boolean, crop: Crop | null) {
  const size = largeDocument ? 4 : 2
  if (data.length < height * size) throw new PSDError('truncated')
  const counts = Array.from({ length: height }, (_, row) => largeDocument ? u32At(data, row * 4) : (data[row * 2] << 8) | data[row * 2 + 1])
  const area = crop ?? { x: 0, y: 0, width, height }, plane = new Uint8Array(area.width * area.height), buffer = crop ? new Uint8Array(width) : null
  let offset = height * size
  for (let row = 0; row < height; row++) {
    const end = offset + counts[row]
    if (end > data.length) throw new PSDError('truncated')
    if (row >= area.y && row < area.y + area.height) {
      if (buffer) { unpackRow(data.subarray(offset, end), buffer, 0, width); plane.set(buffer.subarray(area.x, area.x + area.width), (row - area.y) * area.width) }
      else unpackRow(data.subarray(offset, end), plane, row * width, width)
    }
    offset = end
  }
  return plane
}

// MARK: Records

function assemble(raw: RawLayer[], canvas: { width: number; height: number }, remainingPixels: number, draw: PSDDrawing): PSDRecord[] {
  const result: PSDRecord[] = [], groups: string[] = []
  let remaining = Math.max(0, remainingPixels)
  for (const layer of raw) {
    // Photoshop stores groups bottom-to-top: type 3 divider, then children, then the folder (type 1/2).
    if (layer.section === 3) { groups.push(uuid()); continue }
    const isGroup = layer.section === 1 || layer.section === 2
    const record = psdRecord({ id: isGroup ? groups.pop() ?? uuid() : uuid(), name: layer.name || 'Layer' })
    record.parentId = groups.at(-1) ?? null
    record.isGroup = isGroup
    record.visible = !layer.hidden
    record.blendKey = isGroup && (layer.blendKey === 'pass' || layer.blendKey === 'norm') ? 'pass' : layer.blendKey
    record.clipping = layer.clipping
    record.kind = kind(layer, isGroup)
    record.croppedToCanvas = layer.cropped
    const hasEffects = record.kind === 'effects' || ['lfx2', 'lrFX', 'lmfx'].some(key => layer.extra.has(key))
    record.opacity = hasEffects && layer.fill !== 255 ? layer.opacity / 255 : (layer.opacity / 255) * (layer.fill / 255)
    record.bounds = isGroup ? { x: 0, y: 0, ...canvas } : { x: layer.left, y: layer.top, width: Math.max(0, layer.right - layer.left), height: Math.max(0, layer.bottom - layer.top) }
    record.image = isGroup ? null : layer.image
    const text = record.kind === 'text' ? parseText(layer.extra) : null
    if (text) record.text = text
    else if (!isGroup) {
      const live = vectorLive(layer.extra, canvas, draw, remaining)
      if (live) {
        Object.assign(record, { image: live.image, bounds: live.bounds, shape: live.style, shapeNotes: live.notes, kind: 'vector' })
        remaining = Math.max(0, remaining - live.image.width * live.image.height)
      } else if (!record.image) {
        const raster = vectorRaster(layer.extra, canvas, draw, remaining)
        if (raster) {
          Object.assign(record, { image: raster.image, bounds: raster.bounds, kind: 'vector' })
          remaining = Math.max(0, remaining - raster.image.width * raster.image.height)
        }
      }
    }
    record.mask = layer.maskFromRender ? null : layer.maskImage
    record.maskBounds = { x: layer.maskLeft, y: layer.maskTop, width: layer.maskRight - layer.maskLeft, height: layer.maskBottom - layer.maskTop }
    record.maskDefault = layer.maskDefault
    record.maskEnabled = !layer.maskDisabled
    record.maskLinked = layer.maskLinked
    if (!isGroup) record.adjustment = parseAdjustment(layer.extra)
    if (record.adjustment) record.kind = 'adjustment'
    result.push(record)
  }
  if (groups.length) throw new PSDError('truncated')
  return result
}

function kind(layer: RawLayer, isGroup: boolean): PSDLayerKind {
  const has = (...keys: string[]) => keys.some(key => layer.extra.has(key))
  if (isGroup) return 'group'
  if (has('TySh', 'tySh', 'txt2')) return 'text'
  if (has('vmsk', 'vsms', 'vogk')) return 'vector'
  if (has('SoLd', 'SoLE')) return 'smartObject'
  if (has('lfx2', 'lrFX', 'lmfx')) return 'effects'
  if ([...adjustmentKeys].some(key => layer.extra.has(key))) return 'adjustment'
  return 'raster'
}

// MARK: Adjustments (PSDAdjustments)

export function parseAdjustment(extra: Map<string, Uint8Array>): Adjustment | null {
  const levels = extra.get('levl'), curves = extra.get('curv'), hue = extra.get('hue2') ?? extra.get('hue ')
  if (levels) return levelsAdjustment(levels)
  if (curves) return curvesAdjustment(curves)
  if (hue) return hueAdjustment(hue)
  return null
}

const u16At = (data: Uint8Array, at: number) => (data[at] << 8) | data[at + 1]
const i16At = (data: Uint8Array, at: number) => (u16At(data, at) << 16) >> 16
const clamp = (n: number, low: number, high: number, fallback: number) => Number.isFinite(n) ? Math.min(high, Math.max(low, n)) : fallback

// Photoshop's 'levl': a version, then records of input black, input white, output black, output white and gamma in hundredths (100 is
// 1.00), for RGB, then red, green and blue.
export function levelsAdjustment(data: Uint8Array): Adjustment | null {
  if (data.length < 292) return null
  const adjustment = newAdjustment('Levels')
  adjustment.levels.ranges = [0, 1, 2, 3].map(channel => {
    const base = 2 + channel * 10, black = clamp(u16At(data, base), 0, 254, 0)
    return { black, white: clamp(u16At(data, base + 2), black + 1, 255, 255), gamma: clamp(u16At(data, base + 8) / 100, 0.1, 9.99, 1), outputBlack: clamp(u16At(data, base + 4), 0, 255, 0), outputWhite: clamp(u16At(data, base + 6), 0, 255, 255) }
  })
  return adjustment
}

function curvesAdjustment(data: Uint8Array): Adjustment | null {
  if (data.length < 5) return null
  let offset = data[0] === 0 ? 1 : 0
  if (offset + 2 > data.length) return null
  const version = u16At(data, offset)
  offset += 2
  if ((version !== 1 && version !== 4) || offset + 2 > data.length) return null
  const count = u16At(data, offset)
  offset += 2
  const adjustment = newAdjustment('Curves'), channels = adjustment.curves.channels
  for (let channel = 0; channel < Math.min(4, count); channel++) {
    if (offset + 2 > data.length) return null
    const points = u16At(data, offset)
    offset += 2
    const curve: { x: number; y: number }[] = []
    for (let i = 0; i < points; i++) {
      if (offset + 4 > data.length) return null
      const output = u16At(data, offset), input = u16At(data, offset + 2)
      offset += 4
      curve.push({ x: Math.min(255, Math.max(0, input)), y: Math.min(255, Math.max(0, output)) })
    }
    if (curve.length >= 2) {
      curve.sort((a, b) => a.x - b.x)
      if (curve[0].x !== 0) curve.unshift({ x: 0, y: curve[0].y })
      if (curve.at(-1)!.x !== 255) curve.push({ x: 255, y: curve.at(-1)!.y })
      channels[channel] = curve
    }
  }
  const valid = channels.length === 4 && channels.every(points => points.length >= 2 && points.length <= 32 && points[0].x === 0 && points.at(-1)!.x === 255 && points.every((p, i) => i === 0 || points[i - 1].x < p.x))
  return valid ? adjustment : null
}

// Photoshop's 'hue2': a version, the Colorize switch and a pad byte, the Colorize hue, saturation and lightness, the Master's, then for
// Reds through Magentas the band (where the range fades in, is full, and fades out, in degrees) and its hue, saturation and lightness.
export function hueAdjustment(data: Uint8Array): Adjustment | null {
  if (data.length < 16) return null
  const colorize = data[2] !== 0, adjustment = newAdjustment('Hue/Saturation'), settings = adjustment.hsvSettings!
  settings.colorize = colorize
  adjustment.colorize = colorize
  const values = (at: number) => ({ hue: i16At(data, at), saturation: i16At(data, at + 2), lightness: i16At(data, at + 4) })
  // Colorize has values of its own; the Master applies otherwise.
  settings.adjustments = { Master: values(colorize ? 4 : 10) }
  Object.assign(adjustment, settings.adjustments.Master)
  if (colorize) return adjustment
  let offset = 16
  for (const range of colorRanges.filter(r => r !== 'Master') as ColorRange[]) {
    if (offset + 14 > data.length) break
    const degrees = (at: number) => { const value = i16At(data, at) % 360; return value < 0 ? value + 360 : value }
    settings.bands[range] = { falloffStart: degrees(offset), rangeStart: degrees(offset + 2), rangeEnd: degrees(offset + 4), falloffEnd: degrees(offset + 6) }
    settings.adjustments[range] = values(offset + 8)
    offset += 14
  }
  return adjustment
}

// MARK: Building layers (PSDDocumentBuilder.swift)

export type PSDImport = { width: number; height: number; resolution: number; layers: Layer[]; conversions: PSDConversion[] }

export async function makeImport(document: PSDDocument, draw: PSDDrawing): Promise<PSDImport> {
  const conversions: PSDConversion[] = [], layers: Layer[] = [], { width, height } = document
  const note = (layerName: string, message: string) => conversions.push({ layerName, message })
  for (const record of document.layers) {
    if (record.croppedToCanvas) note(record.name, 'Cropped to the canvas so the file fits in memory. Pixels outside the canvas weren\'t imported.')
    const rendered = record.text ? await renderText(record.text, draw).catch(() => null) : null
    const notes: string[] = []
    if (record.kind === 'text') {
      if (record.text && rendered) {
        notes.push(...record.text.notes)
        if (!(await draw.fontInstalled(record.text.style.fontName))) notes.push(missingFontNote(record.text.style.fontName))
      } else notes.push(rasterizedNote)
    }
    if (record.kind === 'smartObject') notes.push('The smart object was rasterized. Linked contents can’t be edited.')
    if (record.kind === 'effects') notes.push('Layer effects were discarded, so the appearance may differ.')
    if (record.kind === 'vector') notes.push(...(record.shape ? record.shapeNotes : ['Vector shape was rasterized to pixels.']))
    if (record.kind === 'other') notes.push('This Photoshop layer type isn’t supported and was imported as pixels.')
    if (record.isGroup) { if (record.blendKey !== 'pass' && record.blendKey !== 'norm') notes.push(`Folder blend mode “${record.blendKey}” isn’t supported. The folder will be pass-through.`) }
    else if (!blendMode(record.blendKey) && record.blendKey !== 'pass') notes.push(`Blend mode “${record.blendKey.trim()}” isn’t supported and will be applied as Normal.`)
    if (record.kind === 'adjustment') notes.push(record.adjustment ? 'Adjustment parameters may not match Photoshop exactly.' : 'This adjustment type isn’t supported and was skipped.')
    for (const message of notes) note(record.name, message)
    if (record.kind === 'adjustment' && !record.adjustment) continue
    const common = { id: record.id, name: record.name, visible: record.visible, parentId: record.parentId, opacity: Math.min(1, Math.max(0, record.opacity)) }
    const blend = blendMode(record.blendKey) ?? 'Normal'
    let layer: Layer
    // Folders carry an opacity of their own, which multiplies into what's inside them just as Photoshop's group opacity does.
    if (record.isGroup) layer = newLayer({ ...common, isGroup: true, transform: fullTransform(width, height) })
    else if (record.adjustment) layer = newLayer({ ...common, transform: fullTransform(width, height), blendMode: blend, adjustment: record.adjustment })
    else if (rendered && record.text) layer = newLayer({ ...common, transform: rendered.transform, blendMode: blend, image: rendered.raster, text: writeTextStyle(record.text.style) })
    else if (record.image) {
      const size: [number, number] = record.bounds.width > 0 && record.bounds.height > 0 ? [record.bounds.width, record.bounds.height] : [record.image.width, record.image.height]
      layer = newLayer({ ...common, transform: { ...fullTransform(size[0], size[1], record.bounds.x, record.bounds.y), size }, blendMode: blend, image: record.image, ...(record.shape ? { shape: record.shape } : {}) })
    } else layer = newLayer({ ...common, transform: fullTransform(width, height), blendMode: blend })
    const mask = record.mask && maskOnLayerGrid(record.mask, record, layer, { width, height })
    if (mask) Object.assign(layer, { mask, maskEnabled: record.maskEnabled, maskLinked: record.maskLinked })
    else if (record.mask) note(record.name, 'The layer mask couldn’t be converted to 8-bit grayscale and was skipped.')
    layers.push(layer)
  }
  const byId = new Map(layers.map(layer => [layer.id, layer]))
  const baseForParent = new Map<string | null, string | null>()
  for (const record of document.layers) {
    const layer = byId.get(record.id)
    if (!layer) continue
    if (record.clipping) {
      const source = baseForParent.get(record.parentId), base = source ? byId.get(source) : undefined
      if (base && !base.isGroup && !base.adjustment) layer.clipTo = base.id
      else note(record.name, 'This clipping mask’s base isn’t supported, so clipping was skipped.')
    } else baseForParent.set(record.parentId, !layer.isGroup && !layer.adjustment ? record.id : null)
  }
  return { width, height, resolution: document.resolution, layers, conversions }
}

async function renderText(source: PSDTextSource, draw: PSDDrawing) {
  const { raster, baseline } = await draw.text(source.style)
  const transform = textTransform(source, raster.width, raster.height, baseline)
  if (![...transform.origin, ...transform.size, transform.rotation].every(Number.isFinite) || transform.size[0] < 1 || transform.size[1] < 1) throw new PSDError('tooLarge')
  return { raster, transform }
}

// A PSD layer mask on the layer's own pixel grid, as Compositor's masks are: the stored patch drawn where it sits on the document, and
// Photoshop's default value everywhere else. The patch alone, stretched over the layer, would put the mask in the wrong place.
// Adjustment layers and folders cover the canvas.
export function maskOnLayerGrid(patch: Raster, record: Pick<PSDRecord, 'maskBounds' | 'maskDefault'>, layer: Pick<Layer, 'image' | 'transform'>, canvas: { width: number; height: number }): Raster | null {
  const grid = layer.image ? { width: layer.image.width, height: layer.image.height } : canvas
  const [px, py] = layer.transform.origin, [pw, ph] = layer.transform.size, bounds = record.maskBounds
  if (!(grid.width >= 1 && grid.height >= 1 && pw > 0 && ph > 0 && bounds.width > 0 && bounds.height > 0)) return patch
  const scaleX = grid.width / pw, scaleY = grid.height / ph
  const rect = { x: (bounds.x - px) * scaleX, y: (bounds.y - py) * scaleY, width: bounds.width * scaleX, height: bounds.height * scaleY }
  // Already the layer's grid: nothing to place.
  if (Math.floor(rect.x) === 0 && Math.floor(rect.y) === 0 && Math.ceil(rect.x + rect.width) === grid.width && Math.ceil(rect.y + rect.height) === grid.height && patch.width === grid.width && patch.height === grid.height) return patch
  const width = Math.floor(grid.width), height = Math.floor(grid.height), out = Raster.filled(width, height, 1, [record.maskDefault])
  for (let y = 0; y < height; y++) {
    const v = (y + 0.5 - rect.y) / rect.height
    if (v < 0 || v >= 1) continue
    const sy = Math.min(patch.height - 1, Math.floor(v * patch.height))
    for (let x = 0; x < width; x++) {
      const u = (x + 0.5 - rect.x) / rect.width
      if (u >= 0 && u < 1) out.data[y * width + x] = patch.data[sy * patch.width + Math.min(patch.width - 1, Math.floor(u * patch.width))]
    }
  }
  return out
}
