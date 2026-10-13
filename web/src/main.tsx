import { createRoot } from 'react-dom/client'
import { loadKernels } from './kernels'
import { store } from './editor/store'
import { App } from './ui/App'
import './styles.css'

await loadKernels()
// For poking at the running app from the console while developing.
if (import.meta.env.DEV) Object.assign(window, { compositorStore: store, compositorDev: { canvas: await import('./ui/canvasState'), smear: await import('./tools/smear'), paint: await import('./tools/paint'), gradient: await import('./tools/gradient'), raster: await import('./model/raster'), gpuBrush: await import('./render/gpuBrush'), actions: await import('./editor/actions'), files: await import('./io/files'), editorStore: await import('./editor/store') } })
createRoot(document.getElementById('root')!).render(<App />)
// Offline use once opened, where the page is secure (HTTPS or localhost); named by the build, so a new one replaces it.
if (import.meta.env.PROD && 'serviceWorker' in navigator && isSecureContext) navigator.serviceWorker.register(`./sw.js?v=${__BUILD__}`).catch(() => {})
