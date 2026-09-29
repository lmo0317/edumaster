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
    marker: str(s?.marker, 40),
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
    stepMarkers: [...new Set(arr(data?.stepMarkers).map((m) => str(m, 40)).filter(Boolean))].slice(0, 10),
    solutionStepCount: Number.parseInt(data?.solutionStepCount, 10) || 0,
  };
}

// ---------------------------------------------------------------- STEP count vs. the teacher's step markers

const STEP_COUNT_NOTE = /^(해설의 단계 표시는|교정 단계에서 해설의 STEP 표시를)/;
const markerNumber = (marker) => Number.parseInt(String(marker || '').replace(/[^0-9]/g, ''), 10) || 0;

/** How many STEPs the teacher's solution has, if the solution shows step markers. */
function targetStepCount(material) {
  // Models sometimes list one marker per STEP ("step1, step1, step2, step3, step3"), so count distinct
  // markers — from the marker list and from each STEP's own marker — and fall back to the proofreader's count.
  const distinct = (list) => new Set(list.map((m) => markerNumber(m) || String(m).trim()).filter(Boolean)).size;
  return Math.max(distinct(material.stepMarkers || []), distinct((material.steps || []).map((s) => s.marker).filter(Boolean)))
    || material.solutionStepCount || 0;
}

/** Recomputes the STEP-count warning after the steps changed. */
function refreshStepCountNote(material) {
  const target = targetStepCount(material);
  const notes = (material.uncertainties || []).filter((u) => !STEP_COUNT_NOTE.test(u));
  const markers = [...new Set(material.stepMarkers || [])];
  if (target && target !== material.steps.length) {
    notes.push(`해설의 단계 표시는 ${target}개${markers.length === target ? `(${markers.join(', ')})` : ''}인데 정리한 STEP은 ${material.steps.length}개입니다.`);
  }
  // targetSteps is what the screen compares against (it offers the one-click merge when STEPs exceed it).
  return { ...material, stepMarkers: markers, targetSteps: target, uncertainties: notes };
}

/** Groups from each step's own marker (step1, step1, step2 …), or null when the markers can't decide. */
function groupsFromMarkers(steps, target) {
  const nums = steps.map((s) => markerNumber(s.marker));
  if (nums.some((n) => n < 1 || n > target)) return null;
  for (let i = 1; i < nums.length; i++) if (nums[i] < nums[i - 1]) return null;
  if (new Set(nums).size !== target) return null;
  return Array.from({ length: target }, (_, g) => ({ steps: nums.map((n, i) => (n === g + 1 ? i + 1 : 0)).filter(Boolean), title: '' }));
}

function validGroups(groups, stepCount, target) {
  if (!Array.isArray(groups) || groups.length !== target) return false;
  const flat = groups.flatMap((g) => g.steps);
  return flat.length === stepCount && flat.every((n, i) => n === i + 1);
}

function mergeGroups(steps, groups) {
  return groups.map((g) => {
    const part = g.steps.map((n) => steps[n - 1]);
    if (part.length === 1) return part[0];
    const join = (k, sep) => part.map((s) => s[k]).filter(Boolean).join(sep);
    return {
      marker: part[0].marker,
      // The first STEP of a marker group usually carries the solution's printed step heading.
      title: str(g.title, 300) || part[0].title,
      purpose: join('purpose', ' / '),
      technique: join('technique', '\n'),
      work: join('work', '\n\n'),
      result: part[part.length - 1].result || join('result', ' / '),
    };
  });
}

/**
 * Proposes STEPs matching the teacher's step markers. Uses the markers when they decide the grouping,
 * otherwise one small text-only model call. Returns null when nothing needs to change.
 */
