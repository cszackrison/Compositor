import { Raster } from '../src/model/raster'
import { type CMYKProfile, toInks } from '../src/io/cmyk'
import { type PSDRecord, psdRecord } from '../src/io/psd'

// Builds tiny Photoshop files for the reader's tests (PSDFixture.swift). Not part of the app; Compositor does not write PSD.

export class Buffer {
  bytes: number[] = []
  u8(v: number) { this.bytes.push(v & 255) }
  u16(v: number) { this.u8(v >> 8); this.u8(v) }
  i16(v: number) { this.u16(v & 0xffff) }
  u32(v: number) { this.u8(v >>> 24); this.u8(v >>> 16); this.u8(v >>> 8); this.u8(v) }
  i32(v: number) { this.u32(Math.max(-(2 ** 31), Math.min(2 ** 31 - 1, v)) >>> 0) }
  u64(v: number) { this.u32(Math.floor(v / 2 ** 32)); this.u32(v >>> 0) }
  f64(v: number) { const view = new DataView(new ArrayBuffer(8)); view.setFloat64(0, v); this.data(new Uint8Array(view.buffer)) }
  data(v: ArrayLike<number>) { for (let i = 0; i < v.length; i++) this.bytes.push(v[i]) }
  string(v: string) { for (const c of v) this.u8(c.charCodeAt(0)) }
  utf16(v: string) { this.u32(v.length); for (let i = 0; i < v.length; i++) this.u16(v.charCodeAt(i)) }
  id(v: string) { if (v.length === 4) { this.u32(0); this.string(v) } else { this.u32(v.length); this.string(v) } }
  descriptor(classID: string, items: [string, Uint8Array][]) { this.u32(16); this.u32(0); this.id(classID); this.u32(items.length); for (const [key, value] of items) { this.id(key); this.data(value) } }
  get length() { return this.bytes.length }
  build() { return new Uint8Array(this.bytes) }
}
const build = (body: (b: Buffer) => void) => { const b = new Buffer(); body(b); return b.build() }

export type FixtureDocument = { width: number; height: number; resolution: number; cmykProfile?: CMYKProfile | null; layers: (Partial<PSDRecord> & { name: string })[] }
export type FixtureOptions = { composite?: Raster; large?: boolean; additional?: { key: string; payload: Uint8Array }; extras?: Record<string, Record<string, Uint8Array>> }
type Prepared = { record: PSDRecord; isDivider: boolean; channels: { id: number; payload: Uint8Array }[]; top: number; left: number; bottom: number; right: number; maskTop: number; maskLeft: number; maskBottom: number; maskRight: number; extras: Record<string, Uint8Array> }

const largeKeys = ['LMsk', 'Lr16', 'Lr32', 'Layr', 'Mt16', 'Mt32', 'Mtrn', 'Alph', 'FMsk', 'lnk2', 'FEid', 'FXid', 'PxSD']

export async function psdFixture(document: FixtureDocument, { composite, large = false, additional, extras = {} }: FixtureOptions = {}): Promise<Uint8Array> {
  const { width, height } = document, cmyk = document.cmykProfile ?? null
  const records = document.layers.map(layer => psdRecord(layer))
  const file = new Buffer()
  file.string('8BPS'); file.u16(large ? 2 : 1); file.data(new Uint8Array(6)); file.u16(4); file.u32(height); file.u32(width); file.u16(8)
  // RGB, or CMYK (mode 4) with its layers' inks written through `cmykProfile`, embedded.
  file.u16(cmyk ? 4 : 3)
  file.u32(0)
  const resources = new Buffer()
  resources.data(resolutionResource(document.resolution))
  if (cmyk) resources.data(iccResource(cmyk.data))
  file.u32(resources.length); file.data(resources.bytes)
  const layers = await layerSection(records, large, additional, extras, cmyk)
  if (large) file.u64(layers.length); else file.u32(layers.length)
  file.data(layers)
  await appendComposite(file, composite && composite.width === width && composite.height === height ? composite : new Raster(width, height, 4), large, cmyk)
  return file.build()
}

