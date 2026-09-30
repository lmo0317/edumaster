'use strict';
// Regression tests for the code harness, built from real failures: v1 fixtures (cf8e, d2aa) and outputs of
// the 2026-09-29 model comparison (DeepSeek's 물질량 misread, Gemma's broken table).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const harness = require('../server/harness');

const FIX = path.join(__dirname, 'fixtures');

test('focused re-read corrects 물질량 → 몰질량 only when both reads agree (real DeepSeek outputs)', () => {
  const analysis = String.raw`$\frac{b}{x} \times \frac{\ce{C}의 물질량 + \ce{D}의 물질량}{\ce{B}의 물질량}$ 은? (단, 실린더 속 기체의 온도와 압력은 일정하다.) (3점)`;
  const readA = String.raw`\(\dfrac{b}{x} \times \dfrac{\text{C의 몰질량} + \text{D의 몰질량}}{\text{B의 몰질량}}\)은? (단, 실린더 속 기체의 온도와 압력은 일정하다.) (3점)`;
  const readB = readA;
  assert.deepEqual(harness.hangulFixes(analysis, readA, readB), [['물질량', '몰질량'], ['물질량', '몰질량'], ['물질량', '몰질량']]);
  assert.ok(harness.applyWordFixes(analysis, [['물질량', '몰질량']]).includes(String.raw`\ce{C}의 몰질량`));
  // The two focused reads disagree (the 5x run read 물질량 once): no change.
  assert.deepEqual(harness.hangulFixes(analysis, readA, readA.replace('C의 몰질량', 'C의 물질량')), []);
  // Words that differ by more than one letter are left for the teacher.
  assert.deepEqual(harness.hangulFixes('A~D의 물질량 구하기', 'A~D의 몰질량을 구한다', 'A~D의 몰질량을 구한다'), []);
});

test('helper letters defined by the teacher are found and must survive in the variant solution', () => {
  const work = String.raw`$\ce{A(g)}$ $w$ g의 양(mol)을 $n$, $\ce{B(g)}$ $w$ g의 양(mol)을 $m$이라 하면 Ⅰ에서 $\ce{A(g)}$는 $5n$ mol 중 $\frac{5}{3}n$ mol이 반응하고`;
  assert.deepEqual(harness.helperVariables(work).sort(), ['m', 'n']);
  const material = { problem: { text: '원본', choices: ['1', '2', '3', '4', '5'] }, steps: [{ title: 'S1', work: '만약 A가 모두 반응했다고 가정하면 모순' }, { title: 'S2', work, technique: '' }] };
  const item = (solutionWork) => ({ stage: { kind: 'upto', upto: 2 }, problem: { text: '문제', choices: ['1', '2', '3', '4', '5'], answer: 1 }, solution: { steps: [{ step: 1, work: '가정하면 모순' }, { step: 2, work: solutionWork }] } });
  const failed = (it) => harness.inspectItem(material, it, 'integrated').filter((c) => c.state === 'fail').map((c) => c.id);
  assert.deepEqual(failed(item('A는 $3n$ mol, B는 $2m$ mol')), []);
  assert.deepEqual(failed(item('A는 3 mol, B는 2 mol')), ['source-method']);
});

test('v1 d2aa fixture: STEP 1 practice keeps the assumption→contradiction; a solution without it is flagged', () => {
  const d = JSON.parse(fs.readFileSync(path.join(FIX, 'd2aa-stage1.json'), 'utf8'));
  const material = { problem: { text: d.sourceProblem, choices: ['1', '2', '3', '4', '5'] }, steps: d.sourceSteps.map((s) => ({ title: s.slice(0, 30), work: s, technique: '' })) };
  const item = { stage: { kind: 'upto', upto: 1 }, problem: { text: d.body, choices: d.choices, answer: 2 }, solution: { steps: [{ step: 1, work: d.explanation }] } };
  const ids = (it) => harness.inspectItem(material, it, 'integrated').filter((c) => c.state === 'fail').map((c) => c.id);
  assert.ok(!ids(item).includes('source-assumption'));
  assert.ok(ids({ ...item, solution: { steps: [{ step: 1, work: '실험 Ⅰ에서 남은 것은 A이므로 한계 반응물은 B이다.' }] } }).includes('source-assumption'));
});

