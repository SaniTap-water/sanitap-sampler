// v2.13.0 in the browser: an HP-MA usage round of 2027 (the demo frame's FD stratum renamed HP-MA, synthetic buildings) records the
// household area rule, draws households only inside each nearest-point cell, and shows the cell (dashed) on the Map and Field tabs,
// also on an offline tablet B that has only the record PDF and the field pack.
// PLAYWRIGHT_DIR=<dir with node_modules/playwright> node --test test/*.test.js   (the CDN scripts of index.html need the network at boot)
const test = require('node:test'); const assert = require('node:assert/strict'); const fs = require('fs'); const path = require('path'); const os = require('os'); const http = require('http');
const req = (env, mod) => { try { return require(path.join(process.env[env] || '/nonexistent', 'node_modules', mod)); } catch (e) { return null; } };
const pw = req('PLAYWRIGHT_DIR', 'playwright');
const ROOT = path.join(__dirname, '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.csv': 'text/csv', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
function serve() { return new Promise(res => { const s = http.createServer((q, r) => { let p = decodeURIComponent(new URL(q.url, 'http://x').pathname); if (p.endsWith('/')) p += 'index.html'; const f = path.join(ROOT, path.normalize(p)); if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' });
  if (p.endsWith('/sample-water-points.csv')) return r.end(fs.readFileSync(f, 'utf8').replace(/,FD,/g, ',HP-MA,')); fs.createReadStream(f).pipe(r); }); s.listen(0, '127.0.0.1', () => res(s)); }); }
// synthetic village around each point (as test/screens.py), never real households
const SYNTH = `window.SAMPLER_TEST = {
  buildings: async (lat, lon) => { const out = []; const kx = 111320 * Math.cos(lat * Math.PI / 180), ky = 110574; let s = 7; const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
    for (let x = -700; x <= 700; x += 45) for (let y = -700; y <= 700; y += 45) { if (x * x + y * y > 700 * 700 || rnd() < 0.55) continue; const cx = x + (rnd() - .5) * 20, cy = y + (rnd() - .5) * 20, d = 4 + rnd() * 4;
      const ring = [[cx - d, cy - d], [cx + d, cy - d], [cx + d, cy + d], [cx - d, cy + d], [cx - d, cy - d]].map(([a, b]) => [lon + a / kx, lat + b / ky]); out.push({ geometry: { type: 'Polygon', coordinates: [ring] }, properties: { bf_source: 'google' } }); }
    return out; },
  overpass: async (lat, lon) => { const kx = 111320 * Math.cos(lat * Math.PI / 180), ky = 110574; return { elements: [{ type: 'way', tags: { waterway: 'river' }, geometry: [[450, -1200], [380, 0], [470, 1200]].map(([x, y]) => ({ lat: lat + y / ky, lon: lon + x / kx })) }] }; }
};`;
// tablet B: any building or barrier read fails, so its households can only come from the pack
const NOSOURCE = `window.SAMPLER_TEST = { buildings: async () => { throw new Error('no building source on tablet B'); }, overpass: async () => { throw new Error('no barrier source on tablet B'); } };`;
const ROUND = `async () => { const rid = document.getElementById('round-sel').value; const r = await new Promise((res, rej) => { const q = indexedDB.open('sanitap-sampler'); q.onerror = rej; q.onsuccess = () => { const g = q.result.transaction('rounds').objectStore('rounds').get(rid); g.onsuccess = () => res(g.result); g.onerror = rej; }; });
  if (!r) return { rid, round: null }; const list = r.points.concat(r.reserves); return { rid, ids: list.map(w => String(w.water_point_id)), pos: list.map(w => [w.lat, w.lon]), households: list.map(w => (r.areas[w.water_point_id] || { draw: [] }).draw.map(d => [d.position, !!d.reserve, d.key])), next: (document.querySelector('#f-next .fbig') || {}).textContent || null }; }`;
async function boot(ctx, base) { const page = await ctx.newPage(); const errs = []; page.on('pageerror', e => errs.push(e.message)); await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 90000 }); await page.waitForFunction(() => /^v\d/.test((document.getElementById('ver') || {}).textContent || ''), null, { timeout: 90000 }); return { page, errs }; }
async function openFile(page, f) { await page.evaluate(() => { document.getElementById('open-msg').innerHTML = ''; }); await page.setInputFiles('#open-file', f); /* cleared first: a previous message must not satisfy the wait */ await page.waitForFunction(() => { const m = document.getElementById('open-msg').textContent.trim(); return m && !/^(Opening|Ouverture)/.test(m); }, null, { timeout: 20000 }); return page.evaluate(() => ({ tab: document.querySelector('nav button.active').dataset.tab, sel: document.getElementById('round-sel').value, msg: document.getElementById('open-msg').textContent.trim() })); }

const C = require('../app.js');
const cells = page => page.evaluate(sel => [...document.querySelectorAll(sel + ' path.leaflet-interactive, ' + sel + ' path')].filter(p => p.getAttribute('stroke-dasharray') === '6 4').length, '#fmap');
const mapCells = page => page.evaluate(() => [...document.querySelectorAll('#map path')].filter(p => p.getAttribute('stroke-dasharray') === '6 4').length);

