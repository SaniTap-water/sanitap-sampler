// Writes test/fixtures/sdws18-baseline.json: the SDWS 18 (point-of-use) draws of the current code for fixed
// frames and seeds, so that later changes can be proved not to move them (test/sdws18-regression.test.js).
// Run ONLY to re-baseline on purpose:   node test/make-sdws18-baseline.js   (PDFLIB_DIR for the PDF hashes)
const fs = require('fs'); const path = require('path'); const C = require('../app.js');
(async () => {
  const K = require('./sdws18-cases.js'); const out = K.run(C);
  let PDFLib = null; try { PDFLib = require(path.join(process.env.PDFLIB_DIR || '/nonexistent', 'node_modules', 'pdf-lib')); } catch (e) { PDFLib = null; }
  if (PDFLib) out.pdf = await K.pdfs(C, PDFLib);
  fs.writeFileSync(path.join(__dirname, 'fixtures', 'sdws18-baseline.json'), JSON.stringify(out, null, 1) + '\n');
  console.log('baseline written:', Object.keys(out.draws).length, 'draws', out.pdf ? Object.keys(out.pdf).length + ' pdf hashes' : 'no pdf');
})();
