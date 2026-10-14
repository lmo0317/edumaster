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
  // Claude bills a cache write above the input price: twice for the 1-hour cache the CLI uses (its reads held across
  // 7-minute gaps, 2026-10-09), 1.25 times for the API's 5-minute one. Records before 2026-10-09 have no cacheWrite.
  const write = r.cacheWrite || 0;
  const writeFactor = r.provider === 'claude-cli' ? 2 : r.provider === 'claude' ? 1.25 : 1;
  // A failed call (e.g. the CLI's 64k output cap) is recorded without token counts; it adds nothing rather than NaN.
  const input = r.input || 0, output = r.output || 0;
  return factor * ((input - cached - write) * p.input + write * p.input * writeFactor + cached * p.cached + output * p.output) / 1e6;
}

// What each call was for, in the stages a teacher sees: reading the original (done once per original: every set made
// from it reuses the analysis), designing the problems with their repairs, solving and writing the solutions, learning.
// The teacher's sentence frames are read off the original once too (extract-frames, 2026-10-13).
const STAGE_OF = (purpose) => (/^(analyze|proofread|reread-|regroup|fix-verification|extract-frames)/.test(purpose) ? 'read'
  : /^(generate|repair)/.test(purpose) ? 'design' : purpose === 'learn' ? 'learn' : 'solve');

/*
 * The same calls by the part of the work a teacher pays for (모델 비교's cost matrix): understanding the original's
 * problem and its solution (once per original), each step practice problem, the twin final, and the set's learning.
 * The problem a call belonged to is read off the generation job's log: from the line its label first appears on to
 * the next problem's.
 */
const PART_OF_READ = (purpose) => (/^(analyze|reread-question|reread-problem|regroup)/.test(purpose) ? 'understand' : 'solution');
function partOf(r, job, analysisIds) {
  if (analysisIds.includes(r.jobId) || STAGE_OF(r.purpose || '') === 'read') return PART_OF_READ(r.purpose || '');
  if (r.purpose === 'learn') return 'learn';
  const starts = (job?.items || []).map((it) => ({ part: it.stage?.kind === 'twin' ? 'twin' : 'practice', at: (job.log || []).find((x) => x.message.startsWith(`${it.label}: `))?.t }))
    .filter((x) => x.at).sort((a, b) => (a.at < b.at ? -1 : 1));
  const mine = starts.filter((x) => x.at <= r.createdAt).pop();
  return mine ? mine.part : 'practice';
}

/** Totals per provider and overall for the ledger records of the given jobs; the subscription's also per Claude model
 *  (a run with Haiku designing spends tokens on both, at prices forty times apart) and per stage and model; with the
 *  generation job, per part of the work and model (partOf). */
function runCost(records, jobIds, { job = null } = {}) {
  const byPart = {};
  const byProvider = {};
  const byModel = {};
  const byStage = {};
  let usd = 0;
  const withClaude = records.some((x) => jobIds.includes(x.jobId) && x.provider === 'claude-cli');
  for (const r of records) {
    if (!jobIds.includes(r.jobId) || r.outcome === 'started') continue;
    const c = callCost(r);
    const t = byProvider[r.provider] || (byProvider[r.provider] = { calls: 0, input: 0, cached: 0, output: 0, peakCalls: 0, usd: 0 });
    t.calls++; t.input += r.input || 0; t.cached += r.cached || 0; t.output += r.output || 0;
    if (r.provider === 'deepseek' && deepseekPeak(r.createdAt)) t.peakCalls++;
    if (c !== null) { t.usd += c; usd += c; }
    // The PC model designing for Claude (designWith) is counted beside it as 'local', at 0: who did which stage.
    // DeepSeek is split by stage and part too (모델 비교's price grid covers every model, 2026-10-14).
    const model = r.provider === 'claude-cli' ? r.model : r.provider === 'gemma' && withClaude ? 'local' : r.provider === 'deepseek' ? 'deepseek' : null;
    if (model) {
      const m = byModel[model] || (byModel[model] = { calls: 0, tokens: 0, usd: 0 });
      m.calls++; m.tokens += (r.input || 0) + (r.output || 0); m.usd += c || 0;
      const st = byStage[STAGE_OF(r.purpose || '')] || (byStage[STAGE_OF(r.purpose || '')] = {});
      const sm = st[model] || (st[model] = { calls: 0, tokens: 0, usd: 0 });
      sm.calls++; sm.tokens += (r.input || 0) + (r.output || 0); sm.usd += c || 0;
      if (job) {
        const part = partOf(r, job, jobIds.filter((id) => id !== job.id));
        const pt = byPart[part] || (byPart[part] = {});
        const pm = pt[model] || (pt[model] = { calls: 0, tokens: 0, usd: 0 });
        pm.calls++; pm.tokens += (r.input || 0) + (r.output || 0); pm.usd += c || 0;
      }
    }
  }
  for (const t of [...Object.values(byProvider), ...Object.values(byModel), ...Object.values(byStage).flatMap(Object.values), ...Object.values(byPart).flatMap(Object.values)]) t.usd = +t.usd.toFixed(3);
  return { usd: +usd.toFixed(3), byProvider, ...(Object.keys(byModel).length ? { byModel, byStage } : {}), ...(Object.keys(byPart).length ? { byPart } : {}) };
}

module.exports = { PRICES, CLAUDE_PRICES, STAGE_OF, deepseekPeak, callCost, runCost };
