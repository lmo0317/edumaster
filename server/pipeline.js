'use strict';
const prompts = require('./prompts');
const { codeCheck } = require('./verify');
const { Budget, BudgetExceeded } = require('./llm');
const { selectRules, analysisLearning, layerOf, stageOf, readingHint, readingPairs, makeRule, updateRule, grams, overlap, isFormatLesson, CATEGORIES } = require('./learning');
const { materialKey: analysisKey } = require('./material-version');
const harness = require('./harness');
const finalReview = require('./final-review');
const faultsData = require('./faults');

// Models sometimes write $b$ inside \ce{...}, which breaks rendering: drop the inner dollars.
const fixMath = (s) => s.replace(/\\ce\{([^{}]*)\}/g, (m, body) => (body.includes('$') ? `\\ce{${body.replace(/\$/g, '')}}` : m));
const str = (v, max = 20000) => fixMath(String(v ?? '').replace(/\r\n?/g, '\n').trim()).slice(0, max);
const arr = (v) => (Array.isArray(v) ? v : []);
const answerNumber = (v, count) => {
  const n = Number.parseInt(String(v ?? '').replace(/[^0-9]/g, ''), 10) || 0;
  const circled = '①②③④⑤⑥⑦⑧⑨'.indexOf(String(v ?? '').trim()[0]);
  const value = circled >= 0 ? circled + 1 : n;
  return value >= 1 && value <= count ? value : 0;
};
const stripChoiceNumber = (c) => str(c).replace(/^\s*(?:[①②③④⑤⑥⑦⑧⑨]|\(?[1-9]\)|[1-9][.)])\s*/, '');

// A line break a model wrote as the two letters \n (Haiku 5.5's final in reaction-density 3차, 2026-10-18: the equation,
// the sentences and the table ran on one line). Inside $…$ a LaTeX command (\ne, \nu) goes on with a letter, and stays.
const breaks = (t) => t.split(/(\$\$?[^$]*\$\$?)/).map((seg) => (seg.startsWith('$') ? seg.replace(/\\n(?![A-Za-z])/g, '\n') : seg.replace(/\\n/g, '\n'))).join('');

function normalizeProblem(p) {
  const choices = arr(p?.choices).map(stripChoiceNumber).filter(Boolean).slice(0, 9);
  let text = breaks(str(p?.text));
  // Choices belong in the choices array only; drop "① … ② …" lines copied into the body as well.
  if (choices.length > 1) text = text.split('\n').filter((line) => !(/^\s*①/.test(line) && line.includes('②'))).join('\n').trim();
  return { text, choices, answer: answerNumber(p?.answer, choices.length), figure: str(p?.figure) };
}

const romanLabels = (t) => t.replace(/(?<![A-Za-z\{_^])(IV|III|II|I)(?=[가-힣~,·)\s]|$)/g, (m) => ROMAN[m]);

/** Model analysis → material fields. Also used to validate the teacher's edits. */
function normalizeMaterial(data) {
  const problem = normalizeProblem(data?.problem);
  if (problem.text.length < 5) throw Object.assign(new Error('문제 본문을 읽지 못했습니다.'), { status: 422 });
  const steps = arr(data?.steps).map((s) => ({
    marker: str(s?.marker, 40),
    title: str(s?.title, 1000), purpose: str(s?.purpose), technique: str(s?.technique),
    work: str(s?.work), result: str(s?.result),
  })).filter((s) => s.title || s.work).slice(0, 10);
  // A problem that numbers its experiments Ⅰ~Ⅳ: a solution read with Latin "I에서" is the same label, and the solution
  // judges marked every STEP title of a set down for the variant's "Ⅰ에서" (molar-mass round 5, 2026-10-11).
  if (/[ⅠⅡⅢⅣ]/.test(problem.text)) for (const s of steps) { s.title = romanLabels(s.title); s.work = romanLabels(s.work); }
  return {
    title: str(data?.title, 120) || '제목 없음',
    subject: str(data?.subject, 40),
    topic: str(data?.topic, 120),
    problem,
    annotations: arr(data?.annotations).map((a) => str(a, 2000)).filter(Boolean).slice(0, 20),
    solutionSource: data?.solutionSource === 'ai' ? 'ai' : 'provided',
    steps,
    techniques: arr(data?.techniques).map((t) => str(t, 2000)).filter(Boolean).slice(0, 12),
    finalCheck: str(data?.finalCheck),
    uncertainties: arr(data?.uncertainties).map((u) => str(u, 2000)).filter(Boolean).slice(0, 20),
    stepMarkers: [...new Set(arr(data?.stepMarkers).map((m) => str(m, 40)).filter(Boolean))].slice(0, 10),
    solutionStepCount: Math.min(20, Math.max(0, Number.parseInt(data?.solutionStepCount, 10) || 0)),
    sourceVerification: data?.verification && typeof data.verification === 'object' ? data.verification : (data?.sourceVerification || null),
    stepHeadings: arr(data?.stepHeadings).map((h) => str(h, 300)).filter(Boolean).slice(0, 10),
    checks: arr(data?.checks).slice(0, 20),
    printedValues: arr(data?.printedValues).map((v) => str(v, 40)).filter(Boolean).slice(0, 20),
    // What the teacher's analysis feedback asked for: a STEP count of its own, a solution written out differently.
    teacherStepCount: Math.min(10, Math.max(0, Number.parseInt(data?.teacherRequests?.stepCount ?? data?.teacherStepCount, 10) || 0)),
    rewritten: Boolean(data?.teacherRequests?.rewrite ?? data?.rewritten),
    feedbackApplied: arr(data?.feedbackApplied).map((x) => ({ feedback: str(x?.feedback, 1000), how: str(x?.how, 500) })).filter((x) => x.how).slice(0, 20),
  };
}

// ---------------------------------------------------------------- STEP count vs. the teacher's step markers

const STEP_COUNT_NOTE = /^(해설의 단계 표시는|교정 단계에서 해설의 STEP 표시를|선생님 피드백의 STEP 수는)/;
const markerNumber = (marker) => Number.parseInt(String(marker || '').replace(/[^0-9]/g, ''), 10) || 0;
// A heading as read: the step marker in front of it ("step3", "STEP 3.") is dropped, but a heading that begins by
// referring to another step ("step 2에서 구한 …", 2026-10-03: read as "에서 구한 …") keeps that reference — a marker
// is only one that carries this heading's own number and is not followed by a particle.
// A premise that makes the situation hold ("모든 기체는 반응하지 않는다", "X~Z는 임의의 원소 기호이다") is never used in a
// calculation and is not an unneeded condition (2026-10-03: the practice problems lost it after being told it was).
// The setting the original's figure fixes (how many neurons, where a synapse can be) is a premise too: the solver kept
// flagging nerve B's "2개의 뉴런, ㉠~㉢ 중 한 곳에 시냅스" while a lesson said to keep it (2026-10-10, every round).
function cleanHeading(h) {
  const title = h && typeof h === 'object' ? str(h.title, 300) : str(h, 300);
  const own = markerNumber(h?.marker);
  const m = /^\s*(?:step|STEP)\s*(\d+)\s*[.:)·]?\s*/.exec(title);
  const after = m ? title.slice(m.index + m[0].trimEnd().length) : '';
  const isMarker = m && (!own || Number(m[1]) === own) && !/^[가-힣]/.test(after) && !/^\s*(?:에서|의|와|과|을|를|에|로|으로)\s/.test(after);
  return (isMarker ? title.slice(m[0].length) : title).replace(/[.。]\s*$/, '');
}

/** How many STEPs the analysis should have: the count the teacher's analysis feedback asked for, else the solution's step markers. */
function targetStepCount(material) {
  if (material.teacherStepCount) return material.teacherStepCount;
  if (material.stepHeadings?.length) return material.stepHeadings.length;
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
    notes.push(material.teacherStepCount
      ? `선생님 피드백의 STEP 수는 ${target}개인데 정리한 STEP은 ${material.steps.length}개입니다.`
      : `해설의 단계 표시는 ${target}개${markers.length === target ? `(${markers.join(', ')})` : ''}인데 정리한 STEP은 ${material.steps.length}개입니다.`);
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
      title: str(g.title, 1000) || part[0].title,
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
    groups = arr(data?.groups).map((g) => ({ steps: arr(g?.steps).map((n) => Number.parseInt(n, 10)).filter((n) => n > 0), title: str(g?.title, 1000) }));
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
  // A missing sentence is put back whole: on chem-c32-molar-volume (2026-10-26) the fixer's replacement of a 보기 analysis
  // was cut at 400 letters, which left a formula without its closing $ and the judgment without its last line, and the
  // review of the fixed analysis then failed on what the cut had made. A fix that leaves the math unclosed is refused.
  const unclosed = (s) => (s.match(/\$/g) || []).length % 2 === 1;
  for (const fix of fixes) {
    // Neither side is cut (a 'wrong' cut at 400 letters matched its first 400 and left the rest of the old passage
    // after the new one, 2026-10-26 audit); a fix with nothing to find is reported, not dropped.
    const wrong = str(fix?.wrong); const right = str(fix?.right);
    const note = `${fix?.field || ''}: "${wrong.slice(0, 400)}${wrong.length > 400 ? '…' : ''}" → "${right.slice(0, 400)}${right.length > 400 ? '…' : ''}"${fix?.reason ? ' (' + str(fix.reason, 200) + ')' : ''}`;
    if (!wrong) { unresolved.push('교정 제안(고칠 글자가 비어 있어 적용 못 함) ' + note); continue; }
    if (wrong === right) continue;
    const ref = fieldRef(String(fix?.field || ''));
    const current = ref ? String(ref[0][ref[1]] ?? '') : '';
    if (!ref || current.split(wrong).length !== 2) { unresolved.push('교정 제안(자동 적용 못 함) ' + note); continue; }
    // A function replacer: a string one expands "$$", "$&", "$'" in the replacement, and $ is everywhere in math text.
    const next = current.replace(wrong, () => right);
    if (unclosed(next) && !unclosed(current)) { unresolved.push('교정 제안(수식 기호 $의 짝이 맞지 않아 적용 못 함) ' + note); continue; }
    ref[0][ref[1]] = next; applied.push(note);
  }
  return { applied, unresolved };
}

const ROMAN = { I: 'Ⅰ', II: 'Ⅱ', III: 'Ⅲ', IV: 'Ⅳ' };
const stepTitle = (t) => str(t, 300).replace(/^\s*STEP\s*\d+\s*[.:)·]\s*/i, '').replace(/(^|[^A-Za-z])(IV|III|II|I)(?=$|[^A-Za-z])/g, (m, pre, r) => pre + ROMAN[r]);
/** The STEP number a model gives, as a number: "STEP 2", "2.", 2; 0 when it gives none. */
const stepNumber = (v) => Number.parseInt((String(v ?? '').match(/\d+/) || [])[0], 10) || 0;
function normalizeSolution(solution) {
  // A number not given is the position; a number given twice keeps its first STEP; the order is the teacher's. Every
  // lookup by number (titles, frames, the range) then finds one STEP (2026-10-26 audit: step 0 was "in range" always).
  const steps = arr(solution?.steps).map((s, k) => ({ step: stepNumber(s?.step), title: stepTitle(s?.title), work: breaks(str(s?.work)), k })).filter((s) => s.work).map((s, k) => ({ ...s, step: s.step || k + 1 }));
  const seen = new Set();
  return {
    steps: steps.filter((s) => !seen.has(s.step) && seen.add(s.step)).sort((a, b) => a.step - b.step || a.k - b.k).map(({ k, ...s }) => s).slice(0, 12),
    summary: str(solution?.summary),
  };
}

function normalizeGenerated(data) {
  const problem = normalizeProblem(data?.problem);
  if (problem.text.length < 5) throw Object.assign(new Error('모델이 문제 본문을 만들지 않았습니다.'), { status: 422 });
  if (problem.choices.length && !problem.answer) throw Object.assign(new Error('모델이 정답 번호를 주지 않았습니다.'), { status: 422 });
  const solution = normalizeSolution(data?.solution);
  const numbers = arr(data?.solution?.steps).filter((s) => str(s?.work)).map((s) => stepNumber(s?.step)).filter(Boolean);
  if (data?.solution !== undefined && !solution.steps.length) throw Object.assign(new Error('모델이 해설을 쓰지 않았습니다.'), { status: 422 });
  if (new Set(numbers).size !== numbers.length) throw Object.assign(new Error('모델이 해설 STEP 번호를 겹쳐 썼습니다.'), { status: 422 });
  return {
    problem,
    solution,
    usesSteps: arr(data?.usesSteps).map((n) => Number.parseInt(n, 10)).filter((n) => n > 0).slice(0, 12),
    designNote: str(data?.designNote),
    // One note per rule given; a cap below the rules loaded (40) dropped the last notes of every problem.
    appliedRules: arr(data?.appliedRules).map((r) => ({ id: str(r?.id, 40), how: str(r?.how, 2000) })).filter((r) => r.id).slice(0, 100),
    verificationSpec: data?.verification && typeof data.verification === 'object' ? data.verification : null,
  };
}

// ---------------------------------------------------------------- analysis

const hinted = (ctx, text) => (ctx.readingHint ? `${text}\n\n${ctx.readingHint}` : text);

