'use strict';
// Real-model end-to-end check against a running v2 server (makes paid DeepSeek calls).
// usage: node scripts/e2e-real.js <baseUrl> <accessCodeFile> <problem.png> [solution.png] [mode]
const fs = require('node:fs');
const path = require('node:path');

const [base, codeFile, problemPath, solutionPath, mode = 'numeric'] = process.argv.slice(2);
const provider = process.env.EDUMASTER_E2E_PROVIDER || 'deepseek'; // deepseek | gemma
if (!base || !codeFile || !problemPath) { console.error('usage: node scripts/e2e-real.js <baseUrl> <accessCodeFile> <problem> [solution] [mode]'); process.exit(2); }
let cookie = '';
async function call(method, url, body) {
  const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined });
  const set = res.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
  const data = await res.json();
  if (!res.ok) throw new Error(`${method} ${url} ${res.status}: ${data.error}`);
  return data;
}
// Reading views made the same way as the browser does (see readingViews in public/app.js): <image>.views/*.jpg
const views = (file) => { const dir = file + '.views'; return fs.existsSync(dir) ? fs.readdirSync(dir).sort().map((f) => dataUrl(path.join(dir, f))) : []; };
const dataUrl = (file) => `data:image/${path.extname(file).slice(1).replace('jpg', 'jpeg')};base64,` + fs.readFileSync(file).toString('base64');
async function wait(id) {
  for (;;) {
    const job = await call('GET', `/api/jobs/${id}`);
    if (['done', 'failed', 'cancelled', 'interrupted'].includes(job.status)) return job;
    process.stdout.write(`\r${job.status} ${job.usage.calls} calls ${job.usage.total} tokens · ${(job.log || []).slice(-1)[0]?.message || ''}`.padEnd(110));
    await new Promise((r) => setTimeout(r, 4000));
  }
}

(async () => {
  await call('POST', '/api/login', { code: fs.readFileSync(codeFile, 'utf8').trim() });
  const created = await call('POST', '/api/materials', { title: process.env.EDUMASTER_E2E_TITLE || 'e2e 몰질량', problemImage: dataUrl(problemPath), solutionImage: solutionPath ? dataUrl(solutionPath) : null, problemViews: views(problemPath), solutionViews: solutionPath ? views(solutionPath) : [], provider });
  const analysis = await wait(created.jobId);
  console.log('\nanalysis:', analysis.status, analysis.error || '', JSON.stringify(analysis.usage));
  const m = await call('GET', `/api/materials/${created.material.id}`);
  if (m.status !== 'ready') throw new Error('analysis failed: ' + m.error);
  console.log(JSON.stringify({ title: m.title, answer: m.problem.answer, choices: m.problem.choices, steps: m.steps.map((s) => s.title), stepMarkers: m.stepMarkers, annotations: m.annotations, uncertainties: m.uncertainties }, null, 1));
  console.log('PROBLEM TEXT:\n' + m.problem.text);
  console.log('PROOFREAD:', JSON.stringify(m.proofread || []));
  if (mode === 'analyze') return;
  const gen = await call('POST', '/api/generations', { materialId: m.id, mode, provider });
  const job = await wait(gen.jobId);
  console.log('\ngeneration:', job.status, job.error || '', JSON.stringify(job.usage));
  for (const item of job.items) {
    console.log(`\n==== ${item.index + 1}. ${item.label} → ${item.status}`);
    if (!item.problem) { console.log('error:', item.error); continue; }
    console.log(item.problem.text);
    console.log('choices:', item.problem.choices.join(' | '), '→ answer', item.problem.answer);
    console.log('code:', item.verification.code.status, item.verification.code.reasons.join('; '));
    console.log('blind:', item.verification.blind.answer, item.verification.blind.answerValue, 'steps', item.verification.blind.stepsUsed.join(','), 'issues', JSON.stringify(item.verification.blind.issues));
    console.log('repairs:', (item.attempts || []).filter((a) => a.kind === 'repair').length, 'hard:', JSON.stringify(item.problems), 'soft:', JSON.stringify(item.warnings));
    console.log('design:', item.designNote);
  }
  console.log(`\nJOB ${job.id}`);
})().catch((e) => { console.error('\nFAILED', e.message); process.exit(1); });
