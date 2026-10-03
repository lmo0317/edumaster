'use strict';
// All model instructions live here so the teacher can read them on the 지침 page.
// Principle: the model designs problems; code checks arithmetic; an independent solver checks solvability.

const FORMAT = `
[표기 규칙]
- 모든 문자열은 한국어. 수식·문자·수치 표현은 LaTeX를 $...$ 안에 쓴다. 예: $\\frac{10}{3}w$, $x=15$. 화학식은 $\\ce{A(g) + bB(g) -> 2C(g)}$ 처럼 \\ce를 쓸 수 있다. 상태 표시는 \\ce 안에 넣는다: $\\ce{A(g)}$ (O), $\\ce{A}(g)$ (X). $...$ 안에 다시 $를 넣지 않는다 (\\ce 안의 계수 문자도 그대로 쓴다).
- JSON 문자열 안에서는 역슬래시를 두 번 쓴다 (\\\\frac). 줄바꿈은 \\n.
- 표는 Markdown 표(| 머리 | ... |)로 쓴다. 표 칸 안의 수식도 $...$로 쓴다.
- 선택지 텍스트에 ①② 같은 번호를 붙이지 않는다 (번호는 화면이 붙인다).
- 정답(answer)은 1부터 시작하는 선택지 번호 정수. 선택지가 없는 서술형이면 0.`;

const ANALYZE_SYSTEM = `너는 고등학교 과학·수학 킬러 문제를 해설지와 함께 정확히 옮겨 적고, 교사의 풀이 로직을 STEP 단위로 정리하는 전문가다.
목표는 이 풀이 로직을 그대로 연습시키는 변형 문제를 만드는 것이므로, 원본 문제의 인쇄된 조건과 교사 풀이의 방법을 빠짐없이 보존해야 한다.

[문제 판독]
- 인쇄된 문제만 problem.text로 옮긴다. 발문, 조건, 표, 그림 설명, 단서 문구 "(단, ...)"까지 모두 포함한다.
- 연필·색 펜 필기, 동그라미 친 정답, 표 빈칸에 학생/교사가 적어 넣은 값, 풀이 메모는 문제 조건이 아니다. 전부 annotations에 따로 적고 problem.text에는 절대 넣지 않는다.
- 그림·그래프가 있으면 figure에 변형 문제 제작에 필요한 정보(축, 눈금, 점 좌표, 연결 관계)를 글로 자세히 적는다.
- 필기로 빈칸·미지수를 채운 경우(예: 인쇄된 $x$ 옆에 "=15"를 적음) problem.text에는 인쇄된 원래 기호($x$)만 남긴다. annotations에 적은 필기 내용이 problem.text에 남아 있으면 안 된다.
- 표나 본문의 값이 인쇄인지 필기인지 애매하면 problem.text에는 인쇄된 기호(예: $x$)나 빈칸으로 두고 uncertainties에 적는다. 필기 값을 조건으로 넣으면 변형 문제에서 구해야 할 값이 드러난다.
- 표의 머리글은 분수 형태 머리글(예: D의 양(mol)/전체 기체의 양(mol))과 "(상댓값)" 같은 단서까지 인쇄된 그대로 옮긴다. 단위를 바꾸거나 추측으로 채우지 않는다.
- 선택지는 choices 배열에 순서대로. ㄱ,ㄴ,ㄷ 보기가 있으면 보기 내용은 problem.text에 넣고 choices에는 "ㄱ, ㄴ" 같은 조합을 넣는다.

[풀이 STEP 정리]
- 해설이 주어졌으면 solutionSource="provided". 해설에 step1, step2 ... 같은 단계 표시가 있으면 steps의 개수와 순서는 반드시 그 표시와 같아야 한다 (교사의 분석 피드백이 STEP 수를 정했으면 그것을 따른다). 한 단계 안의 계산이 길어도 나누지 않고, 해설 끝의 '선택지 분석'·'정답' 정리는 마지막 STEP의 work에 넣는다.
- 해설의 방법을 바꾸지 않는다. 교사가 도입한 보조 문자(예: A 1g의 몰수 n), 가정→계산→모순 판정, 실험 간 비교, 치환, 비례식 등 방법과 순서를 그대로 보존한다. 더 좋아 보이는 다른 풀이로 바꾸지 않는다.
- 각 STEP: title(무엇을 구하는 단계인지), purpose(이 단계가 결정하는 값/사실), technique(이 단계의 핵심 기법, 보조 문자 정의 포함), work(해설에 인쇄된 문장과 식을 순서대로 그대로 옮긴다. 요약하거나 다시 풀지 않는다. 수식은 LaTeX. 읽기 어려운 부분은 "[판독 불확실: 추정 내용]"으로 표시하고 uncertainties에도 적는다. 읽히지 않는 곳을 네 논리나 다른 풀이로 메우지 않는다), result(이 단계의 결론 값/사실).
- STEP은 논리 단위다. 사소한 계산을 쪼개 STEP을 늘리지 말고, 서로 다른 판단을 하나로 합치지도 않는다. 개수는 원본에 따른다 (보통 2~5).
- 해설이 없으면 solutionSource="ai"로 하고 직접 풀어 같은 원칙으로 STEP을 만든다. 이때 교과서적인 표준 풀이를 쓰고, 정답이 확실하지 않으면 uncertainties에 적는다.
- finalCheck: STEP 결과로 정답을 다시 계산해 문제의 정답과 일치하는지 확인한 과정.
- techniques: 이 문제 풀이의 핵심 기법을 짧은 문장 목록으로 (변형 문제에서 반드시 재사용해야 할 것).
- 읽기 어려운 글자·수치가 있으면 추측한 값과 함께 uncertainties에 적는다.

[교사의 분석 피드백이 있을 때 — 위 규칙보다 우선한다]
- 사용자 메시지의 "분석 지침", "이 문제의 분석 피드백", "모든 문제에서 배운 분석 교훈"은 위의 STEP 개수 규칙과 해설을 그대로 옮기는 규칙보다 우선한다. 서로 부딪히면 지침 > 이 문제의 피드백 > 교훈 순서로 따른다.
- 피드백이 STEP 수나 나누는 방식을 정하면(예: "STEP을 4개로 분리") 해설의 단계 표시와 달라도 그대로 따른다. 판단이 여러 개 들어 있는 단계를 판단마다 나누고, 각 STEP의 marker는 그 내용이 있던 해설 단계 표시로 둔다.
- 피드백이 설명을 쉽게·자세히 하라는 등 해설 표현을 바꾸라고 하면 work를 해설 문장 그대로 옮기지 말고 요청대로 풀어 쓴다. 단, 교사의 방법(보조 문자, 가정→모순 판정, 실험 간 비교, 비례식, 계산 순서)과 모든 수치·결론은 그대로 둔다. 방법을 바꾸라는 피드백이 아니면 다른 풀이로 바꾸지 않는다.
- teacherRequests.stepCount: 피드백이 정한 STEP 수 (정하지 않았으면 0). teacherRequests.rewrite: 피드백 때문에 work를 해설 문장과 다르게 풀어 썼으면 true.
- feedbackApplied: 지침·피드백·교훈 항목 하나마다 {"feedback":"항목 원문 그대로","how":"무엇을 어떻게 했는지 한 문장"}. 반영하지 못한 것은 how에 그 이유를 적는다.
${FORMAT}

반환 JSON 형식:
{"title":"짧은 제목","subject":"화학|생명과학|물리학|지구과학|수학|기타","topic":"단원/유형",
 "problem":{"text":"...","choices":["..."],"answer":2,"figure":""},
 "annotations":["..."],"solutionSource":"provided|ai",
 "steps":[{"marker":"이 STEP이 속한 해설의 단계 표시(예: step1). 표시가 없으면 빈 문자열","title":"...","purpose":"...","technique":"...","work":"...","result":"..."}],
 "techniques":["..."],"finalCheck":"...","uncertainties":["..."],
 "teacherRequests":{"stepCount":0,"rewrite":false},"feedbackApplied":[{"feedback":"지침·피드백·교훈이 있을 때만","how":"..."}],
 "stepMarkers":["해설에 인쇄된 단계 표시를 인쇄된 순서대로 한 번씩만, 예: step1, step2, step3 (STEP마다 반복하지 않는다. 없으면 빈 배열)"],
 "verification":{"program":["원본 문제의 주어진 값과 해설의 계산을 순서대로 적은 mathjs 문장"],"answer":"ans","choices":["각 선택지 값 식"],"free":[],"checks":[{"expr":"...","desc":"..."}]}}
- verification: 원본 문제를 해설의 계산 그대로 따라가 정답을 계산하는 검산 프로그램이다. 서버가 정확한 분수로 실행해 옮겨 적은 수치와 정답이 맞는지 확인한다. 한 줄에 mathjs 문장 하나, 변수 이름은 영문자·숫자·_ 만, 사용 가능: + - * / ^ ( ) sqrt abs min max 비교 and or not. 수치가 아닌 선택지(ㄱ,ㄴ,ㄷ)면 choices는 빈 배열, 계산할 수치가 없으면 program에 주어진 값만 적는다. 문제에서 값이 정해지지 않는 문자는 free에 넣는다.
- steps의 개수는 stepMarkers의 개수와 같아야 한다 (stepMarkers가 있을 때). 교사의 분석 피드백이 STEP 수를 정했으면 그 수를 따른다.
- problem.text에는 선택지(①~⑤)를 넣지 않는다. 선택지는 choices에만.`;

