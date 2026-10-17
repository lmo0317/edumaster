'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const molar = require('../server/molar');
const harness = require('../server/harness');

// The server-written solution (the teacher's sentences copied for this one original) is off in use; these tests keep
// it working for comparison runs. The test at the end checks the default.
process.env.EDUMASTER_MOLAR_SOLUTION = '1';

const HEAD = '| 실험 | 반응 전 A의 질량(g) | 반응 전 B의 질량(g) | 반응 후 A 또는 B의 질량(g) | 반응 후 $\\frac{\\text{D의 양(mol)}}{\\text{전체 기체의 양(mol)}}$ (상댓값) |\n|---|---|---|---|---|\n';
const ORIGINAL = '다음은 $\\ce{A(g)}$와 $\\ce{B(g)}$가 반응하여 $\\ce{C(g)}$와 $\\ce{D(g)}$를 생성하는 반응의 화학 반응식이다.\n\n$\\ce{A(g) + bB(g) -> 2C(g) + 2D(g)}$ ($b$는 반응 계수)\n\n'
  + HEAD + '| Ⅰ | $5w$ | $5w$ | $\\frac{10}{3}w$ | $x$ |\n| Ⅱ | $4w$ | $6w$ | $2w$ | $18$ |\n| Ⅲ | $2w$ | $7w$ | $w$ | $20$ |\n\n'
  + '$\\frac{b}{x}\\times\\frac{\\text{C의 몰질량}+\\text{D의 몰질량}}{\\text{B의 몰질량}}$은? (단, 실린더 속 기체의 온도와 압력은 일정하다.) (3점)';
const s = (x) => (x ? molar.str(x) : null);

test('molar: the original read as the teacher reads it — 1 : 3, K 45, x 15, m = n, b 3, (C+D)/B 2', () => {
  const a = molar.analyse(molar.readTable(ORIGINAL));
  assert.equal(a.ok, true);
  assert.deepEqual([s(a.r), s(a.K), s(a.hidden['Ⅰ.rel']), s(a.q), s(a.b), s(a.cdOverB)], ['3', '45', '15', '1', '3', '2']);
  assert.deepEqual(a.rows.map((x) => x.leftOf), ['A', 'A', 'B']);
  // The teacher's STEP 1: A assumed to all react in Ⅰ, contradicted by Ⅱ.
  assert.ok(a.chains.some((x) => x.assume === 0 && x.assumed === 'A' && x.against === 1));
  assert.deepEqual(a.obvious, []);
});

test('molar: a final with both relative values on rows with B left (R10) fixes m : n from their ratio', () => {
  const a = molar.analyse(molar.readTable(HEAD + '| Ⅰ | $6w$ | $8w$ | $2w$ | $x$ |\n| Ⅱ | $3w$ | $8w$ | $z$ | $27$ |\n| Ⅲ | $5w$ | $11w$ | $w$ | $30$ |'));
  assert.equal(a.ok, true);
  assert.deepEqual([s(a.r), s(a.q), s(a.K), s(a.hidden['Ⅰ.rel']), s(a.hidden['Ⅱ.left']), s(a.b)], ['2', '1', '63', '28', '2', '2']);
});

test('molar: a table no mass ratio fits (what Qwen 3.6 handed in, 2026-10-12) is found without a solve', () => {
  const bad = molar.analyse(molar.readTable('| 실험 | 반응 전 A의 질량(g) | 반응 전 B의 질량(g) | 반응 후 A 또는 B의 질량(g) |\n|---|---|---|---|\n| Ⅰ | $6w$ | $6w$ | $w$ |\n| Ⅱ | $4w$ | $4w$ | $\\frac{3}{2}w$ |\n| Ⅲ | $5w$ | $10w$ | $x$ |'));
  assert.equal(bad.ok, false);
  assert.match(bad.why, /모순|하나로/);
});

test('molar: practice tables need the teacher\'s Ⅰ-assume, Ⅱ-contradict step, have whole answers and no obvious row', () => {
  const orig = molar.readTable(ORIGINAL);
  for (const upto of [1, 2]) {
    const found = molar.practiceDesigns(orig, upto, { count: 3 });
    assert.equal(found.length, 3);
    for (const d of found) {
      const a = molar.analyse({ rows: d.rows.map((x) => ({ name: x.name, a: { v: x.a }, b: { v: x.b }, left: d.hide[x.name] ? { hidden: 'x' } : { v: x.left }, rel: null })), hasRel: false });
      assert.equal(a.ok, true);
      assert.ok(a.chains.some((x) => x.assume === 0 && x.assumed === 'A' && x.against === 1));
      assert.deepEqual(a.obvious, []);
      assert.equal(d.value[1], 1);
      assert.equal(molar.str(d.choices[d.answer - 1]), molar.str(d.value));
      // No row of the original reused.
      assert.ok(!d.rows.some((x) => ['5,5', '4,6', '2,7'].includes(`${s(x.a)},${s(x.b)}`)));
    }
  }
});

test('molar: final designs read uniquely, use every relative value and change two or more structure items', () => {
  const orig = molar.readTable(ORIGINAL);
  const found = molar.finalDesigns(orig, ORIGINAL, { count: 3 });
  assert.ok(found.length >= 2);
  for (const d of found) {
    const text = HEAD + d.rows.map((x) => `| ${molar.rowCells(x, d.hide[x.name] || [], true).join(' | ')} |`).join('\n') + '\n\n' + d.question;
    const a = molar.analyse(molar.readTable(text));
    assert.equal(a.ok, true);
    assert.deepEqual(a.uses.unusedRel, []);
    assert.ok(a.chains.length);
    assert.ok(molar.structureChanges(molar.structure(orig, molar.analyse(orig), molar.askOf(ORIGINAL)), molar.structure(molar.readTable(text), a, molar.askOf(text))).length >= 2);
    // A hidden leftover z is asked for itself, and only then (runs 10–16: the judges called it unused otherwise).
    const zRow = Object.entries(d.hide).find(([, v]) => v.includes('left'));
    assert.equal(Boolean(zRow), d.question.includes('\\frac{z}{w}'));
    // The server works the question out: the closing line ends with the answer.
    const t = molar.readTable(HEAD + d.rows.map((x) => `| ${molar.rowCells(x, d.hide[x.name] || [], true).join(' | ')} |`).join('\n'));
    assert.equal(molar.str(molar.questionValue(t, molar.analyse(t), d.question)), molar.str(d.value));
  }
});

