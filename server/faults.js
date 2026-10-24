'use strict';
// 결함 기록: every fault found while a set's problems were made — the code checks, the independent solve, the final
// review, and Claude·Gemini's review of the finished set — kept as data and read back when the next problem is designed
// and reviewed. The next problem of this original sees what its earlier sets were faulted for (and what passed after);
// a problem of another original sees the faults that keep coming back in its subject and topic, or everywhere.
//
// Why this and not lessons alone: the lessons the system writes from faults (pipeline.learnFromSet / learnFromReview)
// are one sentence per fault kind, and the writer did not follow them — of 3,286 fault lines recorded by 2026-10-24,
// 638 were faults a lesson in the writer's prompt already named, 133 of them quoting the lesson; the faults of an
// original's n-th set were no fewer than its first's. The record of what actually went wrong, in the writer's own
// words with the problem it happened to, is the data; the lessons stay as general advice.
const finalReview = require('./final-review');
const setCheck = require('./set-check');
const { grams, overlap } = require('./learning');

// "최종 검수: [STEP 범위 · mid] …", "[두 번째 검수] [학습 · mid] …", "[Claude] [구조 · high] …"
const TAGGED = /^(?:최종 검수: )?(?:\[(?:두 번째 검수|Claude|Gemini|GPT)\] )*\[([^\]·]+?)(?: · (high|mid|low))?\]\s*([\s\S]*)$/;
// The code checks' own prefixes ("문제 설계: …", "독립 풀이 지적(missing): …").
const PREFIXED = /^(문제 설계|STEP 범위|해설|코드 검산|독립 풀이[^:：]*|손계산 수치|해설 보기 분석|보기·정답 연결|가정 방향|통합 변형|수치)\s*[:：]\s*([\s\S]*)$/;
// Not fault data: what the server lays out itself (the teacher's sentence frames) — the writer is asked for a value, not told.
const FORMAT_NOISE = /\[틀 \d+-\d+\]|틀 번호|자리 이름 그대로/;
// Attempts whose failures are faults of the problem or its solution (not a lost answer, not a frame value to fill).
const KINDS = new Set(['precheck', 'repair', 'redesign', 'rewrite']);

