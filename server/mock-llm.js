'use strict';
// Offline stand-in for DeepSeek (EDUMASTER_LLM=mock). Returns well-formed answers so the whole flow —
// analysis, generation, code check, blind solve, repair, feedback — can be exercised without paid calls.
const prompts = require('./prompts');

const SAMPLE = {
  title: '화학 반응의 양적 관계 — 한계 반응물과 몰질량',
  subject: '화학', topic: '화학 반응의 양적 관계',
  problem: {
    text: '다음은 $\\ce{A(g)}$와 $\\ce{B(g)}$가 반응하여 $\\ce{C(g)}$와 $\\ce{D(g)}$를 생성하는 반응의 화학 반응식이다.\n\n$$\\ce{A(g) + bB(g) -> 2C(g) + 2D(g)}\\quad(b는\\ 반응\\ 계수)$$\n\n표는 실린더에 A와 B를 넣고 반응을 완결시킨 실험 I~III에 대한 자료이다.\n\n| 실험 | A의 질량(g) | B의 질량(g) | 남은 반응물의 질량(g) | $\\frac{D의\\ 양}{전체\\ 기체의\\ 양}$ (상댓값) |\n|---|---|---|---|---|\n| I | $5w$ | $5w$ | A $\\frac{10}{3}w$ | $x$ |\n| II | $4w$ | $6w$ | A $2w$ | 18 |\n| III | $2w$ | $7w$ | $w$ | 20 |\n\n$\\frac{b}{x}\\times\\frac{C의\\ 몰질량+D의\\ 몰질량}{B의\\ 몰질량}$은? (단, 실린더 속 기체의 온도와 압력은 일정하다.)',
    choices: ['$\\frac{1}{5}$', '$\\frac{2}{5}$', '$\\frac{3}{5}$', '$\\frac{4}{5}$', '1'],
    answer: 2, figure: '',
  },
  annotations: ['표 III의 남은 반응물 칸에 필기로 "B"가 적혀 있음 — 인쇄된 조건이 아님', '정답 ②에 동그라미 표시'],
  solutionSource: 'provided',
  steps: [
    { title: 'I에서 한계 반응물을 구한다', purpose: 'I에서 모두 반응한 물질', technique: 'A가 모두 반응했다고 가정 → I, II의 반응 질량비 비교 → 모순이면 B가 모두 반응', work: '만약 I에서 A가 모두 반응했다면 A $5w$ g과 B $\\frac{5}{3}w$ g이 반응해서 반응 후 B $\\frac{10}{3}w$ g이 남은 것이므로 II에서는 A $4w$ g과 B $\\frac{4}{3}w$ g이 반응해서 반응 후 B $\\frac{14}{3}w$ g이 남아야 하지만 주어진 자료와 맞지 않다. 따라서 I에서 모두 반응한 것은 B이다.', result: 'I에서 B가 모두 반응, A:B 반응 질량비 = 1:3' },
    { title: 'I~III 반응 후 기체의 질량과 양(mol)을 구한다', purpose: '각 실험의 반응 후 몰수', technique: 'A 1g의 양을 n mol, B 1g의 양을 m mol로 두는 보조 문자', work: 'A($g$) $w$ g의 양을 $n$, B($g$) $w$ g의 양을 $m$이라 하면 I에서 A는 $5n$ mol 중 $\\frac{5}{3}n$ mol이 반응하고 $\\frac{10}{3}n$ mol이 남았다. C, D는 각각 $\\frac{10}{3}n$ mol 생성.', result: 'I: A $\\frac{10}{3}n$, C $\\frac{10}{3}n$, D $\\frac{10}{3}n$' },
    { title: 'A~D의 몰질량을 구한다', purpose: 'x, b, 몰질량 비', technique: '상댓값의 비례식으로 x를 구하고 m=n에서 몰질량 비 결정', work: 'II에서 D의 몰분율 실제값은 $\\frac{2}{5}$, 상댓값 18이므로 $\\frac{2}{5}:18=\\frac{1}{3}:x$, $x=15$. III에서 $m=n$이므로 A와 B의 몰질량이 같고 $b=3$, $\\frac{C+D}{B}=2$.', result: '$b=3$, $x=15$, 답 $\\frac{2}{5}$' },
  ],
  techniques: ['A가 모두 반응했다는 가정으로 두 실험의 반응 질량비를 비교해 모순을 보인다', 'A 1g, B 1g의 몰수를 n, m 보조 문자로 둔다'],
  finalCheck: '$\\frac{3}{15}\\times2=\\frac{2}{5}$ → ②',
  uncertainties: [],
};

