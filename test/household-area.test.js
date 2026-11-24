// v2.13.0: household area per stratum (SOP-MAD-SDWS26 v0.5). HP-MA usage rounds of 2027 and later use nearestPoint1km
// (a premise within 1 km counts only if the selected point is its nearest programme point; ties to the lower code); every
// other round keeps circle1km and a byte-identical audit. Synthetic positions only; the filed 2026 audits are read from the
// SharePoint evidence folder when it is configured.
// node --test test/*.test.js   (PDFLIB_DIR for the PDF test)
const test = require('node:test'); const assert = require('node:assert/strict'); const fs = require('fs'); const path = require('path');
const C = require('../app.js'); const { EVIDENCE } = require('./evidence.js'); const { pdfTextRuns } = require('../bin/pdf-text.js');
let PDFLib; try { PDFLib = require(path.join(process.env.PDFLIB_DIR || '/nonexistent', 'node_modules', 'pdf-lib')); } catch (e) { PDFLib = null; }

const LAT = -15.4, LON = 49.7, KX = 111320 * Math.cos(LAT * Math.PI / 180), KY = 110574;
const at = (x, y) => ({ lat: LAT + y / KY, lon: LON + x / KX }); // metres east/north of the origin -> position
// HP-MA-like frame: 6 communes x 5 fokontany x 3 points, points 300 m apart inside a fokontany (cells overlap with 1 km circles)
function frame(stratum) {
  const pts = []; for (let c = 0; c < 6; c++) for (let f = 0; f < 5; f++) for (let i = 0; i < 3; i++) { const q = at(c * 6000 + i * 300, f * 3000); pts.push({ water_point_id: 'MA' + c + f + i, name: 'Canzee', stratum, commune: 'Commune ' + c, fokontany: 'Fkt ' + c + f, lat: q.lat, lon: q.lon, households_served: 0, active: true, status: 'active', status_reason: '', abandoned: 'N' }); }
  return pts;
}
// v2.13.1: the rule was not adopted; production uses the circle everywhere. These tests switch the unused path on for HP-MA.
const PROD_BY_STRATUM = JSON.parse(JSON.stringify(C.HOUSEHOLD_AREA.byStratum));
test('production: the 1 km circle for every stratum and year (nearestPoint1km assessed 24 Nov 2026, not adopted)', () => {
  assert.deepEqual(PROD_BY_STRATUM, {});
  for (const s of ['HP-MA', 'HP-FD', 'FD', 'MA']) for (const r of ['2026_R1_Maro', '2027_R1_Maro', '2030 R1', 'R1']) assert.equal(C.householdAreaRule(s, r, '2031-01-01T00:00:00Z'), 'circle1km', s + ' ' + r);
  const pts = frame('HP-MA'); const r = C.drawUsage(Object.assign(P('HP-MA', '2027_R1_Maro'), { competitors: pts }), pts);
  assert.equal(r.householdArea, 'circle1km'); assert.equal(r.audit.parameters.household_area, undefined); assert.ok(!/cell_neighbours/.test(JSON.stringify(r.audit)));
  C.HOUSEHOLD_AREA.byStratum['HP-MA'] = 'nearestPoint1km'; // test configuration for the rest of this file
});
const P = (stratum, round) => ({ roundName: round, stratum, seed: round.replace(/\s+/g, '') + '-' + stratum + '-U', timestamp: '2026-11-24T00:00:00.000Z', drawnBy: 'Test', frameHash: 'cd'.repeat(32) });

test('rule: HP-MA from the 2027 usage round; 2026 rounds, HP-FD and other strata keep the 1 km circle', () => {
  const R = C.householdAreaRule;
  assert.equal(R('HP-MA', '2026_R1_Maro'), 'circle1km'); assert.equal(R('HP-MA', '2026-DRY'), 'circle1km'); assert.equal(R('HP-MA', '2026 R1'), 'circle1km');
  assert.equal(R('HP-MA', '2027_R1_Maro'), 'nearestPoint1km'); assert.equal(R('HP-MA', '2028 R2'), 'nearestPoint1km'); assert.equal(R('HP-MA', 'Maro-2027-R1'), 'nearestPoint1km');
  assert.equal(R('HP-FD', '2027_R1_FTU'), 'circle1km'); assert.equal(R('FD', '2030'), 'circle1km');
  assert.equal(R('HP-MA', 'R1', '2026-12-01T00:00:00Z'), 'circle1km', 'no year in the name: the draw date'); assert.equal(R('HP-MA', 'R1', '2027-01-02T00:00:00Z'), 'nearestPoint1km');
  assert.equal(C.roundYear('R20271', '2026-05-01T00:00:00Z'), 2026, 'digits glued to other digits are not a year'); assert.equal(C.roundYear('x12027', '2026-05-01T00:00:00Z'), 2026);
});

