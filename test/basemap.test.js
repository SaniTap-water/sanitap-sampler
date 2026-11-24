// v2.12.0: basemap switch "Carte / Satellite" (default satellite, choice kept per device, online only) and the installable app
// (manifest, icons, service worker). Node part needs nothing; the UI part drives index.html with Playwright:
// PLAYWRIGHT_DIR=<dir with node_modules/playwright> node --test test/*.test.js   (the CDN scripts of index.html need the network at boot)
const test = require('node:test'); const assert = require('node:assert/strict'); const fs = require('fs'); const path = require('path'); const http = require('http');
const C = require('../app.js');
const ROOT = path.join(__dirname, '..');
const req = (env, mod) => { try { return require(path.join(process.env[env] || '/nonexistent', 'node_modules', mod)); } catch (e) { return null; } };
const pw = req('PLAYWRIGHT_DIR', 'playwright');

const mem = () => { const m = {}; return { getItem: k => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); }, m }; };
const throwing = { getItem() { throw new Error('SecurityError'); }, setItem() { throw new Error('QuotaExceededError'); } };

test('basemap: default satellite, choice remembered, bad or blocked storage falls back', () => {
  assert.equal(C.BASEMAP_DEFAULT, 'satellite');
  const s = mem(); assert.equal(C.readBasemap(s), 'satellite');
  assert.equal(C.writeBasemap(s, 'road'), 'road'); assert.equal(s.m[C.BASEMAP_KEY], 'road'); assert.equal(C.readBasemap(s), 'road');
  assert.equal(C.writeBasemap(s, 'satellite'), 'satellite'); assert.equal(C.readBasemap(s), 'satellite');
  assert.equal(C.writeBasemap(s, 'nonsense'), 'satellite');
  s.setItem(C.BASEMAP_KEY, 'toString'); assert.equal(C.readBasemap(s), 'satellite'); // prototype names are not basemaps
  assert.equal(C.readBasemap(null), 'satellite'); assert.equal(C.readBasemap(throwing), 'satellite');
  assert.equal(C.writeBasemap(throwing, 'road'), 'road'); // used for this session, just not remembered
});

