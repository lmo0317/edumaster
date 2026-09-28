'use strict';
const prompts = require('./prompts');
const { codeCheck } = require('./verify');
const { selectRules } = require('./learning');

// Models sometimes write $b$ inside \ce{...}, which breaks rendering: drop the inner dollars.
const fixMath = (s) => s.replace(/\\ce\{([^{}]*)\}/g, (m, body) => (body.includes('$') ? `\\ce{${body.replace(/\$/g, '')}}` : m));
const str = (v, max = 20000) => fixMath(String(v ?? '').trim()).slice(0, max);
const arr = (v) => (Array.isArray(v) ? v : []);
const answerNumber = (v, count) => {
  const n = Number.parseInt(String(v ?? '').replace(/[^0-9]/g, ''), 10) || 0;
  const circled = '①②③④⑤⑥⑦⑧⑨'.indexOf(String(v ?? '').trim()[0]);
  const value = circled >= 0 ? circled + 1 : n;
  return value >= 1 && value <= count ? value : 0;
};
const stripChoiceNumber = (c) => str(c, 2000).replace(/^\s*(?:[①②③④⑤⑥⑦⑧⑨]|\(?[1-9]\)|[1-9][.)])\s*/, '');

function normalizeProblem(p) {
  const choices = arr(p?.choices).map(stripChoiceNumber).filter(Boolean).slice(0, 9);
  let text = str(p?.text, 12000);
  // Choices belong in the choices array only; drop "① … ② …" lines copied into the body as well.
  if (choices.length > 1) text = text.split('\n').filter((line) => !(/^\s*①/.test(line) && line.includes('②'))).join('\n').trim();
  return { text, choices, answer: answerNumber(p?.answer, choices.length), figure: str(p?.figure, 4000) };
}

/** Model analysis → material fields. Also used to validate the teacher's edits. */
function normalizeMaterial(data) {
  const problem = normalizeProblem(data?.problem);
  if (problem.text.length < 5) throw Object.assign(new Error('문제 본문을 읽지 못했습니다.'), { status: 422 });
  const steps = arr(data?.steps).map((s) => ({
    title: str(s?.title, 300), purpose: str(s?.purpose, 1000), technique: str(s?.technique, 1500),
    work: str(s?.work, 8000), result: str(s?.result, 1500),
  })).filter((s) => s.title || s.work).slice(0, 10);
  return {
    title: str(data?.title, 120) || '제목 없음',
    subject: str(data?.subject, 40),
    topic: str(data?.topic, 120),
    problem,
    annotations: arr(data?.annotations).map((a) => str(a, 500)).filter(Boolean).slice(0, 20),
    solutionSource: data?.solutionSource === 'ai' ? 'ai' : 'provided',
    steps,
    techniques: arr(data?.techniques).map((t) => str(t, 500)).filter(Boolean).slice(0, 12),
    finalCheck: str(data?.finalCheck, 4000),
    uncertainties: arr(data?.uncertainties).map((u) => str(u, 500)).filter(Boolean).slice(0, 20),
    stepMarkers: arr(data?.stepMarkers).map((m) => str(m, 40)).filter(Boolean).slice(0, 10),
  };
}

// Applies proofreading fixes only where the wrong text occurs exactly once in the named field.
function applyFixes(material, fixes) {
  const applied = [];
  const unresolved = [];
  const fieldRef = (field) => {
    let m;
    if (field === 'problem.text') return [material.problem, 'text'];
    if (field === 'problem.figure') return [material.problem, 'figure'];
    if ((m = /^problem\.choices\[(\d+)\]$/.exec(field)) && material.problem.choices[m[1]] !== undefined) return [material.problem.choices, Number(m[1])];
    if ((m = /^steps\[(\d+)\]\.(title|purpose|technique|work|result)$/.exec(field)) && material.steps[m[1]]) return [material.steps[m[1]], m[2]];
    return null;
  };
  for (const fix of fixes) {
    const wrong = str(fix?.wrong, 400); const right = str(fix?.right, 400);
    if (!wrong || wrong === right) continue;
    const ref = fieldRef(String(fix?.field || ''));
    const note = `${fix.field}: "${wrong}" → "${right}"${fix.reason ? ' (' + str(fix.reason, 200) + ')' : ''}`;
    if (ref && ref[0][ref[1]].split(wrong).length === 2) { ref[0][ref[1]] = ref[0][ref[1]].replace(wrong, right); applied.push(note); }
    else unresolved.push('교정 제안(자동 적용 못 함) ' + note);
  }
  return { applied, unresolved };
}

