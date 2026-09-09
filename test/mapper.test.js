// Node tests: node --test test/mapper.test.js   (frame rule, PPS draw, audit, PDF determinism)
const test = require('node:test'); const assert = require('node:assert/strict'); const fs = require('fs'); const path = require('path');
const C = require('../app.js');
const M = C.MWATER; const SD = M.forms.sdws3;
const ent = (o) => Object.assign({ _id: 'id-' + o.code, code: o.code, name: 'Canzee', alt_id: '01', type: 'other', location: { type: 'Point', coordinates: [46.9, -25.0, 0] }, admin_region: 1, admin_div2: 'Taolagnaro', admin_div3: 'Soanierana', admin_div4: 'Ampasy', admin_div5: 'Village', _private: true }, o);
const site = code => ({ value: { code } }); const resp = (data, on, status) => ({ data, submittedOn: on || '2025-01-01', status: status || 'final' });
const q = (k) => SD.params.find(p => p.key === k).q;
const good = (code, over, status) => resp(Object.assign({ [SD.wpQ]: site(code), [SD.dateQ]: { value: '2025-03-01T10:00Z' }, [q('ecoli')]: { value: 0 }, [q('arsenic')]: { value: 2 }, [q('fluoride')]: { value: 0.3 } }, over || {}), undefined, status);

test('SDWS 3 health-based pass rule: E. coli, arsenic, fluoride required; nitrate/manganese only when measured; pH/turbidity/iron never exclude', () => {
  assert.equal(C.sdws3Pass(good('1'), SD).pass, true);
  assert.deepEqual(C.sdws3Pass(good('1', { [q('ecoli')]: { value: 3 } }), SD).failed, ['ecoli:3']);
  assert.deepEqual(C.sdws3Pass(good('1', { [q('arsenic')]: { value: 11 } }), SD).failed, ['arsenic:11']);
  assert.deepEqual(C.sdws3Pass(good('1', { [q('fluoride')]: { value: null } }), SD).failed, ['fluoride:missing']);
  assert.equal(C.sdws3Pass(good('1', { [q('manganese')]: { value: 0.08 } }), SD).pass, true);
  assert.deepEqual(C.sdws3Pass(good('1', { [q('manganese')]: { value: 0.09 } }), SD).failed, ['manganese:0.09']);
  assert.equal(C.sdws3Pass(good('1', { '5eaf270dfe27443ebd33da195b9b89c9': { value: 5 }, 'c70eb0f3cf764b04a26a2bc463a8ca2e': { value: 40 }, '3ba8917797a7429aa31b69023c7f3c1f': { value: 2 } }), SD).pass, true, 'pH, turbidity, iron must not exclude');
  assert.equal(SD.params.find(p => p.key === 'nitrate').q, null, 'nitrate has no question yet and is skipped');
  const pp = C.sdws3PassingPoints([good('1'), good('1', { [q('ecoli')]: { value: 9 }, [SD.dateQ]: { value: '2025-05-01T10:00Z' } }), good('2', {}, 'draft'), resp({ [SD.wpQ]: site('3'), [q('ecoli')]: { value: 0 } })], SD);
  assert.deepEqual(pp['1'], { results: 2, passes: 1, last_pass: '2025-03-01T10:00Z', last_test: '2025-05-01T10:00Z', failing: ['ecoli'], last_result: 'fail:ecoli' }); assert.equal(pp['2'], undefined); assert.deepEqual(pp['3'].failing, ['arsenic:missing', 'fluoride:missing']);
});

