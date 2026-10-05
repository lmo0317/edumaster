'use strict';
// The whole analysis path (analyze → proofread → focused re-reads → STEP alignment → source checks) with a
// scripted model that reproduces DeepSeek's real 2026-09-29 answers for the chem case.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const prompts = require('../server/prompts');
const { analyzeMaterial } = require('../server/pipeline');
const { openStore } = require('../server/store');
const { Budget } = require('../server/llm');

const ANALYSIS = {
  title: '화학', subject: '화학', topic: '반응량',
  problem: {
    text: String.raw`다음은 반응식이다.` + '\n' + String.raw`$\frac{b}{x} \times \frac{\ce{C}의 질량 + \ce{D}의 질량}{\ce{B}의 질량}$ 은? (단, 실린더 속 기체의 온도와 압력은 일정하다.) (3점)`,
    choices: ['$\\frac{1}{5}$', '$\\frac{2}{5}$', '$\\frac{3}{5}$', '$\\frac{4}{5}$', '1'], answer: 2,
  },
  steps: [
    { marker: 'step1', title: '실험 Ⅰ에서 한계 반응물 구하기', work: '만약 A가 모두 반응했다면 … 모순이다.', result: 'B' },
    { marker: 'step2', title: '반응 후 양 구하기', work: 'A w g의 양(mol)을 n이라 하면', result: '' },
    { marker: 'step3', title: 'A~D의 물질량 구하기', work: 'A와 B의 물질량은 같다', result: 'b=3' },
    { marker: 'step4', title: '최종 계산', work: '3/15 × 2 = 2/5', result: '' },
  ],
  stepMarkers: [], techniques: [],
  verification: { program: ['b = 3', 'x = 15', 'ans = b / x * 2'], answer: 'ans', choices: ['1/5', '2/5', '3/5', '4/5', '1'] },
};
const QUESTION = String.raw`$\dfrac{b}{x} \times \dfrac{\text{C의 몰질량} + \text{D의 몰질량}}{\text{B의 몰질량}}$은? (단, 실린더 속 기체의 온도와 압력은 일정하다.) (3점)`;
const HEADINGS = { steps: [{ marker: 'step1', title: 'Ⅰ에서 한계 반응물을 구한다.' }, { marker: 'step2', title: 'Ⅰ~Ⅲ에서 반응 후 기체의 질량(g)과 양(mol)을 구한다.' }, { marker: 'step3', title: 'A~D의 물질량을 구한다.' }] };

test('analysis path fixes the misread question word, the STEP count and the step titles', async () => {
  const store = openStore(fs.mkdtempSync(path.join(os.tmpdir(), 'em2-an-')));
  const img = store.files.saveDataUrl('data:image/png;base64,' + Buffer.alloc(300, 1).toString('base64'));
  const material = { id: 'm1', note: '', images: { problem: img.id, solution: img.id, sameImage: false, views: { problem: [], solution: [] } } };
  const answers = {
    [prompts.ANALYZE_SYSTEM]: () => ANALYSIS,
    [prompts.PROOFREAD_SYSTEM]: () => ({ fixes: [], solutionStepCount: 3 }),
    [prompts.REREAD_QUESTION_SYSTEM]: () => ({ question: QUESTION }),
    [prompts.REREAD_HEADINGS_SYSTEM]: () => HEADINGS,
    [prompts.REGROUP_SYSTEM]: () => ({ groups: [{ steps: [1] }, { steps: [2] }, { steps: [3, 4] }] }),
  };
  const ctx = { store, job: { id: 'j' }, budget: new Budget({ maxCalls: 10, maxTokens: 1e6 }), log() {},
    llm: { json: async ({ system }) => ({ data: JSON.parse(JSON.stringify(answers[system]())) }) } };
  const r = await analyzeMaterial(ctx, material);
  const question = r.problem.text.split('\n').pop();
  assert.ok(question.includes('\\ce{C}의 몰질량') && !/[^몰]질량/.test(question.replace(/몰질량/g, '')), question);
  assert.equal(r.steps.length, 3);
  assert.deepEqual(r.steps.map((s) => s.title), ['Ⅰ에서 한계 반응물을 구한다', 'Ⅰ~Ⅲ에서 반응 후 기체의 질량(g)과 양(mol)을 구한다', 'A~D의 몰질량을 구한다']);
  assert.ok(!r.steps.some((s) => s.work.includes('물질량')), 'confusable partner corrected in the solution too');
  assert.equal(r.checks.find((c) => c.id === 'source-calculation').state, 'pass');
  assert.ok(r.proofread.some((p) => p.includes('발문 재판독')));
  assert.ok(r.uncertainties.some((u) => u.startsWith('단어 확인:')), 'confusable words are always asked of the teacher');
});

