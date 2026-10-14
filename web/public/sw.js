// Offline use once the app has been opened (from the home screen especially): the files a build lists in offline.json are kept as the
// app installs, everything else the app loads (HEIC, RAW, the AI runtimes) the first time it's used. A new build waits for the open
// tabs to close, and files without a hash in their name carry the build's version, so a page never mixes two builds' files.
const version = new URL(self.location.href).searchParams.get('v') || 'dev'
const shell = `compositor-shell-${version}`, later = 'compositor-runtime'

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const files = await fetch('./offline.json', { cache: 'no-store' }).then(r => r.json())
    // Straight from the server, not the browser's HTTP cache, which may still hold the last build's copy.
    await (await caches.open(shell)).addAll(files.map(f => new Request(new URL(f, self.registration.scope).href, { cache: 'reload' })))
  })())
})

// Earlier builds' files go, the ones loaded on first use with them (they're named for their build); the AI models stay.
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k === later || (k.startsWith('compositor-shell-') && k !== shell) || /^compositor-[0-9a-z]{8}$/.test(k)).map(k => caches.delete(k)))))
})

self.addEventListener('fetch', event => {
  const request = event.request, url = new URL(request.url)
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.includes('/samples/')) return
  // The page itself from the network when there is one, so a new build shows; the kept one offline.
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(async () => (await (await caches.open(shell)).match(request, { ignoreSearch: true, ignoreVary: true })) || (await caches.open(shell)).match(new URL('./index.html', self.registration.scope).href)))
    return
  }
  event.respondWith((async () => {
    // This build's files first. Module scripts are asked for with an Origin header, which a cached response's Vary: Origin would
    // otherwise refuse.
    const kept = (await (await caches.open(shell)).match(request, { ignoreVary: true })) || (await (await caches.open(later)).match(request, { ignoreVary: true }))
    if (kept) return kept
    const response = await fetch(request)
    if (response.ok && response.type === 'basic') (await caches.open(later)).put(request, response.clone())
    return response
  })())
})
