#!/usr/bin/env node
'use strict';
// Judges a finished set again with another model, problems and solutions unchanged: the independent solve, the
// solution review and the designer's re-check of a disagreeing solver run on `--judge` (default claude-cli, Opus), the
// code checks as in the pipeline, and each problem's status is decided the way produceItem decides it. A set a cheap
// model judged itself (Qwen 3.8 alone, 2026-10-14) is then scored by the same judge as every other model on 모델 비교.
//   node eval/rejudge.js --data <run dir> --job <generation job id> [--report <report.json>] [--judge claude-cli]
// The job is backed up next to itself (<id>.json.self-judged) and rewritten; the report row's generation checks are
// re-scored and marked with the judge.
const fs = require('node:fs');
const path = require('node:path');

const argv = process.argv.slice(2);
const arg = (name, def = '') => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : def);
const dataArg = arg('--data');
const jobId = arg('--job');
const judge = arg('--judge', 'claude-cli');
const reportFile = arg('--report');
// path.resolve('') is the current folder: the flag's absence has to be checked before resolving.
const dataDir = dataArg ? path.resolve(dataArg) : '';
if (!dataDir || !jobId) { console.error('usage: --data <run dir> --job <id> [--report <file>] [--judge claude-cli]'); process.exit(1); }

process.env.EDUMASTER_DATA_DIR = dataDir;
const config = require('../server/config');
const { openStore } = require('../server/store');
const { createLlm, Budget } = require('../server/llm');
const { verifyItem } = require('../server/pipeline');
const { scoreGeneration } = require('./score');

(async () => {
  const cfg = { ...config, dataDir };
  const store = openStore(dataDir);
  const llm = createLlm({ config: cfg, store, apiKey: '', claudeKey: '', mock: null });
  const file = path.join(dataDir, 'jobs', `${jobId}.json`);
  const job = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!fs.existsSync(`${file}.self-judged`)) fs.copyFileSync(file, `${file}.self-judged`);
  const log = [];
  const ctx = {
    store, job, budget: new Budget({ maxCalls: 1000, maxTokens: 1e9 }), signal: new AbortController().signal, provider: judge,
    routes: {}, lean: false, precheck: false, effort: { generate: 'low', solve: 'low' },
    llm: { ...llm, json: (a) => llm.json({ ...a, provider: judge }) },
    log: (m) => { log.push(m); console.log(m); }, save: () => {},
  };
  const mode = job.options?.mode || 'integrated';
  for (const item of job.items) {
    if (!item.problem) continue;
    const prior = job.items.filter((x) => x.index < item.index && x.problem);
    const check = await verifyItem(ctx, item, job.material, job.rules || [], mode, prior);
    const reasons = [...check.hard, ...check.coverageNotes.map((n) => 'STEP 범위: ' + n), ...check.designNotes.map((n) => '문제 설계: ' + n)];
    item.verification = check.verification;
    item.problems = [...new Set(check.invalid)];
    item.warnings = [...new Set([
      ...reasons.filter((r) => !check.invalid.some((x) => r.endsWith(x))),
      ...check.soft.filter((w) => !check.coverageNotes.includes(w) && !check.designNotes.includes(w) && !check.invalid.includes(w)),
      ...check.rewriteNotes.map((n) => '해설: ' + n),
    ])];
    item.status = item.problems.length ? 'needs_review' : item.warnings.length ? 'warning' : 'passed';
    console.log(`${item.label}: ${item.status} (${item.problems.length} problems, ${item.warnings.length} warnings)`);
  }
  job.judgedBy = judge;
  job.log = [...(job.log || []), { t: new Date().toISOString(), message: `${judge}가 다시 판정함 (문제·해설은 그대로)` }].slice(-200);
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(job, null, 1));
  fs.renameSync(temp, file);
  if (reportFile) {
    const raw = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
    const rows = Array.isArray(raw) ? raw : raw.results || [];
    const row = rows.find((r) => r.jobId === jobId);
    if (row) {
      row.selfGeneration = row.selfGeneration || row.generation;
      row.generation = scoreGeneration(job);
      row.judgedBy = judge;
      fs.writeFileSync(reportFile, JSON.stringify(raw, null, 1));
      console.log(`report: ${row.generation.filter((c) => c.pass).length}/${row.generation.length} (was ${row.selfGeneration.filter((c) => c.pass).length}/${row.selfGeneration.length})`);
    }
  }
})().catch((e) => { console.error(e); process.exit(1); });