async function proposeStepAlignment({ llm, budget, jobId, signal }, material) {
  const target = targetStepCount(material);
  const steps = material.steps;
  if (!target || target >= steps.length) return null;
  let groups = groupsFromMarkers(steps, target);
  if (!groups) {
    const { data } = await llm.json({
      purpose: 'regroup', jobId, budget, signal, effort: 'off', maxTokens: 3000,
      system: prompts.REGROUP_SYSTEM, text: prompts.regroupText(steps, target, material.stepMarkers),
    });
    groups = arr(data?.groups).map((g) => ({ steps: arr(g?.steps).map((n) => Number.parseInt(n, 10)).filter((n) => n > 0), title: str(g?.title, 300) }));
  }
  if (!validGroups(groups, steps.length, target)) {
    throw Object.assign(new Error('STEP을 해설 단계에 맞게 묶지 못했습니다. 수정 화면에서 "위 STEP과 합치기"로 직접 합쳐 주세요.'), { status: 422 });
  }
  return {
    steps: mergeGroups(steps, groups),
    summary: groups.map((g, i) => (g.steps.length > 1 ? `STEP ${g.steps.join('+')} → STEP ${i + 1}` : null)).filter(Boolean).join(', '),
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
      purpose: 'proofread', jobId: ctx.job.id, budget, signal, vision: true, effort: 'low', maxTokens: 32000,
      system: prompts.PROOFREAD_SYSTEM, text: prompts.proofreadText(fields), images,
    });
    const { applied, unresolved } = applyFixes(result, arr(check?.fixes).slice(0, 30));
    result.proofread = applied;
    result.uncertainties.push(...unresolved);
    result.solutionStepCount = Number.parseInt(check?.solutionStepCount, 10) || result.solutionStepCount;
  } catch (e) {
    if (e.name !== 'BudgetExceeded' && e.name !== 'LlmFormatError') throw e;
    result.uncertainties.push('원본 대조(교정) 단계를 건너뛰었습니다: ' + e.message);
  }
  // The teacher's solution decides the STEP count: merge extra STEPs automatically and say so.
  try {
    const proposal = await proposeStepAlignment({ llm, budget, jobId: ctx.job.id, signal }, result);
    if (proposal) {
      result.steps = proposal.steps;
      result.proofread.push(`해설의 단계 표시(${targetStepCount(result)}개)에 맞춰 STEP을 합쳤습니다: ${proposal.summary}`);
    }
  } catch (e) {
    if (e.name !== 'BudgetExceeded' && e.name !== 'LlmFormatError' && e.status !== 422) throw e;
  }
  return refreshStepCountNote(result);
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

async function blindSolve(ctx, item, material, rules, compareOriginal) {
  ctx.log(`${item.label}: 독립 풀이로 검토 중`);
  const { data } = await ctx.llm.json({
    purpose: 'solve', jobId: ctx.job.id, budget: ctx.budget, signal: ctx.signal, effort: ctx.effort.solve, maxTokens: 24000,
    system: prompts.SOLVE_SYSTEM, text: prompts.solveText({ item, material, rules, compareOriginal }),
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
    conditions: arr(data?.conditions).map((c) => ({ text: str(c?.text, 300), used: c?.used !== false })).filter((c) => c.text).slice(0, 30),
    variation: ['numbers-only', 'structural'].includes(data?.variation) ? data.variation : 'n/a',
    variationNote: str(data?.variationNote, 600),
  };
}

const BLOCKING_ISSUES = new Set(['ambiguous', 'contradiction', 'missing', 'revealed']);

// Table rows as number signatures: "| Ⅰ | $8w$ | $6w$ | ..." -> "8w,6w". Only the first two data cells
// (the given amounts) are compared, so a row reusing an earlier experiment's inputs is caught.
function tableRows(text) {
  const rows = [];
  for (const line of String(text || '').split('\n')) {
    if (!/^\s*\|/.test(line) || /^\s*\|[\s:|-]+\|\s*$/.test(line)) continue;
    const cells = line.trim().replace(/^\||\|$/g, '').split('|').slice(1)
      .map((c) => c.replace(/\\ce\{[^}]*\}|\$|\s|\\,/g, '').replace(/\\(d?frac)\{(\d+)\}\{(\d+)\}/g, '$2/$3'))
      .filter((c) => /\d/.test(c) && c.length <= 24);
    if (cells.length >= 2) rows.push({ label: line.split('|')[1].trim().replace(/\$/g, ''), sig: cells.slice(0, 2).join(',') });
  }
  return rows;
}

/** Experiment rows whose given amounts match the original's or (for the final problem) an earlier problem's. */
function numbersReused(item, prior, material) {
  const mine = tableRows(item.problem.text);
  if (!mine.length) return [];
  const notes = [];
  const compare = (text, whose) => {
    const theirs = new Set(tableRows(text).map((r) => r.sig));
    for (const r of mine) if (theirs.has(r.sig)) notes.push(`${whose}의 실험 수치(${r.sig})를 그대로 썼습니다 (${r.label} 행).`);
  };
  compare(material.problem.text, '원본');
  if (item.stage.kind === 'twin') for (const other of prior) if (other.problem && other.index !== item.index) compare(other.problem.text, `앞 문제(${other.label})`);
  return [...new Set(notes)];
}

/** Row signatures the new problem must avoid: the original's, and (for the final problem) earlier problems'. */
function usedRowsFor(item, prior, material) {
  const texts = [material.problem.text, ...(item.stage.kind === 'twin' ? prior.filter((p) => p.problem).map((p) => p.problem.text) : [])];
  return [...new Set(texts.flatMap((t) => tableRows(t).map((r) => r.sig)))];
}

