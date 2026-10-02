'use strict';
// Gemini (agy) and GPT (Codex) through their CLIs, with fake CLIs that answer the way the real ones do (2026-10-02):
// agy prints one JSON object (status, response, usage); codex prints JSON events (item.completed, turn.completed).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cli = require('../server/cli-models');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'em-cli-'));
const fakeAgy = path.join(dir, 'fake-agy.js');
fs.writeFileSync(fakeAgy, `
const fs = require('fs');
const args = process.argv.slice(2);
if (args[0] === 'models') { console.log('gemini-3.1-pro-high\\tGemini 3.1 Pro (High)\\nclaude-x\\tNot Gemini'); process.exit(0); }
const request = fs.readFileSync('request.md', 'utf8');
const answer = { system: request.includes('[시스템 지시]\\nJSON만'), sawImage: fs.existsSync('image1.png') && request.includes('[이미지: image1.png]'), model: args[args.indexOf('--model') + 1], sandbox: args.includes('--sandbox') };
// Like agy with a long answer: written to answer.txt, a short line printed.
fs.writeFileSync('answer.txt', '\\u0060\\u0060\\u0060json\\n' + JSON.stringify(answer) + '\\n\\u0060\\u0060\\u0060');
console.log(JSON.stringify({ status: 'SUCCESS', response: '완료', usage: { input_tokens: 100, output_tokens: 20, thinking_tokens: 15, cache_read_tokens: 50 } }));
`);
const fakeCodex = path.join(dir, 'fake-codex.js');
fs.writeFileSync(fakeCodex, `
const args = process.argv.slice(2);
if (args[0] === 'debug') { console.log(JSON.stringify({ models: [{ slug: 'gpt-x', display_name: 'GPT-X', visibility: 'list', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }, { effort: 'ultra' }] }, { slug: 'hidden', visibility: 'hide' }] })); process.exit(0); }
let input = '';
process.stdin.on('data', (d) => { input += d; }).on('end', () => {
  const answer = { stdin: input.startsWith('JSON만'), images: args.filter((a) => a === '-i').length, effort: args[args.indexOf('-c') + 1], model: args.includes('-m') ? args[args.indexOf('-m') + 1] : '' };
  console.log(JSON.stringify({ type: 'thread.started' }));
  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(answer) } }));
  console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 300, cached_input_tokens: 100, output_tokens: 10, reasoning_output_tokens: 5 } }));
});
`);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'em-cli-data-'));
const config = { dataDir, agyCli: { bin: process.execPath, binArgs: [fakeAgy], timeoutMs: 30000, workRoot: path.join(dataDir, 'agy-requests'), settings: path.join(dataDir, 'agy-settings.json') }, codexCli: { bin: process.execPath, binArgs: [fakeCodex], timeoutMs: 30000 } };
const png = 'data:image/png;base64,' + Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64');
const messages = [{ role: 'system', content: 'JSON만 출력한다.' }, { role: 'user', content: [{ type: 'text', text: '문제 사진' }, { type: 'image_url', image_url: { url: png } }] }];

test('signed in: agy once the LLM tab has seen it work, codex once it has saved its login', () => {
  process.env.CODEX_HOME = path.join(dataDir, 'codex');
  assert.equal(cli.cliReady(config, 'agy-cli'), false);
  assert.equal(cli.cliReady(config, 'codex-cli'), false);
  fs.writeFileSync(path.join(dataDir, 'agy-connected.json'), '{}');
  fs.mkdirSync(process.env.CODEX_HOME, { recursive: true });
  fs.writeFileSync(path.join(process.env.CODEX_HOME, 'auth.json'), '{}');
  assert.equal(cli.cliReady(config, 'agy-cli'), true);
  assert.equal(cli.cliReady(config, 'codex-cli'), true);
});

test('models come from each CLI: Gemini models only from agy, listed models and known efforts from codex', async () => {
  assert.deepEqual(await cli.refreshModels(config, 'agy-cli'), [{ id: 'gemini-3.1-pro-high', label: 'Gemini 3.1 Pro (High)' }]);
  assert.deepEqual(await cli.refreshModels(config, 'codex-cli'), [{ id: 'gpt-x', label: 'GPT-X', efforts: ['low', 'high'] }]);
  assert.deepEqual(cli.cliChoice(config, 'agy-cli'), { model: 'gemini-3.1-pro-high', label: 'Gemini 3.1 Pro (High) (구독)' });
  assert.equal(cli.cliChoice(config, 'codex-cli').label, 'GPT · Codex 기본 모델 (구독)', 'no pick: the CLI\'s own default');
});

test('agy reads the request and the image from files and writes its answer to one; tokens come from its JSON', async () => {
  const r = await cli.sendCli(config, 'agy-cli', { messages, effort: 'low' });
  assert.deepEqual(JSON.parse(r.choices[0].message.content.replace(/```json|```/g, '')), { system: true, sawImage: true, model: 'gemini-3.1-pro-high', sandbox: true });
  // agy may write in the request folders and nothing else, and may run no command; the rules are added once.
  const permissions = () => JSON.parse(fs.readFileSync(config.agyCli.settings, 'utf8')).permissions;
  assert.deepEqual(permissions(), { allow: [`write_file(${config.agyCli.workRoot}/)`], deny: ['command(*)'] });
  await cli.sendCli(config, 'agy-cli', { messages, effort: 'low' });
  assert.equal(permissions().allow.length, 1);
  assert.deepEqual(fs.readdirSync(config.agyCli.workRoot), [], 'each request folder is removed');
  assert.deepEqual(r.usage, { prompt_tokens: 150, prompt_cache_hit_tokens: 50, completion_tokens: 20, completion_tokens_details: { reasoning_tokens: 15 }, total_tokens: 170 });
});

test('codex gets the request on stdin and the image attached, with the picked model and effort', async () => {
  fs.writeFileSync(path.join(dataDir, 'llm-settings.json'), JSON.stringify({ codex: { model: 'gpt-x', effort: 'low' } }));
  const r = await cli.sendCli(config, 'codex-cli', { messages, effort: 'high' });
  assert.deepEqual(JSON.parse(r.choices[0].message.content), { stdin: true, images: 1, effort: 'model_reasoning_effort="low"', model: 'gpt-x' });
  assert.equal(r.usage.total_tokens, 315);
  assert.equal(cli.cliChoice(config, 'codex-cli').label, 'GPT-X (구독)');
});

test('Gemini\'s remaining limits come from agy\'s /usage screen, kept like Claude\'s (used share and reset time)', async () => {
  const fake = path.join(dir, 'fake-quota.js');
  fs.writeFileSync(fake, 'console.log(JSON.stringify({ ok: true, fiveHour: { left: 93.29, resetsInMin: 152 }, sevenDay: { left: 38.38, resetsInMin: 1275 } }));');
  const before = Date.now();
  const limits = await cli.refreshAgyLimits({ ...config, agyCli: { ...config.agyCli, python: process.execPath, quotaScript: fake } });
  assert.ok(Math.abs(limits.fiveHour.used - 0.0671) < 1e-6 && Math.abs(limits.sevenDay.used - 0.6162) < 1e-6);
  const resets = new Date(limits.fiveHour.resetsAt).getTime() - before;
  assert.ok(resets >= 152 * 60000 - 1000 && resets <= 152 * 60000 + 5000);
  assert.deepEqual(cli.agyLimits(config), limits, 'kept for the LLM tab');
});
