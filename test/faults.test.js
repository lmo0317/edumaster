'use strict';
// 결함 기록 (server/faults.js): faults found while sets were made, read back as data for the next design and review.
const test = require('node:test');
const assert = require('node:assert/strict');
const faults = require('../server/faults');
const prompts = require('../server/prompts');
const review = require('../server/final-review');
const FULL = Object.fromEntries(review.ITEM_NAMES.map((n) => [n, 'ok']));
const sets = require('../server/set-check');
const pipeline = require('../server/pipeline');

const job = (id, materialId, { subject = '생명과학', topic = '감수 분열', title = '원본', at = '2026-10-20T00:00:00Z', items = [] } = {}) =>
  ({ id, type: 'generate', createdAt: at, finishedAt: at, materialId, title, material: { title, subject, topic }, items });
const item = (index, stage, { attempts = [], problems = [], status = 'passed', text = '문제 본문' } = {}) =>
  ({ index, label: stage.kind === 'twin' ? '최종 문제' : `STEP 1${stage.upto > 1 ? '~' + stage.upto : ''} 연습`, stage, status, problem: { text, choices: ['1', '2', '3', '4', '5'], answer: 1 }, attempts, problems });
const twin = { kind: 'twin' }, step1 = { kind: 'upto', upto: 1 };

test('a fault line is read as its criteria name, severity and text, whoever wrote it', () => {
  assert.deepEqual(faults.parseFault('최종 검수: [STEP 범위 · mid] STEP 1의 첫 번째 핵심 기법이 필요 없습니다.'), { rule: 'STEP 범위', severity: 'mid', detail: 'STEP 1의 첫 번째 핵심 기법이 필요 없습니다.', from: 'review' });
  assert.deepEqual(faults.parseFault('[두 번째 검수] [학습 · mid] \'합답형 문항은 …\' 어겼습니다.'), { rule: '학습', severity: 'mid', detail: '\'합답형 문항은 …\' 어겼습니다.', from: 'review' });
  assert.deepEqual(faults.parseFault('문제 설계: 앞 문제(STEP 1 연습)와 질문이 같습니다.'), { rule: '문제 설계', severity: '', detail: '앞 문제(STEP 1 연습)와 질문이 같습니다.', from: 'check' });
  assert.deepEqual(faults.parseFault('독립 풀이 지적(missing): B의 속도가 주어지지 않았다.'), { rule: '독립 풀이', severity: '', detail: 'B의 속도가 주어지지 않았다.', from: 'check' });
  // The same kind of fault with other numbers, labels and quoted text has the same key.
  assert.equal(faults.faultKey('앞 문제(STEP 1~2 연습)의 실험 수치(30,18)를 그대로 썼습니다 ((가) 행).'), faults.faultKey('앞 문제(STEP 1 연습)의 실험 수치(2w,5w)를 그대로 썼습니다 (Ⅱ 행).'));
  assert.notEqual(faults.faultKey('원본의 실험 수치(23,12)를 그대로 썼습니다.'), faults.faultKey('앞 문제의 실험 수치(23,12)를 그대로 썼습니다.'));
});