test('cell membership: nearest water point wins, ties go to the lower code, the cell polygon matches', () => {
  const A = Object.assign({ water_point_id: 'B200' }, at(0, 0)); const N1 = Object.assign({ water_point_id: 'B300' }, at(600, 0)); const N2 = Object.assign({ water_point_id: 'A100' }, at(0, -600));
  const nb = [N1, N2];
  assert.equal(C.inCell(at(100, 0), A, nb), true); assert.equal(C.inCell(at(500, 0), A, nb), false, 'nearer B300');
  assert.equal(C.inCell(at(-900, 0), A, nb), true, 'inside 1 km on the free side');
  // exact ties: a premise with two points mirrored east and west of it at the same latitude (identical haversine distances)
  const q0 = at(0, 0); const d = 300 / KX; const W = { water_point_id: 'B200', lat: q0.lat, lon: q0.lon - d }, E = { water_point_id: 'A100', lat: q0.lat, lon: q0.lon + d };
  assert.equal(C.inCell(q0, W, [E]), false, 'A100 < B200 takes the tie'); assert.equal(C.inCell(q0, E, [W]), true, 'A100 keeps it');
  const E2 = Object.assign({}, E, { water_point_id: 'C300' }); assert.equal(C.inCell(q0, W, [E2]), true, 'B200 < C300 keeps it');
  // the polygon drawn on the maps agrees with inCell away from its edges
  const poly = C.cellPolygon(A, nb, 1000); assert.ok(poly.length >= 3);
  const inPoly = (q) => { let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const [yi, xi] = poly[i], [yj, xj] = poly[j]; if ((yi > q.lat) !== (yj > q.lat) && q.lon < (xj - xi) * (q.lat - yi) / (yj - yi) + xi) c = !c; } return c; };
  let checked = 0; for (let x = -980; x <= 980; x += 70) for (let y = -980; y <= 980; y += 70) { const q = at(x + 3, y + 5); const d = Math.hypot(x + 3, y + 5); if (d > 990 || Math.abs(x + 3 - 300) < 15 || Math.abs(y + 5 + 300) < 15) continue; assert.equal(inPoly(q), C.inCell(q, A, nb) && d <= 1000, x + ',' + y); checked++; }
  assert.ok(checked > 400);
  // competitors: abandoned and position-less points never count
  const comp = C.competitorSet([{ water_point_id: 'X1', lat: 1, lon: 1, status_reason: 'abandoned:name', abandoned: 'Y' }, { water_point_id: 'X2', lat: 1, lon: 1, status_reason: 'excluded_no_pass', abandoned: 'N' }, { water_point_id: 'X3', lat: '', lon: '', status_reason: '', abandoned: 'N' }, { water_point_id: 'X4', lat: 2, lon: 2, status_reason: 'abandoned:maintenance not functional', abandoned: 'N' }]);
  assert.deepEqual(comp.points.map(c => c.water_point_id), ['X2']);
  assert.equal(C.competitorSet([{ water_point_id: 'c1', lat: 1, lon: 1, active: false }, { water_point_id: 'c2', lat: 1, lon: 1, active: true }]).points.length, 1, 'CSV frame: inactive rows are out');
});

