'use strict';
// 문제 검수 (.claude/skills/problem-review): Claude and Gemini, given the original's images, review a finished set — the
// analysis and every problem, each solved by the reviewer itself — against scripts/review-criteria.md (final-review.js).
// The review is kept with the set (data/reviews/<set id>.json) and shown on its page as the 모델 비교 checklist.
// 검수하고 고치기 (jobs.js, 'check'): what the review finds goes back into the set — the analysis fixed against the
// images (pipeline.fixAnalysis), each problem a reviewer would not hand out made again with the faults as the teacher's
// note (the same remake as 🔄 다시 만들기, through the final review while made) — and the set is reviewed again.
const fs = require('node:fs');
const path = require('node:path');
const finalReview = require('./final-review');

const REVIEWERS = ['claude-cli', 'agy-cli'];
const NAME = { 'claude-cli': 'Claude', 'agy-cli': 'Gemini', 'codex-cli': 'GPT' };

const checkPath = (dataDir, setId) => path.join(dataDir, 'reviews', `${setId}.json`);
function readCheck(dataDir, setId) {
  try { return JSON.parse(fs.readFileSync(checkPath(dataDir, setId), 'utf8')); } catch { return null; }
}
function writeCheck(dataDir, setId, result) {
  fs.mkdirSync(path.dirname(checkPath(dataDir, setId)), { recursive: true });
  fs.writeFileSync(checkPath(dataDir, setId), JSON.stringify(result, null, 1));
}

const range = (m, st) => (st?.kind === 'upto' ? `원본 STEP 1${st.upto > 1 ? '~' + st.upto : ''}만 쓰는 연습 문제` : st?.kind === 'twin' ? `원본 STEP 1~${m.steps.length}을 모두 쓰는 최종 통합 문제 (원본과 다른 구조여야 함)` : '');

/** The set as the reviewers see it, and the record the page shows (the reviews are filled in as each model finishes). */
function checkRecord(material, set) {
  const items = (set.items || []).filter((it) => it.problem);
  return {
    material: { id: material.id, title: material.title, subject: material.subject, topic: material.topic, problem: material.problem.text, choices: material.problem.choices || [], answer: material.problem.answer, steps: material.steps.map((x) => ({ title: x.title, work: x.work })) },
    set: { id: set.id, createdAt: set.createdAt, provider: set.options?.provider, items: items.map((it) => ({ index: it.index, label: it.label, status: it.status, kind: it.stage?.kind || '', stage: range(material, it.stage), problem: it.problem.text, choices: it.problem.choices || [], answer: it.problem.answer, solution: (it.solution?.steps || []).map((x) => ({ step: x.step, title: x.title, work: x.work })) })) },
    at: new Date().toISOString(), reviews: {}, done: false,
  };
}

/**
 * One review of the set by each reviewer, in parallel. `call(provider, args)` makes the model call (each reviewer on its
 * own subscription, outside the set's budget); `save(record)` is called as each one finishes.
 */
async function reviewSet({ store, set, call, providers = REVIEWERS, images, save = () => {} }) {
  const material = store.materials.get(set.materialId);
  if (!material) throw new Error('문제를 찾지 못했습니다.');
  const record = checkRecord(material, set);
  const items = (set.items || []).filter((it) => it.problem);
  const system = finalReview.reviewSystem(material, store.rules.all());
  const text = finalReview.setText(material, items);
  save(record);
  await Promise.all(providers.map(async (p) => {
    const started = Date.now();
    try {
      const r = await call(p, { purpose: 'review', system, text, images, vision: true, maxTokens: 32000, effort: 'high' });
      record.reviews[p] = { seconds: Math.round((Date.now() - started) / 1000), usage: r.usage, review: r.data };
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      record.reviews[p] = { error: e.message, seconds: Math.round((Date.now() - started) / 1000) };
    }
    save(record);
  }));
  record.done = true;
  record.checklist = checklist(record);
  save(record);
  return record;
}

/** Problems a reviewer would not hand out as they are, with each reviewer's faults: [{index, label, faults}]. */
function failing(record) {
  const out = [];
  (record.set?.items || []).forEach((it, i) => {
    const faults = [];
    for (const [p, v] of Object.entries(record.reviews || {})) {
      if (v.error || !v.review) continue;
      const mine = v.review.items?.[i];
      faults.push(...finalReview.itemFaults({ items: mine ? [mine] : [] }).map((f) => `[${NAME[p] || p}] ${f}`));
    }
    if (faults.length) out.push({ index: it.index, label: it.label, faults });
  });
  return out;
}

