// v2.8.2: bin/reissue-record.js reissues a filed usage-survey (SDWS 26) record with the map, the audit byte for byte unchanged.
// node --test test/*.test.js   (PDFLIB_DIR needed; the filed field records are used when the SharePoint evidence folder is configured)
const test = require('node:test'); const assert = require('node:assert/strict'); const fs = require('fs'); const path = require('path'); const os = require('os');
const { spawnSync } = require('child_process'); const C = require('../app.js'); const { pdfTextRuns } = require('../bin/pdf-text.js'); const { EVIDENCE } = require('./evidence.js');
let PDFLib; try { PDFLib = require(path.join(process.env.PDFLIB_DIR || '/nonexistent', 'node_modules', 'pdf-lib')); } catch (e) { PDFLib = null; }
const ROOT = path.join(__dirname, '..');
function frame() { const pts = []; ['A', 'B', 'C', 'D', 'E', 'F'].forEach((c, ci) => { for (let f = 0; f < 4; f++) for (let i = 0; i < 2; i++) pts.push({ water_point_id: c + f + '-' + i, name: 'Canzee', stratum: 'HP-FD', commune: 'Commune ' + c, fokontany: 'Fkt ' + c + f, lat: -25 + ci * 0.01, lon: 46.9 + i * 0.01, households_served: 0, active: true }); }); return pts; }
const reissue = (dir, args) => spawnSync(process.execPath, [path.join(ROOT, 'bin', 'reissue-record.js'), dir].concat(args), { env: process.env, encoding: 'utf8' });

for (const lang of ['en', 'fr']) test('usage reissue (' + lang + ' original, v2.8.x with map): audit unchanged, map with 1-12 and R1-R3, sections compared, form flags refused', async () => {
  if (!PDFLib) { console.log('  (pdf-lib not available: set PDFLIB_DIR) — skipped'); return; }
  const r = C.drawUsage({ roundName: 'UI TEST', stratum: 'HP-FD', seed: 'UITEST-HP-FD-U', timestamp: '2026-10-31T00:00:00.000Z', drawnBy: 'Test', frameHash: 'ab'.repeat(32) }, frame());
  const a = JSON.parse(JSON.stringify(r.audit)); a.households = null; const text = JSON.stringify(a, null, 2);
  const pack = await C.evidencePack({ PDFLib, auditText: text, lang, positions: {}, fetchTile: null });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reissue-u-')); fs.writeFileSync(path.join(dir, 'audit.json'), text); fs.writeFileSync(path.join(dir, 'sampling-record.pdf'), Buffer.from(pack.pdf)); fs.writeFileSync(path.join(dir, 'selection.csv'), pack.csv);
  const pos = {}; r.points.concat(r.reserves).forEach(w => { pos[w.water_point_id] = { lat: w.lat, lon: w.lon }; }); fs.writeFileSync(path.join(dir, 'pos.json'), JSON.stringify(pos));
  const out = path.join(dir, 'out.pdf'); const p = reissue(dir, ['--positions', path.join(dir, 'pos.json'), '--offline', '--lang', 'fr', '--at', '2026-10-31', '--out', out]);
  assert.equal(p.status, 0, p.stderr); const j = JSON.parse(p.stdout.trim().split('\n').pop());
  assert.deepEqual([j.mode, j.audit_sha256, j.audit_unchanged, j.positions, j.map.placed], ['usage', pack.sha, true, '15/15', 15]);
  const bytes = fs.readFileSync(out); assert.equal(C.extractAudit(bytes, require('zlib').inflateSync), text);
  const runs = pdfTextRuns(bytes); const m = runs.findIndex(x => /^10\. /.test(x)); const map = runs.slice(m);
  for (let i = 1; i <= 12; i++) assert.ok(map.includes(String(i)), 'label ' + i); ['R1', 'R2', 'R3'].forEach(l => assert.ok(map.includes(l), l));
  assert.ok(map.some(x => /^Réédité le 2026-10-31 avec SaniTap Sampler v/.test(x)), 'reissue note');
  assert.notEqual(reissue(dir, ['--positions', path.join(dir, 'pos.json'), '--offline', '--reason', 'x', '--out', out]).status, 0, 'audit changes refused for usage records');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the two field usage records filed 31 Oct 2026 reissue with the audit unchanged (offline preview, nothing written to the evidence folder)', () => {
  if (!PDFLib || !EVIDENCE) { console.log('  (PDFLIB_DIR and the evidence folder needed) — skipped'); return; }
  for (const [rel, sha] of [['2026_R1_FTU/HP-FD-U', '9991cb6a62aa5db9723e7cdff1270d45247d24e1c791c3fec47dbcc69c52fccc'], ['2026_R1_Maro/HP-MA-U', 'c6b8141f7efffcc60cc91d304bcd7a76e1c8814319f2da52481a083a88974699']]) {
    const d = path.join(EVIDENCE, rel); assert.ok(fs.existsSync(d), d); const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'reissue-f-')), 'p.pdf');
    const p = reissue(d, ['--offline', '--out', out]); assert.equal(p.status, 0, p.stderr); const j = JSON.parse(p.stdout.trim().split('\n').pop());
    assert.deepEqual([j.audit_sha256, j.audit_unchanged, j.water_points.length, j.reserves.length], [sha, true, 12, 3]); assert.match(j.sections_1_8_runs_identical, /\(en\)$/);
  }
});