test('frame rule: pass, abandoned, Marolinta, unassigned, per-stratum counts, in that order', () => {
  const ents = [ent({ code: '1' }), ent({ code: '2', name: "Point d'eau abondonné" }), ent({ code: '3', admin_div2: 'Beloha', admin_div3: 'Marolinta' }), ent({ code: '4', admin_div2: 'Betroka' }), ent({ code: '5' }), ent({ code: '6', admin_div2: 'Maroantsetra' }), ent({ code: '7', admin_div2: '', admin_region: 9 }), ent({ code: '8', admin_div2: 'Amboasary-Atsimo', admin_div3: 'Ifotaka' })];
  const passing = C.sdws3PassingPoints(['1', '2', '3', '4', '6', '7', '8'].map(c => good(c)), SD);
  const latest = C.mwaterLatestStatus([resp({ [M.forms.maintenance.wpQ]: site('1'), [M.forms.maintenance.statusQ]: { value: 'asVbMu3' } })], M.forms.maintenance);
  const m = C.mapMwaterEntities(ents, { passing, latest, regionsById: { 9: { full_name: 'F, C, Maroantsetra, Analanjirofo, Madagascar' } } });
  assert.deepEqual(m.counts, { total_in_group: 8, sdws3_pass_count: 7, excluded_no_pass: 1, excluded_abandoned: 1, excluded_marolinta: 1, unassigned: 1, eligible: 4, eligible_by_stratum: { 'HP-FD': 2, 'HP-MA': 2 } });
  const by = Object.fromEntries(m.points.map(p => [p.water_point_id, p]));
  assert.equal(by['5'].status_reason, 'no_passing_sdws3_result'); assert.match(by['2'].status_reason, /^abandoned:/); assert.equal(by['3'].status_reason, 'excluded_district:Beloha'); assert.equal(by['4'].stratum, 'unassigned'); assert.equal(by['8'].stratum, 'HP-FD'); assert.equal(by['8'].status, 'active'); assert.equal(by['7'].stratum, 'HP-MA'); assert.equal(by['1'].status, 'active'); assert.equal(by['1'].sdws3_passes, 1); assert.equal(by['1'].alt_id, '01');
  const csv = C.frameToCsv(m.points); const n = C.normaliseWaterPoints(C.parseCsv(csv).records); assert.equal(n.errors.length, 0); assert.equal(n.points.filter(p => p.active).length, 4);
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
  const a = C.draw(base, pts), b = C.draw(base, pts);
  assert.equal(a.selected.length, 12); assert.equal(a.replacements.length, 3); assert.equal(a.stats.deff, 1.4);
  assert.ok(a.selected.every(w => w.households.mode === 'rule')); assert.equal(new Set(a.selected.concat(a.replacements).map(w => w.water_point_id)).size, 15);
  assert.equal(a.audit.stage1.method, 'pps_households'); assert.equal(a.audit.stage1.imputed_count, 1); assert.ok(a.audit.stage1.interval > 0); assert.ok(a.audit.selected_clusters.length >= 3);
  assert.equal(a.audit.record_id, '2026R1-HP-FD-2026R1-HP-FD'); assert.equal(a.audit.drawn_by, 'Tester'); assert.equal(a.audit.protocol_version, C.PROTOCOL_VERSION); assert.match(a.audit.methodology, /Protocol v2\.2 section 6\.4/); assert.equal(a.audit.parameters.method, 'pps_households');
  assert.equal(JSON.stringify(a.audit), JSON.stringify(b.audit)); assert.ok(!C.auditJson(a).includes('SECRET-TOKEN')); assert.ok(!C.toCsv(a).includes('SECRET-TOKEN'));
  assert.equal(a.selected.every(w => w.commune === w.cluster), true);
  assert.equal(C.draw(Object.assign({}, base, { method: 'commune_clusters' }), pts).audit.parameters.method, 'pps_households', 'only one method exists');
  assert.ok(a.audit.reach_check && a.audit.reach_check.threshold_km === C.REACH_KM && a.audit.reach_check.sources.length === 12); assert.ok(!('axes' in a.audit.input)); assert.ok(!('cluster_mode' in a.audit.parameters));
});

