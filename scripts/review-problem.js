'use strict';
// 문제 검수 (.claude/skills/problem-review): an independent review of one problem's analysis and one of its sets by
// Claude and Gemini, through the same subscription connections the app uses (Claude Code CLI, agy). Neither model sees
// the harness's verdicts; each solves the variants itself. Run on the server, in the app folder:
//   node scripts/review-problem.js <materialId | setId> [out.json] [--providers claude-cli,agy-cli]
// A material id reviews its newest set; a set id reviews that set. Writes the result as each model finishes.
const fs = require('node:fs');
const path = require('node:path');
const cfg = require('../server/config');
const { openStore } = require('../server/store');
const { createLlm, Budget, claudeCliReady } = require('../server/llm');
const cli = require('../server/cli-models');
const { mock } = require('../server/mock-llm');
const { selectRules, analysisLearning, layerOf } = require('../server/learning');

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : ''; };
const providers = (flag('--providers') || 'claude-cli,agy-cli').split(',').filter(Boolean);
const [id, out = `/tmp/review-${id}.json`] = args;
if (!/^[a-f0-9]{16,40}$/.test(id || '')) { console.error('usage: node scripts/review-problem.js <materialId | setId> [out.json]'); process.exit(2); }

const store = openStore(cfg.dataDir);
const readSecret = (f) => { try { return fs.readFileSync(path.join(cfg.dataDir, f), 'utf8').trim(); } catch { return ''; } };
const llm = createLlm({ config: cfg, store, apiKey: readSecret('deepseek-api-key.txt'), claudeKey: readSecret('anthropic-api-key.txt'), mock });

const sets = store.jobs.all().filter((j) => j.type === 'generate');
const asSet = sets.find((j) => j.id === id);
const m = store.materials.get(asSet ? asSet.materialId : id);
if (!m) { console.error('문제를 찾지 못했습니다: ' + id); process.exit(1); }
const set = asSet || sets.filter((j) => j.materialId === m.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];

const fileUrl = (fid) => {
  for (const ext of ['jpg', 'png', 'webp']) {
    const f = path.join(cfg.dataDir, 'files', `${fid}.${ext}`);
    if (fs.existsSync(f)) return `data:image/${ext === 'jpg' ? 'jpeg' : ext};base64,${fs.readFileSync(f).toString('base64')}`;
  }
  return null;
};
const imgs = (label, original, views) => {
  const list = (views || []).length ? views : [original];
  return list.map((fid, i) => ({ label: `${label}${list.length > 1 ? ` (${i + 1}/${list.length})` : ''}`, dataUrl: fileUrl(fid) })).filter((x) => x.dataUrl);
};
const range = (st) => (st?.kind === 'upto' ? `원본 STEP 1${st.upto > 1 ? '~' + st.upto : ''}만 쓰는 연습 문제` : st?.kind === 'twin' ? `원본 STEP 1~${m.steps.length}을 모두 쓰는 최종 통합 문제 (원본과 다른 구조여야 함)` : '');
const choices = (p) => (p.choices || []).map((c, i) => `${'①②③④⑤'[i]} ${c}`).join('  ');

