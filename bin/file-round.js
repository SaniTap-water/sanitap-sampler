#!/usr/bin/env node
/* File a sampling round: verify the sampling record PDF (it carries the audit record as an attached audit.json), copy it with the
 * selection Excel file and a selection CSV to records/<round>/<stratum>/, append records/index.md, commit and push.
 * Append-only: an existing record folder is never overwritten (except round "test").
 * Usage: node bin/file-round.js [--pdf f] [--xlsx f] [--frame f] [--round NAME] [--no-push] [--dry-run]
 * Without paths the newest sanitap-*-record.pdf (and -selection.xlsx) in ~/Downloads are used. --frame verifies the frame CSV hash; it is never published. */
'use strict';
const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto'), zlib = require('zlib'), { execSync } = require('child_process');
const ROOT = path.resolve(__dirname, '..');
const C = require(path.join(ROOT, 'app.js'));
const sha = buf => crypto.createHash('sha256').update(buf).digest('hex');

// Extract the attached audit.json from a SaniTap Sampler record PDF (pdf-lib embedded file, Flate-compressed)
function extractAudit(pdfBuf) {
  const txt = pdfBuf.toString('latin1');
  const re = /\/Type \/EmbeddedFile/g; let m;
  while ((m = re.exec(txt))) {
    const sm = /stream\r?\n/g; sm.lastIndex = m.index; const sh = sm.exec(txt); if (!sh) continue;
    const start = sh.index + sh[0].length; const end = txt.indexOf('endstream', start); if (end < 0) continue;
    let chunk = pdfBuf.subarray(start, end); if (chunk[chunk.length - 1] === 0x0a) chunk = chunk.subarray(0, chunk.length - 1); if (chunk[chunk.length - 1] === 0x0d) chunk = chunk.subarray(0, chunk.length - 1);
    let out = null; try { out = zlib.inflateSync(chunk); } catch (e) { out = chunk; }
    const s = out.toString('utf8'); if (s.trim().startsWith('{') && s.includes('"record_id"')) return s;
  }
  return null;
}
function infoValue(pdfTxt, key) { const m = new RegExp('\\/' + key + ' \\(([^)]*)\\)').exec(pdfTxt); return m ? m[1] : null; }
module.exports = { extractAudit, infoValue };
if (require.main === module) {
  const args = {}; for (let i = 2; i < process.argv.length; i++) { const a = process.argv[i]; if (a.startsWith('--')) { const k = a.slice(2); if (['no-push', 'dry-run'].includes(k)) args[k] = true; else args[k] = process.argv[++i]; } }
  const newest = suffix => { const dir = path.join(os.homedir(), 'Downloads'); if (!fs.existsSync(dir)) return null; const c = fs.readdirSync(dir).filter(n => /^sanitap-.*-/.test(n) && n.endsWith(suffix)).map(n => path.join(dir, n)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs); return c[0] || null; };
  const fail = m => { console.error('ERROR: ' + m); process.exit(1); };
  const pdfPath = args.pdf || newest('-record.pdf'); const xlsxPath = args.xlsx || newest('-selection.xlsx');
  if (!pdfPath || !fs.existsSync(pdfPath)) fail('need the sampling record PDF (give --pdf or put the export in ~/Downloads)');
  const pdfBuf = fs.readFileSync(pdfPath); const pdfTxt = pdfBuf.toString('latin1');
  const auditText = extractAudit(pdfBuf); if (!auditText) fail('no attached audit.json found in the PDF: not a SaniTap Sampler record (v2.1 or later)');
  const audit = JSON.parse(auditText); const auditSha = sha(Buffer.from(auditText, 'utf8'));
  const footerSha = infoValue(pdfTxt, 'AuditSHA256'), rid = infoValue(pdfTxt, 'RecordId');
  if (footerSha !== auditSha) fail('the attached audit (SHA-256 ' + auditSha + ') does not match the PDF footer (' + footerSha + ')');
  if (rid !== audit.record_id) fail('record id mismatch between PDF (' + rid + ') and audit (' + audit.record_id + ')');
  if (C.hasCoordinateKeys(audit)) fail('the audit contains coordinate fields; records must not carry coordinates');
  const round = String(args.round || audit.parameters.round || '').replace(/\s+/g, ''); const stratum = String(audit.parameters.stratum || '');
  if (!/^[A-Za-z0-9_.-]+$/.test(round) || !/^[A-Za-z0-9_.-]+$/.test(stratum)) fail('round/stratum must be plain names: ' + round + ' / ' + stratum);
  const dir = path.join(ROOT, 'records', round, stratum);
  if (fs.existsSync(dir) && round !== 'test') fail('record folder already exists: records/' + round + '/' + stratum + ' — records are append-only; a re-draw gets a new seed and a new round name');
  const frameSha = audit.input && audit.input.water_points_sha256; const framePath = args.frame || null;
  if (framePath) { if (!fs.existsSync(framePath)) fail('missing frame file ' + framePath); if (sha(fs.readFileSync(framePath)) !== frameSha) fail('frame file SHA-256 does not match the audit record (' + frameSha + ')'); }
  const csv = C.auditToCsv(audit);
  const hasXlsx = xlsxPath && fs.existsSync(xlsxPath);
  console.log('Record ' + audit.record_id + ' -> records/' + round + '/' + stratum + '/'); console.log('  audit SHA-256 ' + auditSha + ' (attached in the PDF, matches the footer)'); console.log('  frame SHA-256 ' + frameSha + (framePath ? ' (frame file verified, not published)' : ' (frame file not supplied)')); console.log('  Excel file: ' + (hasXlsx ? xlsxPath : 'none'));
  if (args['dry-run']) { console.log('dry run: nothing written'); process.exit(0); }
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(pdfPath, path.join(dir, 'sampling-record.pdf')); if (hasXlsx) fs.copyFileSync(xlsxPath, path.join(dir, 'selection.xlsx')); fs.writeFileSync(path.join(dir, 'selection.csv'), csv); fs.writeFileSync(path.join(dir, 'audit.json'), auditText);
  const url = 'https://sanitap-water.github.io/sanitap-sampler/records/' + round + '/' + stratum + '/';
  const idx = path.join(ROOT, 'records', 'index.md');
  if (!fs.existsSync(idx)) fs.writeFileSync(idx, '# Sampling records\n\nAppend-only register of sampling rounds drawn with SaniTap Sampler. Each folder holds the sampling record (PDF, with the audit attached), the selection as Excel and CSV.\n\n| Round | Stratum | Drawn (UTC) | Seed | Audit SHA-256 | Frame SHA-256 | Files |\n|---|---|---|---|---|---|---|\n');
  fs.appendFileSync(idx, `| ${round} | ${stratum} | ${audit.timestamp} | \`${audit.seed}\` | \`${auditSha}\` | \`${frameSha || ''}\` | [PDF](${round}/${stratum}/sampling-record.pdf)${hasXlsx ? ' · [Excel](' + round + '/' + stratum + '/selection.xlsx)' : ''} · [CSV](${round}/${stratum}/selection.csv) |\n`);
  const git = c => execSync('git ' + c, { cwd: ROOT, stdio: 'pipe' }).toString().trim();
  git('add records'); git(`commit -q -m "Record ${audit.record_id}: file sampling round ${round} ${stratum}"`);
  console.log('  committed ' + git('rev-parse --short HEAD'));
  if (!args['no-push']) { git('push -q origin HEAD'); console.log('  pushed; served at ' + url + ' after the Pages deploy'); } else console.log('  not pushed (--no-push); URL will be ' + url);
}
