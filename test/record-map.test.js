// v2.8.0: the sampling record PDF carries a map and stop list; audit.json is unchanged; filing goes to the SharePoint folder.
// node --test test/*.test.js   (PDFLIB_DIR for the tests that build PDFs)
const test = require('node:test'); const assert = require('node:assert/strict'); const fs = require('fs'); const path = require('path'); const os = require('os');
const { spawnSync, execSync } = require('child_process');
const C = require('../app.js'); const K = require('../bin/sdws18-cases.js'); const A = require('../bin/audit-cases.js'); const { pdfTextRuns } = require('../bin/pdf-text.js');
let PDFLib; try { PDFLib = require(path.join(process.env.PDFLIB_DIR || '/nonexistent', 'node_modules', 'pdf-lib')); } catch (e) { PDFLib = null; }
const skip = () => { console.log('  (pdf-lib not available: set PDFLIB_DIR) — skipped'); };
const ROOT = path.join(__dirname, '..');
// a 1x1 PNG stands in for every basemap tile (no network in tests)
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64');
const fakeTiles = () => { const seen = []; const f = async (z, x, y) => { seen.push([z, x, y]); return new Uint8Array(PNG); }; f.seen = seen; return f; };
const sdws18 = () => { const frame = K.frames(C).sample; const r = C.draw(Object.assign({}, K.BASE, { roundName: '2026 R1', stratum: 'FD', seed: '2026R1-FD', source: 'csv' }), frame); return { r, frame, text: C.auditJson(r, { drawn_by: 'Test' }) }; };
const textOf = pdf => pdfTextRuns(Buffer.from(pdf)).join('\n');

test('audit.json is byte-identical to the v2.7.0 baseline for the same draws (SDWS 18 and usage survey; only the version stamp differs)', () => {
  const base = require('./fixtures/audit-baseline-v2.7.0.json'); const now = A.shas(C);
  assert.equal(base.app_version, '2.7.0'); assert.ok(Object.keys(base.audits).length >= 20);
  assert.deepEqual(now, base.audits);
});

test('SDWS 18 record: map pages with every selected and replacement id, the record id, legend, scale, attribution; reopens; audit unchanged', async () => {
  if (!PDFLib) return skip();
  const { r, frame, text } = sdws18(); const ids = C.roundIds(C.roundFromAudit(JSON.parse(text))); const positions = C.positionsFromPoints(frame, ids);
  const tiles = fakeTiles();
  for (const lang of ['fr', 'en']) {
    const pack = await C.evidencePack({ PDFLib, auditText: text, lang, kValues: {}, positions, fetchTile: tiles });
    const t = textOf(pack.pdf);
    assert.match(t, lang === 'fr' ? /^11\. Carte et liste des arrêts$/m : /^11\. Map and stop list$/m);
    assert.match(t, lang === 'fr' ? /^Liste des arrêts$/m : /^Stop list$/m);
    assert.match(t, /Tiles © Esri/); assert.doesNotMatch(t, /basemap unavailable|fond de carte indisponible/);
    assert.match(t, / km$/m, 'scale bar'); assert.match(t, /^N$/m, 'north arrow'); assert.match(t, new RegExp(r.audit.record_id));
    const mapPart = t.slice(t.search(/^11\. /m));
    ids.forEach(id => assert.ok(mapPart.includes(id), 'id ' + id + ' missing from the map pages'));
    r.selected.forEach(w => assert.match(mapPart, new RegExp('^' + w.order + '$', 'm')));
    ['R1', 'R2'].forEach(l => assert.match(mapPart, new RegExp('^' + l + '$', 'm')));
    // latitude and longitude to 5 decimals in the stop list
    const w0 = r.selected[0]; assert.ok(mapPart.includes(Number(w0.lat).toFixed(5)) && mapPart.includes(Number(w0.lon).toFixed(5)));
    assert.ok(pack.map.maps >= 2 && pack.map.clusters >= 1 && pack.map.basemapMissing === 0 && pack.map.placed === ids.length);
    const o = await C.openRecord({ pdf: new Uint8Array(pack.pdf) }); assert.equal(o.ok, true, o.error); assert.equal(o.auditText, text, 'Open a confirmed round reads the same audit from the map PDF');
    assert.ok(!C.hasCoordinateKeys(o.audit)); assert.equal(pack.sha, C.sha256Sync(text));
    // the Excel workbook gains a stop list sheet with latitude/longitude
    assert.equal(pack.sheets.length, 4); assert.equal(pack.sheets[3].rows.length, 1 + ids.length);
  }
  assert.ok(tiles.seen.length > 0 && tiles.seen.every(([z]) => z >= 1 && z <= 16));
});

