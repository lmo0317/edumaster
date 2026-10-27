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
