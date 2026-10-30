// v2.7.0: the sampling stage ends at Confirm; the field stage opens from the confirmed record (PDF or audit.json), verified by its audit SHA-256.
// node --test test/*.test.js   (PDFLIB_DIR for the tests that build PDFs)
const test = require('node:test'); const assert = require('node:assert/strict'); const fs = require('fs'); const path = require('path'); const os = require('os'); const zlib = require('zlib');
const { spawnSync } = require('child_process');
const C = require('../app.js'); const K = require('../bin/sdws18-cases.js');
let PDFLib; try { PDFLib = require(path.join(process.env.PDFLIB_DIR || '/nonexistent', 'node_modules', 'pdf-lib')); } catch (e) { PDFLib = null; }
const skip = () => { console.log('  (pdf-lib not available: set PDFLIB_DIR) — skipped'); };
const ROOT = path.join(__dirname, '..'); const { EVIDENCE, REC, skipNoEvidence } = require('./evidence.js');
// a SharePoint-like folder for the filing scripts (SAMPLER_CONFIG): never inside the repo, never under git
function tempEvidence() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-')); const cfg = path.join(d, 'sampler.local.json'); fs.mkdirSync(path.join(d, 'Sampling records')); fs.writeFileSync(cfg, JSON.stringify({ records_dir: path.join(d, 'Sampling records') })); return { root: d, dir: path.join(d, 'Sampling records'), env: Object.assign({}, process.env, { SAMPLER_CONFIG: cfg }) }; }
const csvRows = text => text.trim().split(/\r?\n/).slice(1).map(l => l.split(','));

// the filed 2026R1 records: opened from the PDF alone, the round reproduces exactly what was filed
for (const s of ['HP-FD', 'HP-MA']) {
  test('open the filed 2026R1 ' + s + ' record from its PDF: same audit, 12 sources, R1-R3, household numbers as in selection.csv', async () => {
    if (!EVIDENCE) return skipNoEvidence();
    const pdf = fs.readFileSync(path.join(REC(s), 'sampling-record.pdf'));
    const o = await C.openRecord({ pdf: new Uint8Array(pdf) }); // the browser path (DecompressionStream)
    assert.equal(o.ok, true, o.error); assert.equal(o.mode, 'pou');
    assert.equal(o.auditText, fs.readFileSync(path.join(REC(s), 'audit.json'), 'utf8'), 'the attached audit is the filed audit.json, byte for byte');
    const viaZlib = await C.openRecord({ pdf, inflateSync: zlib.inflateSync }); assert.equal(viaZlib.sha, o.sha, 'bin/file-round.js reads the same audit');
    const filed = fs.readFileSync(path.join(REC(s), 'selection.csv'), 'utf8');
    assert.equal(C.recordCsv(o.audit), filed, 'selection CSV rebuilt from the opened record is byte-identical');
    const v = C.roundFromAudit(o.audit);
    assert.equal(v.selected.length, 12); assert.deepEqual(v.replacements.map(w => 'R' + w.order), ['R1', 'R2', 'R3']);
    // every source, in order, with the household numbers of selection.csv (primary then replacement numbers)
    const rows = csvRows(filed); const fromCsv = {}; rows.forEach(r => { const k = r[4] + '|' + r[3]; (fromCsv[k] = fromCsv[k] || []).push(r[5]); });
    const fromRound = {}; v.selected.map(w => [String(w.order), w]).concat(v.replacements.map(w => ['R' + w.order, w])).forEach(([o2, w]) => { fromRound[o2 + '|' + w.water_point_id] = w.numbers.concat(w.reserve_numbers).map(n => 'HH#' + n); assert.equal(w.K_recorded, true); });
    assert.deepEqual(fromRound, fromCsv);
    assert.ok(!C.hasCoordinateKeys(o.audit));
  });
}

