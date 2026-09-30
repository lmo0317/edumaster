'use strict';
// Retrieval (RAG) in both directions: teacher rules/feedback → generation, teacher corrections → reading.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { selectRules, readingCorrections, recordCorrections, readingPairs, readingHint } = require('../server/learning');
const { openStore } = require('../server/store');
const { pickRules } = require('../server/pipeline');
const prompts = require('../server/prompts');

const chemFeedback = {
  id: 'c1c1c1c1c1c1c1c1', status: 'approved', scope: 'topic', kind: 'feedback', target: 'problem', updatedAt: '2026-09-29', subject: '화학', topic: '화학 반응의 양적 관계',
  text: '연습 문제에 풀이에 안 쓰이는 조건과 자료가 들어갔습니다.', source: { label: '반응량 · STEP 1 연습', excerpt: '실험 I~III에서 A와 B의 질량을 달리하여 반응시켰을 때 반응 후 남은 기체의 질량과 자료' },
};
const bio = { subject: '생명과학', topic: '흥분 전도', problem: { text: '다음은 민말이집 신경 A와 B의 흥분 전도와 전달에 대한 자료이다. 조건과 자료를 이용해 옳은 것만을 고른 것은?' }, techniques: [] };
const chem = { subject: '화학', topic: '반응량', problem: { text: '실험 I~III에서 A와 B의 질량을 달리하여 반응시킨 자료이다. 반응 후 남은 기체의 질량' }, techniques: [] };

test('topic feedback is retrieved for a similar problem of the same subject only', () => {
  assert.deepEqual(selectRules([chemFeedback], chem).map((r) => r.id), ['c1c1c1c1c1c1c1c1']);
  assert.deepEqual(selectRules([chemFeedback], bio).map((r) => r.id), [], 'a 화학 feedback never reaches a 생명과학 problem');
  const global = { ...chemFeedback, id: 'a1a1a1a1a1a1a1a1', scope: 'global', subject: '' };
  assert.deepEqual(selectRules([global], bio).map((r) => r.id), ['a1a1a1a1a1a1a1a1'], 'global rules always apply');
  assert.deepEqual(selectRules([{ ...global, status: 'pending' }], bio), [], 'only approved rules');
});

test('the problem a feedback was written about goes to the generator with the rule', () => {
  const store = openStore(fs.mkdtempSync(path.join(os.tmpdir(), 'em2-rag-')));
  store.rules.put(chemFeedback);
  const rules = pickRules(store, chem);
  assert.match(rules[0].context, /반응량 · STEP 1 연습: 실험 I~III/);
  const text = prompts.generateText({ material: { ...chem, steps: [{ title: 's', work: 'w' }], problem: { ...chem.problem, choices: [] } }, stage: { kind: 'upto', upto: 1 }, total: 1, mode: 'integrated', prior: [], rules });
  assert.match(text, /이 피드백을 받은 문제 .*실험 I~III/);
});

test('a teacher edit of an analysis becomes a reading correction; numbers are not kept', () => {
  const before = { subject: '화학', problem: { text: 'C의 물질량 + D의 물질량 은? 표의 값은 15이다.', choices: ['1'] }, steps: [{ title: 'A~D의 물질량을 구한다', work: 'w', result: 'b=3' }] };
  const after = { problem: { text: 'C의 몰질량 + D의 몰질량 은? 표의 값은 18이다.', choices: ['1'] }, steps: [{ title: 'A~D의 몰질량을 구한다', work: 'w', result: 'b=3' }] };
  const pairs = readingCorrections(before, after);
  assert.deepEqual(pairs, [['물질량', '몰질량']]);
  const store = openStore(fs.mkdtempSync(path.join(os.tmpdir(), 'em2-rag-')));
  recordCorrections(store, pairs, { id: 'aa11', subject: '화학' });
  recordCorrections(store, pairs, { id: 'bb22', subject: '화학' });
  const saved = store.corrections.all();
  assert.equal(saved.length, 1);
  assert.equal(saved[0].count, 2);
  assert.match(readingHint(saved), /"물질량"로 잘못 읽음 → 원본은 "몰질량" \(2회\)/);
  recordCorrections(store, [['질량비', '부피비']], { id: 'cc33' });
  assert.ok(readingPairs(store.corrections.all()).some((p) => p.includes('질량비') && p.includes('부피비')), 'a learned pair joins the confusable pairs');
});

