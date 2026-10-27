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
//
// The same records say what the data is worth (docs/learning.md, 결함 기록·본보기·학습의 수명): a problem both reviewers
// passed is an example for the next writer (passedIndices); a lesson the system wrote is measured by how often a review
// cited it as broken (lessonEffects), put to sleep when no review of its reach cited it for a window of sets
// (sleepLessons) and woken when the fault it was learned from comes back (wakeLessons); a set the teacher deletes
// leaves its records behind (archive). Nothing here is decided by the teacher: the data decides.
const fs = require('node:fs');
const path = require('node:path');
const finalReview = require('./final-review');
const setCheck = require('./set-check');
const { grams, overlap, stageOf, updateRule } = require('./learning');

// "최종 검수: [STEP 범위 · mid] …", "[두 번째 검수] [학습 · mid] …", "[Claude] [구조 · high] …"
const TAGGED = /^(?:최종 검수: )?(?:\[(?:두 번째 검수|Claude|Gemini|GPT)\] )*\[([^\]·]+?)(?: · (high|mid|low))?\]\s*([\s\S]*)$/;
// The code checks' own prefixes ("문제 설계: …", "독립 풀이 지적(missing): …").
const PREFIXED = /^(문제 설계|STEP 범위|해설|코드 검산|독립 풀이[^:：]*|손계산 수치|해설 보기 분석|보기·정답 연결|가정 방향|통합 변형|수치)\s*[:：]\s*([\s\S]*)$/;
// Not fault data: what the server lays out itself (the teacher's sentence frames) — the writer is asked for a value, not
// told — and the lines that say a review did not happen or could not be read.
const FORMAT_NOISE = /\[틀 \d+-\d+\]|틀 번호|자리 이름 그대로|최종 검수까지 가지 못했습니다|^통과하지 못함$|결과를 내지 못했습니다|다시 검수해야 합니다/;
// Attempts whose failures are faults of the problem or its solution (not a lost answer, not a frame value to fill).
const KINDS = new Set(['precheck', 'repair', 'redesign', 'rewrite']);
// A fault that restates a lesson: it names the lesson, not a kind of fault of its own.
const LESSON_RULE = /^(학습|AI 학습 참고)$/;
// Lessons the system wrote itself (learnFromSet 'auto', learnFromReview 'review', a harness evaluation 'eval').
const SYSTEM_FROM = new Set(['auto', 'review', 'eval']);
const bySystem = (r) => SYSTEM_FROM.has(r.source?.from);

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
const newestFirst = (a, b) => String(b.at).localeCompare(String(a.at));

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

