#!/usr/bin/env node
/* File a sampling round: verify the sampling record PDF (it carries the audit record as an attached audit.json), copy it with the
 * selection Excel file and a selection CSV to <records_dir>/<round>/<stratum>/ and append <records_dir>/index.md.
 * <records_dir> is the SharePoint evidence folder named in sampler.local.json (gitignored; see bin/config.js). Nothing is
 * committed or pushed: the public repo holds the app only; all evidence lives in SharePoint.
 * Append-only: an existing record folder is never overwritten (except round "test").
 * SDWS 18 records go to <round>/<stratum>/, usage-survey (SDWS 26) records (seed suffix -U) to <round>/<scenario>-U/.
 * Usage: node bin/file-round.js [--pdf f] [--xlsx f] [--frame f] [--round NAME] [--dry-run]
 * Without paths the newest sanitap-*-record.pdf (and -selection.xlsx) in ~/Downloads are used. --frame verifies the frame CSV hash; it is never published. */
'use strict';
const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto'), zlib = require('zlib');
const { loadConfig, appendIndex } = require('./config.js');
const ROOT = path.resolve(__dirname, '..');
const C = require(path.join(ROOT, 'app.js'));
const sha = buf => crypto.createHash('sha256').update(buf).digest('hex');

// The attached audit.json of a SaniTap Sampler record PDF: the same code the app uses to open a confirmed round (Core.extractAudit), inflated with zlib here
const extractAudit = pdfBuf => C.extractAudit(pdfBuf, zlib.inflateSync);
const infoValue = (pdfTxt, key) => C.pdfInfoValue(pdfTxt, key);
module.exports = { extractAudit, infoValue };
if (require.main === module) {
  const args = {}; for (let i = 2; i < process.argv.length; i++) { const a = process.argv[i]; if (a.startsWith('--')) { const k = a.slice(2); if (['dry-run'].includes(k)) args[k] = true; else args[k] = process.argv[++i]; } }
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
  const usage = C.recordMode(audit) === 'usage';
  if (usage && !/-U$/.test(String(audit.seed || ''))) fail('a usage-survey record must have a seed ending in -U: ' + audit.seed);
  if (!usage && /-U$/.test(String(audit.seed || ''))) fail('seed ' + audit.seed + ' ends in -U but the record is not a usage-survey record');
  const round = String(args.round || audit.parameters.round || '').replace(/\s+/g, ''); const stratum = usage ? String(audit.parameters.scenario || '') + '-U' : String(audit.parameters.stratum || '');
  if (!/^[A-Za-z0-9_.-]+$/.test(round) || !/^[A-Za-z0-9_.-]+$/.test(stratum)) fail('round/stratum must be plain names: ' + round + ' / ' + stratum);
  let cfg; try { cfg = loadConfig(); } catch (e) { fail(e.message); }
  const RD = cfg.recordsDir; const dir = path.join(RD, round, stratum);
  if (fs.existsSync(dir) && round !== 'test') fail('record folder already exists: ' + round + '/' + stratum + ' in ' + RD + ' — records are append-only; a re-draw gets a new seed and a new round name');
  const frameSha = audit.input && (usage ? audit.input.frame_sha256 : audit.input.water_points_sha256); const framePath = args.frame || null;
  if (framePath) { if (!fs.existsSync(framePath)) fail('missing frame file ' + framePath); if (sha(fs.readFileSync(framePath)) !== frameSha) fail('frame file SHA-256 does not match the audit record (' + frameSha + ')'); }
  const csv = C.recordCsv(audit);
  const hasXlsx = xlsxPath && fs.existsSync(xlsxPath);
  console.log((usage ? 'Usage-survey (SDWS 26) record ' : 'Record ') + audit.record_id + ' -> ' + round + '/' + stratum + '/ in ' + RD); console.log('  audit SHA-256 ' + auditSha + ' (attached in the PDF, matches the footer)'); console.log('  frame SHA-256 ' + frameSha + (framePath ? ' (frame file verified, not published)' : ' (frame file not supplied)')); console.log('  Excel file: ' + (hasXlsx ? xlsxPath : 'none'));
  if (args['dry-run']) { console.log('dry run: nothing written'); process.exit(0); }
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(pdfPath, path.join(dir, 'sampling-record.pdf')); if (hasXlsx) fs.copyFileSync(xlsxPath, path.join(dir, 'selection.xlsx')); fs.writeFileSync(path.join(dir, 'selection.csv'), csv); fs.writeFileSync(path.join(dir, 'audit.json'), auditText);
  appendIndex(RD, `| ${round} | ${stratum} | ${audit.timestamp} | \`${audit.seed}\` | \`${auditSha}\` | \`${frameSha || ''}\` | [PDF](${round}/${stratum}/sampling-record.pdf) · [audit](${round}/${stratum}/audit.json)${hasXlsx ? ' · [Excel](' + round + '/' + stratum + '/selection.xlsx)' : ''} · [CSV](${round}/${stratum}/selection.csv) |\n`);
  console.log('  filed in ' + dir + ' and added to index.md (nothing committed: evidence stays in SharePoint)');
}
