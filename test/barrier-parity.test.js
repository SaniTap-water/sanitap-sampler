// Barrier clip parity with the report's SDWS 1 people-served method of record (sdws1_population.py /
// sdws1_barrier_clip.py in ~/sdws1, since edition 5, 16 Sep 2026):
//   barriers  natural=coastline, waterway=river, waterway=canal; waterway=stream is not a barrier
//   crossings ways bridge=yes|viaduct|boardwalk, nodes or ways ford=yes|stepping_stones|boat; any other value
//             (bridge=no, aqueduct, culvert, ...) does not open a river
//   opening   a barrier is removed within 40 m of a crossing
//   fragment  only the part of the 1 km circle that contains the water point is kept
// Synthetic geometry only (a point on the equator-free open sea off nowhere); the expected areas are analytic.
// node --test test/*.test.js
const test = require('node:test'); const assert = require('node:assert/strict');
const C = require('../app.js'); const U = C.USAGE;

const WP = { lat: -20, lon: 47 }; const kx = 111320 * Math.cos(WP.lat * Math.PI / 180), ky = 110574;
const at = (x, y) => ({ lat: WP.lat + y / ky, lon: WP.lon + x / kx });           // metres east/north of the point
const way = (tags, xy) => ({ type: 'way', tags, geometry: xy.map(([x, y]) => at(x, y)) });
const node = (tags, x, y) => Object.assign({ type: 'node', tags }, at(x, y));
const kept = (els) => C.serviceAreaMask(WP, C.parseOverpass({ elements: els })).area_kept_pct;
// a straight river 500 m east of the point, running north-south right through the circle: the segment beyond it is
// R^2 acos(d/R) - d sqrt(R^2 - d^2) = 614,185 m2 of 3,141,593 m2, so 80.45 % of the circle is kept
const RIVER = [[500, -1500], [500, 1500]]; const CHORD_KEPT = 100 * (1 - (1e6 * Math.acos(0.5) - 500 * Math.sqrt(1e6 - 250000)) / (Math.PI * 1e6));

test('parity: the rule constants are the report\'s', () => {
  assert.deepEqual(U.barrierKinds.slice().sort(), ['canal', 'coastline', 'river']);
  assert.deepEqual(U.bridgeValues, ['yes', 'viaduct', 'boardwalk']);
  assert.deepEqual(U.fordValues, ['yes', 'stepping_stones', 'boat']);
  assert.equal(U.crossingM, 40); assert.equal(U.radiusM, 1000);
  const q = C.overpassQuery(WP.lat, WP.lon);
  assert.match(q, /way\["waterway"~"\^\(river\|canal\)\$"\]/); assert.match(q, /way\["natural"="coastline"\]/);
  assert.match(q, /way\["bridge"~"\^\(yes\|viaduct\|boardwalk\)\$"\]/);
  assert.match(q, /way\["ford"~"\^\(yes\|stepping_stones\|boat\)\$"\]/); assert.match(q, /node\["ford"~"\^\(yes\|stepping_stones\|boat\)\$"\]/);
  assert.doesNotMatch(q, /stream/);
});

test('parity: river, canal and coastline cut; the fragment with the water point is kept', () => {
  for (const tags of [{ waterway: 'river' }, { waterway: 'canal' }, { natural: 'coastline' }]) {
    const k = kept([way(tags, RIVER)]);
    assert.ok(Math.abs(k - CHORD_KEPT) < 0.6, JSON.stringify(tags) + ' kept ' + k + ' expected ' + CHORD_KEPT.toFixed(2));
  }
  // the point on the other side keeps the other fragment: a river 500 m WEST keeps the same share
  assert.ok(Math.abs(kept([way({ waterway: 'river' }, [[-500, -1500], [-500, 1500]])]) - CHORD_KEPT) < 0.6);
  // a river whose ends lie exactly on the circle still cuts it. The report's shapely split does not: its lines are
  // clipped to the circle and their ends miss the circle's boundary by rounding, so split() returns the whole circle
  // (found 30 Sep 2026; see README "Barrier clip parity")
  const h = Math.sqrt(1e6 - 250000);
  assert.ok(Math.abs(kept([way({ waterway: 'river' }, [[500, -h], [500, h]])]) - CHORD_KEPT) < 0.6);
  // the river drawn as several ways that meet end to end still cuts (the report unions the lines)
  assert.ok(Math.abs(kept([way({ waterway: 'river' }, [[500, -1500], [500, -200]]), way({ waterway: 'river' }, [[500, -200], [500, 300]]), way({ waterway: 'river' }, [[500, 300], [500, 1500]])]) - CHORD_KEPT) < 0.6);
});

test('parity: streams, and rivers that stop inside the circle, do not cut', () => {
  assert.equal(kept([way({ waterway: 'stream' }, RIVER)]), 100);
  assert.equal(kept([way({ waterway: 'river' }, [[500, -1500], [500, 600]])]), 100);   // ends inside: no fragment is cut off
  assert.equal(kept([]), 100);
});

test('parity: a bridge or ford within 40 m opens the river; other values and farther crossings do not', () => {
  const bridge = (v, dx) => way({ highway: 'track', bridge: v }, [[500 - 15 + dx, 0], [500 + 15 + dx, 0]]);
  for (const v of ['yes', 'viaduct', 'boardwalk']) assert.equal(kept([way({ waterway: 'river' }, RIVER), bridge(v, 0)]), 100, 'bridge=' + v);
  for (const v of ['no', 'aqueduct', 'culvert', 'covered']) assert.ok(Math.abs(kept([way({ waterway: 'river' }, RIVER), bridge(v, 0)]) - CHORD_KEPT) < 0.6, 'bridge=' + v + ' must not open');
  for (const v of ['yes', 'stepping_stones', 'boat']) assert.equal(kept([way({ waterway: 'river' }, RIVER), node({ ford: v }, 500, 0)]), 100, 'ford=' + v);
  assert.ok(Math.abs(kept([way({ waterway: 'river' }, RIVER), node({ ford: 'no' }, 500, 0)]) - CHORD_KEPT) < 0.6, 'ford=no must not open');
  assert.equal(kept([way({ waterway: 'river' }, RIVER), node({ ford: 'yes' }, 535, 0)]), 100, 'a ford 35 m off the river opens it');
  assert.ok(Math.abs(kept([way({ waterway: 'river' }, RIVER), node({ ford: 'yes' }, 550, 0)]) - CHORD_KEPT) < 0.6, 'a ford 50 m off the river does not');
  // a bridge opens only the river it crosses: a second, unbridged river still cuts
  assert.ok(Math.abs(kept([way({ waterway: 'river' }, RIVER), bridge('yes', 0), way({ waterway: 'river' }, [[-500, -1500], [-500, 1500]])]) - CHORD_KEPT) < 0.6);
});

test('parity: the published parameters describe the same rule', () => {
  const r = C.drawUsage({ roundName: 'T', stratum: 'HP-FD', seed: 'T-HP-FD-U', timestamp: '2026-09-30T00:00:00.000Z', drawnBy: 'Test', frameHash: 'ab'.repeat(32) },
    [{ water_point_id: '1', commune: 'A', fokontany: 'F', lat: -20, lon: 47, name: 'x' }]);
  const b = r.audit.parameters.barriers;
  assert.match(b, /bridge=yes\|viaduct\|boardwalk/); assert.match(b, /ford=yes\|stepping_stones\|boat/); assert.match(b, /40 m/); assert.match(b, /containing the water point/);
});
