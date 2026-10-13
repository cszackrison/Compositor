import type { Lcms } from '../../vendor/lcms/lcms.js'
import { Raster, decodeImageFile, premultiply, tiffMainPage } from '../model/raster'

// CMYK for print from documents that stay RGB (CMYK.swift): a proof of a chosen profile on the canvas and export through it. Ink values
// are never edited directly. Color management is LittleCMS (lcms-wasm), loaded on first use. Browsers ship no CMYK profiles, so they
// come from Load Profile (a printer's, or one such as ISO Coated or U.S. Web Coated), kept in the browser. LittleCMS is vendored in
// web/vendor/lcms.

export type CMYKProfile = { name: string; data: Uint8Array }

let engine: Promise<Lcms> | null = null
export function lcms(): Promise<Lcms> {
  return engine ??= (async () => {
    const module = await import('../../vendor/lcms/lcms.js')
    // Node (the tests) finds the wasm beside the module; the page is told where Vite put it.
    if (typeof window === 'undefined' && typeof process === 'object' && process.versions?.node) return module.instantiate()
    const url = (await import('../../vendor/lcms/lcms.wasm?url')).default
    return module.instantiate({ locateFile: () => url })
  })()
}

// A CMYK output profile from an ICC file, named as it names itself; null for any other profile.
export async function readProfile(fileName: string, data: Uint8Array): Promise<CMYKProfile | null> {
  const l = await lcms(), { cmsSigCmykData, cmsInfoDescription } = await import('../../vendor/lcms/lcms.js')
  const handle = l.cmsOpenProfileFromMem(data, data.byteLength)
  if (!handle) return null
  try {
    if (l.cmsGetColorSpace(handle) !== cmsSigCmykData) return null
    const described = (l.cmsGetProfileInfoASCII(handle, cmsInfoDescription, 'en', 'US') ?? '').trim()
    return { name: described || fileName.replace(/\.(icc|icm)$/i, ''), data }
  } finally { l.cmsCloseProfile(handle) }
}

// MARK: The profiles kept, and the one chosen (View › CMYK › Profile)

let profiles: CMYKProfile[] = []
let chosenName: string | null = null
const listeners = new Set<() => void>()
export const cmykProfiles = () => profiles
export const chosenProfile = () => profiles.find(p => p.name === chosenName) ?? profiles[0] ?? null
export function subscribeProfiles(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } }
const changed = () => { profiles = [...profiles]; listeners.forEach(l => l()) }

function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('compositor-cmyk', 1)
    request.onupgradeneeded = () => request.result.createObjectStore('profiles')
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

export async function loadProfiles() {
  try { chosenName = localStorage.getItem('cmykProfile') } catch { /* storage unavailable */ }
  try {
    const db = await database()
    const stored = await new Promise<CMYKProfile[]>((resolve, reject) => { const request = db.transaction('profiles').objectStore('profiles').getAll(); request.onsuccess = () => resolve(request.result ?? []); request.onerror = () => reject(request.error) })
    profiles = stored.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
    changed()
  } catch { /* storage unavailable: profiles last for this session */ }
}

export function chooseProfile(profile: CMYKProfile) {
  chosenName = profile.name
  try { localStorage.setItem('cmykProfile', profile.name) } catch { /* storage unavailable */ }
  changed()
}

// Keeps a profile in the browser and chooses it; one already kept with the same contents is chosen instead.
export async function adoptProfile(profile: CMYKProfile): Promise<CMYKProfile> {
  const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i])
  const known = profiles.find(p => same(p.data, profile.data))
  if (known) { chooseProfile(known); return known }
  profiles = [...profiles.filter(p => p.name !== profile.name), profile].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
  try {
    const db = await database()
    await new Promise<void>((resolve, reject) => { const t = db.transaction('profiles', 'readwrite'); t.objectStore('profiles').put(profile, profile.name); t.oncomplete = () => resolve(); t.onerror = () => reject(t.error) })
  } catch { /* kept for this session */ }
  chooseProfile(profile)
  return profile
}

// Load Profile: a CMYK ICC profile from a file, kept and chosen.
export async function addProfile(file: File): Promise<CMYKProfile> {
  const profile = await readProfile(file.name, new Uint8Array(await file.arrayBuffer()))
  if (!profile) throw new Error('That profile isn’t a CMYK output profile.')
  return adoptProfile(profile)
}

// Picks a profile file and adds it; null when the picker is closed.
export function pickProfile(): Promise<CMYKProfile | null> {
  return new Promise((resolve, reject) => {
    const input = Object.assign(document.createElement('input'), { type: 'file', accept: '.icc,.icm' })
    input.onchange = () => { const file = input.files?.[0]; if (file) addProfile(file).then(resolve, reject); else resolve(null) }
    input.oncancel = () => resolve(null)
    input.click()
  })
}

// MARK: Converting

