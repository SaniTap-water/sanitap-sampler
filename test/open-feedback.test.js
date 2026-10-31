// v2.8.2: "Open a confirmed round isn't giving me anything" (field report, 30 Oct 2026). The open itself worked; the page gave no
// visible sign of it (message below the screen, no tab change, a raw "open_reg_no" key in the text), and a tab of an older version
// holding the database left the open stuck on "…". These tests cover the pure parts; test/open-ui.test.js drives the page.
// node --test test/*.test.js   (PDFLIB_DIR for the PDF builds; the field PDFs are read from the SharePoint evidence folder, never the repo)
const test = require('node:test'); const assert = require('node:assert/strict'); const fs = require('fs'); const path = require('path'); const zlib = require('zlib');
const C = require('../app.js'); const { EVIDENCE, REC, skipNoEvidence } = require('./evidence.js');
let PDFLib; try { PDFLib = require(path.join(process.env.PDFLIB_DIR || '/nonexistent', 'node_modules', 'pdf-lib')); } catch (e) { PDFLib = null; }
const skip = () => { console.log('  (pdf-lib not available: set PDFLIB_DIR) — skipped'); };
// the two usage records James Walker drew and confirmed with v2.7.0 on 30 Oct 2026 (filed by him in Evidence/2026/Random sample)
const FIELD_DIR = process.env.FIELD_PDF_DIR || (EVIDENCE ? path.join(EVIDENCE, '..', '2026', 'Random sample') : null);
const FIELD = [
  { file: 'sanitap-2026_R1_FTU-HP-FD-usage-record.pdf', rid: '2026_R1_FTU-HP-FD-2026_R1_FTU-HP-FD-U', sha: '9991cb6a62aa5db9723e7cdff1270d45247d24e1c791c3fec47dbcc69c52fccc' },
  { file: 'sanitap-2026_R1_Maro-HP-MA-usage-record.pdf', rid: '2026_R1_Maro-HP-MA-2026_R1_Maro-HP-MA-U', sha: 'c6b8141f7efffcc60cc91d304bcd7a76e1c8814319f2da52481a083a88974699' }
];
// the message the page shows for an open, in a language (the same steps as the UI handler)
function render(plan, lang) { const vars = Object.assign({}, plan.vars); Object.keys(plan.tkeys).forEach(k => { vars[k] = C.translate(C.I18N, lang, plan.tkeys[k]); }); return C.translate(C.I18N, lang, plan.key, vars); }

test('translate: an empty translation is used as is (no raw key), missing French falls back to English, unknown keys show the key', () => {
  const D = { en: { a: 'A {x}', empty: '', only_en: 'E' }, fr: { a: 'Fa {x}', empty: '' } };
  assert.equal(C.translate(D, 'fr', 'empty'), ''); assert.equal(C.translate(D, 'en', 'empty'), '');
  assert.equal(C.translate(D, 'fr', 'only_en'), 'E'); assert.equal(C.translate(D, 'fr', 'nope'), 'nope');
  assert.equal(C.translate(D, 'fr', 'a', { x: 1 }), 'Fa 1');
  // the real strings: every key the open path can use exists in both languages
  ['open_ok', 'open_reg_yes', 'open_reg_no', 'open_same', 'open_new', 'open_opening', 'open_local', 'flash_close', 'open_reserves', 'open_replacements', 'mode_usage', 'mode_pou', 'open_err_other',
    'open_err_not_pdf', 'open_err_no_input', 'open_err_no_audit', 'open_err_not_json', 'open_err_not_record', 'open_err_sha_mismatch', 'open_err_rid_mismatch', 'open_err_coords', 'open_err_no_reference']
    .forEach(k => ['en', 'fr'].forEach(l => assert.ok(Object.prototype.hasOwnProperty.call(C.I18N[l], k), l + ' lacks ' + k)));
});

