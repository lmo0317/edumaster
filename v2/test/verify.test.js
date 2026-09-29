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

// The three source checks that failed a correct transcription in the 2026-09-29 harness run.
test('ㄱㄴㄷ problems are checked by their conditions only; a leftover answer symbol is not an error', async () => {
  const deepseekBio = await codeCheck({
    program: ['d3=5', 'd4=7', 'vA=2', 'vB=1', 't1=4', 't_d3_d4_A=(d4-d3)/vA', 't_d3_d4_B=(d4-d3)/vB'],
    answer: 'ans', choices: [], checks: [{ expr: 't_d3_d4_A==1', desc: 'A 1ms' }, { expr: 't_d3_d4_B==2', desc: 'B 2ms' }],
  }, { answer: 2, choiceCount: 5 });
  assert.equal(deepseekBio.status, 'pass', deepseekBio.reasons.join());
  const gemmaBio = await codeCheck({
    program: ['t1 = 4', 'A_speed = 2'], answer: '2', choices: ['ㄱ', 'ㄴ', 'ㄱ, ㄴ', 'ㄱ, ㄷ', 'ㄴ, ㄷ'], checks: [{ expr: 't1 == 4' }],
  }, { answer: 2, choiceCount: 5 });
  assert.equal(gemmaBio.status, 'pass', gemmaBio.reasons.join());
  // A wrong condition still fails.
  const wrong = await codeCheck({ program: ['t1 = 4'], answer: 'ans', choices: [], checks: [{ expr: 't1 == 5', desc: 't1' }] }, { answer: 2, choiceCount: 5 });
  assert.equal(wrong.status, 'fail');
});

test('a check that computes a value instead of stating a condition is skipped with a warning, not failed', async () => {
  const r = await codeCheck({
    program: ['b = 3', 'x = 15', 'ratio = 2', 'result = (b / x) * ratio'], answer: '2/5',
    choices: ['1/5', '2/5', '3/5', '4/5', '1'], checks: [{ expr: '(3 / 15) * 2', desc: '최종 계산식' }],
  }, { answer: 2, choiceCount: 5 });
  assert.equal(r.status, 'pass', r.reasons.join());
  assert.ok(r.warnings.some((w) => w.includes('참/거짓 식이 아니어서')));
  const onlyValue = await codeCheck({ program: ['a = 1'], answer: '', choices: [], checks: [{ expr: 'a + 1' }] }, { answer: 1, choiceCount: 5 });
  assert.equal(onlyValue.status, 'skip', 'nothing was actually checked');
});

test('Python-style True/False in a program (Gemma) run as mathjs booleans', async () => {
  const r = await codeCheck({ program: ['synapse_exists = True', 'x = 2'], answer: '', choices: [], checks: [{ expr: 'synapse_exists == True and x == 2' }] }, { answer: 1, choiceCount: 5 });
  assert.equal(r.status, 'pass', r.reasons.join());
});

test('several assignments on one line run as separate lines; commas inside calls are left alone', async () => {
  const r = await codeCheck({ program: ['mA = 12, mB = 8, left = mA - mB', 'ans = max(left, 2) / 10'], answer: 'ans', choices: ['1/5', '2/5', '3/5', '4/5', '1'] }, { answer: 2, choiceCount: 5 });
  assert.equal(r.status, 'pass', r.reasons.join());
});