// The analysis follows the teacher's analysis feedback the way the prompt asks: "STEP을 n개로" splits the last STEP,
// "쉽게" writes the solution out, and each feedback says how it was applied.
function followFeedback(text) {
  // The lines under the problem's analysis feedback and under 공통 지침's analysis instructions.
  const feedback = [];
  let under = false;
  for (const line of text.split('\n')) {
    if (line.startsWith('[')) under = /분석 지침|분석 피드백|분석 교훈/.test(line);
    else if (under && line.startsWith('- ')) feedback.push(line.slice(2));
  }
  if (!feedback.length) return SAMPLE;
  const count = Number(feedback.map((f) => /STEP[을를]?\s*(\d+)\s*개/.exec(f)?.[1]).find(Boolean)) || 0;
  const rewrite = feedback.some((f) => /쉽게/.test(f));
  let steps = SAMPLE.steps.map((s) => ({ ...s, marker: '' }));
  while (count && steps.length < count) {
    const last = steps.pop();
    steps.push({ ...last, title: last.title + ' (앞부분)', result: '' }, { ...last, title: last.title + ' (뒷부분)', purpose: '나머지' });
  }
  if (rewrite) steps = steps.map((s) => ({ ...s, work: '(쉽게 풀어 씀) ' + s.work }));
  return { ...SAMPLE, steps, teacherRequests: { stepCount: count, rewrite },
    feedbackApplied: feedback.map((f) => ({ feedback: f, how: /STEP/.test(f) ? `STEP을 ${steps.length}개로 나눔` : rewrite ? '해설을 쉽게 풀어 씀' : '반영함' })) };
}

let counter = 0;

// How many original STEPs a stage uses, from the stage name the prompt (or the problem's mock tag) carries.
function stageSteps(label, total) {
  const upto = /STEP 1~(\d+)/.exec(label || '');
  if (upto) return Number(upto[1]);
  if (/STEP 1 연습/.test(label || '')) return 1;
  return total;
}

function generated(text) {
  counter++;
  const stageMatch = /\[이번에 만들 문제: ([^\]]+)\]/.exec(text);
  const a = 2 + (counter % 5); const b = 3 + (counter % 4);
  const answerValue = a + b;
  const choices = [answerValue - 2, answerValue - 1, answerValue, answerValue + 1, answerValue + 2];
  const rot = counter % 5; // move the correct answer around
  const rotated = choices.map((_, i) => choices[(i + rot) % 5]);
  const answer = rotated.indexOf(answerValue) + 1;
  const ruleIds = [...text.matchAll(/- \(([a-f0-9]{16})\)/g)].map((m) => m[1]);
  const wantsFix = /\[발견된 문제\]/.test(text);
  // The original's STEP titles as the prompt lists them (the teacher may have edited them).
  const titles = [...text.matchAll(/^STEP (\d+)\. (.+)$/gm)].map((m) => m[2]);
  const k = stageSteps(stageMatch?.[1], titles.length || SAMPLE.steps.length);
  return {
    problem: {
      text: `[모의 생성 · ${stageMatch ? stageMatch[1] : '문제'}] 반응 후 남은 A의 질량이 $a=${a}w$, B의 질량이 $b=${b}w$일 때 $a+b$의 값은? (단위 $w$)`,
      choices: rotated.map(String),
      answer: counter === 2 && !wantsFix ? (answer % 5) + 1 : answer, // second problem starts wrong to exercise repair
      figure: '',
    },
    // Keeps the teacher's STEP titles and method, as a good answer does (assume → contradiction, then n and m).
    solution: {
      steps: Array.from({ length: k }, (_, i) => ({
        step: i + 1, title: titles[i] || SAMPLE.steps[i]?.title || `STEP ${i + 1}`,
        work: i === 0 ? `만약 A가 모두 반응했다면 주어진 자료와 맞지 않다. 따라서 B가 모두 반응한다. $a+b=${a}+${b}=${answerValue}$` : 'A $w$ g의 양을 $n$, B $w$ g의 양을 $m$이라 한다.',
      })),
      summary: `정답 ${answerValue}`,
    },
    usesSteps: Array.from({ length: k }, (_, i) => i + 1),
    designNote: '모의 모드: 실제 모델을 호출하지 않았습니다.',
    appliedRules: ruleIds.map((id) => ({ id, how: '모의 모드에서 지침을 확인했다고 표시' })),
    verification: { program: [`a = ${a}`, `b = ${b}`, 'ans = a + b'], answer: 'ans', choices: rotated.map(String), free: [], checks: [{ expr: 'a > 0 and b > 0', desc: '질량은 양수' }] },
  };
}

function solved(text) {
  const a = Number(/\$a=(\d+)w\$/.exec(text)?.[1]); const b = Number(/\$b=(\d+)w\$/.exec(text)?.[1]);
  const lines = text.split('\n');
  const choices = lines.filter((l) => /^\d\) /.test(l)).map((l) => l.slice(3).trim());
  const index = choices.indexOf(String(a + b)) + 1;
  // The STEPs the problem's stage needs (its mock tag names the stage).
  const listed = [...text.matchAll(/^STEP (\d+)\./gm)].length;
  const stepsUsed = Array.from({ length: stageSteps(/\[모의 생성 · ([^\]]+)\]/.exec(text)?.[1], listed) }, (_, i) => i + 1);
  return { solution: `$${a}+${b}=${a + b}$`, answer: index, answerValue: String(a + b), confident: true, stepsUsed, issues: [], rules: [] };
}

