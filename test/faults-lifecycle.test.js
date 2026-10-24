'use strict';
// The data decides what the data is worth (docs/learning.md, 데이터만으로 진화하기): problems both reviewers passed are
// examples, a system lesson is measured by the reviews that cited it, sleeps when uncited and wakes when its fault comes
// back, and a deleted set leaves its records behind.
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const faults = require('../server/faults');
const prompts = require('../server/prompts');
const sets = require('../server/set-check');
const pipeline = require('../server/pipeline');
const learning = require('../server/learning');

const job = (id, materialId, { subject = '생명과학', topic = '감수 분열', title = '원본', at = '2026-10-20T00:00:00Z', items = [] } = {}) =>
  ({ id, type: 'generate', status: 'done', createdAt: at, finishedAt: at, materialId, title, material: { title, subject, topic, problem: { text: '원본 문제', choices: ['1', '2', '3', '4', '5'], answer: 1 }, steps: [{ title: 'a', work: 'b' }] }, items });
const item = (index, stage, { attempts = [], problems = [], status = 'passed', text = '문제 본문' } = {}) =>
  ({ index, label: stage.kind === 'twin' ? '최종 문제' : `STEP 1${stage.upto > 1 ? '~' + stage.upto : ''} 연습`, stage, status, problem: { text, choices: ['1', '2', '3', '4', '5'], answer: 1 }, solution: { steps: [] }, attempts, problems });
const twin = { kind: 'twin' }, step1 = { kind: 'upto', upto: 1 };
const day = (d) => `2026-10-${String(d).padStart(2, '0')}T00:00:00Z`;
const rep = (text, at = '2026-10-20T01:00:00Z', problem = '') => ({ kind: 'repair', design: 1, at, failures: [text], ...(problem ? { problem } : {}) });

const tmpStore = (rulesList = [], jobsList = []) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'faults-'));
  const col = (list) => ({ all: () => [...list], get: (id) => list.find((x) => x.id === id) || null, put: (r) => { const i = list.findIndex((x) => x.id === r.id); if (i >= 0) list[i] = r; else list.push(r); return r; } });
  return { dataDir, rules: col(rulesList), jobs: col(jobsList), materials: { get: () => ({ id: 'm1', subject: '생명과학', topic: '감수 분열' }) } };
};
const lessonOf = (id, text, from, extra = {}) => ({ id, text, status: 'approved', stage: 'generation', scope: 'global', layer: 'lesson', subject: '생명과학', createdAt: '2026-10-01T00:00:00Z', source: { from, ...extra }, history: [] });
const okItem = (index, label) => ({ index, label, answerOk: true, markedAnswer: 1, myAnswer: '1', verdict: 'use', checks: {}, issues: [] });
const badItem = (index, label, detail) => ({ ...okItem(index, label), verdict: 'fix', issues: [{ severity: 'mid', rule: '구조', detail }] });

test('a problem both reviewers passed in the set review is an example for the next writer; a failed, unreviewed or stale one is not', () => {
  const j = job('s1', 'm1', { items: [item(0, step1, { text: '연습 본문' }), item(1, twin, { text: '최종 본문' })] });
  const store = tmpStore([], [j]);
  assert.equal(faults.passedProblems(store, j).indices.size, 0, 'no review yet');
  const record = { ...sets.checkRecord(j.material, j), done: true, at: '2026-10-20T03:00:00Z', reviews: {
    'claude-cli': { review: { items: [okItem(0, 'STEP 1 연습'), badItem(1, '최종 문제', '원본과 같은 표입니다.')] } },
    'agy-cli': { review: { items: [okItem(0, 'STEP 1 연습'), okItem(1, '최종 문제')] } } } };
  sets.writeCheck(store.dataDir, j.id, record);
  const passed = faults.passedProblems(store, j);
  assert.deepEqual([...passed.indices], [0], 'the final Claude failed is not an example');
  const examples = pipeline.adoptedExamples(store, 'm1');
  assert.deepEqual(examples.map((e) => [e.index, e.source]), [[0, 'passed']]);
  const text = prompts.generateParts({ material: { id: 'm1', title: 't', problem: { text: '원본' }, steps: [{ title: 'a', work: 'b' }] }, stage: step1, total: 1, mode: 'integrated', prior: [], rules: [], variantNo: 1, examples }).text;
  assert.match(text, /예시 1 · STEP 1 연습 · Claude·Gemini 검수 통과/);
  // The teacher's adopted problem comes first; a stale review (the problem changed since) gives nothing.
  j.items[1].adopted = true;
  assert.deepEqual(pipeline.adoptedExamples(store, 'm1').map((e) => e.source), ['adopted', 'passed']);
  j.items[0].problem.text = '바뀐 본문';
  assert.equal(faults.passedProblems(store, j).indices.size, 0);
  // A reviewer that failed leaves the set unjudged.
  j.items[0].problem.text = '연습 본문';
  sets.writeCheck(store.dataDir, j.id, { ...record, reviews: { ...record.reviews, 'agy-cli': { error: 'limit' } } });
  assert.equal(faults.passedProblems(store, j).indices.size, 0);
});

