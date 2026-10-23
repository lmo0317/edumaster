'use strict';
// What the teacher taught, as one kind of item (docs/learning.md): a stage (analysis | generation), a scope (one
// problem | every problem) and, for every problem, a layer — 지침 (guide: must / must not) or 공통 학습 (lesson). Approved
// items go into the next analysis or generation of the problems they cover, and each result reports how it applied
// them. This is prompt-level learning (retrieval), not model fine-tuning.
const { newId } = require('./store');
const harness = require('./harness');

const KINDS = new Set(['do', 'dont', 'feedback']);
const TARGETS = new Set(['problem', 'solution', 'design', 'all']);
// material: one problem's learning (문제 학습); global: every problem. topic (similar problems) is the older way and is
// migrated to a lesson.
const SCOPES = new Set(['material', 'global', 'topic']);
const STAGES = new Set(['analysis', 'generation']);
const LAYERS = new Set(['guide', 'lesson']);
// auto: written after a set from the faults its checks found (pipeline.learnFromSet).
// merge: two items the teacher merged on 학습 › 정리 후보 (the originals are kept in mergedFrom).
// eval: written from the faults of a harness evaluation run (e.g. a PC model candidate).
const FROM = new Set(['input', 'check', 'fix', 'promote', 'migrated', 'auto', 'merge', 'eval', 'review']);
// What an item is about, for the page and the choice of what one set gets (docs/learning.md §1): reading the original,
// designing the problem, its numbers, its choices, or writing the solution.
const CATEGORIES = ['reading', 'design', 'numbers', 'choices', 'solution'];
const CATEGORY_LABEL = { reading: '원본 읽기', design: '문제 설계', numbers: '수치', choices: '보기·선택지', solution: '해설 쓰기' };
// Learning the system wrote itself (not the teacher): from a set's report, a 학습 반복's review, a harness evaluation.
const BY_SYSTEM = new Set(['auto', 'review', 'eval']);
const bySystem = (r) => BY_SYSTEM.has(r.source?.from);
/** 지침 / 문제 / 전체 — which of the three an item is, for prompts and the page. */
const layerOf = (r) => (r.scope === 'material' ? 'problem' : r.layer === 'guide' ? 'guide' : 'lesson');
const stageOf = (r) => r.stage || 'generation';
/** The category an item has, or the one its stage and target imply. */
const categoryOf = (r) => (CATEGORIES.includes(r.category) ? r.category : stageOf(r) === 'analysis' ? 'reading' : r.target === 'solution' ? 'solution' : 'design');

// Notation, titles and particles are laid out by the system (harness.notation, stepTitle, josa), so a lesson about them
// tells the writer to do what the system then undoes: the gas original's 학습 반복 (2026-10-21) learned "write X₂ in the
// title as $\ce{X2}$ with its full stop" set after set and fell from 89 to 61. Such a sentence is not kept as learning.
// The cues are the sentence talking about the notation itself (write it as \ce{…}, wrap it in \text{}, the full stop),
// not a formula used in an example: "'실젯값이 $\frac{p}{q}$이므로'처럼 값만 쓰고 넘어간 문장은 같은 틀로 쓴다" is a lesson
// on the solution, not on notation.
const FORMAT_LESSON = /\\ce\{[^}]*\}\$? ?(꼴|표기|로 (쓴|써|바꾸))|\\text\{\} ?(으)?로|\\text 없이|\$…\$|\$ ?(짝|밖|안)|마침표|띄어쓰기|유니코드|아래 첨자|수식 모드|'·'|·' 항목|항목 구분|조사(를|가) /;
const isFormatLesson = (text) => FORMAT_LESSON.test(String(text || ''));

function clean(text, max) { return String(text ?? '').replace(/\s+\n/g, '\n').trim().slice(0, max); }

function makeRule(input, now = new Date()) {
  const text = clean(input.text, 1500);
  if (text.length < 2) throw Object.assign(new Error('지침 내용을 입력해 주세요.'), { status: 400 });
  if (input.scope === 'material' && !clean(input.source?.materialId, 40)) throw Object.assign(new Error('어느 문제에 대한 피드백인지 알 수 없습니다.'), { status: 400 });
  const scope = SCOPES.has(input.scope) ? input.scope : 'global';
  return {
    id: newId().slice(0, 16),
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    status: input.status === 'pending' ? 'pending' : 'approved',
    scope,
    stage: STAGES.has(input.stage) ? input.stage : 'generation',
    ...(scope === 'global' ? { layer: LAYERS.has(input.layer) ? input.layer : 'lesson' } : {}),
    kind: KINDS.has(input.kind) ? input.kind : 'feedback',
    target: TARGETS.has(input.target) ? input.target : 'all',
    ...(CATEGORIES.includes(input.category) ? { category: input.category } : {}),
    text,
    subject: clean(input.subject, 40),
    topic: clean(input.topic, 120),
    history: [],
    source: input.source && typeof input.source === 'object' ? {
      jobId: clean(input.source.jobId, 40), itemIndex: Number.isInteger(input.source.itemIndex) ? input.source.itemIndex : undefined,
      materialId: clean(input.source.materialId, 40), label: clean(input.source.label, 120), excerpt: clean(input.source.excerpt, 600),
      from: FROM.has(input.source.from) ? input.source.from : 'input',
    } : undefined,
    applied: 0,
  };
}