test('records come from the attempts that repaired, redesigned or rewrote, from what was left, and from the set review; low notes and frame values are not faults', () => {
  const j = job('j1', 'm1', { items: [
    item(0, step1, { attempts: [
      { kind: 'generate', design: 1 },
      { kind: 'fill', design: 1, failures: ['해설 STEP 1: [틀 1-2]에 《값》 값이 없습니다.'] },
      { kind: 'repair', design: 1, at: '2026-10-20T01:00:00Z', failures: ['최종 검수: [조건 · mid] 표의 (가) 열이 판정에 쓰이지 않습니다.', '최종 검수: [표기 · low] 정답 줄의 수식.'], problem: '첫 설계의 문제' },
    ], text: '고친 문제' }),
    item(1, twin, { status: 'needs_review', problems: ['최종 검수: [구조 · mid] 원본과 같은 표입니다.'], text: '못 고친 최종' }),
  ] });
  const rev = { done: true, at: '2026-10-20T02:00:00Z', reviews: { 'claude-cli': { review: { items: [{ index: 1, label: '최종 문제', issues: [{ severity: 'high', rule: 'STEP 전부 필요', detail: 'ㄱ만 판정해도 답이 나온다.' }, { severity: 'low', rule: '표기', detail: '…' }] }] } }, 'agy-cli': { error: 'limit' } } };
  const recs = faults.recordsOf(j, rev);
  assert.deepEqual(recs.map((r) => [r.kind, r.rule, r.index]), [['repair', '조건', 0], ['left', '구조', 1], ['review', 'STEP 전부 필요', 1]]);
  assert.equal(recs[0].problem, '첫 설계의 문제');
  assert.equal(recs[0].after, '고친 문제', 'a problem made in the end carries its final text');
  assert.equal(recs[1].after, '', 'one not made carries none');
  assert.equal(recs[2].reviewer, 'Claude');
  assert.ok(recs.every((r) => r.subject === '생명과학' && r.topic === '감수 분열' && r.materialId === 'm1'));
});

