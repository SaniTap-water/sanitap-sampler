// v2.9.0 dry run in the browser: tablet A draws a usage round on the fake sample frame, confirms it (evidence pack), prepares the
// households (synthetic footprints) and saves the field pack. Tablet B starts empty, goes offline, has no building or barrier source,
// opens the record PDF and then the pack, and must show the same water points and the same household numbers.
// PLAYWRIGHT_DIR=<dir with node_modules/playwright> node --test test/*.test.js   (the CDN scripts of index.html need the network at boot)
const test = require('node:test'); const assert = require('node:assert/strict'); const fs = require('fs'); const path = require('path'); const os = require('os'); const http = require('http');
const req = (env, mod) => { try { return require(path.join(process.env[env] || '/nonexistent', 'node_modules', mod)); } catch (e) { return null; } };
const pw = req('PLAYWRIGHT_DIR', 'playwright');
const ROOT = path.join(__dirname, '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.csv': 'text/csv', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
function serve() { return new Promise(res => { const s = http.createServer((q, r) => { let p = decodeURIComponent(new URL(q.url, 'http://x').pathname); if (p.endsWith('/')) p += 'index.html'; const f = path.join(ROOT, path.normalize(p)); if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(r); }); s.listen(0, '127.0.0.1', () => res(s)); }); }
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
async function openFile(page, f) { await page.setInputFiles('#open-file', f); await page.waitForFunction(() => { const m = document.getElementById('open-msg').textContent.trim(); return m && !/^(Opening|Ouverture)/.test(m); }, null, { timeout: 20000 }); return page.evaluate(() => ({ tab: document.querySelector('nav button.active').dataset.tab, sel: document.getElementById('round-sel').value, msg: document.getElementById('open-msg').textContent.trim() })); }

test('UI dry run: confirm a usage round on tablet A, re-open it on an offline tablet B from the PDF + field pack, identical water points and households', { timeout: 300000 }, async () => {
  if (!pw) { console.log('  (PLAYWRIGHT_DIR needed) — skipped'); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'field-pack-ui-')); const server = await serve(); const base = 'http://127.0.0.1:' + server.address().port + '/';
  const browser = await pw.chromium.launch();
  try {
    // tablet A
    const ctxA = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block', acceptDownloads: true }); await ctxA.addInitScript(SYNTH);
    const { page: a, errs: errsA } = await boot(ctxA, base);
    await a.click('#btn-sample'); await a.waitForTimeout(500); await a.click('nav button[data-tab="params"]');
    await a.selectOption('#p-mode', 'usage'); await a.fill('#p-round', '2026-DRYRUN'); await a.fill('#p-drawn-by', 'Dry run (fake frame)');
    await a.evaluate(() => { const s = document.getElementById('p-stratum'); s.value = 'FD'; s.dispatchEvent(new Event('input')); });
    await a.click('#btn-draw'); await a.waitForSelector('#usage-results:not(.hidden)');
    await a.click('nav button[data-tab="confirm"]');
    const downloads = []; a.on('download', d => downloads.push(d));
    await a.click('#btn-confirm'); await a.waitForSelector('#btn-next-field:not(.hidden)', { timeout: 60000 }); await a.waitForTimeout(1500);
    const pdfDl = downloads.find(d => /-usage-record\.pdf$/.test(d.suggestedFilename())); assert.ok(pdfDl, 'Confirm downloaded the record PDF: ' + downloads.map(d => d.suggestedFilename()));
    assert.deepEqual(downloads.map(d => d.suggestedFilename()).sort(), ['sanitap-2026-DRYRUN-FD-usage-record.pdf', 'sanitap-2026-DRYRUN-FD-usage-selection.csv', 'sanitap-2026-DRYRUN-FD-usage-selection.xlsx']);
    const pdf = path.join(dir, pdfDl.suggestedFilename()); await pdfDl.saveAs(pdf);
    await a.click('nav button[data-tab="field"]'); await a.click('#btn-prepare'); await a.waitForFunction(() => document.querySelector('#u-msg .msg.ok'), null, { timeout: 60000 });
    const roundA = await a.evaluate(`(${ROUND})()`);
    const [packDl] = await Promise.all([a.waitForEvent('download'), a.click('#btn-fpack')]); assert.equal(packDl.suggestedFilename(), 'sanitap-2026-DRYRUN-FD-field-pack.json');
    const pack = path.join(dir, packDl.suggestedFilename()); await packDl.saveAs(pack);
    assert.deepEqual(errsA, []);
    // tablet B: empty, offline, no building source
    const ctxB = await browser.newContext({ viewport: { width: 800, height: 1280 }, serviceWorkers: 'block', isMobile: true, hasTouch: true }); await ctxB.addInitScript(NOSOURCE);
    const { page: b, errs: errsB } = await boot(ctxB, base); await ctxB.setOffline(true);
    const early = await openFile(b, pack); assert.equal(early.sel, '', 'a pack before its record is refused'); assert.match(early.msg, /Open the sampling record PDF of .* first/);
    const o1 = await openFile(b, pdf); assert.equal(o1.tab, 'field'); assert.match(o1.sel, /^2026-DRYRUN-FD/);
    const before = await b.evaluate(`(${ROUND})()`); assert.equal(before.round, null, 'no households on tablet B before the pack');
    const o2 = await openFile(b, pack); assert.equal(o2.tab, 'field'); assert.match(o2.msg, /^Field pack loaded for /, o2.msg);
    await b.waitForFunction(() => document.querySelector('#f-next .fbig'), null, { timeout: 10000 });
    const roundB = await b.evaluate(`(${ROUND})()`);
    assert.equal(roundB.rid, roundA.rid); assert.deepEqual(roundB.ids, roundA.ids, 'same water points'); assert.deepEqual(roundB.pos, roundA.pos, 'same positions');
    assert.deepEqual(roundB.households, roundA.households, 'same household numbers'); assert.equal(roundB.next, '1');
    assert.deepEqual(errsB, []);
    console.log(`  dry run: ${roundA.rid}, ${roundA.ids.length} water points (${roundA.ids.join(' ')}), ${roundA.households.length * 15} household slots, identical on tablet B`);
    fs.writeFileSync(path.join(dir, 'dry-run.json'), JSON.stringify({ A: roundA, B: roundB }, null, 1)); console.log('  dry-run files: ' + dir);
    await ctxA.close(); await ctxB.close();
  } finally { await browser.close(); server.close(); }
});
