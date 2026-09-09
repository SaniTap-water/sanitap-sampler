// Node tests: node --test test/mapper.test.js   (frame rule, PPS draw, audit, PDF determinism)
const test = require('node:test'); const assert = require('node:assert/strict'); const fs = require('fs'); const path = require('path');
const C = require('../app.js');
const M = C.MWATER; const SD = M.forms.sdws3;
const ent = (o) => Object.assign({ _id: 'id-' + o.code, code: o.code, name: 'Canzee', alt_id: '01', type: 'other', location: { type: 'Point', coordinates: [46.9, -25.0, 0] }, admin_region: 1, admin_div2: 'Taolagnaro', admin_div3: 'Soanierana', admin_div4: 'Ampasy', admin_div5: 'Village', _private: true }, o);
const site = code => ({ value: { code } }); const resp = (data, on, status) => ({ data, submittedOn: on || '2025-01-01', status: status || 'final' });
const q = (k) => SD.params.find(p => p.key === k).q;
const good = (code, over, status) => resp(Object.assign({ [SD.wpQ]: site(code), [SD.dateQ]: { value: '2025-03-01T10:00Z' }, [q('ecoli')]: { value: 0 }, [q('turbidity')]: { value: 1 }, [q('conductivity')]: { value: 200 }, [q('ph')]: { value: 7 }, [q('arsenic')]: { value: 2 }, [q('fluoride')]: { value: 0.3 } }, over || {}), undefined, status);

test('SDWS 3 pass rule follows the form calculations', () => {
  assert.equal(C.sdws3Pass(good('1'), SD).pass, true);
  assert.deepEqual(C.sdws3Pass(good('1', { [q('ecoli')]: { value: 3 } }), SD).failed, ['ecoli:3']);
  assert.deepEqual(C.sdws3Pass(good('1', { [q('ph')]: { value: 5.9 } }), SD).failed, ['ph:5.9']);
  assert.deepEqual(C.sdws3Pass(good('1', { [q('turbidity')]: { value: null } }), SD).failed, ['turbidity:missing']);
  assert.equal(C.sdws3Pass(good('1', { [q('iron')]: { value: 0.3 }, [q('manganese')]: { value: null } }), SD).pass, true);
  assert.deepEqual(C.sdws3Pass(good('1', { [q('iron')]: { value: 0.31 } }), SD).failed, ['iron:0.31']);
  const pp = C.sdws3PassingPoints([good('1'), good('1', { [q('ecoli')]: { value: 9 } }), good('2', {}, 'draft'), resp({ [SD.wpQ]: site('3') })], SD);
  assert.deepEqual(pp['1'], { results: 2, passes: 1, last_pass: '2025-03-01T10:00Z' }); assert.equal(pp['2'], undefined); assert.equal(pp['3'].passes, 0);
});

test('frame rule: pass, abandoned, Marolinta, unassigned, per-stratum counts, in that order', () => {
  const ents = [ent({ code: '1' }), ent({ code: '2', name: "Point d'eau abondonné" }), ent({ code: '3', admin_div2: 'Beloha', admin_div3: 'Marolinta' }), ent({ code: '4', admin_div2: 'Betroka' }), ent({ code: '5' }), ent({ code: '6', admin_div2: 'Maroantsetra' }), ent({ code: '7', admin_div2: '', admin_region: 9 })];
  const passing = C.sdws3PassingPoints(['1', '2', '3', '4', '6', '7'].map(c => good(c)), SD);
  const latest = C.mwaterLatestStatus([resp({ [M.forms.maintenance.wpQ]: site('1'), [M.forms.maintenance.statusQ]: { value: 'asVbMu3' } })], M.forms.maintenance);
  const m = C.mapMwaterEntities(ents, { passing, latest, regionsById: { 9: { full_name: 'F, C, Maroantsetra, Analanjirofo, Madagascar' } } });
  assert.deepEqual(m.counts, { total_in_group: 7, sdws3_pass_count: 6, excluded_no_pass: 1, excluded_abandoned: 1, excluded_marolinta: 1, unassigned: 1, eligible: 3, eligible_by_stratum: { 'HP-FD': 1, 'HP-MA': 2 } });
  const by = Object.fromEntries(m.points.map(p => [p.water_point_id, p]));
  assert.equal(by['5'].status_reason, 'no_passing_sdws3_result'); assert.match(by['2'].status_reason, /^abandoned:/); assert.equal(by['3'].status_reason, 'excluded_district:Beloha'); assert.equal(by['4'].stratum, 'unassigned'); assert.equal(by['7'].stratum, 'HP-MA'); assert.equal(by['1'].status, 'active'); assert.equal(by['1'].sdws3_passes, 1);
  const csv = C.frameToCsv(m.points); const n = C.normaliseWaterPoints(C.parseCsv(csv).records); assert.equal(n.errors.length, 0); assert.equal(n.points.filter(p => p.active).length, 3);
});