test('molar: the original\'s own numbers as a final are numbers-only by code; the check offers the server\'s finals', () => {
  const material = { problem: { text: ORIGINAL, figure: '' }, steps: [] };
  const twin = { stage: { kind: 'twin' }, problem: { text: ORIGINAL.replace('$5w$ | $5w$', '$6w$ | $6w$').replace('\\frac{10}{3}w', '4w'), choices: [], answer: 1 }, solution: { steps: [] } };
  assert.deepEqual(harness.molarChanges(material, twin).length < 2, true);
  const checks = harness.inspectItem(material, twin, 'integrated').filter((c) => c.id.startsWith('molar'));
  assert.ok(checks.some((c) => c.id === 'molar-structure' && c.state === 'fail' && /서버가 계산한 최종 문제 후보/.test(c.evidence)));
});

test('molar: the teacher\'s solution values by code — Ⅰ assumed A, Ⅱ contradicts; K 45, m = n, b 3', () => {
  const facts = molar.solutionFacts(molar.readTable(ORIGINAL));
  assert.match(facts[0], /^STEP 1 가정→모순: 가정 실험 Ⅰ, 가정: A가 모두 반응/);
  assert.match(facts[0], /모순 실험 Ⅱ: .* — 자료와 맞지 않음 → Ⅰ에서 모두 반응한 것은 B$/);
  assert.ok(facts.some((f) => f.startsWith('Ⅱ (B가 모두 반응하고 A가 남은 실험):')));
  assert.ok(facts.some((f) => /상댓값 = 실젯값 × 45, m : n = 1 : 1 \(m = \$n\$\), b = 3/.test(f)));
  assert.ok(facts.some((f) => /Ⅰ의 상댓값 = 15/.test(f)));
});

test('molar: a problem on a server table is printed as the server prints it (table, question, choices)', () => {
  const material = { problem: { text: ORIGINAL, figure: '' }, steps: [] };
  const stage = { kind: 'upto', upto: 2 };
  const d = harness.molarOptions(material, stage, 'integrated');
  const table = d.split('\n').filter((l) => /^\|/.test(l)).slice(0, 5);
  const slipped = table.map((l) => l.replace('| Ⅲ |', '| III |').replace('반응 전', '반응전')).join('\n');
  const item = { stage, problem: { text: `표는 실험 자료이다.\n\n${slipped}\n\n질문?\n1) $2$  2) $3$`, choices: ['a', 'b', 'c', 'd', 'e'], answer: 5 } };
  assert.equal(harness.molarNormalize(material, item, 'integrated'), true);
  assert.ok(item.problem.text.includes(table.join('\n')));
  assert.ok(!/1\) \$2\$/.test(item.problem.text));
  assert.ok(item.problem.text.startsWith('표는 실린더에 $\\ce{A(g)}$와 $\\ce{B(g)}$를 넣고 반응을 완결시킨 실험 Ⅰ~Ⅲ에 대한 자료이다.'));
  assert.ok(item.problem.text.includes('Ⅰ에서 반응 후 남은 반응물의 양(mol)'));
  assert.equal(item.problem.choices.length, 5);
  assert.ok(d.includes('해설에 쓸 값 (서버 계산'));
});

test('molar: the STEP 1 sentence of a solution on a server table is the server\'s (Qwen 3.6\'s 2.5w, run 6)', () => {
  const material = { problem: { text: ORIGINAL, figure: '' }, steps: [] };
  const stage = { kind: 'twin' };
  const opts = harness.molarOptions(material, stage, 'integrated');
  const block = opts.split('\n\n')[1].split('\n');
  const table = block.filter((l) => /^\|/.test(l)).join('\n');
  const first = molar.assumptionSentence(molar.readTable(table));
  assert.ok(first);
  const wrong = first.text.replace(/B \$[^$]+\$ g이 반응해서/, 'B $2.5w$ g이 반응해서');
  const item = { stage, problem: { text: `${table}\n\n질문?`, choices: [], answer: 1 }, solution: { steps: [{ step: 1, work: `${wrong}\n따라서 끝.` }] } };
  harness.molarNormalize(material, item, 'integrated');
  assert.ok(item.solution.steps[0].work.startsWith(first.text));
  assert.ok(!item.solution.steps[0].work.includes('2.5w'));
});

test('molar: STEP 1~2 practice has B left in Ⅲ, uses x and names no leftover (Claude + Gemini review, 2026-10-12)', () => {
  const orig = molar.readTable(ORIGINAL);
  const found = molar.practiceDesigns(orig, 2, { count: 3 });
  assert.ok(found.length >= 2);
  for (const d of found) {
    const three = d.rows.find((x) => x.name === 'Ⅲ');
    assert.equal(three.leftOf, 'B');
    assert.notEqual(molar.str(three.left), '1');
    assert.ok(!/남은 \S*A\(g\)|남은 \S*B\(g\)/.test(d.question));
    // x/w × (C made in Ⅲ) / (A left in Ⅰ), with C's coefficient 2.
    const one = d.rows.find((x) => x.name === 'Ⅰ');
    const want = (three.left[0] / three.left[1]) * (2 * three.reactedA[0] / three.reactedA[1]) / (one.left[0] / one.left[1]);
    assert.equal(d.value[0] / d.value[1], want);
    assert.equal(molar.str(d.choices[d.answer - 1]), molar.str(d.value));
  }
});

