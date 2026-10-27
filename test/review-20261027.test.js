'use strict';
// The code review of 2026-10-27 (three independent readings of the model I/O layer, the generation path and the
// orchestration, each finding verified against the run of 2026-10-26): what a model's answer or a reviewer's verdict
// could still do to a set, and what the code does with it now. No model is called.
const test = require('node:test');
const assert = require('node:assert/strict');
const harness = require('../server/harness');
const finalReview = require('../server/final-review');
const setCheck = require('../server/set-check');
const pipeline = require('../server/pipeline');
const prompts = require('../server/prompts');
const { codeCheck } = require('../server/verify');
const { Budget } = require('../server/llm');

const FULL = Object.fromEntries(finalReview.ITEM_NAMES.map((n) => [n, 'ok']));
const clone = (x) => JSON.parse(JSON.stringify(x));

test('a reviewer\'s answer that begins with a value (2w, 1/4) names no choice; a number, a mark or "n번" does', () => {
  const { answerOf } = finalReview;
  assert.deepEqual(['2w', '1/4', '5/2', '2w, ㄱ·ㄴ', '3 (ㄱ, ㄴ)', '3', '③ 2w', '2번', '정답 4', '4.'].map(answerOf), [0, 0, 0, 0, 3, 3, 3, 2, 4, 0]);
});

test('a verdict is well formed only with every criterion judged, its own answer a number and its faults in form', () => {
  const good = { index: 0, label: 'x', answerOk: true, myAnswer: '③', verdict: 'use', checks: FULL, issues: [] };
  assert.equal(finalReview.wellFormed(good), true);
  assert.equal(finalReview.wellFormed({ ...good, checks: { 정답: 'ok' } }), false);
  assert.equal(finalReview.wellFormed({ ...good, myAnswer: '2w' }), false);
  assert.equal(finalReview.wellFormed({ ...good, issues: [{ severity: 'mid' }] }), false);
  assert.equal(finalReview.wellFormed({ ...good, verdict: 'ok' }), false);
  assert.equal(finalReview.wellFormed(null), false);
});

test('a criterion fault that quotes a lesson and goes on with its own evidence is the fault; one that is only the lesson is a note', () => {
  const lesson = '숨긴 값은 원본과 다른 값으로 정한다.';
  const quotes = { verdict: 'fix', answerOk: true, myAnswer: '③', checks: { ...FULL, 구조: 'fix' }, issues: [{ severity: 'high', rule: '구조', detail: `'${lesson}'를 어겼다: 숨긴 값 a=12가 원본의 a=12와 같다. 그래서 학생은 원본의 답을 외워 쓸 수 있다.` }] };
  assert.equal(finalReview.itemFaults({ items: [quotes] }, { advisory: [lesson], answer: 3 }).length, 1, 'held back');
  assert.equal(finalReview.demote(quotes, [lesson]).checks.구조, 'fix');
  const only = { ...quotes, issues: [{ severity: 'high', rule: '구조', detail: `${lesson} (어김)` }] };
  assert.equal(finalReview.demote(only, [lesson]).issues[0].severity, 'low');
  const named = { ...quotes, checks: { ...FULL, 학습: 'fix' }, issues: [{ severity: 'mid', rule: '학습', detail: `'${lesson}' 어겼다. a=12.` }] };
  assert.deepEqual(finalReview.itemFaults({ items: [named] }, { advisory: [lesson], answer: 3 }), [], 'under 학습 the quote alone decides');
});

test('an index given as a string and a label with stray spaces still match the item', () => {
  const it = { index: 1, label: '최종 문제' };
  assert.equal(finalReview.matchItem({ items: [{ index: '1', label: '최종 문제 ' }] }, it)?.label, '최종 문제 ');
  assert.equal(finalReview.matchItem({ items: [{ index: '0', label: '최종 문제' }] }, it), null, 'a string index is the number');
  assert.equal(finalReview.matchItem({ items: [{ label: ' 최종 문제' }] }, it, [it, { index: 0, label: 'STEP 1 연습' }])?.label, ' 최종 문제');
});

test('the set review compares the reviewer\'s number with the problem\'s own answer, not with the reviewer\'s note of it', () => {
  const record = { set: { items: [{ index: 0, label: 'STEP 1 연습', kind: 'upto', problem: '2+2는?', choices: ['1', '2', '3', '4', '5'], answer: 4, status: 'passed' }] },
    reviews: { 'claude-cli': { review: { analysis: { verdict: 'ok', issues: [] }, items: [{ index: 0, label: 'STEP 1 연습', answerOk: true, myAnswer: '③ 3', markedAnswer: 3, verdict: 'use', checks: FULL, issues: [] }] } } } };
  assert.match(setCheck.failing(record)[0].faults[0], /직접 푼 정답은 ③ 3로 표시된 정답 4번과 다릅니다/);
  assert.equal(setCheck.checklist(record).models['claude-cli'].marks.correct[0], 'no');
});

