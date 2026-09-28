'use strict';
// Teacher feedback (2026-09-29): unused conditions in generated problems, and an "integrated" final
// problem that only changed numbers. Both must trigger the single repair.
const test = require('node:test');
const assert = require('node:assert/strict');
const { produceItem } = require('../server/pipeline');
const prompts = require('../server/prompts');
const { Budget } = require('../server/llm');

const material = {
  subject: '화학', topic: '반응량', solutionSource: 'provided',
  problem: { text: '원본 표와 질문', choices: ['1', '2', '3', '4', '5'], answer: 2, figure: '' },
  steps: [{ title: 'S1', technique: 't1', work: 'w1' }, { title: 'S2', technique: 't2', work: 'w2' }],
  techniques: [],
};
const generated = (text) => ({
  problem: { text, choices: ['1', '2', '3', '4', '5'], answer: 3 },
  solution: { steps: [{ step: 1, title: 'a', work: '3' }], summary: '3' },
  usesSteps: [1, 2], designNote: 'd', appliedRules: [],
  verification: { program: ['ans = 3'], answer: 'ans', choices: ['1', '2', '3', '4', '5'] },
});

function fakeLlm(solveAnswers) {
  const calls = [];
  return {
    calls,
    json: async ({ system, text }) => {
      calls.push({ system, text });
      if (system === prompts.SOLVE_SYSTEM) return { data: solveAnswers.shift() };
      return { data: generated(system === prompts.REPAIR_SYSTEM ? '고친 문제' : '처음 문제') };
    },
  };
}

function ctxFor(llm) {
  return { llm, job: { id: 'j' }, budget: new Budget({ maxCalls: 10, maxTokens: 1e6 }), effort: { generate: 'low', solve: 'low' }, maxRepairs: 1, save() {}, log() {} };
}

test('an unused condition triggers the one repair, and the fixed problem passes', async () => {
  const llm = fakeLlm([
    { answer: 3, stepsUsed: [1, 2], conditions: [{ text: '(단, 온도와 압력은 일정하다.)', used: false }, { text: '표', used: true }] },
    { answer: 3, stepsUsed: [1, 2], conditions: [{ text: '표', used: true }] },
  ]);
  const item = { index: 0, label: 'STEP 1~2', stage: { kind: 'upto', upto: 2 }, variantNo: 1 };
  await produceItem(ctxFor(llm), { material, item, prior: [], rules: [], mode: 'integrated' });
  assert.equal(item.attempts.filter((a) => a.kind === 'repair').length, 1);
  assert.match(item.attempts[1].failures.join(), /쓰이지 않는 조건: \(단, 온도와 압력은 일정하다\.\)/);
  assert.equal(item.problem.text, '고친 문제');
  assert.equal(item.status, 'passed');
});

test('an integrated final that only changed numbers is sent back once and stays flagged if still so', async () => {
  const llm = fakeLlm([
    { answer: 3, stepsUsed: [1, 2], variation: 'numbers-only', variationNote: '표 구조와 질문이 같다' },
    { answer: 3, stepsUsed: [1, 2], variation: 'numbers-only', variationNote: '여전히 같다' },
  ]);
  const item = { index: 2, label: '최종', stage: { kind: 'twin' }, variantNo: 1 };
  await produceItem(ctxFor(llm), { material, item, prior: [], rules: [], mode: 'integrated' });
  const solveCalls = llm.calls.filter((c) => c.system === prompts.SOLVE_SYSTEM);
  assert.ok(solveCalls.every((c) => c.text.includes('[원본 문제 — variation 판정에만 사용')), 'solver sees the original for integrated finals');
  assert.equal(item.attempts.filter((a) => a.kind === 'repair').length, 1);
  assert.equal(item.status, 'warning');
  assert.match(item.warnings.join(), /숫자만 바뀌었습니다/);
});

test('numeric-twin mode does not ask for a structural redesign', async () => {
  const llm = fakeLlm([{ answer: 3, stepsUsed: [1, 2], variation: 'n/a' }]);
  const item = { index: 2, label: '최종', stage: { kind: 'twin' }, variantNo: 1 };
  await produceItem(ctxFor(llm), { material, item, prior: [], rules: [], mode: 'numeric' });
  assert.ok(!llm.calls.some((c) => c.text.includes('[원본 문제 — variation 판정에만 사용')));
  assert.equal(item.status, 'passed');
});

test('a final problem copying a practice problem is caught by code, not left to the model', () => {
  const { repeatsPrior } = require('../server/pipeline');
  const practice = { index: 1, label: 'STEP 1~2 누적 연습', problem: { text: '표...\nⅡ의 전체 몰수는 Ⅰ의 몇 배인가?', choices: ['3/4', '4/3', '3/2', '5/4', '2/3'] } };
  const final = { index: 2, stage: { kind: 'twin' }, problem: { text: '다른 표...\nⅢ의 전체 몰수는 Ⅰ의 몇 배인가?', choices: ['4/3', '3/4', '3/2', '5/4', '2/3'] } };
  assert.deepEqual(repeatsPrior(final, [practice]), ['앞 문제(STEP 1~2 누적 연습)와 선택지가 같습니다.']);
  const same = { ...final, problem: { ...final.problem, text: '다른 표\nⅡ의 전체 몰수는 Ⅰ의 몇 배인가 ?' } };
  assert.equal(repeatsPrior(same, [practice]).length, 2);
});

test('a final problem that skips a STEP goes to teacher review after the one repair', async () => {
  const llm = fakeLlm([{ answer: 3, stepsUsed: [1] }, { answer: 3, stepsUsed: [1] }]);
  const item = { index: 2, label: '최종', stage: { kind: 'twin' }, variantNo: 1 };
  await produceItem(ctxFor(llm), { material, item, prior: [], rules: [], mode: 'integrated' });
  assert.equal(item.attempts.filter((a) => a.kind === 'repair').length, 1);
  assert.equal(item.status, 'needs_review');
  assert.match(item.problems.join(), /STEP 2 로직 없이/);
});
