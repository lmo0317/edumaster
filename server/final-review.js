'use strict';
// 최종 검수: the review a set gets from Claude and Gemini after it is made (scripts/review-problem.js) and the review
// each problem must pass before it counts as made (pipeline.js, finalGate) are one and the same — the criteria in
// scripts/review-criteria.md and the learning that applies to the problem. A problem the generation called finished
// kept failing the later review, which sent the system round fix-after-review on every new original (the user,
// 2026-10-19: "문제 생성할 때 대충 만들고 나중에 검수할 때 문제 있다 그러고 … 이거 반복").
const fs = require('node:fs');
const path = require('node:path');
const { selectRules, analysisLearning, layerOf } = require('./learning');

const CRITERIA_FILE = path.join(__dirname, '..', 'scripts', 'review-criteria.md');
const criteria = () => fs.readFileSync(CRITERIA_FILE, 'utf8').replace(/^[\s\S]*?(?=## A\.)/, '');
const KIND = { guide: '지침', problem: '이 문제', lesson: '공통 학습' };
const ruleLines = (list) => list.map((r) => `- [${KIND[layerOf(r)]}] ${r.text}`).join('\n') || '없음';
// The criteria by section of review-criteria.md: A for the analysis, B~D for a problem and its solution.
const ANALYSIS_NAMES = ['판독', '용어', 'STEP 수와 순서', 'STEP 제목', '풀이 방식', '정답'];
const ITEM_NAMES = ['정답', 'STEP 범위', '결론 노출', '조건', '단서', '수치', '용기·실험 구성', '형식', '구조', 'STEP 전부 필요', 'STEP 제목', '범위', '풀이 방식', '보기 분석', '덧붙임', '숨긴 값의 판단', '정답 줄', '표기'];
const RULE_NAMES = [...new Set([...ANALYSIS_NAMES, ...ITEM_NAMES])].join(', ');

/** The reviewer's instructions: the criteria, and the learning for this problem (all rules, or the given ones). */
function reviewSystem(material, allRules, generationRules = null) {
  const learnedA = analysisLearning(allRules, material);
  const learnedG = generationRules || selectRules(allRules, material);
  return `너는 고등학교 ${material.subject || '과학'} 문항을 검토하는 출제 전문가다. AI가 정리한 분석 결과와 AI가 만든 변형 문제를 원본 이미지와 대조해 독립적으로 검토한다.
- 변형 문제는 반드시 네가 직접 끝까지 풀어서 정답을 확인한다. 표시된 정답이나 해설을 믿지 않는다.
- 아래 [검수 기준]과 [이 문제에 적용되는 학습]을 하나씩 대조한다. 실제 결함만 적고, 기준의 'E. 결함이 아닌 것'은 적지 않는다.
- 각 결함은 어디에서 무엇이 왜 틀렸는지 구체적으로 쓰고, rule에 기준 항목 이름(${RULE_NAMES}) 하나를 쓴다. 학습을 어겼으면 rule은 "학습"이고 detail 앞에 그 학습 문장을 인용한다.
- checks에는 기준 항목마다 판정을 적는다: 지켰으면 "ok", 결함이 있으면 "fix", 이 문제에 해당하지 않으면 "na" (예: 연습 문제의 '구조'·'STEP 전부 필요', ㄱ·ㄴ·ㄷ 문제가 아닌데 '보기 분석'). analysis.checks는 A의 항목(${ANALYSIS_NAMES.join(', ')}), items[].checks는 B~D의 항목(${ITEM_NAMES.join(', ')}).
- 한국어로 쓴다. JSON만 출력한다.

[검수 기준]
${criteria()}
[이 문제에 적용되는 학습 — 분석]
${ruleLines([...learnedA.guides, ...learnedA.own, ...learnedA.lessons])}

[이 문제에 적용되는 학습 — 변형 문제와 해설]
${ruleLines(learnedG)}

반환 형식:
{"analysis":{"verdict":"ok|issues","checks":{"판독":"ok"},"issues":[{"severity":"high|mid|low","rule":"...","where":"문제/STEP n","detail":"..."}]},
 "items":[{"label":"...","myAnswer":"내가 푼 정답 번호와 핵심 값","markedAnswer":3,"answerOk":true,"verdict":"use|fix|reject","checks":{"정답":"ok","구조":"na"},"issues":[{"severity":"high|mid|low","rule":"...","detail":"..."}]}],
 "summary":"전체 평가 두세 문장"}`;
}

const range = (material, st) => (st?.kind === 'upto' ? `원본 STEP 1${st.upto > 1 ? '~' + st.upto : ''}만 쓰는 연습 문제` : st?.kind === 'twin' ? `원본 STEP 1~${material.steps.length}을 모두 쓰는 최종 통합 문제 (원본과 다른 구조여야 함)` : '');
const choices = (p) => (p.choices || []).map((c, i) => `${'①②③④⑤'[i]} ${c}`).join('  ');
const itemText = (material, it) => [
  `### ${it.label} — 목표: ${range(material, it.stage)}`, it.problem.text, choices(it.problem), `표시된 정답: ${it.problem.answer}번`,
  '해설:', ...(it.solution?.steps || []).map((s) => `STEP ${s.step}. ${s.title}\n${s.work}`), it.solution?.summary ? `정리: ${it.solution.summary}` : '',
].filter(Boolean).join('\n');
const materialText = (m) => [
  `[원본 문제를 AI가 옮겨 적은 것]\n${m.problem.text}\n${choices(m.problem)}\n정답: ${m.problem.answer}번`,
  `\n[AI가 원본 해설을 STEP으로 정리한 것]\n${m.steps.map((s, i) => `STEP ${i + 1}. ${s.title}\n${s.work}`).join('\n\n')}`,
];

/** The whole set, reviewed after it is made (scripts/review-problem.js). */
function setText(material, items) {
  return [
    ...materialText(material),
    items.length ? `\n[AI가 만든 변형 세트]\n${items.map((it) => itemText(material, it)).join('\n\n')}` : '\n[변형 세트 없음 — 분석 결과만 검토한다]',
    '\n위 원본 이미지와 대조해 분석 결과를 검토하고, 변형 문제를 하나씩 직접 풀어 검토하라.',
  ].join('\n');
}

/** One problem of a set being made: the earlier ones are shown (numbers must not repeat) but not reviewed. */
function itemReviewText(material, item, prior = []) {
  return [
    ...materialText(material),
    prior.length ? `\n[같은 세트의 앞 문제 — 검토하지 않는다. 수치·구성이 겹치는지 볼 때만 쓴다]\n${prior.map((it) => itemText(material, it)).join('\n\n')}` : '',
    `\n[검토할 변형 문제]\n${itemText(material, item)}`,
    '\n분석 결과는 이미 검토되었으니 analysis는 {"verdict":"ok","issues":[]}로 둔다. [검토할 변형 문제] 하나만 직접 끝까지 풀어 검토하고, items에는 그 문제 하나만 넣는다.',
  ].filter(Boolean).join('\n');
}

/** A reviewer's verdict on one problem → what must still be fixed (empty when it can be used as it is). */
function itemFaults(review) {
  const it = (review?.items || [])[0];
  if (!it) return ['최종 검수가 결과를 내지 못했습니다.'];
  const faults = (it.issues || []).map((x) => `[${x.rule || '기준'}${x.severity ? ` · ${x.severity}` : ''}] ${x.detail || ''}`.trim()).filter((x) => x.length > 4);
  if (it.answerOk === false) faults.unshift(`검수자가 직접 푼 정답은 ${it.myAnswer || '?'}로 표시된 정답 ${it.markedAnswer ?? ''}번과 다릅니다.`);
  // "use" with only low notes is a problem the reviewer would hand out as it is.
  if (it.verdict === 'use' && it.answerOk !== false) return [];
  return faults.length ? faults : [`검수 판정이 '${it.verdict || '없음'}'입니다.`];
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
function checklistOf(part, { analysis = false, final = false } = {}) {
  if (!part) return {};
  const checks = part.checks || {};
  const issues = part.issues || [];
  const out = {};
  for (const row of CHECKLIST.flatMap((g) => g.items)) {
    if (Boolean(row.analysis) !== analysis || row.id === 'complete') continue;
    if (row.id === 'final' && !final) { out[row.id] = ['na', '연습 문제']; continue; }
    const mine = issues.filter((x) => row.names.includes(x.rule));
    const said = row.names.map((n) => checks[n]).filter(Boolean);
    const wrong = row.id === 'correct' && part.answerOk === false;
    const note = [wrong && `검수자가 직접 푼 답 ${part.myAnswer || '?'}`, ...mine.map((x) => x.detail)].filter(Boolean).join(' / ');
    const mark = wrong || mine.some((x) => x.severity !== 'low') ? 'no'
      : mine.length || said.includes('fix') ? 'partial'
      : said.length && said.every((s) => s === 'na') ? 'na' : 'ok';
    out[row.id] = [mark, mark === 'ok' && row.id === 'correct' && part.myAnswer ? `검수자 풀이 ${part.myAnswer}` : note];
  }
  return out;
}

module.exports = { reviewSystem, setText, itemReviewText, analysisText, itemFaults, checklistOf, CHECKLIST, CRITERIA_FILE };
