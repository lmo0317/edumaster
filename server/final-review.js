'use strict';
// 최종 검수: the review a set gets from Claude and Gemini after it is made (scripts/review-problem.js) and the review
// each problem must pass before it counts as made (pipeline.js, finalGate) are one and the same — the criteria in
// scripts/review-criteria.md and the learning that applies to the problem. A problem the generation called finished
// kept failing the later review, which sent the system round fix-after-review on every new original (the user,
// 2026-10-19: "문제 생성할 때 대충 만들고 나중에 검수할 때 문제 있다 그러고 … 이거 반복").
const fs = require('node:fs');
const path = require('node:path');
const { selectRules, analysisLearning, layerOf, grams } = require('./learning');
const { notateMaterial } = require('./harness');
// The final review counted '구조' by feel while the independent solve counts these five items: L64's final, the
// original's table and three kinds of 보기 with members regrouped, passed the one and failed the other (2026-10-22).
const { VARIATION_CRITERIA } = require('./prompts');

const CRITERIA_FILE = path.join(__dirname, '..', 'scripts', 'review-criteria.md');
const criteria = () => fs.readFileSync(CRITERIA_FILE, 'utf8').replace(/^[\s\S]*?(?=## A\.)/, '');
const KIND = { guide: '지침', problem: '이 문제', lesson: '공통 학습' };
const ruleLines = (list) => list.map((r) => `- [${KIND[layerOf(r)]}] ${r.text}`).join('\n') || '없음';
// The criteria by section of review-criteria.md: A for the analysis, B~D for a problem and its solution.
const ANALYSIS_NAMES = ['판독', '용어', 'STEP 수와 순서', 'STEP 제목', '풀이 방식', '정답'];
const ITEM_NAMES = ['정답', 'STEP 범위', '결론 노출', '조건', '단서', '수치', '용기·실험 구성', '형식', '구조', 'STEP 전부 필요', 'STEP 제목', '범위', '풀이 방식', '보기 분석', '덧붙임', '숨긴 값의 판단', '정답 줄', '표기'];
const RULE_NAMES = [...new Set([...ANALYSIS_NAMES, ...ITEM_NAMES])].join(', ');

// Learning the system wrote itself from reviews and sets (from 'review', 'auto', 'eval') guides the writer; the reviewer
// is shown it but judges by the criteria and the teacher's own items. Judged as criteria, such lessons piled up against
// one another — on 생명 D50 (2026-10-22) one said keep A's two 0 mV points and another change its −80, the review
// failed each design on whichever it broke, and the set never finished. And a lesson learned from one reviewer's fault
// became the bar the same reviewer then held every design to: on bio-k61 (2026-10-23) "the hidden cell must be settled
// only at STEP 2" failed the final of six rounds running, 2.5 hours each. So what passes is decided by the criteria and
// the teacher's items alone; a fault that only restates a system lesson is kept as a note (advisoryTexts, demote).
const BY_SYSTEM = new Set(['review', 'auto', 'eval']);
const bySystem = (r) => BY_SYSTEM.has(r.source?.from);

/** The system's own lessons among the rules a set was made with — advice to the writer, not criteria. */
function advisoryTexts(material, allRules, generationRules = null) {
  const full = new Map(allRules.map((r) => [r.id, r]));
  return (generationRules || selectRules(allRules, material)).filter((r) => bySystem(full.get(r.id) || r)).map((r) => r.text);
}
// A fault is a restated lesson when most of the lesson's letter pairs are in its text (the reviewer quotes it).
const coverage = (lesson, detail) => { const a = grams(lesson), b = grams(detail); if (!a.size) return 0; let n = 0; for (const g of a) if (b.has(g)) n++; return n / a.size; };
/** Whether a fault's text restates a lesson (quotes it, or most of it). */
const restates = (lesson, detail, min = 0.5) => coverage(lesson, detail) >= min;
/** A reviewed item with faults that only break a system lesson turned into low notes. */
function demote(it, advisory = []) {
  if (!it || !advisory.length || !Array.isArray(it.issues)) return it;
  // A fault filed under a criterion is demoted only when it is the lesson's sentence (nine tenths of its word pairs):
  // at seven tenths, "숨긴 값 a=12가 원본과 같아 …" under 구조 · high was a note because a short lesson said hidden values
  // differ from the original's, and the check was cleared with it (2026-10-26 audit).
  // Under a criterion the fault must also be little more than the lesson (half of its own letter pairs in the lesson):
  // "'<lesson>'를 어겼다: 숨긴 값 a=12가 원본과 같다 …" quotes the lesson whole and then gives the evidence, and was a
  // note with its check cleared (2026-10-27 review).
  const restates = (x) => x && typeof x.detail === 'string' && advisory.some((t) => (x.rule === '학습' ? coverage(t, x.detail) >= 0.5 : coverage(t, x.detail) >= 0.9 && coverage(x.detail, t) >= 0.5));
  if (!it.issues.some(restates)) return it;
  const issues = it.issues.map((x) => (restates(x) ? { ...x, severity: 'low', rule: 'AI 학습 참고' } : x));
  // The check the reviewer marked for it ('학습': fix) is cleared when no other fault explains it.
  const checks = { ...(it.checks || {}) };
  for (const x of it.issues) if (restates(x) && checks[x.rule] === 'fix' && !issues.some((y) => y.rule === x.rule && y.severity !== 'low')) checks[x.rule] = 'ok';
  return { ...it, issues, checks };
}

/** The reviewer's instructions: the criteria, and the learning for this problem (all rules, or the given ones). */
function reviewSystem(material, allRules, generationRules = null) {
  const learnedA = analysisLearning(allRules, material);
  const learnedG = generationRules || selectRules(allRules, material);
  const full = new Map(allRules.map((r) => [r.id, r]));
  const system = (r) => bySystem(full.get(r.id) || r);
  const analysisRules = [...learnedA.guides, ...learnedA.own, ...learnedA.lessons];
  return `너는 고등학교 ${material.subject || '과학'} 문항을 검토하는 출제 전문가다. AI가 정리한 분석 결과와 AI가 만든 변형 문제를 원본 이미지와 대조해 독립적으로 검토한다.
- 변형 문제는 반드시 네가 직접 끝까지 풀어서 정답을 확인한다. 표시된 정답이나 해설을 믿지 않는다.
- 변형 문제에 [그림]이 있으면 그것이 학생이 받는 그 문제의 그림이다 (지점 위치, 신경의 방향, 그래프). 원본 그림이 아니라 이 그림으로 푼다.
- 아래 [검수 기준]과 [선생님 지침·학습]을 하나씩 대조한다. 실제 결함만 적고, 기준의 'E. 결함이 아닌 것'은 적지 않는다.
- [AI가 정리한 학습]은 세트와 검수에서 시스템이 스스로 배운 것으로, 작성자가 참고하라고 받았다. 판정 기준이 아니다: 이 학습을 어긴 것 자체는 결함으로 적지 않고, 그 학습이 가리키는 실제 결함이 [검수 기준]의 항목에 해당할 때만 그 항목 이름으로 적는다 (학습 문장을 인용해 결함으로 삼지 않는다). 두 학습이 서로 부딪히면 summary에 "학습 충돌: …"로 두 문장을 적는다.
- [전에 걸린 결함]이 있으면 그것부터 네 문제에서 확인한다. 기록이지 기준이 아니다: 실제 결함이 있을 때만 기준 항목 이름으로 적는다.
- 각 결함은 어디에서 무엇이 왜 틀렸는지 구체적으로 쓰고, rule에 기준 항목 이름(${RULE_NAMES}) 하나를 쓴다. [선생님 지침·학습]을 어겼으면 rule은 "학습"이고 detail 앞에 그 문장을 인용한다.
- checks에는 기준 항목마다 판정을 적는다: 지켰으면 "ok", 결함이 있으면 "fix", 이 문제에 해당하지 않으면 "na" (예: 연습 문제의 '구조'·'STEP 전부 필요', ㄱ·ㄴ·ㄷ 문제가 아닌데 '보기 분석'). analysis.checks는 A의 항목(${ANALYSIS_NAMES.join(', ')}), items[].checks는 B~D의 항목(${ITEM_NAMES.join(', ')}).
- 최종 문제의 '구조'는 독립 풀이와 같은 기준으로 센다: ${VARIATION_CRITERIA} 원본과 다른 항목이 둘 이상일 때만 "ok"이고, 하나 이하이면 "fix"로 하고 issues에 달라진 항목 번호와 근거를 적는다.
- 한국어로 쓴다. JSON만 출력한다.
- items에는 검토할 문항을 빠짐없이 한 번씩 넣고, 각 문항의 index와 label을 입력 그대로 반환한다. 배열 순서로 문항을 식별하지 않는다.

[검수 기준]
${criteria()}
[선생님 지침·학습 — 분석]
${ruleLines(analysisRules.filter((r) => !system(r)))}

[선생님 지침·학습 — 변형 문제와 해설]
${ruleLines(learnedG.filter((r) => !system(r)))}

[AI가 정리한 학습 — 작성자가 참고한 것. 판정 기준이 아니다]
${ruleLines([...analysisRules, ...learnedG].filter(system))}

반환 형식:
{"analysis":{"verdict":"ok|issues","checks":{"판독":"ok"},"issues":[{"severity":"high|mid|low","rule":"...","where":"문제/STEP n","detail":"..."}]},
 "items":[{"index":0,"label":"입력 문항의 label 그대로","myAnswer":"내가 푼 정답 번호와 핵심 값","markedAnswer":3,"answerOk":true,"verdict":"use|fix|reject","checks":{"정답":"ok","구조":"na"},"issues":[{"severity":"high|mid|low","rule":"...","detail":"..."}]}],
 "summary":"전체 평가 두세 문장"}`;
}

const range = (material, st) => (st?.kind === 'upto' ? `원본 STEP 1${st.upto > 1 ? '~' + st.upto : ''}만 쓰는 연습 문제` : st?.kind === 'twin' ? `원본 STEP 1~${material.steps.length}을 모두 쓰는 최종 통합 문제 (원본과 다른 구조여야 함)` : '');
const choices = (p) => (p.choices || []).map((c, i) => `${'①②③④⑤'[i]} ${c}`).join('  ');
// A variant's figure (the points' positions, the neurons' direction, a graph) is printed with it on the worksheet
// (report.js), so the reviewer reads it too: without it the reviewer took the original's figure for the variant and
// failed problems for distances they did give (bio D50, 2026-10-20: the final review's "거리가 없다" every round).
const figure = (p) => (p.figure ? `[그림 — 학습지에 문제와 함께 실리는 이 문제의 그림]\n${p.figure}` : '');
const itemText = (material, it) => [
  `### ${it.label} — 문항 index: ${it.index} — 목표: ${range(material, it.stage)}`, it.problem.text, figure(it.problem), choices(it.problem), `표시된 정답: ${it.problem.answer}번`,
  // Each STEP is its own block on the worksheet (app.js .step), so a blank line keeps a STEP ending in a table from
  // reading as one more row of it: joined by '\n' the reviewers failed E37's final three sets running for "표 뒤 빈 줄 없음".
  '해설:', ...(it.solution?.steps || []).map((s) => `\nSTEP ${s.step}. ${s.title}\n${s.work}`), it.solution?.summary ? `\n정리: ${it.solution.summary}` : '',
].filter(Boolean).join('\n');
const identities = (items) => '\n[반환할 문항 식별자 — index와 label을 아래 JSON에서 그대로 복사한다. 목표·제목 설명을 label에 붙이지 않는다]\n'
  + JSON.stringify(items.map(({ index, label }) => ({ index, label })));
// The original in the system's notation, as its problems are (harness.notation).
const materialText = (original) => {
  const m = notateMaterial(original);
  return [
    `[원본 문제를 AI가 옮겨 적은 것]\n${[m.problem.text, figure(m.problem), choices(m.problem)].filter(Boolean).join('\n')}\n정답: ${m.problem.answer}번`,
    `\n[AI가 원본 해설을 STEP으로 정리한 것]\n${m.steps.map((s, i) => `STEP ${i + 1}. ${s.title}\n${s.work}`).join('\n\n')}`,
  ];
};

/** The whole set, reviewed after it is made (scripts/review-problem.js). */
function setText(material, items) {
  return [
    ...materialText(material),
    items.length ? `\n[AI가 만든 변형 세트]\n${items.map((it) => itemText(material, it)).join('\n\n')}` : '\n[변형 세트 없음 — 분석 결과만 검토한다]',
    identities(items),
    '\n위 원본 이미지와 대조해 분석 결과를 검토하고, 변형 문제를 하나씩 직접 풀어 검토하라.',
  ].join('\n');
}

/** One problem of a set being made: the earlier ones are shown (numbers must not repeat) but not reviewed. */
function itemReviewText(material, item, prior = [], hints = [], priorFaults = []) {
  return [
    ...materialText(material),
    prior.length ? `\n[같은 세트의 앞 문제 — 검토하지 않는다. 수치·구성이 겹치는지 볼 때만 쓴다]\n${prior.map((it) => itemText(material, it)).join('\n\n')}` : '',
    `\n[검토할 변형 문제]\n${itemText(material, item)}`,
    identities([item]),
    // What this original's earlier sets were faulted for (server/faults.js): checked first, as a record, not as criteria.
    priorFaults.length ? `\n[전에 걸린 결함 — 이 원본의 지난 세트와 같은 단원에서. 먼저 확인한다. 기록이지 기준이 아니다]\n${priorFaults.map((e) => `- (${e.where} · ${e.sets}세트${e.label ? ` · ${e.label}` : ''}) [${e.rule}] ${e.detail}`).join('\n')}` : '',
    // What the earlier checks noted is weighed here, not taken as it is: a note that goes against the criteria (keeping
    // the original's cylinders, its table, 'E. 결함이 아닌 것') is not a fault.
    hints.length ? `\n[앞선 자동 검토가 짚은 점 — 참고만 한다]\n아래는 독립 풀이와 코드 검사가 짚은 점이다. [검수 기준]에 비추어 실제 결함인 것만 네 판정으로 적는다. 기준과 부딪히면(예: 원본의 용기·실험 구성이나 표 구조를 지키느라 연습 문제에서 쓰이지 않는 값, 합답형이라 같은 선택지) 결함이 아니다.\n${hints.map((h) => `- ${h}`).join('\n')}` : '',
    '\n분석 결과는 이미 검토되었으니 analysis는 {"verdict":"ok","issues":[]}로 둔다. [검토할 변형 문제] 하나만 직접 끝까지 풀어 검토하고, items에는 그 문제 하나만 넣는다.',
  ].filter(Boolean).join('\n');
}

// The criteria of D (the solution): a fault only there is fixed by rewriting the solution, not by a new problem.
const SOLUTION_NAMES = ['STEP 제목', '범위', '풀이 방식', '보기 분석', '덧붙임', '숨긴 값의 판단', '정답 줄', '표기'];
/** Whether a reviewer's faults on one problem are all in its solution (the answer right, the problem itself fine). */
function solutionOnly(review, { advisory = [] } = {}) {
  const it = demote((review?.items || [])[0], advisory);
  // A low note never holds a problem back, so it does not decide what kind of fix the others need.
  const counted = Array.isArray(it?.issues) ? it.issues.filter((x) => x?.severity !== 'low') : [];
  return Boolean(it && it.answerOk === true && it.verdict !== 'reject' && counted.length && counted.every((x) => SOLUTION_NAMES.includes(x?.rule))
    && Object.entries(it.checks || {}).every(([name, value]) => value !== 'fix' || SOLUTION_NAMES.includes(name)));
}

/**
 * A reviewer's verdict on one problem → what must still be fixed (empty when it can be used as it is). A problem is held
 * back by a wrong answer or a high or mid fault; low ones (a title, notation, wording) never hold it back — they go
 * along to be fixed with a fault that does, and are kept as notes otherwise. Held back by the reviewer's 'fix' alone,
 * the gas original's final went through 13 repairs and 3 designs over low notes on its STEP 3 title and was not made
 * (2026-10-21).
 */
/** The choice number a reviewer's own answer names ("② $\frac{2}{5}$", "3", "③ 135", "2번"), 0 when it names none. */
const answerOf = (v) => {
  const s = String(v ?? '').trim();
  const circled = s.match(/[①②③④⑤]/);
  if (circled) return '①②③④⑤'.indexOf(circled[0]) + 1;
  // "2w", "1/4", "5/2" are values, not the numbers of choices (2026-10-27 review: "2w, ㄱ·ㄴ" read as ② against a ③).
  const m = /^(?:정답\s*)?([1-5])(?![0-9.\/]|\s*[A-Za-z㉠-㉿ⓐ-ⓩ])/.exec(s) || /([1-5])\s*번/.exec(s);
  return m ? Number(m[1]) : 0;
};

/** Whether a reviewer's verdict on one problem has what a verdict needs (itemFaults asks the same): every criterion
 *  judged, its own answer a choice number, its faults listed in form. A set review without it is asked again. */
function wellFormed(it) {
  return Boolean(it) && typeof it.answerOk === 'boolean' && ['use', 'fix', 'reject'].includes(it.verdict) && Array.isArray(it.issues)
    && it.issues.every((x) => x && ['high', 'mid', 'low'].includes(x.severity) && typeof x.detail === 'string' && Boolean(x.detail.trim()))
    && Boolean(it.checks) && typeof it.checks === 'object' && !Array.isArray(it.checks) && ITEM_NAMES.every((n) => n in it.checks)
    && Object.values(it.checks).every((v) => ['ok', 'fix', 'na'].includes(v)) && answerOf(it.myAnswer) > 0;
}

function itemFaults(review, { advisory = [], answer = null } = {}) {
  const it = Array.isArray(review?.items) && review.items.length === 1 ? demote(review.items[0], advisory) : null;
  if (!it) return ['최종 검수가 결과를 내지 못했습니다.'];
  if (typeof it.answerOk !== 'boolean' || !['use', 'fix', 'reject'].includes(it.verdict) || !Array.isArray(it.issues)
      || it.issues.some((x) => !x || !['high', 'mid', 'low'].includes(x.severity) || typeof x.detail !== 'string' || !x.detail.trim())) {
    return ['최종 검수의 정답 확인·판정·결함 목록이 누락되었거나 잘못되었습니다. 다시 검수해야 합니다.'];
  }
  // A pass rests on the reviewer having judged every criterion and solved the problem itself: a review with no checks
  // and no issues scored 100 (checklistOf counts the rows it names), and answerOk alone stood for the answer even when
  // the number the reviewer solved to was another (2026-10-26 audit). Both are asked again, as a broken list is.
  const missing = ITEM_NAMES.filter((n) => !it.checks || typeof it.checks !== 'object' || !(n in it.checks));
  if (missing.length) return [`최종 검수가 기준 항목(${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ' 등' : ''})의 판정을 주지 않았습니다. 다시 검수해야 합니다.`];
  const mine = answerOf(it.myAnswer);
  if (!mine) return ['최종 검수가 직접 푼 정답 번호를 주지 않았습니다. 다시 검수해야 합니다.'];
  const marked = Number(answer) || Number(it.markedAnswer) || 0;
  const wrongAnswer = it.answerOk === false || (marked > 0 && mine !== marked);
  // A restated system lesson (demote) stays a note even when another fault sends the problem back: sent along, the
  // writer would be told to fix it anyway, and the lesson would still be acting as a criterion.
  const faults = (it.issues || []).filter((x) => x.rule !== 'AI 학습 참고').map((x) => `[${x.rule || '기준'}${x.severity ? ` · ${x.severity}` : ''}] ${x.detail || ''}`.trim()).filter((x) => x.length > 4);
  // A check marked 'fix' is unexplained only when the item lists no fault at all: the reviewer names rules freely, so
  // a fault filed under '학습' explains a '풀이 방식' check (the gas original's round 1, 2026-10-23: 100 points, one
  // low note, held back as "no explanation").
  const unexplained = Object.entries(it.checks || {}).filter(([name, value]) => value === 'fix' && !it.issues.length);
  faults.push(...unexplained.map(([name]) => `[${name}] 검수 체크가 수정 필요인데 구체적인 결함 설명이 없습니다.`));
  const invalidChecks = it.checks != null && (typeof it.checks !== 'object' || Array.isArray(it.checks) || Object.values(it.checks).some((v) => !['ok', 'fix', 'na'].includes(v)));
  if (invalidChecks) faults.push('검수 체크 항목의 판정 형식이 잘못되었습니다.');
  const blocking = wrongAnswer || it.verdict === 'reject' || unexplained.length || invalidChecks || it.issues.some((x) => x.severity !== 'low');
  if (wrongAnswer) faults.unshift(`검수자가 직접 푼 정답은 ${it.myAnswer || '?'}로 표시된 정답 ${marked || it.markedAnswer || ''}번과 다릅니다.`);
  if (!blocking && (it.verdict === 'use' || it.issues?.length)) return [];
  return faults.length ? faults : [`검수 판정이 '${it.verdict || '없음'}'입니다.`];
}

// Models may reorder their output. Match an explicit index or an unambiguous label, never an array position.
// An index given as a string ("0") is the number; a label with stray spaces is the label (2026-10-27 review).
const indexOf = (x) => (Number.isInteger(x.index) ? x.index : /^\s*\d+\s*$/.test(String(x.index ?? '')) ? Number(x.index) : null);
const labelOf = (x) => String(x?.label ?? '').trim();
function matchItem(review, expected, items = [expected]) {
  const matches = (Array.isArray(review?.items) ? review.items : []).filter((x) => x && (
    indexOf(x) !== null ? indexOf(x) === expected.index : labelOf(x) === labelOf(expected) && items.filter((it) => labelOf(it) === labelOf(expected)).length === 1
  ));
  if (matches.length !== 1) return null;
  const found = matches[0];
  if (labelOf(found) && labelOf(found) !== labelOf(expected)) return null;
  return found;
}

function analysisFaults(a) {
  if (!a || !['ok', 'issues'].includes(a.verdict) || !Array.isArray(a.issues)) return [{ severity: 'high', rule: '검수 응답', detail: '원본 분석 검수 결과가 누락되었거나 잘못되었습니다.' }];
  const issues = a.issues.filter((x) => x && ['high', 'mid', 'low'].includes(x.severity) && typeof x.detail === 'string' && x.detail.trim());
  if (issues.length !== a.issues.length) issues.push({ severity: 'high', rule: '검수 응답', detail: '원본 분석 결함 목록의 형식이 잘못되었습니다.' });
  for (const [name, value] of Object.entries(a.checks || {})) if (value === 'fix' && !issues.some((x) => x.rule === name)) issues.push({ severity: 'high', rule: name, detail: '수정 필요 판정의 구체적인 설명이 없습니다.' });
  if (a.checks != null && (typeof a.checks !== 'object' || Array.isArray(a.checks) || Object.values(a.checks).some((v) => !['ok', 'fix', 'na'].includes(v)))) issues.push({ severity: 'high', rule: '검수 응답', detail: '원본 분석 체크 항목의 판정 형식이 잘못되었습니다.' });
  if (a.verdict === 'issues' && !issues.length) issues.push({ severity: 'high', rule: '검수 응답', detail: '원본 분석 수정 필요 판정의 설명이 없습니다.' });
  return issues;
}
/** The low notes a reviewer left on a problem it passed. */
function itemNotes(review, { advisory = [] } = {}) {
  const it = demote((review?.items || [])[0], advisory);
  return (it?.issues || []).filter((x) => x.severity === 'low').map((x) => `[${x.rule || '기준'} · low] ${x.detail || ''}`.trim());
}

/** The analysis alone, reviewed once before an original's problems are made. */
function analysisText(material) {
  return [...materialText(material), '\n[변형 세트 없음 — 분석 결과만 검토한다]', '\n위 원본 이미지와 대조해 분석 결과를 검토하라. items는 빈 배열로 둔다.'].join('\n');
}

// The checklist of the 모델 비교 page (eval/compare/<case>.feedback.json groups), each row filled from the criteria of
// review-criteria.md that it stands for. '세 문제를 모두 완성한다' is the problem's own state (the page reads it).
const CHECKLIST = [
  { title: '기본 요구사항', items: [
    { id: 'read', text: '원본 문제·해설을 정확히 읽는다 (필기·오독 없이)', names: ['판독', '용어'], analysis: true },
    { id: 'steps', text: '선생님 해설의 STEP 수·순서·제목을 그대로 쓴다', names: ['STEP 수와 순서', 'STEP 제목', '정답'], analysis: true },
    { id: 'range', text: '각 문제가 목표한 STEP만으로 풀린다', names: ['STEP 범위'] },
    { id: 'correct', text: '정답이 하나이고 계산이 맞다 (5지선다 유지)', names: ['정답'] },
    { id: 'numbers', text: '손으로 계산하기 쉬운 수를 쓴다', names: ['수치'] },
    { id: 'complete', text: '문제를 완성한다 (최종 검수 통과)', names: [] },
  ] },
  { title: '선생님 피드백', items: [
    { id: 'method', text: '해설을 자기 논리로 바꾸지 않고 선생님 풀이대로 푼다', names: ['STEP 제목', '범위', '풀이 방식', '보기 분석', '덧붙임', '숨긴 값의 판단', '정답 줄', '표기', '학습'] },
    { id: 'clean', text: '불필요한 서술·무관한 조건을 넣지 않는다', names: ['결론 노출', '조건', '단서', '용기·실험 구성', '형식'] },
    { id: 'final', text: '최종 문제는 숫자만 바꾸지 않고 새 구조로 만들어 모든 STEP이 필요하다', names: ['구조', 'STEP 전부 필요'] },
  ] },
];

/** One review (of the analysis or of a problem) → the checklist rows it fills: {id: [ok|partial|no|na, note]}. */
function checklistOf(part, { analysis = false, final = false, advisory = [], answer = null } = {}) {
  if (!part) return {};
  if (!analysis) part = demote(part, advisory);
  const checks = part.checks || {};
  const issues = Array.isArray(part.issues) ? part.issues.filter((x) => x && typeof x === 'object') : [];
  const out = {};
  for (const row of CHECKLIST.flatMap((g) => g.items)) {
    if (Boolean(row.analysis) !== analysis || row.id === 'complete') continue;
    if (row.id === 'final' && !final) { out[row.id] = ['na', '연습 문제']; continue; }
    const mine = issues.filter((x) => row.names.includes(x.rule));
    const said = row.names.map((n) => checks[n]).filter(Boolean);
    const wrong = row.id === 'correct' && (part.answerOk === false || (Number(answer) > 0 && answerOf(part.myAnswer) > 0 && answerOf(part.myAnswer) !== Number(answer)));
    const note = [wrong && `검수자가 직접 푼 답 ${part.myAnswer || '?'}`, ...mine.map((x) => x.detail)].filter(Boolean).join(' / ');
    // A low note (표기·제목·표현) neither stops a problem being made (itemFaults) nor costs its score: on the gas
    // original's 학습 반복 (2026-10-21) a set with low notes only scored 83 and was made again.
    const mark = wrong || mine.some((x) => x.severity !== 'low') ? 'no'
      : said.includes('fix') && !mine.length ? 'partial'
      : said.length && said.every((s) => s === 'na') ? 'na' : 'ok';
    out[row.id] = [mark, mark === 'ok' && row.id === 'correct' && part.myAnswer ? `검수자 풀이 ${part.myAnswer}` : note];
  }
  return out;
}

module.exports = { reviewSystem, setText, itemReviewText, analysisText, itemFaults, itemNotes, solutionOnly, matchItem, analysisFaults, checklistOf, advisoryTexts, demote, restates, answerOf, wellFormed, ITEM_NAMES, CHECKLIST, CRITERIA_FILE };
