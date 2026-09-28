'use strict';
const http = require('node:http');
const https = require('node:https');
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
  try { return restoreLatex(JSON.parse(json.replace(/\\(?!["\\/bfnrtu])/g, '\\\\'))); }
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

const PROVIDERS = {
  deepseek: { label: 'DeepSeek V4 Flash' },
  gemma: { label: 'Gemma 4 12B (PC)' },
};

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

function createLlm({ config, store, apiKey, mock }) {
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

  async function sendGemma({ messages, maxTokens, signal }) {
    const status = await gemmaStatus();
    if (!status.available) throw Object.assign(new Error('Gemma(PC)에 연결할 수 없습니다. PC가 켜져 있고 Gemma가 실행 중인지 확인해 주세요.'), { status: 503 });
    // Same settings v1 used for the local model: no thinking, JSON-constrained output, output fits the 32k context.
    const payload = {
      model: status.model, messages, stream: false, temperature: 0.2,
      max_tokens: Math.min(maxTokens, config.gemma.maxOutputTokens),
      chat_template_kwargs: { enable_thinking: false },
      response_format: { type: 'json_object' },
    };
    const { response, raw } = await postJson(config.gemma.endpoint + '/chat/completions', {}, payload, config.gemma.timeoutMs, signal, 'Gemma 응답 시간이 초과되었습니다.');
    if (!response.ok) {
      gemmaCache.at = 0;
      const hint = /context|too long|exceed/i.test(raw) ? 'Gemma의 입력 길이 한도(32k)를 넘었습니다. 이미지나 STEP 내용을 줄이거나 DeepSeek을 써 주세요.' : `Gemma 오류 (${response.status})`;
      throw Object.assign(new Error(hint), { status: 502, detail: raw.slice(0, 300) });
    }
    return JSON.parse(raw);
  }

  /**
   * Calls the model and returns parsed JSON.
   * One automatic retry only for unreadable/truncated output; that retry is counted in the budget too.
   */
  async function json({ provider = 'deepseek', purpose, jobId, budget, system, text, images = [], vision = false, maxTokens = 16000, effort = 'low', signal }) {
    const content = images.length
      ? [{ type: 'text', text }, ...images.flatMap((img) => [
          ...(img.label ? [{ type: 'text', text: img.label }] : []),
          { type: 'image_url', image_url: { url: img.dataUrl, detail: 'high' } },
        ])]
      : text;
    const model = provider === 'gemma' ? 'gemma' : vision ? config.deepseek.visionModel : config.deepseek.textModel;
    const messages = [{ role: 'system', content: system }, { role: 'user', content }];
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
          : provider === 'gemma' ? await sendGemma({ messages, maxTokens: tokens, signal })
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
        total: u.total_tokens || (u.prompt_tokens || 0) + (u.completion_tokens || 0),
      };
      budget.add(usage);
      const choice = envelope.choices?.[0];
      const finish = choice?.finish_reason;
      store.usage.put({ ...record, durationMs: Date.now() - started, ...usage, outcome: finish || 'unknown' });
      try {
        if (finish === 'length') throw new LlmFormatError('모델 출력이 길이 제한에서 잘렸습니다.');
        return { data: extractJson(choice?.message?.content), usage };
      } catch (e) {
        if (!(e instanceof LlmFormatError)) throw e;
        lastError = e;
      }
    }
    throw lastError;
  }

  return { json, mode, gemmaStatus };
}

module.exports = { PROVIDERS, createLlm, Budget, BudgetExceeded, LlmFormatError, extractJson };
