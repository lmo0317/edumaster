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

test('the same complaint after a repair stops the loop (no token burn)', async () => {
  const item = await run([
    { answer: 3, stepsUsed: [1, 2] },
    { answer: 3, stepsUsed: [1, 2] },
    { answer: 3, stepsUsed: [1] },
  ]);
  assert.equal(item.attempts.filter((a) => a.kind === 'repair').length, 1);
  // A problem still outside its STEP range is not handed out as usable; the teacher sees why.
  assert.equal(item.status, 'needs_review');
  assert.match(item.problems.join(), /STEP 범위/);
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
  const budget = new Budget({ maxCalls: 20, maxTokens: 45000 });
  const solves = [{ answer: 3, stepsUsed: [1, 2] }];
  let made = 0;
  const llm = { json: async ({ system }) => {
    budget.reserve(); budget.add({ input: 0, output: 0, reasoning: 0, total: 10000 });
    return { data: system === prompts.SOLVE_SYSTEM ? solves.shift() : generated(++made) };
  } };
  const ctx = { llm, job: { id: 'j' }, budget, effort: { generate: 'low', solve: 'low' }, maxRepairs: 2, save() {}, log() {}, reserveCalls: 2 };
  const item = { index: 0, label: 'STEP 1 연습', stage: { kind: 'upto', upto: 1 }, variantNo: 1 };
  await produceItem(ctx, { material, item, prior: [], rules: [], mode: 'integrated' });
  assert.equal(item.attempts.filter((a) => a.kind === 'repair').length, 0);
  assert.ok(item.warnings.some((w) => w.includes('토큰 상한')), item.warnings.join(' | '));
  assert.ok(budget.affords(2), 'the next problem still fits');
});
