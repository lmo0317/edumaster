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

// Claude's review of the same set: the STEP 1~2 practice solution stopped at the mass ratio and never judged ㄱ, ㄴ, ㄷ.
const { inspectItem } = require('../server/harness');
test('a solution must judge every statement in its STEPs and name the answer when the teacher does', () => {
  const material = { problem: { text: '', choices: [] }, steps: [{ title: 'a', work: 'ㄱ. 2배이다. (×)\nㄴ. 3배이다. (○)\nㄷ. 9:4이다. (○)\n정답은 ④이다.' }] };
  const item = (work, summary = '') => ({
    stage: { kind: 'upto', upto: 1 },
    problem: { text: '이에 대한 설명으로 옳은 것만을 <보기>에서 있는 대로 고른 것은?\nㄱ. 가\nㄴ. 나\nㄷ. 다', choices: ['ㄱ', 'ㄴ', 'ㄱ, ㄷ', 'ㄴ, ㄷ', 'ㄱ, ㄴ, ㄷ'], answer: 4 },
    solution: { steps: [{ step: 1, title: 'a', work }], summary },
  });
  const check = (it) => inspectItem(material, it, 'integrated').find((c) => c.id === 'explanation-complete');
  const missing = check(item('질량비는 45:42이다.', 'ㄱ. (×) ㄴ. (○) ㄷ. (○) 정답은 ④'));
  assert.equal(missing.state, 'fail', 'judgments only in the summary do not count');
  assert.match(missing.evidence, /ㄱ, ㄴ, ㄷ/);
  assert.equal(check(item('ㄱ. 1배이다. (×)\nㄴ. 5:3이다. (○)\nㄷ. 15:14이다. (○)')).state, 'fail', 'no answer named');
  assert.equal(check(item('ㄱ. 1배이다. (×)\nㄴ. 5:3이다. (○)\nㄷ. 15:14이다. (○)\n정답은 ④ ㄴ, ㄷ이다.')).state, 'pass');
  assert.equal(inspectItem({ ...material, steps: [{ title: 'a', work: '정답은 ④이다.' }] }, item('질량비는 45:42이다.'), 'integrated').some((c) => c.id === 'explanation-complete'), false, 'not asked when the teacher does not judge them');
});
