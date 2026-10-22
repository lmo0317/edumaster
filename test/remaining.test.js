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

// 2026-10-09: 42% of the solution reviews of eight Opus sets were thrown away by the repair that followed. A review
// now runs only when the problem needs no repair, and once for the version the teacher gets.
test('the solution review is skipped while a repair is due, and run once for the version that is kept', async () => {
  const solves = [{ answer: 3, stepsUsed: [1, 2] }, { answer: 3, stepsUsed: [1] }];
  let reviews = 0;
  const llm = { json: async ({ system }) => {
    if (system === prompts.SOLVE_SYSTEM) return { data: solves.shift() };
    if (system === prompts.SOLUTION_REVIEW_SYSTEM) { reviews++; return { data: { steps: [], rules: [] } }; }
    return { data: generated(1) };
  } };
  const ctx = { llm, job: { id: 'j' }, budget: new Budget({ maxCalls: 40, maxTokens: 1e6 }), effort: { generate: 'low', solve: 'low' }, maxRepairs: 2, save() {}, log() {} };
  const item = { index: 0, label: 'STEP 1 연습', stage: { kind: 'upto', upto: 1 }, variantNo: 1 };
  await produceItem(ctx, { material, item, prior: [], rules: [], mode: 'integrated' });
  assert.equal(item.attempts.filter((a) => a.kind === 'repair').length, 1, 'the first version is out of range: one repair');
  assert.equal(reviews, 1, 'only the repaired version is reviewed');
  assert.equal(item.verification.solutionReview.skipped, undefined);
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
test('clean numbers and the call cap per set size', () => {
  const harness = require('../server/harness');
  const item = (text, work = '') => ({ stage: { kind: 'twin' }, problem: { text, choices: [], answer: 1 }, solution: { steps: [{ step: 1, title: 't', work }] } });
  const clean = (t) => harness.inspectItem({ steps: [], problem: { text: '', choices: [] } }, item(t), 'integrated').find((c) => c.id === 'clean-numbers').state;
  assert.deepEqual(['0.125 mol', '22.4 L', '1.732', '0.333 g'].map(clean), ['pass', 'pass', 'fail', 'fail']);
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

// From the gpt-oss run (2026-10-04): a set made by the PC model gets the PC call cap; a program line with comments or
// several lines still runs; a solution title loses a "STEP 1." the model put in front and gets the original's numerals.
test('PC call cap, commented program lines, and STEP titles as the teacher wrote them', () => {
  const { normalize } = require('../server/verify');
  assert.deepEqual(normalize({ program: ['a=1', '// n = m from equations\nn=1  // guess', '# note', 'b=a+n'], answer: 'b', choices: ['1', '2'] }, 2).spec.program, ['a=1', 'n=1', 'b=a+n']);
  const { normalizeGenerated } = require('../server/pipeline');
  const titles = normalizeGenerated({ problem: { text: '문제 본문입니다', choices: ['1', '2'], answer: 1 }, solution: { steps: [{ step: 1, title: 'STEP 1. I에서 한계 반응물을 구한다.', work: 'w' }, { step: 2, title: 'I ~ III에서 구한다', work: 'w' }] } }).solution.steps.map((s) => s.title);
  assert.deepEqual(titles, ['Ⅰ에서 한계 반응물을 구한다.', 'Ⅰ ~ Ⅲ에서 구한다']);
  // Every loaded rule (selectRules gives up to 40) keeps its note.
  const notes = normalizeGenerated({ problem: { text: '문제 본문입니다', choices: ['1', '2'], answer: 1 }, appliedRules: Array.from({ length: 40 }, (_, i) => ({ id: `r${i}`, how: '지킴' })) }).appliedRules;
  assert.equal(notes.length, 40);
  // The independent solver is told whether it judges the rules on a practice or the final problem.
  const { solveParts } = require('../server/prompts');
  const solveFor = (kind) => solveParts({ item: { stage: { kind }, problem: { text: '문제' } }, material: { steps: [{ title: 't' }], problem: { text: '' } }, rules: [{ id: 'r', text: '합답형 최종 문제는 …', target: 'problem' }] }).context;
  assert.match(solveFor('upto'), /이 문제는 연습 문제다/);
  assert.match(solveFor('twin'), /이 문제는 최종 문제다/);
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  const { createJobs } = require('../server/jobs');
  const config = require('../server/config');
  const { openStore } = require('../server/store');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'em2-pc-'));
  const jobs = createJobs({ store: openStore(dataDir), llm: { json: async () => { throw new Error('not called'); } }, config: { ...config, dataDir } });
  const cap = (provider) => jobs.generate({ material: { id: 'c'.repeat(24), title: 'm' }, items: [{}, {}, {}], rules: [], options: { provider } }).budget.maxCalls;
  assert.deepEqual([cap('gemma'), cap('claude-cli')], [120, 60]);
});

// 2026-10-19: a problem counts as made only once it passes the final review a finished set gets (review-criteria.md):
// sets the generation called finished kept failing that review afterwards.
function gated(reviews) {
  const solves = [];
  const purposes = [];
  let made = 0;
  const llm = { json: async ({ system, purpose }) => {
    purposes.push(purpose);
    if (purpose === 'final-review') return { data: reviews.shift() };
    if (system === prompts.SOLVE_SYSTEM) return { data: solves.shift() || { answer: 3, stepsUsed: [1] } };
    if (system === prompts.SOLUTION_REVIEW_SYSTEM) return { data: { steps: [], rules: [] } };
    return { data: generated(++made) };
  } };
  const ctx = { llm, job: { id: 'j', rules: [] }, budget: new Budget({ maxCalls: 60, maxTokens: 1e7 }), effort: { generate: 'low', solve: 'low' }, maxRepairs: 2, maxDesigns: 2, finalGate: true, save() {}, log() {} };
  const item = { index: 0, label: 'STEP 1 연습', stage: { kind: 'upto', upto: 1 }, variantNo: 1 };
  return produceItem(ctx, { material, item, prior: [], rules: [], mode: 'integrated' }).then(() => ({ item, purposes }));
}
const verdict = (v, issues = []) => ({ analysis: { verdict: 'ok', issues: [] }, items: [{ label: 'STEP 1 연습', answerOk: true, verdict: v, issues }] });

test('what the final review finds is repaired before the problem counts as made', async () => {
  const { item, purposes } = await gated([verdict('fix', [{ severity: 'mid', rule: '조건', detail: '실험이 하나인데 "달리하여"가 남음' }]), verdict('use')]);
  assert.equal(purposes.filter((p) => p === 'final-review').length, 2);
  const repair = item.attempts.find((a) => a.kind === 'repair');
  assert.match(repair.failures.join(), /최종 검수: \[조건 · mid\] 실험이 하나인데/);
  assert.equal(item.status, 'passed');
  assert.equal(item.finalReview.passed, true);
});

test('a problem that never passes the final review is not made: it waits for the teacher with what is left', async () => {
  const bad = () => verdict('fix', [{ severity: 'mid', rule: 'STEP 범위', detail: '지름길로 풀림' }]);
  const { item } = await gated(Array.from({ length: 10 }, bad));
  assert.equal(item.status, 'needs_review');
  assert.equal(item.finalReview.passed, false);
  assert.match(item.problems.join(), /최종 검수: \[STEP 범위 · mid\] 지름길로 풀림/);
});

test('a wrong answer found by the final reviewer is a fault even when its verdict says use', async () => {
  const wrong = { analysis: { verdict: 'ok', issues: [] }, items: [{ answerOk: false, myAnswer: '④ 6', markedAnswer: 3, verdict: 'use', issues: [] }] };
  const { item } = await gated([wrong, verdict('use')]);
  assert.match(item.attempts.find((a) => a.kind === 'repair').failures.join(), /직접 푼 정답은 ④ 6/);
  assert.equal(item.status, 'passed');
});

// chem-c32-molar-volume (2026-10-19): the solution review and the final review judged the same solution and disagreed.
test('with the final review on, the solution is judged by that review alone and a fault only there is a rewrite', async () => {
  const { item, purposes } = await gated([verdict('fix', [{ severity: 'mid', rule: '풀이 방식', detail: '선생님과 다른 순서로 풂' }]), verdict('use')]);
  assert.equal(purposes.filter((p) => p === 'final-review').length, 2);
  assert.ok(!purposes.includes('solution-review') && !purposes.includes('review-solution'), purposes.join());
  const rewrite = item.attempts.find((a) => a.kind === 'rewrite');
  assert.match(rewrite.failures.join(), /최종 검수: \[풀이 방식 · mid\]/);
  assert.ok(!item.attempts.some((a) => a.kind === 'repair'), 'the problem was not redesigned for its solution');
  assert.equal(item.status, 'passed');
});

// The gas original's 학습 반복 (2026-10-21): its final went through 13 repairs and 3 designs over low notes on a STEP
// title the system writes, and was not made.
test('a low note alone never holds a problem back: it passes with the note kept, and the note is not learned', async () => {
  const { itemFaults } = require('../server/final-review');
  const low = { items: [{ answerOk: true, verdict: 'fix', issues: [{ severity: 'low', rule: 'STEP 제목', detail: '마침표 없음' }] }] };
  assert.deepEqual(itemFaults(low), []);
  assert.equal(itemFaults({ items: [{ answerOk: true, verdict: 'use', issues: [{ severity: 'mid', rule: '구조', detail: '숫자만 바꿈' }] }] }).length, 1, 'a mid fault holds it back even under use');
  assert.equal(itemFaults({ items: [{ answerOk: false, myAnswer: '②', verdict: 'use', issues: [] }] }).length, 1);
  const { item, purposes } = await gated([verdict('fix', [{ severity: 'low', rule: '표기', detail: '수식이 $ 밖에 있음' }])]);
  assert.equal(purposes.filter((p) => p === 'final-review').length, 1, 'no rewrite for a low note');
  assert.equal(item.status, 'passed');
  assert.match(item.warnings.join(), /최종 검수 참고: \[표기 · low\]/);
});

// The set page shows the 모델 비교 checklist filled from each problem's final review (server/final-review.js).
test('a final review fills the checklist rows: a mid fault is ✕, a low one only a note, the final-only row is – for practice', () => {
  const { checklistOf } = require('../server/final-review');
  const review = { answerOk: true, myAnswer: '③ 6', checks: { 정답: 'ok', 조건: 'fix', 구조: 'na', '정답 줄': 'fix' },
    issues: [{ severity: 'mid', rule: '조건', detail: '"달리하여"가 남음' }, { severity: 'low', rule: '정답 줄', detail: '정답 줄 없음' }] };
  const rows = checklistOf(review);
  assert.deepEqual(rows.clean, ['no', '"달리하여"가 남음']);
  assert.deepEqual(rows.method, ['ok', '정답 줄 없음'], 'a low note costs no score');
  assert.equal(checklistOf({ checks: { 조건: 'fix' }, issues: [] }).clean[0], 'partial', 'fix without a fault named is △');
  assert.deepEqual(rows.correct, ['ok', '검수자 풀이 ③ 6']);
  assert.equal(rows.final[0], 'na');
  assert.equal(rows.read, undefined, 'the analysis rows come from the analysis review');
  assert.equal(checklistOf({ ...review, answerOk: false }).correct[0], 'no');
  assert.equal(checklistOf({ checks: {}, issues: [{ severity: 'high', rule: '구조', detail: '숫자만 바뀜' }] }, { final: true }).final[0], 'no');
  assert.deepEqual(checklistOf({ checks: { 판독: 'ok' }, issues: [{ severity: 'mid', rule: '용어', detail: '몰질량을 물질량으로' }] }, { analysis: true }).read, ['no', '몰질량을 물질량으로']);
});

// chem-c38-gas-density (2026-10-19): the solver's "unused condition" took out a cylinder the final review wanted back,
// round and round. With the final review on, such a judgement is its hint, not a repair of its own.
test('with the final review on, a condition the solver did not use is weighed by that review, not repaired on its own', async () => {
  const texts = [];
  let made = 0;
  const llm = { json: async ({ system, purpose, text }) => {
    if (purpose === 'final-review') { texts.push(text); return { data: verdict('use') }; }
    if (system === prompts.SOLVE_SYSTEM) return { data: { answer: 3, stepsUsed: [1], conditions: [{ text: '(가)의 Y/X 원자 수 = 1', used: false }] } };
    if (system === prompts.SOLUTION_REVIEW_SYSTEM) return { data: { steps: [], rules: [] } };
    return { data: generated(++made) };
  } };
  const ctx = { llm, job: { id: 'j', rules: [] }, budget: new Budget({ maxCalls: 60, maxTokens: 1e7 }), effort: { generate: 'low', solve: 'low' }, maxRepairs: 2, finalGate: true, save() {}, log() {} };
  const item = { index: 0, label: 'STEP 1 연습', stage: { kind: 'upto', upto: 1 }, variantNo: 1 };
  await produceItem(ctx, { material, item, prior: [], rules: [], mode: 'integrated' });
  assert.equal(item.attempts.filter((a) => a.kind === 'repair').length, 0);
  assert.match(texts[0], /앞선 자동 검토가 짚은 점[\s\S]*풀이에 쓰이지 않는 조건: \(가\)의 Y\/X 원자 수 = 1/);
  assert.equal(item.status, 'passed');
});

test('with the final review on, a set learns what that review found, not the solution review back-and-forth', async () => {
  const { learnFromSet } = require('../server/pipeline');
  let sent = '';
  const put = [];
  const item = (finalReview, failures) => ({ label: 'p', finalReview, problems: [], warnings: ['해설: 교사 해설에 없는 역산'], attempts: [{ kind: 'rewrite', failures }] });
  const job = {
    id: 'j', materialId: 'm', title: 't', material: { subject: '화학', problem: { text: '' }, steps: [] },
    items: [
      { ...item({ passed: true, faults: [] }, ['해설이 선생님 해설과 다름 (STEP 3): 교사 해설에 없는 역산']), attempts: [
        { kind: 'rewrite', failures: ['해설이 선생님 해설과 다름 (STEP 3): 교사 해설에 없는 역산'] },
        { kind: 'repair', failures: ['최종 검수: [구조 · mid] 원본과 같은 구조'] },
      ] },
      item({ passed: true, faults: [] }, ['해설이 선생님 해설과 다름: 36L를 근거 없이 씀']),
    ],
  };
  const ctx = {
    job, store: { rules: { all: () => [], put: (r) => put.push(r) } }, budget: new Budget({ maxCalls: 5, maxTokens: 1e6 }),
    effort: { solve: 'low' }, signal: {}, log() {}, save() {},
    llm: { json: async ({ text }) => { sent = text; return { data: { items: [{ text: '최종 문제는 원본과 다른 구조로 만든다.', scope: 'problem' }] } }; } },
  };
  await learnFromSet(ctx);
  assert.match(sent, /원본과 같은 구조/);
  assert.doesNotMatch(sent, /역산|36L/);
  assert.equal(put.length, 1);
  // A set none of whose problems went past a final-review fault learns nothing.
  sent = ''; put.length = 0;
  job.items = [job.items[1]];
  await learnFromSet(ctx);
  assert.equal(sent, '');
  assert.equal(put.length, 0);
});

// chem-c32-molar-volume (2026-10-19): STEP 1~2's (가) was the original's (나), 23 g and the hidden a = 12.
test('a row that gives as numbers what the original hid (a = 12 in its solution) reuses the original', () => {
  const head = '| 기체 | 분자식 | 질량(g) | 분자량 | 부피(L) | 전체 원자 수(상댓값) |\n|---|---|---|---|---|---|\n';
  const material = { problem: { text: head + '| (가) | $\mathrm{XY_2}$ | 18 |  | 8 | 1 |\n| (나) | $\mathrm{ZX_2}$ | 23 |  | $a$ | 1.5 |' }, steps: [{ work: '따라서 (나)의 부피는 12L이고, $a=12$이다.' }] };
  const at = (rows) => ({ problem: { text: head + rows }, stage: { kind: 'upto' } });
  assert.match(numbersReused(at('| (가) | $\mathrm{XY_2}$ | 23 |  | 12 | 1 |'), [], material).join(), /원본의 실험 수치\(23,12\)/);
  assert.deepEqual(numbersReused(at('| (가) | $\mathrm{XY_2}$ | 16 |  | 6 | 1 |'), [], material), []);
  // Asking for the value the original hid (a = 12 again) is a remembered answer.
  const asks = (a) => ({ ...at(`| (가) | $\mathrm{XY_2}$ | 16 |  | 6 | 1 |
| (나) | $\mathrm{ZX_2}$ | 22 |  | $a$ | 2 |`), solution: { steps: [{ work: `(나)의 부피는 ${a}L이고, $a=${a}$이다.` }] } });
  assert.match(numbersReused(asks(12), [], material).join(), /숨긴 값과 같은 값\(a=12\)/);
  assert.deepEqual(numbersReused(asks(9), [], material), []);
});

// chem-c32-molar-volume (2026-10-19): the analysis review found the teacher's '/몰' moved; every solution followed it.
test('what the analysis review finds is fixed against the original before the problems, and reviewed again', async () => {
  const { reviewAnalysis } = require('../server/pipeline');
  const material = { problem: { text: '표', choices: ['ㄱ'], answer: 1 }, steps: [{ title: 'S1', work: '분자량$=\frac{18g}{\frac{8L}{24L/몰}}$이다.' }], frames: [{ step: 1 }] };
  let stored = { id: 'm', ...JSON.parse(JSON.stringify(material)) };
  const calls = [];
  const reviews = [
    { analysis: { verdict: 'issues', issues: [{ severity: 'low', rule: '표기', where: 'STEP 1', detail: "'/몰'은 분자 쪽 8L에 붙어 있다" }] }, items: [] },
    { analysis: { verdict: 'ok', checks: { 판독: 'ok' }, issues: [] }, items: [] },
  ];
  const llm = { json: async ({ purpose, text }) => {
    calls.push(purpose);
    if (purpose === 'fix-analysis') { assert.match(text, /분자 쪽 8L/); return { data: { fixes: [{ field: 'steps[0].work', wrong: '\frac{8L}{24L/몰}', right: '\frac{8L/몰}{24L}' }] } }; }
    return { data: reviews.shift() };
  } };
  const store = { materials: { get: () => stored, put: (m) => { stored = m; } }, rules: { all: () => [] }, files: null };
  const ctx = { llm, store, job: { id: 'j', materialId: 'm', rules: [] }, budget: new Budget({ maxCalls: 60, maxTokens: 1e7 }), effort: { solve: 'low' }, save() {}, log() {} };
  await reviewAnalysis(ctx, material);
  assert.deepEqual(calls, ['final-review', 'fix-analysis', 'final-review']);
  assert.match(material.steps[0].work, /\frac\{8L\/몰\}\{24L\}/);
  assert.equal(material.frames, undefined, 'the frames are cut again from the fixed analysis');
  assert.match(stored.steps[0].work, /\frac\{8L\/몰\}\{24L\}/);
  assert.equal(stored.analysisFixes.length, 1);
  assert.equal(ctx.job.analysisReview.verdict, 'ok');
  assert.equal(ctx.job.analysisReview.fixed.length, 1);
  // The next set of this original finds the fixed analysis reviewed: no call.
  calls.length = 0;
  await reviewAnalysis({ ...ctx, job: { id: 'j2', materialId: 'm', rules: [] } }, JSON.parse(JSON.stringify(stored)));
  assert.deepEqual(calls, []);
});

test('a fault the review of the fixed analysis finds is fixed in a second round', async () => {
  const { reviewAnalysis } = require('../server/pipeline');
  const material = { problem: { text: '표', choices: ['ㄱ'], answer: 1 }, steps: [{ title: 'S1', work: 'A이다. B이다.' }] };
  let stored = { id: 'm', ...JSON.parse(JSON.stringify(material)) };
  const issue = (d) => ({ analysis: { verdict: 'issues', issues: [{ severity: 'low', rule: '풀이 방식', detail: d }] }, items: [] });
  const reviews = [issue('A가 다름'), issue('B가 다름'), { analysis: { verdict: 'ok', issues: [] }, items: [] }];
  const fixes = [{ field: 'steps[0].work', wrong: 'A이다', right: 'A1이다' }, { field: 'steps[0].work', wrong: 'B이다', right: 'B1이다' }];
  const calls = [];
  const llm = { json: async ({ purpose }) => { calls.push(purpose); return { data: purpose === 'fix-analysis' ? { fixes: [fixes.shift()] } : reviews.shift() }; } };
  const ctx = { llm, store: { materials: { get: () => stored, put: (m) => { stored = m; } }, rules: { all: () => [] } }, job: { id: 'j', materialId: 'm', rules: [] }, budget: new Budget({ maxCalls: 60, maxTokens: 1e7 }), effort: { solve: 'low' }, save() {}, log() {} };
  await reviewAnalysis(ctx, material);
  assert.deepEqual(calls, ['final-review', 'fix-analysis', 'final-review', 'fix-analysis', 'final-review']);
  assert.equal(material.steps[0].work, 'A1이다. B1이다.');
  assert.equal(stored.steps[0].work, 'A1이다. B1이다.');
  assert.deepEqual([ctx.job.analysisReview.verdict, ctx.job.analysisReview.fixed.length], ['ok', 2]);
});

test('the reviewers read a variant\'s figure with it (the worksheet prints it), not the original\'s', () => {
  const finalReview = require('../server/final-review');
  const m = { subject: '생명과학', problem: { text: '그림은 지점의 위치이다.', figure: '$d_1=0$, $d_2=2$', choices: [], answer: 1 }, steps: [{ title: 'a', work: 'b' }] };
  const it = { label: 'STEP 1 연습', stage: { kind: 'upto', upto: 1 }, problem: { text: '그림은 지점의 위치이다.', figure: '$d_1=0$, $d_2=4$', choices: ['x'], answer: 1 }, solution: { steps: [] } };
  for (const text of [finalReview.setText(m, [it]), finalReview.itemReviewText(m, it)]) {
    assert.match(text, /\$d_2=4\$/);
    assert.match(text, /\$d_2=2\$/);
  }
});

test('the reviewers read a STEP that ends in a table as its own block, not one more row of the table', () => {
  const finalReview = require('../server/final-review');
  const m = { subject: '생명과학', problem: { text: '원본', choices: [], answer: 1 }, steps: [{ title: 'a', work: 'b' }] };
  const table = '| ㉠ | X |\n|---|---|\n| $0.8$ | $3.6$ |';
  const it = { label: '최종 문제', stage: { kind: 'twin' }, problem: { text: '변형', choices: [], answer: 1 },
    solution: { steps: [{ step: 1, title: 'F₁', work: table }, { step: 2, title: 'F₂', work: table }], summary: '끝' } };
  for (const text of [finalReview.setText(m, [it]), finalReview.itemReviewText(m, it)]) {
    assert.match(text, /\$3\.6\$ \|\n\nSTEP 2\. F₂/);
    assert.match(text, /\$3\.6\$ \|\n\n정리: 끝/);
  }
});

test('학습 반복 reaches its target only when every reviewer scored the set', () => {
  const setCheck = require('../server/set-check');
  const record = (models, reviews) => ({ set: { items: [] }, reviews, checklist: { models } });
  const both = record({ 'claude-cli': { score: 94 }, 'agy-cli': { score: 100 } }, { 'claude-cli': {}, 'agy-cli': {} });
  assert.equal(setCheck.reaches(both, 90), true);
  assert.equal(setCheck.reaches(both, 95), false);
  // On 2026-10-21 Claude's review hit the subscription's limit and Gemini's 100 alone was taken as reached.
  const one = record({ 'agy-cli': { score: 100 } }, { 'claude-cli': { error: "You've hit your session limit" }, 'agy-cli': {} });
  assert.deepEqual(setCheck.scores(one), { 'claude-cli': null, 'agy-cli': 100 });
  assert.equal(setCheck.reaches(one, 90), false);
});

test("the lessons a problem's own reviews taught reach its next set first, the closest and newer lessons next", () => {
  const { selectRules } = require('../server/learning');
  const r = (id, text, extra = {}) => ({ id, text, status: 'approved', stage: 'generation', scope: 'global', layer: 'lesson', createdAt: `2026-10-${id}`, ...extra });
  // Oldest-first under the cap sent 1-2 of the 4-7 lessons the gas original's 학습 반복 had learned (2026-10-21).
  const old = Array.from({ length: 50 }, (_, i) => r(String(10 + i).padStart(2, '0') + 'a', `오래된 일반 교훈 ${i} `.repeat(6)));
  const mine = [r('21x', '최종 문제는 기체 행을 추가하지 않는다', { source: { materialId: 'gas', from: 'review' } }), r('21y', '해설의 수는 표에 주어진 값에서 온다', { source: { materialId: 'gas', from: 'review' } })];
  const close = r('05c', '기체의 분자량과 부피 비로 전체 원자 수를 구하는 문제는 행 배수를 쓰지 않는다');
  const picked = selectRules([...old, close, ...mine], { id: 'gas', subject: '화학', problem: { text: '기체 (가)~(다)의 분자량, 부피, 전체 원자 수' } }).map((x) => x.id);
  assert.deepEqual([...picked.slice(0, 2)].sort(), ['21x', '21y'], "this problem's own lessons first");
  assert.equal(picked[2], '05c', 'then the closest');
  assert.ok(picked.length > 24, `more than 24 fit in the characters (${picked.length})`);
});

// The original's setting under another face (생명 D50 and E38, 2026-10-21): only a row's first two amounts were compared.
test('a row or the figure scaled by one factor, or a row keeping most amounts in their columns, is reused numbers', () => {
  const material = { problem: { text: table(['| Ⅰ | $5w$ | $5w$ | $2w$ |', '| Ⅱ | $4w$ | $6w$ | $3w$ |']), figure: '위치 눈금: $d_1=0$, $d_2=2$, $d_3=5$, $d_4=7$ (cm).' } };
  const twin = (rows, figure = '') => ({ index: 2, stage: { kind: 'twin' }, problem: { text: table(rows), figure } });
  assert.match(numbersReused(twin(['| Ⅱ | $8w$ | $12w$ | $6w$ |']), [], material).join(), /원본의 Ⅱ 행 수치를 모두 2배 한 값/);
  assert.match(numbersReused(twin(['| Ⅱ | $7w$ | $6w$ | $3w$ |']), [], material).join(), /원본의 Ⅱ 행과 같은 칸에 같은 수치가 2개/);
  assert.match(numbersReused(twin(['| Ⅱ | $7w$ | $9w$ | $5w$ |'], '$d_1=0$, $d_2=6$, $d_3=15$, $d_4=21$ (cm)'), [], material).join(), /원본의 d1, d2, d3, d4 값을 모두 3배 했습니다/);
  // A ratio that is not a whole factor is a coincidence, 0 and 1 match by themselves, and a practice problem may keep the setting.
  assert.deepEqual(numbersReused(twin(['| Ⅱ | $5w$ | $7.5w$ | $1w$ |', '| Ⅰ | $1$ | $5w$ | $9w$ |']), [], material), []);
  assert.deepEqual(numbersReused({ ...twin(['| Ⅱ | $7w$ | $9w$ | $5w$ |'], '$d_1=0$, $d_2=4$, $d_3=10$, $d_4=14$'), stage: { kind: 'upto', upto: 1 } }, [], material), []);
});

test("a set's score counts each problem's mark on each row, so one problem's fault is not a ninth of it", () => {
  const setCheck = require('../server/set-check');
  const clean = { answerOk: true, verdict: 'use', checks: {}, issues: [] };
  const fault = { ...clean, verdict: 'fix', issues: [{ severity: 'mid', rule: '구조', detail: '숫자만 바뀜' }] };
  const record = (items) => ({ set: { items: [{ label: 'STEP 1 연습', status: 'passed' }, { label: 'STEP 1~2 연습', status: 'passed' }, { label: '최종 문제', status: 'passed', kind: 'twin' }] },
    reviews: { 'claude-cli': { review: { analysis: { verdict: 'ok', issues: [], checks: { 판독: 'ok' } }, items } } } });
  const all = setCheck.checklist(record([clean, clean, clean])).models['claude-cli'];
  const one = setCheck.checklist(record([clean, clean, fault])).models['claude-cli'];
  assert.equal(all.score, 100);
  assert.equal(one.marks.final[0], 'no', 'the row still shows its worst problem');
  assert.ok(one.score >= 90 && one.score < 100, `one fault in one of three problems: ${one.score}`);
});

test('a problem the final review passes is looked at by the second reviewer too, and its faults are repaired', async () => {
  const { finalGate } = require('../server/pipeline');
  const material = { problem: { text: '원본', choices: [] }, steps: [{ title: 'S', work: 'w' }] };
  const item = { index: 0, label: '최종 문제', stage: { kind: 'twin' }, attempts: [], problem: { text: '변형', choices: [], answer: 1 }, solution: { steps: [] } };
  const clean = { analysis: { verdict: 'ok', issues: [] }, items: [{ label: '최종 문제', answerOk: true, verdict: 'use', issues: [] }] };
  const fault = { analysis: { verdict: 'ok', issues: [] }, items: [{ label: '최종 문제', answerOk: true, verdict: 'fix', issues: [{ severity: 'mid', rule: '구조', detail: '원본과 구조가 같다' }] }] };
  const calls = [];
  const ctx = (second, answers) => ({ job: { id: 'j', materialId: 'm', rules: [] }, budget: new Budget({ maxCalls: 10, maxTokens: 1000000 }), signal: new AbortController().signal, effort: {}, secondReviewer: second, log() {}, save() {},
    llm: { json: async (args) => { calls.push(args.purpose); const a = answers[args.purpose]; if (a instanceof Error) throw a; return { data: a }; } } });
  const failed = await finalGate(ctx('agy-cli', { 'final-review': clean, 'final-review-second': fault }), item, material, []);
  assert.deepEqual(calls, ['final-review', 'final-review-second']);
  assert.match(failed.faults.join(), /\[두 번째 검수\].*원본과 구조가 같다/);
  assert.deepEqual((await finalGate(ctx('agy-cli', { 'final-review': clean, 'final-review-second': clean }), item, material, [])).faults, []);
  assert.deepEqual((await finalGate(ctx('agy-cli', { 'final-review': clean, 'final-review-second': new Error('limit') }), item, material, [])).faults, [], 'a second look that cannot be had leaves the first');
  calls.length = 0;
  await finalGate(ctx('agy-cli', { 'final-review': fault }), item, material, []);
  assert.deepEqual(calls, ['final-review'], 'what the first review fails is repaired without a second look');
});

test('the reviewer judges by the criteria and the teacher\'s learning; what the system learned itself is shown for reference only', () => {
  const { reviewSystem } = require('../server/final-review');
  const r = (id, text, from) => ({ id, text, status: 'approved', stage: 'generation', scope: 'global', layer: 'lesson', createdAt: '2026-10-01', source: from ? { from } : undefined });
  const system = reviewSystem({ id: 'm', subject: '생명과학', problem: { text: '' }, steps: [] }, [r('t', '선생님이 쓴 학습'), r('a', '검수에서 AI가 배운 학습', 'review'), r('b', '세트에서 AI가 배운 학습', 'auto')]);
  const teacher = system.slice(system.indexOf('[선생님 지침·학습 — 변형 문제와 해설]'), system.lastIndexOf('[AI가 정리한 학습'));
  const ai = system.slice(system.lastIndexOf('[AI가 정리한 학습'));
  assert.match(teacher, /선생님이 쓴 학습/);
  assert.doesNotMatch(teacher, /AI가 배운/);
  assert.match(ai, /검수에서 AI가 배운 학습[\s\S]*세트에서 AI가 배운 학습/);
  assert.match(system, /판정 기준이 아니다/);
  // '구조' is counted by the same five items as the independent solve.
  assert.ok(system.includes(require('../server/prompts').VARIATION_CRITERIA));
});
