'use strict';
// Which problems a generation set contains. The number of STEPs comes from the teacher's solution,
// never from a fixed template.

function stageLabel(stage, total) {
  if (stage.kind === 'upto') return stage.upto === total ? '전체 STEP 연습' : stage.upto === 1 ? 'STEP 1 연습' : `STEP 1~${stage.upto} 누적 연습`;
  if (stage.kind === 'focus') return `STEP ${stage.step} 집중 연습 (앞 단계 결과 제공)`;
  return '최종 쌍둥이 문제';
}

/** Default set: STEP 1, STEP 1~2, … STEP 1~(n-1), then the final twin. */
function defaultStages(stepCount) {
  const stages = [];
  for (let k = 1; k < stepCount; k++) stages.push({ kind: 'upto', upto: k });
  stages.push({ kind: 'twin' });
  return stages;
}

function normalizeStages(input, stepCount) {
  if (!Number.isInteger(stepCount) || stepCount < 1) throw Object.assign(new Error('풀이 STEP이 없습니다. 분석 결과에서 STEP을 먼저 확인해 주세요.'), { status: 400 });
  const raw = Array.isArray(input) && input.length ? input : defaultStages(stepCount);
  const out = [];
  const seen = new Set();
  for (const s of raw) {
    let stage;
    if (s?.kind === 'upto' && Number.isInteger(s.upto) && s.upto >= 1 && s.upto <= stepCount) stage = { kind: 'upto', upto: s.upto };
    else if (s?.kind === 'focus' && Number.isInteger(s.step) && s.step >= 2 && s.step <= stepCount) stage = { kind: 'focus', step: s.step };
    else if (s?.kind === 'twin') stage = { kind: 'twin' };
    else throw Object.assign(new Error('알 수 없는 문제 단계 설정입니다.'), { status: 400 });
    const key = JSON.stringify(stage);
    if (!seen.has(key)) { seen.add(key); out.push(stage); }
  }
  // Practice first (in STEP order), twin last, so later problems can build on earlier ones.
  const order = (s) => (s.kind === 'twin' ? 1000 : s.kind === 'upto' ? s.upto * 2 : s.step * 2 + 1);
  return out.sort((a, b) => order(a) - order(b));
}

function buildItems(stages, stepCount, perStage) {
  const count = Math.min(Math.max(Number.parseInt(perStage, 10) || 1, 1), 3);
  const items = [];
  for (const stage of stages) {
    for (let v = 1; v <= count; v++) {
      items.push({
        index: items.length,
        stage,
        variantNo: v,
        label: stageLabel(stage, stepCount) + (count > 1 ? ` (${v})` : ''),
        status: 'pending',
      });
    }
  }
  if (items.length > 12) throw Object.assign(new Error('한 번에 12문제까지 만들 수 있습니다.'), { status: 400 });
  return items;
}

module.exports = { stageLabel, defaultStages, normalizeStages, buildItems };
