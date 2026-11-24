// v2.12.1: tapping a map marker shows number/role, code, name, latitude and longitude (6 decimals), "Copier" and "Naviguer" (geo:),
// in French, from positions already on the device. Node part: popup content and the copy fallback. UI part (Playwright): a
// demo-CSV SDWS 18 draw is confirmed, then a marker on the Map tab is tapped; Copier with and without clipboard permission.
// PLAYWRIGHT_DIR=<dir with node_modules/playwright> node --test test/*.test.js   (the CDN scripts of index.html need the network)
const test = require('node:test'); const assert = require('node:assert/strict'); const fs = require('fs'); const path = require('path'); const http = require('http');
const C = require('../app.js');
const ROOT = path.join(__dirname, '..');
const req = (env, mod) => { try { return require(path.join(process.env[env] || '/nonexistent', 'node_modules', mod)); } catch (e) { return null; } };
const pw = req('PLAYWRIGHT_DIR', 'playwright');

test('popup: role, code, name, 6-decimal WGS 84 position, Copier and a geo: Naviguer link, in French', () => {
  const h = C.pointPopupHtml({ title: 'Point n° 3', code: '742895814', alt: 'P-12', name: 'Canzee <Ambovo>', lines: ['Commune A / Fkt B'], lat: -25.0123456, lon: 46.98 });
  assert.match(h, /Point n° 3/); assert.match(h, /<b>742895814<\/b> P-12/); assert.match(h, /Canzee &lt;Ambovo&gt;/); assert.match(h, /Commune A \/ Fkt B/);
  assert.match(h, /Latitude <b>-25\.012346<\/b>/); assert.match(h, /Longitude <b>46\.980000<\/b>/);
  assert.match(h, /<button type="button" class="pp-copy" data-ll="-25\.012346, 46\.980000">Copier<\/button>/);
  assert.match(h, /<a class="pp-nav" href="geo:-25\.012346,46\.980000\?q=-25\.012346,46\.980000">Naviguer<\/a>/);
  assert.equal(C.geoUri(-15.4, 49.7), 'geo:-15.400000,49.700000?q=-15.400000,49.700000'); assert.equal(C.coordText(-15.4, 49.7), '-15.400000, 49.700000');
  const none = C.pointPopupHtml({ title: 'Réserve R1', code: 'X', lat: NaN, lon: undefined });
  assert.match(none, /Position inconnue/); assert.ok(!/pp-copy|geo:/.test(none));
  // the record outputs stay coordinate-free: the popup lives in the UI only
  assert.ok(!/pointPopupHtml|copyCoords/.test(C.buildSamplingRecordPdf.toString() + C.auditJson.toString()));
});

test('popup: copy uses the clipboard, else selects the text (and tries execCommand), never throws', async () => {
  const got = []; let selected = 0;
  assert.equal(await C.copyCoords('1, 2', { clipboard: { writeText: t => { got.push(t); return Promise.resolve(); } }, select: () => selected++ }), 'copied');
  assert.deepEqual(got, ['1, 2']); assert.equal(selected, 0);
  const denied = { writeText: () => Promise.reject(new Error('NotAllowedError')) };
  assert.equal(await C.copyCoords('1, 2', { clipboard: denied, select: () => selected++, execCopy: () => false }), 'selected'); assert.equal(selected, 1);
  assert.equal(await C.copyCoords('1, 2', { clipboard: null, select: () => selected++, execCopy: () => true }), 'copied'); assert.equal(selected, 2);
  assert.equal(await C.copyCoords('1, 2', { clipboard: { writeText() { throw new Error('sync'); } }, select: () => selected++, execCopy: () => { throw new Error('x'); } }), 'selected');
  assert.equal(await C.copyCoords('1, 2', { select: () => { throw new Error('no DOM'); } }), 'failed');
  assert.equal(await C.copyCoords('1, 2'), 'selected');
});

// ---------- UI ----------
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.csv': 'text/csv', '.css': 'text/css', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
function serve() { return new Promise(res => { const s = http.createServer((q, r) => { let p = decodeURIComponent(new URL(q.url, 'http://x').pathname); if (p.endsWith('/')) p += 'index.html'; const f = path.join(ROOT, path.normalize(p)); if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); fs.createReadStream(f).pipe(r); }); s.listen(0, '127.0.0.1', () => res(s)); }); }