// The final problem repeating a practice problem (same question, choices or answer) is copying, not integrating.
function repeatsPrior(item, prior) {
  const norm = (s) => String(s || '').replace(/\s+/g, '').replace(/[.?!]/g, '');
  const question = (p) => norm(p.text.split('\n').filter((l) => l.trim()).pop());
  const choiceSet = (p) => p.choices.map(norm).sort().join('|');
  const notes = [];
  for (const other of prior) {
    if (!other.problem || other.index === item.index) continue;
    if (question(other.problem) === question(item.problem)) notes.push(`앞 문제(${other.label})와 질문이 같습니다.`);
    if (item.problem.choices.length && choiceSet(other.problem) === choiceSet(item.problem)) notes.push(`앞 문제(${other.label})와 선택지가 같습니다.`);
  }
  return notes;
}

async function verifyItem(ctx, item, material, rules, mode, prior = []) {
  const code = item.verificationSpec
    ? await codeCheck(item.verificationSpec, { answer: item.problem.answer, choiceCount: item.problem.choices.length })
    : { status: 'fail', reasons: ['검산 프로그램이 없습니다.'] };
  // For an integrated final problem the solver also sees the original, to tell a real redesign from new numbers.
  const integratedFinal = item.stage.kind === 'twin' && mode === 'integrated';
  const blind = await blindSolve(ctx, item, material, rules, integratedFinal);
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
  // The final problem exists to need every STEP; one that skips a STEP goes to the teacher, not just a warning.
  if (item.stage.kind === 'twin' && cov.expected.some((n) => !cov.used.includes(n))) hard.push(...cov.notes.filter((n) => n.includes('없이')));
  soft.push(...cov.notes);
  // Teacher feedback: problems carried conditions nothing used, and the "integrated" final only changed numbers.
  const designNotes = [
    ...blind.conditions.filter((c) => !c.used).map((c) => `풀이에 쓰이지 않는 조건: ${c.text}`),
    ...(integratedFinal && blind.variation === 'numbers-only' ? [`통합 변형인데 원본에서 숫자만 바뀌었습니다. ${blind.variationNote}`.trim()] : []),
    ...(item.stage.kind === 'twin' ? repeatsPrior(item, prior) : []),
    ...numbersReused(item, prior, material),
  ];
  soft.push(...designNotes);
  const ruleResults = rules.map((r) => {
    const self = item.appliedRules.find((a) => a.id === r.id);
    const judged = blind.rules.find((b) => b.id === r.id);
    if (judged && !judged.ok) soft.push(`교사 지침 미준수 가능: ${r.text.slice(0, 80)} — ${judged.note}`);
    return { id: r.id, text: r.text, target: r.target, how: self?.how || '', judged: judged ? { ok: judged.ok, note: judged.note } : null };
  });
  return {
    hard, soft, coverageNotes: cov.notes, designNotes,
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
    text: prompts.generateText({ material, stage: item.stage, total, mode, prior, rules, variantNo: item.variantNo, extraFeedback, previous, usedRows: usedRowsFor(item, prior, material) }),
  });
  Object.assign(item, normalizeGenerated(data));
  item.attempts = [{ kind: 'generate', at: new Date().toISOString() }];
  item.status = 'verifying'; ctx.save();

  let check = await verifyItem(ctx, item, material, rules, mode, prior);
  // A STEP-range mismatch is the teacher's core requirement, so it also earns the single repair;
  // if it remains afterwards it is only a warning (the blind solver's STEP tagging can be noisy).
  const repairReasons = (c) => [...c.hard, ...c.coverageNotes.map((n) => 'STEP 범위: ' + n), ...c.designNotes.map((n) => '문제 설계: ' + n)];
  // Up to ctx.maxRepairs repairs, but a further one only when the previous repair changed what is wrong;
  // the same complaints twice means the model is stuck, so stop and show them to the teacher.
  const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
  for (let round = 0; repairReasons(check).length && round < ctx.maxRepairs; round++) {
    if (round > 0 && same(repairReasons(check), item.attempts[item.attempts.length - 1].failures)) break;
    item.attempts.push({ kind: 'repair', at: new Date().toISOString(), failures: repairReasons(check) });
    item.status = 'repairing'; item.verification = check.verification; ctx.save();
    ctx.log(`${item.label}: 검토에서 발견된 ${repairReasons(check).length}건 수정 중`);
    const { data: fixed } = await ctx.llm.json({
      purpose: 'repair', jobId: ctx.job.id, budget: ctx.budget, signal: ctx.signal, effort: ctx.effort.generate, maxTokens: 64000,
      system: prompts.REPAIR_SYSTEM,
      text: prompts.repairText({ material, stage: item.stage, total, mode, rules, item, failures: repairReasons(check), blind: check.verification.blind }),
    });
    Object.assign(item, normalizeGenerated(fixed));
    item.status = 'verifying'; ctx.save();
    check = await verifyItem(ctx, item, material, rules, mode, prior);
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

module.exports = { tableRows, numbersReused, repeatsPrior, applyFixes, proposeStepAlignment, refreshStepCountNote, targetStepCount, analyzeMaterial, runGeneration, produceItem, pickRules, normalizeMaterial, normalizeGenerated, coverage };
