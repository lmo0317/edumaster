'use strict';
process.env.EDUMASTER_MOCK_DELAY_MS = '5';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../server');
const { createUsers } = require('../server/users');

const image = 'data:image/png;base64,' + Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(300, 7)]).toString('base64');

async function start() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'em2-'));
  createUsers(dataDir).create({ username: 'admin', password: 'test-pass-1', role: 'admin' });
  const app = createApp({ dataDir, llmMode: 'mock' });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  let cookie = '';
  const call = async (method, url, body) => {
    const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined });
    const set = res.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
    const data = await res.json();
    return { status: res.status, data };
  };
  const waitJob = async (id) => {
    for (let i = 0; i < 2400; i++) {
      const { data } = await call('GET', `/api/jobs/${id}`);
      if (['done', 'failed', 'cancelled', 'interrupted'].includes(data.status)) return data;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('job timeout');
  };
  return { app, base, call, waitJob, close: () => new Promise((r) => app.server.close(r)), dataDir };
}

test('full flow with mock model: analyze → edit → generate → verify/repair → feedback → regenerate', async () => {
  const s = await start();
  try {
    assert.equal((await s.call('GET', '/api/materials')).status, 401);
    assert.equal((await s.call('POST', '/api/login', { username: 'admin', password: 'wrong-pass' })).status, 401);
    assert.equal((await s.call('POST', '/api/login', { username: 'admin', password: 'test-pass-1' })).status, 200);

    const created = await s.call('POST', '/api/materials', { title: '몰질량', problemImage: image, solutionImage: image });
    assert.equal(created.status, 200, JSON.stringify(created.data));
    const analyze = await s.waitJob(created.data.jobId);
    assert.equal(analyze.status, 'done', analyze.error);
    let material = (await s.call('GET', `/api/materials/${created.data.material.id}`)).data;
    assert.equal(material.status, 'ready');
    assert.equal(material.steps.length, 3);
    assert.ok(material.annotations.some((a) => a.includes('필기')), 'handwriting kept out of the problem');
    assert.deepEqual(material.proofread.length, 1, 'proofreading fix applied');
    assert.ok(material.problem.text.includes('실험 Ⅰ~Ⅲ에 대한'));
    assert.equal(analyze.usage.calls, 6, "analyze + proofread + two question and two heading re-reads");

    // teacher edits: fix a step title and keep 3 steps
    const edited = await s.call('PUT', `/api/materials/${material.id}`, { steps: material.steps.map((st, i) => (i === 0 ? { ...st, title: 'I에서 모두 반응한 물질 판정' } : st)) });
    assert.equal(edited.status, 200, JSON.stringify(edited.data));
    assert.equal(edited.data.steps[0].title, 'I에서 모두 반응한 물질 판정');

    // a global rule that must be attached and reported
    const rule = (await s.call('POST', '/api/rules', { text: '보조 문자 n, m을 해설에서 계속 사용한다', kind: 'do', target: 'solution', scope: 'global' })).data;
    assert.equal(rule.status, 'approved');

    const gen = await s.call('POST', '/api/generations', { materialId: material.id, mode: 'integrated' });
    assert.equal(gen.status, 200, JSON.stringify(gen.data));
    const job = await s.waitJob(gen.data.jobId);
    assert.equal(job.status, 'done', job.error);
    assert.deepEqual(job.items.map((i) => i.label), ['STEP 1 연습', 'STEP 1~2 연습', '최종 문제']);
    for (const item of job.items) {
      assert.ok(['passed', 'warning'].includes(item.status), `${item.label}: ${item.status} ${JSON.stringify(item.problems)}`);
      assert.equal(item.verification.code.status, 'pass');
      assert.equal(item.verification.blind.answer, item.problem.answer);
      assert.equal(item.verification.rules[0].id, rule.id);
      assert.ok(item.verification.rules[0].how);
    }
    assert.ok(job.items.some((i) => i.attempts.some((a) => a.kind === 'repair')), 'the deliberately wrong mock answer was repaired');
    // What the checks had to fix became this problem's learning, reported on the set.
    assert.equal(job.learned.length, 1);
    const auto = (await s.call('GET', '/api/rules')).data.find((r) => r.id === job.learned[0].id);
    assert.deepEqual([auto.scope, auto.stage, auto.source.from, auto.source.jobId], ['material', 'generation', 'auto', job.id]);
    assert.ok(job.usage.calls >= 7 && job.usage.calls <= job.budget.maxCalls);

    // feedback on one problem → pending rule, approve it, regenerate that problem only
    const fb = await s.call('POST', '/api/rules', { text: '앞 단계 결론을 문제에서 미리 알려주지 말 것', kind: 'dont', target: 'problem', scope: 'topic', status: 'pending', source: { jobId: job.id, itemIndex: 1 } });
    assert.equal(fb.data.status, 'pending');
    assert.equal(fb.data.subject, '화학');
    const approved = await s.call('PUT', `/api/rules/${fb.data.id}`, { status: 'approved' });
    assert.equal(approved.data.status, 'approved');
    const regen = await s.call('POST', `/api/jobs/${job.id}/items/1/regenerate`, { feedback: '조건을 더 간단히' });
    assert.equal(regen.status, 200, JSON.stringify(regen.data));
    assert.equal((await s.waitJob(regen.data.jobId)).status, 'done');
    const after = (await s.call('GET', `/api/jobs/${job.id}`)).data;
    assert.equal(after.items[1].history.length, 1);
    assert.equal(after.items[1].history[0].feedback, '조건을 더 간단히');

    // next generation for the same material picks up the approved topic rule
    const gen2 = await s.call('POST', '/api/generations', { materialId: material.id, stages: [{ kind: 'focus', step: 3 }], mode: 'numeric' });
    const job2 = await s.waitJob(gen2.data.jobId);
    assert.deepEqual(job2.rules.map((r) => r.id).sort(), [rule.id, fb.data.id, job.learned[0].id].sort());
    assert.equal(job2.items[0].label, 'STEP 3 집중 연습 (앞 단계 결과 제공)');

    const usage = (await s.call('GET', '/api/usage')).data;
    assert.ok(usage.all.calls > 0);
  } finally { await s.close(); }
});