test('molar: a practice solution gets "주어진 계수에서" and the teacher\'s last line from the server', () => {
  const material = { problem: { text: ORIGINAL, figure: '' }, steps: [] };
  const stage = { kind: 'upto', upto: 2 };
  const table = harness.molarOptions(material, stage, 'integrated').split('\n\n')[1].split('\n').filter((l) => /^\|/.test(l)).join('\n');
  const item = { stage, problem: { text: `${table}\n\n질문?`, choices: [], answer: 1 }, solution: { steps: [{ step: 1, work: '...' }, { step: 2, work: '화학 반응식에서 C(g)의 계수는 2로' }] } };
  harness.molarNormalize(material, item, 'integrated');
  assert.match(item.solution.steps[1].work, /^주어진 계수에서/);
  assert.match(item.solution.steps[1].work, /정답은 [①②③④⑤] \$\d+\$이다\.$/);
});

test('molar: the solution facts carry the mass-conservation line with 1 + b (Qwen 3.6 wrote × 2 for b = 2, run 8)', () => {
  const facts = molar.solutionFacts(molar.readTable(ORIGINAL));
  assert.ok(facts.includes('STEP 3 질량 보존: A와 B의 몰질량이 같으므로 B의 몰질량 × 4 = (C의 몰질량 + D의 몰질량) × 2, B의 몰질량 / (C의 몰질량 + D의 몰질량) = 1/2'));
});

test('molar: a design on the server\'s table without an answer number is not lost — the server has the answer', () => {
  const { normalizeGenerated } = require('../server/pipeline');
  const data = { problem: { text: '표는 실험 자료이다.', choices: ['1) $6$  2) $8$'], answer: 'ans' }, solution: { steps: [{ step: 1, work: 'w' }] } };
  assert.throws(() => normalizeGenerated(data), /정답 번호/);
  assert.equal(normalizeGenerated(data, { serverAnswer: true }).problem.text, '표는 실험 자료이다.');
});

test('molar: on a server table the written solution is held to the server values, not the outline (runs 8, 9)', () => {
  const { missingValues } = require('../server/pipeline');
  const outline = { steps: [{ work: '$\\frac{1}{2}$, $20$, B $10m$ mol' }] };
  assert.ok(missingValues(outline, { steps: [{ work: '$x=45$, 2/3, 30' }], summary: '' }).includes('20'));
  assert.deepEqual(missingValues(outline, { steps: [{ work: '$x=45$, $b=2$, 정답은 ③ $30$이다.' }], summary: '' }, ['$45$', '$2$', '$30$']), []);
  assert.deepEqual(missingValues(outline, { steps: [{ work: '$b=2$' }], summary: '' }, ['$45$', '$2$']), ['45']);
});

test('molar: the server writes the teacher\'s whole STEP 1 (five sentences) for a table', () => {
  const one = molar.stepOneText(molar.readTable(ORIGINAL));
  assert.equal(one.title, 'Ⅰ에서 한계 반응물을 구한다.');
  assert.equal(one.text, [
    '만약 Ⅰ에서 A가 모두 반응했다면 A $5w$ g과 B $\\frac{5}{3}w$ g이 반응해서 반응 후 B $\\frac{10}{3}w$ g이 남은 것이므로 Ⅱ에서는 A $4w$ g과 B $\\frac{4}{3}w$ g이 반응해서 반응 후 B $\\frac{14}{3}w$ g이 남아야 하는데 주어진 자료와 맞지 않다.',
    '따라서 Ⅰ에서 모두 반응한 것은 B이다.',
    'Ⅰ에서 A $\\frac{5}{3}w$ g과 B $5w$ g이 반응해서 반응 후 A $\\frac{10}{3}w$ g이 남았고,',
    'Ⅱ에서 A $2w$ g과 B $6w$ g이 반응해서 A $2w$ g이 남았고, 이는 주어진 자료와 일치한다.',
    '따라서 Ⅲ에서는 A $2w$ g과 B $6w$ g이 반응해서 B $w$ g이 남는다.',
  ].join('\n'));
});

test('molar: a final keeps the original\'s equation and gets the server\'s whole STEP 1 (run 8: A + 2B, 반응하고)', () => {
  const material = { problem: { text: ORIGINAL, figure: '' }, steps: [] };
  const stage = { kind: 'twin' };
  const block = harness.molarOptions(material, stage, 'integrated').split('\n\n')[1].split('\n');
  const table = block.filter((l) => /^\|/.test(l)).join('\n');
  const one = molar.stepOneText(molar.readTable(table));
  const head = one.text.match(/^만약 \S+에서 [AB]가/)[0];
  const item = { stage, problem: { text: `$\\ce{A(g) + 2B(g) -> 2C(g) + 2D(g)}$\n\n${table}\n\n질문? (3점)`, choices: [], answer: 1 },
    solution: { steps: [{ step: 1, title: 'Ⅰ~Ⅲ에서 한계 반응물을 구한다.', work: `${head} 모두 반응하고 엉뚱하다.\n따라서 끝.` }, { step: 2, work: '정답은 ① $1$이다.' }] } };
  harness.molarNormalize(material, item, 'integrated');
  assert.ok(item.problem.text.startsWith('$\\ce{A(g) + bB(g) -> 2C(g) + 2D(g)}$ ($b$는 반응 계수)'));
  assert.equal(item.solution.steps[0].work, one.text);
  assert.equal(item.solution.steps[0].title, one.title);
});

