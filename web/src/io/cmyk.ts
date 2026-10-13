import type { Lcms } from 'lcms-wasm'
import type { Raster } from '../model/raster'

// CMYK for print from documents that stay RGB (CMYK.swift): a proof of a chosen profile on the canvas and export through it. Ink values
// are never edited directly. Color management is LittleCMS (lcms-wasm), loaded on first use. Browsers ship no CMYK profiles, so they
// come from Load Profile (a printer's, or one such as ISO Coated or U.S. Web Coated), kept in the browser.

export type CMYKProfile = { name: string; data: Uint8Array }

let engine: Promise<Lcms> | null = null
export function lcms(): Promise<Lcms> {
  return engine ??= (async () => {
    const module = await import('lcms-wasm')
    // Node (the tests) finds the wasm beside the module; the page is told where Vite put it.
    if (typeof window === 'undefined' && typeof process === 'object' && process.versions?.node) return module.instantiate()
    const url = (await import('lcms-wasm/dist/lcms.wasm?url')).default
    return module.instantiate({ locateFile: () => url })
  })()
}

// A CMYK output profile from an ICC file, named as it names itself; null for any other profile.
export async function readProfile(fileName: string, data: Uint8Array): Promise<CMYKProfile | null> {
  const l = await lcms(), { cmsSigCmykData, cmsInfoDescription } = await import('lcms-wasm')
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

// Load Profile: a CMYK ICC profile from a file, kept and chosen.
export async function addProfile(file: File): Promise<CMYKProfile> {
  const profile = await readProfile(file.name, new Uint8Array(await file.arrayBuffer()))
  if (!profile) throw new Error('That profile isn’t a CMYK output profile.')
  profiles = [...profiles.filter(p => p.name !== profile.name), profile].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
  try {
    const db = await database()
    await new Promise<void>((resolve, reject) => { const t = db.transaction('profiles', 'readwrite'); t.objectStore('profiles').put(profile, profile.name); t.oncomplete = () => resolve(); t.onerror = () => reject(t.error) })
  } catch { /* kept for this session */ }
  chooseProfile(profile)
  return profile
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
  const l = await lcms(), { TYPE_RGB_8, TYPE_CMYK_8, INTENT_RELATIVE_COLORIMETRIC, cmsFLAGS_BLACKPOINTCOMPENSATION } = await import('lcms-wasm')
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