test('systematic PPS: proportional hits, certainty selection, no duplicates, reproducible', () => {
  const frame = [1, 2, 3, 4, 5, 6].map(i => ({ water_point_id: String(i) })); const w = [10, 10, 10, 10, 10, 100];
  const r = C.systematicPps(frame, w, 3, C.makeRng('x'));
  assert.equal(r.selected.length, 3); assert.equal(r.certainty, 1); assert.ok(r.selected.some(s => s.f.water_point_id === '6' && s.certainty));
  assert.equal(new Set(r.selected.map(s => s.f.water_point_id)).size, 3); assert.equal(r.interval, 25);
  const r2 = C.systematicPps(frame, w, 3, C.makeRng('x')); assert.deepEqual(r.selected.map(s => s.f.water_point_id), r2.selected.map(s => s.f.water_point_id));
  const hits = {}; for (let i = 0; i < 2000; i++) C.systematicPps(frame, [10, 10, 10, 10, 10, 50], 2, C.makeRng('s' + i)).selected.forEach(s => { hits[s.f.water_point_id] = (hits[s.f.water_point_id] || 0) + 1; });
  assert.ok(hits['6'] > 1500 && hits['1'] > 250 && hits['1'] < 550, JSON.stringify(hits));
});

test('draw (pps_households): field rule only, communes covered, audit carries stage-1 numbers, no token', () => {
  const ents = []; for (let i = 0; i < 40; i++) ents.push(ent({ code: String(100 + i), admin_div3: 'C' + (i % 4) }));
  const roofs = {}; ents.forEach((e, i) => { roofs[e.code] = 10 + (i % 7) * 5; }); delete roofs['100'];
  const pts = C.normaliseWaterPoints(C.parseCsv(C.frameToCsv(C.mapMwaterEntities(ents, { roofs, passing: C.sdws3PassingPoints(ents.map(e => good(e.code)), SD) }).points)).records).points;
  const base = { roundName: '2026 R1', stratum: 'HP-FD', target: 58, hhPerPoint: 5, replacementFraction: 0.2, seed: '2026R1-HP-FD', icc: 0.1, expectedPass: 0.95, confidence: '0.90', precision: 0.1, precisionType: 'relative', hhReplacements: 2, timestamp: 't', drawnBy: 'Tester', token: 'SECRET-TOKEN' };
  const a = C.draw(base, pts, []), b = C.draw(base, pts, []);
  assert.equal(a.selected.length, 12); assert.equal(a.replacements.length, 3); assert.equal(a.stats.deff, 1.4);
  assert.ok(a.selected.every(w => w.households.mode === 'rule')); assert.equal(new Set(a.selected.concat(a.replacements).map(w => w.water_point_id)).size, 15);
  assert.equal(a.audit.stage1.method, 'pps_households'); assert.equal(a.audit.stage1.imputed_count, 1); assert.ok(a.audit.stage1.interval > 0); assert.ok(a.audit.selected_clusters.length >= 3);
  assert.equal(a.audit.record_id, '2026R1-HP-FD-2026R1-HP-FD'); assert.equal(a.audit.drawn_by, 'Tester'); assert.equal(a.audit.parameters.method, 'pps_households');
  assert.equal(JSON.stringify(a.audit), JSON.stringify(b.audit)); assert.ok(!C.auditJson(a).includes('SECRET-TOKEN')); assert.ok(!C.toCsv(a).includes('SECRET-TOKEN'));
  assert.equal(a.selected.every(w => w.commune === w.cluster), true);
  const c = C.draw(Object.assign({}, base, { method: 'commune_clusters', clusterMode: 'commune', nClusters: null }), pts, []); assert.equal(c.audit.stage1.method, 'commune_clusters'); assert.equal(c.selected.length, 12);
});

