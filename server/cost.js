'use strict';
// What a run cost, from the per-call usage ledger (data/usage): each call priced by its provider's list price.
// Prices per 1M tokens, checked 2026-09-30 on the official pages:
//   https://api-docs.deepseek.com/quick_start/pricing  (deepseek-flash; peak hours cost twice as much)
//   https://platform.claude.com/docs/en/about-claude/pricing  (Claude Opus 5.5; thinking is billed as output)
const PRICES = {
  deepseek: { input: 0.15, cached: 0.003, output: 0.6 },
  claude: { input: 4, cached: 0.2, output: 20 },
};
// Claude models by id (the subscription, 'claude-cli', records the model each call used).
const CLAUDE_PRICES = {
  'claude-opus-5-5': { input: 4, cached: 0.2, output: 20 },
  'claude-sonnet-5-5': { input: 2, cached: 0.2, output: 10 },
  // Haiku 5.5 (2026-10-07): this price for prompts up to 100k tokens, five times it above (ours stay under).
  'claude-haiku-5-5': { input: 0.1, cached: 0.01, output: 0.5 },
  'claude-haiku-4-5-20251001': { input: 1, cached: 0.1, output: 5 },
  'claude-fable-5-1': { input: 10, cached: 1, output: 50 },
};

// DeepSeek peak: 01:00-04:00 and 06:00-10:00 UTC, Monday to Friday (Chinese public holidays not counted here).
function deepseekPeak(at) {
  const d = new Date(at);
  const day = d.getUTCDay();
  const h = d.getUTCHours();
  return day >= 1 && day <= 5 && ((h >= 1 && h < 4) || (h >= 6 && h < 10));
}

/** USD for one ledger record; null for providers without a price (local model, relay). */
function callCost(r) {
  const p = r.provider === 'claude-cli' ? CLAUDE_PRICES[r.model] || PRICES.claude : PRICES[r.provider];
  if (!p) return null;
  const factor = r.provider === 'deepseek' && deepseekPeak(r.createdAt) ? 2 : 1;
  const cached = r.cached || 0;
  return factor * ((r.input - cached) * p.input + cached * p.cached + r.output * p.output) / 1e6;
}

/** Totals per provider and overall for the ledger records of the given jobs. */
function runCost(records, jobIds) {
  const byProvider = {};
  let usd = 0;
  for (const r of records) {
    if (!jobIds.includes(r.jobId) || r.outcome === 'started') continue;
    const c = callCost(r);
    const t = byProvider[r.provider] || (byProvider[r.provider] = { calls: 0, input: 0, cached: 0, output: 0, peakCalls: 0, usd: 0 });
    t.calls++; t.input += r.input || 0; t.cached += r.cached || 0; t.output += r.output || 0;
    if (r.provider === 'deepseek' && deepseekPeak(r.createdAt)) t.peakCalls++;
    if (c !== null) { t.usd += c; usd += c; }
  }
  for (const t of Object.values(byProvider)) t.usd = +t.usd.toFixed(3);
  return { usd: +usd.toFixed(3), byProvider };
}

module.exports = { PRICES, CLAUDE_PRICES, deepseekPeak, callCost, runCost };