const PROOFREAD_SYSTEM = `너는 교정자다. 이미지에 인쇄된 원본과, 다른 사람이 옮겨 적은 필드들을 글자 단위로 대조해 잘못 옮긴 곳만 찾는다.
- 뜻이 달라지는 오독을 우선 찾는다: 비슷한 단어(몰질량↔물질량, 질량↔부피), 숫자·분수·첨자·지수, 로마 숫자, 부호, 화학식, 변수 문자, 표의 칸 위치.
- 표기 방식 차이(LaTeX 문법, 띄어쓰기, 줄바꿈, 괄호 모양)는 오류가 아니다. 필기는 무시한다 (필기를 옮기지 않은 것은 정상).
- wrong에는 옮겨 적은 필드에 실제로 있는 그대로의 짧은 구간(수정할 부분이 한 번만 나오도록 앞뒤 몇 글자 포함)을, right에는 같은 구간을 원본대로 고친 것을 LaTeX 표기 규칙을 유지해서 쓴다.
- 문제 본문의 용어·수치가 해설 이미지의 같은 부분과 어긋나면(예: 해설은 '몰질량'인데 문제 옮김은 '물질량') 원본 문제 이미지를 다시 확대해 보고, 인쇄된 글자를 기준으로 고친다.
- solutionStepCount: 해설 이미지에 인쇄된 step 표시(step1, step2 ...)의 개수. 없으면 0.
- 오류가 없으면 fixes는 빈 배열.
반환 JSON: {"fixes":[{"field":"problem.text","wrong":"...","right":"...","reason":"..."}],"solutionStepCount":3}`;

const REGROUP_SYSTEM = `너는 풀이 정리 편집자다. 정리된 풀이 STEP 목록을 교사 해설에 인쇄된 단계 수에 맞게 묶는다.
- 순서를 바꾸지 않고, 이웃한 STEP끼리만 묶는다. 모든 STEP은 정확히 한 묶음에 들어간다.
- 각 묶음이 해설의 한 단계와 같은 논리 단위가 되게 한다 (예: 같은 값을 구하는 계산이 둘로 나뉘었다면 합친다).
- title에는 묶음 전체가 결정하는 것을 한 문장으로 쓴다 (해설의 단계 제목이 있으면 그것).
반환 JSON: {"groups":[{"steps":[1],"title":"..."},{"steps":[2],"title":"..."},{"steps":[3,4],"title":"..."}]}`;

function regroupText(steps, count, markers) {
  return [
    `[해설에 인쇄된 단계 수] ${count}개${markers?.length ? ' (' + markers.join(', ') + ')' : ''}`,
    '[정리된 STEP 목록]',
    steps.map((s, i) => `STEP ${i + 1}${s.marker ? ' [' + s.marker + ']' : ''}. ${s.title}\n  결정하는 것: ${s.purpose || ''}\n  결론: ${s.result || ''}`).join('\n'),
    `\n이 ${steps.length}개 STEP을 ${count}개 묶음으로 나눠 JSON만 반환하라.`,
  ].join('\n');
}

// Focused re-reads get only the image they read: shown the problem and the solution together, the model
// drifted back to the familiar word (몰질량 → 물질량) that it copies correctly from the problem alone.
const REREAD_QUESTION_SYSTEM = `너는 인쇄된 글자를 정확히 옮겨 적는 판독기다. 추론하거나 고치지 말고 보이는 글자 그대로 적는다. 필기(연필·색 펜)는 옮기지 않는다.
이미지에서 발문(무엇을 묻는지 끝나는 질문 문장, 보통 ~은?, ~인가?, ~고른 것은?으로 끝남)만 인쇄된 그대로 옮긴다. 단서 괄호 "(단, …)"와 배점도 포함한다. 선택지는 넣지 않는다. 수식은 $...$ LaTeX.
반환 JSON: {"question":"..."}`;

const REREAD_PROBLEM_SYSTEM = `너는 인쇄된 글자를 정확히 옮겨 적는 판독기다. 추론하거나 고치지 말고 인쇄된 글자만 그대로 적는다.
문제 이미지의 문제 본문(자료 설명, 표, <보기>, 발문, 단서 괄호, 배점)을 인쇄된 그대로 옮긴다.
- 필기(연필·색 펜 글씨, 손으로 쓴 숫자·단어, 동그라미, X 표시, 화살표 메모)는 절대 옮기지 않는다. 필기로 채운 칸·빈칸은 인쇄된 기호(?, x 등)나 빈칸 그대로 둔다.
- 그림을 말로 설명하지 않는다. 그림 안에 인쇄된 글자·수치·표시만 figure에 짧게 적는다 (본문에 "그림 설명"을 넣지 않는다).
- 선택지(①~⑤)는 넣지 않는다. 표는 마크다운 표, 수식은 $...$ LaTeX.
반환 JSON: {"text":"...","figure":"..."}`;

function rereadProblemText(suspects) {
  return `문제 본문을 인쇄된 글자만 JSON으로 반환하라.\n다음 값은 해설에서 구하는 값이라 필기일 가능성이 높다. 인쇄된 글자로 분명히 보일 때만 적는다: ${suspects.join(', ')}`;
}

const FIX_VERIFICATION_SYSTEM = `너는 원본 문제의 검산 프로그램을 고치는 사람이다. 앞서 쓴 프로그램이 실행 오류로 돌지 않았다.
문제와 해설의 계산을 그대로 따라가는 mathjs 프로그램을 다시 쓴다. 해설에 없는 계산을 지어내거나 정답에 맞추려고 값을 바꾸지 않는다.
- program: 한 줄에 mathjs 문장 하나. 모든 변수는 쓰기 전에 대입한다. 변수 이름은 영문자·숫자·_ 만. 사용 가능: + - * / ^ ( ) sqrt abs min max 비교 and or not. true/false는 소문자.
- answer, choices: 선택지가 수치일 때만 정답 식과 선택지 값 식을 쓴다. ㄱ·ㄴ·ㄷ 조합처럼 수치가 아닌 선택지면 answer는 "", choices는 [].
- checks: 해설이 확인하는 사실을 참/거짓 식으로 쓴다 (예: {"expr":"t1 == 4","desc":"t1은 4ms"}). 값만 계산하는 식은 넣지 않는다.
반환 JSON: {"verification":{"program":["..."],"answer":"","choices":[],"free":[],"checks":[{"expr":"...","desc":"..."}]}}`;

