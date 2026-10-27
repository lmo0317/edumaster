'use strict';
// Stability review (2026-10-27): the boundary cases that ended the process or answered a 500 for a client's mistake.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../server');
const { createUsers } = require('../server/users');
const { createLlm, Budget, claudeCliReady } = require('../server/llm');
const { openStore } = require('../server/store');

async function start() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'em-stab-'));
  createUsers(dataDir).create({ username: 'admin', password: 'admin-pass-1', role: 'admin' });
  const app = createApp({ dataDir, llmMode: 'mock' });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  let cookie = '';
  const raw = async (method, url, body, headers = {}) => {
    const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', cookie, ...headers }, body });
    const set = res.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
    return { status: res.status, data: await res.json() };
  };
  const call = (method, url, body, headers) => raw(method, url, body === undefined ? undefined : JSON.stringify(body), headers);
  return { dataDir, app, base, raw, call, close: () => new Promise((r) => app.server.close(r)) };
}

test('a JSON body that is not an object is a 400, not a server error', async () => {
  const s = await start();
  try {
    for (const body of ['null', '[]', '"text"', '3', 'true']) {
      const r = await s.raw('POST', '/api/login', body);
      assert.equal(r.status, 400, `${body}: ${JSON.stringify(r.data)}`);
    }
    assert.equal((await s.raw('POST', '/api/login', '{not json')).status, 400);
    assert.equal((await s.call('POST', '/api/login', { username: 'admin', password: 'admin-pass-1' })).status, 200);
    assert.equal((await s.raw('POST', '/api/materials', 'null')).status, 400);
    assert.equal((await s.raw('POST', '/api/rules', '[1,2]')).status, 400);
  } finally { await s.close(); }
});

test('an Origin header that is not a URL is refused like another site, not a server error', async () => {
  const s = await start();
  try {
    await s.call('POST', '/api/login', { username: 'admin', password: 'admin-pass-1' });
    assert.equal((await s.call('POST', '/api/rules', { text: '지침 하나' }, { origin: 'null' })).status, 403);
    assert.equal((await s.call('POST', '/api/rules', { text: '지침 하나' }, { origin: 'https://evil.example' })).status, 403);
    assert.equal((await s.call('POST', '/api/rules', { text: '지침 하나' }, { origin: 'http://' + new URL(s.base).host })).status, 200);
  } finally { await s.close(); }
});

test('mock mode treats the Claude subscription as ready without a login on this machine', () => {
  assert.equal(claudeCliReady({ llmMode: 'mock', claudeCli: {}, dataDir: '' }), true);
  assert.equal(claudeCliReady({ llmMode: 'mock', claudeCli: { off: true }, dataDir: '' }), false);
});

test('a Claude CLI that cannot be started fails the call, not the process', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'em-stab-cli-'));
  const llm = createLlm({ config: { dataDir, llmMode: 'deepseek', claudeCli: { bin: path.join(dataDir, 'no-such-claude'), model: 'claude-opus-5-5', timeoutMs: 5000 }, deepseek: {}, gemma: {} }, store: openStore(dataDir), apiKey: '', claudeKey: '', mock: null });
  const budget = new Budget({ maxCalls: 3, maxTokens: 100000 });
  // Before the fix the prompt written to the dead child's stdin raised EPIPE with no listener: an uncaught exception.
  await assert.rejects(() => llm.json({ provider: 'claude-cli', purpose: 'solve', jobId: 'j', budget, effort: 'low', system: 's', text: '문제' }), /실행하지 못했습니다/);
});

test('a Gemini/GPT CLI that cannot be started fails the call, not the process', async () => {
  const cli = require('../server/cli-models');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'em-stab-cli2-'));
  const config = { dataDir, root: path.resolve(__dirname, '..'), agyCli: { bin: path.join(dataDir, 'no-agy'), timeoutMs: 5000, workRoot: path.join(dataDir, 'w'), settings: path.join(dataDir, 's.json') }, codexCli: { bin: path.join(dataDir, 'no-codex'), timeoutMs: 5000 } };
  await assert.rejects(() => cli.sendCli(config, 'codex-cli', { messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'q' }], effort: 'low' }), /실행하지 못했습니다/);
  await assert.rejects(() => cli.sendCli(config, 'agy-cli', { messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'q' }], effort: 'low' }), /실행하지 못했습니다/);
});

test('a cancelled job does not start another HTTP call', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'em-stab-abort-'));
  const llm = createLlm({ config: { dataDir, llmMode: 'deepseek', claudeCli: {}, deepseek: { baseUrl: 'http://127.0.0.1:9', textModel: 'x', visionModel: 'x', timeoutMs: 5000 }, gemma: {} }, store: openStore(dataDir), apiKey: 'sk-test', claudeKey: '', mock: null });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => llm.json({ provider: 'deepseek', purpose: 'solve', jobId: 'j', budget: new Budget({ maxCalls: 3, maxTokens: 1000 }), effort: 'low', system: 's', text: 't', signal: controller.signal }), /취소/);
});

