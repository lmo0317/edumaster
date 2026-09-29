'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLlm, Budget } = require('../server/llm');
const { openStore } = require('../server/store');

// A fake OpenAI-compatible server: /v1/models and a /chat/completions that answers after `delay` ms.
function fakeModel(delay) {
  const seen = [];
  const server = http.createServer((req, res) => {
    if (req.url.endsWith('/models')) { res.end(JSON.stringify({ data: [{ id: 'fake-gemma' }] })); return; }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push(JSON.parse(body));
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
      }, delay);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen, url: `http://127.0.0.1:${server.address().port}/v1` })));
}

function llmFor(url, overrides = {}) {
  const store = openStore(fs.mkdtempSync(path.join(os.tmpdir(), 'em2-llm-')));
  const config = {
    llmMode: 'deepseek',
    deepseek: { baseUrl: url, visionModel: 'v', textModel: 't', timeoutMs: 5000 },
    gemma: { endpoint: url, timeoutMs: 5000, maxOutputTokens: 1234 },
    ...overrides,
  };
  return { llm: createLlm({ config, store, apiKey: 'test-key', mock: null }), store };
}

test('DeepSeek and Gemma requests go out with the right settings and usage is recorded', async () => {
  const fake = await fakeModel(20);
  try {
    const { llm, store } = llmFor(fake.url);
    const budget = new Budget({ maxCalls: 5, maxTokens: 1000 });
    const a = await llm.json({ provider: 'deepseek', purpose: 'p', jobId: 'j', budget, system: 's', text: 't', effort: 'off' });
    assert.deepEqual(a.data, { ok: true });
    assert.equal(fake.seen[0].thinking.type, 'disabled');
    const b = await llm.json({ provider: 'gemma', purpose: 'p', jobId: 'j', budget, system: 's', text: 't', maxTokens: 64000 });
    assert.deepEqual(b.data, { ok: true });
    assert.equal(fake.seen[1].model, 'fake-gemma');
    assert.equal(fake.seen[1].max_tokens, 1234, 'Gemma output is capped to fit its context');
    assert.equal(fake.seen[1].chat_template_kwargs.enable_thinking, false);
    assert.equal(budget.calls, 2);
    assert.deepEqual(store.usage.all().map((r) => r.provider).sort(), ['deepseek', 'gemma']);
  } finally { fake.server.close(); }
});

test('slow responses are bounded by our own timeout, and cancelling stops the call', async () => {
  const fake = await fakeModel(1500);
  try {
    const { llm } = llmFor(fake.url, { deepseek: { baseUrl: fake.url, visionModel: 'v', textModel: 't', timeoutMs: 300 } });
    await assert.rejects(llm.json({ provider: 'deepseek', purpose: 'p', jobId: 'j', budget: new Budget({ maxCalls: 5, maxTokens: 1000 }), system: 's', text: 't' }), /시간이 초과/);
    const { llm: slow } = llmFor(fake.url);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    await assert.rejects(slow.json({ provider: 'gemma', purpose: 'p', jobId: 'j', budget: new Budget({ maxCalls: 5, maxTokens: 1000 }), system: 's', text: 't', signal: controller.signal }), /취소/);
  } finally { fake.server.closeAllConnections?.(); fake.server.close(); }
});

test('Gemma is reported unavailable when its endpoint is down', async () => {
  const { llm } = llmFor('http://127.0.0.1:9/v1');
  assert.equal((await llm.gemmaStatus(true)).available, false);
});

test('model JSON with single-backslash LaTeX is repaired instead of failing or corrupting text', () => {
  const { extractJson } = require('../server/llm');
  // String.raw: these are the exact characters a model sends.
  // invalid escape (\c) → repaired
  assert.deepEqual(extractJson(String.raw`{"title":"$\ce{A}$의 몰질량"}`), { title: String.raw`$\ce{A}$의 몰질량` });
  // valid-but-wrong escapes (\f, \t, \r, \b) → restored as LaTeX
  assert.equal(extractJson(String.raw`{"w":"$\frac{1}{2}\times 3 \rightarrow \beta$"}`).w, String.raw`$\frac{1}{2}\times 3 \rightarrow \beta$`);
  // properly doubled backslashes and real newlines are untouched
  assert.equal(extractJson(String.raw`{"w":"$\\frac{1}{2}$\n다음 줄"}`).w, String.raw`$\frac{1}{2}$` + '\n다음 줄');
});

