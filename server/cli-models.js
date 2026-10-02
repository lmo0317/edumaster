'use strict';
// Gemini through the Antigravity CLI (`agy`) and GPT through the Codex CLI (`codex`) on this server, on the
// subscriptions the teacher signs in to from the LLM tab — the same way Claude runs through `claude -p`. Nothing is
// billed per call; each subscription's own limits apply. Every call runs the CLI once, non-interactively:
//  - agy: the request (system prompt + user text) goes to a file in a temporary folder with the images beside it, and
//    agy is told to read it (its print mode takes the prompt only as an argument, which Linux caps at 128 KB);
//  - codex: the request goes in on stdin and the images are attached with -i.
// The answer and token counts come from each CLI's JSON output.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const CLIS = ['agy-cli', 'codex-cli'];
const NAME = { 'agy-cli': 'Gemini', 'codex-cli': 'GPT' };
const KEY = { 'agy-cli': 'agy', 'codex-cli': 'codex' };
const CODEX_EFFORTS = ['low', 'medium', 'high', 'xhigh'];

function settingsOf(dataDir, cli) {
  try { return (JSON.parse(fs.readFileSync(path.join(dataDir, 'llm-settings.json'), 'utf8')) || {})[KEY[cli]] || {}; } catch { return {}; }
}
const codexHome = () => process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
// agy keeps its sign-in in the system keyring; the LLM tab's login writes this file once it has seen agy work.
const agyMarker = (config) => path.join(config.dataDir || '.', 'agy-connected.json');

/** Signed in, as far as can be told without a call. */
function cliReady(config, cli) {
  const c = config[cli === 'agy-cli' ? 'agyCli' : 'codexCli'];
  if (!c || c.off || !fs.existsSync(c.bin)) return false;
  return cli === 'agy-cli' ? fs.existsSync(agyMarker(config)) : fs.existsSync(path.join(codexHome(), 'auth.json'));
}

// The models each CLI offers, read from the CLI itself and kept for an hour (data/cli-models.json).
const modelsFile = (config) => path.join(config.dataDir || '.', 'cli-models.json');
function cachedModels(config) {
  try { return JSON.parse(fs.readFileSync(modelsFile(config), 'utf8')); } catch { return {}; }
}
// bin is { bin, binArgs } from the config (binArgs lets the tests run a fake CLI through node).
function run(c, args, { cwd, input, timeoutMs = 60000, signal, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(c.bin, [...(c.binArgs || []), ...args], { cwd, env: { ...process.env, ...env } });
    let out = ''; let err = '';
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(Object.assign(new Error('응답 시간이 초과되었습니다.'), { status: 504 })); }, timeoutMs);
    const abort = () => child.kill('SIGTERM');
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(Object.assign(new Error(`실행하지 못했습니다: ${e.message}`), { status: 503 })); });
    child.on('close', (code) => { clearTimeout(timer); signal?.removeEventListener('abort', abort); resolve({ code, stdout: out, stderr: err }); });
    child.stdin.end(input || '');
  });
}
async function refreshModels(config, cli) {
  const all = cachedModels(config);
  if (cli === 'agy-cli') {
    const { code, stdout } = await run(config.agyCli, ['models'], { cwd: os.tmpdir() });
    const list = stdout.split('\n').map((l) => l.split('\t')).filter(([id, label]) => code === 0 && /^gemini-/.test(id || '') && label).map(([id, label]) => ({ id: id.trim(), label: label.trim() }));
    if (list.length) all[cli] = { at: new Date().toISOString(), list };
  } else {
    const { code, stdout } = await run(config.codexCli, ['debug', 'models'], { cwd: os.tmpdir() });
    let models = [];
    try { models = JSON.parse(stdout).models || []; } catch { /* not JSON */ }
    const list = models.filter((m) => code === 0 && m.visibility === 'list' && m.slug).map((m) => ({
      id: m.slug, label: m.display_name || m.slug,
      efforts: (m.supported_reasoning_levels || []).map((x) => x.effort).filter((e) => CODEX_EFFORTS.includes(e)),
    }));
    if (list.length) all[cli] = { at: new Date().toISOString(), list };
  }
  try { fs.writeFileSync(modelsFile(config), JSON.stringify(all)); } catch { /* display only */ }
  return all[cli]?.list || [];
}
/** The models for the LLM tab; read again in the background when older than an hour. */
function cliModels(config, cli) {
  const entry = cachedModels(config)[cli];
  if (cliReady(config, cli) && (!entry || Date.now() - new Date(entry.at).getTime() > 3600000)) refreshModels(config, cli).catch(() => {});
  return entry?.list || [];
}

