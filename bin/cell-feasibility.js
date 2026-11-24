#!/usr/bin/env node
/* Household-area feasibility (v2.13.0): for every water point of a stratum's usage frame on the live data, how many candidate
 * premises its nearestPoint1km cell keeps (Google Open Buildings v3 footprints, OpenStreetMap barrier clip, nearest programme
 * point), against the households needed per selected point (10 + 5 reserves). Prints ids and counts only, never a coordinate,
 * and writes nothing to the repository.
 *
 * Credentials: MWATER_TOKEN, or MWATER_USERNAME + MWATER_PASSWORD, or --env <file> (e.g. ~/mwater-mcp/.env).
 * FGB_DIR: a folder with node_modules/flatgeobuf (3.38.0).
 * Usage: FGB_DIR=... node bin/cell-feasibility.js --env ~/mwater-mcp/.env [--stratum HP-MA] [--json out.json]
 * Buildings and barriers are read once per ~4 km tile (with a 1.2 km margin), not once per point. */
const fs = require('fs'); const path = require('path'); const C = require('../app.js');
const args = {}; process.argv.slice(2).forEach((a, i, all) => { if (a.startsWith('--')) args[a.slice(2)] = all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true; });
if (args.env) for (const line of fs.readFileSync(args.env, 'utf8').split(/\r?\n/)) { const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line); if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); }
const stratum = args.stratum || 'HP-MA'; const TILE = 0.04; const MARGIN = C.USAGE.radiusM + 200;
const need = C.USAGE.households + C.USAGE.householdReserves;

(async () => {
  const mod = await import(path.join(process.env.FGB_DIR || '/nonexistent', 'node_modules', 'flatgeobuf', 'lib', 'mjs', 'geojson.js')).catch(() => import('flatgeobuf'));
  const geojson = mod.geojson || mod;
  let token = process.env.MWATER_TOKEN; if (!token) token = (await C.mwaterLogin(process.env.MWATER_USERNAME, process.env.MWATER_PASSWORD)).token;
  const frame = await C.mwaterLoadFrame(token, { onProgress: () => {} });
  const points = C.normaliseWaterPoints(C.parseCsv(frame.frameCsv).records).points;
  const fleetText = fs.readFileSync(path.join(__dirname, '..', C.USAGE.fleetUrl), 'utf8'); const fleet = Object.assign(JSON.parse(fleetText), { sha256: C.sha256Sync(fleetText) });
  const uf = C.usageFrame(points, stratum, fleet); const comp = C.competitorSet(points);
  const wps = uf.points.filter(w => isFinite(w.lat) && isFinite(w.lon));
  process.stderr.write(`${stratum}: usage frame ${uf.points.length} (${uf.points.length - wps.length} without position), competitors ${comp.points.length}\n`);
  const tiles = {}; wps.forEach(w => { const k = Math.floor(w.lat / TILE) + ',' + Math.floor(w.lon / TILE); (tiles[k] = tiles[k] || []).push(w); });
  const rows = []; let ti = 0;
  for (const [k, list] of Object.entries(tiles)) {
    ti++; const [a, b] = k.split(',').map(Number); const lat0 = a * TILE, lon0 = b * TILE, latC = lat0 + TILE / 2, lonC = lon0 + TILE / 2;
    const dLat = MARGIN / 110574, dLon = MARGIN / (111320 * Math.cos(latC * Math.PI / 180));
    const features = [];
    for (let attempt = 0; ; attempt++) {
      try { features.length = 0; for await (const f of geojson.deserialize(C.USAGE.buildings.url, { minX: lon0 - dLon, minY: lat0 - dLat, maxX: lon0 + TILE + dLon, maxY: lat0 + TILE + dLat })) features.push({ geometry: f.geometry, properties: { bf_source: f.properties.bf_source } }); break; }
      catch (e) { if (attempt >= 4) throw e; await new Promise(res => setTimeout(res, 2000 * (attempt + 1))); }
    }
    const halfM = Math.max(TILE * 110574, TILE * 111320 * Math.cos(latC * Math.PI / 180)) / 2 * Math.SQRT2; let osm = null;
    for (let attempt = 0; attempt < 8 && !osm; attempt++) { try { const o = await fetch(C.USAGE.overpass, { method: 'POST', body: 'data=' + encodeURIComponent(C.overpassQuery(latC, lonC, halfM + MARGIN)), headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'SaniTap-Sampler/' + C.APP_VERSION + ' (feasibility check)' } }); if (o.ok) osm = await o.json(); else await new Promise(res => setTimeout(res, 4000 * (attempt + 1))); } catch (e) { await new Promise(res => setTimeout(res, 4000 * (attempt + 1))); } }
    for (const w of list) {
      if (!osm) { rows.push({ water_point_id: w.water_point_id, commune: w.commune, fokontany: w.fokontany, error: 'Overpass unavailable' }); continue; }
      const nb = C.cellNeighbours(w, comp.points);
      const circle = C.prepareServiceArea({ seed: 'feasibility', wp: w, features, osm });
      const cell = C.prepareServiceArea({ seed: 'feasibility', wp: w, features, osm, rule: 'nearestPoint1km', neighbours: nb });
      rows.push({ water_point_id: w.water_point_id, commune: w.commune, fokontany: w.fokontany, neighbours_2km: nb.length, buildings_in_circle: circle.buildings_in_circle, circle_kept: circle.buildings_kept, cell_kept: cell.buildings_kept, nearer_other_point: cell.nearer_other_point, short: cell.buildings_kept < need });
    }
    process.stderr.write(`tile ${ti}/${Object.keys(tiles).length}: ${list.length} points, ${features.length} footprints${osm ? '' : ', NO BARRIERS'}\n`);
  }
  rows.sort((x, y) => String(x.water_point_id).localeCompare(String(y.water_point_id)));
  const ok = rows.filter(r => !r.error); const q = (arr, p) => { const s = arr.slice().sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : null; };
  const sum = { stratum, frame: uf.points.length, with_position: wps.length, checked: ok.length, errors: rows.length - ok.length, competitors: comp.points.length, competitors_sha256: comp.sha256, need_per_point: need,
    short_cell: ok.filter(r => r.short).length, short_circle: ok.filter(r => r.circle_kept < need).length, zero_cell: ok.filter(r => r.cell_kept === 0).length,
    cell_kept_median: q(ok.map(r => r.cell_kept), 0.5), circle_kept_median: q(ok.map(r => r.circle_kept), 0.5), neighbours_median: q(ok.map(r => r.neighbours_2km), 0.5),
    buildings: C.USAGE.buildings.name, checked_at: new Date().toISOString() };
  if (args.json) fs.writeFileSync(args.json, JSON.stringify({ summary: sum, rows }, null, 1));
  console.log(JSON.stringify(sum, null, 1));
  console.log('\nPoints whose cell keeps fewer than ' + need + ' premises:'); console.log(['water_point_id', 'commune / fokontany', 'nbrs<=2km', 'circle', 'cell', 'nearer other'].join('\t'));
  ok.filter(r => r.short).forEach(r => console.log([r.water_point_id, r.commune + ' / ' + r.fokontany, r.neighbours_2km, r.circle_kept, r.cell_kept, r.nearer_other_point].join('\t')));
  rows.filter(r => r.error).forEach(r => console.log(r.water_point_id + '\t' + r.error));
})().catch(e => { console.error(e.stack || e.message); process.exit(1); });