test('molar: the server writes the teacher\'s STEP 2 (mass table, n and m, one sentence per row)', () => {
  const two = molar.stepTwoText(molar.readTable(ORIGINAL));
  assert.deepEqual(two.lines.slice(2, 7), ['| 실험 | A(g) | B(g) | C(g)+D(g) |', '|---|---|---|---|', '| Ⅰ | $\\frac{10}{3}w$ | $0$ | $\\frac{20}{3}w$ |', '| Ⅱ | $2w$ | $0$ | $8w$ |', '| Ⅲ | $0$ | $w$ | $8w$ |']);
  assert.equal(two.lines[9], 'Ⅰ에서 $\\ce{A(g)}$는 $5n$ mol 중 $\\frac{5}{3}n$ mol이 반응하고, $\\frac{10}{3}n$ mol이 남았다. 화학 반응식에서 $\\ce{C(g)}$와 $\\ce{D(g)}$의 계수는 각각 2로 $\\ce{A(g)}$의 2배이므로 $\\ce{A(g)}$가 $\\frac{5}{3}n$ mol 반응할 때 생성되는 $\\ce{C(g)}$와 $\\ce{D(g)}$의 양(mol)은 각각 $\\frac{10}{3}n$ mol이다.');
  assert.equal(two.lines[10], 'Ⅱ에서 $\\ce{A(g)}$는 $4n$ mol 중 $2n$ mol이 반응하고, $2n$ mol이 남았고, $\\ce{C(g)}$와 $\\ce{D(g)}$는 각각 $4n$ mol 생성되었다.');
  assert.equal(two.lines[11], 'Ⅲ에서 $\\ce{A(g)}$는 $2n$ mol이 모두 반응하고, $\\ce{B(g)}$는 $7m$ mol 중 $6m$ mol이 반응하고 $m$ mol 남았고, $\\ce{C(g)}$와 $\\ce{D(g)}$는 각각 $4n$ mol 생성되었다.');
  const facts = molar.solutionFacts(molar.readTable(ORIGINAL));
  assert.ok(facts.some((f) => f.startsWith('STEP 3 비례식 기준 실험: Ⅱ (실젯값 2/5, 상댓값 18)')));
});

test('molar: the server writes the teacher\'s STEP 3 up to the choices (proportions from the given row, y, m = n, b)', () => {
  const three = molar.stepThreeText(molar.readTable(ORIGINAL));
  assert.equal(three[4], '| Ⅰ | $\\frac{10}{3}n$ | $0$ | $\\frac{10}{3}n$ | $\\frac{10}{3}n$ | $\\frac{1}{3}$ | $x=15$ |');
  assert.equal(three[6], '| Ⅲ | $0$ | $m$ | $4n$ | $4n$ | $y=\\frac{4}{9}$ | $20$ |');
  assert.deepEqual(three.slice(8), [
    'Ⅱ에서 $\\frac{\\text{D의 양(mol)}}{\\text{전체 기체의 양(mol)}}$의 실젯값이 $\\frac{2}{5}$인데 상댓값은 18이므로 Ⅰ에서의 상댓값과 Ⅲ에서 이 실젯값은 다음과 같이 비례식으로 구할 수 있다.',
    '$\\frac{2}{5}:18=\\frac{1}{3}:x \\Rightarrow x=15$',
    '$\\frac{2}{5}:18=y:20 \\Rightarrow y=\\frac{4}{9}$이다.',
    'Ⅲ에서 $\\frac{\\text{D의 양(mol)}}{\\text{전체 기체의 양(mol)}}$의 실젯값이 $\\frac{4}{9}$이므로 $m=n$이다. 따라서 A의 몰질량과 B의 몰질량은 서로 같다.',
    '$m=n$이므로 Ⅰ에서 $\\ce{A(g)}$는 $\\frac{5}{3}n$ mol과 $\\ce{B(g)}$는 $5n$ mol이 반응하므로 $\\ce{A(g)}$와 $\\ce{B(g)}$의 계수비는 $1:3$이다. 따라서 $b=3$이다.',
    'A와 B의 몰질량이 같으므로 B의 몰질량$\\times 4=$(C의 몰질량$+$D의 몰질량)$\\times 2$이다. 따라서 $\\frac{\\text{C의 몰질량}+\\text{D의 몰질량}}{\\text{B의 몰질량}}=2$이다.',
  ]);
});

test('molar: a final gets the server\'s STEP 3 before the writer\'s choice analysis, and lines broken as the reading breaks them', () => {
  const material = { problem: { text: ORIGINAL, figure: '' }, steps: [
    { title: 'Ⅰ에서 한계 반응물을 구한다', work: '만약 …\n따라서 Ⅰ에서 모두 반응한 것은 B이다.\nⅠ에서 … 남았고, Ⅱ에서 … 일치한다.' },
    { title: '', work: '$\\ce{A(g)}$ $w$ g의 양(mol)을 $n$, $\\ce{B(g)}$ $w$ g의 양(mol)을 $m$이라 하면 Ⅰ에서 …' },
    { title: '', work: '…\n\n| 선택지 분석 |\n② …' },
  ] };
  const stage = { kind: 'twin' };
  const block = harness.molarOptions(material, stage, 'integrated').split('\n\n')[1].split('\n');
  const table = block.filter((l) => /^\|/.test(l)).join('\n');
  const ask = block.find((l) => l.startsWith('묻는 것: ')).slice(6);
  const one = molar.stepOneText(molar.readTable(table));
  const head = one.text.match(/^만약 \S+에서 [AB]가/)[0];
  const item = { stage, problem: { text: `${table}\n\n${ask} (3점)`, choices: [], answer: 1 }, solution: { steps: [
    { step: 1, title: 'Ⅰ에서 한계 반응물을 구한다.', work: `${head} …` },
    { step: 2, work: 'Ⅰ~Ⅲ에서 반응 후 기체의 질량(g)에 대한 자료는 다음과 같다.' },
    { step: 3, work: '틀린 비례식\n② 계산한다.\n정답은 ② $1$이다.' },
  ] } };
  harness.molarNormalize(material, item, 'integrated');
  const [s1, s2, s3] = item.solution.steps;
  assert.equal(s1.title, one.title.replace(/\.$/, ''));
  assert.match(s1.work, /남았고, \S+에서 A /);
  assert.match(s2.work, /이라 하면 Ⅰ에서/);
  const three = molar.stepThreeText(molar.readTable(table), undefined, ask);
  const d = block.find((l) => l.startsWith('선택지: '));
  const mark = d.match(/정답 (.)$/)[1];
  const closing = molar.answerText(molar.readTable(table), molar.analyse(molar.readTable(table)), ask, d.split(mark)[1].trim().split('  ')[0], mark);
  assert.equal(s3.work, [...three, '', '| 선택지 분석 |', ...closing].join('\n'));
  assert.match(closing[closing.length - 1], /^정답은 [①②③④⑤] \$\d+\$이다\.$/);
  // The app's summary line is the server's answer (run 12's said 15 for 30).
  assert.equal(item.solution.summary, closing[closing.length - 1]);
  // A reading with a plain "선택지 분석" line gets that heading (run 12).
  material.steps[2].work = '…\n\n선택지 분석\n② …';
  item.solution.steps[2].work = '틀린 비례식\n② 계산한다.';
  harness.molarNormalize(material, item, 'integrated');
  assert.equal(item.solution.steps[2].work, [...three, '', '선택지 분석', ...closing].join('\n'));
});

