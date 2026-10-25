'use strict';
// 학습 지도 (학습 page): each item's record on the recent sets, the summary, and 정리 후보 — two items the AI reads as
// one are offered merged; merging keeps both originals and their record, skipping does not ask again.
process.env.EDUMASTER_MOCK_DELAY_MS = '5';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../server');
const { createUsers } = require('../server/users');
const { setMarks, mergePairs, keeperOf } = require('../server/learning-map');

test('an item is marked per recent set: broken on any problem wins, a merged item keeps the record of its originals', () => {
  const rules = [{ id: 'r1', text: 'a', mergedFrom: [{ id: 'old', text: 'b' }] }];
  const set = (id, at, rs) => ({ id, type: 'generate', createdAt: at, items: rs.map((r) => ({ verification: { rules: r } })) });
  const jobs = [
    set('s1', '2026-10-01', [[{ id: 'old', judged: { ok: true } }]]),
    set('s2', '2026-10-02', [[{ id: 'r1', judged: { ok: true } }], [{ id: 'r1', judged: { ok: false } }]]),
    set('s3', '2026-10-03', [[{ id: 'r1', judged: null }]]),
    { id: 'x', type: 'generate', createdAt: '2026-10-04', items: [{}] }, // no problem checked yet: not a column
  ];
  const m = setMarks(jobs, rules, 6);
  assert.deepEqual(m.sets.map((s) => s.id), ['s1', 's2', 's3']);
  assert.deepEqual(m.marks('r1'), ['k', 'b', 'u']);
  assert.equal(m.uses('r1'), 4);
  assert.deepEqual(m.marks('none'), ['-', '-', '-']);
});

test('candidates are switched-on items of one stage that reach the same problems; the 지침 one stays', () => {
  const r = (id, text, extra = {}) => ({ id, text, status: 'approved', stage: 'generation', scope: 'global', layer: 'lesson', createdAt: id, ...extra });
  const rules = [
    r('a', '해설 STEP 제목은 원본 제목을 글자 그대로 쓴다'),
    r('b', '해설 STEP 제목은 원본 제목을 그대로 쓴다', { layer: 'guide' }),
    r('c', '해설 STEP 제목은 원본 제목을 그대로 쓴다', { stage: 'analysis' }),
    r('d', '해설 STEP 제목은 원본 제목을 그대로 쓴다', { status: 'pending' }),
    r('e', '해설 STEP 제목은 원본 제목을 그대로 쓴다', { scope: 'material', source: { materialId: 'm1' } }),
    r('f', '해설 STEP 제목은 원본 제목을 그대로 쓴다', { scope: 'material', source: { materialId: 'm2' } }),
    r('g', '수는 손으로 계산하기 쉬운 값으로 잡는다'),
  ];
  const pairs = mergePairs(rules).map((p) => [p.a.id, p.b.id].join(''));
  assert.deepEqual(pairs.sort(), ['ab', 'ae', 'af', 'be', 'bf'], 'not across stages, not switched off, not two different problems, not unrelated');
  assert.equal(keeperOf(rules[0], rules[1])[0].id, 'b');
  assert.equal(keeperOf(rules[4], rules[0])[0].id, 'a');
});

