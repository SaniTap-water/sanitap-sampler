// Node tests for the mWater frame mapper: node --test test/
const test = require('node:test'); const assert = require('node:assert/strict');
const C = require('../app.js');
const M = C.MWATER;
const ent = (o) => Object.assign({ _id: 'id-' + o.code, code: o.code, name: 'Canzee', alt_id: '01', type: 'other', location: { type: 'Point', coordinates: [46.9, -25.0, 0] }, admin_region: 1, admin_div2: 'Taolagnaro', admin_div3: 'Soanierana', admin_div4: 'Ampasy', admin_div5: 'Village', _private: true }, o);
const resp = (data, on, status) => ({ data, submittedOn: on, status: status || 'final' });
const site = code => ({ value: { code } });

test('stratum from district name, with admin_region fallback and unknown districts', () => {
  assert.equal(C.mwaterStratum('Taolagnaro', M.strata), 'FD');
  assert.equal(C.mwaterStratum('maroantsetra', M.strata), 'MA');
  assert.equal(C.mwaterStratum('Amboasary Sud', M.strata), 'AM');
  assert.equal(C.mwaterStratum('', M.strata), '');
  assert.equal(C.mwaterStratum('Mananara Nord', M.strata), 'MANANARA-NOR');
  assert.deepEqual(C.regionParts({ full_name: 'Magnarena, Mandiso, Taolagnaro, Anosy, Madagascar' }), { fokontany: 'Magnarena', commune: 'Mandiso', district: 'Taolagnaro' });
  const m = C.mapMwaterEntities([ent({ code: '1', admin_div2: '', admin_div3: '', admin_div4: '', admin_region: 418284 })], { regionsById: { 418284: { full_name: 'Magnarena, Mandiso, Taolagnaro, Anosy, Madagascar' } } });
  assert.equal(m.points[0].stratum, 'FD'); assert.equal(m.points[0].commune, 'Mandiso'); assert.equal(m.points[0].fokontany, 'Magnarena');
});

test('active/inactive rules: name, latest maintenance status, type', () => {
  const mt = M.forms.maintenance;
  const rr = [resp({ [mt.wpQ]: site('2'), [mt.statusQ]: { value: 'asVbMu3' } }, '2024-01-01'), resp({ [mt.wpQ]: site('2'), [mt.statusQ]: { value: 'LATrLet' }, [mt.pumpQ]: { value: 'mQmlpWT' } }, '2025-06-01'), resp({ [mt.wpQ]: site('3'), [mt.statusQ]: { value: 'LATrLet' } }, '2025-06-01', 'draft'), resp({ [mt.wpQ]: site('3'), [mt.status2Q]: { value: 'asVbMu3' } }, '2025-07-01')];
  const latest = C.mwaterLatestStatus(rr, mt);
  assert.equal(latest['2'].status, 'not_functional'); assert.equal(latest['2'].pump, 'IndiaMark'); assert.equal(latest['3'].status, 'functional');
  const m = C.mapMwaterEntities([ent({ code: '1', name: "Point d'eau abondonné" }), ent({ code: '2' }), ent({ code: '3' }), ent({ code: '4', type: 'kiosk' }), ent({ code: '5', name: 'Drilling' })], { latest });
  assert.deepEqual(m.points.map(p => p.status), ['inactive', 'inactive', 'active', 'inactive', 'inactive']);
  assert.match(m.points[1].status_reason, /^maintenance:not_functional@2025-06-01/);
  assert.equal(m.counts.active, 1); assert.equal(m.counts.byStratum.FD.total, 5);
});

test('households served from the beneficiaries form (latest wins) and household links deduplicated across forms', () => {
  const b = M.forms.beneficiaries;
  const roofs = C.mwaterRoofs([resp({ [b.wpQ]: site('1'), [b.roofsQ]: { value: 10 } }, '2024-01-01'), resp({ [b.wpQ]: site('1'), [b.roofsQ]: { value: 34.5 } }, '2025-01-01')], b);
  assert.equal(roofs['1'], 34.5);
  assert.equal(C.mapMwaterEntities([ent({ code: '1' })], { roofs }).points[0].households_served, 35);
  const [r1, r2] = M.forms.registration;
  const links = C.mwaterHouseholdLinks([{ cfg: r1, responses: [resp({ [r1.wpQ]: site('1'), [r1.hhQ]: site('h2') }), resp({ [r1.wpQ]: site('1'), [r1.hhQ]: site('h1') }), resp({ [r1.wpQ]: site('1'), [r1.hhQ]: site('h9') }, null, 'draft')] }, { cfg: r2, responses: [resp({ [r2.wpQ]: site('1'), [r2.hhQ]: site('h1') }), resp({ [r2.wpQ]: site('2'), [r2.hhQ]: site('h3') })] }]);
  assert.deepEqual(Object.keys(links), ['1', '2']);
  assert.deepEqual(links['1'].map(h => h.household_id), ['h1', 'h2']);
  assert.equal(links['1'][0].source, r1.name);
  const csv = C.householdsToCsv(links, { h1: { name: 'Rasoa', location: { coordinates: [47, -25] } } });
  const hh = C.normaliseHouseholds(C.parseCsv(csv).records);
  assert.equal(hh['1'].length, 2); assert.equal(hh['1'][0].name_or_code, 'Rasoa'); assert.equal(hh['1'][0].lat, -25);
});