test('a lesson is measured by the reviews that cited it; a system lesson uncited for a window of sets sleeps and wakes when its fault comes back', () => {
  const lesson = '합답형 문항은 보기 하나를 판정했을 때 남는 선택지들이 모두 같은 보기를 포함하는지 확인한다.';
  const cite = `최종 검수: [학습 · mid] '${lesson}' — ㄱ을 ×로 판정하면 ②만 남습니다.`;
  const jobs = Array.from({ length: 11 }, (_, i) => job(`s${i}`, 'm1', { at: day(2 + i), items: [item(1, twin, { attempts: i === 0 ? [rep(cite, day(2 + i).replace('T00', 'T01'))] : [] })] }));
  const rules = [
    lessonOf('ai1', lesson, 'auto', { faultKeys: [faults.faultKey('앞 문제(STEP 1 연습)와 선택지가 같습니다.')] }),
    lessonOf('ai2', '다른 AI 학습 문장이다.', 'review'),
    lessonOf('t1', '선생님이 쓴 학습 문장이다.', 'input'),
    { ...lessonOf('ch', '화학 학습이다.', 'auto'), subject: '화학' },
  ];
  const store = tmpStore(rules, jobs);
  const history = faults.index(jobs);
  const effects = faults.lessonEffects(rules, history);
  assert.equal(effects.get('ai1').cited, 1);
  assert.equal(effects.get('ai1').lastCitedJobId, 's0');
  assert.equal(effects.get('ai2').cited, 0);
  // Eleven finished sets of its reach after it was made, the citation only in the oldest: the last 10 are silent, so it sleeps.
  const slept = faults.sleepLessons(store, history, { now: new Date('2026-10-14T00:00:00Z') });
  assert.deepEqual(slept.map((c) => [c.kind, c.id]).sort(), [['sleep', 'ai1'], ['sleep', 'ai2']], 'the teacher\'s item and the other subject\'s lesson are untouched');
  const asleep = store.rules.get('ai1');
  assert.equal(asleep.status, 'dormant');
  assert.equal(asleep.history.at(-1).by, 'system');
  assert.match(asleep.history.at(-1).why, /10세트/);
  assert.equal(learning.selectRules(store.rules.all(), { id: 'm1', subject: '생명과학' }).some((r) => r.id === 'ai1'), false, 'asleep, it is not sent');
  // Only the sets whose writer had the lesson count: with the lesson left out of the last two sets' prompts, nine were
  // silent, not ten, and it stays awake.
  const keptAwake = lessonOf('ai3', '그래프 축에 수치 눈금을 둘 때는 실제 값과 겹치지 않게 한다.', 'auto');
  const store2 = tmpStore([keptAwake], jobs.map((j, i) => ({ ...j, rules: i >= 9 ? [{ id: 'other' }] : [{ id: 'ai3' }] })));
  assert.deepEqual(faults.sleepLessons(store2, history, { now: new Date('2026-10-14T00:00:00Z') }), []);
  // The fault it was learned from comes back in a new set: awake. The other sleeps on (its text does not match).
  const fresh = faults.recordsOf(job('s99', 'm1', { at: day(15), items: [item(1, twin, { attempts: [rep('문제 설계: 앞 문제(STEP 1~2 연습)와 선택지가 같습니다.', day(15))] })] }));
  const woke = faults.wakeLessons(store, fresh, { now: new Date('2026-10-15T02:00:00Z') });
  assert.deepEqual(woke.map((c) => [c.kind, c.id]), [['wake', 'ai1']]);
  assert.equal(store.rules.get('ai1').status, 'approved');
  assert.equal(store.rules.get('ai1').dormantAt, undefined);
  assert.equal(store.rules.get('ai2').status, 'dormant');
  // An older system lesson with no fault keys wakes by wording.
  store.rules.put({ ...lessonOf('old', '앞 문제와 선택지가 같은 조합이면 바꾼다.', 'auto'), subject: '', status: 'dormant' });
  assert.deepEqual(faults.wakeLessons(store, fresh).map((c) => c.id), ['old']);
  // The lesson's fault keys are kept by the store, and a status the system changes is on the record.
  const made = learning.makeRule({ text: '새 학습', stage: 'generation', scope: 'global', layer: 'lesson', source: { from: 'auto', faultKeys: ['가나다', ''] } });
  assert.deepEqual(made.source.faultKeys, ['가나다']);
  assert.deepEqual(faults.keysOf(['문제 설계: 앞 문제(STEP 1 연습)의 실험 수치(3,8)를 그대로 썼습니다.', '[Claude] [구조 · mid] 원본과 같은 표입니다.']),
    [faults.faultKey('앞 문제(STEP 1~2 연습)의 실험 수치(2w,5w)를 그대로 썼습니다.'), faults.faultKey('원본과 같은 표입니다.')]);
  assert.equal(learning.updateRule(made, { status: 'dormant' }, new Date(), { by: 'teacher' }).history.length, 0, 'only the system\'s status changes are recorded');
});

