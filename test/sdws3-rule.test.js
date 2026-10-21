// SDWS 3 creditable rule (James Walker, 20 Oct 2026): one rule file shared with sanitap-water-report, the same verdicts on the
// shared cases, and the not-creditable points left out of every frame (SDWS 18 and SDWS 26), with nothing else in a frame changed.
const test = require('node:test'); const assert = require('node:assert/strict'); const fs = require('fs'); const path = require('path');
const C = require('../app.js');
const ROOT = path.join(__dirname, '..');
const RULE_FILE = path.join(ROOT, 'data', 'sdws3_rule.json'), CASES_FILE = path.join(ROOT, 'data', 'sdws3_rule_cases.json');
const REPORT = process.env.SANITAP_REPORT || path.join(require('os').homedir(), 'sanitap-water-report');
const R = C.SDWS3_RULE; const F = R.form; const Q = Object.fromEntries(R.fail_if.map(t => [t.key, t.q]));
const response = r => ({ _id: r.code.toLowerCase(), code: r.code, form: F.id, status: r.status || 'final', submittedOn: r.submitted || r.date + 'T10:00:00Z',
  data: Object.assign({ [F.site_q]: { value: { code: r.wp } }, [F.date_q]: { value: r.date + 'T09:00:00Z' } }, Object.fromEntries(Object.entries(r.values).map(([k, v]) => [Q[k], { value: v }]))) });

test('the embedded rule is data/sdws3_rule.json byte for byte', () => {
  assert.equal(C.SDWS3_RULE_JSON, fs.readFileSync(RULE_FILE, 'utf8'));
});

test('the rule and its cases are byte-identical to the report\'s copies (when sanitap-water-report is present)', { skip: !fs.existsSync(path.join(REPORT, 'data', 'sdws3_rule.json')) && 'sanitap-water-report not present' }, () => {
  for (const f of ['sdws3_rule.json', 'sdws3_rule_cases.json']) assert.equal(fs.readFileSync(path.join(ROOT, 'data', f), 'utf8'), fs.readFileSync(path.join(REPORT, 'data', f), 'utf8'), f);
});

test('the shared cases give the shared verdicts', () => {
  const cases = JSON.parse(fs.readFileSync(CASES_FILE, 'utf8')).cases;
  for (const c of cases) {
    const got = C.sdws3Creditable(c.results.map(response));
    const view = Object.fromEntries(Object.entries(got).map(([wp, v]) => [wp, { creditable: v.creditable, failing: v.failing.map(f => f.key).sort() }]));
    assert.deepEqual(view, c.expect, c.name);
  }
});

test('the named exception carries its reason, and the rule names its decision', () => {
  const e = R.exceptions.find(x => x.water_point === '742894851');
  assert.ok(e && e.response === 'Cathy_MadAvance-D5V5UQ' && e.ignore.join() === 'turbidity' && /data-entry slip/.test(e.reason));
  assert.match(R.decision.by, /^James Walker/);
});

// a small register: 1 clean, 2 fluoride at the kit maximum, 3 E. coli then a passing retest, 4 no result at all
const ent = (code, district) => ({ _id: 'e' + code, code, name: 'Canzee', type: 'Borehole or tubewell', admin_div2: district || 'Taolagnaro', admin_div3: 'C' + code, admin_div4: 'F' + code, location: { type: 'Point', coordinates: [47, -25] } });
const results = [
  { wp: '1', code: 'R-1', date: '2025-05-01', values: { ecoli: 0, arsenic: 0, fluoride: 0.2, turbidity: 0 } },
  { wp: '2', code: 'R-2', date: '2025-08-15', values: { ecoli: 0, arsenic: 0, fluoride: 1.5, turbidity: 0 } },
  { wp: '3', code: 'R-3a', date: '2025-08-14', values: { ecoli: 50, arsenic: 0, fluoride: 0, turbidity: 0 } },
  { wp: '3', code: 'R-3b', date: '2026-01-14', values: { ecoli: 0, arsenic: 0, fluoride: 0, turbidity: 0 } }
].map(response);
const frame = (withRule) => C.mapMwaterEntities(['1', '2', '3', '4'].map(c => ent(c)), Object.assign({ passing: C.sdws3PassingPoints(results, C.MWATER.forms.sdws3) }, withRule ? { notCreditable: C.sdws3Creditable(results) } : {}));

test('SDWS 18 frame: the fluoride point at the kit maximum is out; the retested point and the untested point keep their treatment', () => {
  const m = frame(true); const by = Object.fromEntries(m.points.map(p => [p.water_point_id, p]));
  assert.equal(by['2'].status, 'inactive'); assert.equal(by['2'].status_reason, 'not_creditable_sdws3:fluoride');
  assert.equal(by['3'].status, 'active', 'a later passing retest restores the point');
  assert.equal(by['4'].status_reason, 'no_passing_sdws3_result', 'no result: unchanged treatment');
  assert.equal(m.counts.excluded_not_creditable, 1);
});

test('SDWS 18 frame: only the not-creditable row differs from the frame without the rule', () => {
  const a = frame(false).points, b = frame(true).points;
  const diff = a.map((p, i) => JSON.stringify(p) === JSON.stringify(b[i]) ? null : p.water_point_id).filter(Boolean);
  assert.deepEqual(diff, ['2']);
  const plain = C.mapMwaterEntities(['1', '4'].map(c => ent(c)), { passing: C.sdws3PassingPoints(results, C.MWATER.forms.sdws3), notCreditable: C.sdws3Creditable(results) });
  assert.equal(plain.counts.excluded_not_creditable, undefined, 'no count key when the rule excludes nothing');
});

test('SDWS 26 frame: not-creditable rows are left out, from the CSV row itself, with and without the fleet file', () => {
  const pts = C.normaliseWaterPoints(C.parseCsv(C.frameToCsv(frame(true).points)).records).points;
  const fleet = { records: { 1: 'in_fleet', 2: 'in_fleet', 3: 'joins', 4: 'in_fleet' } };
  const uf = C.usageFrame(pts, 'HP-FD', fleet);
  assert.deepEqual(uf.points.map(p => p.water_point_id), ['1', '3', '4']); assert.equal(uf.counts.not_creditable, 1);
  assert.deepEqual(C.usageFrame(pts, 'HP-FD', null).points.map(p => p.water_point_id), ['1', '3', '4']);
  const before = C.usageFrame(C.normaliseWaterPoints(C.parseCsv(C.frameToCsv(frame(false).points)).records).points, 'HP-FD', fleet);
  assert.deepEqual(before.points.map(p => p.water_point_id), ['1', '2', '3', '4']); assert.equal(before.counts.not_creditable, undefined);
});