test('the record PDF rebuilt from an opened filed record is byte-identical to the filed PDF (fr); the v2.8.0 pack adds the map and still opens', async () => {
  if (!PDFLib) return skip(); if (!EVIDENCE) return skipNoEvidence();
  for (const s of ['HP-FD', 'HP-MA']) {
    const pdf = fs.readFileSync(path.join(REC(s), 'sampling-record.pdf')); const o = await C.openRecord({ pdf: new Uint8Array(pdf) });
    const kv = {}; o.audit.field_rule_numbers.forEach(x => { kv[x.water_point_id] = x.K; });
    const same = await C.buildSamplingRecordPdf({ PDFLib, audit: o.audit, auditText: o.auditText, auditSha: o.sha, lang: 'fr', url: C.APP_URL, kValues: kv });
    assert.ok(Buffer.from(same).equals(pdf), s + ' PDF differs (without the map pages the template is unchanged)');
    const pack = await C.evidencePack({ PDFLib, auditText: o.auditText, lang: 'fr', kValues: kv });
    const re = await C.openRecord({ pdf: new Uint8Array(pack.pdf) }); assert.equal(re.ok, true); assert.equal(re.auditText, o.auditText); assert.equal(pack.sha, o.sha); assert.equal(pack.csv, fs.readFileSync(path.join(REC(s), 'selection.csv'), 'utf8'));
    assert.deepEqual(pack.names, { pdf: 'sanitap-2026R1-' + s + '-record.pdf', xlsx: 'sanitap-2026R1-' + s + '-selection.xlsx', csv: 'sanitap-2026R1-' + s + '-selection.csv' });
  }
});

test('a changed record is refused: footer hash, record id, edited audit.json, unverifiable audit.json, not a record', async () => {
  if (!EVIDENCE) return skipNoEvidence();
  const pdf = fs.readFileSync(path.join(REC('HP-FD'), 'sampling-record.pdf')); const text = fs.readFileSync(path.join(REC('HP-FD'), 'audit.json'), 'utf8');
  const sha = C.sha256Sync(text); const t = pdf.toString('latin1');
  // the PDF's own audit hash replaced (same length): the attached audit no longer matches it
  const badSha = Buffer.from(t.replace('/AuditSHA256 (' + sha + ')', '/AuditSHA256 (' + '0'.repeat(64) + ')'), 'latin1'); assert.notEqual(badSha.toString('latin1'), t);
  const r1 = await C.openRecord({ pdf: new Uint8Array(badSha) }); assert.equal(r1.error, 'sha_mismatch'); assert.equal(r1.sha, sha);
  const badRid = Buffer.from(t.replace('/RecordId (2026R1-HP-FD)', '/RecordId (2026R1-HP-FX)'), 'latin1');
  assert.equal((await C.openRecord({ pdf: new Uint8Array(badRid) })).error, 'rid_mismatch');
  // audit.json: accepted with the footer hash or when the published register lists it; refused when edited or when nothing vouches for it
  assert.equal((await C.openRecord({ json: text, expectedSha: sha })).ok, true);
  assert.equal((await C.openRecord({ json: text, registerShas: C.registerShas(fs.readFileSync(path.join(EVIDENCE, 'index.md'), 'utf8')) })).ok, true, 'the filed record is in the register (index.md in SharePoint)');
  const edited = text.replace('"742895168"', '"742895169"'); assert.notEqual(edited, text);
  assert.equal((await C.openRecord({ json: edited, expectedSha: sha })).error, 'sha_mismatch');
  assert.equal((await C.openRecord({ json: text.replace(/\n/g, '\r\n'), expectedSha: sha })).error, 'sha_mismatch', 'even a line-ending change is refused');
  assert.equal((await C.openRecord({ json: text })).error, 'no_reference');
  assert.equal((await C.openRecord({ json: '{"a":1}', expectedSha: sha })).error, 'not_record');
  assert.equal((await C.openRecord({ json: 'not json' })).error, 'not_json');
  assert.equal((await C.openRecord({ pdf: new Uint8Array(Buffer.from('%PDF-1.7\n%%EOF')) })).error, 'no_audit');
  assert.equal((await C.openRecord({ pdf: new Uint8Array(Buffer.from('hello')) })).error, 'not_pdf');
});

test('confirm and lock: a record id is confirmed once; the same record again is a no-op; a redraw under it is refused', () => {
  const frame = K.frames(C).sample; const P = x => Object.assign({}, K.BASE, { roundName: '2026 R1', stratum: 'FD', seed: '2026R1-FD', source: 'csv' }, x || {});
  const a = C.draw(P(), frame); const text = C.auditJson(a); const sha = C.sha256Sync(text); const lib = {};
  const e = C.libraryEntry({ audit: JSON.parse(text), auditText: text, sha, at: '2026-10-30T10:00:00Z', origin: 'here' });
  assert.equal(e.record_id, '2026R1-FD'); assert.equal(e.mode, 'pou'); assert.equal(e.frame_sha256, null);
  assert.equal(C.libraryCanDraw(lib, '2026R1-FD'), true);
  assert.equal(C.libraryAdd(lib, e).ok, true); assert.equal(C.libraryCanDraw(lib, '2026R1-FD'), false, 'no redraw under a confirmed record id');
  assert.equal(C.libraryAdd(lib, Object.assign({}, e)).same, true);
  // a later draw of the same round (another time, so another audit) cannot replace it; a new round name can be drawn and confirmed
  const b = C.draw(P({ timestamp: '2026-10-30T11:00:00.000Z' }), frame); const tb = C.auditJson(b);
  const rb = C.libraryAdd(lib, C.libraryEntry({ audit: JSON.parse(tb), auditText: tb, sha: C.sha256Sync(tb), at: 'x' })); assert.equal(rb.error, 'confirmed_other'); assert.equal(lib['2026R1-FD'].audit_sha256, sha);
  const c = C.draw(P({ roundName: '2026 R1b', seed: '2026R1b-FD' }), frame); assert.equal(c.audit.record_id, '2026R1b-FD'); assert.equal(C.libraryCanDraw(lib, '2026R1b-FD'), true);
  // confirming adds nothing to the audit: the record and its hash are those of the draw
  assert.equal(C.auditJson(a), text);
});

