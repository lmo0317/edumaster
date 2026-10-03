'use strict';
// From GPT's and Gemini's review of a gas-mixture problem (2026-10-03): a heading that refers to an earlier step lost
// the reference, a solution title naming the original's (가)~(다) where the problem has (가), (나) was required, and
// the premise that the gases do not react was reported as an unused condition and left out.
const test = require('node:test');
const assert = require('node:assert/strict');
const { cleanHeading, isPremise } = require('../server/pipeline');
const { titleKey } = require('../server/harness');

test('a heading keeps a reference to another step and loses only its own marker', () => {
  assert.equal(cleanHeading({ marker: 'step3', title: 'step 2에서 구한 전체 기체의 질량비를 통해 분자량을 구한다.' }), 'step 2에서 구한 전체 기체의 질량비를 통해 분자량을 구한다');
  assert.equal(cleanHeading({ marker: 'step3', title: 'STEP 3. 원자량비를 구한다' }), '원자량비를 구한다');
  assert.equal(cleanHeading({ marker: 'step3', title: 'step3 원자량비를 구한다.' }), '원자량비를 구한다');
});

test('a solution title may name only the containers this problem has', () => {
  assert.equal(titleKey('(가)~(다)에 들어 있는 기체의 분자 수비를 구한다'), titleKey('(가)와 (나)에 들어 있는 기체의 분자 수비를 구한다'));
  assert.notEqual(titleKey('(가)~(다)에 들어 있는 기체의 분자 수비를 구한다'), titleKey('(가)~(다)에 들어 있는 기체의 질량비를 구한다'));
});

test('premises that make the situation hold are not unused conditions', () => {
  assert.ok(isPremise('(단, X~Z는 임의의 원소 기호이고, 모든 기체는 반응하지 않는다.)'));
  assert.ok(!isPremise('(단, 온도와 압력은 일정하다.)'));
});