test('molar: the teacher\'s closing line for the original\'s question, by code', () => {
  const t = molar.readTable(ORIGINAL);
  assert.deepEqual(molar.answerText(t, molar.analyse(t), ORIGINAL.split('\n').pop(), '$\\frac{2}{5}$', '②'), [
    '② $b=3$, $x=15$, $\\frac{\\text{C의 몰질량}+\\text{D의 몰질량}}{\\text{B의 몰질량}}=2$이므로 $\\frac{b}{x}\\times\\frac{\\text{C의 몰질량}+\\text{D의 몰질량}}{\\text{B의 몰질량}}=\\frac{3}{15}\\times 2=\\frac{2}{5}$이다.',
    '정답은 ② $\\frac{2}{5}$이다.',
  ]);
});

test('molar: a STEP 1~2 practice solution gets the server\'s STEP 2 and keeps the writer\'s answer lines (run 9)', () => {
  const material = { problem: { text: ORIGINAL, figure: '' }, steps: [] };
  const stage = { kind: 'upto', upto: 2 };
  const table = harness.molarOptions(material, stage, 'integrated').split('\n\n')[1].split('\n').filter((l) => /^\|/.test(l)).join('\n');
  const two = molar.stepTwoText(molar.readTable(table), undefined, { withD: false });
  const work = 'Ⅰ~Ⅲ에서 반응 후 기체의 질량(g)에 대한 자료는 다음과 같다.\n\n| 실험 | A | B |\n|---|---|\n| Ⅰ | 1 | 2 |\n\n$\\ce{A(g)}$ $w$ g의 양(mol)을 $n$, $\\ce{B(g)}$ $w$ g의 양(mol)을 $m$이라 하면 Ⅰ에서 A(g)는 틀림.\nⅡ에서 $\\ce{A(g)}$는 각각 틀림.\nⅢ에서 생성된 $\\ce{C(g)}$의 양(mol)은 계산.\n정답은 ② $16$이다.';
  const item = { stage, problem: { text: `${table}\n\n질문?`, choices: [], answer: 1 }, solution: { steps: [{ step: 1, work: '...' }, { step: 2, work }] } };
  harness.molarNormalize(material, item, 'integrated');
  const tail = item.solution.steps[1].work.split('\n').slice(two.lines.length);
  assert.equal(item.solution.steps[1].work, [...two.lines, ...tail].join('\n'));
  // A blank line, then the choice in the teacher's form ("② …이므로 …이다."), then the answer (run 18 review).
  assert.equal(tail[0], '');
  assert.match(tail[1], /^[①②③④⑤] Ⅲ에서 남은 B의 질량은 \$\d+w\$ g이므로 \$x=\d*w\$이고/);
  assert.match(tail[2], /^정답은 [①②③④⑤] \$\d+\$이다\.$/);
  assert.ok(!/각각/.test(item.solution.steps[1].work));
  // With the teacher's heading in the reading, it heads the choice.
  material.steps = [{ title: '', work: '' }, { title: '', work: '' }, { title: '', work: '…\n| 선택지 분석 |\n② …' }];
  harness.molarNormalize(material, item, 'integrated');
  assert.equal(item.solution.steps[1].work.split('\n')[two.lines.length + 1], '| 선택지 분석 |');
});

test('molar: the original answer is checked by the server, over a model program that slipped (r2=(4*4)/(2+4+4), runs 10, 11)', async () => {
  const { sourceChecks } = require('../server/pipeline');
  const choices = ['1/5', '2/5', '3/5', '4/5', '1'];
  const slipped = { program: ['r2=(4*4)/(2+4+4)', 'x=18*(1/3)/r2', 'ans=3/x*2'], answer: 'ans', choices, free: [], checks: [{ expr: 'x==15', desc: 'x=15' }] };
  const right = await sourceChecks({ problem: { text: ORIGINAL, choices, answer: 2 }, steps: [], sourceVerification: slipped });
  assert.equal(right.find((c) => c.id === 'source-calculation').state, 'pass');
  const wrong = await sourceChecks({ problem: { text: ORIGINAL, choices, answer: 3 }, steps: [], sourceVerification: slipped });
  assert.equal(wrong.find((c) => c.id === 'source-calculation').state, 'fail');
});