test('규칙 over the API: the teacher\x27s items, a group the AI read as one merged at once, bulk changes', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'em2-'));
  createUsers(dataDir).create({ username: 'admin', password: 'test-pass-1', role: 'admin' });
  const app = createApp({ dataDir, llmMode: 'mock' });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  let cookie = '';
  const call = async (method, url, body) => {
    const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined });
    const set = res.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
    return { status: res.status, data: await res.json() };
  };
  try {
    await call('POST', '/api/login', { username: 'admin', password: 'test-pass-1' });
    const add = (text, layer = 'lesson') => call('POST', '/api/rules', { text, scope: 'global', layer, stage: 'generation', target: 'solution' });
    const a = (await add('해설은 선생님 해설과 같은 구성으로 쓰고 마지막 STEP 끝에서 끝낸다', 'guide')).data;
    const b = (await add('해설은 선생님 해설과 같은 구성으로 쓰고 결론을 덧붙이지 않는다')).data;
    const c = (await add('표는 모든 행의 칸 수를 머리 행과 같게 한다')).data;
    // Two more that overlap but the (mock) AI reads as different (they do not start alike).
    await add('수는 계산하기 쉬운 값으로 잡고 오답도 같은 꼴로 만든다');
    await add('오답도 같은 꼴로 만들고 수는 계산하기 쉬운 값으로 잡는다');
    let d = (await call('GET', '/api/learning/rules')).data;
    assert.equal(d.items.length, 5);
    assert.ok(d.items.every((x) => x.category === 'solution' && Array.isArray(x.history) && Array.isArray(x.evidence)));
    assert.equal(d.persona, '');
    assert.equal((await call('GET', '/api/learning/journal')).data.items.length, 0, 'the teacher\x27s items are not AI 학습');
    // The AI checks the overlapping pairs in the background and merges the pair it reads as one at once: the 지침 stays
    // with the teacher's own sentence and both originals; the other is gone.
    const until = async (ok) => { for (let i = 0; i < 150 && !ok(d); i++) { await new Promise((r) => setTimeout(r, 30)); d = (await call('GET', '/api/learning/rules')).data; } return d; };
    await until((m) => m.items.length === 4);
    assert.equal(d.items.length, 4);
    const rules = (await call('GET', '/api/rules')).data;
    const kept = rules.find((r) => r.id === a.id);
    assert.equal(kept.text, a.text, 'a teacher\'s item keeps its words');
    assert.deepEqual(kept.mergedFrom.map((x) => x.text).sort(), [a.text, b.text].sort());
    assert.deepEqual(kept.history, [], 'its sentence did not change, so nothing is history; the merge is in mergedFrom');
    assert.ok(!rules.some((r) => r.id === b.id));
    assert.ok(d.items.find((x) => x.id === a.id).evidence.some((e) => e.includes(b.text)), 'the merged original is its evidence');
    assert.ok(d.items.some((x) => x.id === c.id));
    assert.equal((await call('POST', '/api/learning/merge', { ids: [a.id, b.id], text: 'x x x' })).status, 409, 'already merged');
    // Another item that says what c says is folded into c the same way; the two that only overlap stay apart.
    await add('표는 모든 행의 칸 수를 머리 행과 같게 맞춘다');
    await until((m) => m.items.length === 4 && m.items.find((x) => x.id === c.id)?.merged === 2);
    assert.equal(d.items.length, 4);
    assert.equal(d.items.find((x) => x.id === c.id).merged, 2);
    // Several at once: a subject tag, off, and removal.
    const two = d.items.slice(0, 2).map((x) => x.id);
    assert.deepEqual((await call('POST', '/api/learning/bulk', { ids: two, patch: { subject: '화학', status: 'pending' } })).data, { changed: 2 });
    d = (await call('GET', '/api/learning/rules')).data;
    assert.ok(two.every((id) => { const x = d.items.find((i) => i.id === id); return x.subject === '화학' && x.status === 'pending'; }));
    assert.deepEqual((await call('POST', '/api/learning/bulk', { ids: two, remove: true })).data, { changed: 2 });
    assert.equal((await call('GET', '/api/learning/rules')).data.items.length, 2);
  } finally { await new Promise((r) => app.server.close(r)); }
});

// Learning that keeps growing is not all sent to every problem: an every-problem item tagged with a subject reaches only
// that subject, and the subject's own lessons come before untagged ones under the cap.
test('a subject-tagged item reaches only that subject; promotion clears the tag', () => {
  const { selectRules, updateRule } = require('../server/learning');
  const r = (id, text, extra = {}) => ({ id, text, status: 'approved', stage: 'generation', scope: 'global', layer: 'lesson', createdAt: id, ...extra });
  const rules = [r('a', '전 과목 교훈'), r('b', '화학 교훈', { subject: '화학' }), r('c', '생명 교훈', { subject: '생명과학' }), r('d', '화학 지침', { layer: 'guide', subject: '화학' })];
  const ids = (m) => selectRules(rules, { id: 'm', subject: m }).map((x) => x.id);
  assert.deepEqual(ids('화학'), ['d', 'b', 'a'], '지침 first, then this subject, then every subject');
  assert.deepEqual(ids('생명과학'), ['c', 'a']);
  assert.deepEqual(ids(''), ['d', 'c', 'b', 'a'], 'a problem without a subject gets everything, the newer lessons first');
  const own = { ...r('e', '문제 학습'), scope: 'material', subject: '화학', source: { materialId: 'm' } };
  assert.equal(updateRule(own, { scope: 'global' }).subject, '', 'moved up: reaches every subject until tagged');
  assert.equal(updateRule(r('f', 'x'), { subject: '화학' }).subject, '화학');
});