test('budget stops a job instead of overspending', async () => {
  const s = await start();
  try {
    s.app.config.budget.generateCalls = 2;
    await s.call('POST', '/api/login', { username: 'admin', password: 'test-pass-1' });
    const created = await s.call('POST', '/api/materials', { problemImage: image });
    await s.waitJob(created.data.jobId);
    const gen = await s.call('POST', '/api/generations', { materialId: created.data.material.id });
    const job = await s.waitJob(gen.data.jobId);
    assert.equal(job.status, 'failed');
    assert.match(job.error, /상한/);
    assert.equal(job.usage.calls, 2);
    const resumed = await s.call('POST', `/api/jobs/${job.id}/resume`);
    assert.equal(resumed.status, 200);
  } finally { await s.close(); }
});

test('model choice: Gemma runs every call of the job and is free; refused while the PC is off', async () => {
  const s = await start();
  try {
    await s.call('POST', '/api/login', { username: 'admin', password: 'test-pass-1' });
    const status = (await s.call('GET', '/api/status')).data;
    assert.equal(status.providers.gemma.available, true);
    const created = await s.call('POST', '/api/materials', { problemImage: image, provider: 'gemma' });
    const analysis = await s.waitJob(created.data.jobId);
    assert.equal(analysis.options.provider, 'gemma');
    const material = (await s.call('GET', `/api/materials/${created.data.material.id}`)).data;
    assert.equal(material.analyzedWith, 'gemma');
    const gen = await s.call('POST', '/api/generations', { materialId: material.id, stages: [{ kind: 'twin' }], provider: 'gemma' });
    const job = await s.waitJob(gen.data.jobId);
    assert.equal(job.status, 'done', job.error);
    assert.equal(job.options.provider, 'gemma');
    assert.equal(job.modelLabel, 'mock-gemma', 'the job keeps the name of the local model that made it');
    const usage = (await s.call('GET', '/api/usage')).data;
    assert.ok(usage.all.calls > 0);
    assert.equal(usage.all.paidInput, 0, 'Gemma calls are not billed');
  } finally { await s.close(); }

  // Real (non-mock) mode with the Gemma tunnel down: the choice is refused before anything runs.
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'em2-'));
  createUsers(dataDir).create({ username: 'admin', password: 'test-pass-1', role: 'admin' });
  const app = createApp({ dataDir, llmMode: 'deepseek', gemma: { endpoint: 'http://127.0.0.1:9/v1', timeoutMs: 1000, maxOutputTokens: 100 } });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  try {
    const base = `http://127.0.0.1:${app.server.address().port}`;
    const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'test-pass-1' }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const st = await (await fetch(base + '/api/status', { headers: { cookie } })).json();
    assert.equal(st.providers.gemma.available, false);
    const res = await fetch(base + '/api/materials', { method: 'POST', headers: { 'Content-Type': 'application/json', cookie }, body: JSON.stringify({ problemImage: image, provider: 'gemma' }) });
    assert.equal(res.status, 409);
    assert.match((await res.json()).error, /Gemma/);
  } finally { await new Promise((r) => app.server.close(r)); }
});

test('one-click STEP merge for a material whose STEPs outnumber the teacher\'s step markers', async () => {
  const s = await start();
  try {
    await s.call('POST', '/api/login', { username: 'admin', password: 'test-pass-1' });
    const created = await s.call('POST', '/api/materials', { problemImage: image });
    await s.waitJob(created.data.jobId);
    const id = created.data.material.id;
    const m = (await s.call('GET', `/api/materials/${id}`)).data;
    const split = [...m.steps.slice(0, 2), { ...m.steps[2], title: '앞부분', marker: '' }, { ...m.steps[2], title: '뒷부분', marker: '' }];
    const put = await s.call('PUT', `/api/materials/${id}`, { steps: split, stepMarkers: ['step1', 'step2', 'step3'] });
    assert.equal(put.data.steps.length, 4);
    assert.ok(put.data.uncertainties.some((u) => u.startsWith('해설의 단계 표시는')));
    const aligned = await s.call('POST', `/api/materials/${id}/align-steps`);
    assert.equal(aligned.status, 200, JSON.stringify(aligned.data));
    assert.equal(aligned.data.steps.length, 3);
    assert.ok(!aligned.data.uncertainties.some((u) => u.startsWith('해설의 단계 표시는')));
    assert.ok(aligned.data.proofread.some((p) => p.includes('STEP 3+4')));
  } finally { await s.close(); }
});

