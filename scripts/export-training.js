'use strict';
// Training data for a local model (2026-10-05): every finished variant the harness confirmed (passed, or done with
// only minor notes) becomes examples in the prompts the app really sends, so a fine-tuned model learns the task it
// will do. Two files in JSONL ({messages:[system,user,assistant], meta}):
//   solve.jsonl  — the independent solve: the problem → a worked solution and the answer (the 독립 검산 role)
//   design.jsonl — the design: original + stage → the problem, its solution and check program (for later)
// Problems the teacher adopted are marked. Run on the server in the app folder:
//   node scripts/export-training.js [outDir]        (default data/training)
// Nothing leaves the server; the counts show how many distinct originals there are — fine-tuning needs many.
const fs = require('node:fs');
const path = require('node:path');
const cfg = require('../server/config');
const { openStore } = require('../server/store');
const prompts = require('../server/prompts');

const out = path.resolve(process.argv[2] || path.join(cfg.dataDir, 'training'));
fs.mkdirSync(out, { recursive: true });
const store = openStore(cfg.dataDir);
const sets = store.jobs.all().filter((j) => j.type === 'generate' && j.material && !String(j.title || '').startsWith('[평가]'));
const solve = [];
const design = [];
const originals = new Set();
for (const j of sets) {
  const prior = [];
  for (const it of j.items || []) {
    if (!it.problem || !['passed', 'warning'].includes(it.status)) { if (it.problem) prior.push(it); continue; }
    originals.add(j.materialId);
    const meta = { set: j.id, item: it.index, label: it.label, original: j.materialId, provider: j.options?.provider, status: it.status, adopted: Boolean(it.adopted) };
    const answer = { answer: it.problem.answer, solution: (it.solution?.steps || []).map((s) => `STEP ${s.step}. ${s.title}\n${s.work}`).join('\n\n') };
    solve.push({ messages: [
      { role: 'system', content: prompts.SOLVE_SYSTEM },
      { role: 'user', content: prompts.solveText({ item: it, material: j.material, rules: [], compareOriginal: false }) },
      { role: 'assistant', content: JSON.stringify(answer) },
    ], meta });
    design.push({ messages: [
      { role: 'system', content: prompts.GENERATE_SYSTEM },
      { role: 'user', content: prompts.generateText({ material: j.material, stage: it.stage, total: j.material.steps.length, mode: j.options?.mode || 'integrated', prior, rules: [], variantNo: it.variantNo || 1 }) },
      { role: 'assistant', content: JSON.stringify({ problem: it.problem, solution: it.solution, usesSteps: it.usesSteps, designNote: it.designNote, verification: it.verificationSpec }) },
    ], meta });
    prior.push(it);
  }
}
const write = (name, rows) => fs.writeFileSync(path.join(out, name), rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
write('solve.jsonl', solve);
write('design.jsonl', design);
console.log(JSON.stringify({ out, sets: sets.length, examples: solve.length, adopted: solve.filter((r) => r.meta.adopted).length, distinctOriginals: originals.size }));
