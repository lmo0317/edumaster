'use strict';
// Builds one model-comparison file for the 모델 비교 page: the original (images + the teacher's STEP titles) and,
// per model, the problem set it made for the same eval case, with the review results and harness scores.
//   node eval/compare-bundle.js --data <data dir holding the eval jobs> --case chem-molar-mass [--title "화학 몰질량 · "]
// Jobs are picked by title (default: the eval runner's "<case> · <model>"); PDFs of each set, if printed to
// eval/compare/<case>/<provider>.pdf, are offered for download on the page.
// Writes eval/compare/<case>.json (deploy ships it; the page reads it, nothing is stored in data/).
const fs = require('node:fs');
const path = require('node:path');

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []));
if (!args.data || !args.case) { console.error('usage: --data <dir> --case <case>'); process.exit(1); }
const caseDir = path.join(__dirname, 'cases', args.case);
const spec = JSON.parse(fs.readFileSync(path.join(caseDir, 'case.json'), 'utf8'));
const dataUrl = (file) => `data:image/${path.extname(file).slice(1).replace('jpg', 'jpeg')};base64,` + fs.readFileSync(file).toString('base64');
const LABEL = { deepseek: 'DeepSeek V4 Flash', gemma: 'Gemma 4 12B', relay: 'Claude Opus 5.5' };
const ORDER = ['relay', 'deepseek', 'gemma'];

// Harness scores of each model on this case, from the newest full report that has them.
const scores = {};
const reportsDir = path.join(__dirname, 'reports');
for (const f of fs.readdirSync(reportsDir).filter((x) => x.endsWith('.json')).sort().reverse()) {
  const raw = JSON.parse(fs.readFileSync(path.join(reportsDir, f), 'utf8'));
  for (const r of Array.isArray(raw) ? raw : raw.results || []) {
    if (r.case !== args.case || r.stage !== 'full' || scores[r.provider]) continue;
    const t = (list) => ({ pass: (list || []).filter((c) => c.pass).length, total: (list || []).length });
    scores[r.provider] = { read: t(r.analysis), make: t(r.generation), minutes: r.minutes, usage: r.generationUsage || null, report: f };
  }
}

const jobsDir = path.join(args.data, 'jobs');
const models = [];
for (const f of fs.readdirSync(jobsDir)) {
  const job = JSON.parse(fs.readFileSync(path.join(jobsDir, f), 'utf8'));
  if (job.type !== 'generate' || !String(job.title).includes(args.title || `${args.case} · `)) continue;
  const provider = job.options?.provider || 'deepseek';
  const m = job.material;
  models.push({
    provider, label: LABEL[provider] || provider, jobId: job.id, pdf: fs.existsSync(path.join(__dirname, 'compare', args.case, `${provider}.pdf`)), status: job.status, error: job.error || '', mode: job.options?.mode,
    score: scores[provider] || null,
    reading: { question: (m.problem.text || '').split('\n').filter((l) => l.trim()).pop(), steps: m.steps.map((s) => s.title), answer: m.problem.answer },
    items: job.items.map((it) => ({
      label: it.label, stage: it.stage, status: it.status, error: it.error || '',
      problem: it.problem || null, solution: it.solution || null, designNote: it.designNote || '',
      repairs: (it.attempts || []).filter((a) => a.kind === 'repair').length,
      problems: it.problems || [], warnings: it.warnings || [],
      blind: it.verification?.blind ? { answer: it.verification.blind.answer, variation: it.verification.blind.variation } : null,
      code: it.verification?.code?.status || '',
    })),
  });
}
models.sort((a, b) => ORDER.indexOf(a.provider) - ORDER.indexOf(b.provider));
const out = {
  id: args.case, title: spec.title, createdAt: new Date().toISOString(),
  original: {
    problemImage: dataUrl(path.join(caseDir, spec.problem)), solutionImage: spec.solution ? dataUrl(path.join(caseDir, spec.solution)) : null,
    answer: spec.expect?.answer, steps: spec.expect?.stepTitles || [],
  },
  models,
};
fs.mkdirSync(path.join(__dirname, 'compare'), { recursive: true });
const file = path.join(__dirname, 'compare', `${args.case}.json`);
fs.writeFileSync(file, JSON.stringify(out));
console.log(file, models.map((m) => `${m.provider}:${m.items.map((i) => i.status).join('/')}`).join('  '), Math.round(fs.statSync(file).size / 1024) + 'KB');