test('UI: tapping a marker on the Map tab shows the popup; Copier copies, or selects the text when the clipboard is refused', { timeout: 300000 }, async () => {
  if (!pw) { console.log('  (PLAYWRIGHT_DIR needed) — skipped'); return; }
  const server = await serve(); const base = 'http://127.0.0.1:' + server.address().port + '/';
  const browser = await pw.chromium.launch();
  const PNG = fs.readFileSync(path.join(ROOT, 'icons', 'icon-192.png'));
  try {
    for (const variant of ['clipboard', 'refused']) {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block', acceptDownloads: true });
      await ctx.route(/(arcgisonline\.com|tile\.openstreetmap\.org)/, r => /tilemap/.test(r.request().url()) ? r.fulfill({ status: 200, contentType: 'application/json', body: '{"data":[1]}' }) : r.fulfill({ status: 200, contentType: 'image/png', body: PNG }));
      if (variant === 'clipboard') await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base.replace(/\/$/, '') });
      else await ctx.addInitScript(() => { Object.defineProperty(navigator, 'clipboard', { get: () => ({ writeText: () => Promise.reject(new DOMException('denied', 'NotAllowedError')) }) }); document.execCommand = () => false; });
      const page = await ctx.newPage(); const errs = []; page.on('pageerror', e => errs.push(e.message));
      await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 90000 }); await page.waitForFunction(() => /^v\d/.test((document.getElementById('ver') || {}).textContent || ''), null, { timeout: 90000 });
      await page.click('#btn-sample'); await page.waitForTimeout(500); await page.click('nav button[data-tab="params"]');
      await page.fill('#p-round', 'POPUP-TEST'); await page.fill('#p-drawn-by', 'Test');
      await page.click('#btn-draw'); await page.waitForTimeout(800);
      await page.click('nav button[data-tab="confirm"]'); await page.click('#btn-confirm');
      await page.waitForFunction(() => { const s = document.getElementById('round-sel'); return s && /POPUP-TEST/.test(s.value); }, null, { timeout: 60000 });
      await page.click('nav button[data-tab="map"]'); await page.waitForSelector('#map .leaflet-marker-icon .num-icon', { timeout: 15000 });
      // the first selected source (blue "1") and a replacement
      const want = await page.evaluate(() => { const rows = [...document.querySelectorAll('#map-list tr')].slice(1); return rows.map(r => r.cells[0].textContent.trim() + '|' + r.cells[1].querySelector('b').textContent.trim()); });
      assert.ok(want.length > 2, 'stop list');
      for (const lab of ['1', 'R1']) {
        await page.locator('#map .leaflet-marker-icon .num-icon', { hasText: new RegExp('^' + lab + '$') }).first().dispatchEvent('click'); // demo markers overlap: click the icon itself
        await page.waitForSelector('.pt-popup .pp');
        const p = await page.evaluate(() => { const b = document.querySelector('.pt-popup .pp'); const r1 = b.querySelector('.pp-copy').getBoundingClientRect(), r2 = b.querySelector('.pp-nav').getBoundingClientRect(); return { text: b.innerText, ll: b.querySelector('.pp-copy').dataset.ll, href: b.querySelector('.pp-nav').getAttribute('href'), h: [r1.height, r2.height] }; });
        assert.match(p.text, lab === '1' ? /Point n° 1/ : /Remplacement R1/);
        const code = want.find(w => w.split('|')[0] === lab).split('|')[1]; assert.ok(p.text.includes(code), 'code ' + code + ' in ' + p.text);
        assert.match(p.ll, /^-?\d+\.\d{6}, -?\d+\.\d{6}$/); const [la, lo] = p.ll.split(', ');
        assert.match(p.text, new RegExp('Latitude ' + la.replace('.', '\\.'))); assert.match(p.text, new RegExp('Longitude ' + lo.replace('.', '\\.')));
        assert.equal(p.href, 'geo:' + la + ',' + lo + '?q=' + la + ',' + lo);
        assert.ok(p.h.every(x => x >= 44), 'tap targets >= 44 px: ' + p.h);
        await page.locator('.pt-popup .pp-copy').tap(); await page.waitForFunction(() => document.querySelector('.pt-popup .pp').dataset.copy);
        const after = await page.evaluate(() => ({ res: document.querySelector('.pt-popup .pp').dataset.copy, msg: document.querySelector('.pt-popup .pp-msg').textContent, sel: String(window.getSelection()) }));
        if (variant === 'clipboard') { assert.equal(after.res, 'copied'); assert.equal(await page.evaluate(() => navigator.clipboard.readText()), p.ll); assert.equal(after.msg, 'Copié : ' + p.ll); }
        else { assert.equal(after.res, 'selected'); assert.equal(after.sel, p.ll); assert.match(after.msg, /appuyez longuement pour copier/); }
        await page.evaluate(() => document.querySelector('#map .leaflet-popup-close-button').click());
        await page.waitForSelector('.pt-popup', { state: 'detached' });
      }
      assert.deepEqual(errs, []);
      await ctx.close();
    }
  } finally { await browser.close(); server.close(); }
});