test('지침 and 전체 학습: the persona leads every call; every-problem analysis items reach every analysis; the checks are listed', async () => {
  const s = await start();
  try {
    assert.equal((await s.call('GET', '/api/learning')).status, 401, 'login required');
    await s.call('POST', '/api/login', { username: 'admin', password: 'test-pass-1' });
    let d = (await s.call('GET', '/api/learning')).data;
    assert.deepEqual([d.persona, d.guides.analysis, d.guides.generation, d.lessons.analysis, d.lessons.generation], ['', [], [], [], []]);
    // 하네스: the checks with what happens on failure, how they fared, and settings kept within their range.
    const h = (await s.call('GET', '/api/harness')).data;
    assert.ok(h.checks.generation.length >= 10 && h.checks.analysis.length >= 5);
    assert.ok(h.checks.generation.every((c) => h.onFail[c.onFail]), 'every check says what happens on failure');
    assert.deepEqual(h.settings, { maxRewrites: 2, maxRepairs: 2, maxDesigns: 3, setCalls: 60 });
    assert.deepEqual(h.stats.checks.map((c) => c.label), h.checks.generation.map((c) => c.label));
    assert.equal((await s.call('PUT', '/api/harness', { maxDesigns: 9 })).status, 400);
    assert.deepEqual((await s.call('PUT', '/api/harness', { maxDesigns: 2, setCalls: 80 })).data.settings, { maxRewrites: 2, maxRepairs: 2, maxDesigns: 2, setCalls: 80 });
    const made = (await s.call('POST', '/api/materials', { problemImage: image, solutionImage: image })).data;
    await s.waitJob(made.jobId);
    const job = (await s.call('POST', '/api/generations', { materialId: made.material.id, mode: 'integrated' })).data;
    assert.equal((await s.waitJob(job.jobId)).budget.maxCalls, 80, 'a new set takes the call cap');

    assert.equal((await s.call('PUT', '/api/persona', { persona: '  화학 선생님의 조교  ' })).data.persona, '화학 선생님의 조교');
    assert.equal((await s.call('PUT', '/api/persona', { persona: 'x'.repeat(4001) })).status, 400);
    const { withTeacherPrompt } = require('../server/llm');
    const cfg = { dataDir: s.dataDir };
    assert.ok(withTeacherPrompt(cfg, 'BUILT-IN').indexOf('화학 선생님의 조교') < withTeacherPrompt(cfg, 'BUILT-IN').indexOf('BUILT-IN'), 'the persona comes first');
    await s.call('PUT', '/api/persona', { persona: '' });
    assert.equal(withTeacherPrompt(cfg, 'BUILT-IN'), 'BUILT-IN');

    // 전체 학습 of analysis: a new problem's analysis follows it, though the problem has none of its own.
    const easy = (await s.call('POST', '/api/rules', { text: '해설은 쉽게 풀어 쓴다', scope: 'global', layer: 'lesson', stage: 'analysis' })).data;
    const four = (await s.call('POST', '/api/rules', { text: 'STEP을 4개로 나눈다', scope: 'global', layer: 'guide', stage: 'analysis' })).data;
    d = (await s.call('GET', '/api/learning')).data;
    assert.deepEqual([d.lessons.analysis.map((x) => x.text), d.guides.analysis.map((x) => x.text)], [['해설은 쉽게 풀어 쓴다'], ['STEP을 4개로 나눈다']]);
    const a = (await s.call('POST', '/api/materials', { problemImage: image, solutionImage: image })).data;
    await s.waitJob(a.jobId);
    let m = (await s.call('GET', '/api/materials/' + a.material.id)).data;
    assert.equal(m.steps.length, 4, 'the 지침 STEP count');
    assert.ok(m.steps.every((x) => x.work.startsWith('(쉽게 풀어 씀)')), 'the lesson write-up');
    assert.deepEqual(m.learningUsed.map((x) => x.layer), ['guide', 'lesson'], 'the analysis keeps what went into it');
    const l = (await s.call('GET', `/api/materials/${m.id}/learning`)).data;
    assert.ok(l.analysis.items.every((x) => x.inAnalysis && x.how), 'each with how it was applied');
    await s.call('DELETE', '/api/rules/' + easy.id);
    await s.call('DELETE', '/api/rules/' + four.id);
    const again = (await s.call('POST', `/api/materials/${m.id}/analyze`, {})).data;
    await s.waitJob(again.jobId);
    m = (await s.call('GET', '/api/materials/' + m.id)).data;
    assert.equal(m.steps.length, 3, 'without them the printed steps decide again');

    for (const gone of ['/api/llm/prompts', '/api/system', '/api/common']) assert.equal((await s.call('GET', gone)).status, 404, gone);
  } finally { await s.close(); }
});
test('model comparison list and one comparison', async () => {
  const s = await start();
  try {
    await s.call('POST', '/api/login', { username: 'admin', password: 'test-pass-1' });
    const cmpList = (await s.call('GET', '/api/compare')).data;
    assert.ok(Array.isArray(cmpList));
    if (cmpList.length) { const one = (await s.call('GET', '/api/compare/' + cmpList[0].id)).data; assert.ok(one.original.problemImage.startsWith('data:image/') && one.models.length); }
    assert.equal((await s.call('GET', '/api/compare/nope')).status, 404);
  } finally { await s.close(); }
});

