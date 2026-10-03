'use strict';
// Evaluation harness: runs every case through the real pipeline (same code, same HTTP API) with real models
// and scores the results against each case's expectations.
//
//   node eval/run.js [--providers deepseek,gemma,relay] [--cases all|name,...] [--stage analyze|full]
//                    [--mode integrated|numeric] [--key <deepseek key file>] [--relay-dir <dir>]
//
// It starts its own server in-process with a fresh data folder, so real teacher data is never touched.
// Paid providers cost money: --stage analyze is cheap (~20-40k tokens per case), full is ~0.3-0.5M.
const fs = require('node:fs');
const path = require('node:path');
const { createApp } = require('../server');
const { scoreAnalysis, scoreGeneration } = require('./score');

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]?.startsWith('--') || all[i + 1] === undefined ? 'true' : all[i + 1]]] : acc), []));
const root = path.join(__dirname, '..');
const casesDir = path.join(__dirname, 'cases');
const providers = (args.providers || 'deepseek').split(',');
const stage = args.stage || 'analyze';
const mode = args.mode || 'integrated';
const caseNames = !args.cases || args.cases === 'all' ? fs.readdirSync(casesDir).filter((d) => fs.existsSync(path.join(casesDir, d, 'case.json'))) : args.cases.split(',');
const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
const { PROMPT_VERSION } = require('../server/prompts');
const { jobTiming, REVIEW_VERSION } = require('../server/scoring');
const { runCost } = require('../server/cost');
// Mixed runs: --analyze-with <p> reads the scans with another model, --design-with <p> writes the problems and their
// repairs, --repair-with <p> only the repairs; the --providers model does the rest (independent solve, review, checks).
const mixed = { analyzeWith: args['analyze-with'], designWith: args['design-with'], repairWith: args['repair-with'], lean: args.lean === 'true' || undefined };
for (const k of Object.keys(mixed)) if (!mixed[k]) delete mixed[k];
const mixedName = Object.entries(mixed).map(([k, v]) => (v === true ? `-${k}` : `-${k.replace('With', '')}-${v}`)).join('');
const learning = {};

function dataUrl(file) {
  const ext = path.extname(file).slice(1).toLowerCase();
  return `data:image/${ext === 'jpg' ? 'jpeg' : ext};base64,` + fs.readFileSync(file).toString('base64');
}
function views(file) {
  const dir = file + '.views';
  return fs.existsSync(dir) ? fs.readdirSync(dir).sort().map((f) => dataUrl(path.join(dir, f))) : [];
}

