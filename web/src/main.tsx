import { createRoot } from 'react-dom/client'
import { loadKernels } from './kernels'
import { store } from './editor/store'
import { App } from './ui/App'
import './styles.css'

await loadKernels()
// For poking at the running app from the console while developing.
if (import.meta.env.DEV) Object.assign(window, { compositorStore: store, compositorDev: { canvas: await import('./ui/canvasState'), smear: await import('./tools/smear'), paint: await import('./tools/paint'), gradient: await import('./tools/gradient'), raster: await import('./model/raster') } })
createRoot(document.getElementById('root')!).render(<App />)
