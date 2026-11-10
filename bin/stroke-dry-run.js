#!/usr/bin/env node
/* Stroke-test (SDWS 28) dry run on the live frame: reads the mWater register (reads only), joins the fleet classification of this
 * repo, draws both strata exactly as the app does (Core.usageFrame + Core.drawStroke) and prints what the record would carry:
 * frame counts, the frame SHA-256, the 50 + 10 water point ids in draw order with the filmed flag. Nothing is written or filed
 * (James Walker makes the real draw in the app) and no coordinate is printed.
 *
 * Credentials: MWATER_TOKEN, or MWATER_USERNAME + MWATER_PASSWORD, or --env <file> (e.g. ~/mwater-mcp/.env).
 * Usage: node bin/stroke-dry-run.js --env ~/mwater-mcp/.env [--round 2026-DRY] [--points 50] [--reserves 10] [--filmed 10] [--json out.json] */
'use strict';
const fs = require('fs'); const path = require('path'); const C = require('../app.js');
const args = {}; process.argv.slice(2).forEach((a, i, all) => { if (a.startsWith('--')) args[a.slice(2)] = all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true; });
if (args.env) for (const line of fs.readFileSync(args.env, 'utf8').split(/\r?\n/)) { const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line); if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); }
const round = args.round || '2026-DRY';

(async () => {
  let token = process.env.MWATER_TOKEN;
  if (!token) token = (await C.mwaterLogin(process.env.MWATER_USERNAME, process.env.MWATER_PASSWORD)).token;
  const frame = await C.mwaterLoadFrame(token, { onProgress: () => {} });
  const points = C.normaliseWaterPoints(C.parseCsv(frame.frameCsv).records).points;
  const fleetText = fs.readFileSync(path.join(__dirname, '..', C.USAGE.fleetUrl), 'utf8');
  const fleet = { url: C.APP_URL + C.USAGE.fleetUrl.replace(/^\.\//, ''), sha256: C.sha256Sync(fleetText), fetched_at: new Date().toISOString(), records: JSON.parse(fleetText).records };
  const out = { round, group_points: points.length, not_creditable: [].concat(frame.creditRule.not_creditable || []).length, fleet_sha256: fleet.sha256, strata: {} };
  for (const stratum of ['HP-FD', 'HP-MA']) {
    const uf = C.usageFrame(points, stratum, fleet);
    const p = { roundName: round, stratum, points: args.points, reserves: args.reserves, filmed: args.filmed, timestamp: new Date().toISOString(), drawnBy: 'dry run', source: 'mwater', frameHash: C.sha256Sync(C.frameToCsv(uf.points)), frameCounts: uf.counts, fleet: { url: fleet.url, sha256: fleet.sha256, fetched_at: fleet.fetched_at, classes: C.USAGE.fleetClasses } };
    const r = C.drawStroke(p, uf.points); if (r.error) throw new Error(stratum + ': ' + r.error);
    const again = C.drawStroke(p, uf.points.slice().reverse());
    if (JSON.stringify(again.audit) !== JSON.stringify(r.audit)) throw new Error('not reproducible');
    if (C.hasCoordinateKeys(r.audit)) throw new Error('coordinates in the audit');
    const ids = r.audit.water_points.concat(r.audit.reserves).map(w => w.water_point_id);
    if (new Set(ids).size !== ids.length) throw new Error('a water point drawn twice');
    out.strata[stratum] = { record_id: r.audit.record_id, seed: r.audit.seed, frame_sha256: p.frameHash, frame: uf.counts, drawn: r.audit.water_points.length, reserves: r.audit.reserves.length, filmed: r.audit.water_points.filter(w => w.filmed).length, communes_drawn: new Set(r.audit.water_points.map(w => w.commune)).size, without_coordinates: r.points.concat(r.reserves).filter(w => !isFinite(w.lat) || !isFinite(w.lon)).length, warnings: r.warnings, water_points: r.audit.water_points.map(w => ({ order: w.order, id: w.water_point_id, commune: w.commune, filmed: w.filmed })), reserves_list: r.audit.reserves.map(w => w.water_point_id) };
  }
  if (args.json) fs.writeFileSync(args.json, JSON.stringify(out, null, 1));
  console.log(`round ${round}: ${out.group_points} water points in the group; ${out.not_creditable} not creditable (SDWS 3); fleet file SHA-256 ${out.fleet_sha256.slice(0, 16)}…`);
  for (const [s, v] of Object.entries(out.strata)) {
    const f = v.frame;
    console.log(`\n== ${s}  record ${v.record_id}  frame ${f.frame} (in districts ${f.in_scenario}, not in fleet ${f.not_in_fleet}${f.not_creditable ? ', not creditable ' + f.not_creditable : ''})  frame SHA-256 ${v.frame_sha256.slice(0, 16)}…`);
    console.log(`  drawn ${v.drawn} + ${v.reserves} reserves; filmed ${v.filmed}; communes in the sample ${v.communes_drawn}; drawn points without coordinates ${v.without_coordinates}`);
    console.log('  sample: ' + v.water_points.map(w => w.order + (w.filmed ? 'F' : '') + ' ' + w.id).join(', '));
    console.log('  reserves: ' + v.reserves_list.map((id, i) => 'R' + (i + 1) + ' ' + id).join(', '));
    if (v.warnings.length) console.log('  warnings: ' + JSON.stringify(v.warnings));
  }
})().catch(e => { console.error(e.stack || e.message); process.exit(1); });
