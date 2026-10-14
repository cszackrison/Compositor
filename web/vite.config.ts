import { defineConfig, type Plugin } from 'vite'
import { readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'

// The files the service worker (public/sw.js) keeps for offline use: the page, its scripts and styles and the app's own data, not the
// optional parts loaded on first use (HEIC, RAW, the AI runtimes), which it keeps once they're used. The build's version names it.
// Files without a hash in their name are asked for with the build's version, so a page never gets another build's copy.
const build = Date.now().toString(36)
// What the About box shows: the Mac app's version this port follows (from its Xcode project), and the commit and day it was built.
const macVersion = (() => { try { return readFileSync(new URL('../Compositor.xcodeproj/project.pbxproj', import.meta.url), 'utf8').match(/MARKETING_VERSION = ([^;]+);/)?.[1] ?? '' } catch { return '' } })()
const commit = (() => { try { return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() } catch { return '' } })()
const offline = (): Plugin => ({
  name: 'offline-files',
  generateBundle(_, bundle) {
    const optional = /libheif|libraw|ort-wasm|subjectWorker|objectWorker|worker-/
    const built = Object.keys(bundle).filter(name => !optional.test(name) && !name.endsWith('.map'))
    const files = ['./', 'index.html', `kernels.wasm?v=${build}`, `CameraRawTables.bin?v=${build}`, `CameraRawShadows.bin?v=${build}`, 'manifest.webmanifest', 'icon.png', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png', ...built.filter(n => n !== 'index.html')]
    this.emitFile({ type: 'asset', fileName: 'offline.json', source: JSON.stringify(files) })
  },
})

// libraw-wasm starts its own worker beside itself, which Vite's dependency pre-bundling would move away from it.
export default defineConfig({ base: './', plugins: [offline()], define: { __BUILD__: JSON.stringify(build), __VERSION__: JSON.stringify(macVersion), __COMMIT__: JSON.stringify(commit), __BUILT__: JSON.stringify(new Date().toISOString().slice(0, 10)) }, esbuild: { jsx: 'automatic' }, build: { target: 'es2022' }, optimizeDeps: { exclude: ['libraw-wasm'] }, worker: { format: 'es' } })