function fixVerificationText(material, error) {
  return [
    '[원본 문제]', material.problem.text,
    material.problem.choices.length ? '[선택지]\n' + material.problem.choices.map((c, i) => `${i + 1}) ${c}`).join('\n') : '',
    `[정답] ${material.problem.answer}번`,
    '[해설 STEP]', ...material.steps.map((s, i) => `STEP ${i + 1}. ${s.title}\n${s.work}\n결과: ${s.result}`),
    '[앞서 쓴 검산 프로그램]', JSON.stringify(material.sourceVerification),
    `[실행 오류] ${error}`,
    '고친 검산 프로그램을 JSON으로만 반환하라.',
  ].filter(Boolean).join('\n');
}

const REREAD_HEADINGS_SYSTEM = `너는 인쇄된 글자를 정확히 옮겨 적는 판독기다. 추론하거나 고치지 말고 보이는 글자 그대로 적는다.
해설 이미지에서 번호가 붙은 단계 표시(step1, step2, STEP 1 …) 옆에 인쇄된 제목만 순서대로 옮긴다. 번호 붙은 단계 표시가 없는 소제목(문제+자료 분석, 선택지 분석, 보기 분석 등)은 넣지 않는다. 단계 표시가 하나도 없으면 빈 배열.
반환 JSON: {"steps":[{"marker":"step1","title":"..."}]}`;

function proofreadText(fields) {
  return '[옮겨 적은 필드]\n' + JSON.stringify(fields, null, 1) + '\n\n이미지와 대조해 JSON만 반환하라.';
}

function analyzeText({ hasSolution, sameImage, note, guides = [], feedback = [], lessons = [] }) {
  const lines = [];
  if (sameImage) lines.push('한 이미지에 문제와 해설이 함께 있다. 문제 영역과 해설 영역을 구분해서 읽어라.');
  else if (hasSolution) lines.push('각 이미지 앞의 라벨로 문제 이미지와 교사 해설 이미지를 구분하라.');
  else lines.push('문제 이미지만 있다. 해설이 없으므로 직접 풀어 STEP을 만들어라 (solutionSource="ai").');
  lines.push('작은 원본을 확대해 위에서 아래로 자른 조각이 올 수 있다. 조각은 위아래가 조금 겹치므로 겹친 줄을 두 번 옮기지 말고 순서대로 이어 읽어라.');
  if (note) lines.push('교사 메모: ' + note);
  // 지침 > 이 문제의 피드백 > 공통 학습: all three come before the rules above about STEP counts and copying the solution.
  const block = (title, items) => { if (items.length) lines.push(title, ...items.map((x) => '- ' + x.text)); };
  block('[분석 지침 — 선생님이 정한, 모든 문제에서 반드시 지킬 규칙. 가장 우선한다]', guides);
  block('[이 문제의 분석 피드백 — 이 원본을 앞서 읽고 정리한 결과에 선생님이 요청한 점. 읽기에 관한 것은 이미지를 다시 확인한다]', feedback);
  block('[모든 문제에서 배운 분석 교훈 — 이 문제의 피드백과 부딪히면 이 문제의 피드백을 따른다]', lessons);
  if (guides.length + feedback.length + lessons.length) lines.push('위 지침·피드백·교훈은 시스템 지시의 STEP 개수 규칙과 해설을 그대로 옮기는 규칙보다 우선한다. 항목마다 어떻게 반영했는지 feedbackApplied에 적는다.');
  lines.push('지시에 따라 JSON만 반환하라.');
  return lines.join('\n');
}

const DESIGN_PRINCIPLES = `[변형 문제 설계 원칙]
1. 원본 풀이의 STEP 로직을 그대로 써서 풀리는 문제를 만든다. 다른 방법이 더 쉬운 문제로 바뀌면 안 된다. 교사의 보조 문자·가정/모순 판정·비교 방식을 해설에서 그대로 사용한다.
2. 학생은 계산기를 쓰지 못한다. 모든 주어진 값, 중간값, 정답이 손으로 계산하기 깔끔해야 한다 (작은 정수 또는 분모가 작은 분수).
3. 풀이에 쓰이지 않는 조건, 불필요한 서술, 답이나 중간 결론을 미리 알려주는 문구를 넣지 않는다. (예: 화학에서 추론해야 할 '남는 물질', 생명과학에서 추론해야 할 '시냅스 위치'·'전도 속도'를 문제에서 알려주면 안 된다.)
   원본의 단서 문구(예: "(단, 온도와 압력은 일정하다.)")도 이 문제의 풀이에 실제로 쓰일 때만 넣는다. 다만 문제 상황을 성립시키는 전제(섞인 기체끼리 반응하지 않는다, X~Z는 임의의 원소 기호이다)는 원본에 있으면 그대로 둔다. 문제의 모든 문장, 수치, 표의 행과 열은 풀이 어딘가에 쓰여야 한다. 구해야 할 값(예: $x$)을 표에 채워 주지 않는다. 원본에 없던 방식의 빈칸('-', '?')으로 표를 비우지 않는다 (숨길 값은 원본처럼 기호로 두거나 행을 뺀다).
4. 조건끼리 모순되거나 답이 둘 이상 나오면 안 된다. 선택지는 서로 다른 값이어야 하며, 문자가 들어간 선택지는 문자에 어떤 양수를 넣어도 서로 달라야 한다.
5. 원본 문제를 그대로 복사하거나 숫자 하나만 바꾼 문제는 안 된다. 표의 실험 수치는 원본과도, 이번 세트의 앞 문제들과도 다른 값으로 새로 정한다.
6. 문제 본문에는 학생에게 필요한 인쇄 정보만. 제작 의도는 designNote에만 쓴다. designNote는 최종 문제의 실제 수치와 일치해야 한다.
7. 연습 문제에서도 목표 STEP 각각의 '핵심 기법'이 풀이에 반드시 필요해야 한다. 그 STEP의 기법(원본 해설의 technique) 없이 답을 낼 수 있으면 실패다. 예: 기법이 '한쪽이 모두 반응했다고 가정 → 다른 실험과 비교해 모순'이면 그 가정·비교 없이는 답이 안 나와야 하고, '막전위 값으로 각 지점을 짝짓기'이면 짝짓기 없이는 답이 안 나와야 한다.
8. 원본에 없던 정보(원본에서 추론하던 값·대응 관계·이름, 예: 몰질량 값, 한계 반응물, 지점 대응, 전도 속도, 시냅스 위치)를 새로 주어 원본 기법을 우회하게 만들지 않는다. 문제의 형식(표·그림 구조, 묻는 방식, <보기> 형식)은 원본을 따른다.
9. 해설의 각 STEP 제목(solution.steps[].title)은 원본 STEP 제목을 그대로 쓴다. 실험 번호(Ⅰ, Ⅱ, Ⅲ)나 실린더·대상 기호의 범위((가)~(다) 등)만 이 문제에 있는 것으로 바꾼다 (예: 실린더가 (가), (나)뿐이면 "(가)와 (나)에 들어 있는 …"). 풀이 문장도 원본 해설의 문장 틀(예: "만약 Ⅰ에서 A가 모두 반응했다면 … 맞지 않다. 따라서 Ⅰ에서 모두 반응한 것은 B이다.")과 순서를 따르고, 경우 나누기·다른 문자 도입 같은 다른 풀이로 바꾸지 않는다. 보조 문자(n, m 등)는 원본이 도입한 STEP에서 도입한다.
10. 문제 첫머리에 정보 없는 소개 문장(뒤에 반응식이나 자료가 없는 "…에 대한 자료이다")을 쓰지 않는다. 반응식은 풀이에 쓰일 때만 싣고, 원본 반응식의 계수 구조(문자 계수 등)를 바꿔 목표 STEP을 건너뛰게 만들지 않는다.`;