test('a set review whose verdicts are not in form is asked again, and a second one no better is the reviewer\'s error, not the problem\'s fault', async () => {
  const items = [{ index: 0, label: 'STEP 1 연습', stage: { kind: 'upto', upto: 1 }, status: 'passed', problem: { text: '2+2는?', choices: ['1', '2', '3', '4', '5'], answer: 4 }, solution: { steps: [{ step: 1, title: 't', work: '4' }] } }];
  const material = { id: 'm', title: 'm', subject: '수학', topic: 't', problem: { text: '1+1은?', choices: ['1', '2', '3', '4', '5'], answer: 2 }, steps: [{ title: 't', work: '2' }] };
  const store = { rules: { all: () => [] }, materials: { get: () => material } };
  const bare = { analysis: { verdict: 'ok', issues: [] }, items: [{ index: 0, label: 'STEP 1 연습', answerOk: true, myAnswer: '④', verdict: 'use', checks: { 정답: 'ok' }, issues: [] }] };
  const full = { ...bare, items: [{ ...bare.items[0], checks: FULL }] };
  const calls = [];
  const call = async (p, args) => { calls.push(args.text.includes('[이전 응답의 문항 식별자가 불일치했거나 판정 항목이 불완전했습니다]')); return { data: p === 'claude-cli' ? (calls.length > 1 ? full : bare) : bare, usage: {} }; };
  const record = await setCheck.reviewSet({ store, set: { id: 's', items, material, rules: [] }, call, providers: ['claude-cli', 'agy-cli'], images: [] });
  assert.ok(record.reviews['claude-cli'].review, 'asked again and taken');
  assert.match(record.reviews['agy-cli'].error, /판정 항목.*불완전/);
  assert.deepEqual(setCheck.failing(record), [], 'no fault of the problem');
});

test('the 학습 반복 stop rule needs two stuck rounds after the first, learning changed or not', () => {
  const stats = (faults, own, learned = [{ kind: 'add' }]) => ({ faultStats: { faults, own }, learned });
  assert.equal(setCheck.stuckAfterLearning([stats(10, 1), stats(10, 9), stats(5, 5)]), true);
  assert.equal(setCheck.stuckAfterLearning([stats(10, 1, []), stats(10, 9, []), stats(5, 5, [])]), true, 'nothing to learn and the faults stay: stuck');
  assert.equal(setCheck.stuckAfterLearning([stats(10, 9), stats(5, 5)]), false, 'not before the third set');
  assert.equal(setCheck.stuckAfterLearning([stats(10, 1), stats(10, 2), stats(10, 3)]), false);
  assert.equal(setCheck.stuckAfterLearning([stats(10, 1), stats(2, 2), stats(2, 2)]), false, 'fewer than three faults say nothing');
});

test('a reference to a frame that does not exist stays the writer\'s line and is the hard fault; a sentence with two = in it is not', () => {
  const material = { steps: [{ title: 't', work: '실험 Ⅰ에서 B가 남는다.' }], frames: [{ step: 1, frames: ['실험 《실험》에서 《물질》가 남는다.'] }] };
  const item = { problem: { answer: 2, choices: ['1', '2', '3', '4', '5'] }, solution: { steps: [{ step: 1, title: 't', work: '[틀 1-9] 값=1\n[틀 1-1] 실험=Ⅱ; 물질=A\n정답은 ② 2이다.' }] } };
  const missing = harness.renderFrames(material, item);
  assert.match(missing[0], /\[틀 1-9\]은 없는 틀 번호/);
  assert.equal(item.solution.steps[0].work.split('\n')[0], '[틀 1-9] 값=1');
  assert.equal(item.solution.steps[0].work.split('\n')[1], '실험 Ⅱ에서 A가 남는다.');
  assert.equal(harness.checkFramesFilled(item)[0].state, 'fail');
  for (const line of ['따라서 a=12; b=1.5이다.', '반응 전 질량은 A=2; B=3으로 둔다.']) assert.equal(harness.checkFramesFilled({ solution: { steps: [{ step: 1, work: line }] } })[0].state, 'pass', line);
  assert.equal(harness.checkFramesFilled({ solution: { steps: [{ step: 1, work: '실험=Ⅰ; 물질=B' }] } })[0].state, 'fail');
});