/** The model (and for GPT the reasoning effort) the teacher picked on the LLM tab, else a sensible default. */
function cliChoice(config, cli) {
  const s = config.dataDir ? settingsOf(config.dataDir, cli) : {};
  const list = cachedModels(config)[cli]?.list || [];
  if (cli === 'agy-cli') {
    const model = list.some((m) => m.id === s.model) ? s.model : (list.find((m) => m.id === 'gemini-3.1-pro-high') || list[0])?.id || 'gemini-3.1-pro-high';
    const label = list.find((m) => m.id === model)?.label || model;
    return { model, label: `${label} (구독)` };
  }
  const model = list.some((m) => m.id === s.model) ? s.model : '';
  const effort = CODEX_EFFORTS.includes(s.effort) ? s.effort : 'high';
  const label = model ? list.find((m) => m.id === model)?.label || model : 'GPT · Codex 기본 모델';
  return { model, effort, label: `${label} (구독)` };
}

// One request in the folder: the images as files, the text with [이미지: 파일] where each stood.
function writeRequest(dir, messages) {
  const user = messages[1].content;
  const texts = [];
  const images = [];
  (typeof user === 'string' ? [{ type: 'text', text: user }] : user).forEach((part, i) => {
    if (part.type === 'text') { texts.push(part.text); return; }
    const m = /^data:image\/(\w+);base64,(.*)$/s.exec(part.image_url.url);
    const name = `image${i}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`;
    fs.writeFileSync(path.join(dir, name), Buffer.from(m[2], 'base64'));
    images.push(name);
    texts.push(`[이미지: ${name}]`);
  });
  for (const turn of messages.slice(2)) texts.push(`[${turn.role === 'assistant' ? '너의 이전 응답' : '추가 요청'}]\n${turn.content}`);
  return { text: texts.join('\n'), images };
}

// agy's settings (shared by every agy run on this account): its answer may be written in the request folders, nothing
// else, and no command may run; the /usage reader's folder is trusted. Other keys in the file are kept.
function ensureAgySettings(config) {
  const c = config.agyCli;
  if (!c?.settings || !c.workRoot) return;
  let s = {};
  try { s = JSON.parse(fs.readFileSync(c.settings, 'utf8')) || {}; } catch { /* none yet */ }
  const before = JSON.stringify(s);
  const write = `write_file(${c.workRoot}/)`;
  const quotaDir = path.dirname(c.workRoot);
  s.trustedWorkspaces = [...new Set([...(s.trustedWorkspaces || []).filter((w) => w !== '/tmp'), quotaDir])];
  s.permissions = s.permissions || {};
  s.permissions.allow = [...new Set([...(s.permissions.allow || []), write])];
  s.permissions.deny = [...new Set([...(s.permissions.deny || []), 'command(*)'])];
  if (JSON.stringify(s) === before) return;
  fs.mkdirSync(path.dirname(c.settings), { recursive: true });
  fs.writeFileSync(c.settings, JSON.stringify(s, null, 2));
}