function normalizeGenerated(data) {
  const problem = normalizeProblem(data?.problem);
  if (problem.text.length < 5) throw Object.assign(new Error('모델이 문제 본문을 만들지 않았습니다.'), { status: 422 });
  if (problem.choices.length && !problem.answer) throw Object.assign(new Error('모델이 정답 번호를 주지 않았습니다.'), { status: 422 });
  return {
    problem,
    solution: {
      steps: arr(data?.solution?.steps).map((s) => ({ step: Number.parseInt(s?.step, 10) || 0, title: str(s?.title, 300), work: str(s?.work, 8000) })).filter((s) => s.work).slice(0, 12),
      summary: str(data?.solution?.summary, 1000),
    },
    usesSteps: arr(data?.usesSteps).map((n) => Number.parseInt(n, 10)).filter((n) => n > 0).slice(0, 12),
    designNote: str(data?.designNote, 3000),
    appliedRules: arr(data?.appliedRules).map((r) => ({ id: str(r?.id, 40), how: str(r?.how, 600) })).filter((r) => r.id).slice(0, 30),
    verificationSpec: data?.verification && typeof data.verification === 'object' ? data.verification : null,
  };
}

// ---------------------------------------------------------------- analysis

async function analyzeMaterial(ctx, material) {
  const { store, llm, budget, signal } = ctx;
  // Prefer the browser-made reading views (upscaled, tiled with overlap) over a small original.
  const { images: src } = material;
  const separate = src.solution && !src.sameImage;
  const role = (key) => (key === 'solution' ? '해설 이미지' : separate ? '문제 이미지' : src.sameImage ? '문제+해설 이미지' : '문제 이미지');
  const images = [];
  for (const key of separate ? ['problem', 'solution'] : ['problem']) {
    const views = src.views?.[key] || [];
    if (views.length) views.forEach((id, i) => images.push({ label: `[${role(key)} — 확대 조각 ${i + 1}/${views.length}, 조각끼리 위아래가 조금 겹친다]`, dataUrl: store.files.dataUrl(id) }));
    else images.push({ label: `[${role(key)}]`, dataUrl: store.files.dataUrl(src[key]) });
  }
  if (images.some((i) => !i.dataUrl)) throw new Error('저장된 원본 이미지를 찾지 못했습니다.');
  ctx.log('원본 이미지 판독과 풀이 STEP 정리 중');
  const { data } = await llm.json({
    purpose: 'analyze', jobId: ctx.job.id, budget, signal, vision: true, effort: 'off', maxTokens: 16000,
    system: prompts.ANALYZE_SYSTEM,
    text: prompts.analyzeText({ hasSolution: Boolean(material.images.solution), sameImage: material.images.sameImage, note: material.note }),
    images,
  });
  const result = normalizeMaterial(data);
  if (!result.steps.length) throw new Error('풀이 STEP을 만들지 못했습니다. 해설 이미지를 확인하거나 다시 분석해 주세요.');

  // Second look: compare the transcription with the image and fix misreadings (e.g. 몰질량 ↔ 물질량).
  result.proofread = [];
  try {
    ctx.log('옮겨 적은 내용을 원본 이미지와 대조하는 중');
    const fields = { 'problem.text': result.problem.text, 'problem.figure': result.problem.figure };
    result.problem.choices.forEach((c, i) => { fields[`problem.choices[${i}]`] = c; });
    result.steps.forEach((s, i) => { for (const k of ['title', 'work', 'result']) fields[`steps[${i}].${k}`] = s[k]; });
    const { data: check } = await llm.json({
      purpose: 'proofread', jobId: ctx.job.id, budget, signal, vision: true, effort: 'low', maxTokens: 16000,
      system: prompts.PROOFREAD_SYSTEM, text: prompts.proofreadText(fields), images,
    });
    const { applied, unresolved } = applyFixes(result, arr(check?.fixes).slice(0, 30));
    result.proofread = applied;
    result.uncertainties.push(...unresolved);
    const counted = Number.parseInt(check?.solutionStepCount, 10) || 0;
    if (counted && !result.stepMarkers.length && counted !== result.steps.length) result.uncertainties.push(`교정 단계에서 해설의 STEP 표시를 ${counted}개로 셌는데 정리한 STEP은 ${result.steps.length}개입니다. STEP 구분을 확인해 주세요.`);
  } catch (e) {
    if (e.name !== 'BudgetExceeded' && e.name !== 'LlmFormatError') throw e;
    result.uncertainties.push('원본 대조(교정) 단계를 건너뛰었습니다: ' + e.message);
  }
  if (result.stepMarkers.length && result.stepMarkers.length !== result.steps.length) {
    result.uncertainties.push(`해설의 단계 표시는 ${result.stepMarkers.length}개(${result.stepMarkers.join(', ')})인데 정리한 STEP은 ${result.steps.length}개입니다. 합치거나 나눠 주세요.`);
  }
  return result;
}