async function analyzeMaterial(ctx, material) {
  const { store, llm, budget, signal } = ctx;
  // Reading RAG: the teacher's past corrections of analyses (물질량 → 몰질량) go to every reader and join the
  // confusable pairs that are propagated and flagged.
  const corrections = store?.corrections?.all() || [];
  ctx.readingHint = readingHint(corrections);
  ctx.readingPairs = readingPairs(corrections);
  ctx.readingCorrections = corrections;
  const withHint = (text) => hinted(ctx, text);
  // Prefer the browser-made reading views (upscaled, tiled with overlap) over a small original.
  const { images: src } = material;
  const separate = src.solution && !src.sameImage;
  const role = (key) => (key === 'solution' ? '해설 이미지' : separate ? '문제 이미지' : src.sameImage ? '문제+해설 이미지' : '문제 이미지');
  const images = [];
  const byRole = { problem: [], solution: [] };
  for (const key of separate ? ['problem', 'solution'] : ['problem']) {
    const views = src.views?.[key] || [];
    const list = views.length
      ? views.map((id, i) => ({ label: `[${role(key)} — 확대 조각 ${i + 1}/${views.length}, 조각끼리 위아래가 조금 겹친다]`, dataUrl: store.files.dataUrl(id) }))
      : [{ label: `[${role(key)}]`, dataUrl: store.files.dataUrl(src[key]) }];
    images.push(...list);
    byRole[key].push(...list);
  }
  if (!separate) byRole.solution = byRole.problem; // one image holds both
  if (images.some((i) => !i.dataUrl)) throw new Error('저장된 원본 이미지를 찾지 못했습니다.');
  ctx.log('원본 이미지 판독과 풀이 STEP 정리 중');
  // What the teacher taught about reading (docs/learning.md): the analysis 지침, this problem's feedback, the lessons.
  const learn = store ? analysisLearning(store.rules.all(), material) : { guides: [], own: [], lessons: [] };
  const { data, shapeFixes: analyzeShape = [] } = await llm.json({
    purpose: 'analyze', jobId: ctx.job.id, budget, signal, vision: true, effort: 'off', maxTokens: 16000,
    system: prompts.ANALYZE_SYSTEM,
    text: withHint(prompts.analyzeText({ hasSolution: Boolean(material.images.solution), sameImage: material.images.sameImage, note: material.note, guides: learn.guides, feedback: learn.own, lessons: learn.lessons })),
    images,
  });
  if (analyzeShape.length) ctx.log(`응답 JSON 구조 보정: ${analyzeShape.join(', ')}를 최상위로 옮김`);
  const result = normalizeMaterial(data);
  if (!result.steps.length) throw new Error('풀이 STEP을 만들지 못했습니다. 해설 이미지를 확인하거나 다시 분석해 주세요.');

  // Second look: compare the transcription with the image and fix misreadings (e.g. 몰질량 ↔ 물질량).
  result.proofread = [];
  try {
    ctx.log('옮겨 적은 내용을 원본 이미지와 대조하는 중');
    const fields = { 'problem.text': result.problem.text, 'problem.figure': result.problem.figure };
    result.problem.choices.forEach((c, i) => { fields[`problem.choices[${i}]`] = c; });
    if (!result.rewritten) result.steps.forEach((s, i) => { for (const k of ['title', 'work', 'result']) fields[`steps[${i}].${k}`] = s[k]; });
    const { data: check } = await llm.json({
      purpose: 'proofread', jobId: ctx.job.id, budget, signal, vision: true, effort: 'low', maxTokens: 32000,
      system: prompts.PROOFREAD_SYSTEM, text: withHint(prompts.proofreadText(fields)), images,
    });
    const proposed = arr(check?.fixes);
    const { applied, unresolved } = applyFixes(result, proposed.slice(0, 100));
    result.proofread = applied;
    result.uncertainties.push(...unresolved);
    if (proposed.length > 100) result.uncertainties.push(`교정 제안이 ${proposed.length}건이어서 100건까지만 적용했습니다. 원본과 대조해 주세요.`);
    result.solutionStepCount = Math.min(20, Math.max(0, Number.parseInt(check?.solutionStepCount, 10) || 0)) || result.solutionStepCount;
  } catch (e) {
    if (e.name !== 'BudgetExceeded' && e.name !== 'LlmFormatError') throw e;
    result.uncertainties.push('원본 대조(교정) 단계를 건너뛰었습니다: ' + e.message);
  }
  // Chinese characters in a Korean worksheet are misreadings ("몰질量", "B的", Qwen 3.8 alone, 2026-10-13): the fields that
  // have them are proofread once more against the image, told so.
  const han = /\p{Script=Han}/u;
  const hanFields = {};
  if (han.test(result.problem.text)) hanFields['problem.text'] = result.problem.text;
  result.steps.forEach((s, i) => { for (const k of ['title', 'work', 'result']) if (han.test(s[k] || '')) hanFields[`steps[${i}].${k}`] = s[k]; });
  if (Object.keys(hanFields).length) {
    try {
      ctx.log('판독에 섞인 한자를 원본 이미지와 다시 대조하는 중');
      const { data: again } = await llm.json({
        purpose: 'proofread', jobId: ctx.job.id, budget, signal, vision: true, effort: 'low', maxTokens: 16000,
        system: prompts.PROOFREAD_SYSTEM,
        text: withHint(prompts.proofreadText(hanFields) + '\n\n이 필드들에는 한자가 섞여 있다. 원본은 한글 문서이므로 한자는 모두 잘못 읽은 것이다. 이미지의 인쇄된 한글로 고친다.'), images,
      });
      const { applied } = applyFixes(result, arr(again?.fixes).slice(0, 30));
      result.proofread.push(...applied);
    } catch (e) {
      if (e.name !== 'BudgetExceeded' && e.name !== 'LlmFormatError') throw e;
    }
    // What the second look left: the misreadings seen so far, by code (量 for 량, 质/質 for 질, 的 for 의).
    const HAN = [[/[质質]量/g, '질량'], [/量/g, '량'], [/[质質]/g, '질'], [/的/g, '의']];
    const fix = (t) => HAN.reduce((x, [re, to]) => x.replace(re, to), String(t || ''));
    result.problem.text = fix(result.problem.text);
    for (const s of result.steps) for (const k of ['title', 'work', 'result']) if (s[k]) s[k] = fix(s[k]);
    const left = [result.problem.text, ...result.steps.flatMap((s) => [s.title, s.work, s.result])].some((t) => han.test(t || ''));
    if (left) result.uncertainties.push('판독에 한자가 남아 있습니다. 원본의 한글을 잘못 읽은 것이므로 확인해 주세요.');
  }
  // Focused re-read (twice): the question sentence and the solution's printed step headings.
  // A big one-shot transcription drifts toward familiar words (it read 몰질량 as 물질량 while a focused
  // read of the same image gets it right), so trust two agreeing focused reads over the first pass.
  await printedProblemReread(ctx, result, byRole.problem);
  await focusedReread(ctx, result, byRole, Boolean(src.solution));

  // The teacher's solution decides the STEP count (or the count the teacher's analysis feedback asked for): merge extra
  // STEPs automatically and say so.
  try {
    const proposal = await proposeStepAlignment({ llm, budget, jobId: ctx.job.id, signal }, result);
    if (proposal) {
      result.steps = proposal.steps;
      result.proofread.push(`해설의 단계 표시(${targetStepCount(result)}개)에 맞춰 STEP을 합쳤습니다: ${proposal.summary}`);
    }
  } catch (e) {
    if (e.name !== 'BudgetExceeded' && e.name !== 'LlmFormatError' && e.status !== 422) throw e;
  }
  // Printed step headings are the truest STEP titles.
  if (!result.teacherStepCount && result.stepHeadings.length && result.stepHeadings.length === result.steps.length) {
    result.steps.forEach((s, i) => {
      const heading = result.stepHeadings[i];
      // Only a change of words counts: a title that differs by a final period or spacing is the same title.
      const words = (t) => harness.plain(t).replace(/[\s.,·:;!?。'"“”‘’]/g, '');
      if (heading && words(heading) !== words(s.title)) {
        result.proofread.push(`STEP ${i + 1} 제목을 해설에 인쇄된 제목으로: "${s.title}" → "${heading}"`);
        s.title = heading;
      }
    });
  }
  result.checks = await sourceChecks(result);
  const source = result.checks.find((c) => c.id === 'source-calculation');
  if (source?.runError) await fixSourceVerification(ctx, result, source.evidence);
  for (const c of result.checks) if (c.state !== 'pass') result.uncertainties.push(`${c.label}: ${c.evidence}`);
  // Two agreeing reads can share the same slip on a known confusable pair (Gemma read 몰질량 as 물질량 in all
  // three reads), so the teacher is always asked to look at those words.
  const allText = [result.problem.text, ...result.steps.map((s) => s.title + ' ' + s.work)].join(' ');
  const pairs = ctx.readingPairs || harness.CONFUSABLE;
  const hit = pairs.filter((p) => p.some((w) => allText.includes(w)));
  const seen = [...new Set(hit.flat().filter((w) => allText.includes(w)))];
  // One plain question per word, with how often it was read and the word it gets confused with (the page answers it
  // with 네 / 아니요 — 바꾸기).
  for (const word of seen) {
    const other = hit.find((p) => p.includes(word))?.find((w) => w !== word);
    const n = allText.split(word).length - 1;
    if (other) result.uncertainties.push(`단어 확인: 읽은 내용에 "${word}"이(가) ${n}번 나옵니다. AI가 "${word}"과(와) "${other}"을(를) 헷갈린 적이 있어서 묻습니다. 원본 사진에도 "${word}"으로 인쇄되어 있나요?`);
  }
  if (corrections.length) result.proofread.push(`과거 교사 교정 ${corrections.length}건을 판독에 참고했습니다.`);
  // What went into this analysis, so the page can show it next to the result with how each was applied.
  result.learningUsed = [...learn.guides, ...learn.own, ...learn.lessons].map((r) => ({ id: r.id, layer: layerOf(r), text: r.text }));
  result.correctionsUsed = Math.min(corrections.length, 12);
  return refreshStepCountNote(result);
}

async function focusedReread(ctx, result, byRole, hasSolution) {
  const read = async (purpose, system, text, images) => {
    const out = [];
    for (let i = 0; i < 2; i++) {
      try {
        const { data } = await ctx.llm.json({ purpose, jobId: ctx.job.id, budget: ctx.budget, signal: ctx.signal, vision: true, effort: 'off', maxTokens: 2000, system, text, images });
        out.push(data || {});
      } catch (e) {
        if (e.name !== 'BudgetExceeded' && e.name !== 'LlmFormatError') throw e;
      }
    }
    return out;
  };
  const questions = (await read('reread-question', prompts.REREAD_QUESTION_SYSTEM, hinted(ctx, '발문만 JSON으로 반환하라.'), byRole.problem)).map((d) => str(d.question, 2000));
  const headingReads = hasSolution
    ? (await read('reread-headings', prompts.REREAD_HEADINGS_SYSTEM, hinted(ctx, '단계 제목만 JSON으로 반환하라.'), byRole.solution)).map((d) => arr(d.steps).filter((s) => s?.marker || s?.title).map(cleanHeading).filter(Boolean))
    : [];
  result.rereads = { questions, headings: headingReads };
  // Two rereads that agree on the number of headings are trusted over the first read — unless the headings they read
  // are not in the solution the first read transcribed (2026-10-06: two Haiku rereads both read one garbled heading,
  // "기체 (가)의 분자량 전체 적산 수(상대질량) 구한다", and C32's three STEPs were merged into one). A changed count
  // must come with headings that are recognisably the solution's own.
  const transcript = grams(result.steps.map((s) => `${s.title} ${s.work}`).join(' '));
  const recognised = (h) => overlap(grams(h), transcript) >= 0.5;
  const sameCount = headingReads.length === 2 && headingReads[0].length && headingReads[0].length === headingReads[1].length;
  const trusted = sameCount && (headingReads[0].length === result.steps.length || headingReads[0].every(recognised));
  if (sameCount && !trusted) result.uncertainties.push(`해설 단계 제목 재판독(${headingReads[0].length}개)이 옮겨 적은 해설과 맞지 않아 쓰지 않았습니다: ${headingReads[0].join(' / ').slice(0, 200)}`);
  if (hasSolution && trusted) {
    result.stepHeadings = headingReads[0];
    result.solutionStepCount = headingReads[0].length;
  } else if (hasSolution && !sameCount) {
    result.uncertainties.push('해설 단계 제목 재판독 두 번의 결과가 달라 STEP 수를 교차 확인하지 못했습니다.');
  }
  if (questions.length < 2) { result.uncertainties.push('발문 재판독을 끝내지 못해 교차 확인을 건너뛰었습니다.'); return; }
  const [a, b] = questions;
  // Question: fix words that both focused reads read differently from the first pass (one-letter slips).
  const lines = result.problem.text.split('\n');
  const qIndex = lines.map((l, i) => [i, harness.hangulFixes(l, a, b, ctx.readingPairs).length || 0, (harness.plain(l).match(/[가-힣]+/g) || []).length]).filter(([, , n]) => n > 0);
  const target = qIndex.map(([i]) => i).reverse().find((i) => /[?？]|은\?|는\?|것은|인가/.test(lines[i])) ?? qIndex.map(([i]) => i).pop();
  if (target === undefined) return;
  // Two agreeing rereads are not enough to undo what is known to be right (2026-10-05: the first read had 몰질량,
  // both question rereads read 물질량, and the question and every STEP were "fixed" into the error): a change back
  // to the wrong side of a teacher's correction is the same slip again, and a word the separately read solution
  // headings show as the first read had it, against its confusable partner, stays.
  const corrections = ctx.readingCorrections || [];
  const reverts = (w, r) => corrections.some((c) => w.includes(c.right) && r === w.replace(c.right, c.wrong));
  const headingWords = headingReads.flat().join(' ');
  const contradicted = (w, r) => (ctx.readingPairs || []).some((p) => p.some((x) => w.startsWith(x) && p.some((y) => y !== x && r.startsWith(y) && headingWords.includes(x) && !headingWords.includes(y))));
  const all = harness.hangulFixes(lines[target], a, b, ctx.readingPairs);
  const kept = all.filter(([w, r]) => reverts(w, r) || contradicted(w, r));
  if (kept.length) result.proofread.push(...kept.map(([w, r]) => `발문 재판독은 "${w}"를 "${r}"로 읽었지만 교사 교정·해설 단계 제목과 어긋나 "${w}"로 둠`));
  const fixes = all.filter((f) => !kept.includes(f));
  if (!fixes.length) return;
  lines[target] = harness.applyWordFixes(lines[target], fixes);
  result.problem.text = lines.join('\n');
  result.proofread.push(...fixes.map(([w, r]) => `발문 재판독(2회 일치): "${w}" → "${r}"`));
  // The question confirmed a word of a known confusable pair: the same reader's slips to its partner in the
  // choices and the solution are the same systematic misread.
  const known = harness.confusableFixes(fixes.map(([, r]) => r), ctx.readingPairs);
  if (known.length) {
    const fixText = (t) => harness.applySubstringFixes(t, known);
    result.problem.choices = result.problem.choices.map(fixText);
    for (const s of result.steps) for (const k of ['title', 'purpose', 'technique', 'work', 'result']) s[k] = fixText(s[k]);
    result.techniques = result.techniques.map(fixText);
    result.stepHeadings = (result.stepHeadings || []).map(fixText);
    result.proofread.push(...known.map(([w, r]) => `같은 오독을 해설 STEP 전체에도 적용: "${w}" → "${r}"`));
  }
}

// A value the solution derives (x=15, 2cm/ms) that already sits in the problem text was most likely handwriting.
function derivedLeaks(material, text) {
  const problem = harness.plain(text).replace(/\s+/g, '');
  const leaks = [];
  material.steps.forEach((s, i) => {
    const tokens = [
      ...[...harness.plain(s.result).matchAll(/([a-zA-Z](?:_?\d)?)\s*=\s*(-?[\d./]+)/g)].map((m) => `${m[1].replace('_', '')}=${m[2]}`),
      ...[...harness.plain(s.result).matchAll(/(-?\d+(?:\.\d+)?)\s*(cm\/ms|m\/s|ms|mV|g\/mol)/g)].map((m) => m[1] + m[2]),
    ];
    // A value two printed-only re-reads kept is printed (the solution merely restates a given, e.g. 1cm/ms).
    for (const t of tokens) if (problem.includes(t.replace(/\s+/g, '')) && !(material.printedValues || []).includes(t) && !leaks.some((l) => l.token === t)) leaks.push({ step: i + 1, token: t });
  });
  return leaks;
}

// When the problem text holds a value the solution derives, read the printed problem again (problem images
// only, handwriting excluded) and take that text if the value is gone and it is still the same problem.
async function printedProblemReread(ctx, result, images) {
  const leaks = derivedLeaks(result, result.problem.text);
  if (!leaks.length || !images.length) return;
  const suspects = leaks.map((l) => l.token);
  ctx.log(`문제 본문에 해설에서 구하는 값(${suspects.join(', ')})이 있어 인쇄된 글자만 다시 읽는 중`);
  const words = (t) => new Set(harness.plain(t).match(/[가-힣]{2,}/g) || []);
  const before = words(result.problem.text);
  const reads = []; // same-problem re-reads and the suspects each still contains
  for (let i = 0; i < 2; i++) {
    let data;
    try {
      ({ data } = await ctx.llm.json({ purpose: 'reread-problem', jobId: ctx.job.id, budget: ctx.budget, signal: ctx.signal, vision: true, effort: 'off', maxTokens: 6000,
        system: prompts.REREAD_PROBLEM_SYSTEM, text: prompts.rereadProblemText(suspects), images }));
    } catch (e) {
      if (e.name !== 'BudgetExceeded' && e.name !== 'LlmFormatError') throw e;
      break;
    }
    const text = str(data?.text);
    const after = words(text);
    const shared = [...after].filter((w) => before.has(w)).length;
    // Same problem: most of the re-read's words were in the first transcription, and it is not a fragment.
    const same = after.size >= 5 && shared / after.size >= 0.7 && shared / Math.max(1, before.size) >= 0.4;
    if (!same) continue;
    const kept = derivedLeaks(result, text).map((l) => l.token);
    if (!kept.length) { useText(result, text, data, suspects); return; }
    reads.push({ text, data, kept });
  }
  // Values both printed-only reads still show are printed conditions, not handwriting.
  const printed = reads.length === 2 ? suspects.filter((t) => reads.every((r) => r.kept.includes(t))) : [];
  if (printed.length) {
    result.printedValues = [...new Set([...(result.printedValues || []), ...printed])];
    result.proofread.push(`인쇄된 조건으로 확인(인쇄 글자만 두 번 읽어도 그대로): ${printed.join(', ')}`);
  }
  const rest = suspects.filter((t) => !printed.includes(t));
  if (!rest.length) return;
  const clean = reads.find((r) => r.kept.every((t) => printed.includes(t)));
  if (clean) { useText(result, clean.text, clean.data, rest); return; }
  result.uncertainties.push(`문제 본문에 해설에서 구하는 값(${rest.join(', ')})이 있는데, 인쇄된 글자만 다시 읽어도 확인하지 못했습니다. 필기인지 원본과 대조해 주세요.`);
}

function useText(result, text, data, removed) {
  // A re-read that lost a line of the first reading (a condition, a "(단, …)") still replaces it when most words
  // match; the lost line is reported for the teacher (2026-10-26 audit).
  const tokens = (l) => new Set(String(l).replace(/\$[^$]*\$/g, ' ').match(/[가-힣]{2,}|[A-Za-z]{2,}|\d+/g) || []);
  const lines = (t) => String(t || '').split('\n').map((l) => l.trim()).filter((l) => l && !/^\|/.test(l));
  const after = lines(text).map(tokens);
  const gone = lines(result.problem.text).filter((l) => (l.match(/[가-힣]/g) || []).length >= 6).filter((l) => {
    const a = tokens(l);
    return a.size && !after.some((b) => [...a].filter((w) => b.has(w)).length / a.size >= 0.5);
  });
  if (gone.length) result.uncertainties.push(`문제 본문 재판독에서 처음 판독의 줄이 빠졌습니다. 원본과 대조해 주세요: ${gone.map((l) => l.slice(0, 60)).join(' / ')}`);
  result.problem.text = text;
  if (str(data?.figure)) result.problem.figure = str(data?.figure);
  result.proofread.push(`문제 본문 재판독(인쇄된 글자만): 해설에서 구하는 값 ${removed.join(', ')}이(가) 빠진 본문으로 교체`);
}

// The original's verification program did not run (undefined name, syntax): show the model the error and
// ask for a runnable program once, like the repair step of a generated problem.
async function fixSourceVerification(ctx, result, error) {
  ctx.log('원본 검산 프로그램이 실행되지 않아 고치는 중');
  let data;
  try {
    ({ data } = await ctx.llm.json({ purpose: 'fix-verification', jobId: ctx.job.id, budget: ctx.budget, signal: ctx.signal, effort: 'off', maxTokens: 6000,
      system: prompts.FIX_VERIFICATION_SYSTEM, text: prompts.fixVerificationText(result, error) }));
  } catch (e) {
    if (e.name !== 'BudgetExceeded' && e.name !== 'LlmFormatError') throw e;
    return;
  }
  if (!data?.verification || typeof data.verification !== 'object') return;
  const previous = result.sourceVerification;
  result.sourceVerification = data.verification;
  const checks = await sourceChecks(result);
  if (checks.find((c) => c.id === 'source-calculation')?.runError) { result.sourceVerification = previous; return; }
  result.checks = checks;
  result.proofread.push('원본 검산 프로그램의 실행 오류를 고쳐 다시 검산했습니다.');
}

/** Checks on the transcribed original (v1 source-calculation / source-quantity, generalized). */
async function sourceChecks(material) {
  const checks = [];
  // "answer": "3, 12g" reads as 0 and went through as 정답 0번, the code check skipping the comparison (2026-10-26 audit).
  if ((material.problem.choices || []).length && !(material.problem.answer >= 1)) {
    checks.push({ id: 'source-answer', label: '원본 정답 표시', state: 'fail', evidence: '선택지는 있는데 원본의 정답 번호를 읽지 못했습니다. 정답 번호를 확인해 주세요.' });
  }
  if (material.sourceVerification) {
    const r = await codeCheck(material.sourceVerification, { answer: material.problem.answer, choiceCount: material.problem.choices.length });
    // A program that does not run says nothing about the transcribed numbers: report it as unverified.
    if (r.runError) {
      checks.push({ id: 'source-calculation', label: '원본 정답 검산', state: 'unknown', runError: true, evidence: `검산 프로그램이 실행되지 않아 수치를 확인하지 못했습니다: ${r.reasons.join('; ')}` });
    } else {
      checks.push({ id: 'source-calculation', label: '원본 정답 검산', state: r.status === 'fail' ? 'fail' : 'pass',
        evidence: r.status === 'fail' ? `옮겨 적은 수치로 해설대로 계산하면 정답과 맞지 않습니다: ${r.reasons.join('; ')}` : r.status === 'skip' ? '수치로 검산할 대상 없음' : '해설대로 계산한 값이 원본 정답과 일치' });
    }
  } else {
    checks.push({ id: 'source-calculation', label: '원본 정답 검산', state: 'unknown', evidence: '분석 결과에 검산 프로그램이 없습니다.' });
  }
  // Math left open in the transcription ($ without its pair) breaks the rendering of everything after it and reaches
  // every variant's solution: the same check a generated problem gets (harness.js), named by field.
  const open = (t) => (String(t || '').replace(/\\\$/g, '').match(/\$/g) || []).length % 2 === 1;
  const unpaired = [
    ...(open(material.problem.text) ? ['문제 본문'] : []), ...(open(material.problem.figure) ? ['그림 설명'] : []),
    ...(material.problem.choices || []).flatMap((c, i) => (open(c) ? [`선택지 ${i + 1}`] : [])),
    ...(material.steps || []).flatMap((st, i) => ['title', 'work', 'result'].filter((k) => open(st[k])).map((k) => `STEP ${i + 1} ${{ title: '제목', work: '풀이', result: '결론' }[k]}`)),
  ];
  checks.push({ id: 'source-math', label: '수식 기호 짝', state: unpaired.length ? 'fail' : 'pass',
    evidence: unpaired.length ? `${unpaired.join(', ')}에 $ 기호의 짝이 맞지 않습니다. 수식이 닫히지 않으면 그 뒤 글이 모두 수식으로 표시됩니다.` : '' });
  // A ㄱㄴㄷ problem whose solution judges each statement (|보기 분석|): the transcription must keep those judgments in
  // the last STEP, or every variant solution is compared with a teacher solution that has none (2026-10-05: Qwen's
  // C38 analysis dropped them; the writer then added judgments and the reviewer called them extra).
  const markers = [...new Set([...material.problem.text.matchAll(/(?:^|\n)\s*([ㄱ-ㄹ])\s*\./g)].map((m) => m[1]))];
  if (markers.length >= 2) {
    const judged = Object.keys(harness.judgments((material.steps || []).map((s) => s.work).join('\n')));
    const missing = markers.filter((k) => !judged.includes(k));
    checks.push({ id: 'source-choice-analysis', label: '해설의 보기 분석', state: missing.length ? 'fail' : 'pass',
      evidence: missing.length ? `해설 STEP에 보기 ${missing.join(', ')}의 판정(○/×)이 없습니다. 해설에 보기 분석이 있다면 마지막 STEP 끝에 옮겨 적어야 변형 해설도 같은 형식으로 씁니다.` : '' });
  }
  const leaks = derivedLeaks(material, material.problem.text).map((l) => `STEP ${l.step}에서 구하는 ${l.token}`);
  checks.push({ id: 'derived-value-in-problem', label: '해설에서 구하는 값이 문제에 없음', state: leaks.length ? 'fail' : 'pass',
    evidence: leaks.length ? `${[...new Set(leaks)].join(', ')}이(가) 문제 본문에 있습니다. 필기를 조건으로 옮긴 것일 수 있습니다.` : '' });
  return checks;
}

// ---------------------------------------------------------------- generation

function coverage(stage, stepCount, used, shortcuts = []) {
  const expected = stage.kind === 'upto' ? Array.from({ length: stage.upto }, (_, i) => i + 1)
    : stage.kind === 'focus' ? [stage.step]
    : Array.from({ length: stepCount }, (_, i) => i + 1);
  const usedSet = new Set(used);
  const missing = expected.filter((n) => !usedSet.has(n));
  const extra = used.filter((n) => !expected.includes(n) && !(stage.kind === 'focus' && n < stage.step));
  const notes = [];
  if (missing.length) notes.push(`독립 풀이에서 STEP ${missing.join(', ')} 로직 없이 풀렸습니다.`);
  if (extra.length) notes.push(`독립 풀이에 목표 범위 밖 STEP ${extra.join(', ')} 로직이 필요했습니다.`);
  // A target STEP whose technique can be skipped (e.g. the leftover is obvious from the masses) is not practised.
  for (const c of shortcuts.filter((x) => expected.includes(x.step))) notes.push(`STEP ${c.step}의 핵심 기법 없이 결론이 나옵니다: ${c.how}`);
  return { status: notes.length ? 'warn' : 'pass', expected, used, notes };
}

async function blindSolve(ctx, item, material, rules, compareOriginal) {
  ctx.log(`${item.label}: 독립 풀이로 검토 중`);
  let data;
  try {
    ({ data } = await ctx.llm.json({
      purpose: 'solve', jobId: ctx.job.id, budget: ctx.budget, signal: ctx.signal, effort: ctx.effort.solve, maxTokens: 24000,
      system: prompts.SOLVE_SYSTEM, ...prompts.solveParts({ item, material, rules, compareOriginal }),
    }));
  } catch (e) {
    if (e.name !== 'LlmFormatError') throw e;
    // A solver that cannot finish (e.g. a small model re-solving until the output limit) is a verification
    // result, not a reason to throw the generated problem away: it goes to the teacher as unverified.
    data = { answer: 0, confident: false, solution: `독립 풀이가 출력 한도 안에서 답을 내지 못했습니다 (${e.message}).` };
  }
  const choiceCount = item.problem.choices.length;
  return {
    answer: answerNumber(data?.answer, choiceCount || 99),
    answerValue: str(data?.answerValue, 1000),
    confident: data?.confident !== false,
    solution: str(data?.solution),
    stepsUsed: arr(data?.stepsUsed).map((n) => Number.parseInt(n, 10)).filter((n) => n > 0),
    shortcuts: arr(data?.shortcuts).map((c) => ({ step: Number.parseInt(c?.step, 10) || 0, how: str(c?.how, 2000) })).filter((c) => c.step > 0 && c.how).slice(0, 6),
    issues: arr(data?.issues).map((i) => ({ type: str(i?.type, 30) || 'other', detail: str(i?.detail, 2000) })).filter((i) => i.detail).slice(0, 10),
    // Kept rules by id only, like the solution review: a note for every kept rule was 44% of the solver's answer.
    rules: judgedRules(data?.rules),
    conditions: arr(data?.conditions).map((c) => ({ text: str(c?.text, 1000), used: c?.used !== false })).filter((c) => c.text).slice(0, 30),
    variation: ['numbers-only', 'structural'].includes(data?.variation) ? data.variation : 'n/a',
    variationNote: str(data?.variationNote, 2000),
  };
}

/** Teacher feedback ①: compares the written solution with the teacher's, STEP by STEP (the solver never sees it). */
async function reviewSolution(ctx, item, material, rules) {
  if (!(item.solution?.steps || []).length) return { steps: [], rules: [] };
  ctx.log(`${item.label}: 해설을 선생님 해설과 대조 중`);
  let data;
  try {
    ({ data } = await ctx.llm.json({
      purpose: 'review-solution', jobId: ctx.job.id, budget: ctx.budget, signal: ctx.signal, effort: ctx.effort.solve, maxTokens: 12000,
      system: prompts.SOLUTION_REVIEW_SYSTEM, ...prompts.solutionReviewParts({ item, material, rules }),
    }));
  } catch (e) {
    if (e.name !== 'LlmFormatError') throw e;
    return { steps: [], rules: [], error: e.message };
  }
  // Only what deviates comes back with words: the STEPs with issues, the rules broken (kept ones by id), which keeps
  // the reviewer's answer short (2026-10-03: review and rewrite were about half of a set's tokens).
  return {
    steps: arr(data?.steps).map((s) => ({ step: Number.parseInt(s?.step, 10) || 0, ok: s?.ok === true ? true : !arr(s?.issues).length, issues: arr(s?.issues).map((x) => str(x, 2000)).filter(Boolean).slice(0, 6) })),
    rules: judgedRules(data?.rules),
  };
}

// The original's pictures for the final review (the analysis's zoomed pieces when it made them).
function originalImages(store, material) {
  const out = [];
  for (const [key, label] of [['problem', '원본 문제'], ['solution', '원본 해설']]) {
    const views = material.images?.views?.[key] || [];
    const list = views.length ? views : [material.images?.[key]].filter(Boolean);
    list.forEach((id, i) => {
      const dataUrl = store?.files?.dataUrl(id);
      if (dataUrl) out.push({ label: `${label}${list.length > 1 ? ` (${i + 1}/${list.length})` : ''}`, dataUrl });
    });
  }
  return out;
}

/** 최종 검수 while the problem is made: the review of review-criteria.md a finished set gets afterwards (scripts/
 *  review-problem.js), on this one problem by the job's judging model. What it finds goes back for repair like any other
 *  fault, and a problem is made only once it passes (server/final-review.js). Returns the faults left (none = passed). */
async function finalGate(ctx, item, material, prior, hints = []) {
  if (ctx.budget.affords && !ctx.budget.affords(1 + (ctx.reserveCalls || 0))) {
    return { faults: [], skipped: '세트의 AI 호출·토큰 상한 때문에 최종 검수를 하지 못했습니다.' };
  }
  ctx.log(`${item.label}: 최종 검수 기준으로 검토 중`);
  const subject = { ...material, id: ctx.job.materialId };
  const allRules = ctx.store?.rules?.all() || [];
  // The system's own lessons are advice to the writer, not criteria (final-review.js, advisoryTexts).
  const advisory = finalReview.advisoryTexts(subject, allRules, ctx.generationRules ?? ctx.job.rules ?? null);
  // What this original (and its topic) was faulted for before: the reviewer checks those first (server/faults.js).
  const known = (ctx.priorFaults || []).filter((e) => e.own || e.where === '같은 단원의 다른 원본').slice(0, 6);
  try {
    const ask = (again = '') => ctx.llm.json({
      purpose: 'final-review', jobId: ctx.job.id, budget: ctx.budget, signal: ctx.signal, effort: ctx.effort.review || 'high', maxTokens: 24000, vision: true,
      system: finalReview.reviewSystem(subject, allRules, ctx.generationRules ?? ctx.job.rules ?? null),
      text: finalReview.itemReviewText(material, item, prior, hints, known) + again,
      images: originalImages(ctx.store, material),
    });
    const mismatch = ['최종 검수가 이 문항(index·label)의 판정을 돌려주지 않았습니다. 다시 검수해야 합니다.'];
    const answer = item.problem?.answer;
    // The verdict must be about this problem and in form. A review that answers about another problem of the set (its
    // index or label — the prompt shows the earlier problems too) or without what a verdict needs (every criterion
    // judged, its own answer, its faults in form) is asked once more, told so; and if the second is no better, the
    // review is skipped and the problem waits for the teacher. Taken as a fault it sent the problem to a repair and a
    // solve for nothing (2026-10-26 audit, 2026-10-27 review).
    const judge = (d) => { const found = finalReview.matchItem(d, item) || null; return { found, faults: found ? finalReview.itemFaults({ ...d, items: [found] }, { advisory, answer }) : mismatch }; };
    const incomplete = (list) => list.some((f) => /다시 검수해야 합니다/.test(f));
    const AGAIN = `\n\n[이전 응답이 불완전했습니다] items에는 index ${item.index}, label "${item.label}"인 [검토할 변형 문제] 하나만 넣고, 그 문항의 checks에 기준 항목 전부의 판정, myAnswer에 직접 푼 정답 번호, verdict와 issues(결함 목록)를 갖춘다. 앞 문제의 판정을 옮기지 않는다.`;
    let { data } = await ask();
    let { found: review, faults } = judge(data);
    if (incomplete(faults) && (!ctx.budget.affords || ctx.budget.affords(1 + (ctx.reserveCalls || 0)))) {
      ctx.log(`${item.label}: 최종 검수 응답이 불완전해 다시 검수합니다 (${faults[0].slice(0, 80)})`);
      ({ data } = await ask(AGAIN));
      ({ found: review, faults } = judge(data));
    }
    if (incomplete(faults)) {
      (item.reviewRounds = item.reviewRounds || []).push({ at: new Date().toISOString(), design: item.attempts.filter((a) => a.kind === 'generate').length, verdict: '', myAnswer: '', faults });
      ctx.save();
      return { faults: [], skipped: `최종 검수 응답이 두 번 모두 불완전했습니다 (${faults[0]})` };
    }
    // What it found goes into the log: a 39-minute regeneration failed on 2026-10-23 with seven '1건 — 고침' lines and no way to tell what.
    ctx.log(`${item.label}: 최종 검수 ${faults.length ? `${faults.length}건 — 고침: ${faults.map((f) => f.replace(/\s+/g, ' ').slice(0, 90)).join(' / ').slice(0, 300)}` : '통과'}`);
    // What one review passes, a second reviewer looks at too, as the finished set is reviewed by Claude and Gemini: on
    // the eight new originals (2026-10-21) the review here passed 24 of 25 problems and the set's review failed 7 of
    // them — Claude's own review 6, Gemini's 2. The second look is on its own subscription, outside the set's budget; if
    // it cannot be had (not connected, its limit) the first review stands.
    let second = null;
    if (!faults.length && ctx.secondReviewer) {
      try {
        ctx.log(`${item.label}: 두 번째 검수자(${ctx.secondReviewer})가 같은 기준으로 검토 중`);
        const askSecond = (again = '') => ctx.llm.json({
          purpose: 'final-review-second', provider: ctx.secondReviewer, jobId: ctx.job.id, budget: new Budget({ maxCalls: 2, maxTokens: 3000000 }), signal: ctx.signal, maxTokens: 24000, vision: true,
          system: finalReview.reviewSystem(subject, allRules, ctx.generationRules ?? ctx.job.rules ?? null),
          text: finalReview.itemReviewText(material, item, prior, hints, known) + again,
          images: originalImages(ctx.store, material),
        });
        ({ data: second } = await askSecond());
        let verdict = judge(second);
        if (incomplete(verdict.faults)) { ctx.log(`${item.label}: 두 번째 검수 응답이 불완전해 다시 검수합니다`); ({ data: second } = await askSecond(AGAIN)); verdict = judge(second); }
        if (incomplete(verdict.faults)) { ctx.log(`${item.label}: 두 번째 검수 응답이 두 번 모두 불완전해 첫 검수로 판정합니다`); second = null; }
        else { faults = verdict.faults.map((f) => `[두 번째 검수] ${f}`); ctx.log(`${item.label}: 두 번째 검수 ${faults.length ? `${faults.length}건 — 고침` : '통과'}`); }
      } catch (e) {
        if (ctx.signal?.aborted) throw e;
        ctx.log(`${item.label}: 두 번째 검수를 하지 못해 첫 검수로 판정합니다 (${e.message})`);
        second = null;
      }
    }
    // Every round is kept for the set page: what each review found, and that the next one passed.
    (item.reviewRounds = item.reviewRounds || []).push({ at: new Date().toISOString(), design: item.attempts.filter((a) => a.kind === 'generate').length, verdict: review?.verdict || '', myAnswer: str(review?.myAnswer, 300), faults });
    ctx.save();
    const judged = faults.length && second ? second : data;
    const own = (d) => ({ ...d, items: [finalReview.matchItem(d, item)].filter(Boolean) });
    return { faults, notes: faults.length ? [] : [...finalReview.itemNotes(own(data), { advisory }), ...(second ? finalReview.itemNotes(own(second), { advisory }) : [])], review, solutionOnly: faults.length > 0 && finalReview.solutionOnly(own(judged), { advisory }) };
  } catch (e) {
    if (e.name !== 'LlmFormatError') throw e;
    return { faults: [], skipped: `최종 검수 응답을 읽지 못했습니다 (${e.message}).` };
  }
}

/** The analysis (the original read and its STEPs) under the same criteria, once per original as it now reads: kept with
 *  the original, so the set page shows the rows 원본을 정확히 읽는다 and 선생님 STEP을 그대로 쓴다 of the checklist. */
// What the analysis review finds is fixed against the original before any problem is made from the analysis, and the
// fixed analysis is reviewed once more: on chem-c32-molar-volume (2026-10-19) the review found the analysis had moved
// the teacher's '/몰' and dropped "분자량=질량/양(mol)이고 …", every problem's solution followed the analysis, and Claude
// and Gemini then found both in all three problems of the set.
// One look does not find everything: on the third c32 run the first review found one fault, and the review of the fixed
// analysis three more (one of them the '분자량=질량/양(mol)이고 …' line the run before had found first). Up to two rounds.
// What the last look still lists decides as a problem's review does (final-review.js itemFaults): a high or mid fault
// stops the set, low notes (a shortened sentence, a middle step left out) do not. On chem-c32-molar-volume (2026-10-26)
// the third look listed one mid fault the fixer's cut had caused and three low notes, and the 학습 반복 stopped at its
// first set for the teacher. The low notes left are fixed once more against the original and the analysis passes with
// them on record; a high or mid fault left stops the set as before.
async function reviewAnalysis(ctx, material, rounds = 2) {
  let review = await reviewAnalysisOnce(ctx, material);
  const fixed = [];
  const before = [];
  for (let round = 0; round < rounds && review?.verdict === 'issues' && review.issues.length; round++) {
    const done = await fixAnalysis(ctx, material, review.issues);
    if (!done.length) break;
    fixed.push(...done);
    before.push(...review.issues);
    const again = await reviewAnalysisOnce(ctx, material);
    if (!again) break;
    review = again;
  }
  if (review && review.verdict === 'issues' && review.passed && review.issues.length) {
    const done = await fixAnalysis(ctx, material, review.issues);
    if (done.length) { fixed.push(...done); before.push(...review.issues); review = { ...review, key: analysisKey(material), issues: [], fixedLast: true }; }
  }
  if (!fixed.length || !review) return review;
  Object.assign(review, { fixed, before });
  ctx.job.analysisReview = review;
  const stored = ctx.store?.materials?.get(ctx.job.materialId);
  if (stored && analysisKey(stored) === analysisKey(material)) ctx.store.materials.put({ ...stored, analysisReview: review });
  ctx.save();
  return review;
}

/** Whether an analysis review lets the set be made: no high or mid fault (older records: the verdict). */
const analysisPassed = (review) => Boolean(review && (review.passed ?? review.verdict === 'ok'));

/** The review's findings → fixes of the analysis fields against the images (applyFixes), on the job's copy and the original. */
async function fixAnalysis(ctx, material, all) {
  // A reviewer's broken answer ('검수 응답': the list missing, a check without its reason) says nothing about the
  // analysis; it is asked again, never "fixed" into the original (2026-10-26 audit).
  const issues = (all || []).filter((x) => x && x.rule !== '검수 응답');
  if (!issues.length) return [];
  const beforeKey = analysisKey(material);
  if (ctx.budget.affords && !ctx.budget.affords(5)) return [];
  ctx.log(`원본 분석 검토에서 걸린 ${issues.length}건을 원본과 대조해 고치는 중`);
  const fields = { 'problem.text': material.problem.text, 'problem.figure': material.problem.figure || '' };
  (material.problem.choices || []).forEach((c, i) => { fields[`problem.choices[${i}]`] = c; });
  material.steps.forEach((s, i) => { for (const k of ['title', 'work', 'result']) if (s[k]) fields[`steps[${i}].${k}`] = s[k]; });
  let data;
  try {
    ({ data } = await ctx.llm.json({
      purpose: 'fix-analysis', jobId: ctx.job.id, budget: ctx.budget, signal: ctx.signal, effort: ctx.effort.solve, maxTokens: 16000, vision: true,
      system: prompts.FIX_ANALYSIS_SYSTEM, text: prompts.fixAnalysisText(fields, issues), images: originalImages(ctx.store, material),
    }));
  } catch (e) {
    if (e.name === 'BudgetExceeded' || ctx.signal?.aborted) throw e;
    ctx.log(`원본 분석을 고치지 못했습니다 (${e.message})`);
    return [];
  }
  const fixes = arr(data?.fixes).slice(0, 20);
  const { applied, unresolved } = applyFixes(material, fixes);
  for (const u of unresolved) ctx.log(`원본 분석 교정을 적용하지 못했습니다: ${u.slice(0, 200)}`);
  if (!applied.length) { ctx.log('원본 분석: 고칠 곳을 찾지 못했습니다'); return []; }
  // The teacher's frames were cut from the analysis as it read; they are cut again from the fixed one.
  delete material.frames;
  delete material.framesKey;
  delete material.analysisReview;
  const stored = ctx.store?.materials?.get(ctx.job.materialId);
  if (stored && analysisKey(stored) === beforeKey) {
    const copy = JSON.parse(JSON.stringify({ problem: stored.problem, steps: stored.steps }));
    applyFixes(copy, fixes);
    const { frames, framesKey, analysisReview, ...rest } = stored;
    ctx.store.materials.put({ ...rest, problem: copy.problem, steps: copy.steps, analysisFixes: [...(stored.analysisFixes || []), { at: new Date().toISOString(), jobId: ctx.job.id, applied, ...(unresolved.length ? { unresolved } : {}) }] });
  }
  ctx.log(`원본 분석 ${applied.length}곳을 고쳤습니다`);
  return applied;
}

async function reviewAnalysisOnce(ctx, material) {
  const stored = ctx.store?.materials?.get(ctx.job.materialId);
  const key = analysisKey(material);
  if (stored?.analysisReview?.key === key && analysisPassed(stored.analysisReview) && !stored.analysisReview.issues?.length) {
    ctx.job.analysisReview = stored.analysisReview; ctx.save(); return stored.analysisReview;
  }
  if (ctx.budget.affords && !ctx.budget.affords(4)) throw new BudgetExceeded('원본 분석 검수·수리에 필요한 모델 호출·토큰 상한이 부족합니다.');
  ctx.log('원본 분석을 최종 검수 기준으로 검토 중');
  try {
    const { data } = await ctx.llm.json({
      purpose: 'final-review', jobId: ctx.job.id, budget: ctx.budget, signal: ctx.signal, effort: ctx.effort.solve, maxTokens: 16000, vision: true,
      system: finalReview.reviewSystem({ ...material, id: ctx.job.materialId }, ctx.store?.rules?.all() || [], ctx.generationRules ?? ctx.job.rules ?? null),
      text: finalReview.analysisText(material), images: originalImages(ctx.store, material),
    });
    const a = data?.analysis || {};
    const issues = finalReview.analysisFaults(a);
    const review = { key, at: new Date().toISOString(), verdict: issues.length ? 'issues' : 'ok', passed: !issues.some((x) => x.severity !== 'low'), issues: issues.slice(0, 12), checklist: finalReview.checklistOf(a, { analysis: true }) };
    ctx.job.analysisReview = review;
    const latest = ctx.store?.materials?.get(ctx.job.materialId);
    if (latest && analysisKey(latest) === key) ctx.store.materials.put({ ...latest, analysisReview: review });
    ctx.log(`원본 분석 검토: ${review.issues.length ? `${review.issues.length}건` : '이상 없음'}`);
    ctx.save();
    return review;
  } catch (e) {
    if (e.name === 'BudgetExceeded' || ctx.signal?.aborted) throw e;
    ctx.log(`원본 분석 검토를 하지 못했습니다 (${e.message})`);
    return null;
  }
}

/** A judge's rule verdicts: {kept: [id], broken: [{id, note}]}, or the older shape (every rule with ok and a note). */
function judgedRules(rules) {
  const list = Array.isArray(rules) ? rules
    : [...arr(rules?.kept).map((id) => ({ id, ok: true })), ...arr(rules?.broken).map((r) => ({ ...r, ok: false }))];
  return list.map((r) => (typeof r === 'string' ? { id: r, ok: true } : r)).map((r) => ({ id: str(r?.id, 40), ok: r?.ok !== false, note: str(r?.note, 2000) })).filter((r) => r.id);
}

const BLOCKING_ISSUES = new Set(['ambiguous', 'contradiction', 'missing', 'revealed']);

// Table rows as number signatures: "| Ⅰ | $8w$ | $6w$ | ..." -> "8w,6w". Only the first two data cells
// (the given amounts) are compared, so a row reusing an earlier experiment's inputs is caught.
function tableRows(text, hidden = {}) {
  const rows = [];
  for (const line of String(text || '').split('\n')) {
    if (!/^\s*\|/.test(line) || /^\s*\|[\s:|-]+\|\s*$/.test(line)) continue;
    // cols: every cell in its column (null where it holds no amount), so rows can be compared column by column.
    const cols = line.trim().replace(/^\||\|$/g, '').split('|').slice(1)
      .map((c) => c.replace(/\\ce\{[^}]*\}|\$|\s|\\,/g, '').replace(/\\(d?frac)\{(\d+)\}\{(\d+)\}/g, '$2/$3'))
      .map((c) => hidden[c] ?? c)
      // A formula (\mathrm{ZX_2}) names the row, it is not an amount: with it the row's amounts were never compared.
      .map((c) => (/\d/.test(c) && c.length <= 24 && !/(mathrm|text)\{/.test(c) ? c : null));
    const cells = cols.filter((c) => c !== null);
    if (cells.length >= 2) rows.push({ label: line.split('|')[1].trim().replace(/\$/g, ''), sig: cells.slice(0, 2).join(','), cells, cols });
  }
  return rows;
}
// Values that repeat across the original's table or come from its figure (membrane potentials 0, -70, +30 read
// off one action-potential curve) are the problem's reading vocabulary, not designed experiment amounts:
// rows made only of them are expected to recur and are not "reused numbers".
function readingVocabulary(material) {
  const count = new Map();
  for (const r of tableRows(material.problem.text)) for (const c of new Set(r.cells)) count.set(c, (count.get(c) || 0) + 1); // rows containing c
  const figure = new Set(harness.plain(material.problem.figure).replace(/[−–]/g, '-').replace(/\s/g, '').match(/[+-]?\d+(?:\.\d+)?/g) || []);
  const bare = (v) => v.replace(/^\+/, '');
  return new Set([...count].filter(([v, n]) => n >= 2 || figure.has(v) || figure.has(bare(v))).map(([v]) => v));
}
const designedRows = (text, vocab, hidden) => tableRows(text, hidden).filter((r) => !r.sig.split(',').every((v) => vocab.has(v)));
// A table's hidden letters (a, b) with the values its solution works out ("a=12"): a row that gives as numbers what the
// original hid reuses it all the same. On chem-c32-molar-volume (2026-10-19) STEP 1~2's (가) was 23 g, 12 L — the
// original's (나), 23 g and a = 12 — and only Claude's later review saw it.
function hiddenValues(text, steps) {
  const letters = new Set();
  for (const row of String(text || '').split('\n')) if (/^\s*\|/.test(row)) for (const c of row.split('|')) { const m = /^\s*\$?\s*([a-z])\s*\$?\s*$/.exec(c); if (m) letters.add(m[1]); }
  const work = (steps || []).map((s) => `${s.work || ''}\n${s.result || ''}`).join('\n').replace(/\$/g, '');
  const out = {};
  for (const l of letters) { const m = new RegExp(`(?:^|[^A-Za-z\\\\])${l}\\s*=\\s*(\\d+(?:\\.\\d+)?)(?![\\d.])`).exec(work); if (m) out[l] = m[1]; }
  return out;
}

// A table of marks (○/×, +/−, ?) as the matrix of its data cells, header and label column dropped; null when the text
// holds no such table.
function markTable(text) {
  let rows = [];
  for (const line of String(text || '').split('\n')) {
    if (!/^\s*\|/.test(line)) continue;
    if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) { rows = []; continue; } // the line above was the header
    const all = line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.replace(/\$|\s/g, ''));
    const cells = all.slice(1);
    if (cells.length >= 2 && cells.every((c) => c.length > 0 && c.length <= 2 && !/\d/.test(c))) { cells.label = all[0]; rows.push(cells); }
  }
  return rows.length >= 2 && rows.every((r) => r.length === rows[0].length) ? rows : null;
}
// The table under its own row labels with its columns in one order: equal for two tables that differ only in the
// order of their columns.
function labelledMarks(m) {
  const rows = [...m].sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
  return rows.map((r) => r.label).join(',') + ' ' + rows[0].map((_, j) => rows.map((r) => r[j]).join('')).sort().join('|');
}
// The matrix's one form under any order of its rows and of its columns: the smallest column list over the row orders.
function canonicalMarks(m) {
  if (m.length > 7) return null;
  const perms = (xs) => (xs.length <= 1 ? [xs] : xs.flatMap((x, i) => perms([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p])));
  let best = null;
  for (const p of perms(m.map((_, i) => i))) {
    const cols = m[0].map((_, j) => p.map((i) => m[i][j]).join('')).sort().join('|');
    if (best === null || cols < best) best = cols;
  }
  return best;
}
const transposed = (m) => m[0].map((_, j) => m.map((r) => r[j]));
const HIDDEN_MARK = /^(?:[?？]|[a-z]|[ⓐ-ⓩ])$/;
/**
 * The final problem's table of marks that is the original's with its rows renamed and its columns reordered, and hides
 * nothing, is the original's problem: on bio-k61 (2026-10-23) the first set's final and the next set's final each mapped
 * onto the original's ○/× table (㉠~㉣ and (가)~(다) permuted), one past the final review, one failed by the set review as
 * numbers-only; the number checks above see no number in it. A practice problem keeps the original's layout by design
 * (the cells' roles are the teacher's STEP logic: asked for another layout, the writer spent seven repairs and two designs
 * between this check and the final review's 용기·실험 구성 the same day), and so may a final that hides a cell — the
 * variation criteria change what is hidden inside the same table, not the table.
 */