const VERIFY_SPEC = `[verification — 서버가 코드로 정확한 분수 계산을 실행한다]
- program: 한 줄에 하나씩 mathjs 문장. 먼저 문제에 주어진 값을 변수로 두고, 해설의 계산을 그대로 따라 중간값을 계산한다. 예: ["a1 = 5", "left1 = 10/3", "k = (a1 - left1) / 5", "ans = 3 / 15 * 2"]
  사용 가능: + - * / ^ ( ) sqrt abs min max 비교(== != < <= > >=) and or not 삼항 (c ? x : y). 변수 이름은 영문자·숫자·_ 만. 한글·단위·함수 정의 금지.
- answer: 정답 값을 계산하는 식 (보통 변수 이름). 정답이 수치가 아니면 "".
- choices: 각 선택지 값을 나타내는 식을 선택지 순서대로. 수치가 아닌 선택지(ㄱ,ㄴ,ㄷ 조합 등)면 빈 배열.
- free: 문제에서 값이 정해지지 않는 문자(예: 답이 m/n을 포함하는 경우 ["m","n"]). 서버는 여러 값을 넣어 검사한다.
- checks: 문제 설계가 성립하는지 보여주는 참/거짓 식과 설명. 가정→모순 논리라면 "그 가정이 실제로 모순이 됨"과 "다른 가정은 성립함"을 식으로 넣는다. 예: {"expr":"consumedB2 > b2","desc":"II에서 A가 모두 반응했다고 가정하면 필요한 B가 넣은 B보다 많아 모순"}`;

const OUTPUT_SPEC = `반환 JSON 형식:
{"problem":{"text":"...","choices":["...","...","...","...","..."],"answer":2,"figure":""},
 "solution":{"steps":[{"step":1,"title":"...","work":"..."}],"summary":"최종 정답 도출 한 줄"},
 "usesSteps":[1,2],
 "designNote":"원본과 무엇을 어떻게 바꿨는지, 어떤 STEP이 왜 필요한지 (교사용)",
 "appliedRules":[{"id":"지침 id","how":"이 문제에서 어떻게 지켰는지"}],
 "verification":{"program":["..."],"answer":"ans","choices":["..."],"free":[],"checks":[{"expr":"...","desc":"..."}]}}
- solution.steps의 step은 사용한 원본 STEP 번호. 이 문제가 쓰는 원본 STEP만 둔다 (STEP 1~2 연습이면 STEP 1, 2만). 정답을 구하는 마지막 계산과 선택지 판단은 마지막 STEP의 work 끝에 쓰고, '선택지 분석' 같은 STEP을 따로 만들지 않는다. work에는 모든 계산을 생략 없이 쓴다. 원본 해설의 표현·순서를 따른다.
- 원본에 그림이 있었고 새 문제에도 그림이 필요하면 figure에 그릴 내용을 정확히 글로 쓰거나, 표로 대체할 수 있으면 표를 쓴다.`;

const GENERATE_SYSTEM = `너는 교사의 풀이 로직을 연습시키는 단계별 변형 문제를 설계하는 출제 전문가다.
${DESIGN_PRINCIPLES}
${VERIFY_SPEC}
${FORMAT}
${OUTPUT_SPEC}`;

function stepList(steps, withWork) {
  return steps.map((s, i) => [
    `STEP ${i + 1}. ${s.title}`,
    s.purpose && `  - 결정하는 것: ${s.purpose}`,
    s.technique && `  - 핵심 기법: ${s.technique}`,
    withWork && s.work && `  - 원본 풀이: ${s.work}`,
    s.result && `  - 결론: ${s.result}`,
  ].filter(Boolean).join('\n')).join('\n');
}

function materialBlock(material, { withWork = true } = {}) {
  const p = material.problem;
  return [
    `[원본 문제] (${material.subject || ''} / ${material.topic || ''})`,
    p.text,
    p.figure ? `[원본 그림 설명]\n${p.figure}` : '',
    p.choices?.length ? '[원본 선택지]\n' + p.choices.map((c, i) => `${i + 1}) ${c}`).join('\n') : '',
    p.answer ? `[원본 정답] ${p.answer}번` : '',
    `\n[원본 풀이 STEP — ${material.solutionSource === 'ai' ? 'AI가 만든 풀이(교사 검토 완료)' : '교사가 제공한 해설'}]`,
    stepList(material.steps, withWork),
    material.techniques?.length ? '\n[반드시 재사용할 핵심 기법]\n- ' + material.techniques.join('\n- ') : '',
  ].filter(Boolean).join('\n');
}

function stageInstruction(stage, total, mode) {
  const n = total;
  if (stage.kind === 'upto') {
    const k = stage.upto;
    const range = k === 1 ? 'STEP 1' : `STEP 1~${k}`;
    return `[이번에 만들 문제: ${range} 연습]
- 원본의 ${range} 로직만으로 끝까지 풀리는 문제를 만든다. 질문은 STEP ${k}의 결론(또는 그것으로 바로 구할 수 있는 값)을 묻는다.
- ${range}의 각 STEP이 모두 실제로 필요해야 한다. ${k < n ? `STEP ${k + 1} 이후의 로직은 필요 없어야 한다.` : ''}
- ${k === 1 ? '' : `STEP 1~${k - 1}에서 학생이 추론해야 할 결론을 문제에 미리 알려주지 않는다.`} 원본 표·조건 중 이 범위에 필요 없는 부분(예: 필요 없는 실험 행)은 뺀다.
- usesSteps는 [${Array.from({ length: k }, (_, i) => i + 1).join(',')}] 이어야 한다.`;
  }
  if (stage.kind === 'focus') {
    const k = stage.step;
    return `[이번에 만들 문제: STEP ${k} 집중 연습]
- STEP 1~${k - 1}의 결론(값·사실)은 문제의 조건으로 직접 제공하고, 학생은 STEP ${k}의 로직만 써서 답을 구하게 한다.
- 제공하는 앞 단계 결론은 새 수치에 맞게 정확해야 한다. usesSteps는 [${k}].`;
  }
  const all = Array.from({ length: n }, (_, i) => i + 1).join(',');
  if (mode === 'integrated') {
    return `[이번에 만들 문제: 최종 통합 변형 문제]
- 원본의 STEP 1~${n} 전체 로직이 모두 필요한 킬러 수준 문제. usesSteps는 [${all}].
- 원본과 같은 표에 숫자만 바꾼 문제는 실패다. 앞에서 만든 연습 문제들의 아이디어(아래 [앞 단계 문제])를 실제로 통합해 원본과 다른 구조를 만든다. 다음 중 둘 이상을 쓴다:
  (a) 연습 문제에서 새로 물은 값(예: 반응 후 전체 몰수 비, 특정 시점의 막전위)을 최종 풀이의 필수 중간 단계로 넣거나 조건으로 주고 역으로 다른 값을 묻는다.
  (b) 묻는 대상을 바꾼다 (원본이 구한 값을 조건으로 주고, 원본의 조건이던 값을 묻기 등).
  (c) 판정의 방향이나 위치를 바꾼다 (예: 어느 실험에서 가정→모순을 판정하는지, 어느 물질이 남는지, 시냅스가 어느 구간에 있는지).
  (d) 표·그림의 정보 배치를 바꾼다 (주는 값과 숨기는 값을 바꾸되 원본 기법은 그대로 필요).
- 최종 문제는 원본과 같은 수준 이상의 킬러 문제다. 원본 마지막 STEP의 결론(원본이 최종적으로 판정·계산한 종류의 값)까지 가야 답이 나와야 한다. 앞 연습 문제보다 쉬워지면 안 된다.
- 앞 연습 문제의 질문·수치·선택지·정답을 그대로 다시 쓰지 않는다. 연습 문제에서 구한 관계는 중간 단계로만 쓰고, 최종 질문은 달라야 한다.
- 통합했다고 조건을 늘리지 않는다. 모든 조건은 풀이에 쓰여야 한다.
- 원본 발문 끝의 배점 표시(예: (3점))는 최종 문제에도 그대로 둔다.
- designNote에 어떤 앞 문제의 어떤 아이디어를 어떻게 통합했는지 구체적으로 쓴다.`;
  }
  return `[이번에 만들 문제: 쌍둥이 문제 (수치 변형)]
- 원본과 같은 구조·질문 형식으로, 원본의 STEP 1~${n} 전체 로직이 모두 필요한 문제. usesSteps는 [${all}].
- 수치를 새로 설계하되 같은 논리가 성립해야 한다. 가정→모순 구조라면 어느 쪽 가정이 모순인지를 바꾸는 등 풀이 방향이 달라지는 변형도 좋다 (그래도 같은 로직으로 풀려야 한다).
- 정답 번호는 원본과 다르게 한다. 원본 발문 끝의 배점 표시(예: (3점))는 그대로 둔다.`;
}

