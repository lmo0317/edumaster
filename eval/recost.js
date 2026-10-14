#!/usr/bin/env node
'use strict';
// Re-prices evaluation reports from their runs' usage ledgers with the current server/cost.js (a report written before
// a provider had a price, e.g. the Claude subscription before 2026-10-07, records $0).
//   node eval/recost.js [report.json ...]     (default: every report in eval/reports whose cost is $0)
const fs = require('fs');
const path = require('path');
const { runCost } = require('../server/cost');

const REPORTS = path.join(__dirname, 'reports');
const WORK = path.join(__dirname, '.work');
// --work <dir> (repeatable): other eval copies' work dirs to look for a report's run in (e.g. ~/edumaster-eval-qwen).
const argv = process.argv.slice(2);
const WORKS = argv.flatMap((a, i) => (argv[i - 1] === '--work' ? [a] : []));
const named = argv.filter((a, i) => a !== '--work' && argv[i - 1] !== '--work');
const files = named.length ? named : fs.readdirSync(REPORTS).filter((f) => f.endsWith('.json')).map((f) => path.join(REPORTS, f));
const read = (dir, sub) => (fs.existsSync(path.join(dir, sub)) ? fs.readdirSync(path.join(dir, sub)).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(dir, sub, f), 'utf8'))) : []);

for (const file of files) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const rows = Array.isArray(raw) ? raw : raw.results || [];
  if (!rows.some((r) => r.cost && r.cost.usd === 0 && r.jobId) && !named.length) continue;
  // The run's copy of the data is named by the report's stamp (in this checkout's eval/.work, or a copy's: --work).
  const dir = [WORK, ...WORKS].map((w) => path.join(w, path.basename(file).split('-')[0])).find((d) => fs.existsSync(d)) || path.join(WORK, path.basename(file).split('-')[0]);
  if (!fs.existsSync(dir)) { console.log(`${path.basename(file)}: no work dir, skipped`); continue; }
  const usage = read(dir, 'usage');
  const jobs = read(dir, 'jobs');
  let changed = false;
  for (const r of rows) {
    if (!r.jobId) continue;
    const gen = jobs.find((j) => j.id === r.jobId);
    // The analysis that made the material the generation used, as the run priced it.
    const ids = [r.jobId, ...jobs.filter((j) => j.type === 'analyze' && gen && j.materialId === gen.materialId).map((j) => j.id)];
    const cost = runCost(usage, ids, { job: gen || null });
    if (cost.usd !== r.cost?.usd || (cost.byStage && !r.cost?.byStage) || (cost.byPart && !r.cost?.byPart)) { console.log(`${path.basename(file)} ${r.case} ${r.provider}${r.claudeMix ? ' (mix)' : ''}: $${r.cost?.usd} → $${cost.usd}`); r.cost = cost; changed = true; }
  }
  if (changed) fs.writeFileSync(file, JSON.stringify(raw, null, 1));
}