// Items that say the same thing are offered as one group, not as every pair among them: seven lessons about hidden
// values were sixteen pairs on 2026-10-23.
test('pairs the AI read as one are joined into groups with one suggested sentence', () => {
  const { clustersOf } = require('../server/learning-map');
  const r = (id, extra = {}) => ({ id, text: 't' + id, createdAt: id, scope: 'global', layer: 'lesson', ...extra });
  const same = (a, b, sim, text) => ({ key: a.id + b.id, a, b, similarity: sim, decision: { decision: 'same', text, why: 'w' } });
  const [a, b, c, d, e] = ['a', 'b', 'c', 'd', 'e'].map((id) => r(id, id === 'c' ? { layer: 'guide' } : {}));
  const groups = clustersOf([same(a, b, 0.5, 'ab'), same(b, c, 0.9, 'bc'), same(d, e, 0.6, 'de'), { key: 'x', a, b: d, similarity: 0.4, decision: { decision: 'distinct' } }]);
  assert.deepEqual(groups.map((g) => g.items.map((x) => x.id)), [['a', 'b', 'c'], ['d', 'e']], 'joined through b; the distinct pair does not join');
  assert.equal(groups[0].text, 'bc', 'the most similar pair\'s sentence');
  assert.equal(groups[0].keeper.id, 'c', 'the 지침 stays');
  assert.deepEqual(groups[0].pairs.sort(), ['ab', 'bc']);
});

test('a lesson about notation or titles is not learning (the system lays those out); content lessons are', () => {
  const { isFormatLesson } = require('../server/learning');
  for (const t of ['화학식은 STEP 제목까지 $\\ce{X2}$ 꼴로 쓴다', '한글이 들어간 식은 $…$ 안에 넣지 않고 \\text{}로 감싼다', '제목 끝의 마침표까지 맞춰 쓴다', "해설의 '·' 항목 구분은 선생님 해설과 같은 자리에만 둔다"]) assert.ok(isFormatLesson(t), t);
  for (const t of ['수치를 정한 뒤 양(mol)이 $\\frac{1}{4}$처럼 간단한 값이 되게 잡는다', '최종 문제의 행 수치는 앞 문제의 배수가 되지 않게 잡는다', 'STEP 제목이 가리키는 물질의 양을 묻는 보기를 하나 둔다']) assert.ok(!isFormatLesson(t), t);
});

test('a text change keeps the sentence it replaced on the item, with who changed it and why', () => {
  const { updateRule, makeRule } = require('../server/learning');
  const r = makeRule({ text: '처음 문장', scope: 'global', layer: 'lesson', category: 'numbers' });
  assert.deepEqual([r.history, r.category], [[], 'numbers']);
  const r2 = updateRule(r, { text: '둘째 문장' }, new Date('2026-10-23T00:00:00Z'), { by: 'review', why: '검수 지적', jobId: 'j1' });
  assert.deepEqual(r2.history, [{ at: '2026-10-23T00:00:00.000Z', before: '처음 문장', by: 'review', why: '검수 지적', jobId: 'j1' }]);
  assert.equal(updateRule(r2, { subject: '화학' }).history.length, 1, 'only a text change is history');
  assert.equal(updateRule(r2, { text: '셋째 문장' }).history.at(-1).by, 'teacher');
});

// Filled in order and stopped at the first item that does not fit: a short item far down the list (another subject's)
// must not take the room of this subject's longer one.
test('the cap is filled in priority order without skipping ahead', () => {
  const { selectRules } = require('../server/learning');
  const r = (id, text, extra = {}) => ({ id, text, status: 'approved', stage: 'generation', scope: 'global', layer: 'lesson', createdAt: id, ...extra });
  const rules = [r('a', 'x'.repeat(50), { subject: '생명과학' }), r('b', 'y'.repeat(50), { subject: '생명과학' }), r('c', 'z'.repeat(10))];
  assert.deepEqual(selectRules(rules, { id: 'm', subject: '생명과학' }, { maxChars: 70 }).map((x) => x.id), ['b'], 'b is newer; a does not fit, and c is not pulled forward');
});

test('the second migration tags the system\'s untagged lessons with the subject they were learned on and drops notation lessons, once', () => {
  const { migrateLearningV2, makeRule } = require('../server/learning');
  const { openStore } = require('../server/store');
  const store = openStore(fs.mkdtempSync(path.join(os.tmpdir(), 'em-mig-')));
  store.materials.put({ id: 'a1'.padEnd(24, '0'), subject: '화학', topic: '기체', createdAt: '2026-10-01' });
  const sys = store.rules.put(makeRule({ text: '기체 행 수를 유지한다', scope: 'global', layer: 'lesson', source: { materialId: 'a1'.padEnd(24, '0'), from: 'auto' } }));
  const teacher = store.rules.put(makeRule({ text: '수는 작은 정수로 잡는다', scope: 'global', layer: 'lesson', target: 'solution' }));
  const fmt = store.rules.put(makeRule({ text: '화학식은 $\\ce{X2}$ 꼴로 쓴다', scope: 'global', layer: 'lesson', source: { materialId: 'a1'.padEnd(24, '0'), from: 'review' } }));
  assert.equal(migrateLearningV2(store), 3);
  const after = Object.fromEntries(store.rules.all().map((r) => [r.id, r]));
  assert.deepEqual([after[sys.id].subject, after[sys.id].topic, after[sys.id].tagged, after[sys.id].category], ['화학', '기체', 'migrated', 'design']);
  assert.deepEqual([after[teacher.id].subject, after[teacher.id].category], ['', 'solution'], 'the teacher\'s untagged item reaches every subject as before');
  assert.equal(after[fmt.id], undefined, 'a lesson about notation is dropped, not left for the teacher to delete');
  assert.equal(migrateLearningV2(store), 0, 'runs once per item');
});