test('sampling record PDF is byte-reproducible, carries the audit hash and record id, and no token', async () => {
  let PDFLib; try { PDFLib = require(path.join(process.env.PDFLIB_DIR || '/nonexistent', 'node_modules', 'pdf-lib')); } catch (e) { PDFLib = null; }
  if (!PDFLib) { console.log('  (pdf-lib not available: set PDFLIB_DIR to a folder with node_modules/pdf-lib) — skipped'); return; }
  const ents = []; for (let i = 0; i < 30; i++) ents.push(ent({ code: String(200 + i), admin_div3: 'C' + (i % 3), alt_id: 'É' + i }));
  const roofs = {}; ents.forEach((e, i) => { roofs[e.code] = 12 + i; });
  const pts = C.normaliseWaterPoints(C.parseCsv(C.frameToCsv(C.mapMwaterEntities(ents, { roofs, passing: C.sdws3PassingPoints(ents.map(e => good(e.code)), SD) }).points)).records).points;
  const p = { roundName: '2026 R1', stratum: 'HP-FD', target: 58, hhPerPoint: 5, replacementFraction: 0.2, seed: '2026R1-HP-FD', icc: 0.1, expectedPass: 0.95, confidence: '0.90', precision: 0.1, precisionType: 'relative', hhReplacements: 2, timestamp: '2026-09-09T10:00:00.000Z', drawnBy: 'A. Tester, sampler', source: 'mwater', wpFileHash: 'ab'.repeat(32), mwater: { group: M.group, forms_used: [SD.id], fetched_at: '2026-09-09T09:59:00.000Z', counts: { total_in_group: 30, sdws3_pass_count: 30, excluded_no_pass: 0, excluded_abandoned: 0, excluded_marolinta: 0, unassigned: 0, eligible: 30, eligible_by_stratum: { 'HP-FD': 30, 'HP-MA': 0 } } }, token: 'SECRET-TOKEN' };
  const r = C.draw(p, pts); const auditText = C.auditJson(r); const auditSha = C.sha256Sync(auditText);
  const mk = lang => C.buildSamplingRecordPdf({ PDFLib, audit: JSON.parse(auditText), auditSha, lang, url: C.APP_URL, kValues: { [r.selected[0].water_point_id]: 23 } });
  const a = Buffer.from(await mk('en')), b = Buffer.from(await mk('en')), f = Buffer.from(await mk('fr'));
  assert.ok(a.equals(b), 'two builds differ'); assert.ok(!a.equals(f));
  const txt = a.toString('latin1'); assert.ok(txt.includes('/AuditSHA256 (' + auditSha + ')')); assert.ok(txt.includes('/RecordId (' + r.audit.record_id + ')')); assert.ok(!txt.includes('SECRET-TOKEN')); assert.ok(txt.startsWith('%PDF-1.7'));
  assert.ok(a.length > 5000);
  fs.writeFileSync(path.join(require('os').tmpdir(), 'sanitap-test-record.pdf'), a);
});

test('published record files never carry coordinates: audit JSON, selection CSV, PDF text, and every file under records/', async () => {
  const ents = []; for (let i = 0; i < 20; i++) ents.push(ent({ code: String(300 + i) }));
  const pts = C.normaliseWaterPoints(C.parseCsv(C.frameToCsv(C.mapMwaterEntities(ents, { passing: C.sdws3PassingPoints(ents.map(e => good(e.code)), SD) }).points)).records).points;
  const r = C.draw({ roundName: 'R', stratum: 'HP-FD', target: 20, hhPerPoint: 5, replacementFraction: 0.2, seed: 's', icc: 0.1, expectedPass: 0.95, confidence: '0.90', precision: 0.1, precisionType: 'relative', hhReplacements: 2, timestamp: 't' }, pts);
  assert.ok(pts[0].lat === -25, 'frame itself keeps coordinates for the map');
  assert.equal(C.hasCoordinateKeys(JSON.parse(C.auditJson(r))), false, 'reach check keeps distances only');
  assert.ok(!/lat|lon/i.test(C.toCsv(r).split('\r\n')[0]));
  const dir = path.join(__dirname, '..', 'records'); const bad = [];
  const scanText = (txt, f) => { if (/(^|[,;])\s*(lat|lon|lng|latitude|longitude)\s*([,;]|$)/im.test(txt) || /-2[0-9]\.\d{4,}/.test(txt)) bad.push(f); };
  (function walk(d) { if (!fs.existsSync(d)) return; fs.readdirSync(d).forEach(n => { const f = path.join(d, n); if (fs.statSync(f).isDirectory()) return walk(f); if (n.endsWith('.json')) { if (C.hasCoordinateKeys(JSON.parse(fs.readFileSync(f, 'utf8')))) bad.push(f); } else if (n.endsWith('.csv') || n.endsWith('.md')) scanText(fs.readFileSync(f, 'utf8'), f); else if (n.endsWith('.pdf')) { const raw = fs.readFileSync(f); const b = raw.toString('latin1'); const zlib = require('zlib'); let runs = []; const re = /stream\r?\n/g; let m; while ((m = re.exec(b))) { const end = b.indexOf('endstream', m.index); let chunk = raw.subarray(m.index + m[0].length, end); try { chunk = zlib.inflateSync(chunk); } catch (e) { } const txt = chunk.toString('latin1'); (txt.match(/<([0-9A-Fa-f]+)> Tj/g) || []).forEach(h => runs.push(Buffer.from(h.slice(1, -4), 'hex').toString('latin1'))); } assert.ok(runs.length > 50, 'PDF text could not be extracted from ' + f); scanText(runs.join('\n'), f); if (/\/(Lat|Lon|GPS)/.test(b)) bad.push(f); } }); })(dir);
  assert.deepEqual(bad, [], 'files under records/ with coordinate fields: ' + bad.join(', '));
});

