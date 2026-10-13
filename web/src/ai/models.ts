// Model files for the AI features, run in workers: downloaded from Hugging Face the first time, with progress posted to the page
// ({ kind: 'progress', received, total, model }), and kept in the browser's cache.
export async function downloadModel(url: string, size: number, model: string): Promise<Uint8Array> {
  const cache = typeof caches !== 'undefined' ? await caches.open('compositor-models').catch(() => null) : null
  const cached = await cache?.match(url)
  if (cached) return new Uint8Array(await cached.arrayBuffer())
  const response = await fetch(url)
  if (!response.ok || !response.body) throw new Error(`Couldn’t download the ${model} model (${response.status}).`)
  const total = Number(response.headers.get('content-length')) || size
  const reader = response.body.getReader(), parts: Uint8Array[] = []
  let received = 0, reported = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    parts.push(value)
    received += value.byteLength
    if (received - reported > total / 100) { reported = received; self.postMessage({ kind: 'progress', received, total, model }) }
  }
  const bytes = new Uint8Array(received)
  let at = 0
  for (const part of parts) { bytes.set(part, at); at += part.byteLength }
  await cache?.put(url, new Response(bytes, { headers: { 'content-type': 'application/octet-stream' } })).catch(() => {})
  return bytes
}

// A WebGPU device asking for the adapter's real limits: some models have shaders with more storage buffers than WebGPU's default
// allows (17 against 16), which most GPUs support when asked.
export async function gpuDevice(): Promise<GPUDevice | null> {
  const adapter = await navigator.gpu?.requestAdapter().catch(() => null)
  if (!adapter) return null
  const limits = adapter.limits as unknown as Record<string, number>
  const wanted = ['maxStorageBuffersPerShaderStage', 'maxStorageBufferBindingSize', 'maxBufferSize', 'maxComputeWorkgroupStorageSize', 'maxComputeInvocationsPerWorkgroup', 'maxComputeWorkgroupSizeX', 'maxComputeWorkgroupSizeY', 'maxComputeWorkgroupSizeZ']
  return adapter.requestDevice({
    requiredFeatures: (['shader-f16', 'subgroups'] as GPUFeatureName[]).filter(f => adapter.features.has(f)),
    requiredLimits: Object.fromEntries(wanted.filter(name => name in limits).map(name => [name, limits[name]])),
  }).catch(() => null)
}