test('the public comparison page needs no login and exposes only the comparison', async () => {
  const s = await start();
  try {
    const page = await fetch(s.base + '/compare.html');
    assert.equal(page.status, 200);
    const pub = await fetch(s.base + '/api/public/compare');
    assert.equal(pub.status, 200, 'no session needed');
    const b = await pub.json();
    assert.ok(b.overview && b.models.length, 'the whole comparison');
    assert.equal(b.feedback?.quote || '', '', 'the colleague\'s message stays private');
    assert.equal((await fetch(s.base + '/api/public/compare/other/pdf/relay')).status, 404);
    assert.equal((await fetch(s.base + '/api/compare/chem-molar-mass')).status, 401, 'the app route still needs login');
    assert.equal((await fetch(s.base + '/api/materials')).status, 401);
  } finally { await s.close(); }
});

test('mixed run: designWith sends problem design and repairs to that model; solving and review stay with the provider', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'em2-'));
  createUsers(dataDir).create({ username: 'admin', password: 'test-pass-1', role: 'admin' });
  const app = createApp({ dataDir, llmMode: 'mock', relay: { dir: path.join(dataDir, 'relay'), label: 'relay', timeoutMs: 1000 } });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  let cookie = '';
  const call = async (method, url, body) => {
    const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined });
    const set = res.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
    return res.json();
  };
  const wait = async (id) => { for (;;) { const j = await call('GET', `/api/jobs/${id}`); if (['done', 'failed'].includes(j.status)) return j; await new Promise((r) => setTimeout(r, 25)); } };
  try {
    await call('POST', '/api/login', { username: 'admin', password: 'test-pass-1' });
    const created = await call('POST', '/api/materials', { title: '몰질량', problemImage: image, solutionImage: image });
    await wait(created.jobId);
    const gen = await call('POST', '/api/generations', { materialId: created.material.id, mode: 'integrated', designWith: 'relay' });
    const job = await wait(gen.jobId);
    assert.equal(job.status, 'done', job.error);
    assert.equal(job.options.designWith, 'relay');
    const calls = fs.readdirSync(path.join(dataDir, 'usage')).map((f) => JSON.parse(fs.readFileSync(path.join(dataDir, 'usage', f), 'utf8'))).filter((r) => r.jobId === job.id);
    const by = (purpose) => [...new Set(calls.filter((r) => r.purpose === purpose).map((r) => r.provider))];
    assert.deepEqual(by('generate'), ['relay']);
    assert.deepEqual(by('repair'), ['relay'], 'the mock\'s deliberately wrong answer was repaired by the design model');
    assert.deepEqual(by('solve'), ['deepseek']);
  } finally {
    await new Promise((r) => app.server.close(r));
  }
});

test('lean mixed run end to end (mock): the designer writes and adjudicates, the provider writes the solution out, solves and reviews', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'em2-'));
  createUsers(dataDir).create({ username: 'admin', password: 'test-pass-1', role: 'admin' });
  const app = createApp({ dataDir, llmMode: 'mock', relay: { dir: path.join(dataDir, 'relay'), label: 'relay', timeoutMs: 1000 } });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  let cookie = '';
  const call = async (method, url, body) => {
    const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined });
    const set = res.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
    return res.json();
  };
  const wait = async (id) => { for (;;) { const j = await call('GET', `/api/jobs/${id}`); if (['done', 'failed'].includes(j.status)) return j; await new Promise((r) => setTimeout(r, 25)); } };
  try {
    await call('POST', '/api/login', { username: 'admin', password: 'test-pass-1' });
    const created = await call('POST', '/api/materials', { title: '몰질량', problemImage: image, solutionImage: image });
    await wait(created.jobId);
    const gen = await call('POST', '/api/generations', { materialId: created.material.id, mode: 'integrated', designWith: 'relay', lean: true });
    const job = await wait(gen.jobId);
    assert.equal(job.status, 'done', job.error);
    assert.equal(job.options.lean, true);
    const calls = fs.readdirSync(path.join(dataDir, 'usage')).map((f) => JSON.parse(fs.readFileSync(path.join(dataDir, 'usage', f), 'utf8'))).filter((r) => r.jobId === job.id);
    const by = (purpose) => [...new Set(calls.filter((r) => r.purpose === purpose).map((r) => r.provider))];
    assert.deepEqual(by('generate'), ['relay']);
    assert.deepEqual(by('write-solution'), ['deepseek']);
    assert.deepEqual(by('solve'), ['deepseek']);
    assert.ok(job.items.every((i) => i.outline?.steps?.length && i.solution?.steps?.length), 'each problem keeps the outline and the written solution');
    assert.ok(job.items.every((i) => i.status !== 'failed'), JSON.stringify(job.items.map((i) => [i.status, i.error])));
  } finally {
    await new Promise((r) => app.server.close(r));
  }
});