test('mapper on real mWater document shapes (scrubbed fixture): counts, flags and backlog groups', () => {
  const fx = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'mwater-shape.json'), 'utf8'));
  assert.ok(fx.entities.every(e => !e.location || e.location.coordinates.every(c => c === 0)), 'fixture must carry no real coordinates');
  const passing = C.sdws3PassingPoints(fx.sdws3, SD), latest = C.mwaterLatestStatus(fx.maintenance, M.forms.maintenance), roofs = C.mwaterRoofs(fx.beneficiaries, M.forms.beneficiaries);
  const m = C.mapMwaterEntities(fx.entities, { passing, latest, roofs, regionsById: Object.fromEntries(fx.regions.map(r => [r._id, r])) });
  assert.equal(m.counts.total_in_group, fx.entities.length); assert.equal(m.counts.sdws3_pass_count, m.points.filter(p => p.sdws3_passes > 0).length); assert.equal(m.counts.eligible, m.points.filter(p => p.status === 'active').length);
  const by = Object.fromEntries(m.points.map(p => [p.name_pattern + '/' + p.district, p]));
  const canzeeFD = m.points.find(p => p.stratum === 'HP-FD' && p.status === 'active'); assert.ok(canzeeFD, 'a passing Taolagnaro Canzee is eligible'); assert.equal(canzeeFD.has_rehab_record, 'Y'); assert.ok(canzeeFD.households_served > 0); assert.equal(canzeeFD.sdws3_last_result, 'pass');
  const failing = m.points.find(p => p.sdws3_results > 0 && p.sdws3_passes === 0); assert.ok(failing); assert.match(failing.sdws3_last_result, /^fail:/); assert.equal(failing.status_reason, 'no_passing_sdws3_result');
  assert.equal(by['abandonné/Taolagnaro'].abandoned, 'Y'); const identCode = by['identifié/Taolagnaro'].water_point_id; const identLatest = latest[identCode] || {}; assert.equal(by['identifié/Taolagnaro'].abandoned, identLatest.status === 'not_functional' ? 'Y' : 'N', 'identified-only points are abandoned only when maintenance says not functional'); assert.equal(by['identifié/Taolagnaro'].status, 'inactive');
  const beloha = m.points.find(p => p.district === 'Beloha'); assert.equal(beloha.stratum, 'unassigned');
  const noDiv = m.points.find(p => p.district && !fx.entities.find(e => e.code === p.water_point_id).admin_div2); assert.ok(noDiv, 'district resolved from admin_region hierarchy');
  // frame CSV round trip keeps the backlog fields, and the backlog groups are consistent with the flags
  const pts = C.normaliseWaterPoints(C.parseCsv(C.frameToCsv(m.points)).records).points;
  ['HP-FD', 'HP-MA'].forEach(s => { const g = C.backlog(pts, s); const all = g.operating.concat(g.failing, g.notBuilt, g.other); assert.ok(all.every(p => p.stratum === s && !(p.sdws3_passes > 0) && p.abandoned !== 'Y')); assert.ok(g.failing.every(p => p.sdws3_results > 0)); assert.ok(g.operating.every(p => p.has_records === 'Y' && !(p.sdws3_results > 0))); assert.ok(g.notBuilt.every(p => /identifié|drilling/.test(p.name_pattern) && p.has_records !== 'Y')); });
  const fd = C.backlog(pts, 'HP-FD'); assert.equal(fd.failing.length + fd.operating.length + fd.notBuilt.length + fd.other.length, pts.filter(p => p.stratum === 'HP-FD' && p.abandoned !== 'Y' && !(p.sdws3_passes > 0)).length);
});

test('reach check flags a source farther than 25 km from every other selected source and from the town; nothing is replaced', () => {
  const sel = [{ water_point_id: 'a', lat: -25.0, lon: 46.9 }, { water_point_id: 'b', lat: -25.05, lon: 46.95 }, { water_point_id: 'c', lat: -24.3, lon: 47.3 }, { water_point_id: 'd', lat: 'x', lon: 'y' }];
  const r = C.reachCheck(sel, M.strata['HP-FD'].town);
  const by = Object.fromEntries(r.map(x => [x.water_point_id, x]));
  assert.equal(by.a.far, false); assert.equal(by.b.far, false); assert.equal(by.c.far, true); assert.ok(by.c.nearest_km > 25 && by.c.town_km > 25); assert.equal(by.d.far, false); assert.equal(by.d.nearest_km, null);
  assert.equal(r.length, 4, 'no source is removed or replaced');
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
