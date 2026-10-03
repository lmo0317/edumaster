'use strict';
// Follow-ups from the verification run: numbers copied from earlier problems, and a range problem left
// unfixed because the only repair was spent on something else.
const test = require('node:test');
const assert = require('node:assert/strict');
const { tableRows, numbersReused, produceItem } = require('../server/pipeline');
const prompts = require('../server/prompts');
const { Budget } = require('../server/llm');

const table = (rows) => ['| 실험 | 반응 전 $\\ce{A}$의 질량(g) | 반응 전 $\\ce{B}$의 질량(g) | 반응 후 |', '|---|---|---|---|', ...rows].join('\n');
const original = table(['| Ⅰ | $5w$ | $5w$ | $\\ce{A}$ $\\frac{10}{3}w$ |', '| Ⅱ | $4w$ | $6w$ | $\\ce{A}$ $2w$ |']);

test('table rows are read as the given amounts of each experiment', () => {
  assert.deepEqual(tableRows(original).map((r) => r.sig), ['5w,5w', '4w,6w']);
});

test('final problem reusing a practice problem\'s experiment numbers is flagged; new numbers pass', () => {
  const material = { problem: { text: original } };
  const practice = { index: 1, label: 'STEP 1~2 누적 연습', problem: { text: table(['| Ⅰ | $8w$ | $6w$ | $4w$ |', '| Ⅱ | $6w$ | $12w$ | $3w$ |']) } };
  const copied = { index: 2, stage: { kind: 'twin' }, problem: { text: table(['| Ⅰ | $8w$ | $6w$ | $10w$ |', '| Ⅱ | $3w$ | $9w$ | $2w$ |']) } };
  assert.deepEqual(numbersReused(copied, [practice], material), ['앞 문제(STEP 1~2 누적 연습)의 실험 수치(8w,6w)를 그대로 썼습니다 (Ⅰ 행).']);
  const fresh = { ...copied, problem: { text: table(['| Ⅰ | $9w$ | $3w$ | $6w$ |']) } };
  assert.deepEqual(numbersReused(fresh, [practice], material), []);
  const fromOriginal = { index: 0, stage: { kind: 'upto', upto: 1 }, problem: { text: table(['| Ⅰ | $4w$ | $6w$ | $2w$ |']) } };
  assert.match(numbersReused(fromOriginal, [], material).join(), /원본의 실험 수치\(4w,6w\)/);
});

const material = {
  subject: '화학', topic: '반응량', solutionSource: 'provided',
  problem: { text: original, choices: ['1', '2', '3', '4', '5'], answer: 2, figure: '' },
  steps: [{ title: 'S1', technique: 't1', work: 'w1' }, { title: 'S2', technique: 't2', work: 'w2' }],
};
const generated = (n) => ({
  problem: { text: `문제 ${n}\n` + table([`| Ⅰ | $${n + 10}w$ | $${n + 20}w$ | $1w$ |`]), choices: ['1', '2', '3', '4', '5'], answer: 3 },
  solution: { steps: [{ step: 1, title: 'S1', work: '3' }], summary: '3' }, usesSteps: [1], designNote: 'd', appliedRules: [],
  verification: { program: ['ans = 3'], answer: 'ans', choices: ['1', '2', '3', '4', '5'] },
});
function run(solves) {
  let made = 0;
  const llm = { json: async ({ system }) => ({ data: system === prompts.SOLVE_SYSTEM ? solves.shift() : generated(++made) }) };
  const ctx = { llm, job: { id: 'j' }, budget: new Budget({ maxCalls: 20, maxTokens: 1e6 }), effort: { generate: 'low', solve: 'low' }, maxRepairs: 2, save() {}, log() {} };
  const item = { index: 0, label: 'STEP 1 연습', stage: { kind: 'upto', upto: 1 }, variantNo: 1 };
  return produceItem(ctx, { material, item, prior: [], rules: [], mode: 'integrated' }).then(() => item);
}

test('a second repair is used when the first one fixed something but a new problem appeared', async () => {
  const item = await run([
    { answer: 3, stepsUsed: [1], issues: [{ type: 'contradiction', detail: '조건 모순' }] },
    { answer: 3, stepsUsed: [1, 2] },
    { answer: 3, stepsUsed: [1] },
  ]);
  assert.equal(item.attempts.filter((a) => a.kind === 'repair').length, 2);
  assert.equal(item.status, 'passed');
});

