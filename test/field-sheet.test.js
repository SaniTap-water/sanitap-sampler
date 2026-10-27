// v2.6.0: the mWater form name and K pre-filled from the register are per-draw settings printed on the record.
const test = require('node:test'); const assert = require('node:assert/strict'); const fs = require('fs'); const path = require('path'); const os = require('os');
const C = require('../app.js'); const K = require('../bin/sdws18-cases.js'); const { pdfTextRuns } = require('../bin/pdf-text.js');
let PDFLib; try { PDFLib = require(path.join(process.env.PDFLIB_DIR || '/nonexistent', 'node_modules', 'pdf-lib')); } catch (e) { PDFLib = null; }

const frame = K.frames(C).sample;
const P = extra => Object.assign({}, K.BASE, { roundName: '2026 R1', stratum: 'FD', seed: '2026R1-FD', source: 'csv' }, extra || {});
async function pdfText(r, lang, kValues) {
  const text = JSON.stringify(r.audit, null, 2);
  const bytes = await C.buildSamplingRecordPdf({ PDFLib, audit: r.audit, auditText: text, auditSha: C.sha256Sync(text), lang, url: C.APP_URL, kValues: kValues || {} });
  return pdfTextRuns(Buffer.from(bytes)).join(' ').replace(/\s+/g, ' ');
}

test('form name and K source are recorded only when set; the draw itself is unchanged', () => {
  const plain = C.draw(P(), frame), set = C.draw(P({ mwaterForm: 'SDWS18', kSource: 'register' }), frame);
  assert.equal('mwater_form' in plain.audit.parameters, false); assert.equal('k_source' in plain.audit.parameters, false);
  assert.equal(set.audit.parameters.mwater_form, 'SDWS18'); assert.equal(set.audit.parameters.k_source, 'register');
  assert.deepEqual(set.audit.water_points, plain.audit.water_points); assert.deepEqual(set.audit.replacements, plain.audit.replacements); assert.deepEqual(set.audit.stage1, plain.audit.stage1);
});

test('kFor: typed K wins, else the register figure only when the draw pre-fills K from the register', () => {
  const w = { water_point_id: 'a', households_served: 40 };
  assert.equal(C.kFor(w, { a: 12 }, 'register'), 12); assert.equal(C.kFor(w, {}, 'register'), 40); assert.equal(C.kFor(w, {}, undefined), undefined);
  assert.equal(C.kFor({ water_point_id: 'b', households_served: '' }, {}, 'register'), undefined);
});

test('no template prints the old SDWS 22 PoU form label', () => {
  assert.equal(/SDWS 22 PoU/.test(fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8')), false);
});

test('record PDF: form name in header and section 8; register K replaces the count-K instruction (fr and en)', async () => {
  if (!PDFLib) { console.log('  (pdf-lib not available: set PDFLIB_DIR) — skipped'); return; }
  const reg = C.draw(P({ mwaterForm: 'SDWS18', kSource: 'register' }), frame);
  const fr = await pdfText(reg, 'fr');
  assert.match(fr, /enregistrement 2026R1-FD .{1,3} formulaire mWater SDWS18/);
  assert.match(fr, /K est déjà imprimé d.après le chiffre « Ménages » du registre : il n.y a rien à compter ni à saisir dans l.outil\./);
  assert.match(fr, /formulaire mWater « SDWS18 »/);
  assert.doesNotMatch(fr, /compter tous les ménages qui y puisent/); assert.doesNotMatch(fr, /SDWS 22/); assert.doesNotMatch(fr, /K = ____/);
  const en = await pdfText(reg, 'en');
  assert.match(en, /K is already printed from the register "Ménages" figure/); assert.doesNotMatch(en, /count all households that draw water/);
  // not pre-filled: the count-K instruction stays, with the form name when one is set
  const counted = await pdfText(C.draw(P({ mwaterForm: 'SDWS18' }), frame), 'fr');
  assert.match(counted, /compter tous les ménages qui y puisent \(K\), saisir K dans l.outil/); assert.match(counted, /formulaire mWater « SDWS18 »\./); assert.doesNotMatch(counted, /K est déjà imprimé/);
});

test('reissuing the filed 2026R1 records keeps every source, replacement and household number', async () => {
  if (!PDFLib) { console.log('  (pdf-lib not available: set PDFLIB_DIR) — skipped'); return; }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reissue-'));
  for (const s of ['HP-FD', 'HP-MA']) {
    const out = path.join(tmp, s + '.pdf');
    const res = require('child_process').spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'reissue-record.js'), path.join(__dirname, '..', 'records', '2026R1', s), '--form', 'SDWS18', '--k-register', '--lang', 'fr', '--at', '2026-10-27', '--out', out], { env: process.env, encoding: 'utf8' });
    assert.equal(res.status, 0, res.stderr); assert.equal(JSON.parse(res.stdout).draw_identical, true);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});
