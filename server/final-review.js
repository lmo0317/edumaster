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
const RULE_NAMES = '판독, 용어, STEP 수와 순서, STEP 제목, 풀이 방식, 정답, STEP 범위, 결론 노출, 조건, 단서, 수치, 용기·실험 구성, 형식, 구조, STEP 전부 필요, 범위, 보기 분석, 덧붙임, 표기';

/** The reviewer's instructions: the criteria, and the learning for this problem (all rules, or the given ones). */
function reviewSystem(material, allRules, generationRules = null) {
  const learnedA = analysisLearning(allRules, material);
  const learnedG = generationRules || selectRules(allRules, material);
  return `너는 고등학교 ${material.subject || '과학'} 문항을 검토하는 출제 전문가다. AI가 정리한 분석 결과와 AI가 만든 변형 문제를 원본 이미지와 대조해 독립적으로 검토한다.
- 변형 문제는 반드시 네가 직접 끝까지 풀어서 정답을 확인한다. 표시된 정답이나 해설을 믿지 않는다.
- 아래 [검수 기준]과 [이 문제에 적용되는 학습]을 하나씩 대조한다. 실제 결함만 적고, 기준의 'E. 결함이 아닌 것'은 적지 않는다.
- 각 결함은 어디에서 무엇이 왜 틀렸는지 구체적으로 쓰고, rule에 기준 항목 이름(${RULE_NAMES}) 하나를 쓴다. 학습을 어겼으면 rule은 "학습"이고 detail 앞에 그 학습 문장을 인용한다.
- 한국어로 쓴다. JSON만 출력한다.

[검수 기준]
${criteria()}
[이 문제에 적용되는 학습 — 분석]
${ruleLines([...learnedA.guides, ...learnedA.own, ...learnedA.lessons])}

[이 문제에 적용되는 학습 — 변형 문제와 해설]
${ruleLines(learnedG)}

반환 형식:
{"analysis":{"verdict":"ok|issues","issues":[{"severity":"high|mid|low","rule":"...","where":"문제/STEP n","detail":"..."}]},
 "items":[{"label":"...","myAnswer":"내가 푼 정답 번호와 핵심 값","markedAnswer":3,"answerOk":true,"verdict":"use|fix|reject","issues":[{"severity":"high|mid|low","rule":"...","detail":"..."}]}],
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

module.exports = { reviewSystem, setText, itemReviewText, itemFaults, CRITERIA_FILE };