// ---------------------------------------------------------------- generation

function coverage(stage, stepCount, used) {
  const expected = stage.kind === 'upto' ? Array.from({ length: stage.upto }, (_, i) => i + 1)
    : stage.kind === 'focus' ? [stage.step]
    : Array.from({ length: stepCount }, (_, i) => i + 1);
  const usedSet = new Set(used);
  const missing = expected.filter((n) => !usedSet.has(n));
  const extra = used.filter((n) => !expected.includes(n) && !(stage.kind === 'focus' && n < stage.step));
  const notes = [];
  if (missing.length) notes.push(`독립 풀이에서 STEP ${missing.join(', ')} 로직 없이 풀렸습니다.`);
  if (extra.length) notes.push(`독립 풀이에 목표 범위 밖 STEP ${extra.join(', ')} 로직이 필요했습니다.`);
  return { status: notes.length ? 'warn' : 'pass', expected, used, notes };
}

async function blindSolve(ctx, item, material, rules) {
  ctx.log(`${item.label}: 독립 풀이로 검토 중`);
  const { data } = await ctx.llm.json({
    purpose: 'solve', jobId: ctx.job.id, budget: ctx.budget, signal: ctx.signal, effort: ctx.effort.solve, maxTokens: 24000,
    system: prompts.SOLVE_SYSTEM, text: prompts.solveText({ item, material, rules }),
  });
  const choiceCount = item.problem.choices.length;
  return {
    answer: answerNumber(data?.answer, choiceCount || 99),
    answerValue: str(data?.answerValue, 300),
    confident: data?.confident !== false,
    solution: str(data?.solution, 6000),
    stepsUsed: arr(data?.stepsUsed).map((n) => Number.parseInt(n, 10)).filter((n) => n > 0),
    issues: arr(data?.issues).map((i) => ({ type: str(i?.type, 30) || 'other', detail: str(i?.detail, 600) })).filter((i) => i.detail).slice(0, 10),
    rules: arr(data?.rules).map((r) => ({ id: str(r?.id, 40), ok: r?.ok !== false, note: str(r?.note, 400) })).filter((r) => r.id),
  };
}

const BLOCKING_ISSUES = new Set(['ambiguous', 'contradiction', 'missing', 'revealed']);

async function verifyItem(ctx, item, material, rules) {
  const code = item.verificationSpec
    ? await codeCheck(item.verificationSpec, { answer: item.problem.answer, choiceCount: item.problem.choices.length })
    : { status: 'fail', reasons: ['검산 프로그램이 없습니다.'] };
  const blind = await blindSolve(ctx, item, material, rules);
  const hard = [];
  const soft = [];
  if (code.status === 'fail') hard.push(...code.reasons.map((r) => '코드 검산: ' + r));
  soft.push(...(code.warnings || []));
  if (item.problem.choices.length) {
    if (!blind.answer) hard.push('독립 풀이가 정답을 고르지 못했습니다: ' + blind.solution.slice(0, 300));
    else if (blind.answer !== item.problem.answer) hard.push(`독립 풀이의 정답은 ${blind.answer}번(${blind.answerValue})인데 표시된 정답은 ${item.problem.answer}번입니다. 독립 풀이 요약: ${blind.solution.slice(0, 600)}`);
  }
  for (const issue of blind.issues) (BLOCKING_ISSUES.has(issue.type) ? hard : soft).push(`독립 풀이 지적(${issue.type}): ${issue.detail}`);
  const cov = coverage(item.stage, material.steps.length, blind.stepsUsed);
  soft.push(...cov.notes);
  const ruleResults = rules.map((r) => {
    const self = item.appliedRules.find((a) => a.id === r.id);
    const judged = blind.rules.find((b) => b.id === r.id);
    if (judged && !judged.ok) soft.push(`교사 지침 미준수 가능: ${r.text.slice(0, 80)} — ${judged.note}`);
    return { id: r.id, text: r.text, target: r.target, how: self?.how || '', judged: judged ? { ok: judged.ok, note: judged.note } : null };
  });
  return {
    hard, soft, coverageNotes: cov.notes,
    verification: {
      code: { status: code.status, reasons: code.reasons || [], warnings: code.warnings || [], mode: code.mode, values: code.trials?.[0]?.values || [], checks: code.trials?.[0]?.checks || [] },
      blind,
      coverage: cov,
      rules: ruleResults,
    },
  };
}

