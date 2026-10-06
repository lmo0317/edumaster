'use strict';
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { jsonrepair } = require('jsonrepair');
// DeepSeek chat client with a per-job budget and a usage ledger.
// Every paid call is recorded (tokens only — never prompts, images or keys).
const { newId } = require('./store');

class BudgetExceeded extends Error {
  constructor(message) { super(message); this.name = 'BudgetExceeded'; this.status = 429; }
}
class LlmFormatError extends Error {
  constructor(message) { super(message); this.name = 'LlmFormatError'; }
}

class Budget {
  constructor({ maxCalls, maxTokens }) {
    this.maxCalls = maxCalls; this.maxTokens = maxTokens;
    this.calls = 0; this.input = 0; this.output = 0; this.reasoning = 0; this.total = 0;
  }
  reserve() {
    if (this.calls >= this.maxCalls) throw new BudgetExceeded(`이 작업의 모델 호출 상한(${this.maxCalls}회)에 도달해 더 호출하지 않았습니다.`);
    if (this.total >= this.maxTokens) throw new BudgetExceeded(`이 작업의 토큰 상한(${this.maxTokens.toLocaleString()}토큰)에 도달해 더 호출하지 않았습니다.`);
    this.calls++;
  }
  add(usage) {
    this.input += usage.input; this.output += usage.output; this.reasoning += usage.reasoning; this.total += usage.total;
  }
  /** Whether `calls` more calls of the average size so far still fit under both caps. */
  affords(calls) {
    const avg = this.calls ? this.total / this.calls : 0;
    return this.calls + calls <= this.maxCalls && this.total + avg * calls <= this.maxTokens;
  }
  toJSON() {
    const { calls, input, output, reasoning, total, maxCalls, maxTokens } = this;
    return { calls, input, output, reasoning, total, maxCalls, maxTokens };
  }
}