// ---------------------------------------------------------------- part 2: the model's data at the seams
test('an analysis fix whose replacement holds $$ is put in as written (no $-pattern expansion)', () => {
  const { applyFixes } = require('../server/pipeline');
  const material = { problem: { text: '질량은 $8w$ g이다.', figure: '', choices: ['$1$', '$2$'] }, steps: [{ title: 't', work: 'w' }] };
  const { applied, unresolved } = applyFixes(material, [{ field: 'problem.text', wrong: '$8w$', right: '$8w$$6w$' }]);
  assert.equal(applied.length, 1, JSON.stringify(unresolved));
  assert.equal(material.problem.text, '질량은 $8w$$6w$ g이다.');
  // A field an older record lacks is read as empty text, not a TypeError.
  const old = { problem: { text: '본문', choices: [] }, steps: [] };
  assert.deepEqual(applyFixes(old, [{ field: 'problem.figure', wrong: 'x', right: 'y' }]).applied, []);
});

test('a lesson id the model mangled is not looked up on disk: the round goes on', async () => {
  const { learnFromReview } = require('../server/pipeline');
  const rules = new Map([['e7975d4c4e9c60f0', { id: 'e7975d4c4e9c60f0', text: '최종 문제는 숨긴 값의 역할, 판정 기준 실험, 묻는 값 중 둘 이상을 원본과 다르게 한다.', status: 'approved', stage: 'generation', scope: 'global', layer: 'lesson', source: { from: 'review' } }]]);
  const { openStore } = require('../server/store');
  const store = openStore(fs.mkdtempSync(path.join(os.tmpdir(), 'em-stab-rules-')));
  for (const r of rules.values()) store.rules.put({ ...r, createdAt: '2026-10-01T00:00:00.000Z' });
  const material = { id: 'm', subject: '화학', topic: 't', title: '몰질량', problem: { text: '' }, steps: [] };
  const ctx = { store, job: { id: 'train' }, budget: { affords: () => true }, effort: { solve: 'low' }, signal: new AbortController().signal, log() {}, save() {},
    llm: { json: async () => ({ data: { revise: [{ id: 'rule-3', text: '다른 문장으로 바꾼다 다른 문장으로' }], remove: [{}, { id: 'e7975d4c4e9c60f0!' }], add: [] } }) } };
  const changed = await learnFromReview(ctx, material, { id: 's1' }, [{ label: '최종 문제', text: '[구조 · mid] 숫자만 바꾼 문제이다.' }]);
  assert.deepEqual(changed, []);
  assert.equal(store.rules.all().length, 1, 'nothing removed');
});

test('users.json is written through a temp file, and a half-written list is never taken for no accounts', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'em-stab-users-'));
  const users = createUsers(dataDir);
  users.create({ username: 'admin', password: 'admin-pass-1', role: 'admin' });
  users.create({ username: 'teacher1', password: 'teacher-pass-1', role: 'teacher' });
  assert.equal(users.count(), 2);
  assert.deepEqual(fs.readdirSync(dataDir).filter((f) => f.endsWith('.tmp')), [], 'no temp file left behind');
  assert.equal((fs.statSync(path.join(dataDir, 'users.json')).mode & 0o777), 0o600);
});

test('the mock analysis caps the STEP count it reads off the prompt', async () => {
  const { mock } = require('../server/mock-llm');
  const prompts = require('../server/prompts');
  const text = `[분석 지침]\n- STEP을 20000개로 나눈다\n\n` + '문제';
  const r = await mock([{ role: 'system', content: prompts.ANALYZE_SYSTEM }, { role: 'user', content: text }]);
  const data = JSON.parse(r.choices[0].message.content);
  assert.ok(data.steps.length <= 10, `steps ${data.steps.length}`);
});

test('a rule from the page: an id that is not one is refused, text that is not text is refused, dormant is not a client state', async () => {
  const s = await start();
  try {
    await s.call('POST', '/api/login', { username: 'admin', password: 'admin-pass-1' });
    assert.equal((await s.call('POST', '/api/rules', { text: '지침 하나', scope: 'material', source: { materialId: '"><img src=x>', from: 'fix' } })).status, 400);
    assert.equal((await s.call('POST', '/api/rules', { text: '지침 하나', source: { jobId: 'not-an-id' } })).status, 400);
    assert.equal((await s.call('POST', '/api/rules', { text: { a: 1 } })).status, 400);
    assert.equal((await s.call('POST', '/api/rules', { text: ['가나다', '라마'] })).status, 400);
    const made = await s.call('POST', '/api/rules', { text: '지침 하나', source: { from: 'auto', faultKeys: ['x'] } });
    assert.equal(made.status, 200);
    assert.equal(made.data.source.from, 'input', 'the system\'s own kinds are not taken from a client');
    assert.equal(made.data.source.faultKeys, undefined);
    const put = await s.call('PUT', `/api/rules/${made.data.id}`, { status: 'dormant' });
    assert.equal(put.status, 200);
    assert.equal(put.data.status, 'approved', 'dormant is the data\'s verdict, not a client\'s');
    assert.equal((await s.call('PUT', `/api/rules/${made.data.id}`, { text: { a: 1 } })).status, 400);
  } finally { await s.close(); }
});