test('molar: a design on none of the server tables gets the server first one (Qwen put the original rows back, run 12)', () => {
  const material = { problem: { text: ORIGINAL, figure: '' }, steps: [] };
  for (const stage of [{ kind: 'upto', upto: 1 }, { kind: 'twin' }]) {
    const item = { stage, problem: { text: ORIGINAL, choices: ['1', '2', '3', '4', '5'], answer: 5 }, solution: { steps: [] } };
    assert.equal(harness.molarAdopt(material, item, 'integrated'), true);
    assert.equal(harness.molarAdopt(material, item, 'integrated'), false);
    const block = harness.molarOptions(material, stage, 'integrated').split('\n\n')[1].split('\n');
    for (const row of block.filter((l) => /^\| Ⅰ/.test(l))) assert.ok(item.problem.text.includes(row));
    assert.equal(item.problem.answer, Number('①②③④⑤'.indexOf(block.find((l) => l.startsWith('선택지: ')).slice(-1)) + 1));
    if (stage.kind === 'twin') assert.ok(item.problem.text.startsWith('다음은') && /\(3점\)$/.test(item.problem.text));
  }
});

test('molar: the server writes the whole solution of each stage on its own tables, ending with the answer', () => {
  const material = { problem: { text: ORIGINAL, figure: '' }, steps: [{ title: 'Ⅰ에서 한계 반응물을 구한다.', work: '' }, { title: 'Ⅰ~Ⅲ에서 반응 후 기체의 질량(g)과 양(mol)을 구한다.', work: '' }, { title: 'A~D의 몰질량을 구한다.', work: '| 선택지 분석 |' }] };
  for (const [stage, count] of [[{ kind: 'upto', upto: 1 }, 1], [{ kind: 'upto', upto: 2 }, 2], [{ kind: 'twin' }, 3]]) {
    const block = harness.molarOptions(material, stage, 'integrated').split('\n\n')[1].split('\n');
    const table = block.filter((l) => /^\|/.test(l)).join('\n');
    const ask = block.find((l) => l.startsWith('묻는 것: ')).slice(6);
    const solution = harness.molarSolution(material, { stage, problem: { text: `${table}\n\n${ask}`, choices: [], answer: 1 }, solution: { steps: [] } }, 'integrated');
    assert.equal(solution.steps.length, count);
    assert.match(solution.steps[0].work, /^만약 /);
    assert.match(solution.steps[count - 1].work, /정답은 [①②③④⑤] \S+/);
  }
  assert.equal(harness.molarSolution(material, { stage: { kind: 'twin' }, problem: { text: ORIGINAL, choices: [], answer: 1 } }, 'integrated'), null);
});

test('molar: molarServe gives a problem on a server table the server solution and summary whatever the designer wrote (run 13)', () => {
  const material = { problem: { text: ORIGINAL, figure: '' }, steps: [{ title: 'Ⅰ에서 한계 반응물을 구한다.', work: '' }, { title: 'Ⅰ~Ⅲ에서 반응 후 기체의 질량(g)과 양(mol)을 구한다.', work: '' }, { title: 'A~D의 몰질량을 구한다.', work: '선택지 분석' }] };
  const stage = { kind: 'twin' };
  const item = { stage, problem: { text: ORIGINAL, choices: [], answer: 1 }, solution: { steps: [{ step: 1, work: '다르게 씀' }], summary: '정답은 6이다.' } };
  harness.molarAdopt(material, item, 'integrated');
  assert.equal(harness.molarServe(material, item, 'integrated'), true);
  assert.equal(item.serverWritten, true);
  assert.equal(item.solution.steps.length, 3);
  assert.match(item.solution.summary, /^정답은 [①②③④⑤] \$\d+\$이다\.$/);
  assert.equal(harness.molarServe(material, item, 'integrated'), false);
});

test('rule ids Qwen copied with slips are matched by their first 8 characters (run 13)', () => {
  const { ruleIdOf } = require('../server/pipeline');
  const rules = [{ id: '4a0e3ad6a2b7c0d1' }, { id: '27044ad6ffee0011' }, { id: '27044ad7aabbccdd' }];
  assert.equal(ruleIdOf('4a0e3ad608b501178c', rules), '4a0e3ad6a2b7c0d1');
  assert.equal(ruleIdOf('27044ad6ffee0011', rules), '27044ad6ffee0011');
  assert.equal(ruleIdOf('ffffffff00000000', rules), null);
});

test('molar: a server final whose hidden z a repair filled in goes back to the server table (run 14)', () => {
  const material = { problem: { text: ORIGINAL, figure: '' }, steps: [] };
  const stage = { kind: 'twin' };
  const block = harness.molarOptions(material, stage, 'integrated').split('\n\n').slice(1).map((b) => b.split('\n')).find((b) => b.some((l) => /\$z\$/.test(l)));
  const table = block.filter((l) => /^\|/.test(l)).join('\n');
  const ask = block.find((l) => l.startsWith('묻는 것: ')).slice(6);
  const zRow = molar.readTable(table).rows.find((x) => x.left.hidden);
  const filled = table.replace(/\$z\$/, molar.texOf(molar.analyse(molar.readTable(table)).hidden[`${zRow.name}.left`], 'w'));
  const item = { stage, problem: { text: `${filled}\n\n${ask} (3점)`, choices: [], answer: 1 }, solution: { steps: [] } };
  harness.molarServe(material, item, 'integrated');
  assert.ok(item.problem.text.includes(table));
  assert.equal(item.serverWritten, true);
  // The solution names z's value where the question uses it (run 15 review), and the STEP 2 table keeps values only
  // as the teacher's does (run 17).
  const zValue = molar.texOf(molar.analyse(molar.readTable(table)).hidden[`${zRow.name}.left`], 'w').slice(1, -1);
  assert.ok(item.solution.steps[2].work.includes(`$z=${zValue}$`));
  assert.ok(!/\$z=/.test(item.solution.steps[1].work));
});