// Runs `colors` (3 or 4 bytes each) through `transform` a stretch at a time, so a large picture doesn't need it all on the engine's heap.
function run(l: Lcms, transform: number, colors: Uint8Array, inChannels: number, outChannels: number) {
  const count = colors.length / inChannels, out = new Uint8Array(count * outChannels), step = 1 << 20
  for (let at = 0; at < count; at += step) {
    const n = Math.min(step, count - at)
    out.set(l.cmsDoTransform(transform, colors.subarray(at * inChannels, (at + n) * inChannels), n), at * outChannels)
  }
  return out
}

async function transform<T>(profile: CMYKProfile, toInks: boolean, body: (l: Lcms, transform: number) => T): Promise<T> {
  const l = await lcms(), { TYPE_RGB_8, TYPE_CMYK_8, INTENT_RELATIVE_COLORIMETRIC, cmsFLAGS_BLACKPOINTCOMPENSATION } = await import('../../vendor/lcms/lcms.js')
  const srgb = l.cmsCreate_sRGBProfile(), cmyk = l.cmsOpenProfileFromMem(profile.data, profile.data.byteLength)
  if (!cmyk) { l.cmsCloseProfile(srgb); throw new Error(`The profile “${profile.name}” could not be read.`) }
  const t = toInks ? l.cmsCreateTransform(srgb, TYPE_RGB_8, cmyk, TYPE_CMYK_8, INTENT_RELATIVE_COLORIMETRIC, cmsFLAGS_BLACKPOINTCOMPENSATION) : l.cmsCreateTransform(cmyk, TYPE_CMYK_8, srgb, TYPE_RGB_8, INTENT_RELATIVE_COLORIMETRIC, cmsFLAGS_BLACKPOINTCOMPENSATION)
  try {
    if (!t) throw new Error(`The profile “${profile.name}” can’t convert colors.`)
    return body(l, t)
  } finally { if (t) l.cmsDeleteTransform(t); l.cmsCloseProfile(srgb); l.cmsCloseProfile(cmyk) }
}

// Premultiplied RGBA flattened over `matte` (ink has no transparency; paper shows), as straight RGB.
export function flatten(pixels: Raster, matte: [number, number, number]) {
  const { data } = pixels, out = new Uint8Array(pixels.width * pixels.height * 3)
  for (let i = 0, j = 0; i < data.length; i += 4, j += 3) { const k = 255 - data[i + 3]; for (let c = 0; c < 3; c++) out[j + c] = Math.min(255, data[i + c] + Math.round(matte[c] * k / 255)) }
  return out
}

// A picture in the profile's inks, 4 bytes a pixel: relative colorimetric, as Photoshop converts by default, so colors the press can't
// reach go to the nearest it can.
export const toInks = (rgb: Uint8Array, profile: CMYKProfile) => transform(profile, true, (l, t) => run(l, t, rgb, 3, 4))
// Inks back to RGB, as the print would look: for previews.
export const fromInks = (cmyk: Uint8Array, profile: CMYKProfile) => transform(profile, false, (l, t) => run(l, t, cmyk, 4, 3))

// MARK: Proofing

// Points along each side of the proof's color lookups.
export const proofSize = 33
export type ProofLookups = { proof: Float32Array; warning: Float32Array; marked: Float32Array }
const lookups = new Map<CMYKProfile, Promise<ProofLookups>>()

// Color lookups for the canvas, made once a profile, red fastest: `proof` takes each RGB color to what printing it through the profile
// gives back; `warning` is the same with the colors it can't print as they are marked gray; `marked` leaves colors as they are and marks
// those gray (the gamut warning without the proof).
export function proofLookups(profile: CMYKProfile): Promise<ProofLookups> {
  let found = lookups.get(profile)
  if (!found) {
    found = (async () => {
      const n = proofSize, count = n * n * n, lattice = new Uint8Array(count * 3), level = (i: number) => Math.round(i * 255 / (n - 1))
      for (let b = 0; b < n; b++) for (let g = 0; g < n; g++) for (let r = 0; r < n; r++) { const i = ((b * n + g) * n + r) * 3; lattice[i] = level(r); lattice[i + 1] = level(g); lattice[i + 2] = level(b) }
      const shown = await fromInks(await toInks(lattice, profile), profile)
      const proof = new Float32Array(count * 4).fill(1), warning = new Float32Array(count * 4).fill(1), marked = new Float32Array(count * 4).fill(1)
      for (let i = 0; i < count; i++) {
        let off = 0
        for (let c = 0; c < 3; c++) { proof[i * 4 + c] = shown[i * 3 + c] / 255; off = Math.max(off, Math.abs(shown[i * 3 + c] - lattice[i * 3 + c])) }
        // Out of gamut: printing moves it further than its own rounding there and back would.
        const outside = off > 10
        for (let c = 0; c < 3; c++) { warning[i * 4 + c] = outside ? 0.5 : proof[i * 4 + c]; marked[i * 4 + c] = outside ? 0.5 : lattice[i * 3 + c] / 255 }
      }
      return { proof, warning, marked }
    })()
    lookups.set(profile, found)
  }
  return found
}

// MARK: Opening CMYK files

