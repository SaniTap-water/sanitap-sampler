// v2.9.0: field pack. One tablet prepares the households of a confirmed usage round; every other tablet opens the record PDF and then
// the pack, and gets the same water points and the same household numbers without mWater, network or a fresh building read.
// node --test test/*.test.js   (PDFLIB_DIR for the round trip through the record PDF)
const test = require('node:test'); const assert = require('node:assert/strict'); const path = require('path');
const C = require('../app.js');
let PDFLib; try { PDFLib = require(path.join(process.env.PDFLIB_DIR || '/nonexistent', 'node_modules', 'pdf-lib')); } catch (e) { PDFLib = null; }

function uframe() {
  const pts = []; const spec = { A: [5, 3, 2, 4, 1], B: [2, 2, 2, 2], C: [6, 1, 1, 1, 1, 2], D: [1, 1, 1, 1], E: [3, 3, 3, 3, 3], F: [4, 4] };
  Object.keys(spec).forEach(c => spec[c].forEach((n, fi) => { for (let i = 0; i < n; i++) pts.push({ water_point_id: c + fi + '-' + i, name: 'Canzee', stratum: 'HP-FD', commune: 'Commune ' + c, fokontany: 'Fkt ' + c + fi, lat: -25 + fi * 0.01, lon: 46.9 + i * 0.01, households_served: 0, active: true }); }));
  return pts;
}
const UP = { roundName: '2026-PACK', stratum: 'HP-FD', seed: '2026-PACK-HP-FD-U', timestamp: '2026-11-04T00:00:00.000Z', drawnBy: 'Test', frameHash: 'cd'.repeat(32) };
// a village of small squares around a point, with deterministic jitter so every service area has its own building list
function houses(wp) { const kx = 111320 * Math.cos(wp.lat * Math.PI / 180), ky = 110574; let s = 7 + Math.round(wp.lat * 1e4 + wp.lon * 1e4); const rnd = () => { s = (s * 16807) % 2147483647; if (s <= 0) s += 2147483646; return s / 2147483647; }; const out = []; for (let x = -700; x <= 700; x += 45) for (let y = -700; y <= 700; y += 45) { if (rnd() < 0.5) continue; const cx = x + (rnd() - .5) * 20, cy = y + (rnd() - .5) * 20; const sq = [[cx - 4, cy - 4], [cx + 4, cy - 4], [cx + 4, cy + 4], [cx - 4, cy + 4], [cx - 4, cy - 4]].map(([a, b]) => [wp.lon + a / kx, wp.lat + b / ky]); out.push({ geometry: { type: 'Polygon', coordinates: [sq] }, properties: { bf_source: 'google' } }); } return out; }

// tablet A: confirm the draw, take positions from its frame, prepare every service area
function tabletA() {
  const r = C.drawUsage(UP, uframe()); const a = JSON.parse(JSON.stringify(r.audit)); a.households = null; const auditText = JSON.stringify(a, null, 2); const sha = C.sha256Sync(auditText);
  const entry = C.libraryEntry({ audit: a, auditText, sha, at: '2026-11-04T01:00:00.000Z' });
  const v = C.withPositions(C.roundFromAudit(a), C.positionsFromPoints(uframe(), C.roundIds(C.roundFromAudit(a))));
  const all = v.points.concat(v.reserves); const areas = {}; const pos = {};
  all.forEach(w => { areas[w.water_point_id] = C.prepareServiceArea({ seed: v.seed, wp: w, features: houses(w), osm: { elements: [] } }); pos[w.water_point_id] = { lat: w.lat, lon: w.lon }; });
  const households = { dataset: C.USAGE.buildings.name, version: 'test', fetched_at: '2026-11-04T02:00:00.000Z', service_areas: all.map(w => C.auditServiceArea(areas[w.water_point_id])) };
  return { r, a, auditText, sha, entry, v, ids: C.roundIds(v), areas, pos, households };
}

test('field pack: tablet B gets the same water points and household numbers as tablet A, checked against the record seed', () => {
  const A = tabletA();
  const text = C.fieldPack({ auditText: A.auditText, sha: A.sha, positions: A.pos, areas: A.areas, households: A.households, at: '2026-11-04T03:00:00.000Z' });
  assert.equal(C.isFieldPackText(text), true); assert.equal(C.isFieldPackText(A.auditText), false);
  const B = C.openFieldPack(text, A.entry);
  assert.equal(B.ok, true, B.error); assert.equal(B.record_id, A.a.record_id); assert.equal(B.n, A.ids.length); assert.ok(A.ids.length >= 12);
  assert.deepEqual(Object.keys(B.areas), A.ids, 'same water points, same order');
  assert.deepEqual(C.householdSummary(B.areas, A.ids), C.householdSummary(A.areas, A.ids), 'same household numbers');
  A.ids.forEach(id => { assert.equal(B.positions[id].lat, A.pos[id].lat); assert.equal(B.areas[id].buildings_sha256, A.areas[id].buildings_sha256); assert.equal(B.areas[id].draw.length, 15); });
  // the record itself stays coordinate-free; the pack is the only carrier of positions
  assert.ok(!C.hasCoordinateKeys(JSON.parse(A.auditText))); assert.ok(C.hasCoordinateKeys(JSON.parse(text)));
});