function marksReused(item, prior, material) {
  const mine = markTable(item.problem.text);
  if (!mine) return [];
  const notes = [];
  // The same table with its columns reordered, under the same row labels, is the same problem again: the set's STEP 1~2
  // 연습 put STEP 1 연습's three cells in another order and the set review failed it (bio-k61, 2026-10-23).
  const mineLabelled = labelledMarks(mine);
  const earlier = [['원본', material.problem], ...prior.filter((o) => o.problem && o.index < item.index).map((o) => [`앞 문제(${o.label})`, o.problem])];
  for (const [whose, problem] of earlier) {
    const theirs = markTable(problem.text);
    if (theirs && labelledMarks(theirs) === mineLabelled) notes.push(`${whose}의 표와 같은 표입니다: 열(${mine[0].length}개)의 순서만 바꾼 것이라 같은 값 조합에서 같은 판단이 나옵니다. 행마다 ○/×를 새로 잡습니다.`);
  }
  if (notes.length || item.stage.kind !== 'twin' || mine.some((r) => r.some((c) => HIDDEN_MARK.test(c)))) return notes;
  const key = canonicalMarks(mine);
  const theirs = markTable(material.problem.text);
  if (key === null || !theirs) return notes;
  const same = canonicalMarks(theirs) === key || (theirs[0].length === mine.length && theirs.length === mine[0].length && canonicalMarks(transposed(theirs)) === key);
  return same ? ['원본의 표와 같은 표이고 숨긴 칸이 없습니다: 행의 이름표와 열의 순서만 바꾸면 원본의 ○/× 배치가 그대로 나와, 원본과 같은 판단을 같은 순서로 하는 문제입니다. 표의 배치는 원본 그대로 두고, 칸 일부를 문자나 ?로 숨겨 문제의 다른 조건으로 그 칸을 정하게 합니다 (구조 변형의 기준 (1)).'] : [];
}

