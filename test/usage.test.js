// Usage-survey mode (SDWS 26): frame, three-stage draw, barrier clip, household draw, field slots, record.
// node --test test/*.test.js   (PDFLIB_DIR for the PDF test)
const test = require('node:test'); const assert = require('node:assert/strict'); const path = require('path');
const C = require('../app.js'); const U = C.USAGE;

// synthetic frame: 6 communes of different sizes; commune F has only 2 fokontany (forces an added commune when drawn)
function frame() {
  const pts = []; const spec = { A: [5, 3, 2, 4, 1], B: [2, 2, 2, 2], C: [6, 1, 1, 1, 1, 2], D: [1, 1, 1, 1], E: [3, 3, 3, 3, 3], F: [4, 4] };
  Object.keys(spec).forEach(c => spec[c].forEach((n, fi) => { for (let i = 0; i < n; i++) pts.push({ water_point_id: c + fi + '-' + i, name: 'Canzee', stratum: 'HP-FD', commune: 'Commune ' + c, fokontany: 'Fkt ' + c + fi, lat: -25 + fi * 0.01, lon: 46.9 + i * 0.01, households_served: 0, active: i % 3 !== 0 }); }));
  return pts;
}
const P = { roundName: '2026-DRY', stratum: 'HP-FD', seed: '2026-DRY-HP-FD-U', timestamp: '2026-09-30T00:00:00.000Z', drawnBy: 'Test', frameHash: 'ab'.repeat(32) };

test('usage draw is reproducible from seed + frame, whatever the input order', () => {
  const a = C.drawUsage(P, frame()), b = C.drawUsage(P, frame().reverse());
  assert.equal(JSON.stringify(a.audit), JSON.stringify(b.audit));
  const c = C.drawUsage(Object.assign({}, P, { seed: '2026-DRY-HP-MA-U' }), frame());
  assert.notEqual(JSON.stringify(c.audit.water_points), JSON.stringify(a.audit.water_points));
});

test('three stages: 3+ communes, 4 fokontany each (fewer only when the commune has fewer), 1 point per fokontany, 1 reserve per commune, probabilities and weights', () => {
  for (let s = 0; s < 60; s++) {
    const r = C.drawUsage(Object.assign({}, P, { seed: 'seed-' + s }), frame());
    const fok = r.communes.reduce((a, c) => a + c.fokontany_drawn.length, 0);
    assert.ok(r.communes.length >= 3); assert.ok(fok >= 12 || r.communes.length === 6, 'at least 12 fokontany unless the frame runs out');
    r.communes.forEach(c => { assert.equal(c.fokontany_drawn.length, Math.min(4, c.fokontany_in_frame)); const nres = r.reserves.filter(w => w.commune === c.name).length; if (c.points > c.fokontany_drawn.length) assert.equal(nres, 1); else { assert.equal(nres, 0); assert.ok(r.warnings.some(w => w.code === 'no_reserve' && w.commune === c.name), 'a commune with every point drawn has no reserve, and says so'); } if (c.fokontany_in_frame < 4) assert.ok(r.warnings.some(w => w.code === 'few_fokontany' && w.commune === c.name)); });
    assert.equal(r.points.length, fok); assert.equal(new Set(r.points.map(w => w.commune + '|' + w.fokontany)).size, fok, 'one point per fokontany');
    const ids = r.points.concat(r.reserves).map(w => w.water_point_id); assert.equal(new Set(ids).size, ids.length, 'no point twice');
    r.points.forEach(w => { assert.ok(Math.abs(w.pi - w.pi_commune * w.p_fokontany * w.p_point) < 1e-5); assert.ok(Math.abs(w.weight - 1 / w.pi) / w.weight < 1e-3); assert.ok(w.pi > 0 && w.pi <= 1); });
    if (r.communes.some(c => c.added)) assert.ok(r.communes.some(c => c.fokontany_in_frame < 4), 'a commune is added only after a short one');
  }
});

test('stage 1 inclusion frequencies match the recorded commune probabilities (systematic PPS on frame points)', () => {
  const hits = {}, pis = {}; const N = 3000;
  for (let s = 0; s < N; s++) { const r = C.drawUsage(Object.assign({}, P, { seed: 'mc' + s }), frame()); r.communes.filter(c => !c.added).forEach(c => { hits[c.name] = (hits[c.name] || 0) + 1; pis[c.name] = c.pi; }); }
  Object.keys(pis).forEach(c => { const f = hits[c] / N; assert.ok(Math.abs(f - pis[c]) < 0.04, c + ': frequency ' + f.toFixed(3) + ' vs pi ' + pis[c]); });
});