test('sampling record PDF is byte-reproducible, carries the audit hash and record id, and no token', async () => {
  let PDFLib; try { PDFLib = require(path.join(process.env.PDFLIB_DIR || '/nonexistent', 'node_modules', 'pdf-lib')); } catch (e) { PDFLib = null; }
  if (!PDFLib) { console.log('  (pdf-lib not available: set PDFLIB_DIR to a folder with node_modules/pdf-lib) — skipped'); return; }
  const ents = []; for (let i = 0; i < 30; i++) ents.push(ent({ code: String(200 + i), admin_div3: 'C' + (i % 3), alt_id: 'É' + i }));
  const roofs = {}; ents.forEach((e, i) => { roofs[e.code] = 12 + i; });
  const pts = C.normaliseWaterPoints(C.parseCsv(C.frameToCsv(C.mapMwaterEntities(ents, { roofs, passing: C.sdws3PassingPoints(ents.map(e => good(e.code)), SD) }).points)).records).points;
  const p = { roundName: '2026 R1', stratum: 'HP-FD', target: 58, hhPerPoint: 5, replacementFraction: 0.2, seed: '2026R1-HP-FD', icc: 0.1, expectedPass: 0.95, confidence: '0.90', precision: 0.1, precisionType: 'relative', hhReplacements: 2, timestamp: '2026-09-09T10:00:00.000Z', drawnBy: 'A. Tester, sampler', source: 'mwater', wpFileHash: 'ab'.repeat(32), mwater: { group: M.group, forms_used: [SD.id], fetched_at: '2026-09-09T09:59:00.000Z', counts: { total_in_group: 30, sdws3_pass_count: 30, excluded_no_pass: 0, excluded_abandoned: 0, excluded_marolinta: 0, unassigned: 0, eligible: 30, eligible_by_stratum: { 'HP-FD': 30, 'HP-MA': 0 } } }, token: 'SECRET-TOKEN' };
  const r = C.draw(p, pts, []); const auditText = C.auditJson(r); const auditSha = C.sha256Sync(auditText);
  const mk = lang => C.buildSamplingRecordPdf({ PDFLib, audit: JSON.parse(auditText), auditSha, lang, url: C.APP_URL, kValues: { [r.selected[0].water_point_id]: 23 } });
  const a = Buffer.from(await mk('en')), b = Buffer.from(await mk('en')), f = Buffer.from(await mk('fr'));
  assert.ok(a.equals(b), 'two builds differ'); assert.ok(!a.equals(f));
  const txt = a.toString('latin1'); assert.ok(txt.includes('/AuditSHA256 (' + auditSha + ')')); assert.ok(txt.includes('/RecordId (' + r.audit.record_id + ')')); assert.ok(!txt.includes('SECRET-TOKEN')); assert.ok(txt.startsWith('%PDF-1.7'));
  assert.ok(a.length > 5000);
  fs.writeFileSync(path.join(require('os').tmpdir(), 'sanitap-test-record.pdf'), a);
});

test('mwaterGet puts the token in the query only and never echoes it in errors', async () => {
  const seen = []; const fetchImpl = async (u) => { seen.push(u); return { ok: false, status: 401, json: async () => ({}) }; };
  await assert.rejects(C.mwaterGet('entities/water_point', { limit: '1' }, 'tok123', fetchImpl), e => !e.message.includes('tok123') && /401/.test(e.message));
  assert.ok(seen[0].includes('client=tok123'));
});

test('mwaterLoadFrame assembles the frame with SDWS 3 pass data and counts', async () => {
  const b = M.forms.beneficiaries, mt = M.forms.maintenance;
  const replies = (u) => {
    const url = new URL(u); const p = url.pathname.replace('/v3/', ''); const f = JSON.parse(url.searchParams.get('filter') || '{}');
    if (p === 'entities/water_point') return [ent({ code: '1' }), ent({ code: '2', admin_div2: '', admin_region: 5 }), ent({ code: '3' })];
    if (p === 'admin_regions') return [{ _id: 5, full_name: 'F, Commune X, Maroantsetra, Analanjirofo, Madagascar' }];
    if (p === 'responses' && f.form === SD.id) return [good('1'), good('2'), good('3', { [q('ecoli')]: { value: 1 } })];
    if (p === 'responses' && f.form === b.id) return [resp({ [b.wpQ]: site('1'), [b.roofsQ]: { value: 12 } })];
    if (p === 'responses' && f.form === mt.id) return [resp({ [mt.wpQ]: site('2'), [mt.statusQ]: { value: 'LATrLet' } })];
    return [];
  };
  const r = await C.mwaterLoadFrame('tok', { fetchImpl: async (u) => ({ ok: true, status: 200, json: async () => replies(u) }) });
  assert.deepEqual(r.counts, { total_in_group: 3, sdws3_pass_count: 2, excluded_no_pass: 1, excluded_abandoned: 1, excluded_marolinta: 0, unassigned: 0, eligible: 1, eligible_by_stratum: { 'HP-FD': 1, 'HP-MA': 0 } });
  assert.equal(r.points[0].households_served, 12); assert.equal(r.points[1].stratum, 'HP-MA'); assert.equal(r.points[1].status, 'inactive'); assert.equal(r.formsUsed.length, 3); assert.equal(r.sdws3Responses, 3); assert.ok(!JSON.stringify(r).includes('tok'));
});