test('both strata (and both surveys) are held side by side; adding one never changes another', async () => {
  if (!EVIDENCE) return skipNoEvidence();
  const lib = {};
  for (const s of ['HP-FD', 'HP-MA']) { const text = fs.readFileSync(path.join(REC(s), 'audit.json'), 'utf8'); C.libraryAdd(lib, C.libraryEntry({ audit: JSON.parse(text), auditText: text, sha: C.sha256Sync(text), at: s, origin: 'opened' })); }
  const before = JSON.stringify(lib['2026R1-HP-FD']);
  const u = C.drawUsage(UP, uframe()); const ut = JSON.stringify(u.audit, null, 2);
  assert.equal(C.libraryAdd(lib, C.libraryEntry({ audit: u.audit, auditText: ut, sha: C.sha256Sync(ut), at: 'u' })).ok, true);
  assert.deepEqual(Object.keys(lib).sort(), ['2026-DRY-HP-FD-2026-DRY-HP-FD-U', '2026R1-HP-FD', '2026R1-HP-MA']);
  assert.equal(JSON.stringify(lib['2026R1-HP-FD']), before);
  const fd = C.roundFromAudit(JSON.parse(lib['2026R1-HP-FD'].audit_text)), ma = C.roundFromAudit(JSON.parse(lib['2026R1-HP-MA'].audit_text));
  assert.equal(fd.params.stratum, 'HP-FD'); assert.equal(ma.params.stratum, 'HP-MA'); assert.equal(lib['2026-DRY-HP-FD-2026-DRY-HP-FD-U'].mode, 'usage');
  assert.equal(new Set(C.roundIds(fd).concat(C.roundIds(ma))).size, 30, 'two rounds of 15 sources each, none shared');
});

// usage survey: synthetic frame and buildings (as test/usage.test.js)
function uframe() {
  const pts = []; const spec = { A: [5, 3, 2, 4, 1], B: [2, 2, 2, 2], C: [6, 1, 1, 1, 1, 2], D: [1, 1, 1, 1], E: [3, 3, 3, 3, 3], F: [4, 4] };
  Object.keys(spec).forEach(c => spec[c].forEach((n, fi) => { for (let i = 0; i < n; i++) pts.push({ water_point_id: c + fi + '-' + i, name: 'Canzee', stratum: 'HP-FD', commune: 'Commune ' + c, fokontany: 'Fkt ' + c + fi, lat: -25 + fi * 0.01, lon: 46.9 + i * 0.01, households_served: 0, active: true }); }));
  return pts;
}
const UP = { roundName: '2026-DRY', stratum: 'HP-FD', seed: '2026-DRY-HP-FD-U', timestamp: '2026-09-30T00:00:00.000Z', drawnBy: 'Test', frameHash: 'ab'.repeat(32) };
function houses(wp) { const kx = 111320 * Math.cos(wp.lat * Math.PI / 180), ky = 110574; const out = []; for (let x = -600; x <= 600; x += 50) for (let y = -600; y <= 600; y += 50) { const sq = [[x - 4, y - 4], [x + 4, y - 4], [x + 4, y + 4], [x - 4, y + 4], [x - 4, y - 4]].map(([a, b]) => [wp.lon + a / kx, wp.lat + b / ky]); out.push({ geometry: { type: 'Polygon', coordinates: [sq] }, properties: { bf_source: 'google' } }); } return out; }

