/* SaniTap Sampler service worker: caches the app shell for offline use. Map tiles are never cached. */
const BUILD = '__GIT_COMMIT__'; // replaced by the Pages workflow with the short git hash
const CACHE = 'sanitap-sampler-' + BUILD;
const SHELL = [
  './', './index.html', './app.js',
  './data/sample-water-points.csv',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js'
];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(async c => {
    for (const u of SHELL) { try { const r = await fetch(u, { mode: 'cors' }); if (r.ok) await c.put(u, r); } catch (err) { /* offline at install: skip */ } }
  }).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()).then(async () => {
    // Tell open pages that a new build is active; pages compare it with their own build and show the reload banner.
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    clients.forEach(c => c.postMessage({ type: 'sw-updated', build: BUILD }));
  }));
});
self.addEventListener('message', ev => { const d = ev.data || {}; if (d.type === 'build?' && ev.source) ev.source.postMessage({ type: 'build', build: BUILD }); });
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.origin === location.origin && url.pathname.endsWith('/reset.html')) return; // always from the network
  if (url.hostname.endsWith('openstreetmap.org')) return; // tiles: network only, never cached
  if (url.hostname === 'api.mwater.co') return; // mWater API: network only, never cached (URLs carry the client token)
  // index.html and app.js: network first so a new deploy is picked up, cache fallback offline
  const isShell = url.origin === location.origin && (e.request.mode === 'navigate' || /\/(index\.html)?$/.test(url.pathname) || url.pathname.endsWith('/app.js'));
  if (isShell) { e.respondWith(fetch(new Request(url.href, { cache: 'no-cache', credentials: 'same-origin' })).then(resp => { if (resp && resp.ok) { const copy = resp.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); } return resp; }).catch(() => caches.match(e.request, { ignoreSearch: true }).then(hit => hit || caches.match('./index.html')))); return; }
  // Leaflet, pdf-lib and data: cache first, then network (and store)
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then(hit => hit || fetch(e.request).then(resp => {
    if (resp && resp.ok && (url.origin === location.origin || url.hostname === 'cdnjs.cloudflare.com')) {
      const copy = resp.clone(); caches.open(CACHE).then(c => c.put(e.request, copy));
    }
    return resp;
  }).catch(() => (url.origin === location.origin && e.request.mode === 'navigate') ? caches.match('./index.html') : undefined)));
});
