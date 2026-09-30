#!/usr/bin/env node
/* Usage-survey (SDWS 26) dry run on the live frame: draws both scenarios for a round, prepares every service area
 * exactly as the phone does (Google Open Buildings v3 footprints read by bounding box from the FlatGeobuf file,
 * OpenStreetMap barriers from Overpass, the 10 m barrier clip, the 10 + 5 household draw) and prints what the record
 * would carry: communes, fokontany, water points with probabilities and weights, building counts per service area.
 * Nothing is written to the repository and no coordinate is printed.
 *
 * Credentials: MWATER_TOKEN, or MWATER_USERNAME + MWATER_PASSWORD, or --env <file> (e.g. ~/mwater-mcp/.env).
 * The FlatGeobuf reader is loaded from FGB_DIR (a folder with node_modules/flatgeobuf).
 * Usage: FGB_DIR=... node bin/usage-dry-run.js --env ~/mwater-mcp/.env [--round 2026-DRY] [--json out.json] */
const fs = require('fs'); const path = require('path'); const C = require('../app.js');
const args = {}; process.argv.slice(2).forEach((a, i, all) => { if (a.startsWith('--')) args[a.slice(2)] = all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true; });
if (args.env) for (const line of fs.readFileSync(args.env, 'utf8').split(/\r?\n/)) { const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line); if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); }
const round = args.round || '2026-DRY';

