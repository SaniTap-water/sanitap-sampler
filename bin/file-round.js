#!/usr/bin/env node
/* File a sampling round: verify the exported record (PDF + audit JSON + selection CSV), copy it to records/<round>/<stratum>/,
 * append records/index.md, commit and push. Append-only: an existing record folder is never overwritten (except round "test").
 * Usage: node bin/file-round.js [--pdf f] [--json f] [--csv f] [--frame f] [--store-frame] [--round NAME] [--no-push] [--dry-run]
 * --frame verifies the frame CSV against the audit hash; it is only copied into the public record with --store-frame (it holds real coordinates).
 * Without paths the newest sanitap-*-record.pdf / -audit.json / -selection.csv in ~/Downloads are used. */
'use strict';
const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto'), { execSync } = require('child_process');
const ROOT = path.resolve(__dirname, '..');
const args = {}; for (let i = 2; i < process.argv.length; i++) { const a = process.argv[i]; if (a.startsWith('--')) { const k = a.slice(2); if (['no-push', 'dry-run', 'store-frame'].includes(k)) args[k] = true; else args[k] = process.argv[++i]; } }
const sha = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const newest = suffix => { const dir = path.join(os.homedir(), 'Downloads'); if (!fs.existsSync(dir)) return null; const c = fs.readdirSync(dir).filter(n => /^sanitap-.*-/.test(n) && n.endsWith(suffix)).map(n => path.join(dir, n)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs); return c[0] || null; };
const fail = m => { console.error('ERROR: ' + m); process.exit(1); };
const pdfPath = args.pdf || newest('-record.pdf'), jsonPath = args.json || newest('-audit.json'), csvPath = args.csv || newest('-selection.csv');
if (!pdfPath || !jsonPath || !csvPath) fail('need the PDF, audit JSON and selection CSV (give --pdf/--json/--csv or put the exports in ~/Downloads)');
[pdfPath, jsonPath, csvPath].forEach(f => { if (!fs.existsSync(f)) fail('missing ' + f); });
const audit = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
const pdf = fs.readFileSync(pdfPath, 'latin1');
const auditSha = sha(jsonPath);
const m = /\/AuditSHA256 \(([0-9a-f]{64})\)/.exec(pdf); const rid = /\/RecordId \(([^)]+)\)/.exec(pdf);
if (!m) fail('the PDF carries no /AuditSHA256 entry: not a SaniTap Sampler record');
if (m[1] !== auditSha) fail('audit JSON SHA-256 ' + auditSha + ' does not match the PDF footer ' + m[1] + ' — export the PDF and JSON together with "Export sampling record"');
if (!rid || rid[1] !== audit.record_id) fail('record id mismatch between PDF (' + (rid && rid[1]) + ') and audit JSON (' + audit.record_id + ')');
const round = String(args.round || audit.parameters.round || '').replace(/\s+/g, ''); const stratum = String(audit.parameters.stratum || '');
if (!/^[A-Za-z0-9_.-]+$/.test(round) || !/^[A-Za-z0-9_.-]+$/.test(stratum)) fail('round/stratum must be plain names: ' + round + ' / ' + stratum);
const dir = path.join(ROOT, 'records', round, stratum);
if (fs.existsSync(dir) && round !== 'test') fail('record folder already exists: records/' + round + '/' + stratum + ' — records are append-only; a re-draw gets a new seed and a new round name');
const frameSha = audit.input && audit.input.water_points_sha256; const framePath = args.frame || null;
if (framePath) { if (!fs.existsSync(framePath)) fail('missing frame file ' + framePath); if (sha(framePath) !== frameSha) fail('frame file SHA-256 does not match the audit record (' + frameSha + ')'); }
const storeFrame = !!(framePath && args['store-frame']);
const files = [[pdfPath, 'sampling-record.pdf'], [jsonPath, 'audit.json'], [csvPath, 'selection.csv']].concat(storeFrame ? [[framePath, 'frame.csv']] : []);
console.log('Record ' + audit.record_id + ' -> records/' + round + '/' + stratum + '/'); console.log('  audit JSON SHA-256 ' + auditSha + ' (matches PDF)'); console.log('  frame SHA-256 ' + frameSha + (framePath ? ' (frame file verified' + (storeFrame ? ', stored)' : ', not stored: keep it in the private archive)') : ' (frame file not supplied)'));
if (args['dry-run']) { console.log('dry run: nothing written'); process.exit(0); }
fs.mkdirSync(dir, { recursive: true }); files.forEach(([src, name]) => fs.copyFileSync(src, path.join(dir, name)));
const url = 'https://sanitap-water.github.io/sanitap-sampler/records/' + round + '/' + stratum + '/';
const idx = path.join(ROOT, 'records', 'index.md');
if (!fs.existsSync(idx)) fs.writeFileSync(idx, '# Sampling records\n\nAppend-only register of sampling rounds drawn with SaniTap Sampler. Each folder holds the VVB-facing sampling record (PDF), the audit JSON, the selection CSV and, when filed, the frame CSV.\n\n| Round | Stratum | Drawn (UTC) | Seed | Audit JSON SHA-256 | Frame SHA-256 | Files |\n|---|---|---|---|---|---|---|\n');
fs.appendFileSync(idx, `| ${round} | ${stratum} | ${audit.timestamp} | \`${audit.seed}\` | \`${auditSha}\` | \`${frameSha || ''}\` | [PDF](${round}/${stratum}/sampling-record.pdf) · [audit](${round}/${stratum}/audit.json) · [CSV](${round}/${stratum}/selection.csv)${storeFrame ? ' · [frame](' + round + '/' + stratum + '/frame.csv)' : ''} |\n`);
const git = c => execSync('git ' + c, { cwd: ROOT, stdio: 'pipe' }).toString().trim();
git('add records'); git(`commit -q -m "Record ${audit.record_id}: file sampling round ${round} ${stratum}"`);
console.log('  committed ' + git('rev-parse --short HEAD'));
if (!args['no-push']) { git('push -q origin HEAD'); console.log('  pushed; served at ' + url + ' after the Pages deploy'); } else console.log('  not pushed (--no-push); URL will be ' + url);
