import { defineConfig, type Plugin } from 'vite'

// The files the service worker (public/sw.js) keeps for offline use: the page, its scripts and styles and the app's own data, not the
// optional parts loaded on first use (HEIC, RAW, the AI runtimes), which it keeps once they're used. The build's version names it.
// Files without a hash in their name are asked for with the build's version, so a page never gets another build's copy.
const build = Date.now().toString(36)
const offline = (): Plugin => ({
  name: 'offline-files',
  generateBundle(_, bundle) {
    const optional = /libheif|libraw|ort-wasm|subjectWorker|objectWorker|worker-/
    const built = Object.keys(bundle).filter(name => !optional.test(name) && !name.endsWith('.map'))
    const files = ['./', 'index.html', `kernels.wasm?v=${build}`, `CameraRawTables.bin?v=${build}`, 'manifest.webmanifest', 'icon.png', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png', ...built.filter(n => n !== 'index.html')]
    this.emitFile({ type: 'asset', fileName: 'offline.json', source: JSON.stringify(files) })
  },
})

// libraw-wasm starts its own worker beside itself, which Vite's dependency pre-bundling would move away from it.
export default defineConfig({ base: './', plugins: [offline()], define: { __BUILD__: JSON.stringify(build) }, esbuild: { jsx: 'automatic' }, build: { target: 'es2022' }, optimizeDeps: { exclude: ['libraw-wasm'] }, worker: { format: 'es' } })