test('only the tiles a map needs are requested, each once; clusters link sources within 25 km', () => {
  const v = C.mapView([{ lat: -25.03, lon: 46.99 }, { lat: -24.9, lon: 47.1 }], 495, 470, { maxZoom: 14 });
  const t = C.viewTiles(v); assert.ok(t.length > 0 && t.length <= 6 * 5); assert.equal(new Set(t.map(x => x.x + '/' + x.ty)).size, t.length);
  let calls = 0; const f = C.tileFetcher(async () => { calls++; return { ok: true, arrayBuffer: async () => PNG }; });
  return Promise.all([f(5, 1, 2), f(5, 1, 2), f(5, 1, 3)]).then(() => { assert.equal(calls, 2); assert.equal(f.count(), 2);
    assert.equal(C.tileUrl(5, 1, 2), 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/5/2/1');
    const cl = C.mapClusters([{ lat: -25, lon: 47 }, { lat: -25.1, lon: 47 }, { lat: -24.0, lon: 47 }]); assert.deepEqual(cl.map(c => c.length).sort(), [1, 2]); });
});

test('offline or failing tiles: the pack is still produced, the maps say "basemap unavailable"; no positions: stop list without coordinates', async () => {
  if (!PDFLib) return skip();
  const { frame, text } = sdws18(); const ids = C.roundIds(C.roundFromAudit(JSON.parse(text))); const positions = C.positionsFromPoints(frame, ids);
  const off = await C.evidencePack({ PDFLib, auditText: text, lang: 'en', positions, fetchTile: null });
  let t = textOf(off.pdf); assert.match(t, /^basemap unavailable$/m); assert.doesNotMatch(t, /Tiles © Esri/); assert.equal(off.map.basemapMissing, off.map.maps);
  const failing = C.tileFetcher(async () => { throw new Error('network down'); });
  const bad = await C.evidencePack({ PDFLib, auditText: text, lang: 'fr', positions, fetchTile: failing });
  t = textOf(bad.pdf); assert.match(t, /^fond de carte indisponible$/m); assert.ok((await C.openRecord({ pdf: new Uint8Array(bad.pdf) })).ok);
  const half = C.tileFetcher(async u => (/\/0$/.test(u) ? { ok: false } : { ok: true, arrayBuffer: async () => PNG }));
  const hp = await C.evidencePack({ PDFLib, auditText: text, lang: 'en', positions, fetchTile: half }); assert.ok(hp.map.basemapMissing >= 0);
  const none = await C.evidencePack({ PDFLib, auditText: text, lang: 'en', positions: {}, fetchTile: fakeTiles() });
  t = textOf(none.pdf); assert.match(t, /Positions not available/); assert.match(t, /^Stop list$/m); ids.forEach(id => assert.ok(t.includes(id)));
  assert.equal(none.map.placed, 0); assert.equal(none.map.maps, 1); assert.equal(none.sheets.length, 3, 'no stop list sheet without positions');
  const o = await C.openRecord({ pdf: new Uint8Array(none.pdf) }); assert.equal(o.ok, true); assert.equal(o.auditText, text);
});

test('usage record: map with zones in the Map tab colours, every drawn and reserve point, record id; audit unchanged', async () => {
  if (!PDFLib) return skip();
  const r = C.drawUsage({ roundName: '2026-DRY', stratum: 'HP-FD', seed: '2026-DRY-HP-FD-U', timestamp: '2026-09-30T00:00:00.000Z', drawnBy: 'Test', frameHash: 'ab'.repeat(32) }, A.uframe());
  const a = JSON.parse(JSON.stringify(r.audit)); a.households = null; const text = JSON.stringify(a, null, 2);
  const ids = C.roundIds(C.roundFromAudit(a)); const pack = await C.evidencePack({ PDFLib, auditText: text, lang: 'fr', positions: C.positionsFromPoints(A.uframe(), ids), fetchTile: fakeTiles() });
  const t = textOf(pack.pdf); const mapPart = t.slice(t.search(/^10\. Carte et liste des arrêts$/m)); assert.ok(mapPart.length > 100);
  ids.forEach(id => assert.ok(mapPart.includes(id), id)); a.zones.forEach(z => assert.ok(mapPart.includes('Zone ' + z.name), 'legend lists zone ' + z.name));
  assert.match(mapPart, /tirés à l’étape terrain|tir.s . l.étape terrain/); assert.match(t, new RegExp(a.record_id));
  assert.deepEqual(C.MAP_PALETTE.slice(0, 3), ['#0b5e8a', '#b45309', '#157347']);
  const o = await C.openRecord({ pdf: new Uint8Array(pack.pdf) }); assert.equal(o.ok, true); assert.equal(o.auditText, text);
});

// a SharePoint-like folder named by SAMPLER_CONFIG; the filing scripts must write there and never touch git
function tempEvidence() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-')); const dir = path.join(d, 'Monitoring evidence', 'Sampling records'); fs.mkdirSync(dir, { recursive: true }); const cfg = path.join(d, 'sampler.local.json'); fs.writeFileSync(cfg, JSON.stringify({ records_dir: dir })); return { root: d, dir, env: Object.assign({}, process.env, { SAMPLER_CONFIG: cfg }) }; }
const gitState = () => execSync('git rev-parse HEAD && git status --porcelain --untracked-files=all', { cwd: ROOT }).toString();

test('file-round files to the SharePoint folder from the config, appends index.md, refuses an overwrite, never touches git', async () => {
  if (!PDFLib) return skip();
  const { frame, text } = sdws18(); const ids = C.roundIds(C.roundFromAudit(JSON.parse(text)));
  const pack = await C.evidencePack({ PDFLib, auditText: text, lang: 'fr', positions: C.positionsFromPoints(frame, ids), fetchTile: null });
  const ev = tempEvidence(); const pdf = path.join(ev.root, pack.names.pdf); fs.writeFileSync(pdf, pack.pdf); const before = gitState();
  const run = () => spawnSync(process.execPath, [path.join(ROOT, 'bin', 'file-round.js'), '--pdf', pdf, '--xlsx', path.join(ev.root, 'none.xlsx')], { encoding: 'utf8', env: ev.env });
  const r1 = run(); assert.equal(r1.status, 0, r1.stderr);
  const rec = path.join(ev.dir, '2026R1', 'FD'); assert.deepEqual(fs.readdirSync(rec).sort(), ['audit.json', 'sampling-record.pdf', 'selection.csv']);
  assert.equal(fs.readFileSync(path.join(rec, 'audit.json'), 'utf8'), text); assert.ok(fs.readFileSync(path.join(rec, 'sampling-record.pdf')).equals(Buffer.from(pack.pdf)));
  const idx = fs.readFileSync(path.join(ev.dir, 'index.md'), 'utf8'); assert.match(idx, new RegExp('\\| 2026R1 \\| FD \\| .*' + pack.sha)); assert.doesNotMatch(idx, /github\.io/);
  const r2 = run(); assert.equal(r2.status, 1); assert.match(r2.stderr, /record folder already exists: 2026R1\/FD/);
  assert.equal(fs.readFileSync(path.join(ev.dir, 'index.md'), 'utf8'), idx, 'refused filing leaves the index alone');
  assert.equal(gitState(), before, 'no commit, no staged or new files in the repo'); assert.ok(!fs.existsSync(path.join(ev.root, '.git')));
  assert.doesNotMatch(fs.readFileSync(path.join(ROOT, 'bin', 'file-round.js'), 'utf8'), /child_process|execSync|spawn|no-push/, 'file-round runs no git (or any other) command');
  // a config pointing inside the repository is refused
  const inRepo = path.join(ev.root, 'bad.json'); fs.writeFileSync(inRepo, JSON.stringify({ records_dir: path.join(ROOT, 'test') }));
  const r3 = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'file-round.js'), '--pdf', pdf, '--dry-run'], { encoding: 'utf8', env: Object.assign({}, process.env, { SAMPLER_CONFIG: inRepo }) });
  assert.equal(r3.status, 1); assert.match(r3.stderr, /outside the repository/);
  fs.rmSync(ev.root, { recursive: true, force: true });
});

