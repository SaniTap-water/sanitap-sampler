// Stroke-test mode (SDWS 28, v2.10.0): frame, simple random draw of 50 + 10 per stratum, filmed flag, -ST record id,
// refusal of a record id another sample holds, and the evidence pack round trip (record PDF -> Open -> file-round).
// node --test test/*.test.js   (PDFLIB_DIR for the PDF round trip)
const test = require('node:test'); const assert = require('node:assert/strict'); const path = require('path'); const fs = require('fs'); const os = require('os'); const zlib = require('zlib');
const { spawnSync } = require('child_process');
const C = require('../app.js'); const S = C.STROKE;
let PDFLib; try { PDFLib = require(path.join(process.env.PDFLIB_DIR || '/nonexistent', 'node_modules', 'pdf-lib')); } catch (e) { PDFLib = null; }

// synthetic frame: 150 fleet points in HP-FD over 6 communes, 20 in HP-MA, plus points outside the fleet and one not creditable
function points() {
  const pts = [];
  for (let i = 0; i < 150; i++) pts.push({ water_point_id: 'FD' + String(i).padStart(3, '0'), alt_id: 'C' + i, name: 'Canzee', stratum: 'HP-FD', commune: 'Commune ' + (i % 6), fokontany: 'Fkt ' + (i % 17), village: 'V' + i, lat: -25 + (i % 10) * 0.01, lon: 46.9 + Math.floor(i / 10) * 0.01, households_served: 10 });
  for (let i = 0; i < 20; i++) pts.push({ water_point_id: 'MA' + i, name: 'Canzee', stratum: 'HP-MA', commune: 'Maro ' + (i % 3), fokontany: 'F' + i, lat: -15.4, lon: 49.7 + i * 0.01 });
  pts.push({ water_point_id: 'FDX1', stratum: 'HP-FD', commune: 'Commune 0', fokontany: 'Fkt 0', lat: -25, lon: 47 }); // not in the fleet
  pts.push({ water_point_id: 'FDNC', stratum: 'HP-FD', commune: 'Commune 0', fokontany: 'Fkt 0', lat: -25, lon: 47, status_reason: 'not_creditable_sdws3: latest SDWS 3 fails' }); // in the fleet, not creditable
  return pts;
}
const fleet = () => { const records = {}; points().forEach(p => { if (p.water_point_id !== 'FDX1') records[p.water_point_id] = 'in_fleet'; }); return { url: 'test', sha256: 'f'.repeat(64), records }; };
const P = { roundName: '2026 R1', stratum: 'HP-FD', timestamp: '2026-11-10T08:00:00.000Z', drawnBy: 'Test', source: 'mwater', frameHash: 'ab'.repeat(32) };
const frameOf = (stratum) => C.usageFrame(points(), stratum || 'HP-FD', fleet()).points;

test('frame: the usage frame (fleet, not-creditable SDWS 3 points out), per stratum', () => {
  const fd = frameOf('HP-FD'), ma = frameOf('HP-MA');
  assert.equal(fd.length, 150); assert.equal(ma.length, 20);
  assert.ok(!fd.some(p => p.water_point_id === 'FDX1'), 'not in the fleet'); assert.ok(!fd.some(p => p.water_point_id === 'FDNC'), 'not creditable');
  assert.ok(fd.every(p => p.stratum === 'HP-FD') && ma.every(p => p.stratum === 'HP-MA'), 'strata kept apart');
});