// Gemma's real bio transcription (2026-09-29): handwriting and a value the solution derives (2cm/ms) were
// written into the problem as a "그림 설명". The leak check triggers a printed-only re-read of the problem.
test('a derived value in the problem text triggers a printed-only re-read that replaces the polluted text', async () => {
  const store = openStore(fs.mkdtempSync(path.join(os.tmpdir(), 'em2-an-')));
  const img = store.files.saveDataUrl('data:image/png;base64,' + Buffer.alloc(300, 1).toString('base64'));
  const material = { id: 'm2', note: '', images: { problem: img.id, solution: img.id, sameImage: false, views: { problem: [], solution: [] } } };
  const clean = [
    '다음은 민말이집 신경 A와 B의 흥분 전도와 전달에 대한 자료이다.',
    String.raw`○ 그림은 A와 B의 지점 $d_1 \sim d_4$의 위치를 나타낸 것이다. B는 2개의 뉴런으로 구성되어 있고, ㉠~㉢ 중 한 곳에만 시냅스가 있다.`,
    String.raw`○ B를 구성하는 두 뉴런의 흥분 전도 속도는 $1\text{cm/ms}$로 같다.`,
    String.raw`이에 대한 설명으로 옳은 것만을 <보기>에서 있는 대로 고른 것은? (단, 휴지 전위는 $-70\text{mV}$이다.) (3점)`,
  ].join('\n');
  const polluted = clean.replace('○ B를', '(그림 설명)\n' + String.raw`- 속도 표시: A 신경 위에는 $2\text{cm/ms}$라고 적혀 있음. $d_4$ 부근에 '시냅스 존재' 표시가 있음.` + '\n○ B를');
  const bio = {
    title: '생명', subject: '생명과학', topic: '흥분 전도',
    problem: { text: polluted, choices: ['ㄱ', 'ㄴ', 'ㄱ, ㄴ', 'ㄱ, ㄷ', 'ㄴ, ㄷ'], answer: 2 },
    steps: [
      { marker: 'step1', title: '지점 매칭', work: '막전위로 지점을 찾는다', result: 'Ⅰ=d4' },
      { marker: 'step2', title: 'A의 속도', work: 'A의 흥분 전도 속도는 2cm/ms', result: 'A의 속도 2cm/ms' },
      { marker: 'step3', title: 't1과 시냅스', work: '시냅스는 ㉢', result: 't1 = 4ms' },
    ],
    stepMarkers: ['step1', 'step2', 'step3'], techniques: [],
    verification: { program: ['vA = 2', 't1 = 4'], answer: 'ans', choices: ['ㄱ', 'ㄴ', 'ㄱ, ㄴ', 'ㄱ, ㄷ', 'ㄴ, ㄷ'], checks: [{ expr: 't1 == 4' }] },
  };
  const reads = [];
  const answers = {
    [prompts.ANALYZE_SYSTEM]: () => bio,
    [prompts.PROOFREAD_SYSTEM]: () => ({ fixes: [], solutionStepCount: 3 }),
    [prompts.REREAD_PROBLEM_SYSTEM]: () => ({ text: clean, figure: 'A, B의 d1~d4 위치' }),
    [prompts.REREAD_QUESTION_SYSTEM]: () => ({ question: clean.split('\n').pop() }),
    [prompts.REREAD_HEADINGS_SYSTEM]: () => ({ steps: bio.steps.map((s) => ({ marker: s.marker, title: s.title })) }),
  };
  const ctx = { store, job: { id: 'j' }, budget: new Budget({ maxCalls: 12, maxTokens: 1e6 }), log() {},
    llm: { json: async ({ system, purpose, text }) => { reads.push({ purpose, text }); return { data: JSON.parse(JSON.stringify(answers[system]())) }; } } };
  const r = await analyzeMaterial(ctx, material);
  const reread = reads.filter((x) => x.purpose === 'reread-problem');
  assert.equal(reread.length, 1);
  assert.match(reread[0].text, /2cm\/ms/, 'the suspected value is named to the reader');
  assert.ok(!r.problem.text.includes('cm/ms}$라고') &&!r.problem.text.includes('시냅스 존재'), r.problem.text);
  assert.equal(r.problem.figure, 'A, B의 d1~d4 위치');
  assert.equal(r.checks.find((c) => c.id === 'derived-value-in-problem').state, 'pass');
  assert.equal(r.checks.find((c) => c.id === 'source-calculation').state, 'pass', 'ㄱㄴㄷ problem checked by its conditions');
  assert.ok(r.proofread.some((p) => p.includes('문제 본문 재판독')));
});

