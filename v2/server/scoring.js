'use strict';
// Model comparison scoring from harness reports (used by the 모델 비교 page).

// Scored per problem, so a model is not rewarded for failing early: a problem it could not make scores 0 and
// fails every item (counting checks instead gave an unmade problem one failed check and a made one ten).
// [id, label, weight, harness checks that must all pass]; a wrong answer weighs most.
const DIMENSIONS = [
  ['made', '문제를 끝까지 만들어 냄', 0, ['문제 생성']],
  ['correct', '정답과 계산이 맞음 (컴퓨터 검산 + 독립 풀이)', 30, ['코드 검산', '독립 풀이 정답 일치']],
  ['range', '목표한 STEP만으로 풀림', 15, ['목표 STEP 범위로 풀림']],
  ['method', '선생님 풀이 방법 유지', 15, ['교사 풀이 방법 보존']],
  ['clean', '쓸모없는 조건이 없음', 10, ['모든 조건이 풀이에 쓰임']],
  ['rules', '선생님 지침을 지킴', 10, ['교사 지침 준수']],
  ['clear', '교사 검토 없이 바로 쓸 수 있음', 10, ['교사 검토 필요 없음']],
  ['structural', '최종 문제를 새 구조로 설계 (최종 문제만)', 10, ['구조 변형(숫자만 바꾸지 않음)']],
];
function problemResults(run) {
  const byItem = new Map();
  for (const c of run.generation || []) {
    const m = /^(.+?): (.+)$/.exec(c.name);
    if (!m) continue; // "세트 완료"
    if (!byItem.has(m[1])) byItem.set(m[1], {});
    byItem.get(m[1])[m[2]] = c.pass;
  }
  return [...byItem].map(([label, checks]) => {
    const final = /최종/.test(label);
    const made = checks['문제 생성'] !== false;
    const dims = {};
    for (const [id, , , names] of DIMENSIONS) {
      if (id === 'structural' && !final) continue;
      if (id === 'made') { dims.made = made; continue; }
      const seen = names.filter((n) => checks[n] !== undefined);
      if (!made) dims[id] = false;
      else if (seen.length) dims[id] = seen.every((n) => checks[n]);
      // older runs lack some checks; those items are left out rather than guessed
    }
    return { label, final, dims };
  });
}
// Wilson score interval (95%): unlike mean ± 1.96·sd it does not collapse to ±0 when every problem scored the same.
function wilson(p, n, z = 1.96) {
  if (!n) return [0, 0];
  const d = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / d;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, center - half), Math.min(1, center + half)];
}
function problemScore({ dims }) {
  const weighed = DIMENSIONS.filter(([id, , w]) => w && dims[id] !== undefined);
  const total = weighed.reduce((a, [, , w]) => a + w, 0);
  return dims.made && total ? weighed.reduce((a, [id, , w]) => a + (dims[id] ? w : 0), 0) / total : 0;
}

module.exports = { DIMENSIONS, problemResults, problemScore, wilson };
