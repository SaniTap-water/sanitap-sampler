// v2.8.1: usage mode reads the fleet classification from this repo (same origin).
// The file is public, so it must hold water-point ids and classes only.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const C = require('../app.js');

const FILE = path.join(__dirname, '..', 'data', 'register_classification.json');
const COORD = /^(lat|lng|lon|long|latitude|longitude|location|locations|coord|coords|coordinates|geometry|geom|geojson|gps|position|positions|point|x|y|easting|northing)$/i;

function coordinateKeys(o, p = '$') {
  if (Array.isArray(o)) return o.flatMap((v, i) => coordinateKeys(v, `${p}[${i}]`));
  if (o && typeof o === 'object') return Object.entries(o).flatMap(([k, v]) => (COORD.test(k) ? [`${p}.${k}`] : []).concat(coordinateKeys(v, `${p}.${k}`)));
  return [];
}

test('fleetUrl is the same-origin copy, not the report site', () => {
  assert.strictEqual(C.USAGE.fleetUrl, './data/register_classification.json');
  assert.ok(fs.existsSync(FILE));
});

test('the fleet file holds no coordinate keys', () => {
  assert.deepStrictEqual(coordinateKeys(JSON.parse(fs.readFileSync(FILE, 'utf8'))), []);
});

test('the fleet file holds ids and classes only', () => {
  const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  assert.deepStrictEqual(Object.keys(j).sort(), ['checked', 'counts', 'group_records', 'note', 'records']);
  const ids = Object.keys(j.records);
  assert.ok(ids.length > 100);
  for (const id of ids) assert.match(id, /^\d+$/);
  const classes = new Set(Object.values(j.records));
  for (const c of classes) assert.ok(['in_fleet', 'joins', 'excluded', 'no_first_rehab', 'rehab_not_successful', 'review'].includes(c), c);
  for (const c of C.USAGE.fleetClasses) assert.ok(classes.has(c), 'fleet class present: ' + c);
  const raw = fs.readFileSync(FILE, 'utf8');
  assert.doesNotMatch(raw, /-(1[2-9]|2[0-6])\.\d{4,}/, 'no Madagascar-like latitude values');
});

test('the coordinate check catches nested location keys', () => {
  assert.deepStrictEqual(coordinateKeys({ records: { 1: 'in_fleet' }, a: [{ location: { type: 'Point' } }] }), ['$.a[0].location']);
});
