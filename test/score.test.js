'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { norm, scoreAnalysis } = require('../eval/score');

test('notation differences do not count as reading errors', () => {
  assert.equal(norm('$\\frac{\\ce{C}의\\ 몰질량 + \\ce{D}의 몰질량}{\\ce{B}의 몰질량}$'), norm('C의 몰질량+D의 몰질량/B의 몰질량'));
  assert.equal(norm('$t_1$은 $4\\,\\text{ms}$'), norm('t1은 4ms'));
  assert.ok(norm('| Ⅰ | $x=15$ |').includes(norm('x = 15')));
});

test('analysis scoring reports the misread word, the handwriting and the STEP count', () => {
  const expect = { answer: 2, choiceCount: 5, stepCount: 3, stepTitles: ['Ⅰ에서 한계 반응물을 구한다', '반응 후 양(mol)을 구한다', 'A~D의 몰질량을 구한다'],
    problemMustContain: ['몰질량'], problemMustNotContain: ['물질량', 'x=15'], stepsMustContain: ['모순'] };
  const material = {
    problem: { text: '표 | Ⅰ | $x=15$ |\n$\\frac{\\ce{C}의 물질량}{\\ce{B}의 물질량}$은?', choices: ['1', '2', '3', '4', '5'], answer: 2 },
    steps: [{ title: 'Ⅰ에서 한계 반응물을 구한다', work: '가정하면 모순' }, { title: '반응 후 양(mol)을 구한다' }, { title: 'A~D의 물질량 구하기' }, { title: '계수 구하기' }],
  };
  const failed = scoreAnalysis(material, expect).filter((c) => !c.pass).map((c) => c.name);
  assert.deepEqual(failed, ['해설 STEP 수', 'STEP 제목이 해설과 일치', '문제에 "몰질량" 포함', '문제에 "물질량" 미포함 (필기·오독)', '문제에 "x=15" 미포함 (필기·오독)']);
});

test('generation score names each teacher complaint separately', () => {
  const { scoreGeneration } = require('../eval/score');
  const job = { status: 'done', options: { mode: 'integrated' }, items: [{
    label: '최종', stage: { kind: 'twin' }, problem: { answer: 2 }, problems: [], warnings: ['x'],
    verification: {
      code: { status: 'pass' }, blind: { answer: 2, variation: 'numbers-only', conditions: [{ text: '(단, 온도 일정)', used: false }, { text: '표', used: true }] },
      coverage: { status: 'warn', notes: ['독립 풀이에서 STEP 2 로직 없이 풀렸습니다.'] },
      harness: [{ id: 'source-method', state: 'fail', label: '교사 방법', evidence: '보조 문자 n 없음' }],
      rules: [{ text: '불필요한 조건 금지', how: '', judged: { ok: false, note: '온도 조건' } }],
    },
  }] };
  const failed = scoreGeneration(job).filter((c) => !c.pass).map((c) => c.name);
  assert.deepEqual(failed, ['최종: 모든 조건이 풀이에 쓰임', '최종: 목표 STEP 범위로 풀림', '최종: 교사 풀이 방법 보존', '최종: 교사 지침 준수', '최종: 확인할 점 없음', '최종: 구조 변형(숫자만 바꾸지 않음)']);
});
