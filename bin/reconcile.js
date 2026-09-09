#!/usr/bin/env node
/* SDWS 3 reconciliation: one row per water point of the MadAvance group with its test status under the health-based rule.
 * Writes ~/Downloads/sdws3_reconciliation.csv (no coordinates) and prints a per-district summary.
 * Credentials: MWATER_TOKEN, or MWATER_USERNAME + MWATER_PASSWORD in the environment, or --env <file> (KEY=VALUE lines, e.g. ~/mwater-mcp/.env).
 * Nothing is written to the repository. Usage: node bin/reconcile.js [--env file] [--out file] */
'use strict';
const fs = require('fs'), path = require('path'), os = require('os');
const C = require(path.join(__dirname, '..', 'app.js'));
const args = {}; for (let i = 2; i < process.argv.length; i++) { const a = process.argv[i]; if (a.startsWith('--')) args[a.slice(2)] = process.argv[++i]; }
if (args.env) for (const line of fs.readFileSync(args.env, 'utf8').split(/\r?\n/)) { const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line); if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); }
(async () => {
  let token = process.env.MWATER_TOKEN;
  if (!token) { if (!process.env.MWATER_USERNAME || !process.env.MWATER_PASSWORD) { console.error('Set MWATER_TOKEN, or MWATER_USERNAME and MWATER_PASSWORD, or pass --env <file>'); process.exit(1); } token = (await C.mwaterLogin(process.env.MWATER_USERNAME, process.env.MWATER_PASSWORD)).token; }
  const warns = []; const r = await C.mwaterLoadFrame(token, { onProgress: (w, n) => { if (w === 'warn') warns.push(n); } });
  const Y = b => b ? 'Y' : 'N';
  const rows = r.points.map(p => ({ id: p.water_point_id, alt_id: p.alt_id || '', name: p.pump, district: p.district, commune: p.commune, status: p.status, sdws3_tested: Y(p.sdws3_results > 0), last_test_date: p.sdws3_last_test, passes_health_rule: Y(p.sdws3_passes > 0), failing_parameters: p.sdws3_passes > 0 ? '' : p.sdws3_failing, eligible: Y(p.status === 'active'), stratum: p.stratum, status_reason: p.status_reason }));
  const header = ['id', 'alt_id', 'name', 'district', 'commune', 'status', 'sdws3_tested', 'last_test_date', 'passes_health_rule', 'failing_parameters', 'eligible', 'stratum', 'status_reason'];
  const out = args.out || path.join(os.homedir(), 'Downloads', 'sdws3_reconciliation.csv'); fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, [header].concat(rows.map(x => header.map(k => x[k]))).map(l => l.map(C.csvEscape).join(',')).join('\r\n') + '\r\n');
  const params = C.MWATER.forms.sdws3.params.map(p => p.key);
  const by = {}; rows.forEach(x => { const d = x.district || '(none)'; const b = by[d] = by[d] || { total: 0, tested: 0, untested: 0, passing: 0, eligible: 0, failing: {} }; b.total++; if (x.sdws3_tested === 'Y') b.tested++; else b.untested++; if (x.passes_health_rule === 'Y') b.passing++; if (x.eligible === 'Y') b.eligible++; if (x.sdws3_tested === 'Y' && x.passes_health_rule === 'N') x.failing_parameters.split(';').filter(Boolean).forEach(f => { b.failing[f] = (b.failing[f] || 0) + 1; }); });
  const cols = ['district', 'total', 'tested', 'untested', 'passing', 'eligible'].concat(params.map(p => 'fail:' + p));
  const line = (d, b) => [d, b.total, b.tested, b.untested, b.passing, b.eligible].concat(params.map(p => Object.keys(b.failing).filter(k => k.split(':')[0] === p).reduce((a, k) => a + b.failing[k], 0)));
  const tot = { total: 0, tested: 0, untested: 0, passing: 0, eligible: 0, failing: {} }; Object.values(by).forEach(b => { ['total', 'tested', 'untested', 'passing', 'eligible'].forEach(k => tot[k] += b[k]); Object.keys(b.failing).forEach(k => tot.failing[k] = (tot.failing[k] || 0) + b.failing[k]); });
  const table = [cols].concat(Object.keys(by).sort().map(d => line(d, by[d]))).concat([line('TOTAL', tot)]);
  const w = cols.map((_, i) => Math.max.apply(null, table.map(t => String(t[i]).length)));
  table.forEach((t, i) => { console.log(t.map((v, j) => String(v).padEnd(w[j])).join('  ')); if (i === 0) console.log(w.map(n => '-'.repeat(n)).join('  ')); });
  console.log('\nfetched ' + r.fetchedAt + ' | SDWS 3 final results ' + r.sdws3Responses + ' | counts ' + JSON.stringify(r.counts) + (warns.length ? ' | warnings: ' + warns.join('; ') : ''));
  console.log('written ' + out + ' (' + rows.length + ' rows; a failing parameter marked ":missing" was not measured in any result)');
})().catch(e => { console.error('ERROR ' + e.message); process.exit(1); });