/** The records a set left when it was deleted (archive), one file per set under data/faults. */
function archived(dataDir, except = new Set()) {
  const dir = path.join(dataDir, 'faults');
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json') || except.has(name.slice(0, -5))) continue;
    try { out.push(...(JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')).records || [])); } catch { /* a half-written file is skipped */ }
  }
  return out;
}

/** Keeps a set's records (the problem texts shortened) before the set itself is deleted: the data outlives the set. */
function archive(dataDir, job, review = null) {
  const records = recordsOf(job, review).map((r) => ({ ...r, problem: r.problem.slice(0, 600), after: r.after.slice(0, 600) }));
  if (!records.length) return 0;
  const dir = path.join(dataDir, 'faults');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${job.id}.json`);
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify({ jobId: job.id, materialId: job.materialId, title: job.material?.title || job.title || '', archivedAt: new Date().toISOString(), records }, null, 1));
  fs.renameSync(temp, file);
  return records.length;
}

/** Every record of the given sets (and of their reviews and of deleted sets, when `dataDir` is given), newest first. */
function index(jobs, { dataDir = null, exclude = null } = {}) {
  const out = [];
  for (const j of jobs) {
    if (j.type !== 'generate' || !Array.isArray(j.items) || j.id === exclude) continue;
    const review = dataDir ? setCheck.readCheck(dataDir, j.id) : null;
    out.push(...recordsOf(j, review?.done ? review : null));
  }
  if (dataDir) out.push(...archived(dataDir, new Set(jobs.map((j) => j.id))));
  return out.sort(newestFirst);
}

// A reviewer words the same fault differently each time ("원본과 달라진 항목이 (2) 하나뿐이어서 숫자만 바꾼 문제다", "구조 변형
// 기준 세 항목 중 하나만 원본과 다르므로 숫자만 바꾼 문제다", "원본과 다른 항목이 하나도 없어 숫자만 바꾼 문제이다"), then
// gives evidence particular to the problem. Two review faults are the same kind when most of the shorter one's letter
// pairs are in the other, or when their first sentences — the verdict, before the evidence — mostly agree once labels,
// numbers and variables are taken out. Measured over 123 sets on 2026-10-25: the "numbers-only final" kind alone was 24
// records in 20 sets of 13 originals, split by wording into eleven groups and so never offered as one recurring kind.
const firstSentence = (detail) => String(detail || '').replace(/\$[^$]*\$/g, ' ').split(/(?<=[.다요음임])\s+|[:：]\s/)[0].slice(0, 120);
const kindText = (text) => String(text || '').replace(/[㉠-㉿ⓐ-ⓩ①-⑮]|\(\d\)|\d+(?:[.,]\d+)?|[a-zA-Z]_?\d*/g, ' ');
const gramsOfReview = (detail) => ({ full: grams(detail), first: grams(kindText(firstSentence(detail))) });
const sameReviewFault = (a, b) => overlap(a.full, b.full) >= 0.5 || overlap(a.first, b.first) >= 0.35;

/** Records grouped by kind: {rule, detail (the newest), n, sets, materials, …}. */
function groupsOf(records) {
  const byKey = new Map();
  const groups = [];
  for (const r of [...records].sort(newestFirst)) {
    let g = byKey.get(r.key);
    if (!g && r.from === 'review') {
      const mine = gramsOfReview(r.detail);
      g = groups.find((x) => x.rule === r.rule && x.reviewGrams && sameReviewFault(x.reviewGrams, mine)) || null;
    }
    if (!g) {
      g = { key: r.key, rule: r.rule, detail: r.detail, label: r.label, at: r.at, n: 0, sets: new Set(), materials: new Set(), subjects: new Set(), topics: new Set(), stages: new Set(), reviewers: new Set(), fixed: 0, example: null, reviewGrams: r.from === 'review' ? gramsOfReview(r.detail) : null };
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
// Faults of other originals are offered only while they keep coming: a kind last seen before the most recent sets is
// history, not advice (the records stay; the offer window moves).
const OFFER_WINDOW = 12;
/**
 * What the writer (and the reviewer) of one problem should know went wrong before: this original's own faults first
 * (any number of times, newest first), then the faults of the same subject and topic, then what recurs in two sets or
 * more anywhere — the others only when seen within the last `window` sets. Faults of the same stage (practice up to
 * STEP n, final) come before the others. At most `limit` entries and about `maxChars` characters.
 */
function forItem(records, material, item, { limit = 8, maxChars = 3600, window = OFFER_WINDOW } = {}) {
  const sk = stageKey(item.stage);
  const recent = new Set([...new Set([...records].sort(newestFirst).map((r) => r.jobId))].slice(0, window));
  const tier = (g) => (g.materials.has(material.id) ? 3 : g.topics.has(`${material.subject || ''}|${material.topic || ''}`) && material.topic ? 2 : g.subjects.has(material.subject || '') && material.subject ? 1 : 0);
  // A fault that restates a lesson ('학습') says nothing the lesson in the writer's prompt does not; offered again as a
  // record it would only weigh that lesson up — for a lesson the system wrote itself, back to the bar that stalled bio-k61.
  const scored = groupsOf(records).filter((g) => !LESSON_RULE.test(g.rule)).map((g) => ({ g, tier: tier(g) }))
    .filter(({ g, tier: t }) => (t >= 2 || g.sets.size >= 2) && (t === 3 || [...g.sets].some((id) => recent.has(id))))
    .sort((a, b) => b.tier - a.tier || Number(b.g.stages.has(sk)) - Number(a.g.stages.has(sk)) || Math.min(b.g.sets.size, 5) - Math.min(a.g.sets.size, 5) || String(b.g.at).localeCompare(String(a.g.at)));
  const out = [];
  let chars = 0;
  for (const { g, tier: t } of scored) {
    const entry = { where: WHERE[t], own: t === 3, rule: g.rule, detail: g.detail.slice(0, 2000), label: g.label, sets: g.sets.size, count: g.n, materials: g.materials.size, sameStage: g.stages.has(sk), fixed: g.fixed, reviewers: [...g.reviewers], example: t === 3 ? g.example : null };
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
  const reviewed = earlier.filter((r) => r.from === 'review').map((r) => ({ g: gramsOfReview(r.detail), rule: r.rule, own: r.materialId === job.materialId }));
  const repeatOf = (r) => {
    if (seen.has(r.key)) return ownSeen.has(r.key) ? 'own' : 'other';
    if (r.from !== 'review') return '';
    const g = gramsOfReview(r.detail);
    const hit = reviewed.filter((x) => x.rule === r.rule && sameReviewFault(x.g, g));
    return hit.length ? (hit.some((x) => x.own) ? 'own' : 'other') : '';
  };
  let repeat = 0, own = 0;
  for (const r of mine) { const k = repeatOf(r); if (k) repeat++; if (k === 'own') own++; }
  return { faults: mine.length, repeat, own, lesson: mine.filter((r) => LESSON_RULE.test(r.rule)).length, rate: mine.length ? Math.round((100 * repeat) / mine.length) : null };
}

/** The set's log line for its stats. */
function statsLine(s) {
  if (!s || !s.faults) return '결함 기록: 걸린 것 없이 완성';
  return `결함 기록: ${s.faults}건 — 전에 나온 종류 ${s.repeat}건 (${s.rate}%, 이 원본에서 ${s.own}건) · 지시문의 학습이 이미 말한 것 ${s.lesson}건`;
}

// ---------------------------------------------------------------- what worked: problems both reviewers passed
/**
 * The problems of a set that every reviewer passed in the review kept with it (검수하기, 학습 반복): none when there is
 * no review, it is stale, or a reviewer failed. With the review's scores. These are examples for the next writer as
 * much as the ones the teacher adopted — no problem had been adopted by hand on the production server by 2026-10-24.
 */
function passedProblems(store, job) {
  const review = store.dataDir ? setCheck.readCheck(store.dataDir, job.id) : null;
  if (!review?.done || review.stale || !setCheck.matchesSet(review, job)) return { indices: new Set(), scores: {} };
  const reviews = Object.values(review.reviews || {});
  if (reviews.length < 2 || reviews.some((v) => v.error || !v.review)) return { indices: new Set(), scores: {} };
  const failed = new Set(setCheck.failing(review, null, setCheck.advisoryOf(store, job)).map((f) => f.index));
  return { indices: new Set((job.items || []).filter((it) => it.problem && ['passed', 'warning'].includes(it.status) && !failed.has(it.index)).map((it) => it.index)), scores: setCheck.scores(review) };
}

// ---------------------------------------------------------------- what a lesson is worth
/**
 * What the record says of each rule: how often a review cited it as broken (a '학습' fault restating it) and when last;
 * with the sets given, how many finished sets had it in their prompt (`sent`) and how many faults of the kinds it was
 * learned from came back after it, within its reach (`recurred`) — the two numbers the AI 학습 page sorts by
 * (docs/learning.md §4): a lesson in n prompts with its fault back m times is not working, whatever it says.
 */
function lessonEffects(rules, records, jobs = []) {
  const cites = records.filter((r) => LESSON_RULE.test(r.rule)).sort(newestFirst);
  const done = jobs.filter((j) => j.type === 'generate' && j.status === 'done' && Array.isArray(j.items));
  const out = new Map();
  for (const rule of rules) {
    const hits = cites.filter((c) => finalReview.restates(rule.text, c.detail));
    const keys = new Set(rule.source?.faultKeys || []);
    const recurred = keys.size ? records.filter((r) => String(r.at) > String(rule.createdAt) && r.jobId !== rule.source?.jobId && reachesRecord(rule, r) && keys.has(r.key)) : [];
    out.set(rule.id, {
      cited: hits.length, sets: new Set(hits.map((h) => h.jobId)).size, lastCitedAt: hits[0]?.at || '', lastCitedJobId: hits[0]?.jobId || '',
      sent: done.filter((j) => j.createdAt > rule.createdAt && sentTo(rule, j)).length,
      recurred: recurred.length, recurredSets: new Set(recurred.map((r) => r.jobId)).size, lastRecurredAt: recurred.sort(newestFirst)[0]?.at || '',
    });
  }
  return out;
}

// The sets a lesson reaches: its original's, its subject's, or every set.
const reachesJob = (rule, job) => (rule.scope === 'material' ? job.materialId === rule.source?.materialId : !rule.subject || (job.material?.subject || '') === rule.subject);
const reachesRecord = (rule, r) => (rule.scope === 'material' ? r.materialId === rule.source?.materialId : !rule.subject || (r.subject || '') === rule.subject);
const SLEEP_WINDOW = 10;

// Whether a set's writer had the lesson in its prompt (the set keeps the rules it was made with); an older set without
// that list counts by reach.
const sentTo = (rule, job) => (Array.isArray(job.rules) && job.rules.length ? job.rules.some((r) => (typeof r === 'string' ? r : r.id) === rule.id) : reachesJob(rule, job));

/**
 * A lesson the system wrote itself goes to sleep when the last `window` finished sets whose writer had it (made after
 * it) had no review citing it: it took room in the prompt that many times with no effect anyone could see. It is no
 * longer sent, keeps its record, and wakes when its fault comes back (wakeLessons). Sets it was not sent to (another
 * topic's, past the cap) do not count — a lesson about graph axes is not judged by sets without a graph. The teacher's
 * own items never sleep. Returns what changed.
 */
function sleepLessons(store, records, { window = SLEEP_WINDOW, now = new Date() } = {}) {
  const sets = store.jobs.all().filter((j) => j.type === 'generate' && j.status === 'done' && Array.isArray(j.items)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const cites = records.filter((r) => LESSON_RULE.test(r.rule));
  const changes = [];
  for (const rule of store.rules.all()) {
    if (rule.status !== 'approved' || stageOf(rule) !== 'generation' || !bySystem(rule)) continue;
    const mine = sets.filter((j) => j.createdAt > rule.createdAt && sentTo(rule, j)).slice(0, window);
    if (mine.length < window) continue;
    const ids = new Set(mine.map((j) => j.id));
    if (cites.some((c) => ids.has(c.jobId) && finalReview.restates(rule.text, c.detail))) continue;
    const why = `지시문에 들어간 최근 ${window}세트에서 검수가 한 번도 인용하지 않음`;
    store.rules.put({ ...updateRule(rule, { status: 'dormant' }, now, { why, by: 'system' }), dormantAt: now.toISOString() });
    changes.push({ kind: 'sleep', id: rule.id, text: rule.text, why });
  }
  return changes;
}

/**
 * A sleeping lesson wakes when a new set's records hold the fault it was learned from (source.faultKeys, kept since
 * 2026-10-24; older lessons by wording) within its reach. Returns what changed.
 */
function wakeLessons(store, fresh, { now = new Date() } = {}) {
  const changes = [];
  if (!fresh.length) return changes;
  for (const rule of store.rules.all()) {
    if (rule.status !== 'dormant') continue;
    const keys = new Set(rule.source?.faultKeys || []);
    const g = grams(rule.text);
    const hit = fresh.find((r) => reachesRecord(rule, r) && (keys.size ? keys.has(r.key) : overlap(g, grams(r.detail)) >= 0.35));
    if (!hit) continue;
    const why = `배운 결함이 다시 나타남: ${hit.detail.slice(0, 80)}`;
    const next = updateRule(rule, { status: 'approved' }, now, { why, by: 'system', jobId: hit.jobId });
    delete next.dormantAt;
    store.rules.put(next);
    changes.push({ kind: 'wake', id: rule.id, text: rule.text, why });
  }
  return changes;
}

/** The fault keys of a list of fault texts (what a lesson was learned from). */
const keysOf = (texts) => [...new Set(texts.map((t) => faultKey(parseFault(t).detail)).filter(Boolean))].slice(0, 40);

// ---------------------------------------------------------------- the data of one original, for its page
/**
 * What the problem page shows under 문제 생성 (이 원본의 기록): every set of the original in time order with its review
 * scores and fault stats, the kinds of fault that came back and whether they stopped, and what the next final problem's
 * writer would get.
 */
function materialView(store, material, history) {
  const sets = store.jobs.all().filter((j) => j.type === 'generate' && j.materialId === material.id && Array.isArray(j.items)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const mine = history.filter((r) => r.materialId === material.id);
  const rows = sets.map((j, i) => {
    const earlier = history.filter((r) => r.jobId !== j.id && String(r.at) < String(j.createdAt));
    const review = store.dataDir ? setCheck.readCheck(store.dataDir, j.id) : null;
    const stats = j.faultStats || setStats(j, earlier, review?.done ? review : null);
    const items = j.items || [];
    return {
      id: j.id, no: i + 1, at: j.createdAt, status: j.status, trainRound: j.trainRound || 0,
      scores: review?.done && !review.stale ? setCheck.scores(review) : null,
      made: items.filter((it) => ['passed', 'warning'].includes(it.status)).length, items: items.length,
      repairs: items.reduce((n, it) => n + (it.attempts || []).filter((a) => a.kind === 'repair').length, 0),
      redesigns: items.reduce((n, it) => n + (it.attempts || []).filter((a) => a.kind === 'redesign').length, 0),
      ...stats,
    };
  });
  const recentIds = new Set(sets.slice(-3).map((j) => j.id));
  const kinds = groupsOf(mine).filter((g) => !LESSON_RULE.test(g.rule)).map((g) => ({
    rule: g.rule, detail: g.detail.slice(0, 160), label: g.label, sets: g.sets.size, count: g.n, lastAt: g.at,
    lastSetNo: rows.find((s) => [...g.sets].includes(s.id) && s.at === rows.filter((x) => g.sets.has(x.id)).map((x) => x.at).sort().at(-1))?.no || 0,
    active: [...g.sets].some((id) => recentIds.has(id)),
  })).sort((a, b) => b.sets - a.sets || String(b.lastAt).localeCompare(String(a.lastAt))).slice(0, 12);
  const offered = forItem(history, material, { stage: { kind: 'twin' } }).map((e) => ({ where: e.where, rule: e.rule, detail: e.detail.slice(0, 160), sets: e.sets, label: e.label, example: Boolean(e.example?.after) }));
  return { sets: rows, kinds, offered, records: mine.length };
}

// ---------------------------------------------------------------- the data of every original, for 학습 › 기록
/**
 * What the 기록 page shows (docs/learning.md §4): every set in time order with its scores and how many of its faults
 * were kinds already seen (what scripts/fault-recurrence.js prints), the same per original, the kinds that came back in
 * two sets or more and whether they still do (the last three sets), and the problems that are examples for the next
 * writer (adopted, or passed by both reviewers).
 */
function recordsView(store) {
  const jobsAll = store.jobs.all();
  const history = index(jobsAll, { dataDir: store.dataDir });
  const sets = jobsAll.filter((j) => j.type === 'generate' && Array.isArray(j.items) && j.items.some((it) => it.attempts?.length)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const materials = new Map(store.materials.all().map((m) => [m.id, m]));
  const no = new Map();
  for (const m of new Set(sets.map((j) => j.materialId))) sets.filter((j) => j.materialId === m).forEach((j, i) => no.set(j.id, i + 1));
  const rows = sets.map((j) => {
    const earlier = history.filter((r) => r.jobId !== j.id && String(r.at) < String(j.createdAt));
    const review = store.dataDir ? setCheck.readCheck(store.dataDir, j.id) : null;
    const stats = j.faultStats || setStats(j, earlier, review?.done ? review : null);
    const items = j.items || [];
    return {
      id: j.id, no: no.get(j.id), at: j.createdAt, status: j.status, trainRound: j.trainRound || 0, materialId: j.materialId,
      title: j.material?.title || j.title || '', subject: j.material?.subject || '',
      scores: review?.done && !review.stale ? setCheck.scores(review) : null,
      made: items.filter((it) => ['passed', 'warning'].includes(it.status)).length, items: items.length, ...stats,
    };
  });
  const sum = (list, k) => list.reduce((n, s) => n + (s[k] || 0), 0);
  const totalsOf = (list) => { const faults = sum(list, 'faults'), repeat = sum(list, 'repeat'); return { sets: list.length, faults, repeat, own: sum(list, 'own'), lesson: sum(list, 'lesson'), rate: faults ? Math.round((100 * repeat) / faults) : null }; };
  // Deleted originals keep their archived records: they count in the totals and show as one line.
  const ids = [...new Set([...rows.map((s) => s.materialId), ...history.map((r) => r.materialId)])];
  const originals = ids.map((id) => {
    const m = materials.get(id);
    const mine = rows.filter((s) => s.materialId === id);
    const recs = history.filter((r) => r.materialId === id);
    const last = mine.at(-1);
    return { id, title: m?.title || recs[0]?.title || '지워진 문제', subject: m?.subject || recs[0]?.subject || '', topic: m?.topic || '', gone: !m, ...totalsOf(mine),
      records: recs.length, lastAt: last?.at || recs[0]?.at || '', lastScores: last?.scores || null };
  }).sort((a, b) => String(b.lastAt).localeCompare(String(a.lastAt)));
  const recentIds = new Set(rows.slice(-3).map((s) => s.id));
  const kinds = groupsOf(history).filter((g) => !LESSON_RULE.test(g.rule) && g.sets.size >= 2).map((g) => ({
    rule: g.rule, detail: g.detail.slice(0, 200), label: g.label, count: g.n, sets: g.sets.size, materials: g.materials.size,
    titles: [...g.materials].map((id) => materials.get(id)?.title || '지워진 문제').slice(0, 6), lastAt: g.at, active: [...g.sets].some((id) => recentIds.has(id)), fixed: g.fixed,
  })).sort((a, b) => b.sets - a.sets || b.count - a.count).slice(0, 40);
  const examples = [];
  for (const j of [...sets].reverse()) {
    const passed = passedProblems(store, j);
    for (const it of j.items || []) {
      const source = it.adopted ? 'adopted' : passed.indices.has(it.index) ? 'passed' : '';
      if (!source || !it.problem?.text) continue;
      examples.push({ jobId: j.id, setNo: no.get(j.id), index: it.index, label: it.label, source, materialId: j.materialId, title: j.material?.title || j.title || '', scores: source === 'passed' ? passed.scores : null, preview: squash(it.problem.text).slice(0, 140) });
    }
  }
  return { totals: totalsOf(rows), sets: rows.slice().reverse(), originals, kinds, examples: examples.slice(0, 60), records: history.length };
}

module.exports = { parseFault, faultKey, keysOf, recordsOf, index, archive, archived, groupsOf, forItem, setStats, statsLine, passedProblems, lessonEffects, sleepLessons, wakeLessons, materialView, recordsView, bySystem, FORMAT_NOISE, KINDS, OFFER_WINDOW, SLEEP_WINDOW };