async function main() {
  const dataDir = path.join(__dirname, '.work', stamp);
  process.env.EDUMASTER_KEEP_RAW = '1'; // every model answer is kept under .work/<stamp>/llm-raw
  fs.mkdirSync(dataDir, { recursive: true });
  require('../server/users').createUsers(dataDir).create({ username: 'eval', password: 'eval-harness', role: 'admin' });
  const keyFile = args.key || path.join(root, 'data', 'deepseek-api-key.txt');
  if (fs.existsSync(keyFile)) fs.copyFileSync(keyFile, path.join(dataDir, 'deepseek-api-key.txt'));
  const claudeKeyFile = args['claude-key'] || path.join(root, 'data', 'anthropic-api-key.txt');
  if (fs.existsSync(claudeKeyFile)) fs.copyFileSync(claudeKeyFile, path.join(dataDir, 'anthropic-api-key.txt'));
  // The Claude subscription (claude-cli): the server's login token and the LLM tab's model/effort choice come along,
  // so --providers claude-cli measures the model the teacher actually uses.
  for (const [arg, file] of [['claude-token', 'claude-oauth-token.txt'], ['llm-settings', 'llm-settings.json']]) {
    const from = args[arg] || path.join(root, 'data', file);
    if (fs.existsSync(from)) { fs.copyFileSync(from, path.join(dataDir, file)); fs.chmodSync(path.join(dataDir, file), 0o600); }
  }
  // Measure the system as it runs: the teacher's approved rules and reading corrections come along (RAG).
  // --no-learning measures the bare prompts, so the two runs show what retrieval adds.
  const learningFrom = args['learning-from'] || path.join(root, 'data');
  learning.used = args['no-learning'] ? 'none' : learningFrom;
  if (!args['no-learning']) {
    for (const dir of ['rules', 'corrections']) {
      if (fs.existsSync(path.join(learningFrom, dir))) fs.cpSync(path.join(learningFrom, dir), path.join(dataDir, dir), { recursive: true });
    }
  }
  learning.rules = fs.existsSync(path.join(dataDir, 'rules')) ? fs.readdirSync(path.join(dataDir, 'rules')).filter((f) => f.endsWith('.json')).length : 0;
  learning.corrections = fs.existsSync(path.join(dataDir, 'corrections')) ? fs.readdirSync(path.join(dataDir, 'corrections')).filter((f) => f.endsWith('.json')).length : 0;
  const app = createApp({ dataDir, llmMode: 'deepseek', relay: { dir: args['relay-dir'] || '', label: 'relay', timeoutMs: 3 * 3600 * 1000 } });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  let cookie = '';
  const call = async (method, url, body) => {
    const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined });
    const set = res.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
    const data = await res.json();
    if (!res.ok) throw new Error(`${method} ${url}: ${data.error}`);
    return data;
  };
  const wait = async (id) => {
    for (;;) {
      const job = await call('GET', `/api/jobs/${id}`);
      if (['done', 'failed', 'cancelled', 'interrupted'].includes(job.status)) return job;
      await new Promise((r) => setTimeout(r, 3000));
    }
  };
  await call('POST', '/api/login', { username: 'eval', password: 'eval-harness' });
  // The PC provider serves whichever local model is loaded; keep its name so runs of different models differ.
  const status = await call('GET', '/api/status');
  const modelOf = (provider) => (provider === 'gemma' ? status.providers?.gemma?.model || 'gemma' : provider);

  const results = [];
  for (const name of caseNames) {
    const spec = JSON.parse(fs.readFileSync(path.join(casesDir, name, 'case.json'), 'utf8'));
    const problem = path.join(casesDir, name, spec.problem);
    const solution = spec.solution ? path.join(casesDir, name, spec.solution) : null;
    for (const provider of providers) {
      const started = Date.now();
      const row = { case: name, title: spec.title, provider, model: modelOf(provider), stage, mode, ...mixed };
      process.stdout.write(`\n[${name} · ${provider}] 분석 중…`);
      try {
        const created = await call('POST', '/api/materials', {
          title: `[평가] ${name} · ${provider}`, provider: mixed.analyzeWith || provider, sameImage: Boolean(spec.sameImage),
          problemImage: dataUrl(problem), solutionImage: solution && !spec.sameImage ? dataUrl(solution) : null,
          problemViews: views(problem), solutionViews: solution && !spec.sameImage ? views(solution) : [],
        });
        const analysisJob = await wait(created.jobId);
        const material = await call('GET', `/api/materials/${created.material.id}`);
        row.analysisUsage = analysisJob.usage;
        row.analysis = material.status === 'ready' ? scoreAnalysis(material, spec.expect) : [{ name: '분석 완료', pass: false, detail: material.error || analysisJob.error }];
        row.timing = jobTiming(analysisJob, null);
        row.read = { steps: (material.steps || []).map((s) => s.title), question: (material.problem?.text || '').split('\n').filter((l) => l.trim()).pop(), proofread: material.proofread || [] };
        if (stage === 'full' && material.status === 'ready') {
          process.stdout.write(' 생성 중…');
          const gen = await call('POST', '/api/generations', { materialId: material.id, mode, provider, designWith: mixed.designWith, repairWith: mixed.repairWith, lean: mixed.lean });
          const job = await wait(gen.jobId);
          row.generationUsage = job.usage;
          row.generation = scoreGeneration(job);
          row.rulesAttached = (job.rules || []).length;
          row.jobId = job.id;
          row.timing = jobTiming(analysisJob, job);
        }
        // List-price cost of every call this case made (analysis + generation), per provider.
        const usageDir = path.join(dataDir, 'usage');
        const records = fs.existsSync(usageDir) ? fs.readdirSync(usageDir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(usageDir, f), 'utf8'))) : [];
        row.cost = runCost(records, [analysisJob.id, row.jobId].filter(Boolean));
      } catch (e) {
        row.error = e.message;
      }
      row.minutes = +((Date.now() - started) / 60000).toFixed(1);
      const all = [...(row.analysis || []), ...(row.generation || [])];
      process.stdout.write(` ${all.filter((c) => c.pass).length}/${all.length} 통과 (${row.minutes}분)`);
      results.push(row);
    }
  }
  await new Promise((r) => app.server.close(r));

  fs.mkdirSync(path.join(__dirname, 'reports'), { recursive: true });
  const base_ = path.join(__dirname, 'reports', `${stamp}-${stage}-${providers.join('+')}${mixedName}`);
  fs.writeFileSync(base_ + '.json', JSON.stringify({ stamp, stage, mode, promptVersion: PROMPT_VERSION, reviewVersion: REVIEW_VERSION, learning, results }, null, 1));
  fs.writeFileSync(base_ + '.md', report(results));
  console.log(`\n\n${report(results)}\n보고서: ${base_}.md`);
}

