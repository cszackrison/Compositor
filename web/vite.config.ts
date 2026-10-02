import { defineConfig } from 'vite'

export default defineConfig({ base: './', esbuild: { jsx: 'automatic' }, build: { target: 'es2022' } })