async function layerSection(records: PSDRecord[], large: boolean, additional: FixtureOptions['additional'], extras: Record<string, Record<string, Uint8Array>>, cmyk: CMYKProfile | null) {
  const prepared: Prepared[] = []
  // File order is bottom-to-top. Photoshop groups are type 3, children, then type 1/2.
  const emit = async (parent: string | null) => {
    for (const record of records.filter(r => r.parentId === parent)) {
      if (record.isGroup) {
        prepared.push(emptyLayer({ name: '</Layer group>', blendKey: 'norm', section: 3, parentId: parent, large }))
        await emit(record.id)
        prepared.push(emptyLayer({ name: record.name, blendKey: record.blendKey, section: 1, visible: record.visible, opacity: record.opacity, parentId: record.parentId, id: record.id, mask: record.mask, maskEnabled: record.maskEnabled, large }))
      } else prepared.push(await layer(record, extras[record.id] ?? {}, cmyk, large))
    }
  }
  await emit(null)
  const recordBytes = new Buffer(), payloads = new Buffer()
  recordBytes.i16(prepared.length)
  for (const item of prepared) { writeRecord(recordBytes, item, large, additional); for (const channel of item.channels) payloads.data(channel.payload) }
  const info = new Buffer()
  if (large) info.u64(0); else info.u32(0)
  info.data(recordBytes.bytes); info.data(payloads.bytes)
  if (info.length % 2 === 1) info.u8(0)
  const fieldBytes = large ? 8 : 4, length = new Buffer()
  if (large) length.u64(info.length - fieldBytes); else length.u32(info.length - fieldBytes)
  info.bytes.splice(0, fieldBytes, ...length.bytes)
  info.u32(0)
  return info.build()
}

async function layer(record: PSDRecord, extras: Record<string, Uint8Array>, cmyk: CMYKProfile | null, large: boolean): Promise<Prepared> {
  const image = record.image, width = image?.width ?? 0, height = image?.height ?? 0
  const left = Math.round(record.bounds.x), top = Math.round(record.bounds.y)
  let channels: Prepared['channels'] = []
  if (image && width > 0 && height > 0) {
    const p = planes(image)
    let color: [number, Uint8Array][] = [[0, p.red], [1, p.green], [2, p.blue]]
    if (cmyk) color = await inks(p, cmyk)
    for (const [id, plane] of [[-1, p.alpha] as [number, Uint8Array], ...color]) channels.push({ id, payload: channelPayload(plane, width, height, large) })
  } else channels = emptyChannels()
  if (record.mask) channels.push({ id: -2, payload: channelPayload(record.mask.data, record.mask.width, record.mask.height, large) })
  return { record, isDivider: false, channels, top, left, bottom: top + height, right: left + width, maskTop: top, maskLeft: left, maskBottom: top + (record.mask?.height ?? 0), maskRight: left + (record.mask?.width ?? 0), extras }
}

function emptyLayer({ name, blendKey, section, visible = true, opacity = 1, parentId, id, mask = null, maskEnabled = true, large }: { name: string; blendKey: string; section: number; visible?: boolean; opacity?: number; parentId: string | null; id?: string; mask?: Raster | null; maskEnabled?: boolean; large: boolean }): Prepared {
  const record = psdRecord({ name, parentId, isGroup: section !== 3, visible, opacity, blendKey, mask, maskEnabled, kind: 'group', ...(id ? { id } : {}) })
  const channels = emptyChannels()
  if (mask) channels.push({ id: -2, payload: channelPayload(mask.data, mask.width, mask.height, large) })
  return { record, isDivider: section === 3, channels, top: 0, left: 0, bottom: 0, right: 0, maskTop: 0, maskLeft: 0, maskBottom: mask?.height ?? 0, maskRight: mask?.width ?? 0, extras: {} }
}