test('field pack: refused without the record on the device, for another record, for other points, or with households that do not follow the seed', () => {
  const A = tabletA();
  const text = C.fieldPack({ auditText: A.auditText, sha: A.sha, positions: A.pos, areas: A.areas, households: A.households });
  const p = JSON.parse(text); const rid = A.a.record_id; const id0 = A.ids[0];
  assert.deepEqual(C.openFieldPack(text, null), { error: 'pack_no_round', rid });
  assert.equal(C.openFieldPack(text, Object.assign({}, A.entry, { audit_sha256: '0'.repeat(64) })).error, 'pack_other_audit');
  assert.equal(C.openFieldPack('{', A.entry).error, 'pack_not_json'); assert.equal(C.openFieldPack(A.auditText, A.entry).error, 'pack_not_pack');
  assert.equal(C.openFieldPack(JSON.stringify(Object.assign({}, p, { version: 99 })), A.entry).error, 'pack_version');
  const swapped = JSON.parse(text); [swapped.service_areas[0], swapped.service_areas[1]] = [swapped.service_areas[1], swapped.service_areas[0]];
  assert.equal(C.openFieldPack(JSON.stringify(swapped), A.entry).error, 'pack_points');
  // households changed by hand: two positions swapped, a building added, a reserve flag flipped, a moved building
  const mut = f => { const q = JSON.parse(text); f(q.service_areas[0]); return C.openFieldPack(JSON.stringify(q), A.entry); };
  assert.deepEqual(mut(a => { const d = a.draw; [d[0].key, d[1].key] = [d[1].key, d[0].key]; [d[0].lat, d[1].lat] = [d[1].lat, d[0].lat]; [d[0].lon, d[1].lon] = [d[1].lon, d[0].lon]; }), { error: 'pack_area', rid, id: id0 });
  assert.equal(mut(a => { a.keys.push('-1.000000,1.000000'); a.keys.sort(); a.buildings_kept++; }).error, 'pack_area');
  assert.equal(mut(a => { a.draw[14].reserve = false; }).error, 'pack_area');
  assert.equal(mut(a => { a.draw[0].lat += 0.001; }).error, 'pack_area');
  assert.equal(mut(a => { delete a.keys; }).error, 'pack_area');
  const nopos = JSON.parse(text); delete nopos.positions[id0]; assert.equal(C.openFieldPack(JSON.stringify(nopos), A.entry).error, 'pack_area');
  // a pack needs every service area prepared, and only a usage round has one
  const partial = Object.assign({}, A.areas); delete partial[id0];
  assert.throws(() => C.fieldPack({ auditText: A.auditText, sha: A.sha, positions: A.pos, areas: partial }), /households not prepared/);
});

test('dry run through the record PDF: confirm, open the PDF on another device, load the pack: identical water points and household numbers', async () => {
  if (!PDFLib) { console.log('  (pdf-lib not available: set PDFLIB_DIR) — skipped'); return; }
  const A = tabletA();
  const ev = await C.evidencePack({ PDFLib, auditText: A.auditText, lang: 'fr' }); assert.equal(ev.sha, A.sha);
  const o = await C.openRecord({ pdf: new Uint8Array(ev.pdf) }); assert.equal(o.ok, true, o.error); assert.equal(o.mode, 'usage');
  const entryB = C.libraryEntry({ audit: o.audit, auditText: o.auditText, sha: o.sha, at: '2026-11-04T04:00:00.000Z', origin: 'opened' });
  assert.deepEqual(C.roundIds(C.roundFromAudit(o.audit)), A.ids, 'the opened record lists the same water points in the same order');
  const text = C.fieldPack({ auditText: A.auditText, sha: A.sha, positions: A.pos, areas: A.areas, households: A.households });
  const B = C.openFieldPack(text, entryB); assert.equal(B.ok, true, B.error);
  assert.deepEqual(C.householdSummary(B.areas, A.ids), C.householdSummary(A.areas, A.ids));
});