test('the answer line keeps a clause that goes on after the mark', () => {
  const item = { problem: { answer: 2, choices: ['1', '2', '3', '4', '5'] }, solution: { steps: [{ step: 1, title: 't', work: '정답은 ②이고, 이때 $x=2$이다.' }] } };
  harness.renderFrames({ steps: [{ title: 't', work: '' }] }, item);
  assert.equal(item.solution.steps[0].work, '정답은 ②이고, 이때 $x=2$이다.');
  const plain = { problem: { answer: 2, choices: ['1', '2', '3', '4', '5'] }, solution: { steps: [{ step: 1, title: 't', work: '정답은 ④ 4이다.' }] } };
  harness.renderFrames({ steps: [{ title: 't', work: '' }] }, plain);
  assert.equal(plain.solution.steps[0].work, '정답은 ② 2이다.');
});

test('a program whose values carry units is a program to fix, not a wrong answer', async () => {
  const r = await codeCheck({ program: ['n = 2 mol', 'ans = n * 2'], answer: 'ans', choices: ['2', '4', '6', '8', '10'], checks: [] }, { answer: 2, choiceCount: 5 });
  assert.equal(r.status, 'fail');
  assert.equal(r.runError, true);
  assert.match(r.reasons[0], /단위\(g, mol, L …\)가 섞여/);
  const ok = await codeCheck({ program: ['n = 2', 'ans = n * 2'], answer: 'ans', choices: ['2', '4', '6', '8', '10'], checks: [] }, { answer: 2, choiceCount: 5 });
  assert.equal(ok.status, 'pass');
});

// ---------------------------------------------------------------- the generation loop with a mock designer and solver

const material = { id: 'm', title: 'm', subject: '화학', topic: 't', problem: { text: '1+1은?', choices: ['1', '2', '3', '4', '5'], answer: 2 }, steps: [{ title: '덧셈', work: '1+1=2이다.' }] };
const design = (over = {}) => ({ problem: { text: '2+2는?', choices: ['1', '2', '3', '4', '5'], answer: 4, figure: '' },
  solution: { steps: [{ step: 1, title: '덧셈', work: '2+2=4이다.\n정답은 ④ 4이다.' }], summary: '' }, usesSteps: [1], designNote: 'n', appliedRules: [],
  verification: { program: ['ans = 4'], answer: 'ans', choices: ['1', '2', '3', '4', '5'], free: [], checks: [] }, ...over });
const solve = (answer) => ({ answer, confident: true, solution: '풀었다', stepsUsed: [1], shortcuts: [], issues: [], rules: [], conditions: [] });
const verdict = (v = 'use', issues = [], myAnswer = '④') => ({ analysis: { verdict: 'ok', issues: [] }, items: [{ index: 0, label: 'STEP 1 연습', answerOk: true, myAnswer, verdict: v, checks: FULL, issues }] });
function run({ designs, repairs = [], solves = [], reviews = [], finalGate = true, precheck = false }) {
  const purposes = [];
  const llm = { json: async ({ system, purpose }) => {
    purposes.push(purpose);
    if (purpose === 'final-review') return { data: reviews.shift() || verdict() };
    if (system === prompts.SOLVE_SYSTEM) return { data: solves.shift() || solve(4) };
    if (system === prompts.REPAIR_SYSTEM) return { data: repairs.shift() || design() };
    if (system === prompts.SOLUTION_REVIEW_SYSTEM) return { data: { steps: [], rules: [] } };
    return { data: designs.shift() || design() };
  } };
  const ctx = { llm, job: { id: 'j', rules: [], materialId: 'm' }, store: { rules: { all: () => [] }, materials: { get: () => material } }, budget: new Budget({ maxCalls: 60, maxTokens: 1e7 }), effort: { generate: 'low', solve: 'low' }, maxRepairs: 2, maxDesigns: 2, finalGate, precheck, save() {}, log() {} };
  const item = { index: 0, label: 'STEP 1 연습', stage: { kind: 'upto', upto: 1 }, variantNo: 1 };
  return pipeline.produceItem(ctx, { material, item, prior: [], rules: [], mode: 'practice' }).then(() => ({ item, purposes }));
}

