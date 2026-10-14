'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const harness = require('../server/harness');

const HEAD = '| 실험 | 반응 전 A의 질량(g) | 반응 전 B의 질량(g) | 반응 후 A 또는 B의 질량(g) | 반응 후 $\\frac{\\text{D의 양(mol)}}{\\text{전체 기체의 양(mol)}}$ (상댓값) |\n|---|---|---|---|---|\n';
const ORIGINAL = '다음은 $\\ce{A(g)}$와 $\\ce{B(g)}$가 반응하여 $\\ce{C(g)}$와 $\\ce{D(g)}$를 생성하는 반응의 화학 반응식이다.\n\n$\\ce{A(g) + bB(g) -> 2C(g) + 2D(g)}$ ($b$는 반응 계수)\n\n'
  + HEAD + '| Ⅰ | $5w$ | $5w$ | $\\frac{10}{3}w$ | $x$ |\n| Ⅱ | $4w$ | $6w$ | $2w$ | $18$ |\n| Ⅲ | $2w$ | $7w$ | $w$ | $20$ |\n\n'
  + '$\\frac{b}{x}\\times\\frac{\\text{C의 몰질량}+\\text{D의 몰질량}}{\\text{B의 몰질량}}$은? (단, 실린더 속 기체의 온도와 압력은 일정하다.) (3점)';

test('a table read flat (no "반응 후", no separator row, handwritten A/B in the cells) is still the server’s table', () => {
  const molar = require('../server/molar');
  const t = molar.readTable('| 실험 | 반응 전 A의 질량(g) | 반응 전 B의 질량(g) | A 또는 B의 질량(g) | D의 양(mol)/전체 기체의 양(mol) (상댓값) |\n| Ⅰ | $5w$ | $5w$ | A $\\frac{10}{3}w$ | $x$ |\n| Ⅱ | $4w$ | $6w$ | A $2w$ | $18$ |\n| Ⅲ | $2w$ | $7w$ | B $w$ | $20$ |');
  assert.ok(t?.hasRel);
  assert.deepEqual(t.rows.map((r) => molar.str(r.left.v)), ['10/3', '2', '1']);
  assert.equal(molar.analyse(t).ok, true);
});

test('a table whose header was read as its printed two rows (group over label) is still the server’s table', () => {
  const molar = require('../server/molar');
  const t = molar.readTable([
    '| 실험 | 반응 전 | | 반응 후 | | 반응 후 |',
    '| :---: | :---: | :---: | :---: | :---: | :---: |',
    '| | A의 질량(g) | B의 질량(g) | A 또는 B의 질량(g) | $\\frac{\\text{D의 양(mol)}}{\\text{전체 기체의 양(mol)}}$ (상댓값) | |',
    '| I | $5w$ | $5w$ | $\\frac{10}{3}w$ | $x$ | |',
    '| II | $4w$ | $6w$ | $2w$ | 18 | |',
    '| III | $2w$ | $7w$ | $w$ | 20 | |',
  ].join('\n'));
  assert.ok(t?.hasRel);
  assert.deepEqual(t.rows.map((r) => [r.name, molar.str(r.a.v), molar.str(r.b.v), molar.str(r.left.v)]), [['Ⅰ', '5', '5', '10/3'], ['Ⅱ', '4', '6', '2'], ['Ⅲ', '2', '7', '1']]);
  assert.equal(molar.analyse(t).ok, true);
});

test('a STEP 1~2 practice gives C’s coefficient only, and its solution speaks of C alone in the teacher’s sentences', () => {
  const material = { problem: { text: ORIGINAL, figure: '' }, steps: [{ title: 'Ⅰ에서 한계 반응물을 구한다.', work: '' }, { title: 'Ⅰ~Ⅲ에서 반응 후 기체의 질량(g)과 양(mol)을 구한다.', work: '' }, { title: 'A~D의 몰질량을 구한다.', work: '' }] };
  const stage = { kind: 'upto', upto: 2 };
  const hint = harness.molarOptions(material, stage, 'integrated');
  assert.match(hint, /\$\\\\?ce\{C\(g\)\}\$의 계수는 2이다/);
  assert.doesNotMatch(hint, /D\(g\)\}\$의 계수는 각각/);
  const item = { stage, problem: { text: '', choices: [], answer: 1 }, solution: { steps: [
    { step: 1, title: 't', work: '…' },
    { step: 2, title: 't', work: '화학 반응식에서 $\\ce{C(g)}$와 $\\ce{D(g)}$의 계수는 각각 2로 $\\ce{A(g)}$의 2배이므로 $\\ce{A(g)}$가 $2n$ mol 반응할 때 생성되는 $\\ce{C(g)}$와 $\\ce{D(g)}$의 양(mol)은 각각 $4n$ mol이다.\nⅡ에서 $\\ce{A(g)}$는 $6n$ mol 중 $4n$ mol이 반응하고, $2n$ mol이 남았고, C(g)와 D(g)는 각각 $8n$ mol 생성되었다.' },
  ] } };
  harness.molarAdopt(material, item, 'integrated');
  harness.molarServe(material, item, 'integrated');
  assert.equal(item.solution.steps[1].work,
    '주어진 계수에서 $\\ce{C(g)}$의 계수는 2로 $\\ce{A(g)}$의 2배이므로 $\\ce{A(g)}$가 $2n$ mol 반응할 때 생성되는 $\\ce{C(g)}$의 양(mol)은 $4n$ mol이다.\nⅡ에서 $\\ce{A(g)}$는 $6n$ mol 중 $4n$ mol이 반응하고, $2n$ mol이 남았고, C(g)는 $8n$ mol 생성되었다.');
});