(async () => {
  const mod = await import(path.join(process.env.FGB_DIR || '/nonexistent', 'node_modules', 'flatgeobuf', 'lib', 'mjs', 'geojson.js')).catch(() => import('flatgeobuf'));
  const geojson = mod.geojson || mod;
  let token = process.env.MWATER_TOKEN;
  if (!token) token = (await C.mwaterLogin(process.env.MWATER_USERNAME, process.env.MWATER_PASSWORD)).token;
  const frame = await C.mwaterLoadFrame(token, { onProgress: () => {} });
  const points = C.normaliseWaterPoints(C.parseCsv(frame.frameCsv).records).points;
  const fleetText = await (await fetch(C.USAGE.fleetUrl)).text(); const fleet = { url: C.USAGE.fleetUrl, sha256: C.sha256Sync(fleetText), fetched_at: new Date().toISOString(), records: JSON.parse(fleetText).records };
  const head = await fetch(C.USAGE.buildings.url, { method: 'HEAD' }); const version = [head.headers.get('last-modified'), head.headers.get('etag')].filter(Boolean).join(' · ');
  const out = { round, frame_points: points.length, fleet_sha256: fleet.sha256, buildings: C.USAGE.buildings.name, buildings_version: version, scenarios: {} };
  for (const scenario of ['HP-FD', 'HP-MA']) {
    const uf = C.usageFrame(points, scenario, fleet);
    const p = { roundName: round, stratum: scenario, seed: round.replace(/\s+/g, '') + '-' + scenario + '-U', timestamp: new Date().toISOString(), drawnBy: 'dry run', source: 'mwater', frameHash: C.sha256Sync(C.frameToCsv(uf.points)), frameCounts: uf.counts };
    const r = C.drawUsage(p, uf.points); const again = C.drawUsage(p, uf.points.slice().reverse());
    if (JSON.stringify(r.audit.water_points) !== JSON.stringify(again.audit.water_points)) throw new Error('not reproducible');
    const areas = [];
    for (const w of r.points.concat(r.reserves)) {
      if (!isFinite(w.lat)) { areas.push({ water_point_id: w.water_point_id, error: 'no coordinates' }); continue; }
      const R = C.USAGE.radiusM + 30, dLat = R / 110574, dLon = R / (111320 * Math.cos(w.lat * Math.PI / 180)); const features = [];
      for (let attempt = 0; ; attempt++) { // transient 'fetch failed' on range requests: retry the whole box
        try { features.length = 0; for await (const f of geojson.deserialize(C.USAGE.buildings.url, { minX: w.lon - dLon, minY: w.lat - dLat, maxX: w.lon + dLon, maxY: w.lat + dLat })) features.push({ geometry: f.geometry, properties: { bf_source: f.properties.bf_source } }); break; }
        catch (e) { if (attempt >= 4) throw e; await new Promise(res => setTimeout(res, 2000 * (attempt + 1))); }
      }
      let osm = null;
      // Overpass refuses generic client User-Agents (HTTP 406) and is often busy (504): identify the tool and retry
      for (let attempt = 0; attempt < 6 && !osm; attempt++) { try { const o = await fetch(C.USAGE.overpass, { method: 'POST', body: 'data=' + encodeURIComponent(C.overpassQuery(w.lat, w.lon)), headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'SaniTap-Sampler/' + C.APP_VERSION + ' (+' + C.APP_URL + ')' } }); if (o.ok) osm = await o.json(); else await new Promise(res => setTimeout(res, 3000 * (attempt + 1))); } catch (e) { await new Promise(res => setTimeout(res, 3000 * (attempt + 1))); } }
      if (!osm) { areas.push({ water_point_id: w.water_point_id, error: 'Overpass unavailable' }); continue; }
      const sa = C.prepareServiceArea({ seed: p.seed, wp: w, features, osm });
      areas.push(Object.assign({ reserve: !!w.reserve, footprints_read: features.length }, C.auditServiceArea(sa)));
      process.stderr.write('.');
    }
    process.stderr.write('\n');
    r.audit.households = { dataset: C.USAGE.buildings.name, version, service_areas: areas.filter(a => !a.error) };
    if (C.hasCoordinateKeys(r.audit)) throw new Error('coordinates in the audit');
    out.scenarios[scenario] = { seed: p.seed, frame_sha256: p.frameHash, frame: uf.counts, stage1: r.audit.stage1, communes: r.audit.communes, water_points: r.audit.water_points, reserves: r.audit.reserves, service_areas: areas, warnings: r.warnings };
  }
  if (args.json) fs.writeFileSync(args.json, JSON.stringify(out, null, 1));
  for (const [s, v] of Object.entries(out.scenarios)) {
    console.log(`\n== ${s}  seed ${v.seed}  frame ${v.frame.frame} points (fleet in scenario; ${v.frame.not_in_fleet} group points of the scenario not in the fleet)  frame SHA-256 ${v.frame_sha256.slice(0, 16)}…`);
    v.communes.forEach(c => console.log(`  commune ${c.name}: ${c.points} points, pi ${c.pi}${c.certainty ? ' (certainty)' : ''}${c.added ? ' (added)' : ''}; fokontany ${c.fokontany_drawn.length}/${c.fokontany_in_frame}: ${c.fokontany_drawn.map(f => f.name).join(', ')}`));
    const byId = Object.fromEntries(v.service_areas.map(a => [a.water_point_id, a]));
    v.water_points.concat(v.reserves).forEach(w => { const a = byId[w.water_point_id] || {}; console.log(`  ${w.reserve ? 'R' + w.order : String(w.order).padStart(2)} ${w.water_point_id.padEnd(10)} ${String(w.commune + ' / ' + w.fokontany).padEnd(40)} ${w.reserve ? 'p(in commune) ' + w.p_conditional : 'pi ' + w.pi + ' weight ' + w.weight}  buildings ${a.error ? a.error : a.buildings_kept + ' kept / ' + a.buildings_in_circle + ' in 1 km (area kept ' + a.area_kept_pct + ' %' + (Object.keys(a.barrier_ways || {}).length ? ', barriers ' + JSON.stringify(a.barrier_ways) : '') + ')' + (a.short ? ' SHORT' : '')}`); });
    if (v.warnings.length) console.log('  warnings: ' + JSON.stringify(v.warnings));
  }
})().catch(e => { console.error(e.stack || e.message); process.exit(1); });