test('problem feedback: written on the problem page or on a variant it belongs to that problem and reaches only its sets', async () => {
  const s = await start();
  try {
    await s.call('POST', '/api/login', { username: 'admin', password: 'test-pass-1' });
    const a = (await s.call('POST', '/api/materials', { title: 'A', problemImage: image, solutionImage: image })).data;
    const b = (await s.call('POST', '/api/materials', { title: 'B', problemImage: image, solutionImage: image })).data;
    await s.waitJob(a.jobId); await s.waitJob(b.jobId);
    const onPage = (await s.call('POST', '/api/rules', { text: 'A 문제 전용: 표에 남는 물질을 적지 말 것', target: 'problem', source: { materialId: a.material.id } })).data;
    assert.equal(onPage.scope, 'material');
    assert.equal(onPage.status, 'approved');
    const genA = await s.waitJob((await s.call('POST', '/api/generations', { materialId: a.material.id, mode: 'integrated' })).data.jobId);
    assert.ok(genA.rules.some((r) => r.id === onPage.id), 'A\'s set carries A\'s feedback');
    const onVariant = (await s.call('POST', '/api/rules', { text: '이 변형처럼 조건을 늘리지 말 것', source: { jobId: genA.id, itemIndex: 0 } })).data;
    assert.equal(onVariant.scope, 'material', 'feedback on a variant goes to its original problem');
    assert.equal(onVariant.source.materialId, a.material.id);
    const genB = await s.waitJob((await s.call('POST', '/api/generations', { materialId: b.material.id, mode: 'integrated' })).data.jobId);
    assert.ok(!genB.rules.some((r) => [onPage.id, onVariant.id].includes(r.id)), 'B never gets A\'s feedback');
    const list = (await s.call('GET', '/api/materials')).data;
    const autoOf = (job) => (job.learned || []).filter((l) => l.scope === 'problem').length; // learned from the set's own faults
    assert.equal(list.find((x) => x.id === a.material.id).feedbackCount, 2 + autoOf(genA));
    assert.equal(list.find((x) => x.id === b.material.id).feedbackCount, autoOf(genB));
    // Widened to every problem, it reaches B too.
    await s.call('PUT', '/api/rules/' + onPage.id, { scope: 'global' });
    const genB2 = await s.waitJob((await s.call('POST', '/api/generations', { materialId: b.material.id, mode: 'integrated' })).data.jobId);
    assert.ok(genB2.rules.some((r) => r.id === onPage.id));
  } finally { await s.close(); }
});

test('a problem\'s analysis learning: typed with 다시 분석 or added alone, kept as items, and every re-analysis gets all of it', async () => {
  const s = await start();
  try {
    await s.call('POST', '/api/login', { username: 'admin', password: 'test-pass-1' });
    const a = (await s.call('POST', '/api/materials', { title: 'A', problemImage: image, solutionImage: image })).data;
    await s.waitJob(a.jobId);
    const id = a.material.id;
    const first = (await s.call('POST', `/api/materials/${id}/analyze`, { feedback: 'STEP 3 제목은 A~D의 몰질량을 구한다' })).data;
    await s.waitJob(first.jobId);
    const second = (await s.call('POST', `/api/materials/${id}/analyze`, { feedback: '표 Ⅲ의 B는 필기', from: 'check' })).data;
    await s.waitJob(second.jobId);
    let l = (await s.call('GET', `/api/materials/${id}/learning`)).data;
    assert.deepEqual(l.analysis.items.map((x) => [x.layer, x.text, x.from, x.inAnalysis]),
      [['problem', 'STEP 3 제목은 A~D의 몰질량을 구한다', 'input', true], ['problem', '표 Ⅲ의 B는 필기', 'check', true]]);
    // Added on its own: kept for the next analysis, which has not run.
    const added = (await s.call('POST', '/api/rules', { text: 'STEP을 4개로 나눈다', scope: 'material', stage: 'analysis', source: { materialId: id } })).data;
    assert.equal((await s.call('GET', '/api/materials/' + id)).data.status, 'ready', 'adding does not start an analysis');
    l = (await s.call('GET', `/api/materials/${id}/learning`)).data;
    assert.equal(l.analysis.items.find((x) => x.id === added.id).inAnalysis, false, 'waits for the next analysis');
    assert.equal((await s.call('GET', '/api/materials')).data.find((x) => x.id === id).analysisFeedbackCount, 3);
    // An analysis item does not go into a generation.
    assert.ok(!l.generation.items.some((x) => x.stage === 'analysis'));
    await s.call('PUT', '/api/rules/' + added.id, { text: 'STEP을 4개로 나눠 한 단계 더 생각하게' });
    await s.call('PUT', '/api/rules/' + added.id, { status: 'pending' });
    l = (await s.call('GET', `/api/materials/${id}/learning`)).data;
    assert.deepEqual(l.analysis.items.find((x) => x.id === added.id) && [l.analysis.items.find((x) => x.id === added.id).text, l.analysis.items.find((x) => x.id === added.id).status], ['STEP을 4개로 나눠 한 단계 더 생각하게', 'pending'], 'switched off, still listed to switch back on');
  } finally { await s.close(); }
});
test('a problem\'s generation learning: 지침, this problem, 전체 학습 in that order, with how each fared; moving up 문제 → 전체 학습 → 지침', async () => {
  const s = await start();
  try {
    await s.call('POST', '/api/login', { username: 'admin', password: 'test-pass-1' });
    const a = (await s.call('POST', '/api/materials', { title: 'P', problemImage: image, solutionImage: image })).data;
    await s.waitJob(a.jobId);
    const id = a.material.id;
    const own = (await s.call('POST', '/api/rules', { text: '단서를 노출하지 않는다', target: 'problem', scope: 'material', source: { materialId: id } })).data;
    await s.call('POST', '/api/rules', { text: '조건을 낭비하지 않는다', scope: 'global', layer: 'guide' });
    await s.call('POST', '/api/rules', { text: '수를 작게 잡는다', scope: 'global', layer: 'lesson' });
    let l = (await s.call('GET', `/api/materials/${id}/learning`)).data;
    assert.deepEqual(l.generation.items.map((x) => [x.layer, x.text]), [['guide', '조건을 낭비하지 않는다'], ['problem', '단서를 노출하지 않는다'], ['lesson', '수를 작게 잡는다']]);
    const gen = (await s.call('POST', '/api/generations', { materialId: id, stages: [{ kind: 'upto', upto: 1 }], mode: 'integrated', perStage: 1 })).data;
    const job = await s.waitJob(gen.jobId);
    assert.deepEqual(job.rules.map((r) => r.layer), ['guide', 'problem', 'lesson'], 'the set records each item with its kind');
    l = (await s.call('GET', `/api/materials/${id}/learning`)).data;
    assert.equal(l.sets[0].rules, 3);
    // Up: this problem → 전체 학습 (it remembers where it was learned) → 지침.
    await s.call('PUT', '/api/rules/' + own.id, { scope: 'global' });
    let d = (await s.call('GET', '/api/learning')).data;
    const up = d.lessons.generation.find((x) => x.id === own.id);
    assert.deepEqual([up.layer, up.learnedOn], ['lesson', 'P']);
    await s.call('PUT', '/api/rules/' + own.id, { layer: 'guide' });
    d = (await s.call('GET', '/api/learning')).data;
    assert.ok(d.guides.generation.some((x) => x.id === own.id));
    // And back to the problem it came from.
    await s.call('PUT', '/api/rules/' + own.id, { scope: 'material' });
    l = (await s.call('GET', `/api/materials/${id}/learning`)).data;
    assert.equal(l.generation.items.find((x) => x.id === own.id).layer, 'problem');
  } finally { await s.close(); }
});
test('renaming a problem: the new name stays through a re-analysis and shows on its sets', async () => {
  const s = await start();
  try {
    await s.call('POST', '/api/login', { username: 'admin', password: 'test-pass-1' });
    const a = (await s.call('POST', '/api/materials', { problemImage: image, solutionImage: image })).data;
    await s.waitJob(a.jobId);
    const id = a.material.id;
    assert.equal((await s.call('PUT', `/api/materials/${id}/name`, { title: ' ' })).status, 400);
    let m = (await s.call('PUT', `/api/materials/${id}/name`, { title: '몰질량 — 한계 반응물', subject: '화학', topic: '양적 관계' })).data;
    assert.deepEqual([m.title, m.subject, m.topic, m.titleFromUser], ['몰질량 — 한계 반응물', '화학', '양적 관계', true]);
    assert.ok(!m.teacherEditedAt, 'renaming is not an edit of the analysis');
    const again = (await s.call('POST', `/api/materials/${id}/analyze`, {})).data;
    await s.waitJob(again.jobId);
    m = (await s.call('GET', '/api/materials/' + id)).data;
    assert.equal(m.title, '몰질량 — 한계 반응물', 'a re-analysis does not rename it');
    const gen = (await s.call('POST', '/api/generations', { materialId: id, stages: [{ kind: 'upto', upto: 1 }], mode: 'integrated', perStage: 1 })).data;
    await s.waitJob(gen.jobId);
    await s.call('PUT', `/api/materials/${id}/name`, { title: '새 이름' });
    assert.equal((await s.call('GET', '/api/jobs/' + gen.jobId)).data.materialTitle, '새 이름', 'the set shows the name as it is now');
    // The analysis editor renaming it also sticks.
    m = (await s.call('PUT', '/api/materials/' + id, { title: '편집기에서 바꾼 이름' })).data;
    assert.equal(m.titleFromUser, true);
  } finally { await s.close(); }
});