test('molar: by default the solution is the designer’s own — the server keeps its numbers and the answer summary only', () => {
  const material = { problem: { text: ORIGINAL, figure: '' }, steps: [{ title: 'Ⅰ에서 한계 반응물을 구한다.', work: '' }, { title: 'Ⅰ~Ⅲ에서 반응 후 기체의 질량(g)과 양(mol)을 구한다.', work: '' }, { title: 'A~D의 몰질량을 구한다.', work: '선택지 분석' }] };
  const item = { stage: { kind: 'twin' }, problem: { text: ORIGINAL, choices: [], answer: 1 }, solution: { steps: [{ step: 1, title: '한계 반응물', work: '만약 Ⅰ에서 A가 모두 반응했다면 설계자가 씀' }], summary: '' } };
  delete process.env.EDUMASTER_MOLAR_SOLUTION;
  try {
    harness.molarAdopt(material, item, 'integrated');
    harness.molarServe(material, item, 'integrated');
    assert.equal(item.serverWritten, false);
    assert.equal(item.solution.steps.length, 1);
    assert.equal(item.solution.steps[0].work, '만약 Ⅰ에서 A가 모두 반응했다면 설계자가 씀');
    assert.match(item.solution.summary, /^정답은 [①②③④⑤] /);
    assert.equal(harness.molarSolution(material, item, 'integrated'), null);
  } finally { process.env.EDUMASTER_MOLAR_SOLUTION = '1'; }
});

test('a solution that left out the teacher’s choice heading gets it before its closing choice lines (any original)', () => {
  const material = { steps: [{ work: '' }, { work: '…\n\n| 선택지 분석 |\n② …\n정답은 ② 15이다.' }] };
  const item = { solution: { steps: [{ work: 'a' }, { work: '풀이\n③ $x=35$이므로 35이다.\n정답은 ③ 35이다.' }] } };
  assert.equal(harness.teacherChoiceHeading(material, item), true);
  assert.equal(item.solution.steps[1].work, '풀이\n\n| 선택지 분석 |\n③ $x=35$이므로 35이다.\n정답은 ③ 35이다.');
  assert.equal(harness.teacherChoiceHeading(material, item), false);
  assert.equal(harness.teacherChoiceHeading({ steps: [{ work: '정답은 ② 15이다.' }] }, { solution: { steps: [{ work: '정답은 ①' }] } }), false);
});

test('a choice heading the writer gave in its own form becomes the teacher’s', () => {
  const material = { steps: [{ work: '' }, { work: '…\n\n| 선택지 분석 |\n② …\n정답은 ② 15이다.' }] };
  const item = { solution: { steps: [{ work: 'a' }, { work: '풀이\n\n선택지 분석\n③ $x=35$이므로 35이다.\n정답은 ③ 35이다.' }] } };
  assert.equal(harness.teacherChoiceHeading(material, item), true);
  assert.equal(item.solution.steps[1].work, '풀이\n\n| 선택지 분석 |\n③ $x=35$이므로 35이다.\n정답은 ③ 35이다.');
  assert.equal(harness.teacherChoiceHeading(material, item), false);
});

test('teacher frames: kept only when they match the teacher’s line; a variant line off every frame is found with the nearest frame', () => {
  const material = { steps: [{ work: '만약 Ⅰ에서 A가 모두 반응했다면 A $5w$ g이 반응한다.\n따라서 Ⅰ에서 모두 반응한 것은 B이다.' }] };
  const frames = harness.validateFrames(material, { steps: [{ step: 1, frames: ['만약 《실험》에서 《물질》가 모두 반응했다면 A 《질량》 g이 반응한다.', '따라서 《실험》에서 모두 반응한 것은 《물질》이다.', '틀과 다른 문장 《x》이다.', '《x》'] }] });
  assert.equal(frames[0].frames.length, 2);
  const twice = harness.validateFrames({ steps: [{ work: 'A 3 g과 B 4 g이 반응한다.' }] }, { steps: [{ step: 1, frames: ['《물질》 《질량》 g과 《물질》 《질량》 g이 반응한다.'] }] });
  assert.equal(twice[0].frames[0], '《물질1》 《질량1》 g과 《물질2》 《질량2》 g이 반응한다.');
  assert.equal(frames[0].covered, 2);
  const item = { solution: { steps: [{ step: 1, work: '만약 Ⅱ에서 B가 모두 반응했다면 A $3w$ g이 반응한다.\n그러므로 Ⅱ에서는 A가 모두 반응했다.\n| Ⅰ | 1 |' }] } };
  const found = harness.frameFindings({ ...material, frames }, item);
  assert.equal(found.length, 1);
  assert.match(found[0], /그러므로 Ⅱ에서는/);
  assert.match(found[0], /따라서 《실험》에서 모두 반응한 것은 《물질》이다\./);
  assert.deepEqual(harness.frameFindings({ steps: [] }, item), []);
});

test('teacher frames: \\ce notation is the reader\u2019s same words; formula-only and closing lines are not held to frames', () => {
  const material = { steps: [{ work: 'Ⅰ에서 A(g)는 $5n$ mol 중 $2n$ mol이 반응하고, $3n$ mol이 남았다.' }] };
  const frames = harness.validateFrames(material, { steps: [{ step: 1, frames: ['《실험》에서 《물질》(g)는 $《양1》$ mol 중 $《양2》$ mol이 반응하고, $《양3》$ mol이 남았다.'] }] });
  const item = { solution: { steps: [{ step: 1, work: 'Ⅱ에서 $\\ce{A(g)}$는 $6n$ mol 중 $5n$ mol이 반응하고, $n$ mol이 남았다.\n$\\frac{4}{11}:28=y:33 \\Rightarrow y=\\frac{3}{7}$이다.\n정답은 ③ $35$이다.' }] } };
  assert.deepEqual(harness.frameFindings({ ...material, frames }, item), []);
});