test('stage clue leak: printing the leftover reactant (A/B) in a practice table is flagged', () => {
  const material = { problem: { text: '원본', choices: [] }, steps: [{ title: 'Ⅰ에서 한계 반응물을 구한다', work: '가정하면 모순이므로 B가 모두 반응' }] };
  const table = (cell) => `| 실험 | A | B | 반응 후 |\n|---|---|---|---|\n| Ⅰ | $6w$ | $4w$ | ${cell} |`;
  const check = (cell) => harness.inspectItem(material, { stage: { kind: 'upto', upto: 1 }, problem: { text: table(cell), choices: [], answer: 0 }, solution: { steps: [] } }, 'integrated').find((c) => c.id === 'stage-clue-leak');
  assert.equal(check('$\\ce{A}$ $2w$').state, 'fail');
  assert.equal(check('$2w$').state, 'pass');
});

test('O/X judgments in the solution must match the chosen ㄱㄴㄷ combination (v1 explanation-consistency)', () => {
  const problem = { text: '<보기>\nㄱ. t1은 5ms이다.\nㄴ. 시냅스는 ㉢에 있다.\nㄷ. A의 Ⅱ에서 탈분극이 일어나고 있다.', choices: ['ㄱ', 'ㄴ', 'ㄱ, ㄷ', 'ㄴ, ㄷ', 'ㄱ, ㄴ, ㄷ'], answer: 2 };
  const solution = (s) => ({ steps: [{ step: 3, work: s }] });
  const material = { problem: { text: '', choices: problem.choices }, steps: [] };
  const get = (s, answer) => harness.inspectItem(material, { stage: { kind: 'twin' }, problem: { ...problem, answer }, solution: solution(s) }, 'numeric').find((c) => c.id === 'explanation-consistency');
  const text = 'ㄱ. t1은 4ms이다. (X)\nㄴ. 시냅스는 ㉢에 있다. (O)\nㄷ. 재분극이 일어난다. (X)';
  assert.equal(get(text, 2).state, 'pass');
  assert.equal(get(text, 4).state, 'fail');
});

test('integrated final with the same text skeleton as the original is flagged by code', () => {
  const original = '표 | Ⅰ | 5w | 5w |\n$\\frac{b}{x}$은?';
  const material = { problem: { text: original, choices: [] }, steps: [] };
  const item = (text) => ({ stage: { kind: 'twin' }, problem: { text, choices: [], answer: 0 }, solution: { steps: [] } });
  const v = (text) => harness.inspectItem(material, item(text), 'integrated').find((c) => c.id === 'variant-design').state;
  assert.equal(v('표 | Ⅰ | 7w | 3w |\n$\\frac{b}{x}$은?'), 'fail');
  assert.equal(v('표 | Ⅰ | 7w | 3w | 생성물 질량 |\n$\\frac{x}{b}$은?'), 'pass');
});

test('format check catches Gemma output: LaTeX outside $ and a table whose rows have different widths', () => {
  const gemma = String.raw`| 실험 | 반응 전 | 반응 후 | \frac{\text{D의 양(mol)}}{\text{전체 기체의 양(mol)}} (상댓값) |
| :--- | :--- | :--- |
| I | $5w$ | $5w$ | $x$ |`;
  const issues = harness.formatIssues(gemma);
  assert.ok(issues.some((i) => i.includes('$ 밖')));
  assert.ok(issues.some((i) => i.includes('칸 수')));
  assert.deepEqual(harness.formatIssues(String.raw`| a | $\frac{1}{2}$ |` + '\n' + '| 1 | 2 |'), []);
});

