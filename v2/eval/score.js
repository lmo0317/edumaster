'use strict';
// Scores one analysis (and optionally one generation set) against a case's expectations.
// Every check returns { name, pass, detail } so reports can show exactly what failed.
const { grams, overlap } = require('../server/learning');

/** Notation-insensitive text: LaTeX wrappers, $, spaces and subscript marks removed. */
function norm(text) {
  return String(text || '')
    .replace(/\\(?:ce|text|mathrm|mathbf|operatorname)\s*\{([^{}]*)\}/g, '$1')
    .replace(/\\(?:d?frac)\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, '$1/$2')
    .replace(/\\[,;:! ]/g, '')
    .replace(/\\(?:left|right|displaystyle)/g, '')
    .replace(/[_^]\{?([^{}\s])\}?/g, '$1')
    .replace(/[${}\s]/g, '')
    .replace(/[–−－]/g, '-')
    .toLowerCase();
}

function check(name, pass, detail) { return { name, pass: Boolean(pass), detail: detail || '' }; }

function scoreAnalysis(material, expect) {
  const out = [];
  const problemText = norm([material.problem?.text, ...(material.problem?.choices || [])].join(' '));
  const stepsText = norm((material.steps || []).map((s) => [s.title, s.technique, s.work, s.result].join(' ')).join(' '));
  if (expect.answer) out.push(check('정답 번호', material.problem?.answer === expect.answer, `읽음 ${material.problem?.answer} / 기대 ${expect.answer}`));
  if (expect.choiceCount) out.push(check('선택지 수', material.problem?.choices?.length === expect.choiceCount, `읽음 ${material.problem?.choices?.length} / 기대 ${expect.choiceCount}`));
  if (expect.stepCount) out.push(check('해설 STEP 수', material.steps?.length === expect.stepCount, `정리 ${material.steps?.length} / 해설 ${expect.stepCount}`));
  if (expect.stepTitles?.length) {
    const sims = expect.stepTitles.map((t, i) => {
      const got = material.steps?.[i]?.title || '';
      return { i: i + 1, sim: overlap(grams(norm(got)), grams(norm(t))), got };
    });
    const bad = sims.filter((s) => s.sim < 0.5);
    out.push(check('STEP 제목이 해설과 일치', !bad.length, bad.map((b) => `STEP ${b.i} "${b.got}" (유사도 ${b.sim.toFixed(2)})`).join('; ') || sims.map((s) => s.sim.toFixed(2)).join(', ')));
  }
  for (const w of expect.problemMustContain || []) out.push(check(`문제에 "${w}" 포함`, problemText.includes(norm(w)), ''));
  for (const w of expect.problemMustNotContain || []) out.push(check(`문제에 "${w}" 미포함 (필기·오독)`, !problemText.includes(norm(w)), ''));
  // "A|B": any of the wordings (the printed solution says "맞지 않다" where a summary would say "모순").
  for (const w of expect.stepsMustContain || []) out.push(check(`해설 STEP에 "${w}" 포함`, w.split('|').some((x) => stepsText.includes(norm(x))), ''));
  // A correct transcription must not be flagged to the teacher as failing its own check.
  const source = (material.checks || []).find((c) => c.id === 'source-calculation');
  if (source) out.push(check('원본 정답 검산 통과', source.state === 'pass', source.evidence || ''));
  return out;
}

function scoreGeneration(job) {
  const out = [];
  const items = job.items || [];
  out.push(check('세트 완료', job.status === 'done', job.error || job.status));
  for (const it of items) {
    const v = it.verification || {};
    const label = it.label;
    out.push(check(`${label}: 문제 생성`, Boolean(it.problem), it.error || ''));
    if (!it.problem) continue;
    out.push(check(`${label}: 코드 검산`, v.code?.status === 'pass' || v.code?.status === 'skip', (v.code?.reasons || []).join('; ')));
    out.push(check(`${label}: 독립 풀이 정답 일치`, v.blind?.answer && v.blind.answer === it.problem.answer, `독립 ${v.blind?.answer} / 표시 ${it.problem.answer}`));
    out.push(check(`${label}: 교사 검토 필요 없음`, !(it.problems || []).length, (it.problems || []).join('; ')));
    out.push(check(`${label}: 확인할 점 없음`, !(it.warnings || []).length, (it.warnings || []).join('; ')));
    if (it.stage?.kind === 'twin' && job.options?.mode === 'integrated') {
      out.push(check(`${label}: 구조 변형(숫자만 바꾸지 않음)`, v.blind?.variation === 'structural', v.blind?.variation || ''));
    }
  }
  return out;
}

module.exports = { norm, scoreAnalysis, scoreGeneration };
