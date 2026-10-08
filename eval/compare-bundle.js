'use strict';
// Builds one model-comparison file for the 모델 비교 page: the original (images + the teacher's STEP titles) and,
// per model, the problem set it made for the same eval case, with the review results and harness scores.
//   node eval/compare-bundle.js --data <data dir holding the eval jobs> --case chem-molar-mass [--title "화학 몰질량 · "]
//     [--keys <jobId>=<key>,...] [--merge]
// Each model has a key (claude-cli, deepseek, or the local model: gemma12, qwen36); a PC job is gemma12 unless --keys
// says otherwise. --merge keeps the models already in the file and replaces only those with the same key.
// Jobs are picked by title (default: the eval runner's "<case> · <model>"); PDFs of each set, if printed to
// eval/compare/<case>/<key>.pdf, are offered for download on the page.
// Writes eval/compare/<case>.json (deploy ships it; the page reads it, nothing is stored in data/).
const fs = require('node:fs');
const path = require('node:path');

// --name value, or a bare --flag (true).
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]] : acc), []));
if (!args.data || !args.case) { console.error('usage: --data <dir> --case <case>'); process.exit(1); }
const caseDir = path.join(__dirname, 'cases', args.case);
const spec = JSON.parse(fs.readFileSync(path.join(caseDir, 'case.json'), 'utf8'));
const dataUrl = (file) => `data:image/${path.extname(file).slice(1).replace('jpg', 'jpeg')};base64,` + fs.readFileSync(file).toString('base64');
const { pcModelKey } = require('../server/llm');
const LABEL = { 'claude-cli': 'Claude Opus 5.5', deepseek: 'DeepSeek V4 Flash', qwen36: 'Qwen 3.6-35B', gemma12: 'Gemma 4 12B' };
const ORDER = ['claude-cli', 'deepseek', 'qwen36', 'gemma12'];
const KEYS = Object.fromEntries((args.keys || '').split(',').filter(Boolean).map((p) => p.split('=')));
const keyOf = (provider, model) => (provider === 'gemma' ? pcModelKey(model) : provider === 'claude-cli' && model && !/^(claude-cli|claude-opus-5-5)$/.test(model) ? model : provider);

// Harness scores of each model on this case, from the newest full report that has them.
const scores = {};
const reportsDir = path.join(__dirname, 'reports');
for (const f of fs.readdirSync(reportsDir).filter((x) => x.endsWith('.json')).sort().reverse()) {
  const raw = JSON.parse(fs.readFileSync(path.join(reportsDir, f), 'utf8'));
  for (const r of Array.isArray(raw) ? raw : raw.results || []) {
    if (r.case !== args.case || r.stage !== 'full' || !(r.generation || []).length || r.claudeMix || scores[keyOf(r.provider, r.model)]) continue;
    const t = (list) => ({ pass: (list || []).filter((c) => c.pass).length, total: (list || []).length });
    scores[keyOf(r.provider, r.model)] = { read: t(r.analysis), make: t(r.generation), minutes: r.minutes, usage: r.generationUsage || null, report: f };
  }
}

const jobsDir = path.join(args.data, 'jobs');
const models = [];
for (const f of fs.readdirSync(jobsDir)) {
  const job = JSON.parse(fs.readFileSync(path.join(jobsDir, f), 'utf8'));
  if (job.type !== 'generate' || job.options?.claudeMix || !String(job.title).includes(args.title || `${args.case} · `)) continue;
  const provider = job.options?.provider || 'deepseek';
  const key = KEYS[job.id] || keyOf(provider, '');
  const m = job.material;
  models.push({
    key, provider, label: LABEL[key] || key, jobId: job.id, pdf: fs.existsSync(path.join(__dirname, 'compare', args.case, `${key}.pdf`)), status: job.status, error: job.error || '', mode: job.options?.mode,
    score: scores[key] || null,
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
const file = path.join(__dirname, 'compare', `${args.case}.json`);
const previous = args.merge && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
if (previous) models.push(...previous.models.filter((p) => !models.some((m) => m.key === p.key)));
models.sort((a, b) => ORDER.indexOf(a.key) - ORDER.indexOf(b.key));
const out = {
  id: args.case, title: spec.title, createdAt: new Date().toISOString(),
  original: {
    problemImage: dataUrl(path.join(caseDir, spec.problem)), solutionImage: spec.solution ? dataUrl(path.join(caseDir, spec.solution)) : null,
    answer: spec.expect?.answer, steps: spec.expect?.stepTitles || [],
  },
  models,
};
fs.mkdirSync(path.join(__dirname, 'compare'), { recursive: true });
fs.writeFileSync(file, JSON.stringify(out));
console.log(file, models.map((m) => `${m.key}:${m.items.map((i) => i.status).join('/')}`).join('  '), Math.round(fs.statSync(file).size / 1024) + 'KB');
