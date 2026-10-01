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
  assert.ok(r.uncertainties.some((u) => u.startsWith('단어 확인:') && u.includes('"부피비"') && u.includes('"질량비"')), 'and asked of the teacher');
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

test('the analysis prompt carries 지침, then this problem\'s feedback, then the lessons, each as its own block', () => {
  const { analyzeText } = require('../server/prompts');
  const text = analyzeText({ hasSolution: true, guides: [{ text: '필기는 조건에 넣지 않는다' }], feedback: [{ text: 'STEP 2와 3을 나눠 주세요' }, { text: '표 Ⅲ의 B는 필기' }], lessons: [{ text: '해설은 쉽게 풀어 쓴다' }] });
  assert.match(text, /\[분석 지침[^\]]*\]\n- 필기는 조건에 넣지 않는다\n\[이 문제의 분석 피드백[^\]]*\]\n- STEP 2와 3을 나눠 주세요\n- 표 Ⅲ의 B는 필기\n\[모든 문제에서 배운 분석 교훈[^\]]*\]\n- 해설은 쉽게 풀어 쓴다/);
  assert.match(text, /STEP 개수 규칙과 해설을 그대로 옮기는 규칙보다 우선/);
  assert.doesNotMatch(analyzeText({ hasSolution: true }), /분석 (지침|피드백|교훈)/);
});

test('the generation prompt labels each item 지침 / 이 문제 / 전체 학습 and says which wins', () => {
  const { rulesBlock } = require('../server/prompts');
  const text = rulesBlock([{ id: 'g1', layer: 'guide', kind: 'dont', text: '조건 낭비' }, { id: 'p1', layer: 'problem', kind: 'feedback', target: 'problem', text: '가정→모순' }, { id: 'l1', layer: 'lesson', kind: 'feedback', text: '작은 수' }]);
  assert.match(text, /지침 > 이 문제 > 전체 학습/);
  assert.match(text, /- \(g1\) \[지침·하지 말 것\] 조건 낭비\n- \(p1\) \[이 문제·문제\] 가정→모순\n- \(l1\) \[전체 학습\] 작은 수/);
});

test('learning picks by stage and layer, and older learning moves into the one store once', () => {
  const { selectRules, analysisLearning, migrateLearning, makeRule } = require('../server/learning');
  const at = (d) => `2026-10-0${d}T00:00:00.000Z`;
  const m = { id: 'm1', subject: '화학', problem: { text: '' } };
  const rules = [
    { ...makeRule({ text: '이 문제 생성', scope: 'material', source: { materialId: 'm1' } }), createdAt: at(2) },
    { ...makeRule({ text: '이 문제 분석', scope: 'material', stage: 'analysis', source: { materialId: 'm1' } }), createdAt: at(2) },
    { ...makeRule({ text: '다른 문제', scope: 'material', source: { materialId: 'm2' } }), createdAt: at(2) },
    { ...makeRule({ text: '생성 교훈', scope: 'global', layer: 'lesson' }), createdAt: at(1) },
    { ...makeRule({ text: '생성 지침', scope: 'global', layer: 'guide' }), createdAt: at(3) },
    { ...makeRule({ text: '분석 지침', scope: 'global', layer: 'guide', stage: 'analysis' }), createdAt: at(1) },
  ];
  assert.deepEqual(selectRules(rules, m).map((r) => r.text), ['생성 지침', '이 문제 생성', '생성 교훈'], '지침 first, then this problem, then lessons; generation only');
  const a = analysisLearning(rules, m);
  assert.deepEqual([a.guides, a.own, a.lessons].map((l) => l.map((r) => r.text)), [['분석 지침'], ['이 문제 분석'], []]);

  const mem = (list) => { const map = new Map(list.map((x) => [x.id, x])); return { all: () => [...map.values()], put: (x) => { map.set(x.id, x); return x; } }; };
  const store = { rules: mem([{ id: 'r1', text: '하지 말 것', scope: 'global', status: 'approved', createdAt: at(1) }, { id: 'r2', text: '유형별', scope: 'topic', status: 'approved', createdAt: at(1) }]),
    materials: mem([{ id: 'm1', title: 'P', analysisFeedback: [{ text: 'STEP 4개', at: at(2) }] }]) };
  let saved = null;
  const moved = migrateLearning(store, { commonAnalysis: [{ text: '쉽게 풀어 쓴다', at: at(3) }] }, (p) => { saved = p; });
  assert.equal(moved, 4);
  const byText = new Map(store.rules.all().map((r) => [r.text, r]));
  assert.deepEqual(['하지 말 것', '유형별', 'STEP 4개', '쉽게 풀어 쓴다'].map((t) => [byText.get(t).scope, byText.get(t).layer, byText.get(t).stage]),
    [['global', 'guide', 'generation'], ['global', 'lesson', 'generation'], ['material', undefined, 'analysis'], ['global', 'lesson', 'analysis']]);
  assert.equal(byText.get('STEP 4개').source.materialId, 'm1');
  assert.equal(byText.get('STEP 4개').createdAt, at(2), 'keeps when it was taught');
  assert.deepEqual(store.materials.all()[0].analysisFeedback, []);
  assert.deepEqual(saved, { commonAnalysis: [] });
  assert.equal(migrateLearning(store, {}, () => {}), 0, 'once');
});

test('the generation prompt shows adopted examples as models, not to copy', () => {
  const { generateText } = require('../server/prompts');
  const material = { problem: { text: '원본', choices: [] }, steps: [{ title: 'S1', work: 'w' }], techniques: [] };
  const examples = [{ label: 'STEP 1 연습', problem: { text: '채택된 문제 본문', choices: ['1', '2'], answer: 2 }, solution: { steps: [{ step: 1, title: 'S1', work: '채택된 해설' }] } }];
  const text = generateText({ material, stage: { kind: 'upto', upto: 1 }, total: 1, mode: 'integrated', prior: [], rules: [], variantNo: 1, examples });
  assert.match(text, /선생님이 채택한 좋은 예시[\s\S]*그대로 쓰지 않고[\s\S]*채택된 문제 본문[\s\S]*정답: 2번[\s\S]*채택된 해설/);
  assert.doesNotMatch(generateText({ material, stage: { kind: 'upto', upto: 1 }, total: 1, mode: 'integrated', prior: [], rules: [], variantNo: 1 }), /채택한 좋은 예시/);
});
