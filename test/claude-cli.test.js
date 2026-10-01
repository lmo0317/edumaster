'use strict';
// The Claude Code CLI provider, run against a stand-in `claude` that records how it was called.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLlm, Budget } = require('../server/llm');
const { openStore } = require('../server/store');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'em-cli-'));
const fake = path.join(tmp, 'fake-claude.js');
const seen = path.join(tmp, 'seen.json');
fs.writeFileSync(fake, `
const fs = require('fs');
let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  const args = process.argv.slice(2);
  const images = input.split('[이미지: ').slice(1).map((x) => x.split(']')[0]).map((file) => ({ file, exists: fs.existsSync(file) }));
  fs.writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ args, input, images, cwd: process.cwd() }));
  if (process.env.FAKE_LIMIT) { process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'Claude AI usage limit reached' })); return; }
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '답: {"answer": 3, "answerValue": "3"}', usage: { input_tokens: 100, cache_read_input_tokens: 50, output_tokens: 40 } }));
});`);
const image = 'data:image/png;base64,' + Buffer.from('png-bytes').toString('base64');
const llmFor = () => createLlm({ config: { claudeCli: { bin: process.execPath, binArgs: [fake], model: 'claude-opus-5-5', timeoutMs: 20000 }, deepseek: {}, gemma: {} }, store: openStore(fs.mkdtempSync(path.join(tmp, 'store-'))), apiKey: '', claudeKey: '', mock: null });

test('claude-cli: system prompt and model passed, images opened with Read only, answer and tokens read from the JSON result', async () => {
  const llm = llmFor();
  const r = await llm.json({ provider: 'claude-cli', purpose: 'solve', jobId: 'j', budget: new Budget({ maxCalls: 5, maxTokens: 1e6 }), effort: 'low', system: '시스템 지시', text: '', images: [{ label: '[원본 문제]', dataUrl: image }], vision: true });
  assert.equal(r.data.answer, 3);
  assert.deepEqual(r.usage, { input: 150, output: 40, reasoning: 0, cached: 50, total: 190 });
  const s = JSON.parse(fs.readFileSync(seen, 'utf8'));
  assert.ok(s.args.includes('-p') && s.args.includes('--no-session-persistence'));
  assert.equal(s.args[s.args.indexOf('--model') + 1], 'claude-opus-5-5');
  assert.equal(s.args[s.args.indexOf('--system-prompt') + 1], '시스템 지시');
  assert.equal(s.args[s.args.indexOf('--tools') + 1], 'Read');
  assert.match(s.input, /\[원본 문제\]\n\[이미지: /, 'the image stands where it was in the message, after its label');
  const files = s.images.filter((i) => i.file !== '경로'); // the instruction line itself mentions "[이미지: 경로]"
  assert.ok(files.length === 1 && files[0].exists, 'the image file exists while the CLI runs');
  assert.ok(!fs.existsSync(s.cwd), 'the temporary folder is removed afterwards');
});

test('claude-cli: a text-only call gets no tools; a usage limit comes back as a clear error', async () => {
  const llm = llmFor();
  await llm.json({ provider: 'claude-cli', purpose: 'solve', jobId: 'j', budget: new Budget({ maxCalls: 5, maxTokens: 1e6 }), effort: 'low', system: 's', text: '문제' });
  const s = JSON.parse(fs.readFileSync(seen, 'utf8'));
  assert.equal(s.args[s.args.indexOf('--tools') + 1], '');
  process.env.FAKE_LIMIT = '1';
  try {
    await assert.rejects(() => llm.json({ provider: 'claude-cli', purpose: 'solve', jobId: 'j', budget: new Budget({ maxCalls: 5, maxTokens: 1e6 }), effort: 'low', system: 's', text: '문제' }), /usage limit reached/);
  } finally { delete process.env.FAKE_LIMIT; }
});
