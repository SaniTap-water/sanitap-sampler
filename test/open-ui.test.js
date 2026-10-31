// v2.8.2: the page after "Open a confirmed round" (field report 30 Oct 2026: "isn't giving me anything"). Serves this checkout on
// localhost and drives it with Playwright: success -> round selected, field tab shown, message on screen; refusal -> top of the Data
// tab; an older tab holding the database -> the open still finishes (localStorage) instead of staying on "…".
// PLAYWRIGHT_DIR=<dir with node_modules/playwright> PDFLIB_DIR=<dir with node_modules/pdf-lib> [UI_BROWSERS=chromium,webkit] node --test test/*.test.js
// The CDN scripts of index.html need the network. Field PDFs come from the SharePoint evidence folder, never from the repo.
const test = require('node:test'); const assert = require('node:assert/strict'); const fs = require('fs'); const path = require('path'); const os = require('os'); const http = require('http');
const C = require('../app.js'); const { EVIDENCE, REC } = require('./evidence.js');
const req = (env, mod) => { try { return require(path.join(process.env[env] || '/nonexistent', 'node_modules', mod)); } catch (e) { return null; } };
const pw = req('PLAYWRIGHT_DIR', 'playwright'); const PDFLib = req('PDFLIB_DIR', 'pdf-lib');
const ROOT = path.join(__dirname, '..'); const BROWSERS = (process.env.UI_BROWSERS || 'chromium').split(',');
const FIELD_DIR = process.env.FIELD_PDF_DIR || (EVIDENCE ? path.join(EVIDENCE, '..', '2026', 'Random sample') : null);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.csv': 'text/csv', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
function serve() { return new Promise(res => { const s = http.createServer((q, r) => { let p = decodeURIComponent(new URL(q.url, 'http://x').pathname); if (p.endsWith('/')) p += 'index.html'; const f = path.join(ROOT, path.normalize(p)); if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); fs.createReadStream(f).pipe(r); }); s.listen(0, '127.0.0.1', () => res(s)); }); }
// a usage record made here (so the test never depends on the evidence folder) and a copy whose Info SHA-256 was changed
async function madeRecords(dir) {
  const pts = []; ['A', 'B', 'C', 'D', 'E', 'F'].forEach((c, ci) => { for (let f = 0; f < 4; f++) for (let i = 0; i < 2; i++) pts.push({ water_point_id: c + f + '-' + i, name: 'Canzee', stratum: 'HP-FD', commune: 'Commune ' + c, fokontany: 'Fkt ' + c + f, lat: -25 + ci * 0.01, lon: 46.9 + i * 0.01, households_served: 0, active: true }); });
  const r = C.drawUsage({ roundName: 'UI TEST', stratum: 'HP-FD', seed: 'UITEST-HP-FD-U', timestamp: '2026-10-31T00:00:00.000Z', drawnBy: 'Test', frameHash: 'ab'.repeat(32) }, pts);
  const a = JSON.parse(JSON.stringify(r.audit)); a.households = null; const pack = await C.evidencePack({ PDFLib, auditText: JSON.stringify(a, null, 2), lang: 'en' });
  const good = path.join(dir, 'made-usage-record.pdf'); fs.writeFileSync(good, Buffer.from(pack.pdf));
  const t = Buffer.from(pack.pdf).toString('latin1'); const i = t.indexOf('/AuditSHA256 (') + 14; const flip = t[i] === '0' ? '1' : '0';
  const bad = path.join(dir, 'changed-usage-record.pdf'); fs.writeFileSync(bad, Buffer.from(t.slice(0, i) + flip + t.slice(i + 1), 'latin1'));
  return { good, bad, rid: a.record_id };
}
async function boot(ctx, base) {
  const page = await ctx.newPage(); const errs = []; page.on('pageerror', e => errs.push(e.message)); page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
  await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 90000 }); await page.waitForFunction(() => /^v\d/.test((document.getElementById('ver') || {}).textContent || ''), null, { timeout: 90000 });
  return { page, errs };
}
async function openFile(page, f) {
  await page.setInputFiles('#open-file', f);
  await page.waitForFunction(() => { const m = document.getElementById('open-msg').textContent.trim(); return m && !/^(Opening|Ouverture)/.test(m); }, null, { timeout: 15000 });
  return page.evaluate(() => { const vis = id => { const el = document.querySelector('#' + id + ' .msg'); if (!el) return null; const r = el.getBoundingClientRect(); return { text: el.textContent, onScreen: r.height > 0 && r.top >= 0 && r.bottom <= innerHeight + 1, cls: el.className }; };
    return { tab: document.querySelector('nav button.active').dataset.tab, sel: document.getElementById('round-sel').value, flash: vis('flash'), dataFlash: vis('data-flash'), openMsg: document.getElementById('open-msg').textContent.trim() }; });
}