test('basemap: Esri World Imagery + labels with attribution, zoom 19+, road map kept', () => {
  const B = C.BASEMAPS;
  assert.match(B.satellite.url, /^https:\/\/server\.arcgisonline\.com\/ArcGIS\/rest\/services\/World_Imagery\/MapServer\/tile\/\{z\}\/\{y\}\/\{x\}$/);
  assert.equal(new URL(B.satellite.url.replace(/[{}]/g, '')).host, C.TILES.host); // same Esri provider as the record PDF
  assert.match(B.satellite.labels.url, /Reference\/World_Boundaries_and_Places\/MapServer\/tile\//);
  assert.match(B.satellite.attribution, /Esri/); assert.match(B.satellite.labels.attribution, /Esri/);
  assert.ok(B.satellite.maxZoom >= 19 && B.road.maxZoom >= 19);
  assert.match(B.road.url, /tile\.openstreetmap\.org/); assert.match(B.road.attribution, /OpenStreetMap/);
});

test('basemap: deepest real imagery level from the tilemap', async () => {
  const asked = []; const upTo = top => (z, y, x) => { asked.push(z); return Promise.resolve(z <= top); };
  assert.equal(await C.deepestImagery(upTo(17), -25.03, 46.98, 19, 16), 17); assert.deepEqual(asked, [19, 18, 17]);
  assert.equal(await C.deepestImagery(upTo(19), -25.03, 46.98, 19, 16), 19);
  assert.equal(await C.deepestImagery(upTo(10), -25.03, 46.98, 19, 16), 16);
  assert.equal(await C.deepestImagery(() => Promise.reject(new Error('offline')), -25.03, 46.98, 19, 16), null);
  // tile numbers match the slippy-map scheme Esri uses ({z}/{y}/{x})
  let got; await C.deepestImagery((z, y, x) => { got = [z, y, x]; return true; }, -25.03, 46.985, 17, 16);
  assert.deepEqual(got, [17, 74953, 82642]);
});

test('install: manifest, icons and service worker meet Chrome installability', () => {
  const m = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.webmanifest'), 'utf8'));
  assert.equal(m.name, 'SaniTap Sampler'); assert.equal(m.short_name, 'Sampler');
  assert.equal(m.start_url, './'); assert.equal(m.scope, './'); assert.equal(m.display, 'standalone');
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const theme = html.match(/<meta name="theme-color" content="([^"]+)">/)[1];
  assert.equal(m.theme_color, theme); assert.equal(m.background_color, theme);
  assert.match(html, /<link rel="manifest" href="manifest\.webmanifest">/);
  const png = f => { const b = fs.readFileSync(path.join(ROOT, f)); assert.equal(b.toString('latin1', 1, 4), 'PNG', f); return [b.readUInt32BE(16), b.readUInt32BE(20)]; };
  const want = { '192x192|any': 0, '512x512|any': 0, '512x512|maskable': 0 };
  m.icons.forEach(i => { assert.equal(i.type, 'image/png'); const [w, h] = png(i.src); assert.equal(w + 'x' + h, i.sizes, i.src); want[i.sizes + '|' + (i.purpose || 'any')]++; });
  Object.keys(want).forEach(k => assert.equal(want[k], 1, k));
  const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
  assert.match(sw, /addEventListener\('fetch'/);
  ['./manifest.webmanifest'].concat(m.icons.map(i => './' + i.src)).forEach(u => assert.ok(sw.includes("'" + u + "'"), 'sw.js caches ' + u));
  assert.match(sw, /server\.arcgisonline\.com'\) return;/); // tiles (road + satellite + labels) never cached
});

// ---------- UI (Playwright) ----------
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.csv': 'text/csv', '.css': 'text/css', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
function serve() { return new Promise(res => { const s = http.createServer((q, r) => { let p = decodeURIComponent(new URL(q.url, 'http://x').pathname); if (p.endsWith('/')) p += 'index.html'; const f = path.join(ROOT, path.normalize(p)); if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); fs.createReadStream(f).pipe(r); }); s.listen(0, '127.0.0.1', () => res(s)); }); }

test('UI: Map tab defaults to satellite, the switch is remembered after reload, offline shows the notice and keeps the map', { timeout: 240000 }, async () => {
  if (!pw) { console.log('  (PLAYWRIGHT_DIR needed) — skipped'); return; }
  const server = await serve(); const base = 'http://127.0.0.1:' + server.address().port + '/';
  const browser = await pw.chromium.launch(); const tiles = [];
  try {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
    // no real tiles in the test: answer every tile request with a 1x1 PNG and note the host/path
    const PNG = fs.readFileSync(path.join(ROOT, 'icons', 'icon-192.png'));
    await ctx.route(/(arcgisonline\.com|tile\.openstreetmap\.org)/, r => { const u = r.request().url(); tiles.push(u); if (/tilemap/.test(u)) return r.fulfill({ status: 200, contentType: 'application/json', body: '{"data":[0]}' }); return r.fulfill({ status: 200, contentType: 'image/png', body: PNG }); });
    const page = await ctx.newPage(); const errs = []; page.on('pageerror', e => errs.push(e.message));
    const boot = async () => { await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 90000 }); await page.waitForFunction(() => /^v\d/.test((document.getElementById('ver') || {}).textContent || ''), null, { timeout: 90000 }); await page.evaluate(() => { document.getElementById('lang-toggle').textContent === 'EN' || document.getElementById('lang-toggle').click(); }); await page.click('nav button[data-tab="map"]'); await page.waitForSelector('#map .bm-switch button'); };
    const state = () => page.evaluate(() => ({ on: [...document.querySelectorAll('#map .bm-switch button')].map(b => b.textContent + (b.classList.contains('on') ? '*' : '')), sat: !!document.querySelector('#map img[src*="World_Imagery"]'), labels: !!document.querySelector('#map img[src*="World_Boundaries_and_Places"]'), osm: !!document.querySelector('#map img[src*="openstreetmap"]'), note: (() => { const n = document.querySelector('#map .bm-offline'); return n && !n.classList.contains('hidden') ? n.textContent : null; })(), stored: localStorage.getItem('sanitap.basemap'), attr: document.querySelector('#map .leaflet-control-attribution').textContent }));
    await boot(); await page.waitForTimeout(800);
    let s = await state();
    assert.deepEqual(s.on, ['Carte', 'Satellite*']); assert.ok(s.sat && s.labels && !s.osm, JSON.stringify(s)); assert.equal(s.stored, null); assert.match(s.attr, /Esri/); assert.equal(s.note, null);
    await page.click('#map .bm-switch button[data-bm="road"]'); await page.waitForTimeout(500);
    s = await state(); assert.deepEqual(s.on, ['Carte*', 'Satellite']); assert.ok(s.osm && !s.sat && !s.labels, JSON.stringify(s)); assert.equal(s.stored, 'road'); assert.match(s.attr, /OpenStreetMap/);
    await boot(); await page.waitForTimeout(500);
    s = await state(); assert.deepEqual(s.on, ['Carte*', 'Satellite'], 'remembered after reload'); assert.ok(s.osm && !s.sat);
    await page.click('#map .bm-switch button[data-bm="satellite"]'); await page.waitForTimeout(300);
    assert.equal((await state()).stored, 'satellite');
    // the map lets the team zoom to roof level on satellite
    for (let i = 0; i < 30 && !(await page.evaluate(() => document.querySelector('#map .leaflet-control-zoom-in').classList.contains('leaflet-disabled'))); i++) { await page.click('#map .leaflet-control-zoom-in'); await page.waitForTimeout(350); }
    assert.ok(await page.evaluate(() => document.querySelector('#map .leaflet-control-zoom-in').classList.contains('leaflet-disabled')), 'zoom stops at the max');
    await page.waitForTimeout(1500);
    const deep = await page.evaluate(() => [...document.querySelectorAll('#map img[src*="World_Imagery"]')].map(i => +i.src.split('/tile/')[1].split('/')[0]));
    assert.ok(deep.length, 'imagery shown at the deepest zoom');
    // the stubbed tilemap says no imagery below z17 here, so the map stretches z16 instead of asking for grey "no data" tiles
    assert.ok(Math.max(...deep) <= 16, 'stretched, not grey: ' + deep.join(','));
    // offline: French notice on the map, switch still there
    await ctx.setOffline(true); await page.evaluate(() => window.dispatchEvent(new Event('offline'))); await page.waitForTimeout(300);
    s = await state(); assert.equal(s.note, 'Image satellite disponible seulement avec internet');
    await page.click('#map .bm-switch button[data-bm="road"]'); assert.equal((await state()).note, null, 'no notice on the road map');
    await page.click('#map .bm-switch button[data-bm="satellite"]');
    await ctx.setOffline(false); await page.evaluate(() => window.dispatchEvent(new Event('online'))); await page.waitForTimeout(300);
    assert.equal((await state()).note, null);
    // blocked storage: the page still boots and shows satellite
    const ctx2 = await browser.newContext({ serviceWorkers: 'block' }); await ctx2.route(/(arcgisonline\.com|tile\.openstreetmap\.org)/, r => r.fulfill({ status: 200, contentType: 'image/png', body: PNG }));
    await ctx2.addInitScript(() => { Object.defineProperty(window, 'localStorage', { get() { throw new Error('SecurityError'); } }); });
    const p2 = await ctx2.newPage(); const errs2 = []; p2.on('pageerror', e => errs2.push(e.message));
    await p2.goto(base, { waitUntil: 'domcontentloaded', timeout: 90000 }); await p2.waitForFunction(() => /^v\d/.test((document.getElementById('ver') || {}).textContent || ''), null, { timeout: 90000 });
    await p2.click('nav button[data-tab="map"]'); await p2.waitForSelector('#map .bm-switch button.on');
    assert.equal(await p2.getAttribute('#map .bm-switch button.on', 'data-bm'), 'satellite');
    assert.deepEqual(errs2, []); assert.deepEqual(errs, []);
    assert.ok(tiles.some(u => /World_Imagery\/MapServer\/tilemap\//.test(u)), 'tilemap asked at deep zoom');
    await ctx2.close(); await ctx.close();
  } finally { await browser.close(); server.close(); }
});