test('the same complaint after a repair stops the repairs (no token burn); one fresh design follows', async () => {
  const solves = [
    { answer: 3, stepsUsed: [1, 2] },
    { answer: 3, stepsUsed: [1, 2] }, // the repair did not change the complaint: stop repairing
    { answer: 3, stepsUsed: [1] }, // the fresh design is in range
  ];
  const item = await run(solves);
  assert.equal(solves.length, 0, 'two solves for the first design (no second repair), one for the fresh design');
  assert.equal(item.redesigned, 1);
  assert.equal(item.status, 'passed');
});

test('designs that keep the same fault: three designs, the best kept, the fault reported with the problem', async () => {
  const item = await run(Array.from({ length: 6 }, () => ({ answer: 3, stepsUsed: [1, 2] })));
  assert.equal(item.redesigned, 2, 'three designs in all');
  assert.equal(item.status, 'warning');
  assert.match(item.warnings.join(), /STEP 범위/);
  assert.deepEqual(item.attempts.map((a) => a.kind), ['generate', 'repair', 'redesign', 'generate', 'repair', 'redesign', 'generate', 'repair']);
});

// Opus bio run (2026-09-29): membrane potentials read off one shared curve were flagged as "reused numbers".
test('values of the original figure/table vocabulary (membrane potentials) are not reused experiment numbers', () => {
  const material = {
    problem: { text: '| 신경 | Ⅰ | Ⅱ | Ⅲ | Ⅳ |\n|---|---|---|---|---|\n| A | $-80$ | $0$ | ? | $0$ |\n| B | $0$ | $-60$ | ? | ? |',
      figure: '세로축 막전위(mV) 눈금 $+30$, $0$, $-60$, $-80$. 휴지 전위 $-70$' },
  };
  const item = { index: 2, stage: { kind: 'twin' }, problem: { text: '| 신경 | Ⅰ | Ⅱ |\n|---|---|---|\n| A | $0$ | $-60$ |\n| B | $+30$ | $-80$ |' } };
  assert.deepEqual(numbersReused(item, [], material), []);
  // A designed amount that happens to use a curve value together with a new one is still compared.
  const chem = { problem: { text: '| 실험 | A | B |\n|---|---|---|\n| Ⅰ | $5w$ | $5w$ |\n| Ⅱ | $4w$ | $6w$ |' } };
  assert.match(numbersReused({ index: 2, stage: { kind: 'twin' }, problem: { text: '| 실험 | A | B |\n|---|---|---|\n| Ⅰ | $4w$ | $6w$ |' } }, [], chem).join(), /원본의 실험 수치\(4w,6w\)/);
});

// DeepSeek bio run (2026-09-29): repairs of the practice problems used up the 600k-token cap and the final
// problem was never made. A repair now runs only if the later problems still fit.
test('a repair is skipped when it would leave too little budget for the problems still to come', async () => {
  // generate + solve + solution review use 30k; a repair round (3 calls) plus the next problem's 3 would not fit.
  const budget = new Budget({ maxCalls: 20, maxTokens: 65000 });
  const solves = [{ answer: 3, stepsUsed: [1, 2] }];
  let made = 0;
  const llm = { json: async ({ system }) => {
    budget.reserve(); budget.add({ input: 0, output: 0, reasoning: 0, total: 10000 });
    return { data: system === prompts.SOLVE_SYSTEM ? solves.shift() : generated(++made) };
  } };
  const ctx = { llm, job: { id: 'j' }, budget, effort: { generate: 'low', solve: 'low' }, maxRepairs: 2, save() {}, log() {}, reserveCalls: 3 };
  const item = { index: 0, label: 'STEP 1 연습', stage: { kind: 'upto', upto: 1 }, variantNo: 1 };
  await produceItem(ctx, { material, item, prior: [], rules: [], mode: 'integrated' });
  assert.equal(item.attempts.filter((a) => a.kind === 'repair').length, 0);
  assert.ok(item.warnings.some((w) => w.includes('토큰 상한')), item.warnings.join(' | '));
  assert.ok(budget.affords(3), 'the next problem still fits');
});