const emptyChannels = () => [-1, 0, 1, 2].map(id => ({ id, payload: new Uint8Array([0, 0]) }))

function channelPayload(plane: Uint8Array, width: number, height: number, large = false) {
  const encoded = encode(plane, width, height, large)
  return new Uint8Array([encoded.compression >> 8, encoded.compression & 255, ...encoded.data])
}

function writeRecord(b: Buffer, item: Prepared, large: boolean, additional: FixtureOptions['additional']) {
  const record = item.record
  b.i32(item.top); b.i32(item.left); b.i32(item.bottom); b.i32(item.right)
  b.u16(item.channels.length)
  for (const channel of item.channels) { b.i16(channel.id); if (large) b.u64(channel.payload.length); else b.u32(channel.payload.length) }
  b.string('8BIM')
  b.string((record.blendKey + '    ').slice(0, 4))
  b.u8(Math.max(0, Math.min(255, Math.round(record.opacity * 255))))
  b.u8(record.clipping ? 1 : 0)
  b.u8(record.visible ? 0 : 2)
  b.u8(0)
  const extra = extraData(item, large, additional)
  b.u32(extra.length); b.data(extra)
}

function extraData(item: Prepared, large: boolean, additional: FixtureOptions['additional']) {
  const extra = new Buffer(), record = item.record
  if (record.mask && item.maskRight > item.maskLeft && item.maskBottom > item.maskTop) {
    extra.u32(20); extra.i32(item.maskTop); extra.i32(item.maskLeft); extra.i32(item.maskBottom); extra.i32(item.maskRight)
    extra.u8(255)
    extra.u8((record.maskLinked ? 0 : 1) | (record.maskEnabled ? 0 : 2))
    extra.u16(0)
  } else extra.u32(0)
  extra.u32(0)
  const pascal = [...new TextEncoder().encode(record.name)].slice(0, 255)
  extra.u8(pascal.length); extra.data(pascal)
  extra.data(new Uint8Array((4 - ((1 + pascal.length) % 4)) % 4))
  if (additional) writeAdditional(extra, additional.key, additional.payload, large)
  writeAdditional(extra, 'luni', luni(record.name), large)
  if (record.isGroup || item.isDivider) {
    const blend = item.isDivider ? 'norm' : ((record.blendKey === 'pass' ? 'pass' : record.blendKey) + '    ').slice(0, 4)
    writeAdditional(extra, 'lsct', build(b => { b.u32(item.isDivider ? 3 : 1); b.string('8BIM'); b.string(blend) }), large)
  }
  for (const key of Object.keys(item.extras).sort()) writeAdditional(extra, key, item.extras[key], large)
  return extra.bytes
}

function writeAdditional(b: Buffer, key: string, payload: Uint8Array, large: boolean) {
  b.string('8BIM'); b.string(key)
  if (large && largeKeys.includes(key)) b.u64(payload.length); else b.u32(payload.length)
  b.data(payload)
  if (payload.length % 2 === 1) b.u8(0)
}

const luni = (name: string) => build(b => b.utf16(name))

function resolutionResource(resolution: number) {
  const fixed = Math.round(Math.min(9600, Math.max(1, resolution)) * 65536)
  return build(b => { b.string('8BIM'); b.u16(1005); b.u8(0); b.u8(0); b.u32(16); b.u32(fixed); b.u16(1); b.u16(1); b.u32(fixed); b.u16(1); b.u16(1) })
}

// Image resource 1039: an embedded ICC profile.
const iccResource = (profile: Uint8Array) => build(b => { b.string('8BIM'); b.u16(1039); b.u8(0); b.u8(0); b.u32(profile.length); b.data(profile); if (profile.length % 2 === 1) b.u8(0) })

