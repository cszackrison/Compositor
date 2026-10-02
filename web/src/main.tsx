import { createRoot } from 'react-dom/client'
import { loadKernels } from './kernels'
import { store } from './editor/store'
import { App } from './ui/App'
import './styles.css'

await loadKernels()
if (import.meta.env.DEV) Object.assign(window, { compositorStore: store })
createRoot(document.getElementById('root')!).render(<App />)
