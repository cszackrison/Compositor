import { defineConfig } from 'vite'

// libraw-wasm starts its own worker beside itself, which Vite's dependency pre-bundling would move away from it.
export default defineConfig({ base: './', esbuild: { jsx: 'automatic' }, build: { target: 'es2022' }, optimizeDeps: { exclude: ['libraw-wasm'] }, worker: { format: 'es' } })
