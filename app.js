/* SaniTap Sampler — statistically valid, logistics-aware water quality sampling
 * Gold Standard SDWS methodology v2.0. Plain JS, no build step, nothing leaves the browser.
 * File layout: Core (pure, testable in Node) + UI (browser only).
 */
'use strict';
const APP_VERSION = '1.1.0';
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
      input: { source: p.source || 'csv', water_points_file: p.wpFileName || null, water_points_sha256: p.wpFileHash || null, households_file: p.hhFileName || null, households_sha256: p.hhFileHash || null, mwater: p.source === 'mwater' ? (p.mwater || null) : null, axes: p.clusterMode === 'axis' ? (axes || []) : null },
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


  /* ---------- mWater (identifiers only; no credentials live in this file) ---------- */
  const MWATER = {
    api: 'https://api.mwater.co/v3',
    group: 'group:aaaf0a14e4ce44eaa7a2bcfd1c74aa56', // MadAvance operator group: owner of the programme water points and households
    entityType: 'water_point',
    strata: {
      FD: { label: 'Fort-Dauphin (Taolagnaro)', districts: ['Taolagnaro', 'Fort-Dauphin'] },
      MA: { label: 'Maroantsetra', districts: ['Maroantsetra'] },
      BE: { label: 'Beloha', districts: ['Beloha'] },
      AM: { label: 'Amboasary-Atsimo', districts: ['Amboasary-Atsimo', 'Amboasary Sud', 'Amboasary'] }
    },
    forms: {
      beneficiaries: { name: 'Clean Water || Nombre de bénéficiaires', id: '8aa2dd78eb1f460f8f43db7935955846', wpQ: 'e796e451be1243d58b547bc0f6c1d5b4', roofsQ: '00ae079e071a40349e0706c659430f9b' },
      maintenance: { name: 'Clean Water || Première réhabilitation/Entretien préventif/Réparation', id: '86cf66efdd3749dd8a121314bab3675a', wpQ: '6b454d5e31ce4f6bb4918aca5f824d75', statusQ: 'c843c54776864de7b5b8b90825bc4c06', status2Q: '701d5b8d583145e3baab2e75a5f17ce4', pumpQ: '2ba451c8124f4d02aa76c44e6f5a88a3',
        status: { asVbMu3: 'functional', LATrLet: 'not_functional', NScsLF7: 'functional_substandard' }, pump: { '6Txb2rB': 'Canzee', mQmlpWT: 'IndiaMark', '72yyu9B': 'other' } },
      registration: [
        { name: 'Baseline Cbn&Gender', id: '7312b69c4c33466a9611791197cd21bf', wpQ: '229291742afe47c9af1a25034c81dbd1', hhQ: '3794238133a142418711164fc0cad4e6' },
        { name: 'Project Cbn&Gender', id: '2eeb86824b4545eca33db9e7cf7dcbd4', wpQ: '229291742afe47c9af1a25034c81dbd1', hhQ: '3794238133a142418711164fc0cad4e6' },
        { name: 'Hygiene&San', id: '209cc5fc24e24463aff702c11b6bd18f', wpQ: '07e2aa4fa29b4a45b9357d67f049d2c2', hhQ: '9954412d58164a25bc9efe27cab1bae1' }
      ]
    },
    inactiveNames: /ab[ao]ndonn|identifi|drilling|proposal|puits? ouvert/i,
    entityFields: { name: 1, desc: 1, type: 1, code: 1, alt_id: 1, alt_id_org: 1, location: 1, admin_region: 1, admin_div1: 1, admin_div2: 1, admin_div3: 1, admin_div4: 1, admin_div5: 1, _private: 1, _rev: 1, _modified_on: 1 }
  };
  const FRAME_COLUMNS = ['water_point_id', 'name', 'stratum', 'commune', 'fokontany', 'village', 'lat', 'lon', 'households_served', 'status', 'mwater_id', 'pump', 'district', 'status_reason'];
  // district name from an admin_regions document: full_name is "Fokontany, Commune, District, Region, Country"
  function regionParts(reg) { const p = String((reg && reg.full_name) || '').split(',').map(x => x.trim()); const n = p.length; return { fokontany: n >= 5 ? p[n - 5] : '', commune: n >= 4 ? p[n - 4] : '', district: n >= 3 ? p[n - 3] : '' }; }
  function mwaterStratum(district, strata) {
    const d = String(district || '').trim().toLowerCase(); if (!d) return '';
    for (const code in strata) if (strata[code].districts.some(x => x.toLowerCase() === d)) return code;
    return d.replace(/\s+/g, '-').toUpperCase().slice(0, 12);
  }
  function mwaterLatestStatus(responses, cfg) {
    const out = {};
    responses.filter(r => r.status === 'final' || !r.status).slice().sort((a, b) => String(a.submittedOn || '').localeCompare(String(b.submittedOn || ''))).forEach(r => {
      const d = r.data || {}; const code = d[cfg.wpQ] && d[cfg.wpQ].value && d[cfg.wpQ].value.code; if (!code) return;
      const sv = (d[cfg.statusQ] && d[cfg.statusQ].value) || (d[cfg.status2Q] && d[cfg.status2Q].value); const pv = d[cfg.pumpQ] && d[cfg.pumpQ].value;
      const cur = out[code] = out[code] || {};
      if (sv) { cur.status = cfg.status[sv] || 'unknown'; cur.status_on = r.submittedOn; }
      if (pv) cur.pump = cfg.pump[pv] || pv;
      cur.last_visit = r.submittedOn;
    });
    return out;
  }
  function mwaterRoofs(responses, cfg) {
    const out = {};
    responses.slice().sort((a, b) => String(a.submittedOn || '').localeCompare(String(b.submittedOn || ''))).forEach(r => { const d = r.data || {}; const code = d[cfg.wpQ] && d[cfg.wpQ].value && d[cfg.wpQ].value.code; const n = d[cfg.roofsQ] && d[cfg.roofsQ].value; if (code && n !== null && n !== undefined && !isNaN(n)) out[code] = Number(n); });
    return out;
  }
  // responsesByForm: [{cfg, responses}] -> { wpCode: [{household_id, source}] } (deduplicated, sorted)
  function mwaterHouseholdLinks(responsesByForm) {
    const map = {};
    responsesByForm.forEach(({ cfg, responses }) => responses.forEach(r => {
      if (r.status && r.status !== 'final') return; const d = r.data || {};
      const w = d[cfg.wpQ] && d[cfg.wpQ].value && d[cfg.wpQ].value.code, h = d[cfg.hhQ] && d[cfg.hhQ].value && d[cfg.hhQ].value.code;
      if (!w || !h) return; const l = map[w] = map[w] || {}; if (!l[h]) l[h] = cfg.name;
    }));
    const out = {}; Object.keys(map).sort().forEach(w => { out[w] = Object.keys(map[w]).sort().map(h => ({ household_id: h, source: map[w][h] })); });
    return out;
  }
  // entities (mWater water_point docs) -> sampler frame rows
  function mapMwaterEntities(entities, extras) {
    const ex = extras || {}; const strata = ex.strata || MWATER.strata; const regions = ex.regionsById || {}; const roofs = ex.roofs || {}; const latest = ex.latest || {};
    const points = entities.map(e => {
      const rp = regionParts(regions[e.admin_region]);
      const district = e.admin_div2 || rp.district || '';
      const st = latest[e.code] || {};
      let reason = '';
      if (MWATER.inactiveNames.test(e.name || '')) reason = 'name:' + e.name;
      else if (st.status === 'not_functional') reason = 'maintenance:not_functional@' + String(st.status_on || '').slice(0, 10);
      else if (['kiosk', 'Unprotected dug well', 'Protected dug well'].includes(e.type)) reason = 'type:' + e.type;
      const coords = (e.location && e.location.coordinates) || [];
      return { water_point_id: String(e.code), name: [e.name, e.alt_id].filter(Boolean).join(' '), stratum: mwaterStratum(district, strata), commune: e.admin_div3 || rp.commune || '', fokontany: e.admin_div4 || rp.fokontany || '', village: e.admin_div5 || '',
        lat: coords.length ? coords[1] : '', lon: coords.length ? coords[0] : '', households_served: roofs[e.code] !== undefined ? Math.round(roofs[e.code]) : '', status: reason ? 'inactive' : 'active', mwater_id: e._id, pump: st.pump || e.name || '', district, status_reason: reason };
    }).sort((a, b) => a.water_point_id.localeCompare(b.water_point_id));
    const byStratum = {}; points.forEach(p => { const b = byStratum[p.stratum || '(none)'] = byStratum[p.stratum || '(none)'] || { total: 0, active: 0 }; b.total++; if (p.status === 'active') b.active++; });
    return { points, counts: { fetched: points.length, active: points.filter(p => p.status === 'active').length, noStratum: points.filter(p => !p.stratum).length, byStratum } };
  }
  function frameToCsv(points) { return [FRAME_COLUMNS].concat(points.map(p => FRAME_COLUMNS.map(c => p[c]))).map(r => r.map(csvEscape).join(',')).join('\r\n') + '\r\n'; }
  function householdsToCsv(links, names) {
    const rows = [['household_id', 'water_point_id', 'name_or_code', 'lat', 'lon', 'source']];
    Object.keys(links).sort().forEach(w => links[w].forEach(h => { const e = (names || {})[h.household_id] || {}; const c = (e.location && e.location.coordinates) || []; rows.push([h.household_id, w, e.name || '', c.length ? c[1] : '', c.length ? c[0] : '', h.source]); }));
    return rows.map(r => r.map(csvEscape).join(',')).join('\r\n') + '\r\n';
  }
  // --- HTTP helpers: the token only ever travels as the ?client= query parameter; errors never echo the URL ---
  async function mwaterGet(path, params, token, fetchImpl) {
    const u = new URL(MWATER.api + '/' + path); Object.keys(params || {}).forEach(k => u.searchParams.set(k, params[k])); if (token) u.searchParams.set('client', token);
    const r = await (fetchImpl || fetch)(u.toString(), { headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error('mWater HTTP ' + r.status + ' on /' + path);
    return r.json();
  }
  async function mwaterPages(path, filter, fields, token, onProgress, fetchImpl, size) {
    size = size || 200; const out = [];
    for (let skip = 0; ; skip += size) {
      const page = await mwaterGet(path, { filter: JSON.stringify(filter), fields: JSON.stringify(fields), limit: String(size), skip: String(skip) }, token, fetchImpl);
      if (!Array.isArray(page)) throw new Error('mWater: unexpected reply on /' + path);
      out.push.apply(out, page); if (onProgress) onProgress(path, out.length); if (page.length < size) break;
    }
    return out;
  }
  async function mwaterLogin(username, password, fetchImpl) {
    const r = await (fetchImpl || fetch)(MWATER.api + '/clients', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
    if (!r.ok) throw new Error('mWater login failed (HTTP ' + r.status + ')');
    const b = await r.json(); const token = typeof b === 'string' ? b : (b.client || b.id || b._id); if (!token) throw new Error('mWater login: no client id in reply');
    return { token, username: (typeof b === 'object' && (b.username || b.email)) || username };
  }
  // Full frame load: entities of the programme group, admin regions for rows without admin_div fields, households served, latest functional status, registered household links
  async function mwaterLoadFrame(token, opts) {
    const o = opts || {}; const prog = o.onProgress || function () {}; const F = o.fetchImpl; const cfg = MWATER.forms; const used = [];
    const entities = await mwaterPages('entities/' + MWATER.entityType, { _managed_by: MWATER.group }, MWATER.entityFields, token, prog, F, 100);
    const missing = [...new Set(entities.filter(e => !e.admin_div2 && e.admin_region).map(e => e.admin_region))];
    const regionsById = {};
    if (missing.length) { const regs = await mwaterGet('admin_regions', { filter: JSON.stringify({ _id: { $in: missing } }), fields: JSON.stringify({ _id: 1, full_name: 1 }), limit: String(missing.length) }, token, F); regs.forEach(r => { regionsById[r._id] = r; }); }
    let roofs = {}, latest = {}, links = {}, names = {};
    try { const rr = await mwaterPages('responses', { form: cfg.beneficiaries.id, status: 'final' }, { ['data.' + cfg.beneficiaries.wpQ]: 1, ['data.' + cfg.beneficiaries.roofsQ]: 1, submittedOn: 1, status: 1 }, token, prog, F, 500); roofs = mwaterRoofs(rr, cfg.beneficiaries); used.push(cfg.beneficiaries.id); } catch (e) { prog('warn', 'beneficiaries: ' + e.message); }
    try { const m = cfg.maintenance; const rr = await mwaterPages('responses', { form: m.id, status: 'final' }, { ['data.' + m.wpQ]: 1, ['data.' + m.statusQ]: 1, ['data.' + m.status2Q]: 1, ['data.' + m.pumpQ]: 1, submittedOn: 1, status: 1 }, token, prog, F, 500); latest = mwaterLatestStatus(rr, m); used.push(m.id); } catch (e) { prog('warn', 'maintenance: ' + e.message); }
    if (o.households !== false) {
      const byForm = [];
      for (const rc of cfg.registration) { try { const rr = await mwaterPages('responses', { form: rc.id, status: 'final' }, { ['data.' + rc.wpQ]: 1, ['data.' + rc.hhQ]: 1, status: 1 }, token, prog, F, 500); byForm.push({ cfg: rc, responses: rr }); used.push(rc.id); } catch (e) { prog('warn', rc.name + ': ' + e.message); } }
      links = mwaterHouseholdLinks(byForm);
      const codes = [...new Set(Object.values(links).flat().map(h => h.household_id))];
      for (let i = 0; i < codes.length; i += 150) { try { const hs = await mwaterGet('entities/household', { filter: JSON.stringify({ code: { $in: codes.slice(i, i + 150) } }), fields: JSON.stringify({ code: 1, name: 1, location: 1 }), limit: '150' }, token, F); hs.forEach(h => { names[h.code] = h; }); } catch (e) { prog('warn', 'households: ' + e.message); } }
    }
    const mapped = mapMwaterEntities(entities, { roofs, latest, regionsById });
    return { fetchedAt: new Date().toISOString(), points: mapped.points, counts: mapped.counts, frameCsv: frameToCsv(mapped.points), householdsCsv: Object.keys(links).length ? householdsToCsv(links, names) : null, householdLinks: links, formsUsed: used, source: { api: MWATER.api, group: MWATER.group, entity_type: MWATER.entityType } };
  }

  return { xmur3, mulberry32, makeRng, parseCsv, normaliseWaterPoints, normaliseHouseholds, csvEscape, haversineKm, pointInPolygon, convexHull, nearestNeighbourRoute, sha256, sha256Sync, stats, assignClusters, defaultClusterCount, draw, fieldNumbers, ruleText, toCsv, auditJson, APP_VERSION, ALGORITHM, MWATER, FRAME_COLUMNS, regionParts, mwaterStratum, mwaterLatestStatus, mwaterRoofs, mwaterHouseholdLinks, mapMwaterEntities, frameToCsv, householdsToCsv, mwaterGet, mwaterPages, mwaterLogin, mwaterLoadFrame };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = Core;

/* =====================================================================
 *  I18N — every label in one object
 * ===================================================================*/
const I18N = {
  en: {
    src_mwater: 'mWater (live)', src_csv: 'CSV file (offline)', mw_settings: 'mWater connection', mw_user: 'mWater username or email', mw_pass: 'Password', mw_pass_hint: '(used once to obtain a token; never stored)', mw_login: 'Sign in', mw_token: '…or paste an API token (client id)', mw_save: 'Save token', mw_forget: 'Forget token',
    mw_token_hint: "The token stays in this browser's local storage only, is shown masked, never logged and never included in exports.", mw_stratum: 'Stratum to load', mw_all: 'All strata', mw_hh: 'Also fetch registered households (survey links)', mw_fetch: 'Fetch from mWater',
    mw_connected: 'Token saved: {mask}{user}', mw_not_connected: 'No mWater token. Open "mWater connection" to sign in or paste a token. The programme water points are private, so a token is required.', mw_no_token: 'Sign in or paste a token first.', mw_fetching: 'Fetching {what}: {n} rows…', mw_done: 'Fetched {n} water points ({a} active) at {t}.', mw_err: 'Fetch failed: {e}. Check the connection and the token, or use the CSV source offline.', mw_login_err: 'Sign-in failed: {e}', mw_warn: 'Partial: {w}',
    data_frame_dl: 'Download loaded frame (CSV)', data_hh_dl: 'Download household list (CSV)', data_source: 'Source', data_fetched: 'fetched', btn_mwcsv: 'Export mWater site list (CSV)',
    tab_data: '1 Data', tab_params: '2 Parameters', tab_results: '3 Draw', tab_map: '4 Map', tab_sheet: '5 Field sheet', tab_how: 'How it works',
    data_title: 'Load water points', data_privacy: 'Everything runs in your browser. No file leaves this device.',
    data_wp_label: 'Water points CSV (mWater export)', data_wp_cols: 'Required columns: water_point_id, name, stratum, commune, fokontany, village, lat, lon, households_served, status',
    data_hh_label: 'Households CSV (optional)', data_hh_cols: 'Columns: household_id, water_point_id, name_or_code, lat, lon',
    data_sample: 'Load sample data', data_clear: 'Clear stored data', data_loaded: 'Loaded', data_points: 'water points', data_hh: 'households linked to', data_none: 'No water points loaded.',
    col_stratum: 'Stratum', col_active: 'Active', col_inactive: 'Inactive', col_communes: 'Communes', col_hh_listed: 'Points with household list', sha: 'SHA-256', missing_cols: 'Missing columns',
    params_title: 'Round parameters', p_round: 'Round name', p_stratum: 'Stratum', p_target: 'Target PoU samples', p_hh: 'Households per water point',
    p_cmode: 'Cluster definition', cmode_commune: 'Communes', cmode_axis: 'Custom axes (drawn on map)', p_nclusters: 'Clusters to select', p_repfrac: 'Replacement fraction (%)',
    p_hhrep: 'Household replacements per point', p_seed: 'Seed', p_seed_hint: '(reproduces the draw)', params_stats: 'Statistical check',
    p_icc: 'Intra-cluster correlation (ICC)', p_pass: 'Expected pass rate', p_conf: 'Confidence', p_prec: 'Precision (10 %)', prec_rel: 'Relative to the pass rate (CDM)', prec_abs: 'Absolute (±10 points)',
    btn_draw: 'Draw the sample', preview: 'Eligible active points: {n} in {c} clusters. Water points to select: {w} + {r} replacements = {t}. Auto cluster count: {k}.', auto: 'auto = {k}',
    err_nodata: 'Load water points first.', err_noeligible: 'No active water points in this stratum (or none inside an axis).', err_noaxes: 'Draw at least one axis polygon on the map first.',
    res_empty: 'No draw yet. Load data and set parameters first.', res_title: 'Draw result', btn_csv: 'Export CSV (mWater)', btn_json: 'Export audit JSON', btn_print: 'Print field sheet',
    res_clusters: 'Clusters', res_points: 'Selected water points', res_points_hint: 'For points without a household list, type K (number of households counted clockwise from the pump) to generate the household numbers.', res_audit: 'Audit record',
    st_nwp: 'Water points', st_nact: 'PoU samples planned', st_deff: 'Design effect', st_neff: 'Effective n', st_nreq: 'Required n ({c} % / {p} %)', st_rep: 'Replacement points',
    check_ok: 'Effective sample size {ne} ≥ required {nr}: the design meets the {c}/{p} rule for an expected pass rate of {pr}.',
    check_fail: 'Effective sample size {ne} < required {nr}. The design does NOT meet the {c}/{p} rule.',
    sug_fewer: 'Keep {t} samples but use at most {m} households per point ({w} water points, so more clusters).', sug_more: 'Keep {m} households per point but select {w} water points ({s} samples).',
    w_no_coords: '{n} eligible points have no coordinates; they can be drawn but not mapped.', w_unassigned: '{n} eligible points fall outside every axis and were excluded: {ids}',
    w_insufficient: 'Selected clusters hold {have} points; {needed} were needed ({w} + {r} replacements). Increase the number of clusters.', w_short: 'Only {have} of {w} water points could be selected.',
    w_few_hh: 'Point {id} lists only {have} households ({needed} needed): all were taken.',
    col_order: '#', col_cluster: 'Cluster', col_size: 'Eligible points', col_selected: 'Selected', col_sel_order: 'Draw order', yes: 'yes', no: '—',
    col_id: 'Water point', col_name: 'Name', col_village: 'Village', col_hh: 'Households', col_k: 'K', rep_wp: 'Replacement', rule_short: '{n} random of K, clockwise from pump, nearest first', rep_short: 'rep.',
    map_start_click: 'Set start: tap on map', map_start_gps: 'Set start: my GPS', map_start_wp: 'Start from a water point…', map_fit: 'Fit',
    axis_draw: 'Draw axis polygon', axis_finish: 'Finish polygon', axis_cancel: 'Cancel', axis_export: 'Export axes JSON', axis_import: 'Import axes JSON', axis_list: 'Saved axes', axis_name: 'Axis name', axis_delete: 'Delete', axis_none: 'No axes saved. Use "Draw axis polygon" on the map.', axis_vertices: 'vertices', axis_points: 'eligible points',
    map_route: 'Suggested visiting order (nearest neighbour, straight-line)', map_click_hint: 'Tap the map to set the start point.', map_draw_hint: 'Tap the map to add vertices ({n}). Then press "Finish polygon".', map_no_draw: 'Draw a sample first to see points on the map.', map_no_start: 'Choose a start point to compute the visiting order.',
    col_stop: 'Stop', col_leg: 'Leg (km)', col_cum: 'Total (km)', route_start: 'Start', route_total: 'Total straight-line distance: {km} km', gps_err: 'GPS position unavailable.',
    sheet_hint: 'Use the browser print dialog; choose "Save as PDF" on the phone.', sheet_title: 'PoU/PoC sampling field sheet', sheet_round: 'Round', sheet_stratum: 'Stratum', sheet_seed: 'Seed', sheet_date: 'Date', sheet_team: 'Team', sheet_order: 'Stop', sheet_wp: 'Water point', sheet_cluster: 'Cluster', sheet_gps: 'GPS', sheet_arrive: 'Arrival time', sheet_depart: 'Departure time', sheet_replacement: 'REPLACEMENT POINT — use only if a primary point is unavailable; record the reason.',
    sheet_poc: 'A. Point of collection (PoC) sample and boundary conditions', sheet_c1: 'Spout / outlet disinfected (flame or alcohol wipe) and flushed ≥ 30 s', sheet_c2: 'PoC sample taken in sterile container — Sample ID', sheet_c3: 'Sample container disinfected / sealed, kept cool and in the dark', sheet_c4: 'Free chlorine / turbidity noted if applicable', sheet_time: 'Time',
    sheet_hh: 'B. Point of use (PoU) household samples', sheet_rule: 'Field rule: count all households served by this pump, number them CLOCKWISE from the pump starting at the NEAREST. Enter K (total) here and generate the numbers in the app, or use the pre-generated numbers below.', sheet_k: 'K =', sheet_numbers: 'Selected household numbers', sheet_rep_numbers: 'Replacements',
    sheet_hh_col_n: '#', sheet_hh_col_id: 'Household ID / number', sheet_hh_col_name: 'Name / code', sheet_hh_col_sample: 'PoU sample ID', sheet_hh_col_time: 'Time', sheet_hh_col_store: 'Storage container', sheet_hh_col_notes: 'Notes / reason if replaced',
    sheet_sign: 'Sampler signature', sheet_notes: 'Notes', sheet_empty: 'No draw yet.',
    foot: 'open source, no data leaves the device', offline: 'offline', online: '',
    howto_html: `
<h2>How the draw works</h2>
<p>SaniTap Sampler draws a reproducible, multi-stage cluster sample of households for point-of-use (PoU) water quality testing under the Gold Standard <em>Safe Drinking Water Supply</em> methodology v2.0. The multi-stage design follows the CDM <em>Standard: Sampling and surveys for CDM project activities and programmes of activities</em>.</p>
<h3>Randomness</h3>
<p>The seed text (default: round name + stratum, e.g. <code>2026R1-FD</code>) is hashed with <code>xmur3</code> into a 32-bit word which seeds a <code>mulberry32</code> pseudo-random generator. The same seed, the same input file and the same parameters always produce exactly the same selection, on any device. Records are sorted by identifier before drawing so the row order of the CSV does not matter.</p>
<h3>Frame</h3>
<p>Only water points with <code>status = active</code> in the chosen stratum are eligible.</p>
<h3>Stage 1 — geographic clusters</h3>
<p>Clusters are communes by default, or custom "axes" (polygons you draw on the map, saved on the device). Clusters are selected one by one with probability proportional to their number of eligible water points, without replacement (sequential PPS): a uniform number in [0, total points) is drawn and the cluster whose cumulative share contains it is taken. The default number of clusters is the smallest k such that the k smallest clusters together hold the required number of water points (selected + replacements), so any draw has enough points; you can override it.</p>
<h3>Stage 2 — water points</h3>
<p>Within the selected clusters, water points are drawn by simple random sampling without replacement until <code>ceil(target ÷ households per point)</code> are chosen. Then a replacement list of <code>ceil(replacement fraction × that number)</code> points is drawn in random order; use replacements in the listed order only when a primary point cannot be sampled and record the reason.</p>
<h3>Stage 3 — households</h3>
<p>If a household list is loaded, N households (plus 2 replacements) are drawn by simple random sampling from those linked to each selected water point. Otherwise a field rule applies: count the households served (K), number them clockwise from the pump starting at the nearest, and draw N random numbers between 1 and K. The numbers are generated when K is typed, from a generator seeded with <code>seed | water_point_id | K</code>, so they are also reproducible.</p>
<h3>Statistical check</h3>
<p>Households sampled at the same water point are correlated. The design effect is <code>DEFF = 1 + (m − 1) × ICC</code> with m households per point and ICC default 0.1 (editable). Effective sample size is <code>n / DEFF</code>. The required sample size for a proportion at the expected pass rate p follows the CDM 90/10 rule: <code>n = z² p(1 − p) / d²</code> with z = 1.645 for 90 % confidence and d = 10 % of p (relative precision, CDM default) or 0.10 absolute. If the effective size is below the requirement the tool proposes fewer households per point (hence more water points and clusters) or more water points.</p>
<h3>Audit record</h3>
<p>Every draw writes a JSON record: timestamp, seed, algorithm, input file names and SHA-256 hashes, parameters, frame, selected clusters, water points, replacements and households or field rule. It is shown on screen, exported as JSON and is the evidence of random selection retained for the validation and verification body (VVB).</p>
<h3>Logistics</h3>
<p>The map shows selected points (numbered), replacements (grey), cluster boundaries (convex hull of the commune's points, or the axis polygon) and a visiting order computed by nearest neighbour from a start point you choose, with straight-line distances. The route is a suggestion and does not affect the statistical validity of the sample.</p>
<h3>Offline</h3>
<p>After the first load the app shell is cached by a service worker and works offline. Map tiles are not cached. Loaded data, axes and the last draw are kept in the browser's local storage on this device only.</p>`
  },
  fr: {
    src_mwater: 'mWater (en direct)', src_csv: 'Fichier CSV (hors ligne)', mw_settings: 'Connexion mWater', mw_user: 'Identifiant ou e-mail mWater', mw_pass: 'Mot de passe', mw_pass_hint: '(utilisé une fois pour obtenir un jeton ; jamais stocké)', mw_login: 'Se connecter', mw_token: '…ou coller un jeton API (client id)', mw_save: 'Enregistrer le jeton', mw_forget: 'Oublier le jeton',
    mw_token_hint: 'Le jeton reste uniquement dans le stockage local de ce navigateur, est affiché masqué, jamais journalisé ni inclus dans les exports.', mw_stratum: 'Strate à charger', mw_all: 'Toutes les strates', mw_hh: 'Charger aussi les ménages enregistrés (liens des enquêtes)', mw_fetch: 'Charger depuis mWater',
    mw_connected: 'Jeton enregistré : {mask}{user}', mw_not_connected: 'Aucun jeton mWater. Ouvrez « Connexion mWater » pour vous connecter ou coller un jeton. Les points d’eau du programme sont privés : un jeton est nécessaire.', mw_no_token: 'Connectez-vous ou collez un jeton d’abord.', mw_fetching: 'Chargement {what} : {n} lignes…', mw_done: '{n} points d’eau chargés ({a} actifs) à {t}.', mw_err: 'Échec du chargement : {e}. Vérifiez la connexion et le jeton, ou utilisez la source CSV hors ligne.', mw_login_err: 'Connexion échouée : {e}', mw_warn: 'Partiel : {w}',
    data_frame_dl: 'Télécharger la base chargée (CSV)', data_hh_dl: 'Télécharger la liste des ménages (CSV)', data_source: 'Source', data_fetched: 'chargé', btn_mwcsv: 'Exporter la liste de sites mWater (CSV)',
    tab_data: '1 Données', tab_params: '2 Paramètres', tab_results: '3 Tirage', tab_map: '4 Carte', tab_sheet: '5 Fiche terrain', tab_how: 'Fonctionnement',
    data_title: 'Charger les points d’eau', data_privacy: 'Tout se passe dans votre navigateur. Aucun fichier ne quitte cet appareil.',
    data_wp_label: 'CSV des points d’eau (export mWater)', data_wp_cols: 'Colonnes requises : water_point_id, name, stratum, commune, fokontany, village, lat, lon, households_served, status',
    data_hh_label: 'CSV des ménages (facultatif)', data_hh_cols: 'Colonnes : household_id, water_point_id, name_or_code, lat, lon',
    data_sample: 'Charger les données d’exemple', data_clear: 'Effacer les données stockées', data_loaded: 'Chargé', data_points: 'points d’eau', data_hh: 'ménages liés à', data_none: 'Aucun point d’eau chargé.',
    col_stratum: 'Strate', col_active: 'Actifs', col_inactive: 'Inactifs', col_communes: 'Communes', col_hh_listed: 'Points avec liste de ménages', sha: 'SHA-256', missing_cols: 'Colonnes manquantes',
    params_title: 'Paramètres du cycle', p_round: 'Nom du cycle', p_stratum: 'Strate', p_target: 'Échantillons PoU visés', p_hh: 'Ménages par point d’eau',
    p_cmode: 'Définition des grappes', cmode_commune: 'Communes', cmode_axis: 'Axes personnalisés (dessinés sur la carte)', p_nclusters: 'Grappes à sélectionner', p_repfrac: 'Fraction de remplacement (%)',
    p_hhrep: 'Ménages de remplacement par point', p_seed: 'Graine (seed)', p_seed_hint: '(reproduit le tirage)', params_stats: 'Vérification statistique',
    p_icc: 'Corrélation intra-grappe (ICC)', p_pass: 'Taux de conformité attendu', p_conf: 'Confiance', p_prec: 'Précision (10 %)', prec_rel: 'Relative au taux attendu (CDM)', prec_abs: 'Absolue (±10 points)',
    btn_draw: 'Tirer l’échantillon', preview: 'Points actifs éligibles : {n} dans {c} grappes. Points d’eau à sélectionner : {w} + {r} remplacements = {t}. Nombre de grappes auto : {k}.', auto: 'auto = {k}',
    err_nodata: 'Chargez d’abord les points d’eau.', err_noeligible: 'Aucun point d’eau actif dans cette strate (ou aucun à l’intérieur d’un axe).', err_noaxes: 'Dessinez d’abord au moins un axe sur la carte.',
    res_empty: 'Pas encore de tirage. Chargez les données et fixez les paramètres.', res_title: 'Résultat du tirage', btn_csv: 'Exporter CSV (mWater)', btn_json: 'Exporter l’audit JSON', btn_print: 'Imprimer la fiche terrain',
    res_clusters: 'Grappes', res_points: 'Points d’eau sélectionnés', res_points_hint: 'Pour les points sans liste de ménages, saisissez K (nombre de ménages comptés dans le sens horaire depuis la pompe) pour générer les numéros.', res_audit: 'Enregistrement d’audit',
    st_nwp: 'Points d’eau', st_nact: 'Échantillons PoU prévus', st_deff: 'Effet de plan', st_neff: 'n effectif', st_nreq: 'n requis ({c} % / {p} %)', st_rep: 'Points de remplacement',
    check_ok: 'Taille effective {ne} ≥ requise {nr} : le plan respecte la règle {c}/{p} pour un taux de conformité attendu de {pr}.',
    check_fail: 'Taille effective {ne} < requise {nr}. Le plan NE respecte PAS la règle {c}/{p}.',
    sug_fewer: 'Garder {t} échantillons mais au plus {m} ménages par point ({w} points d’eau, donc plus de grappes).', sug_more: 'Garder {m} ménages par point mais sélectionner {w} points d’eau ({s} échantillons).',
    w_no_coords: '{n} points éligibles sans coordonnées : tirables mais non cartographiables.', w_unassigned: '{n} points éligibles hors de tout axe ont été exclus : {ids}',
    w_insufficient: 'Les grappes sélectionnées contiennent {have} points ; il en fallait {needed} ({w} + {r} remplacements). Augmentez le nombre de grappes.', w_short: 'Seulement {have} des {w} points d’eau ont pu être sélectionnés.',
    w_few_hh: 'Le point {id} ne liste que {have} ménages ({needed} requis) : tous ont été pris.',
    col_order: 'N°', col_cluster: 'Grappe', col_size: 'Points éligibles', col_selected: 'Sélectionnée', col_sel_order: 'Ordre de tirage', yes: 'oui', no: '—',
    col_id: 'Point d’eau', col_name: 'Nom', col_village: 'Village', col_hh: 'Ménages', col_k: 'K', rep_wp: 'Remplacement', rule_short: '{n} au hasard parmi K, sens horaire depuis la pompe, le plus proche d’abord', rep_short: 'rempl.',
    map_start_click: 'Départ : toucher la carte', map_start_gps: 'Départ : mon GPS', map_start_wp: 'Partir d’un point d’eau…', map_fit: 'Cadrer',
    axis_draw: 'Dessiner un axe', axis_finish: 'Terminer le polygone', axis_cancel: 'Annuler', axis_export: 'Exporter les axes JSON', axis_import: 'Importer des axes JSON', axis_list: 'Axes enregistrés', axis_name: 'Nom de l’axe', axis_delete: 'Supprimer', axis_none: 'Aucun axe enregistré. Utilisez « Dessiner un axe » sur la carte.', axis_vertices: 'sommets', axis_points: 'points éligibles',
    map_route: 'Ordre de visite suggéré (plus proche voisin, à vol d’oiseau)', map_click_hint: 'Touchez la carte pour fixer le point de départ.', map_draw_hint: 'Touchez la carte pour ajouter des sommets ({n}). Puis « Terminer le polygone ».', map_no_draw: 'Faites d’abord un tirage pour voir les points sur la carte.', map_no_start: 'Choisissez un point de départ pour calculer l’ordre de visite.',
    col_stop: 'Étape', col_leg: 'Tronçon (km)', col_cum: 'Cumul (km)', route_start: 'Départ', route_total: 'Distance totale à vol d’oiseau : {km} km', gps_err: 'Position GPS indisponible.',
    sheet_hint: 'Utilisez l’impression du navigateur ; choisissez « Enregistrer en PDF » sur le téléphone.', sheet_title: 'Fiche terrain échantillonnage PoU/PoC', sheet_round: 'Cycle', sheet_stratum: 'Strate', sheet_seed: 'Graine', sheet_date: 'Date', sheet_team: 'Équipe', sheet_order: 'Étape', sheet_wp: 'Point d’eau', sheet_cluster: 'Grappe', sheet_gps: 'GPS', sheet_arrive: 'Heure d’arrivée', sheet_depart: 'Heure de départ', sheet_replacement: 'POINT DE REMPLACEMENT — à utiliser seulement si un point principal est indisponible ; noter la raison.',
    sheet_poc: 'A. Échantillon au point de collecte (PoC) et conditions limites', sheet_c1: 'Bec / sortie désinfecté(e) (flamme ou lingette alcool) et purge ≥ 30 s', sheet_c2: 'Échantillon PoC prélevé en flacon stérile — ID échantillon', sheet_c3: 'Flacon désinfecté / scellé, gardé au frais et à l’abri de la lumière', sheet_c4: 'Chlore libre / turbidité notés si applicable', sheet_time: 'Heure',
    sheet_hh: 'B. Échantillons ménages au point d’utilisation (PoU)', sheet_rule: 'Règle terrain : compter tous les ménages desservis par cette pompe, les numéroter dans le SENS HORAIRE depuis la pompe en commençant par le PLUS PROCHE. Inscrire K (total) ici et générer les numéros dans l’application, ou utiliser les numéros pré-générés ci-dessous.', sheet_k: 'K =', sheet_numbers: 'Numéros de ménages sélectionnés', sheet_rep_numbers: 'Remplacements',
    sheet_hh_col_n: 'N°', sheet_hh_col_id: 'ID / numéro du ménage', sheet_hh_col_name: 'Nom / code', sheet_hh_col_sample: 'ID échantillon PoU', sheet_hh_col_time: 'Heure', sheet_hh_col_store: 'Récipient de stockage', sheet_hh_col_notes: 'Notes / raison si remplacé',
    sheet_sign: 'Signature du préleveur', sheet_notes: 'Notes', sheet_empty: 'Pas encore de tirage.',
    foot: 'code ouvert, aucune donnée ne quitte l’appareil', offline: 'hors ligne', online: '',
    howto_html: `
<h2>Comment fonctionne le tirage</h2>
<p>SaniTap Sampler tire un échantillon en grappes à plusieurs degrés, reproductible, de ménages pour les tests de qualité de l’eau au point d’utilisation (PoU) selon la méthodologie Gold Standard <em>Safe Drinking Water Supply</em> v2.0. Le plan à plusieurs degrés suit le <em>Standard: Sampling and surveys for CDM project activities and programmes of activities</em> du MDP.</p>
<h3>Aléa</h3>
<p>Le texte de la graine (par défaut : nom du cycle + strate, p. ex. <code>2026R1-FD</code>) est haché par <code>xmur3</code> en un mot de 32 bits qui initialise le générateur pseudo-aléatoire <code>mulberry32</code>. La même graine, le même fichier et les mêmes paramètres produisent toujours exactement la même sélection, sur n’importe quel appareil. Les enregistrements sont triés par identifiant avant le tirage : l’ordre des lignes du CSV n’a pas d’importance.</p>
<h3>Base de sondage</h3>
<p>Seuls les points d’eau avec <code>status = active</code> dans la strate choisie sont éligibles.</p>
<h3>Degré 1 — grappes géographiques</h3>
<p>Les grappes sont les communes par défaut, ou des « axes » personnalisés (polygones dessinés sur la carte, enregistrés sur l’appareil). Les grappes sont tirées une à une avec une probabilité proportionnelle à leur nombre de points d’eau éligibles, sans remise (PPS séquentiel) : un nombre uniforme dans [0, total) est tiré et la grappe dont la part cumulée le contient est retenue. Le nombre de grappes par défaut est le plus petit k tel que les k plus petites grappes contiennent ensemble le nombre requis de points (sélection + remplacements) ; vous pouvez le modifier.</p>
<h3>Degré 2 — points d’eau</h3>
<p>Dans les grappes retenues, les points d’eau sont tirés par sondage aléatoire simple sans remise jusqu’à <code>ceil(cible ÷ ménages par point)</code>. Puis une liste de remplacement de <code>ceil(fraction × ce nombre)</code> points est tirée dans un ordre aléatoire ; n’utiliser les remplacements, dans l’ordre, que si un point principal ne peut pas être échantillonné, et noter la raison.</p>
<h3>Degré 3 — ménages</h3>
<p>Si une liste de ménages est chargée, N ménages (+ 2 remplacements) sont tirés au hasard parmi ceux liés à chaque point retenu. Sinon une règle terrain s’applique : compter les ménages desservis (K), les numéroter dans le sens horaire depuis la pompe en commençant par le plus proche, et tirer N numéros entre 1 et K. Les numéros sont générés quand K est saisi, par un générateur initialisé avec <code>graine | water_point_id | K</code> : ils sont donc aussi reproductibles.</p>
<h3>Vérification statistique</h3>
<p>Les ménages d’un même point d’eau sont corrélés. L’effet de plan est <code>DEFF = 1 + (m − 1) × ICC</code> avec m ménages par point et ICC = 0,1 par défaut (modifiable). La taille effective est <code>n / DEFF</code>. La taille requise pour une proportion au taux attendu p suit la règle 90/10 du MDP : <code>n = z² p(1 − p) / d²</code> avec z = 1,645 pour 90 % de confiance et d = 10 % de p (précision relative, défaut MDP) ou 0,10 en absolu. Si la taille effective est insuffisante, l’outil propose moins de ménages par point (donc plus de points et de grappes) ou plus de points d’eau.</p>
<h3>Enregistrement d’audit</h3>
<p>Chaque tirage écrit un enregistrement JSON : horodatage, graine, algorithme, noms et empreintes SHA-256 des fichiers, paramètres, base, grappes retenues, points d’eau, remplacements et ménages ou règle terrain. Il est affiché, exporté en JSON et constitue la preuve de sélection aléatoire conservée pour l’organisme de validation et vérification (VVB).</p>
<h3>Logistique</h3>
<p>La carte montre les points retenus (numérotés), les remplacements (gris), les limites des grappes (enveloppe convexe des points de la commune, ou polygone de l’axe) et un ordre de visite par plus proche voisin depuis un point de départ choisi, avec les distances à vol d’oiseau. L’itinéraire est une suggestion et n’affecte pas la validité statistique.</p>
<h3>Hors ligne</h3>
<p>Après le premier chargement, l’application est mise en cache par un service worker et fonctionne hors ligne. Les tuiles de carte ne sont pas mises en cache. Données, axes et dernier tirage sont conservés dans le stockage local du navigateur, sur cet appareil seulement.</p>`
  }
};

/* =====================================================================
 *  UI (browser only)
 * ===================================================================*/
if (typeof window !== 'undefined' && typeof document !== 'undefined') (function () {
  const $ = id => document.getElementById(id);
  const LS = { get(k, d) { try { const v = localStorage.getItem('sanitap.' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } }, set(k, v) { try { localStorage.setItem('sanitap.' + k, JSON.stringify(v)); } catch (e) { console.warn('localStorage', e); } }, del(k) { try { localStorage.removeItem('sanitap.' + k); } catch (e) {} } };
  const state = { mw: LS.get('mw', null), lang: LS.get('lang', (navigator.language || '').startsWith('fr') ? 'fr' : 'en'), wp: LS.get('wp', null), hh: LS.get('hh', null), points: [], hhByWp: {}, axes: LS.get('axes', []), result: null, kValues: LS.get('k', {}), start: LS.get('start', null), route: null, map: null, layers: {}, drawing: null, pickStart: false };
  const t = (k, v) => { let s = (I18N[state.lang] && I18N[state.lang][k]) || I18N.en[k] || k; if (v) for (const x in v) s = s.split('{' + x + '}').join(v[x]); return s; };
  const esc = s => String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (n, d) => (n === undefined || n === null || isNaN(n)) ? '' : Number(n).toFixed(d === undefined ? 1 : d);

  /* ---------- language ---------- */
  function applyLang() {
    document.documentElement.lang = state.lang;
    document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
    $('lang-toggle').textContent = state.lang === 'en' ? 'FR' : 'EN';
    $('howto').innerHTML = t('howto_html');
    $('ver').textContent = 'v' + APP_VERSION;
    renderData(); renderPreview(); renderResults(); renderSheet(); renderAxisList(); renderRoute(); renderMw();
  }
  $('lang-toggle').onclick = () => { state.lang = state.lang === 'en' ? 'fr' : 'en'; LS.set('lang', state.lang); applyLang(); };

  /* ---------- tabs ---------- */
  function showTab(name) {
    document.querySelectorAll('nav button').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
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
    updateSeed();
  }
  async function loadHh(text, name, meta) {
    const parsed = Core.parseCsv(text);
    const hash = await Core.sha256(text);
    state.hh = Object.assign({ name, hash, text, missing: ['household_id', 'water_point_id'].filter(c => !parsed.header.includes(c)), source: 'csv' }, meta || {});
    LS.set('hh', state.hh); applyHh();
  }
  function applyHh() { state.hhByWp = state.hh ? Core.normaliseHouseholds(Core.parseCsv(state.hh.text).records) : {}; }
  $('file-wp').onchange = async e => { const f = e.target.files[0]; if (!f) return; await loadWp(await readFile(f), f.name, { source: 'csv' }); setSource('csv'); renderData(); renderPreview(); };
  $('file-hh').onchange = async e => { const f = e.target.files[0]; if (!f) return; await loadHh(await readFile(f), f.name); renderData(); renderPreview(); };
  $('btn-sample').onclick = async () => {
    try {
      const [a, b] = await Promise.all([fetch('data/sample-water-points.csv').then(r => r.text()), fetch('data/sample-households.csv').then(r => r.text())]);
      await loadWp(a, 'sample-water-points.csv', { source: 'csv' }); await loadHh(b, 'sample-households.csv', { source: 'csv' }); setSource('csv'); renderData(); renderPreview();
    } catch (e) { $('data-status').innerHTML = `<div class="msg err">${esc(e.message)}</div>`; }
  };
  $('btn-clear').onclick = () => { ['wp', 'hh', 'last', 'k', 'start'].forEach(LS.del); state.wp = null; state.hh = null; state.points = []; state.hhByWp = {}; state.result = null; state.kValues = {}; state.route = null; state.start = null; applyWp(); renderData(); renderPreview(); renderResults(); renderSheet(); };
  function renderData() {
    const st = $('data-status'), sm = $('data-summary');
    if (!state.wp) { st.innerHTML = `<div class="msg warn">${t('data_none')}</div>`; sm.innerHTML = ''; $('btn-frame-dl').classList.add('hidden'); $('btn-hh-dl').classList.add('hidden'); return; }
    const src = state.wp.source === 'mwater' ? `mWater · ${t('data_fetched')} ${esc(state.wp.fetchedAt || '')}` : 'CSV';
    let h = `<div class="msg ok">${t('data_source')}: <b>${src}</b><br>${t('data_loaded')}: <b>${esc(state.wp.name)}</b> — ${state.points.length} ${t('data_points')}${state.wp.counts ? ` (${state.wp.counts.active} ${t('col_active').toLowerCase()})` : ''}<br><small>${t('sha')}: ${state.wp.hash}</small></div>`;
    $('btn-frame-dl').classList.remove('hidden'); $('btn-hh-dl').classList.toggle('hidden', !state.hh);
    if (state.wp.missing.length) h += `<div class="msg err">${t('missing_cols')}: ${state.wp.missing.join(', ')}</div>`;
    if (state.wp.errors && state.wp.errors.length) h += `<div class="msg warn">${state.wp.errors.slice(0, 5).map(esc).join('<br>')}${state.wp.errors.length > 5 ? '…' : ''}</div>`;
    if (state.hh) { const nh = Object.values(state.hhByWp).reduce((s, l) => s + l.length, 0); h += `<div class="msg ok">${t('data_loaded')}: <b>${esc(state.hh.name)}</b> — ${nh} ${t('data_hh')} ${Object.keys(state.hhByWp).length} ${t('data_points')}<br><small>${t('sha')}: ${state.hh.hash}</small></div>`; if (state.hh.missing.length) h += `<div class="msg err">${t('missing_cols')}: ${state.hh.missing.join(', ')}</div>`; }
    st.innerHTML = h;
    const by = {};
    state.points.forEach(p => { const b = by[p.stratum] = by[p.stratum] || { a: 0, i: 0, c: new Set(), l: 0 }; p.active ? b.a++ : b.i++; b.c.add(p.commune); if (state.hhByWp[p.water_point_id]) b.l++; });
    sm.innerHTML = `<table><tr><th>${t('col_stratum')}</th><th>${t('col_active')}</th><th>${t('col_inactive')}</th><th>${t('col_communes')}</th><th>${t('col_hh_listed')}</th></tr>` +
      Object.keys(by).sort().map(s => `<tr><td>${esc(s)}</td><td>${by[s].a}</td><td>${by[s].i}</td><td>${by[s].c.size}</td><td>${by[s].l}</td></tr>`).join('') + '</table>';
  }


  /* ---------- mWater source ---------- */
  const mask = tok => tok ? '••••' + String(tok).slice(-4) : '';
  function renderMw() {
    const c = $('mw-conn');
    c.innerHTML = state.mw && state.mw.token ? `<span class="msg ok" style="display:inline-block">${t('mw_connected', { mask: mask(state.mw.token), user: state.mw.username ? ' · ' + esc(state.mw.username) : '' })}</span>` : `<div class="msg warn">${t('mw_not_connected')}</div>`;
    const sel = $('mw-stratum'); const cur = sel.value;
    sel.innerHTML = `<option value="">${t('mw_all')}</option>` + Object.keys(Core.MWATER.strata).map(k => `<option value="${k}">${k} — ${esc(Core.MWATER.strata[k].label)}</option>`).join('');
    sel.value = cur || (LS.get('mwstratum', 'FD'));
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
      const r = await Core.mwaterLoadFrame(state.mw.token, { households: $('mw-hh').checked, onProgress: (what, n) => { if (what === 'warn') warns.push(n); else out.textContent = t('mw_fetching', { what: what.replace(/^entities\//, ''), n }); } });
      const points = stratum ? r.points.filter(p => p.stratum === stratum) : r.points;
      const ids = new Set(points.map(p => p.water_point_id));
      const frameCsv = Core.frameToCsv(points);
      const counts = { fetched: points.length, active: points.filter(p => p.status === 'active').length, fetched_total: r.counts.fetched, active_total: r.counts.active };
      const mwMeta = Object.assign({}, r.source, { fetched_at: r.fetchedAt, stratum_filter: stratum || null, forms_used: r.formsUsed, counts, status_rule: 'inactive if name matches ' + String(Core.MWATER.inactiveNames) + ', if the latest final maintenance record says not functional, or if type is kiosk/dug well' });
      await loadWp(frameCsv, 'mwater:' + Core.MWATER.entityType + (stratum ? ':' + stratum : '') + '@' + r.fetchedAt, { source: 'mwater', fetchedAt: r.fetchedAt, counts, mwater: mwMeta });
      if (r.householdsCsv) {
        const lines = r.householdsCsv.split('\r\n'); const kept = [lines[0]].concat(lines.slice(1).filter(l => l && ids.has(Core.parseCsv(lines[0] + '\r\n' + l).records[0].water_point_id)));
        await loadHh(kept.join('\r\n') + '\r\n', 'mwater:registration-forms@' + r.fetchedAt, { source: 'mwater', fetchedAt: r.fetchedAt });
      } else { state.hh = null; LS.del('hh'); applyHh(); }
      if (stratum) { $('p-stratum').value = stratum; seedTouched = false; updateSeed(); }
      out.innerHTML = `<div class="msg ok">${t('mw_done', { n: counts.fetched, a: counts.active, t: r.fetchedAt })}</div>` + (warns.length ? `<div class="msg warn">${esc(t('mw_warn', { w: warns.join('; ') }))}</div>` : '');
      renderData(); renderPreview();
    } catch (e) { out.innerHTML = `<div class="msg err">${esc(t('mw_err', { e: e.message }))}</div>`; }
    $('btn-mw-fetch').disabled = false;
  };
  $('btn-frame-dl').onclick = () => { if (state.wp) download((state.wp.source === 'mwater' ? 'sanitap-frame-mwater' : 'sanitap-frame') + '.csv', state.wp.text, 'text/csv'); };
  $('btn-hh-dl').onclick = () => { if (state.hh) download('sanitap-households.csv', state.hh.text, 'text/csv'); };

  /* ---------- parameters ---------- */
  let seedTouched = false;
  function updateSeed() { if (!seedTouched) $('p-seed').value = ($('p-round').value.replace(/\s+/g, '') || 'round') + '-' + ($('p-stratum').value || 'stratum'); }
  $('p-seed').oninput = () => { seedTouched = $('p-seed').value.trim() !== ''; };
  ['p-round', 'p-stratum'].forEach(id => $(id).addEventListener('input', () => { seedTouched = false; updateSeed(); renderPreview(); }));
  ['p-target', 'p-hh', 'p-cmode', 'p-nclusters', 'p-repfrac', 'p-hhrep', 'p-icc', 'p-pass', 'p-conf', 'p-prectype'].forEach(id => $(id).addEventListener('input', renderPreview));
  function readParams() {
    const num = (id, d) => { const v = parseFloat($(id).value); return isNaN(v) ? d : v; };
    return {
      roundName: $('p-round').value.trim(), stratum: $('p-stratum').value, target: Math.max(1, Math.round(num('p-target', 58))), hhPerPoint: Math.max(1, Math.round(num('p-hh', 5))),
      clusterMode: $('p-cmode').value, nClusters: $('p-nclusters').value ? Math.max(1, Math.round(num('p-nclusters', 0))) : null,
      replacementFraction: Math.min(1, Math.max(0, num('p-repfrac', 20) / 100)), hhReplacements: Math.max(0, Math.round(num('p-hhrep', 2))), seed: $('p-seed').value.trim() || 'seed',
      icc: Math.min(1, Math.max(0, num('p-icc', 0.1))), expectedPass: Math.min(0.99, Math.max(0.01, num('p-pass', 0.95))), confidence: $('p-conf').value, precision: 0.10, precisionType: $('p-prectype').value,
      wpFileName: state.wp && state.wp.name, wpFileHash: state.wp && state.wp.hash, hhFileName: state.hh && state.hh.name, hhFileHash: state.hh && state.hh.hash,
      source: (state.wp && state.wp.source) || 'csv', mwater: state.wp && state.wp.source === 'mwater' ? state.wp.mwater : null
    };
  }
  function renderPreview() {
    const el = $('params-preview'); if (!state.points.length) { el.textContent = t('err_nodata'); return; }
    const p = readParams();
    const elig = state.points.filter(x => x.active && String(x.stratum) === String(p.stratum));
    const { clusters } = Core.assignClusters(elig, p.clusterMode, state.axes);
    const st = Core.stats(p); const nRep = Math.ceil(st.nWp * p.replacementFraction);
    const k = Core.defaultClusterCount(clusters, st.nWp + nRep);
    $('p-nclusters-hint').textContent = t('auto', { k }); $('p-nclusters').placeholder = t('auto', { k });
    el.textContent = t('preview', { n: elig.length, c: clusters.length, w: st.nWp, r: nRep, t: st.nWp + nRep, k });
  }
  $('btn-draw').onclick = () => {
    const msg = $('params-msg'); msg.innerHTML = '';
    if (!state.points.length) { msg.innerHTML = `<div class="msg err">${t('err_nodata')}</div>`; return; }
    const p = readParams();
    if (p.clusterMode === 'axis' && !state.axes.length) { msg.innerHTML = `<div class="msg err">${t('err_noaxes')}</div>`; return; }
    runDraw(p, true);
  };
  function runDraw(p, fresh) {
    if (fresh) { p.timestamp = new Date().toISOString(); state.kValues = {}; state.route = null; }
    const r = Core.draw(p, state.points, state.hhByWp, state.axes);
    if (r.error) { $('params-msg').innerHTML = `<div class="msg err">${t('err_noeligible')}</div>`; return; }
    state.result = r; LS.set('last', p); LS.set('k', state.kValues);
    if (state.start) computeRoute();
    renderResults(); renderSheet(); if (state.map) renderMap();
    if (fresh) showTab('results');
  }

  /* ---------- results ---------- */
  function warnText(w) {
    switch (w.code) {
      case 'no_coords': return t('w_no_coords', w);
      case 'unassigned': return t('w_unassigned', { n: w.n, ids: w.ids.join(', ') });
      case 'insufficient_points': return t('w_insufficient', { have: w.have, needed: w.needed, w: w.nWp, r: w.nRep });
      case 'short_selection': return t('w_short', { have: w.have, w: w.nWp });
      case 'few_households': return t('w_few_hh', w);
      default: return JSON.stringify(w);
    }
  }
  function orderMap() { const o = {}; if (state.route) state.route.stops.forEach((s, i) => { o[s.point.water_point_id] = i + 1; }); return o; }
  function hhCell(w) {
    const h = w.households;
    if (h.mode === 'list') return h.primary.map(x => esc(x.household_id)).join(', ') + (h.replacements.length ? ` <span class="muted">(${t('rep_short')} ${h.replacements.map(x => esc(x.household_id)).join(', ')})</span>` : '');
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
    const selOrd = {}; r.selectedClusters.forEach(c => { selOrd[c.name] = c.order; });
    $('res-clusters').innerHTML = `<table><tr><th>${t('col_cluster')}</th><th>${t('col_size')}</th><th>${t('col_selected')}</th><th>${t('col_sel_order')}</th></tr>` + r.clusters.map(c => `<tr class="${selOrd[c.name] ? '' : 'rep'}"><td>${esc(c.name)}</td><td>${c.size}</td><td>${selOrd[c.name] ? t('yes') : t('no')}</td><td>${selOrd[c.name] || ''}</td></tr>`).join('') + '</table>';
    const om = orderMap();
    const row = (w, rep) => `<tr class="${rep ? 'rep' : ''}"><td>${rep ? 'R' + w.order : (om[w.water_point_id] || w.order)}</td><td><b>${esc(w.water_point_id)}</b><br><small>${esc(w.name)}</small></td><td>${esc(w.cluster)}<br><small>${esc(w.fokontany)} / ${esc(w.village)}</small></td><td>${hhCell(w)}</td></tr>`;
    $('res-points').innerHTML = `<table><tr><th>${t('col_order')}</th><th>${t('col_id')}</th><th>${t('col_cluster')}</th><th>${t('col_hh')}</th></tr>` + r.selected.map(w => row(w, false)).join('') + r.replacements.map(w => row(w, true)).join('') + '</table>';
    $('res-points').querySelectorAll('input[data-k]').forEach(inp => inp.addEventListener('change', () => { const v = parseInt(inp.value, 10); if (v > 0) state.kValues[inp.dataset.k] = v; else delete state.kValues[inp.dataset.k]; LS.set('k', state.kValues); renderResults(); renderSheet(); }));
    $('res-audit').textContent = Core.auditJson(r, auditExtra());
  }
  function auditExtra() {
    const ex = {}; const om = orderMap();
    if (state.route) ex.visiting_order = { start: state.start, stops: state.route.stops.map((s, i) => ({ stop: i + 1, water_point_id: s.point.water_point_id, leg_km: +s.legKm.toFixed(2), cumulative_km: +s.cumKm.toFixed(2) })), total_km: +state.route.totalKm.toFixed(2) };
    const ks = Object.keys(state.kValues);
    if (ks.length && state.result) ex.field_rule_numbers = ks.map(id => { const w = state.result.selected.concat(state.result.replacements).find(x => x.water_point_id === id); if (!w || w.households.mode !== 'rule') return null; return Object.assign({ water_point_id: id }, Core.fieldNumbers(state.result.params.seed, id, state.kValues[id], w.households.n, w.households.extra)); }).filter(Boolean);
    return ex;
  }
  function download(name, content, type) {
    const blob = new Blob([content], { type }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  const fname = ext => `sanitap-${(state.result.params.roundName || 'round').replace(/\s+/g, '')}-${state.result.params.stratum}-${ext}`;
  $('btn-csv').onclick = () => { if (state.result) download(fname('selection.csv'), Core.toCsv(state.result, orderMap(), state.kValues), 'text/csv'); };
  $('btn-json').onclick = () => { if (state.result) download(fname('audit.json'), Core.auditJson(state.result, auditExtra()), 'application/json'); };
  $('btn-mwcsv').onclick = () => {
    if (!state.result) return; const r = state.result, p = r.params, om = orderMap();
    const rows = [['code', 'name', 'round', 'stratum', 'role', 'order', 'seed', 'drawn_at']];
    r.selected.forEach(w => rows.push([w.water_point_id, w.name, p.roundName, p.stratum, 'selected', om[w.water_point_id] || w.order, p.seed, r.audit.timestamp]));
    r.replacements.forEach(w => rows.push([w.water_point_id, w.name, p.roundName, p.stratum, 'replacement', 'R' + w.order, p.seed, r.audit.timestamp]));
    download(fname('mwater-sites.csv'), rows.map(x => x.map(Core.csvEscape).join(',')).join('\r\n') + '\r\n', 'text/csv');
  };
  $('btn-print').onclick = $('btn-print2').onclick = () => { showTab('sheet'); setTimeout(() => window.print(), 100); };

  /* ---------- field sheet ---------- */
  function renderSheet() {
    const r = state.result; const el = $('fieldsheet');
    if (!r) { el.innerHTML = `<p class="muted">${t('sheet_empty')}</p>`; return; }
    const p = r.params, om = orderMap(); const line = (w) => `<span class="line" style="min-width:${w || 7}rem"></span>`;
    const sheet = (w, rep) => {
      const h = w.households; const K = state.kValues[w.water_point_id];
      const fn = (h.mode === 'rule' && K) ? Core.fieldNumbers(p.seed, w.water_point_id, K, h.n, h.extra) : null;
      const ids = h.mode === 'list' ? h.primary.map(x => [x.household_id, x.name_or_code]).concat(h.replacements.map(x => [x.household_id, x.name_or_code, true]))
        : fn ? fn.primary.map(x => ['HH#' + x, '']).concat(fn.replacements.map(x => ['HH#' + x, '', true]))
        : Array.from({ length: h.n + h.extra }, (_, i) => ['', '', i >= h.n]);
      return `<div class="sheet">
<h2>${t('sheet_title')} — ${esc(p.roundName)} / ${esc(p.stratum)}</h2>
<div class="meta"><div><b>${t('sheet_order')}:</b> ${rep ? 'R' + w.order : (om[w.water_point_id] || w.order)}</div><div><b>${t('sheet_date')}:</b> ${line(8)}</div>
<div><b>${t('sheet_wp')}:</b> ${esc(w.water_point_id)} — ${esc(w.name)}</div><div><b>${t('sheet_team')}:</b> ${line(8)}</div>
<div><b>${t('sheet_cluster')}:</b> ${esc(w.cluster)} · ${esc(w.fokontany)} · ${esc(w.village)}</div><div><b>${t('sheet_arrive')}:</b> ${line(4)} <b>${t('sheet_depart')}:</b> ${line(4)}</div>
<div><b>${t('sheet_gps')}:</b> ${isFinite(w.lat) ? fmt(w.lat, 5) + ', ' + fmt(w.lon, 5) : '—'}</div><div><b>${t('sheet_seed')}:</b> ${esc(p.seed)}</div></div>
${rep ? `<div class="rule big">${t('sheet_replacement')}</div>` : ''}
<h3>${t('sheet_poc')}</h3>
<span class="chk">${t('sheet_c1')} — ${t('sheet_time')} ${line(4)}</span>
<span class="chk">${t('sheet_c2')} ${line(8)} — ${t('sheet_time')} ${line(4)}</span>
<span class="chk">${t('sheet_c3')}</span>
<span class="chk">${t('sheet_c4')} ${line(6)}</span>
<h3>${t('sheet_hh')}</h3>
${h.mode === 'rule' ? `<div class="rule">${t('sheet_rule')}<br><span class="big">${t('sheet_k')} ${K ? K : line(4)}</span>${fn ? ` &nbsp; <b>${t('sheet_numbers')}: <span class="big">${fn.primary.join(' – ')}</span></b> &nbsp; ${t('sheet_rep_numbers')}: ${fn.replacements.join(', ')}` : ''}</div>` : ''}
<table><tr><th>${t('sheet_hh_col_n')}</th><th>${t('sheet_hh_col_id')}</th><th>${t('sheet_hh_col_name')}</th><th>${t('sheet_hh_col_sample')}</th><th>${t('sheet_hh_col_time')}</th><th>${t('sheet_hh_col_store')}</th><th>${t('sheet_hh_col_notes')}</th></tr>
${ids.map((x, i) => `<tr><td>${x[2] ? 'R' + (i - h.n + 1) : i + 1}</td><td>${esc(x[0])}&nbsp;</td><td>${esc(x[1])}&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td></tr>`).join('')}</table>
<div class="box"><b>${t('sheet_notes')}:</b></div>
<div><b>${t('sheet_sign')}:</b> ${line(14)}</div>
</div>`;
    };
    el.innerHTML = r.selected.map(w => sheet(w, false)).join('') + r.replacements.map(w => sheet(w, true)).join('');
  }

  /* ---------- map ---------- */
  function initMap() {
    if (state.map || typeof L === 'undefined') return;
    const m = state.map = L.map('map', { zoomControl: true }).setView([-25.03, 46.99], 9);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' }).addTo(m);
    state.layers = { clusters: L.layerGroup().addTo(m), axes: L.layerGroup().addTo(m), route: L.layerGroup().addTo(m), points: L.layerGroup().addTo(m), draw: L.layerGroup().addTo(m) };
    m.on('click', e => {
      if (state.drawing) { state.drawing.push([e.latlng.lat, e.latlng.lng]); drawPreview(); return; }
      if (state.pickStart) { state.pickStart = false; setStart({ lat: e.latlng.lat, lon: e.latlng.lng, label: t('route_start') }); }
    });
  }
  const numIcon = (txt, cls) => L.divIcon({ className: '', html: `<div class="num-icon ${cls || ''}">${txt}</div>`, iconSize: [28, 28], iconAnchor: [14, 14] });
  function renderMap() {
    if (!state.map) return; const Ly = state.layers; Object.values(Ly).forEach(l => l.clearLayers());
    const r = state.result; const bounds = [];
    state.axes.forEach(a => { Ly.axes.addLayer(L.polygon(a.coords, { color: '#e07b00', weight: 2, fillOpacity: .05 }).bindTooltip(a.name)); });
    if (state.drawing) drawPreview();
    if (!r) { $('map-msg').textContent = t('map_no_draw'); if (state.axes.length) state.map.fitBounds(L.featureGroup(Ly.axes.getLayers()).getBounds().pad(.2)); return; }
    const selNames = new Set(r.selectedClusters.map(c => c.name));
    if (r.params.clusterMode !== 'axis') r.clusters.forEach(c => { const hull = Core.convexHull(c.points); if (hull.length >= 3) Ly.clusters.addLayer(L.polygon(hull, { color: selNames.has(c.name) ? '#0b5e8a' : '#9aa3ad', weight: selNames.has(c.name) ? 2 : 1, dashArray: selNames.has(c.name) ? null : '4 4', fillOpacity: selNames.has(c.name) ? .06 : .02 }).bindTooltip(c.name + ' (' + c.size + ')')); });
    const om = orderMap();
    r.selected.forEach(w => { if (!isFinite(w.lat)) return; bounds.push([w.lat, w.lon]); Ly.points.addLayer(L.marker([w.lat, w.lon], { icon: numIcon(om[w.water_point_id] || w.order) }).bindPopup(`<b>${esc(w.water_point_id)}</b><br>${esc(w.name)}<br>${esc(w.cluster)} · ${esc(w.village)}`)); });
    r.replacements.forEach(w => { if (!isFinite(w.lat)) return; bounds.push([w.lat, w.lon]); Ly.points.addLayer(L.marker([w.lat, w.lon], { icon: numIcon('R' + w.order, 'rep') }).bindPopup(`<b>${esc(w.water_point_id)}</b> (${t('rep_wp')})<br>${esc(w.name)}<br>${esc(w.cluster)}`)); });
    if (state.start) { bounds.push([state.start.lat, state.start.lon]); Ly.points.addLayer(L.marker([state.start.lat, state.start.lon], { icon: numIcon('▶', 'start') }).bindTooltip(t('route_start'))); }
    if (state.route) { const pts = [[state.start.lat, state.start.lon]].concat(state.route.stops.map(s => [s.point.lat, s.point.lon])); Ly.route.addLayer(L.polyline(pts, { color: '#157347', weight: 3, opacity: .8 })); }
    if (bounds.length && !state.drawing) state.map.fitBounds(bounds, { padding: [30, 30] });
    $('map-msg').textContent = state.route ? '' : t('map_no_start');
    const sel = $('sel-start-wp'); sel.innerHTML = `<option value="">${t('map_start_wp')}</option>` + r.selected.map(w => `<option value="${esc(w.water_point_id)}">${esc(w.water_point_id)} — ${esc(w.name)}</option>`).join('');
  }
  function setStart(s) { state.start = s; LS.set('start', s); computeRoute(); renderResults(); renderSheet(); renderMap(); renderRoute(); }
  function computeRoute() { if (!state.result || !state.start) { state.route = null; return; } state.route = Core.nearestNeighbourRoute(state.start, state.result.selected); }
  function renderRoute() {
    const el = $('route-table'); if (!state.route) { el.innerHTML = `<p class="muted">${t('map_no_start')}</p>`; return; }
    el.innerHTML = `<table><tr><th>${t('col_stop')}</th><th>${t('col_id')}</th><th>${t('col_cluster')}</th><th>${t('col_leg')}</th><th>${t('col_cum')}</th></tr><tr><td>0</td><td>${esc(state.start.label || t('route_start'))} (${fmt(state.start.lat, 4)}, ${fmt(state.start.lon, 4)})</td><td></td><td></td><td>0</td></tr>` +
      state.route.stops.map((s, i) => `<tr><td>${i + 1}</td><td>${esc(s.point.water_point_id)}<br><small>${esc(s.point.name)}</small></td><td>${esc(s.point.cluster)}</td><td>${fmt(s.legKm)}</td><td>${fmt(s.cumKm)}</td></tr>`).join('') + `</table><p>${t('route_total', { km: fmt(state.route.totalKm) })}</p>`;
  }
  $('btn-start-click').onclick = () => { state.pickStart = true; state.drawing = null; $('map-msg').textContent = t('map_click_hint'); };
  $('btn-start-gps').onclick = () => { if (!navigator.geolocation) { $('map-msg').textContent = t('gps_err'); return; } navigator.geolocation.getCurrentPosition(pos => setStart({ lat: pos.coords.latitude, lon: pos.coords.longitude, label: 'GPS' }), () => { $('map-msg').textContent = t('gps_err'); }, { enableHighAccuracy: true, timeout: 15000 }); };
  $('sel-start-wp').onchange = e => { const w = state.result && state.result.selected.find(x => x.water_point_id === e.target.value); if (w) setStart({ lat: w.lat, lon: w.lon, label: w.water_point_id }); };
  $('btn-fit').onclick = () => renderMap();

  /* ---------- axis drawing ---------- */
  function drawPreview() { state.layers.draw.clearLayers(); const d = state.drawing || []; if (d.length) state.layers.draw.addLayer(L.polyline(d, { color: '#e07b00', dashArray: '6 4' })); d.forEach(v => state.layers.draw.addLayer(L.circleMarker(v, { radius: 5, color: '#e07b00' }))); $('map-msg').textContent = t('map_draw_hint', { n: d.length }); $('btn-axis-finish').disabled = d.length < 3; }
  $('btn-axis-draw').onclick = () => { initMap(); state.drawing = []; state.pickStart = false; $('btn-axis-cancel').disabled = false; drawPreview(); };
  $('btn-axis-cancel').onclick = () => { state.drawing = null; $('btn-axis-finish').disabled = true; $('btn-axis-cancel').disabled = true; renderMap(); };
  $('btn-axis-finish').onclick = () => {
    const name = (prompt(t('axis_name'), 'Axe ' + (state.axes.length + 1)) || '').trim(); if (!name) return;
    state.axes.push({ name, coords: state.drawing }); LS.set('axes', state.axes); state.drawing = null;
    $('btn-axis-finish').disabled = true; $('btn-axis-cancel').disabled = true; renderAxisList(); renderPreview(); renderMap();
  };
  function renderAxisList() {
    const el = $('axis-list'); if (!state.axes.length) { el.innerHTML = `<p class="muted">${t('axis_none')}</p>`; return; }
    const p = state.points.length ? readParams() : null;
    el.innerHTML = state.axes.map((a, i) => { const n = p ? state.points.filter(x => x.active && String(x.stratum) === String(p.stratum) && isFinite(x.lat) && Core.pointInPolygon(x, a.coords)).length : '?'; return `<div class="btnrow" style="align-items:center;margin:.3rem 0"><b style="flex:1">${esc(a.name)}</b><span class="muted">${a.coords.length} ${t('axis_vertices')} · ${n} ${t('axis_points')}</span><button class="btn small danger" data-del="${i}" type="button">${t('axis_delete')}</button></div>`; }).join('');
    el.querySelectorAll('button[data-del]').forEach(b => b.onclick = () => { state.axes.splice(+b.dataset.del, 1); LS.set('axes', state.axes); renderAxisList(); renderPreview(); renderMap(); });
  }
  $('btn-axis-export').onclick = () => download('sanitap-axes.json', JSON.stringify(state.axes, null, 2), 'application/json');
  $('file-axes').onchange = async e => { const f = e.target.files[0]; if (!f) return; try { const a = JSON.parse(await readFile(f)); if (Array.isArray(a)) { state.axes = a.filter(x => x && x.name && Array.isArray(x.coords)); LS.set('axes', state.axes); renderAxisList(); renderPreview(); renderMap(); } } catch (err) { alert(err.message); } e.target.value = ''; };

  /* ---------- offline / service worker ---------- */
  function onlineBadge() { $('offline-badge').textContent = navigator.onLine ? t('online') : '⚠ ' + t('offline'); }
  window.addEventListener('online', onlineBadge); window.addEventListener('offline', onlineBadge);
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(e => console.warn('SW', e));

  /* ---------- boot ---------- */
  applyWp(); applyHh(); applyLang(); onlineBadge(); renderMw(); setSource(LS.get('src', (state.wp && state.wp.source === 'csv') ? 'csv' : 'mwater'));
  const last = LS.get('last', null);
  if (last && state.points.length) {
    $('p-round').value = last.roundName; $('p-stratum').value = last.stratum; $('p-target').value = last.target; $('p-hh').value = last.hhPerPoint; $('p-cmode').value = last.clusterMode;
    $('p-nclusters').value = last.nClusters || ''; $('p-repfrac').value = Math.round(last.replacementFraction * 100); $('p-hhrep').value = last.hhReplacements; $('p-seed').value = last.seed; seedTouched = true;
    $('p-icc').value = last.icc; $('p-pass').value = last.expectedPass; $('p-conf').value = last.confidence; $('p-prectype').value = last.precisionType;
    runDraw(last, false); renderRoute();
  }
  renderPreview();
})();
