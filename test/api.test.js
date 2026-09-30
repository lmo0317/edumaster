'use strict';
process.env.EDUMASTER_MOCK_DELAY_MS = '5';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../server');

const image = 'data:image/png;base64,' + Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(300, 7)]).toString('base64');

async function start() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'em2-'));
  fs.writeFileSync(path.join(dataDir, 'access-code.txt'), 'test-code\n');
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
    assert.equal((await s.call('POST', '/api/login', { code: 'wrong' })).status, 401);
    assert.equal((await s.call('POST', '/api/login', { code: 'test-code' })).status, 200);

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
    assert.deepEqual(job.items.map((i) => i.label), ['STEP 1 연습', 'STEP 1~2 누적 연습', '최종 쌍둥이 문제']);
    for (const item of job.items) {
      assert.ok(['passed', 'warning'].includes(item.status), `${item.label}: ${item.status} ${JSON.stringify(item.problems)}`);
      assert.equal(item.verification.code.status, 'pass');
      assert.equal(item.verification.blind.answer, item.problem.answer);
      assert.equal(item.verification.rules[0].id, rule.id);
      assert.ok(item.verification.rules[0].how);
    }
    assert.ok(job.items.some((i) => i.attempts.some((a) => a.kind === 'repair')), 'the deliberately wrong mock answer was repaired');
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
    assert.deepEqual(job2.rules.map((r) => r.id).sort(), [rule.id, fb.data.id].sort());
    assert.equal(job2.items[0].label, 'STEP 3 집중 연습 (앞 단계 결과 제공)');

    const usage = (await s.call('GET', '/api/usage')).data;
    assert.ok(usage.all.calls > 0);
  } finally { await s.close(); }
});

test('budget stops a job instead of overspending', async () => {
  const s = await start();
  try {
    s.app.config.budget.generateCalls = 2;
    await s.call('POST', '/api/login', { code: 'test-code' });
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
    await s.call('POST', '/api/login', { code: 'test-code' });
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
  fs.writeFileSync(path.join(dataDir, 'access-code.txt'), 'test-code\n');
  const app = createApp({ dataDir, llmMode: 'deepseek', gemma: { endpoint: 'http://127.0.0.1:9/v1', timeoutMs: 1000, maxOutputTokens: 100 } });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  try {
    const base = `http://127.0.0.1:${app.server.address().port}`;
    const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'test-code' }) });
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
    await s.call('POST', '/api/login', { code: 'test-code' });
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

test('system page data: prompts with version, the check catalog, RAG state, usage per model, eval reports', async () => {
  const s = await start();
  try {
    await s.call('POST', '/api/login', { code: 'test-code' });
    await s.call('POST', '/api/rules', { text: '불필요한 조건을 넣지 않는다.', kind: 'dont', target: 'problem' });
    const { status, data } = await s.call('GET', '/api/system');
    assert.equal(status, 200);
    assert.match(data.prompts.version, /^[0-9a-f]{10}$/);
    assert.equal(data.prompts.list.length, 13);
    assert.ok(data.prompts.list.every((p) => p.purpose), 'every prompt says what it does');
    assert.ok(data.checks.analysis.length >= 5 && data.checks.generation.length >= 8);
    assert.ok([...data.checks.analysis, ...data.checks.generation].every((c) => ['fix', 'repair', 'review', 'note'].includes(c.onFail)));
    assert.equal(data.rag.rules.approved, 1);
    assert.equal(data.rag.corrections.count, 0);
    assert.ok(Array.isArray(data.evals));
    const cmpList = (await s.call('GET', '/api/compare')).data;
    assert.ok(Array.isArray(cmpList));
    if (cmpList.length) { const one = (await s.call('GET', '/api/compare/' + cmpList[0].id)).data; assert.ok(one.original.problemImage.startsWith('data:image/') && one.models.length); }
    assert.equal((await s.call('GET', '/api/compare/nope')).status, 404);
    assert.deepEqual(data.cost.pricing.opus, { input: 4, output: 20 }, 'Opus 5.5 list price');
    if (data.cost.perProblem) assert.ok(data.cost.perProblem.opus > data.cost.perProblem.deepseek && data.cost.perProblemRange.deepseek[0] <= data.cost.perProblem.deepseek);
    assert.equal((await s.call('GET', '/api/system').then(() => fetch(s.app.server.address ? `http://127.0.0.1:${s.app.server.address().port}/api/system` : ''))).status, 401, 'login required');
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
  fs.writeFileSync(path.join(dataDir, 'access-code.txt'), 'test-code\n');
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
    await call('POST', '/api/login', { code: 'test-code' });
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
  fs.writeFileSync(path.join(dataDir, 'access-code.txt'), 'test-code\n');
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
    await call('POST', '/api/login', { code: 'test-code' });
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
    await s.call('POST', '/api/login', { code: 'test-code' });
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
    assert.equal(list.find((x) => x.id === a.material.id).feedbackCount, 2);
    assert.equal(list.find((x) => x.id === b.material.id).feedbackCount, 0);
    // Widened to every problem, it reaches B too.
    await s.call('PUT', '/api/rules/' + onPage.id, { scope: 'global' });
    const genB2 = await s.waitJob((await s.call('POST', '/api/generations', { materialId: b.material.id, mode: 'integrated' })).data.jobId);
    assert.ok(genB2.rules.some((r) => r.id === onPage.id));
  } finally { await s.close(); }
});
