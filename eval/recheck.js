'use strict';
// Brings stored runs up to the current review, so a run made just before a check was added is judged like a new one:
// re-applies the code checks (server/harness.js) and, with --review, runs the solution review against the teacher's
// solution on problems that never had it. A problem that newly fails goes to "교사 검토 필요", as the pipeline would
// have sent it, and the run is re-scored.
//   node eval/recheck.js --since 20260930T0250 [--jobs <extra jobs dir>]... [--review deepseek|relay --relay-dir <dir>]
// Jobs come from eval/.work/<stamp>/jobs (or --jobs) and are updated in place. Reports get reviewVersion; runs whose
// jobs are missing are left alone.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const harness = require('../server/harness');
const { scoreGeneration } = require('./score');
const { REVIEW_VERSION } = require('../server/scoring');

const argv = process.argv.slice(2);
const arg = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : '');
const since = arg('--since');
const provider = arg('--review');
const extra = argv.flatMap((a, i) => (a === '--jobs' ? [argv[i + 1]] : []));
const reportsDir = path.join(__dirname, 'reports');
const readJobs = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => ({ file: path.join(dir, f), job: JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) })) : []);
const extraJobs = extra.flatMap(readJobs);

// The solution reviewer, called the way the pipeline calls it (same prompt, same provider as the run under review).
function reviewer() {
  if (!provider) return null;
  const config = require('../server/config');
  const { openStore } = require('../server/store');
  const { createLlm, Budget } = require('../server/llm');
  const { reviewSolution } = require('../server/pipeline');
  const key = (f) => { try { return fs.readFileSync(path.join(config.dataDir, f), 'utf8').trim(); } catch { return ''; } };
  const cfg = { ...config, llmMode: 'deepseek', relay: { ...config.relay, dir: arg('--relay-dir') || config.relay.dir } };
  const store = openStore(fs.mkdtempSync(path.join(os.tmpdir(), 'em2-recheck-')));
  const llm = createLlm({ config: cfg, store, apiKey: key('deepseek-api-key.txt'), claudeKey: key('anthropic-api-key.txt'), mock: null });
  return (job, item) => reviewSolution({
    llm: { json: (a) => llm.json({ ...a, provider }) }, job: { id: job.id }, budget: new Budget({ maxCalls: 1000, maxTokens: 1e9 }),
    effort: { solve: job.options?.effort || 'low' }, log: () => {}, save: () => {},
  }, item, job.material, job.rules || []);
}

(async () => {
  const review = reviewer();
  for (const f of fs.readdirSync(reportsDir).filter((x) => x.endsWith('.json') && x.includes('-full-') && x.slice(0, 15) >= since)) {
    const file = path.join(reportsDir, f);
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw.reviewVersion === REVIEW_VERSION) continue;
    const jobs = [...readJobs(path.join(__dirname, '.work', f.slice(0, 15), 'jobs')), ...extraJobs];
    const rows = Array.isArray(raw) ? raw : raw.results || [];
    if (review && rows.some((r) => (r.provider === 'relay' ? 'relay' : r.provider) !== provider)) { console.log(`${f}: made by another provider, skipped`); continue; }
    let all = true;
    const notes = [];
    for (const row of rows) {
      const found = row.jobId && jobs.find((j) => j.job.id === row.jobId);
      if (!found) { all = false; continue; }
      const { job } = found;
      for (const it of job.items || []) {
        if (!it.problem) continue;
        const v = it.verification || (it.verification = {});
        const added = [];
        if (review && !v.solutionReview) {
          v.solutionReview = await review(job, it);
          added.push(...v.solutionReview.steps.flatMap((s) => s.issues.map((x) => `문제 설계: 해설이 선생님 해설과 다름 (STEP ${s.step}): ${x}`)));
          for (const r of v.rules || []) {
            const judged = !r.judged && v.solutionReview.rules.find((x) => x.id === r.id);
            if (!judged) continue;
            r.judged = { ok: judged.ok, note: judged.note };
            if (!judged.ok) added.push(`문제 설계: 교사 지침 미준수: ${r.text.slice(0, 80)} — ${judged.note}`);
          }
        }
        const before = new Set((v.harness || []).filter((c) => c.state === 'fail').map((c) => c.id));
        v.harness = harness.inspectItem(job.material, it, job.options?.mode);
        added.push(...v.harness.filter((c) => c.state === 'fail' && !before.has(c.id)).map((c) => `문제 설계: ${c.label}: ${c.evidence}`));
        if (added.length) {
          it.problems = [...(it.problems || []), ...added];
          it.status = 'needs_review';
          notes.push(`${row.provider} ${it.label}: ${added.length}건`);
        }
      }
      if (!review || job.items.every((it) => !it.problem || it.verification?.solutionReview)) fs.writeFileSync(found.file, JSON.stringify(job));
      row.generation = scoreGeneration(job);
    }
    if (!all) { console.log(`${f}: jobs missing, left as is`); continue; }
    if (!review && rows.some((r) => jobs.find((j) => j.job.id === r.jobId)?.job.items.some((it) => it.problem && !it.verification?.solutionReview))) {
      console.log(`${f}: code checks applied; the solution review still has to run (--review)`);
      fs.writeFileSync(file, JSON.stringify(raw, null, 1));
      continue;
    }
    raw.reviewVersion = REVIEW_VERSION;
    raw.rechecked = new Date().toISOString();
    fs.writeFileSync(file, JSON.stringify(raw, null, 1));
    console.log(`${f}: rechecked${notes.length ? ' — newly failing: ' + notes.join('; ') : ''}`);
  }
})().catch((e) => { console.error(e); process.exit(1); });
