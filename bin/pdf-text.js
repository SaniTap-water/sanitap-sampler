// Text runs of a SaniTap Sampler PDF (pdf-lib writes each line as one hex Tj run). Used by tests and bin/reissue-record.js.
const zlib = require('zlib');
function pdfTextRuns(raw) {
  const b = raw.toString('latin1'); const runs = []; const re = /stream\r?\n/g; let m;
  while ((m = re.exec(b))) {
    const end = b.indexOf('endstream', m.index); let chunk = raw.subarray(m.index + m[0].length, end);
    try { chunk = zlib.inflateSync(chunk); } catch (e) { }
    (chunk.toString('latin1').match(/<([0-9A-Fa-f]+)> Tj/g) || []).forEach(h => runs.push(Buffer.from(h.slice(1, -4), 'hex').toString('latin1')));
  }
  return runs;
}
module.exports = { pdfTextRuns };