/**
 * A change to an item. When the text changes, the sentence it replaces is kept on the item (history: when, by whom —
 * teacher, review, auto, merge — and why), so a 학습 반복 that rewrites a lesson round after round leaves a record the
 * teacher can read: the gas original's 8dffe10d was rewritten six times on 2026-10-21 and no version survived.
 */
function updateRule(rule, patch, now = new Date(), change = {}) {
  const next = { ...rule, updatedAt: now.toISOString() };
  if (patch.text !== undefined) {
    next.text = clean(patch.text, 1500);
    if (next.text.length < 2) throw Object.assign(new Error('지침 내용을 입력해 주세요.'), { status: 400 });
    if (next.text !== rule.text) {
      next.history = [...(rule.history || []), { at: now.toISOString(), before: rule.text, by: change.by || 'teacher', why: clean(change.why, 300), jobId: clean(change.jobId, 40) }].slice(-20);
    }
  }
  if (CATEGORIES.includes(patch.category)) next.category = patch.category;
  if (patch.topic !== undefined) next.topic = clean(patch.topic, 120);
  if (['approved', 'pending', 'rejected'].includes(patch.status)) next.status = patch.status;
  // Moving up and down: 문제 학습 → 공통 학습 → 지침, and back (to a problem only if it came from one).
  if (SCOPES.has(patch.scope) && (patch.scope !== 'material' || next.source?.materialId)) next.scope = patch.scope;
  if (next.scope === 'global') next.layer = LAYERS.has(patch.layer) ? patch.layer : (next.layer || 'lesson');
  else delete next.layer;
  if (patch.scope === 'global' && rule.scope === 'material') next.promotedFrom = rule.source?.materialId || '';
  // The subject tag of an every-problem item: set, it reaches only that subject's problems ('' = every subject). An item
  // moved up from a problem starts with no tag, so a promotion reaches every problem unless the teacher tags it.
  if (patch.subject !== undefined) next.subject = clean(patch.subject, 40);
  else if (patch.scope === 'global' && rule.scope === 'material') next.subject = '';
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
 * Picks the rules for one material: the 지침, every approved feedback on this very problem, the lessons (most useful
 * first, see below), then approved topic rules whose source problem looks like this one. At most `limit` rules and
 * ~`maxChars` characters in total; this problem's own feedback always comes first.
 */
function selectRules(allRules, material, { limit = 40, maxChars = 9000, stage = 'generation' } = {}) {
  const approved = allRules.filter((r) => r.status === 'approved' && stageOf(r) === stage);
  const own = approved.filter((r) => r.scope === 'material' && r.source?.materialId === material.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const byTime = (a, b) => a.createdAt.localeCompare(b.createdAt);
  // Every-problem items tagged with a subject reach only that subject (learning that keeps growing is not all sent to
  // every problem); within the lessons, ones for this subject come before the untagged ones, so the cap drops those first.
  const reaches = (r) => !r.subject || !material.subject || r.subject === material.subject;
  const guides = approved.filter((r) => r.scope === 'global' && r.layer === 'guide' && reaches(r)).sort(byTime);
  const target = grams([material.subject, material.topic, material.problem?.text, ...(material.techniques || [])].join(' '));
  // Lessons, most useful first, so the cap drops the least: those learned from this problem's own reviews (학습 반복 —
  // oldest-first sent only 1-2 of the 4-7 a 2026-10-21 repeat had learned, and the next set made the same faults), then
  // this subject's, then the ones closest to this problem, the newer first.
  const near = new Map();
  const closeness = (r) => near.get(r) ?? near.set(r, overlap(grams([r.text, r.source?.label, r.source?.excerpt].join(' ')), target)).get(r);
  const fromHere = (r) => Number(r.source?.materialId === material.id);
  const sameTopic = (r) => Number(Boolean(r.topic && material.topic && r.topic === material.topic));
  const lessons = approved.filter((r) => r.scope === 'global' && r.layer !== 'guide' && reaches(r))
    .sort((a, b) => fromHere(b) - fromHere(a) || Number(!a.subject) - Number(!b.subject) || sameTopic(b) - sameTopic(a) || closeness(b) - closeness(a) || -byTime(a, b));
  // A topic feedback belongs to its subject: shared exam wording ("조건", "자료") must not carry a 화학 note to 생명과학.
  const topical = approved.filter((r) => r.scope === 'topic' && !(r.subject && material.subject && r.subject !== material.subject)).map((r) => {
    let score = overlap(grams([r.subject, r.topic, r.source?.excerpt, r.text].join(' ')), target);
    if (r.subject && material.subject && r.subject === material.subject) score += 0.15;
    if (r.source?.materialId && r.source.materialId === material.id) score += 1;
    return { r, score };
  }).filter((x) => x.score >= 0.3).sort((a, b) => b.score - a.score).map((x) => x.r);
  // Filled in that order and stopped at the first item that does not fit: skipping ahead let short items from far down
  // the list (another subject's) take the room of this subject's longer ones — on 생명 L64 (2026-10-22) 8 of its 19
  // 생명과학 lessons were left out while 28 untagged chemistry ones went in.
  const picked = [];
  let chars = 0;
  for (const r of [...guides, ...own, ...lessons, ...topical]) {
    if (picked.length >= limit || chars + r.text.length > maxChars) break;
    picked.push(r); chars += r.text.length;
  }
  return picked;
}

/**
 * The second pass over older items (once, at start-up): every item gets a history and a category; a lesson the system
 * wrote on one original and left untagged is tagged with that original's subject and topic, since an untagged lesson
 * reaches every subject — 28 chemistry lessons went into a 생명과학 set on 2026-10-22. A lesson about notation or
 * titles, which the system lays out itself, is switched off. Returns how many items changed.
 */
function migrateLearningV2(store) {
  let moved = 0;
  const materials = new Map(store.materials.all().map((m) => [m.id, m]));
  for (const r of store.rules.all()) {
    if (r.v2) continue;
    const next = { ...r, v2: true };
    if (!Array.isArray(next.history)) next.history = [];
    if (!CATEGORIES.includes(next.category)) next.category = categoryOf(next);
    if (next.scope === 'global' && next.layer !== 'guide' && bySystem(next) && !next.subject) {
      const m = materials.get(next.source?.materialId);
      if (m?.subject) { next.subject = m.subject; next.topic = next.topic || m.topic || ''; next.tagged = 'migrated'; }
    }
    if (next.status === 'approved' && stageOf(next) === 'generation' && isFormatLesson(next.text)) { next.status = 'pending'; next.offReason = 'format'; }
    store.rules.put(next); moved++;
  }
  return moved;
}

/** What one analysis gets: the analysis 지침, this problem's analysis feedback, the analysis lessons. */
function analysisLearning(allRules, material) {
  const picked = selectRules(allRules, material, { stage: 'analysis', limit: 30, maxChars: 8000 });
  return { guides: picked.filter((r) => layerOf(r) === 'guide'), own: picked.filter((r) => layerOf(r) === 'problem'), lessons: picked.filter((r) => layerOf(r) === 'lesson') };
}

/**
 * Brings older learning into the one store, once (docs/learning.md §5): rules get a stage, every-problem rules a layer
 * (they were all "꼭 할 것 / 하지 말 것", so 지침), topic rules become lessons; each problem's analysis feedback and the
 * settings' common analysis instructions become analysis items. Returns how many things moved.
 */
function migrateLearning(store, settings, saveSettings) {
  let moved = 0;
  for (const r of store.rules.all()) {
    const next = { ...r };
    if (!next.stage) next.stage = 'generation';
    if (next.scope === 'topic') { next.scope = 'global'; next.layer = 'lesson'; }
    if (next.scope === 'global' && !next.layer) next.layer = 'guide';
    if (JSON.stringify(next) !== JSON.stringify(r)) { store.rules.put(next); moved++; }
  }
  for (const m of store.materials.all()) {
    if (!m.analysisFeedback?.length) continue;
    for (const f of m.analysisFeedback) {
      const rule = makeRule({ text: f.text, scope: 'material', stage: 'analysis', source: { materialId: m.id, label: m.title, from: 'migrated' } }, new Date(f.at || Date.now()));
      store.rules.put({ ...rule, createdAt: f.at || rule.createdAt, updatedAt: f.at || rule.updatedAt });
      moved++;
    }
    store.materials.put({ ...m, analysisFeedback: [] });
  }
  if (settings.commonAnalysis?.length) {
    for (const f of settings.commonAnalysis) {
      const rule = makeRule({ text: f.text, scope: 'global', layer: 'lesson', stage: 'analysis', source: { from: 'migrated' } });
      store.rules.put({ ...rule, createdAt: f.at || rule.createdAt, updatedAt: f.at || rule.updatedAt });
      moved++;
    }
    saveSettings({ commonAnalysis: [] });
  }
  return moved;
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

module.exports = { makeRule, updateRule, selectRules, analysisLearning, migrateLearning, migrateLearningV2, layerOf, stageOf, categoryOf, bySystem, isFormatLesson, CATEGORIES, CATEGORY_LABEL, grams, overlap, readingCorrections, recordCorrections, readingPairs, readingHint };
