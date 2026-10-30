#!/usr/bin/env node
// Reissue a filed SDWS 18 sampling record with the current template, without re-drawing, as a new version in the
// SharePoint evidence folder (records_dir in sampler.local.json; see bin/config.js). Nothing is committed or pushed.
//
// v2.8.0: the reissue adds the map pages (overview, stop list, one zoomed page per 25 km cluster). Positions come from a
// frame loaded on this machine (--frame <frame.csv> or --positions <{id:{lat,lon}}.json>); they go into the PDF pages only.
// Without --form / --k-register / --reason the attached audit.json is the filed one, byte for byte (same audit SHA-256).
// With them, the audit gains parameters.mwater_form / k_source and a reissue block (v2.6.0 behaviour), so its hash changes.
//
//   PDFLIB_DIR=<dir with node_modules/pdf-lib> node bin/reissue-record.js 2026R1/HP-FD --frame <frame.csv> [--lang fr|en]
//        [--at YYYY-MM-DD] [--offline] [--form NAME] [--k-register] [--reason TEXT] [--out <file.pdf>]
//
// The record is read from <records_dir>/<round>/<stratum>/ (or from a folder path). The new version is written to
// <records_dir>/<round>/<stratum>/reissue-<at>-v<version>/ (append-only: refused if it exists) and added to index.md.
// --out writes only that PDF (and <out>.audit.json) and leaves the evidence folder alone (tests, previews).
// Checks: every draw field, sections 6-7 of the PDF run for run, the selection CSV, and every id on the map pages.
const fs = require('fs'); const path = require('path'); const assert = require('assert'); const crypto = require('crypto');
const C = require('../app.js'); const { pdfTextRuns } = require('./pdf-text.js'); const { loadConfig, appendIndex } = require('./config.js');

const args = process.argv.slice(2); const src = args[0];
const opt = k => { const i = args.indexOf(k); return i < 0 ? undefined : args[i + 1]; };
if (!src || src.startsWith('--')) { console.error('usage: reissue-record.js <round>/<stratum> | <record dir> [--frame f.csv | --positions f.json] [--lang fr|en] [--at ISO] [--offline] [--form NAME] [--k-register] [--reason TEXT] [--out file.pdf]'); process.exit(2); }
const PDFLib = require(path.join(process.env.PDFLIB_DIR || '.', 'node_modules', 'pdf-lib'));
const sha = b => crypto.createHash('sha256').update(b).digest('hex');

