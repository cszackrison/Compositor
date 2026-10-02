import { runClang } from '@yowasp/clang'
import { readFileSync, readdirSync, writeFileSync, mkdirSync, statSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const web = join(dirname(fileURLToPath(import.meta.url)), '..')
const kernels = join(web, '../Compositor/Rendering')
const output = join(web, 'public/kernels.wasm')
const sources = readdirSync(kernels).filter(name => /\.[ch]$/.test(name))
const newest = Math.max(...[...sources.map(name => join(kernels, name)), join(web, 'wasm/runtime.c'), join(web, 'wasm/include/dispatch/dispatch.h'), import.meta.filename].map(path => statSync(path).mtimeMs))
if (existsSync(output) && statSync(output).mtimeMs > newest) process.exit(0)

const exports = readdirSync(kernels).filter(name => name.endsWith('.h')).flatMap(name => [...readFileSync(join(kernels, name), 'utf8').matchAll(/^\s*(?:void|int|long|size_t)\s+\**(\w+)\s*\(/gm)].map(match => match[1]))
const files = { 'runtime.c': readFileSync(join(web, 'wasm/runtime.c')), include: { dispatch: { 'dispatch.h': readFileSync(join(web, 'wasm/include/dispatch/dispatch.h')) } } }
for (const name of sources) files[name] = readFileSync(join(kernels, name))
const cFiles = sources.filter(name => name.endsWith('.c'))
const result = await runClang(['clang', '--target=wasm32-wasip1', '-O3', '-fblocks', '-msimd128', '-mexec-model=reactor', '-Iinclude', '-I.', '-Wno-everything',
  '-Wl,--export-dynamic', '-Wl,--growable-table', '-Wl,--initial-memory=67108864', '-Wl,--max-memory=4294967296', '-Wl,-z,stack-size=8388608',
  ...exports.map(name => `-Wl,--export=${name}`), '-o', 'kernels.wasm', 'runtime.c', ...cFiles], files)
mkdirSync(dirname(output), { recursive: true })
writeFileSync(output, result['kernels.wasm'])
console.log(`kernels.wasm: ${result['kernels.wasm'].length} bytes, ${exports.length} exports`)