test('openOutcome: success goes to the field tab of the survey with the round selected; errors stay on the Data tab', () => {
  const audit = mode => ({ record_id: 'R-1', mode: mode === 'usage' ? C.USAGE.mode : undefined, water_points: new Array(12).fill({}), reserves: [{}, {}, {}], replacements: [{}, {}, {}] });
  const u = C.openOutcome({ ok: true, mode: 'usage', audit: audit('usage'), sha: 'ab', registered: false }, { ok: true });
  assert.deepEqual([u.ok, u.tab, u.select, u.cls, u.warn], [true, 'field', 'R-1', 'ok', null]);
  const p = C.openOutcome({ ok: true, mode: 'pou', audit: audit('pou'), sha: 'ab' }, { ok: true, same: true, local: true });
  assert.deepEqual([p.tab, p.tkeys.same, p.warn], ['sheet', 'open_same', 'open_local']);
  for (const lang of ['en', 'fr']) for (const plan of [u, p]) { const s = render(plan, lang); assert.ok(!/open_|mode_/.test(s), s); assert.ok(s.includes('R-1') && s.includes('ab')); }
  assert.ok(render(u, 'en').endsWith('verified.'), render(u, 'en'));
  const e = C.openOutcome({ error: 'sha_mismatch', sha: 'cd', expected: 'ef' }, null);
  assert.deepEqual([e.ok, e.tab, e.cls], [false, 'data', 'err']); assert.match(render(e, 'en'), /^Refused: the audit SHA-256 is cd but the record says ef/);
  const o = C.openOutcome({ ok: true, mode: 'usage', audit: audit('usage'), sha: 'ab' }, { error: 'confirmed_other' });
  assert.deepEqual([o.ok, o.tab, o.key], [false, 'data', 'open_err_other']);
});

// a fake IndexedDB: each scenario fires the events a real browser would
function fakeIdb(scenario) {
  const made = []; const db = { objectStoreNames: { contains: n => ['confirmed'].includes(n) }, createObjectStore: n => made.push(n), closed: 0, close() { this.closed++; } };
  return { db, made, open(name, version) { const r = { result: db }; setTimeout(() => {
    if (scenario === 'ok') { r.onupgradeneeded(); r.onsuccess(); }
    else if (scenario === 'blocked') { r.onblocked(); setTimeout(() => r.onsuccess(), 30); } // the old tab closes later
    else if (scenario === 'error') { r.error = new Error('quota'); r.onerror(); }
    /* 'hang': no event at all */ }, 5); return r; } };
}
test('idbOpen: opens and adds the missing stores; a blocked upgrade or no answer fails fast instead of hanging', async () => {
  const ok = fakeIdb('ok'); const d = await C.idbOpen(ok, 'sanitap-sampler', 2, ['confirmed', 'rounds', 'outcomes'], 500);
  assert.equal(d, ok.db); assert.deepEqual(ok.made, ['rounds', 'outcomes']); d.onversionchange(); assert.equal(ok.db.closed, 1, 'a newer version asking for the database closes this connection');
  const bl = fakeIdb('blocked'); await assert.rejects(C.idbOpen(bl, 'x', 2, [], 2000), e => e.code === 'idb_blocked');
  await new Promise(r => setTimeout(r, 60)); assert.equal(bl.db.closed, 1, 'a late success after giving up is closed, not leaked');
  const t0 = Date.now(); await assert.rejects(C.idbOpen(fakeIdb('hang'), 'x', 2, [], 150), e => e.code === 'idb_blocked'); assert.ok(Date.now() - t0 < 1000);
  await assert.rejects(C.idbOpen(fakeIdb('error'), 'x', 2, [], 500), /quota/);
  await assert.rejects(C.idbOpen(null, 'x', 2, [], 500), e => e.code === 'idb_none');
});