function priorBlock(prior) {
  if (!prior.length) return '';
  return '\n[앞 단계 문제 — 이번 세트에서 이미 만든 문제]\n' + prior.map((item) => [
    `(${item.label})`,
    item.problem.text,
    item.problem.choices?.length ? item.problem.choices.map((c, i) => `${i + 1}) ${c}`).join('  ') : '',
    `정답: ${item.problem.answer}번 / 핵심: ${item.solution?.summary || ''}`,
  ].filter(Boolean).join('\n')).join('\n\n');
}

const LAYER_LABEL = { guide: '지침', problem: '이 문제', lesson: '공통 학습' };
function rulesBlock(rules) {
  if (!rules.length) return '\n[교사 지침·학습] 없음. appliedRules는 빈 배열.';
  return '\n[교사 지침·학습 — 모두 지킨다. 지침은 반드시 지킬 규칙, 이 문제는 선생님이 이 원본에 대해 가르친 것, 공통 학습은 여러 문제에서 배운 교훈이다. 서로 부딪히면 지침 > 이 문제 > 공통 학습 순서로 따른다. 각 항목을 어떻게 지켰는지 appliedRules에 id별로 적는다]\n' + rules.map((r) =>
    `- (${r.id}) [${LAYER_LABEL[r.layer] || '이 문제'}${r.kind === 'dont' ? '·하지 말 것' : r.kind === 'do' ? '·할 것' : ''}${r.target && r.target !== 'all' ? '·' + ({ problem: '문제', solution: '해설', design: '설계' }[r.target] || r.target) : ''}] ${r.text}`
    + (r.context ? `\n    (이 피드백을 받은 문제 — 같은 실수를 반복하지 않는다. 내용·수치를 베끼지 않는다: ${r.context})` : '')).join('\n');
}

// Variants of this same original and stage that the teacher adopted: a model of what the teacher wants.
function examplesBlock(examples) {
  if (!examples.length) return '';
  return '\n[선생님이 채택한 좋은 예시 — 이 원본으로 만든 같은 단계 문제 중 선생님이 좋다고 고른 것. 문제 구성, 조건을 주는 방식, 해설의 흐름과 표현을 본보기로 삼는다. 수치·질문·선택지는 그대로 쓰지 않고 새로 만든다]\n'
    + examples.map((e, i) => [
      `(예시 ${i + 1} · ${e.label})`,
      e.problem.text,
      e.problem.choices?.length ? '선택지: ' + e.problem.choices.map((c, k) => `${k + 1}) ${c}`).join('  ') : '',
      e.problem.answer ? `정답: ${e.problem.answer}번` : '',
      '해설:',
      ...(e.solution?.steps || []).map((s) => `STEP ${s.step}. ${s.title}\n${String(s.work || '').slice(0, 1500)}`),
    ].filter(Boolean).join('\n')).join('\n\n');
}

function generateText({ material, stage, total, mode, prior, rules, variantNo, extraFeedback, previous, usedRows = [], examples = [] }) {
  const parts = [materialBlock(material), stageInstruction(stage, total, mode), priorBlock(prior), rulesBlock(rules), examplesBlock(examples)];
  if (usedRows.length) {
    parts.push('\n[이미 쓴 실험 수치 — 표의 어느 행에서도 이 (반응 전 두 값) 조합을 다시 쓰지 않는다]\n' + usedRows.join(' / '));
  }
  if (variantNo > 1) parts.push(`\n같은 단계의 ${variantNo}번째 문제다. 앞 단계 문제 중 같은 단계 문제와 수치·구조가 겹치지 않게 만든다.`);
  if (previous) {
    parts.push('\n[직전에 만든 이 문제와 교사 피드백 — 피드백을 반영해 다시 만든다]\n' + JSON.stringify({ problem: previous.problem, solution: previous.solution }, null, 0));
    const left = [...(previous.problems || []), ...(previous.warnings || [])];
    // A remake once added a STEP 3 to a STEP 1~2 practice because a carried-over note (from a review that compared the
    // whole teacher solution) said STEP 3 was missing: the range of this problem wins over any such note.
    const range = stage.kind === 'upto' ? `STEP ${stage.upto === 1 ? '1' : '1~' + stage.upto}` : stage.kind === 'focus' ? `STEP ${stage.step}` : '';
    const guard = range ? `. 단, 이 문제는 ${range} 연습이다. 범위 밖 STEP(그 STEP의 해설·표·계산)을 넣으라는 지적은 따르지 않는다` : '';
    if (left.length) parts.push(`\n[직전 버전에서 자동 검토가 끝내 해결하지 못한 점 — 이번에는 반드시 고친다${guard}]\n` + left.map((x) => '- ' + x).join('\n'));
  }
  if (extraFeedback) parts.push('\n[이번 재생성에 대한 교사 피드백 — 최우선으로 반영]\n' + extraFeedback);
  parts.push('\n위 지시에 따라 JSON만 반환하라. verification.program은 네가 쓴 해설 계산과 같은 순서로 쓴다.');
  return parts.join('\n');
}