/** Generates, checks, and (at most once) repairs one problem. Mutates `item` and saves progress. */
async function produceItem(ctx, { material, item, prior, rules, mode, extraFeedback, previous }) {
  const total = material.steps.length;
  item.status = 'generating'; item.error = ''; ctx.save();
  ctx.log(`${item.label}: 문제 설계 중`);
  const { data } = await ctx.llm.json({
    purpose: 'generate', jobId: ctx.job.id, budget: ctx.budget, signal: ctx.signal, effort: ctx.effort.generate, maxTokens: 64000,
    system: prompts.GENERATE_SYSTEM,
    text: prompts.generateText({ material, stage: item.stage, total, mode, prior, rules, variantNo: item.variantNo, extraFeedback, previous }),
  });
  Object.assign(item, normalizeGenerated(data));
  item.attempts = [{ kind: 'generate', at: new Date().toISOString() }];
  item.status = 'verifying'; ctx.save();

  let check = await verifyItem(ctx, item, material, rules);
  // A STEP-range mismatch is the teacher's core requirement, so it also earns the single repair;
  // if it remains afterwards it is only a warning (the blind solver's STEP tagging can be noisy).
  const repairReasons = (c) => [...c.hard, ...c.coverageNotes.map((n) => 'STEP 범위: ' + n)];
  for (let round = 0; repairReasons(check).length && round < ctx.maxRepairs; round++) {
    item.attempts.push({ kind: 'repair', at: new Date().toISOString(), failures: repairReasons(check) });
    item.status = 'repairing'; item.verification = check.verification; ctx.save();
    ctx.log(`${item.label}: 검토에서 발견된 ${check.hard.length}건 수정 중`);
    const { data: fixed } = await ctx.llm.json({
      purpose: 'repair', jobId: ctx.job.id, budget: ctx.budget, signal: ctx.signal, effort: ctx.effort.generate, maxTokens: 64000,
      system: prompts.REPAIR_SYSTEM,
      text: prompts.repairText({ material, stage: item.stage, total, mode, rules, item, failures: repairReasons(check), blind: check.verification.blind }),
    });
    Object.assign(item, normalizeGenerated(fixed));
    item.status = 'verifying'; ctx.save();
    check = await verifyItem(ctx, item, material, rules);
  }
  item.verification = check.verification;
  item.problems = check.hard;
  item.warnings = check.soft;
  item.status = check.hard.length ? 'needs_review' : check.soft.length ? 'warning' : 'passed';
  ctx.log(`${item.label}: ${{ passed: '검증 통과', warning: '통과 (확인할 점 있음)', needs_review: '교사 검토 필요' }[item.status]}`);
  ctx.save();
}

async function runGeneration(ctx) {
  const { job, store } = ctx;
  const material = job.material;
  const rules = job.rules;
  for (const item of job.items) {
    if (ctx.signal.aborted) throw new Error('작업이 취소되었습니다.');
    if (['passed', 'warning', 'needs_review'].includes(item.status)) continue; // resume keeps finished work
    const prior = job.items.filter((x) => x.index < item.index && x.problem);
    try {
      await produceItem(ctx, { material, item, prior, rules, mode: job.options.mode });
    } catch (e) {
      item.status = 'failed'; item.error = e.message; ctx.save();
      ctx.log(`${item.label}: 실패 — ${e.message}`);
      if (e.name === 'BudgetExceeded' || ctx.signal.aborted) throw e;
    }
  }
  for (const rule of rules) {
    const stored = store.rules.get(rule.id);
    if (stored) store.rules.put({ ...stored, applied: (stored.applied || 0) + 1 });
  }
}

function pickRules(store, material) {
  return selectRules(store.rules.all(), material).map((r) => ({ id: r.id, text: r.text, kind: r.kind, target: r.target, scope: r.scope }));
}

module.exports = { applyFixes, analyzeMaterial, runGeneration, produceItem, pickRules, normalizeMaterial, normalizeGenerated, coverage };
