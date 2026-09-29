'use strict';
// Runs a model-written verification program with exact fractions.
// Runs in a worker thread (memory + time limited by the parent); the parser is also stripped of
// functions that could define new code or units.
const { parentPort, workerData } = require('node:worker_threads');
const { create, all } = require('mathjs');

function makeMath(numberMode) {
  const math = create(all, numberMode === 'Fraction' ? { number: 'Fraction' } : {});
  const evaluate = math.evaluate;
  const disabled = (name) => () => { throw new Error(`${name} 함수는 검산 프로그램에서 쓸 수 없습니다.`); };
  math.import(Object.fromEntries(
    ['import', 'createUnit', 'evaluate', 'parse', 'simplify', 'derivative', 'resolve', 'reviver', 'compile', 'rationalize', 'range', 'zeros', 'ones', 'identity', 'random', 'randomInt', 'pickRandom']
      .map((name) => [name, disabled(name)])), { override: true });
  return { math, evaluate };
}

function describe(math, value) {
  if (value === undefined || value === null) return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  try { return math.format(value, { fraction: 'ratio', precision: 12 }).replace(/^(-?\d+)\/1$/, '$1'); } catch { return String(value); }
}

function isNumeric(math, value) {
  return typeof value === 'number' || math.isFraction(value) || math.isBigNumber(value);
}

function near(math, a, b) {
  if (!isNumeric(math, a) || !isNumeric(math, b)) return false;
  if (math.isFraction(a) && math.isFraction(b)) return a.equals(b);
  const x = Number(a.valueOf ? a.valueOf() : a); const y = Number(b.valueOf ? b.valueOf() : b);
  return Math.abs(x - y) <= 1e-9 * Math.max(1, Math.abs(x), Math.abs(y));
}

function trialValues(free, trial) {
  // Deterministic, distinct small integers per trial so failures can be reproduced.
  const pools = [[3, 5, 7, 11, 13], [4, 9, 2, 15, 17], [6, 10, 14, 19, 23]];
  return Object.fromEntries(free.map((name, i) => [name, pools[trial % pools.length][i % 5] + Math.floor(i / 5) * 29]));
}

function runTrial(numberMode, spec, trial) {
  const { math, evaluate } = makeMath(numberMode);
  const scope = new Map();
  for (const [name, value] of Object.entries(trialValues(spec.free, trial))) scope.set(name, numberMode === 'Fraction' ? math.fraction(value) : value);
  const assigned = [];
  spec.program.forEach((statement, line) => {
    let value;
    try { value = evaluate(statement, scope); }
    catch (e) { throw new Error(`${line + 1}번째 줄 "${statement}" 계산 실패: ${e.message}`); }
    const name = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(?!=)/.exec(statement)?.[1];
    if (name) assigned.push({ name, value });
  });
  const value = (expr, what) => {
    try { return evaluate(String(expr), scope); } catch (e) { throw new Error(`${what} "${expr}" 계산 실패: ${e.message}`); }
  };
  const answer = spec.answer ? value(spec.answer, '정답 식') : undefined;
  const choices = spec.choices.map((expr, i) => (expr === '' || expr === null ? undefined : value(expr, `${i + 1}번 선택지 식`)));
  const checks = spec.checks.map((c) => {
    const v = value(c.expr, '조건 검사');
    return { expr: c.expr, desc: c.desc || '', ok: v === true, boolean: typeof v === 'boolean', value: describe(math, v) };
  });
  const matches = answer === undefined ? [] : choices.map((c, i) => (c !== undefined && near(math, c, answer) ? i + 1 : 0)).filter(Boolean);
  const ugly = [];
  if (numberMode === 'Fraction' && spec.free.length === 0) {
    for (const { name, value: v } of assigned) {
      if (math.isFraction(v) && (Number(v.d) > 60 || Math.abs(Number(v.n)) > 1000000)) ugly.push(`${name} = ${describe(math, v)}`);
    }
  }
  return {
    free: spec.free.length ? trialValues(spec.free, trial) : undefined,
    answer: describe(math, answer),
    choices: choices.map((c) => describe(math, c)),
    matches,
    checks,
    ugly,
    values: assigned.slice(0, 60).map(({ name, value: v }) => `${name} = ${describe(math, v)}`),
  };
}

function run(spec) {
  const trials = spec.free.length ? 3 : 1;
  let mode = 'Fraction';
  let results;
  try {
    results = Array.from({ length: trials }, (_, t) => runTrial(mode, spec, t));
  } catch (fractionError) {
    // sqrt, trig, logs etc. are not exact fractions — fall back to floating point with a tolerance.
    mode = 'number';
    try { results = Array.from({ length: trials }, (_, t) => runTrial(mode, spec, t)); }
    catch (e) { return { ok: false, mode, error: e.message }; }
  }
  return { ok: true, mode, trials: results };
}

// Loading mathjs happens above; tell the parent we are ready so only the program's own run is timed.
parentPort.once('message', (spec) => parentPort.postMessage(run(spec)));
parentPort.postMessage({ ready: true });
