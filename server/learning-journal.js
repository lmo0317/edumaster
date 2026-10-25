'use strict';
// AI 학습 (docs/learning.md §4): what the system learned by itself, as a journal the teacher reviews — set by set, what was
// learned, rewritten, dropped, merged, put to sleep or woken, with the set's scores and fault count beside it — and as a
// list of every system lesson ordered by what the record says it did (lessonEffects). No store of its own: the journal
// is read from what the sets left (job.learned, a 학습 반복's round.learned) and from each item's history.
const setCheck = require('./set-check');
const { bySystem, stageOf, layerOf, categoryOf } = require('./learning');

// Sets a lesson must have been in before it is judged kept: fewer and it is new.
const NEW_SETS = 3;

/** Which of the four groups a system lesson falls in: broken (cited or its fault came back), dormant, new, kept. */
function effectOf(rule, e = {}) {
  if (rule.status === 'dormant') return 'dormant';
  if (rule.status !== 'approved') return 'off';
  if ((e.cited || 0) > 0 || (e.recurred || 0) > 0) return 'broken';
  if ((e.sent || 0) < NEW_SETS) return 'new';
  return 'kept';
}

const KINDS = { add: '배움', revise: '고침', remove: '뺌', merge: '합침', sleep: '휴면', wake: '깨어남', teacher: '선생님 고침' };

/**
 * Every change the system made to its learning, grouped by the set it happened in (newest set first). A change the
 * teacher made by hand is grouped under no set. Each event says whether the item still exists and its state now.
 */
function journalOf(store) {
  const jobs = store.jobs.all();
  const rules = store.rules.all();
  const byId = new Map(rules.map((r) => [r.id, r]));
  const materials = new Map(store.materials.all().map((m) => [m.id, m]));
  const sets = jobs.filter((j) => j.type === 'generate' && Array.isArray(j.items));
  const setNo = new Map();
  for (const m of new Set(sets.map((j) => j.materialId))) sets.filter((j) => j.materialId === m).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).forEach((j, i) => setNo.set(j.id, i + 1));
  const setById = new Map(sets.map((j) => [j.id, j]));
  const groups = new Map();
  // A change outside a set — the teacher's own rewrite, the AI merging items it read as one — is grouped by what did it.
  const NO_SET = { teacher: '선생님이 직접', merge: 'AI가 같은 뜻을 합침' };
  const groupOf = (jobId, at, kind) => {
    const key = jobId || (NO_SET[kind] ? kind : 'teacher');
    if (groups.has(key)) return groups.get(key);
    const j = setById.get(jobId);
    const review = j && store.dataDir ? setCheck.readCheck(store.dataDir, j.id) : null;
    const g = {
      jobId: j ? j.id : '', materialId: j?.materialId || '', title: j ? materials.get(j.materialId)?.title || j.material?.title || j.title || '' : NO_SET[key] || NO_SET.teacher,
      setNo: j ? setNo.get(j.id) : 0, trainRound: j?.trainRound || 0, at: j ? j.finishedAt || j.createdAt : at,
      scores: review?.done && !review.stale ? setCheck.scores(review) : null, faultStats: j?.faultStats || null,
      gone: Boolean(jobId) && !j, events: [],
    };
    groups.set(key, g);
    return g;
  };
  const state = (id) => { const r = byId.get(id); return r ? { exists: true, status: r.status, text: r.text } : { exists: false }; };
  const push = (jobId, ev) => groupOf(jobId, ev.at, ev.kind).events.push({ ...ev, kindLabel: KINDS[ev.kind] || ev.kind, now: state(ev.id) });
  for (const j of jobs) {
    if (j.type === 'generate') {
      for (const l of j.learned || []) push(j.id, { kind: l.kind, id: l.id, text: l.text || '', before: l.before || '', why: l.why || '', at: j.finishedAt || j.createdAt, scope: l.scope || '' });
    } else if (j.type === 'train') {
      for (const r of j.rounds || []) for (const l of r.learned || []) push(r.setId, { kind: l.kind, id: l.id, text: l.text || '', before: l.before || '', why: l.why || '', at: r.at, scope: l.scope || '', train: true });
    }
  }
  // From the items themselves: merges, the data's sleep and wake, the teacher's rewrites. (A review's or report's
  // rewrite is already in the set's learned list.)
  for (const r of rules) {
    const h = r.history || [];
    h.forEach((x, i) => {
      const after = i + 1 < h.length ? h[i + 1].before : r.text;
      if (x.by === 'merge') push(x.jobId, { kind: 'merge', id: r.id, text: after, before: x.before, why: x.why || '', at: x.at, merged: (r.mergedFrom || []).map((m) => m.text) });
      else if (x.by === 'system' && x.status) push(x.jobId, { kind: x.status === 'dormant' ? 'sleep' : 'wake', id: r.id, text: r.text, why: x.why || '', at: x.at });
      else if (x.by === 'teacher' && bySystem(r)) push('', { kind: 'teacher', id: r.id, text: after, before: x.before, why: x.why || '', at: x.at });
    });
  }
  for (const g of groups.values()) {
    g.events.sort((a, b) => String(a.at).localeCompare(String(b.at)));
    if (!g.jobId) g.at = g.events.at(-1).at;
    g.subject = materials.get(g.materialId)?.subject || setById.get(g.jobId)?.material?.subject || '';
  }
  return [...groups.values()].filter((g) => g.events.length).sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

/** A system lesson as the AI 학습 list shows it: the item, where it was learned, and what the record says it did. */
function itemOf(r, e, titleOf) {
  return {
    id: r.id, text: r.text, why: r.why || '', example: r.example || null, stage: stageOf(r), layer: layerOf(r), scope: r.scope, target: r.target,
    status: r.status, createdAt: r.createdAt, updatedAt: r.updatedAt, subject: r.scope === 'material' ? '' : r.subject || '', topic: r.topic || '',
    category: categoryOf(r), from: r.source?.from || 'input', fromLabel: r.source?.label || '', jobId: r.source?.jobId || '',
    materialId: r.source?.materialId || '', materialTitle: titleOf(r.source?.materialId), faultKeys: (r.source?.faultKeys || []).length,
    history: (r.history || []).slice().reverse(), merged: (r.mergedFrom || []).map((m) => m.text), dormantAt: r.dormantAt || '',
    cited: e.cited || 0, citedSets: e.sets || 0, lastCitedAt: e.lastCitedAt || '', lastCitedJobId: e.lastCitedJobId || '',
    sent: e.sent || 0, recurred: e.recurred || 0, recurredSets: e.recurredSets || 0, lastRecurredAt: e.lastRecurredAt || '',
    effect: effectOf(r, e),
  };
}

module.exports = { journalOf, itemOf, effectOf, NEW_SETS, KINDS };
