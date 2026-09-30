'use strict';
// Re-applies the current code checks (server/harness.js) to runs whose independent review already used the current
// prompts, and re-scores them, so a run made just before a code check was added is judged like a new one. A problem
// that newly fails goes to "교사 검토 필요", as the pipeline would have sent it.
//   node eval/recheck.js --since 20260930T0250 [--jobs <extra jobs dir>]...
// Jobs come from eval/.work/<stamp>/jobs (or --jobs). Reports get reviewVersion; runs without their jobs are left alone.
const fs = require('node:fs');
const path = require('node:path');
const harness = require('../server/harness');
const { scoreGeneration } = require('./score');
const { REVIEW_VERSION } = require('../server/scoring');

const argv = process.argv.slice(2);
const since = argv[argv.indexOf('--since') + 1] || '';
const extra = argv.flatMap((a, i) => (a === '--jobs' ? [argv[i + 1]] : []));
const reportsDir = path.join(__dirname, 'reports');
const readJobs = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))) : []);
const extraJobs = extra.flatMap(readJobs);

for (const f of fs.readdirSync(reportsDir).filter((x) => x.endsWith('.json') && x.includes('-full-') && x.slice(0, 15) >= since)) {
  const file = path.join(reportsDir, f);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (raw.reviewVersion === REVIEW_VERSION) continue;
  const jobs = [...readJobs(path.join(__dirname, '.work', f.slice(0, 15), 'jobs')), ...extraJobs];
  const rows = Array.isArray(raw) ? raw : raw.results || [];
  let all = true;
  const notes = [];
  for (const row of rows) {
    const job = row.jobId && jobs.find((j) => j.id === row.jobId);
    if (!job) { all = false; continue; }
    for (const it of job.items || []) {
      if (!it.problem) continue;
      const before = new Set((it.verification?.harness || []).filter((c) => c.state === 'fail').map((c) => c.id));
      const now = harness.inspectItem(job.material, it, job.options?.mode);
      const added = now.filter((c) => c.state === 'fail' && !before.has(c.id));
      it.verification = { ...(it.verification || {}), harness: now };
      if (added.length) {
        it.problems = [...(it.problems || []), ...added.map((c) => `문제 설계: ${c.label}: ${c.evidence}`)];
        it.status = 'needs_review';
        notes.push(`${row.provider} ${it.label}: ${added.map((c) => c.id).join(', ')}`);
      }
    }
    row.generation = scoreGeneration(job);
  }
  if (!all) { console.log(`${f}: jobs missing, left as is`); continue; }
  raw.reviewVersion = REVIEW_VERSION;
  raw.rechecked = new Date().toISOString();
  fs.writeFileSync(file, JSON.stringify(raw, null, 1));
  console.log(`${f}: rechecked${notes.length ? ' — newly failing: ' + notes.join('; ') : ''}`);
}