// A proposed lesson is folded into the item that already says the same (the AI compares it with the items whose wording
// overlaps), stored as new otherwise, and never kept when it is about notation.
test('keeping a lesson: merged into a same-meaning editable item with history, added when new, dropped when about notation', async () => {
  const { keepLesson, draftLesson } = require('../server/pipeline');
  const { makeRule } = require('../server/learning');
  const { openStore } = require('../server/store');
  const store = openStore(fs.mkdtempSync(path.join(os.tmpdir(), 'em-keep-')));
  const material = { id: 'a1'.padEnd(24, '0'), subject: '화학', topic: '기체' };
  const existing = store.rules.put(makeRule({ text: '숨긴 값은 원본과 앞 연습 문제의 같은 칸 값과 다르게 잡는다', scope: 'global', layer: 'lesson', subject: '화학', source: { materialId: material.id, from: 'auto' } }));
  const teacher = store.rules.put(makeRule({ text: '보기는 서로 다른 값으로 만든다', scope: 'global', layer: 'lesson', subject: '화학' }));
  const calls = [];
  const ctx = { budget: { affords: () => true }, log: () => {}, llm: { json: async ({ text }) => { calls.push(text); return { data: { same: /숨긴 값/.test(text), text: '숨긴 값(a, b)은 원본과 앞 연습 문제의 같은 칸 값과 모두 다르게 잡고, 정한 뒤 하나씩 대조한다', why: 'w' } }; } } };
  const src = { materialId: material.id, jobId: 'b2'.padEnd(24, '0'), label: 't', from: 'review' };
  const merged = await keepLesson(ctx, store, draftLesson({ scope: 'common', category: 'numbers' }, '숨긴 칸의 답은 원본과 앞 연습 문제에서 같은 자리의 값과 다르게 나오도록 수치를 잡는다', material, src), { why: '검수', jobId: src.jobId, by: 'review' });
  assert.equal(merged.kind, 'revise');
  assert.equal(merged.id, existing.id);
  const after = store.rules.get(existing.id);
  assert.match(after.text, /하나씩 대조/);
  assert.deepEqual(after.history.map((h) => [h.by, h.before]), [['review', existing.text]]);
  assert.equal(store.rules.all().length, 2, 'nothing added');
  // Nothing near: stored as new, tagged with the subject it was learned on, in its category.
  const added = await keepLesson(ctx, store, draftLesson({ scope: 'common', category: 'choices' }, '합답형 보기 하나를 빼도 정답이 정해지면 선택지 조합을 바꾼다', material, src), { why: '검수', jobId: src.jobId, by: 'review' });
  assert.equal(added.kind, 'add');
  assert.deepEqual([store.rules.get(added.id).subject, store.rules.get(added.id).topic, store.rules.get(added.id).category], ['화학', '기체', 'choices']);
  assert.equal(store.rules.get(draftLesson({ scope: 'common', allSubjects: true }, 'x'.repeat(10), material, src).id), null);
  assert.equal(draftLesson({ scope: 'common', allSubjects: true }, 'x'.repeat(10), material, src).subject, '', 'only when the learner says it holds for every subject');
  // A notation lesson is not kept at all.
  assert.equal(await keepLesson(ctx, store, draftLesson({ scope: 'common' }, '화학식은 제목까지 $\ce{X2}$ 꼴로 쓰고 마침표를 맞춘다', material, src), { why: 'w', jobId: '', by: 'review' }), null);
  // The same meaning as a teacher's item: dropped, the teacher's item untouched.
  const dup = await keepLesson({ ...ctx, llm: { json: async () => ({ data: { same: true, text: '보기는 서로 다른 값으로 만들고 모양만 보고 답이 가려지지 않게 한다' } }) } }, store, draftLesson({ scope: 'common' }, '보기는 서로 다른 값으로 만들어 모양만 보고 가려지지 않게 한다', material, src), { why: 'w', jobId: '', by: 'review' });
  assert.equal(dup, null);
  assert.equal(store.rules.get(teacher.id).text, teacher.text);
  assert.equal(store.rules.all().length, 3);
});