// A JPEG's color: whether its picture is CMYK, and its ICC profile put back together from its APP2 pieces.
export function jpegColor(bytes: Uint8Array): { cmyk: boolean; icc?: Uint8Array } | null {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null
  const pieces: Uint8Array[] = []
  let cmyk = false
  for (let at = 2; at + 4 <= bytes.length;) {
    if (bytes[at] !== 0xff) return null
    const marker = bytes[at + 1], length = (bytes[at + 2] << 8) | bytes[at + 3], body = bytes.subarray(at + 4, at + 2 + length)
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01 || marker === 0xff) { at += marker === 0xff ? 1 : 2; continue }
    if (marker === 0xda || marker === 0xd9) break
    if (marker === 0xe2 && String.fromCharCode(...body.subarray(0, 11)) === 'ICC_PROFILE' && body[11] === 0) pieces[body[12] - 1] = body.subarray(14)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) cmyk = body[5] === 4
    at += 2 + length
  }
  const present = pieces.filter(Boolean)
  if (!present.length) return { cmyk }
  const icc = new Uint8Array(present.reduce((n, p) => n + p.length, 0))
  present.reduce((at, p) => { icc.set(p, at); return at + p.length }, 0)
  return { cmyk, icc }
}

// The same JPEG with `icc` embedded right after its start, so the browser decodes its inks through it.
function withProfile(bytes: Uint8Array, icc: Uint8Array) {
  const size = 65519, count = Math.ceil(icc.length / size), parts: Uint8Array[] = [bytes.subarray(0, 2)]
  for (let i = 0; i < count; i++) {
    const piece = icc.subarray(i * size, (i + 1) * size), header = new Uint8Array(18)
    header.set([0xff, 0xe2, (piece.length + 16) >> 8, (piece.length + 16) & 0xff, ...[...'ICC_PROFILE'].map(c => c.charCodeAt(0)), 0, i + 1, count])
    parts.push(header, piece)
  }
  parts.push(bytes.subarray(2))
  return new Blob(parts as BlobPart[], { type: 'image/jpeg' })
}

const embedded = async (data: Uint8Array) => readProfile('Embedded CMYK Profile', data)

// A CMYK JPEG or TIFF opened through its own profile, or the chosen one when it names none, as the Mac falls back to Generic CMYK;
// null for any other file, or a CMYK one with no profile to go by (the browser's own conversion takes it then). `profile` is the one
// it was made for, to adopt when it starts a project.
export async function openCMYK(file: Blob): Promise<{ image: Raster; profile: CMYKProfile } | null> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  const jpeg = jpegColor(bytes)
  if (jpeg) {
    if (!jpeg.cmyk) return null
    const own = jpeg.icc && await embedded(jpeg.icc), profile = own || chosenProfile()
    if (!profile) return null
    return { image: await decodeImageFile(own ? new Blob([bytes], { type: 'image/jpeg' }) : withProfile(bytes, profile.data)), profile }
  }
  const tiff = (bytes[0] === 0x49 && bytes[1] === 0x49) || (bytes[0] === 0x4d && bytes[1] === 0x4d)
  if (!tiff) return null
  const { page, UTIF, buffer } = await tiffMainPage(bytes), tag = (name: string, fallback: number) => (page[name] as unknown as number[] | undefined)?.[0] ?? fallback
  if (tag('t262', 2) !== 5 || tag('t284', 1) !== 1 || tag('t332', 1) !== 1) return null
  const bits = tag('t258', 8), samples = tag('t277', 4)
  if ((bits !== 8 && bits !== 16) || samples < 4) return null
  const icc = page.t34675 as unknown as Uint8Array | undefined, own = icc && await embedded(new Uint8Array(icc)), profile = own || chosenProfile()
  if (!profile) return null
  UTIF.decodeImage(buffer, page)
  const raw = new Uint8Array(page.data.buffer, page.data.byteOffset, page.data.byteLength), count = page.width * page.height, step = samples * bits / 8, high = bits / 8 - 1
  const inks = new Uint8Array(count * 4), alpha = samples > 4 ? new Uint8Array(count) : null
  // Extra sample 1 is alpha already multiplied into the inks, undone before they're converted.
  const associated = tag('t338', 2) === 1
  for (let i = 0; i < count; i++) {
    const a = alpha ? raw[i * step + 4 * bits / 8 + high] : 255
    if (alpha) alpha[i] = a
    for (let c = 0; c < 4; c++) { const v = raw[i * step + c * bits / 8 + high]; inks[i * 4 + c] = associated && a < 255 ? (a ? Math.min(255, Math.round(v * 255 / a)) : 0) : v }
  }
  const rgb = await fromInks(inks, profile), data = new Uint8Array(count * 4)
  for (let i = 0; i < count; i++) { for (let c = 0; c < 3; c++) data[i * 4 + c] = rgb[i * 3 + c]; data[i * 4 + 3] = alpha ? alpha[i] : 255 }
  return { image: new Raster(page.width, page.height, 4, premultiply(data)), profile }
}