test('draw is reproducible from round + stratum + frame, whatever the input order; -ST seed and record id', () => {
  const a = C.drawStroke(P, frameOf()), b = C.drawStroke(P, frameOf().reverse());
  assert.equal(JSON.stringify(a.audit), JSON.stringify(b.audit));
  assert.equal(a.audit.seed, '2026R1-HP-FD-ST'); assert.equal(a.audit.record_id, '2026R1-HP-FD-ST'); assert.equal(a.audit.mode, 'stroke_sdws28');
  assert.equal(C.strokeRecordId('2026 R1', 'HP-FD'), '2026R1-HP-FD-ST');
  // a seed passed in is ignored: the seed is always round + stratum + -ST
  assert.equal(JSON.stringify(C.drawStroke(Object.assign({}, P, { seed: 'other' }), frameOf()).audit), JSON.stringify(a.audit));
  // never the id of an SDWS 18 or usage record of the same round and stratum
  assert.notEqual(a.audit.record_id, C.recordId({ roundName: '2026 R1', stratum: 'HP-FD', seed: '2026R1-HP-FD' }));
  assert.notEqual(a.audit.record_id, C.recordId({ roundName: '2026 R1', stratum: 'HP-FD', seed: '2026R1-HP-FD-U' }));
  const ma = C.drawStroke(Object.assign({}, P, { stratum: 'HP-MA' }), frameOf('HP-MA'));
  assert.equal(ma.audit.record_id, '2026R1-HP-MA-ST');
  const other = C.drawStroke(Object.assign({}, P, { roundName: '2026 R2' }), frameOf());
  assert.notDeepEqual(other.audit.water_points.map(w => w.water_point_id), a.audit.water_points.map(w => w.water_point_id));
  assert.equal(C.recordMode(a.audit), 'stroke'); assert.ok(!C.hasCoordinateKeys(a.audit), 'no coordinates in the audit');
});

test('50 + 10 distinct water points, in draw order; the first 10 (exactly) are filmed', () => {
  for (let s = 0; s < 40; s++) {
    const r = C.drawStroke(Object.assign({}, P, { roundName: 'R' + s }), frameOf()); const a = r.audit;
    assert.equal(a.water_points.length, 50); assert.equal(a.reserves.length, 10);
    const ids = a.water_points.concat(a.reserves).map(w => w.water_point_id); assert.equal(new Set(ids).size, 60, 'no point twice');
    ids.forEach(id => assert.ok(/^FD\d{3}$/.test(id), 'drawn from the frame: ' + id));
    assert.deepEqual(a.water_points.map(w => w.order), Array.from({ length: 50 }, (_, i) => i + 1));
    assert.deepEqual(a.reserves.map(w => w.order), Array.from({ length: 10 }, (_, i) => i + 1));
    assert.deepEqual(a.water_points.map(w => w.filmed), Array.from({ length: 50 }, (_, i) => i < 10));
    assert.ok(a.reserves.every(w => w.reserve === true && w.filmed === undefined), 'reserves are not filmed');
    a.water_points.forEach(w => { assert.equal(w.pi, +(50 / 150).toFixed(6)); assert.equal(w.weight, 3); });
    assert.deepEqual([a.parameters.sample_size, a.parameters.reserves, a.parameters.filmed], [50, 10, 10]);
    assert.equal(a.frame.points, 150);
    // the order is random: not the frame (id) order
    assert.notDeepEqual(a.water_points.map(w => w.water_point_id), a.water_points.map(w => w.water_point_id).slice().sort());
  }
  // the defaults are editable
  const e = C.drawStroke(Object.assign({}, P, { points: 30, reserves: 5, filmed: 4 }), frameOf()).audit;
  assert.deepEqual([e.water_points.length, e.reserves.length, e.water_points.filter(w => w.filmed).length], [30, 5, 4]);
  assert.deepEqual(e.water_points.map(w => w.filmed).slice(0, 5), [true, true, true, true, false]);
  // a frame smaller than asked: everything is drawn and the record says so
  const small = C.drawStroke(Object.assign({}, P, { stratum: 'HP-MA' }), frameOf('HP-MA'));
  assert.equal(small.audit.water_points.length, 20); assert.equal(small.audit.reserves.length, 0);
  assert.ok(small.warnings.some(w => w.code === 'short_frame' && w.have === 20 && w.needed === 60));
  assert.equal(C.drawStroke(P, []).error, 'no_eligible');
});

