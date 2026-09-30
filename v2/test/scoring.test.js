'use strict';
// The 모델 비교 score: per problem, unmade problems count as failing, and the range reflects how few problems
// were seen (2026-09-30: counting checks made Gemma 4 12B look close to Qwen 3.6 though it made 4 of 9 problems).
const test = require('node:test');
const assert = require('node:assert/strict');
const { problemResults, problemScore, wilson } = require('../server/scoring');

const checks = (label, pass, extra = {}) => [
  '문제 생성', '코드 검산', '독립 풀이 정답 일치', '모든 조건이 풀이에 쓰임', '목표 STEP 범위로 풀림', '교사 풀이 방법 보존', '교사 지침 준수', '교사 검토 필요 없음',
].map((n) => ({ name: `${label}: ${n}`, pass: extra[n] ?? pass }));

test('an unmade problem scores 0 and fails every item, instead of counting as one failed check', () => {
  const run = { generation: [{ name: '세트 완료', pass: true }, ...checks('STEP 1 연습', true), { name: '최종 쌍둥이 문제: 문제 생성', pass: false }] };
  const [practice, final] = problemResults(run).map((p) => ({ ...p, score: problemScore(p) }));
  assert.equal(practice.score, 1);
  assert.equal(final.final, true);
  assert.equal(final.score, 0);
  assert.equal(final.dims.correct, false);
  assert.equal(final.dims.structural, false, 'the final problem\'s own item fails too');
});

test('a wrong answer costs more than an unused condition; the final-only item applies to finals only', () => {
  const wrong = problemResults({ generation: checks('STEP 1 연습', true, { '코드 검산': false }) })[0];
  const unused = problemResults({ generation: checks('STEP 1 연습', true, { '모든 조건이 풀이에 쓰임': false }) })[0];
  assert.ok(problemScore(wrong) < problemScore(unused));
  assert.equal(wrong.dims.correct, false, 'the answer needs both the code check and the independent solve');
  assert.equal(wrong.dims.structural, undefined);
  assert.equal(Math.round(problemScore(wrong) * 90), 60);
});

test('the range is wide for few problems and never collapses to a point', () => {
  const [lo3, hi3] = wilson(1, 3);
  assert.ok(lo3 < 0.5 && hi3 === 1, `3 perfect problems: ${lo3}`);
  const [lo30] = wilson(1, 30);
  assert.ok(lo30 > 0.85, 'thirty perfect problems narrow it');
  const [a, b] = wilson(0.44, 12);
  assert.ok(a < 0.44 && b > 0.44);
});