function extractJson(text) {
  let body = String(text || '').trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)```$/i.exec(body);
  if (fence) body = fence[1].trim();
  const start = body.indexOf('{'); const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) throw new LlmFormatError('모델 응답에서 JSON을 찾지 못했습니다.');
  const json = body.slice(start, end + 1);
  try { return restoreLatex(JSON.parse(json)); } catch { /* try the LaTeX-escape repair below */ }
  // Models often forget to double LaTeX backslashes: "\ce{A}" is an invalid JSON escape. Double every
  // backslash that does not start a valid JSON escape, then parse again.
  const latexFixed = json.replace(/\\(?!["\\/bfnrtu])/g, '\\\\');
  try { return restoreLatex(JSON.parse(latexFixed)); } catch { /* try a general repair below */ }
  // Unescaped quotes inside strings, trailing commas, missing brackets: repair locally before asking again.
  try { return restoreLatex(JSON.parse(jsonrepair(latexFixed))); }
  catch (e) { throw new LlmFormatError('모델 응답 JSON을 읽지 못했습니다: ' + e.message); }
}

// "\frac", "\times", "\rightarrow", "\beta" written with a single backslash are *valid* JSON escapes
// (form feed, tab, carriage return, backspace) and silently corrupt the text. None of those control
// characters belong in our content, so turn them back into a LaTeX backslash.
function restoreLatex(value) {
  if (typeof value === 'string') {
    return value.replace(/\f/g, '\\f').replace(/\x08/g, '\\b').replace(/\r(?=[a-zA-Z])/g, '\\r').replace(/\t(?=[a-zA-Z])/g, '\\t');
  }
  if (Array.isArray(value)) return value.map(restoreLatex);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, restoreLatex(v)]));
  return value;
}

// Fields each kind of call must return; checked after JSON repair so silent data loss is retried instead.
const REQUIRED = {
  analyze: ['problem', 'steps'],
  generate: ['problem', 'solution', 'verification'],
  repair: ['problem', 'solution', 'verification'],
  solve: ['answer'],
  'review-solution': ['steps'],
  regroup: ['groups'],
  'reread-question': ['question'],
  'reread-problem': ['text'],
  'fix-verification': ['verification'],
  'write-solution': ['solution'],
  adjudicate: ['problemAtFault', 'reason'],
  learn: ['items'],
  // 'repair-lean' returns only what changed, so nothing in particular is required.
};

// The response schema of each call: which top-level keys exist and which keys belong inside each nested object.
// A model that forgets one closing brace (DeepSeek, 2026-09-29: `problem` never closed) nests every later
// top-level key inside the previous object; the JSON still parses (jsonrepair closes it at the end) but
// `steps`/`verification` sit under `problem`. Keys that belong at the top level are moved back there.
const PROBLEM_KEYS = ['text', 'choices', 'answer', 'figure'];
const VERIFICATION_KEYS = ['program', 'answer', 'choices', 'free', 'checks'];
const SHAPES = {
  analyze: {
    top: ['title', 'subject', 'topic', 'problem', 'annotations', 'solutionSource', 'steps', 'techniques', 'finalCheck', 'uncertainties', 'stepMarkers', 'verification'],
    nested: { problem: PROBLEM_KEYS, verification: VERIFICATION_KEYS },
  },
  generate: {
    top: ['problem', 'solution', 'usesSteps', 'designNote', 'appliedRules', 'verification'],
    nested: { problem: PROBLEM_KEYS, solution: ['steps', 'summary'], verification: VERIFICATION_KEYS },
  },
};
SHAPES.repair = SHAPES.generate;
SHAPES['repair-lean'] = SHAPES.generate;
SHAPES['write-solution'] = { top: ['solution'], nested: { solution: ['steps', 'summary'] } };

function fixShape(data, shape) {
  if (!shape || !data || typeof data !== 'object' || Array.isArray(data)) return { data, moved: [] };
  const moved = [];
  // Walk nested objects in order; a key lifted out of one object may itself carry more stray keys.
  for (let changed = true; changed;) {
    changed = false;
    for (const [name, own] of Object.entries(shape.nested)) {
      const child = data[name];
      if (!child || typeof child !== 'object' || Array.isArray(child)) continue;
      for (const key of Object.keys(child)) {
        if (own.includes(key) || !shape.top.includes(key) || key === name) continue;
        if (data[key] === undefined) { data[key] = child[key]; moved.push(`${name}.${key}`); changed = true; }
        delete child[key];
      }
    }
  }
  return { data, moved };
}

const cli = require('./cli-models');

/** Providers that cost nothing per call (the teacher's subscriptions, the PC model): their jobs have no token cap. */
const PER_CALL_FREE = new Set(['claude-cli', 'agy-cli', 'codex-cli', 'gemma']);

const PROVIDERS = {
  deepseek: { label: 'DeepSeek V4 Flash' },
  gemma: { label: 'PC 모델' },
  relay: { label: 'Claude Opus 5.5 (세션 중계)' },
  claude: { label: 'Claude Opus 5.5' },
  'claude-cli': { label: 'Claude Opus 5.5 (구독)' },
  'agy-cli': { label: 'Gemini (구독)' },
  'codex-cli': { label: 'GPT (구독)' },
};

/** The Claude Code CLI is installed and someone has logged in to it on this machine (the file holds the login). */
function claudeCliReady(config) {
  if (config.claudeCli?.off) return false;
  return Boolean(claudeCliToken(config)) || fs.existsSync(path.join(os.homedir(), '.claude', '.credentials.json'));
}
// LLM tab settings (data/llm-settings.json): the 기본 모델, and which Claude model and effort the subscription runs.
const CLAUDE_MODELS = {
  'claude-opus-5-5': 'Claude Opus 5.5',
  'claude-sonnet-5-5': 'Claude Sonnet 5.5',
  'claude-haiku-4-5-20251001': 'Claude Haiku 4.5',
  'claude-fable-5-1': 'Claude Fable 5.1',
};
const CLAUDE_EFFORTS = ['auto', 'low', 'medium', 'high', 'xhigh', 'max'];
function llmSettings(dataDir) {
  try { return JSON.parse(fs.readFileSync(path.join(dataDir, 'llm-settings.json'), 'utf8')) || {}; } catch { return {}; }
}
function saveLlmSettings(dataDir, patch) {
  const next = { ...llmSettings(dataDir), ...patch };
  fs.writeFileSync(path.join(dataDir, 'llm-settings.json'), JSON.stringify(next, null, 1));
  return next;
}
// The harness settings on the 학습 › 하네스 tab: [lowest, highest, default].
const HARNESS_LIMITS = {
  maxRewrites: [0, 3, 2], // solution-only rewrites per design
  maxRepairs: [0, 4, 2], // problem repairs per design
  maxDesigns: [1, 5, 3], // designs per problem (the first and fresh ones)
  setCalls: [20, 150, 60], // model calls one set may use
  localCalls: [20, 150, 120], // the same for a set made by the PC model (free per call)
};
function harnessSettings(dataDir) {
  const saved = (dataDir && llmSettings(dataDir).harness) || {};
  return Object.fromEntries(Object.entries(HARNESS_LIMITS).map(([k, [lo, hi, def]]) => [k, Number.isInteger(saved[k]) && saved[k] >= lo && saved[k] <= hi ? saved[k] : def]));
}

/** The built-in instructions with the teacher's AI role (공통 지침) before them. */
function withTeacherPrompt(config, system) {
  if (!config.dataDir) return system;
  const persona = String(llmSettings(config.dataDir).persona || '').trim();
  return persona ? `[선생님이 정한 AI의 역할과 공통 지시]\n${persona}\n\n${system}` : system;
}

/** The Claude model and effort the subscription runs: the LLM tab's choice, else the server's default. */
function claudeCliChoice(config) {
  const s = config.dataDir ? llmSettings(config.dataDir).claude || {} : {};
  const model = CLAUDE_MODELS[s.model] ? s.model : config.claudeCli.model;
  return { model, effort: CLAUDE_EFFORTS.includes(s.effort) ? s.effort : 'auto', label: `${CLAUDE_MODELS[model] || model} (구독)` };
}

/** The subscription's use as of the last call (5-hour and weekly windows), kept for the LLM tab. */
function saveClaudeLimits(config, info) {
  if (!config.dataDir) return;
  const w = info.unifiedWindows || {};
  const pick = (x) => (x ? { used: Number(x.utilization) || 0, resetsAt: x.resetsAt ? new Date(x.resetsAt * 1000).toISOString() : '' } : null);
  const data = { at: new Date().toISOString(), status: info.status || '', fiveHour: pick(w.five_hour), sevenDay: pick(w.seven_day) };
  try { fs.writeFileSync(path.join(config.dataDir, 'claude-limits.json'), JSON.stringify(data)); } catch { /* display only */ }
}
function claudeLimits(config) {
  try { return JSON.parse(fs.readFileSync(path.join(config.dataDir, 'claude-limits.json'), 'utf8')); } catch { return null; }
}

/** The long-lived token saved by the LLM tab's login (deploy/claude-login.py), if any. */
function claudeCliToken(config) {
  try { return config.dataDir ? fs.readFileSync(path.join(config.dataDir, 'claude-oauth-token.txt'), 'utf8').trim() : ''; } catch { return ''; }
}

// POST JSON with our own timeout and the job's cancel signal.
// Uses node:http(s) rather than fetch: fetch (undici) silently gives up when response headers take
// longer than 5 minutes, and a local Gemma or a long DeepSeek reasoning call can take longer than that.
function postJson(url, headers, payload, timeoutMs, signal, timeoutMessage) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const body = Buffer.from(JSON.stringify(payload));
    const client = target.protocol === 'https:' ? https : http;
    let settled = false;
    const finish = (fn, value) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', onCancel); fn(value); };
    const req = client.request(target, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': body.length, ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => finish(resolve, { response: { ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode }, raw: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', (e) => finish(reject, e));
    });
    const timer = setTimeout(() => { req.destroy(); finish(reject, new Error(timeoutMessage)); }, timeoutMs);
    const onCancel = () => { req.destroy(); finish(reject, new Error('작업이 취소되었습니다.')); };
    signal?.addEventListener('abort', onCancel, { once: true });
    req.on('error', (e) => finish(reject, e.code === 'ECONNREFUSED' ? new Error('모델 서버에 연결할 수 없습니다.') : e));
    req.end(body);
  });
}

// A local model sometimes falls into a loop ("(M_A/M_B) * (M_A/M_B) * ..." or the same sentence again and again)
// and would fill the whole output limit, ~5 minutes on the PC. True when the latest stretch keeps repeating.
function repeating(text, { window = 4000, piece = 60, times = 6 } = {}) {
  if (text.length < piece * times) return false;
  const tail = text.slice(-window);
  const last = tail.slice(-piece);
  let count = 0;
  for (let i = tail.indexOf(last); i !== -1; i = tail.indexOf(last, i + 1)) if (++count >= times) return true;
  return false;
}

// Streams an OpenAI-style chat completion (llama-server) and stops early when the answer or the thinking starts
// repeating. Returns the same envelope a non-streamed call gives; a stopped loop has finish_reason 'repeat'.
function postStream(url, payload, timeoutMs, signal, timeoutMessage) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const body = Buffer.from(JSON.stringify({ ...payload, stream: true, stream_options: { include_usage: true } }));
    const client = target.protocol === 'https:' ? https : http;
    let settled = false;
    const finish = (fn, value) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', onCancel); fn(value); };
    let content = '';
    let reasoning = '';
    let finishReason = null;
    let usage = null;
    let pieces = 0;
    let checkedAt = 0;
    const envelope = (reason) => ({
      choices: [{ finish_reason: reason, message: { content, reasoning_content: reasoning } }],
      usage: usage || { prompt_tokens: 0, completion_tokens: pieces, total_tokens: pieces },
    });
    // A fresh connection per call: llama-server closes a streamed connection, and a reused keep-alive socket
    // then fails the next call with 'socket hang up'.
    const req = client.request(target, { method: 'POST', agent: false, headers: { 'Content-Type': 'application/json', 'Content-Length': body.length, Connection: 'close' } }, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => finish(resolve, { response: { ok: false, status: res.statusCode }, raw: Buffer.concat(chunks).toString('utf8') }));
        return;
      }
      let buffer = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buffer += chunk;
        let nl;
        while ((nl = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') continue;
          let event;
          try { event = JSON.parse(data); } catch { continue; }
          if (event.usage) usage = event.usage;
          const choice = event.choices?.[0];
          if (!choice) continue;
          if (choice.delta?.content) { content += choice.delta.content; pieces++; }
          if (choice.delta?.reasoning_content) { reasoning += choice.delta.reasoning_content; pieces++; }
          if (choice.finish_reason) finishReason = choice.finish_reason;
        }
        if (content.length + reasoning.length - checkedAt >= 400) {
          checkedAt = content.length + reasoning.length;
          if (repeating(content) || repeating(reasoning)) { req.destroy(); finish(resolve, { response: { ok: true, status: 200 }, envelope: envelope('repeat') }); }
        }
      });
      res.on('end', () => finish(resolve, { response: { ok: true, status: 200 }, envelope: envelope(finishReason || 'stop') }));
      res.on('error', (e) => finish(reject, e));
    });
    const timer = setTimeout(() => { req.destroy(); finish(reject, new Error(timeoutMessage)); }, timeoutMs);
    const onCancel = () => { req.destroy(); finish(reject, new Error('작업이 취소되었습니다.')); };
    signal?.addEventListener('abort', onCancel, { once: true });
    req.on('error', (e) => finish(reject, e.code === 'ECONNREFUSED' ? new Error('모델 서버에 연결할 수 없습니다.') : e));
    req.end(body);
  });
}

function createLlm({ config, store, apiKey, claudeKey = '', mock }) {
  const mode = config.llmMode;

  // Gemma runs on the teacher's PC and reaches the server through an SSH tunnel, so it can be off.
  let gemmaCache = { at: 0, model: null };
  async function gemmaStatus(force = false) {
    if (mode === 'mock') return { available: true, model: 'mock-gemma' };
    if (!force && Date.now() - gemmaCache.at < 15000) return { available: Boolean(gemmaCache.model), model: gemmaCache.model };
    let model = null;
    try {
      const r = await fetch(config.gemma.endpoint + '/models', { signal: AbortSignal.timeout(2500) });
      const data = await r.json();
      model = data?.data?.[0]?.id || null;
    } catch { model = null; }
    gemmaCache = { at: Date.now(), model };
    return { available: Boolean(model), model };
  }

  async function sendDeepseek({ model, messages, maxTokens, effort, signal }) {
    if (!apiKey) throw Object.assign(new Error('서버에 DeepSeek API 키가 설정되지 않았습니다.'), { status: 503 });
    const payload = {
      model, messages, max_tokens: maxTokens,
      response_format: { type: 'json_object' },
      thinking: { type: effort === 'off' ? 'disabled' : 'enabled' },
      temperature: effort === 'off' ? 0 : 0.6,
    };
    if (effort !== 'off') payload.reasoning_effort = effort;
    const { response, raw } = await postJson(config.deepseek.baseUrl + '/chat/completions', { Authorization: 'Bearer ' + apiKey }, payload, config.deepseek.timeoutMs, signal, 'DeepSeek 응답 시간이 초과되었습니다.');
    if (!response.ok) {
      const hint = response.status === 402 ? 'DeepSeek 계정 잔액이 부족합니다.'
        : response.status === 429 ? 'DeepSeek 요청 한도에 걸렸습니다. 잠시 후 다시 시도해 주세요.'
        : response.status === 401 ? 'DeepSeek API 키가 올바르지 않습니다.'
        : `DeepSeek 오류 (${response.status})`;
      throw Object.assign(new Error(hint), { status: 502, detail: raw.slice(0, 300) });
    }
    return JSON.parse(raw);
  }

  async function sendGemma({ messages, maxTokens, effort, signal, copying = false }) {
    const status = await gemmaStatus();
    if (!status.available) throw Object.assign(new Error('Gemma(PC)에 연결할 수 없습니다. PC가 켜져 있고 Gemma가 실행 중인지 확인해 주세요.'), { status: 503 });
    // JSON-constrained output that fits the context. Thinking (design/review calls) gets its own budget: left
    // unbounded, Gemma 26B thought until the whole output limit was used and the answer was never written.
    const thinking = Boolean(config.gemma.thinking) && effort !== 'off';
    const maxOut = Math.min(maxTokens, config.gemma.maxOutputTokens);
    // Sampling against loops: at temperature 0.2 Gemma 26B repeated one line until the output limit (5 answers in
    // one set). DRY penalises re-emitting a sequence it just wrote; JSON punctuation resets it, so keys still repeat.
    // Writing a solution out from an outline repeats the teacher's phrases and table headers on purpose; there DRY
    // bent the repeats into typos ("반응 후" → "반앦 후", a header split mid-word), so it is off and the
    // temperature low. The streamed-repeat stop still ends a real loop.
    const payload = {
      model: status.model, messages, temperature: copying ? 0.2 : thinking ? 0.6 : 0.2, top_p: 0.95,
      ...(copying ? {} : { dry_multiplier: 0.8, dry_base: 1.75, dry_allowed_length: 4 }),
      max_tokens: maxOut,
      // enable_thinking switches Qwen's and Gemma's thinking; gpt-oss always thinks and takes its depth from
      // reasoning_effort instead (each template ignores the other's key).
      chat_template_kwargs: { enable_thinking: thinking, reasoning_effort: !thinking ? 'low' : effort === 'high' ? 'high' : 'medium' },
      response_format: { type: 'json_object' },
    };
    if (thinking) {
      payload.thinking_budget_tokens = Math.min(config.gemma.thinkingBudget?.[effort] || config.gemma.thinkingBudget?.low || 3072, Math.floor(maxOut / 2));
      payload.reasoning_budget_message = '\n\n생각할 시간이 끝났다. 지금까지 정한 내용으로 바로 JSON 답을 쓴다.\n';
    }
    const { response, raw, envelope } = await postStream(config.gemma.endpoint + '/chat/completions', payload, config.gemma.timeoutMs, signal, 'Gemma 응답 시간이 초과되었습니다.');
    if (!response.ok) {
      gemmaCache.at = 0;
      const hint = /context|too long|exceed/i.test(raw) ? 'Gemma의 입력 길이 한도(32k)를 넘었습니다. 이미지나 STEP 내용을 줄이거나 DeepSeek을 써 주세요.' : `Gemma 오류 (${response.status})`;
      throw Object.assign(new Error(hint), { status: 502, detail: raw.slice(0, 300) });
    }
    return envelope;
  }

  // Claude Code CLI on this server (`claude -p`): the same system prompt and user message; images go to a temporary
  // folder and are opened with the Read tool where they stood in the message; the answer and the token counts come
  // from its JSON result. Runs on the logged-in subscription, so nothing is billed per call.
  async function sendClaudeCli({ messages, effort, signal, model: modelOverride }) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'em-claude-'));
    try {
      const user = messages[1].content;
      const texts = [];
      let images = 0;
      (typeof user === 'string' ? [{ type: 'text', text: user }] : user).forEach((part, i) => {
        if (part.type === 'text') { texts.push(part.text); return; }
        const m = /^data:image\/(\w+);base64,(.*)$/s.exec(part.image_url.url);
        const file = path.join(dir, `image${i}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`);
        fs.writeFileSync(file, Buffer.from(m[2], 'base64'));
        texts.push(`[이미지: ${file}]`);
        images++;
      });
      for (const turn of messages.slice(2)) texts.push(`[${turn.role === 'assistant' ? '너의 이전 응답' : '추가 요청'}]\n${turn.content}`);
      const prompt = (images ? '[이미지: 경로]가 있는 자리마다 그 이미지 파일을 Read 도구로 열어 자세히 본 뒤 답한다. 다른 파일은 열지 않는다.\n\n' : '') + texts.join('\n');
      const choice = claudeCliChoice(config);
      const args = ['-p', '--output-format', 'stream-json', '--verbose', '--model', modelOverride || choice.model, '--system-prompt', messages[0].content, '--no-session-persistence',
        '--tools', images ? 'Read' : '', ...(images ? ['--allowedTools', 'Read'] : []),
        ...(effort === 'off' ? ['--effort', 'low'] : choice.effort !== 'auto' ? ['--effort', choice.effort] : effort === 'high' ? ['--effort', 'high'] : [])];
      const { code, stdout, stderr } = await new Promise((resolve, reject) => {
        const token = claudeCliToken(config);
        const child = spawn(config.claudeCli.bin, [...(config.claudeCli.binArgs || []), ...args], { cwd: dir, env: token ? { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: token } : process.env });
        let out = ''; let err = '';
        const timer = setTimeout(() => { child.kill('SIGTERM'); reject(Object.assign(new Error('Claude(구독) 응답 시간이 초과되었습니다.'), { status: 504 })); }, config.claudeCli.timeoutMs);
        const abort = () => child.kill('SIGTERM');
        signal?.addEventListener('abort', abort, { once: true });
        child.stdout.on('data', (d) => { out += d; });
        child.stderr.on('data', (d) => { err += d; });
        child.on('error', (e) => { clearTimeout(timer); reject(Object.assign(new Error(`Claude CLI를 실행하지 못했습니다: ${e.message}`), { status: 503 })); });
        child.on('close', (c) => { clearTimeout(timer); signal?.removeEventListener('abort', abort); resolve({ code: c, stdout: out, stderr: err }); });
        child.stdin.end(prompt);
      });
      if (signal?.aborted) throw new Error('작업이 취소되었습니다.');
      // Streamed events: the final "result", and "rate_limit_event"s with the subscription's 5-hour and weekly use,
      // which the LLM tab shows.
      const events = stdout.split('\n').map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
      const limits = events.filter((e) => e.type === 'rate_limit_event').pop()?.rate_limit_info;
      if (limits) saveClaudeLimits(config, limits);
      const result = events.filter((e) => e.type === 'result').pop();
      if (!result) {
        throw Object.assign(new Error(`Claude(구독) 실행 오류 (종료 코드 ${code}): ${(stderr || stdout).trim().slice(0, 300)}`), { status: 502 });
      }
      // A usage limit, an expired login and the like come back as an error result with the reason in `result`.
      if (result.is_error || result.subtype !== 'success') {
        throw Object.assign(new Error(`Claude(구독) 오류: ${String(result.result || result.subtype || '').slice(0, 300)}`), { status: 502 });
      }
      const u = result.usage || {};
      const input = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      return {
        choices: [{ finish_reason: 'stop', message: { content: String(result.result || '') } }],
        usage: { prompt_tokens: input, prompt_cache_hit_tokens: u.cache_read_input_tokens || 0, completion_tokens: u.output_tokens || 0, total_tokens: input + (u.output_tokens || 0) },
      };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  // Relay: write the exact request (system prompt, user text, images in order) to a file and wait for an
  // answer file. Same prompts and same pipeline as the API providers; only who answers differs.
  // Claude over the Anthropic Messages API. Our messages are OpenAI-style (system first, image_url data URLs),
  // so they are converted; the answer is returned in the same envelope the other providers use.
  function toClaude(messages) {
    const blocks = (content) => (typeof content === 'string' ? content : content.map((part) => {
      if (part.type === 'text') return { type: 'text', text: part.text };
      const m = /^data:(image\/[a-z]+);base64,(.*)$/s.exec(part.image_url.url);
      return { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } };
    }));
    return { system: messages[0].content, messages: messages.slice(1).map((m) => ({ role: m.role, content: blocks(m.content) })) };
  }
  async function sendClaude({ messages, maxTokens, effort, signal }) {
    if (!claudeKey) throw Object.assign(new Error('서버에 Anthropic API 키가 설정되지 않았습니다.'), { status: 503 });
    const { system, messages: turns } = toClaude(messages);
    const budget = effort === 'high' ? 16000 : 4000;
    const payload = { model: config.claude.model, system, messages: turns, max_tokens: Math.min(Math.max(maxTokens, effort === 'off' ? 1024 : budget + 8000), config.claude.maxOutputTokens) };
    if (effort === 'off') payload.temperature = 0;
    else payload.thinking = { type: 'enabled', budget_tokens: budget };
    const headers = { 'x-api-key': claudeKey, 'anthropic-version': '2023-06-01' };
    // Rate limits on a small plan: wait and try again a few times instead of failing the job.
    for (let attempt = 0; ; attempt++) {
      const { response, raw } = await postJson(config.claude.baseUrl + '/v1/messages', headers, payload, config.claude.timeoutMs, signal, 'Claude 응답 시간이 초과되었습니다.');
      if (response.ok) {
        const data = JSON.parse(raw);
        const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
        const u = data.usage || {};
        const input = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
        return {
          choices: [{ finish_reason: data.stop_reason === 'max_tokens' ? 'length' : 'stop', message: { content: text } }],
          usage: { prompt_tokens: input, prompt_cache_hit_tokens: u.cache_read_input_tokens || 0, completion_tokens: u.output_tokens || 0, total_tokens: input + (u.output_tokens || 0) },
        };
      }
      if ((response.status === 429 || response.status === 529) && attempt < 4) {
        await new Promise((r) => setTimeout(r, (config.claude.retryDelaysMs || [5000, 15000, 30000, 60000])[attempt]));
        if (signal?.aborted) throw new Error('작업이 취소되었습니다.');
        continue;
      }
      const hint = /credit balance/i.test(raw) ? 'Anthropic 계정 크레딧이 부족합니다. 콘솔의 결제 설정에서 크레딧을 충전해 주세요.'
        : response.status === 401 ? 'Anthropic API 키가 올바르지 않습니다.'
        : response.status === 429 ? 'Claude 요청 한도에 걸렸습니다. 잠시 후 다시 시도해 주세요.'
        : `Claude 오류 (${response.status})`;
      throw Object.assign(new Error(hint), { status: 502, detail: raw.slice(0, 300) });
    }
  }

  async function sendRelay({ messages, purpose, signal }) {
    const dir = config.relay.dir;
    if (!dir) throw Object.assign(new Error('중계 모델이 설정되지 않았습니다.'), { status: 503 });
    fs.mkdirSync(dir, { recursive: true });
    const id = `${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${newId().slice(0, 6)}-${purpose}`;
    const user = messages[1].content;
    const content = [];
    (typeof user === 'string' ? [{ type: 'text', text: user }] : user).forEach((part, i) => {
      if (part.type === 'text') { content.push({ type: 'text', text: part.text }); return; }
      const m = /^data:image\/(\w+);base64,(.*)$/s.exec(part.image_url.url);
      const file = path.join(dir, `${id}-image${i}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`);
      fs.writeFileSync(file, Buffer.from(m[2], 'base64'));
      content.push({ type: 'image', file });
    });
    // A follow-up turn (e.g. "your JSON was invalid, send it again") travels as extra text parts.
    for (const turn of messages.slice(2)) content.push({ type: 'text', text: `[${turn.role === 'assistant' ? '너의 이전 응답' : '추가 요청'}]\n${turn.content}` });
    const requestFile = path.join(dir, `${id}.request.json`);
    const responseFile = path.join(dir, `${id}.response.json`);
    fs.writeFileSync(requestFile, JSON.stringify({ id, purpose, system: messages[0].content, content, responseFile }, null, 1));
    const deadline = Date.now() + config.relay.timeoutMs;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error('작업이 취소되었습니다.');
      if (fs.existsSync(responseFile)) {
        await new Promise((r) => setTimeout(r, 500)); // let the writer finish
        const answer = JSON.parse(fs.readFileSync(responseFile, 'utf8'));
        return { choices: [{ finish_reason: 'stop', message: { content: answer.content } }], usage: {} };
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    throw new Error('중계 모델 응답 시간이 초과되었습니다.');
  }

  /**
   * Calls the model and returns parsed JSON.
   * One automatic retry only for unreadable/truncated output; that retry is counted in the budget too.
   */
  async function json({ provider: requested = 'deepseek', purpose, jobId, budget, system, text, images = [], vision = false, maxTokens = 16000, effort = 'low', signal }) {
    // "claude-cli:<model>": the Claude subscription with a model chosen for this call (Claude 혼합).
    const [provider, claudeModel] = requested.startsWith('claude-cli:') ? ['claude-cli', requested.slice('claude-cli:'.length)] : [requested, ''];
    const content = images.length
      ? [{ type: 'text', text }, ...images.flatMap((img) => [
          ...(img.label ? [{ type: 'text', text: img.label }] : []),
          { type: 'image_url', image_url: { url: img.dataUrl, detail: 'high' } },
        ])]
      : text;
    const model = provider === 'gemma' ? 'gemma' : provider === 'relay' ? 'relay' : provider === 'claude' ? config.claude.model : provider === 'claude-cli' ? claudeModel || claudeCliChoice(config).model : cli.CLIS.includes(provider) ? cli.cliChoice(config, provider).model || 'codex-default' : vision ? config.deepseek.visionModel : config.deepseek.textModel;
    // The teacher's persona and per-stage additions (LLM tab) go around the built-in instructions (not in mock mode).
    let messages = [{ role: 'system', content: mode === 'mock' ? system : withTeacherPrompt(config, system) }, { role: 'user', content }];
    let lastError;
    for (let attempt = 0; attempt < 2; attempt++) {
      budget.reserve();
      const started = Date.now();
      const record = { id: newId(), jobId, purpose, provider, model: mode === 'mock' ? 'mock' : model, createdAt: new Date().toISOString(), outcome: 'started' };
      store.usage.put(record);
      let envelope;
      try {
        const tokens = attempt ? Math.min(maxTokens * 2, 128000) : maxTokens;
        envelope = mode === 'mock' ? await mock(messages)
          : provider === 'gemma' ? await sendGemma({ messages, maxTokens: tokens, effort, signal, copying: purpose === 'write-solution' })
          : provider === 'relay' ? await sendRelay({ messages, purpose, signal })
          : provider === 'claude' ? await sendClaude({ messages, maxTokens: tokens, effort, signal })
          : provider === 'claude-cli' ? await sendClaudeCli({ messages, effort, signal, model: claudeModel })
          : cli.CLIS.includes(provider) ? await cli.sendCli(config, provider, { messages, effort, signal })
          : await sendDeepseek({ model, messages, maxTokens: tokens, effort, signal });
      } catch (e) {
        store.usage.put({ ...record, durationMs: Date.now() - started, outcome: 'error' });
        throw e;
      }
      const u = envelope.usage || {};
      const usage = {
        input: u.prompt_tokens || 0,
        output: u.completion_tokens || 0,
        reasoning: u.completion_tokens_details?.reasoning_tokens || 0,
        // Input served from the provider's prompt cache (billed far lower); kept per call for cost reports.
        cached: u.prompt_cache_hit_tokens || 0,
        total: u.total_tokens || (u.prompt_tokens || 0) + (u.completion_tokens || 0),
      };
      budget.add(usage);
      const choice = envelope.choices?.[0];
      const finish = choice?.finish_reason;
      store.usage.put({ ...record, durationMs: Date.now() - started, ...usage, outcome: finish || 'unknown' });
      const raw = choice?.message?.content || '';
      // Evaluation runs keep every answer so a check that failed can be traced to what the model actually wrote.
      if (process.env.EDUMASTER_KEEP_RAW === '1') {
        try {
          fs.mkdirSync(path.join(store.dataDir, 'llm-raw'), { recursive: true });
          fs.writeFileSync(path.join(store.dataDir, 'llm-raw', `${record.createdAt.replace(/[:.]/g, '')}-${purpose}.txt`), `finish=${finish}\n\n${raw}`);
        } catch { /* diagnostics only */ }
      }
      try {
        if (finish === 'length') throw new LlmFormatError('모델 출력이 길이 제한에서 잘렸습니다.');
        if (finish === 'repeat') throw new LlmFormatError('모델이 같은 내용을 반복해서 중간에 멈췄습니다.');
        const { data, moved } = fixShape(extractJson(raw), SHAPES[purpose]);
        // A repaired-but-truncated answer (jsonrepair dropped everything after a broken bracket) must not pass.
        const missing = (REQUIRED[purpose] || []).filter((k) => data[k] === undefined || data[k] === null || data[k] === '' || (Array.isArray(data[k]) && !data[k].length));
        if (missing.length) throw new LlmFormatError(`응답에 필요한 항목이 없습니다: ${missing.join(', ')}`);
        return { data, usage, shapeFixes: moved };
      } catch (e) {
        if (!(e instanceof LlmFormatError)) throw e;
        lastError = e;
        // Keep what the model sent so a failure can be diagnosed later.
        try {
          fs.mkdirSync(path.join(store.dataDir, 'llm-failures'), { recursive: true });
          fs.writeFileSync(path.join(store.dataDir, 'llm-failures', `${record.id}-${purpose}.txt`), `${e.message}\nfinish=${finish}\n\n${raw}`);
        } catch { /* diagnostics only */ }
        // Same request again would give the same broken answer (temperature 0). For unreadable JSON, show the
        // model its answer and the error and ask for the corrected JSON; for a cut-off answer, allow more room.
        if (finish !== 'length' && finish !== 'repeat' && raw) {
          messages = [...messages.slice(0, 2), { role: 'assistant', content: raw.slice(0, 60000) },
            { role: 'user', content: `위 응답은 올바른 JSON이 아니다 (${e.message}). 같은 내용을 올바른 JSON 객체 하나로만 다시 출력하라. 문자열 안의 큰따옴표는 \\" 로, LaTeX 역슬래시는 \\\\ 로 쓴다.` }];
        }
      }
    }
    throw lastError;
  }

  // The LLM tab can replace the DeepSeek key while the server runs.
  const setApiKey = (key) => { apiKey = key; };
  return { json, mode, gemmaStatus, setApiKey };
}

