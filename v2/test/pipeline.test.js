'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeMaterial, applyFixes, coverage } = require('../server/pipeline');
const { selectRules, makeRule } = require('../server/learning');
const { normalizeStages, buildItems } = require('../server/plan');

const base = { problem: { text: '문제 본문입니다.\n① 1  ② 2  ③ 3', choices: ['1', '2', '3'], answer: '②' }, steps: [{ title: 'a', work: '$\\ce{A + $b$B}$' }] };

test('material normalization: choices out of body, circled answer, \\ce dollars', () => {
  const m = normalizeMaterial(base);
  assert.equal(m.problem.text, '문제 본문입니다.');
  assert.equal(m.problem.answer, 2);
  assert.equal(m.steps[0].work, '$\\ce{A + bB}$');
});

test('proofreading fixes apply only to a unique match', () => {
  const m = normalizeMaterial({ ...base, problem: { ...base.problem, text: '몰질량의 합 / 물질량 / 물질량' } });
  const r = applyFixes(m, [
    { field: 'problem.text', wrong: '몰질량의 합', right: '몰질량 합' },
    { field: 'problem.text', wrong: '물질량', right: '몰질량' },
    { field: 'steps[0].work', wrong: 'bB', right: 'cB' },
    { field: 'nope', wrong: 'x', right: 'y' },
  ]);
  assert.equal(r.applied.length, 2);
  assert.equal(r.unresolved.length, 2);
  assert.equal(m.problem.text, '몰질량 합 / 물질량 / 물질량');
  assert.equal(m.steps[0].work, '$\\ce{A + cB}$');
});

test('stage plan follows the STEP count of the source solution', () => {
  const stages = normalizeStages(undefined, 4);
  assert.deepEqual(stages.map((s) => s.kind + (s.upto || '')), ['upto1', 'upto2', 'upto3', 'twin']);
  const items = buildItems(normalizeStages([{ kind: 'twin' }, { kind: 'focus', step: 2 }, { kind: 'upto', upto: 1 }], 2), 2, 2);
  assert.deepEqual(items.map((i) => i.label), ['STEP 1 연습 (1)', 'STEP 1 연습 (2)', 'STEP 2 집중 연습 (앞 단계 결과 제공) (1)', 'STEP 2 집중 연습 (앞 단계 결과 제공) (2)', '최종 쌍둥이 문제 (1)', '최종 쌍둥이 문제 (2)']);
  assert.throws(() => normalizeStages([{ kind: 'upto', upto: 5 }], 3));
});

test('coverage flags STEPs skipped or beyond the target', () => {
  assert.equal(coverage({ kind: 'upto', upto: 2 }, 3, [1, 2]).status, 'pass');
  assert.match(coverage({ kind: 'upto', upto: 2 }, 3, [2]).notes.join(), /STEP 1 로직 없이/);
  assert.match(coverage({ kind: 'upto', upto: 1 }, 3, [1, 2]).notes.join(), /범위 밖 STEP 2/);
  assert.equal(coverage({ kind: 'focus', step: 3 }, 3, [1, 3]).status, 'pass');
});

test('rule selection: global always, topic rules only for similar problems', () => {
  const g = makeRule({ text: '해설은 원본 순서대로', scope: 'global' });
  const chem = makeRule({ text: '남는 물질을 알려주지 말 것', scope: 'topic', subject: '화학', topic: '화학 반응의 양적 관계', source: { excerpt: '실린더에 A와 B를 넣고 반응을 완결시킨 실험' } });
  const bio = makeRule({ text: '흥분 전도 속도는 정수로', scope: 'topic', subject: '생명과학', topic: '흥분의 전도', source: { excerpt: '신경 세포 막전위 그래프' } });
  const pending = makeRule({ text: '승인 안 됨', scope: 'global', status: 'pending' });
  const material = { subject: '화학', topic: '화학 반응의 양적 관계', problem: { text: '실린더에 A(g)와 B(g)를 넣고 반응을 완결시킨 실험 I~III' }, techniques: [] };
  const ids = selectRules([g, chem, bio, pending], material).map((r) => r.id);
  assert.deepEqual(ids, [g.id, chem.id]);
});
