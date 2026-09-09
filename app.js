/* SaniTap Sampler — statistically valid, logistics-aware water quality sampling
 * Gold Standard SDWS methodology v2.0. Plain JS, no build step, nothing leaves the browser.
 * File layout: Core (pure, testable in Node) + UI (browser only).
 */
'use strict';
const APP_VERSION = '2.1.0';
const PROTOCOL_VERSION = 'v2.2'; // SaniTap Water Quality Testing Protocol version cited in the UI, the PDF record and the audit
const APP_COMMIT = '__GIT_COMMIT__'; // replaced by the Pages workflow with the short git hash
const APP_URL = 'https://sanitap-water.github.io/sanitap-sampler/';
const ALGORITHM = 'seed string -> xmur3 32-bit hash -> mulberry32 PRNG (v1.2.0); stage 1: systematic PPS of sources proportional to households served, frame ordered by commune then water_point_id, one random start, certainty selection for sources larger than the interval; replacements: sequential PPS without replacement in random order; stage 2: households by the field rule (the k-th household walking from the source), numbers from mulberry32 seeded with seed|water_point_id|K';
const ALGORITHMS = { pps_households: ALGORITHM };
const REACH_KM = 25; // a selected source farther than this from every other selected source and from the district town is flagged for the field team

/* =====================================================================
 *  CORE
 * ===================================================================*/