test('frame: carbon fleet of the scenario, broken pumps stay in, Marolinta and non-fleet points out', () => {
  const pts = [{ water_point_id: '1', stratum: 'HP-FD', active: false }, { water_point_id: '2', stratum: 'HP-FD', active: true }, { water_point_id: '3', stratum: 'HP-FD', active: true }, { water_point_id: '4', stratum: 'unassigned', active: true }, { water_point_id: '5', stratum: 'HP-MA', active: true }];
  const fleet = { records: { 1: 'in_fleet', 2: 'joins', 3: 'no_first_rehab', 4: 'in_fleet', 5: 'in_fleet' } };
  const f = C.usageFrame(pts, 'HP-FD', fleet);
  assert.deepEqual(f.points.map(p => p.water_point_id), ['1', '2'], 'broken pump 1 stays; 3 is not in the fleet');
  assert.equal(f.counts.fleet_in_group, 4); assert.equal(f.counts.not_in_fleet, 1); assert.equal(f.counts.fleet_by_stratum.unassigned, 1);
  assert.equal(C.usageFrame(pts, 'HP-FD', null).points.length, 3, 'a CSV frame is taken as it is');
});

// a water point at (-25, 47); metres -> degrees
const WP = { water_point_id: 'W', lat: -25, lon: 47 }; const kx = 111320 * Math.cos(-25 * Math.PI / 180), ky = 110574;
const at = (x, y) => [WP.lat + y / ky, WP.lon + x / kx];
const square = (x, y) => { const d = 3; const pts = [[x - d, y - d], [x + d, y - d], [x + d, y + d], [x - d, y + d], [x - d, y - d]].map(([a, b]) => { const q = at(a, b); return [q[1], q[0]]; }); return { geometry: { type: 'Polygon', coordinates: [pts] }, properties: { bf_source: 'google' } }; };
const way = (tags, pts) => ({ type: 'way', tags, geometry: pts.map(([x, y]) => { const q = at(x, y); return { lat: q[0], lon: q[1] }; }) });

test('barrier clip: a river across the circle cuts off the far side; a stream does not; a bridge within 40 m opens it', () => {
  const houses = []; for (let x = -900; x <= 900; x += 60) for (let y = -900; y <= 900; y += 60) if (x * x + y * y < 950 * 950) houses.push(square(x, y));
  const river = way({ waterway: 'river' }, [[300, -1200], [300, 1200]]);
  const none = C.prepareServiceArea({ seed: 's', wp: WP, features: houses, osm: { elements: [] } });
  const cut = C.prepareServiceArea({ seed: 's', wp: WP, features: houses, osm: { elements: [river] } });
  const east = houses.filter(h => { const c = C.footprintCentroid(h.geometry); return (c.lon - WP.lon) * kx > 310; }).length;
  assert.equal(none.buildings_kept, none.buildings_in_circle); assert.ok(east > 50);
  assert.ok(Math.abs((none.buildings_kept - cut.buildings_kept) - east) <= 3, 'the far side is removed: ' + (none.buildings_kept - cut.buildings_kept) + ' vs ' + east);
  assert.ok(cut.area_kept_pct < 85 && cut.area_kept_pct > 60); assert.deepEqual(cut.barrier_ways, { river: 1 });
  const stream = C.prepareServiceArea({ seed: 's', wp: WP, features: houses, osm: { elements: [way({ waterway: 'stream' }, [[300, -1200], [300, 1200]])] } });
  assert.equal(stream.buildings_kept, none.buildings_kept, 'a stream is not a barrier');
  const bridged = C.prepareServiceArea({ seed: 's', wp: WP, features: houses, osm: { elements: [river, way({ highway: 'track', bridge: 'yes' }, [[250, 0], [350, 0]])] } });
  assert.equal(bridged.buildings_kept, none.buildings_kept, 'the bridge makes the river crossable');
  const ford = C.prepareServiceArea({ seed: 's', wp: WP, features: houses, osm: { elements: [river, { type: 'node', tags: { ford: 'yes' }, lat: at(300, 500)[0], lon: at(300, 500)[1] }] } });
  assert.equal(ford.buildings_kept, none.buildings_kept, 'a ford makes the river crossable');
  const coast = C.prepareServiceArea({ seed: 's', wp: WP, features: houses, osm: { elements: [way({ natural: 'coastline' }, [[-2000, 400], [2000, 400]])] } });
  assert.ok(coast.buildings_kept < none.buildings_kept - 50, 'the coastline cuts');
  assert.ok(C.prepareServiceArea({ seed: 's', wp: WP, features: houses.map(h => Object.assign({}, h, { properties: { bf_source: 'microsoft' } })), osm: { elements: [] } }).buildings_kept === 0, 'only the Google layer is used');
});