test('analysis: a value the solution derives that already sits in the problem is flagged (v1 cf8e: pencilled 2cm/ms)', async () => {
  const { sourceChecks } = require('../server/pipeline');
  const d = JSON.parse(fs.readFileSync(path.join(FIX, 'cf8e-stage2.json'), 'utf8'));
  const material = {
    problem: { text: d.sourceProblem, choices: ['ㄱ', 'ㄴ', 'ㄱ, ㄷ', 'ㄴ, ㄷ', 'ㄱ, ㄴ, ㄷ'], answer: 2 },
    steps: [{ result: 'd3은 Ⅲ' }, { result: '신경 A의 흥분 전도 속도는 2cm/ms' }, { result: 't1 = 4, 시냅스는 ㉢' }],
    sourceVerification: null,
  };
  const leak = (await sourceChecks(material)).find((c) => c.id === 'derived-value-in-problem');
  assert.equal(leak.state, 'fail');
  assert.match(leak.evidence, /STEP 2에서 구하는 2cm\/ms/);
  const clean = (await sourceChecks({ ...material, problem: { ...material.problem, text: d.sourceProblem.replace(/2\s*cm\/ms/g, '') } })).find((c) => c.id === 'derived-value-in-problem');
  assert.equal(clean.state, 'pass');
});

test('analysis: the original answer is recomputed from the transcription', async () => {
  const { sourceChecks } = require('../server/pipeline');
  const base = { problem: { text: '문제', choices: ['1/5', '2/5', '3/5', '4/5', '1'], answer: 2 }, steps: [] };
  const ok = await sourceChecks({ ...base, sourceVerification: { program: ['b = 3', 'x = 15', 'ans = b / x * 2'], answer: 'ans', choices: ['1/5', '2/5', '3/5', '4/5', '1'] } });
  assert.equal(ok.find((c) => c.id === 'source-calculation').state, 'pass');
  const misread = await sourceChecks({ ...base, sourceVerification: { program: ['b = 3', 'x = 18', 'ans = b / x * 2'], answer: 'ans', choices: ['1/5', '2/5', '3/5', '4/5', '1'] } });
  assert.equal(misread.find((c) => c.id === 'source-calculation').state, 'fail');
});

test('re-read also restores a missing letter (질량 → 몰질량), and fixes stay on whole words', () => {
  const analysis = String.raw`$\frac{b}{x} \times \frac{\ce{C}의 질량 + \ce{D}의 질량}{\ce{B}의 질량}$ 은? (3점)`;
  const read = String.raw`$\dfrac{b}{x} \times \dfrac{\text{C의 몰질량} + \text{D의 몰질량}}{\text{B의 몰질량}}$은? (3점)`;
  const fixes = harness.hangulFixes(analysis, read, read);
  assert.deepEqual([...new Set(fixes.map((f) => f.join('→')))], ['질량→몰질량']);
  const fixed = harness.applyWordFixes(analysis + ' 이미 몰질량', fixes);
  assert.ok(fixed.includes('\ce{C}의 몰질량') && fixed.endsWith('이미 몰질량') && !fixed.includes('몰몰'));
});

test('a confirmed confusable word corrects the same slip in the solution, particles included', () => {
  const known = harness.confusableFixes(['몰질량']);
  assert.deepEqual(known, [['물질량', '몰질량']]);
  assert.equal(harness.applySubstringFixes('A~D의 물질량을 구한다', known), 'A~D의 몰질량을 구한다');
  assert.deepEqual(harness.confusableFixes(['온도']), []);
});

test('two agreeing re-reads restore a number a proofreader changed (Gemma: 휴지 전위 -70 → -80)', () => {
  const line = '(단, A와 B에서 흥분의 전도는 각각 1회 일어났고, 휴지 전위는 $-80\text{mV}$이다.)';
  const read = '이에 대한 설명으로 옳은 것만을 <보기>에서 있는 대로 고른 것은? (단, A와 B에서 흥분의 전도는 각각 1회 일어났고, 휴지 전위는 －70mV이다.)';
  assert.deepEqual(harness.hangulFixes(line, read, read), [['-80', '-70']]);
});