// ---------------------------------------------------------------- part 3: the harness and the set review
test('a frame of adjacent slots is tested against a long line in milliseconds, not minutes', () => {
  const harness = require('../server/harness');
  const long = '실험 Ⅰ에서 ' + '가나다 라마바 '.repeat(60) + '반응하지 않는다.';
  const work = ['실험 Ⅰ에서 A 5w g B 3w g이 반응하여 생성물이 된다.', long, '따라서 질량 보존이 성립한다.'].join('\n');
  const material = { steps: [{ title: 't', work }], problem: { text: '' } };
  const frame = '《실험》에서 《물질1》 《질량1》 《물질2》 《질량2》이 반응하여 생성물이 된다.';
  const started = Date.now();
  const frames = harness.validateFrames(material, { steps: [{ step: 1, frames: [frame] }] });
  const item = { solution: { steps: [{ step: 1, work: [long, 'X 2w g Y 4w g이 반응하여 생성물이 된다.'].join('\n') }] } };
  harness.frameFindings({ ...material, frames }, item);
  assert.ok(Date.now() - started < 2000, `took ${Date.now() - started} ms`);
  assert.equal(frames.length, 1, 'the frame is kept (its teacher line matches)');
  assert.ok(harness.frameRegex(frame).test('실험 Ⅱ에서 C 2w g D 7w g이 반응하여 생성물이 된다.'));
});

test('an extract-frames answer of the wrong shape loses only the bad entry, not every STEP\'s frames', () => {
  const harness = require('../server/harness');
  const material = { steps: [{ title: 't', work: '(가)의 질량은 5 g이다.' }, { title: 'u', work: '(나)의 부피는 3 L이다.' }], problem: { text: '' } };
  const frames = harness.validateFrames(material, { steps: [{ step: 1, frames: ['(가)의 질량은 《질량》이다.'] }, null, { step: 2, frames: { bad: true } }, { step: 2, frames: ['(나)의 부피는 《부피》이다.', 7] }, 'text'] });
  assert.deepEqual(frames.map((f) => f.step), [1, 2]);
  assert.deepEqual(harness.validateFrames(material, { steps: { not: 'a list' } }), []);
});

test('the set review compares the reviewer\'s own answer with the stored one, and an empty review scores nothing', () => {
  const setCheck = require('../server/set-check');
  const finalReview = require('../server/final-review');
  const names = finalReview.ITEM_NAMES;
  const checks = Object.fromEntries(names.map((n) => [n, 'ok']));
  const material = { id: 'm', title: 't', subject: '화학', topic: '', problem: { text: '원본', choices: ['1', '2', '3'], answer: 2 }, steps: [{ title: 's', work: 'w' }] };
  const set = { id: 'abcdefabcdefabcdefabcdef', items: [{ index: 0, label: '최종 문제', status: 'passed', stage: { kind: 'twin' }, problem: { text: '문제', choices: ['1', '2', '3'], answer: 2 }, solution: { steps: [] } }] };
  const record = setCheck.checkRecord(material, set);
  // The reviewer solved to ③, says the marked answer is ③ and answerOk — the stored answer is ②.
  const review = { analysis: { verdict: 'ok', issues: [] }, items: [{ index: 0, label: '최종 문제', verdict: 'use', answerOk: true, myAnswer: 3, markedAnswer: 3, checks, issues: [] }] };
  record.reviews['claude-cli'] = { review: setCheck.normalizeReview(review, record.set.items) };
  record.done = true;
  const fails = setCheck.failing(record, null, []);
  assert.equal(fails.length, 1, 'the problem fails on the answer');
  assert.match(fails[0].faults.join(' '), /정답|답/);
  const empty = finalReview.checklistOf({ verdict: 'reject', checks: {}, issues: [] }, { final: true, answer: 2 });
  assert.ok(Object.values(empty).every(([mark]) => mark === 'na'), JSON.stringify(empty));
});

test('a deleted set\'s fault archive is written through a temp file', () => {
  const faults = require('../server/faults');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'em-stab-faults-'));
  const job = { id: 'abcdefabcdefabcdefabcdef', materialId: 'm', title: 't', items: [{ index: 0, label: '최종 문제', problem: { text: '문제' }, status: 'needs_review', problems: ['[구조 · mid] 원본과 구조가 같다'], history: [] }] };
  faults.archive(dataDir, job, null);
  const files = fs.readdirSync(path.join(dataDir, 'faults'));
  assert.ok(files.includes(`${job.id}.json`) && !files.some((f) => f.endsWith('.tmp')), files.join(','));
});
