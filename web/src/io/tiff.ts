import { zlibSync } from 'fflate'

// A TIFF of 8-bit samples, top row first, Deflate-compressed in one strip: RGB with its transparency kept (straight alpha), or CMYK inks
// with the profile embedded, at `resolution` pixels per inch, as the Mac's Export As writes one.
export function encodeTIFF({ width, height, samples, cmyk = false, alpha = false, icc, resolution = 72 }: { width: number; height: number; samples: Uint8Array; cmyk?: boolean; alpha?: boolean; icc?: Uint8Array; resolution?: number }): Uint8Array {
  const channels = cmyk ? 4 : alpha ? 4 : 3, strip = zlibSync(samples, { level: 6 })
  type Entry = [tag: number, type: number, values: number[] | Uint8Array]
  const SHORT = 3, LONG = 4, RATIONAL = 5, UNDEFINED = 7
  const entries: Entry[] = [
    [256, LONG, [width]], [257, LONG, [height]], [258, SHORT, Array(channels).fill(8)], [259, SHORT, [8]], [262, SHORT, [cmyk ? 5 : 2]],
    [273, LONG, [0]], [277, SHORT, [channels]], [278, LONG, [height]], [279, LONG, [strip.length]],
    [282, RATIONAL, [Math.round(resolution * 1000), 1000]], [283, RATIONAL, [Math.round(resolution * 1000), 1000]], [284, SHORT, [1]], [296, SHORT, [2]],
    ...(cmyk ? [[332, SHORT, [1]] as Entry] : []), ...(alpha && !cmyk ? [[338, SHORT, [2]] as Entry] : []), ...(icc ? [[34675, UNDEFINED, icc] as Entry] : []),
  ]
  const size = (e: Entry) => e[1] === UNDEFINED ? e[2].length : e[1] === SHORT ? e[2].length * 2 : e[1] === RATIONAL ? e[2].length / 2 * 8 : e[2].length * 4
  const count = (e: Entry) => e[1] === RATIONAL ? e[2].length / 2 : e[2].length
  // Header, then the directory, then the values too long to sit in it (word aligned), then the strip.
  const ifdSize = 2 + entries.length * 12 + 4
  let extra = 8 + ifdSize
  const placed = entries.map(e => { if (size(e) <= 4) return -1; const at = extra; extra += size(e) + (size(e) & 1); return at })
  const stripAt = extra, out = new Uint8Array(stripAt + strip.length), view = new DataView(out.buffer)
  out.set([0x49, 0x49, 42, 0]); view.setUint32(4, 8, true); view.setUint16(8, entries.length, true)
  const write = (e: Entry, at: number) => {
    const [, type, values] = e
    if (type === UNDEFINED) out.set(values as Uint8Array, at)
    else values.forEach((v, i) => type === SHORT ? view.setUint16(at + i * 2, v, true) : view.setUint32(at + i * 4, v, true))
  }
  entries.forEach((e, i) => {
    const at = 10 + i * 12
    if (e[0] === 273) e[2] = [stripAt]
    view.setUint16(at, e[0], true); view.setUint16(at + 2, e[1], true); view.setUint32(at + 4, count(e), true)
    if (placed[i] < 0) write(e, at + 8)
    else { view.setUint32(at + 8, placed[i], true); write(e, placed[i]) }
  })
  view.setUint32(10 + entries.length * 12, 0, true)
  out.set(strip, stripAt)
  return out
}