// 2026-10-02: a problem is made without stopping for the teacher; of its designs, the one with the fewest faults is kept.
test('of three designs the one with the fewest faults is kept: a later design with a wrong answer never replaces it', async () => {
  let designs = 0;
  const solves = [
    { answer: 3, stepsUsed: [1, 2] }, { answer: 3, stepsUsed: [1, 2] }, // design 1: out of range, answer right
    { answer: 4, stepsUsed: [1] }, { answer: 4, stepsUsed: [1] }, // design 2: another answer
    { answer: 4, stepsUsed: [1] }, { answer: 4, stepsUsed: [1] }, // design 3: the same
  ];
  const llm = { json: async ({ system }) => {
    if (system === prompts.SOLVE_SYSTEM) return { data: solves.shift() };
    if (system === prompts.GENERATE_SYSTEM) { designs++; return { data: { ...generated(designs), problem: { ...generated(designs).problem, text: `설계 ${designs}번째 문제` } } }; }
    if (system === prompts.REPAIR_SYSTEM) return { data: { ...generated(designs), problem: { ...generated(designs).problem, text: `설계 ${designs}번째 문제 고침` } } };
    return { data: { steps: [], rules: [] } };
  } };
  const ctx = { llm, job: { id: 'j' }, budget: new Budget({ maxCalls: 40, maxTokens: 1e6 }), effort: { generate: 'low', solve: 'low' }, maxRepairs: 2, save() {}, log() {} };
  const item = { index: 0, label: 'STEP 1 연습', stage: { kind: 'upto', upto: 1 }, variantNo: 1 };
  await produceItem(ctx, { material, item, prior: [], rules: [], mode: 'integrated' });
  assert.equal(designs, 3);
  assert.equal(item.design, 1);
  assert.equal(item.problem.text, '설계 1번째 문제 고침');
  assert.equal(item.status, 'warning', 'its answer checks out; the range fault is reported');
  assert.deepEqual(item.problems, []);
});

test('the solution reviewer compares only the STEPs of the problem\'s range', () => {
  const text = prompts.solutionReviewText({ item: { stage: { kind: 'upto', upto: 2 }, problem: { text: 'Q' }, solution: { steps: [] } },
    material: { steps: [{ title: 'S1', work: 'w1' }, { title: 'S2', work: 'w2' }, { title: 'S3', work: 'w3' }] }, rules: [] });
  assert.match(text, /STEP 3은 이 문제에 필요 없고/);
  assert.ok(text.includes('STEP 2. S2') && !text.includes('STEP 3. S3'));
  const withChoices = prompts.solutionReviewText({ item: { stage: { kind: 'twin' }, problem: { text: 'Q', choices: ['1', '2', '3'], answer: 2 }, solution: { steps: [] } }, material: { steps: [{ title: 'S1', work: 'w1' }] }, rules: [] });
  assert.ok(withChoices.includes('① 1  ② 2  ③ 3\n정답: ②'), 'the reviewer sees the choices and the answer');
});

// 2026-10-02 (Opus): a STEP 1~2 practice whose solution wrote the final calculation as "STEP 3 선택지 분석"; the title
// check and the solution review then contradicted each other through two rewrites.
test('a STEP beyond the practice range is folded into the range\'s last STEP', () => {
  const { fitSolutionToStage } = require('../server/pipeline');
  const item = { stage: { kind: 'upto', upto: 2 }, solution: { steps: [{ step: 1, title: 'a', work: 'w1' }, { step: 2, title: 'b', work: 'w2' }, { step: 3, title: '선택지 분석', work: '정답은 ③' }], summary: 's' } };
  assert.equal(fitSolutionToStage(item), true);
  assert.deepEqual(item.solution.steps.map((x) => [x.step, x.work]), [[1, 'w1'], [2, 'w2\n\n정답은 ③']]);
  const final = { stage: { kind: 'twin' }, solution: { steps: [{ step: 1, work: 'a' }, { step: 3, work: 'b' }] } };
  assert.equal(fitSolutionToStage(final), false, 'a final problem keeps every STEP');
});

