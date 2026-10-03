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

test('학습 지도 over the API: the map, a candidate the AI merged, merging and skipping', async () => {
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
    let d = (await call('GET', '/api/learning')).data.map;
    assert.equal(d.items.length, 5);
    assert.deepEqual(d.recent, { added: 5, auto: 0 });
    assert.ok(d.items.every((x) => x.marks && x.uses === 0 && Array.isArray(x.evidence)));
    // The AI checks the overlapping pairs in the background.
    for (let i = 0; i < 100 && d.checking; i++) { await new Promise((r) => setTimeout(r, 30)); d = (await call('GET', '/api/learning')).data.map; }
    assert.equal(d.checking, 0);
    assert.equal(d.candidates.length, 1, JSON.stringify(d.candidates));
    const cand = d.candidates[0];
    assert.deepEqual([cand.a.id, cand.b.id].sort(), [a.id, b.id].sort());
    assert.match(cand.text, /모의 합침/);
    // Merging: the 지침 stays with the teacher's sentence and both originals; the other is gone.
    assert.equal((await call('POST', '/api/learning/merge', { key: cand.key, text: '해설은 선생님 해설과 같은 구성으로 쓰고, 선생님 해설이 끝나는 자리에서 끝낸다' })).status, 200);
    assert.equal((await call('POST', '/api/learning/merge', { key: cand.key, text: 'x x x' })).status, 409, 'already merged');
    const rules = (await call('GET', '/api/rules')).data;
    const kept = rules.find((r) => r.id === a.id);
    assert.equal(kept.text, '해설은 선생님 해설과 같은 구성으로 쓰고, 선생님 해설이 끝나는 자리에서 끝낸다');
    assert.deepEqual(kept.mergedFrom.map((x) => x.text).sort(), [a.text, b.text].sort());
    assert.ok(!rules.some((r) => r.id === b.id));
    d = (await call('GET', '/api/learning')).data.map;
    assert.ok(d.items.find((x) => x.id === a.id).evidence.some((e) => e.includes(b.text)), 'the merged original is its evidence');
    assert.equal(d.candidates.length, 0);
    assert.ok(d.items.some((x) => x.id === c.id));
    // Skipping: both stay and the pair is not offered again.
    await add('표는 모든 행의 칸 수를 머리 행과 같게 맞춘다');
    for (let i = 0; i < 100 && !d.candidates.length; i++) { await new Promise((r) => setTimeout(r, 30)); d = (await call('GET', '/api/learning')).data.map; }
    assert.equal(d.candidates.length, 1);
    await call('POST', '/api/learning/skip', { key: d.candidates[0].key });
    d = (await call('GET', '/api/learning')).data.map;
    assert.deepEqual([d.candidates.length, d.checking, d.items.length], [0, 0, 5]);
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
  assert.deepEqual(ids(''), ['d', 'b', 'c', 'a'], 'a problem without a subject gets everything');
  const own = { ...r('e', '문제 학습'), scope: 'material', subject: '화학', source: { materialId: 'm' } };
  assert.equal(updateRule(own, { scope: 'global' }).subject, '', 'moved up: reaches every subject until tagged');
  assert.equal(updateRule(r('f', 'x'), { subject: '화학' }).subject, '화학');
});
