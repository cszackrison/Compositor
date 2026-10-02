import { useSyncExternalStore } from 'react'
import { store, subscribeTabs, tabsVersion, type State } from '../editor/store'

// The active project's state, following tab switches as well as edits.
export function useEditor(): State {
  useSyncExternalStore(subscribeTabs, () => tabsVersion.value)
  return useSyncExternalStore(store.subscribe, store.getState)
}

export function useTabs() { return useSyncExternalStore(subscribeTabs, () => tabsVersion.value) }