/** Experiment rows whose given amounts match the original's or (for the final problem) an earlier problem's. */
function numbersReused(item, prior, material) {
  const vocab = readingVocabulary(material);
  const mine = designedRows(item.problem.text, vocab);
  const notes = [...scaledOrKept(item, prior, material, vocab), ...marksReused(item, prior, material)];
  if (!mine.length) return notes;
  // The value a hidden letter comes to is the answer the student works out: the same as the original's (a = 12 asked
  // again, chem-c32-molar-volume 2026-10-19: the final review found it in a third round, past the repairs) is a
  // remembered answer, not a worked one.
  const myHidden = hiddenValues(item.problem.text, item.solution?.steps);
  const compare = (text, steps, whose) => {
    const theirHidden = hiddenValues(text, steps);
    // A row's values as a set of values, in any order: the teacher's rule is about a row's 값 조합, and D50's final put
    // the original's A row (−80, 0, ?, 0) in other columns (?, 0, −80, 0) past the check (학습 반복, 2026-10-23).
    const combo = (r) => [...r.cells].sort().join(',');
    const theirs = [...designedRows(text, vocab), ...designedRows(text, vocab, theirHidden)];
    const sigs = new Set(theirs.map((r) => r.sig));
    const combos = new Set(theirs.filter((r) => r.cells.length >= 3).map(combo));
    for (const r of mine) {
      if (sigs.has(r.sig)) notes.push(`${whose}의 실험 수치(${r.sig})를 그대로 썼습니다 (${r.label} 행).`);
      else if (r.cells.length >= 3 && combos.has(combo(r))) notes.push(`${whose}의 한 행과 같은 값 조합(${r.cells.join(', ')})을 칸 순서만 바꿔 썼습니다 (${r.label} 행). 값 조합을 새로 잡습니다.`);
    }
    for (const [l, v] of Object.entries(myHidden)) if (theirHidden[l] === v) notes.push(`${whose}에서 숨긴 값과 같은 값(${l}=${v})을 구하게 합니다. ${l}가 다른 값이 되게 수치를 잡습니다.`);
  };
  compare(material.problem.text, material.steps, '원본');
  if (item.stage.kind === 'twin') for (const other of prior) if (other.problem && other.index !== item.index) compare(other.problem.text, other.solution?.steps, `앞 문제(${other.label})`);
  return [...new Set(notes)];
}

// An amount as a number with its unit letters ("8w" -> [8, 'w'], "3/4" -> [0.75, '']), or null.
function amount(cell) {
  const m = /^([+-]?)(\d+(?:\.\d+)?)(?:\/(\d+))?([a-zA-Z]*)$/.exec(String(cell || '').replace(/−/g, '-'));
  if (!m) return null;
  const v = Number(m[2]) / (m[3] ? Number(m[3]) : 1);
  return [m[1] === '-' ? -v : v, m[4]];
}
// The ratio of two lists of amounts when every pair has the same one (zero to zero), else null.
function commonRatio(mine, theirs) {
  let k = null;
  let pairs = 0;
  for (let i = 0; i < mine.length; i++) {
    const a = amount(mine[i]);
    const b = amount(theirs[i]);
    if (!a || !b) continue;
    if (a[1] !== b[1]) return null;
    if (a[0] === 0 || b[0] === 0) { if (a[0] !== b[0]) return null; continue; }
    const r = a[0] / b[0];
    if (k !== null && Math.abs(r - k) > 1e-9 * Math.abs(k)) return null;
    k = r; pairs++;
  }
  return pairs >= 2 ? k : null;
}
const times = (k) => (Number.isInteger(k) ? `${k}배` : Number.isInteger(1 / k) ? `1/${1 / k}배` : `${+k.toFixed(3)}배`);
// Named values in the problem and its figure ("d_2=6", "x = 1.5"): the setting the student reads, outside the tables.
function namedValues(problem) {
  const text = `${problem?.text || ''}\n${problem?.figure || ''}`.replace(/\$|\\[,;! ]|\{|\}/g, '').replace(/−/g, '-');
  const out = {};
  for (const m of text.matchAll(/(?<![A-Za-z0-9_])([A-Za-z](?:_?[0-9A-Za-z])?)\s*=\s*([+-]?\d+(?:\.\d+)?(?:\/\d+)?)(?![\d./])/g)) out[m[1].replace('_', '')] ??= m[2];
  return out;
}
/**
 * Numbers that keep the original's (or an earlier problem's) setting under another face: a row whose amounts are those of
 * the same row times one factor, a row with most of its amounts the same in the same columns, and the named values of the
 * figure (positions, lengths) all one factor of the original's. On 생명 D50 (2026-10-21) the final problem drew the
 * positions 0, 6, 15, 21 cm for 0, 2, 5, 7 and the speeds three times as fast, so every time and answer was the
 * original's; on 생명 E38 the final problem's t₁ row kept the original's 1.6 and 0.6 with a new first amount. Only the
 * first two amounts of a row were compared, and the figure not at all.
 */
function scaledOrKept(item, prior, material, vocab) {
  const notes = [];
  const mine = designedRows(item.problem.text, vocab);
  const against = [['원본', material.problem], ...(item.stage.kind === 'twin' ? prior.filter((o) => o.problem && o.index !== item.index).map((o) => [`앞 문제(${o.label})`, o.problem]) : [])];
  for (const [whose, problem] of against) {
    const theirs = designedRows(problem.text, vocab);
    for (const r of mine) {
      for (const t of theirs.filter((x) => x.label === r.label && x.cols.length === r.cols.length)) {
        if (r.sig === t.sig) continue; // said already (numbersReused)
        // A value the original repeats (a length that stays the same) counts with the others, but alone it is no reuse.
        // 0 and 1 (a ratio's 1, an empty amount) match by themselves and say nothing.
        const kept = r.cols.filter((c, i) => c !== null && c === t.cols[i] && !['0', '1'].includes(c));
        const same = kept.some((c) => !vocab.has(c)) ? kept.length : 0;
        const given = Math.min(r.cols.filter((c) => c !== null).length, t.cols.filter((c) => c !== null).length);
        const k = commonRatio(r.cols, t.cols);
        if (k !== null && k !== 1 && (Number.isInteger(k) || Number.isInteger(1 / k))) notes.push(`${whose}의 ${r.label} 행 수치를 모두 ${times(k)} 한 값입니다. 비가 같아 구하는 값과 판단이 그대로 같아지므로, 행마다 비가 달라지게 수치를 잡습니다.`);
        else if (same >= 2 && same * 3 >= given * 2) notes.push(`${whose}의 ${r.label} 행과 같은 칸에 같은 수치가 ${same}개 있습니다 (${r.cols.filter((c) => c !== null).join(', ')}). 그 행의 수치를 새로 잡습니다.`);
      }
    }
    // The figure's setting kept or scaled whole. A practice problem may keep the original's setting, but scaled it is the
    // original's numbers in disguise: D50's STEP 1~2 practice put d₁~d₄ at twice the original's with twice the speed,
    // and every time and potential came out the original's (학습 반복, 2026-10-23, Claude).
    const a = namedValues(item.problem);
    const b = namedValues(problem);
    const names = Object.keys(a).filter((n) => n in b);
    if (names.length >= 3) {
      const k = commonRatio(names.map((n) => a[n]), names.map((n) => b[n]));
      if (k !== null && (item.stage.kind === 'twin' || k !== 1)) notes.push(`${whose}의 ${names.join(', ')} 값을 ${k === 1 ? '그대로 썼습니다' : `모두 ${times(k)} 했습니다`}. 비가 같아 구하는 값과 판단이 그대로 같아지므로, 값 사이의 비가 달라지게 잡습니다.`);
    }
  }
  return notes;
}

