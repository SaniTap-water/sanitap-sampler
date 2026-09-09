/* SaniTap Sampler — statistically valid, logistics-aware water quality sampling
 * Gold Standard SDWS methodology v2.0. Plain JS, no build step, nothing leaves the browser.
 * File layout: Core (pure, testable in Node) + UI (browser only).
 */
'use strict';
const APP_VERSION = '1.0.0';
const ALGORITHM = 'seed string -> xmur3 32-bit hash -> mulberry32 PRNG; stage 1 sequential PPS without replacement; stage 2 & 3 simple random sampling without replacement (sequential uniform index draws)';

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
  function pointInPolygon(pt, poly) { // poly: [[lat,lon],...]; ray casting
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const yi = poly[i][0], xi = poly[i][1], yj = poly[j][0], xj = poly[j][1];
      const intersect = ((yi > pt.lat) !== (yj > pt.lat)) && (pt.lon < (xj - xi) * (pt.lat - yi) / (yj - yi) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  }
  function convexHull(pts) { // Andrew monotone chain; pts: [{lat,lon}]
    const p = pts.filter(q => isFinite(q.lat) && isFinite(q.lon)).map(q => [q.lon, q.lat]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    if (p.length < 3) return p.map(q => [q[1], q[0]]);
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lower = []; for (const q of p) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop(); lower.push(q); }
    const upper = []; for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop(); upper.push(q); }
    return lower.slice(0, -1).concat(upper.slice(0, -1)).map(q => [q[1], q[0]]);
  }
  // nearest-neighbour route from start through points (each {lat,lon,...})
  function nearestNeighbourRoute(start, points) {
    const left = points.filter(p => isFinite(p.lat) && isFinite(p.lon)).slice();
    const order = []; let cur = start, total = 0;
    while (left.length) {
      let bi = 0, bd = Infinity;
      for (let i = 0; i < left.length; i++) { const d = haversineKm(cur, left[i]); if (d < bd) { bd = d; bi = i; } }
      const p = left.splice(bi, 1)[0]; total += bd;
      order.push({ point: p, legKm: bd, cumKm: total }); cur = p;
    }
    return { stops: order, totalKm: total, skipped: points.length - order.length };
  }

  /* ---------- SHA-256 (pure JS fallback when crypto.subtle is unavailable) ---------- */
  function sha256Sync(str) {
    const K = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
    const bytes = (typeof TextEncoder !== 'undefined') ? new TextEncoder().encode(str) : Buffer.from(str, 'utf8');
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

  /* ---------- clustering ---------- */
  function assignClusters(points, mode, axes) {
    const map = {}; const unassigned = [];
    points.forEach(pt => {
      let key = null;
      if (mode === 'axis') {
        for (const ax of (axes || [])) { if (isFinite(pt.lat) && isFinite(pt.lon) && pointInPolygon(pt, ax.coords)) { key = ax.name; break; } }
      } else key = pt.commune || '(no commune)';
      if (key === null) { unassigned.push(pt); return; }
      (map[key] = map[key] || []).push(pt);
    });
    const clusters = Object.keys(map).sort().map(name => ({ name, points: map[name].sort((a, b) => String(a.water_point_id).localeCompare(String(b.water_point_id))), size: map[name].length }));
    return { clusters, unassigned };
  }
  // smallest k such that the k smallest clusters together hold `needed` points (guarantees enough points whatever is drawn)
  function defaultClusterCount(clusters, needed) {
    const sizes = clusters.map(c => c.size).sort((a, b) => a - b);
    let sum = 0;
    for (let k = 0; k < sizes.length; k++) { sum += sizes[k]; if (sum >= needed) return k + 1; }
    return sizes.length;
  }

  /* ---------- the draw ---------- */
  function draw(params, allPoints, householdsByWp, axes) {
    const p = Object.assign({}, params);
    const warnings = [];
    const rng = makeRng(p.seed);
    const eligible = allPoints.filter(pt => pt.active && String(pt.stratum) === String(p.stratum))
      .sort((a, b) => String(a.water_point_id).localeCompare(String(b.water_point_id)));
    const noCoords = eligible.filter(pt => !isFinite(pt.lat) || !isFinite(pt.lon)).length;
    if (noCoords) warnings.push({ code: 'no_coords', n: noCoords });
    const { clusters, unassigned } = assignClusters(eligible, p.clusterMode, axes);
    if (unassigned.length) warnings.push({ code: 'unassigned', n: unassigned.length, ids: unassigned.map(u => u.water_point_id) });
    const st = stats(p);
    const nWp = st.nWp;
    const nRep = Math.ceil(nWp * p.replacementFraction);
    const needed = nWp + nRep;
    const autoK = defaultClusterCount(clusters, needed);
    let k = p.nClusters && p.nClusters > 0 ? Math.min(p.nClusters, clusters.length) : autoK;
    if (!clusters.length) return { error: 'no_eligible', warnings, eligibleCount: 0 };

    // Stage 1: sequential PPS without replacement
    const pool1 = clusters.slice(); const selectedClusters = [];
    while (selectedClusters.length < k && pool1.length) {
      const total = pool1.reduce((s, c) => s + c.size, 0);
      let u = rng.next() * total, idx = 0;
      for (; idx < pool1.length; idx++) { u -= pool1[idx].size; if (u < 0) break; }
      if (idx >= pool1.length) idx = pool1.length - 1;
      const c = pool1.splice(idx, 1)[0];
      selectedClusters.push({ name: c.name, size: c.size, order: selectedClusters.length + 1 });
    }
    const selNames = new Set(selectedClusters.map(c => c.name));
    const clusterOf = {}; clusters.forEach(c => c.points.forEach(pt => { clusterOf[pt.water_point_id] = c.name; }));

    // Stage 2: SRS without replacement in the pooled selected clusters
    const pool2 = clusters.filter(c => selNames.has(c.name)).flatMap(c => c.points)
      .sort((a, b) => String(a.water_point_id).localeCompare(String(b.water_point_id)));
    if (pool2.length < needed) warnings.push({ code: 'insufficient_points', have: pool2.length, needed, nWp, nRep });
    const pick = n => { const out = []; while (out.length < n && pool2.length) out.push(pool2.splice(randInt(rng, pool2.length), 1)[0]); return out; };
    const selected = pick(nWp), replacements = pick(nRep);
    if (selected.length < nWp) warnings.push({ code: 'short_selection', have: selected.length, nWp });

    // Stage 3: households
    const hhN = p.hhPerPoint, hhR = p.hhReplacements;
    function hhFor(pt) {
      const list = householdsByWp && householdsByWp[pt.water_point_id];
      if (list && list.length) {
        const pool = list.slice(); const out = [];
        while (out.length < hhN + hhR && pool.length) out.push(pool.splice(randInt(rng, pool.length), 1)[0]);
        if (list.length < hhN + hhR) warnings.push({ code: 'few_households', id: pt.water_point_id, have: list.length, needed: hhN + hhR });
        return { mode: 'list', primary: out.slice(0, hhN), replacements: out.slice(hhN), listed: list.length };
      }
      return { mode: 'rule', n: hhN, extra: hhR };
    }
    const mk = (pt, i, rep) => ({
      order: i + 1, replacement: rep, water_point_id: pt.water_point_id, name: pt.name, cluster: clusterOf[pt.water_point_id],
      commune: pt.commune, fokontany: pt.fokontany, village: pt.village, lat: pt.lat, lon: pt.lon, households_served: pt.households_served,
      households: hhFor(pt)
    });
    const selectedOut = selected.map((pt, i) => mk(pt, i, false));
    const replacementOut = replacements.map((pt, i) => mk(pt, i, true));

    const audit = {
      tool: 'SaniTap Sampler', version: APP_VERSION, methodology: 'Gold Standard SDWS v2.0',
      timestamp: p.timestamp || new Date().toISOString(),
      seed: p.seed, seed_word_uint32: rng.seedWord, algorithm: ALGORITHM,
      input: { water_points_file: p.wpFileName || null, water_points_sha256: p.wpFileHash || null, households_file: p.hhFileName || null, households_sha256: p.hhFileHash || null, axes: p.clusterMode === 'axis' ? (axes || []) : null },
      parameters: { round: p.roundName, stratum: p.stratum, target_samples: p.target, households_per_point: hhN, household_replacements: hhR, cluster_mode: p.clusterMode, clusters_requested: p.nClusters || null, clusters_auto: autoK, clusters_selected: k, replacement_fraction: p.replacementFraction, icc: p.icc, expected_pass_rate: p.expectedPass, confidence: p.confidence, precision: p.precision, precision_type: p.precisionType },
      frame: { eligible_points: eligible.length, clusters: clusters.map(c => ({ name: c.name, size: c.size })), unassigned: unassigned.map(u => u.water_point_id) },
      statistics: st,
      selected_clusters: selectedClusters,
      water_points: selectedOut.map(auditWp), replacements: replacementOut.map(auditWp),
      field_rule: 'Number households clockwise from the pump starting at the nearest; K = total households counted on the day; draw N=' + hhN + ' numbers (+' + hhR + ' replacements) from 1..K with PRNG seeded by seed|water_point_id|K=K',
      warnings
    };
    return { params: p, eligible, clusters, unassigned, stats: st, nWp, nRep, selectedClusters, selected: selectedOut, replacements: replacementOut, warnings, audit };
  }
  function auditWp(w) {
    return { order: w.order, water_point_id: w.water_point_id, name: w.name, cluster: w.cluster, lat: w.lat, lon: w.lon,
      households: w.households.mode === 'list' ? { mode: 'list', listed: w.households.listed, primary: w.households.primary.map(h => h.household_id), replacements: w.households.replacements.map(h => h.household_id) } : w.households };
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
    return { primary: [], replacements: [], text: 'RULE: ' + h.n + ' random of K clockwise from pump, nearest first (+' + h.extra + ' replacements)' };
  }
  function toCsv(result, order, kValues) {
    const rows = [['round', 'stratum', 'cluster', 'water_point_id', 'order', 'household_id_or_rule', 'replacement_flag']];
    const p = result.params; const kv = Object.assign({ __seed: p.seed }, kValues || {});
    const ord = order || {};
    const add = (w, wpRep) => {
      const o = ord[w.water_point_id] || (wpRep ? 'R' + w.order : w.order);
      const base = [p.roundName, p.stratum, w.cluster, w.water_point_id, o];
      if (w.households.mode === 'list') {
        w.households.primary.forEach(h => rows.push(base.concat([h.household_id, wpRep ? 'water_point' : 'none'])));
        w.households.replacements.forEach(h => rows.push(base.concat([h.household_id, wpRep ? 'water_point+household' : 'household'])));
      } else {
        const r = ruleText(w, kv);
        if (r.primary.length) {
          r.primary.forEach(x => rows.push(base.concat([x, wpRep ? 'water_point' : 'none'])));
          r.replacements.forEach(x => rows.push(base.concat([x, wpRep ? 'water_point+household' : 'household'])));
        } else rows.push(base.concat([r.text, wpRep ? 'water_point' : 'none']));
      }
    };
    result.selected.forEach(w => add(w, false));
    result.replacements.forEach(w => add(w, true));
    return rows.map(r => r.map(csvEscape).join(',')).join('\r\n') + '\r\n';
  }
  function auditJson(result, extra) {
    return JSON.stringify(Object.assign({}, result.audit, extra || {}), null, 2);
  }

  return { xmur3, mulberry32, makeRng, parseCsv, normaliseWaterPoints, normaliseHouseholds, csvEscape, haversineKm, pointInPolygon, convexHull, nearestNeighbourRoute, sha256, sha256Sync, stats, assignClusters, defaultClusterCount, draw, fieldNumbers, ruleText, toCsv, auditJson, APP_VERSION, ALGORITHM };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = Core;