// Gemma's real bio verification (2026-09-29) used a name it never assigned ("synapse_at_C == True").
test('a source verification program that does not run is fixed once with the error, not reported as a number mismatch', async () => {
  const store = openStore(fs.mkdtempSync(path.join(os.tmpdir(), 'em2-an-')));
  const img = store.files.saveDataUrl('data:image/png;base64,' + Buffer.alloc(300, 1).toString('base64'));
  const material = { id: 'm3', note: '', images: { problem: img.id, solution: img.id, sameImage: false, views: { problem: [], solution: [] } } };
  const broken = { program: ['vA = 2', 't1 = 4'], answer: '2', choices: ['t1 == 5', 'synapse_at_C == True', '1', '2', '3'], checks: [] };
  const analysis = {
    title: '생명', subject: '생명과학', topic: '흥분 전도',
    problem: { text: '다음은 신경에 대한 자료이다.\n이에 대한 설명으로 옳은 것만을 <보기>에서 있는 대로 고른 것은?', choices: ['ㄱ', 'ㄴ', 'ㄱ, ㄴ', 'ㄱ, ㄷ', 'ㄴ, ㄷ'], answer: 2 },
    steps: [{ title: '속도', work: 'A의 속도', result: 'vA' }], stepMarkers: [], techniques: [], verification: broken,
  };
  const calls = [];
  const answers = {
    [prompts.ANALYZE_SYSTEM]: () => analysis,
    [prompts.PROOFREAD_SYSTEM]: () => ({ fixes: [], solutionStepCount: 1 }),
    [prompts.REREAD_QUESTION_SYSTEM]: () => ({ question: '이에 대한 설명으로 옳은 것만을 <보기>에서 있는 대로 고른 것은?' }),
    [prompts.REREAD_HEADINGS_SYSTEM]: () => ({ steps: [{ marker: '', title: '속도' }] }),
    [prompts.FIX_VERIFICATION_SYSTEM]: () => ({ verification: { program: ['vA = 2', 't1 = 4'], answer: '', choices: [], checks: [{ expr: 't1 == 4', desc: 't1' }] } }),
  };
  const ctx = { store, job: { id: 'j' }, budget: new Budget({ maxCalls: 12, maxTokens: 1e6 }), log() {},
    llm: { json: async ({ system, purpose, text }) => { calls.push({ purpose, text }); return { data: JSON.parse(JSON.stringify(answers[system]())) }; } } };
  const r = await analyzeMaterial(ctx, material);
  const fix = calls.filter((c) => c.purpose === 'fix-verification');
  assert.equal(fix.length, 1);
  assert.match(fix[0].text, /synapse_at_C/, 'the model sees the error');
  assert.equal(r.checks.find((c) => c.id === 'source-calculation').state, 'pass');
  assert.ok(r.proofread.some((p) => p.includes('실행 오류를 고쳐')));
});