// What the reviewers check: the recorded criteria (scripts/review-criteria.md, from past failures and the colleague's
// review) and the learning that applies to this problem now (지침, this problem's own, 공통 학습).
const criteria = fs.readFileSync(path.join(__dirname, 'review-criteria.md'), 'utf8').replace(/^[\s\S]*?(?=## A\.)/, '');
const KIND = { guide: '지침', problem: '이 문제', lesson: '공통 학습' };
const ruleLines = (list) => list.map((r) => `- [${KIND[layerOf(r)]}] ${r.text}`).join('\n') || '없음';
const learnedA = analysisLearning(store.rules.all(), m);
const learnedG = selectRules(store.rules.all(), m);
const RULE_NAMES = '판독, 용어, STEP 수와 순서, STEP 제목, 풀이 방식, 정답, STEP 범위, 결론 노출, 조건, 단서, 수치, 용기·실험 구성, 형식, 구조, STEP 전부 필요, 범위, 보기 분석, 덧붙임, 표기';
const system = `너는 고등학교 ${m.subject || '과학'} 문항을 검토하는 출제 전문가다. AI가 정리한 분석 결과와 AI가 만든 변형 문제를 원본 이미지와 대조해 독립적으로 검토한다.
- 변형 문제는 반드시 네가 직접 끝까지 풀어서 정답을 확인한다. 표시된 정답이나 해설을 믿지 않는다.
- 아래 [검수 기준]과 [이 문제에 적용되는 학습]을 하나씩 대조한다. 실제 결함만 적고, 기준의 'E. 결함이 아닌 것'은 적지 않는다.
- 각 결함은 어디에서 무엇이 왜 틀렸는지 구체적으로 쓰고, rule에 기준 항목 이름(${RULE_NAMES}) 하나를 쓴다. 학습을 어겼으면 rule은 "학습"이고 detail 앞에 그 학습 문장을 인용한다.
- 한국어로 쓴다. JSON만 출력한다.

[검수 기준]
${criteria}
[이 문제에 적용되는 학습 — 분석]
${ruleLines([...learnedA.guides, ...learnedA.own, ...learnedA.lessons])}

[이 문제에 적용되는 학습 — 변형 문제와 해설]
${ruleLines(learnedG)}

반환 형식:
{"analysis":{"verdict":"ok|issues","issues":[{"severity":"high|mid|low","rule":"...","where":"문제/STEP n","detail":"..."}]},
 "items":[{"label":"...","myAnswer":"내가 푼 정답 번호와 핵심 값","markedAnswer":3,"answerOk":true,"verdict":"use|fix|reject","issues":[{"severity":"high|mid|low","rule":"...","detail":"..."}]}],
 "summary":"전체 평가 두세 문장"}`;
const items = (set?.items || []).filter((it) => it.problem);
const text = [
  `[원본 문제를 AI가 옮겨 적은 것]\n${m.problem.text}\n${choices(m.problem)}\n정답: ${m.problem.answer}번`,
  `\n[AI가 원본 해설을 STEP으로 정리한 것]\n${m.steps.map((s, i) => `STEP ${i + 1}. ${s.title}\n${s.work}`).join('\n\n')}`,
  items.length ? `\n[AI가 만든 변형 세트]\n${items.map((it) => [
    `### ${it.label} — 목표: ${range(it.stage)}`, it.problem.text, choices(it.problem), `표시된 정답: ${it.problem.answer}번`,
    '해설:', ...(it.solution?.steps || []).map((s) => `STEP ${s.step}. ${s.title}\n${s.work}`), it.solution?.summary ? `정리: ${it.solution.summary}` : '',
  ].filter(Boolean).join('\n')).join('\n\n')}` : '\n[변형 세트 없음 — 분석 결과만 검토한다]',
  '\n위 원본 이미지와 대조해 분석 결과를 검토하고, 변형 문제를 하나씩 직접 풀어 검토하라.',
].join('\n');
const images = [...imgs('원본 문제', m.images.problem, m.images.views?.problem), ...imgs('원본 해설', m.images.solution, m.images.views?.solution)];

const ready = { 'claude-cli': () => claudeCliReady(cfg), 'agy-cli': () => cli.cliReady(cfg, 'agy-cli'), 'codex-cli': () => cli.cliReady(cfg, 'codex-cli') };
const result = {
  material: { id: m.id, title: m.title, subject: m.subject, topic: m.topic, problem: m.problem.text, choices: m.problem.choices || [], answer: m.problem.answer, steps: m.steps.map((x) => ({ title: x.title, work: x.work })) },
  set: set ? { id: set.id, createdAt: set.createdAt, provider: set.options?.provider, items: items.map((it) => ({ label: it.label, status: it.status, stage: range(it.stage), problem: it.problem.text, choices: it.problem.choices || [], answer: it.problem.answer, solution: (it.solution?.steps || []).map((x) => ({ step: x.step, title: x.title, work: x.work })) })) } : null,
  at: new Date().toISOString(), reviews: {}, done: false,
};
const save = () => fs.writeFileSync(out, JSON.stringify(result, null, 1));
save();
(async () => {
  await Promise.all(providers.map(async (p) => {
    const started = Date.now();
    try {
      if (ready[p] && !(await ready[p]())) throw new Error('서버에 연결되어 있지 않습니다 (LLM 탭에서 연결)');
      const budget = new Budget({ maxCalls: 2, maxTokens: 3000000 });
      const r = await llm.json({ provider: p, purpose: 'review', budget, system, text, images, vision: true, maxTokens: 32000, effort: 'high' });
      result.reviews[p] = { seconds: Math.round((Date.now() - started) / 1000), usage: r.usage, review: r.data };
    } catch (e) {
      result.reviews[p] = { error: e.message, seconds: Math.round((Date.now() - started) / 1000) };
    }
    save();
  }));
  result.done = true;
  save();
})();