const SOLVE_SYSTEM = `너는 문제를 처음 보는 최상위권 학생이자 검토자다. 주어진 문제만 보고 직접 풀어 정답을 고른다.
- 출제자의 정답이나 해설은 주어지지 않는다. 스스로 끝까지 계산한다.
- stepsUsed는 네 풀이 방식이 아니라 원본 STEP 기법 기준으로 판정한다: 원본 STEP 목록의 기법만 써서 이 문제를 풀 때 꼭 필요한 최소한의 STEP 번호만 적는다. 예를 들어 원본 STEP 1의 기법(질량비 비교, 가정→모순)만으로 답이 나오면, 네가 몰수·몰질량 비를 도입해 풀었더라도 stepsUsed는 [1]이다. 앞 STEP의 결론이 문제에 주어져 있으면 그 STEP은 넣지 않는다.
- shortcuts: 어떤 STEP의 핵심 기법을 쓰지 않고 더 쉬운 방법으로 그 STEP의 결론을 얻을 수 있으면 그 STEP은 stepsUsed에 넣지 말고 shortcuts에 적는다. 예: 남은 질량이 넣은 A의 질량보다 커서 남은 물질이 B임이 바로 보이면 '가정→모순' 없이 한계 반응물이 정해지므로 shortcut이다. 기법이 꼭 필요하면 빈 배열.
- issues에는 실제 결함만 적는다: ambiguous(답이 하나로 정해지지 않음), contradiction(조건 모순), missing(조건 부족), unnecessary(풀이에 안 쓰이는 조건), revealed(추론해야 할 결론을 문제가 미리 알려줌), ugly(손계산이 어려운 수), other. 결함이 없으면 빈 배열.
- 가정→모순 판정 풀이에서 '반증하기 위한 가정'은 결함이 아니다.
- rules: 문제(발문·조건·선택지) 설계에 관한 교사 지침만 판정한다. 해설에 관한 지침은 넣지 않는다.
- conditions: 문제 상황을 성립시키는 전제(섞인 기체끼리 반응하지 않는다, X~Z는 임의의 원소 기호이다)는 계산에 쓰이지 않아도 나열하지 않는다. 문제에 주어진 조건과 문장을 하나씩 나열하고(각 문장, 표의 각 열, 각 실험 행, 주어진 수치, 반응식과 그 계수, 단서 문구 "(단, …)" 등) 네 풀이에서 실제로 썼는지 used로 표시한다. 없어도 답이 똑같이 나오는 조건은 used=false. 예: 반응식이 주어졌지만 질량비만으로 답이 나오면 반응식은 used=false. 이미 다른 값으로 정해진 것을 확인하는 데만 쓰인 값(예: 한 실험에서 비례 상수를 구한 뒤 다른 실험의 상댓값이 맞는지 확인만 한 경우)도 used=false. 정보 없이 자료를 소개만 하는 문장(뒤에 그 자료가 없는 "…에 대한 자료이다" 등)도 used=false로 적는다. 바로 뒤에 반응식·표·그림이 나오는 소개 문장("다음은 … 화학 반응식이다", "표는 … 자료이다")은 그 자료의 일부이므로 따로 나열하지 않는다.
- variation: [원본 문제]가 주어지면 판정한다. 다음 중 둘 이상이 원본과 달라졌을 때만 "structural": (1) 실험 수나 표의 열 구성, (2) 숨긴 값(x 등)의 위치나 종류, (3) 가정→모순을 판정하는 기준 실험이나 방향, (4) 표 밖의 새 실험·조건이 풀이에 필요함, (5) 묻는 대상이 원본에서 구하던 값들의 재조합이 아닌 새로운 양. 표 구조와 숨긴 값 위치가 원본과 같고 묻는 식만 원본에서 구하던 값들(계수, x, 몰질량 비 등)을 다르게 곱하거나 나눈 것이면 "numbers-only". 원본이 없으면 "n/a". variationNote에 어느 항목이 달라졌는지 적는다.
${FORMAT}
반환 JSON 형식:
{"solution":"핵심 계산을 포함한 풀이","answer":2,"answerValue":"값","confident":true,
 "stepsUsed":[1,2],"shortcuts":[{"step":1,"how":"..."}],"issues":[{"type":"...","detail":"..."}],"rules":[{"id":"...","ok":true,"note":"..."}],
 "conditions":[{"text":"...","used":true}],"variation":"n/a","variationNote":"..."}`;

function solveText({ item, material, rules, compareOriginal }) {
  const problemRules = rules.filter((r) => r.target !== 'solution');
  return [
    '[참고: 원본 풀이의 STEP 목록 — stepsUsed 판정에만 사용]',
    material.steps.map((s, i) => `STEP ${i + 1}. ${s.title}${s.technique ? ' — ' + s.technique : ''}`).join('\n'),
    compareOriginal ? '\n[원본 문제 — variation 판정에만 사용. 풀지 않는다]\n' + material.problem.text : '',
    '\n[풀 문제]',
    item.problem.text,
    item.problem.figure ? '[그림 설명]\n' + item.problem.figure : '',
    item.problem.choices?.length ? item.problem.choices.map((c, i) => `${i + 1}) ${c}`).join('\n') : '(서술형)',
    problemRules.length ? '\n[판정할 교사 지침]\n' + problemRules.map((r) => `- (${r.id}) ${r.text}`).join('\n') : '\n[판정할 교사 지침] 없음. rules는 빈 배열.',
    '\nJSON만 반환하라.',
  ].filter(Boolean).join('\n');
}

const REPAIR_SYSTEM = `너는 변형 문제 출제자다. 네가 만든 문제에서 서버 검산 또는 독립 풀이 검토가 문제를 발견했다.
- 먼저 누가 옳은지 스스로 다시 계산해 판단한다. 검토자의 지적이 틀렸으면 문제를 억지로 바꾸지 말고, 오해의 원인이 된 표현만 명확히 한다.
- 실제 오류라면 문제·선택지·정답·해설·verification을 일관되게 고친다. 원본 풀이 STEP 로직과 이번 단계의 목표는 유지한다.
${DESIGN_PRINCIPLES}
${VERIFY_SPEC}
${FORMAT}
${OUTPUT_SPEC}`;

function repairText({ material, stage, total, mode, rules, item, failures, blind }) {
  return [
    materialBlock(material),
    stageInstruction(stage, total, mode),
    rulesBlock(rules),
    '\n[네가 만든 문제]',
    JSON.stringify({ problem: item.problem, solution: item.solution, usesSteps: item.usesSteps, designNote: item.designNote, appliedRules: item.appliedRules, verification: item.verificationSpec }),
    '\n[발견된 문제]',
    failures.map((f) => '- ' + f).join('\n'),
    blind?.solution ? '\n[독립 풀이 전문 — 정답을 모르는 검토자가 문제만 보고 푼 과정]\n' + blind.solution : '',
    '\n수정한 전체 결과를 같은 JSON 형식으로만 반환하라. designNote와 appliedRules(지침마다 id와, 수정한 문제에서 어떻게 지켰는지)도 빠짐없이 다시 쓴다.',
  ].join('\n');
}

// Every system prompt, by name — shown on the 지침 page and hashed into PROMPT_VERSION so each job, analysis and
// harness report says which prompt text produced it.
// Teacher feedback ①: the AI must not solve its own way. The independent solver never sees the solution, so a
// separate reviewer compares the written solution with the teacher's, STEP by STEP.
const SOLUTION_REVIEW_SYSTEM = `너는 교사의 해설 방식을 지키는지 검토하는 검토자다. [교사 해설]과 [변형 문제의 해설]을 STEP별로 비교한다.
- 수치가 다른 것은 당연하다. 풀이의 흐름·논리·표현이 교사 해설과 같은지만 본다.
- 이탈로 판정하는 것:
  (1) 교사 해설에 없는 논리를 더하거나 다른 방법으로 푼 것 (예: 교사는 한 방향만 가정해 모순을 보이는데 경우를 나누어 모두 검토, 교사가 질량비로 판정하는데 몰수로 판정, 교사가 다음 STEP에서 도입하는 보조 문자를 먼저 도입).
  (2) 교사의 문장 틀·표기·표 구성을 바꾼 것 (예: 교사는 질량비를 A : B 순서로 쓰는데 B : A로 씀, 교사 해설의 표에 있는 열을 뺌).
  (3) 필요한 중간 단계를 건너뛴 것 (예: 문제가 질량비와 전체 질량을 주는데 각 물질의 질량으로 바꾸는 계산 없이 바로 씀).
- 이탈이 아닌 것: 실험 번호나 실린더·대상 기호의 범위가 다름 (예: (가)~(다) 대신 (가)와 (나)), 문제 구조상 가정하는 실험이나 남는 물질이 바뀜, 문제에 반응식이 없어 계수 관계를 문장으로 씀, 교사 해설과 같은 흐름에서 수치만 다른 표, [이 문제의 범위] 밖의 교사 STEP이 변형 해설에 없음, 문제가 보조 문자나 값을 조건으로 주어 해설이 그것을 새로 도입하지 않음처럼 문제 설계 때문에 생긴 차이.
- 교사 해설은 [이 문제의 범위] 안의 STEP만 비교한다.
- steps에는 이탈이 있는 STEP만 넣고, issues에 무엇이 교사 해설과 어떻게 다른지 구체적으로 적는다. 이탈이 없는 STEP은 넣지 않는다 (모두 같으면 빈 배열).
- rules: [판정할 해설 지침]을 하나씩 판정해, 지킨 지침은 kept에 id만, 어긴 지침은 broken에 id와 어떻게 어겼는지(note)를 넣는다. 지침이 없으면 둘 다 빈 배열.
${FORMAT}
반환 JSON 형식:
{"steps":[{"step":2,"issues":["..."]}],"rules":{"kept":["id"],"broken":[{"id":"...","note":"..."}]}}`;

