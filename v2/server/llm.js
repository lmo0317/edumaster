'use strict';
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
  try { return JSON.parse(body.slice(start, end + 1)); }
  catch (e) { throw new LlmFormatError('모델 응답 JSON을 읽지 못했습니다: ' + e.message); }
}

function createLlm({ config, store, apiKey, mock }) {
  const mode = config.llmMode;

  async function send({ model, messages, maxTokens, effort, signal }) {
    if (mode === 'mock') return mock(messages);
    if (!apiKey) throw Object.assign(new Error('서버에 DeepSeek API 키가 설정되지 않았습니다.'), { status: 503 });
    const payload = {
      model,
      messages,
      max_tokens: maxTokens,
      response_format: { type: 'json_object' },
      thinking: { type: effort === 'off' ? 'disabled' : 'enabled' },
      temperature: effort === 'off' ? 0 : 0.6,
    };
    if (effort !== 'off') payload.reasoning_effort = effort;
    // Node 18 has no AbortSignal.any, so combine the job's cancel signal with the timeout by hand.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('DeepSeek 응답 시간이 초과되었습니다.')), config.deepseek.timeoutMs);
    const onCancel = () => controller.abort(new Error('작업이 취소되었습니다.'));
    signal?.addEventListener('abort', onCancel, { once: true });
    let response, raw;
    try {
      response = await fetch(config.deepseek.baseUrl + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      raw = await response.text();
    } catch (e) {
      throw controller.signal.aborted && controller.signal.reason instanceof Error ? controller.signal.reason : e;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onCancel);
    }
    if (!response.ok) {
      const hint = response.status === 402 ? 'DeepSeek 계정 잔액이 부족합니다.'
        : response.status === 429 ? 'DeepSeek 요청 한도에 걸렸습니다. 잠시 후 다시 시도해 주세요.'
        : response.status === 401 ? 'DeepSeek API 키가 올바르지 않습니다.'
        : `DeepSeek 오류 (${response.status})`;
      throw Object.assign(new Error(hint), { status: 502, detail: raw.slice(0, 300) });
    }
    return JSON.parse(raw);
  }

  /**
   * Calls the model and returns parsed JSON.
   * One automatic retry only for unreadable/truncated output; that retry is counted in the budget too.
   */
  async function json({ purpose, jobId, budget, system, text, images = [], vision = false, maxTokens = 16000, effort = 'low', signal }) {
    const content = images.length
      ? [{ type: 'text', text }, ...images.flatMap((img) => [
          ...(img.label ? [{ type: 'text', text: img.label }] : []),
          { type: 'image_url', image_url: { url: img.dataUrl, detail: 'high' } },
        ])]
      : text;
    const model = vision ? config.deepseek.visionModel : config.deepseek.textModel;
    const messages = [{ role: 'system', content: system }, { role: 'user', content }];
    let lastError;
    for (let attempt = 0; attempt < 2; attempt++) {
      budget.reserve();
      const started = Date.now();
      const record = { id: newId(), jobId, purpose, model: mode === 'mock' ? 'mock' : model, createdAt: new Date().toISOString(), outcome: 'started' };
      store.usage.put(record);
      let envelope;
      try {
        envelope = await send({ model, messages, maxTokens: attempt ? Math.min(maxTokens * 2, 128000) : maxTokens, effort, signal });
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

  return { json, mode };
}

module.exports = { createLlm, Budget, BudgetExceeded, LlmFormatError, extractJson };