async function appendComposite(file: Buffer, image: Raster, large: boolean, cmyk: CMYKProfile | null) {
  const { width, height } = image, p = planes(image)
  file.u16(1)
  // A CMYK file's merged image is its four inks.
  const merged = cmyk ? (await inks(p, cmyk)).map(([, plane]) => plane) : [p.red, p.green, p.blue, p.alpha]
  const counts = new Buffer(), packed = new Buffer(), countBytes = height * (large ? 4 : 2)
  for (const plane of merged) { const { data } = encode(plane, width, height, large); counts.data(data.subarray(0, countBytes)); packed.data(data.subarray(countBytes)) }
  file.data(counts.bytes); file.data(packed.bytes)
}

export function encode(plane: Uint8Array, width: number, height: number, large = false): { compression: number; data: Uint8Array } {
  if (width <= 0 || height <= 0 || plane.length < width * height) return { compression: 0, data: new Uint8Array(0) }
  const counts = new Buffer(), packed = new Buffer()
  for (let row = 0; row < height; row++) {
    const encoded = packBits(plane.subarray(row * width, (row + 1) * width))
    if (large) counts.u32(encoded.length); else counts.u16(encoded.length)
    packed.data(encoded)
  }
  return { compression: 1, data: new Uint8Array([...counts.bytes, ...packed.bytes]) }
}

// Straight RGB planes as a CMYK file's ink channels through `profile`: cyan, magenta, yellow and black, inverted as Photoshop stores
// them (255 is no ink).
async function inks(p: ReturnType<typeof planes>, profile: CMYKProfile): Promise<[number, Uint8Array][]> {
  const count = p.red.length, rgb = new Uint8Array(count * 3)
  for (let i = 0; i < count; i++) { rgb[i * 3] = p.red[i]; rgb[i * 3 + 1] = p.green[i]; rgb[i * 3 + 2] = p.blue[i] }
  const printed = await toInks(rgb, profile), channels = [0, 1, 2, 3].map(() => new Uint8Array(count))
  for (let i = 0; i < count; i++) for (let c = 0; c < 4; c++) channels[c][i] = 255 - printed[i * 4 + c]
  return channels.map((plane, id) => [id, plane])
}

// Straight colors from premultiplied RGBA, first row at the top.
function planes(image: Raster) {
  const count = image.width * image.height, red = new Uint8Array(count), green = new Uint8Array(count), blue = new Uint8Array(count), alpha = new Uint8Array(count)
  for (let i = 0; i < count; i++) {
    const [r, g, b, a] = image.data.subarray(i * 4, i * 4 + 4)
    alpha[i] = a
    if (a) { red[i] = Math.min(255, Math.floor((r * 255 + Math.floor(a / 2)) / a)); green[i] = Math.min(255, Math.floor((g * 255 + Math.floor(a / 2)) / a)); blue[i] = Math.min(255, Math.floor((b * 255 + Math.floor(a / 2)) / a)) }
  }
  return { red, green, blue, alpha }
}

export function packBits(row: Uint8Array) {
  const out: number[] = []
  let i = 0
  while (i < row.length) {
    if (i + 1 < row.length && row[i] === row[i + 1]) {
      let run = 2
      while (i + run < row.length && row[i + run] === row[i] && run < 128) run++
      out.push((1 - run) & 255, row[i])
      i += run
    } else {
      const start = i
      i++
      while (i < row.length && i - start < 128) { if (i + 1 < row.length && row[i] === row[i + 1]) break; i++ }
      out.push(i - start - 1, ...row.subarray(start, i))
    }
  }
  return new Uint8Array(out)
}

// MARK: Type layers

export type TySh = { text: string; font?: string; fontSize?: number; red?: number; green?: number; blue?: number; justification?: number; tracking?: number; leading?: number | null; fauxBold?: boolean; fauxItalic?: boolean; vertical?: boolean; warp?: boolean; secondSize?: number; secondLeading?: number; secondHorizontalScale?: number; secondVerticalScale?: number; tx?: number; ty?: number; xx?: number; xy?: number; yx?: number; yy?: number; bounds?: [number, number, number, number]; glyphBounds?: [number, number, number, number] }