// Opus (2026-09-29) restated the printed speed "1cm/ms" in a STEP result; that is not handwriting.
test('a value both printed-only re-reads keep is a printed condition, not a leak', async () => {
  const store = openStore(fs.mkdtempSync(path.join(os.tmpdir(), 'em2-an-')));
  const img = store.files.saveDataUrl('data:image/png;base64,' + Buffer.alloc(300, 1).toString('base64'));
  const material = { id: 'm4', note: '', images: { problem: img.id, solution: img.id, sameImage: false, views: { problem: [], solution: [] } } };
  const text = '다음은 민말이집 신경 A와 B의 흥분 전도에 대한 자료이다.\nB를 구성하는 두 뉴런의 흥분 전도 속도는 1cm/ms로 같다.\n이에 대한 설명으로 옳은 것만을 <보기>에서 있는 대로 고른 것은?';
  const analysis = {
    title: '생명', subject: '생명과학', topic: '흥분 전도', problem: { text, choices: ['ㄱ', 'ㄴ'], answer: 1 },
    steps: [{ title: '속도', work: 'B의 속도는 1cm/ms', result: 'B의 속도 1cm/ms' }], stepMarkers: [], techniques: [],
  };
  let rereads = 0;
  const answers = {
    [prompts.ANALYZE_SYSTEM]: () => analysis,
    [prompts.PROOFREAD_SYSTEM]: () => ({ fixes: [], solutionStepCount: 0 }),
    [prompts.REREAD_PROBLEM_SYSTEM]: () => { rereads++; return { text }; },
    [prompts.REREAD_QUESTION_SYSTEM]: () => ({ question: '이에 대한 설명으로 옳은 것만을 <보기>에서 있는 대로 고른 것은?' }),
    [prompts.REREAD_HEADINGS_SYSTEM]: () => ({ steps: [] }),
  };
  const ctx = { store, job: { id: 'j' }, budget: new Budget({ maxCalls: 12, maxTokens: 1e6 }), log() {},
    llm: { json: async ({ system }) => ({ data: JSON.parse(JSON.stringify(answers[system]())) }) } };
  const r = await analyzeMaterial(ctx, material);
  assert.equal(rereads, 2);
  assert.deepEqual(r.printedValues, ['1cm/ms']);
  assert.equal(r.checks.find((c) => c.id === 'derived-value-in-problem').state, 'pass');
  assert.ok(!r.uncertainties.some((u) => u.includes('1cm/ms')), r.uncertainties.join(' | '));
});

// Qwen 3.6, 2026-10-05: the first read had 몰질량 right, both question rereads read 물질량, and the harness "fixed"
// the question and every STEP into the error — though the teacher had once corrected 물질량 → 몰질량 and the step
// headings, read separately, said 몰질량. A reread may not undo a teacher's correction or contradict the headings.
test('two agreeing rereads do not turn a word back into what a teacher corrected', async () => {
  const store = openStore(fs.mkdtempSync(path.join(os.tmpdir(), 'em2-an-')));
  store.corrections.put({ id: 'a1b2c3d4e5f60718', wrong: '물질량', right: '몰질량', count: 1, lastAt: '2026-09-30T00:00:00Z' });
  const img = store.files.saveDataUrl('data:image/png;base64,' + Buffer.alloc(300, 1).toString('base64'));
  const material = { id: 'm1', note: '', images: { problem: img.id, solution: img.id, sameImage: false, views: { problem: [], solution: [] } } };
  const right = JSON.parse(JSON.stringify(ANALYSIS).replace(/의 질량/g, '의 몰질량').replace(/물질량/g, '몰질량'));
  const answers = {
    [prompts.ANALYZE_SYSTEM]: () => right,
    [prompts.PROOFREAD_SYSTEM]: () => ({ fixes: [], solutionStepCount: 3 }),
    [prompts.REREAD_QUESTION_SYSTEM]: () => ({ question: QUESTION.replace(/몰질량/g, '물질량') }),
    [prompts.REREAD_HEADINGS_SYSTEM]: () => JSON.parse(JSON.stringify(HEADINGS).replace(/물질량/g, '몰질량')),
    [prompts.REGROUP_SYSTEM]: () => ({ groups: [{ steps: [1] }, { steps: [2] }, { steps: [3, 4] }] }),
  };
  const ctx = { store, job: { id: 'j' }, budget: new Budget({ maxCalls: 12, maxTokens: 1e6 }), log() {},
    llm: { json: async ({ system }) => ({ data: JSON.parse(JSON.stringify((answers[system] || (() => ({})))())) }) } };
  const r = await analyzeMaterial(ctx, material);
  assert.ok(!r.problem.text.includes('물질량'), r.problem.text);
  assert.ok(!r.steps.some((s) => (s.title + s.work).includes('물질량')), 'the solution keeps 몰질량');
  assert.ok(r.proofread.some((p) => p.includes('어긋나')), 'the refused change is recorded');
});