test('a problem\'s writer gets this original\'s faults first, then its topic\'s, then what recurs anywhere — same stage first — and the reviewer the first two', () => {
  const rep = (text, at = '2026-10-20T01:00:00Z', problem = '걸린 문제 본문') => ({ kind: 'repair', design: 1, at, failures: [text], problem });
  const jobs = [
    job('own1', 'm1', { items: [item(1, twin, { attempts: [rep('최종 검수: [구조 · mid] 원본과 같은 표이고 숨긴 칸이 없습니다.')], text: '숨긴 칸을 둔 최종' }), item(0, step1, { attempts: [rep('문제 설계: 앞 문제와 선택지가 같습니다.')] })] }),
    job('own2', 'm1', { at: '2026-10-21T00:00:00Z', items: [item(1, twin, { attempts: [rep('최종 검수: [구조 · mid] 원본과 같은 표이고 숨긴 칸이 없습니다.', '2026-10-21T01:00:00Z')], text: '숨긴 칸을 둔 최종' })] }),
    job('topic', 'm2', { title: '같은 단원 원본', items: [item(1, twin, { attempts: [rep('최종 검수: [STEP 전부 필요 · mid] ㄱ만 판정해도 답이 나온다.')] })] }),
    job('chem1', 'm3', { subject: '화학', topic: '몰', title: '화학 원본', items: [item(1, twin, { attempts: [rep('문제 설계: 원본의 실험 수치(23,12)를 그대로 썼습니다.')] })] }),
    job('chem2', 'm4', { subject: '화학', topic: '밀도', title: '화학 원본 2', items: [item(1, twin, { attempts: [rep('문제 설계: 원본의 실험 수치(5,7)를 그대로 썼습니다.')] })] }),
    job('chem3', 'm5', { subject: '화학', topic: '밀도', title: '화학 원본 3', items: [item(1, twin, { attempts: [rep('문제 설계: 손계산 수치: 1/108.')] })] }),
  ];
  const history = faults.index(jobs);
  const material = { id: 'm1', subject: '생명과학', topic: '감수 분열' };
  const list = faults.forItem(history, material, item(1, twin));
  assert.deepEqual(list.map((e) => [e.where, e.rule, e.sets]), [
    ['이 원본', '구조', 2], ['이 원본', '문제 설계', 1], ['같은 단원의 다른 원본', 'STEP 전부 필요', 1], ['다른 과목의 원본', '문제 설계', 2],
  ], 'a fault of another subject counts only when it came back in two sets or more');
  assert.equal(list[0].count, 2);
  assert.deepEqual(list[0].example, { problem: '걸린 문제 본문', after: '숨긴 칸을 둔 최종' }, 'this original\'s entry shows the faulted problem and the one that passed');
  assert.equal(list[3].example, null, 'another original\'s problem text is not shown');
  const text = prompts.priorFaultsBlock(list);
  assert.match(text, /\[전에 걸린 결함/);
  assert.match(text, /\(이 원본 · 2세트에서 2번 · 최종 문제\) \[구조\] 원본과 같은 표이고 숨긴 칸이 없습니다\.\n {2}걸린 문제: 걸린 문제 본문\n {2}고친 뒤 통과한 문제: 숨긴 칸을 둔 최종/);
  assert.match(text, /기록이지 기준이 아니다/);
  // The design prompt carries it; the reviewer gets this original's and its topic's entries only.
  const parts = prompts.generateParts({ material: { ...material, title: 't', problem: { text: '원본' }, steps: [{ title: 'a', work: 'b' }] }, stage: twin, total: 1, mode: 'integrated', prior: [], rules: [], variantNo: 1, priorFaults: list });
  assert.match(parts.text, /\[전에 걸린 결함/);
  const reviewText = review.itemReviewText({ ...material, title: 't', problem: { text: '원본', choices: [], answer: 1 }, steps: [] }, item(1, twin), [], [], list.filter((e) => e.own || e.where === '같은 단원의 다른 원본'));
  assert.match(reviewText, /\[전에 걸린 결함 — 이 원본의 지난 세트와 같은 단원에서/);
  assert.match(reviewText, /\[구조\] 원본과 같은 표/);
  assert.doesNotMatch(reviewText, /실험 수치/);
  assert.equal(prompts.priorFaultsBlock([]), '');
  // A practice problem of the same original: its own stage's fault comes first.
  assert.equal(faults.forItem(history, material, item(0, step1))[0].rule, '문제 설계');
  // A fault that restates a lesson is counted (setStats) but not offered: the lesson is in the prompt already, and a
  // system lesson would come back as criteria (bio-k61, 2026-10-23).
  const withLesson = [...history, ...faults.index([job('own3', 'm1', { at: '2026-10-22T00:00:00Z', items: [item(1, twin, { attempts: [rep('최종 검수: [학습 · mid] \'표의 칸을 숨길 때는 STEP 2를 거쳐야 정해지는 자리를 고른다.\' ⓑ는 STEP 1에서 정해집니다.', '2026-10-22T01:00:00Z')] })] })])];
  assert.ok(!faults.forItem(withLesson, material, item(1, twin)).some((e) => e.rule === '학습'));
  assert.equal(faults.setStats(job('own4', 'm1', { items: [item(1, twin, { attempts: [rep('최종 검수: [학습 · mid] \'표의 칸을 숨길 때는 STEP 2를 거쳐야 정해지는 자리를 고른다.\' 어겼습니다.')] })] }), withLesson).lesson, 1);
  // A line that says the review did not happen is not a fault.
  assert.equal(faults.recordsOf(job('x', 'm1', { items: [item(1, twin, { status: 'needs_review', problems: ['최종 검수: 앞의 검토에서 고칠 점이 남아 최종 검수까지 가지 못했습니다.'] })] })).length, 0);
});

test('a finished set is measured against the record: faults of a kind seen before, in this original, and ones a prompt lesson already named', () => {
  const rep = (text) => ({ kind: 'repair', design: 1, at: '2026-10-21T01:00:00Z', failures: [text] });
  const earlier = faults.index([
    job('e1', 'm1', { items: [item(1, twin, { attempts: [rep('최종 검수: [구조 · mid] 원본과 같은 표이고 숨긴 칸이 없습니다.')] })] }),
    job('e2', 'm9', { subject: '화학', topic: '몰', items: [item(1, twin, { attempts: [rep('문제 설계: 원본의 실험 수치(23,12)를 그대로 썼습니다.')] })] }),
  ]);
  const made = job('new', 'm1', { at: '2026-10-22T00:00:00Z', items: [item(1, twin, { attempts: [
    rep('최종 검수: [구조 · mid] 원본과 같은 표이고 숨긴 칸이 없습니다.'),
    rep('문제 설계: 원본의 실험 수치(3,4)를 그대로 썼습니다.'),
    rep('최종 검수: [학습 · mid] \'합답형 문항은 …\' 이 학습을 어겼습니다.'),
    rep('최종 검수: [조건 · mid] 처음 보는 결함.'),
  ] })] });
  const s = faults.setStats(made, earlier);
  assert.deepEqual(s, { faults: 4, repeat: 2, own: 1, lesson: 1, rate: 50 });
  assert.match(faults.statsLine(s), /4건 — 전에 나온 종류 2건 \(50%, 이 원본에서 1건\) · 지시문의 학습이 이미 말한 것 1건/);
  assert.match(faults.statsLine({ faults: 0 }), /걸린 것 없이/);
  // A reviewer's fault worded differently is the same kind when it says the same.
  const again = job('new2', 'm1', { at: '2026-10-23T00:00:00Z', items: [item(1, twin, { attempts: [rep('최종 검수: [구조 · mid] 숨긴 칸이 없이 원본과 같은 표이고, 원본과 같은 판단을 합니다.')] })] });
  assert.equal(faults.setStats(again, earlier).own, 1);
});

test('a review fault is the kind its first sentence says, whatever the evidence after it: the numbers-only final of three originals is one recurring kind', () => {
  // Three reviewers' wordings of the same verdict on the live data, 2026-10-24 (가계도, 골격근 두 원본); each goes on with the
  // problem's own evidence, so the full texts share few letter pairs and the 28-letter keys differ.
  const rep = (text, at) => ({ kind: 'repair', design: 1, at, failures: [text], problem: '첫 설계' });
  const jobs = [
    job('l64', 'mL', { topic: '가계도', title: '가계도', at: '2026-10-24T12:00:00Z', items: [item(1, twin, { attempts: [rep('최종 검수: [구조 · mid] 원본과 달라진 항목은 (1) 하나뿐이다. (1)은 원본이 수치 2로 준 ㉤ 칸을 ⓐ로 숨겨 ㄴ에서 판정하게 했으므로 해당한다. (2)는 해당하지 않는다. STEP 1의 기준 구성원은 원본처럼 ㉠(=1)이고 가정→모순의 방향도 같다.', '2026-10-24T12:30:00Z')] })] }),
    job('e38', 'mE', { topic: '근수축', title: '골격근 1', at: '2026-10-24T13:00:00Z', items: [item(1, twin, { attempts: [rep('최종 검수: [구조 · mid] 원본과 다른 항목이 (2) 하나뿐이어서 숫자만 바꾼 문제(numbers-only)입니다. (1) 해당하지 않습니다. 숨긴 값은 원본과 같은 종류(한 시점의 X 길이)입니다. 이 값을 t2 행에서 t1 행으로 옮겼을 뿐입니다.', '2026-10-24T13:30:00Z')] })] }),
    job('c38', 'mC', { subject: '화학', topic: '밀도', title: '기체의 밀도', at: '2026-10-24T09:00:00Z', items: [item(1, twin, { attempts: [rep('최종 검수: [구조 · mid] 원본과 다른 항목이 하나도 없어 숫자만 바꾼 문제(numbers-only)이다. ① 숨긴 값: 학생이 받는 표에 ?·문자 칸이 없다. ② 기준 실험: 원본처럼 (가)에서 시작한다.', '2026-10-24T09:30:00Z')] })] }),
    // Another 구조 fault — the table's rows and columns copied — is a kind of its own.
    job('n1', 'mN', { topic: '흥분 전도', title: '신경', at: '2026-10-24T10:00:00Z', items: [item(1, twin, { attempts: [rep('최종 검수: [구조 · mid] 표 구성이 원본과 같다(A·B 두 행, Ⅰ~Ⅳ, A 행의 값은 -80·0·0·?). 지점 이름만 바뀌었다.', '2026-10-24T10:30:00Z')] })] }),
  ];
  const history = faults.index(jobs);
  const groups = faults.groupsOf(history).filter((g) => g.rule === '구조');
  assert.deepEqual(groups.map((g) => g.sets.size).sort(), [1, 3], 'three wordings of the verdict are one kind; the copied table another');
  // A new 생명과학 original's final problem gets it as a recurring kind of its subject, and its own such fault counts as a repeat.
  const e37 = { id: 'mF', subject: '생명과학', topic: '근수축' };
  const offered = faults.forItem(history, e37, item(1, twin));
  assert.deepEqual(offered.map((e) => [e.where, e.rule, e.sets, e.count]), [['같은 단원의 다른 원본', '구조', 3, 3]]);
  const made = job('e37', 'mF', { at: '2026-10-25T00:00:00Z', items: [item(1, twin, { attempts: [rep('최종 검수: [구조 · mid] 구조 변형 기준 세 항목 중 하나만 원본과 다르므로 숫자만 바꾼 문제다. (2)는 해당한다. A대 길이와 두 비를 모두 준 기준 행이 F₁에서 F₂로 바뀌었다.', '2026-10-25T00:30:00Z')] })] });
  assert.deepEqual(faults.setStats(made, history), { faults: 1, repeat: 1, own: 0, lesson: 0, rate: 100 });
  // Verdicts that only share the rule name stay apart: a different first sentence under the same rule is another kind.
  assert.equal(faults.setStats(job('n2', 'mF', { at: '2026-10-25T01:00:00Z', items: [item(1, twin, { attempts: [rep('최종 검수: [구조 · mid] 위치 눈금 0, 6, 15, 21 cm는 원본 0, 2, 5, 7 cm의 정확히 3배이다.', '2026-10-25T01:30:00Z')] })] }), history).repeat, 0);
});

test('a fault that only restates a lesson the system wrote itself is a note, not what holds a problem back or costs its score', () => {
  const ai = '합답형 문항은 보기 하나를 판정했을 때 남는 선택지들이 모두 같은 보기를 포함하거나 모두 빼서 나머지 보기를 판정할 필요가 없어지는지 확인한다.';
  const teacher = '해설에서 가정→모순 판정을 선생님 순서대로 쓴다.';
  const rules = [
    { id: 'a', text: ai, status: 'approved', stage: 'generation', scope: 'global', layer: 'lesson', createdAt: '2026-10-01', source: { from: 'auto' } },
    { id: 't', text: teacher, status: 'approved', stage: 'generation', scope: 'global', layer: 'lesson', createdAt: '2026-10-01', source: { from: 'input' } },
  ];
  const material = { id: 'm', subject: '생명과학', problem: { text: '' }, steps: [] };
  const advisory = review.advisoryTexts(material, rules);
  assert.deepEqual(advisory, [ai]);
  const it = (issues) => ({ items: [{ index: 1, label: '최종 문제', answerOk: true, markedAnswer: 4, myAnswer: '4', verdict: 'fix', checks: { ...FULL, '학습': 'fix' }, issues }] });
  const quotesAi = { severity: 'mid', rule: '학습', detail: `'${ai}' — ㄱ을 ×로 판정하면 남는 선택지가 ②와 ④뿐이라 ㄷ이 참으로 정해집니다.` };
  const quotesTeacher = { severity: 'mid', rule: '학습', detail: `'${teacher}' — STEP 1의 가정이 빠졌습니다.` };
  const real = { severity: 'mid', rule: '구조', detail: '원본과 같은 표입니다.' };
  assert.deepEqual(review.itemFaults(it([quotesAi]), { advisory }), [], 'the AI lesson alone holds nothing back');
  assert.deepEqual(review.itemNotes(it([quotesAi]), { advisory }), [`[AI 학습 참고 · low] ${quotesAi.detail}`]);
  assert.equal(review.itemFaults(it([quotesTeacher]), { advisory }).length, 1, 'the teacher\'s lesson does');
  assert.equal(review.itemFaults(it([quotesAi, real]), { advisory }).length, 1, 'a real fault beside it stays');
  assert.equal(review.itemFaults(it([quotesAi])).length, 1, 'without the advisory list (the offline review script) nothing changes');
  assert.deepEqual(review.checklistOf(it([quotesAi]).items[0], { final: true, advisory }).method[0], 'ok');
  assert.deepEqual(review.checklistOf(it([quotesAi]).items[0], { final: true }).method[0], 'no');
  // The set review's verdicts use the same list: the problem does not fail, and the target can be reached.
  const clean = { items: [{ ...it([]).items[0], verdict: 'use', checks: FULL }] };
  const record = { set: { items: [{ index: 1, label: '최종 문제', problem: {}, kind: 'twin' }] }, reviews: { 'claude-cli': { review: it([quotesAi]) }, 'agy-cli': { review: clean } } };
  assert.equal(sets.failing(record, null, advisory).length, 0);
  assert.equal(sets.failing(record).length, 1);
  const store = { rules: { all: () => rules }, materials: { get: () => material } };
  assert.deepEqual(sets.advisoryOf(store, { materialId: 'm', rules: [{ id: 'a', text: ai }, { id: 't', text: teacher }] }), [ai]);
});

test('an attempt that found faults keeps the problem as it was, and the final review gets the advisory list and the prior faults', async () => {
  const ai = '표의 칸을 숨길 때는 그 값이 STEP 2를 거쳐야 정해지는 자리를 고른다.';
  const rules = [{ id: 'a', text: ai, status: 'approved', stage: 'generation', scope: 'global', layer: 'lesson', createdAt: '2026-10-01', source: { from: 'review' } }];
  const material = { id: 'm', title: 't', subject: '생명과학', problem: { text: '원본', choices: ['1', '2', '3', '4', '5'], answer: 1 }, steps: [{ title: 'a', work: 'b' }] };
  const it = { ...item(1, twin), attempts: [] };
  let prompt = '';
  const ctx = {
    finalGate: true, job: { id: 'test', materialId: 'm', rules: [{ id: 'a', text: ai }] }, budget: {}, effort: {}, log() {}, save() {},
    store: { rules: { all: () => rules }, files: { dataUrl: () => null } },
    priorFaults: [{ where: '이 원본', own: true, rule: '구조', detail: '원본과 같은 표입니다.', label: '최종 문제', sets: 2, count: 2, materials: 1, reviewers: [], example: null }, { where: '다른 과목의 원본', own: false, rule: '수치', detail: '실험 수치 재사용.', label: '', sets: 3, count: 3, materials: 2, reviewers: [], example: null }],
    llm: { json: async (a) => { prompt = a.text; return { data: { items: [{ index: 1, label: '최종 문제', answerOk: true, markedAnswer: 1, myAnswer: '1', verdict: 'fix', checks: { ...FULL, '학습': 'fix' }, issues: [{ severity: 'mid', rule: '학습', detail: `'${ai}' 어겼습니다.` }] }] } }; } },
  };
  const gate = await pipeline.finalGate(ctx, it, material, []);
  assert.deepEqual(gate.faults, []);
  assert.match(gate.notes.join(), /AI 학습 참고/);
  assert.match(prompt, /\[전에 걸린 결함[\s\S]*\[구조\] 원본과 같은 표입니다/);
  assert.doesNotMatch(prompt, /실험 수치 재사용/, 'the reviewer sees this original\'s and its topic\'s faults only');
});