// A Photoshop 6 TySh block. The descriptor layout matches Adobe's type-tool object setting.
export function tySh(o: TySh) {
  const { text, tx = 40, ty = 50, xx = 1, xy = 0, yx = 0, yy = 1, vertical = false, warp = false } = o
  const items: [string, Uint8Array][] = [['Txt ', build(b => { b.string('TEXT'); b.utf16(text) })], ['Ornt', enumItem('Ornt', vertical ? 'Vrtc' : 'Hrzn')]]
  if (o.bounds) items.push(['bounds', rectItem(o.bounds)])
  if (o.glyphBounds) items.push(['boundingBox', rectItem(o.glyphBounds)])
  items.push(['EngineData', build(b => { const engineBytes = new TextEncoder().encode(engine(o)); b.string('tdta'); b.u32(engineBytes.length); b.data(engineBytes) })])
  return build(b => {
    b.u16(1)
    for (const v of [xx, xy, yx, yy, tx, ty]) b.f64(v)
    b.u16(50)
    b.descriptor('TxLr', items)
    b.u16(1)
    b.descriptor('warp', [['warpStyle', enumItem('warpStyle', warp ? 'warpArc' : 'warpNone')]])
  })
}

const enumItem = (type: string, value: string) => build(b => { b.string('enum'); b.id(type); b.id(value) })
const rectItem = ([left, top, right, bottom]: [number, number, number, number]) => build(b => {
  b.string('Objc'); b.u32(0); b.id('Rctn'); b.u32(4)
  for (const [key, value] of [['Left', left], ['Top ', top], ['Rght', right], ['Btom', bottom]] as const) { b.id(key); b.string('UntF'); b.string('#Pnt'); b.f64(value) }
})

// Swift prints a Double with a point ("24.0").
const swift = (n: number) => Number.isInteger(n) ? n.toFixed(1) : String(n)

function engine({ text, font = 'Helvetica', fontSize = 24, red = 0, green = 0, blue = 0, justification = 0, tracking = 0, leading = null, fauxBold = false, fauxItalic = false, secondSize, secondLeading, secondHorizontalScale, secondVerticalScale }: TySh) {
  const run = (size: number, runLeading: number | null, horizontal: number, vertical: number) => `<<
/StyleSheet
<<
/StyleSheetData
<<
/Font 0
/FontSize ${swift(size)}
/FauxBold ${fauxBold}
/FauxItalic ${fauxItalic}
/AutoLeading ${runLeading === null}
/Leading ${swift(runLeading ?? size * 1.2)}
/Tracking ${swift(tracking)}
/HorizontalScale ${swift(horizontal)}
/VerticalScale ${swift(vertical)}
/FillColor
<<
/Type 1
/Values [ 1.0 ${swift(red)} ${swift(green)} ${swift(blue)} ]
>>
>>
>>
>>`
  const hasSecond = secondSize !== undefined || secondLeading !== undefined || secondHorizontalScale !== undefined || secondVerticalScale !== undefined
  const runs = hasSecond ? `${run(fontSize, leading, 1, 1)}\n${run(secondSize ?? fontSize, secondLeading ?? leading, secondHorizontalScale ?? 1, secondVerticalScale ?? 1)}` : run(fontSize, leading, 1, 1)
  return `<<
/EngineDict
<<
/Editor
<<
/Text ${parenthesized(text)}
>>
/ParagraphRun
<<
/RunArray
[
<<
/ParagraphSheet
<<
/Properties
<<
/Justification ${justification}
>>
>>
>>
]
>>
/StyleRun
<<
/RunArray
[
${runs}
]
>>
>>
/ResourceDict
<<
/FontSet
[
<<
/Name ${parenthesized(font)}
>>
]
>>
>>
`
}

const parenthesized = (text: string) => `(${text.replace(/[\\()]/g, c => `\\${c}`)})`
