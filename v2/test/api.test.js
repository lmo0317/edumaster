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
  return { app, call, waitJob, close: () => new Promise((r) => app.server.close(r)), dataDir };
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
    assert.equal(analyze.usage.calls, 2);

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