test('usage draw: confirmed, opened from its PDF, reproduces the water points, reserves and household draw; file-round accepts it (-U)', async () => {
  if (!PDFLib) return skip();
  const r = C.drawUsage(UP, uframe()); const a = JSON.parse(JSON.stringify(r.audit)); a.households = null; const text = JSON.stringify(a, null, 2);
  const pack = await C.evidencePack({ PDFLib, auditText: text, lang: 'en' });
  assert.deepEqual(pack.names, { pdf: 'sanitap-2026-DRY-HP-FD-usage-record.pdf', xlsx: 'sanitap-2026-DRY-HP-FD-usage-selection.xlsx', csv: 'sanitap-2026-DRY-HP-FD-usage-selection.csv' });
  assert.deepEqual(pack.sheets.map(s => s.rows.length), [1 + r.points.length, 1 + r.reserves.length, 16]);
  const o = await C.openRecord({ pdf: new Uint8Array(pack.pdf) }); assert.equal(o.ok, true, o.error); assert.equal(o.mode, 'usage'); assert.equal(o.auditText, text); assert.equal(o.sha, pack.sha);
  const v = C.roundFromAudit(o.audit);
  const key = w => [w.order, w.water_point_id, w.zone, w.commune, w.fokontany, w.pi, w.weight, w.p_conditional].join('|');
  assert.deepEqual(v.points.map(key), r.points.map(key)); assert.deepEqual(v.reserves.map(key), r.reserves.map(key)); assert.equal(v.reserves.every(w => w.reserve), true);
  // positions come from the device (here the frame), never from the record; the household draw then equals the one from the original draw
  C.withPositions(v, C.positionsFromPoints(uframe(), C.roundIds(v)));
  r.points.concat(r.reserves).forEach((w, i) => { const x = v.points.concat(v.reserves)[i]; assert.equal(x.lat, w.lat); assert.equal(x.lon, w.lon);
    const before = C.prepareServiceArea({ seed: r.audit.seed, wp: w, features: houses(w), osm: { elements: [] } });
    const after = C.prepareServiceArea({ seed: v.seed, wp: x, features: houses(x), osm: { elements: [] } });
    assert.deepEqual(after.draw.map(d => [d.position, d.reserve, d.key]), before.draw.map(d => [d.position, d.reserve, d.key])); assert.equal(after.buildings_sha256, before.buildings_sha256); });
  // the usage selection CSV: 12 water points then R1-R3, no coordinates
  const rows = csvRows(pack.csv); assert.deepEqual(rows.map(x => x[4]), r.points.map(w => String(w.order)).concat(r.reserves.map(w => 'R' + w.order)));
  assert.ok(!/-25\.0|46\.9/.test(pack.csv)); assert.ok(!C.hasCoordinateKeys(o.audit));
  // bin/file-round.js: a usage record files to <records_dir>/<round>/<scenario>-U/ (dry run: nothing written)
  const ev = tempEvidence(); const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-file-')); const f = path.join(tmp, pack.names.pdf); fs.writeFileSync(f, pack.pdf);
  const res = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'file-round.js'), '--pdf', f, '--xlsx', path.join(tmp, 'none.xlsx'), '--dry-run'], { encoding: 'utf8', env: ev.env });
  assert.equal(res.status, 0, res.stderr); assert.match(res.stdout, /Usage-survey \(SDWS 26\) record 2026-DRY-HP-FD-2026-DRY-HP-FD-U -> 2026-DRY\/HP-FD-U\/ in /); assert.deepEqual(fs.readdirSync(ev.dir), [], 'dry run writes nothing'); assert.match(res.stdout, new RegExp('audit SHA-256 ' + pack.sha));
  fs.rmSync(tmp, { recursive: true, force: true }); fs.rmSync(ev.root, { recursive: true, force: true });
});

test('K typed in the field fills only the sources without a recorded K; recorded K stays authoritative', () => {
  const frame = K.frames(C).sample; const r = C.draw(Object.assign({}, K.BASE, { roundName: '2026 R1', stratum: 'FD', seed: '2026R1-FD' }), frame);
  const id0 = r.selected[0].water_point_id, id1 = r.selected[1].water_point_id;
  const a = JSON.parse(C.auditJson(r, { field_rule_numbers: [Object.assign({ water_point_id: id0 }, C.fieldNumbers(r.params.seed, id0, 20, 5, 2))] }));
  const v = C.roundFromAudit(a, { kValues: { [id0]: 99, [id1]: 17 } });
  assert.equal(v.selected[0].K, 20); assert.equal(v.selected[0].K_recorded, true);
  assert.equal(v.selected[1].K, 17); assert.equal(v.selected[1].K_recorded, false); assert.deepEqual(v.selected[1].numbers, C.fieldNumbers(r.params.seed, id1, 17, 5, 2).primary);
  assert.equal(v.selected[2].K, null); assert.equal(v.selected[2].numbers, null);
});
