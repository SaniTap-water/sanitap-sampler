// v2.14.0: field request 25 Nov 2026, the field-pack .json in Chrome's downloads could not be sent with WhatsApp or Xender.
// "Share field pack" hands the same content to Android's share sheet as a .txt file (Chrome shares text/plain, not
// application/json); the Data tab opens the .txt like the .json. Node tests with a stand-in navigator and File.
const test = require('node:test'); const assert = require('node:assert/strict'); const fs = require('fs'); const path = require('path');
const C = require('../app.js');
class FakeFile { constructor(parts, name, opts) { this.parts = parts; this.name = name; this.type = (opts || {}).type; } }
const PACK = JSON.stringify({ kind: C.FIELD_PACK_KIND, version: 1, record_id: 'R-HP-MA-U' });

test('share: .json name becomes .txt, other names get .txt appended', () => {
  assert.equal(C.packShareName('sanitap-2026_R1_Maro-HP-MA-field-pack.json'), 'sanitap-2026_R1_Maro-HP-MA-field-pack.txt');
  assert.equal(C.packShareName('pack.JSON'), 'pack.txt');
  assert.equal(C.packShareName('pack'), 'pack.txt');
});

test('share: a share-capable browser gets one text/plain .txt file with the pack content', async () => {
  let shared = null; const nav = { canShare: o => o.files.every(f => f.type === 'text/plain'), share: async o => { shared = o; } };
  assert.equal(await C.shareTextFile(nav, FakeFile, 'x-field-pack.json', PACK, 'Partager'), 'shared');
  assert.equal(shared.files.length, 1); assert.equal(shared.files[0].name, 'x-field-pack.txt'); assert.equal(shared.files[0].type, 'text/plain');
  assert.equal(shared.files[0].parts.join(''), PACK); assert.equal(shared.title, 'Partager');
  assert.ok(C.isFieldPackText(shared.files[0].parts.join('')), 'the shared .txt is still recognised as a field pack on the Data tab');
});

test('share: no Web Share, or files refused, reports unsupported (the app then saves the .txt instead)', async () => {
  assert.equal(await C.shareTextFile({}, FakeFile, 'a.json', PACK), 'unsupported');
  assert.equal(await C.shareTextFile({ canShare: () => false, share: async () => { throw new Error('must not be called'); } }, FakeFile, 'a.json', PACK), 'unsupported');
  assert.equal(await C.shareTextFile({ canShare: () => { throw new TypeError('x'); }, share: async () => {} }, FakeFile, 'a.json', PACK), 'unsupported');
  assert.equal(await C.shareTextFile({ canShare: () => true, share: async () => {} }, null, 'a.json', PACK), 'unsupported');
});

test('share: closing the share sheet is not an error; other failures are reported', async () => {
  const abort = Object.assign(new Error('cancel'), { name: 'AbortError' });
  assert.equal(await C.shareTextFile({ canShare: () => true, share: async () => { throw abort; } }, FakeFile, 'a.json', PACK), 'cancelled');
  await assert.rejects(C.shareTextFile({ canShare: () => true, share: async () => { throw new Error('NotAllowedError'); } }, FakeFile, 'a.json', PACK), /NotAllowedError/);
});

test('share: the open dialog accepts .txt, and the Field tab has the share button in both languages', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(html, /id="open-file" accept="[^"]*\.txt[^"]*text\/plain/);
  assert.match(html, /id="btn-fpack-share"/);
  const I = C.I18N; assert.ok(I.en.btn_fpack_share && I.fr.btn_fpack_share && I.fr.fpack_shared && I.fr.fpack_share_unsupported);
});