test('deleting a problem takes its sets and its own learning; learning moved up to 공통 학습 stays', async () => {
  const s = await start();
  try {
    await s.call('POST', '/api/login', { username: 'admin', password: 'test-pass-1' });
    const a = (await s.call('POST', '/api/materials', { problemImage: image, solutionImage: image })).data;
    await s.waitJob(a.jobId);
    const id = a.material.id;
    const own = (await s.call('POST', '/api/rules', { text: '이 문제만', stage: 'generation', scope: 'material', source: { materialId: id } })).data;
    const moved = (await s.call('POST', '/api/rules', { text: '올린 것', stage: 'generation', scope: 'material', source: { materialId: id } })).data;
    await s.call('PUT', '/api/rules/' + moved.id, { scope: 'global', layer: 'lesson' });
    const gen = (await s.call('POST', '/api/generations', { materialId: id, stages: [{ kind: 'upto', upto: 1 }], mode: 'integrated', perStage: 1 })).data;
    await s.waitJob(gen.jobId);
    const del = await s.call('DELETE', '/api/materials/' + id);
    assert.equal(del.status, 200);
    assert.deepEqual([del.data.sets, del.data.learning], [1, 1]);
    assert.equal((await s.call('GET', '/api/jobs/' + gen.jobId)).status, 404);
    assert.equal((await s.call('GET', '/api/jobs/' + a.jobId)).status, 404, 'its analysis goes too');
    const texts = (await s.call('GET', '/api/rules')).data.map((r) => r.text);
    assert.ok(!texts.includes(own.text));
    assert.ok(texts.includes('올린 것'));
  } finally { await s.close(); }
});