test('a deleted set leaves its records behind, and faults of other originals are offered only while recent', () => {
  const gone = job('gone', 'm9', { subject: '화학', topic: '몰', title: '지운 원본', items: [item(1, twin, { attempts: [rep('문제 설계: 원본의 실험 수치(23,12)를 그대로 썼습니다.', '2026-10-20T01:00:00Z', '지운 세트의 문제')], text: '지운 세트의 문제' })] });
  const store = tmpStore([], []);
  assert.equal(faults.archive(store.dataDir, gone), 1);
  const kept = job('kept', 'm8', { subject: '화학', topic: '밀도', at: day(21), items: [item(1, twin, { attempts: [rep('문제 설계: 원본의 실험 수치(5,7)를 그대로 썼습니다.', day(21).replace('T00', 'T01'))] })] });
  const history = faults.index([kept], { dataDir: store.dataDir });
  assert.deepEqual(history.map((r) => r.jobId), ['kept', 'gone'], 'the archived set\'s records come back with the others');
  assert.equal(history[1].problem, '지운 세트의 문제');
  assert.equal(faults.index([kept, gone], { dataDir: store.dataDir }).length, 2, 'a set still present is not counted twice');
  // Offered to another original while it recurs in recent sets; not once it is older than the window.
  const material = { id: 'm1', subject: '화학', topic: '기체' };
  assert.equal(faults.forItem(history, material, item(1, twin)).length, 1);
  const later = Array.from({ length: 12 }, (_, i) => job(`l${i}`, 'm7', { subject: '화학', topic: '산염기', at: `2026-11-${String(1 + i).padStart(2, '0')}T00:00:00Z`, items: [item(1, twin, { attempts: [rep('문제 설계: 손계산 수치: 1/108.', `2026-11-${String(1 + i).padStart(2, '0')}T01:00:00Z`)] })] }));
  const all = [...history, ...faults.index(later)];
  assert.deepEqual(faults.forItem(all, material, item(1, twin)).map((e) => e.detail.slice(0, 6)), ['손계산 수치'], 'the number-reuse kind fell out of the 12-set window');
  // The page's view of one original.
  const view = faults.materialView(tmpStore([], [kept]), { id: 'm8', subject: '화학', topic: '밀도' }, history);
  assert.equal(view.sets.length, 1);
  assert.equal(view.sets[0].faults, 1);
  assert.equal(view.kinds.length, 1);
  assert.equal(view.kinds[0].active, true);
  assert.equal(view.records, 1);
});