// A Gemini set stopped fixing at 1.6M tokens after 9 calls (2026-10-03): a model that costs nothing per call is held
// by the call cap only; a paid API keeps its token cap.
test('subscription and PC jobs have no token cap; a paid API keeps it', () => {
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  const { createJobs } = require('../server/jobs');
  const config = require('../server/config');
  const { openStore } = require('../server/store');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'em2-cap-'));
  const store = openStore(dataDir);
  const jobs = createJobs({ store, llm: { json: async () => { throw new Error('not called'); } }, config: { ...config, dataDir } }); // the jobs start and fail at once (no such material): only their caps are read
  const material = { id: 'a'.repeat(24), title: 'm' };
  const cap = (provider, kind) => (kind === 'analyze' ? jobs.analyze(material, provider) : jobs.generate({ material, items: [], rules: [], options: { provider } })).budget;
  for (const p of ['agy-cli', 'claude-cli', 'codex-cli', 'gemma']) assert.equal(cap(p, 'generate').maxTokens, config.budget.perCallFreeTokens, p);
  assert.equal(cap('agy-cli', 'analyze').maxTokens, config.budget.perCallFreeTokens);
  assert.equal(cap('deepseek', 'generate').maxTokens, config.budget.generateTokens);
  assert.equal(cap('relay', 'analyze').maxTokens, config.budget.analyzeTokens);
  assert.equal(cap('agy-cli', 'generate').maxCalls, 60, 'the call cap still holds');
});

// 요구서 1: students have no calculator; a set can flip which case STEP 1 assumes; more problems get more calls.
test('clean numbers, assumption direction, and the call cap per set size', () => {
  const harness = require('../server/harness');
  const item = (text, work = '') => ({ stage: { kind: 'twin' }, problem: { text, choices: [], answer: 1 }, solution: { steps: [{ step: 1, title: 't', work }] } });
  const clean = (t) => harness.inspectItem({ steps: [], problem: { text: '', choices: [] } }, item(t), 'integrated').find((c) => c.id === 'clean-numbers').state;
  assert.deepEqual(['0.125 mol', '22.4 L', '1.732', '0.333 g'].map(clean), ['pass', 'pass', 'fail', 'fail']);
  const material = { steps: [{ title: 't', work: String.raw`만약 Ⅰ에서 $\ce{A}$가 모두 반응했다면 … 맞지 않다. 따라서 Ⅰ에서 모두 반응한 것은 B이다.` }, { title: 'u', work: '' }] };
  const dir = (work, d) => harness.checkDirection(material, item('', work), d)[0]?.state;
  assert.equal(dir('만약 Ⅱ에서 B가 모두 반응했다면 … 맞지 않다.', 'flip'), 'pass');
  assert.equal(dir('만약 Ⅱ에서 A가 모두 반응했다면 … 맞지 않다.', 'flip'), 'fail');
  assert.equal(dir('만약 Ⅱ에서 A가 모두 반응했다면 … 맞지 않다.', 'same'), 'pass');
  assert.equal(dir('가정 없이 바로 구한다.', 'flip'), undefined, 'not checked when the variant does not say');
  assert.equal(harness.checkDirection(material, item('', '만약 A가 모두 반응했다면'), '').length, 0, 'not asked');

  const { buildItems, normalizeStages } = require('../server/plan');
  const stages = normalizeStages([{ kind: 'twin' }, { kind: 'focus', step: 3 }, { kind: 'upto', upto: 1 }], 3);
  assert.deepEqual(buildItems(stages, 3, 2, 'numeric').map((i) => i.label), ['STEP 1 연습 (1)', 'STEP 1 연습 (2)', 'STEP 3 집중 연습 (앞 단계 결과 제공) (1)', 'STEP 3 집중 연습 (앞 단계 결과 제공) (2)', '쌍둥이 문제 (1)', '쌍둥이 문제 (2)']);

  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  const { createJobs } = require('../server/jobs');
  const config = require('../server/config');
  const { openStore } = require('../server/store');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'em2-calls-'));
  const jobs = createJobs({ store: openStore(dataDir), llm: { json: async () => { throw new Error('not called'); } }, config: { ...config, dataDir } });
  const calls = (n) => jobs.generate({ material: { id: 'b'.repeat(24), title: 'm' }, items: Array.from({ length: n }, (_, i) => ({ index: i })), rules: [], options: { provider: 'deepseek' } }).budget.maxCalls;
  assert.deepEqual([calls(3), calls(6), calls(12)], [60, 120, 150], 'the 하네스 cap is per three problems, up to the ceiling');
});
