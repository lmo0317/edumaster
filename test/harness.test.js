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

test('the substance the teacher supposes used up stays the same (R11 molar final supposed B)', () => {
  const material = { problem: { text: '원본', choices: [] }, steps: [{ title: 'S1', work: '만약 Ⅰ에서 A가 모두 반응했다면 … 주어진 자료와 맞지 않다. 따라서 Ⅰ에서 모두 반응한 것은 B이다.' }] };
  const check = (work) => harness.inspectItem(material, { stage: { kind: 'twin' }, problem: { text: '문제', choices: [] }, solution: { steps: [{ step: 1, work }] } }, 'integrated').find((c) => c.id === 'source-assumption-substance');
  assert.equal(check('만약 Ⅱ에서 A가 모두 반응했다면 … 맞지 않다. 따라서 Ⅱ에서 모두 반응한 것은 B이다.').state, 'pass', 'another experiment is fine');
  const b = check('만약 Ⅰ에서 B가 모두 반응했다면 … 맞지 않다. 따라서 Ⅰ에서 모두 반응한 것은 A이다.');
  assert.equal(b.state, 'fail');
  assert.match(b.evidence, /A가 모두 반응했다"고 가정/);
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

test('an obvious-leftover row comes back with rows the server computed for the solution\'s mass ratio', () => {
  const harness = require('../server/harness');
  const material = { problem: { text: '| Ⅰ | $5w$ | $5w$ | $2w$ |' }, steps: [{ title: 'S1', technique: '가정→모순', work: '만약 A가 모두 반응했다면 맞지 않다' }, { title: 'S2', work: '' }] };
  const item = { stage: { kind: 'upto', upto: 2 }, problem: { text: '| Ⅰ | $6w$ | $8w$ | $2w$ |\n| Ⅲ | $w$ | $5w$ | $3w$ |', choices: [] }, solution: { steps: [{ step: 1, work: '반응 질량비는 A : B $=1:2$이다' }] } };
  const c = harness.inspectItem(material, item, 'integrated').find((x) => x.id === 'source-assumption-needed');
  assert.equal(c.state, 'fail');
  const rows = [...c.evidence.matchAll(/A \$(\d+)w\$, B \$(\d+)w\$ → (A|B)가 모두 반응, (A|B) \$(\d*)w\$ 남음/g)];
  assert.ok(rows.length >= 2);
  for (const [, a, b, all, rest, l] of rows) {
    const [A, B, left] = [Number(a), Number(b), Number(l || 1)];
    // A : B = 1 : 2 reacts; what is left is a whole w, lighter than both, and on the side the row says.
    assert.equal(all === 'B' ? A - B / 2 : B - 2 * A, left);
    assert.ok(left < Math.min(A, B) && rest !== all);
    assert.ok(!(A === 6 && B === 8) && !(A === 5 && B === 5), 'rows already used are not offered');
  }
});

test('a final in the original table shape is told which cells and rows it can change', () => {
  const text = '| 실험 | 반응 전 A의 질량(g) | 반응 전 B의 질량(g) | 반응 후 남은 질량(g) | 상댓값 |\n|---|---|---|---|---|\n| Ⅰ | $5w$ | $5w$ | $\frac{10}{3}w$ | $x$ |\n| Ⅱ | $4w$ | $6w$ | $w$ | $18$ |\n| Ⅲ | $3w$ | $9w$ | $5w$ | $20$ |';
  const hint = harness.shapeOptions(text);
  assert.match(hint, /실험 Ⅰ, Ⅱ, Ⅲ 3개, 숨긴 값 Ⅰ의 '상댓값'/);
  assert.match(hint, /Ⅱ의 '상댓값'/, 'the hidden value can move to another row');
  assert.match(hint, /실험 Ⅳ를 더해 4개/);
});

test('the nerve A row must come out of the membrane-potential graph for some speed, t1 and order of Ⅰ~Ⅳ', () => {
  const figure = '지점 위치: $d_1=0$, $d_2=2$, $d_3=5$, $d_4=7$ (cm). 자극은 A와 B의 $d_3$에 준다.\n[막전위 그래프] 휴지 전위 $-70$에서 시작해 1 ms에 약 $-60$, 1.5 ms에 0(상승), 2 ms에 최고점 $+30$, 2.5 ms에 0(하강), 3 ms에 최저점 $-80$, 이후 약 4 ms까지 $-70$ 부근으로 회복한다.';
  const item = (a) => ({ problem: { text: `표는 A와 B의 $d_3$에 역치 이상의 자극을 동시에 1회 주고 …\n\n| 신경 | Ⅰ | Ⅱ | Ⅲ | Ⅳ |\n|---|---|---|---|---|\n| A | ${a} |\n| B | $0$ | $-60$ | ? | ? |`, figure } });
  assert.deepEqual(harness.checkNerveRow(item('$-80$ | $0$ | ? | $0$')), [], 'the original: 2 cm/ms, t1 = 4 ms');
  const [bad] = harness.checkNerveRow(item('$+30$ | $+30$ | $+30$ | $-80$'));
  assert.equal(bad.state, 'fail');
  assert.match(bad.evidence, /성립하는 예\(서버 계산\): 속도/);
});

test('a nerve final that keeps the stimulated point, the spacing and the hidden cells is numbers-only before the judge solves it', () => {
  // The original's figure as the analysis wrote it ("1 ms 무렵", "1.5 ms에 상승하면서 0"): read before 2026-10-11 as no graph.
  const figure = '위치 눈금은 $d_1=0$, $d_2=2$, $d_3=5$, $d_4=7\\ \\mathrm{cm}$이다. A와 B 모두 $d_3$에 자극 화살표가 있다.\n[막전위 그래프] 휴지 상태 약 $-70$에서 출발해 1 ms 무렵 $-60$이 되고, 1.5 ms에 상승하면서 $0$을 지나며, 2 ms에 최고점 $+30$에 이른다. 그 뒤 2.5 ms에 하강하면서 $0$을 지나고, 3 ms에 최저점 $-80$에 이른 다음 4 ms에는 약 $-70$으로 돌아온다.';
  assert.deepEqual(harness.nerveSetup('', figure), { ticks: [[1, -60], [1.5, 0], [2, 30], [2.5, 0], [3, -80]], recover: 4, pos: { 1: 0, 2: 2, 3: 5, 4: 7 }, stim: 3 });
  const table = (a, b, stim = 3) => `B는 2개의 뉴런, ㉠~㉢ 중 한 곳에만 시냅스가 있다. $d_${stim}$에 역치 이상의 자극을 주고 …\n\n| 신경 | Ⅰ | Ⅱ | Ⅲ | Ⅳ |\n|---|---|---|---|---|\n| A | ${a} |\n| B | ${b} |`;
  const material = { steps: [], problem: { text: table('$-80$ | $0$ | ? | $0$', '$0$ | $-60$ | ? | ?'), figure } };
  const shape = (text, fig = figure) => harness.inspectItem(material, { stage: { kind: 'twin' }, problem: { text, figure: fig, choices: [] }, solution: { steps: [] } }, 'integrated').find((c) => c.id === 'variant-shape');
  const copy = shape(table('$-80$ | $0$ | ? | $0$', '$-60$ | $-60$ | ? | ?'));
  assert.equal(copy.state, 'fail', 'only B\'s numbers changed (R6 final)');
  assert.match(copy.evidence, /자극 지점을/, 'with the ways out named');
  const turned = `B는 2개의 뉴런, ㉠~㉢ 중 한 곳에만 시냅스가 있다. $d_3$에 역치 이상의 자극을 주고 …\n\n| 지점 | A | B |\n|---|---|---|\n| Ⅰ | $-80$ | $0$ |\n| Ⅱ | $0$ | $-60$ |\n| Ⅲ | ? | ? |\n| Ⅳ | $0$ | ? |`;
  assert.equal(shape(turned).state, 'fail', 'the same table with A and B as columns (R7 final)');
  assert.equal(shape(table('$-80$ | ? | $0$ | $0$', '$0$ | $-60$ | ? | ?')).state, 'pass', 'another hidden cell');
  assert.equal(shape(table('$-80$ | $0$ | ? | $0$', '$0$ | $-60$ | ? | ?', 2), figure.replace('$d_3$에 자극', '$d_2$에 자극')).state, 'pass', 'another stimulated point');
});

test('nerve final: the table is read the way the student reads it — one reading, a one-way synapse, computed examples', () => {
  const nerve = require('../server/nerve');
  const figure = '위치 눈금: $d_1=0$, $d_2=2$, $d_3=5$, $d_4=7$(cm). 왼쪽 끝에 세포체. A와 B의 $d_3$에 자극 화살표.\n[막전위 그래프] 1ms에 −60, 1.5ms에 0, 2ms에 +30, 2.5ms에 0, 3ms에 −80, 4ms에 −70으로 회복.';
  const text = (a, b) => `B는 2개의 뉴런으로 구성되어 있고, ㉠~㉢ 중 한 곳에만 시냅스가 있다. A와 B의 $d_3$에 역치 이상의 자극을 …\n\n| 신경 | Ⅰ | Ⅱ | Ⅲ | Ⅳ |\n|---|---|---|---|---|\n| A | ${a} |\n| B | ${b} |\n\n○ B를 구성하는 두 뉴런의 흥분 전도 속도는 $1\,\mathrm{cm/ms}$로 같다.`;
  const original = text('$-80$ | $0$ | ? | $0$', '$0$ | $-60$ | ? | ?');
  const setup = harness.nerveSetup(original, figure);
  // The original reads one way only, the teacher's: Ⅰ=d4, Ⅱ=d2, Ⅲ=d3, Ⅳ=d1, A 2 cm/ms, t1 4 ms, synapse ㉢.
  assert.deepEqual(nerve.analyse(setup, nerve.readTable(original), 1).readings, [{ order: [4, 2, 3, 1], vA: 2, t1: 4, box: 3 }]);
  const material = { steps: [{ work: '' }, { work: '' }, { work: '' }], problem: { text: original, figure } };
  const reading = (t) => harness.inspectItem(material, { stage: { kind: 'twin' }, problem: { text: t, figure, choices: [] }, solution: { steps: [] } }, 'integrated').find((c) => c.id === 'nerve-reading');
  assert.equal(reading(original).state, 'pass');
  // B's impulse crossing the synapse backwards to d1 (R4's final): no reading.
  const backwards = reading(text('$-80$ | $0$ | ? | $0$', '$0$ | $-60$ | ? | $-60$'));
  assert.equal(backwards.state, 'fail');
  assert.match(backwards.evidence, /한 방향으로만/);
  assert.match(backwards.evidence, /서버가 계산한 예/, 'with tables that work');
  // Without B's Ⅱ the order of d1 and d2 is open.
  assert.match(reading(text('$-80$ | $0$ | ? | $0$', '$0$ | ? | ? | ?')).evidence, /하나로 정해지지 않습니다/);
  // Every computed example reads one way and takes STEP 1 the teacher's way.
  const found = nerve.designs(setup, nerve.readTable(original), 1, 3);
  assert.ok(found.length >= 1);
  for (const x of found) {
    assert.equal(nerve.analyse({ ...setup, pos: x.pos, stim: x.stim }, x.table, 1).readings.length, 1);
    assert.ok(nerve.stimSteps(setup, x.table).ok);
    assert.ok(nerve.nearestStep({ ...setup, pos: x.pos, stim: x.stim }, x.table, x.order).ok);
  }
  // STEP 1 order: the original rules out Ⅰ·Ⅱ by A ≠ B and Ⅳ by the graph; R11's STEP 1 practice ruled out one by B
  // and two by the graph.
  assert.deepEqual(nerve.stimSteps(setup, nerve.readTable(original)), { byB: ['Ⅰ', 'Ⅱ'], byRight: ['Ⅳ'], alsoByRight: ['Ⅱ'], ok: true });
  const order = (t, stage = { kind: 'focus', step: 1 }, fig = figure) => harness.inspectItem(material, { stage, problem: { text: t, figure: fig, choices: [] }, solution: { steps: [] } }, 'integrated').find((c) => c.id === 'nerve-stim-order');
  assert.equal(order(original, { kind: 'twin' }).state, 'pass');
  // The two points nearest d1 both at 0 mV: the nearest cannot be found the teacher's way (R12's final).
  const r12 = order(text('$0$ | $0$ | $-60$ | ?', '$-70$ | $-60$ | ? | ?').replace('$d_3$에 역치', '$d_1$에 역치'), { kind: 'twin' }, figure.replace('$d_2=2$, $d_3=5$, $d_4=7$', '$d_2=1$, $d_3=3$, $d_4=4$').replace('$d_3$에 자극', '$d_1$에 자극'));
  assert.match(r12.evidence, /세 번째 판단/);
  const r11 = order(text('$+30$ | $-80$ | $0$ | ?', '? | $-60$ | ? | ?'));
  assert.equal(r11.state, 'fail');
  assert.match(r11.evidence, /지점 1개\(Ⅱ\).*지점 2개\(Ⅰ·Ⅲ\)/);
  // Practices up to STEP 1 and 2: computed tables take the teacher's moves, and every value given is one of them.
  for (const upto of [1, 2]) {
    const ps = nerve.practiceDesigns(setup, nerve.readTable(original), 1, upto, 3);
    assert.equal(ps.length, 3);
    for (const x of ps) assert.ok(nerve.practiceRead({ ...setup, pos: x.pos, stim: x.stim }, x.table, 1, upto).ok);
    assert.match(harness.practiceOptions(material, { kind: 'upto', upto }), /서버가 계산한 연습용 표/);
  }
  assert.equal(harness.practiceOptions(material, { kind: 'twin' }), '');
  const practice = (t, upto, fig = figure) => harness.inspectItem(material, { stage: { kind: 'upto', upto }, problem: { text: t, figure: fig, choices: [] }, solution: { steps: [] } }, 'integrated').find((c) => c.id === 'nerve-practice');
  assert.equal(practice(original, 1).state, 'pass');
  assert.equal(practice(original, 2).state, 'pass');
  // R13's STEP 1 practice: Ⅰ and Ⅳ both 0 mV, d2 and d4 at 2.5 and 3.5 cm from d3 — the nearest is not fixed.
  const r13 = practice(text('$0$ | $-60$ | ? | $0$', '$-80$ | ? | ? | $+30$').replace(/\n\n○ B를[^\n]*/, ''), 1, figure.replace('$d_2=2$, $d_3=5$, $d_4=7$', '$d_2=1.5$, $d_3=4$, $d_4=7.5$'));
  assert.equal(r13.state, 'fail');
  assert.match(r13.evidence, /하나로 정할 수 없습니다/);
  // Cell bodies at the right end turn the synapse around.
  assert.equal(nerve.reach(3, 3, 4, true), 'never');
  assert.equal(nerve.reach(3, 2, 2, true), 'late');
});
