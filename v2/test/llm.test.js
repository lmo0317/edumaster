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
