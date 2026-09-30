// The SDWS 18 point-of-use mode must reproduce, unchanged, every draw that v2.2.0 produced
// (test/fixtures/sdws18-baseline.json, written by v2.2.0 before the usage-survey mode was added).
const test = require('node:test'); const assert = require('node:assert/strict'); const path = require('path');
const C = require('../app.js'); const K = require('../bin/sdws18-cases.js'); const base = require('./fixtures/sdws18-baseline.json');

test('SDWS 18 regression: every baseline draw reproduces exactly (selection, replacements, stage-1 numbers, field numbers, audit hash)', () => {
  const now = K.run(C);
  assert.deepEqual(Object.keys(now.draws).sort(), Object.keys(base.draws).sort());
  for (const k of Object.keys(base.draws)) assert.deepEqual(now.draws[k], base.draws[k], 'draw changed: ' + k);
});

test('SDWS 18 regression: the sampling record PDF bytes are unchanged (build stamp pinned)', async () => {
  let PDFLib; try { PDFLib = require(path.join(process.env.PDFLIB_DIR || '/nonexistent', 'node_modules', 'pdf-lib')); } catch (e) { PDFLib = null; }
  if (!PDFLib || !base.pdf) { console.log('  (pdf-lib not available: set PDFLIB_DIR) — PDF part skipped'); return; }
  assert.deepEqual(await K.pdfs(C, PDFLib), base.pdf);
});
