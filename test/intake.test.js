'use strict';
// 2026-10-26, after the two defects of that day (an analysis fix cut at 400 letters; the teacher's closing line put into
// every variant): every place a model's answer becomes data, or code writes into a variant, is checked so that a
// different-but-valid answer never silently passes, corrupts or leaks the original's values.
const test = require('node:test');
const assert = require('node:assert/strict');
const harness = require('../server/harness');
const finalReview = require('../server/final-review');
const pipeline = require('../server/pipeline');

const FULL = Object.fromEntries(finalReview.ITEM_NAMES.map((n) => [n, 'ok']));
const item = (over = {}) => ({ index: 0, label: '최종 문제', answerOk: true, myAnswer: '③ 135', markedAnswer: 3, verdict: 'use', checks: FULL, issues: [], ...over });

test('a review is taken only with every criterion judged and the reviewer\'s own answer the marked one', () => {
  const { itemFaults, answerOf } = finalReview;
  assert.deepEqual(itemFaults({ items: [item()] }, { answer: 3 }), []);
  assert.match(itemFaults({ items: [item({ checks: undefined })] }, { answer: 3 })[0], /기준 항목.*판정을 주지 않았습니다/);
  assert.match(itemFaults({ items: [item({ checks: { 정답: 'ok' } })] }, { answer: 3 })[0], /기준 항목\(STEP 범위, 결론 노출/);
  assert.match(itemFaults({ items: [item({ myAnswer: '모르겠음' })] }, { answer: 3 })[0], /직접 푼 정답 번호를 주지 않았습니다/);
  // The number the reviewer solved to decides, not answerOk alone.
  assert.match(itemFaults({ items: [item({ myAnswer: '② 54' })] }, { answer: 3 })[0], /직접 푼 정답은 ② 54로 표시된 정답 3번과 다릅니다/);
  assert.match(itemFaults({ items: [item({ myAnswer: '2' })] })[0], /표시된 정답 3번과 다릅니다/, 'markedAnswer stands in when the item\'s answer is not given');
  assert.deepEqual([answerOf('② $\\frac{2}{5}$'), answerOf('3'), answerOf('③ 135'), answerOf('2번'), answerOf('135 (③)'), answerOf('정답 4'), answerOf('없음')], [2, 3, 3, 2, 3, 4, 0]);
  // The 정답 row of the checklist reads the reviewer's number too.
  assert.equal(finalReview.checklistOf(item({ myAnswer: '②' }), { final: true, answer: 3 }).correct[0], 'no');
  assert.equal(finalReview.checklistOf(item(), { final: true, answer: 3 }).correct[0], 'ok');
});

test('a criterion fault that shares words with a lesson is not demoted; only a quoted lesson is', () => {
  const lesson = '숨긴 값은 원본과 다르게 둔다.';
  const shares = item({ verdict: 'fix', checks: { ...FULL, 구조: 'fix' }, issues: [{ severity: 'high', rule: '구조', detail: '숨긴 값 a=12가 원본과 같아 숫자만 바꾼 문제이다. 다르게 둔다.' }] });
  assert.equal(finalReview.itemFaults({ items: [shares] }, { advisory: [lesson], answer: 3 }).length, 1, 'held back');
  const quotes = item({ verdict: 'fix', checks: { ...FULL, 학습: 'fix' }, issues: [{ severity: 'mid', rule: '학습', detail: `'${lesson}' 어겼습니다.` }] });
  assert.deepEqual(finalReview.itemFaults({ items: [quotes] }, { advisory: [lesson], answer: 3 }), [], 'a quoted lesson is a note');
});

test('a sentence frame that carries a value of the original is not kept; a method\'s count is not a value', () => {
  const { carriesValue, validateFrames } = harness;
  for (const f of ['따라서 $x=15$이고 $b=3$이다.', '$M_A=《몰질량》$ g/mol이므로 $\\frac{w}{15}$ mol이다.', '따라서 ②가 정답이다.', '반응 전 질량 20 g에서 (가)~(다)의 몰수', '$\\frac{3}{15}\\times2=\\frac{2}{5}$이다.', '질량은 $5w$ g이고 $x=《값》']) assert.equal(carriesValue(f), true, f);
  for (const f of ['기체 1몰의 부피', '계수는 각각 2로', '2㉡+㉢=2b+a=《길이2》이다.', '분자량$=\\frac{질량}{양(mol)}$이고', '$\\frac{㉢}{㉠}=《값1》$이고 ㉠=a', '(가)의 분자량$=\\frac{《질량》g}{《부피》L}=《분자량》$', '식 (1), (2)를 연립하면 $a$와 $b$는 각각 $《값1》$과 $《값2》$이다.']) assert.equal(carriesValue(f), false, f);
  const material = { steps: [{ work: '따라서 $x=15$이고 $b=3$이다.\n반응 질량비는 A : B $=1:3$이다.' }] };
  const kept = validateFrames(material, { steps: [{ step: 1, frames: ['따라서 $x=15$이고 $b=3$이다.', '반응 질량비는 A : B $=《비》$이다.'] }] });
  assert.deepEqual(kept.map((s) => s.frames), [['반응 질량비는 A : B $=《비》$이다.']]);
});

test('a frame reference in any spelling is rendered, and one left unrendered is a hard fault', () => {
  const material = { frames: [{ step: 1, frames: ['Ⅰ에서 A 《질량》 g이 반응한다.'] }], steps: [{ title: 'S', work: 'Ⅰ에서 A $5w$ g이 반응한다.' }] };
  const it = { problem: { text: 'q', choices: ['1', '2'], answer: 1 }, solution: { steps: [{ step: 1, title: 'S', work: '**［틀 1-1］** 질량=4w\r\n[틀 1-1] 질량=3w\n[틀 1-2] 값=1' }] } };
  const missing = harness.renderFrames(material, it);
  const lines = it.solution.steps[0].work.split('\n');
  assert.equal(lines[0], 'Ⅰ에서 A $4w$ g이 반응한다.');
  assert.equal(lines[1], 'Ⅰ에서 A $3w$ g이 반응한다.');
  assert.match(missing[0], /없는 틀 번호/);
  const left = harness.checkFramesFilled({ solution: { steps: [{ step: 1, work: '[틀 2-1] 실험=Ⅱ\n실험=Ⅱ; 질량=4w\n$x=1$이다.' }] } })[0];
  assert.deepEqual([left.state, left.severity], ['fail', 'hard']);
  assert.match(left.evidence, /\[틀 2-1\] 실험=Ⅱ/);
  assert.equal(harness.checkFramesFilled({ solution: { steps: [{ step: 1, work: 'Ⅰ에서 A $4w$ g이 반응한다.\n$a=1$; $b=2$' }] } })[0].state, 'pass');
});

test('the answer line keeps its bold marks and table rows, and does not repeat a sentence choice', () => {
  const it = { problem: { choices: ['반응 후 남은 기체는 A이다.', '2'], answer: 1 }, solution: { steps: [{ step: 1, work: '| 정답은 ② | 20 |\n**정답은 ② 20이다.**' }] } };
  harness.renderFrames({ steps: [] }, it);
  assert.equal(it.solution.steps[0].work, '| 정답은 ② | 20 |\n**정답은 ①이다.**');
  const none = { problem: { choices: ['12', '20'], answer: 2 }, solution: { steps: [{ step: 1, work: '풀이.' }] } };
  harness.renderFrames({ steps: [] }, none);
  assert.equal(none.solution.steps[0].work, '풀이.\n정답은 ② 20이다.');
});

test('the choice heading is a line that starts as one; a sentence using the words is not', () => {
  const material = { steps: [{ work: '[선택지 분석] $b=3$이다.\n정답은 ②이다.' }] };
  const it = { solution: { steps: [{ step: 1, work: '선택지 분석을 하면 ㄱ은 옳다.\n정답은 ② $2w$이다.' }] } };
  harness.teacherChoiceHeading(material, it);
  assert.equal(it.solution.steps[0].work, '선택지 분석을 하면 ㄱ은 옳다.\n\n[선택지 분석]\n정답은 ② $2w$이다.');
});

test('notation leaves a field with unpaired $ alone, and a valence is not a particle', () => {
  assert.equal(harness.notation('질량은 $5w g이다. 따라서 X2가 남고 $x$의 값은 3이다.'), '질량은 $5w g이다. 따라서 X2가 남고 $x$의 값은 3이다.');
  assert.equal(harness.notation('3가 양이온과 1가 알코올', [], { formulas: false }), '3가 양이온과 1가 알코올');
  const figure = harness.checkFormat({ problem: { text: 'q', choices: [], figure: '$d_1=6$ cm, $d_2=15 cm' }, solution: { steps: [] } })[0];
  assert.equal(figure.state, 'fail');
  assert.match(figure.evidence, /그림 설명: \$ 기호 짝/);
});

test('a letter the variant introduces must be used in its solution; the original\'s own letters are the family\'s', () => {
  const material = { problem: { text: '표는 반응 전 질량 5w g과 반응 후 질량 $x$에 대한 자료이다.' } };
  const decorated = { problem: { text: '| Ⅲ | $aw$ | $x$ |', choices: [], figure: '' }, solution: { steps: [{ step: 1, work: '따라서 $x=2w$이다.' }] } };
  const [c] = harness.checkUnusedLetters(material, decorated);
  assert.equal(c.state, 'fail');
  assert.match(c.evidence, /문자 a가 해설 어디에도/);
  const used = { problem: { text: '| Ⅲ | $aw$ | $x$ |', choices: [], figure: '' }, solution: { steps: [{ step: 1, work: '따라서 $a=3$, $x=2w$이다.' }] } };
  assert.equal(harness.checkUnusedLetters(material, used)[0].state, 'pass');
  assert.deepEqual(harness.checkUnusedLetters(material, { problem: { text: '$5w$ g', choices: [] }, solution: { steps: [] } }), [], 'nothing new to use');
});

test('an analysis fix is never cut, and one with nothing to find is reported', () => {
  const { applyFixes } = pipeline;
  const long = 'ㄱ. ' + '분석 문장이다. '.repeat(60) + '(○)';
  assert.ok(long.length > 400);
  const m = { problem: { text: '표', choices: [] }, steps: [{ title: 'S', work: `앞 줄\n${long}\n뒤 줄` }] };
  const r = applyFixes(m, [{ field: 'steps[0].work', wrong: long, right: 'ㄱ. 새 분석 (×)' }, { field: 'steps[0].work', wrong: '', right: '통째로' }]);
  assert.equal(m.steps[0].work, '앞 줄\nㄱ. 새 분석 (×)\n뒤 줄', 'the whole passage is replaced, nothing of the old one left');
  assert.equal(r.applied.length, 1);
  assert.match(r.unresolved[0], /고칠 글자가 비어 있어/);
});

test('solution STEP numbers are read from any spelling, one per number, in order; none at all is refused', () => {
  const { normalizeGenerated } = pipeline;
  const data = { problem: { text: '문제 본문이다.', choices: ['1', '2'], answer: 1 }, solution: { steps: [{ step: 'STEP 2', title: 'b', work: 'w2' }, { step: '1.', title: 'a', work: 'w1' }, { title: 'c', work: 'w3' }] } };
  assert.deepEqual(normalizeGenerated(data).solution.steps.map((s) => [s.step, s.work]), [[1, 'w1'], [2, 'w2'], [3, 'w3']]);
  assert.throws(() => normalizeGenerated({ ...data, solution: { steps: [{ step: 1, work: 'a' }, { step: 1, work: 'b' }] } }), /STEP 번호를 겹쳐/);
  assert.throws(() => normalizeGenerated({ ...data, solution: { steps: [] } }), /해설을 쓰지 않았습니다/);
});

test('an original whose answer could not be read is a failed check, not 정답 0번', async () => {
  const checks = await pipeline.sourceChecks({ problem: { text: '표는 기체 (가)~(다)에 대한 자료이다.', choices: ['1', '2', '3'], answer: 0, figure: '' }, steps: [{ title: 'S', work: '값은 $x=1$이다.', result: '' }] });
  const c = checks.find((x) => x.id === 'source-answer');
  assert.equal(c.state, 'fail');
  assert.equal((await pipeline.sourceChecks({ problem: { text: '표는 기체 (가)~(다)에 대한 자료이다.', choices: ['1', '2', '3'], answer: 2, figure: '' }, steps: [] })).find((x) => x.id === 'source-answer'), undefined);
});

test('a lesson rewrite keeps the lesson, once per 학습 반복, and a merge that loses it is not made', async () => {
  const { learnFromReview } = pipeline;
  const before = '최종 문제는 숨긴 값의 역할, 판정 기준 실험, 묻는 값 중 둘 이상을 원본과 다르게 한다. 실험 수와 열은 원본과 같게 둔다. 같은 종류의 값을 다른 행으로 옮겨 같은 방법으로 구하게 하는 것, 실험 행 순서나 역할만 맞바꾸는 것, 열을 지우거나 발문으로 옮기는 것은 달라진 항목으로 세지 않는다. 문자로 숨긴 칸은 모두 묻는 값에 들어가거나 해설의 계산에 쓰이게 하고, 쓰이지 않으면 수치로 준다.';
  const rules = new Map([['e7975d4c4e9c60f0', { id: 'e7975d4c4e9c60f0', text: before, status: 'approved', stage: 'generation', scope: 'global', layer: 'lesson', subject: '화학', source: { from: 'review', faultKeys: ['k1'] } }]]);
  const store = { rules: { all: () => [...rules.values()], get: (id) => rules.get(id), put: (r) => rules.set(r.id, r), remove: (id) => rules.delete(id) } };
  const material = { id: 'm', subject: '화학', topic: 't', title: '몰질량', problem: { text: '' }, steps: [] };
  const answers = [];
  const ctx = { store, job: { id: 'train', rules: [] }, budget: { affords: () => true }, effort: { solve: 'low' }, signal: new AbortController().signal, log: (m) => answers.push(m), save() {},
    llm: { json: async () => ({ data: { revise: [{ id: 'e7975d4c4e9c60f0', text: '최종 문제는 숨긴 값의 역할, 판정 기준 실험, 묻는 값 중 둘 이상을 원본과 다르게 하고, 값을 옮기기만 한 것은 세지 않는다.', why: '짧게' }], remove: [], add: [] } }) } };
  const faults = [{ label: '최종 문제', text: '[구조 · mid] 숫자만 바꾼 문제이다.' }];
  const first = await learnFromReview(ctx, material, { id: 's1' }, faults);
  assert.deepEqual(first, [], 'a rewrite that drops the second half of the lesson is refused');
  assert.equal(rules.get('e7975d4c4e9c60f0').text, before);
  assert.ok(answers.some((m) => /절반 넘게 사라짐/.test(m)));
  ctx.llm.json = async () => ({ data: { revise: [{ id: 'e7975d4c4e9c60f0', text: before + ' 실험 수와 열은 원본과 같게 둔다.', why: '덧붙임' }], remove: [], add: [] } });
  const second = await learnFromReview(ctx, material, { id: 's2' }, faults);
  assert.equal(second[0].kind, 'revise');
  assert.ok(rules.get('e7975d4c4e9c60f0').source.faultKeys.length >= 2, 'the fault kinds join the record');
  ctx.llm.json = async () => ({ data: { revise: [{ id: 'e7975d4c4e9c60f0', text: before + ' 실험 수와 열은 원본과 같게 둔다. 표의 열 이름도 원본과 같게 둔다.', why: '또 덧붙임' }], remove: [], add: [] } });
  const third = await learnFromReview(ctx, material, { id: 's3' }, faults);
  assert.deepEqual(third, [], 'the same lesson is not rewritten again in this 학습 반복');
  assert.ok(answers.some((m) => /이미 고친 학습은 다시 고치지 않습니다/.test(m)));
});
