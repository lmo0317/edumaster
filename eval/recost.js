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
const files = process.argv.slice(2).length ? process.argv.slice(2) : fs.readdirSync(REPORTS).filter((f) => f.endsWith('.json')).map((f) => path.join(REPORTS, f));
const read = (dir, sub) => (fs.existsSync(path.join(dir, sub)) ? fs.readdirSync(path.join(dir, sub)).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(dir, sub, f), 'utf8'))) : []);

for (const file of files) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const rows = Array.isArray(raw) ? raw : raw.results || [];
  if (!rows.some((r) => r.cost && r.cost.usd === 0 && r.jobId) && process.argv.length <= 2) continue;
  // The run's copy of the data is named by the report's stamp.
  const dir = path.join(WORK, path.basename(file).split('-')[0]);
  if (!fs.existsSync(dir)) { console.log(`${path.basename(file)}: no work dir, skipped`); continue; }
  const usage = read(dir, 'usage');
  const jobs = read(dir, 'jobs');
  let changed = false;
  for (const r of rows) {
    if (!r.jobId) continue;
    const gen = jobs.find((j) => j.id === r.jobId);
    // The analysis that made the material the generation used, as the run priced it.
    const ids = [r.jobId, ...jobs.filter((j) => j.type === 'analyze' && gen && j.materialId === gen.materialId).map((j) => j.id)];
    const cost = runCost(usage, ids);
    if (cost.usd !== r.cost?.usd) { console.log(`${path.basename(file)} ${r.case} ${r.provider}${r.claudeMix ? ' (mix)' : ''}: $${r.cost?.usd} → $${cost.usd}`); r.cost = cost; changed = true; }
  }
  if (changed) fs.writeFileSync(file, JSON.stringify(raw, null, 1));
}