async function sendCli(config, cli, { messages, effort, signal }) {
  // agy works in a folder of its own under workRoot (where it may write its answer); codex in a temporary one.
  if (cli === 'agy-cli') { fs.mkdirSync(config.agyCli.workRoot, { recursive: true }); ensureAgySettings(config); }
  const dir = fs.mkdtempSync(cli === 'agy-cli' ? path.join(config.agyCli.workRoot, 'em-') : path.join(os.tmpdir(), `em-${KEY[cli]}-`));
  const fail = (msg, status = 502) => Object.assign(new Error(`${NAME[cli]}(구독) ${msg}`), { status });
  try {
    const { text, images } = writeRequest(dir, messages);
    const choice = cliChoice(config, cli);
    if (cli === 'agy-cli') {
      const request = `[시스템 지시]\n${messages[0].content}\n\n[요청]\n${images.length ? '[이미지: 파일]이 있는 자리마다 이 폴더의 그 이미지 파일을 열어 자세히 본 뒤 답한다.\n\n' : ''}${text}`;
      fs.writeFileSync(path.join(dir, 'request.md'), request);
      // A printed answer is cut at agy's output limit (a problem design with its solution and checks did not fit,
      // 2026-10-02), so the answer is written to answer.txt; the printed one is kept only if that file is missing.
      const ask = '같은 폴더의 request.md 파일을 처음부터 끝까지 모두 읽고, 그 안의 [시스템 지시]와 [요청]을 그대로 따라 답한다. 답 전체를 이 폴더의 answer.txt 파일에 파일 쓰기 도구로 그대로 쓴다. 다른 파일은 고치거나 만들지 않고, 명령은 실행하지 않는다. 화면에는 완료라고만 출력한다.';
      const { code, stdout, stderr } = await run(config.agyCli, ['-p', ask, '--output-format', 'json', '--model', choice.model, '--sandbox'],
        { cwd: dir, timeoutMs: config.agyCli.timeoutMs, signal });
      if (signal?.aborted) throw new Error('작업이 취소되었습니다.');
      let result;
      try { result = JSON.parse(stdout.trim().split('\n').filter((l) => l.startsWith('{')).pop() || ''); } catch { result = null; }
      const written = fs.existsSync(path.join(dir, 'answer.txt')) ? fs.readFileSync(path.join(dir, 'answer.txt'), 'utf8').trim() : '';
      if (!result && !written) throw fail(`실행 오류 (종료 코드 ${code}): ${(stderr || stdout).trim().slice(0, 300)}`);
      if (result?.status !== 'SUCCESS' && !written) throw fail(`오류: ${String(result?.error || result?.response || result?.status).slice(0, 300)}`);
      const last = agyLimits(config);
      if (!last || Date.now() - new Date(last.at).getTime() > 120000) refreshAgyLimits(config).catch(() => {});
      const u = result?.usage || {};
      const input = (u.input_tokens || 0) + (u.cache_read_tokens || 0);
      const output = (u.output_tokens || 0);
      return {
        choices: [{ finish_reason: 'stop', message: { content: written || String(result.response || '') } }],
        usage: { prompt_tokens: input, prompt_cache_hit_tokens: u.cache_read_tokens || 0, completion_tokens: output, completion_tokens_details: { reasoning_tokens: u.thinking_tokens || 0 }, total_tokens: input + output },
      };
    }
    const level = choice.effort || (effort === 'high' ? 'high' : 'medium');
    const args = ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'read-only', '--ephemeral', '-C', dir,
      ...(choice.model ? ['-m', choice.model] : []), '-c', `model_reasoning_effort="${level}"`,
      ...images.flatMap((f) => ['-i', path.join(dir, f)]), '-'];
    const request = `${messages[0].content}\n\n---\n\n${images.length ? '첨부한 이미지는 [이미지: 파일] 자리에 순서대로 놓인 것이다.\n\n' : ''}${text}\n\n도구나 명령을 쓰지 않고 답만 출력한다.`;
    const { code, stdout, stderr } = await run(config.codexCli, args, { cwd: dir, input: request, timeoutMs: config.codexCli.timeoutMs, signal });
    if (signal?.aborted) throw new Error('작업이 취소되었습니다.');
    const events = stdout.split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const failed = events.find((e) => e.type === 'turn.failed' || e.type === 'error');
    const answer = events.filter((e) => e.type === 'item.completed' && e.item?.type === 'agent_message').pop()?.item?.text;
    if (!answer) throw fail(failed ? `오류: ${String(failed.error?.message || failed.message || '').slice(0, 300)}` : `실행 오류 (종료 코드 ${code}): ${(stderr || stdout).trim().slice(-300)}`);
    const u = events.filter((e) => e.type === 'turn.completed').pop()?.usage || {};
    const input = u.input_tokens || 0;
    const output = (u.output_tokens || 0) + (u.reasoning_output_tokens || 0);
    return {
      choices: [{ finish_reason: 'stop', message: { content: answer } }],
      usage: { prompt_tokens: input, prompt_cache_hit_tokens: u.cached_input_tokens || 0, completion_tokens: output, completion_tokens_details: { reasoning_tokens: u.reasoning_output_tokens || 0 }, total_tokens: input + output },
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- Gemini's remaining limits
// agy shows them only on its interactive /usage screen; deploy/agy-quota.py reads it (about 5 seconds, no model call).
// Kept in data/agy-limits.json in the shape Claude's limits have: { at, fiveHour: { used, resetsAt }, sevenDay }.
const limitsFile = (config) => path.join(config.dataDir || '.', 'agy-limits.json');
function agyLimits(config) {
  try { return JSON.parse(fs.readFileSync(limitsFile(config), 'utf8')); } catch { return null; }
}
let limitsRun = null;
function refreshAgyLimits(config) {
  if (limitsRun) return limitsRun;
  const c = config.agyCli;
  if (!c?.python || !fs.existsSync(c.python) || !cliReady(config, 'agy-cli')) return Promise.resolve(agyLimits(config));
  try { ensureAgySettings(config); } catch { /* the reader reports what it sees */ }
  const script = c.quotaScript || path.join(config.root || path.join(__dirname, '..'), 'deploy', 'agy-quota.py');
  limitsRun = run({ bin: c.python }, [script], { cwd: os.tmpdir(), timeoutMs: 90000, env: { AGY_BIN: c.bin } }).then(({ stdout }) => {
    let r = null;
    try { r = JSON.parse(stdout.trim().split('\n').pop()); } catch { /* not JSON */ }
    if (!r?.ok) return agyLimits(config);
    const now = Date.now();
    const win = (w) => (w ? { used: Math.max(0, Math.min(1, 1 - w.left / 100)), resetsAt: w.resetsInMin ? new Date(now + w.resetsInMin * 60000).toISOString() : '' } : null);
    const data = { at: new Date(now).toISOString(), fiveHour: win(r.fiveHour), sevenDay: win(r.sevenDay) };
    try { fs.writeFileSync(limitsFile(config), JSON.stringify(data)); } catch { /* display only */ }
    return data;
  }).catch(() => agyLimits(config)).finally(() => { limitsRun = null; });
  return limitsRun;
}
/** The limits for the LLM tab; read again in the background when older than ten minutes. */
function agyLimitsFresh(config) {
  const l = agyLimits(config);
  if (!l || Date.now() - new Date(l.at).getTime() > 600000) refreshAgyLimits(config).catch(() => {});
  return l;
}

// ---------------------------------------------------------------- sign-in from the LLM tab
// One sign-in at a time per CLI, given up after 15 minutes. The codes the teacher types are never logged.
//  - codex: `codex login --device-auth` prints a link and a one-time code; the teacher enters the code on that page
//    and the CLI finishes by itself.
//  - agy: deploy/agy-login.py drives agy's first-run screen in a pseudo-terminal: it shows the Google link, takes
//    the code the teacher pastes back, then checks that agy works and writes data/agy-connected.json.
const logins = new Map();
function loginState(cli) {
  const s = logins.get(cli);
  return s ? { pending: !s.done, ...(s.done ? {} : { url: s.url, code: s.userCode || '' }), needsCode: cli === 'agy-cli', checking: Boolean(s.codeSent && !s.done), result: s.result } : { pending: false };
}
async function loginStart(config, cli, root) {
  const old = logins.get(cli);
  if (old && !old.done && old.url) return loginState(cli);
  const state = { url: '', userCode: '', done: false, result: null, codeSent: false };
  const child = cli === 'codex-cli'
    ? spawn(config.codexCli.bin, [...(config.codexCli.binArgs || []), 'login', '--device-auth'], { cwd: os.tmpdir() })
    : spawn('python3', [path.join(root, 'deploy', 'agy-login.py'), agyMarker(config)], { env: { ...process.env, AGY_BIN: config.agyCli.bin } });
  state.child = child;
  logins.set(cli, state);
  let buf = '';
  const strip = (t) => t.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
  child.stdout.on('data', (d) => {
    buf += d;
    if (cli === 'codex-cli') {
      const t = strip(buf);
      state.url = state.url || (/https:\/\/auth\.openai\.com\/\S+/.exec(t) || [''])[0];
      state.userCode = state.userCode || (/\b[A-Z0-9]{4}-[A-Z0-9]{4,6}\b/.exec(t) || [''])[0];
      return;
    }
    for (let i; (i = buf.indexOf('\n')) >= 0;) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      try { const msg = JSON.parse(line); if (msg.url) state.url = msg.url; if ('ok' in msg) state.result = { ...msg, at: new Date().toISOString() }; } catch { /* not a status line */ }
    }
  });
  child.stderr.on('data', (d) => { if (cli === 'codex-cli') buf += d; });
  child.on('close', (code) => {
    state.done = true;
    if (!state.result) state.result = cli === 'codex-cli' && code === 0 ? { ok: true, at: new Date().toISOString() } : { ok: false, error: '로그인이 끝나지 않았습니다. 다시 시작해 주세요.' };
    if (state.result.ok) refreshModels(config, cli).catch(() => {});
  });
  child.on('error', () => { state.done = true; state.result = { ok: false, error: '로그인 도구를 실행하지 못했습니다.' }; });
  setTimeout(() => { if (!state.done) child.kill('SIGTERM'); }, 15 * 60 * 1000).unref();
  for (let i = 0; i < 240 && !(state.url && (cli !== 'codex-cli' || state.userCode)) && !state.done; i++) await new Promise((r) => setTimeout(r, 250));
  if (!state.url) { child.kill('SIGTERM'); throw Object.assign(new Error(state.result?.error || '로그인 링크를 받지 못했습니다.'), { status: 502 }); }
  return loginState(cli);
}
function loginCode(cli, code) {
  const state = logins.get(cli);
  if (cli !== 'agy-cli') throw Object.assign(new Error('이 모델은 코드를 붙여 넣지 않습니다.'), { status: 400 });
  if (!state || state.done) throw Object.assign(new Error('진행 중인 로그인이 없습니다. 로그인을 다시 시작해 주세요.'), { status: 409 });
  if (!code || /\s/.test(code)) throw Object.assign(new Error('코드를 그대로 붙여 넣어 주세요.'), { status: 400 });
  if (state.codeSent) throw Object.assign(new Error('이미 코드를 확인하는 중입니다.'), { status: 409 });
  state.codeSent = true;
  state.child.stdin.write(code + '\n');
  return loginState(cli);
}
function loginCancel(cli) {
  const state = logins.get(cli);
  if (state && !state.done) state.child.kill('SIGTERM');
  logins.delete(cli);
}
/** Disconnect: codex signs out (its saved login is deleted); agy is no longer used by this server. */
async function logout(config, cli) {
  logins.delete(cli);
  if (cli === 'codex-cli') await run(config.codexCli, ['logout'], { cwd: os.tmpdir() }).catch(() => {});
  else fs.rmSync(agyMarker(config), { force: true });
}

module.exports = { ensureAgySettings, agyLimits, agyLimitsFresh, refreshAgyLimits, CLIS, NAME, CODEX_EFFORTS, cliReady, cliModels, cliChoice, refreshModels, sendCli, loginState, loginStart, loginCode, loginCancel, logout };
