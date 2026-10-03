import { useSyncExternalStore } from 'react'

function media(query: string) {
  const list = typeof matchMedia === 'undefined' ? null : matchMedia(query)
  return {
    get: () => !!list?.matches,
    subscribe: (listener: () => void) => { list?.addEventListener('change', listener); return () => list?.removeEventListener('change', listener) },
  }
}

// Phone width: the canvas fills the screen, the tools sit in bars along the bottom, and layers come up in a sheet.
const compact = media('(max-width: 760px)')
// A finger rather than a mouse: bigger targets, and on-screen stand-ins for the modifier keys.
const coarse = media('(pointer: coarse)')

export const useCompact = () => useSyncExternalStore(compact.subscribe, compact.get)
export const useCoarse = () => useSyncExternalStore(coarse.subscribe, coarse.get)
export const isCoarse = coarse.get