/** Row signatures the new problem must avoid: the original's, and (for the final problem) earlier problems'. */
// ---------------------------------------------------------------- learning from adopted variants
// A variant the teacher adopted (채택) is a good example for its original: later variants of the same stage are shown
// it as a model of structure and solution style (not to copy — its numbers join the ones to avoid).
const stageKey = (s) => `${s?.kind}:${s?.upto || s?.step || ''}`;
/** Adopted variants of this original across its sets (the teacher's first, then the ones both reviewers passed —
 *  faultsData.passedProblems), newest first; `exclude` leaves out the one being replaced. */
function adoptedExamples(store, materialId, exclude = {}) {
  const out = [];
  for (const j of store.jobs.all()) {
    if (j.type !== 'generate' || j.materialId !== materialId) continue;
    const passed = faultsData.passedProblems(store, j);
    for (const it of j.items || []) {
      if (!it.problem || (j.id === exclude.jobId && it.index === exclude.index)) continue;
      const source = it.adopted ? 'adopted' : passed.indices.has(it.index) ? 'passed' : '';
      if (!source) continue;
      out.push({ stage: it.stage, label: it.label, problem: it.problem, solution: it.solution, at: it.reviewedAt || j.createdAt, source, jobId: j.id, index: it.index, scores: source === 'passed' ? passed.scores : null });
    }
  }
  return out.sort((a, b) => Number(b.source === 'adopted') - Number(a.source === 'adopted') || String(b.at).localeCompare(String(a.at)));
}
/** The examples for one item: adopted variants of the same stage, at most two. */
const examplesFor = (item, examples = []) => examples.filter((e) => stageKey(e.stage) === stageKey(item.stage)).slice(0, 2);

