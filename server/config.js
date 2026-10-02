'use strict';
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

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
  // nginx strips "/edumaster/" before proxying; the cookie still has to be scoped to it.
  cookiePath: env.EDUMASTER_COOKIE_PATH || '/',
  llmMode: env.EDUMASTER_LLM || 'deepseek', // "deepseek" | "mock"
  deepseek: {
    baseUrl: env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
    visionModel: env.EDUMASTER_VISION_MODEL || 'deepseek-flash',
    textModel: env.EDUMASTER_TEXT_MODEL || 'deepseek-flash',
    timeoutMs: int('EDUMASTER_LLM_TIMEOUT_MS', 420000),
  },
  // Local Gemma on the teacher's PC, reached through the existing SSH tunnel (scripts/start-web.ps1 keeps it open).
  gemma: {
    endpoint: (env.EDUMASTER_GEMMA_ENDPOINT || 'http://127.0.0.1:18283/v1').replace(/\/+$/, ''),
    timeoutMs: int('EDUMASTER_GEMMA_TIMEOUT_MS', 1200000),
    // The PC model now runs with a 49k context (scripts/start-local-model.ps1), so answers can be longer.
    maxOutputTokens: int('EDUMASTER_GEMMA_MAX_OUTPUT', 24576),
    // Thinking on for design and review calls (a quick check: without it Gemma 12B got a 1:3 limiting-reagent
    // question wrong, with it right). Reading calls stay without thinking.
    thinking: env.EDUMASTER_GEMMA_THINKING !== '0',
    // Tokens the model may think before it must answer (the rest of the output limit is for the JSON). Like the
    // other providers, 'low' (the default) thinks briefly and 'high' longer: at 8k on every call, Gemma 26B spent
    // ~2.5 minutes per call and 88 minutes per set.
    thinkingBudget: { low: int('EDUMASTER_GEMMA_THINKING_LOW', 3072), high: int('EDUMASTER_GEMMA_THINKING_HIGH', 8192) },
  },
  // Claude through the Claude Code CLI on this server (`claude -p`), on the subscription the teacher logged in with
  // once (`claude` → login). No API key and no API cost; the subscription's usage limits apply. For the teacher's own use.
  claudeCli: {
    // A per-user install (`claude install latest` → ~/.local/bin) is preferred: it can be kept current without sudo,
    // and new models need a recent CLI (Opus 5.5: 2.1.280 or newer).
    bin: env.EDUMASTER_CLAUDE_CLI || (fs.existsSync(path.join(os.homedir(), '.local', 'bin', 'claude')) ? path.join(os.homedir(), '.local', 'bin', 'claude') : 'claude'),
    model: env.EDUMASTER_CLAUDE_CLI_MODEL || 'claude-opus-5-5',
    timeoutMs: int('EDUMASTER_CLAUDE_CLI_TIMEOUT_MS', 1800000),
    off: env.EDUMASTER_CLAUDE_CLI === 'off',
  },
  // Gemini through the Antigravity CLI and GPT through the Codex CLI on this server (server/cli-models.js), on the
  // subscriptions the teacher signs in to from the LLM tab. Both are per-user installs in ~/.local/bin.
  agyCli: {
    bin: env.EDUMASTER_AGY_CLI || path.join(os.homedir(), '.local', 'bin', 'agy'),
    timeoutMs: int('EDUMASTER_AGY_CLI_TIMEOUT_MS', 1800000),
    off: env.EDUMASTER_AGY_CLI === 'off',
    // The python with pyte that reads the remaining limits from agy's /usage screen (deploy/agy-quota.py).
    python: env.EDUMASTER_AGY_PYTHON || path.join(os.homedir(), '.local', 'share', 'edumaster-py', 'bin', 'python'),
    // Each request runs in a folder under workRoot, the only place agy may write (its answer); agy's own settings file
    // gets that rule (and no commands) from server/cli-models.js.
    workRoot: env.EDUMASTER_AGY_WORK || path.join(os.homedir(), '.local', 'share', 'edumaster-agy', 'requests'),
    settings: env.EDUMASTER_AGY_SETTINGS || path.join(os.homedir(), '.gemini', 'antigravity-cli', 'settings.json'),
  },
  codexCli: {
    bin: env.EDUMASTER_CODEX_CLI || path.join(os.homedir(), '.local', 'bin', 'codex'),
    timeoutMs: int('EDUMASTER_CODEX_CLI_TIMEOUT_MS', 1800000),
    off: env.EDUMASTER_CODEX_CLI === 'off',
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
    // generate + (independent solve + solution review) per try; repairs, rewrites and up to 3 designs per problem, 3 problems
    generateCalls: int('EDUMASTER_GENERATE_CALLS', 150), // a ceiling: a set's cap is the 하네스 setting (default 60) up to this
    generateTokens: int('EDUMASTER_GENERATE_TOKENS', 1600000),
    regenerateCalls: int('EDUMASTER_REGENERATE_CALLS', 25),
    regenerateTokens: int('EDUMASTER_REGENERATE_TOKENS', 600000),
  },
  // USD per million tokens, for the cost estimate on the 모델 비교 page (checked 2026-09-29: DeepSeek's own
  // price list, claude.com/pricing for Opus 5.5). Gemma runs free on the teacher's PC.
  pricing: {
    deepseek: { input: 0.30, output: 1.20 },
    opus: { input: 4, output: 20 },
    krwPerUsd: 1400,
  },
  maxUploadBytes: int('EDUMASTER_MAX_UPLOAD_BYTES', 14 * 1024 * 1024),
};
