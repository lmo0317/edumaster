'use strict';
// Teacher feedback → rules. Approved rules are attached to every later generation that they match,
// and each generated problem reports how it applied each rule (shown to the teacher).
// This is prompt-level learning (retrieval), not model fine-tuning.
const { newId } = require('./store');
const harness = require('./harness');

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
  // A topic feedback belongs to its subject: shared exam wording ("조건", "자료") must not carry a 화학 note to 생명과학.
  const topical = approved.filter((r) => r.scope === 'topic' && !(r.subject && material.subject && r.subject !== material.subject)).map((r) => {
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

// ---------------------------------------------------------------- reading corrections (RAG for analysis)
// When the teacher fixes an analysis (물질량 → 몰질량), the word-level changes are kept. Later analyses show the
// reader its past misreads and treat each corrected pair like a known confusable pair.

/** One-letter Hangul word changes between the analysis before and after the teacher's edit. */
function readingCorrections(before, after) {
  const fields = (m) => {
    const out = [m?.problem?.text, ...(m?.problem?.choices || [])];
    for (const s of m?.steps || []) out.push(s.title, s.work, s.result);
    return out.map((t) => String(t || ''));
  };
  const a = fields(before); const b = fields(after);
  if (a.length !== b.length) b.length = Math.min(a.length, b.length);
  const pairs = new Map();
  b.forEach((text, i) => {
    if (!text || text === a[i]) return;
    for (let [wrong, right] of harness.hangulFixes(a[i], text, text, harness.CONFUSABLE, 2)) {
      // 물질량을 → 몰질량을 is the same correction as 물질량 → 몰질량: drop a shared trailing particle.
      const particle = /(으로|에서|에게|을|를|이|가|은|는|의|에|와|과|로|도|만)$/.exec(wrong)?.[1];
      if (particle && right.endsWith(particle) && wrong.length - particle.length >= 2 && right.length - particle.length >= 2) {
        wrong = wrong.slice(0, -particle.length); right = right.slice(0, -particle.length);
      }
      if (/^-?\d/.test(wrong) || /^-?\d/.test(right) || wrong.length < 2 || right.length < 2) continue; // values are not reusable knowledge
      pairs.set(`${wrong}→${right}`, [wrong, right]);
    }
  });
  return [...pairs.values()];
}

function recordCorrections(store, pairs, material, now = new Date()) {
  const existing = store.corrections.all();
  for (const [wrong, right] of pairs) {
    const found = existing.find((c) => c.wrong === wrong && c.right === right);
    const base = found || { id: newId().slice(0, 16), wrong, right, count: 0, createdAt: now.toISOString(), materials: [] };
    store.corrections.put({ ...base, count: base.count + 1, subject: material?.subject || base.subject || '', lastAt: now.toISOString(),
      materials: [...new Set([...(base.materials || []), material?.id].filter(Boolean))].slice(-20), provider: material?.analyzedWith || '' });
  }
}

/** Confusable word pairs: the built-in list plus every word the teacher has corrected. */
function readingPairs(corrections) {
  const pairs = harness.CONFUSABLE.map((p) => [...p]);
  for (const c of corrections) {
    if (!pairs.some((p) => p.includes(c.wrong) && p.includes(c.right))) pairs.push([c.wrong, c.right]);
  }
  return pairs;
}

/** Past corrections as a short hint for the reader (most frequent first). */
function readingHint(corrections, limit = 12) {
  const top = [...corrections].sort((a, b) => b.count - a.count || String(b.lastAt).localeCompare(String(a.lastAt))).slice(0, limit);
  if (!top.length) return '';
  return '[과거 교사 교정 — 이전 판독에서 실제로 잘못 읽은 단어. 이 단어들은 인쇄된 글자를 한 글자씩 확인한다]\n'
    + top.map((c) => `- "${c.wrong}"로 잘못 읽음 → 원본은 "${c.right}" (${c.count}회)`).join('\n');
}

module.exports = { makeRule, updateRule, selectRules, grams, overlap, readingCorrections, recordCorrections, readingPairs, readingHint };