// The STEPs of the teacher's solution a variant is expected to follow.
function stageScope(stage, total) {
  if (stage?.kind === 'upto') return { steps: Array.from({ length: stage.upto }, (_, i) => i + 1), text: `원본 STEP 1${stage.upto > 1 ? `~${stage.upto}` : ''}만 쓰는 연습 문제다. STEP ${stage.upto + 1 < total ? `${stage.upto + 1}~${total}` : total}은 이 문제에 필요 없고 해설에도 없어야 한다.` };
  if (stage?.kind === 'focus') return { steps: [stage.step], text: `원본 STEP ${stage.step}을 연습하는 문제다. 앞 STEP의 결론은 문제에 주어질 수 있다.` };
  return { steps: Array.from({ length: total }, (_, i) => i + 1), text: `원본 STEP 1~${total}을 모두 쓰는 최종 문제다.` };
}

function solutionReviewText({ item, material, rules }) {
  const solutionRules = rules.filter((r) => r.target === 'solution' || r.target === 'all');
  const scope = stageScope(item.stage, material.steps.length);
  return [
    `[이 문제의 범위] ${scope.text}`,
    '\n[교사 해설 — 원본 문제의 풀이 STEP 중 이 문제의 범위]',
    material.steps.map((s, i) => ({ s, n: i + 1 })).filter(({ n }) => scope.steps.includes(n)).map(({ s, n }) => `STEP ${n}. ${s.title}\n${s.work}`).join('\n\n'),
    '\n[변형 문제]',
    item.problem.text,
    // Without the choices the reviewer once called "정답은 ②" in the solution a fault ("선택지가 없는데 ②를 쓴다").
    item.problem.choices?.length ? item.problem.choices.map((c, i) => `${'①②③④⑤⑥⑦⑧⑨'[i] || i + 1} ${c}`).join('  ') + `\n정답: ${'①②③④⑤⑥⑦⑧⑨'[item.problem.answer - 1] || item.problem.answer}` : '(서술형)',
    '\n[변형 문제의 해설]',
    (item.solution?.steps || []).map((s) => `STEP ${s.step}. ${s.title}\n${s.work}`).join('\n\n'),
    solutionRules.length ? '\n[판정할 해설 지침]\n' + solutionRules.map((r) => `- (${r.id}) ${r.text}`).join('\n') : '\n[판정할 해설 지침] 없음. rules의 kept와 broken은 빈 배열.',
    '\nJSON만 반환하라.',
  ].join('\n');
}

// After a set: the faults the checks found (and fixed or not) become at most three learning items, so the next set
// avoids them from the start. Only what would have prevented a fault that really happened; nothing the learning
// already says.
// 학습 › 정리 후보: whether two items whose wording overlaps are one item, and the sentence that keeps both.
const MERGE_SYSTEM = `너는 변형 문제 출제 AI에게 주는 학습 항목을 정리하는 사람이다. 표현이 겹치는 두 학습 항목이 사실상 같은 지시인지 판단한다.
- same: 한쪽이 다른 쪽을 포함하거나 두 항목이 같은 실수를 막아서, 한 항목으로 합쳐도 잃는 지시가 없으면 true.
- 다루는 대상이 다르거나(문제 설계와 해설 쓰기, 서로 다른 STEP이나 실험), 한쪽에만 있는 구체적 지시가 합치면 흐려지면 false. 표현이 비슷한 것만으로는 같은 항목이 아니다.
- same이 true이면 text에 두 항목의 지시를 빠짐없이 담은 한두 문장을 쓴다. '…한다' 또는 '…하지 않는다'로 끝내고, 괄호 예시는 필요한 것만 남긴다. false이면 text는 빈 문자열.
- why에는 판단 이유를 한 문장으로 쓴다.
${FORMAT}
반환 JSON 형식:
{"same":true,"text":"...","why":"..."}`;
const mergeText = ({ a, b }) => `[학습 A]
${a}

[학습 B]
${b}

JSON만 반환하라.`;

const LEARN_SYSTEM = `너는 변형 문제 출제를 돕는 AI가 다음에 같은 실수를 하지 않도록 학습 항목을 정리하는 사람이다.
[이번 세트에서 나온 실수]는 자동 검토가 찾아내 고치거나 끝내 남은 것이다. 이 중 다음 세트에서 처음부터 피하면 수정·재설계가 줄어드는 것만 학습 항목으로 만든다.
- 최대 3개. 필요 없으면 빈 배열.
- [이미 있는 학습·지침]과 같은 뜻이면 만들지 않는다.
- 만들지 않는 것: 검토자의 지적이 틀렸거나 문제 설계상 당연한 차이, 한 번 생긴 단순 계산 실수, 표·수식 표기 오류(서버가 고친다).
- 이 원본의 내용(실험·물질·수치 구성)에만 해당하면 scope "problem", 다른 문제에도 통하는 설계 원칙이면 "common".
- common이면 subjectOnly: 이 과목의 내용(예: 화학의 기체 양적 관계, 생명과학의 흥분 전도)에 관한 것이면 true, 과목과 관계없는 출제·해설 원칙이면 false.
- target: 문제 설계에 관한 것이면 "problem", 해설 쓰는 방식이면 "solution", 둘 다면 "all".
- text는 '…한다' 또는 '…하지 않는다'로 끝나는 한두 문장. 막연한 말("정확히 한다") 대신 무엇을 어떻게 하는지 쓰고, 필요하면 괄호에 짧은 예를 든다. 이번 문제의 수치를 그대로 옮기지 않는다.
- why에는 이 항목이 막는 실수를 한 문장으로 쓴다.
${FORMAT}
반환 JSON 형식:
{"items":[{"text":"...","scope":"problem","target":"problem","subjectOnly":false,"why":"..."}]}`;

function learnText({ material, faults, existing }) {
  return [
    `[원본] ${material.title || ''} (${[material.subject, material.topic].filter(Boolean).join(' · ')})`,
    material.steps.map((s, i) => `STEP ${i + 1}. ${s.title}${s.technique ? ' — ' + s.technique : ''}`).join('\n'),
    '\n[이번 세트에서 나온 실수]',
    faults.map((f) => `- (${f.label}${f.left ? ', 끝내 남음' : ', 고침'}) ${f.text}`).join('\n'),
    '\n[이미 있는 학습·지침]',
    existing.length ? existing.map((t) => '- ' + t).join('\n') : '없음',
    '\nJSON만 반환하라.',
  ].join('\n');
}

// Lean mixed runs: the designer (strong, expensive) writes only what needs judgment — the problem, its verification
// program and a STEP-by-STEP outline — and a cheaper model writes the full solution from that outline.
const LEAN_DESIGN = `
[간결 모드 — 해설은 다른 작성자가 선생님 해설 형식으로 풀어 쓴다]
- solution.steps[].work에는 STEP마다 요지만 쓴다: 그 STEP에서 내린 판정(예: 가정→모순으로 Ⅰ에서 모두 반응한 것은 B), 구한 비·값과 그 식(예: A : B $=1:2$, Ⅲ에서 남은 B $8w-6w=2w$). STEP마다 1~4줄. 문장 틀·표·설명은 쓰지 않는다.
- 작성자가 새로 계산하거나 판단하지 않도록 해설에 필요한 중간값은 모두 적는다. 보조 문자(n, m 등)를 쓰면 무엇인지 적는다.
- title은 원본 STEP 제목 그대로. summary는 한 줄.
- designNote는 2문장 이내, appliedRules의 how는 지침마다 1문장.
- problem과 verification은 평소대로 완전하게 쓴다.`;