test('analysis feedback beats the printed steps: a STEP count and an easier write-up survive merging, proofreading and printed titles', async () => {
  const s = await start();
  try {
    await s.call('POST', '/api/login', { username: 'admin', password: 'test-pass-1' });
    const a = (await s.call('POST', '/api/materials', { title: '피드백 반영', problemImage: image, solutionImage: image })).data;
    await s.waitJob(a.jobId);
    let m = (await s.call('GET', '/api/materials/' + a.material.id)).data;
    assert.equal(m.steps.length, 3, 'the solution prints three steps');
    const easy = (await s.call('POST', '/api/rules', { text: '설명을 좀더 쉽게 해줘봐', scope: 'material', stage: 'analysis', source: { materialId: m.id } })).data;
    const again = (await s.call('POST', `/api/materials/${m.id}/analyze`, { feedback: 'STEP을 4개로 분리 해서 넣어봐 한단계 더 꼬아서 생각할수 있게' })).data;
    await s.waitJob(again.jobId);
    m = (await s.call('GET', '/api/materials/' + m.id)).data;
    assert.equal(m.steps.length, 4, 'not merged back to the three printed steps');
    assert.equal(m.teacherStepCount, 4);
    assert.equal(m.targetSteps, 4);
    assert.ok(m.steps.every((x) => x.work.startsWith('(쉽게 풀어 씀)')), 'the easier write-up is not "corrected" back to the printed solution');
    assert.ok(!m.uncertainties.some((u) => /단계 표시는|STEP 수는/.test(u)), 'no STEP-count warning: the count is the one asked for');
    assert.equal(m.feedbackApplied.length, 2, 'each feedback says how it was applied');
    // Without the feedback the printed steps decide again.
    for (const x of (await s.call('GET', `/api/materials/${m.id}/learning`)).data.analysis.items) await s.call('DELETE', '/api/rules/' + x.id);
    assert.ok(easy.id);
    const plain = (await s.call('POST', `/api/materials/${m.id}/analyze`, {})).data;
    await s.waitJob(plain.jobId);
    m = (await s.call('GET', '/api/materials/' + m.id)).data;
    assert.equal(m.steps.length, 3);
    assert.equal(m.teacherStepCount, 0);
  } finally { await s.close(); }
});

test('LLM tab data: calls, tokens and cost per model from the ledger, today and over 30 days', async () => {
  const s = await start();
  try {
    await s.call('POST', '/api/login', { username: 'admin', password: 'test-pass-1' });
    const a = (await s.call('POST', '/api/materials', { title: 'A', problemImage: image, solutionImage: image })).data;
    await s.waitJob(a.jobId);
    const { status, data } = await s.call('GET', '/api/llm');
    assert.equal(status, 200);
    assert.ok(data.usage.deepseek.today.calls >= 6, 'the analysis calls are counted');
    assert.equal(data.usage.deepseek.today.calls, data.usage.deepseek.days30.calls);
    assert.equal(data.usage.gemma.today.calls, 0);
    assert.equal(typeof data.claude.loggedIn, 'boolean');
    assert.ok(data.usage.deepseek.lastAt);
  } finally { await s.close(); }
});

test('기본 모델: chosen on the LLM tab, it is what requests without a model use; a malformed DeepSeek key is refused', async () => {
  const s = await start();
  try {
    await s.call('POST', '/api/login', { username: 'admin', password: 'test-pass-1' });
    assert.equal((await s.call('GET', '/api/status')).data.defaultProvider, 'deepseek');
    assert.equal((await s.call('PUT', '/api/llm/default', { provider: 'nope' })).status, 400);
    assert.equal((await s.call('PUT', '/api/llm/default', { provider: 'gemma' })).data.defaultProvider, 'gemma');
    assert.equal((await s.call('GET', '/api/status')).data.defaultProvider, 'gemma');
    const a = (await s.call('POST', '/api/materials', { title: 'A', problemImage: image })).data;
    const job = await s.waitJob(a.jobId);
    assert.equal(job.options.provider, 'gemma', 'no model named → the 기본 모델');
    const named = (await s.call('POST', '/api/materials', { title: 'B', problemImage: image, provider: 'deepseek' })).data;
    assert.equal((await s.waitJob(named.jobId)).options.provider, 'deepseek', 'a named model still wins');
    assert.equal((await s.call('PUT', '/api/llm/deepseek-key', { key: 'not-a-key' })).status, 400);
    assert.match((await s.call('GET', '/api/llm')).data.deepseek.key, /^$|^…/, 'only the last characters are ever shown');
  } finally { await s.close(); }
});

test('Claude model and effort on the LLM tab: saved, validated, and shown by name', async () => {
  const s = await start();
  try {
    await s.call('POST', '/api/login', { username: 'admin', password: 'test-pass-1' });
    assert.equal((await s.call('PUT', '/api/llm/claude', { model: 'gpt-9', effort: 'low' })).status, 400);
    assert.equal((await s.call('PUT', '/api/llm/claude', { model: 'claude-opus-5-5', effort: 'turbo' })).status, 400);
    const r = (await s.call('PUT', '/api/llm/claude', { model: 'claude-sonnet-5-5', effort: 'medium' })).data;
    assert.equal(r.label, 'Claude Sonnet 5.5 (구독)');
    const llm = (await s.call('GET', '/api/llm')).data;
    assert.equal(llm.claude.model, 'claude-sonnet-5-5');
    assert.equal(llm.claude.effort, 'medium');
    assert.ok(llm.claude.models['claude-opus-5-5']);
    await s.call('PUT', '/api/llm/default', { provider: 'deepseek' });
    assert.equal((await s.call('GET', '/api/llm')).data.claude.model, 'claude-sonnet-5-5', 'changing the 기본 모델 keeps the Claude choice');
  } finally { await s.close(); }
});

