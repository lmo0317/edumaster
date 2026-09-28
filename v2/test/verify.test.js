'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { codeCheck } = require('../server/verify');

test('original reaction problem: exact fractions pick choice 2', async () => {
  const r = await codeCheck({
    program: [
      'a1 = 5', 'b1 = 5', 'leftA1 = 10/3',
      'a2 = 4', 'b2 = 6', 'leftA2 = 2',
      'k = (a1 - leftA1) / b1',
      'b = 3', 'x = 15', 'massRatio = 2',
      'ans = b / x * massRatio',
    ],
    answer: 'ans',
    choices: ['1/5', '2/5', '3/5', '4/5', '1'],
    checks: [
      { expr: 'k == (a2 - leftA2) / b2', desc: 'I, II의 소비 질량비 일치' },
      { expr: 'b1 * k < a1', desc: 'B가 모두 반응하고 A가 남는다' },
    ],
  }, { answer: 2, choiceCount: 5 });
  assert.equal(r.status, 'pass', JSON.stringify(r));
  assert.equal(r.mode, 'Fraction');
  assert.deepEqual(r.trials[0].matches, [2]);
});

test('wrong claimed answer is reported', async () => {
  const r = await codeCheck({ program: ['ans = 2/5'], answer: 'ans', choices: ['1/5', '2/5', '3/5', '4/5', '1'] }, { answer: 4, choiceCount: 5 });
  assert.equal(r.status, 'fail');
  assert.match(r.reasons.join(), /2번/);
});

test('symbolic choices m/n and n/m must differ for free symbols', async () => {
  const ok = await codeCheck({
    free: ['m', 'n'],
    program: ['ans = 3/16 * m / n'],
    answer: 'ans',
    choices: ['1/16*m/n', '3/16*m/n', '3/16*n/m', '1/4*m/n', '3/8*m/n'],
  }, { answer: 2, choiceCount: 5 });
  assert.equal(ok.status, 'pass', JSON.stringify(ok.reasons));
  const dup = await codeCheck({
    free: ['m', 'n'],
    program: ['ans = m / n'],
    answer: 'ans',
    choices: ['m/n', '2*m/n', '3*m/n', '4*m/n', 'm/n*1'],
  }, { answer: 1, choiceCount: 5 });
  assert.equal(dup.status, 'fail');
  assert.match(dup.reasons.join(), /여러 개/);
});

test('failed check and ugly numbers are reported', async () => {
  const r = await codeCheck({ program: ['a = 7/97', 'ans = a'], answer: 'ans', choices: ['7/97', '1', '2', '3', '4'], checks: [{ expr: 'a > 1', desc: 'a는 1보다 커야 함' }] }, { answer: 1, choiceCount: 5 });
  assert.equal(r.status, 'fail');
  assert.match(r.reasons.join(), /a는 1보다 커야 함/);
  assert.match(r.warnings.join(), /7\/97/);
});

test('irrational values fall back to floating point', async () => {
  const r = await codeCheck({ program: ['d = sqrt(2) * 3', 'ans = d^2'], answer: 'ans', choices: ['9', '18', '27', '36', '6'] }, { answer: 2, choiceCount: 5 });
  assert.equal(r.status, 'pass', JSON.stringify(r));
});

test('dangerous functions are disabled and syntax errors fail cleanly', async () => {
  const r = await codeCheck({ program: ['import({x: 1})', 'ans = 1'], answer: 'ans', choices: ['1', '2', '3', '4', '5'] }, { answer: 1, choiceCount: 5 });
  assert.equal(r.status, 'fail');
  const s = await codeCheck({ program: ['ans = (1 +'], answer: 'ans', choices: [] }, { answer: 0, choiceCount: 0 });
  assert.equal(s.status, 'fail');
});