test('equal inclusion probability over many seeds: sample, reserves and the filmed day', () => {
  const N = 3000; const sel = {}, res = {}, film = {}; const ids = frameOf().map(p => p.water_point_id);
  for (let s = 0; s < N; s++) {
    const a = C.drawStroke(Object.assign({}, P, { roundName: 'MC' + s }), frameOf()).audit;
    a.water_points.forEach(w => { sel[w.water_point_id] = (sel[w.water_point_id] || 0) + 1; if (w.filmed) film[w.water_point_id] = (film[w.water_point_id] || 0) + 1; });
    a.reserves.forEach(w => { res[w.water_point_id] = (res[w.water_point_id] || 0) + 1; });
  }
  // binomial standard errors: sample 0.0086, reserves 0.0045, filmed 0.0045; allow 5 of them
  const check = (h, p, tol, what) => ids.forEach(id => { const f = (h[id] || 0) / N; assert.ok(Math.abs(f - p) < tol, what + ' ' + id + ': ' + f.toFixed(4) + ' vs ' + p.toFixed(4)); });
  check(sel, 50 / 150, 0.043, 'sample'); check(res, 10 / 150, 0.023, 'reserve'); check(film, 10 / 150, 0.023, 'filmed');
  // and the overall spread is what equal probability gives (chi-square on the sample counts, 149 df: mean 149, sd 17)
  const exp = N * 50 / 150; const chi = ids.reduce((x, id) => x + Math.pow((sel[id] || 0) - exp, 2) / exp, 0) * (150 / 100);
  assert.ok(chi < 149 + 5 * 17.3, 'chi-square ' + chi.toFixed(1));
});

test('never overwrite another sample: a record id held by another record is refused, whatever its survey', () => {
  const a = C.drawStroke(P, frameOf()).audit; const text = JSON.stringify(a, null, 2); const sha = C.sha256Sync(text);
  const entry = C.libraryEntry({ audit: a, auditText: text, sha, at: '2026-11-10T09:00:00Z' });
  assert.deepEqual([entry.mode, entry.stratum, entry.frame_sha256, entry.record_id], ['stroke', 'HP-FD', 'ab'.repeat(32), '2026R1-HP-FD-ST']);
  // a library holding an SDWS 18 and a usage round of the same round name: the stroke round goes in beside them, untouched
  const lib = { '2026R1-HP-FD': { record_id: '2026R1-HP-FD', mode: 'pou', audit_sha256: '1'.repeat(64) }, '2026R1-HP-FD-2026R1-HP-FD-U': { record_id: '2026R1-HP-FD-2026R1-HP-FD-U', mode: 'usage', audit_sha256: '2'.repeat(64) } };
  const before = JSON.stringify(lib);
  assert.equal(C.libraryCanDraw(lib, entry.record_id), true);
  assert.equal(C.libraryAdd(lib, entry).ok, true); assert.equal(Object.keys(lib).length, 3);
  const others = {}; Object.keys(JSON.parse(before)).forEach(k => { others[k] = lib[k]; }); assert.equal(JSON.stringify(others), before, 'other entries byte-identical');
  // the same record again is a no-op; a different record under the same id is refused, and a redraw under it too
  assert.equal(C.libraryAdd(lib, entry).same, true);
  const other = Object.assign({}, entry, { audit_sha256: '3'.repeat(64) });
  assert.equal(C.libraryAdd(lib, other).error, 'confirmed_other'); assert.equal(lib[entry.record_id].audit_sha256, sha);
  assert.equal(C.libraryCanDraw(lib, entry.record_id), false);
  // an SDWS 18 or usage entry under a taken id is refused just the same (the library is keyed by record id only)
  assert.equal(C.libraryAdd(lib, Object.assign({}, lib['2026R1-HP-FD'], { audit_sha256: '4'.repeat(64) })).error, 'confirmed_other');
  // records folder: holders of the id under another audit (or every holder when filing a new record)
  const filed = [{ record_id: '2026R1-HP-FD-ST', audit_sha256: sha, where: '2026R1/HP-FD-ST' }, { record_id: '2026R1-HP-FD', audit_sha256: '1'.repeat(64), where: '2026R1/HP-FD' }];
  assert.equal(C.recordIdTaken(filed, '2026R1-HP-FD-ST', sha).length, 0); assert.equal(C.recordIdTaken(filed, '2026R1-HP-FD-ST', 'x').length, 1); assert.equal(C.recordIdTaken(filed, '2026R1-HP-FD-ST', null).length, 1);
  assert.equal(C.recordIdTaken(filed, '2026R2-HP-FD-ST', null).length, 0);
});

