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
const crypto = require('node:crypto');
const { materialKey } = require('./material-version');

const REVIEWERS = ['claude-cli', 'agy-cli'];
const NAME = { 'claude-cli': 'Claude', 'agy-cli': 'Gemini', 'codex-cli': 'GPT' };

const checkPath = (dataDir, setId) => path.join(dataDir, 'reviews', `${setId}.json`);
function readCheck(dataDir, setId) {
  try { return JSON.parse(fs.readFileSync(checkPath(dataDir, setId), 'utf8')); } catch { return null; }
}
function writeCheck(dataDir, setId, result) {
  fs.mkdirSync(path.dirname(checkPath(dataDir, setId)), { recursive: true });
  const file = checkPath(dataDir, setId);
  const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(result, null, 1));
  fs.renameSync(temp, file);
}

const contentKey = (set) => crypto.createHash('sha256').update(JSON.stringify([
  set.material ? materialKey(set.material) : null,
  (set.items || []).map((it) => [it.index, it.label, it.stage, it.problem, it.solution]),
])).digest('hex');

function matchesSet(record, set) {
  if (record.contentKey) return record.contentKey === contentKey(set);
  if (!set.material || !record.material || !record.set?.items) return false;
  // Older persisted reviews predate content keys. Compare the source and question/solution text they actually saw.
  const current = checkRecord(set.material, set);
  const source = (m) => [m.problem, m.choices, m.answer, m.steps];
  const items = (s) => s.items.map((it) => [it.index, it.label, it.problem, it.choices, it.answer, it.solution]);
  return JSON.stringify(source(record.material)) === JSON.stringify(source(current.material))
    && JSON.stringify(items(record.set)) === JSON.stringify(items(current.set));
}

function invalidateCheck(dataDir, setId) {
  const old = readCheck(dataDir, setId);
  if (!old) return;
  writeCheck(dataDir, setId, { ...old, stale: true, done: false, running: false, checklist: null,
    invalidatedAt: new Date().toISOString() });
}

function normalizeReview(review, items) {
  return { ...review, items: items.map((it) => finalReview.matchItem(review, it, items) || {
    index: it.index, label: it.label, answerOk: false, verdict: 'fix', checks: {},
    issues: [{ severity: 'high', rule: '검수 응답', detail: '이 문항의 검수 결과가 누락되었거나 문항 식별자가 중복·불일치합니다. 다시 검수해야 합니다.' }],
  }) };
}

// Recovery covers check jobs and training rounds, including a crash between writing the review and finishing its job.
function recoverChecks(dataDir) {
  const dir = path.join(dataDir, 'reviews');
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    if (!/^[a-f0-9]+\.json$/.test(name)) continue;
    const id = name.slice(0, -5), rec = readCheck(dataDir, id);
    if (rec?.running) writeCheck(dataDir, id, { ...rec, running: false, done: false, interrupted: true, error: '서버 재시작으로 검수가 중단되었습니다. 다시 검수해 주세요.' });
  }
}

const range = (m, st) => (st?.kind === 'upto' ? `원본 STEP 1${st.upto > 1 ? '~' + st.upto : ''}만 쓰는 연습 문제` : st?.kind === 'twin' ? `원본 STEP 1~${m.steps.length}을 모두 쓰는 최종 통합 문제 (원본과 다른 구조여야 함)` : '');

/** The set as the reviewers see it, and the record the page shows (the reviews are filled in as each model finishes). */
function checkRecord(material, set) {
  const items = (set.items || []).filter((it) => it.problem);
  return {
    material: { id: material.id, title: material.title, subject: material.subject, topic: material.topic, problem: material.problem.text, choices: material.problem.choices || [], answer: material.problem.answer, steps: material.steps.map((x) => ({ title: x.title, work: x.work })) },
    set: { id: set.id, createdAt: set.createdAt, provider: set.options?.provider, items: items.map((it) => ({ index: it.index, label: it.label, status: it.status, kind: it.stage?.kind || '', stage: range(material, it.stage), problem: it.problem.text, choices: it.problem.choices || [], answer: it.problem.answer, solution: (it.solution?.steps || []).map((x) => ({ step: x.step, title: x.title, work: x.work })) })) },
    at: new Date().toISOString(), contentKey: contentKey(set), reviews: {}, done: false,
  };
}

/**
 * One review of the set by each reviewer, in parallel. `call(provider, args)` makes the model call (each reviewer on its
 * own subscription, outside the set's budget); `save(record)` is called as each one finishes.
 */