for (const bn of BROWSERS) {
  test('UI ' + bn + ': opening a record selects the round, shows its field tab and keeps the message on screen; refusals at the top of Data', { timeout: 300000 }, async () => {
    if (!pw || !PDFLib) { console.log('  (PLAYWRIGHT_DIR and PDFLIB_DIR needed) — skipped'); return; }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-ui-')); const made = await madeRecords(dir);
    const server = await serve(); const base = 'http://127.0.0.1:' + server.address().port + '/';
    const browser = await pw[bn].launch();
    try {
      const cases = [{ f: made.good, rid: made.rid, tab: 'field' }];
      if (FIELD_DIR && fs.existsSync(path.join(FIELD_DIR, 'sanitap-2026_R1_FTU-HP-FD-usage-record.pdf'))) cases.push({ f: path.join(FIELD_DIR, 'sanitap-2026_R1_FTU-HP-FD-usage-record.pdf'), rid: '2026_R1_FTU-HP-FD-2026_R1_FTU-HP-FD-U', tab: 'field' }, { f: path.join(FIELD_DIR, 'sanitap-2026_R1_Maro-HP-MA-usage-record.pdf'), rid: '2026_R1_Maro-HP-MA-2026_R1_Maro-HP-MA-U', tab: 'field' });
      else if (EVIDENCE) assert.fail('field PDFs not found in ' + FIELD_DIR);
      if (EVIDENCE) cases.push({ f: path.join(REC('HP-FD'), 'sampling-record.pdf'), rid: '2026R1-HP-FD', tab: 'sheet' }, { f: path.join(REC('HP-MA'), 'reissue-2026-10-30-v2.8.0', 'sampling-record.pdf'), rid: '2026R1-HP-MA', tab: 'sheet' });
      for (const viewport of [{ width: 390, height: 844 }, { width: 1366, height: 768 }]) for (const c of cases) {
        const ctx = await browser.newContext({ viewport }); const { page, errs } = await boot(ctx, base);
        const s = await openFile(page, c.f); const tag = bn + ' ' + viewport.width + ' ' + path.basename(c.f);
        assert.equal(s.tab, c.tab, tag); assert.equal(s.sel, c.rid, tag);
        assert.ok(s.flash && s.flash.onScreen && /msg ok/.test(s.flash.cls), tag + ' ' + JSON.stringify(s.flash));
        assert.match(s.flash.text, new RegExp('^×?Opened ' + c.rid.replace(/[-]/g, '\\-')), tag);
        assert.ok(!/open_|mode_/.test(s.flash.text + s.openMsg), tag + ' raw key in ' + s.flash.text);
        assert.equal(s.dataFlash, null, tag); assert.deepEqual(errs, [], tag);
        await ctx.close();
      }
      // a changed file: refused, on the Data tab, the refusal at its top and on screen; nothing selected
      { const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } }); const { page } = await boot(ctx, base);
        const s = await openFile(page, made.bad); assert.equal(s.tab, 'data'); assert.equal(s.sel, '');
        assert.ok(s.dataFlash && s.dataFlash.onScreen && /msg err/.test(s.dataFlash.cls), JSON.stringify(s.dataFlash)); assert.match(s.dataFlash.text, /Refused: the audit SHA-256 is/); assert.equal(s.flash, null); await ctx.close(); }
      // a tab of v2.3-v2.6 (database version 1) still open: the open finishes, kept in localStorage, with a note to close the other tabs
      { const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } }); const old = await ctx.newPage(); await old.goto(base + 'old-tab-placeholder');
        await old.evaluate(() => { return new Promise(r => { const q = indexedDB.open('sanitap-sampler', 1); q.onupgradeneeded = () => q.result.createObjectStore('rounds'); q.onsuccess = () => { window.keep = q.result; r(); }; }); });
        const { page } = await boot(ctx, base); const t0 = Date.now(); const s = await openFile(page, made.good);
        assert.ok(Date.now() - t0 < 15000); assert.equal(s.tab, 'field'); assert.equal(s.sel, made.rid); assert.match(s.flash.text, /another SaniTap Sampler tab is open/); await ctx.close(); }
    } finally { await browser.close(); server.closeAllConnections(); server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  });
}
