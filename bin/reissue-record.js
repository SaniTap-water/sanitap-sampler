#!/usr/bin/env node
// Reissue a filed SDWS 18 sampling record with the current template, without re-drawing.
// The draw (seed, sources, replacements, K, household numbers) is copied from the filed audit.json;
// only record metadata is added: the mWater form name, K pre-filled from the register, and a reissue note.
// Then it checks that every draw field and the whole of sections 6 and 7 of the PDF are unchanged.
//
//   PDFLIB_DIR=<dir with node_modules/pdf-lib> node bin/reissue-record.js records/2026R1/HP-FD \
//     --form SDWS18 --k-register --reason "form name and K line corrected" --lang fr --out <file.pdf>
//
// Writes only the --out PDF (and <out>.audit.json beside it); records/ stays append-only.
const fs = require('fs'); const path = require('path'); const assert = require('assert');
const C = require('../app.js'); const { pdfTextRuns } = require('./pdf-text.js');

const args = process.argv.slice(2); const dir = args[0];
const opt = k => { const i = args.indexOf(k); return i < 0 ? undefined : args[i + 1]; };
if (!dir || !opt('--out')) { console.error('usage: reissue-record.js <record dir> --out <file.pdf> [--form NAME] [--k-register] [--reason TEXT] [--lang fr|en] [--at ISO]'); process.exit(2); }
const PDFLib = require(path.join(process.env.PDFLIB_DIR || '.', 'node_modules', 'pdf-lib'));

(async () => {
  const oldAudit = JSON.parse(fs.readFileSync(path.join(dir, 'audit.json'), 'utf8'));
  const oldPdf = fs.readFileSync(path.join(dir, 'sampling-record.pdf'));
  const a = JSON.parse(JSON.stringify(oldAudit));
  if (opt('--form')) a.parameters.mwater_form = opt('--form');
  if (args.includes('--k-register')) a.parameters.k_source = 'register';
  const commit = (() => { try { return require('child_process').execSync('git rev-parse --short HEAD', { cwd: path.join(__dirname, '..') }).toString().trim(); } catch (e) { return 'dev'; } })();
  a.reissue = { version: 'v' + C.APP_VERSION, commit, at: opt('--at') || new Date().toISOString().slice(0, 10), reason: opt('--reason') || 'template corrected', original_audit_sha256: C.sha256Sync(JSON.stringify(oldAudit, null, 2)) };
  const kValues = {}; (a.field_rule_numbers || []).forEach(x => { kValues[x.water_point_id] = x.K; });
  const text = JSON.stringify(a, null, 2); const sha = C.sha256Sync(text);
  const bytes = Buffer.from(await C.buildSamplingRecordPdf({ PDFLib, audit: a, auditText: text, auditSha: sha, lang: opt('--lang') || 'fr', url: C.APP_URL, kValues }));
  const out = opt('--out'); fs.writeFileSync(out, bytes); fs.writeFileSync(out.replace(/\.pdf$/, '') + '.audit.json', text);

  // ---- identical-draw check
  const pick = x => ({ record_id: x.record_id, seed: x.seed, seed_word_uint32: x.seed_word_uint32, timestamp: x.timestamp, stage1: x.stage1, statistics: x.statistics, water_points: x.water_points, replacements: x.replacements, field_rule_numbers: x.field_rule_numbers, reach_check: x.reach_check });
  assert.deepStrictEqual(pick(a), pick(oldAudit), 'draw fields differ from the filed audit');
  // household numbers recomputed from seed + source + K must equal the filed ones
  (a.field_rule_numbers || []).forEach(x => { const w = a.water_points.concat(a.replacements).find(y => y.water_point_id === x.water_point_id); const fn = C.fieldNumbers(a.seed, x.water_point_id, x.K, w.households.n, w.households.extra); assert.deepStrictEqual([fn.primary, fn.replacements], [x.primary, x.replacements], 'numbers differ for ' + x.water_point_id); });
  // sections 6 and 7 of the PDF (selected sources, replacements, K and household numbers) must read the same, run for run
  const section = runs => { const body = runs.filter(r => !/^(Enregistrement|Record) .* SHA-256|^SaniTap Sampler v.* · /.test(r)); const i = body.findIndex(r => /^6\. /.test(r)), j = body.findIndex(r => /^8\. /.test(r)); return body.slice(i, j); };
  const before = section(pdfTextRuns(oldPdf)), after = section(pdfTextRuns(bytes));
  assert.ok(before.length > 20, 'sections 6-7 not found in the filed PDF');
  assert.deepStrictEqual(after, before, 'sections 6-7 differ');
  const ids = a.water_points.map(w => w.water_point_id), reps = a.replacements.map(w => w.water_point_id);
  console.log(JSON.stringify({ out, audit_sha256: sha, selected: ids, replacements: reps, k_and_numbers: (a.field_rule_numbers || []).length, sections_6_7_runs_identical: before.length, draw_identical: true }));
})().catch(e => { console.error(e.message); process.exit(1); });