async function reviewSet({ store, set, call, providers = REVIEWERS, images, save = () => {} }) {
  const material = set.material || store.materials.get(set.materialId);
  if (!material) throw new Error('문제를 찾지 못했습니다.');
  const record = checkRecord(material, set);
  const items = (set.items || []).filter((it) => it.problem);
  // Judged with the learning the set was made with (its snapshot), not with what the store holds now: a 학습 반복's set
  // was reviewed against lessons added after it was made, which its writer had never seen.
  const system = finalReview.reviewSystem(material, store.rules.all(), set.rules?.length ? set.rules : null);
  const text = finalReview.setText(material, items);
  if (material.images && store.files) images = require('./pipeline').originalImages(store, material);
  save(record);
  const completed = await Promise.allSettled(providers.map(async (p) => {
    const started = Date.now();
    try {
      const responses = [];
      for (let attempt = 0; attempt < 2; attempt++) {
        const retry = attempt ? '\n[이전 응답의 문항 식별자가 불일치했습니다]\n아래 응답을 다시 확인하여 각 문항의 index와 label을 위 식별자 목록과 정확히 맞춘 완전한 JSON을 반환하세요. 다른 문항의 판정을 옮기지 말고 실제 문항 내용과 대응을 확인하세요.\n' + JSON.stringify(responses[0].review) : '';
        const r = await call(p, { purpose: 'review', system, text: text + retry, images, vision: true, maxTokens: 32000, effort: 'high' });
        responses.push({ usage: r.usage, review: r.data });
        const usage = responses.reduce((sum, response) => {
          for (const [key, value] of Object.entries(response.usage || {})) if (typeof value === 'number') sum[key] = (sum[key] || 0) + value;
          return sum;
        }, {});
        const valid = Array.isArray(r.data?.items) && r.data.items.length === items.length
          && items.every(it => finalReview.matchItem(r.data, it, items));
        record.reviews[p] = { seconds: Math.round((Date.now() - started) / 1000), usage, responses,
          ...(valid ? { review: normalizeReview(r.data, items) } : { error: '검수 응답의 문항 식별자가 누락·중복·불일치합니다. 정답 오류 판정이 아니며 다시 검수해야 합니다.' }) };
        save(record);
        if (valid) break;
      }
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      record.reviews[p] = { ...record.reviews[p], error: e.message, seconds: Math.round((Date.now() - started) / 1000) };
    }
    save(record);
  }));
  const rejected = completed.find((r) => r.status === 'rejected');
  if (rejected) throw rejected.reason;
  record.done = true;
  record.checklist = checklist(record, advisoryOf(store, set));
  save(record);
  return record;
}

/**
 * Problems a reviewer would not hand out as they are, with each reviewer's faults: [{index, label, faults}]. A problem
 * in `settled` (both reviewers passed it in an earlier round and it was carried over unchanged) is not among them: the
 * same final of bio-k61 passed the set review in one round and was failed in the next, by the same reviewer, over two
 * lessons (2026-10-23) — a verdict that flips on unchanged content is noise, and acting on it remade a passed problem.
 */
function failing(record, settled = null, advisory = []) {
  const out = [];
  (record.set?.items || []).forEach((it, i) => {
    if (settled?.has(it.index)) return;
    const faults = [];
    for (const [p, v] of Object.entries(record.reviews || {})) {
      if (v.error || !v.review) continue;
      const mine = finalReview.matchItem(v.review, it, record.set.items);
      faults.push(...finalReview.itemFaults({ items: mine ? [mine] : [] }, { advisory, answer: it.problem?.answer }).map((f) => `[${NAME[p] || p}] ${f}`));
    }
    if (faults.length) out.push({ index: it.index, label: it.label, faults });
  });
  return out;
}

/** What the reviewers found in the analysis (both of them, one list). */
// A low note (wording, a title) on the analysis is kept out, as it is on the problems: one blocked the target while the
// same note on a problem cost nothing.
function analysisIssues(record) {
  return Object.values(record.reviews || {}).filter((v) => !v.error).flatMap((v) => finalReview.analysisFaults(v.review?.analysis)).filter((x) => x.severity !== 'low');
}

const WORST = { no: 3, partial: 2, ok: 1, na: 0 };
/**
 * The 모델 비교 checklist (final-review.js CHECKLIST) for each reviewer: a row is as good as its worst problem, with
 * which problem fell short; the score counts each problem's ✓ on each row as 1 and △ as half, – not at all.
 */
function checklist(record, advisory = []) {
  const rows = finalReview.CHECKLIST.flatMap((g) => g.items);
  const items = record.set?.items || [];
  const models = {};
  for (const [p, v] of Object.entries(record.reviews || {})) {
    if (v.error || !v.review) continue;
    const analysis = finalReview.checklistOf(v.review.analysis, { analysis: true });
    const per = items.map((it) => {
      const mine = finalReview.matchItem(v.review, it, items);
      if (!mine) return Object.fromEntries(rows.filter((r) => !r.analysis).map((r) => [r.id, ['no', '문항 검수 결과 누락·불일치']]));
      return finalReview.checklistOf(mine, { final: it.kind === 'twin', advisory, answer: it.problem?.answer });
    });
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
const reaches = (record, target, settled = null, advisory = []) => !record.stale && !record.interrupted && record.set?.items?.length > 0 && Object.values(scores(record)).every((s) => s != null && s >= target) && !failing(record, settled, advisory).length && !analysisIssues(record).length;

/** The system's own lessons among the rules the set was made with: advice to the writer, not what the review judges by. */
const advisoryOf = (store, set) => finalReview.advisoryTexts(set.material || store.materials.get(set.materialId) || {}, store.rules.all(), set.rules?.length ? set.rules : null);

/** The remake's note: what the reviewers found, for the writer to fix. */
const remakeNote = (f) => `Claude·Gemini 검수에서 이 문제에 걸린 점입니다. 모두 고친 문제를 새로 만듭니다.\n${f.faults.map((x) => `- ${x}`).join('\n')}`;

module.exports = { REVIEWERS, NAME, checkPath, readCheck, writeCheck, invalidateCheck, recoverChecks, contentKey, matchesSet, normalizeReview, checkRecord, reviewSet, failing, analysisIssues, checklist, scores, reaches, advisoryOf, remakeNote };