test('a repair the reader cannot use loses the repair, not the problem; one that leaves the solution out keeps the one before', async () => {
  // The solver disagrees once, so the design is repaired; the repair writes STEP 1 twice.
  const twice = design({ solution: { steps: [{ step: 1, title: '덧셈', work: '2+2=4이다.' }, { step: 1, title: '선택지 분석', work: '정답은 ④ 4이다.' }] } });
  const lost = await run({ designs: [design()], solves: [solve(3), solve(4)], repairs: [twice] });
  assert.ok(lost.item.attempts.some((a) => a.kind === 'lost-repair' && /STEP 번호를 겹쳐/.test(a.failures[0])), JSON.stringify(lost.item.attempts.map((a) => a.kind)));
  assert.notEqual(lost.item.status, 'failed');
  assert.equal(lost.item.solution.steps.length, 1, 'the version before the repair stands');
  // A repair of the problem and its check program alone keeps the solution it left out.
  const noSolution = { problem: { text: '3+3은?', choices: ['2', '4', '6', '8', '10'], answer: 3 }, verification: { program: ['ans = 6'], answer: 'ans', choices: ['2', '4', '6', '8', '10'], free: [], checks: [] } };
  const kept = await run({ designs: [design()], solves: [solve(3), solve(3)], repairs: [noSolution], reviews: [verdict('use', [], '③')] });
  assert.equal(kept.item.problem.text, '3+3은?');
  assert.equal(kept.item.solution.steps.length, 1, 'the solution was not wiped');
  assert.equal(kept.item.status, 'passed');
  assert.ok(!kept.item.attempts.some((a) => a.kind === 'lost-repair'), JSON.stringify(kept.item.attempts));
});

test('a design without its answer number is designed again, not failed', async () => {
  const { item, purposes } = await run({ designs: [design({ problem: { text: '2+2는?', choices: ['1', '2', '3', '4', '5'], answer: '' } }), design()] });
  assert.equal(purposes.filter((p) => p === 'generate').length, 2);
  assert.equal(item.status, 'passed');
});

test('the final review that comes back incomplete is asked once more and, no better, skipped: the problem waits for the teacher, no repair', async () => {
  const bare = { analysis: { verdict: 'ok', issues: [] }, items: [{ index: 0, label: 'STEP 1 연습', answerOk: true, myAnswer: '④', verdict: 'use', checks: { 정답: 'ok' }, issues: [] }] };
  const recovered = await run({ designs: [design()], reviews: [bare, verdict()] });
  assert.equal(recovered.item.status, 'passed');
  assert.equal(recovered.purposes.filter((p) => p === 'final-review').length, 2);
  assert.ok(!recovered.item.attempts.some((a) => a.kind === 'repair'));
  const skipped = await run({ designs: [design()], reviews: [bare, bare, bare, bare, bare, bare] });
  assert.equal(skipped.item.status, 'needs_review');
  assert.match(skipped.item.finalReview.skipped, /두 번 모두 불완전/);
  assert.ok(!skipped.item.attempts.some((a) => a.kind === 'repair'), 'never a repair for the reviewer\'s slip');
});

test('the precheck lays the repaired solution out before it checks it again', async () => {
  const m = { ...material, frames: [{ step: 1, frames: ['《식》이다.'] }] };
  const framed = design({ solution: { steps: [{ step: 1, title: '덧셈', work: '[틀 1-1] 식=$2+2=4$\n정답은 ④ 4이다.' }] } });
  const purposes = [];
  const repairs = [];
  const llm = { json: async ({ system, purpose, text }) => {
    purposes.push(purpose);
    if (purpose === 'final-review') return { data: verdict() };
    if (system === prompts.SOLVE_SYSTEM) return { data: solve(4) };
    if (system === prompts.REPAIR_SYSTEM) { repairs.push(text); return { data: framed }; }
    if (system === prompts.SOLUTION_REVIEW_SYSTEM) return { data: { steps: [], rules: [] } };
    return { data: design({ verification: null, solution: framed.solution }) };
  } };
  const ctx = { llm, job: { id: 'j', rules: [], materialId: 'm' }, store: { rules: { all: () => [] }, materials: { get: () => m } }, budget: new Budget({ maxCalls: 60, maxTokens: 1e7 }), effort: { generate: 'low', solve: 'low' }, maxRepairs: 2, maxDesigns: 1, finalGate: true, precheck: true, save() {}, log() {} };
  const item = { index: 0, label: 'STEP 1 연습', stage: { kind: 'upto', upto: 1 }, variantNo: 1 };
  await pipeline.produceItem(ctx, { material: m, item, prior: [], rules: [], mode: 'practice' });
  // The first precheck fails on the missing check program; the repair brings one, written with a frame reference,
  // which is rendered before the second precheck: no "틀 참조가 남았습니다" goes back to the designer.
  assert.ok(repairs.length >= 1);
  assert.ok(!repairs.slice(1).some((t) => /틀 참조가 문장으로 바뀌지 않고/.test(t)), 'the rendered line is not a fault');
  assert.equal(item.solution.steps[0].work.split('\n')[0], '$2+2=4$이다.');
});