// The PC provider serves whichever local model is loaded; name it from the model id llama-server reports.
function pcModelLabel(id) {
  const s = String(id || '').toLowerCase();
  if (/gpt-oss/.test(s)) return 'gpt-oss-20B (PC)';
  if (/qwen3\.8.*gsq/.test(s)) return 'Qwen 3.8-27B GSQ (PC)';
  if (/qwen3\.8/.test(s)) return 'Qwen 3.8-27B (PC)';
  if (/ornith/.test(s)) return 'Ornith 1.5-35B (PC)';
  if (/qwen3\.6/.test(s)) return 'Qwen 3.6-35B (PC)';
  if (/gemma-4-26b/.test(s)) return 'Gemma 4 26B (PC)';
  if (/gemma-4-12b/.test(s)) return 'Gemma 4 12B (PC)';
  return id ? `${id} (PC)` : 'PC 모델';
}

// A short key per local model for evaluation results (reports only name the PC provider "gemma"). Runs from before
// the model was recorded were all Gemma 4 12B.
function pcModelKey(id) {
  const s = String(id || '').toLowerCase();
  if (!s || s === 'gemma' || /gemma-4-12b/.test(s)) return 'gemma12';
  if (/gemma-4-26b/.test(s)) return 'gemma26';
  if (/qwen3\.6/.test(s)) return 'qwen36';
  if (/gpt-oss/.test(s)) return 'gptoss20';
  if (/qwen3\.8.*gsq/.test(s)) return 'qwen38gsq';
  if (/qwen3\.8/.test(s)) return 'qwen38';
  if (/ornith/.test(s)) return 'ornith';
  return s.replace(/^edumaster-/, '');
}

/**
 * Claude 혼합: within one Claude subscription, the calls that need judgment stay on the chosen model (Opus) and the
 * others go to cheaper ones — the subscription's limit fills by list price (Sonnet ½, Haiku ¼ of Opus).
 */
const CLAUDE_MIX = {
  'review-solution': 'claude-sonnet-5-5', 'write-solution': 'claude-sonnet-5-5', solve: 'claude-sonnet-5-5', learn: 'claude-sonnet-5-5', proofread: 'claude-sonnet-5-5',
  'reread-question': 'claude-haiku-4-5-20251001', 'reread-headings': 'claude-haiku-4-5-20251001', 'reread-problem': 'claude-haiku-4-5-20251001',
};

module.exports = { CLAUDE_MIX, PER_CALL_FREE, HARNESS_LIMITS, harnessSettings, repeating, pcModelLabel, pcModelKey, PROVIDERS, claudeCliReady, claudeLimits, claudeCliChoice, llmSettings, saveLlmSettings, CLAUDE_MODELS, CLAUDE_EFFORTS, withTeacherPrompt, createLlm, Budget, BudgetExceeded, LlmFormatError, extractJson, fixShape, SHAPES };
