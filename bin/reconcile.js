#!/usr/bin/env node
/* SDWS 3 / crediting reconciliation: one row per water point of the MadAvance group. No coordinates are written.
 * Output: /mnt/c/Users/bushp/Downloads/sdws3_reconciliation.csv (Windows Downloads) or ~/Downloads when that folder is absent; --out overrides.
 * Credentials: MWATER_TOKEN, or MWATER_USERNAME + MWATER_PASSWORD in the environment, or --env <file> (KEY=VALUE lines, e.g. ~/mwater-mcp/.env).
 * Nothing is written to the repository. Usage: node bin/reconcile.js [--env file] [--out file] [--md file] */
'use strict';
const fs = require('fs'), path = require('path'), os = require('os');
const C = require(path.join(__dirname, '..', 'app.js')); const M = C.MWATER;
const args = {}; for (let i = 2; i < process.argv.length; i++) { const a = process.argv[i]; if (a.startsWith('--')) args[a.slice(2)] = process.argv[++i]; }
if (args.env) for (const line of fs.readFileSync(args.env, 'utf8').split(/\r?\n/)) { const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line); if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); }
const REHAB_PROGRESS_FORM = '8764843c94484f5b984078c68f13b2ca'; // "Suivi avancement nouveau forage et réhabilitation"
const OUTSIDE = M.excludedDistricts.districts.map(d => d.toLowerCase());
const loc = v => typeof v === 'object' && v ? (v.fr || v.en || v._base || '') : String(v || '');
const day = v => String(v || '').slice(0, 10);
const namePattern = n => /identifi/i.test(n || '') ? 'identifié' : /drilling|proposal/i.test(n || '') ? 'drilling' : /ab[ao]ndonn/i.test(n || '') ? 'abandonné' : 'normal';
(async () => {
  let token = process.env.MWATER_TOKEN;
  if (!token) { if (!process.env.MWATER_USERNAME || !process.env.MWATER_PASSWORD) { console.error('Set MWATER_TOKEN, or MWATER_USERNAME and MWATER_PASSWORD, or pass --env <file>'); process.exit(1); } token = (await C.mwaterLogin(process.env.MWATER_USERNAME, process.env.MWATER_PASSWORD)).token; }
  const warns = []; const prog = (w, n) => { if (w === 'warn') warns.push(n); };
  const r = await C.mwaterLoadFrame(token, { onProgress: prog });
  // rehabilitation records: maintenance form with work type "Première réhabilitation" (+ end-of-works date) and the rehab progress form
  const mt = M.forms.maintenance;
  const mResp = await C.mwaterPages('responses', { form: mt.id, status: 'final' }, { ['data.' + mt.wpQ]: 1, ['data.' + mt.workQ]: 1, ['data.' + mt.endDateQ]: 1, submittedOn: 1, status: 1 }, token, prog);
  const rehab = {}; // code -> earliest rehab date
  const noteRehab = (code, when) => { if (!code) return; if (!rehab[code] || (when && when < rehab[code])) rehab[code] = when || rehab[code] || ''; };
  mResp.forEach(x => { const d = x.data || {}; const code = d[mt.wpQ] && d[mt.wpQ].value && d[mt.wpQ].value.code; if (d[mt.workQ] && d[mt.workQ].value === mt.rehabWork) noteRehab(code, day((d[mt.endDateQ] && d[mt.endDateQ].value) || x.submittedOn)); });
  try { const f = await C.mwaterGet('forms/' + REHAB_PROGRESS_FORM, {}, token); const qs = []; (function w(l) { for (const it of l || []) { if (it.contents) w(it.contents); else qs.push(it); } })(f.design.contents); const siteQ = qs.find(q => q._type === 'SiteQuestion'), dateQ = qs.find(q => q._type === 'DateQuestion');
    const rr = await C.mwaterPages('responses', { form: REHAB_PROGRESS_FORM, status: 'final' }, { ['data.' + siteQ._id]: 1, ['data.' + (dateQ || {})._id]: 1, submittedOn: 1, status: 1 }, token, prog);
    rr.forEach(x => { const d = x.data || {}; const code = d[siteQ._id] && d[siteQ._id].value && d[siteQ._id].value.code; noteRehab(code, day((dateQ && d[dateQ._id] && d[dateQ._id].value) || x.submittedOn)); }); } catch (e) { warns.push('rehab progress form: ' + e.message); }
  // first_seen: earliest response referencing the point in any programme form that links water points (server-computed "entities" field)
  const forms = (await C.mwaterPages('forms', {}, { 'design.name': 1, state: 1, _entity_types: 1, deployments: 1 }, token, prog)).filter(f => f.state !== 'deleted' && (f._entity_types || []).includes('water_point') && (/^(Clean Water|Eau potable|MadAvance|SaniTap)/i.test(loc(f.design && f.design.name)) || /dauphin|maroantsetra|tolagnaro|marolinta/i.test(JSON.stringify(f.deployments || []))));
  const firstSeen = {}; let refs = 0;
  for (const f of forms) { let rr = []; try { rr = await C.mwaterPages('responses', { form: f._id }, { entities: 1, submittedOn: 1, status: 1 }, token, prog, null, 20000); } catch (e) { warns.push(loc(f.design.name).slice(0, 40) + ': ' + e.message); }
    rr.forEach(x => (x.entities || []).forEach(e => { if (e.entityType !== 'water_point' || !e.value) return; refs++; const when = day(x.submittedOn); if (when && (!firstSeen[e.value] || when < firstSeen[e.value])) firstSeen[e.value] = when; })); }
  // rows
  const Y = b => b ? 'Y' : 'N';
  const entByCode = {}; r.entities.forEach(e => { entByCode[e.code] = e; });
  const rows = r.points.map(p => {
    const ent = entByCode[p.water_point_id] || {}; const st = r.latest[p.water_point_id] || {}; const roofs = r.roofs[p.water_point_id]; const district = p.district || '';
    const pat = namePattern(ent.name || ''); const hasRehab = rehab[p.water_point_id] !== undefined; const tested = p.sdws3_results > 0; const passing = p.sdws3_passes > 0;
    const hasRecords = hasRehab || !!st.last_visit || roofs !== undefined;
    let status, note = '';
    if (OUTSIDE.includes(district.toLowerCase())) status = 'outside-carbon';
    else if (pat === 'abandonné' || st.status === 'not_functional') { status = 'abandoned'; note = pat === 'abandonné' ? 'name' : 'maintenance: not functional'; }
    else if (hasRehab && passing && p.status === 'active') status = 'credited-eligible';
    else if (hasRecords && !tested) { status = 'operating-untested'; note = [hasRehab ? 'rehab' : '', st.last_visit ? 'maintenance' : '', roofs !== undefined ? 'beneficiaries' : ''].filter(Boolean).join('+'); }
    else if ((pat === 'identifié' || pat === 'drilling') && !hasRecords && !tested) status = 'not-yet-built';
    else { status = 'other'; note = tested && !passing ? 'tested, failing: ' + p.sdws3_failing : passing && !hasRehab ? 'passing SDWS 3, no rehabilitation record' : passing && p.status !== 'active' ? 'passing but ' + p.status_reason : !hasRecords && !tested ? 'no records' : 'unclassified'; }
    return { id: p.water_point_id, alt_id: p.alt_id || '', name: ent.name || '', pump_type_maintenance: st.pump || '', name_pattern: pat, district, commune: p.commune, stratum: p.stratum, status: p.status, status_reason: p.status_reason, sdws3_tested: Y(tested), last_test_date: p.sdws3_last_test, passes_health_rule: Y(passing), failing_parameters: passing ? '' : p.sdws3_failing, eligible: Y(p.status === 'active'), installation_date: rehab[p.water_point_id] || '', has_rehab_record: Y(hasRehab), last_maintenance_visit: day(st.last_visit), households_served: roofs !== undefined ? Math.round(roofs) : '', first_seen: firstSeen[p.water_point_id] || '', status_for_crediting: status, crediting_note: note };
  });
  // probable duplicate register entries in Marolinta: entries of different series (Aug-2025 assessment, Jun-2026 registration, "Drilling" placeholders) within 50 m in the same commune
  const series = x => /drilling/i.test(x.name || '') ? 'drilling' : /^2025-08-2/.test(x.first_seen) ? 'assessment-2025-08' : /^2026-06-1/.test(x.first_seen) ? 'registration-2026-06' : '';
  const pairs = []; const dupOf = {};
  const mar = rows.filter(x => /marolinta/i.test(x.commune || '') || (x.district === 'Beloha' && !x.commune)).map(x => Object.assign({ series: series(x), ent: entByCode[x.id] || {} }, x));
  for (let i = 0; i < mar.length; i++) for (let j = i + 1; j < mar.length; j++) {
    const a = mar[i], b = mar[j]; if (!a.series || !b.series || a.series === b.series) continue;
    const la = a.ent.location && a.ent.location.coordinates, lb = b.ent.location && b.ent.location.coordinates; if (!la || !lb) continue;
    const d = C.haversineKm({ lat: la[1], lon: la[0] }, { lat: lb[1], lon: lb[0] }) * 1000;
    if (d <= 50) { pairs.push([a.id, b.id, Math.round(d), a.series + ' "' + a.name + '"', b.series + ' "' + b.name + '"']); (dupOf[a.id] = dupOf[a.id] || []).push(b.id); (dupOf[b.id] = dupOf[b.id] || []).push(a.id); }
  }
  // Marolinta register entries are not all pumps: classify them
  const marClass = x => { if (x.has_rehab_record === 'Y' || x.installation_date) return 'rehabilitated'; if (/forage|forrage|drilling|nouveau|noveau/i.test(x.name || '') && /^2026/.test(x.first_seen)) return 'new borehole'; if (/^2025-08/.test(x.first_seen) && x.has_rehab_record !== 'Y') return 'assessment'; return 'other'; };
  const marIds = new Set(mar.map(m => m.id));
  rows.forEach(x => { x.marolinta_class = marIds.has(x.id) ? marClass(x) : ''; x.register_series = marIds.has(x.id) ? series(x) : ''; x.duplicate_candidate = dupOf[x.id] ? 'Y' : 'N'; x.duplicate_pair_ids = (dupOf[x.id] || []).join(';'); });
  const marCounts = {}; rows.filter(x => x.marolinta_class).forEach(x => { marCounts[x.marolinta_class] = (marCounts[x.marolinta_class] || 0) + 1; });
  const marPumps = (marCounts['rehabilitated'] || 0) + (marCounts['new borehole'] || 0);
  const marLine = 'Marolinta (Beloha): ' + marPumps + ' programme pumps (rehabilitated ' + (marCounts['rehabilitated'] || 0) + ' + new boreholes ' + (marCounts['new borehole'] || 0) + ') among ' + mar.length + ' register entries, outside the carbon frame; ' + (marCounts['assessment'] || 0) + ' assessment entries (Aug 2025) and ' + (marCounts['other'] || 0) + ' other.';
  const header = Object.keys(rows[0]);
  let out = args.out; if (!out) { const win = '/mnt/c/Users/bushp/Downloads'; out = path.join(fs.existsSync(win) ? win : path.join(os.homedir(), 'Downloads'), 'sdws3_reconciliation.csv'); }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, [header].concat(rows.map(x => header.map(k => x[k]))).map(l => l.map(C.csvEscape).join(',')).join('\r\n') + '\r\n');
  // summary district x status
  const STATUSES = ['credited-eligible', 'operating-untested', 'not-yet-built', 'abandoned', 'outside-carbon', 'other'];
  const by = {}; rows.forEach(x => { const d = x.district || '(none)'; by[d] = by[d] || {}; by[d][x.status_for_crediting] = (by[d][x.status_for_crediting] || 0) + 1; });
  const tot = {}; rows.forEach(x => { tot[x.status_for_crediting] = (tot[x.status_for_crediting] || 0) + 1; });
  const table = [['district', 'total'].concat(STATUSES)].concat(Object.keys(by).sort().map(d => [d, Object.values(by[d]).reduce((a, b) => a + b, 0)].concat(STATUSES.map(s => by[d][s] || 0)))).concat([['TOTAL', rows.length].concat(STATUSES.map(s => tot[s] || 0))]);
  const pad = t => { const w = t[0].map((_, i) => Math.max.apply(null, t.map(l => String(l[i]).length))); return t.map((l, i) => l.map((v, j) => String(v).padEnd(w[j])).join('  ') + (i === 0 ? '\n' + w.map(n => '-'.repeat(n)).join('  ') : '')).join('\n'); };
  console.log(pad(table));
  const otherNotes = {}; rows.filter(x => x.status_for_crediting === 'other').forEach(x => { const k = x.crediting_note.replace(/:.*/, ''); otherNotes[k] = (otherNotes[k] || 0) + 1; }); console.log('\n"other" breakdown: ' + JSON.stringify(otherNotes));
  const untested = rows.filter(x => x.status_for_crediting === 'operating-untested').sort((a, b) => a.district.localeCompare(b.district) || a.commune.localeCompare(b.commune) || a.id.localeCompare(b.id));
  const ut = [['id', 'alt_id', 'name', 'district', 'commune', 'last_maintenance_visit', 'households_served', 'records']].concat(untested.map(x => [x.id, x.alt_id, x.name, x.district, x.commune, x.last_maintenance_visit, x.households_served, x.crediting_note]));
  console.log('\noperating-untested (' + untested.length + '):'); console.log(pad(ut));
  const ms = {}; mar.forEach(m => { ms[m.series || '(other)'] = (ms[m.series || '(other)'] || 0) + 1; });
  console.log('\n' + marLine + '\nMarolinta by class ' + JSON.stringify(marCounts) + ' | by series ' + JSON.stringify(ms) + ' | duplicate candidates ' + Object.keys(dupOf).length + ' entries in ' + pairs.length + ' pairs (<= 50 m, different series):');
  pairs.sort((a, b) => a[2] - b[2]).forEach(p => console.log('  ' + p[0] + ' <-> ' + p[1] + '  ' + p[2] + ' m  ' + p[3] + ' / ' + p[4]));
  console.log('\nfetched ' + r.fetchedAt + ' | entities ' + r.entities.length + ' | SDWS 3 final results ' + r.sdws3Responses + ' | rehab records for ' + Object.keys(rehab).length + ' points | forms scanned for first_seen ' + forms.length + ' (' + refs + ' references)' + (warns.length ? ' | warnings: ' + warns.join('; ') : ''));
  console.log('written ' + out + ' (' + rows.length + ' rows, no coordinates)');
  if (args.md) { const md = t => '| ' + t[0].join(' | ') + ' |\n|' + t[0].map(() => '---').join('|') + '|\n' + t.slice(1).map(l => '| ' + l.join(' | ') + ' |').join('\n'); fs.writeFileSync(args.md, '_Generated ' + r.fetchedAt.slice(0, 10) + ' by `bin/reconcile.js` from ' + r.entities.length + ' water points of the MadAvance group, ' + r.sdws3Responses + ' final SDWS 3 results, rehabilitation records for ' + Object.keys(rehab).length + ' points._\n\n**Per district × crediting status**\n\n' + md(table) + '\n\n"Other" breakdown: ' + Object.entries(otherNotes).map(([k, v]) => k + ' ' + v).join('; ') + '.\n\n' + marLine + ' Probable duplicate register entries (different series within 50 m): ' + Object.keys(dupOf).length + ' entries in ' + pairs.length + ' pairs, flagged in `duplicate_candidate`.\n\n**Operating but untested (' + untested.length + ')**\n\n' + md(ut) + '\n'); }
})().catch(e => { console.error('ERROR ' + e.message); process.exit(1); });
