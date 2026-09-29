'use strict';
const path = require('node:path');
const { Worker } = require('node:worker_threads');

const MAX_LINES = 120;
const MAX_CHARS = 400;

/** Normalizes the model's verification block. Returns { spec } or { error }. */
function normalize(verification, choiceCount) {
  if (!verification || typeof verification !== 'object') return { error: '검산 프로그램이 없습니다.' };
  const list = (v) => (Array.isArray(v) ? v : []);
  const program = list(verification.program).map((s) => String(s).trim()).filter(Boolean);
  if (!program.length) return { error: '검산 프로그램이 비어 있습니다.' };
  if (program.length > MAX_LINES) return { error: `검산 프로그램이 너무 깁니다 (${program.length}줄).` };
  const tooLong = [...program, verification.answer, ...list(verification.choices)].find((s) => String(s ?? '').length > MAX_CHARS);
  if (tooLong) return { error: '검산 식 한 줄이 너무 깁니다.' };
  const free = list(verification.free).map(String).filter((s) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(s)).slice(0, 6);
  let choices = list(verification.choices).map((c) => (c === null || c === undefined ? '' : String(c).trim()));
  // ㄱ/ㄴ/ㄷ combinations or worded choices are not values: such a problem is checked by its conditions only.
  if (choices.some((c) => /[ㄱ-ㆎ가-힣]/.test(c))) choices = [];
  if (choiceCount && choices.length && choices.length !== choiceCount) return { error: `선택지 식 개수(${choices.length})가 선택지 수(${choiceCount})와 다릅니다.` };
  const checks = list(verification.checks)
    .map((c) => (typeof c === 'string' ? { expr: c, desc: '' } : { expr: String(c?.expr ?? '').trim(), desc: String(c?.desc ?? '') }))
    .filter((c) => c.expr && c.expr.length <= MAX_CHARS)
    .slice(0, 30);
  // Without choice values the answer has nothing to be compared with, so it is not evaluated (a leftover
  // "ans" that the program never assigns would otherwise fail a correct transcription).
  return { spec: { program, free, answer: choices.length ? String(verification.answer ?? '').trim() : '', choices, checks } };
}

// The 4-second limit covers the model-written program only. Loading mathjs in a fresh worker can itself take
// seconds when several checks start at once, so startup has its own, looser limit.
function runWorker(spec, timeoutMs = 4000, startupMs = 30000) {
  return new Promise((resolve) => {
    const worker = new Worker(path.join(__dirname, 'math-worker.js'), {
      resourceLimits: { maxOldGenerationSizeMb: 96, maxYoungGenerationSizeMb: 32 },
    });
    let timer = setTimeout(() => { worker.terminate(); resolve({ ok: false, error: '검산 실행기를 시작하지 못했습니다 (서버가 바쁨).' }); }, startupMs);
    worker.on('message', (m) => {
      clearTimeout(timer);
      if (m?.ready) {
        timer = setTimeout(() => { worker.terminate(); resolve({ ok: false, error: '검산 프로그램이 시간 제한(4초)을 넘었습니다.' }); }, timeoutMs);
        worker.postMessage(spec);
        return;
      }
      worker.terminate();
      resolve(m);
    });
    worker.once('error', (e) => { clearTimeout(timer); resolve({ ok: false, error: '검산 실행 오류: ' + e.message }); });
  });
}

/**
 * Independent code check of one generated problem.
 * status: pass | fail | skip (nothing numeric to check)
 */
async function codeCheck(verification, { answer, choiceCount }) {
  const { spec, error } = normalize(verification, choiceCount);
  // runError: the program itself could not run (undefined name, syntax) — says nothing about the numbers.
  if (error) return { status: 'fail', reasons: [error], runError: true };
  const result = await runWorker(spec);
  if (!result.ok) return { status: 'fail', reasons: [result.error], spec, runError: true };
  const reasons = [];
  const warnings = [];
  const claimed = Number(answer);
  result.trials.forEach((t, i) => {
    const label = t.free ? `(자유 문자 ${Object.entries(t.free).map(([k, v]) => `${k}=${v}`).join(', ')}) ` : '';
    for (const c of t.checks) {
      // "(3/15)*2" computes a value but states nothing; it is not evidence either way.
      if (!c.boolean) { if (i === 0) warnings.push(`참/거짓 식이 아니어서 건너뛴 검사: ${c.desc || c.expr} → ${c.value}`); continue; }
      if (!c.ok) reasons.push(`${label}조건 검사 실패: ${c.desc || c.expr} → ${c.value}`);
    }
    if (spec.answer && spec.choices.length) {
      if (!t.matches.length) reasons.push(`${label}계산한 정답 ${t.answer}과 같은 선택지가 없습니다. 선택지 값: ${t.choices.join(' | ')}`);
      else if (t.matches.length > 1) reasons.push(`${label}정답 값 ${t.answer}과 같은 선택지가 여러 개입니다 (${t.matches.join(', ')}번).`);
      else if (claimed && t.matches[0] !== claimed) reasons.push(`${label}계산한 정답은 ${t.matches[0]}번인데 문제의 정답 표시는 ${claimed}번입니다.`);
    }
    if (i === 0 && t.ugly.length) warnings.push('학생이 손으로 계산하기 어려운 수: ' + t.ugly.slice(0, 5).join(', '));
  });
  const numeric = Boolean(spec.answer && spec.choices.length) || (result.trials[0]?.checks || []).some((c) => c.boolean);
  return {
    status: reasons.length ? 'fail' : numeric ? 'pass' : 'skip',
    reasons: [...new Set(reasons)].slice(0, 12),
    warnings,
    mode: result.mode,
    trials: result.trials,
  };
}

module.exports = { codeCheck, normalize };