(async () => {
  const out = opt('--out'); let RD = null;
  if (!out) RD = loadConfig().recordsDir;
  const dir = fs.existsSync(src) && fs.statSync(src).isDirectory() ? src : path.join(RD || loadConfig().recordsDir, src);
  const oldText = fs.readFileSync(path.join(dir, 'audit.json'), 'utf8'); const oldAudit = JSON.parse(oldText);
  const oldPdf = fs.readFileSync(path.join(dir, 'sampling-record.pdf'));
  if (C.recordMode(oldAudit) === 'usage') throw new Error('usage-survey records are not reissued by this script');
  const changeAudit = !!(opt('--form') || args.includes('--k-register') || opt('--reason'));
  const commit = (() => { try { return require('child_process').execSync('git rev-parse --short HEAD', { cwd: path.join(__dirname, '..') }).toString().trim(); } catch (e) { return 'dev'; } })();
  const at = opt('--at') || new Date().toISOString().slice(0, 10);
  let a = oldAudit, text = oldText;
  if (changeAudit) {
    a = JSON.parse(oldText);
    if (opt('--form')) a.parameters.mwater_form = opt('--form');
    if (args.includes('--k-register')) a.parameters.k_source = 'register';
    a.reissue = { version: 'v' + C.APP_VERSION, commit, at, reason: opt('--reason') || 'template corrected', original_audit_sha256: C.sha256Sync(oldText) };
    text = JSON.stringify(a, null, 2);
  }
  const auditSha = C.sha256Sync(text);
  // positions: from the frame loaded on this machine; never written anywhere but the PDF pages
  const ids = a.water_points.concat(a.replacements).map(w => String(w.water_point_id));
  let positions = {};
  if (opt('--positions')) positions = JSON.parse(fs.readFileSync(opt('--positions'), 'utf8'));
  else if (opt('--frame')) positions = C.positionsFromPoints(C.normaliseWaterPoints(C.parseCsv(fs.readFileSync(opt('--frame'), 'utf8')).records).points, ids);
  const kValues = {}; (a.field_rule_numbers || []).forEach(x => { kValues[x.water_point_id] = x.K; });
  const fetchTile = args.includes('--offline') ? null : C.tileFetcher(fetch);
  const ctx = { PDFLib, audit: a, auditText: text, auditSha, lang: opt('--lang') || 'fr', url: C.APP_URL, kValues, map: { positions, fetchTile, reissue: { at, version: C.APP_VERSION, commit } } };
  const bytes = Buffer.from(await C.buildSamplingRecordPdf(ctx));

  // ---- identical-draw check
  const pick = x => ({ record_id: x.record_id, seed: x.seed, seed_word_uint32: x.seed_word_uint32, timestamp: x.timestamp, stage1: x.stage1, statistics: x.statistics, water_points: x.water_points, replacements: x.replacements, field_rule_numbers: x.field_rule_numbers, reach_check: x.reach_check });
  assert.deepStrictEqual(pick(a), pick(oldAudit), 'draw fields differ from the filed audit');
  (a.field_rule_numbers || []).forEach(x => { const w = a.water_points.concat(a.replacements).find(y => y.water_point_id === x.water_point_id); const fn = C.fieldNumbers(a.seed, x.water_point_id, x.K, w.households.n, w.households.extra); assert.deepStrictEqual([fn.primary, fn.replacements], [x.primary, x.replacements], 'numbers differ for ' + x.water_point_id); });
  // sections 6 and 7 of the PDF (selected sources, replacements, K and household numbers) must read the same, run for run
  const section = runs => { const body = runs.filter(r => !/^(Enregistrement|Record) .* SHA-256|^SaniTap Sampler v.* · /.test(r)); const i = body.findIndex(r => /^6\. /.test(r)), j = body.findIndex(r => /^8\. /.test(r)); return body.slice(i, j); };
  const newRuns = pdfTextRuns(bytes); const before = section(pdfTextRuns(oldPdf)), after = section(newRuns);
  assert.ok(before.length > 20, 'sections 6-7 not found in the filed PDF');
  assert.deepStrictEqual(after, before, 'sections 6-7 differ');
  const csv = C.recordCsv(a); const filedCsv = path.join(dir, 'selection.csv');
  if (fs.existsSync(filedCsv)) assert.strictEqual(csv, fs.readFileSync(filedCsv, 'utf8'), 'selection CSV differs from the filed one');
  const joined = newRuns.join('\n'); ids.forEach(id => assert.ok(joined.includes(id), 'id ' + id + ' missing from the PDF'));
  assert.ok(C.extractAudit(bytes, require('zlib').inflateSync) === text, 'attached audit differs');
  assert.ok(!C.hasCoordinateKeys(a), 'coordinates in the audit');

  let target;
  if (out) { fs.writeFileSync(out, bytes); fs.writeFileSync(out.replace(/\.pdf$/, '') + '.audit.json', text); target = out; }
  else {
    const P = a.parameters; const round = String(P.round || '').replace(/\s+/g, ''); const name = 'reissue-' + at + '-v' + C.APP_VERSION;
    const vdir = path.join(RD, round, P.stratum, name); if (fs.existsSync(vdir)) throw new Error('already reissued: ' + vdir + ' (append-only)');
    fs.mkdirSync(vdir, { recursive: true }); fs.writeFileSync(path.join(vdir, 'sampling-record.pdf'), bytes); fs.writeFileSync(path.join(vdir, 'audit.json'), text); fs.writeFileSync(path.join(vdir, 'selection.csv'), csv);
    const rel = round + '/' + P.stratum + '/' + name;
    appendIndex(RD, `| ${round} | ${P.stratum} (reissue ${at}, v${C.APP_VERSION}) | ${a.timestamp} | \`${a.seed}\` | \`${auditSha}\` | \`${(a.input || {}).water_points_sha256 || ''}\` | [PDF](${rel}/sampling-record.pdf) · [audit](${rel}/audit.json) · [CSV](${rel}/selection.csv) |\n`);
    target = vdir;
  }
  console.log(JSON.stringify({ out: target, pdf_sha256: sha(bytes), audit_sha256: auditSha, audit_unchanged: text === oldText, selected: a.water_points.map(w => w.water_point_id), replacements: a.replacements.map(w => w.water_point_id), k_and_numbers: (a.field_rule_numbers || []).length, sections_6_7_runs_identical: before.length, csv_identical: true, positions: Object.keys(positions).filter(k => ids.includes(k)).length + '/' + ids.length, map: ctx.mapResult, draw_identical: true }));
})().catch(e => { console.error(e.message); process.exit(1); });
