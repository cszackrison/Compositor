// Offline use once the app has been opened (from the home screen especially): the files a build lists in offline.json are kept as the
// app installs, everything else the app loads (HEIC, RAW, the AI runtimes, models) the first time it's used. A new build waits for
// the open tabs to close, so a page never mixes two builds' files.
const version = new URL(self.location.href).searchParams.get('v') || 'dev'
const shell = `compositor-${version}`, later = 'compositor-runtime'

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const files = await fetch('./offline.json', { cache: 'no-store' }).then(r => r.json())
    await (await caches.open(shell)).addAll(files.map(f => new URL(f, self.registration.scope).href))
  })())
})

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('compositor-') && k !== shell && k !== later).map(k => caches.delete(k)))))
})

self.addEventListener('fetch', event => {
  const request = event.request, url = new URL(request.url)
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.includes('/samples/')) return
  // The page itself from the network when there is one, so a new build shows; the kept one offline.
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(async () => (await caches.match(request, { ignoreSearch: true, ignoreVary: true })) || caches.match(new URL('./index.html', self.registration.scope).href)))
    return
  }
  event.respondWith((async () => {
    // Module scripts are asked for with an Origin header, which a cached response's Vary: Origin would otherwise refuse.
    const kept = await caches.match(request, { ignoreVary: true })
    if (kept) return kept
    const response = await fetch(request)
    if (response.ok && response.type === 'basic') (await caches.open(later)).put(request, response.clone())
    return response
  })())
})
