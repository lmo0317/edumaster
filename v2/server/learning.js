'use strict';
// Teacher feedback → rules. Approved rules are attached to every later generation that they match,
// and each generated problem reports how it applied each rule (shown to the teacher).
// This is prompt-level learning (retrieval), not model fine-tuning.
const { newId } = require('./store');

const KINDS = new Set(['do', 'dont', 'feedback']);
const TARGETS = new Set(['problem', 'solution', 'design', 'all']);
const SCOPES = new Set(['global', 'topic']);

function clean(text, max) { return String(text ?? '').replace(/\s+\n/g, '\n').trim().slice(0, max); }

function makeRule(input, now = new Date()) {
  const text = clean(input.text, 1500);
  if (text.length < 2) throw Object.assign(new Error('지침 내용을 입력해 주세요.'), { status: 400 });
  return {
    id: newId().slice(0, 16),
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    status: input.status === 'pending' ? 'pending' : 'approved',
    scope: SCOPES.has(input.scope) ? input.scope : 'global',
    kind: KINDS.has(input.kind) ? input.kind : 'feedback',
    target: TARGETS.has(input.target) ? input.target : 'all',
    text,
    subject: clean(input.subject, 40),
    topic: clean(input.topic, 120),
    source: input.source && typeof input.source === 'object' ? {
      jobId: clean(input.source.jobId, 40), itemIndex: Number.isInteger(input.source.itemIndex) ? input.source.itemIndex : undefined,
      materialId: clean(input.source.materialId, 40), label: clean(input.source.label, 120), excerpt: clean(input.source.excerpt, 600),
    } : undefined,
    applied: 0,
  };
}

function updateRule(rule, patch, now = new Date()) {
  const next = { ...rule, updatedAt: now.toISOString() };
  if (patch.text !== undefined) { next.text = clean(patch.text, 1500); if (next.text.length < 2) throw Object.assign(new Error('지침 내용을 입력해 주세요.'), { status: 400 }); }
  if (['approved', 'pending', 'rejected'].includes(patch.status)) next.status = patch.status;
  if (SCOPES.has(patch.scope)) next.scope = patch.scope;
  if (KINDS.has(patch.kind)) next.kind = patch.kind;
  if (TARGETS.has(patch.target)) next.target = patch.target;
  return next;
}

// Korean has no spaces between morphemes worth relying on, so similarity uses character bigrams.
function grams(text) {
  const out = new Set();
  for (const word of String(text || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || []) {
    if (word.length === 1) continue;
    for (let i = 0; i < word.length - 1; i++) out.add(word.slice(i, i + 2));
  }
  return out;
}
function overlap(a, b) {
  if (!a.size || !b.size) return 0;
  let hit = 0;
  for (const g of a) if (b.has(g)) hit++;
  return hit / Math.min(a.size, b.size);
}

/**
 * Picks the rules for one material: every approved global rule, plus approved topic rules whose source
 * problem looks like this one. Returns at most `limit` rules and ~3500 characters in total.
 */
function selectRules(allRules, material, { limit = 14, maxChars = 3500 } = {}) {
  const approved = allRules.filter((r) => r.status === 'approved');
  const global = approved.filter((r) => r.scope === 'global').sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const target = grams([material.subject, material.topic, material.problem?.text, ...(material.techniques || [])].join(' '));
  const topical = approved.filter((r) => r.scope === 'topic').map((r) => {
    let score = overlap(grams([r.subject, r.topic, r.source?.excerpt, r.text].join(' ')), target);
    if (r.subject && material.subject && r.subject === material.subject) score += 0.15;
    if (r.source?.materialId && r.source.materialId === material.id) score += 1;
    return { r, score };
  }).filter((x) => x.score >= 0.3).sort((a, b) => b.score - a.score).map((x) => x.r);
  const picked = [];
  let chars = 0;
  for (const r of [...global, ...topical]) {
    if (picked.length >= limit || chars + r.text.length > maxChars) continue;
    picked.push(r); chars += r.text.length;
  }
  return picked;
}

module.exports = { makeRule, updateRule, selectRules, grams, overlap };