test('frame CSV is deterministic, round-trips through the CSV parser and hashes identically', () => {
  const ents = [ent({ code: '20' }), ent({ code: '10', name: 'IndiaMark', alt_id: '7' })];
  const a = C.frameToCsv(C.mapMwaterEntities(ents).points), b = C.frameToCsv(C.mapMwaterEntities(ents.slice().reverse()).points);
  assert.equal(a, b); assert.equal(C.sha256Sync(a), C.sha256Sync(b));
  assert.equal(a.split('\r\n')[0], C.FRAME_COLUMNS.join(','));
  const n = C.normaliseWaterPoints(C.parseCsv(a).records);
  assert.equal(n.errors.length, 0); assert.equal(n.points[0].water_point_id, '10'); assert.equal(n.points[0].name, 'IndiaMark 7'); assert.equal(n.points[0].lat, -25); assert.ok(n.points[0].active);
});

test('audit record carries the source but never the token; the draw is identical for csv and mwater sources of the same frame', () => {
  const ents = []; for (let i = 0; i < 30; i++) ents.push(ent({ code: String(100 + i), admin_div3: 'C' + (i % 4) }));
  const pts = C.normaliseWaterPoints(C.parseCsv(C.frameToCsv(C.mapMwaterEntities(ents).points)).records).points;
  const base = { roundName: '2026 R1', stratum: 'FD', target: 20, hhPerPoint: 5, nClusters: null, replacementFraction: 0.2, seed: '2026R1-FD', clusterMode: 'commune', icc: 0.1, expectedPass: 0.95, confidence: '0.90', precision: 0.1, precisionType: 'relative', hhReplacements: 2, timestamp: 't' };
  const token = 'SECRET-TOKEN-1234';
  const a = C.draw(Object.assign({}, base, { source: 'mwater', mwater: { api: M.api, group: M.group, fetched_at: 't' }, token }), pts, {}, []);
  const b = C.draw(Object.assign({}, base, { source: 'csv' }), pts, {}, []);
  assert.equal(a.audit.input.source, 'mwater'); assert.equal(a.audit.input.mwater.group, M.group); assert.equal(b.audit.input.source, 'csv'); assert.equal(b.audit.input.mwater, null);
  assert.deepEqual(a.selected.map(w => w.water_point_id), b.selected.map(w => w.water_point_id));
  assert.ok(!C.auditJson(a).includes(token)); assert.ok(!C.toCsv(a).includes(token));
});

test('mwaterGet puts the token in the query only and never echoes it in errors', async () => {
  const seen = []; const fetchImpl = async (u) => { seen.push(u); return { ok: false, status: 401, json: async () => ({}) }; };
  await assert.rejects(C.mwaterGet('entities/water_point', { limit: '1' }, 'tok123', fetchImpl), e => !e.message.includes('tok123') && /401/.test(e.message));
  assert.ok(seen[0].includes('client=tok123') && seen[0].startsWith(M.api + '/entities/water_point?'));
});

test('mwaterLoadFrame assembles frame, households and metadata from paged replies', async () => {
  const b = M.forms.beneficiaries, mt = M.forms.maintenance, r1 = M.forms.registration[0];
  const replies = (u) => {
    const url = new URL(u); const p = url.pathname.replace('/v3/', ''); const f = JSON.parse(url.searchParams.get('filter') || '{}');
    if (p === 'entities/water_point') return [ent({ code: '1' }), ent({ code: '2', admin_div2: '', admin_region: 5 })];
    if (p === 'admin_regions') return [{ _id: 5, full_name: 'F, Commune X, Maroantsetra, Analanjirofo, Madagascar' }];
    if (p === 'responses' && f.form === b.id) return [resp({ [b.wpQ]: site('1'), [b.roofsQ]: { value: 12 } }, '2025-01-01')];
    if (p === 'responses' && f.form === mt.id) return [resp({ [mt.wpQ]: site('2'), [mt.statusQ]: { value: 'LATrLet' } }, '2025-01-01')];
    if (p === 'responses' && f.form === r1.id) return [resp({ [r1.wpQ]: site('1'), [r1.hhQ]: site('h1') })];
    if (p === 'responses') return [];
    if (p === 'entities/household') return [{ code: 'h1', name: 'Hh One', location: { coordinates: [46, -25] } }];
    throw new Error('unexpected ' + p);
  };
  const fetchImpl = async (u) => ({ ok: true, status: 200, json: async () => replies(u) });
  const r = await C.mwaterLoadFrame('tok', { fetchImpl });
  assert.equal(r.counts.fetched, 2); assert.equal(r.counts.active, 1);
  const pts = r.points; assert.equal(pts[0].households_served, 12); assert.equal(pts[1].stratum, 'MA'); assert.equal(pts[1].status, 'inactive');
  assert.ok(r.householdsCsv.includes('h1,1,Hh One,-25,46,' + r1.name)); assert.equal(r.formsUsed.length, 5); assert.ok(!JSON.stringify(r).includes('tok'));
});
