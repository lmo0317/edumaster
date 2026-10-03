'use strict';
// 학습 지도 (docs/learning.md): what the 학습 page shows beside each item — how many problems carried it, whether the
// recent sets kept it, what it was learned from — and the items that may say the same thing (정리 후보). Two items are
// a candidate when their wording overlaps; the AI then decides whether they are one item and writes the merged
// sentence, and the teacher merges or skips. Merging keeps both originals on the item (mergedFrom).
const crypto = require('node:crypto');
const { grams, overlap, stageOf } = require('./learning');

// The recent sets an item's marks cover: the list shows the last 6, the heatmap all of them.
const SET_COLUMNS = 12;
const SIMILAR = 0.4;

/** The id an item's judgements count toward: an item merged into another counts for the one it was merged into. */
function aliasesOf(rules) {
  const to = new Map();
  for (const r of rules) for (const x of r.mergedFrom || []) to.set(x.id, r.id);
  return (id) => to.get(id) || id;
}

/**
 * The recent finished sets (oldest first) as columns, and per item: how many problems carried it (every set) and its
 * mark on each column — k kept, b broken (on any of the set's problems), u carried but not judged, - not carried.
 */
function setMarks(jobs, rules, columns = SET_COLUMNS) {
  const alias = aliasesOf(rules);
  const sets = jobs.filter((j) => j.type === 'generate' && (j.items || []).some((it) => it.verification)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const recent = sets.slice(-columns);
  const uses = new Map();
  const marks = new Map();
  for (const j of sets) {
    const col = recent.indexOf(j);
    for (const it of j.items || []) for (const r of it.verification?.rules || []) {
      const id = alias(r.id);
      uses.set(id, (uses.get(id) || 0) + 1);
      if (col < 0) continue;
      if (!marks.has(id)) marks.set(id, recent.map(() => '-'));
      const row = marks.get(id);
      const mark = !r.judged ? 'u' : r.judged.ok ? 'k' : 'b';
      if (row[col] === '-' || mark === 'b' || (mark === 'k' && row[col] === 'u')) row[col] = mark;
    }
  }
  return {
    sets: recent.map((j) => ({ id: j.id, at: j.createdAt, title: j.title || '', provider: j.options?.provider || '' })),
    uses: (id) => uses.get(id) || 0,
    marks: (id) => marks.get(id) || recent.map(() => '-'),
  };
}

/** What an item was learned from, in a sentence: the reason the AI gave, the problem the teacher wrote it on, the items merged into it. */
function evidenceOf(rule, jobsById) {
  const s = rule.source || {};
  const out = [];
  if (s.from === 'auto') {
    const why = jobsById.get(s.jobId)?.learned?.find((x) => x.id === rule.id)?.why;
    out.push(why ? `세트 리포트: ${why}` : `세트 리포트 (${s.label || '세트'})`);
  } else if (s.from === 'fix' || s.from === 'check') out.push(`${s.from === 'fix' ? '세트의 고칠 점' : '확인할 곳'}에서 선생님이 씀${s.label ? ` (${s.label})` : ''}`);
  else if (s.from === 'migrated') out.push('예전 지침·피드백에서 옮겨 옴');
  else if (s.label) out.push(`선생님이 씀 (${s.label})`);
  for (const x of rule.mergedFrom || []) out.push(`합친 학습: ${x.text}`);
  return out;
}

const pairKey = (a, b) => {
  const [x, y] = [a, b].sort((p, q) => p.id.localeCompare(q.id));
  return `${x.id}+${y.id}:${crypto.createHash('md5').update(x.text + '\n' + y.text).digest('hex').slice(0, 10)}`;
};
// Two items can become one when they reach the same problems: two every-problem items, one problem's items, or a
// problem's item and an every-problem item (the merged one is every-problem).
const sameReach = (a, b) => a.scope !== 'material' || b.scope !== 'material' || a.source?.materialId === b.source?.materialId;

/** Pairs of switched-on items of one stage whose wording overlaps, most similar first; a pair already decided is skipped. */
function mergePairs(rules, decided = {}) {
  const on = rules.filter((r) => r.status === 'approved').map((r) => ({ r, g: grams(r.text) }));
  const out = [];
  for (let i = 0; i < on.length; i++) for (let j = i + 1; j < on.length; j++) {
    const a = on[i].r, b = on[j].r;
    if (stageOf(a) !== stageOf(b) || !sameReach(a, b)) continue;
    const similarity = overlap(on[i].g, on[j].g);
    if (similarity < SIMILAR) continue;
    const key = pairKey(a, b);
    out.push({ key, a, b, similarity, decision: decided[key] || null });
  }
  return out.sort((p, q) => q.similarity - p.similarity);
}

/** The item that stays when two merge: 지침 over 공통 학습 over a problem's, then the older. */
function keeperOf(a, b) {
  const rank = (r) => (r.scope === 'material' ? 2 : r.layer === 'guide' ? 0 : 1);
  return rank(a) !== rank(b) ? (rank(a) < rank(b) ? [a, b] : [b, a]) : (a.createdAt <= b.createdAt ? [a, b] : [b, a]);
}

module.exports = { SET_COLUMNS, SIMILAR, setMarks, evidenceOf, mergePairs, pairKey, keeperOf, aliasesOf };