const Core = (function () {

  /* ---------- PRNG ---------- */
  // xmur3: string -> 32-bit seed (Bryc, public domain)
  function xmur3(str) {
    let h = 1779033703 ^ str.length;
    for (let i = 0; i < str.length; i++) {
      h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
      h = (h << 13) | (h >>> 19);
    }
    return function () {
      h = Math.imul(h ^ (h >>> 16), 2246822507);
      h = Math.imul(h ^ (h >>> 13), 3266489909);
      return (h ^= h >>> 16) >>> 0;
    };
  }
  // mulberry32: 32-bit state -> uniform [0,1)
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function makeRng(seedString) {
    const word = xmur3(String(seedString))();
    return { seedWord: word, next: mulberry32(word) };
  }
  // integer in [0, n)
  function randInt(rng, n) { return Math.floor(rng.next() * n); }

  /* ---------- CSV ---------- */
  function parseCsv(text) {
    text = String(text).replace(/^﻿/, '');
    const rows = []; let row = [], field = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
        else field += c;
      } else if (c === '"') q = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(field); field = ''; rows.push(row); row = [];
      } else field += c;
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }
    const nonEmpty = rows.filter(r => r.some(v => v.trim() !== ''));
    if (!nonEmpty.length) return { header: [], records: [] };
    const header = nonEmpty[0].map(h => h.trim().toLowerCase().replace(/\s+/g, '_'));
    const records = nonEmpty.slice(1).map(r => {
      const o = {}; header.forEach((h, i) => { o[h] = (r[i] === undefined ? '' : r[i]).trim(); }); return o;
    });
    return { header, records };
  }
  const WP_ALIASES = { latitude: 'lat', longitude: 'lon', lng: 'lon', long: 'lon', id: 'water_point_id', _id: 'water_point_id', hh_served: 'households_served' };
  function normaliseWaterPoints(records) {
    const errors = [];
    const out = records.map((r, i) => {
      const o = {};
      for (const k in r) o[WP_ALIASES[k] || k] = r[k];
      o.lat = parseFloat(o.lat); o.lon = parseFloat(o.lon);
      o.households_served = parseInt(o.households_served, 10);
      if (isNaN(o.households_served)) o.households_served = 0;
      ['sdws3_passes', 'sdws3_results'].forEach(k => { if (o[k] !== undefined) { o[k] = parseInt(o[k], 10) || 0; } });
      o.status = String(o.status || '').trim().toLowerCase();
      o.active = o.status === 'active' || o.status === 'actif' || o.status === 'true' || o.status === '1';
      if (!o.water_point_id) errors.push('row ' + (i + 2) + ': missing water_point_id');
      if (!o.stratum) errors.push('row ' + (i + 2) + ': missing stratum');
      return o;
    });
    return { points: out, errors };
  }
  function normaliseHouseholds(records) {
    const byWp = {};
    records.forEach(r => {
      const o = {}; for (const k in r) o[WP_ALIASES[k] || k] = r[k];
      if (!o.water_point_id || !o.household_id) return;
      o.lat = parseFloat(o.lat); o.lon = parseFloat(o.lon);
      (byWp[o.water_point_id] = byWp[o.water_point_id] || []).push(o);
    });
    for (const k in byWp) byWp[k].sort((a, b) => a.household_id.localeCompare(b.household_id));
    return byWp;
  }
  function csvEscape(v) {
    v = v === null || v === undefined ? '' : String(v);
    return /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  }

  /* ---------- geometry ---------- */
  function haversineKm(a, b) {
    const R = 6371.0088, toR = Math.PI / 180;
    const dLat = (b.lat - a.lat) * toR, dLon = (b.lon - a.lon) * toR;
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
  }
  /* ---------- SHA-256 (pure JS fallback when crypto.subtle is unavailable) ---------- */
  function utf8Bytes(str) { // manual UTF-8 encoder (no TextEncoder / Buffer dependency)
    const out = [];
    for (let i = 0; i < str.length; i++) {
      let c = str.charCodeAt(i);
      if (c >= 0xd800 && c < 0xdc00 && i + 1 < str.length) { c = 0x10000 + ((c - 0xd800) << 10) + (str.charCodeAt(++i) - 0xdc00); }
      if (c < 0x80) out.push(c); else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return new Uint8Array(out);
  }
  function sha256Sync(str) {
    const K = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
    const bytes = utf8Bytes(str);
    const l = bytes.length, bitLen = l * 8, padded = new Uint8Array(((l + 9 + 63) >> 6) << 6);
    padded.set(bytes); padded[l] = 0x80;
    const dv = new DataView(padded.buffer); dv.setUint32(padded.length - 4, bitLen >>> 0); dv.setUint32(padded.length - 8, Math.floor(bitLen / 4294967296));
    let H = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
    const w = new Uint32Array(64), rotr = (x, n) => (x >>> n) | (x << (32 - n));
    for (let off = 0; off < padded.length; off += 64) {
      for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
      for (let i = 16; i < 64; i++) { const s0 = rotr(w[i-15],7) ^ rotr(w[i-15],18) ^ (w[i-15]>>>3), s1 = rotr(w[i-2],17) ^ rotr(w[i-2],19) ^ (w[i-2]>>>10); w[i] = (w[i-16] + s0 + w[i-7] + s1) >>> 0; }
      let [a,b,c,d,e,f,g,h] = H;
      for (let i = 0; i < 64; i++) {
        const S1 = rotr(e,6) ^ rotr(e,11) ^ rotr(e,25), ch = (e & f) ^ (~e & g), t1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
        const S0 = rotr(a,2) ^ rotr(a,13) ^ rotr(a,22), maj = (a & b) ^ (a & c) ^ (b & c), t2 = (S0 + maj) >>> 0;
        h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      H = H.map((v, i) => (v + [a,b,c,d,e,f,g,h][i]) >>> 0);
    }
    return H.map(v => v.toString(16).padStart(8, '0')).join('');
  }
  async function sha256(str) {
    try {
      if (typeof crypto !== 'undefined' && crypto.subtle) {
        const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
        return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
      }
    } catch (e) { /* fall through */ }
    return sha256Sync(str);
  }

  /* ---------- statistics ---------- */
  const Z = { '0.90': 1.6449, '0.95': 1.96 };
  function stats(p) {
    const m = p.hhPerPoint, icc = p.icc;
    const deff = 1 + (m - 1) * icc;
    const nWp = Math.ceil(p.target / m);
    const nActual = nWp * m;
    const nEff = nActual / deff;
    const z = Z[String(p.confidence)] || 1.6449;
    const pr = p.expectedPass;
    const d = p.precisionType === 'absolute' ? p.precision : p.precision * pr;
    const nReq = Math.ceil(z * z * pr * (1 - pr) / (d * d));
    const pass = nEff >= nReq;
    const suggestions = [];
    if (!pass) {
      // (a) keep target, reduce households per point
      const mMax = Math.floor(1 + (nActual / nReq - 1) / (icc || 1e-9));
      if (icc > 0 && mMax >= 1 && mMax < m) suggestions.push({ type: 'fewer_hh', m: mMax, nWp: Math.ceil(p.target / mMax) });
      // (b) keep m, add water points (more clusters)
      const nWpNeeded = Math.ceil(nReq * deff / m);
      if (nWpNeeded > nWp) suggestions.push({ type: 'more_wp', nWp: nWpNeeded, nSamples: nWpNeeded * m });
    }
    return { m, icc, deff: +deff.toFixed(3), nWp, nActual, nEff: +nEff.toFixed(1), z, expectedPass: pr, precision: p.precision, precisionType: p.precisionType, d: +d.toFixed(4), nReq, pass, suggestions };
  }

  /* ---------- the draw ---------- */
  // Systematic PPS: frame in fixed order, weights w_i, n draws, one random start. Sources with w_i >= interval are taken with certainty
  // and the interval recomputed on the rest (repeated until stable), so no source can be hit twice. Returns selected in frame order with the hit positions.
  function systematicPps(frame, weights, n, rng) {
    const certain = []; let rest = frame.map((f, i) => ({ f, w: weights[i], i })); let interval = 0, total = 0;
    for (;;) {
      total = rest.reduce((a, r) => a + r.w, 0); const k = n - certain.length; if (k <= 0 || !rest.length) { interval = 0; break; }
      interval = total / k; const big = rest.filter(r => r.w >= interval);
      if (!big.length) break;
      big.forEach(r => certain.push(r)); rest = rest.filter(r => r.w < interval);
    }
    const k = n - certain.length; const start = k > 0 ? rng.next() * interval : 0; const hits = [];
    if (k > 0) { let cum = 0, j = 0; rest.forEach(r => { const from = cum; cum += r.w; while (j < k && start + j * interval < cum) { if (start + j * interval >= from) hits.push({ f: r.f, w: r.w, from, to: cum, hit: start + j * interval, i: r.i }); j++; } }); }
    const selected = certain.map(r => ({ f: r.f, w: r.w, from: null, to: null, hit: null, certainty: true, i: r.i })).concat(hits).sort((a, b) => a.i - b.i);
    return { selected, interval, start, total, certainty: certain.length, remaining: rest.filter(r => !hits.some(h => h.i === r.i)).map(r => ({ f: r.f, w: r.w, i: r.i })) };
  }
  function median(arr) { const a = arr.slice().sort((x, y) => x - y); return a.length ? (a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2) : 0; }
  function recordId(p) { return String(p.roundName || 'round').replace(/\s+/g, '') + '-' + p.stratum + '-' + p.seed; }

  // reach check: nearest other selected source and the district town; flagged when both are farther than REACH_KM (no automatic replacement)
  function reachCheck(selected, town) {
    return selected.map(w => {
      if (!isFinite(w.lat) || !isFinite(w.lon)) return { water_point_id: w.water_point_id, nearest_km: null, nearest_id: null, town_km: null, far: false };
      let best = null, bestId = null;
      selected.forEach(o => { if (o === w || !isFinite(o.lat)) return; const d = haversineKm(w, o); if (best === null || d < best) { best = d; bestId = o.water_point_id; } });
      const townKm = town ? haversineKm(w, town) : null;
      const far = (best === null || best > REACH_KM) && (townKm === null || townKm > REACH_KM);
      return { water_point_id: w.water_point_id, nearest_km: best === null ? null : +best.toFixed(1), nearest_id: bestId, town_km: townKm === null ? null : +townKm.toFixed(1), far };
    });
  }

  function draw(params, allPoints) {
    const p = Object.assign({ method: 'pps_households', hhReplacements: 2 }, params, { method: 'pps_households' });
    const warnings = [];
    const rng = makeRng(p.seed);
    const eligible = allPoints.filter(pt => pt.active && String(pt.stratum) === String(p.stratum))
      .sort((a, b) => String(a.water_point_id).localeCompare(String(b.water_point_id)));
    const noCoords = eligible.filter(pt => !isFinite(pt.lat) || !isFinite(pt.lon)).length;
    if (noCoords) warnings.push({ code: 'no_coords', n: noCoords });
    if (!eligible.length) return { error: 'no_eligible', warnings, eligibleCount: 0 };
    const st = stats(p);
    const nWp = st.nWp;
    const nRep = Math.ceil(nWp * p.replacementFraction);
    const needed = nWp + nRep;
    // Protocol §6.4 (PROTOCOL_VERSION): sources drawn proportional to households served, frame ordered by commune then id (implicit stratification across communes)
    const frame = eligible.slice().sort((a, b) => String(a.commune || '').localeCompare(String(b.commune || '')) || String(a.water_point_id).localeCompare(String(b.water_point_id)));
    const known = frame.filter(f => f.households_served > 0).map(f => f.households_served);
    const imputed = known.length ? Math.max(1, Math.round(median(known))) : 1;
    const nImputed = frame.length - known.length;
    if (nImputed) warnings.push({ code: 'imputed_weights', n: nImputed, value: imputed });
    const weights = frame.map(f => f.households_served > 0 ? f.households_served : imputed);
    if (frame.length < needed) warnings.push({ code: 'insufficient_points', have: frame.length, needed, nWp, nRep });
    const sp = systematicPps(frame, weights, Math.min(nWp, frame.length), rng);
    const selected = sp.selected.map(x => x.f);
    const hitOf = {}; sp.selected.forEach(x => { hitOf[x.f.water_point_id] = x; });
    // replacements: sequential PPS without replacement among the remaining sources, in draw order
    const replacements = []; let rest = sp.remaining.slice();
    while (replacements.length < nRep && rest.length) {
      const total = rest.reduce((a, r) => a + r.w, 0); let u = rng.next() * total, idx = 0;
      for (; idx < rest.length; idx++) { u -= rest[idx].w; if (u < 0) break; }
      if (idx >= rest.length) idx = rest.length - 1;
      const r = rest.splice(idx, 1)[0]; replacements.push(r.f); hitOf[r.f.water_point_id] = { w: r.w, hit: null, from: null, to: null };
    }
    const clusterOf = {}; frame.forEach(f => { clusterOf[f.water_point_id] = f.commune || '(no commune)'; });
    const byCommune = {}; frame.forEach(f => { const c = f.commune || '(no commune)'; byCommune[c] = byCommune[c] || { name: c, size: 0, households: 0, selected: 0 }; byCommune[c].size++; byCommune[c].households += f.households_served > 0 ? f.households_served : imputed; });
    selected.forEach(f => { byCommune[f.commune || '(no commune)'].selected++; });
    const clusters = Object.keys(byCommune).sort().map(c => ({ name: c, size: byCommune[c].size, households: byCommune[c].households, selected: byCommune[c].selected }));
    const selectedClusters = clusters.filter(c => c.selected > 0).map((c, i) => Object.assign({}, c, { order: i + 1 }));
    const stage1 = { method: 'pps_households', frame_order: 'commune, water_point_id', frame_size: frame.length, total_households: sp.total, imputed_weight: imputed, imputed_count: nImputed, interval: +sp.interval.toFixed(4), random_start: +sp.start.toFixed(4), certainty_selections: sp.certainty, communes_covered: selectedClusters.length, communes_in_frame: clusters.length };
    if (selected.length < nWp) warnings.push({ code: 'short_selection', have: selected.length, nWp });

    // Stage 2 (households): field rule for every source
    const hhN = p.hhPerPoint, hhR = p.hhReplacements;
    const mk = (pt, i, rep) => { const h = hitOf[pt.water_point_id] || {}; return {
      order: i + 1, replacement: rep, water_point_id: pt.water_point_id, alt_id: pt.alt_id, name: pt.name, cluster: clusterOf[pt.water_point_id],
      commune: pt.commune, fokontany: pt.fokontany, village: pt.village, lat: pt.lat, lon: pt.lon, households_served: pt.households_served, pump: pt.pump,
      weight: h.w, hit: h.hit !== null && h.hit !== undefined ? +h.hit.toFixed(4) : undefined, cum_from: h.from !== null && h.from !== undefined ? +h.from.toFixed(4) : undefined, cum_to: h.to !== null && h.to !== undefined ? +h.to.toFixed(4) : undefined, certainty: h.certainty ? true : undefined,
      households: { mode: 'rule', n: hhN, extra: hhR }
    }; };
    const selectedOut = selected.map((pt, i) => mk(pt, i, false));
    const replacementOut = replacements.map((pt, i) => mk(pt, i, true));
    const town = (MWATER.strata[p.stratum] || {}).town || null;
    const reach = reachCheck(selectedOut, town);
    reach.forEach(r => { if (r.far) warnings.push({ code: 'far_source', id: r.water_point_id, nearest_km: r.nearest_km, town_km: r.town_km }); });

    const audit = {
      tool: 'SaniTap Sampler', version: APP_VERSION, commit: APP_COMMIT, methodology: 'Gold Standard SDWS v2.0; SaniTap Water Quality Testing Protocol ' + PROTOCOL_VERSION + ' section 6.4', protocol_version: PROTOCOL_VERSION,
      record_id: recordId(p),
      timestamp: p.timestamp || new Date().toISOString(), drawn_by: p.drawnBy || null,
      seed: p.seed, seed_word_uint32: rng.seedWord, algorithm: ALGORITHM,
      input: { source: p.source || 'csv', water_points_file: p.wpFileName || null, water_points_sha256: p.wpFileHash || null, frame_rule: FRAME_RULE_TEXT.en, mwater: p.source === 'mwater' ? (p.mwater || null) : null },
      parameters: { round: p.roundName, stratum: p.stratum, method: 'pps_households', target_samples: p.target, households_per_point: hhN, household_replacements: hhR, replacement_fraction: p.replacementFraction, icc: p.icc, expected_pass_rate: p.expectedPass, confidence: p.confidence, precision: p.precision, precision_type: p.precisionType },
      frame: { eligible_points: eligible.length, clusters },
      stage1,
      statistics: st,
      selected_clusters: selectedClusters,
      water_points: selectedOut.map(auditWp), replacements: replacementOut.map(auditWp),
      reach_check: { threshold_km: REACH_KM, town: town ? town.name : null, sources: reach },
      field_rule: 'Households are drawn by the field rule: the k-th household walking from the source. Count the households served (K), draw N=' + hhN + ' numbers (+' + hhR + ' replacements) from 1..K with mulberry32 seeded by seed|water_point_id|K=K, and sample the k-th household met when walking from the source.',
      warnings
    };
    return { params: p, eligible, clusters, stats: st, nWp, nRep, selectedClusters, selected: selectedOut, replacements: replacementOut, reach, warnings, audit };
  }
  function auditWp(w) {
    // published record: identifiers, names, commune, households and the field rule only — never coordinates (the field sheet and map carry those and are not filed)
    const o = { order: w.order, water_point_id: w.water_point_id, alt_id: w.alt_id || '', name: w.name, cluster: w.cluster, commune: w.commune, fokontany: w.fokontany || '', households_served: w.households_served, households: w.households };
    if (w.weight !== undefined) o.weight = w.weight; if (w.hit !== undefined) o.hit = w.hit; if (w.cum_from !== undefined) { o.cum_from = w.cum_from; o.cum_to = w.cum_to; } if (w.certainty) o.certainty = true;
    return o;
  }
  // field rule numbers when K is typed on the day: reproducible from seed, point and K
  function fieldNumbers(seed, wpId, K, n, extra) {
    K = parseInt(K, 10); if (!(K > 0)) return null;
    const rng = makeRng(seed + '|' + wpId + '|K=' + K);
    const pool = []; for (let i = 1; i <= K; i++) pool.push(i);
    const out = []; while (out.length < n + extra && pool.length) out.push(pool.splice(randInt(rng, pool.length), 1)[0]);
    return { K, primary: out.slice(0, n), replacements: out.slice(n), short: K < n + extra };
  }

  /* ---------- exports ---------- */
  function ruleText(w, kValues) {
    const h = w.households; const K = kValues && kValues[w.water_point_id];
    const fn = K ? fieldNumbers(w.seed || kValues.__seed, w.water_point_id, K, h.n, h.extra) : null;
    if (fn) return { primary: fn.primary.map(x => 'HH#' + x), replacements: fn.replacements.map(x => 'HH#' + x), text: 'K=' + K + ' numbers ' + fn.primary.join(',') + ' (rep ' + fn.replacements.join(',') + ')' };
    return { primary: [], replacements: [], text: 'RULE: ' + h.n + ' of K, k-th household walking from the source (+' + h.extra + ' replacements)' };
  }
  function toCsv(result, kValues) {
    const rows = [['round', 'stratum', 'cluster', 'water_point_id', 'order', 'household_id_or_rule', 'replacement_flag']];
    const p = result.params; const kv = Object.assign({ __seed: p.seed }, kValues || {});
    const add = (w, wpRep) => {
      const o = wpRep ? 'R' + w.order : w.order;
      const base = [p.roundName, p.stratum, w.cluster, w.water_point_id, o];
      const r = ruleText(w, kv);
      if (r.primary.length) {
        r.primary.forEach(x => rows.push(base.concat([x, wpRep ? 'water_point' : 'none'])));
        r.replacements.forEach(x => rows.push(base.concat([x, wpRep ? 'water_point+household' : 'household'])));
      } else rows.push(base.concat([r.text, wpRep ? 'water_point' : 'none']));
    };
    result.selected.forEach(w => add(w, false));
    result.replacements.forEach(w => add(w, true));
    return rows.map(r => r.map(csvEscape).join(',')).join('\r\n') + '\r\n';
  }
  function auditJson(result, extra) {
    return JSON.stringify(Object.assign({}, result.audit, extra || {}), null, 2);
  }


  /* ---------- mWater (identifiers only; no credentials live in this file) ---------- */
  const MWATER = {
    api: 'https://api.mwater.co/v3',
    group: 'group:aaaf0a14e4ce44eaa7a2bcfd1c74aa56', // MadAvance operator group: owner of the programme water points and households
    entityType: 'water_point',
    strata: {
      'HP-FD': { label: 'Hand pumps — Fort-Dauphin (Taolagnaro, Amboasary-Atsimo)', districts: ['Taolagnaro', 'Fort-Dauphin', 'Amboasary-Atsimo', 'Amboasary Sud', 'Amboasary'], town: { name: 'Fort-Dauphin', lat: -25.0319, lon: 46.9967 } },
      'HP-MA': { label: 'Hand pumps — Maroantsetra', districts: ['Maroantsetra'], town: { name: 'Maroantsetra', lat: -15.4333, lon: 49.7333 } }
    },
    excludedDistricts: { label: 'Marolinta', districts: ['Beloha'] },
    unassigned: 'unassigned',
    forms: {
      beneficiaries: { name: 'Clean Water || Nombre de bénéficiaires', id: '8aa2dd78eb1f460f8f43db7935955846', wpQ: 'e796e451be1243d58b547bc0f6c1d5b4', roofsQ: '00ae079e071a40349e0706c659430f9b' },
      maintenance: { name: 'Clean Water || Première réhabilitation/Entretien préventif/Réparation', id: '86cf66efdd3749dd8a121314bab3675a', wpQ: '6b454d5e31ce4f6bb4918aca5f824d75', statusQ: 'c843c54776864de7b5b8b90825bc4c06', status2Q: '701d5b8d583145e3baab2e75a5f17ce4', pumpQ: '2ba451c8124f4d02aa76c44e6f5a88a3', workQ: '7f78d719b9f242d8886df7bb88640a80', rehabWork: 'DQcV1NT', endDateQ: '29280fbb5f2b4da6a4feecadc1d6d4d4',
        status: { asVbMu3: 'functional', LATrLet: 'not_functional', NScsLF7: 'functional_substandard' }, pump: { '6Txb2rB': 'Canzee', mQmlpWT: 'IndiaMark', '72yyu9B': 'other' } },
      sdws3: { name: 'Clean Water || Water Quality Testing_SDWS 3_Result', id: '7b33c5d7e5074808a94915939a5a0783', wpQ: 'a3390d2e97494b3da193e5c015a879d1', dateQ: '630ccd46f76f420692572e0db2d86ad8',
        // Health-based pass rule (v1.3): E. coli, arsenic and fluoride must be present and within limit; nitrate and manganese only exclude when measured.
        // pH, conductivity, turbidity and iron are recorded by the form but do not exclude. Nitrate has no question in the form (q: null): skipped until one exists.
        params: [
          { key: 'ecoli', q: '892f1d81bf1a4c4483e53271dda474a5', test: v => v === 0, missing: false, rule: 'E. coli = 0 CFU/100 mL' },
          { key: 'arsenic', q: '4b86e349e9bc418ea5a4868e7b383604', test: v => v <= 10, missing: false, rule: 'arsenic <= 10 µg/L' },
          { key: 'fluoride', q: 'b4e94c2a5ca4497199bcde2856f2cd0c', test: v => v <= 1.5, missing: false, rule: 'fluoride <= 1.5 mg/L' },
          { key: 'nitrate', q: null, test: v => v <= 50, missing: true, rule: 'nitrate <= 50 mg/L where measured' },
          { key: 'manganese', q: 'c0a900a9659e45c29acce3349e32f1fd', test: v => v <= 0.08, missing: true, rule: 'manganese <= 0.08 mg/L where measured' }
        ] }
    },
    inactiveNames: /ab[ao]ndonn|identifi|drilling|proposal|puits? ouvert/i,
    entityFields: { name: 1, desc: 1, type: 1, code: 1, alt_id: 1, alt_id_org: 1, location: 1, admin_region: 1, admin_div1: 1, admin_div2: 1, admin_div3: 1, admin_div4: 1, admin_div5: 1, _private: 1, _rev: 1, _modified_on: 1 }
  };
  const FRAME_COLUMNS = ['water_point_id', 'name', 'stratum', 'commune', 'fokontany', 'village', 'lat', 'lon', 'households_served', 'status', 'mwater_id', 'pump', 'district', 'status_reason', 'sdws3_passes', 'sdws3_results', 'sdws3_last_pass', 'sdws3_last_test', 'sdws3_failing', 'alt_id', 'sdws3_last_result', 'abandoned', 'name_pattern', 'has_rehab_record', 'last_maintenance_visit', 'has_records'];
  // district name from an admin_regions document: full_name is "Fokontany, Commune, District, Region, Country"
  function regionParts(reg) { const p = String((reg && reg.full_name) || '').split(',').map(x => x.trim()); const n = p.length; return { fokontany: n >= 5 ? p[n - 5] : '', commune: n >= 4 ? p[n - 4] : '', district: n >= 3 ? p[n - 3] : '' }; }
  function mwaterStratum(district, strata) {
    const d = String(district || '').trim().toLowerCase(); if (!d) return MWATER.unassigned;
    for (const code in strata) if (strata[code].districts.some(x => x.toLowerCase() === d)) return code;
    return MWATER.unassigned;
  }
  // SDWS 3 result pass/fail on the health-based parameters: required ones must be present and within limit; optional ones exclude only when measured
  function sdws3Pass(response, cfg) {
    const d = (response && response.data) || {}; const failed = [];
    cfg.params.forEach(pm => { if (!pm.q) return; const a = d[pm.q]; const raw = a && a.value; const v = (raw === null || raw === undefined || raw === '') ? null : Number(raw); if (v === null) { if (!pm.missing) failed.push(pm.key + ':missing'); } else if (isNaN(v) || !pm.test(v)) failed.push(pm.key + ':' + raw); });
    return { pass: failed.length === 0, failed };
  }
  // per water point: results, passes, last test date, last passing date, and (union over results) the parameters that failed
  function sdws3PassingPoints(responses, cfg) {
    const out = {};
    responses.forEach(r => { if (r.status && r.status !== 'final') return; const d = r.data || {}; const code = d[cfg.wpQ] && d[cfg.wpQ].value && d[cfg.wpQ].value.code; if (!code) return; const o = out[code] = out[code] || { results: 0, passes: 0, last_pass: '', last_test: '', failing: [], last_result: '' }; o.results++; const when = String((d[cfg.dateQ] && d[cfg.dateQ].value) || r.submittedOn || ''); const p = sdws3Pass(r, cfg); if (when >= o.last_test) { o.last_test = when; o.last_result = p.pass ? 'pass' : 'fail:' + p.failed.map(f => f.split(':')[0]).join('+'); } if (p.pass) { o.passes++; if (when > o.last_pass) o.last_pass = when; } else p.failed.forEach(f => { const k = f.split(':')[0] + (f.endsWith(':missing') ? ':missing' : ''); if (!o.failing.includes(k)) o.failing.push(k); }); });
    Object.values(out).forEach(o => o.failing.sort());
    return out;
  }
  function mwaterLatestStatus(responses, cfg) {
    const out = {};
    responses.filter(r => r.status === 'final' || !r.status).slice().sort((a, b) => String(a.submittedOn || '').localeCompare(String(b.submittedOn || ''))).forEach(r => {
      const d = r.data || {}; const code = d[cfg.wpQ] && d[cfg.wpQ].value && d[cfg.wpQ].value.code; if (!code) return;
      const sv = (d[cfg.statusQ] && d[cfg.statusQ].value) || (d[cfg.status2Q] && d[cfg.status2Q].value); const pv = d[cfg.pumpQ] && d[cfg.pumpQ].value;
      const cur = out[code] = out[code] || {};
      if (sv) { cur.status = cfg.status[sv] || 'unknown'; cur.status_on = r.submittedOn; }
      if (pv) cur.pump = cfg.pump[pv] || pv;
      if (cfg.workQ && d[cfg.workQ] && d[cfg.workQ].value === cfg.rehabWork) { const when = String((cfg.endDateQ && d[cfg.endDateQ] && d[cfg.endDateQ].value) || r.submittedOn || '').slice(0, 10); if (!cur.rehab_on || (when && when < cur.rehab_on)) cur.rehab_on = when; }
      cur.last_visit = r.submittedOn;
    });
    return out;
  }
  function mwaterRoofs(responses, cfg) {
    const out = {};
    responses.slice().sort((a, b) => String(a.submittedOn || '').localeCompare(String(b.submittedOn || ''))).forEach(r => { const d = r.data || {}; const code = d[cfg.wpQ] && d[cfg.wpQ].value && d[cfg.wpQ].value.code; const n = d[cfg.roofsQ] && d[cfg.roofsQ].value; if (code && n !== null && n !== undefined && !isNaN(n)) out[code] = Number(n); });
    return out;
  }
  // entities (mWater water_point docs) -> sampler frame rows, applying the eligibility rule in this order:
  //   1 at least one passing SDWS 3 result  2 not abandoned / not functional / not a hand pump  3 district not excluded (Marolinta)  4 district mapped to a stratum
  function mapMwaterEntities(entities, extras) {
    const ex = extras || {}; const strata = ex.strata || MWATER.strata; const regions = ex.regionsById || {}; const roofs = ex.roofs || {}; const latest = ex.latest || {}; const passing = ex.passing || {};
    const counts = { total_in_group: entities.length, sdws3_pass_count: 0, excluded_no_pass: 0, excluded_abandoned: 0, excluded_marolinta: 0, unassigned: 0, eligible: 0, eligible_by_stratum: {} };
    Object.keys(strata).forEach(k => { counts.eligible_by_stratum[k] = 0; });
    const points = entities.map(e => {
      const rp = regionParts(regions[e.admin_region]);
      const district = e.admin_div2 || rp.district || '';
      const st = latest[e.code] || {}; const ps = passing[e.code] || { results: 0, passes: 0, last_pass: '', last_test: '', failing: [], last_result: '' };
      const pattern = /identifi/i.test(e.name || '') ? 'identifié' : /drilling|proposal/i.test(e.name || '') ? 'drilling' : /ab[ao]ndonn/i.test(e.name || '') ? 'abandonné' : 'normal';
      const abandonedFlag = /ab[ao]ndonn/i.test(e.name || '') || st.status === 'not_functional' || ['kiosk', 'Unprotected dug well', 'Protected dug well'].includes(e.type);
      const hasRecords = !!(st.rehab_on || st.last_visit || roofs[e.code] !== undefined);
      let stratum = mwaterStratum(district, strata);
      const excluded = MWATER.excludedDistricts.districts.some(x => x.toLowerCase() === String(district).trim().toLowerCase());
      let reason = '';
      if (ps.passes > 0) counts.sdws3_pass_count++;
      if (!(ps.passes > 0)) { reason = 'no_passing_sdws3_result'; counts.excluded_no_pass++; }
      else if (MWATER.inactiveNames.test(e.name || '')) { reason = 'abandoned:' + e.name; counts.excluded_abandoned++; }
      else if (st.status === 'not_functional') { reason = 'abandoned:maintenance not functional ' + String(st.status_on || '').slice(0, 10); counts.excluded_abandoned++; }
      else if (['kiosk', 'Unprotected dug well', 'Protected dug well'].includes(e.type)) { reason = 'abandoned:type ' + e.type; counts.excluded_abandoned++; }
      else if (excluded) { reason = 'excluded_district:' + district; counts.excluded_marolinta++; }
      else if (stratum === MWATER.unassigned) { reason = 'unassigned_district:' + (district || '(none)'); counts.unassigned++; }
      else { counts.eligible++; counts.eligible_by_stratum[stratum]++; }
      const coords = (e.location && e.location.coordinates) || [];
      return { water_point_id: String(e.code), name: [e.name, e.alt_id].filter(Boolean).join(' '), stratum, commune: e.admin_div3 || rp.commune || '', fokontany: e.admin_div4 || rp.fokontany || '', village: e.admin_div5 || '',
        lat: coords.length ? coords[1] : '', lon: coords.length ? coords[0] : '', households_served: roofs[e.code] !== undefined ? Math.round(roofs[e.code]) : '', status: reason ? 'inactive' : 'active', mwater_id: e._id, pump: st.pump || e.name || '', district, status_reason: reason, sdws3_passes: ps.passes, sdws3_results: ps.results, sdws3_last_pass: String(ps.last_pass || '').slice(0, 10), sdws3_last_test: String(ps.last_test || '').slice(0, 10), sdws3_failing: (ps.failing || []).join(';'), alt_id: e.alt_id || '', sdws3_last_result: ps.last_result || '', abandoned: abandonedFlag ? 'Y' : 'N', name_pattern: pattern, has_rehab_record: st.rehab_on ? 'Y' : 'N', last_maintenance_visit: String(st.last_visit || '').slice(0, 10), has_records: hasRecords ? 'Y' : 'N' };
    }).sort((a, b) => a.water_point_id.localeCompare(b.water_point_id));
    return { points, counts };
  }
  // Test A backlog: points of the stratum that are in the group, not abandoned and without a passing SDWS 3 result
  function backlog(points, stratum) {
    const rows = points.filter(p => String(p.stratum) === String(stratum) && !(p.sdws3_passes > 0) && p.abandoned !== 'Y' && String(p.status_reason || '').indexOf('excluded_district') !== 0);
    const groups = { operating: [], failing: [], notBuilt: [], other: [] };
    rows.forEach(p => {
      const tested = p.sdws3_results > 0; const records = p.has_records === 'Y';
      if (tested) groups.failing.push(p);
      else if (records) groups.operating.push(p);
      else if (p.name_pattern === 'identifié' || p.name_pattern === 'drilling') groups.notBuilt.push(p);
      else groups.other.push(p);
    });
    const byCommune = a => a.slice().sort((x, y) => String(x.commune || '').localeCompare(String(y.commune || '')) || String(x.water_point_id).localeCompare(String(y.water_point_id)));
    Object.keys(groups).forEach(k => { groups[k] = byCommune(groups[k]); });
    return groups;
  }
  function frameToCsv(points) { return [FRAME_COLUMNS].concat(points.map(p => FRAME_COLUMNS.map(c => p[c]))).map(r => r.map(csvEscape).join(',')).join('\r\n') + '\r\n'; }
  const FRAME_RULE_TEXT = { en: 'A source is eligible when it belongs to the MadAvance water point register (mWater group ' + MWATER.group + '), has at least one final water quality result in the form "' + MWATER.forms.sdws3.name + '" that meets the health-based rule (E. coli = 0 CFU/100 mL, arsenic <= 10 µg/L, fluoride <= 1.5 mg/L, and, where measured, nitrate <= 50 mg/L and manganese <= 0.08 mg/L; pH, conductivity, turbidity and iron are recorded but do not exclude), is not abandoned, identified-only, proposed, reported not functional in its latest maintenance record or of a non-hand-pump type, and lies in a district mapped to a stratum (Taolagnaro and Amboasary-Atsimo -> HP-FD, Maroantsetra -> HP-MA); the Marolinta area (Beloha district) is excluded and any other district is unassigned.',
    fr: 'Une source est éligible si elle appartient au registre des points d\'eau MadAvance (groupe mWater ' + MWATER.group + '), possède au moins un résultat final d\'analyse dans le formulaire « ' + MWATER.forms.sdws3.name + ' » satisfaisant la règle sanitaire (E. coli = 0 UFC/100 mL, arsenic <= 10 µg/L, fluorure <= 1,5 mg/L et, lorsqu\'ils sont mesurés, nitrate <= 50 mg/L et manganèse <= 0,08 mg/L ; le pH, la conductivité, la turbidité et le fer sont enregistrés mais n\'excluent pas), n\'est pas abandonnée, seulement identifiée, proposée, déclarée non fonctionnelle dans son dernier enregistrement de maintenance ni d\'un type autre que pompe à main, et se trouve dans un district rattaché à une strate (Taolagnaro et Amboasary-Atsimo -> HP-FD, Maroantsetra -> HP-MA) ; la zone de Marolinta (district de Beloha) est exclue et tout autre district est non affecté.' };
  // --- HTTP helpers: the token only ever travels as the ?client= query parameter; errors never echo the URL ---
  async function mwaterGet(path, params, token, fetchImpl) {
    const u = new URL(MWATER.api + '/' + path); Object.keys(params || {}).forEach(k => u.searchParams.set(k, params[k])); if (token) u.searchParams.set('client', token);
    const r = await (fetchImpl || fetch)(u.toString(), { headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error('mWater HTTP ' + r.status + ' on /' + path);
    return r.json();
  }
  // The API has no stable sort, so limit/skip pages beyond the first can overlap or skip rows. Fetch in one large page (5000 rows fits every
  // programme collection) and only fall back to skip-paging, with a warning, if a page comes back full. Duplicates are removed by _id.
  async function mwaterPages(path, filter, fields, token, onProgress, fetchImpl, size) {
    size = size || 5000; const out = []; const seen = new Set();
    for (let skip = 0; ; skip += size) {
      const page = await mwaterGet(path, { filter: JSON.stringify(filter), fields: JSON.stringify(fields), limit: String(size), skip: String(skip) }, token, fetchImpl);
      if (!Array.isArray(page)) throw new Error('mWater: unexpected reply on /' + path);
      page.forEach(r => { const id = r._id || JSON.stringify(r); if (!seen.has(id)) { seen.add(id); out.push(r); } });
      if (onProgress) onProgress(path, out.length);
      if (page.length < size) break;
      if (onProgress) onProgress('warn', path + ': more than ' + size + ' rows, paging without a stable sort');
    }
    return out;
  }
  async function mwaterLogin(username, password, fetchImpl) {
    const r = await (fetchImpl || fetch)(MWATER.api + '/clients', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
    if (!r.ok) throw new Error('mWater login failed (HTTP ' + r.status + ')');
    const b = await r.json(); const token = typeof b === 'string' ? b : (b.client || b.id || b._id); if (!token) throw new Error('mWater login: no client id in reply');
    return { token, username: (typeof b === 'object' && (b.username || b.email)) || username };
  }
  // Full frame load: entities of the programme group, admin regions for rows without admin_div fields, households served, latest functional status, SDWS 3 results
  async function mwaterLoadFrame(token, opts) {
    const o = opts || {}; const prog = o.onProgress || function () {}; const F = o.fetchImpl; const cfg = MWATER.forms; const used = [];
    const entities = await mwaterPages('entities/' + MWATER.entityType, { _managed_by: MWATER.group }, MWATER.entityFields, token, prog, F);
    const missing = [...new Set(entities.filter(e => !e.admin_div2 && e.admin_region).map(e => e.admin_region))];
    const regionsById = {};
    if (missing.length) { const regs = await mwaterGet('admin_regions', { filter: JSON.stringify({ _id: { $in: missing } }), fields: JSON.stringify({ _id: 1, full_name: 1 }), limit: String(missing.length) }, token, F); regs.forEach(r => { regionsById[r._id] = r; }); }
    const sd = cfg.sdws3; const sdFields = { ['data.' + sd.wpQ]: 1, ['data.' + sd.dateQ]: 1, submittedOn: 1, status: 1 }; sd.params.forEach(pm => { sdFields['data.' + pm.q] = 1; });
    const sdResp = await mwaterPages('responses', { form: sd.id, status: 'final' }, sdFields, token, prog, F); used.push(sd.id);
    const passing = sdws3PassingPoints(sdResp, sd);
    let roofs = {}, latest = {};
    try { const rr = await mwaterPages('responses', { form: cfg.beneficiaries.id, status: 'final' }, { ['data.' + cfg.beneficiaries.wpQ]: 1, ['data.' + cfg.beneficiaries.roofsQ]: 1, submittedOn: 1, status: 1 }, token, prog, F); roofs = mwaterRoofs(rr, cfg.beneficiaries); used.push(cfg.beneficiaries.id); } catch (e) { prog('warn', 'beneficiaries: ' + e.message); }
    try { const m = cfg.maintenance; const rr = await mwaterPages('responses', { form: m.id, status: 'final' }, { ['data.' + m.wpQ]: 1, ['data.' + m.statusQ]: 1, ['data.' + m.status2Q]: 1, ['data.' + m.pumpQ]: 1, ['data.' + m.workQ]: 1, ['data.' + m.endDateQ]: 1, submittedOn: 1, status: 1 }, token, prog, F); latest = mwaterLatestStatus(rr, m); used.push(m.id); } catch (e) { prog('warn', 'maintenance: ' + e.message); }
    const mapped = mapMwaterEntities(entities, { roofs, latest, regionsById, passing });
    return { fetchedAt: new Date().toISOString(), points: mapped.points, counts: mapped.counts, frameCsv: frameToCsv(mapped.points), formsUsed: used, sdws3Responses: sdResp.length, source: { api: MWATER.api, group: MWATER.group, entity_type: MWATER.entityType }, entities, latest, roofs, passing };
  }

  /* ---------- sampling record PDF (pdf-lib, standard fonts, deterministic output) ---------- */
  const PDF_SAFE = /[^\x20-\x7E\xA0-\xFFŒœ–—‘’“”•…€]/g;
  const RECORD_COORD_KEYS = /^(lat|lon|lng|latitude|longitude|coordinates|location|geometry)$/i;
  function hasCoordinateKeys(obj) { if (Array.isArray(obj)) return obj.some(hasCoordinateKeys); if (obj && typeof obj === 'object') return Object.keys(obj).some(k => RECORD_COORD_KEYS.test(k) || hasCoordinateKeys(obj[k])); return false; }
  const pdfSafe = str => String(str === undefined || str === null ? '' : str).replace(/≤/g, '<=').replace(/≥/g, '>=').replace(/→/g, '->').replace(/×/g, 'x').replace(/\r?\n/g, ' ').replace(PDF_SAFE, '?');
  async function buildSamplingRecordPdf(ctx) {
    const { PDFDocument, StandardFonts, rgb, PDFName, PDFString, PageSizes, AFRelationship } = ctx.PDFLib;
    const a = ctx.audit; const lang = ctx.lang === 'fr' ? 'fr' : 'en'; const T = (I18N[lang] && I18N[lang].pdf) || I18N.en.pdf; const P = a.parameters; const st = a.statistics; const kv = ctx.kValues || {};
    const rid = a.record_id || recordId({ roundName: P.round, stratum: P.stratum, seed: a.seed });
    const doc = await PDFDocument.create({ updateMetadata: false });
    const font = await doc.embedFont(StandardFonts.Helvetica), bold = await doc.embedFont(StandardFonts.HelveticaBold);
    const W = 595.28, H = 841.89, M = 50, CW = W - 2 * M; let page = null, y = 0;
    const newPage = () => { page = doc.addPage(PageSizes && PageSizes.A4 ? PageSizes.A4 : [W, H]); y = H - M; };
    const ensure = h => { if (!page || y - h < M + 22) newPage(); };
    const wrap = (text, f, size, width) => { const out = []; String(text).split(/\n/).forEach(par => { const words = par.split(/\s+/); let line = ''; words.forEach(wd => { const cand = line ? line + ' ' + wd : wd; if (f.widthOfTextAtSize(cand, size) <= width) line = cand; else { if (line) out.push(line); line = wd; while (f.widthOfTextAtSize(line, size) > width && line.length > 1) { let cut = line.length - 1; while (cut > 1 && f.widthOfTextAtSize(line.slice(0, cut), size) > width) cut--; out.push(line.slice(0, cut)); line = line.slice(cut); } } }); out.push(line); }); return out; };
    const para = (text, o) => { o = o || {}; const f = o.bold ? bold : font, size = o.size || 9.5, lh = size * 1.35; const lines = wrap(pdfSafe(text), f, size, CW - (o.indent || 0)); lines.forEach(l => { ensure(lh); page.drawText(l, { x: M + (o.indent || 0), y: y - size, size, font: f, color: o.color || rgb(0.1, 0.1, 0.1) }); y -= lh; }); y -= (o.gap === undefined ? 4 : o.gap); };
    const heading = (text) => { ensure(30); y -= 6; page.drawText(pdfSafe(text), { x: M, y: y - 12, size: 12.5, font: bold, color: rgb(0.04, 0.37, 0.54) }); y -= 18; page.drawLine({ start: { x: M, y }, end: { x: M + CW, y }, thickness: 0.6, color: rgb(0.04, 0.37, 0.54) }); y -= 6; };
    const kvRow = (label, value) => { const size = 9.5, lw = 150; const lines = wrap(pdfSafe(value), font, size, CW - lw - 6); const h = Math.max(1, lines.length) * size * 1.35; ensure(h); page.drawText(pdfSafe(label), { x: M, y: y - size, size, font: bold }); lines.forEach((l, i) => page.drawText(l, { x: M + lw, y: y - size - i * size * 1.35, size, font })); y -= h + 2; };
    const table = (headers, rows, widths) => {
      const size = 8.5, lh = size * 1.3, pad = 3; const drawHead = () => { ensure(lh + 2 * pad + 10); page.drawRectangle({ x: M, y: y - lh - 2 * pad, width: CW, height: lh + 2 * pad, color: rgb(0.93, 0.95, 0.97) }); let x = M; headers.forEach((h, i) => { page.drawText(pdfSafe(h), { x: x + pad, y: y - pad - size, size, font: bold }); x += widths[i]; }); y -= lh + 2 * pad; };
      drawHead();
      rows.forEach(r => { const cells = r.map((c, i) => wrap(pdfSafe(c), font, size, widths[i] - 2 * pad)); const n = Math.max.apply(null, cells.map(c => c.length)); const h = n * lh + 2 * pad; if (y - h < M + 22) { newPage(); drawHead(); } let x = M; cells.forEach((lines, i) => { lines.forEach((l, j) => page.drawText(l, { x: x + pad, y: y - pad - size - j * lh, size, font })); x += widths[i]; }); y -= h; page.drawLine({ start: { x: M, y }, end: { x: M + CW, y }, thickness: 0.3, color: rgb(0.8, 0.82, 0.85) }); });
      y -= 6;
    };
    const num = (v, d) => (v === undefined || v === null || v === '' || isNaN(v)) ? '—' : Number(v).toFixed(d === undefined ? 0 : d);
    const pct = v => Math.round(Number(v) * 100) + ' %';
    // ---- title
    newPage();
    page.drawText(pdfSafe(T.title), { x: M, y: y - 18, size: 18, font: bold, color: rgb(0.04, 0.37, 0.54) }); y -= 26;
    page.drawText(pdfSafe(P.round + ' / ' + P.stratum + ' — ' + T.record + ' ' + rid), { x: M, y: y - 11, size: 11, font }); y -= 22;
    heading(T.h_id);
    kvRow(T.programme, T.programme_v); kvRow(T.stratum, P.stratum + (MWATER.strata[P.stratum] ? ' — ' + MWATER.strata[P.stratum].label : '')); kvRow(T.round, P.round); kvRow(T.drawn_at, a.timestamp); kvRow(T.drawn_by, a.drawn_by || '—'); kvRow(T.record_id, rid); kvRow(T.tool, 'SaniTap Sampler v' + a.version + ' (' + (a.commit || 'dev') + ') — ' + (ctx.url || APP_URL));
    // ---- method
    heading(T.h_method);
    const method = 'pps_households';
    T.method_pps.forEach(t => para(t));
    para(T.method_poc);
    // ---- frame
    heading(T.h_frame);
    para(FRAME_RULE_TEXT[lang]);
    const inp = a.input || {}; const mw = inp.mwater || {};
    if (inp.source === 'mwater') { kvRow(T.frame_source, T.frame_source_mwater); kvRow(T.frame_group, mw.group || MWATER.group); kvRow(T.frame_forms, (mw.forms_used || []).join(', ') || '—'); kvRow(T.frame_fetched, mw.fetched_at || '—'); if (mw.stratum_filter) kvRow(T.frame_filter, mw.stratum_filter); }
    else { kvRow(T.frame_source, T.frame_source_csv); kvRow(T.frame_file, inp.water_points_file || '—'); }
    const c = mw.counts || {};
    if (c.total_in_group !== undefined) table([T.c_item, T.c_value], [[T.c_total, num(c.total_in_group)], [T.c_pass, num(c.sdws3_pass_count)], [T.c_nopass, num(c.excluded_no_pass)], [T.c_abandoned, num(c.excluded_abandoned)], [T.c_marolinta, num(c.excluded_marolinta)], [T.c_unassigned, num(c.unassigned)]].concat(Object.keys(c.eligible_by_stratum || {}).map(k => [T.c_eligible + ' ' + k, num(c.eligible_by_stratum[k])])), [CW - 120, 120]);
    kvRow(T.frame_eligible, num((a.frame || {}).eligible_points) + ' (' + P.stratum + ')'); kvRow(T.frame_sha, inp.water_points_sha256 || '—');
    // ---- randomness
    heading(T.h_random);
    kvRow(T.seed, a.seed); kvRow(T.seed_word, String(a.seed_word_uint32)); kvRow(T.prng, T.prng_v.replace('{v}', a.version + ' (' + (a.commit || 'dev') + ')'));
    if (a.stage1 && a.stage1.method === 'pps_households') kvRow(T.stage1_numbers, T.stage1_numbers_v.replace('{tot}', num(a.stage1.total_households)).replace('{int}', num(a.stage1.interval, 4)).replace('{start}', num(a.stage1.random_start, 4)).replace('{cert}', num(a.stage1.certainty_selections)).replace('{imp}', num(a.stage1.imputed_count)).replace('{impv}', num(a.stage1.imputed_weight)));
    para(T.reproducible);
    T.repro_steps.forEach((step, i) => para((i + 1) + '. ' + step.replace('{url}', ctx.url || APP_URL).replace('{sha}', inp.water_points_sha256 || '—').replace('{seed}', a.seed).replace('{round}', P.round).replace('{stratum}', P.stratum).replace('{target}', P.target_samples).replace('{m}', P.households_per_point).replace('{rep}', pct(P.replacement_fraction)).replace('{method}', T.method_name_pps), { indent: 12 }));
    // ---- design check
    heading(T.h_design);
    table([T.c_item, T.c_value], [[T.d_target, num(P.target_samples)], [T.d_sources, num(st.nWp) + ' (' + T.d_selected.replace('{n}', num(a.water_points.length)) + ')'], [T.d_m, num(st.m)], [T.d_n, num(st.nActual)], [T.d_pass, st.expectedPass], [T.d_conf, pct(P.confidence) + ' / ' + pct(P.precision) + ' ' + (P.precision_type === 'absolute' ? T.d_abs : T.d_rel)], [T.d_nreq, num(st.nReq)], [T.d_icc, st.icc], [T.d_deff, num(st.deff, 2)], [T.d_neff, num(st.nEff, 1)], [T.d_result, st.pass ? T.d_ok : T.d_fail]], [CW - 160, 160]);
    // ---- tables
    heading(T.h_selected);
    const kText = w => { const K = kv[w.water_point_id]; if (!K) return T.k_blank; const fn = fieldNumbers(a.seed, w.water_point_id, K, w.households.n, w.households.extra); return 'K=' + K + ': ' + fn.primary.join(', ') + ' (+' + fn.replacements.join(', ') + ')'; };
    const farIds = new Set(((a.reach_check || {}).sources || []).filter(x => x.far).map(x => x.water_point_id));
    const wrow = (w, rep) => [rep ? 'R' + w.order : String(w.order), w.water_point_id + (w.alt_id ? ' / ' + w.alt_id : ''), w.name || '', (w.commune || w.cluster || '') + (w.fokontany ? ' / ' + w.fokontany : ''), num(w.households_served), (farIds.has(w.water_point_id) ? T.far_mark + ' ' : '') + kText(w)];
    table([T.t_order, T.t_id, T.t_name, T.t_commune, T.t_hh, T.t_k], a.water_points.map(w => wrow(w, false)), [36, 70, 90, 95, 60, CW - 351]);
    heading(T.h_replacements); para(T.replacements_note);
    table([T.t_order, T.t_id, T.t_name, T.t_commune, T.t_hh, T.t_k], a.replacements.map(w => wrow(w, true)), [36, 70, 90, 95, 60, CW - 351]);
    heading(T.h_field_rule); para(T.field_rule_text.replace('{n}', P.households_per_point).replace('{r}', P.household_replacements));
    if (a.reach_check) { heading(T.h_reach); para(T.reach_text.replace('{km}', a.reach_check.threshold_km).replace('{town}', a.reach_check.town || '—')); const far = (a.reach_check.sources || []).filter(x => x.far); para(far.length ? T.reach_far.replace('{list}', far.map(x => x.water_point_id + ' (' + (x.nearest_km === null ? '—' : x.nearest_km + ' km') + ' / ' + (x.town_km === null ? '—' : x.town_km + ' km') + ')').join(', ')) : T.reach_none); }
    if (a.warnings && a.warnings.length) { heading(T.h_warnings); a.warnings.forEach(wn => para('- ' + JSON.stringify(wn))); }
    // ---- footer on every page
    const pages = doc.getPages(); const n = pages.length;
    pages.forEach((pg, i) => { const left = pdfSafe(T.footer_record + ' ' + rid + ' · ' + T.footer_sha + ' ' + (ctx.auditSha || '')); const right = pdfSafe('SaniTap Sampler v' + a.version + ' (' + (a.commit || 'dev') + ') · ' + T.page.replace('{x}', i + 1).replace('{y}', n)); pg.drawLine({ start: { x: M, y: M - 8 }, end: { x: W - M, y: M - 8 }, thickness: 0.4, color: rgb(0.7, 0.7, 0.7) }); pg.drawText(left, { x: M, y: M - 18, size: 6.5, font, color: rgb(0.35, 0.35, 0.35) }); pg.drawText(right, { x: W - M - font.widthOfTextAtSize(right, 6.5), y: M - 28, size: 6.5, font, color: rgb(0.35, 0.35, 0.35) }); });
    // ---- deterministic metadata: dates fixed to the draw timestamp; the token never enters this document
    const when = new Date(a.timestamp);
    doc.setTitle(pdfSafe(T.title + ' ' + rid)); doc.setAuthor(pdfSafe(a.drawn_by || 'SaniTap Sampler')); doc.setSubject(rid); doc.setKeywords(['record:' + rid, 'audit-sha256:' + (ctx.auditSha || '')]); doc.setProducer('SaniTap Sampler v' + a.version); doc.setCreator('SaniTap Sampler v' + a.version); doc.setCreationDate(when); doc.setModificationDate(when);
    const info = doc.context.lookup(doc.context.trailerInfo.Info); if (info && info.set) { info.set(PDFName.of('RecordId'), PDFString.of(rid)); info.set(PDFName.of('AuditSHA256'), PDFString.of(ctx.auditSha || '')); info.set(PDFName.of('FrameSHA256'), PDFString.of(inp.water_points_sha256 || '')); info.set(PDFName.of('Seed'), PDFString.of(String(a.seed))); }
    // the full audit record travels inside the PDF as an attached file (audit.json); its SHA-256 is in the footer and the Info dictionary
    if (ctx.auditText) { const bytes = utf8Bytes(ctx.auditText); await doc.attach(bytes, 'audit.json', { mimeType: 'application/json', description: 'SaniTap Sampler audit record ' + rid, creationDate: when, modificationDate: when, afRelationship: AFRelationship ? AFRelationship.Data : undefined }); }
    return doc.save({ useObjectStreams: false, addDefaultPage: false, updateFieldAppearances: false });
  }

  // Excel workbook (array-of-arrays per sheet) from the audit record: selected sources, replacements, parameters. No coordinates.
  function selectionWorkbook(audit, kValues, lang) {
    const T = (I18N[lang] && I18N[lang].xlsx) || I18N.en.xlsx; const P = audit.parameters, st = audit.statistics; const kv = kValues || {};
    const far = new Set(((audit.reach_check || {}).sources || []).filter(x => x.far).map(x => x.water_point_id));
    const numbers = w => { const K = kv[w.water_point_id]; if (!K) return ['', '', '']; const fn = fieldNumbers(audit.seed, w.water_point_id, K, w.households.n, w.households.extra); return [K, fn.primary.join(' '), fn.replacements.join(' ')]; };
    const row = (w, rep) => [rep ? 'R' + w.order : w.order, w.water_point_id, w.alt_id || '', w.name || '', w.commune || w.cluster || '', w.fokontany || '', w.households_served === '' ? '' : w.households_served].concat(numbers(w), [far.has(w.water_point_id) ? T.far : '']);
    const head = [T.order, T.id, T.alt, T.name, T.commune, T.fokontany, T.hh, T.k, T.numbers, T.rep_numbers, T.reach];
    const c = ((audit.input || {}).mwater || {}).counts || {};
    const params = [[T.param, T.value], [T.round, P.round], [T.stratum, P.stratum], [T.drawn_by, audit.drawn_by || ''], [T.drawn_at, audit.timestamp], [T.record_id, audit.record_id], [T.seed, audit.seed], [T.frame_sha, (audit.input || {}).water_points_sha256 || ''], [T.frame_source, (audit.input || {}).source || ''], [T.fetched_at, ((audit.input || {}).mwater || {}).fetched_at || ''],
      [T.c_total, c.total_in_group === undefined ? '' : c.total_in_group], [T.c_pass, c.sdws3_pass_count === undefined ? '' : c.sdws3_pass_count], [T.c_eligible, (audit.frame || {}).eligible_points], [T.target, P.target_samples], [T.sources, st.nWp], [T.m, P.households_per_point], [T.n, st.nActual], [T.pass_rate, st.expectedPass], [T.icc, st.icc], [T.deff, st.deff], [T.neff, st.nEff], [T.nreq, st.nReq], [T.check, st.pass ? T.check_ok : T.check_fail], [T.tool, 'SaniTap Sampler v' + audit.version + ' (' + (audit.commit || 'dev') + ')'], [T.protocol, audit.methodology || '']];
    return [{ name: T.sheet_selected, rows: [head].concat(audit.water_points.map(w => row(w, false))) }, { name: T.sheet_replacements, rows: [head].concat(audit.replacements.map(w => row(w, true))) }, { name: T.sheet_params, rows: params }];
  }
  // selection CSV (mWater import layout) rebuilt from an audit record, using the field-rule numbers stored in it
  function auditToCsv(audit) {
    const kv = { __seed: audit.seed }; (audit.field_rule_numbers || []).forEach(x => { kv[x.water_point_id] = x.K; });
    return toCsv({ params: { roundName: audit.parameters.round, stratum: audit.parameters.stratum, seed: audit.seed }, selected: audit.water_points, replacements: audit.replacements }, kv);
  }

  return { selectionWorkbook, auditToCsv, xmur3, mulberry32, makeRng, parseCsv, normaliseWaterPoints, normaliseHouseholds, csvEscape, haversineKm, sha256, sha256Sync, stats, draw, reachCheck, REACH_KM, fieldNumbers, ruleText, toCsv, auditJson, APP_VERSION, APP_COMMIT, APP_URL, PROTOCOL_VERSION, ALGORITHM, ALGORITHMS, MWATER, FRAME_COLUMNS, FRAME_RULE_TEXT, regionParts, mwaterStratum, sdws3Pass, sdws3PassingPoints, mwaterLatestStatus, mwaterRoofs, mapMwaterEntities, frameToCsv, mwaterGet, mwaterPages, mwaterLogin, mwaterLoadFrame, systematicPps, buildSamplingRecordPdf, recordId, hasCoordinateKeys, RECORD_COORD_KEYS, backlog };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = Core;

/* =====================================================================
 *  I18N — every label in one object
 * ===================================================================*/
const I18N = {
  en: {
    pdf: {
      title: 'Sampling record', record: 'record', h_id: '1. Identification', programme: 'Programme', programme_v: 'SaniTap safe drinking water supply, Madagascar — Gold Standard SDWS methodology v2.0 — operator MadAvance', stratum: 'Stratum', round: 'Round', drawn_at: 'Draw date/time (UTC)', drawn_by: 'Drawn by', record_id: 'Record id', tool: 'Tool',
      h_method: '2. Method', method_name_pps: 'Protocol ' + PROTOCOL_VERSION + ' section 6.4 (systematic PPS by households served)',
      method_pps: ['The sample is a two-stage cluster sample as described in the SaniTap Water Quality Testing Protocol ' + PROTOCOL_VERSION + ', section 6.4, applied separately to each stratum.', 'Stage 1 — sources. The eligible sources of the stratum are listed in a fixed order (commune, then water point id) with their number of households served. Sources are drawn at random with probability proportional to households served by systematic sampling: the list is cut into as many equal intervals of households as there are sources to select, one random start is drawn in the first interval, and the source containing each successive point (start, start + interval, start + 2 x interval, ...) is selected. Ordering by commune spreads the selection across communes in proportion to their households. A source serving more households than one interval is selected with certainty and the interval is recomputed on the others, so no source is selected twice. Sources with no recorded household count receive the median count of the stratum.', 'Replacement list. After the main selection, replacement sources are drawn one by one from the remaining sources, again with probability proportional to households served, and listed in draw order. A replacement is used only when a selected source cannot be sampled (pump broken, inaccessible, refusal); the reason is written on the field sheet and in mWater, and replacements are taken strictly in the listed order.', 'Stage 2 — households. At each source the sampler counts the households served (K) and draws the household numbers by the field rule: N random numbers between 1 and K plus replacements, generated from the round seed, the source id and K; for each number k the k-th household met when walking from the source is sampled. A point-of-use (PoU) sample is taken from the stored drinking water of each selected household.'],
     
      method_poc: 'Point-of-collection (PoC) sample. One PoC sample is taken at the source outlet on each day households of that source are sampled, after disinfection of the spout and flushing, so that every PoU sample is paired with a PoC sample of the same source and day.',
      h_frame: '3. Sampling frame', frame_source: 'Source of the frame', frame_source_mwater: 'Fetched live from the mWater API by the tool', frame_source_csv: 'CSV file loaded into the tool', frame_group: 'mWater group', frame_forms: 'mWater forms used', frame_fetched: 'Fetched at (UTC)', frame_filter: 'Stratum filter at fetch', frame_file: 'Frame file', frame_eligible: 'Eligible sources in this stratum', frame_sha: 'Frame file SHA-256',
      c_item: 'Item', c_value: 'Value', c_total: 'Water points in the MadAvance group', c_pass: 'with at least one passing SDWS 3 result', c_nopass: 'excluded: no passing result', c_abandoned: 'excluded: abandoned / not functional / not a hand pump', c_marolinta: 'excluded: Marolinta area (Beloha district)', c_unassigned: 'unassigned district', c_eligible: 'eligible in stratum',
      h_random: '4. Randomness and reproducibility', seed: 'Seed string', seed_word: 'Seed word (xmur3, uint32)', prng: 'Generator', prng_v: 'mulberry32 (32-bit), seeded with the xmur3 hash of the seed string — SaniTap Sampler v{v}', stage1_numbers: 'Stage 1 numbers', stage1_numbers_v: 'total households {tot}; interval {int}; random start {start}; certainty selections {cert}; sources with imputed count {imp} (value {impv})',
      reproducible: 'The same seed string, the same frame file and the same parameters reproduce exactly the same selection on any device. To reproduce this draw:',
      repro_steps: ['Open {url} (any browser; the tool runs offline after the first load).', 'Data: choose "CSV file", load the frame file whose SHA-256 is {sha} (the file is filed with this record and is also produced by "Download loaded frame").', 'Parameters: round "{round}", stratum {stratum}, target {target} samples, {m} households per source, replacement fraction {rep}, method "{method}", seed "{seed}".', 'Press "Draw the sample". The audit record shown must list the same sources in the same order as this document, and its SHA-256 must equal the value in the footer once exported.'],
      h_design: '5. Design check (CDM 90/10 rule)', d_target: 'Target PoU samples', d_sources: 'Sources to select', d_selected: '{n} selected', d_m: 'Households per source (m)', d_n: 'PoU samples planned (n)', d_pass: 'Expected pass rate (p)', d_conf: 'Confidence / precision', d_abs: 'absolute', d_rel: 'relative to p', d_nreq: 'Required sample size', d_icc: 'ICC assumed', d_deff: 'Design effect 1 + (m - 1) x ICC', d_neff: 'Effective sample size n / DEFF', d_result: 'Check', d_ok: 'PASS — effective n is at least the required n', d_fail: 'FAIL — effective n is below the required n',
      h_selected: '6. Selected sources (visit in any order; numbers are draw order)', h_replacements: '7. Replacement sources (use strictly in this order)', replacements_note: 'Use a replacement only when a selected source cannot be sampled; record the reason.', t_order: 'No.', t_id: 'Source id', t_name: 'Name', t_commune: 'Commune', t_hh: 'Households', t_k: 'Field rule (K, household numbers)', k_blank: 'K = ____ (numbers generated in the tool when K is entered)',
      h_field_rule: '8. Field rule', field_rule_text: 'At each source: count all households that draw water from it (K), enter K in the tool to obtain {n} household numbers plus {r} replacement numbers, and for each number k sample the k-th household met when walking from the source. Sterile sampling equipment is used and spouts are not flamed; the purge and the sampling steps are recorded in the mWater form. The numbers are generated from the seed, the source id and K, so they can be re-generated by the verifier.', h_reach: '9. Reach check', reach_text: 'Each selected source was compared with the nearest other selected source and with the district town ({town}). A source farther than {km} km from both is flagged for the field team: it is replaced in the field only if it proves unreachable, and the reason is recorded; the tool never replaces it automatically.', reach_far: 'Flagged sources (nearest source / town): {list}', reach_none: 'No source is flagged.', far_mark: 'FAR:',
      h_warnings: '10. Notes generated by the tool', footer_record: 'Record', footer_sha: 'audit JSON SHA-256', page: 'page {x} of {y}'
    },
    src_mwater: 'mWater (live)', src_csv: 'CSV file (offline)', mw_settings: 'mWater connection', mw_user: 'mWater username or email', mw_pass: 'Password', mw_pass_hint: '(used once to obtain a token; never stored)', mw_login: 'Sign in', mw_token: '…or paste an API token (client id)', mw_save: 'Save token', mw_forget: 'Forget token',
    mw_token_hint: "The token stays in this browser's local storage only, is shown masked, never logged and never included in exports.", mw_stratum: 'Stratum to load', mw_all: 'All strata', mw_fetch: 'Fetch from mWater',
    mw_connected: 'Token saved: {mask}{user}', mw_not_connected: 'No mWater token. Open "mWater connection" to sign in or paste a token. The programme water points are private, so a token is required.', mw_no_token: 'Sign in or paste a token first.', mw_fetching: 'Fetching {what}: {n} rows…', mw_done: 'Fetched {n} water points ({a} active) at {t}.', mw_err: 'Fetch failed: {e}. Check the connection and the token, or use the CSV source offline.', mw_login_err: 'Sign-in failed: {e}', mw_warn: 'Partial: {w}',
    data_frame_dl: 'Download loaded frame (CSV)', data_hh_dl: 'Download household list (CSV)', data_source: 'Source', data_fetched: 'fetched',
    p_drawn_by: 'Drawn by (name, role)', pdf_err: 'PDF library not loaded (needs one online visit first).', pdf_need_by: 'Enter "Drawn by" before exporting the record.', w_imputed: '{n} sources without a household count were given the stratum median ({value}) as sampling weight.',
    c_total: 'in MadAvance group', c_pass: 'with a passing SDWS 3 result', c_nopass: 'excluded: no passing result', c_abandoned: 'excluded: abandoned/not functional', c_marolinta: 'excluded: Marolinta', c_unassigned: 'unassigned district', c_eligible: 'eligible',
    tab_backlog: '1b Test A backlog', next_params: 'Next: set parameters and draw', bl_title: 'Test A backlog — SDWS 3', bl_intro: 'Sources of the loaded stratum that are in the register and not abandoned but have no passing SDWS 3 result yet.', bl_operating: 'Operating, untested', bl_failing: 'Last result failed', bl_notbuilt: 'Not yet built', bl_other: 'No records, unclassified', bl_none: 'No backlog for this stratum, or no frame loaded.', bl_csv: 'Export backlog CSV (with coordinates, download only)', bl_print: 'Print visit sheets per commune', bl_print_hint: 'Visit sheets and the CSV carry coordinates: for the field team only, never filed.', col_fokontany: 'Fokontany', col_last_visit: 'Last maintenance', col_last_test: 'Last test', col_result: 'Result', col_pattern: 'Name', col_records: 'Records', map_show: 'Show on map', map_show_draw: 'the draw', map_show_backlog: 'the Test A backlog (route from {town})', bl_sheet_title: 'Test A visit sheet', bl_sheet_commune: 'Commune', bl_sheet_cols: ['#', 'Source', 'Name', 'Fokontany', 'GPS', 'Group', 'Last maintenance', 'Households', 'Sample ID / result', 'Notes'], step_done: 'done', step_current: 'current', step_pending: 'pending', update_banner: 'New version available', update_reload: 'Reload',
    col_sel_short: 'Selected', k_blank_short: 'numbers appear when K is entered in the app', record_id_label: 'Record id', next_backlog: 'Next: Test A backlog', next_draw: 'Next: draw', next_map: 'Next: map', next_sheet: 'Next: field sheet', col_alt: 'Pump no.', reach_far: 'Far from the rest: replace in the field only if unreachable, and record the reason', reach_col: 'Reach', reach_ok: 'ok', reach_dist: 'nearest {n} km · town {t} km', map_list_title: 'Stops (number on the map = row)', w_far: 'Source {id} is more than 25 km from every other selected source and from the district town (nearest {nearest_km} km, town {town_km} km): replace in the field only if unreachable, and record the reason.',
    sheet_rule: 'Field rule (Protocol v2.2 §6.4): count the households served by this source (K), then take the k-th household met when walking from the source for each drawn number k. Sterile sampling equipment; no flaming. Enter K in the app to get the numbers, or use the pre-generated numbers below.', sheet_mwater: 'Sampling steps and results are recorded in the mWater form (SDWS 22 PoU); enter the record id {rid} on every form.', sheet_stops: 'Stop list',
    rule_short: '{n} of K: the k-th household walking from the source', sug_fewer: 'Keep {t} samples but use at most {m} households per source ({w} sources).', sug_more: 'Keep {m} households per source but select {w} sources ({s} samples).', w_insufficient: 'The stratum holds {have} eligible sources; {needed} were needed ({w} + {r} replacements).',
    xlsx: { sheet_selected: 'Selected sources', sheet_replacements: 'Replacements', sheet_params: 'Parameters', order: 'No.', id: 'Source id', alt: 'Pump no.', name: 'Name', commune: 'Commune', fokontany: 'Fokontany', hh: 'Households served', k: 'K', numbers: 'Household numbers', rep_numbers: 'Replacement numbers', reach: 'Reach', far: 'Far from the rest: replace in the field only if unreachable, and record the reason', param: 'Parameter', value: 'Value', round: 'Round', stratum: 'Stratum', drawn_by: 'Drawn by', drawn_at: 'Draw date/time (UTC)', record_id: 'Record id', seed: 'Seed', frame_sha: 'Frame SHA-256', frame_source: 'Frame source', fetched_at: 'Frame fetched at (UTC)', c_total: 'Water points in the MadAvance group', c_pass: 'With a passing SDWS 3 result', c_eligible: 'Eligible sources in the stratum', target: 'Target PoU samples', sources: 'Sources to select', m: 'Households per source', n: 'PoU samples planned', pass_rate: 'Expected pass rate', icc: 'ICC', deff: 'Design effect', neff: 'Effective sample size', nreq: 'Required sample size (90/10)', check: 'Design check', check_ok: 'PASS', check_fail: 'FAIL', tool: 'Tool', protocol: 'Methodology' },
    btn_pdf: 'Sampling record (PDF)', p_stratum_loaded: 'Stratum (loaded on the Data tab)', repro_line: 'Seed {seed}; the same seed and water point list reproduce this draw.', adv_title: 'Advanced: statistical check', btn_xlsx: 'Selection (Excel)', xlsx_err: 'Excel library not loaded (needs one online visit first).', data_stratum: 'Stratum to use',
    tab_data: '1 Data', tab_params: '2 Parameters', tab_results: '3 Draw', tab_map: '4 Map', tab_sheet: '5 Field sheet', tab_how: 'How it works',
    data_title: 'Load water points', data_privacy: 'Everything runs in your browser. No file leaves this device.',
    data_wp_label: 'Water points CSV (mWater export)', data_wp_cols: 'Required columns: water_point_id, name, stratum, commune, fokontany, village, lat, lon, households_served, status',
    data_hh_label: 'Households CSV (optional)', data_hh_cols: 'Columns: household_id, water_point_id, name_or_code, lat, lon',
    data_sample: 'Load sample data', data_clear: 'Clear stored data', data_loaded: 'Loaded', data_points: 'water points', data_hh: 'households linked to', data_none: 'No water points loaded.',
    col_stratum: 'Stratum', col_active: 'Active', col_inactive: 'Inactive', col_communes: 'Communes', col_hh_listed: 'Points with household list', sha: 'SHA-256', missing_cols: 'Missing columns',
    params_title: 'Round parameters', p_round: 'Round name', p_stratum: 'Stratum', p_target: 'Target PoU samples', p_hh: 'Households per water point',
    p_repfrac: 'Replacement fraction (%)',
    p_seed: 'Seed', p_seed_hint: '(reproduces the draw)', params_stats: 'Statistical check',
    p_icc: 'Intra-cluster correlation (ICC)', p_pass: 'Expected pass rate', p_conf: 'Confidence', p_prec: 'Precision (10 %)', prec_rel: 'Relative to the pass rate (CDM)', prec_abs: 'Absolute (±10 points)',
    btn_draw: 'Draw the sample', preview: 'Eligible sources: {n} in {c} communes. Sources to select: {w} + {r} replacements = {t}.',
    err_nodata: 'Load water points first.', err_noeligible: 'No active water points in this stratum (or none inside an axis).',
    res_empty: 'No draw yet. Load data and set parameters first.', res_title: 'Draw result', btn_print: 'Print field sheet',
    res_clusters: 'Clusters', res_points: 'Selected water points', res_points_hint: 'Type K (households served by the source, counted on the day) to generate the household numbers: the k-th household walking from the source.',
    st_nwp: 'Water points', st_nact: 'PoU samples planned', st_deff: 'Design effect', st_neff: 'Effective n', st_nreq: 'Required n ({c} % / {p} %)', st_rep: 'Replacement points',
    check_ok: 'Effective sample size {ne} ≥ required {nr}: the design meets the {c}/{p} rule for an expected pass rate of {pr}.',
    check_fail: 'Effective sample size {ne} < required {nr}. The design does NOT meet the {c}/{p} rule.',
   
    w_no_coords: '{n} eligible points have no coordinates; they can be drawn but not mapped.',
    w_short: 'Only {have} of {w} water points could be selected.',
    w_few_hh: 'Point {id} lists only {have} households ({needed} needed): all were taken.',
    col_order: '#', col_cluster: 'Cluster', col_size: 'Eligible points', yes: 'yes', no: '—',
    col_id: 'Water point', col_name: 'Name', col_village: 'Village', col_hh: 'Households', col_k: 'K', rep_wp: 'Replacement', rep_short: 'rep.',
    map_fit: 'Fit',
   
    map_no_draw: 'Draw a sample first to see points on the map.',
   
    sheet_hint: 'Use the browser print dialog; choose "Save as PDF" on the phone.', sheet_title: 'PoU/PoC sampling field sheet', sheet_round: 'Round', sheet_stratum: 'Stratum', sheet_seed: 'Seed', sheet_date: 'Date', sheet_team: 'Team', sheet_order: 'Stop', sheet_wp: 'Water point', sheet_cluster: 'Cluster', sheet_gps: 'GPS', sheet_arrive: 'Arrival time', sheet_depart: 'Departure time', sheet_replacement: 'REPLACEMENT POINT — use only if a primary point is unavailable; record the reason.',
    sheet_time: 'Time',
    sheet_k: 'K =', sheet_numbers: 'Selected household numbers', sheet_rep_numbers: 'Replacements',
   
    sheet_sign: 'Sampler signature', sheet_notes: 'Notes', sheet_empty: 'No draw yet.',
    foot: 'open source, no data leaves the device', offline: 'offline', online: '',
    howto_html: `
<h2>How the draw works</h2>
<p>SaniTap Sampler draws a reproducible, multi-stage cluster sample of households for point-of-use (PoU) water quality testing under the Gold Standard <em>Safe Drinking Water Supply</em> methodology v2.0. The multi-stage design follows the CDM <em>Standard: Sampling and surveys for CDM project activities and programmes of activities</em>.</p>
<h3>Randomness</h3>
<p>The seed text (default: round name + stratum, e.g. <code>2026R1-FD</code>) is hashed with <code>xmur3</code> into a 32-bit word which seeds a <code>mulberry32</code> pseudo-random generator. The same seed, the same input file and the same parameters always produce exactly the same selection, on any device. Records are sorted by identifier before drawing so the row order of the CSV does not matter.</p>
<h3>Frame</h3>
<p>Only water points with <code>status = active</code> in the chosen stratum are eligible.</p>
<h3>Stage 1 — sources (Protocol v2.2 §6.4)</h3>
<p>The eligible sources of the stratum are listed by commune then id with their households served. <code>ceil(target ÷ households per source)</code> sources are drawn by systematic sampling with probability proportional to households served: one random start, then every interval of households; ordering by commune spreads the selection across communes. A source larger than the interval is taken with certainty. A replacement list (replacement fraction × that number) is then drawn from the remaining sources, again proportional to households, in draw order; use replacements in that order only when a selected source cannot be sampled and record the reason.</p>
<h3>Stage 2 — households</h3>
<p>The field rule: count the households served (K) and draw N random numbers between 1 and K (plus 2 replacements); for each number k, sample the k-th household met when walking from the source. The numbers are generated when K is typed, from a generator seeded with <code>seed | water_point_id | K</code>, so they are reproducible. Sampling steps and results go on the mWater form (SDWS 22 PoU) with the record id.</p>
<h3>Reach check</h3>
<p>A selected source more than 25 km from every other selected source and from the district town is marked orange on the map and in the lists: replace it in the field only if it is unreachable, and record the reason.</p>
<h3>Statistical check</h3>
<p>Households sampled at the same water point are correlated. The design effect is <code>DEFF = 1 + (m − 1) × ICC</code> with m households per point and ICC default 0.1 (editable). Effective sample size is <code>n / DEFF</code>. The required sample size for a proportion at the expected pass rate p follows the CDM 90/10 rule: <code>n = z² p(1 − p) / d²</code> with z = 1.645 for 90 % confidence and d = 10 % of p (relative precision, CDM default) or 0.10 absolute. If the effective size is below the requirement the tool proposes fewer households per point (hence more water points and clusters) or more water points.</p>
<h3>Record and data</h3>
<p>The <b>sampling record (PDF)</b> is the evidence of random selection kept for the validation and verification body (VVB): it narrates the method, frame, seed, design check and selection, carries the seed and the frame hash in its footer, and contains the complete machine-readable audit as an attached file. The <b>selection (Excel)</b> file holds the same sources, replacements and parameters as data for the team. Neither contains coordinates.</p>
<h3>Map</h3>
<p>The map shows the selected sources numbered in draw order and the replacements (R1, R2, …) in grey, with the same numbers in the stop list beside it.</p>
<h3>Offline</h3>
<p>After the first load the app shell is cached by a service worker and works offline. Map tiles are not cached. Loaded data and the last draw are kept in the browser's local storage on this device only.</p>
<h3>Reset</h3>
<p>If the app shows an old version or misbehaves, <a href="./reset.html">Reset app</a>: it removes the cached copy and the service worker, keeps your mWater token and settings, and reloads the current build.</p>`
  },
  fr: {
    pdf: {
      title: 'Enregistrement d’échantillonnage', record: 'enregistrement', h_id: '1. Identification', programme: 'Programme', programme_v: 'SaniTap approvisionnement en eau potable, Madagascar — méthodologie Gold Standard SDWS v2.0 — opérateur MadAvance', stratum: 'Strate', round: 'Cycle', drawn_at: 'Date/heure du tirage (UTC)', drawn_by: 'Tiré par', record_id: 'Identifiant', tool: 'Outil',
      h_method: '2. Méthode', method_name_pps: 'Protocole ' + PROTOCOL_VERSION + ' section 6.4 (PPS systématique selon les ménages desservis)',
      method_pps: ['L’échantillon est un échantillon en grappes à deux degrés tel que décrit dans le Protocole SaniTap de tests de qualité de l’eau ' + PROTOCOL_VERSION + ', section 6.4, appliqué séparément à chaque strate.', 'Degré 1 — sources. Les sources éligibles de la strate sont listées dans un ordre fixe (commune, puis identifiant du point d’eau) avec leur nombre de ménages desservis. Les sources sont tirées au hasard avec une probabilité proportionnelle aux ménages desservis par tirage systématique : la liste est découpée en autant d’intervalles égaux de ménages qu’il y a de sources à sélectionner, un départ aléatoire est tiré dans le premier intervalle, et la source contenant chaque point successif (départ, départ + intervalle, départ + 2 x intervalle, ...) est sélectionnée. L’ordre par commune répartit la sélection entre les communes proportionnellement à leurs ménages. Une source desservant plus de ménages qu’un intervalle est sélectionnée d’office et l’intervalle est recalculé sur les autres, de sorte qu’aucune source n’est sélectionnée deux fois. Les sources sans nombre de ménages enregistré reçoivent la médiane de la strate.', 'Liste de remplacement. Après la sélection principale, les sources de remplacement sont tirées une à une parmi les sources restantes, toujours avec une probabilité proportionnelle aux ménages desservis, et listées dans l’ordre de tirage. Un remplacement n’est utilisé que si une source sélectionnée ne peut pas être échantillonnée (pompe en panne, inaccessible, refus) ; la raison est notée sur la fiche terrain et dans mWater, et les remplacements sont pris strictement dans l’ordre listé.', 'Degré 2 — ménages. À chaque source, le préleveur compte les ménages desservis (K) et tire les numéros de ménages selon la règle terrain : N nombres aléatoires entre 1 et K plus des remplacements, générés à partir de la graine du cycle, de l’identifiant de la source et de K ; pour chaque numéro k, le k-ième ménage rencontré en marchant depuis la source est prélevé. Un échantillon au point d’utilisation (PoU) est prélevé dans l’eau de boisson stockée de chaque ménage sélectionné.'],
     
      method_poc: 'Échantillon au point de collecte (PoC). Un échantillon PoC est prélevé à la sortie de la source chaque jour où des ménages de cette source sont échantillonnés, après désinfection du bec et purge, de sorte que chaque échantillon PoU est apparié à un échantillon PoC de la même source et du même jour.',
      h_frame: '3. Base de sondage', frame_source: 'Source de la base', frame_source_mwater: 'Chargée en direct depuis l’API mWater par l’outil', frame_source_csv: 'Fichier CSV chargé dans l’outil', frame_group: 'Groupe mWater', frame_forms: 'Formulaires mWater utilisés', frame_fetched: 'Chargée le (UTC)', frame_filter: 'Filtre de strate au chargement', frame_file: 'Fichier de base', frame_eligible: 'Sources éligibles dans cette strate', frame_sha: 'SHA-256 du fichier de base',
      c_item: 'Élément', c_value: 'Valeur', c_total: 'Points d’eau du groupe MadAvance', c_pass: 'avec au moins un résultat SDWS 3 conforme', c_nopass: 'exclus : aucun résultat conforme', c_abandoned: 'exclus : abandonnés / non fonctionnels / autre que pompe à main', c_marolinta: 'exclus : zone de Marolinta (district de Beloha)', c_unassigned: 'district non affecté', c_eligible: 'éligibles dans la strate',
      h_random: '4. Aléa et reproductibilité', seed: 'Graine (seed)', seed_word: 'Mot de graine (xmur3, uint32)', prng: 'Générateur', prng_v: 'mulberry32 (32 bits), initialisé par le hachage xmur3 de la graine — SaniTap Sampler v{v}', stage1_numbers: 'Nombres du degré 1', stage1_numbers_v: 'total des ménages {tot} ; intervalle {int} ; départ aléatoire {start} ; sélections d’office {cert} ; sources avec nombre imputé {imp} (valeur {impv})',
      reproducible: 'La même graine, le même fichier de base et les mêmes paramètres reproduisent exactement la même sélection sur n’importe quel appareil. Pour reproduire ce tirage :',
      repro_steps: ['Ouvrir {url} (tout navigateur ; l’outil fonctionne hors ligne après le premier chargement).', 'Données : choisir « Fichier CSV », charger le fichier de base dont le SHA-256 est {sha} (le fichier est classé avec cet enregistrement et est aussi produit par « Télécharger la base chargée »).', 'Paramètres : cycle « {round} », strate {stratum}, cible {target} échantillons, {m} ménages par source, fraction de remplacement {rep}, méthode « {method} », graine « {seed} ».', 'Appuyer sur « Tirer l’échantillon ». L’enregistrement d’audit affiché doit lister les mêmes sources dans le même ordre que ce document, et son SHA-256 doit être égal à la valeur en pied de page une fois exporté.'],
      h_design: '5. Vérification du plan (règle 90/10 du MDP)', d_target: 'Échantillons PoU visés', d_sources: 'Sources à sélectionner', d_selected: '{n} sélectionnées', d_m: 'Ménages par source (m)', d_n: 'Échantillons PoU prévus (n)', d_pass: 'Taux de conformité attendu (p)', d_conf: 'Confiance / précision', d_abs: 'absolue', d_rel: 'relative à p', d_nreq: 'Taille d’échantillon requise', d_icc: 'ICC supposé', d_deff: 'Effet de plan 1 + (m - 1) x ICC', d_neff: 'Taille effective n / DEFF', d_result: 'Vérification', d_ok: 'CONFORME — n effectif au moins égal au n requis', d_fail: 'NON CONFORME — n effectif inférieur au n requis',
      h_selected: '6. Sources sélectionnées (ordre de visite libre ; les numéros sont l’ordre de tirage)', h_replacements: '7. Sources de remplacement (à utiliser strictement dans cet ordre)', replacements_note: 'N’utiliser un remplacement que si une source sélectionnée ne peut pas être échantillonnée ; noter la raison.', t_order: 'N°', t_id: 'Id source', t_name: 'Nom', t_commune: 'Commune', t_hh: 'Ménages', t_k: 'Règle terrain (K, numéros de ménages)', k_blank: 'K = ____ (numéros générés dans l’outil à la saisie de K)',
      h_field_rule: '8. Règle terrain', field_rule_text: 'À chaque source : compter tous les ménages qui y puisent (K), saisir K dans l’outil pour obtenir {n} numéros de ménages plus {r} numéros de remplacement, et pour chaque numéro k prélever chez le k-ième ménage rencontré en marchant depuis la source. Le matériel de prélèvement est stérile et les becs ne sont pas flambés ; la purge et les étapes de prélèvement sont enregistrées dans le formulaire mWater. Les numéros sont générés à partir de la graine, de l’identifiant de la source et de K : le vérificateur peut les régénérer.', h_reach: '9. Vérification d’accès', reach_text: 'Chaque source sélectionnée a été comparée à la source sélectionnée la plus proche et à la ville du district ({town}). Une source à plus de {km} km des deux est signalée à l’équipe terrain : elle n’est remplacée sur le terrain que si elle s’avère inaccessible, et la raison est notée ; l’outil ne la remplace jamais automatiquement.', reach_far: 'Sources signalées (source la plus proche / ville) : {list}', reach_none: 'Aucune source signalée.', far_mark: 'LOIN :',
      h_warnings: '10. Notes générées par l’outil', footer_record: 'Enregistrement', footer_sha: 'SHA-256 du JSON d’audit', page: 'page {x} sur {y}'
    },
    src_mwater: 'mWater (en direct)', src_csv: 'Fichier CSV (hors ligne)', mw_settings: 'Connexion mWater', mw_user: 'Identifiant ou e-mail mWater', mw_pass: 'Mot de passe', mw_pass_hint: '(utilisé une fois pour obtenir un jeton ; jamais stocké)', mw_login: 'Se connecter', mw_token: '…ou coller un jeton API (client id)', mw_save: 'Enregistrer le jeton', mw_forget: 'Oublier le jeton',
    mw_token_hint: 'Le jeton reste uniquement dans le stockage local de ce navigateur, est affiché masqué, jamais journalisé ni inclus dans les exports.', mw_stratum: 'Strate à charger', mw_all: 'Toutes les strates', mw_fetch: 'Charger depuis mWater',
    mw_connected: 'Jeton enregistré : {mask}{user}', mw_not_connected: 'Aucun jeton mWater. Ouvrez « Connexion mWater » pour vous connecter ou coller un jeton. Les points d’eau du programme sont privés : un jeton est nécessaire.', mw_no_token: 'Connectez-vous ou collez un jeton d’abord.', mw_fetching: 'Chargement {what} : {n} lignes…', mw_done: '{n} points d’eau chargés ({a} actifs) à {t}.', mw_err: 'Échec du chargement : {e}. Vérifiez la connexion et le jeton, ou utilisez la source CSV hors ligne.', mw_login_err: 'Connexion échouée : {e}', mw_warn: 'Partiel : {w}',
    data_frame_dl: 'Télécharger la base chargée (CSV)', data_hh_dl: 'Télécharger la liste des ménages (CSV)', data_source: 'Source', data_fetched: 'chargé',
    p_drawn_by: 'Tiré par (nom, fonction)', pdf_err: 'Bibliothèque PDF non chargée (une visite en ligne est nécessaire).', pdf_need_by: 'Renseignez « Tiré par » avant d’exporter l’enregistrement.', w_imputed: '{n} sources sans nombre de ménages ont reçu la médiane de la strate ({value}) comme poids de sondage.',
    c_total: 'dans le groupe MadAvance', c_pass: 'avec un résultat SDWS 3 conforme', c_nopass: 'exclus : aucun résultat conforme', c_abandoned: 'exclus : abandonnés/non fonctionnels', c_marolinta: 'exclus : Marolinta', c_unassigned: 'district non affecté', c_eligible: 'éligibles',
    tab_backlog: '1b À tester (SDWS 3)', next_params: 'Suite : paramètres et tirage', bl_title: 'À tester — SDWS 3', bl_intro: 'Sources de la strate chargée qui sont dans le registre et non abandonnées mais sans résultat SDWS 3 conforme.', bl_operating: 'En service, non testées', bl_failing: 'Dernier résultat non conforme', bl_notbuilt: 'Pas encore construites', bl_other: 'Sans enregistrement, non classées', bl_none: 'Aucun point à tester pour cette strate, ou aucune base chargée.', bl_csv: 'Exporter le CSV (avec coordonnées, téléchargement seulement)', bl_print: 'Imprimer les fiches de visite par commune', bl_print_hint: 'Les fiches de visite et le CSV contiennent des coordonnées : pour l’équipe terrain seulement, jamais archivés.', col_fokontany: 'Fokontany', col_last_visit: 'Dernière maintenance', col_last_test: 'Dernier test', col_result: 'Résultat', col_pattern: 'Nom', col_records: 'Enregistrements', map_show: 'Afficher sur la carte', map_show_draw: 'le tirage', map_show_backlog: 'les points à tester (itinéraire depuis {town})', bl_sheet_title: 'Fiche de visite Test A', bl_sheet_commune: 'Commune', bl_sheet_cols: ['N°', 'Source', 'Nom', 'Fokontany', 'GPS', 'Groupe', 'Dernière maintenance', 'Ménages', 'ID échantillon / résultat', 'Notes'], step_done: 'fait', step_current: 'en cours', step_pending: 'à faire', update_banner: 'Nouvelle version disponible', update_reload: 'Recharger',
    col_sel_short: 'Sélectionnées', k_blank_short: 'les numéros apparaissent quand K est saisi dans l’application', record_id_label: 'Identifiant d’enregistrement', next_backlog: 'Suite : points à tester', next_draw: 'Suite : tirage', next_map: 'Suite : carte', next_sheet: 'Suite : fiche terrain', col_alt: 'N° pompe', reach_far: 'Éloignée des autres : remplacer sur le terrain seulement si inaccessible, et noter la raison', reach_col: 'Accès', reach_ok: 'ok', reach_dist: 'plus proche {n} km · ville {t} km', map_list_title: 'Étapes (numéro sur la carte = ligne)', w_far: 'La source {id} est à plus de 25 km de toute autre source sélectionnée et de la ville du district (plus proche {nearest_km} km, ville {town_km} km) : remplacer sur le terrain seulement si inaccessible, et noter la raison.',
    sheet_rule: 'Règle terrain (Protocole v2.2 §6.4) : compter les ménages desservis par cette source (K), puis prendre le k-ième ménage rencontré en marchant depuis la source pour chaque numéro k tiré. Matériel de prélèvement stérile ; pas de flambage. Saisir K dans l’application pour obtenir les numéros, ou utiliser les numéros pré-générés ci-dessous.', sheet_mwater: 'Les étapes et résultats du prélèvement sont enregistrés dans le formulaire mWater (SDWS 22 PoU) ; inscrire l’identifiant d’enregistrement {rid} sur chaque formulaire.', sheet_stops: 'Liste des étapes',
    rule_short: '{n} parmi K : le k-ième ménage en marchant depuis la source', sug_fewer: 'Garder {t} échantillons mais au plus {m} ménages par source ({w} sources).', sug_more: 'Garder {m} ménages par source mais sélectionner {w} sources ({s} échantillons).', w_insufficient: 'La strate compte {have} sources éligibles ; il en fallait {needed} ({w} + {r} remplacements).',
    xlsx: { sheet_selected: 'Sources sélectionnées', sheet_replacements: 'Remplacements', sheet_params: 'Paramètres', order: 'N°', id: 'Id source', alt: 'N° pompe', name: 'Nom', commune: 'Commune', fokontany: 'Fokontany', hh: 'Ménages desservis', k: 'K', numbers: 'Numéros de ménages', rep_numbers: 'Numéros de remplacement', reach: 'Accès', far: 'Éloignée des autres : remplacer sur le terrain seulement si inaccessible, et noter la raison', param: 'Paramètre', value: 'Valeur', round: 'Cycle', stratum: 'Strate', drawn_by: 'Tiré par', drawn_at: 'Date/heure du tirage (UTC)', record_id: 'Identifiant', seed: 'Graine', frame_sha: 'SHA-256 de la base', frame_source: 'Source de la base', fetched_at: 'Base chargée le (UTC)', c_total: 'Points d’eau du groupe MadAvance', c_pass: 'Avec un résultat SDWS 3 conforme', c_eligible: 'Sources éligibles dans la strate', target: 'Échantillons PoU visés', sources: 'Sources à sélectionner', m: 'Ménages par source', n: 'Échantillons PoU prévus', pass_rate: 'Taux de conformité attendu', icc: 'ICC', deff: 'Effet de plan', neff: 'Taille effective', nreq: 'Taille requise (90/10)', check: 'Vérification du plan', check_ok: 'CONFORME', check_fail: 'NON CONFORME', tool: 'Outil', protocol: 'Méthodologie' },
    btn_pdf: 'Enregistrement d’échantillonnage (PDF)', p_stratum_loaded: 'Strate (chargée dans l’onglet Données)', repro_line: 'Graine {seed} ; la même graine et la même liste de points d’eau reproduisent ce tirage.', adv_title: 'Avancé : vérification statistique', btn_xlsx: 'Sélection (Excel)', xlsx_err: 'Bibliothèque Excel non chargée (une visite en ligne est nécessaire).', data_stratum: 'Strate à utiliser',
    tab_data: '1 Données', tab_params: '2 Paramètres', tab_results: '3 Tirage', tab_map: '4 Carte', tab_sheet: '5 Fiche terrain', tab_how: 'Fonctionnement',
    data_title: 'Charger les points d’eau', data_privacy: 'Tout se passe dans votre navigateur. Aucun fichier ne quitte cet appareil.',
    data_wp_label: 'CSV des points d’eau (export mWater)', data_wp_cols: 'Colonnes requises : water_point_id, name, stratum, commune, fokontany, village, lat, lon, households_served, status',
    data_hh_label: 'CSV des ménages (facultatif)', data_hh_cols: 'Colonnes : household_id, water_point_id, name_or_code, lat, lon',
    data_sample: 'Charger les données d’exemple', data_clear: 'Effacer les données stockées', data_loaded: 'Chargé', data_points: 'points d’eau', data_hh: 'ménages liés à', data_none: 'Aucun point d’eau chargé.',
    col_stratum: 'Strate', col_active: 'Actifs', col_inactive: 'Inactifs', col_communes: 'Communes', col_hh_listed: 'Points avec liste de ménages', sha: 'SHA-256', missing_cols: 'Colonnes manquantes',
    params_title: 'Paramètres du cycle', p_round: 'Nom du cycle', p_stratum: 'Strate', p_target: 'Échantillons PoU visés', p_hh: 'Ménages par point d’eau',
    p_repfrac: 'Fraction de remplacement (%)',
    p_seed: 'Graine (seed)', p_seed_hint: '(reproduit le tirage)', params_stats: 'Vérification statistique',
    p_icc: 'Corrélation intra-grappe (ICC)', p_pass: 'Taux de conformité attendu', p_conf: 'Confiance', p_prec: 'Précision (10 %)', prec_rel: 'Relative au taux attendu (CDM)', prec_abs: 'Absolue (±10 points)',
    btn_draw: 'Tirer l’échantillon', preview: 'Sources éligibles : {n} dans {c} communes. Sources à sélectionner : {w} + {r} remplacements = {t}.',
    err_nodata: 'Chargez d’abord les points d’eau.', err_noeligible: 'Aucun point d’eau actif dans cette strate (ou aucun à l’intérieur d’un axe).',
    res_empty: 'Pas encore de tirage. Chargez les données et fixez les paramètres.', res_title: 'Résultat du tirage', btn_print: 'Imprimer la fiche terrain',
    res_clusters: 'Grappes', res_points: 'Points d’eau sélectionnés', res_points_hint: 'Saisissez K (ménages desservis par la source, comptés le jour même) pour générer les numéros de ménages : le k-ième ménage en marchant depuis la source.',
    st_nwp: 'Points d’eau', st_nact: 'Échantillons PoU prévus', st_deff: 'Effet de plan', st_neff: 'n effectif', st_nreq: 'n requis ({c} % / {p} %)', st_rep: 'Points de remplacement',
    check_ok: 'Taille effective {ne} ≥ requise {nr} : le plan respecte la règle {c}/{p} pour un taux de conformité attendu de {pr}.',
    check_fail: 'Taille effective {ne} < requise {nr}. Le plan NE respecte PAS la règle {c}/{p}.',
   
    w_no_coords: '{n} points éligibles sans coordonnées : tirables mais non cartographiables.',
    w_short: 'Seulement {have} des {w} points d’eau ont pu être sélectionnés.',
    w_few_hh: 'Le point {id} ne liste que {have} ménages ({needed} requis) : tous ont été pris.',
    col_order: 'N°', col_cluster: 'Grappe', col_size: 'Points éligibles', yes: 'oui', no: '—',
    col_id: 'Point d’eau', col_name: 'Nom', col_village: 'Village', col_hh: 'Ménages', col_k: 'K', rep_wp: 'Remplacement', rep_short: 'rempl.',
    map_fit: 'Cadrer',
   
    map_no_draw: 'Faites d’abord un tirage pour voir les points sur la carte.',
   
    sheet_hint: 'Utilisez l’impression du navigateur ; choisissez « Enregistrer en PDF » sur le téléphone.', sheet_title: 'Fiche terrain échantillonnage PoU/PoC', sheet_round: 'Cycle', sheet_stratum: 'Strate', sheet_seed: 'Graine', sheet_date: 'Date', sheet_team: 'Équipe', sheet_order: 'Étape', sheet_wp: 'Point d’eau', sheet_cluster: 'Grappe', sheet_gps: 'GPS', sheet_arrive: 'Heure d’arrivée', sheet_depart: 'Heure de départ', sheet_replacement: 'POINT DE REMPLACEMENT — à utiliser seulement si un point principal est indisponible ; noter la raison.',
    sheet_time: 'Heure',
    sheet_k: 'K =', sheet_numbers: 'Numéros de ménages sélectionnés', sheet_rep_numbers: 'Remplacements',
   
    sheet_sign: 'Signature du préleveur', sheet_notes: 'Notes', sheet_empty: 'Pas encore de tirage.',
    foot: 'code ouvert, aucune donnée ne quitte l’appareil', offline: 'hors ligne', online: '',
    howto_html: `
<h2>Comment fonctionne le tirage</h2>
<p>SaniTap Sampler tire un échantillon en grappes à plusieurs degrés, reproductible, de ménages pour les tests de qualité de l’eau au point d’utilisation (PoU) selon la méthodologie Gold Standard <em>Safe Drinking Water Supply</em> v2.0. Le plan à plusieurs degrés suit le <em>Standard: Sampling and surveys for CDM project activities and programmes of activities</em> du MDP.</p>
<h3>Aléa</h3>
<p>Le texte de la graine (par défaut : nom du cycle + strate, p. ex. <code>2026R1-FD</code>) est haché par <code>xmur3</code> en un mot de 32 bits qui initialise le générateur pseudo-aléatoire <code>mulberry32</code>. La même graine, le même fichier et les mêmes paramètres produisent toujours exactement la même sélection, sur n’importe quel appareil. Les enregistrements sont triés par identifiant avant le tirage : l’ordre des lignes du CSV n’a pas d’importance.</p>
<h3>Base de sondage</h3>
<p>Seuls les points d’eau avec <code>status = active</code> dans la strate choisie sont éligibles.</p>
<h3>Degré 1 — sources (Protocole v2.2 §6.4)</h3>
<p>Les sources éligibles de la strate sont listées par commune puis identifiant avec leurs ménages desservis. <code>ceil(cible ÷ ménages par source)</code> sources sont tirées par sondage systématique à probabilité proportionnelle aux ménages desservis : un départ aléatoire, puis un pas égal à l’intervalle de ménages ; l’ordre par commune répartit la sélection entre les communes. Une source plus grande que l’intervalle est prise d’office. Une liste de remplacement (fraction × ce nombre) est ensuite tirée parmi les sources restantes, toujours proportionnellement aux ménages, dans l’ordre du tirage ; n’utiliser les remplacements, dans cet ordre, que si une source sélectionnée ne peut pas être échantillonnée, et noter la raison.</p>
<h3>Degré 2 — ménages</h3>
<p>La règle terrain : compter les ménages desservis (K) et tirer N numéros entre 1 et K (+ 2 remplacements) ; pour chaque numéro k, prélever chez le k-ième ménage rencontré en marchant depuis la source. Les numéros sont générés quand K est saisi, par un générateur initialisé avec <code>graine | water_point_id | K</code> : ils sont reproductibles. Les étapes et résultats du prélèvement sont notés dans le formulaire mWater (SDWS 22 PoU) avec l’identifiant d’enregistrement.</p>
<h3>Vérification d’accès</h3>
<p>Une source sélectionnée à plus de 25 km de toute autre source sélectionnée et de la ville du district est marquée en orange sur la carte et dans les listes : ne la remplacer sur le terrain que si elle est inaccessible, et noter la raison.</p>
<h3>Vérification statistique</h3>
<p>Les ménages d’un même point d’eau sont corrélés. L’effet de plan est <code>DEFF = 1 + (m − 1) × ICC</code> avec m ménages par point et ICC = 0,1 par défaut (modifiable). La taille effective est <code>n / DEFF</code>. La taille requise pour une proportion au taux attendu p suit la règle 90/10 du MDP : <code>n = z² p(1 − p) / d²</code> avec z = 1,645 pour 90 % de confiance et d = 10 % de p (précision relative, défaut MDP) ou 0,10 en absolu. Si la taille effective est insuffisante, l’outil propose moins de ménages par point (donc plus de points et de grappes) ou plus de points d’eau.</p>
<h3>Enregistrement et données</h3>
<p>L’<b>enregistrement d’échantillonnage (PDF)</b> est la preuve de sélection aléatoire conservée pour l’organisme de validation et vérification (VVB) : il décrit la méthode, la base, la graine, la vérification du plan et la sélection, porte la graine et l’empreinte de la base en pied de page, et contient l’audit complet lisible par machine en fichier joint. Le fichier <b>sélection (Excel)</b> contient les mêmes sources, remplacements et paramètres sous forme de données pour l’équipe. Aucun des deux ne contient de coordonnées.</p>
<h3>Carte</h3>
<p>La carte montre les sources sélectionnées numérotées dans l’ordre du tirage et les remplacements (R1, R2, …) en gris, avec les mêmes numéros dans la liste des étapes à côté.</p>
<h3>Hors ligne</h3>
<p>Après le premier chargement, l’application est mise en cache par un service worker et fonctionne hors ligne. Les tuiles de carte ne sont pas mises en cache. Données et dernier tirage sont conservés dans le stockage local du navigateur, sur cet appareil seulement.</p>
<h3>Réinitialiser</h3>
<p>Si l’application affiche une ancienne version ou se comporte mal, <a href="./reset.html">Réinitialiser l’application</a> : la copie en cache et le service worker sont supprimés, le jeton mWater et les réglages sont conservés, et la version en ligne est rechargée.</p>`
  }
};

/* =====================================================================
 *  UI (browser only)
 * ===================================================================*/
if (typeof window !== 'undefined' && typeof document !== 'undefined') (function () {
  const $ = id => document.getElementById(id);
  const LS = { get(k, d) { try { const v = localStorage.getItem('sanitap.' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } }, set(k, v) { try { localStorage.setItem('sanitap.' + k, JSON.stringify(v)); } catch (e) { console.warn('localStorage', e); } }, del(k) { try { localStorage.removeItem('sanitap.' + k); } catch (e) {} } };
  const state = { mw: LS.get('mw', null), lang: LS.get('lang', (navigator.language || '').startsWith('fr') ? 'fr' : 'en'), wp: LS.get('wp', null), points: [], result: null, kValues: LS.get('k', {}), map: null, layers: {} };
  const t = (k, v) => { let s = (I18N[state.lang] && I18N[state.lang][k]) || I18N.en[k] || k; if (v) for (const x in v) s = s.split('{' + x + '}').join(v[x]); return s; };
  const esc = s => String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (n, d) => (n === undefined || n === null || isNaN(n)) ? '' : Number(n).toFixed(d === undefined ? 1 : d);

  /* ---------- language ---------- */
  function applyLang() {
    document.documentElement.lang = state.lang;
    document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
    $('lang-toggle').textContent = state.lang === 'en' ? 'FR' : 'EN';
    $('howto').innerHTML = t('howto_html');
    $('ver').textContent = 'v' + APP_VERSION + (APP_COMMIT && APP_COMMIT.indexOf('__') !== 0 ? ' (' + APP_COMMIT + ')' : ' (dev)');
    renderData(); renderPreview(); renderResults(); renderSheet(); renderMapList(); renderMw(); renderBacklog(); updateSteps();
  }
  $('lang-toggle').onclick = () => { state.lang = state.lang === 'en' ? 'fr' : 'en'; LS.set('lang', state.lang); applyLang(); };

  /* ---------- tabs ---------- */
  function updateSteps() {
    const done = { data: !!state.wp, backlog: !!state.wp, params: !!state.result, results: !!state.result, map: !!state.result, sheet: false, how: false };
    document.querySelectorAll('nav button').forEach(b => { const tab = b.dataset.tab; b.classList.toggle('done', !!done[tab] && !b.classList.contains('active')); b.classList.toggle('pending', !done[tab] && !b.classList.contains('active')); b.title = t(b.classList.contains('active') ? 'step_current' : done[tab] ? 'step_done' : 'step_pending'); });
  }
  function showTab(name) {
    document.querySelectorAll('nav button').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
    updateSteps();
    document.querySelectorAll('section.tab').forEach(s => s.classList.toggle('active', s.id === 'tab-' + name));
    if (name === 'map') { initMap(); if (state.map) setTimeout(() => { state.map.invalidateSize(); renderMap(); }, 50); }
    try { window.scrollTo(0, 0); } catch (e) {}
  }
  document.querySelectorAll('nav button').forEach(b => b.onclick = () => showTab(b.dataset.tab));

  /* ---------- data ---------- */
  const REQUIRED_WP = ['water_point_id', 'name', 'stratum', 'commune', 'fokontany', 'village', 'lat', 'lon', 'households_served', 'status'];
  function readFile(file) { return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsText(file); }); }
  async function loadWp(text, name, meta) {
    const parsed = Core.parseCsv(text);
    const missing = REQUIRED_WP.filter(c => !parsed.header.includes(c) && !(c === 'lat' && parsed.header.includes('latitude')) && !(c === 'lon' && (parsed.header.includes('longitude') || parsed.header.includes('lng'))));
    const hash = await Core.sha256(text);
    state.wp = Object.assign({ name, hash, text, missing, source: 'csv' }, meta || {});
    LS.set('wp', state.wp);
    applyWp();
  }
  function applyWp() {
    if (!state.wp) { state.points = []; return; }
    const n = Core.normaliseWaterPoints(Core.parseCsv(state.wp.text).records);
    state.points = n.points; state.wp.errors = n.errors;
    const strata = [...new Set(state.points.map(p => p.stratum).filter(Boolean))].sort();
    const sel = $('p-stratum'); const cur = sel.value;
    sel.innerHTML = strata.map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
    if (strata.includes(cur)) sel.value = cur;
    const ds = $('data-stratum'); ds.innerHTML = sel.innerHTML; ds.value = sel.value; $('data-stratum-wrap').classList.toggle('hidden', strata.length < 2);
    updateSeed();
  }
  $('file-wp').onchange = async e => { const f = e.target.files[0]; if (!f) return; await loadWp(await readFile(f), f.name, { source: 'csv' }); setSource('csv'); renderData(); renderPreview(); renderBacklog(); updateSteps(); };
  $('btn-sample').onclick = async () => {
    try {
      const a = await fetch('data/sample-water-points.csv').then(r => r.text());
      await loadWp(a, 'sample-water-points.csv', { source: 'csv' }); setSource('csv'); renderData(); renderPreview();
    } catch (e) { $('data-status').innerHTML = `<div class="msg err">${esc(e.message)}</div>`; }
  };
  $('btn-clear').onclick = () => { ['wp', 'last', 'k', 'start', 'axes'].forEach(LS.del); state.wp = null; state.points = []; state.result = null; state.kValues = {}; applyWp(); renderData(); renderPreview(); renderResults(); renderSheet(); renderMapList(); updateSteps(); };
  function renderData() {
    const st = $('data-status'), sm = $('data-summary');
    if (!state.wp) { st.innerHTML = `<div class="msg warn">${t('data_none')}</div>`; sm.innerHTML = ''; $('btn-frame-dl').classList.add('hidden'); $('btn-next-params').classList.add('hidden'); return; }
    const src = state.wp.source === 'mwater' ? `mWater · ${t('data_fetched')} ${esc(state.wp.fetchedAt || '')}` : 'CSV';
    let h = `<div class="msg ok">${t('data_source')}: <b>${src}</b><br>${t('data_loaded')}: <b>${esc(state.wp.name)}</b> — ${state.points.length} ${t('data_points')}${state.wp.counts ? ` (${state.wp.counts.active} ${t('col_active').toLowerCase()})` : ''}<br><small>${t('sha')}: ${state.wp.hash}</small></div>`;
    $('btn-frame-dl').classList.remove('hidden'); $('btn-next-params').classList.remove('hidden');
    const fc = state.wp.mwater && state.wp.mwater.counts; if (fc && fc.total_in_group !== undefined) h += `<div class="stat">${[['c_total', fc.total_in_group], ['c_pass', fc.sdws3_pass_count], ['c_nopass', fc.excluded_no_pass], ['c_abandoned', fc.excluded_abandoned], ['c_marolinta', fc.excluded_marolinta], ['c_unassigned', fc.unassigned]].map(x => `<div><b>${x[1]}</b><span>${t(x[0])}</span></div>`).join('')}${Object.keys(fc.eligible_by_stratum || {}).map(k => `<div><b>${fc.eligible_by_stratum[k]}</b><span>${t('c_eligible')} ${k}</span></div>`).join('')}${backlogTiles()}</div>`;
    if (state.wp.missing.length) h += `<div class="msg err">${t('missing_cols')}: ${state.wp.missing.join(', ')}</div>`;
    if (state.wp.errors && state.wp.errors.length) h += `<div class="msg warn">${state.wp.errors.slice(0, 5).map(esc).join('<br>')}${state.wp.errors.length > 5 ? '…' : ''}</div>`;
    st.innerHTML = h;
    const by = {};
    state.points.forEach(p => { const b = by[p.stratum] = by[p.stratum] || { a: 0, i: 0, c: new Set(), hh: 0 }; p.active ? b.a++ : b.i++; if (p.active) { b.c.add(p.commune); b.hh += p.households_served || 0; } });
    sm.innerHTML = `<table><tr><th>${t('col_stratum')}</th><th>${t('col_active')}</th><th>${t('col_inactive')}</th><th>${t('col_communes')}</th><th>${t('col_hh')}</th></tr>` +
      Object.keys(by).sort().map(s => `<tr><td>${esc(s)}</td><td>${by[s].a}</td><td>${by[s].i}</td><td>${by[s].c.size}</td><td>${by[s].hh}</td></tr>`).join('') + '</table>';
  }


  /* ---------- mWater source ---------- */
  const mask = tok => tok ? '••••' + String(tok).slice(-4) : '';
  function renderMw() {
    const c = $('mw-conn');
    c.innerHTML = state.mw && state.mw.token ? `<span class="msg ok" style="display:inline-block">${t('mw_connected', { mask: mask(state.mw.token), user: state.mw.username ? ' · ' + esc(state.mw.username) : '' })}</span>` : `<div class="msg warn">${t('mw_not_connected')}</div>`;
    const sel = $('mw-stratum'); const cur = sel.value;
    sel.innerHTML = `<option value="">${t('mw_all')}</option>` + Object.keys(Core.MWATER.strata).map(k => `<option value="${k}">${k} — ${esc(Core.MWATER.strata[k].label)}</option>`).join('');
    sel.value = cur || (LS.get('mwstratum', 'HP-FD'));
  }
  function setSource(src) { document.querySelectorAll('input[name=src]').forEach(r => { r.checked = r.value === src; }); $('src-mwater').classList.toggle('hidden', src !== 'mwater'); $('src-csv').classList.toggle('hidden', src !== 'csv'); LS.set('src', src); }
  document.querySelectorAll('input[name=src]').forEach(r => r.addEventListener('change', () => setSource(r.value)));
  function saveToken(token, username) { state.mw = { token, username: username || '' }; LS.set('mw', state.mw); $('mw-token').value = ''; $('mw-pass').value = ''; renderMw(); }
  $('btn-mw-login').onclick = async () => {
    const u = $('mw-user').value.trim(), p = $('mw-pass').value; if (!u || !p) return;
    $('mw-progress').textContent = '…';
    try { const r = await Core.mwaterLogin(u, p); saveToken(r.token, r.username); $('mw-progress').textContent = ''; $('mw-settings').open = false; }
    catch (e) { $('mw-progress').innerHTML = `<div class="msg err">${esc(t('mw_login_err', { e: e.message }))}</div>`; }
    $('mw-pass').value = '';
  };
  $('btn-mw-save').onclick = () => { const v = $('mw-token').value.trim(); if (v) { saveToken(v, ''); $('mw-settings').open = false; } };
  $('btn-mw-forget').onclick = () => { state.mw = null; LS.del('mw'); renderMw(); };
  $('mw-stratum').onchange = () => LS.set('mwstratum', $('mw-stratum').value);
  $('btn-mw-fetch').onclick = async () => {
    const out = $('mw-progress');
    if (!state.mw || !state.mw.token) { out.innerHTML = `<div class="msg err">${t('mw_no_token')}</div>`; $('mw-settings').open = true; return; }
    const stratum = $('mw-stratum').value; const warns = []; $('btn-mw-fetch').disabled = true;
    try {
      const r = await Core.mwaterLoadFrame(state.mw.token, { onProgress: (what, n) => { if (what === 'warn') warns.push(n); else out.textContent = t('mw_fetching', { what: what.replace(/^entities\//, ''), n }); } });
      const points = stratum ? r.points.filter(p => p.stratum === stratum) : r.points;
      const frameCsv = Core.frameToCsv(points);
      const counts = Object.assign({}, r.counts, { fetched: points.length, active: points.filter(p => p.status === 'active').length });
      const mwMeta = Object.assign({}, r.source, { fetched_at: r.fetchedAt, stratum_filter: stratum || null, forms_used: r.formsUsed, sdws3_responses: r.sdws3Responses, counts, frame_rule: Core.FRAME_RULE_TEXT.en });
      await loadWp(frameCsv, 'mwater:' + Core.MWATER.entityType + (stratum ? ':' + stratum : '') + '@' + r.fetchedAt, { source: 'mwater', fetchedAt: r.fetchedAt, counts, mwater: mwMeta });
      if (stratum) { $('p-stratum').value = stratum; $('data-stratum').value = stratum; updateSeed(); }
      out.innerHTML = `<div class="msg ok">${t('mw_done', { n: counts.fetched, a: counts.active, t: r.fetchedAt })}</div><button class="btn" type="button" onclick="document.getElementById('btn-next-params').click()">${t('next_params')}</button>` + (warns.length ? `<div class="msg warn">${esc(t('mw_warn', { w: warns.join('; ') }))}</div>` : '');
      renderData(); renderPreview(); renderBacklog(); updateSteps();
    } catch (e) { out.innerHTML = `<div class="msg err">${esc(t('mw_err', { e: e.message }))}</div>`; }
    $('btn-mw-fetch').disabled = false;
  };
  $('btn-frame-dl').onclick = () => { if (state.wp) download((state.wp.source === 'mwater' ? 'sanitap-frame-mwater' : 'sanitap-frame') + '.csv', state.wp.text, 'text/csv'); };

  /* ---------- Test A backlog ---------- */
  function backlogStratum() { return (state.wp && state.wp.mwater && state.wp.mwater.stratum_filter) || $('p-stratum').value || ''; }
  function currentBacklog() { if (!state.points.length) return null; const strata = [...new Set(state.points.map(p => p.stratum))]; const bl = {}; strata.forEach(s => { bl[s] = Core.backlog(state.points, s); }); return bl; }
  function backlogTiles() { const bl = currentBacklog(); if (!bl) return ''; return Object.keys(bl).filter(s => s !== 'unassigned').map(s => [['bl_operating', bl[s].operating.length], ['bl_failing', bl[s].failing.length], ['bl_notbuilt', bl[s].notBuilt.length]].map(x => `<div style="background:#fff4e5"><b>${x[1]}</b><span>${t(x[0])} ${s}</span></div>`).join('')).join(''); }
  function renderBacklog() {
    const el = $('backlog-tables'), cnt = $('backlog-counts'); const bl = currentBacklog(); const s = backlogStratum();
    if (!bl || !bl[s]) { el.innerHTML = `<p class="muted">${t('bl_none')}</p>`; cnt.innerHTML = ''; return; }
    const g = bl[s];
    cnt.innerHTML = `<div class="stat">${[['bl_operating', g.operating.length], ['bl_failing', g.failing.length], ['bl_notbuilt', g.notBuilt.length], ['bl_other', g.other.length]].map(x => `<div><b>${x[1]}</b><span>${x[0] === 'bl_other' ? t(x[0]) : t(x[0])} ${esc(s)}</span></div>`).join('')}</div>`;
    const row = p => `<tr><td><b>${esc(p.water_point_id)}</b><br><small>${esc(p.alt_id || '')}</small></td><td>${esc(p.name)}</td><td>${esc(p.commune)}<br><small>${esc(p.fokontany)}</small></td><td>${p.households_served || ''}</td><td>${esc(p.last_maintenance_visit || '')}${p.has_rehab_record === 'Y' ? ' <span class="pill">rehab</span>' : ''}</td><td>${esc(p.sdws3_last_test || '')}${p.sdws3_last_result ? '<br><small>' + esc(p.sdws3_last_result) + '</small>' : ''}</td></tr>`;
    const table = (key, arr) => arr.length ? `<h3>${t(key)} (${arr.length})</h3><div class="tablewrap"><table><tr><th>${t('col_id')}</th><th>${t('col_name')}</th><th>${t('col_cluster')} / ${t('col_fokontany')}</th><th>${t('col_hh')}</th><th>${t('col_last_visit')}</th><th>${t('col_last_test')} / ${t('col_result')}</th></tr>${arr.map(row).join('')}</table></div>` : '';
    el.innerHTML = table('bl_operating', g.operating) + table('bl_failing', g.failing) + table('bl_notbuilt', g.notBuilt) + table('bl_other', g.other);
  }
  function backlogList() { const bl = currentBacklog(); const s = backlogStratum(); if (!bl || !bl[s]) return []; const g = bl[s]; return g.operating.map(p => Object.assign({ group: 'operating-untested' }, p)).concat(g.failing.map(p => Object.assign({ group: 'failing' }, p)), g.notBuilt.map(p => Object.assign({ group: 'not-yet-built' }, p)), g.other.map(p => Object.assign({ group: 'other' }, p))); }
  $('btn-backlog-csv').onclick = () => { const list = backlogList(); if (!list.length) return; const cols = ['group', 'water_point_id', 'alt_id', 'name', 'district', 'commune', 'fokontany', 'village', 'households_served', 'has_rehab_record', 'last_maintenance_visit', 'sdws3_last_test', 'sdws3_last_result', 'lat', 'lon']; download('sanitap-testA-backlog-' + backlogStratum() + '.csv', [cols].concat(list.map(p => cols.map(c => p[c]))).map(r => r.map(Core.csvEscape).join(',')).join('\r\n') + '\r\n', 'text/csv'); };
  $('btn-backlog-print').onclick = () => {
    const list = backlogList(); if (!list.length) return; const by = {}; list.forEach(p => { (by[p.commune || '—'] = by[p.commune || '—'] || []).push(p); }); const cols = t('bl_sheet_cols');
    $('backlog-print').innerHTML = Object.keys(by).sort().map(c => `<div class="sheet"><h2>${t('bl_sheet_title')} — ${esc(backlogStratum())} — ${t('bl_sheet_commune')} ${esc(c)}</h2><div class="meta"><div><b>${t('sheet_date')}:</b> <span class="line"></span></div><div><b>${t('sheet_team')}:</b> <span class="line"></span></div></div><table><tr>${cols.map(h => `<th>${esc(h)}</th>`).join('')}</tr>${by[c].map((p, i) => `<tr><td>${i + 1}</td><td>${esc(p.water_point_id)}<br><small>${esc(p.alt_id || '')}</small></td><td>${esc(p.name)}</td><td>${esc(p.fokontany)}</td><td>${isFinite(p.lat) ? fmt(p.lat, 5) + ', ' + fmt(p.lon, 5) : ''}</td><td>${esc(p.group)}</td><td>${esc(p.last_maintenance_visit || '')}</td><td>${p.households_served || ''}</td><td>&nbsp;</td><td>&nbsp;</td></tr>`).join('')}</table><div class="box"><b>${t('sheet_notes')}:</b></div></div>`).join('');
    document.body.classList.add('print-backlog'); setTimeout(() => { window.print(); setTimeout(() => document.body.classList.remove('print-backlog'), 500); }, 100);
  };
  $('btn-next-params').onclick = () => showTab('backlog');
  $('btn-next-params2').onclick = () => showTab('params');
  $('btn-next-map').onclick = () => showTab('map');
  $('btn-next-sheet').onclick = () => showTab('sheet');

  /* ---------- parameters ---------- */
  function computedSeed() { return ($('p-round').value.replace(/\s+/g, '') || 'round') + '-' + ($('p-stratum').value || 'stratum'); }
  function updateSeed() { $('p-stratum-text').textContent = $('p-stratum').value || '—'; $('p-repro').textContent = t('repro_line', { seed: computedSeed() }); }
  ['p-round', 'p-stratum', 'data-stratum'].forEach(id => $(id).addEventListener('input', () => { if (id === 'data-stratum') $('p-stratum').value = $('data-stratum').value; updateSeed(); renderPreview(); renderBacklog(); }));
  ['p-target', 'p-hh', 'p-icc', 'p-pass', 'p-conf', 'p-prectype'].forEach(id => $(id).addEventListener('input', renderPreview));
  $('p-drawn-by').addEventListener('input', () => LS.set('drawnBy', $('p-drawn-by').value));
  function readParams() {
    const num = (id, d) => { const v = parseFloat($(id).value); return isNaN(v) ? d : v; };
    return {
      roundName: $('p-round').value.trim(), stratum: $('p-stratum').value, drawnBy: $('p-drawn-by').value.trim(), method: 'pps_households', target: Math.max(1, Math.round(num('p-target', 58))), hhPerPoint: Math.max(1, Math.round(num('p-hh', 5))),
      replacementFraction: 0.2, hhReplacements: 2, seed: computedSeed(),
      icc: Math.min(1, Math.max(0, num('p-icc', 0.1))), expectedPass: Math.min(0.99, Math.max(0.01, num('p-pass', 0.95))), confidence: $('p-conf').value, precision: 0.10, precisionType: $('p-prectype').value,
      wpFileName: state.wp && state.wp.name, wpFileHash: state.wp && state.wp.hash,
      source: (state.wp && state.wp.source) || 'csv', mwater: state.wp && state.wp.source === 'mwater' ? state.wp.mwater : null
    };
  }
  function renderPreview() {
    const el = $('params-preview'); if (!state.points.length) { el.textContent = t('err_nodata'); return; }
    const p = readParams();
    const elig = state.points.filter(x => x.active && String(x.stratum) === String(p.stratum));
    const st = Core.stats(p); const nRep = Math.ceil(st.nWp * p.replacementFraction);
    const communes = new Set(elig.map(x => x.commune)); el.textContent = t('preview', { n: elig.length, c: communes.size, w: st.nWp, r: nRep, t: st.nWp + nRep });
  }
  $('btn-draw').onclick = () => {
    const msg = $('params-msg'); msg.innerHTML = '';
    if (!state.points.length) { msg.innerHTML = `<div class="msg err">${t('err_nodata')}</div>`; return; }
    const p = readParams();
    runDraw(p, true);
  };
  function runDraw(p, fresh) {
    if (fresh) { p.timestamp = new Date().toISOString(); state.kValues = {}; }
    const r = Core.draw(p, state.points);
    if (r.error) { $('params-msg').innerHTML = `<div class="msg err">${t('err_noeligible')}</div>`; return; }
    state.result = r; LS.set('last', p); LS.set('k', state.kValues);
    renderResults(); renderSheet(); renderMapList(); if (state.map) renderMap(); updateSteps();
    if (fresh) showTab('results');
  }

  /* ---------- results ---------- */
  function warnText(w) {
    switch (w.code) {
      case 'no_coords': return t('w_no_coords', w);
      case 'insufficient_points': return t('w_insufficient', { have: w.have, needed: w.needed, w: w.nWp, r: w.nRep });
      case 'short_selection': return t('w_short', { have: w.have, w: w.nWp });
      case 'far_source': return t('w_far', w);
      case 'imputed_weights': return t('w_imputed', w);
      default: return JSON.stringify(w);
    }
  }
  function farSet() { return new Set(((state.result && state.result.reach) || []).filter(x => x.far).map(x => x.water_point_id)); }
  function hhCell(w) {
    const h = w.households;
    const K = state.kValues[w.water_point_id];
    const fn = K ? Core.fieldNumbers(state.result.params.seed, w.water_point_id, K, h.n, h.extra) : null;
    let s = `<span class="muted">${t('rule_short', { n: h.n })}</span><br>${t('col_k')}: <input class="kinput" type="number" min="1" inputmode="numeric" data-k="${esc(w.water_point_id)}" value="${K || ''}"> `;
    if (fn) s += `<b>${fn.primary.join(', ')}</b> <span class="muted">(${t('rep_short')} ${fn.replacements.join(', ')})</span>`;
    return s;
  }
  function renderResults() {
    const r = state.result; $('results-empty').classList.toggle('hidden', !!r); $('results').classList.toggle('hidden', !r);
    if (!r) return;
    const p = r.params, st = r.stats, cPct = Math.round(parseFloat(p.confidence) * 100), pPct = 10;
    $('res-head').innerHTML = `<span class="pill">${esc(p.roundName)}</span><span class="pill">${t('p_stratum')}: ${esc(p.stratum)}</span><span class="pill">${t('p_seed')}: <b>${esc(p.seed)}</b></span><span class="pill">${esc(r.audit.timestamp)}</span><span class="pill">${t('sha')}: ${(p.wpFileHash || '').slice(0, 12)}…</span>`;
    $('res-stats').innerHTML = [[t('st_nwp'), r.selected.length + ' / ' + st.nWp], [t('st_rep'), r.replacements.length], [t('st_nact'), st.nActual], [t('st_deff'), fmt(st.deff, 2)], [t('st_neff'), fmt(st.nEff, 1)], [t('st_nreq', { c: cPct, p: pPct }), st.nReq]]
      .map(x => `<div><b>${x[1]}</b><span>${x[0]}</span></div>`).join('');
    let h = st.pass ? `<div class="msg ok">${t('check_ok', { ne: fmt(st.nEff), nr: st.nReq, c: cPct, p: pPct, pr: st.expectedPass })}</div>` : `<div class="msg err">${t('check_fail', { ne: fmt(st.nEff), nr: st.nReq, c: cPct, p: pPct })}</div>`;
    st.suggestions.forEach(s => { h += `<div class="msg warn">${s.type === 'fewer_hh' ? t('sug_fewer', { t: p.target, m: s.m, w: s.nWp }) : t('sug_more', { m: st.m, w: s.nWp, s: s.nSamples })}</div>`; });
    r.warnings.forEach(w => { h += `<div class="msg warn">${esc(warnText(w))}</div>`; });
    $('res-check').innerHTML = h;
    $('res-clusters').innerHTML = `<table><tr><th>${t('col_cluster')}</th><th>${t('col_size')}</th><th>${t('col_hh')}</th><th>${t('col_sel_short')}</th></tr>` + r.clusters.map(c => `<tr class="${c.selected ? '' : 'rep'}"><td>${esc(c.name)}</td><td>${c.size}</td><td>${c.households !== undefined ? c.households : ''}</td><td>${c.selected || t('no')}</td></tr>`).join('') + '</table>';
    const far = farSet();
    const row = (w, rep) => `<tr class="${rep ? 'rep' : ''}"><td>${rep ? 'R' + w.order : w.order}${far.has(w.water_point_id) ? ' <span class="pill" style="background:#fff4e5;color:#b45309" title="' + esc(t('reach_far')) + '">⚠</span>' : ''}</td><td><b>${esc(w.water_point_id)}</b><br><small>${esc(w.name)}${w.households_served ? ' · ' + w.households_served + ' hh' : ''}</small></td><td>${esc(w.cluster)}<br><small>${esc(w.fokontany)} / ${esc(w.village)}</small></td><td>${hhCell(w)}</td></tr>`;
    $('res-points').innerHTML = `<table><tr><th>${t('col_order')}</th><th>${t('col_id')}</th><th>${t('col_cluster')}</th><th>${t('col_hh')}</th></tr>` + r.selected.map(w => row(w, false)).join('') + r.replacements.map(w => row(w, true)).join('') + '</table>';
    $('res-points').querySelectorAll('input[data-k]').forEach(inp => inp.addEventListener('change', () => { const v = parseInt(inp.value, 10); if (v > 0) state.kValues[inp.dataset.k] = v; else delete state.kValues[inp.dataset.k]; LS.set('k', state.kValues); renderResults(); renderSheet(); }));
  }
  function auditExtra() {
    const ex = {};
    const ks = Object.keys(state.kValues);
    if (ks.length && state.result) ex.field_rule_numbers = ks.map(id => { const w = state.result.selected.concat(state.result.replacements).find(x => x.water_point_id === id); if (!w) return null; return Object.assign({ water_point_id: id }, Core.fieldNumbers(state.result.params.seed, id, state.kValues[id], w.households.n, w.households.extra)); }).filter(Boolean);
    return ex;
  }
  function download(name, content, type) {
    const blob = new Blob([content], { type }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  const fname = ext => `sanitap-${(state.result.params.roundName || 'round').replace(/\s+/g, '')}-${state.result.params.stratum}-${ext}`;
  $('btn-pdf').onclick = async () => {
    if (!state.result) return; const msg = $('res-export-msg'); msg.innerHTML = '';
    if (typeof PDFLib === 'undefined') { msg.innerHTML = `<div class="msg err">${t('pdf_err')}</div>`; return; }
    if (!state.result.audit.drawn_by) { msg.innerHTML = `<div class="msg warn">${t('pdf_need_by')}</div>`; }
    try {
      const auditText = Core.auditJson(state.result, auditExtra()); const auditSha = await Core.sha256(auditText);
      const bytes = await Core.buildSamplingRecordPdf({ PDFLib, audit: JSON.parse(auditText), auditText, auditSha, lang: state.lang, url: Core.APP_URL, kValues: state.kValues });
      state.lastRecord = { auditSha, recordId: state.result.audit.record_id }; LS.set('lastRecord', state.lastRecord);
      download(fname('record.pdf'), bytes, 'application/pdf');
      msg.innerHTML = `<div class="msg ok">${esc(state.result.audit.record_id)} · ${t('sha')} ${auditSha}</div>`;
    } catch (e) { msg.innerHTML = `<div class="msg err">${esc(e.message)}</div>`; }
  };
  $('btn-xlsx').onclick = () => {
    if (!state.result) return; const msg = $('res-export-msg');
    if (typeof XLSX === 'undefined') { msg.innerHTML = `<div class="msg err">${t('xlsx_err')}</div>`; return; }
    const audit = JSON.parse(Core.auditJson(state.result, auditExtra()));
    const wb = XLSX.utils.book_new(); Core.selectionWorkbook(audit, state.kValues, state.lang).forEach(sh => XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sh.rows), sh.name.slice(0, 31)));
    const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' }); download(fname('selection.xlsx'), out, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  };
  $('btn-print').onclick = $('btn-print2').onclick = () => { showTab('sheet'); setTimeout(() => window.print(), 100); };

  /* ---------- field sheet: stop list only ---------- */
  function renderSheet() {
    const r = state.result; const el = $('fieldsheet');
    if (!r) { el.innerHTML = `<p class="muted">${t('sheet_empty')}</p>`; return; }
    const p = r.params; const far = farSet(); const line = (w) => `<span class="line" style="min-width:${w || 7}rem"></span>`;
    const stop = (w, rep) => {
      const h = w.households; const K = state.kValues[w.water_point_id];
      const fn = K ? Core.fieldNumbers(p.seed, w.water_point_id, K, h.n, h.extra) : null;
      return `<tr${rep ? ' class="rep"' : ''}><td><b>${rep ? 'R' + w.order : w.order}</b>${far.has(w.water_point_id) ? '<br><small>⚠</small>' : ''}</td><td><b>${esc(w.water_point_id)}</b>${w.alt_id ? ' / ' + esc(w.alt_id) : ''}<br>${esc(w.name)}${far.has(w.water_point_id) ? `<br><small>${t('reach_far')}</small>` : ''}</td><td>${esc(w.commune)}<br><small>${esc(w.fokontany)}</small></td><td>${isFinite(w.lat) ? fmt(w.lat, 5) + '<br>' + fmt(w.lon, 5) : '—'}</td><td>${w.households_served || ''}</td><td>K = ${K ? K : line(3)}<br>${fn ? `<b class="big">${fn.primary.join(' – ')}</b><br><small>${t('sheet_rep_numbers')}: ${fn.replacements.join(', ')}</small>` : `<small>${t('k_blank_short')}</small>`}</td></tr>`;
    };
    el.innerHTML = `<div class="sheet">
<h2>${t('sheet_title')} — ${esc(p.roundName)} / ${esc(p.stratum)}</h2>
<div class="meta"><div><b>${t('sheet_date')}:</b> ${line(8)}</div><div><b>${t('sheet_team')}:</b> ${line(8)}</div><div><b>${t('record_id_label')}:</b> <span class="big">${esc(r.audit.record_id)}</span></div><div><b>${t('sheet_seed')}:</b> ${esc(p.seed)}</div></div>
<div class="rule">${t('sheet_mwater', { rid: esc(r.audit.record_id) })}</div>
<div class="rule">${t('sheet_rule')}</div>
<h3>${t('sheet_stops')}</h3>
<table><tr><th>${t('col_order')}</th><th>${t('col_id')}</th><th>${t('col_cluster')} / ${t('col_fokontany')}</th><th>${t('sheet_gps')}</th><th>${t('col_hh')}</th><th>${t('sheet_numbers')}</th></tr>
${r.selected.map(w => stop(w, false)).join('')}${r.replacements.map(w => stop(w, true)).join('')}</table>
<p><small>${t('sheet_replacement')}</small></p>
</div>`;
  }

  /* ---------- map: numbered markers + stop list + reach flags ---------- */
  function initMap() {
    if (state.map || typeof L === 'undefined') return;
    const m = state.map = L.map('map', { zoomControl: true }).setView([-25.03, 46.99], 9);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' }).addTo(m);
    state.layers = { labels: L.layerGroup().addTo(m), points: L.layerGroup().addTo(m) };
  }
  const numIcon = (txt, cls) => L.divIcon({ className: '', html: `<div class="num-icon ${cls || ''}">${txt}</div>`, iconSize: [28, 28], iconAnchor: [14, 14] });
  function communeLabels(list) {
    const by = {}; list.forEach(p => { if (!isFinite(p.lat)) return; const c = p.commune || ''; if (!c) return; (by[c] = by[c] || []).push(p); });
    Object.keys(by).forEach(c => { const pts = by[c]; const lat = pts.reduce((a, p) => a + p.lat, 0) / pts.length, lon = pts.reduce((a, p) => a + p.lon, 0) / pts.length; state.layers.labels.addLayer(L.marker([lat, lon], { icon: L.divIcon({ className: '', html: `<div class="commune-label">${esc(c)}</div>`, iconSize: [120, 18], iconAnchor: [60, 30] }), interactive: false })); });
  }
  function renderMap() {
    if (!state.map) return; const Ly = state.layers; Object.values(Ly).forEach(l => l.clearLayers());
    if ($('map-mode').value === 'backlog') return renderBacklogMap();
    const r = state.result; const bounds = [];
    if (!r) { $('map-msg').textContent = t('map_no_draw'); return; }
    const far = farSet();
    r.selected.forEach(w => { if (!isFinite(w.lat)) return; bounds.push([w.lat, w.lon]); Ly.points.addLayer(L.marker([w.lat, w.lon], { icon: numIcon(w.order, far.has(w.water_point_id) ? 'far' : '') }).bindPopup(`<b>${w.order}. ${esc(w.water_point_id)}</b> ${esc(w.alt_id || '')}<br>${esc(w.name)}<br>${esc(w.commune)} / ${esc(w.fokontany)}${far.has(w.water_point_id) ? '<br><b style="color:#b45309">' + esc(t('reach_far')) + '</b>' : ''}`)); });
    r.replacements.forEach(w => { if (!isFinite(w.lat)) return; bounds.push([w.lat, w.lon]); Ly.points.addLayer(L.marker([w.lat, w.lon], { icon: numIcon('R' + w.order, 'rep') }).bindPopup(`<b>R${w.order}. ${esc(w.water_point_id)}</b> (${t('rep_wp')})<br>${esc(w.name)}<br>${esc(w.commune)} / ${esc(w.fokontany)}`)); });
    communeLabels(r.selected.concat(r.replacements));
    if (bounds.length) state.map.fitBounds(bounds, { padding: [30, 30] });
    $('map-msg').textContent = '';
  }
  function renderMapList() {
    const el = $('map-list'); const r = state.result;
    if ($('map-mode').value === 'backlog') { const list = backlogList(); el.innerHTML = list.length ? `<h3>${t('tab_backlog')}</h3><div class="tablewrap"><table><tr><th>#</th><th>${t('col_id')}</th><th>${t('col_name')}</th><th>${t('col_cluster')} / ${t('col_fokontany')}</th><th>${t('col_hh')}</th></tr>${list.map((p, i) => `<tr><td>${i + 1}</td><td>${esc(p.water_point_id)}<br><small>${esc(p.alt_id || '')}</small></td><td>${esc(p.name)}<br><small>${esc(p.group)}</small></td><td>${esc(p.commune)}<br><small>${esc(p.fokontany)}</small></td><td>${p.households_served || ''}</td></tr>`).join('')}</table></div>` : `<p class="muted">${t('bl_none')}</p>`; return; }
    if (!r) { el.innerHTML = `<p class="muted">${t('map_no_draw')}</p>`; return; }
    const reach = {}; (r.reach || []).forEach(x => { reach[x.water_point_id] = x; });
    const row = (w, rep) => { const rc = reach[w.water_point_id]; return `<tr class="${rep ? 'rep' : ''}${rc && rc.far ? ' far' : ''}"><td><b>${rep ? 'R' + w.order : w.order}</b></td><td><b>${esc(w.water_point_id)}</b><br><small>${esc(w.alt_id || '')}</small></td><td>${esc(w.name)}</td><td>${esc(w.commune)}<br><small>${esc(w.fokontany)}</small></td><td>${w.households_served || ''}</td><td>${rc ? (rc.far ? `<b style="color:#b45309">⚠ ${esc(t('reach_far'))}</b><br>` : '') + `<small>${t('reach_dist', { n: rc.nearest_km === null ? '—' : rc.nearest_km, t: rc.town_km === null ? '—' : rc.town_km })}</small>` : ''}</td></tr>`; };
    el.innerHTML = `<h3>${t('map_list_title')}</h3><div class="tablewrap"><table><tr><th>#</th><th>${t('col_id')}</th><th>${t('col_name')}</th><th>${t('col_cluster')} / ${t('col_fokontany')}</th><th>${t('col_hh')}</th><th>${t('reach_col')}</th></tr>${r.selected.map(w => row(w, false)).join('')}${r.replacements.map(w => row(w, true)).join('')}</table></div>`;
  }
  function renderBacklogMap() {
    const Ly = state.layers; const list = backlogList(); const s = backlogStratum(); const town = (Core.MWATER.strata[s] || {}).town; const bounds = [];
    if (!list.length) { $('map-msg').textContent = t('bl_none'); return; }
    const colors = { 'operating-untested': '#b45309', failing: '#b91c1c', 'not-yet-built': '#6b7280', other: '#9aa3ad' };
    list.forEach((p, i) => { if (!isFinite(p.lat)) return; bounds.push([p.lat, p.lon]); Ly.points.addLayer(L.marker([p.lat, p.lon], { icon: L.divIcon({ className: '', html: `<div class="num-icon" style="background:${colors[p.group]}">${i + 1}</div>`, iconSize: [28, 28], iconAnchor: [14, 14] }) }).bindPopup(`<b>${i + 1}. ${esc(p.water_point_id)}</b> ${esc(p.alt_id || '')}<br>${esc(p.name)} · ${esc(p.group)}<br>${esc(p.commune)} / ${esc(p.fokontany)}`)); });
    if (town) { bounds.push([town.lat, town.lon]); Ly.points.addLayer(L.marker([town.lat, town.lon], { icon: numIcon('▶', 'start') }).bindTooltip(town.name)); }
    communeLabels(list);
    if (bounds.length) state.map.fitBounds(bounds, { padding: [30, 30] });
    $('map-msg').textContent = '';
  }
  $('map-mode').onchange = () => { renderMap(); renderMapList(); };
  $('btn-fit').onclick = () => renderMap();

  /* ---------- offline / service worker ---------- */
  function onlineBadge() { $('offline-badge').textContent = navigator.onLine ? t('online') : '⚠ ' + t('offline'); }
  window.addEventListener('online', onlineBadge); window.addEventListener('offline', onlineBadge);
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (navigator.serviceWorker.controller) navigator.serviceWorker.controller.postMessage({ type: 'build?' }); });
    // banner only when the active worker's build differs from the running page's build (network-first pages are usually already current)
    const newer = build => build && build !== APP_COMMIT && $('update-banner').classList.remove('hidden');
    navigator.serviceWorker.addEventListener('message', ev => { const d = ev.data || {}; if (d.type === 'sw-updated' || d.type === 'build') newer(d.build); });
    // check for a new deploy when the tab comes back and every 30 minutes; a newly activated worker reports its build and the page compares it with its own
    navigator.serviceWorker.register('sw.js').then(reg => {
      reg.addEventListener('updatefound', () => { const nw = reg.installing; if (nw) nw.addEventListener('statechange', () => { if (nw.state === 'activated' && hadController) nw.postMessage({ type: 'build?' }); }); });
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); });
      setInterval(() => reg.update().catch(() => {}), 30 * 60 * 1000);
    }).catch(e => console.warn('SW', e));
    $('btn-update-reload').onclick = () => location.reload();
  }

  /* ---------- boot ---------- */
  applyWp(); applyLang(); onlineBadge(); renderMw(); $('p-drawn-by').value = LS.get('drawnBy', ''); setSource(LS.get('src', (state.wp && state.wp.source === 'csv') ? 'csv' : 'mwater'));
  const last = LS.get('last', null);
  if (last && state.points.length) {
    $('p-round').value = last.roundName; $('p-stratum').value = last.stratum; $('p-target').value = last.target; $('p-hh').value = last.hhPerPoint;
    $('p-drawn-by').value = last.drawnBy || ''; $('data-stratum').value = last.stratum; updateSeed();
    $('p-icc').value = last.icc; $('p-pass').value = last.expectedPass; $('p-conf').value = last.confidence; $('p-prectype').value = last.precisionType;
    runDraw(last, false);
  }
  renderPreview(); renderBacklog(); renderMapList(); updateSteps();
})();