test('household draw: 10 + 5 distinct buildings, reproducible, independent of the order buildings arrive in', () => {
  const houses = []; for (let x = -600; x <= 600; x += 50) for (let y = -600; y <= 600; y += 50) houses.push(square(x, y));
  const a = C.prepareServiceArea({ seed: '2026-DRY-HP-FD-U', wp: WP, features: houses, osm: { elements: [] } });
  const b = C.prepareServiceArea({ seed: '2026-DRY-HP-FD-U', wp: WP, features: houses.slice().reverse(), osm: { elements: [] } });
  assert.equal(a.draw.length, 15); assert.equal(new Set(a.draw.map(d => d.key)).size, 15); assert.deepEqual(a.draw.map(d => d.key), b.draw.map(d => d.key)); assert.equal(a.buildings_sha256, b.buildings_sha256);
  assert.deepEqual(a.draw.map(d => d.reserve), Array(10).fill(false).concat(Array(5).fill(true)));
  const audited = C.auditServiceArea(a); assert.ok(!C.hasCoordinateKeys(audited)); assert.ok(!JSON.stringify(audited).includes(String(WP.lat)));
  const few = C.prepareServiceArea({ seed: 's', wp: WP, features: houses.slice(0, 7), osm: { elements: [] } }); assert.equal(few.short, true); assert.ok(few.draw.length <= 7);
});

test('field slots: reserves strictly in order, nobody home closes after 3 visits, done at 10 interviews', () => {
  const draw = Array.from({ length: 15 }, (_, i) => ({ position: i + 1, reserve: i >= 10 }));
  let s = C.fieldSlots(draw, []); assert.equal(s.next.position, 1); assert.equal(s.active.length, 10);
  const log = [{ position: 1, outcome: 'refused' }];
  s = C.fieldSlots(draw, log); assert.equal(s.active.length, 11); assert.ok(s.active.some(x => x.position === 11)); assert.equal(s.next.position, 2);
  log.push({ position: 2, outcome: 'nobody_home' }, { position: 2, outcome: 'nobody_home' }); s = C.fieldSlots(draw, log); assert.equal(s.active.length, 11, 'two visits do not close'); assert.equal(s.next.position, 3);
  log.push({ position: 2, outcome: 'nobody_home' }); s = C.fieldSlots(draw, log); assert.equal(s.active.length, 12, 'the third visit closes and opens R2'); assert.ok(s.active.some(x => x.position === 12));
  for (let p = 3; p <= 12; p++) log.push({ position: p, outcome: 'interviewed' }); s = C.fieldSlots(draw, log); assert.equal(s.interviewed, 10); assert.equal(s.done, true); assert.equal(s.next, null);
  const csv = C.outcomeLogCsv('R-1', log.map((e, i) => Object.assign({ water_point_id: 'W', at: '2026-10-01T08:0' + (i % 10) + ':00Z' }, e)));
  assert.ok(csv.startsWith('record_id,water_point_id,draw_position,role,outcome,visit,recorded_at,team')); assert.ok(csv.includes('reserve R2')); assert.ok(!/lat|lon/i.test(csv.split('\r\n')[0]));
});

test('usage sampling record PDF: deterministic, carries seed, frame hash, probabilities, building counts, no coordinates', async () => {
  let PDFLib; try { PDFLib = require(path.join(process.env.PDFLIB_DIR || '/nonexistent', 'node_modules', 'pdf-lib')); } catch (e) { PDFLib = null; }
  if (!PDFLib) { console.log('  (pdf-lib not available: set PDFLIB_DIR) — skipped'); return; }
  const r = C.drawUsage(P, frame());
  const houses = []; for (let x = -600; x <= 600; x += 50) for (let y = -600; y <= 600; y += 50) houses.push(square(x, y));
  const sa = C.prepareServiceArea({ seed: P.seed, wp: Object.assign({}, WP, { water_point_id: r.points[0].water_point_id }), features: houses, osm: { elements: [] } });
  r.audit.households = { dataset: U.buildings.name, version: 'test', service_areas: [C.auditServiceArea(sa)] };
  assert.ok(!C.hasCoordinateKeys(r.audit), 'the audit carries no coordinates');
  const text = JSON.stringify(r.audit, null, 2); const sha = C.sha256Sync(text);
  const mk = lang => C.buildUsageRecordPdf({ PDFLib, audit: JSON.parse(text), auditText: text, auditSha: sha, lang, url: C.APP_URL });
  const a = Buffer.from(await mk('en')), b = Buffer.from(await mk('en')); assert.ok(a.equals(b)); assert.ok(!a.equals(Buffer.from(await mk('fr'))));
  const t = a.toString('latin1'); assert.ok(t.includes('/Seed (' + P.seed + ')')); assert.ok(t.includes('/FrameSHA256 (' + P.frameHash + ')')); assert.ok(t.includes('/Mode (usage_sdws26)'));
  assert.ok(!/-25\.0\d|46\.9\d/.test(t), 'no coordinate in the PDF text');
  const F = require('../bin/file-round.js'); assert.equal(F.extractAudit(a), text, 'the audit round-trips from the PDF');
});