/** What the reviewers found in the analysis (both of them, one list). */
function analysisIssues(record) {
  return Object.values(record.reviews || {}).flatMap((v) => (v.review?.analysis?.verdict === 'issues' ? v.review.analysis.issues || [] : []));
}

const WORST = { no: 3, partial: 2, ok: 1, na: 0 };
/**
 * The 모델 비교 checklist (final-review.js CHECKLIST) for each reviewer: a row is as good as its worst problem, with
 * which problem fell short; the score counts each problem's ✓ on each row as 1 and △ as half, – not at all.
 */
function checklist(record) {
  const rows = finalReview.CHECKLIST.flatMap((g) => g.items);
  const items = record.set?.items || [];
  const models = {};
  for (const [p, v] of Object.entries(record.reviews || {})) {
    if (v.error || !v.review) continue;
    const analysis = finalReview.checklistOf(v.review.analysis, { analysis: true });
    const per = items.map((it, i) => finalReview.checklistOf(v.review.items?.[i], { final: it.kind === 'twin' }));
    const marks = {};
    // The score counts every problem's own mark on each row (and the analysis'), not a row's worst: with the worst, one
    // problem's one fault took a ninth of the score, and one reviewer seeing it where the other did not moved the set
    // 11-33 points (gas original, 2026-10-21: 94 and 67 for the same set).
    const cells = [];
    for (const r of rows) {
      if (r.analysis) { marks[r.id] = analysis[r.id] || ['na', '']; cells.push(marks[r.id][0]); continue; }
      if (r.id === 'complete') {
        const left = items.filter((it) => !['passed', 'warning'].includes(it.status));
        marks[r.id] = left.length ? ['no', `${left.map((it) => it.label).join(', ')} 미완료`] : ['ok', `${items.length}문제 모두 완성`];
        cells.push(marks[r.id][0]);
        continue;
      }
      const mine = per.map((c, i) => [items[i].label, c[r.id] || ['na', '']]);
      cells.push(...mine.map(([, c]) => c[0]));
      const worst = mine.reduce((w, [, c]) => (WORST[c[0]] > WORST[w] ? c[0] : w), 'na');
      const notes = mine.filter(([, c]) => c[0] === 'no' || c[0] === 'partial').map(([label, c]) => `${label}: ${c[1]}`);
      marks[r.id] = [worst, notes.join(' / ') || (r.id === 'correct' ? `정답 ${mine.filter(([, c]) => c[0] === 'ok').length}/${items.length}` : '')];
    }
    const counted = Object.values(marks).filter((m) => m[0] !== 'na');
    const n = (g) => counted.filter((m) => m[0] === g).length;
    const scored = cells.filter((c) => c !== 'na');
    const score = scored.length ? Math.round(((scored.filter((c) => c === 'ok').length + scored.filter((c) => c === 'partial').length / 2) / scored.length) * 100) : null;
    models[p] = { marks, score, ok: n('ok'), partial: n('partial'), no: n('no') };
  }
  return { groups: finalReview.CHECKLIST.map((g) => ({ title: g.title, items: g.items.map(({ id, text }) => ({ id, text })) })), models };
}

/** Each reviewer's score of the set, null for one that failed (a lost connection, the subscription's limit). */
const scores = (record) => Object.fromEntries(REVIEWERS.map((p) => [p, record.checklist?.models?.[p]?.score ?? null]));
/**
 * Whether a reviewed set reached the 학습 반복 target: every reviewer at the target, no problem failing, the analysis
 * unfaulted. A reviewer that failed leaves the set unjudged, so the other's score alone never reaches it.
 */
const reaches = (record, target) => Object.values(scores(record)).every((s) => s != null && s >= target) && !failing(record).length && !analysisIssues(record).length;

/** The remake's note: what the reviewers found, for the writer to fix. */
const remakeNote = (f) => `Claude·Gemini 검수에서 이 문제에 걸린 점입니다. 모두 고친 문제를 새로 만듭니다.\n${f.faults.map((x) => `- ${x}`).join('\n')}`;

module.exports = { REVIEWERS, NAME, checkPath, readCheck, writeCheck, reviewSet, failing, analysisIssues, checklist, scores, reaches, remakeNote };