/** One fault line → its criteria name, severity, text and where it came from ('review' = a reviewer, 'check' = code or the solve). */
function parseFault(raw) {
  const text = String(raw || '').trim();
  const reviewed = /^(?:최종 검수: |\[(?:두 번째 검수|Claude|Gemini|GPT)\])/.test(text);
  let m = TAGGED.exec(text);
  if (m) return { rule: m[1].trim(), severity: m[2] || '', detail: m[3].trim(), from: reviewed ? 'review' : 'check' };
  m = PREFIXED.exec(text);
  if (m) return { rule: m[1].replace(/\(.*$/, '').replace(/\s*지적\s*$/, '').trim(), severity: '', detail: m[2].trim(), from: 'check' };
  return { rule: '검사', severity: '', detail: text, from: 'check' };
}

/** The kind of a fault, as text: numbers, quoted text, labels and STEP numbers dropped, the first letters kept. */
function faultKey(detail) {
  return String(detail || '')
    .replace(/\$[^$]*\$/g, ' ')
    .replace(/'[^']*'|"[^"]*"|‘[^’]*’|“[^”]*”|「[^」]*」/g, ' ')
    .replace(/\([가-힣]\)|[㉠-㉿ⓐ-ⓩ①-⑮ⅠⅡⅢⅣⅤⅥ]|STEP ?\d+(?:~\d+)?|\d+(?:[.,]\d+)?/g, ' ')
    .replace(/(?<![a-zA-Z])[a-zA-Z](?![a-zA-Z])/g, ' ') // a variable (a, w, x)
    .replace(/[^\p{L}]/gu, '')
    .slice(0, 28);
}

const stageKey = (s) => `${s?.kind || ''}:${s?.upto || s?.step || ''}`;
const squash = (t) => String(t || '').replace(/\s+/g, ' ').trim();

/**
 * The fault records of one set: every failure of every attempt that repaired, redesigned or rewrote a problem, what was
 * left unfixed, and (with the set's review) what Claude·Gemini found. A record carries the problem as it was when the
 * fault was found (attempts keep a snapshot since 2026-10-24) and, when the problem was made in the end, its final text.
 */
function recordsOf(job, review = null) {
  const out = [];
  const base = { materialId: job.materialId, title: job.material?.title || job.title || '', subject: job.material?.subject || '', topic: job.material?.topic || '', jobId: job.id };
  for (const it of job.items || []) {
    const fixed = ['passed', 'warning'].includes(it.status);
    const push = (raw, at, kind, problem, extra = {}) => {
      const p = parseFault(raw);
      if (p.severity === 'low' || FORMAT_NOISE.test(p.detail) || p.detail.length < 6) return;
      out.push({ ...base, at: at || job.createdAt, index: it.index, label: it.label, stage: it.stage || null, kind, ...p, key: faultKey(p.detail), fixed, problem: squash(problem), after: fixed ? squash(it.problem?.text) : '', ...extra });
    };
    for (const a of it.attempts || []) {
      if (!KINDS.has(a.kind)) continue;
      for (const f of a.failures || []) push(f, a.at, a.kind, a.problem);
    }
    for (const f of it.problems || []) push(f, job.finishedAt || job.updatedAt, 'left', it.problem?.text);
    for (const [p, v] of Object.entries(review?.reviews || {})) {
      if (v.error || !v.review) continue;
      const mine = finalReview.matchItem(v.review, it, job.items);
      for (const x of mine?.issues || []) {
        if (!x || !['high', 'mid'].includes(x.severity) || typeof x.detail !== 'string') continue;
        push(`[${x.rule || '기준'} · ${x.severity}] ${x.detail}`, review.at, 'review', it.problem?.text, { from: 'review', reviewer: setCheck.NAME[p] || p, fixed: false, after: '' });
      }
    }
  }
  return out;
}

/** Every record of the given sets (and of their reviews, when `dataDir` is given), newest first. */
function index(jobs, { dataDir = null, exclude = null } = {}) {
  const out = [];
  for (const j of jobs) {
    if (j.type !== 'generate' || !Array.isArray(j.items) || j.id === exclude) continue;
    const review = dataDir ? setCheck.readCheck(dataDir, j.id) : null;
    out.push(...recordsOf(j, review?.done ? review : null));
  }
  return out.sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

// A reviewer words the same fault differently each time; two review faults are the same kind when most of the shorter
// one's letter pairs are in the other.
const sameReviewFault = (a, b) => overlap(a, b) >= 0.5;

/** Records grouped by kind: {rule, detail (the newest), n, sets, materials, …}. */
function groupsOf(records) {
  const byKey = new Map();
  const groups = [];
  for (const r of records) {
    let g = byKey.get(r.key);
    if (!g && r.from === 'review') {
      const mine = grams(r.detail);
      g = groups.find((x) => x.rule === r.rule && x.reviewGrams && sameReviewFault(x.reviewGrams, mine)) || null;
    }
    if (!g) {
      g = { key: r.key, rule: r.rule, detail: r.detail, label: r.label, at: r.at, n: 0, sets: new Set(), materials: new Set(), subjects: new Set(), topics: new Set(), stages: new Set(), reviewers: new Set(), fixed: 0, example: null, reviewGrams: r.from === 'review' ? grams(r.detail) : null };
      byKey.set(r.key, g);
      groups.push(g);
    }
    g.n++; g.sets.add(r.jobId); g.materials.add(r.materialId); g.subjects.add(r.subject); g.topics.add(`${r.subject}|${r.topic}`); g.stages.add(stageKey(r.stage));
    if (r.reviewer) g.reviewers.add(r.reviewer);
    if (r.fixed) g.fixed++;
    // The newest record with the problem it happened to is the example (and, when it was made, how it ended up).
    if (!g.example && r.problem) g.example = { problem: r.problem, after: r.after && r.after !== r.problem ? r.after : '' };
  }
  return groups;
}

const WHERE = ['다른 과목의 원본', '같은 과목의 다른 원본', '같은 단원의 다른 원본', '이 원본'];
/**
 * What the writer (and the reviewer) of one problem should know went wrong before: this original's own faults first
 * (any number of times, newest first), then the faults of the same subject and topic, then what recurs in two sets or
 * more anywhere. Faults of the same stage (practice up to STEP n, final) come before the others. At most `limit`
 * entries and about `maxChars` characters.
 */
function forItem(records, material, item, { limit = 8, maxChars = 3600 } = {}) {
  const sk = stageKey(item.stage);
  const tier = (g) => (g.materials.has(material.id) ? 3 : g.topics.has(`${material.subject || ''}|${material.topic || ''}`) && material.topic ? 2 : g.subjects.has(material.subject || '') && material.subject ? 1 : 0);
  const scored = groupsOf(records).map((g) => ({ g, tier: tier(g) }))
    .filter(({ g, tier: t }) => t >= 2 || g.sets.size >= 2)
    .sort((a, b) => b.tier - a.tier || Number(b.g.stages.has(sk)) - Number(a.g.stages.has(sk)) || Math.min(b.g.sets.size, 5) - Math.min(a.g.sets.size, 5) || String(b.g.at).localeCompare(String(a.g.at)));
  const out = [];
  let chars = 0;
  for (const { g, tier: t } of scored) {
    const entry = { where: WHERE[t], own: t === 3, rule: g.rule, detail: g.detail.slice(0, 400), label: g.label, sets: g.sets.size, count: g.n, materials: g.materials.size, sameStage: g.stages.has(sk), fixed: g.fixed, reviewers: [...g.reviewers], example: t === 3 ? g.example : null };
    const size = entry.detail.length + (entry.example ? Math.min(240, entry.example.problem.length) + Math.min(240, entry.example.after.length) : 0) + 40;
    if (out.length >= limit || chars + size > maxChars) break;
    out.push(entry); chars += size;
  }
  return out;
}

/**
 * How a finished set did against the record: of its faults, how many were of a kind seen before in any set (`repeat`),
 * in this original's sets (`own`), and how many broke a lesson that was in the writer's prompt (`lesson`). The number to
 * drive down: a system that learns from its data makes the same fault less and less.
 */
function setStats(job, earlier, review = null) {
  const mine = recordsOf(job, review);
  const seen = new Set(earlier.map((r) => r.key));
  const ownSeen = new Set(earlier.filter((r) => r.materialId === job.materialId).map((r) => r.key));
  const reviewed = earlier.filter((r) => r.from === 'review').map((r) => ({ g: grams(r.detail), own: r.materialId === job.materialId }));
  const repeatOf = (r) => {
    if (seen.has(r.key)) return ownSeen.has(r.key) ? 'own' : 'other';
    if (r.from !== 'review') return '';
    const g = grams(r.detail);
    const hit = reviewed.filter((x) => sameReviewFault(x.g, g));
    return hit.length ? (hit.some((x) => x.own) ? 'own' : 'other') : '';
  };
  let repeat = 0, own = 0;
  for (const r of mine) { const k = repeatOf(r); if (k) repeat++; if (k === 'own') own++; }
  return { faults: mine.length, repeat, own, lesson: mine.filter((r) => r.rule === '학습').length, rate: mine.length ? Math.round((100 * repeat) / mine.length) : null };
}

/** The set's log line for its stats. */
function statsLine(s) {
  if (!s || !s.faults) return '결함 기록: 걸린 것 없이 완성';
  return `결함 기록: ${s.faults}건 — 전에 나온 종류 ${s.repeat}건 (${s.rate}%, 이 원본에서 ${s.own}건) · 지시문의 학습이 이미 말한 것 ${s.lesson}건`;
}

module.exports = { parseFault, faultKey, recordsOf, index, groupsOf, forItem, setStats, statsLine, FORMAT_NOISE, KINDS };