test('draw: HP-MA 2027 records the rule and cell neighbours (ids only); same water points as the circle draw; HP-FD and 2026 untouched', () => {
  const pts = frame('HP-MA'); const p = Object.assign(P('HP-MA', '2027_R1_Maro'), { competitors: pts });
  assert.equal(C.drawUsage(P('HP-MA', '2027_R1_Maro'), pts).error, 'no_competitors');
  const r = C.drawUsage(p, pts); assert.ok(!r.error); assert.equal(r.householdArea, 'nearestPoint1km');
  const HA = r.audit.parameters.household_area; assert.equal(HA.rule, 'nearestPoint1km'); assert.equal(HA.version, 1); assert.equal(HA.radius_m, 1000);
  assert.equal(HA.competitors.count, pts.length); assert.match(HA.competitors.sha256, /^[0-9a-f]{64}$/); assert.match(HA.sop, /v0\.5/);
  r.audit.water_points.concat(r.audit.reserves).forEach(w => { assert.ok(Array.isArray(w.cell_neighbours)); assert.ok(w.cell_neighbours.length >= 2, w.water_point_id + ' has its two fokontany neighbours'); assert.ok(!w.cell_neighbours.includes(w.water_point_id)); });
  assert.equal(C.hasCoordinateKeys(r.audit), false, 'no coordinates in the audit');
  assert.equal(JSON.stringify(r.audit).indexOf(String(pts[0].lat)), -1);
  // the draw itself (zones, fokontany, points, reserves, probabilities) is the circle draw: only the two additions differ
  const save = C.HOUSEHOLD_AREA.fromYear; C.HOUSEHOLD_AREA.fromYear = 9999;
  try {
    const circ = C.drawUsage(p, pts); assert.equal(circ.audit.parameters.household_area, undefined);
    const strip = JSON.parse(JSON.stringify(r.audit)); delete strip.parameters.household_area; strip.water_points.concat(strip.reserves).forEach(w => delete w.cell_neighbours);
    assert.equal(JSON.stringify(strip), JSON.stringify(circ.audit));
  } finally { C.HOUSEHOLD_AREA.fromYear = save; }
  // HP-FD 2027 and HP-MA 2026: no rule in the audit, competitors ignored, identical with or without them
  for (const [s, round] of [['HP-FD', '2027_R1_FTU'], ['HP-MA', '2026_R1_Maro'], ['HP-MA', '2026-DRY']]) {
    const f = frame(s); const a = C.drawUsage(P(s, round), f), b = C.drawUsage(Object.assign(P(s, round), { competitors: f }), f);
    assert.equal(a.audit.parameters.household_area, undefined, s + ' ' + round); assert.equal(JSON.stringify(a.audit), JSON.stringify(b.audit));
    assert.ok(!/cell_neighbours/.test(JSON.stringify(a.audit)));
  }
});

// buildings on a 40 m grid around a point
const grid = (c, R) => { const out = []; for (let x = -R; x <= R; x += 40) for (let y = -R; y <= R; y += 40) { const q = { lat: c.lat + y / KY, lon: c.lon + x / KX }; const d = 0.00003; out.push({ geometry: { type: 'Polygon', coordinates: [[[q.lon - d, q.lat - d], [q.lon + d, q.lat - d], [q.lon + d, q.lat + d], [q.lon - d, q.lat + d], [q.lon - d, q.lat - d]]] }, properties: { bf_source: 'google' } }); } return out; };

test('households: the cell filter runs before the unchanged draw; circle calls are unchanged', () => {
  const wp = Object.assign({ water_point_id: 'MA001' }, at(0, 0)); const nb = [Object.assign({ water_point_id: 'MA002' }, at(300, 0)), Object.assign({ water_point_id: 'MA000' }, at(-300, 0))];
  const feats = grid(wp, 1100);
  const circle = C.prepareServiceArea({ seed: 's', wp, features: feats, osm: { elements: [] } });
  const cell = C.prepareServiceArea({ seed: 's', wp, features: feats, osm: { elements: [] }, rule: 'nearestPoint1km', neighbours: nb });
  assert.equal(circle.household_area, undefined); assert.equal(circle.nearer_other_point, undefined);
  assert.equal(cell.buildings_in_circle, circle.buildings_in_circle);
  assert.equal(cell.buildings_kept + cell.nearer_other_point, circle.buildings_kept);
  assert.ok(cell.buildings_kept < circle.buildings_kept / 2, 'a 300 m spacing leaves a strip ' + cell.buildings_kept + ' / ' + circle.buildings_kept);
  cell.keys.forEach(k => { const [la, lo] = k.split(',').map(Number); assert.ok(C.inCell({ lat: la, lon: lo }, wp, nb)); });
  // draw = the same household draw on the reduced list (seed, water point, B = n)
  const want = C.householdDraw('s', 'MA001', cell.keys); assert.deepEqual(cell.draw.map(d => d.key), want.map(d => d.key));
  const audited = C.auditServiceArea(cell); assert.equal(audited.household_area, 'nearestPoint1km'); assert.equal(audited.nearer_other_point, cell.nearer_other_point); assert.equal(audited.cell_neighbours, 2);
  assert.ok(!('household_area' in JSON.parse(JSON.stringify(C.auditServiceArea(circle)))));
  assert.throws(() => C.prepareServiceArea({ seed: 's', wp, features: feats, osm: { elements: [] }, rule: 'nearestPoint1km' }), /neighbouring water points/);
  // with no neighbour within 2 km the cell is the circle
  const alone = C.prepareServiceArea({ seed: 's', wp, features: feats, osm: { elements: [] }, rule: 'nearestPoint1km', neighbours: [] });
  assert.deepEqual(alone.keys, circle.keys); assert.deepEqual(alone.draw, circle.draw);
});