test('CSV, workbook, file names, open feedback and the field view of a stroke record', () => {
  const r = C.drawStroke(P, frameOf()); const a = r.audit;
  const csv = C.recordCsv(a).split('\r\n'); assert.equal(csv.length, 1 + 60 + 1);
  assert.equal(csv[0], 'round,stratum,record_id,water_point_id,order,role,filmed,alt_id,name,commune,fokontany,probability,weight');
  assert.equal(csv.filter(l => /,sample,yes,/.test(l)).length, 10); assert.equal(csv.filter(l => /,reserve,/.test(l)).length, 10);
  assert.deepEqual(C.packNames(a), { pdf: 'sanitap-2026R1-HP-FD-stroke-record.pdf', xlsx: 'sanitap-2026R1-HP-FD-stroke-selection.xlsx', csv: 'sanitap-2026R1-HP-FD-stroke-selection.csv' });
  ['en', 'fr'].forEach(l => { const wb = C.strokeSelectionWorkbook(a, l); assert.equal(wb.length, 3); assert.equal(wb[0].rows.length, 51); assert.equal(wb[1].rows.length, 11); assert.equal(wb[0].rows.slice(1).filter(x => x[6]).length, 10); });
  const v = C.roundFromAudit(a); assert.equal(v.mode, 'stroke'); assert.equal(C.roundIds(v).length, 60);
  C.withPositions(v, C.positionsFromPoints(r.points.concat(r.reserves), C.roundIds(v))); assert.ok(v.points.concat(v.reserves).every(w => isFinite(w.lat)));
  const o = C.openOutcome({ ok: true, mode: 'stroke', audit: a, sha: 'ab', registered: false }, { ok: true });
  assert.deepEqual([o.ok, o.tab, o.tkeys.survey, o.tkeys.rlabel, o.vars.n, o.vars.r], [true, 'field', 'mode_stroke', 'open_reserves', 50, 10]);
  ['mode_stroke', 'stroke_intro', 'stroke_preview', 'f_need_round_st', 'sw_short_frame', 'st_dist'].forEach(k => ['en', 'fr'].forEach(l => assert.ok(Object.prototype.hasOwnProperty.call(C.I18N[l], k), l + ' lacks ' + k)));
  assert.equal(C.I18N.en.mode_stroke, 'Stroke test (SDWS 28)'); assert.equal(C.I18N.fr.mode_stroke, 'Test de pompage (SDWS 28)');
  Object.keys(C.I18N.en.spdf).forEach(k => assert.ok(k in C.I18N.fr.spdf, 'fr spdf lacks ' + k)); Object.keys(C.I18N.en.sxlsx).forEach(k => assert.ok(k in C.I18N.fr.sxlsx, 'fr sxlsx lacks ' + k));
});

