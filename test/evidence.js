// The filed records live in the SharePoint evidence folder (sampler.local.json, gitignored), not in the repo.
// Tests that read the filed 2026R1 records use it when it is configured on this machine and skip (saying so) when not.
const path = require('path');
let dir = null, why = '';
try { dir = require('../bin/config.js').loadConfig().recordsDir; } catch (e) { why = e.message; }
const REC = s => path.join(dir, '2026R1', s);
const skipNoEvidence = () => console.log('  (no SharePoint evidence folder configured: ' + why + ') — skipped');
module.exports = { EVIDENCE: dir, REC, skipNoEvidence };
