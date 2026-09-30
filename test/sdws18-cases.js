// The fixed SDWS 18 cases shared by the baseline writer and the regression test.
const fs = require('fs'); const path = require('path');
function frames(C) {
  const sample = C.normaliseWaterPoints(C.parseCsv(fs.readFileSync(path.join(__dirname, '..', 'data', 'sample-water-points.csv'), 'utf8')).records).points;
  const shape = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'mwater-shape.json'), 'utf8'));
  let mw = null;
  try {
    const m = C.mapMwaterEntities(shape.entities || [], { passing: C.sdws3PassingPoints(shape.sdws3 || [], C.MWATER.forms.sdws3), latest: C.mwaterLatestStatus(shape.maintenance || [], C.MWATER.forms.maintenance), roofs: C.mwaterRoofs(shape.beneficiaries || [], C.MWATER.forms.beneficiaries), regionsById: shape.regions || shape.regionsById || {} });
    mw = C.normaliseWaterPoints(C.parseCsv(C.frameToCsv(m.points)).records).points;
  } catch (e) { mw = null; }
  return { sample, mw };
}
const BASE = { target: 58, hhPerPoint: 5, replacementFraction: 0.2, icc: 0.1, expectedPass: 0.95, confidence: '0.90', precision: 0.1, precisionType: 'relative', hhReplacements: 2, timestamp: '2026-09-30T00:00:00.000Z', drawnBy: 'Regression' };
function cases(f) {
  const out = [];
  for (const st of ['FD', 'MA', 'AM']) for (const round of ['2026 R1', '2026 R2', 'TEST']) for (const target of [20, 58]) out.push({ frame: 'sample', p: Object.assign({}, BASE, { roundName: round, stratum: st, target, seed: round.replace(/\s+/g, '') + '-' + st }) });
  if (f.mw) for (const st of ['HP-FD', 'HP-MA']) for (const round of ['2026 R1', '2026-DRY']) out.push({ frame: 'mw', p: Object.assign({}, BASE, { roundName: round, stratum: st, seed: round.replace(/\s+/g, '') + '-' + st }) });
  return out;
}
function summary(C, r) {
  if (r.error) return { error: r.error };
  const a = JSON.parse(JSON.stringify(r.audit)); a.commit = 'x'; a.version = 'x'; // the build stamp is not part of the draw
  return { selected: r.selected.map(w => w.water_point_id), replacements: r.replacements.map(w => w.water_point_id), stage1: r.audit.stage1,
    field: r.selected.concat(r.replacements).map(w => C.fieldNumbers(r.params.seed, w.water_point_id, 17, 5, 2)),
    audit_sha256: C.sha256Sync(JSON.stringify(a)) };
}
function run(C) {
  const f = frames(C); const draws = {};
  cases(f).forEach(c => { const key = c.frame + '|' + c.p.seed + '|' + c.p.target; draws[key] = summary(C, C.draw(c.p, c.frame === 'sample' ? f.sample : f.mw)); });
  return { note: 'SDWS 18 (point-of-use) draws of SaniTap Sampler v2.2.0 (commit 2b56e5a) for fixed frames and seeds; the regression test requires every later version to reproduce them exactly.', draws };
}
// PDF bytes for three draws, with the build stamp in the audit pinned so that only the record builder is compared
async function pdfs(C, PDFLib) {
  const f = frames(C); const out = {};
  for (const [st, round] of [['FD', '2026 R1'], ['MA', '2026 R2'], ['AM', 'TEST']]) for (const lang of ['en', 'fr']) {
    const p = Object.assign({}, BASE, { roundName: round, stratum: st, seed: round.replace(/\s+/g, '') + '-' + st, source: 'csv', wpFileName: 'sample-water-points.csv', wpFileHash: 'cd'.repeat(32) });
    const r = C.draw(p, f.sample); const a = JSON.parse(JSON.stringify(r.audit)); a.version = '2.2.0'; a.commit = '2b56e5a';
    const text = JSON.stringify(a, null, 2); const sha = C.sha256Sync(text);
    const bytes = await C.buildSamplingRecordPdf({ PDFLib, audit: a, auditText: text, auditSha: sha, lang, url: 'https://sanitap-water.github.io/sanitap-sampler/', kValues: { [r.selected[0].water_point_id]: 23 } });
    out[st + '|' + lang] = C.sha256Sync(Buffer.from(bytes).toString('latin1'));
  }
  return out;
}
module.exports = { run, frames, cases, summary, pdfs, BASE };