test('reissue-record writes a new version (map added, same audit) into the SharePoint folder, once', async () => {
  if (!PDFLib) return skip();
  const { frame, text, r } = sdws18(); const ev = tempEvidence();
  // a filed record (v2.7.0 template: no map) in the temp evidence folder
  const rec = path.join(ev.dir, '2026R1', 'FD'); fs.mkdirSync(rec, { recursive: true });
  const kv = {}; const old = await C.buildSamplingRecordPdf({ PDFLib, audit: JSON.parse(text), auditText: text, auditSha: C.sha256Sync(text), lang: 'fr', url: C.APP_URL, kValues: kv });
  fs.writeFileSync(path.join(rec, 'sampling-record.pdf'), old); fs.writeFileSync(path.join(rec, 'audit.json'), text); fs.writeFileSync(path.join(rec, 'selection.csv'), C.recordCsv(JSON.parse(text)));
  const fcsv = path.join(ev.root, 'frame.csv'); fs.writeFileSync(fcsv, C.frameToCsv(frame)); const before = gitState();
  const run = () => spawnSync(process.execPath, [path.join(ROOT, 'bin', 'reissue-record.js'), '2026R1/FD', '--frame', fcsv, '--offline', '--at', '2026-10-30', '--lang', 'fr'], { encoding: 'utf8', env: ev.env });
  const r1 = run(); assert.equal(r1.status, 0, r1.stderr); const j = JSON.parse(r1.stdout);
  assert.equal(j.audit_unchanged, true); assert.equal(j.audit_sha256, C.sha256Sync(text)); assert.match(j.positions, /^(\d+)\/\1$/); assert.deepEqual(j.selected, r.selected.map(w => w.water_point_id));
  const v = path.join(rec, 'reissue-2026-10-30-v' + C.APP_VERSION); assert.deepEqual(fs.readdirSync(v).sort(), ['audit.json', 'sampling-record.pdf', 'selection.csv']);
  assert.equal(fs.readFileSync(path.join(v, 'audit.json'), 'utf8'), text); const t = textOf(fs.readFileSync(path.join(v, 'sampling-record.pdf'))); assert.match(t, /Réédité le 2026-10-30/); assert.match(t, /^11\. Carte et liste des arrêts$/m);
  assert.match(fs.readFileSync(path.join(ev.dir, 'index.md'), 'utf8'), /\| 2026R1 \| FD \(reissue 2026-10-30, v/);
  const r2 = run(); assert.equal(r2.status, 1); assert.match(r2.stderr, /already reissued/);
  assert.equal(gitState(), before); fs.rmSync(ev.root, { recursive: true, force: true });
});