for (const F of FIELD) {
  test('field report 30 Oct: ' + F.file + ' (v2.7.0) opens in both inflate paths, Info entries readable, message clean, goes to 6 Field', async () => {
    if (!FIELD_DIR || !fs.existsSync(path.join(FIELD_DIR, F.file))) { if (!EVIDENCE) return skipNoEvidence(); assert.fail('field PDF not found in ' + FIELD_DIR); }
    const buf = fs.readFileSync(path.join(FIELD_DIR, F.file)); const txt = C.bytesLatin1(buf);
    assert.equal(txt.includes('/Type /ObjStm'), false, 'no object streams'); assert.equal(C.pdfInfoValue(txt, 'RecordId'), F.rid); assert.equal(C.pdfInfoValue(txt, 'AuditSHA256'), F.sha);
    const o = await C.openRecord({ pdf: new Uint8Array(buf) }); assert.equal(o.ok, true, o.error); // browser path (DecompressionStream)
    const z = await C.openRecord({ pdf: buf, inflateSync: zlib.inflateSync }); assert.equal(z.sha, o.sha); // bin/file-round.js path
    assert.deepEqual([o.mode, o.sha, o.audit.record_id, o.audit.version, o.audit.commit], ['usage', F.sha, F.rid, '2.7.0', 'f3f391a']);
    assert.deepEqual([o.audit.water_points.length, o.audit.reserves.length], [12, 3]); assert.equal(C.hasCoordinateKeys(o.audit), false);
    const plan = C.openOutcome(o, { ok: true }); assert.equal(plan.tab, 'field');
    for (const lang of ['en', 'fr']) assert.ok(!/open_|mode_/.test(render(plan, lang)), render(plan, lang));
    const v = C.roundFromAudit(o.audit); assert.equal(C.roundIds(v).length, 15);
  });
}

test('filed 2026R1 records and their v2.8.0 reissues: Info entries outside object streams, open plan goes to 6 Field sheet', async () => {
  if (!EVIDENCE) return skipNoEvidence();
  for (const s of ['HP-FD', 'HP-MA']) for (const sub of ['', 'reissue-2026-10-30-v2.8.0']) {
    const buf = fs.readFileSync(path.join(REC(s), sub, 'sampling-record.pdf')); const txt = C.bytesLatin1(buf);
    assert.equal(txt.includes('/Type /ObjStm'), false); assert.equal(C.pdfInfoValue(txt, 'RecordId'), '2026R1-' + s);
    const o = await C.openRecord({ pdf: new Uint8Array(buf) }); assert.equal(o.ok, true, s + sub + ' ' + o.error);
    assert.equal(C.openOutcome(o, { ok: true }).tab, 'sheet');
  }
});

test('record PDFs keep /RecordId and /AuditSHA256 in a plain Info dictionary (no object streams), both surveys', async () => {
  if (!PDFLib) return skip();
  const pts = []; ['A', 'B', 'C', 'D', 'E', 'F'].forEach((c, ci) => { for (let f = 0; f < 4; f++) for (let i = 0; i < 2; i++) pts.push({ water_point_id: c + f + '-' + i, name: 'Canzee', stratum: 'HP-FD', commune: 'Commune ' + c, fokontany: 'Fkt ' + c + f, lat: -25 + ci * 0.01, lon: 46.9 + i * 0.01, households_served: 0, active: true }); });
  const r = C.drawUsage({ roundName: '2026-DRY', stratum: 'HP-FD', seed: '2026-DRY-HP-FD-U', timestamp: '2026-09-30T00:00:00.000Z', drawnBy: 'Test', frameHash: 'ab'.repeat(32) }, pts);
  const a = JSON.parse(JSON.stringify(r.audit)); a.households = null; const text = JSON.stringify(a, null, 2);
  const pack = await C.evidencePack({ PDFLib, auditText: text, lang: 'en' }); const txt = C.bytesLatin1(Buffer.from(pack.pdf));
  assert.equal(txt.includes('/Type /ObjStm'), false); assert.equal(C.pdfInfoValue(txt, 'AuditSHA256'), pack.sha); assert.equal(C.pdfInfoValue(txt, 'RecordId'), a.record_id);
  if (EVIDENCE) { const pou = fs.readFileSync(path.join(REC('HP-FD'), 'audit.json'), 'utf8'); const pp = await C.evidencePack({ PDFLib, auditText: pou, lang: 'fr' }); const t2 = C.bytesLatin1(Buffer.from(pp.pdf)); assert.equal(t2.includes('/Type /ObjStm'), false); assert.equal(C.pdfInfoValue(t2, 'AuditSHA256'), pp.sha); }
});