test('analysis sends past corrections to every reader and propagates a learned pair', async () => {
  const { analyzeMaterial } = require('../server/pipeline');
  const { Budget } = require('../server/llm');
  const store = openStore(fs.mkdtempSync(path.join(os.tmpdir(), 'em2-rag-')));
  recordCorrections(store, [['질량비', '부피비']], { id: 'aa11', subject: '화학' });
  const img = store.files.saveDataUrl('data:image/png;base64,' + Buffer.alloc(300, 1).toString('base64'));
  const material = { id: 'm9', note: '', images: { problem: img.id, solution: img.id, sameImage: false, views: { problem: [], solution: [] } } };
  const analysis = {
    title: '화학', subject: '화학', topic: '기체',
    problem: { text: '다음은 기체 실험이다.\nA와 B의 질량비는?', choices: ['1', '2'], answer: 1 },
    steps: [{ title: '질량비 구하기', work: '부피비와 질량비를 비교한다', result: '1' }], stepMarkers: [], techniques: [],
    verification: { program: ['a = 1'], answer: 'a', choices: ['1', '2'], checks: [] },
  };
  const texts = [];
  const answers = {
    [prompts.ANALYZE_SYSTEM]: () => analysis,
    [prompts.PROOFREAD_SYSTEM]: () => ({ fixes: [], solutionStepCount: 0 }),
    // Both focused reads see 부피비 in the question: the learned pair then fixes 질량비 in the solution too.
    [prompts.REREAD_QUESTION_SYSTEM]: () => ({ question: 'A와 B의 부피비는?' }),
    [prompts.REREAD_HEADINGS_SYSTEM]: () => ({ steps: [] }),
  };
  const ctx = { store, job: { id: 'j' }, budget: new Budget({ maxCalls: 12, maxTokens: 1e6 }), log() {},
    llm: { json: async ({ system, purpose, text }) => { texts.push({ purpose, text }); return { data: JSON.parse(JSON.stringify(answers[system]())) }; } } };
  const r = await analyzeMaterial(ctx, material);
  for (const p of ['analyze', 'proofread', 'reread-question', 'reread-headings']) {
    assert.ok(texts.filter((t) => t.purpose === p).every((t) => /"질량비"로 잘못 읽음/.test(t.text)), `${p} gets the hint`);
  }
  assert.ok(r.problem.text.includes('A와 B의 부피비는?'), r.problem.text);
  assert.ok(!r.steps[0].work.includes('질량비') && !r.steps[0].title.includes('질량비'), 'learned pair propagated to the solution');
  assert.ok(r.uncertainties.some((u) => u.includes('질량비↔부피비')), 'and shown to the teacher');
});

test('a two-letter teacher correction is learned; a rewritten sentence is not', () => {
  const before = { problem: { text: 'A와 B의 질량비는?', choices: [] }, steps: [{ title: 't', work: '반응 후 남은 양을 구한다', result: '' }] };
  const after = { problem: { text: 'A와 B의 부피비는?', choices: [] }, steps: [{ title: 't', work: '처음 넣은 기체 전체를 비교한다', result: '' }] };
  assert.deepEqual(readingCorrections(before, after), [['질량비', '부피비']]);
});

test('a problem\'s own feedback goes to that problem only, before the rules for every problem', () => {
  const base = { status: 'approved', kind: 'feedback', target: 'problem', createdAt: '2026-09-30T01:00:00Z', updatedAt: '2026-09-30T01:00:00Z', text: 'x' };
  const mine = { ...base, id: 'm1m1m1m1m1m1m1m1', scope: 'material', source: { materialId: 'aaaa' }, text: '이 문제: 남는 물질을 표에 적지 말 것' };
  const other = { ...base, id: 'm2m2m2m2m2m2m2m2', scope: 'material', source: { materialId: 'bbbb' } };
  const global = { ...base, id: 'g1g1g1g1g1g1g1g1', scope: 'global', updatedAt: '2026-09-30T05:00:00Z' };
  const ids = selectRules([global, other, mine], { id: 'aaaa', subject: '화학' }).map((r) => r.id);
  assert.deepEqual(ids, ['m1m1m1m1m1m1m1m1', 'g1g1g1g1g1g1g1g1']);
});
