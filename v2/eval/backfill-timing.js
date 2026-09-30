'use strict';
// Adds `timing` (minutes for reading the original, making the set, and each problem) to reports written before
// the runner recorded it, from the jobs kept in eval/.work/<stamp>/jobs.
//   node eval/backfill-timing.js [--jobs <extra jobs dir>]...   (e.g. the folder of a run made elsewhere)
const fs = require('node:fs');
const path = require('node:path');
const { jobTiming } = require('../server/scoring');

const extra = process.argv.flatMap((a, i, all) => (a === '--jobs' ? [all[i + 1]] : []));
const reportsDir = path.join(__dirname, 'reports');
const readJobs = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))) : []);
const extraJobs = extra.flatMap(readJobs);

let filled = 0;
for (const f of fs.readdirSync(reportsDir).filter((x) => x.endsWith('.json'))) {
  const file = path.join(reportsDir, f);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const rows = Array.isArray(raw) ? raw : raw.results || [];
  const jobs = [...readJobs(path.join(__dirname, '.work', f.slice(0, 15), 'jobs')), ...extraJobs];
  let changed = false;
  for (const row of rows) {
    if (row.timing) continue;
    const generation = row.jobId ? jobs.find((j) => j.id === row.jobId) : null;
    const title = `[평가] ${row.case} · ${row.provider}`;
    const analysis = generation
      ? jobs.find((j) => j.type === 'analyze' && j.materialId === generation.materialId)
      : jobs.find((j) => j.type === 'analyze' && j.title === title);
    if (!generation && !analysis) continue;
    row.timing = jobTiming(analysis, generation);
    changed = true;
    filled++;
  }
  if (changed) fs.writeFileSync(file, JSON.stringify(raw, null, 1));
}
console.log(`timing added to ${filled} report rows`);
