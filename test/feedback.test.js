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
  solution: { steps: [{ step: 1, title: 'S1', work: '3' }], summary: '3' },
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

test('an integrated final that only changed numbers is sent back once and goes to the teacher if still so', async () => {
  const llm = fakeLlm([
    { answer: 3, stepsUsed: [1, 2], variation: 'numbers-only', variationNote: '표 구조와 질문이 같다' },
    { answer: 3, stepsUsed: [1, 2], variation: 'numbers-only', variationNote: '여전히 같다' },
  ]);
  const item = { index: 2, label: '최종', stage: { kind: 'twin' }, variantNo: 1 };
  await produceItem(ctxFor(llm), { material, item, prior: [], rules: [], mode: 'integrated' });
  const solveCalls = llm.calls.filter((c) => c.system === prompts.SOLVE_SYSTEM);
  assert.ok(solveCalls.every((c) => c.text.includes('[원본 문제 — variation 판정에만 사용')), 'solver sees the original for integrated finals');
  assert.equal(item.attempts.filter((a) => a.kind === 'repair').length, 1);
  // Numbers-only after the repair is the teacher's main complaint, so it is not left as a usable "check this".
  assert.equal(item.status, 'needs_review');
  assert.match(item.problems.join(), /숫자만 바뀌었습니다/);
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

test('a blind solver that cannot finish keeps the problem for teacher review instead of failing it', async () => {
  const { LlmFormatError } = require('../server/llm');
  let solveCalls = 0;
  const llm = {
    json: async ({ system }) => {
      if (system === prompts.SOLVE_SYSTEM) { solveCalls++; throw new LlmFormatError('모델 출력이 길이 제한에서 잘렸습니다.'); }
      return { data: generated('끝까지 못 푸는 문제') };
    },
  };
  const item = { index: 0, label: 'STEP 1', stage: { kind: 'upto', upto: 1 }, variantNo: 1 };
  await produceItem(ctxFor(llm), { material, item, prior: [], rules: [], mode: 'integrated' });
  assert.equal(item.status, 'needs_review');
  assert.ok(item.problem.text);
  assert.match(item.verification.blind.solution, /답을 내지 못했습니다/);
  assert.equal(solveCalls, 2, 'one repair, then stop because the complaint repeats');
});

test('a repair answer that leaves out how each rule was kept does not wipe the first answer\'s explanation', async () => {
  // Qwen 3.6 / Gemma returned only the fixed problem on repair; the rule explanations were lost.
  const rules = [{ id: 'r1', kind: 'dont', target: 'problem', text: '풀이에 쓰이지 않는 조건을 넣지 않는다.' }];
  const solves = [
    { answer: 3, stepsUsed: [1, 2], conditions: [{ text: '(단, 온도는 일정하다.)', used: false }], rules: [{ id: 'r1', ok: true, note: '' }] },
    { answer: 3, stepsUsed: [1, 2], conditions: [], rules: [{ id: 'r1', ok: true, note: '' }] },
  ];
  const calls = [];
  const llm = {
    json: async ({ system, text }) => {
      calls.push({ system, text });
      if (system === prompts.SOLVE_SYSTEM) return { data: solves.shift() };
      if (system === prompts.REPAIR_SYSTEM) return { data: { ...generated('고친 문제'), designNote: '', appliedRules: [] } };
      return { data: { ...generated('처음 문제'), appliedRules: [{ id: 'r1', how: '표만 남기고 온도 조건을 뺐다' }] } };
    },
  };
  const item = { index: 0, label: 'STEP 1~2', stage: { kind: 'upto', upto: 2 }, variantNo: 1 };
  await produceItem(ctxFor(llm), { material, item, prior: [], rules, mode: 'integrated' });
  const repairCall = calls.find((c) => c.system === prompts.REPAIR_SYSTEM);
  assert.match(repairCall.text, /"appliedRules":\[\{"id":"r1"/, 'the repair sees its own rule explanations');
  assert.equal(item.problem.text, '고친 문제');
  assert.deepEqual(item.appliedRules, [{ id: 'r1', how: '표만 남기고 온도 조건을 뺐다' }]);
  assert.equal(item.designNote, 'd');
  assert.equal(item.verification.rules[0].how, '표만 남기고 온도 조건을 뺐다');
});

test('a target STEP the solver could skip, and a STEP title that is not the teacher\'s, are sent back for repair', async () => {
  const solves = [
    { answer: 3, stepsUsed: [2], shortcuts: [{ step: 1, how: '남은 질량이 넣은 A보다 커서 남은 물질이 바로 보임' }], conditions: [] },
    { answer: 3, stepsUsed: [1, 2], conditions: [] },
  ];
  const repairs = [];
  const llm = {
    json: async ({ system, text }) => {
      if (system === prompts.SOLVE_SYSTEM) return { data: solves.shift() };
      if (system === prompts.REPAIR_SYSTEM) { repairs.push(text); return { data: generated('고친 문제') }; }
      const first = generated('처음 문제');
      return { data: { ...first, solution: { steps: [{ step: 1, title: '한계 반응물 판정 (경우 나누기)', work: '3' }], summary: '3' } } };
    },
  };
  const item = { index: 1, label: 'STEP 1~2', stage: { kind: 'upto', upto: 2 }, variantNo: 1 };
  await produceItem(ctxFor(llm), { material, item, prior: [], rules: [], mode: 'integrated' });
  assert.equal(repairs.length, 1);
  assert.match(repairs[0], /STEP 1의 핵심 기법 없이 결론이 나옵니다: 남은 질량이/);
  assert.match(repairs[0], /해설 STEP 제목을 선생님 해설의 제목대로/);
  assert.equal(item.status, 'passed');
});

test('a solution that leaves the teacher\'s flow is sent back, and the reviewer judges the solution rules', async () => {
  // Teacher feedback ①: DeepSeek added a case split the teacher never makes and wrote the mass ratio as B : A.
  const rules = [{ id: 'r2', kind: 'do', target: 'solution', text: '해설은 교사 해설의 풀이 흐름과 표현을 그대로 따른다.' }];
  const reviews = [
    { steps: [{ step: 1, ok: false, issues: ['교사는 한 방향만 가정하는데 경우를 나누어 모두 검토함'] }], rules: [{ id: 'r2', ok: false, note: '경우 나누기 추가' }] },
    { steps: [{ step: 1, ok: true, issues: [] }], rules: [{ id: 'r2', ok: true, note: '' }] },
  ];
  const repairs = [];
  const llm = {
    json: async ({ system, text }) => {
      if (system === prompts.SOLVE_SYSTEM) return { data: { answer: 3, stepsUsed: [1, 2], conditions: [] } };
      if (system === prompts.SOLUTION_REVIEW_SYSTEM) return { data: reviews.shift() };
      if (system === prompts.REPAIR_SYSTEM) { repairs.push(text); return { data: { ...generated('고친 문제'), appliedRules: [{ id: 'r2', how: '교사 흐름대로' }] } }; }
      return { data: { ...generated('처음 문제'), appliedRules: [{ id: 'r2', how: '교사 흐름대로' }] } };
    },
  };
  const item = { index: 1, label: 'STEP 1~2', stage: { kind: 'upto', upto: 2 }, variantNo: 1 };
  await produceItem(ctxFor(llm), { material, item, prior: [], rules, mode: 'integrated' });
  assert.equal(repairs.length, 1);
  assert.match(repairs[0], /해설이 선생님 해설과 다름 \(STEP 1\): 교사는 한 방향만 가정/);
  assert.match(repairs[0], /교사 지침 미준수: 해설은 교사 해설의/);
  assert.equal(item.status, 'passed');
  assert.equal(item.verification.rules[0].judged.ok, true);
});

test('a letter coefficient no question or solution uses is an unused condition', () => {
  const harness = require('../server/harness');
  const item = (solution, question = '실험 Ⅰ에서 생성된 D의 양은?') => ({ stage: { kind: 'upto', upto: 2 }, problem: { text: `$\\ce{A(g) + bB(g) -> 2C(g) + 2D(g)}$ ($b$는 반응 계수)\n${question}`, choices: [] }, solution: { steps: [{ step: 1, work: solution }] } });
  const check = (it) => harness.inspectItem({ problem: { text: '' }, steps: [] }, it, 'integrated').find((c) => c.id === 'unused-coefficient').state;
  assert.equal(check(item('D는 $8n$ mol이다.')), 'fail');
  assert.equal(check(item('따라서 $b=3$이다.')), 'pass');
  assert.equal(check(item('…', '$\\frac{b}{x}$는?')), 'pass');
});

test('run cost: list prices per provider, DeepSeek peak hours double, cached input at the cache price', () => {
  const { runCost } = require('../eval/cost');
  const records = [
    // Sunday: off-peak. 1M input of which 0.5M cached, 1M output.
    { jobId: 'a', provider: 'deepseek', createdAt: '2026-09-27T02:00:00Z', input: 1e6, cached: 5e5, output: 1e6, outcome: 'stop' },
    // Wednesday 02:00 UTC: peak, twice the price.
    { jobId: 'a', provider: 'deepseek', createdAt: '2026-09-30T02:00:00Z', input: 0, cached: 0, output: 1e6, outcome: 'stop' },
    { jobId: 'b', provider: 'claude', createdAt: '2026-09-30T02:00:00Z', input: 1e5, cached: 0, output: 5e4, outcome: 'stop' },
    { jobId: 'other', provider: 'claude', createdAt: '2026-09-30T02:00:00Z', input: 1e6, cached: 0, output: 1e6, outcome: 'stop' },
  ];
  const c = runCost(records, ['a', 'b']);
  assert.equal(c.byProvider.deepseek.usd, +(0.5 * 0.15 + 0.5 * 0.003 + 0.6 + 1.2).toFixed(3));
  assert.equal(c.byProvider.deepseek.peakCalls, 1);
  assert.equal(c.byProvider.claude.usd, +(0.1 * 4 + 0.05 * 20).toFixed(3));
  assert.equal(c.byProvider.claude.calls, 1);
});
