'use strict';
// 학습 › AI 학습 and 기록 (docs/learning.md §4): the system's own lessons as a journal by set and as a list ordered by what
// the record says each did; the fault data across every original.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openStore } = require('../server/store');
const { makeRule, updateRule } = require('../server/learning');
const faults = require('../server/faults');
const journal = require('../server/learning-journal');

const at = (d) => `2026-10-${String(d).padStart(2, '0')}T00:00:00Z`;
const set = (id, materialId, day, { items = [], rules = [], learned, lessonChanges, trainRound, subject = '화학' } = {}) =>
  ({ id, type: 'generate', status: 'done', createdAt: at(day), finishedAt: at(day), materialId, title: 'T' + materialId, material: { title: 'T' + materialId, subject, topic: '몰' }, items, rules, ...(learned ? { learned } : {}), ...(lessonChanges ? { lessonChanges } : {}), ...(trainRound ? { trainRound } : {}) });
const faulted = (index, text, day) => ({ index, label: '최종 문제', stage: { kind: 'twin' }, status: 'passed', problem: { text: '문제' }, attempts: [{ kind: 'repair', design: 1, at: at(day), failures: [text] }] });

test('a system lesson is structured — a rule sentence, the fault it prevents, the faulted line and its fix — and the teacher\'s stays free text', () => {
  const r = makeRule({ text: '숨긴 칸의 값은 원본과 다르게 잡는다.', why: '숨긴 값이 원본과 같아 숫자만 바꾼 문제가 됐다', example: { before: 'a = 4 (원본과 같음)', after: 'a = 6' }, stage: 'generation', scope: 'global', layer: 'lesson', source: { from: 'auto' } });
  assert.equal(r.why, '숨긴 값이 원본과 같아 숫자만 바꾼 문제가 됐다');
  assert.deepEqual(r.example, { before: 'a = 4 (원본과 같음)', after: 'a = 6' });
  assert.ok(!('why' in makeRule({ text: '선생님 문장', scope: 'global' })), 'nothing is stored for an item without a reason');
  assert.equal(makeRule({ text: 'x y', example: { before: '', after: '' } }).example, undefined, 'an empty example is not kept');
  const next = updateRule(r, { why: '', example: null });
  assert.ok(!('why' in next) && !('example' in next), 'cleared when emptied');
});

test('what the record says of a lesson: the finished sets whose prompt had it, and the faults of its kinds that came back after it', () => {
  const lesson = { ...makeRule({ text: '원본의 실험 수치를 그대로 쓰지 않는다.', stage: 'generation', scope: 'global', layer: 'lesson', subject: '화학', source: { from: 'auto', jobId: 's1', materialId: 'm1', faultKeys: faults.keysOf(['문제 설계: 원본의 실험 수치(23,12)를 그대로 썼습니다.']) } }), createdAt: at(10) };
  const jobs = [
    set('s1', 'm1', 9, { items: [faulted(1, '문제 설계: 원본의 실험 수치(23,12)를 그대로 썼습니다.', 9)] }),               // where it was learned
    set('s2', 'm1', 11, { rules: [{ id: lesson.id }], items: [faulted(1, '문제 설계: 원본의 실험 수치(3,4)를 그대로 썼습니다.', 11)] }), // had it, fault back
    set('s3', 'm2', 12, { rules: [{ id: lesson.id }], items: [faulted(1, '최종 검수: [조건 · mid] 다른 결함.', 12)] }),            // had it, kept
    set('s4', 'm3', 13, { rules: [], subject: '생명과학', items: [faulted(1, '문제 설계: 원본의 실험 수치(5,6)를 그대로 썼습니다.', 13)] }), // another subject: out of reach
    set('s5', 'm1', 14, { rules: [{ id: lesson.id }], items: [], status: 'running' }),
  ];
  jobs[4].status = 'running';
  const e = faults.lessonEffects([lesson], faults.index(jobs), jobs).get(lesson.id);
  assert.equal(e.sent, 2, 'finished sets made after it whose prompt had it');
  assert.deepEqual([e.recurred, e.recurredSets, e.lastRecurredAt], [1, 1, at(11)], 'its kind came back once within its subject; the set it was learned from and the other subject do not count');
  assert.equal(journal.effectOf(lesson, e), 'broken');
  assert.equal(journal.effectOf(lesson, { sent: 1, recurred: 0 }), 'new');
  assert.equal(journal.effectOf(lesson, { sent: 3, recurred: 0 }), 'kept');
  assert.equal(journal.effectOf({ ...lesson, status: 'dormant' }, { sent: 9 }), 'dormant');
});