test('unreadable JSON: repaired locally when possible, otherwise the model is shown its answer and asked to fix it', async () => {
  const { extractJson } = require('../server/llm');
  // Unescaped quotes inside a string (a common DeepSeek slip) are repaired without another call.
  assert.deepEqual(extractJson('{"title":"그는 "몰질량"을 구한다","n":1,}'), { title: '그는 "몰질량"을 구한다', n: 1 });

  let calls = 0; const seen = [];
  const server = require('node:http').createServer((req, res) => {
    let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => {
      calls++; seen.push(JSON.parse(body).messages);
      const content = calls === 1 ? '이건 JSON이 아닙니다 {{{' : '{"ok":true}';
      res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const url = `http://127.0.0.1:${server.address().port}`;
    const { llm, store } = llmFor(url);
    const { data } = await llm.json({ provider: 'deepseek', purpose: 'p', jobId: 'j', budget: new Budget({ maxCalls: 5, maxTokens: 1000 }), system: 's', text: 't', effort: 'off' });
    assert.deepEqual(data, { ok: true });
    assert.equal(seen[1].length, 4, 'second call carries the broken answer and a fix request');
    assert.equal(seen[1][2].role, 'assistant');
    assert.match(seen[1][3].content, /올바른 JSON/);
    assert.equal(fs.readdirSync(path.join(store.dataDir, 'llm-failures')).length, 1, 'the broken answer is kept for diagnosis');
  } finally { server.close(); }
});

test('real DeepSeek bio analysis #1 (2026-09-29): same unclosed problem object, recovered in one call', async () => {
  const broken = fs.readFileSync(path.join(__dirname, 'fixtures', 'deepseek-bio-analysis-broken.txt'), 'utf8');
  let calls = 0;
  const server = require('node:http').createServer((req, res) => {
    let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => {
      calls++;
      res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: broken } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const { llm } = llmFor(`http://127.0.0.1:${server.address().port}`);
    const { data, shapeFixes } = await llm.json({ provider: 'deepseek', purpose: 'analyze', jobId: 'j', budget: new Budget({ maxCalls: 5, maxTokens: 1000 }), system: 's', text: 't', effort: 'off' });
    assert.equal(calls, 1);
    assert.equal(data.steps.length, 3);
    assert.ok(shapeFixes.includes('problem.steps'));
  } finally { server.close(); }
});

test('an answer that really lacks a required field is retried with the error, not accepted', async () => {
  let calls = 0; const seen = [];
  const server = require('node:http').createServer((req, res) => {
    let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => {
      calls++; seen.push(JSON.parse(body).messages);
      const content = calls === 1 ? JSON.stringify({ problem: { text: '문제 본문입니다' } }) : JSON.stringify({ problem: { text: '문제 본문입니다' }, steps: [{ title: 's1', work: 'w' }] });
      res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const { llm } = llmFor(`http://127.0.0.1:${server.address().port}`);
    const { data } = await llm.json({ provider: 'deepseek', purpose: 'analyze', jobId: 'j', budget: new Budget({ maxCalls: 5, maxTokens: 1000 }), system: 's', text: 't', effort: 'off' });
    assert.equal(calls, 2);
    assert.equal(data.steps.length, 1);
    assert.match(seen[1][3].content, /필요한 항목이 없습니다: steps/);
  } finally { server.close(); }
});

test('a forgotten closing brace (real DeepSeek bio analysis #2, 2026-09-29) is put back in shape, not failed', () => {
  const { extractJson, fixShape, SHAPES } = require('../server/llm');
  const broken = fs.readFileSync(path.join(__dirname, 'fixtures', 'deepseek-bio-analysis-broken-2.txt'), 'utf8');
  // What happened: `problem` was never closed, so steps, verification, ... all ended up inside it.
  const parsed = extractJson(broken);
  assert.ok(!parsed.steps && parsed.problem.steps);
  const { data, moved } = fixShape(parsed, SHAPES.analyze);
  assert.ok(data.steps.length >= 3, 'steps are back at the top level');
  assert.ok(data.verification.program.length, 'the source verification program is kept');
  assert.deepEqual(Object.keys(data.problem).sort(), ['answer', 'choices', 'figure', 'text'], 'problem keeps only its own fields');
  assert.ok(moved.includes('problem.steps') && moved.includes('problem.verification'));
  // A well-formed answer is left alone, including solution.steps inside a generated problem.
  const ok = { problem: { text: 't', answer: 1 }, solution: { steps: [{ step: 1 }], summary: 's' }, verification: { program: ['a=1'], answer: 'a' } };
  assert.deepEqual(fixShape(JSON.parse(JSON.stringify(ok)), SHAPES.generate), { data: ok, moved: [] });
});
