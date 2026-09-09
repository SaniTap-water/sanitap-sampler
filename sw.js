/* SaniTap Sampler service worker: caches the app shell for offline use. Map tiles are never cached. */
const CACHE = 'sanitap-sampler-v1.3.0';
const SHELL = [
  './', './index.html', './app.js',
  './data/sample-water-points.csv',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js'
];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(async c => {
    for (const u of SHELL) { try { const r = await fetch(u, { mode: 'cors' }); if (r.ok) await c.put(u, r); } catch (err) { /* offline at install: skip */ } }
  }).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.hostname.endsWith('openstreetmap.org')) return; // tiles: network only, never cached
  if (url.hostname === 'api.mwater.co') return; // mWater API: network only, never cached (URLs carry the client token)
  // Leaflet marker images etc. from cdnjs, and the app shell: cache first, then network (and store)
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then(hit => hit || fetch(e.request).then(resp => {
    if (resp && resp.ok && (url.origin === location.origin || url.hostname === 'cdnjs.cloudflare.com')) {
      const copy = resp.clone(); caches.open(CACHE).then(c => c.put(e.request, copy));
    }
    return resp;
  }).catch(() => (url.origin === location.origin && e.request.mode === 'navigate') ? caches.match('./index.html') : undefined)));
});