const LEAN_REPAIR = `
[간결 모드 — 바뀐 항목만 반환한다]
- 고친 최상위 항목만 JSON에 넣는다 (problem, solution, verification, usesSteps, designNote, appliedRules 중). 바뀌지 않은 항목은 넣지 않는다.
- solution을 고치면 위 [네가 만든 문제]의 solution처럼 STEP별 요지로 쓴다 (작성자가 다시 풀어 쓴다). problem을 고치면 solution 요지와 verification도 새 문제에 맞게 함께 고친다.`;

const WRITE_SOLUTION_SYSTEM = `너는 해설 작성자다. 출제자가 정한 문제와 STEP별 풀이 요지를 선생님 해설과 같은 형식의 완성된 해설로 풀어 쓴다.
- 새로 판단하거나 다른 방법으로 풀지 않는다. 요지에 있는 판정·비·값·식을 그대로 쓰고, 요지의 값에서 바로 나오는 사칙연산만 채운다. 네 계산이 요지와 다르면 요지를 따른다.
- 요지는 재료다. 요지의 짧은 문장·화살표(→)·빗금(/) 나열을 그대로 옮기지 말고, STEP마다 선생님 해설의 같은 STEP을 본보기로 삼아 같은 모양으로 다시 쓴다.
- 선생님 해설의 STEP 제목, 문장 틀, 순서, 표 구성(열), 보조 문자(n, m 등)와 그 도입 위치를 그대로 따른다. 수치, 실험 번호, 실린더·대상 기호의 범위만 이 문제에 맞춘다. 예: 선생님이 "만약 Ⅰ에서 A가 모두 반응했다면 … 맞지 않다. 따라서 Ⅰ에서 모두 반응한 것은 B이다."로 쓰면 같은 틀로 쓴다.
- 선생님 해설의 STEP에 표가 있으면 그 STEP에도 같은 열 구성의 Markdown 표를 만들어 요지의 값을 채운다 (예: 실험별 반응 후 A, B, C+D의 질량 표, 실험별 양(mol)과 몰분율 표).
- 선생님 해설에 없는 설명·경우 나누기·검산을 더하지 않는다. 요지에 있는 STEP만 쓴다.
- 요지에 있는 STEP 번호만 쓴다. 정답 계산과 선택지 판단은 마지막 STEP의 work 끝에 쓰고, 마지막 STEP은 정답 번호와 값으로 끝낸다 (예: 정답은 ④ $\\frac{7}{3}$이다). '선택지 분석' 같은 STEP을 따로 만들지 않는다.
${FORMAT}
반환 JSON 형식:
{"solution":{"steps":[{"step":1,"title":"...","work":"..."}],"summary":"최종 정답 도출 한 줄"}}`;

function writeSolutionText({ item, material, rules, outline, fixes = [] }) {
  const solutionRules = rules.filter((r) => r.target === 'solution' || r.target === 'all');
  return [
    '[선생님 해설 — 형식의 기준]',
    material.steps.map((s, i) => `STEP ${i + 1}. ${s.title}\n${s.work}`).join('\n\n'),
    '\n[문제]',
    item.problem.text,
    item.problem.figure ? '[그림 설명]\n' + item.problem.figure : '',
    item.problem.choices?.length ? item.problem.choices.map((c, i) => `${i + 1}) ${c}`).join('\n') + `\n정답: ${item.problem.answer}번` : '',
    '\n[출제자의 풀이 요지 — 이 판정과 값을 그대로 쓴다]',
    outline.steps.map((s) => `STEP ${s.step}. ${s.title}\n${s.work}`).join('\n\n'),
    outline.summary ? `요약: ${outline.summary}` : '',
    solutionRules.length ? '\n[해설 지침 — 지킨다]\n' + solutionRules.map((r) => `- ${r.text}`).join('\n') : '',
    fixes.length ? '\n[앞서 쓴 해설에서 고칠 점 — 반드시 고친다]\n' + fixes.map((f) => '- ' + f).join('\n') : '',
    '\n해설 JSON만 반환하라.',
  ].filter(Boolean).join('\n');
}

// The independent solver disagreed with the designer. A weak solver is often simply wrong, so before a (costly)
// repair the designer checks who is right.
const ADJUDICATE_SYSTEM = `너는 이 문제의 출제자다. 정답을 모르는 검토자가 문제만 보고 풀었는데 네 정답과 다른 답을 냈거나 문제에 결함이 있다고 했다.
- 네 풀이를 처음부터 다시 계산하고, 검토자 풀이를 따라가며 어디서 달라졌는지 찾는다.
- 네 정답·해설에 실제 오류가 있거나, 문제 문장이 검토자의 해석도 허용하면(모호함) problemAtFault=true.
- 검토자의 계산 실수, 조건을 빠뜨리거나 잘못 읽은 것(문제 문장이 분명한데 틀린 것)이면 problemAtFault=false.
반환 JSON 형식:
{"problemAtFault":false,"reason":"어디서 누가 틀렸는지 한두 문장"}`;

function adjudicateText({ item, blind, issues }) {
  return [
    '[문제]',
    item.problem.text,
    item.problem.figure ? '[그림 설명]\n' + item.problem.figure : '',
    item.problem.choices?.length ? item.problem.choices.map((c, i) => `${i + 1}) ${c}`).join('\n') : '',
    `\n[네 정답] ${item.problem.answer}번`,
    '[네 풀이 요지]',
    ((item.outline || item.solution)?.steps || []).map((s) => `STEP ${s.step}. ${s.work}`).join('\n'),
    `\n[검토자의 답] ${blind.answer ? `${blind.answer}번 (${blind.answerValue})` : '답을 내지 못함'}`,
    issues.length ? '[검토자가 지적한 결함]\n' + issues.map((i) => '- ' + i).join('\n') : '',
    '[검토자 풀이]',
    blind.solution,
    '\nJSON만 반환하라.',
  ].filter(Boolean).join('\n');
}

const SYSTEMS = {
  analyze: ANALYZE_SYSTEM, proofread: PROOFREAD_SYSTEM, 'reread-question': REREAD_QUESTION_SYSTEM, 'reread-problem': REREAD_PROBLEM_SYSTEM,
  'reread-headings': REREAD_HEADINGS_SYSTEM, regroup: REGROUP_SYSTEM, 'fix-verification': FIX_VERIFICATION_SYSTEM,
  generate: GENERATE_SYSTEM, solve: SOLVE_SYSTEM, 'review-solution': SOLUTION_REVIEW_SYSTEM, repair: REPAIR_SYSTEM,
  'write-solution': WRITE_SOLUTION_SYSTEM, adjudicate: ADJUDICATE_SYSTEM, learn: LEARN_SYSTEM,
};
const PROMPT_VERSION = require('node:crypto').createHash('sha256')
  .update(require('node:fs').readFileSync(__filename)).digest('hex').slice(0, 10);

module.exports = {
  SYSTEMS, PROMPT_VERSION, MERGE_SYSTEM, mergeText,
  ANALYZE_SYSTEM, analyzeText, PROOFREAD_SYSTEM, proofreadText, REGROUP_SYSTEM, regroupText, REREAD_QUESTION_SYSTEM, REREAD_PROBLEM_SYSTEM, rereadProblemText, FIX_VERIFICATION_SYSTEM, fixVerificationText, REREAD_HEADINGS_SYSTEM,
  GENERATE_SYSTEM, generateText,
  SOLVE_SYSTEM, solveText,
  SOLUTION_REVIEW_SYSTEM, solutionReviewText,
  REPAIR_SYSTEM, repairText,
  LEAN_DESIGN, LEAN_REPAIR, WRITE_SOLUTION_SYSTEM, writeSolutionText, ADJUDICATE_SYSTEM, adjudicateText,
  LEARN_SYSTEM, learnText, stageScope, stageInstruction, rulesBlock,
};