test('the journal reads what the sets left — learned, rewritten, dropped — and what the items remember — merged, asleep, awake — grouped by set, newest first', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'em-journal-'));
  const store = openStore(dataDir);
  const a = makeRule({ text: 'A 규칙.', stage: 'generation', scope: 'global', layer: 'lesson', source: { from: 'auto', jobId: 'ac01000000000001' } });
  const b = makeRule({ text: 'B 규칙.', stage: 'generation', scope: 'global', layer: 'lesson', source: { from: 'auto', jobId: 'ac01000000000001' } });
  store.rules.put(a);
  // b was rewritten by the 학습 반복's review in set 2, then merged with another, then put to sleep by the data after set 3.
  let b2 = updateRule(b, { text: 'B 규칙 (고침).' }, new Date(at(12)), { by: 'review', why: '검수 결함', jobId: 'ac01000000000002' });
  b2 = updateRule(b2, { text: 'B 규칙 (합침).' }, new Date('2026-10-12T01:00:00Z'), { by: 'merge', why: '2개를 합침' });
  b2.mergedFrom = [{ id: 'af01000000000001', text: '다른 B' }];
  b2 = updateRule(b2, { status: 'dormant' }, new Date(at(13)), { by: 'system', why: '인용 없음', jobId: 'ac01000000000003' });
  store.rules.put(b2);
  store.materials.put({ id: 'ab01000000000001', title: '원본 하나', subject: '화학', createdAt: at(1) });
  store.jobs.put(set('ac01000000000001', 'ab01000000000001', 11, { learned: [{ kind: 'add', id: a.id, text: a.text, why: 'a를 막음', scope: 'common' }, { kind: 'add', id: b.id, text: b.text, why: 'b를 막음', scope: 'problem' }] }));
  store.jobs.put(set('ac01000000000002', 'ab01000000000001', 12, { trainRound: 2 }));
  store.jobs.put({ id: 'ad01000000000001', type: 'train', status: 'done', createdAt: at(12), materialId: 'ab01000000000001', rounds: [{ setId: 'ac01000000000002', at: at(12), learned: [{ kind: 'revise', id: b.id, before: 'B 규칙.', text: 'B 규칙 (고침).', why: '검수 결함' }, { kind: 'remove', id: 'ae01000000000001', before: '없어진 규칙.', why: '막을 수 없음' }] }] });
  store.jobs.put(set('ac01000000000003', 'ab01000000000001', 13));
  const groups = journal.journalOf(store);
  assert.deepEqual(groups.map((g) => [g.jobId, g.setNo, g.trainRound, g.events.map((e) => e.kind)]), [
    ['ac01000000000003', 3, 0, ['sleep']],
    ['', 0, 0, ['merge']],
    ['ac01000000000002', 2, 2, ['revise', 'remove']],
    ['ac01000000000001', 1, 0, ['add', 'add']],
  ], 'a merge happens outside any set and is its own entry');
  assert.equal(groups[1].title, 'AI가 같은 뜻을 합침');
  const s2 = groups[2];
  assert.equal(s2.title, '원본 하나');
  assert.deepEqual(s2.events[0].now, { exists: true, status: 'dormant', text: 'B 규칙 (합침).' }, 'an event says what the item is now');
  assert.deepEqual(s2.events[1].now, { exists: false }, 'a dropped item is still in the journal');
  assert.deepEqual([groups[1].events[0].before, groups[1].events[0].text, groups[1].events[0].merged], ['B 규칙 (고침).', 'B 규칙 (합침).', ['다른 B']], 'a merge shows the sentence before and after and the originals');
  assert.equal(groups[0].events[0].why, '인용 없음');
  // The list: items with their effect and where they were learned.
  const items = store.rules.all().filter(faults.bySystem).map((r) => journal.itemOf(r, {}, () => '원본 하나'));
  assert.deepEqual(items.map((x) => x.effect).sort(), ['dormant', 'new']);
  assert.deepEqual(items.find((x) => x.id === b.id).merged, ['다른 B']);
});
