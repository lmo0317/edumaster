'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLlm, Budget } = require('../server/llm');
const { openStore } = require('../server/store');

test('relay provider writes the exact request (text and images in order) and reads the answer file', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'em2-relay-'));
  const store = openStore(fs.mkdtempSync(path.join(os.tmpdir(), 'em2-relay-data-')));
  const llm = createLlm({ config: { llmMode: 'deepseek', deepseek: {}, gemma: {}, relay: { dir, timeoutMs: 20000 } }, store, apiKey: '', mock: null });
  const png = 'data:image/png;base64,' + Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]).toString('base64');
  const answerer = setInterval(() => {
    const req = fs.readdirSync(dir).find((f) => f.endsWith('.request.json'));
    if (!req) return;
    clearInterval(answerer);
    const r = JSON.parse(fs.readFileSync(path.join(dir, req), 'utf8'));
    assert.equal(r.system, 'SYS');
    assert.deepEqual(r.content.map((c) => c.type), ['text', 'text', 'image']);
    assert.equal(r.content[1].text, '[문제 이미지]');
    assert.ok(fs.existsSync(r.content[2].file));
    fs.writeFileSync(r.responseFile, JSON.stringify({ content: '{"ok":true,"t":"$\\\\ce{A}$"}' }));
  }, 50);
  const { data } = await llm.json({ provider: 'relay', purpose: 'relay-test', jobId: 'j', budget: new Budget({ maxCalls: 2, maxTokens: 100 }), system: 'SYS', text: '본문', images: [{ label: '[문제 이미지]', dataUrl: png }] });
  assert.deepEqual(data, { ok: true, t: '$\\ce{A}$' });
  assert.equal(store.usage.all()[0].provider, 'relay');
});