test('variant review: 채택 is saved and listed; a tag pressed on two variants is one feedback; a regenerated variant is reviewed afresh', async () => {
  const s = await start();
  try {
    await s.call('POST', '/api/login', { username: 'admin', password: 'test-pass-1' });
    const a = (await s.call('POST', '/api/materials', { title: 'A', problemImage: image, solutionImage: image })).data;
    await s.waitJob(a.jobId);
    const job = await s.waitJob((await s.call('POST', '/api/generations', { materialId: a.material.id, mode: 'integrated' })).data.jobId);
    assert.equal((await s.call('PUT', `/api/jobs/${job.id}/items/0/review`, { adopted: true })).data.adopted, true);
    const listed = (await s.call('GET', `/api/materials/${a.material.id}`)).data.jobs.find((j) => j.id === job.id);
    assert.equal(listed.items[0].adopted, true);
    assert.ok(listed.items[0].preview, 'the variant list shows the question');
    const text = '풀이에 쓰이지 않는 조건이나 서술을 넣지 않는다.';
    const r1 = (await s.call('POST', '/api/rules', { text, target: 'problem', source: { jobId: job.id, itemIndex: 0 } })).data;
    const r2 = (await s.call('POST', '/api/rules', { text, target: 'problem', source: { jobId: job.id, itemIndex: 1 } })).data;
    assert.equal(r1.id, r2.id, 'the same tag twice is one feedback');
    const regen = (await s.call('POST', `/api/jobs/${job.id}/items/0/regenerate`, { feedback: text })).data;
    await s.waitJob(regen.jobId);
    assert.equal((await s.call('GET', '/api/jobs/' + job.id)).data.items[0].adopted, false);
  } finally { await s.close(); }
});

test('learning: an adopted variant is shown as an example to the next set of the same stage, and a regenerated variant gets feedback added after its set was made', async () => {
  const s = await start();
  try {
    await s.call('POST', '/api/login', { username: 'admin', password: 'test-pass-1' });
    const a = (await s.call('POST', '/api/materials', { title: 'A', problemImage: image, solutionImage: image })).data;
    await s.waitJob(a.jobId);
    const set1 = await s.waitJob((await s.call('POST', '/api/generations', { materialId: a.material.id, mode: 'integrated' })).data.jobId);
    assert.equal(set1.items[0].examplesUsed, 0, 'nothing adopted yet');
    await s.call('PUT', `/api/jobs/${set1.id}/items/0/review`, { adopted: true });
    const set2 = await s.waitJob((await s.call('POST', '/api/generations', { materialId: a.material.id, mode: 'integrated' })).data.jobId);
    assert.equal(set2.items[0].examplesUsed, 1, 'STEP 1 practice of the next set sees the adopted STEP 1 practice');
    assert.equal(set2.items[2].examplesUsed, 0, 'a different stage does not');
    const late = (await s.call('POST', '/api/rules', { text: '세트를 만든 뒤에 남긴 피드백', target: 'problem', source: { jobId: set2.id, itemIndex: 1 } })).data;
    const regen = (await s.call('POST', `/api/jobs/${set2.id}/items/1/regenerate`, { feedback: '' })).data;
    await s.waitJob(regen.jobId);
    const after = (await s.call('GET', '/api/jobs/' + set2.id)).data;
    assert.ok(after.items[1].verification.rules.some((r) => r.id === late.id), 'the regenerated variant was checked against the new feedback');
  } finally { await s.close(); }
});

test('학습 현황: per set (made, passed, adopted, feedback then, kept/broken) and per feedback (checked on how many variants, kept or broken)', async () => {
  const s = await start();
  try {
    await s.call('POST', '/api/login', { username: 'admin', password: 'test-pass-1' });
    const a = (await s.call('POST', '/api/materials', { title: 'A', problemImage: image, solutionImage: image })).data;
    await s.waitJob(a.jobId);
    const set1 = await s.waitJob((await s.call('POST', '/api/generations', { materialId: a.material.id, mode: 'integrated' })).data.jobId);
    const fb = (await s.call('POST', '/api/rules', { text: '표에 남는 물질을 적지 않는다', target: 'problem', source: { materialId: a.material.id } })).data;
    await s.call('PUT', `/api/jobs/${set1.id}/items/0/review`, { adopted: true });
    await s.waitJob((await s.call('POST', '/api/generations', { materialId: a.material.id, mode: 'integrated' })).data.jobId);
    const d = (await s.call('GET', `/api/materials/${a.material.id}/learning`)).data;
    assert.equal(d.sets.length, 2);
    assert.equal(d.sets[0].feedbackBefore, 0);
    assert.equal(d.sets[1].feedbackBefore, 1, 'the second set was made with the feedback');
    assert.equal(d.sets[0].adopted, 1);
    assert.equal(d.sets[1].examples, 1, 'and with the adopted example');
    assert.equal(d.adopted, 1);
    const row = d.feedback.find((f) => f.id === fb.id);
    assert.equal(row.used, 3, 'checked on the three variants of the second set');
    assert.equal(row.kept + row.broken <= row.used, true);
  } finally { await s.close(); }
});