function usedRowsFor(item, prior, material, examples = []) {
  const texts = [material.problem.text, ...(item.stage.kind === 'twin' ? prior.filter((p) => p.problem).map((p) => p.problem.text) : []), ...examples.map((e) => e.problem.text)];
  const vocab = readingVocabulary(material);
  return [...new Set(texts.flatMap((t) => designedRows(t, vocab).map((r) => r.sig)))];
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

// ---------------------------------------------------------------- lean mixed runs
// options.lean with designWith: the designer (strong, expensive) writes the problem, its verification program and a
// STEP outline; the job's own model writes the full solution from the outline in the teacher's format. Faults in the
// written solution go back to that writer, not to the designer. The solver's judgment calls (unused conditions,
// shortcuts, numbers-only, STEP coverage, problem-rule checks) stay in the record but do not send the problem back —
// a weak solver raised them falsely (Qwen 3.6, 2026-09-30: three of four repairs); an answer mismatch is first put
// to the designer, who decides whether the problem or the solver is wrong. Code checks stay as they are.
const SOLUTION_CHECKS = new Set(['source-method', 'source-method-order', 'source-assumption', 'explanation-consistency', 'explanation-complete', 'source-step-titles', 'source-tables']);
const solutionOnly = (c) => SOLUTION_CHECKS.has(c.id) || (c.id === 'format' && c.evidence.split('; ').every((e) => e.startsWith('해설')));

const flat = (s) => harness.plain(s).replace(/\\left|\\right|\s/g, '');
/** Values the outline derives (the last side of each "$…=…$") that the written solution must still show. */
function missingValues(outline, solution) {
  const text = flat(solution.steps.map((s) => s.work).join('\n') + '\n' + solution.summary);
  const values = new Set();
  for (const s of outline.steps) {
    for (const m of String(s.work).matchAll(/\$([^$]+)\$/g)) {
      const v = flat(m[1].split('=').pop());
      if (/\d/.test(v) && v.length <= 24) values.add(v);
    }
  }
  return [...values].filter((v) => v && !text.includes(v));
}

/** The job's own model writes the outline out as a full solution; returns warnings for the teacher. */
async function writeSolution(ctx, item, material, rules, fixes = [], purpose = 'write-solution') {
  ctx.log(`${item.label}: 해설 ${purpose === 'polish-solution' ? '다듬는' : '풀어 쓰는'} 중${fixes.length ? ` (고칠 점 ${fixes.length}건)` : ''}${ctx.routes?.[purpose] ? ` (${ctx.routes[purpose]})` : ''}`);
  let written = null;
  let missing = [];
  for (let attempt = 0; attempt < 2 && (!written || missing.length); attempt++) {
    const notes = [...fixes, ...missing.map((v) => `출제자 요지의 값 ${v}가 해설에 없습니다. 요지의 판정과 값을 그대로 쓴다.`)];
    let data;
    try {
      ({ data } = await ctx.llm.json({
        // With thinking off, Qwen 3.6 copied the outline instead of rewriting it in the teacher's format.
        purpose, jobId: ctx.job.id, budget: ctx.budget, signal: ctx.signal, effort: ctx.effort.solve, maxTokens: 20000,
        system: prompts.WRITE_SOLUTION_SYSTEM, ...prompts.writeSolutionParts({ item, material, rules, outline: item.outline, fixes: notes }),
      }));
    } catch (e) {
      if (e.name !== 'LlmFormatError') throw e;
      continue;
    }
    const solution = normalizeSolution(data?.solution);
    if (!solution.steps.length) continue;
    written = solution;
    missing = missingValues(item.outline, solution);
  }
  if (!written) { item.solution = item.outline; return ['해설 풀어쓰기에 실패해 출제자의 요지를 해설로 둡니다.']; }
  item.solution = stripSummaries(written, material);
  return missing.length ? [`풀어 쓴 해설에 출제자 요지의 값(${missing.join(', ')})이 보이지 않습니다.`] : [];
}

/** The designer checks a disagreeing solver's work: is the problem at fault, or the solver? */
async function adjudicate(ctx, item, blind, issues) {
  ctx.log(`${item.label}: 독립 풀이와 달라 출제자가 재확인 중`);
  try {
    const { data } = await ctx.llm.json({
      purpose: 'adjudicate', jobId: ctx.job.id, budget: ctx.budget, signal: ctx.signal, effort: ctx.effort.solve, maxTokens: 8000,
      system: prompts.ADJUDICATE_SYSTEM, text: prompts.adjudicateText({ item, blind, issues }),
    });
    return { problemAtFault: data?.problemAtFault === true, reason: str(data?.reason, 2000) };
  } catch (e) {
    if (e.name !== 'LlmFormatError') throw e;
    return { problemAtFault: true, reason: `재확인 응답을 읽지 못함 (${e.message})` };
  }
}

// A practice problem's solution has the STEPs of its range only. A model that writes the final calculation as one more
// STEP ("STEP 3 선택지 분석" in a STEP 1~2 practice, 2026-10-02) set two checks against each other: the title check
// wanted the original STEP 3 title, the solution review wanted no STEP 3. Such a STEP is folded into the last STEP of
// the range, where the teacher's solution puts its 선택지 분석 too.
function fitSolutionToStage(item) {
  const last = item.stage?.kind === 'upto' ? item.stage.upto : item.stage?.kind === 'focus' ? item.stage.step : 0;
  const steps = item.solution?.steps || [];
  if (!last || !steps.some((x) => x.step > last)) return false;
  const inside = steps.filter((x) => x.step <= last);
  if (!inside.length) return false;
  const end = inside[inside.length - 1];
  const extra = steps.filter((x) => x.step > last).map((x) => x.work).filter(Boolean).join('\n\n');
  item.solution = { ...item.solution, steps: inside.map((x) => (x === end ? { ...x, work: [x.work, extra].filter(Boolean).join('\n\n') } : x)) };
  return true;
}

/** What a solution review asks the writer to change: each STEP's issues and the rules it finds broken (a rule the
 *  independent solver judged is the solver's call). */
function reviewNotes(review, rules, blind) {
  return [
    ...review.steps.flatMap((s) => s.issues.map((x) => `해설이 선생님 해설과 다름 (STEP ${s.step}): ${x}`)),
    ...rules.filter((r) => !blind.rules.some((b) => b.id === r.id)).map((r) => [r, review.rules.find((b) => b.id === r.id)]).filter(([, b]) => b && !b.ok).map(([r, b]) => `교사 지침 미준수: ${r.text.slice(0, 80)} — ${b.note}`),
  ];
}

/** The solution review a check skipped (a repair was due), added for the version the teacher gets. */
async function addSolutionReview(ctx, item, material, rules, check) {
  if (ctx.finalGate || !check.verification.solutionReview?.skipped) return;
  if (ctx.budget.affords && !ctx.budget.affords(1 + (ctx.reserveCalls || 0))) return;
  const review = await reviewSolution(ctx, item, material, rules);
  check.verification.solutionReview = review;
  check.rewriteNotes.push(...reviewNotes(review, rules, check.verification.blind));
  for (const r of check.verification.rules) {
    const b = !r.judged && review.rules.find((x) => x.id === r.id);
    if (b) r.judged = { ok: b.ok, note: b.note };
  }
}

async function verifyItem(ctx, item, material, rules, mode, prior = [], keep = null) {
  if (fitSolutionToStage(item)) ctx.log(`${item.label}: 범위 밖 STEP으로 쓴 정답 계산을 마지막 STEP에 합침`);
  harness.renderFrames(material, item);
  const code = item.verificationSpec
    ? await codeCheck(item.verificationSpec, { answer: item.problem.answer, choiceCount: item.problem.choices.length })
    : { status: 'fail', reasons: ['검산 프로그램이 없습니다.'] };
  // For an integrated final problem the solver also sees the original, to tell a real redesign from new numbers.
  const integratedFinal = item.stage.kind === 'twin' && mode === 'integrated';
  // A rewrite of the solution alone keeps the problem, so the solve (and its adjudication) is not repeated.
  const blind = keep?.blind || await blindSolve(ctx, item, material, rules, integratedFinal);
  const lean = Boolean(ctx.lean);
  const hard = [];
  const soft = [];
  const rewriteNotes = [];
  // Faults that make the problem unusable: the server's calculation fails, or the independent solver gets another
  // answer or finds it ambiguous, contradictory, short of a condition or giving away its conclusion.
  const invalid = [];
  let adjudication = keep?.adjudication || null;
  if (code.status === 'fail') invalid.push(...code.reasons.map((r) => '코드 검산: ' + r));
  // A verifier's intermediate reciprocal (1/92 for comparing atoms per gram) can cancel into a simple ratio.
  // Let the final reviewer judge the student's actual calculation, rather than repairing on the denominator alone.
  const handNotes = (code.warnings || []).filter((w) => /손으로 계산/.test(w)).map((w) => `손계산 수치 확인: ${w}. 검산 보조값일 수 있으므로, 약분·비교 후 학생이 실제로 다루는 값과 풀이가 어려운지 확인하고 어려운 경우에만 수치 수정을 요구합니다.`);
  soft.push(...(code.warnings || []).filter((w) => !/손으로 계산/.test(w)));
  const mismatch = !item.problem.choices.length ? ''
    : !blind.answer ? '독립 풀이가 정답을 고르지 못했습니다: ' + blind.solution.slice(0, 300)
    : blind.answer !== item.problem.answer ? `독립 풀이의 정답은 ${blind.answer}번(${blind.answerValue})인데 표시된 정답은 ${item.problem.answer}번입니다. 독립 풀이 요약: ${blind.solution.slice(0, 600)}`
    : '';
  const blocking = blind.issues.filter((i) => BLOCKING_ISSUES.has(i.type)).map((i) => `독립 풀이 지적(${i.type}): ${i.detail}`);
  if (lean && (mismatch || blocking.length) && code.status !== 'fail') {
    adjudication = adjudication || await adjudicate(ctx, item, blind, [mismatch, ...blocking].filter(Boolean));
    if (adjudication.problemAtFault) invalid.push(...[mismatch, ...blocking].filter(Boolean), `출제자 재확인: ${adjudication.reason}`);
    else soft.push(`독립 풀이와 결과가 달랐지만 출제자가 재확인함: ${adjudication.reason}`);
  } else {
    if (mismatch) invalid.push(mismatch);
    invalid.push(...blocking);
  }
  hard.push(...invalid);
  if (!lean) for (const issue of blind.issues.filter((i) => !BLOCKING_ISSUES.has(i.type))) soft.push(`독립 풀이 지적(${issue.type}): ${issue.detail}`);
  const cov = coverage(item.stage, material.steps.length, blind.stepsUsed, blind.shortcuts);
  if (!lean) {
    // The final problem exists to need every STEP; one that skips a STEP goes to the teacher, not just a warning.
    if (!ctx.finalGate && item.stage.kind === 'twin' && cov.expected.some((n) => !cov.used.includes(n))) hard.push(...cov.notes.filter((n) => n.includes('없이')));
    soft.push(...cov.notes);
  }
  // Code checks carried over from v1's quality harness (teacher method, choices, O/X consistency, clue leak, format).
  // The table-shape check is a rough stand-in for the solver's reading of the five structure criteria: a final that keeps
  // the original's table but changes the reasoning (another reference experiment, a new quantity asked) is the
  // solver's call, or the two would send it back and forth.
  const codeChecks = harness.inspectItem(material, item, mode)
    .filter((c) => !(c.id === 'variant-shape' && blind.variation === 'structural'));
  const numbersOnly = blind.variation === 'numbers-only';
  const failed = codeChecks.filter((x) => x.state === 'fail');
  for (const c of failed) {
    if (c.severity === 'hint') continue; // a judgement call: weighed below with the solver's (judgement)
    if (solutionOnly(c) && c.severity !== 'hard') rewriteNotes.push(`${c.label}: ${c.evidence}`);
    else if (c.severity === 'hard') { hard.push(`${c.label}: ${c.evidence}`); invalid.push(`${c.label}: ${c.evidence}`); }
    else soft.push(`${c.label}: ${c.evidence}`);
  }
  // Teacher feedback: problems carried conditions nothing used, and the "integrated" final only changed numbers.
  // A problem rule the independent solver finds broken goes back for repair like any other design fault (in a lean
  // run it is only recorded).
  const ruleNotes = lean ? [] : rules.map((r) => [r, blind.rules.find((b) => b.id === r.id)]).filter(([, j]) => j && !j.ok).map(([r, j]) => `교사 지침 미준수: ${r.text.slice(0, 80)} — ${j.note}`);
  // What is a judgement against the criteria — a condition the solver did not use, numbers only, a rule it finds broken,
  // choices like an earlier problem's, a STEP reached another way — is weighed by the final review when it is on, as a
  // hint, instead of sending the problem to a repair of its own: the solver's "unused condition" took out a practice
  // problem's cylinder the final review then wanted back, round and round until the set's calls ran out
  // (chem-c38-gas-density, 2026-10-19: the final problem of Opus alone and two practice problems of Opus + Haiku never
  // reached the final review). What code settles (the answer, the check program, numbers reused) is repaired as before.
  const judgement = [
    ...(lean ? [] : blind.conditions.filter((c) => !c.used).map((c) => `풀이에 쓰이지 않는 조건: ${c.text}`)),
    ...(!lean && integratedFinal && numbersOnly ? [[`통합 변형인데 원본에서 숫자만 바뀌었습니다. ${blind.variationNote}`.trim(), harness.shapeOptions(material.problem.text, material.problem.figure)].filter(Boolean).join('\n')] : []),
    ...(item.stage.kind === 'twin' ? repeatsPrior(item, prior) : []),
    ...ruleNotes,
    ...failed.filter((c) => c.severity === 'hint').map((c) => `${c.label}: ${c.evidence}`),
  ];
  const gated = Boolean(ctx.finalGate);
  const designNotes = [
    ...(gated ? [] : judgement),
    ...numbersReused(item, prior, material),
    ...failed.filter((c) => c.severity === 'design' && !solutionOnly(c)).map((c) => `${c.label}: ${c.evidence}`),
    ...(gated ? [] : handNotes),
  ];
  const hints = gated ? [...judgement, ...handNotes, ...(lean ? [] : cov.notes.map((n) => 'STEP 범위: ' + n))] : [];
  const coverageNotes = gated ? [] : cov.notes;
  // The solution review only feeds a rewrite of the solution, which a repair or a fresh design makes moot: it runs when
  // the problem itself needs no repair (the version the teacher gets is reviewed in the end: addSolutionReview). 42% of the reviews of
  // eight Opus sets were thrown away that way (2026-10-09).
  const repairNeeded = hard.length || (!lean && coverageNotes.length) || designNotes.length;
  // With the final review on, it judges the solution against the teacher's too (review-criteria.md D): a second judge
  // went back and forth six times over one line of chem-c32-molar-volume's final (2026-10-19) — the inverse step to
  // the hidden volume "is not the teacher's", then without it "36L with no ground" — and the final review passed it.
  const solutionReview = repairNeeded || gated ? { skipped: true, steps: [], rules: [] } : await reviewSolution(ctx, item, material, rules);
  rewriteNotes.push(...reviewNotes(solutionReview, rules, blind));
  soft.push(...designNotes, ...hints);
  const ruleResults = rules.map((r) => {
    const self = item.appliedRules.find((a) => a.id === r.id);
    // Problem rules are judged by the independent solver, solution rules by the solution reviewer.
    const byReviewer = solutionReview.rules.find((b) => b.id === r.id);
    const judged = blind.rules.find((b) => b.id === r.id) || byReviewer;
    return { id: r.id, text: r.text, target: r.target, how: self?.how || '', judged: judged ? { ok: judged.ok, note: judged.note } : null };
  });
  return {
    hard, invalid, soft, coverageNotes, designNotes, rewriteNotes, hints,
    verification: {
      ...(adjudication ? { adjudication } : {}),
      code: { status: code.status, reasons: code.reasons || [], warnings: code.warnings || [], mode: code.mode, values: code.trials?.[0]?.values || [], checks: code.trials?.[0]?.checks || [] },
      blind,
      solutionReview,
      coverage: cov,
      harness: codeChecks,
      rules: ruleResults,
    },
  };
}

/** The design faults the server finds by itself, without the independent solve (the same ones verifyItem reports). */
async function codeFaults(item, material, mode, prior, ctx) {
  const code = item.verificationSpec
    ? await codeCheck(item.verificationSpec, { answer: item.problem.answer, choiceCount: item.problem.choices.length })
    : { status: 'fail', reasons: ['검산 프로그램이 없습니다.'] };
  // Solution wording is the writer's. The table-shape check counts here although verifyItem lets the solver's
  // structure verdict overrule it: a final in the original's table came back numbers-only from Opus and Haiku alike
  // (molar-mass, 2026-10-09/10), and the cheap designer changing the table costs less than one Opus solve.
  const failed = harness.inspectItem(material, item, mode)
    .filter((c) => c.state === 'fail' && !(solutionOnly(c) && c.severity !== 'hard'));
  return [
    ...(code.status === 'fail' ? code.reasons.map((r) => '코드 검산: ' + r) : []),
    ...failed.filter((c) => c.severity === 'hard').map((c) => `${c.label}: ${c.evidence}`),
    ...[
      ...(item.stage.kind === 'twin' ? repeatsPrior(item, prior) : []),
      ...numbersReused(item, prior, material),
      ...failed.filter((c) => c.severity === 'design').map((c) => `${c.label}: ${c.evidence}`),
      ...(ctx?.finalGate ? [] : (code.warnings || []).filter((w) => /손으로 계산/.test(w)).map((w) => `손계산 수치: ${w}. 수치를 손으로 계산하기 쉽게 다시 잡아야 합니다.`)),
    ].map((n) => '문제 설계: ' + n),
  ];
}

// A summary line the teacher never writes ('결론: …', '정리하면 …') is cut by code: Haiku 5.5 closed its STEPs with
// one and the solution judges marked the set down for it (molar-mass 2026-10-09; nerve conduction 2026-10-10, written
// by Opus from Haiku's outline), and a lesson against it did not stop it.
const SUMMARY_LINE = /^\s*[-•*·]?\s*(\**결론\**\s*[:：]|정리하면)/;
function stripSummaries(solution, material) {
  const has = (work) => String(work || '').split('\n').some((l) => SUMMARY_LINE.test(l));
  if (!solution?.steps || (material.steps || []).some((s) => has(s.work))) return solution;
  return { ...solution, steps: solution.steps.map((st) => (has(st.work) ? { ...st, work: st.work.split('\n').filter((l) => !SUMMARY_LINE.test(l)).join('\n').trim() } : st)) };
}

// The fields one version of a problem consists of: kept per design so the best one can be put back.
const VERSION_KEYS = ['problem', 'solution', 'outline', 'usesSteps', 'designNote', 'appliedRules', 'verificationSpec'];
const versionOf = (item) => Object.fromEntries(VERSION_KEYS.filter((k) => item[k] !== undefined).map((k) => [k, item[k]]));
// A design with fewer faults that make it unusable wins; then fewer design faults; then fewer solution notes.
const faultScore = (r) => r.check.invalid.length * 1000 + r.reasons.length * 10 + r.check.rewriteNotes.length;

/** The rule notes another designer (designWith) left out, asked of it again for those rules only. */
// Qwen 3.6 copies a 16-hex rule id with slips ("4a0e3ad608b501178c" for "4a0e3ad6…"), and an exact match threw its
// notes away (8 of 13 kept, 2026-10-13 run 13): an id is taken by its first 8 characters when that names one rule.
function ruleIdOf(id, rules) {
  const exact = rules.find((r) => r.id === id);
  if (exact) return exact.id;
  const near = rules.filter((r) => String(id).slice(0, 8) === r.id.slice(0, 8));
  return near.length === 1 ? near[0].id : null;
}

/** The rule notes another designer (designWith) left out, asked of it again for those rules only (twice at most). */
async function fillRuleNotes(ctx, item, rules) {
  if (!ctx.routes?.['repair-notes'] || !item.problem) return;
  item.appliedRules = item.appliedRules.map((a) => ({ ...a, id: ruleIdOf(a.id, rules) || a.id }));
  for (let round = 0; round < 2; round++) {
    const missing = rules.filter((r) => !item.appliedRules.some((a) => a.id === r.id && a.how));
    if (!missing.length) return;
    try {
      const { data } = await ctx.llm.json({
        purpose: 'repair-notes', jobId: ctx.job.id, budget: ctx.budget, signal: ctx.signal, effort: ctx.effort.generate, maxTokens: 12000,
        system: prompts.RULE_NOTES_SYSTEM, ...prompts.ruleNotesParts({ item, rules: missing }),
      });
      const back = (Array.isArray(data?.appliedRules) ? data.appliedRules : [])
        .map((r) => ({ id: ruleIdOf(String(r?.id || '').slice(0, 40), missing), how: String(r?.how || '').slice(0, 2000) }))
        .filter((r) => r.id && r.how);
      item.appliedRules = [...item.appliedRules.filter((a) => !back.some((b) => b.id === a.id)), ...back];
      ctx.log(`${item.label}: 빠진 지침 설명 ${back.length}/${missing.length}건 채움`);
    } catch (e) {
      if (e.name !== 'LlmFormatError') throw e;
    }
  }
}

// An attempt that found faults keeps the problem as it was then, so the record of faults (server/faults.js) can show the
// next writer what the fault looked like and, once the problem passed, what it became.
const faulted = (kind, design, failures, item) => ({ kind, design, at: new Date().toISOString(), failures, ...(item.problem?.text ? { problem: String(item.problem.text) } : {}) });

/** One design of a problem: generated, checked, repaired (problem) and rewritten (solution) until it passes or stops
 *  getting better. Mutates `item`; returns its version, the last check and what is still wrong. */
async function designOnce(ctx, { material, item, prior, rules, mode, extraFeedback, previous, examples, design }) {
  const total = material.steps.length;
  const lean = Boolean(ctx.lean);
  item.status = 'generating'; item.error = ''; ctx.save();
  ctx.log(`${item.label}: 문제 설계 중${design > 1 ? ` (${design}번째 설계)` : ''}`);
  const shapeHint = item.stage.kind === 'twin' && mode === 'integrated' ? harness.shapeOptions(material.problem.text) : '';
  let lostAnswer = false;
  let unusable = '';
  for (let tries = 0; ; tries++) {
    // A designer that returns no problem gets one more design told that giving up is not an answer.
    const feedback = lostAnswer ? extraFeedback : tries ? [extraFeedback, unusable ? `지난 설계는 쓸 수 없었습니다 (${unusable}). 문제 본문, 정답 번호, 해설 STEP(번호는 하나씩 한 번만)을 모두 갖춘 설계를 낸다.` : '지난 설계는 문제 없이 "만들지 못함"으로 끝났습니다. 설계를 중단하지 말고 반드시 완성된 문제를 내야 합니다.'].filter(Boolean).join('\n') : extraFeedback;
    const designPrompt = prompts.generateParts({ material, stage: item.stage, total, mode, prior, rules, variantNo: item.variantNo, extraFeedback: feedback, previous, examples, usedRows: usedRowsFor(item, prior, material, examples), direction: ctx.direction, shapeHint, priorFaults: ctx.priorFaults || [] });
    let data, generateShape = [];
    try {
      ({ data, shapeFixes: generateShape = [] } = await ctx.llm.json({
        purpose: 'generate', jobId: ctx.job.id, budget: ctx.budget, signal: ctx.signal, effort: ctx.effort.generate, maxTokens: 64000,
        system: prompts.GENERATE_SYSTEM, context: designPrompt.context, text: designPrompt.text + (lean ? prompts.LEAN_DESIGN : ''),
      }));
    } catch (e) {
      // An answer cut off or stopped in a loop loses this design, not the problem: Qwen 3.6's final failed whole on
      // one cut answer and one looped thinking (2026-10-12, run 4). Designed again, at most twice.
      if (e.name !== 'LlmFormatError' || tries >= 2) throw e;
      ctx.log(`${item.label}: 설계 응답을 읽지 못해 다시 설계합니다 (${e.message})`);
      item.attempts.push({ kind: 'lost-design', design, at: new Date().toISOString(), failures: [e.message] });
      lostAnswer = true;
      continue;
    }
    lostAnswer = false;
    if (generateShape.length) ctx.log(`${item.label}: 응답 JSON 구조 보정 (${generateShape.join(', ')})`);
    try {
      Object.assign(item, normalizeGenerated(data));
      break;
    } catch (e) {
      // A design without its answer number or with a STEP number twice failed the problem outright; it is designed
      // again like one without a problem, at most twice (2026-10-27 review).
      if (e.status !== 422 || tries >= 2) throw e;
      ctx.log(`${item.label}: 설계를 쓸 수 없어 다시 설계합니다 (${e.message})`);
      unusable = e.message;
    }
  }
  item.attempts.push({ kind: 'generate', design, at: new Date().toISOString() });
  await fillRuleNotes(ctx, item, rules);
  // Lean run: what the designer wrote is the outline; the job's own model writes it out as the solution.
  let writeNotes = [];
  const writeOut = async (fixes = []) => writeSolution(ctx, item, material, rules, fixes);
  if (lean) { item.outline = item.solution; writeNotes = await writeOut(); }
  let rewrites = 0;
  // One repair by the designer: the problem, its solution and check program fixed for `failures`.
  const repairWith = async (failures, blind) => {
    const purpose = lean ? 'repair-lean' : 'repair';
    ctx.log(`${item.label}: 검토에서 발견된 ${failures.length}건 수정 중${ctx.routes?.[purpose] ? ` (${ctx.routes[purpose]})` : ''}`);
    let fixed, repairShape = [];
    try {
      ({ data: fixed, shapeFixes: repairShape = [] } = await ctx.llm.json({
        purpose, jobId: ctx.job.id, budget: ctx.budget, signal: ctx.signal, effort: ctx.effort.generate, maxTokens: 64000,
        system: prompts.REPAIR_SYSTEM,
        // A lean repair sees the designer's own outline (not the long written solution) and returns only what changed.
        ...(({ context, text }) => ({ context, text: text + (lean ? prompts.LEAN_REPAIR : '') }))(prompts.repairParts({ material, stage: item.stage, total, mode, rules, item: lean ? { ...item, solution: item.outline } : item, failures, blind, lean })),
      }));
    } catch (e) {
      // A repair the reader cannot use (a missing field, broken JSON) loses this repair, not the problem: the version
      // before it stays (Qwen 3.6's final, 2026-10-12: one answer without its check program failed the whole problem).
      if (e.name !== 'LlmFormatError') throw e;
      ctx.log(`${item.label}: 수정 응답을 읽지 못해 직전 버전을 유지합니다 (${e.message})`);
      item.attempts.push({ kind: 'lost-repair', design, at: new Date().toISOString(), failures: [e.message] });
      return;
    }
    if (repairShape.length) ctx.log(`${item.label}: 응답 JSON 구조 보정 (${repairShape.join(', ')})`);
    // A repair returns only the appliedRules notes that changed; the others stay as they were.
    const rulesAfter = (back) => [...item.appliedRules.map((r) => back.find((b) => b.id === r.id) || r), ...back.filter((b) => !item.appliedRules.some((r) => r.id === b.id))];
    try {
      if (lean) {
        const kept = { problem: item.problem, solution: item.outline, usesSteps: item.usesSteps, designNote: item.designNote, appliedRules: item.appliedRules, verification: item.verificationSpec };
        const changed = Object.fromEntries(Object.entries(fixed || {}).filter(([k, v]) => k in kept && v != null && v !== ''));
        const next = normalizeGenerated({ ...kept, ...changed });
        next.appliedRules = rulesAfter(changed.appliedRules ? next.appliedRules : []);
        Object.assign(item, next);
        item.outline = item.solution;
        writeNotes = await writeOut();
        rewrites = 0;
      } else {
        // Local models often return only the fixed problem; what they leave out stays from the previous version instead
        // of being wiped — the solution and the check program too: a repair of the problem alone emptied the solution,
        // and the next solve and review went without one (2026-10-27 review).
        const left = ['problem', 'solution', 'verification'].filter((k) => fixed?.[k] == null || fixed[k] === '');
        if (left.length) ctx.log(`${item.label}: 수정 응답에 ${left.join(', ')}가 없어 직전 것을 유지합니다`);
        const next = normalizeGenerated({ ...fixed, problem: left.includes('problem') ? item.problem : fixed.problem, solution: left.includes('solution') ? item.solution : fixed.solution, verification: left.includes('verification') ? item.verificationSpec : fixed.verification });
        for (const key of ['designNote', 'usesSteps']) if (!next[key]?.length && item[key]?.length) next[key] = item[key];
        next.appliedRules = rulesAfter(next.appliedRules);
        Object.assign(item, next);
        rewrites = 0;
      }
    } catch (e) {
      // A repair the reader cannot use (no answer number, a STEP number twice, no problem text) loses this repair, not
      // the problem: it failed the problem whole, past the best design kept so far (2026-10-27 review).
      if (e.status !== 422) throw e;
      ctx.log(`${item.label}: 수정 응답을 쓸 수 없어 직전 버전을 유지합니다 (${e.message})`);
      item.attempts.push({ kind: 'lost-repair', design, at: new Date().toISOString(), failures: [e.message] });
      return;
    }
    await fillRuleNotes(ctx, item, rules);
  };
  item.status = 'verifying'; ctx.save();

  // A cheaper designer (claude.designModel) is checked by code before the independent solve: what the server can see
  // itself (the check program, the leftover-row shortcut, reused rows, letters no answer uses) goes back to the designer
  // first, so the expensive judge sees only designs that pass the code. Haiku 5.5 alone (2026-10-08) failed the same
  // code check three designs in a row, each one also solved and reviewed by the judge.
  // The same after every repair: a repair that fixes the judge's findings can bring a new code fault (2026-10-09).
  const precheck = async () => {
    if (!lean) item.solution = stripSummaries(item.solution, material);
    for (let pre = 0; ctx.precheck && pre < 2 && !ctx.signal?.aborted; pre++) {
      const faults = await codeFaults(item, material, mode, prior, ctx);
      if (!faults.length) break;
      item.attempts.push(faulted('precheck', design, faults, item));
      ctx.log(`${item.label}: 코드 검사에서 ${faults.length}건 — 독립 풀이 전에 설계자가 고침`);
      await repairWith(faults, null);
      // Laid out before the next check reads it: unrendered, the designer's own [틀 n-k] lines were a hard fault of the
      // second check and went back to it as one (2026-10-27 review).
      await polish();
    }
  };
  // The solution's layout is the system's: the writer gives each sentence as a teacher frame and its values, the server
  // writes the sentence, the titles and the choice heading (harness.renderFrames). The writer is asked again only for
  // what it left out (a frame's value) — never to reword (the user, 2026-10-13: format is not the model's job; Qwen
  // 3.8 spent round 6 rewording lines to fit frames).
  const polish = async () => {
    if (lean || !material.frames?.length) return;
    let missing = harness.renderFrames(material, item);
    // The designer fills what it left out (the PC model in a mixed run, the job's own model otherwise).
    for (let i = 0; i < 2 && missing.length && !ctx.signal?.aborted; i++) {
      item.attempts.push({ kind: 'fill', design, at: new Date().toISOString(), failures: missing });
      item.outline = item.solution;
      await writeSolution(ctx, item, material, rules, missing, 'polish-solution');
      missing = harness.renderFrames(material, item);
    }
  };
  await polish();
  await precheck();

  let check = await verifyItem(ctx, item, material, rules, mode, prior);
  // In a lean run the solver's STEP tagging does not send the problem back (see verifyItem).
  const repairReasons = (c) => [...c.hard, ...(lean ? [] : c.coverageNotes.map((n) => 'STEP 범위: ' + n)), ...c.designNotes.map((n) => '문제 설계: ' + n), ...(c.gate?.faults || []).map((n) => '최종 검수: ' + n)];
  // Up to ctx.maxRepairs repairs, a further one only when the previous one changed what is wrong (the same complaints
  // twice means the model is stuck: a fresh design does better). The solution alone is rewritten up to twice.
  const same = (x, y) => x.length === y.length && x.every((v, i) => v === y[i]);
  // Stuck is the same kinds of fault again: a reviewer words one fault differently every round ("[STEP 제목 · low] …"),
  // so compared word for word the gas original's final never counted as stuck and spent 13 repairs (2026-10-21).
  const kinds = (reasons) => [...new Set(reasons.map((r) => r.replace(/^(최종 검수: \[[^\]·]+).*$/s, '$1').replace(/^(최종 검수: )[^[].*$/s, '$1답').slice(0, 200)))].sort();
  let lastRepair = null;
  for (let round = 0; ;) {
    if (ctx.signal?.aborted) break;
    // A fault only in the solution (wording, the teacher's sentence frame, a solution rule) is rewritten by the writer
    // — no redesign, no new solve. Outside a lean run the current solution is what gets rewritten.
    if (check.rewriteNotes.length && !repairReasons(check).length && rewrites < (ctx.maxRewrites ?? 2) && (!ctx.budget.affords || ctx.budget.affords(2 + (ctx.reserveCalls || 0)))) {
      rewrites++;
      item.attempts.push(faulted('rewrite', design, check.rewriteNotes, item));
      if (!lean) item.outline = item.solution;
      // The judge's notes are rewritten by the designer in a mixed run (free), then held to the frames again.
      writeNotes = await writeSolution(ctx, item, material, rules, check.rewriteNotes, ctx.routes?.['polish-solution'] && !lean ? 'polish-solution' : 'write-solution');
      await polish();
      const before = check.rewriteNotes;
      check = await verifyItem(ctx, item, material, rules, mode, prior, { blind: check.verification.blind, adjudication: check.verification.adjudication });
      if (same(before, check.rewriteNotes)) rewrites = Infinity; // the same notes again: rewriting more will not help
      continue;
    }
    // What the checks above find is fixed first; a problem they pass gets the final review, and what that finds is
    // repaired in the same loop (and, past the repairs, by a fresh design).
    if (ctx.finalGate && !repairReasons(check).length && !check.gate) check.gate = await finalGate(ctx, item, material, prior, check.hints);
    // What the final review finds only in the solution is rewritten by the writer, the problem and its solve kept.
    if (check.gate?.solutionOnly && rewrites < (ctx.maxRewrites ?? 2) && (!ctx.budget.affords || ctx.budget.affords(3 + (ctx.reserveCalls || 0)))) {
      rewrites++;
      const notes = check.gate.faults.map((n) => '최종 검수: ' + n);
      item.attempts.push(faulted('rewrite', design, notes, item));
      if (!lean) item.outline = item.solution;
      writeNotes = await writeSolution(ctx, item, material, rules, notes, ctx.routes?.['polish-solution'] && !lean ? 'polish-solution' : 'write-solution');
      await polish();
      check = await verifyItem(ctx, item, material, rules, mode, prior, { blind: check.verification.blind, adjudication: check.verification.adjudication });
      continue;
    }
    if (!repairReasons(check).length || round >= ctx.maxRepairs) break;
    if (lastRepair && same(kinds(repairReasons(check)), kinds(lastRepair))) break;
    // A repair costs a repair and a new solve; skip it when that would leave too little for the later problems.
    if (ctx.budget.affords && !ctx.budget.affords(3 + (ctx.reserveCalls || 0))) {
      const byCalls = ctx.budget.calls + 3 + (ctx.reserveCalls || 0) > ctx.budget.maxCalls;
      ctx.log(`${item.label}: 남은 문제를 만들 ${byCalls ? '호출' : '토큰'}을 남기려고 수정을 건너뜁니다`);
      check.soft.push(byCalls ? '세트당 AI 호출 상한 때문에 자동 수정을 더 하지 못했습니다 (LLM › 하네스에서 늘릴 수 있습니다).' : '세트 토큰 상한 때문에 자동 수정을 더 하지 못했습니다.');
      break;
    }
    round++;
    lastRepair = repairReasons(check);
    item.attempts.push(faulted('repair', design, lastRepair, item));
    item.status = 'repairing'; item.verification = check.verification; ctx.save();
    await repairWith(lastRepair, check.verification.blind);
    await polish();
    await precheck();
    item.status = 'verifying'; ctx.save();
    check = await verifyItem(ctx, item, material, rules, mode, prior);
  }
  await addSolutionReview(ctx, item, material, rules, check);
  return { version: versionOf(item), check, writeNotes, reasons: repairReasons(check), design };
}

/** Makes one problem without stopping for the teacher: up to ctx.maxDesigns designs (each repaired and rewritten), the
 *  best one kept. What was found and fixed along the way is in item.attempts (the report); what is still left is in
 *  item.problems (the answer cannot be trusted) or item.warnings (the problem is usable). Mutates `item`. */
async function produceItem(ctx, { material, item, prior, rules, mode, extraFeedback, previous, examples: allExamples = [], priorFaults = [] }) {
  // A remake/check job has a different job object; its writer and final reviewers still use the same rule snapshot.
  // What earlier sets were faulted for (faults.forItem) goes to this problem's writer and its final review alike.
  ctx = { ...ctx, generationRules: rules, priorFaults };
  const examples = examplesFor(item, allExamples);
  item.examplesUsed = examples.length;
  item.attempts = [];
  item.reviewRounds = [];
  item.redesigned = 0;
  let best = null;
  let left = previous;
  for (let design = 1; design <= (ctx.maxDesigns ?? 3); design++) {
    if (design > 1) {
      if (ctx.signal?.aborted) break;
      // A fresh design costs a design, a solve and a review at least; the later problems keep theirs.
      if (ctx.budget.affords && !ctx.budget.affords(6 + (ctx.reserveCalls || 0))) {
        ctx.log(`${item.label}: 남은 문제를 만들 토큰을 남기려고 새 설계를 하지 않습니다`);
        break;
      }
      if (best) {
        ctx.log(`${item.label}: 고쳐도 ${best.reasons.length}건이 남아 새로 설계합니다`);
        item.attempts.push(faulted('redesign', design, left.problems, item));
      }
      item.redesigned = design - 1;
    }
    let result;
    try {
      result = await designOnce(ctx, { material, item, prior, rules, mode, extraFeedback, previous: left, examples, design });
    } catch (e) {
      // A designer that runs past its output cap (Haiku 5.5 wrote 64k tokens into one nerve final, 2026-10-11) loses
      // this design, not the problem: the best design so far stays, or a fresh one is made.
      if (!/output token maximum/.test(e.message)) throw e;
      ctx.log(`${item.label}: 설계 응답이 출력 한도를 넘어 이 설계를 버립니다`);
      item.attempts.push({ kind: 'overflow', design, at: new Date().toISOString(), failures: ['설계 응답이 출력 한도를 넘음'] });
      if (best) Object.assign(item, best.version);
      continue;
    }
    if (!best || faultScore(result) < faultScore(best)) best = result;
    if (!result.reasons.length) break;
    left = { problem: item.problem, solution: item.solution, problems: result.reasons };
  }
  if (!best) throw new Error('모든 설계 응답이 출력 한도를 넘었습니다.');
  // The best design is the one kept.
  Object.assign(item, best.version);
  const check = best.check;
  item.verification = check.verification;
  item.design = best.design;
  // Only a problem whose answer cannot be trusted is held back for the teacher; anything else the checks could not fix
  // is listed with the problem as 남은 점.
  // A problem the final review still finds fault with is not made: it goes to the teacher with what is left.
  const gate = check.gate || null;
  item.finalReview = ctx.finalGate ? {
    passed: Boolean(gate && !gate.skipped && !gate.faults.length), faults: gate?.faults || [],
    skipped: gate?.skipped || (gate ? '' : '앞의 검토에서 고칠 점이 남아 최종 검수까지 가지 못했습니다.'), review: gate?.review || null,
    // The 모델 비교 checklist's rows, filled from this review (server/final-review.js).
    checklist: finalReview.checklistOf(gate?.review, { final: item.stage?.kind === 'twin' }),
  } : null;
  item.problems = [...new Set([...check.invalid, ...(gate?.faults || []).map((f) => '최종 검수: ' + f)])];
  item.warnings = [...new Set([
    ...best.reasons.filter((r) => !check.invalid.some((x) => r.endsWith(x)) && !r.startsWith('최종 검수: ')),
    ...check.soft.filter((w) => !check.coverageNotes.includes(w) && !check.designNotes.includes(w) && !check.invalid.includes(w)),
    ...check.rewriteNotes.map((n) => '해설: ' + n), ...best.writeNotes,
    ...(gate?.notes || []).map((n) => '최종 검수 참고: ' + n),
  ])];
  // With the final review on, made means it passed: a problem that never reached it (other faults left) is not made
  // either, and what the earlier checks noted but the final review does not count as a fault stays as a note.
  const unreviewed = ctx.finalGate && !item.finalReview.passed;
  if (unreviewed && !item.problems.length) item.problems = [`최종 검수: ${item.finalReview.skipped || '통과하지 못함'}`, ...item.warnings];
  item.status = item.problems.length ? 'needs_review' : item.warnings.length && !ctx.finalGate ? 'warning' : 'passed';
  const fixes = item.attempts.filter((x) => x.kind !== 'generate').length;
  ctx.log(`${item.label}: ${{ passed: '완성', warning: `완성 (남은 점 ${item.warnings.length}개)`, needs_review: ctx.finalGate ? '최종 검수를 통과하지 못해 미완료' : '정답을 확정하지 못함' }[item.status]}${fixes ? ` — 자동 수정 ${fixes}번${item.redesigned ? `, 새 설계 ${item.redesigned}번` : ''}` : ''}`);
  ctx.save();
}

// Low notes of the final review: notation, a title, wording. The system lays these out (harness.notation, stepTitle),
// so they are never learned: the gas original's 학습 반복 (2026-10-21) learned "write X₂ in the title as $\ce{X2}$ with
// its full stop" set after set, a lesson no writer could keep (the system wrote that title), and fell from 89 to 61.
const LOW_NOTE = /· low\]/;

// After a set: what its checks found becomes at most three learning items (this problem's or every problem's), so the
// next set avoids it from the start. Recorded on the job for its report. A failure here never fails the set.
async function learnFromSet(ctx) {
  const { job, store } = ctx;
  const faults = [];
  // With the final review on, it alone judges: a set learns what that review found and what code settled on the way
  // (a wrong answer, numbers reused), not the solution review's rewrites or what the review let stand. On
  // chem-c32-molar-volume (2026-10-19) the solution review went back and forth six times over the final's ㄷ (the
  // inverse step to the hidden volume "is not the teacher's", then "36L with no ground"), the final review passed the
  // problem, and the set learned "never hide that volume" from the back-and-forth — the lesson Claude and Gemini then
  // held the passed problem to.
  const gated = job.items.some((it) => it.finalReview);
  for (const item of job.items) {
    const seen = new Set();
    const left = new Set(gated ? (item.finalReview?.faults || []).map((f) => '최종 검수: ' + f) : [...(item.problems || []), ...(item.warnings || [])]);
    for (const a of item.attempts || []) for (const f of a.failures || []) {
      if (gated && !['repair', 'redesign'].includes(a.kind) && !String(f).startsWith('최종 검수: ')) continue;
      const text = String(f).replace(/^(문제 설계|STEP 범위|해설|최종 검수): /, '');
      // A low note (a title, notation, wording) is the system's to write, not a lesson (LOW_NOTE).
      if (seen.has(text) || LOW_NOTE.test(text)) continue;
      seen.add(text);
      faults.push({ label: item.label, text: text.slice(0, 2000), left: [...left].some((x) => x.includes(text.slice(0, 60))) });
    }
  }
  if (!faults.length || !store) return;
  if (ctx.budget.affords && !ctx.budget.affords(1)) return;
  const material = job.material;
  const existing = selectRules(store.rules.all(), { ...material, id: job.materialId }).map((r) => r.text);
  ctx.log('세트에서 나온 실수로 학습 정리 중');
  let data;
  try {
    ({ data } = await ctx.llm.json({
      purpose: 'learn', jobId: job.id, budget: ctx.budget, signal: ctx.signal, effort: ctx.effort.solve, maxTokens: 6000,
      system: prompts.LEARN_SYSTEM, text: prompts.learnText({ material, faults: faults.slice(0, 40), existing }),
    }));
  } catch (e) {
    if (e.name === 'BudgetExceeded' || ctx.signal?.aborted) return;
    ctx.log(`학습 정리 실패 — ${e.message}`);
    return;
  }
  const learned = [];
  // The kinds of fault this set's lessons come from: what wakes a lesson the data put to sleep (faults.wakeLessons).
  const faultKeys = faultsData.keysOf(faults.map((f) => f.text));
  for (const x of arr(data?.items).slice(0, 3)) {
    const text = str(x?.text, 2000);
    if (text.length < 8 || existing.includes(text)) continue;
    const change = await keepLesson(ctx, store, draftLesson(x, text, material, { materialId: job.materialId, jobId: job.id, label: job.title, from: 'auto', faultKeys }), { why: str(x?.why, 1000), jobId: job.id, by: 'auto' });
    if (change) learned.push(change);
  }
  job.learned = learned;
  ctx.log(learned.length ? `학습 ${learned.length}곳을 고쳤습니다 (${summary(learned)})` : '새로 추가할 학습은 없습니다');
  ctx.save();
}

const summary = (changed) => `더함 ${changed.filter((c) => c.kind === 'add').length} · 고침 ${changed.filter((c) => c.kind === 'revise').length} · 뺌 ${changed.filter((c) => c.kind === 'remove').length}`;

/**
 * A lesson as the learner proposed it, as an item. A common lesson is tagged with this original's subject and topic
 * unless the learner says it holds for every subject: untagged, it reached every subject, and the learner called most
 * chemistry lessons subject-free — 28 of them went into a 생명과학 set on 2026-10-22.
 */
function draftLesson(x, text, material, source) {
  const common = x?.scope === 'common';
  return makeRule({
    text, why: str(x?.why, 1000), example: x?.example && typeof x.example === 'object' ? { before: str(x.example.before, 1000), after: str(x.example.after, 1000) } : undefined,
    stage: 'generation', target: ['problem', 'solution', 'all'].includes(x?.target) ? x.target : 'all',
    category: CATEGORIES.includes(x?.category) ? x.category : undefined,
    scope: common ? 'global' : 'material', layer: 'lesson',
    subject: common && x?.allSubjects === true ? '' : material.subject || '',
    topic: common && x?.allSubjects === true ? '' : material.topic || '',
    source,
  });
}

/**
 * Keeps a proposed lesson: not at all when it is about notation or titles (the system lays those out); folded into an
 * item that already says the same (the AI compares it with the items whose wording overlaps, as 학습 › 정리 후보 does);
 * otherwise stored as new. Seven lessons saying "hidden values differ from the original's" piled up on 2026-10-21/22
 * because only an identical sentence counted as already there. Returns what changed, for the set's record.
 */
/** How much of what `before` said `after` still says: the share of before's letter pairs in after. */
function keeps(before, after) {
  const a = grams(before), b = grams(after);
  if (!a.size) return 1;
  let n = 0;
  for (const g of a) if (b.has(g)) n++;
  return n / a.size;
}

async function keepLesson(ctx, store, draft, { why, jobId, by }) {
  if (isFormatLesson(draft.text)) { ctx.log(`형식에 관한 학습은 두지 않습니다: ${draft.text.slice(0, 60)}…`); return null; }
  const reach = (r) => r.status === 'approved' && stageOf(r) === 'generation' && (r.scope === 'material' ? draft.scope === 'material' && r.source?.materialId === draft.source?.materialId : (r.subject || '') === (draft.subject || '') || !r.subject);
  const mine = grams(draft.text);
  const near = store.rules.all().filter(reach).map((r) => ({ r, s: overlap(grams(r.text), mine) })).filter((x) => x.s >= 0.3).sort((a, b) => b.s - a.s).slice(0, 2);
  const editable = (r) => layerOf(r) !== 'guide' && ['auto', 'review', 'eval'].includes(r.source?.from);
  for (const { r } of near) {
    if (ctx.budget.affords && !ctx.budget.affords(1)) break;
    let data;
    try {
      ({ data } = await ctx.llm.json({ purpose: 'merge', jobId, budget: ctx.budget, signal: ctx.signal, effort: 'low', maxTokens: 3000, system: prompts.MERGE_SYSTEM, text: prompts.mergeText({ a: r.text, b: draft.text }) }));
    } catch (e) {
      if (e.name === 'BudgetExceeded' || ctx.signal?.aborted) return null;
      break;
    }
    const merged = str(data?.text, 4000);
    if (data?.same !== true || merged.length < 8) continue;
    // The merged sentence must still say what the kept lesson said, and must not be a format lesson.
    if (isFormatLesson(merged) || keeps(r.text, merged) < 0.5) { ctx.log(`합친 문장이 원래 학습의 뜻을 잃어 합치지 않습니다: ${r.text.slice(0, 60)}…`); continue; }
    if (!editable(r)) { ctx.log(`이미 있는 학습과 같아 두지 않습니다: ${r.text.slice(0, 60)}…`); return null; }
    if (merged === r.text) return null;
    store.rules.put(updateRule(r, { text: merged }, new Date(), { why, jobId, by }));
    return { kind: 'revise', id: r.id, before: r.text, text: merged, why: `같은 뜻의 학습에 합침 — ${why}` };
  }
  store.rules.put(draft);
  return { kind: 'add', id: draft.id, text: draft.text, scope: draft.scope === 'global' ? 'common' : 'problem', target: draft.target, why };
}

/**
 * 학습 반복 (jobs.js 'train'): what Claude·Gemini found in a finished set (set-check.failing) changes the learning the
 * next set is made with — lessons the system learned itself are rewritten or dropped, new ones added; the teacher's
 * own items are never touched. Returns what changed.
 */
async function learnFromReview(ctx, material, set, all) {
  const faults = all.filter((f) => !LOW_NOTE.test(f.text));
  if (!faults.length || !ctx.store) return [];
  const editable = (r) => layerOf(r) !== 'guide' && ['auto', 'review', 'eval'].includes(r.source?.from);
  const allRules = ctx.store.rules.all();
  const rules = selectRules(allRules, material).map((r) => ({ id: r.id, text: r.text, editable: editable(r) }));
  ctx.log('검수에서 걸린 점으로 학습을 고치는 중');
  const { data } = await ctx.llm.json({
    purpose: 'learn-review', jobId: ctx.job.id, budget: ctx.budget, signal: ctx.signal, effort: ctx.effort.solve, maxTokens: 8000,
    system: prompts.LEARN_REVIEW_SYSTEM, text: prompts.learnReviewText({ material, faults: faults.slice(0, 40), rules }),
  });
  const changed = [];
  // The id as the model returned it, matched against the lessons it was shown (a mangled id is simply not found; the
  // store itself refuses an id that is not a key, which failed the whole round).
  const shown = new Set(rules.map((r) => r.id));
  const own = (id) => { const key = str(id, 40); const r = key && shown.has(key) ? allRules.find((x) => x.id === key) : null; return r && editable(r) ? r : null; };
  const faultKeys = faultsData.keysOf(faults.map((f) => f.text));
  const revised = (ctx.job.revisedLessons = ctx.job.revisedLessons || []);
  for (const x of arr(data?.revise).slice(0, 5)) {
    const r = own(x?.id);
    const text = str(x?.text, 4000);
    if (!r || text.length < 8 || text === r.text) continue;
    if (isFormatLesson(text)) { ctx.log(`형식에 관한 학습은 두지 않습니다: ${text.slice(0, 60)}…`); continue; }
    // A rewrite that drops most of what the lesson said is another lesson, not this one made better (e7975d4c lost its
    // "쓰이지 않으면 수치로 준다" clause on 2026-10-26); and a lesson rewritten once in a 학습 반복 is not rewritten in
    // it again — a fault that stays after the rewrite is not the lesson's to fix (86fd6698, four rewrites that day).
    if (keeps(r.text, text) < 0.5) { ctx.log(`학습 고침을 두지 않습니다 (원래 지시의 절반 넘게 사라짐): ${r.text.slice(0, 50)}… → ${text.slice(0, 50)}…`); continue; }
    if (revised.includes(r.id)) { ctx.log(`이 반복에서 이미 고친 학습은 다시 고치지 않습니다: ${r.text.slice(0, 60)}…`); continue; }
    revised.push(r.id);
    const next = updateRule(r, { text, ...(str(x?.why, 1000) ? { why: str(x?.why, 1000) } : {}) }, new Date(), { why: str(x?.why, 1000), jobId: set.id, by: 'review' });
    // The fault kinds it was rewritten for join its record, so its effect (faults.lessonEffects) counts them.
    next.source = { ...(r.source || {}), faultKeys: [...new Set([...(r.source?.faultKeys || []), ...faultKeys])].slice(0, 40) };
    ctx.store.rules.put(next);
    changed.push({ kind: 'revise', id: r.id, before: r.text, text, why: str(x?.why, 1000) });
  }
  for (const x of arr(data?.remove).slice(0, 5)) {
    const r = own(x?.id);
    if (!r) continue;
    ctx.store.rules.remove(r.id);
    changed.push({ kind: 'remove', id: r.id, before: r.text, why: str(x?.why, 1000) });
  }
  const existing = new Set(rules.map((r) => r.text));
  for (const x of arr(data?.add).slice(0, 3)) {
    const text = str(x?.text, 4000);
    if (text.length < 8 || existing.has(text)) continue;
    const change = await keepLesson(ctx, ctx.store, draftLesson(x, text, material, { materialId: material.id, jobId: set.id, label: material.title, from: 'review', faultKeys }), { why: str(x?.why, 1000), jobId: set.id, by: 'review' });
    if (change) changed.push(change);
  }
  ctx.log(changed.length ? `학습 ${changed.length}곳을 고쳤습니다 (${summary(changed)})` : '고칠 학습이 없습니다');
  return changed;
}

/**
 * The teacher's sentence frames of an original, extracted once by the job's model and kept with the original (see
 * harness.validateFrames): only frames that match the teacher's own lines stay. A failure leaves the set without them.
 */
async function ensureFrames(ctx, material) {
  const key = analysisKey(material);
  if (material.framesKey === key && Array.isArray(material.frames) && !material.frames.length) return;
  if (material.framesKey && material.framesKey !== key) delete material.frames;
  // Validate legacy caches too: old single-entry frames may refer to a teacher's previous analysis.
  if (material.frames) {
    material.frames = harness.validateFrames(material, { steps: material.frames });
    if (!material.frames.length) delete material.frames;
    material.framesKey = key;
    const stored = ctx.store?.materials?.get(ctx.job.materialId);
    if (stored && analysisKey(stored) === key) ctx.store.materials.put({ ...stored, frames: material.frames, framesKey: key });
    ctx.save();
  }
  if (material.frames || !material.steps?.length) return;
  ctx.log('선생님 해설의 문장 틀 뽑는 중');
  // A whole-solution answer that cannot be read (Qwen 3.8 looped and stopped twice, 2026-10-14) leaves the STEP-by-STEP
  // requests below to do the work.
  let whole = true;
  try {
    let data = null;
    try {
      ({ data } = await ctx.llm.json({
        purpose: 'extract-frames', jobId: ctx.job.id, budget: ctx.budget, signal: ctx.signal, effort: 'low', maxTokens: 16000,
        system: prompts.EXTRACT_FRAMES_SYSTEM, text: prompts.extractFramesText(material),
      }));
    } catch (e) {
      if (e.name !== 'LlmFormatError') throw e;
      whole = false;
    }
    material.frames = harness.validateFrames(material, data);
    // Lines left without a frame (5 of 15 in round 10) are asked for once more, by name.
    const uncovered = harness.uncoveredLines(material);
    if (uncovered.length && material.frames.length) {
      const { data: more } = await ctx.llm.json({
        purpose: 'extract-frames', jobId: ctx.job.id, budget: ctx.budget, signal: ctx.signal, effort: 'low', maxTokens: 8000,
        system: prompts.EXTRACT_FRAMES_SYSTEM,
        text: prompts.extractFramesText(material) + `\n\n아래 줄은 아직 맞는 틀이 없다. 이 줄들의 틀만 반환한다 (줄의 글자와 한 글자도 다르지 않게, 값만 자리로):\n${uncovered.map((u) => `STEP ${u.step}: ${u.line}`).join('\n')}`,
      });
      const added = harness.validateFrames(material, more);
      material.frames = harness.validateFrames(material, { steps: [...material.frames, ...added].map((f) => ({ step: f.step, frames: f.frames })) });
    }
    // A STEP still without frames is asked for alone: a smaller task (Qwen 3.8 framed only STEP 1 of three, 2026-10-13).
    for (const [i, s] of material.steps.entries()) {
      if ((whole && !material.frames.length) || material.frames.some((f) => f.step === i + 1) || ctx.signal?.aborted) continue;
      try {
        const { data: one } = await ctx.llm.json({
          purpose: 'extract-frames', jobId: ctx.job.id, budget: ctx.budget, signal: ctx.signal, effort: 'low', maxTokens: 8000,
          system: prompts.EXTRACT_FRAMES_SYSTEM,
          text: `[선생님 해설]\nSTEP ${i + 1}. ${s.title}\n${s.work}\n\n이 STEP ${i + 1}의 줄만 틀로 옮긴다 ("step": ${i + 1}). JSON만 반환하라.`,
        });
        const got = harness.validateFrames(material, { steps: (one?.steps || []).map((x) => ({ ...x, step: i + 1 })) });
        material.frames = [...material.frames, ...got].sort((a, b) => a.step - b.step);
      } catch (e) {
        if (e.name === 'BudgetExceeded' || ctx.signal?.aborted) throw e;
      }
    }
    const lines = material.frames.reduce((n, f) => n + f.lines, 0);
    const covered = material.frames.reduce((n, f) => n + f.covered, 0);
    ctx.log(`문장 틀 ${material.frames.reduce((n, f) => n + f.frames.length, 0)}개 — 선생님 해설 ${lines}줄 중 ${covered}줄과 맞음`);
    const stored = ctx.store?.materials?.get(ctx.job.materialId);
    material.framesKey = key;
    if (stored && analysisKey(stored) === key) ctx.store.materials.put({ ...stored, frames: material.frames, framesKey: key });
    ctx.save();
  } catch (e) {
    if (e.name === 'BudgetExceeded' || ctx.signal?.aborted) throw e;
    ctx.log(`문장 틀을 뽑지 못했습니다 (${e.message})`);
  }
}

async function runGeneration(ctx) {
  const { job, store } = ctx;
  const material = job.material;
  const rules = job.rules;
  // What the teacher adopted from earlier sets of this original (examples for the same stages).
  const examples = adoptedExamples(store, job.materialId, {});
  // What every earlier set (of this original and the others) was faulted for, with its reviews: the data each problem's
  // writer and reviewer get (faults.forItem), and what this set is measured against when it is done (faults.setStats).
  const history = faultsData.index(store.jobs.all(), { dataDir: store.dataDir, exclude: job.id });
  if (ctx.finalGate) {
    if (job.analysisReview?.key !== analysisKey(material) || !analysisPassed(job.analysisReview)) await reviewAnalysis(ctx, material);
    if (job.analysisReview?.key !== analysisKey(material) || !analysisPassed(job.analysisReview)) {
      throw new Error('원본 분석 검수를 통과하지 못했습니다. 분석 결과를 확인한 뒤 이어서 진행해 주세요.');
    }
  }
  await ensureFrames(ctx, material);
  for (const item of job.items) {
    if (ctx.signal.aborted) throw new Error('작업이 취소되었습니다.');
    if (['passed', 'warning', 'needs_review'].includes(item.status)) continue; // resume keeps finished work
    const prior = job.items.filter((x) => x.index < item.index && x.problem);
    try {
      // Budget kept for the problems still to come, so repairs of an early practice problem never starve the final:
      // each keeps its share of the set's calls, the final half again as much. Three calls each (a design and a solve)
      // left the nerve final of a Haiku-designed set unrepaired after the practice problems took 18 repairs (2026-10-11).
      const weight = (x) => (x.stage?.kind === 'twin' ? 1.5 : 1);
      const share = Number.isFinite(ctx.budget.maxCalls) ? ctx.budget.maxCalls / job.items.reduce((s, x) => s + weight(x), 0) : 0;
      ctx.reserveCalls = Math.floor(job.items.filter((x) => x.index > item.index && !['passed', 'warning', 'needs_review'].includes(x.status))
        .reduce((s, x) => s + Math.max(3, share * weight(x)), 0));
      // A problem a 학습 반복 carried over to remake: the reviewers' faults are its note, its last version what to fix.
      await produceItem(ctx, { material, item, prior, rules, mode: job.options.mode, examples, extraFeedback: item.remakeNote, previous: item.remakeNote ? item.history?.[0] : undefined,
        priorFaults: faultsData.forItem(history, { ...material, id: job.materialId }, item) });
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
  // The set against the record: how many of its faults were kinds already seen (the number a learning system drives down).
  job.faultStats = faultsData.setStats(job, history);
  ctx.log(faultsData.statsLine(job.faultStats));
  ctx.save();
  if (!ctx.signal.aborted) { try { await learnFromSet(ctx); } catch (e) { ctx.log(`세트 학습 실패 — ${e.message}`); } }
  // The data decides what the lessons are worth: one whose fault came back wakes, one no review has cited for a window
  // of sets sleeps (faults.sleepLessons / wakeLessons). The teacher's own items are never touched.
  try {
    const mine = faultsData.recordsOf(job);
    const changes = [...faultsData.wakeLessons(store, mine), ...faultsData.sleepLessons(store, [...history, ...mine])];
    if (changes.length) {
      job.lessonChanges = changes;
      ctx.log(`학습 수명: ${changes.map((c) => `${c.kind === 'wake' ? '깨어남' : '휴면'} — ${c.text.slice(0, 50)}… (${c.why.slice(0, 60)})`).join(' / ').slice(0, 500)}`);
      ctx.save();
    }
  } catch (e) {
    ctx.log(`학습 수명 정리 실패 — ${e.message}`);
  }
}

function pickRules(store, material) {
  // The problem a feedback was written about goes along: "이 조건은 불필요" means little without it.
  return selectRules(store.rules.all(), material).map((r) => ({ id: r.id, text: r.text, kind: r.kind, target: r.target, scope: r.scope, layer: layerOf(r),
    context: r.source?.excerpt ? `${r.source.label || '이전 생성 문제'}: ${r.source.excerpt.replace(/\s+/g, ' ').slice(0, 220)}` : '' }));
}

// What the pipeline checks and what happens on failure — shown on LLM › 하네스. Keep in step with the code above.
// onFail: 'fix' = the server corrects it itself, 'rewrite' = the solution is written again (the problem kept),
// 'repair' = the problem is repaired, then designed afresh if that does not do it, 'answer' = if it is still so after
// every design, the problem is marked 정답 확인 필요. match: how a recorded fault is counted under the check.
const SYSTEM_CHECKS = {
  analysis: [
    { label: '원본 대조 교정', how: '옮겨 적은 문제·해설을 이미지와 글자 단위로 다시 대조해 오독(몰질량↔물질량, 숫자, 로마 숫자)을 고친다.', onFail: 'fix' },
    { label: '필기 유입 재판독', how: '해설에서 구하는 값(x=15, 2cm/ms)이 문제 본문에 있으면 문제 이미지만 인쇄 글자 기준으로 두 번 다시 읽는다. 두 번 다 있으면 인쇄된 조건으로 인정한다.', onFail: 'fix' },
    { label: '발문 재판독 (2회)', how: '발문만 따로 두 번 읽어, 두 번 일치한 글자로 첫 판독을 고친다. 알려진·교사가 고친 혼동 단어는 해설까지 함께 고친다.', onFail: 'fix' },
    { label: '해설 단계 제목 재판독 (2회)', how: '해설에 인쇄된 step 제목을 두 번 읽어 STEP 수와 제목을 정한다.', onFail: 'fix' },
    { label: 'STEP 수 맞추기', how: '정리한 STEP이 해설의 단계 수보다 많으면 이웃한 STEP을 합친다 (선생님이 STEP 수를 정했으면 그대로 둔다).', onFail: 'fix' },
    { label: '해설의 보기 분석', how: 'ㄱㄴㄷ 문제인데 옮겨 적은 해설에 보기마다의 판정(○/×)이 없으면 알린다. 선생님 해설의 보기 분석은 마지막 STEP 끝에 옮겨야 한다.', onFail: 'fix' },
    { label: '원본 정답 검산', how: '원본을 해설대로 계산하는 프로그램을 정확한 분수로 실행해 옮겨 적은 수치와 정답이 맞는지 본다. 프로그램이 실행되지 않으면 오류를 보여 주고 한 번 고치게 한다. 계산 코드가 있는 유형(몰질량 표)은 서버가 선생님 풀이대로 직접 계산하고, 인쇄된 값을 필기로 보고 뺀 빈칸이 있으면 알린다.', onFail: 'fix' },
    { label: '판독에 섞인 한자', how: '한글 문서인데 판독에 한자가 섞이면(몰질量, B的) 그 필드만 이미지와 다시 대조하고, 남은 흔한 오독(量·质·的)은 코드가 한글로 고친다.', onFail: 'fix' },
    { label: '선생님 문장 틀 (원본마다 1번)', how: '해설의 각 줄을 바뀌는 값만 《이름》 자리로 비운 문장 틀로 뽑는다. 선생님 줄과 글자 그대로 맞는 틀만 남기고, 틀이 없는 줄이나 STEP은 다시 뽑는다. 같은 원본으로 다시 만들 때는 저장된 틀을 쓴다.', onFail: 'fix' },
  ],
  generation: [
    { label: '문장 배치', how: 'AI는 해설 한 줄을 "[틀 STEP-번호] 자리=값"으로 내용만 정하고, 서버가 선생님 문장 틀에 값을 넣어 문장·STEP 제목·선택지 분석 머리말·분수·수식 표기를 만든다. 값이 빠진 자리만 AI에게 다시 묻는다.', onFail: 'fix', match: /\[틀 \d+-\d+\]/ },
    { label: '코드 검산', how: '생성 모델이 함께 쓴 검산 프로그램을 서버가 정확한 분수로 실행해, 정답 값이 선택지 하나와만 맞는지와 설계 조건(가정→모순 등)이 참인지 본다.', onFail: 'answer', match: /^코드 검산/ },
    { label: '독립 풀이', how: '정답을 모르는 별도 호출이 문제만 보고 풀어 정답을 대조하고, 모호·모순·조건 부족·결론 노출을 지적한다.', onFail: 'answer', match: /독립 풀이(의 정답|가 정답| 지적)/ },
    { label: '보기·정답 연결', how: '보기 수·중복·정답 번호, ㄱㄴㄷ 해설의 참 판정과 정답 보기가 맞는지 코드로 본다.', onFail: 'answer', match: /^(보기·정답|해설 O\/X)/ },
    { label: '해설 보기 분석', how: '선생님 해설이 ㄱㄴㄷ을 하나씩 판정하면, 변형 해설도 STEP 안에서 보기마다 ○/× 판정을 하고 정답 번호로 끝나는지 코드로 본다.', onFail: 'rewrite', match: /^해설 보기 분석/ },
    { label: 'STEP 범위', how: '독립 풀이에 원본 STEP 기법 중 무엇이 꼭 필요했는지로, 목표 범위(STEP 1, STEP 1~2, 전체)와 맞는지, 기법 없이 풀리는 지름길이 없는지 본다.', onFail: 'repair', match: /^STEP 범위|로직 없이|핵심 기법 없이|목표 범위 밖/ },
    { label: '안 쓰인 조건', how: '독립 풀이가 문제의 조건을 하나씩 나열해 풀이에 썼는지 표시한다. 쓰이지 않은 조건·문자 계수가 있으면 설계 결함이다.', onFail: 'repair', match: /쓰이지 않는 조건|문자 계수/ },
    { label: '통합 변형 여부', how: '최종 문제를 원본과 비교해 숫자만 바꿨는지(독립 판정 + 표 구조 비교) 본다.', onFail: 'repair', match: /숫자만 바뀌|통합 변형/ },
    { label: '숫자·질문 재사용', how: '표의 설계 수치가 원본·앞 문제와 같은지(같은 칸에 같은 값이 대부분이거나 행 전체를 정수배·1/정수배 한 것도), 최종 문제의 그림 수치(위치 눈금 등)를 원본·앞 문제의 한 배수로만 바꿨는지, 최종 문제의 질문·보기가 앞 문제와 같은지 본다. 그래프에서 읽는 값(막전위 등)은 제외.', onFail: 'repair', match: /수치\(|질문이 같|선택지가 같|배 한 값|배 했습니다|같은 칸에 같은 수치/ },
    { label: '최종 검수', how: '각 문제를 검수 기준(review-criteria.md)으로 생성 모델이 한 번 검토한다 (세트에 두 번째 검수자를 지정하면 그 모델도 본다).', onFail: 'repair', match: /^최종 검수/ },
    { label: '교사 풀이 방법', how: '원본 해설의 보조 문자·STEP별 도입 순서·가정→모순 판정이 변형 해설에 그대로 있는지 코드로 본다.', onFail: 'repair', match: /가정→모순 판정 유지|보조 문자 유지|풀이 순서/ },
    { label: '결론 노출·표기 형식', how: '추론할 결론을 표에 미리 준 경우, 표 칸 수·수식 표기 오류를 코드로 본다.', onFail: 'repair', match: /결론을 표에|표기 형식/ },
    { label: '손계산 수치', how: '문제·선택지의 어려운 소수(1.732, 0.333)는 수정을 요구한다. 검산 보조값의 큰 분모는 최종 검수에서 약분·비교 후 학생의 실제 계산 난도를 판단한다. 최종 검수가 꺼진 경우에는 기존 수치 검사를 적용한다.', onFail: 'repair', match: /^손계산 수치/ },
    { label: '가정 방향', how: '세트에서 가정 방향(원본과 같게 / 반대로)을 정했으면, 해설 STEP 1이 가정해 모순을 보이는 쪽이 원본과 같은지·바뀌었는지 본다.', onFail: 'repair', match: /^가정 방향/ },
    { label: '해설 대조', how: '별도 검토자가 변형 해설을 선생님 해설과 이 문제의 STEP 범위 안에서 STEP별로 비교해, 다른 논리·문장 틀·표 구성을 찾는다. 범위 밖 STEP으로 쓴 정답 계산은 서버가 마지막 STEP에 합친다.', onFail: 'rewrite', match: /해설이 선생님 해설과 다름|STEP 제목/ },
    { label: '지침·학습 준수', how: '생성 모델이 지침·학습마다 적용 방법을 적고, 문제에 관한 것은 독립 풀이가, 해설에 관한 것은 해설 검토자가 다시 판정한다.', onFail: 'repair', match: /교사 지침 미준수/ },
  ],
};
const ON_FAIL = { fix: '서버가 바로 고침', rewrite: '해설만 다시 씀', repair: '문제 수정 → 안 되면 새로 설계', answer: '고치고 새로 설계, 끝내 안 되면 정답 확인 필요' };

/** How the checks fared on the recent sets: per check, on how many problems it fired and on how many it was left. */
function harnessStats(jobs) {
  const sets = jobs.filter((j) => j.type === 'generate' && j.status === 'done').sort((x, y) => y.createdAt.localeCompare(x.createdAt)).slice(0, 10);
  const items = sets.flatMap((j) => (j.items || []).filter((i) => i.problem));
  const fired = (item) => (item.attempts || []).flatMap((a) => a.failures || []);
  const left = (item) => [...(item.problems || []), ...(item.warnings || [])];
  const checks = SYSTEM_CHECKS.generation.map((c) => ({
    label: c.label,
    fired: items.filter((i) => [...fired(i), ...left(i)].some((f) => c.match.test(String(f).replace(/^(문제 설계|STEP 범위|해설): /, '')) || c.match.test(f))).length,
    left: items.filter((i) => left(i).some((f) => c.match.test(String(f).replace(/^(문제 설계|해설): /, '')) || c.match.test(f))).length,
  }));
  const first = items.filter((i) => ['passed', 'warning'].includes(i.status) && !(i.attempts || []).some((a) => a.kind !== 'generate')).length;
  const minutes = sets.map((j) => (new Date(j.finishedAt || j.updatedAt) - new Date(j.startedAt || j.createdAt)) / 60000).filter((m) => m > 0);
  return {
    sets: sets.length, problems: items.length, first,
    made: items.filter((i) => ['passed', 'warning'].includes(i.status)).length,
    answer: items.filter((i) => i.status === 'needs_review' && i.design).length,
    failed: items.filter((i) => i.status === 'failed').length,
    calls: sets.length ? Math.round(sets.reduce((n, j) => n + (j.usage?.calls || 0), 0) / sets.length) : 0,
    minutes: minutes.length ? Math.round(minutes.reduce((a, m) => a + m, 0) / minutes.length) : 0,
    checks,
  };
}

module.exports = {
  analysisPassed,
  harnessStats, ON_FAIL, cleanHeading, finalGate, reviewAnalysis, fixAnalysis, ensureFrames, originalImages, learnFromSet, learnFromReview, keepLesson, draftLesson, fitSolutionToStage, reviewSolution, writeSolution, verifyItem, adoptedExamples, SYSTEM_CHECKS, sourceChecks, tableRows, numbersReused, repeatsPrior, applyFixes, proposeStepAlignment, refreshStepCountNote, targetStepCount, analyzeMaterial, runGeneration, produceItem, pickRules, normalizeMaterial, normalizeGenerated, missingValues, ruleIdOf, coverage };