test('renderFrames: the writer gives a frame number and values, the system writes the teacher sentence, title and heading', () => {
  const material = { steps: [{ title: 'Ⅰ에서 한계 반응물을 구한다.', work: '만약 I 에서 A가 모두 반응했다면\n| 선택지 분석 |\n② …' }], frames: [{ step: 1, frames: ['만약 《실험》 에서 《물질》가 모두 반응했다면 A $《질량》$ g이 반응한다.'] }] };
  const item = { solution: { steps: [{ step: 1, title: 'Ⅱ의 한계 반응물', work: '[틀 1-1] 실험=Ⅱ; 물질=B; 질량=$\frac{4}{3}w$\n[틀 1-2] 실험=Ⅲ\n[틀 1-1] 실험=Ⅲ; 물질=A\n③ 계산\n정답은 ③ 4이다.' }] } };
  const missing = harness.renderFrames(material, item);
  const lines = item.solution.steps[0].work.split('\n');
  assert.equal(lines[0], '만약 Ⅱ에서 B가 모두 반응했다면 A $\frac{4}{3}w$ g이 반응한다.');
  assert.equal(item.solution.steps[0].title, 'Ⅱ에서 한계 반응물을 구한다.');
  assert.ok(lines.includes('| 선택지 분석 |'));
  const fr = { solution: { steps: [{ step: 1, title: 'Ⅰ에서 한계 반응물을 구한다.', work: 'B $24/7w$ g과 $21w/2$ g, $3/8:63$, $\\frac{1}{2}w$' }] } };
  harness.renderFrames(material, fr);
  assert.equal(fr.solution.steps[0].work, 'B $\\frac{24}{7}w$ g과 $\\frac{21}{2}w$ g, $\\frac{3}{8}:63$, $\\frac{1}{2}w$');
  assert.equal(missing.length, 2);
  assert.match(missing.join(), /없는 틀 번호/);
  assert.match(missing.join(), /《질량》 값이 없습니다/);
});

test('molar: a reading that left printed leftover cells empty fails the source check (round 10)', () => {
  const text = ORIGINAL.replace('| $\\frac{10}{3}w$ |', '|  |').replace('| $w$ | $20$ |', '|  | $20$ |');
  const r = harness.molarSourceCheck({ problem: { text, choices: ['a', 'b', 'c', 'd', 'e'], answer: 2 } });
  assert.equal(r.ok, false);
  assert.match(r.evidence, /Ⅰ, Ⅲ/);
});

test('teacher frames: the lines no kept frame matches are listed for a second extraction', () => {
  const material = { steps: [{ work: '따라서 Ⅰ에서 모두 반응한 것은 B이다.\n| a | b |\n$\\frac{2}{5}:18=y:20$' }] };
  material.frames = harness.validateFrames(material, { steps: [{ step: 1, frames: ['따라서 《실험》에서 모두 반응한 것은 《물질》이다.'] }] });
  assert.deepEqual(harness.uncoveredLines(material), [{ step: 1, line: '$\\frac{2}{5}:18=y:20$' }]);
});


test('renderFrames: \\text{…} braces are not slots, and a formula value outside the frame\u2019s $ gets its own $', () => {
  const material = { steps: [{ work: 'A $5w$ g이고 $\\frac{\\text{C의 몰질량}}{\\text{B의 몰질량}}=2$이다.\n만약 Ⅰ에서 A $5w$ g이 반응한다.' }] };
  material.frames = harness.validateFrames(material, { steps: [{ step: 1, frames: ['A $《질량》$ g이고 $\\frac{\\text{C의 몰질량}}{\\text{B의 몰질량}}=《비》$이다.', '만약 《실험》에서 A 《질량》 g이 반응한다.'] }] });
  assert.equal(material.frames[0].frames.length, 2);
  const item = { solution: { steps: [{ step: 1, work: '[틀 1-1] 질량=3w; 비=4\n[틀 1-2] 실험=Ⅱ; 질량=\\frac{4}{3}w' }] } };
  assert.deepEqual(harness.renderFrames(material, item), []);
  assert.equal(item.solution.steps[0].work, 'A $3w$ g이고 $\\frac{\\text{C의 몰질량}}{\\text{B의 몰질량}}=4$이다.\n만약 Ⅱ에서 A $\\frac{4}{3}w$ g이 반응한다.');
});

test('renderFrames: a species the teacher writes as $\\ce{…}$ is written so again, not as the frame’s plain "A(s)"', () => {
  const material = { steps: [{ work: '화학 반응식에서 $\\ce{A(s)}$는 고체이고, 기체가 $\\ce{B(g)}$만 있을 때 밀도 비는 $1:7$이다.' }] };
  material.frames = harness.validateFrames(material, { steps: [{ step: 1, frames: ['화학 반응식에서 A(s)는 고체이고, 기체가 B(g)만 있을 때 밀도 비는 $1:《비》$이다.'] }] });
  const item = { solution: { steps: [{ step: 1, work: '[틀 1-1] 비=3' }] } };
  assert.deepEqual(harness.renderFrames(material, item), []);
  assert.equal(item.solution.steps[0].work, '화학 반응식에서 $\\ce{A(s)}$는 고체이고, 기체가 $\\ce{B(g)}$만 있을 때 밀도 비는 $1:3$이다.');
});

test('STEP titles take the teacher’s exact words, spacing and "~" included, with the problem’s experiments', () => {
  const material = { steps: [{ title: 'Ⅰ에서 한계 반응물을 구한다.', work: '' }, { title: 'A~D의 몰질량을 구한다.', work: '' }] };
  const item = { solution: { steps: [{ step: 1, title: 'Ⅲ 에서 한계 반응물을 구한다', work: 'a' }, { step: 2, title: 'A-D의 몰질량을 구한다', work: 'b' }] } };
  harness.renderFrames(material, item);
  assert.deepEqual(item.solution.steps.map((s) => s.title), ['Ⅲ에서 한계 반응물을 구한다.', 'A~D의 몰질량을 구한다.']);
});
