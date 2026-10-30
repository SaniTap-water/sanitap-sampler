// audit.json texts for fixed SDWS 18 and usage-survey draws, as the app confirms them (Draw -> Confirm), for the
// "audit.json is byte-identical across versions" check. The version stamp is the only line allowed to differ.
//   node bin/audit-cases.js [path/to/app.js] > test/fixtures/audit-baseline-v2.7.0.json
const path = require('path'); const K = require('./sdws18-cases.js');
function uframe() {
  const pts = []; const spec = { A: [5, 3, 2, 4, 1], B: [2, 2, 2, 2], C: [6, 1, 1, 1, 1, 2], D: [1, 1, 1, 1], E: [3, 3, 3, 3, 3], F: [4, 4] };
  Object.keys(spec).forEach(c => spec[c].forEach((n, fi) => { for (let i = 0; i < n; i++) pts.push({ water_point_id: c + fi + '-' + i, name: 'Canzee', stratum: 'HP-FD', commune: 'Commune ' + c, fokontany: 'Fkt ' + c + fi, lat: -25 + fi * 0.01, lon: 46.9 + i * 0.01, households_served: 0, active: true }); }));
  return pts;
}
const UP = { roundName: '2026-DRY', stratum: 'HP-FD', timestamp: '2026-09-30T00:00:00.000Z', drawnBy: 'Test', frameHash: 'ab'.repeat(32) };
const norm = (C, text) => text.split('"version": "' + C.APP_VERSION + '"').join('"version": "__VERSION__"');
function texts(C) {
  const f = K.frames(C); const out = {};
  K.cases(f).forEach(c => { const r = C.draw(c.p, c.frame === 'sample' ? f.sample : f.mw); if (r.error) return; out['pou|' + c.frame + '|' + c.p.seed + '|' + c.p.target] = norm(C, C.auditJson(r, { drawn_by: c.p.drawnBy })); });
  ['2026-DRY-HP-FD-U', '2027-WET-HP-FD-U', 'X-HP-FD-U'].forEach(seed => { const r = C.drawUsage(Object.assign({}, UP, { seed }), uframe()); const a = JSON.parse(JSON.stringify(r.audit)); a.households = null; out['usage|' + seed] = norm(C, JSON.stringify(a, null, 2)); });
  return out;
}
function shas(C) { const t = texts(C); const o = {}; Object.keys(t).sort().forEach(k => { o[k] = C.sha256Sync(t[k]); }); return o; }
module.exports = { texts, shas, uframe };
if (require.main === module) { const C = require(path.resolve(process.argv[2] || path.join(__dirname, '..', 'app.js'))); process.stdout.write(JSON.stringify({ note: 'SHA-256 of audit.json texts (version stamp normalised) for fixed draws, written by ' + (process.argv[2] || 'app.js') + ' v' + C.APP_VERSION + '. Later versions must reproduce them byte for byte.', app_version: C.APP_VERSION, audits: shas(C) }, null, 2) + '\n'); }