test('UI: HP-MA 2027 usage round: rule in the audit, households inside the cells, cells on the Map and Field tabs (tablet A and offline tablet B)', { timeout: 300000 }, async () => {
  if (!pw) { console.log('  (PLAYWRIGHT_DIR needed) — skipped'); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'household-area-ui-')); const server = await serve(); const base = 'http://127.0.0.1:' + server.address().port + '/';
  const browser = await pw.chromium.launch();
  try {
    const ctxA = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block', acceptDownloads: true }); await ctxA.addInitScript(SYNTH); await ctxA.addInitScript(() => { window.SAMPLER_TEST.householdArea = { 'HP-MA': 'nearestPoint1km' }; }); // v2.13.1: rule not adopted, switched on for this test
    await ctxA.route(/(arcgisonline\.com|tile\.openstreetmap\.org)/, r => r.fulfill({ status: 404 }));
    const { page: a, errs: errsA } = await boot(ctxA, base);
    await a.click('#btn-sample'); await a.waitForTimeout(500); await a.click('nav button[data-tab="params"]');
    await a.selectOption('#p-mode', 'usage'); await a.fill('#p-round', '2027-DRYRUN'); await a.fill('#p-drawn-by', 'Dry run (fake frame)');
    await a.evaluate(() => { const s = document.getElementById('p-stratum'); s.value = 'HP-MA'; s.dispatchEvent(new Event('input')); s.dispatchEvent(new Event('change')); });
    await a.click('#btn-draw'); await a.waitForSelector('#usage-results:not(.hidden)');
    await a.click('nav button[data-tab="confirm"]'); const downloads = []; a.on('download', d => downloads.push(d));
    await a.click('#btn-confirm'); await a.waitForSelector('#btn-next-field:not(.hidden)', { timeout: 60000 }); await a.waitForTimeout(1500);
    const pdfDl = downloads.find(d => /-usage-record\.pdf$/.test(d.suggestedFilename())); assert.ok(pdfDl); const pdf = path.join(dir, pdfDl.suggestedFilename()); await pdfDl.saveAs(pdf);
    const opened = await C.openRecord({ pdf: new Uint8Array(fs.readFileSync(pdf)) }); const audit = opened.audit;
    assert.equal(audit.parameters.scenario, 'HP-MA'); assert.equal(audit.parameters.household_area.rule, 'nearestPoint1km'); assert.equal(C.hasCoordinateKeys(audit), false);
    assert.ok(audit.water_points.every(w => Array.isArray(w.cell_neighbours)));
    await a.click('nav button[data-tab="map"]'); await a.waitForTimeout(800);
    assert.equal(await mapCells(a), audit.water_points.length + audit.reserves.length, 'one dashed cell per drawn water point on the Map tab');
    await a.click('nav button[data-tab="field"]'); await a.click('#btn-prepare'); await a.waitForFunction(() => document.querySelector('#u-msg .msg.ok'), null, { timeout: 60000 }); await a.waitForTimeout(600);
    assert.equal(await cells(a), 1, 'the selected water point cell on the Field map');
    const roundA = await a.evaluate(`(${ROUND})()`);
    // every drawn household of every area is in its cell, computed again here from the frame positions
    const csv = fs.readFileSync(path.join(ROOT, 'data', 'sample-water-points.csv'), 'utf8').replace(/,FD,/g, ',HP-MA,'); const pts = C.normaliseWaterPoints(C.parseCsv(csv).records).points; const comp = C.competitorSet(pts).points;
    roundA.ids.forEach((id, i) => { const w = pts.find(p => p.water_point_id === id); const nb = C.cellNeighbours(w, comp); roundA.households[i].forEach(h => { const [la, lo] = h[2].split(',').map(Number); assert.ok(C.inCell({ lat: la, lon: lo }, w, nb), id + ' household ' + h[0]); }); });
    const [packDl] = await Promise.all([a.waitForEvent('download'), a.click('#btn-fpack')]); const pack = path.join(dir, packDl.suggestedFilename()); await packDl.saveAs(pack);
    assert.deepEqual(errsA, []);
    // tablet B, offline, no sources: the pack brings the neighbour positions, so the cell shows there too
    const ctxB = await browser.newContext({ viewport: { width: 800, height: 1280 }, serviceWorkers: 'block', isMobile: true, hasTouch: true }); await ctxB.addInitScript(NOSOURCE);
    const { page: b, errs: errsB } = await boot(ctxB, base); await ctxB.setOffline(true);
    await openFile(b, pdf); const o2 = await openFile(b, pack); assert.equal(o2.tab, 'field'); await b.waitForFunction(() => document.querySelector('#f-next .fbig'), null, { timeout: 10000 }); await b.waitForTimeout(600);
    assert.equal(await cells(b), 1, 'cell on tablet B'); const roundB = await b.evaluate(`(${ROUND})()`); assert.deepEqual(roundB.households, roundA.households);
    await b.click('nav button[data-tab="map"]'); await b.waitForTimeout(800); assert.equal(await mapCells(b), audit.water_points.length + audit.reserves.length);
    assert.deepEqual(errsB, []);
    await ctxA.close(); await ctxB.close();
  } finally { await browser.close(); server.close(); }
});