function mock(messages) {
  const system = messages[0].content;
  const user = messages[1].content;
  const text = typeof user === 'string' ? user : user.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
  let data;
  if (system === prompts.ANALYZE_SYSTEM) data = followFeedback(text);
  else if (system === prompts.REGROUP_SYSTEM) {
    const n = Number(/STEP을 (\d+)개 묶음/.exec(text)?.[1]); const total = Number(/이 (\d+)개 STEP을/.exec(text)?.[1]);
    data = { groups: Array.from({ length: n }, (_, i) => ({ steps: i < n - 1 ? [i + 1] : Array.from({ length: total - n + 1 }, (_, k) => n + k), title: `묶음 ${i + 1}` })) };
  } else if (system === prompts.REREAD_QUESTION_SYSTEM) {
    data = { question: SAMPLE.problem.text.split('\n').filter((l) => l.trim()).pop() };
  } else if (system === prompts.FIX_VERIFICATION_SYSTEM) {
    data = { verification: { program: ['a = 1'], answer: '', choices: [], free: [], checks: [{ expr: 'a == 1', desc: 'mock' }] } };
  } else if (system === prompts.REREAD_PROBLEM_SYSTEM) {
    data = { text: SAMPLE.problem.text, figure: SAMPLE.problem.figure || '' };
  } else if (system === prompts.REREAD_HEADINGS_SYSTEM) {
    data = { steps: SAMPLE.steps.map((s, i) => ({ marker: `step${i + 1}`, title: s.title })) };
  } else if (system === prompts.PROOFREAD_SYSTEM) {
    // Like a real proofreader, it takes a solution written out differently for the printed one being misread.
    const rewritten = /"steps\[0\]\.work": "\(쉽게 풀어 씀\) /.test(text);
    data = { fixes: [{ field: 'problem.text', wrong: '실험 I~III에 대한', right: '실험 Ⅰ~Ⅲ에 대한', reason: '로마 숫자' },
      ...(rewritten ? [{ field: 'steps[0].work', wrong: '(쉽게 풀어 씀) ', right: '', reason: '원본에 없는 문장' }] : [])], solutionStepCount: 3 };
  }
  else if (system === prompts.SOLVE_SYSTEM) data = solved(text);
  else if (system === prompts.SOLUTION_REVIEW_SYSTEM) data = { steps: [{ step: 1, ok: true, issues: [] }], rules: [] };
  else if (system === prompts.WRITE_SOLUTION_SYSTEM) {
    // Writes the designer's outline out as is (the real writer expands it in the teacher's format).
    const outline = (text.split('[출제자의 풀이 요지')[1] || '').split('\n[')[0];
    const steps = [...outline.matchAll(/^STEP (\d+)\. ([^\n]*)\n([\s\S]*?)(?=\n\nSTEP \d+\.|\n요약:|$)/gm)].map((m) => ({ step: Number(m[1]), title: m[2], work: m[3].trim() }));
    data = { solution: { steps, summary: '모의 해설' } };
  } else if (system === prompts.ADJUDICATE_SYSTEM) data = { problemAtFault: false, reason: '모의 판정: 검토자 계산 실수' };
  // One item per set that had faults, about the first one (a real model generalizes them).
  else if (system === prompts.LEARN_SYSTEM) {
    const first = /\n- \(([^)]*)\) (.+)/.exec(text.split('[이번 세트에서 나온 실수]')[1] || '');
    data = { items: first ? [{ text: `모의 학습: ${first[2].slice(0, 60)} 같은 실수를 처음부터 피한다.`, scope: 'problem', target: 'problem', why: first[2].slice(0, 80) }] : [] };
  }
  // Two items are one when they share their first five characters (a real model reads them).
  else if (system === prompts.MERGE_SYSTEM) {
    const [a, b] = ['A', 'B'].map((k) => new RegExp(`\\[학습 ${k}\\]\\n(.*)`).exec(text)?.[1] || '');
    const same = a.slice(0, 5) === b.slice(0, 5);
    data = { same, text: same ? `${a} (모의 합침)` : '', why: '모의 판정' };
  }
  else data = generated(text);
  const content = JSON.stringify(data);
  return new Promise((resolve) => setTimeout(() => resolve({
    choices: [{ finish_reason: 'stop', message: { content } }],
    usage: { prompt_tokens: Math.round(text.length / 2), completion_tokens: Math.round(content.length / 3), total_tokens: Math.round(text.length / 2 + content.length / 3) },
  }), Number(process.env.EDUMASTER_MOCK_DELAY_MS ?? 300)));
}

module.exports = { mock, SAMPLE };
