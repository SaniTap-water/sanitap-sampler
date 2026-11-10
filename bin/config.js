// Local settings for the filing scripts: sampler.local.json at the repo root (gitignored), or the file named by SAMPLER_CONFIG.
//   { "records_dir": "/mnt/c/Users/<you>/OneDrive - SaniTap/Central Data Hub - Water Documents/Evidence/Sampling records" }
// records_dir is the SharePoint evidence folder (synced). The public repo holds the app only; all evidence lives in SharePoint.
const fs = require('fs'); const path = require('path');
const ROOT = path.resolve(__dirname, '..');
function loadConfig() {
  const file = process.env.SAMPLER_CONFIG || path.join(ROOT, 'sampler.local.json');
  if (!fs.existsSync(file)) throw new Error('no ' + file + ': copy sampler.local.example.json to sampler.local.json and set records_dir to the SharePoint "Sampling records" folder');
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8')); const dir = cfg.records_dir && path.resolve(path.dirname(file), cfg.records_dir);
  if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error('records_dir in ' + file + ' is not an existing folder: ' + cfg.records_dir);
  const rel = path.relative(ROOT, dir); if (!rel.startsWith('..') && !path.isAbsolute(rel)) throw new Error('records_dir must be outside the repository (evidence never goes into git): ' + dir);
  return { file, recordsDir: dir };
}
const INDEX_HEAD = '# Sampling records\n\nAppend-only register of sampling rounds drawn with SaniTap Sampler. Each folder holds the sampling record (PDF, with the audit attached), the audit JSON, the selection CSV and, when filed, the selection Excel file.\n\n| Round | Stratum | Drawn (UTC) | Seed | Audit JSON SHA-256 | Frame SHA-256 | Files |\n|---|---|---|---|---|---|---|\n';
function appendIndex(recordsDir, row) { const idx = path.join(recordsDir, 'index.md'); if (!fs.existsSync(idx)) fs.writeFileSync(idx, INDEX_HEAD); fs.appendFileSync(idx, row); return idx; }
// v2.10.0: every audit.json under the records folder (originals and reissues), with its record id, survey and SHA-256, so that
// filing and reissue can refuse a record id that another sample already holds, whatever its survey
function filedRecords(recordsDir) {
  const crypto = require('crypto'); const out = [];
  const walk = d => { for (const n of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, n.name); if (n.isDirectory()) walk(f); else if (n.name === 'audit.json') { try { const text = fs.readFileSync(f, 'utf8'); const a = JSON.parse(text); out.push({ record_id: a.record_id, mode: a.mode || 'pou', audit_sha256: crypto.createHash('sha256').update(text, 'utf8').digest('hex'), where: path.relative(recordsDir, path.dirname(f)) || '.' }); } catch (e) { /* not an audit record */ } } } };
  if (recordsDir && fs.existsSync(recordsDir)) walk(recordsDir);
  return out;
}
module.exports = { loadConfig, appendIndex, filedRecords, ROOT };
