type Exports = Record<string, (...args: number[]) => number> & { memory: WebAssembly.Memory }

let exports: Exports | undefined
let compiled: WebAssembly.Module | undefined

// Workers take the page's compiled module, since a relative base URL would resolve against the worker's own script.
export async function loadKernels(source?: BufferSource | WebAssembly.Module) {
  if (exports) return
  compiled = source instanceof WebAssembly.Module ? source : await WebAssembly.compile(source ?? await fetch(`${import.meta.env.BASE_URL}kernels.wasm`).then(response => response.arrayBuffer()))
  const instance = await WebAssembly.instantiate(compiled, {})
  exports = instance.exports as unknown as Exports
  exports._initialize?.()
}

export const kernelModule = () => compiled

function kernel() {
  if (!exports) throw new Error('Pixel kernels are not loaded')
  return exports
}

export function heap() { return new Uint8Array(kernel().memory.buffer) }

// Copies `inputs` into wasm memory, runs `body` with their addresses, copies back any marked `out`, then frees them.
export function withBuffers<T>(inputs: { data: ArrayBufferView; out?: boolean }[], body: (pointers: number[], call: Exports) => T): T {
  const k = kernel()
  const pointers = inputs.map(input => {
    const pointer = k.wasm_alloc(input.data.byteLength)
    if (!pointer) throw new Error('Out of wasm memory')
    heap().set(new Uint8Array(input.data.buffer, input.data.byteOffset, input.data.byteLength), pointer)
    return pointer
  })
  try {
    const result = body(pointers, k)
    inputs.forEach((input, index) => { if (input.out) new Uint8Array(input.data.buffer, input.data.byteOffset, input.data.byteLength).set(heap().subarray(pointers[index], pointers[index] + input.data.byteLength)) })
    return result
  } finally { pointers.forEach(pointer => k.wasm_free(pointer)) }
}

export function floats(values: ArrayLike<number>) { return { data: Float32Array.from(values) } }

export function call(name: string, ...args: number[]) { return kernel()[name](...args) }