test('evidence pack round trip: record PDF -> Open a confirmed round -> file-round (and a second filing is refused)', async () => {
  if (!PDFLib) { console.log('  (pdf-lib not available: set PDFLIB_DIR) — skipped'); return; }
  const r = C.drawStroke(P, frameOf()); const auditText = JSON.stringify(r.audit, null, 2);
  const positions = C.positionsFromPoints(r.points.concat(r.reserves), C.roundIds(C.roundFromAudit(r.audit)));
  for (const lang of ['fr', 'en']) {
    const pack = await C.evidencePack({ PDFLib, auditText, lang, positions, fetchTile: null });
    assert.equal(pack.record_id, '2026R1-HP-FD-ST'); assert.equal(pack.sha, C.sha256Sync(auditText));
    assert.equal(pack.csv, C.strokeSelectionCsv(r.audit));
    const stops = pack.sheets[pack.sheets.length - 1]; assert.equal(stops.rows.length, 61, 'stop list sheet with GPS'); assert.equal(stops.rows.slice(1).filter(x => x[7]).length, 10, 'filmed flag in the stop list');
    assert.ok(stops.rows.slice(1).every(x => typeof x[5] === 'number' && typeof x[6] === 'number'));
    const pdf = Buffer.from(pack.pdf); const txt = pdf.toString('latin1');
    assert.equal(C.pdfInfoValue(txt, 'RecordId'), '2026R1-HP-FD-ST'); assert.equal(C.pdfInfoValue(txt, 'Mode'), 'stroke_sdws28'); assert.equal(C.pdfInfoValue(txt, 'AuditSHA256'), pack.sha);
    // Open a confirmed round: the browser path and the zlib path read the same attached audit
    const o = await C.openRecord({ pdf: new Uint8Array(pdf) }); assert.equal(o.ok, true); assert.equal(o.mode, 'stroke'); assert.equal(o.auditText, auditText);
    const oz = await C.openRecord({ pdf, inflateSync: zlib.inflateSync }); assert.equal(oz.sha, o.sha);
    const { pdfTextRuns } = require('../bin/pdf-text.js'); const runs = pdfTextRuns(pdf).join('\n');
    C.roundIds(C.roundFromAudit(r.audit)).forEach(id => assert.ok(runs.includes(id), id + ' missing from the PDF'));
    assert.ok(runs.includes(lang === 'fr' ? 'Journée filmée' : 'Filmed day')); assert.ok(runs.includes('-25.00000'), 'stop list with GPS');
    assert.ok(!/\{[nrf]\}/.test(runs), 'every placeholder filled'); assert.ok(/N \/\s+50/.test(runs), 'weight N / 50 in the method');
    assert.ok(/^(Stroke test sampling record|Registre d.échantillonnage . test de pompage)/.test(pdfTextRuns(pdf)[0]));
    if (lang === 'en') continue;
    // bin/file-round.js into a temporary records folder: the record goes to <round>/<stratum>-ST/
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sanitap-stroke-')); const rd = path.join(tmp, 'records'); fs.mkdirSync(rd);
    const cfg = path.join(tmp, 'cfg.json'); fs.writeFileSync(cfg, JSON.stringify({ records_dir: rd }));
    const pdfPath = path.join(tmp, pack.names.pdf); fs.writeFileSync(pdfPath, pdf);
    const run = () => spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'file-round.js'), '--pdf', pdfPath], { env: Object.assign({}, process.env, { SAMPLER_CONFIG: cfg }), encoding: 'utf8' });
    const first = run(); assert.equal(first.status, 0, first.stderr);
    const dir = path.join(rd, '2026R1', 'HP-FD-ST'); assert.equal(fs.readFileSync(path.join(dir, 'audit.json'), 'utf8'), auditText);
    assert.equal(fs.readFileSync(path.join(dir, 'selection.csv'), 'utf8'), pack.csv);
    assert.ok(fs.readFileSync(path.join(rd, 'index.md'), 'utf8').includes('| 2026R1 | HP-FD-ST |'));
    const again = run(); assert.notEqual(again.status, 0); assert.match(again.stderr, /already exists|already filed/);
    // a record id held by a record of another survey in another folder is refused too, and nothing is written
    const rd2 = path.join(tmp, 'records2'); fs.mkdirSync(path.join(rd2, 'elsewhere', 'X'), { recursive: true });
    fs.writeFileSync(path.join(rd2, 'elsewhere', 'X', 'audit.json'), JSON.stringify({ record_id: '2026R1-HP-FD-ST', mode: 'usage_sdws26' }));
    fs.writeFileSync(cfg, JSON.stringify({ records_dir: rd2 }));
    const held = run(); assert.notEqual(held.status, 0); assert.match(held.stderr, /already filed \(elsewhere\/X, usage_sdws26\)/);
    assert.ok(!fs.existsSync(path.join(rd2, '2026R1')), 'nothing filed');
    // reissue: refused while another folder holds the id; with the id only in its own folder it reissues the audit unchanged
    const re = (extra) => spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'reissue-record.js'), '2026R1/HP-FD-ST', '--offline', '--at', '2026-11-10', '--lang', 'fr'].concat(extra || []), { env: Object.assign({}, process.env, { SAMPLER_CONFIG: cfg }), encoding: 'utf8' });
    fs.cpSync(dir, path.join(rd2, '2026R1', 'HP-FD-ST'), { recursive: true });
    const r1 = re(); assert.notEqual(r1.status, 0); assert.match(r1.stderr, /also held by elsewhere/);
    fs.writeFileSync(cfg, JSON.stringify({ records_dir: rd }));
    const r2 = re(); assert.equal(r2.status, 0, r2.stderr); const out = JSON.parse(r2.stdout.trim().split('\n').pop());
    assert.deepEqual([out.mode, out.audit_unchanged, out.audit_sha256], ['stroke', true, pack.sha]);
    assert.equal(fs.readFileSync(path.join(dir, 'reissue-2026-11-10-v' + C.APP_VERSION, 'audit.json'), 'utf8'), auditText);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