test('field pack carries the neighbour positions of a nearestPoint1km round and reopens', () => {
  const pts = frame('HP-MA'); const r = C.drawUsage(Object.assign(P('HP-MA', '2027_R1_Maro'), { competitors: pts }), pts);
  const auditText = JSON.stringify(r.audit, null, 2); const sha = C.sha256Sync(auditText); const v = C.roundFromAudit(r.audit);
  const ids = C.roundPositionIds(v); assert.ok(ids.length > C.roundIds(v).length);
  const pos = C.positionsFromPoints(pts, ids); C.withPositions(v, pos);
  const areas = {}; v.points.concat(v.reserves).forEach(w => { areas[w.water_point_id] = C.prepareServiceArea({ seed: v.seed, wp: w, features: grid(w, 1000), osm: { elements: [] }, rule: 'nearestPoint1km', neighbours: C.neighboursFromPositions(w, pos) }); });
  const pack = C.fieldPack({ auditText, sha, positions: pos, areas, households: {}, at: '2027-01-01T00:00:00Z' });
  const j = JSON.parse(pack); assert.deepEqual(Object.keys(j.positions).sort(), ids.slice().sort());
  j.service_areas.forEach(a => { assert.equal(a.household_area, 'nearestPoint1km'); assert.ok(a.nearer_other_point > 0); });
  const o = C.openFieldPack(pack, { audit_sha256: sha, audit_text: auditText }); assert.equal(o.ok, true, JSON.stringify(o));
  const missing = Object.assign({}, pos); delete missing[ids[ids.length - 1]];
  assert.throws(() => C.fieldPack({ auditText, sha, positions: missing, areas, households: {} }), /no position for/);
});

test('record PDF: the rule is printed for a nearestPoint1km round (en, fr) and absent from a circle round', async () => {
  if (!PDFLib) { console.log('  (pdf-lib not available: set PDFLIB_DIR) — skipped'); return; }
  const pts = frame('HP-MA'); const text = (a) => JSON.stringify(a, null, 2);
  const r = C.drawUsage(Object.assign(P('HP-MA', '2027_R1_Maro'), { competitors: pts }), pts); const t = text(r.audit);
  for (const lang of ['en', 'fr']) {
    const runs = pdfTextRuns(Buffer.from(await C.buildUsageRecordPdf({ PDFLib, audit: JSON.parse(t), auditText: t, auditSha: C.sha256Sync(t), lang, url: C.APP_URL }))).join(' ');
    assert.match(runs, lang === 'en' ? /Household area/ : /Zone des m/); assert.match(runs, /nearestPoint1km/); assert.match(runs, /v0\.5/);
    assert.ok(runs.includes(r.audit.parameters.household_area.competitors.sha256.slice(0, 20)), lang + ' competitors SHA printed');
  }
  const c = C.drawUsage(P('HP-MA', '2026_R1_Maro'), pts); const ct = text(c.audit);
  const runs = pdfTextRuns(Buffer.from(await C.buildUsageRecordPdf({ PDFLib, audit: JSON.parse(ct), auditText: ct, auditSha: C.sha256Sync(ct), lang: 'fr', url: C.APP_URL }))).join(' ');
  assert.ok(!/nearestPoint1km|Zone des m/.test(runs));
});

test('filed 2026 usage rounds (2026_R1_Maro, 2026_R1_FTU) stay under the 1 km circle and rebuild byte-identically', async () => {
  if (!EVIDENCE) { console.log('  (no SharePoint evidence folder configured) — skipped'); return; }
  for (const [dir, s] of [['2026_R1_Maro', 'HP-MA-U'], ['2026_R1_FTU', 'HP-FD-U']]) {
    const f = path.join(EVIDENCE, dir, s); const text = fs.readFileSync(path.join(f, 'audit.json'), 'utf8'); const a = JSON.parse(text);
    assert.equal(C.roundHouseholdArea(a), 'circle1km', dir); assert.equal(C.householdAreaRule(a.parameters.scenario, a.parameters.round, a.timestamp), 'circle1km', dir);
    assert.ok(!/household_area|cell_neighbours/.test(text));
    if (!PDFLib) continue;
    const pdf = fs.readFileSync(path.join(f, 'sampling-record.pdf')); const o = await C.openRecord({ pdf: new Uint8Array(pdf) });
    assert.equal(o.auditText, text, dir + ' audit attached to the filed PDF is the filed audit.json');
    const build = lang => C.buildUsageRecordPdf({ PDFLib, audit: o.audit, auditText: o.auditText, auditSha: o.sha, lang, url: C.APP_URL });
    const same = Buffer.from(await build('en')).equals(pdf) ? pdf : Buffer.from(await build('fr')); // the filed records are English
    assert.ok(Buffer.from(same).equals(pdf), dir + ' record PDF rebuilt by this version differs from the filed one');
  }
});
