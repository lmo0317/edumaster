'use strict';
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const env = process.env;
const int = (name, fallback) => {
  const value = Number.parseInt(env[name] ?? '', 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

module.exports = {
  root,
  publicDir: path.join(root, 'public'),
  dataDir: path.resolve(env.EDUMASTER_DATA_DIR || path.join(root, 'data')),
  host: env.EDUMASTER_HOST || '127.0.0.1',
  port: int('EDUMASTER_PORT', 18290),
  // nginx strips "/edumasterv2/" before proxying; the cookie still has to be scoped to it.
  cookiePath: env.EDUMASTER_COOKIE_PATH || '/',
  llmMode: env.EDUMASTER_LLM || 'deepseek', // "deepseek" | "mock"
  deepseek: {
    baseUrl: env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
    visionModel: env.EDUMASTER_VISION_MODEL || 'deepseek-flash',
    textModel: env.EDUMASTER_TEXT_MODEL || 'deepseek-flash',
    timeoutMs: int('EDUMASTER_LLM_TIMEOUT_MS', 420000),
  },
  // Local Gemma on the teacher's PC, reached through the existing SSH tunnel (same endpoint v1 uses).
  gemma: {
    endpoint: (env.EDUMASTER_GEMMA_ENDPOINT || 'http://127.0.0.1:18283/v1').replace(/\/+$/, ''),
    timeoutMs: int('EDUMASTER_GEMMA_TIMEOUT_MS', 1200000),
    // The PC model now runs with a 49k context (v1/scripts/start-local-model.ps1), so answers can be longer.
    maxOutputTokens: int('EDUMASTER_GEMMA_MAX_OUTPUT', 24576),
    // Thinking on for design and review calls (a quick check: without it Gemma 12B got a 1:3 limiting-reagent
    // question wrong, with it right). Reading calls stay without thinking.
    thinking: env.EDUMASTER_GEMMA_THINKING !== '0',
    // Tokens the model may think before it must answer (the rest of the output limit is for the JSON). Like the
    // other providers, 'low' (the default) thinks briefly and 'high' longer: at 8k on every call, Gemma 26B spent
    // ~2.5 minutes per call and 88 minutes per set.
    thinkingBudget: { low: int('EDUMASTER_GEMMA_THINKING_LOW', 3072), high: int('EDUMASTER_GEMMA_THINKING_HIGH', 8192) },
  },
  // Claude over the Anthropic API (key in data/anthropic-api-key.txt, never in the repo).
  claude: {
    baseUrl: env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
    model: env.EDUMASTER_CLAUDE_MODEL || 'claude-opus-5-5',
    timeoutMs: int('EDUMASTER_CLAUDE_TIMEOUT_MS', 600000),
    maxOutputTokens: int('EDUMASTER_CLAUDE_MAX_OUTPUT', 32000),
    // Shown in the teacher's model picker only when turned on (it costs several times DeepSeek); the eval
    // runner can use it either way.
    selectable: env.EDUMASTER_CLAUDE_SELECTABLE === '1',
  },
  // "relay" provider: each model request is written to this folder and answered by an outside agent
  // (used to run the same pipeline with a model that has no API key here, e.g. Claude in a Claude Code session).
  relay: {
    dir: env.EDUMASTER_RELAY_DIR || '',
    label: env.EDUMASTER_RELAY_LABEL || 'Claude Opus 5.5 (세션 중계)',
    timeoutMs: int('EDUMASTER_RELAY_TIMEOUT_MS', 3 * 3600 * 1000),
  },
  // Hard limits per job. A job never exceeds either one; it stops and reports instead.
  budget: {
    analyzeCalls: int('EDUMASTER_ANALYZE_CALLS', 11),
    analyzeTokens: int('EDUMASTER_ANALYZE_TOKENS', 160000),
    generateCalls: int('EDUMASTER_GENERATE_CALLS', 24),
    generateTokens: int('EDUMASTER_GENERATE_TOKENS', 600000),
    regenerateCalls: int('EDUMASTER_REGENERATE_CALLS', 5),
    regenerateTokens: int('EDUMASTER_REGENERATE_TOKENS', 150000),
  },
  // USD per million tokens, for the cost estimate on the 시스템 page (checked 2026-09-29: DeepSeek's own
  // price list, claude.com/pricing for Opus 5.5). Gemma runs free on the teacher's PC.
  pricing: {
    deepseek: { input: 0.30, output: 1.20 },
    opus: { input: 4, output: 20 },
    krwPerUsd: 1400,
  },
  maxUploadBytes: int('EDUMASTER_MAX_UPLOAD_BYTES', 14 * 1024 * 1024),
};