function usageText(u, provider) {
  if (!u) return '-';
  if (provider === 'gemma') return `${u.calls}회 · 무료`;
  if (provider === 'relay') return `${u.calls}회 · 집계 없음`;
  if (provider === 'claude') return `${u.calls}회 · ${Number(u.total).toLocaleString()}토큰 · $${(((u.input || 0) * 4 + (u.output || 0) * 20) / 1e6).toFixed(2)}`;
  return `${u.calls}회 · ${Number(u.total).toLocaleString()}토큰 · ≤$${(((u.input || 0) * 0.3 + (u.output || 0) * 1.2) / 1e6).toFixed(2)}`;
}

function report(results) {
  const pct = (list) => (list?.length ? `${list.filter((c) => c.pass).length}/${list.length}` : '-');
  const lines = [
    `# 평가 결과 (${stamp}, ${stage}, ${mode})`, '',
    `- 프롬프트 버전: ${PROMPT_VERSION}`,
    `- 학습 상태(RAG): ${learning.used === 'none' ? '끔 (--no-learning)' : `교사 지침 ${learning.rules}개 · 판독 교정 ${learning.corrections}개`}`, '',
    '| 사례 | 모델 | 분석 | 생성 | 분석 비용 | 생성 비용 | 시간 |', '|---|---|---|---|---|---|---|',
    ...results.map((r) => `| ${r.case} | ${r.model && r.model !== r.provider ? r.model : r.provider} | ${pct(r.analysis)} | ${pct(r.generation)} | ${usageText(r.analysisUsage, r.provider)} | ${usageText(r.generationUsage, r.provider)} | ${r.minutes}분 |`),
    '',
  ];
  for (const r of results) {
    const failed = [...(r.analysis || []), ...(r.generation || [])].filter((c) => !c.pass);
    lines.push(`## ${r.case} · ${r.provider}`);
    if (r.error) lines.push(`- 오류: ${r.error}`);
    if (r.read) lines.push(`- 읽은 STEP: ${r.read.steps.map((s, i) => `${i + 1}) ${s}`).join(' / ')}`, `- 읽은 발문: ${r.read.question}`);
    if (r.jobId) lines.push(`- 생성 작업: ${r.jobId} (붙인 교사 지침 ${r.rulesAttached}개)${[r.analyzeWith && `분석 ${r.analyzeWith}`, r.designWith && `설계·수정 ${r.designWith}`, r.repairWith && !r.designWith && `수정 ${r.repairWith}`].filter(Boolean).map((x) => ' · ' + x).join('')}`);
    if (r.cost) lines.push(`- 비용(정가): $${r.cost.usd} — ${Object.entries(r.cost.byProvider).map(([p, t]) => `${p} ${t.calls}회 $${t.usd} (입력 ${t.input.toLocaleString()} 중 캐시 ${t.cached.toLocaleString()}, 출력 ${t.output.toLocaleString()}${t.peakCalls ? `, 피크 ${t.peakCalls}회` : ''})`).join(' · ')}`);
    if (r.timing) lines.push(`- 시간: 분석 ${r.timing.analysis}분 · 생성 ${r.timing.generation}분 (${(r.timing.items || []).map((i) => `${i.label} ${i.minutes}분/수정 ${i.repairs}`).join(', ')})`);
    lines.push(failed.length ? '- 실패한 항목:' : '- 모든 항목 통과');
    for (const c of failed) lines.push(`  - ✗ ${c.name}${c.detail ? ' — ' + c.detail : ''}`);
    lines.push('');
  }
  return lines.join('\n');
}

main().catch((e) => { console.error(e); process.exit(1); });
