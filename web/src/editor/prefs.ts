import type { GridSettings } from './store'

// Per-user view settings, kept across sessions as the Mac app keeps them in user defaults. Not saved in projects.
export type Prefs = {
  rulers: boolean; guides: boolean; grid: boolean; lockGuides: boolean; pixelGrid: boolean; transformControls: boolean
  snap: boolean; snapSession: boolean; snapTo: { guides: boolean; grid: boolean; layers: boolean; bounds: boolean }
  gridSettings: GridSettings; jpegQuality: number
}

export const gridColors: [string, [number, number, number]][] = [['Light Gray', [0.7, 0.7, 0.7]], ['Light Blue', [0.29, 0.78, 1]], ['Light Red', [1, 0.4, 0.4]], ['Green', [0.25, 0.8, 0.25]], ['Medium Blue', [0.2, 0.4, 1]], ['Yellow', [1, 1, 0]], ['Magenta', [1, 0, 1]], ['Cyan', [0, 1, 1]], ['Black', [0, 0, 0]]]

const defaults: Prefs = {
  rulers: false, guides: true, grid: false, lockGuides: false, pixelGrid: true, transformControls: true,
  snap: true, snapSession: true, snapTo: { guides: true, grid: false, layers: true, bounds: true },
  gridSettings: { spacing: 64, subdivisions: 8, color: [0.7, 0.7, 0.7], style: 'Lines', opacity: 45 }, jpegQuality: 0.85,
}

const key = 'compositor.prefs.v1'
function load(): Prefs {
  try { const saved = JSON.parse(localStorage.getItem(key) ?? '{}'); return { ...defaults, ...saved, snapSession: true, snapTo: { ...defaults.snapTo, ...saved.snapTo }, gridSettings: { ...defaults.gridSettings, ...saved.gridSettings } } } catch { return defaults }
}

export let prefs: Prefs = load()
const listeners = new Set<() => void>()
export function subscribePrefs(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } }
export function setPrefs(changes: Partial<Prefs>) {
  prefs = { ...prefs, ...changes }
  try { const { snapSession: _, ...kept } = prefs; localStorage.setItem(key, JSON.stringify(kept)) } catch { /* private mode */ }
  listeners.forEach(listener => listener())
}

// Every grid line along a length, every subdivision included.
export function gridLines(length: number, settings = prefs.gridSettings) {
  const step = settings.spacing / Math.max(1, Math.min(settings.subdivisions, settings.spacing))
  return Array.from({ length: Math.floor(length / step + 0.001) + 1 }, (_, i) => Math.round(i * step))
}
