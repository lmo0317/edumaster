'use strict';
const prompts = require('./prompts');
const { codeCheck } = require('./verify');
const { selectRules, analysisLearning, layerOf, readingHint, readingPairs, makeRule, grams, overlap } = require('./learning');
const crypto = require('node:crypto');
const harness = require('./harness');
const finalReview = require('./final-review');

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

// A line break a model wrote as the two letters \n (Haiku 5.5's final in reaction-density 3차, 2026-10-18: the equation,
// the sentences and the table ran on one line). Inside $…$ a LaTeX command (\ne, \nu) goes on with a letter, and stays.
const breaks = (t) => t.split(/(\$\$?[^$]*\$\$?)/).map((seg) => (seg.startsWith('$') ? seg.replace(/\\n(?![A-Za-z])/g, '\n') : seg.replace(/\\n/g, '\n'))).join('');

function normalizeProblem(p) {
  const choices = arr(p?.choices).map(stripChoiceNumber).filter(Boolean).slice(0, 9);
  let text = breaks(str(p?.text, 12000));
  // Choices belong in the choices array only; drop "① … ② …" lines copied into the body as well.
  if (choices.length > 1) text = text.split('\n').filter((line) => !(/^\s*①/.test(line) && line.includes('②'))).join('\n').trim();
  return { text, choices, answer: answerNumber(p?.answer, choices.length), figure: str(p?.figure, 4000) };
}

const romanLabels = (t) => t.replace(/(?<![A-Za-z\{_^])(IV|III|II|I)(?=[가-힣~,·)\s]|$)/g, (m) => ROMAN[m]);

/** Model analysis → material fields. Also used to validate the teacher's edits. */
function normalizeMaterial(data) {
  const problem = normalizeProblem(data?.problem);
  if (problem.text.length < 5) throw Object.assign(new Error('문제 본문을 읽지 못했습니다.'), { status: 422 });
  const steps = arr(data?.steps).map((s) => ({
    marker: str(s?.marker, 40),
    title: str(s?.title, 300), purpose: str(s?.purpose, 1000), technique: str(s?.technique, 1500),
    work: str(s?.work, 8000), result: str(s?.result, 1500),
  })).filter((s) => s.title || s.work).slice(0, 10);
  // A problem that numbers its experiments Ⅰ~Ⅳ: a solution read with Latin "I에서" is the same label, and the solution
  // judges marked every STEP title of a set down for the variant's "Ⅰ에서" (molar-mass round 5, 2026-10-11).
  if (/[ⅠⅡⅢⅣ]/.test(problem.text)) for (const s of steps) { s.title = romanLabels(s.title); s.work = romanLabels(s.work); }
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
const isPremise = (t) => /반응하지\s*않|임의의\s*원소\s*기호|뉴런으로\s*(구성|이루어)|시냅스가\s*있(을\s*수\s*있|는\s*위치|다)|한\s*곳에(만)?\s*시냅스/.test(String(t || ''));
function cleanHeading(h) {
  const title = str(h?.title ?? h, 300);
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

const ROMAN = { I: 'Ⅰ', II: 'Ⅱ', III: 'Ⅲ', IV: 'Ⅳ' };
const stepTitle = (t) => str(t, 300).replace(/^\s*STEP\s*\d+\s*[.:)·]\s*/i, '').replace(/(^|[^A-Za-z])(IV|III|II|I)(?=$|[^A-Za-z])/g, (m, pre, r) => pre + ROMAN[r]);
function normalizeSolution(solution) {
  return {
    steps: arr(solution?.steps).map((s) => ({ step: Number.parseInt(s?.step, 10) || 0, title: stepTitle(s?.title), work: breaks(str(s?.work, 8000)) })).filter((s) => s.work).slice(0, 12),
    summary: str(solution?.summary, 1000),
  };
}

// serverAnswer: the server computed the choices and answer (a molar-mass table) and puts them in itself.
function normalizeGenerated(data, { serverAnswer = false } = {}) {
  const problem = normalizeProblem(data?.problem);
  if (problem.text.length < 5) throw Object.assign(new Error('모델이 문제 본문을 만들지 않았습니다.'), { status: 422 });
  if (problem.choices.length && !problem.answer && !serverAnswer) throw Object.assign(new Error('모델이 정답 번호를 주지 않았습니다.'), { status: 422 });
  return {
    problem,
    solution: normalizeSolution(data?.solution),
    usesSteps: arr(data?.usesSteps).map((n) => Number.parseInt(n, 10)).filter((n) => n > 0).slice(0, 12),
    designNote: str(data?.designNote, 3000),
    appliedRules: arr(data?.appliedRules).map((r) => ({ id: str(r?.id, 40), how: str(r?.how, 600) })).filter((r) => r.id).slice(0, 30),
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
    const { applied, unresolved } = applyFixes(result, arr(check?.fixes).slice(0, 30));
    result.proofread = applied;
    result.uncertainties.push(...unresolved);
    result.solutionStepCount = Number.parseInt(check?.solutionStepCount, 10) || result.solutionStepCount;
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
    const text = str(data?.text, 8000);
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
  result.problem.text = text;
  if (str(data?.figure, 3000)) result.problem.figure = str(data.figure, 3000);
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
  // A molar-mass original is worked by the server's own code; it decides over the model's check program, whose
  // arithmetic slipped twice on a right transcription (2026-10-13).
  const molarCheck = harness.molarSourceCheck(material);
  if (molarCheck) {
    const c = checks.find((x) => x.id === 'source-calculation');
    const model = c.state === 'pass' ? '' : ` (모델 검산 프로그램: ${c.evidence})`;
    Object.assign(c, { state: molarCheck.ok ? 'pass' : 'fail', runError: false, evidence: molarCheck.evidence + (molarCheck.ok ? model : '') });
  }
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
    answerValue: str(data?.answerValue, 300),
    confident: data?.confident !== false,
    solution: str(data?.solution, 6000),
    stepsUsed: arr(data?.stepsUsed).map((n) => Number.parseInt(n, 10)).filter((n) => n > 0),
    shortcuts: arr(data?.shortcuts).map((c) => ({ step: Number.parseInt(c?.step, 10) || 0, how: str(c?.how, 400) })).filter((c) => c.step > 0 && c.how).slice(0, 6),
    issues: arr(data?.issues).map((i) => ({ type: str(i?.type, 30) || 'other', detail: str(i?.detail, 600) })).filter((i) => i.detail).slice(0, 10),
    // Kept rules by id only, like the solution review: a note for every kept rule was 44% of the solver's answer.
    rules: judgedRules(data?.rules),
    conditions: arr(data?.conditions).map((c) => ({ text: str(c?.text, 300), used: c?.used !== false })).filter((c) => c.text).slice(0, 30),
    variation: ['numbers-only', 'structural'].includes(data?.variation) ? data.variation : 'n/a',
    variationNote: str(data?.variationNote, 600),
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
    steps: arr(data?.steps).map((s) => ({ step: Number.parseInt(s?.step, 10) || 0, ok: s?.ok === true ? true : !arr(s?.issues).length, issues: arr(s?.issues).map((x) => str(x, 400)).filter(Boolean).slice(0, 6) })),
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
  try {
    const { data } = await ctx.llm.json({
      purpose: 'final-review', jobId: ctx.job.id, budget: ctx.budget, signal: ctx.signal, effort: ctx.effort.solve, maxTokens: 24000, vision: true,
      system: finalReview.reviewSystem(subject, ctx.store?.rules?.all() || [], ctx.job.rules || []),
      text: finalReview.itemReviewText(material, item, prior, hints),
      images: originalImages(ctx.store, material),
    });
    const review = (data?.items || [])[0] || null;
    const faults = finalReview.itemFaults(data);
    ctx.log(`${item.label}: 최종 검수 ${faults.length ? `${faults.length}건 — 고침` : '통과'}`);
    // Every round is kept for the set page: what each review found, and that the next one passed.
    (item.reviewRounds = item.reviewRounds || []).push({ at: new Date().toISOString(), design: item.attempts.filter((a) => a.kind === 'generate').length, verdict: review?.verdict || '', myAnswer: str(review?.myAnswer, 300), faults });
    ctx.save();
    return { faults, review, solutionOnly: faults.length > 0 && finalReview.solutionOnly(data) };
  } catch (e) {
    if (e.name !== 'LlmFormatError') throw e;
    return { faults: [], skipped: `최종 검수 응답을 읽지 못했습니다 (${e.message}).` };
  }
}

/** The analysis (the original read and its STEPs) under the same criteria, once per original as it now reads: kept with
 *  the original, so the set page shows the rows 원본을 정확히 읽는다 and 선생님 STEP을 그대로 쓴다 of the checklist. */
const analysisKey = (material) => crypto.createHash('sha1').update(JSON.stringify([material.problem?.text, material.problem?.choices, material.problem?.answer, (material.steps || []).map((s) => [s.title, s.work])])).digest('hex');
// What the analysis review finds is fixed against the original before any problem is made from the analysis, and the
// fixed analysis is reviewed once more: on chem-c32-molar-volume (2026-10-19) the review found the analysis had moved
// the teacher's '/몰' and dropped "분자량=질량/양(mol)이고 …", every problem's solution followed the analysis, and Claude
// and Gemini then found both in all three problems of the set.
// One look does not find everything: on the third c32 run the first review found one fault, and the review of the fixed
// analysis three more (one of them the '분자량=질량/양(mol)이고 …' line the run before had found first). Up to two rounds.
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
  if (!fixed.length || !review) return;
  Object.assign(review, { fixed, before });
  ctx.job.analysisReview = review;
  const stored = ctx.store?.materials?.get(ctx.job.materialId);
  if (stored) ctx.store.materials.put({ ...stored, analysisReview: review });
  ctx.save();
}

/** The review's findings → fixes of the analysis fields against the images (applyFixes), on the job's copy and the original. */
async function fixAnalysis(ctx, material, issues) {
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
  const { applied } = applyFixes(material, fixes);
  if (!applied.length) { ctx.log('원본 분석: 고칠 곳을 찾지 못했습니다'); return []; }
  // The teacher's frames were cut from the analysis as it read; they are cut again from the fixed one.
  delete material.frames;
  const stored = ctx.store?.materials?.get(ctx.job.materialId);
  if (stored) {
    const copy = JSON.parse(JSON.stringify({ problem: stored.problem, steps: stored.steps }));
    applyFixes(copy, fixes);
    const { frames, ...rest } = stored;
    ctx.store.materials.put({ ...rest, problem: copy.problem, steps: copy.steps, analysisFixes: [...(stored.analysisFixes || []), { at: new Date().toISOString(), jobId: ctx.job.id, applied }] });
  }
  ctx.log(`원본 분석 ${applied.length}곳을 고쳤습니다`);
  return applied;
}

async function reviewAnalysisOnce(ctx, material) {
  const stored = ctx.store?.materials?.get(ctx.job.materialId);
  const key = analysisKey(material);
  if (stored?.analysisReview?.key === key) { ctx.job.analysisReview = stored.analysisReview; ctx.save(); return null; }
  if (ctx.budget.affords && !ctx.budget.affords(4)) return null;
  ctx.log('원본 분석을 최종 검수 기준으로 검토 중');
  try {
    const { data } = await ctx.llm.json({
      purpose: 'final-review', jobId: ctx.job.id, budget: ctx.budget, signal: ctx.signal, effort: ctx.effort.solve, maxTokens: 16000, vision: true,
      system: finalReview.reviewSystem({ ...material, id: ctx.job.materialId }, ctx.store?.rules?.all() || [], ctx.job.rules || []),
      text: finalReview.analysisText(material), images: originalImages(ctx.store, material),
    });
    const a = data?.analysis || {};
    const review = { key, at: new Date().toISOString(), verdict: a.verdict === 'issues' ? 'issues' : 'ok', issues: arr(a.issues).slice(0, 12), checklist: finalReview.checklistOf(a, { analysis: true }) };
    ctx.job.analysisReview = review;
    if (stored) ctx.store.materials.put({ ...stored, analysisReview: review });
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
  return list.map((r) => (typeof r === 'string' ? { id: r, ok: true } : r)).map((r) => ({ id: str(r?.id, 40), ok: r?.ok !== false, note: str(r?.note, 400) })).filter((r) => r.id);
}

const BLOCKING_ISSUES = new Set(['ambiguous', 'contradiction', 'missing', 'revealed']);

// Table rows as number signatures: "| Ⅰ | $8w$ | $6w$ | ..." -> "8w,6w". Only the first two data cells
// (the given amounts) are compared, so a row reusing an earlier experiment's inputs is caught.
function tableRows(text, hidden = {}) {
  const rows = [];
  for (const line of String(text || '').split('\n')) {
    if (!/^\s*\|/.test(line) || /^\s*\|[\s:|-]+\|\s*$/.test(line)) continue;
    const cells = line.trim().replace(/^\||\|$/g, '').split('|').slice(1)
      .map((c) => c.replace(/\\ce\{[^}]*\}|\$|\s|\\,/g, '').replace(/\\(d?frac)\{(\d+)\}\{(\d+)\}/g, '$2/$3'))
      .map((c) => hidden[c] ?? c)
      // A formula (\mathrm{ZX_2}) names the row, it is not an amount: with it the row's amounts were never compared.
      .filter((c) => /\d/.test(c) && c.length <= 24 && !/(mathrm|text)\{/.test(c));
    if (cells.length >= 2) rows.push({ label: line.split('|')[1].trim().replace(/\$/g, ''), sig: cells.slice(0, 2).join(','), cells });
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

/** Experiment rows whose given amounts match the original's or (for the final problem) an earlier problem's. */
function numbersReused(item, prior, material) {
  const vocab = readingVocabulary(material);
  const mine = designedRows(item.problem.text, vocab);
  if (!mine.length) return [];
  const notes = [];
  // The value a hidden letter comes to is the answer the student works out: the same as the original's (a = 12 asked
  // again, chem-c32-molar-volume 2026-10-19: the final review found it in a third round, past the repairs) is a
  // remembered answer, not a worked one.
  const myHidden = hiddenValues(item.problem.text, item.solution?.steps);
  const compare = (text, steps, whose) => {
    const theirHidden = hiddenValues(text, steps);
    const theirs = new Set([...designedRows(text, vocab), ...designedRows(text, vocab, theirHidden)].map((r) => r.sig));
    for (const r of mine) if (theirs.has(r.sig)) notes.push(`${whose}의 실험 수치(${r.sig})를 그대로 썼습니다 (${r.label} 행).`);
    for (const [l, v] of Object.entries(myHidden)) if (theirHidden[l] === v) notes.push(`${whose}에서 숨긴 값과 같은 값(${l}=${v})을 구하게 합니다. ${l}가 다른 값이 되게 수치를 잡습니다.`);
  };
  compare(material.problem.text, material.steps, '원본');
  if (item.stage.kind === 'twin') for (const other of prior) if (other.problem && other.index !== item.index) compare(other.problem.text, other.solution?.steps, `앞 문제(${other.label})`);
  return [...new Set(notes)];
}

/** Row signatures the new problem must avoid: the original's, and (for the final problem) earlier problems'. */
// ---------------------------------------------------------------- learning from adopted variants
// A variant the teacher adopted (채택) is a good example for its original: later variants of the same stage are shown
// it as a model of structure and solution style (not to copy — its numbers join the ones to avoid).
const stageKey = (s) => `${s?.kind}:${s?.upto || s?.step || ''}`;
/** Adopted variants of this original across its sets, newest first; `exclude` leaves out the one being replaced. */
function adoptedExamples(store, materialId, exclude = {}) {
  const out = [];
  for (const j of store.jobs.all()) {
    if (j.type !== 'generate' || j.materialId !== materialId) continue;
    for (const it of j.items || []) {
      if (!it.adopted || !it.problem || (j.id === exclude.jobId && it.index === exclude.index)) continue;
      out.push({ stage: it.stage, label: it.label, problem: it.problem, solution: it.solution, at: it.reviewedAt || j.createdAt });
    }
  }
  return out.sort((a, b) => String(b.at).localeCompare(String(a.at)));
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
// trusted: on one of the server's molar-mass tables, the values the server computed (hidden values, b, the answer) are
// required instead — the outline's own arithmetic was wrong in two of two runs (Qwen 3.6's 1/2 and 20 for 2/3 and 30,
// and "B 10m mol" on a row where B was all used, 2026-10-13 runs 8 and 9) while the writer had it right.
function missingValues(outline, solution, trusted = null) {
  const text = flat(solution.steps.map((s) => s.work).join('\n') + '\n' + solution.summary);
  const values = new Set(trusted ? trusted.map(flat) : []);
  if (!trusted) {
    for (const s of outline.steps) {
      for (const m of String(s.work).matchAll(/\$([^$]+)\$/g)) {
        const v = flat(m[1].split('=').pop());
        if (/\d/.test(v) && v.length <= 24) values.add(v);
      }
    }
  }
  return [...values].filter((v) => v && !text.includes(v));
}

/** The job's own model writes the outline out as a full solution; returns warnings for the teacher. */
async function writeSolution(ctx, item, material, rules, fixes = [], trusted = null, purpose = 'write-solution') {
  // The server's values go to the writer as they went to the designer (Qwen 3.8 rewrote a final's STEP 1 without them
  // and got B 14w for 8w, 2026-10-13 round 6). Not kept on the problem.
  item.serverFacts = ctx.serverFacts?.(item) || null;
  try { return await writeOnce(ctx, item, material, rules, fixes, trusted, purpose); } finally { delete item.serverFacts; }
}

async function writeOnce(ctx, item, material, rules, fixes, trusted, purpose) {
  ctx.log(`${item.label}: 해설 ${purpose === 'polish-solution' ? '다듬는' : '풀어 쓰는'} 중${fixes.length ? ` (고칠 점 ${fixes.length}건)` : ''}${ctx.routes?.[purpose] ? ` (${ctx.routes[purpose]})` : ''}`);
  let written = null;
  let missing = [];
  for (let attempt = 0; attempt < 2 && (!written || missing.length); attempt++) {
    const notes = [...fixes, ...missing.map((v) => (trusted ? `서버가 계산한 값 ${v}가 해설에 없습니다. 이 값이 나오게 쓴다.` : `출제자 요지의 값 ${v}가 해설에 없습니다. 요지의 판정과 값을 그대로 쓴다.`))];
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
    missing = missingValues(item.outline, solution, trusted);
  }
  if (!written) { item.solution = item.outline; return ['해설 풀어쓰기에 실패해 출제자의 요지를 해설로 둡니다.']; }
  item.solution = stripSummaries(written, material);
  return missing.length ? [`풀어 쓴 해설에 ${trusted ? '서버가 계산한 값' : '출제자 요지의 값'}(${missing.join(', ')})이 보이지 않습니다.`] : [];
}

/** The designer checks a disagreeing solver's work: is the problem at fault, or the solver? */
async function adjudicate(ctx, item, blind, issues) {
  ctx.log(`${item.label}: 독립 풀이와 달라 출제자가 재확인 중`);
  try {
    const { data } = await ctx.llm.json({
      purpose: 'adjudicate', jobId: ctx.job.id, budget: ctx.budget, signal: ctx.signal, effort: ctx.effort.solve, maxTokens: 8000,
      system: prompts.ADJUDICATE_SYSTEM, text: prompts.adjudicateText({ item, blind, issues }),
    });
    return { problemAtFault: data?.problemAtFault === true, reason: str(data?.reason, 600) };
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
  // A problem on one of the server's molar-mass tables is checked against the server's own calculation, not the
  // designer's program (Qwen 3.6's programs failed on syntax the math engine does not take, 2026-10-12).
  if (harness.molarServe(material, item, mode, prior)) ctx?.log?.(`${item.label}: 서버가 계산한 표·발문·선택지${item.serverWritten ? '·해설' : ''}로 맞춤`);
  item.verificationSpec = harness.molarSpec(material, item, mode, prior) || item.verificationSpec;
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
  // A value the program computes that a student could not do by hand is a design fault (요구서 1), not just a note.
  const handNotes = (code.warnings || []).filter((w) => /손으로 계산/.test(w)).map((w) => `손계산 수치: ${w}. 수치를 손으로 계산하기 쉽게 다시 잡아야 합니다.`);
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
  // A molar-mass final's structure is counted by code (harness.checkMolar): the solver's own count of the same five
  // items went both ways on alike finals (R10~R14, 2026-10-10~12: 14 of 15 agree with the code, the 15th's note
  // contradicted itself) and sent finals round the repair loop.
  const molarChanges = integratedFinal ? harness.molarChanges(material, item) : null;
  const codeChecks = [...harness.inspectItem(material, item, mode), ...harness.checkDirection(material, item, ctx.direction)]
    .filter((c) => !(c.id === 'variant-shape' && (blind.variation === 'structural' || molarChanges)));
  const numbersOnly = molarChanges ? false : blind.variation === 'numbers-only';
  const failed = codeChecks.filter((x) => x.state === 'fail');
  for (const c of failed) {
    if (solutionOnly(c) && c.severity !== 'hard') rewriteNotes.push(`${c.label}: ${c.evidence}`);
    else if (c.severity === 'hard') { hard.push(`${c.label}: ${c.evidence}`); invalid.push(`${c.label}: ${c.evidence}`); }
    else soft.push(`${c.label}: ${c.evidence}`);
  }
  // Teacher feedback: problems carried conditions nothing used, and the "integrated" final only changed numbers.
  // On one of the server's tables a hidden cell (x, z) is an unknown the solution works out, not a given condition, and
  // the server has checked that every given value is used: Opus's solve called a hidden z whose row the question
  // totals "unused", and the repair that followed printed z's value and left the server's tables (2026-10-13, run 14).
  const onServerTable = Boolean(item.verificationSpec && harness.molarSpec(material, item, mode, prior));
  const hiddenCell = (t) => onServerTable && /(^|[^A-Za-z\\])[xz]($|[^A-Za-z])/.test(String(t).replace(/\$/g, ' '));
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
    ...(lean ? [] : blind.conditions.filter((c) => !c.used && !isPremise(c.text) && !hiddenCell(c.text)).map((c) => `풀이에 쓰이지 않는 조건: ${c.text}`)),
    ...(!lean && integratedFinal && numbersOnly ? [[`통합 변형인데 원본에서 숫자만 바뀌었습니다. ${blind.variationNote}`.trim(), harness.shapeOptions(material.problem.text, material.problem.figure)].filter(Boolean).join('\n')] : []),
    ...(item.stage.kind === 'twin' ? repeatsPrior(item, prior) : []),
    ...ruleNotes,
  ];
  const gated = Boolean(ctx.finalGate);
  const designNotes = [
    ...(gated ? [] : judgement),
    ...numbersReused(item, prior, material),
    ...failed.filter((c) => c.severity === 'design' && !solutionOnly(c)).map((c) => `${c.label}: ${c.evidence}`),
    ...handNotes,
  ];
  const hints = gated ? [...judgement, ...(lean ? [] : cov.notes.map((n) => 'STEP 범위: ' + n))] : [];
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
  // A problem on one of the server's molar-mass tables is checked against the server's own calculation, not the
  // designer's program (Qwen 3.6's programs failed on syntax the math engine does not take, 2026-10-12).
  if (harness.molarServe(material, item, mode, prior)) ctx?.log?.(`${item.label}: 서버가 계산한 표·발문·선택지${item.serverWritten ? '·해설' : ''}로 맞춤`);
  item.verificationSpec = harness.molarSpec(material, item, mode, prior) || item.verificationSpec;
  const code = item.verificationSpec
    ? await codeCheck(item.verificationSpec, { answer: item.problem.answer, choiceCount: item.problem.choices.length })
    : { status: 'fail', reasons: ['검산 프로그램이 없습니다.'] };
  // Solution wording is the writer's. The table-shape check counts here although verifyItem lets the solver's
  // structure verdict overrule it: a final in the original's table came back numbers-only from Opus and Haiku alike
  // (molar-mass, 2026-10-09/10), and the cheap designer changing the table costs less than one Opus solve.
  const molarFinal = item.stage.kind === 'twin' && mode === 'integrated' && harness.molarChanges(material, item);
  const failed = [...harness.inspectItem(material, item, mode), ...harness.checkDirection(material, item, ctx.direction)]
    .filter((c) => c.state === 'fail' && !(solutionOnly(c) && c.severity !== 'hard') && !(c.id === 'variant-shape' && molarFinal));
  return [
    ...(code.status === 'fail' ? code.reasons.map((r) => '코드 검산: ' + r) : []),
    ...failed.filter((c) => c.severity === 'hard').map((c) => `${c.label}: ${c.evidence}`),
    ...[
      ...(item.stage.kind === 'twin' ? repeatsPrior(item, prior) : []),
      ...numbersReused(item, prior, material),
      ...failed.filter((c) => c.severity === 'design').map((c) => `${c.label}: ${c.evidence}`),
      ...(code.warnings || []).filter((w) => /손으로 계산/.test(w)).map((w) => `손계산 수치: ${w}. 수치를 손으로 계산하기 쉽게 다시 잡아야 합니다.`),
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
        .map((r) => ({ id: ruleIdOf(String(r?.id || '').slice(0, 40), missing), how: String(r?.how || '').slice(0, 600) }))
        .filter((r) => r.id && r.how);
      item.appliedRules = [...item.appliedRules.filter((a) => !back.some((b) => b.id === a.id)), ...back];
      ctx.log(`${item.label}: 빠진 지침 설명 ${back.length}/${missing.length}건 채움`);
    } catch (e) {
      if (e.name !== 'LlmFormatError') throw e;
    }
  }
}

/** One design of a problem: generated, checked, repaired (problem) and rewritten (solution) until it passes or stops
 *  getting better. Mutates `item`; returns its version, the last check and what is still wrong. */
async function designOnce(ctx, { material, item, prior, rules, mode, extraFeedback, previous, examples, design }) {
  const total = material.steps.length;
  const lean = Boolean(ctx.lean);
  item.status = 'generating'; item.error = ''; ctx.save();
  ctx.log(`${item.label}: 문제 설계 중${design > 1 ? ` (${design}번째 설계)` : ''}`);
  // A molar-mass original: the server's own tables (numbers, question, choices) to copy — the designer only words them.
  const shapeHint = harness.molarOptions(material, item.stage, mode, prior)
    || (item.stage.kind === 'twin' && mode === 'integrated' ? harness.shapeOptions(material.problem.text, material.problem.figure) : harness.practiceOptions(material, item.stage));
  // A designer that returns no problem ("설계 미완성", Haiku 5.5's nerve finals R10/R11 2026-10-12, with the server's
  // computed tables in its prompt) gets one more design told that giving up is not an answer.
  const serverNumbers = /^서버가 계산한/.test(shapeHint || '');
  const trusted = () => (serverNumbers ? harness.molarTrusted(material, item, mode, prior) : null);
  ctx.serverFacts = (x) => (serverNumbers && x === item ? harness.molarFacts(material, item, mode, prior) : null);
  let lostAnswer = false;
  let noAnswer = false;
  for (let tries = 0; ; tries++) {
    const feedback = lostAnswer ? extraFeedback : noAnswer ? [extraFeedback, '지난 설계는 선택지만 있고 정답 번호(answer)가 없었습니다. 서버가 계산한 표 하나를 수치·선택지·정답 번호까지 그대로 쓰세요.'].filter(Boolean).join('\n') : tries ? [extraFeedback, `지난 설계는 문제 없이 "만들지 못함"으로 끝났습니다. 설계를 중단하지 말고 반드시 완성된 문제를 내야 합니다.${/서버가 계산한 예/.test(shapeHint) ? ' 설계 안내의 "서버가 계산한 예" 중 첫 번째 표의 자극 지점·위치·시냅스·수치를 그대로 쓰세요 — 해석이 하나뿐이고 준 값이 모두 필요한 것이 서버에서 확인된 표입니다.' : ''}`].filter(Boolean).join('\n') : extraFeedback;
    const designPrompt = prompts.generateParts({ material, stage: item.stage, total, mode, prior, rules, variantNo: item.variantNo, extraFeedback: feedback, previous, examples, usedRows: usedRowsFor(item, prior, material, examples), direction: ctx.direction, shapeHint });
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
      // On the server's own table a missing answer number is the server's to fill (Qwen 3.6's STEP 1~2 practice
      // failed whole on one, 2026-10-13 run 8); a table the server cannot match still needs the designer's answer.
      Object.assign(item, normalizeGenerated(data, { serverAnswer: serverNumbers }));
      if (serverNumbers && harness.molarAdopt(material, item, mode, prior)) ctx.log(`${item.label}: 설계가 서버 표를 쓰지 않아 서버 후보 1번으로 바꿈`);
      if (serverNumbers) harness.molarServe(material, item, mode, prior);
      if (item.problem.choices.length && !item.problem.answer) throw Object.assign(new Error('모델이 정답 번호를 주지 않았습니다.'), { status: 422 });
      break;
    } catch (e) {
      if (e.status !== 422 || tries >= 2 || (/정답 번호/.test(e.message) && !serverNumbers)) throw e;
      ctx.log(`${item.label}: ${/정답 번호/.test(e.message) ? '정답 번호 없이 돌아와' : '설계가 문제 없이 돌아와'} 다시 설계합니다`);
      noAnswer = /정답 번호/.test(e.message);
    }
  }
  item.attempts.push({ kind: 'generate', design, at: new Date().toISOString() });
  await fillRuleNotes(ctx, item, rules);
  // Lean run: what the designer wrote is the outline; the job's own model writes it out as the solution — or, on one
  // of the server's molar-mass tables, the server writes all of it in the teacher's sentences (runs 9–11: the writer's
  // text was replaced by the server's anyway, and its rewrites were the set's largest Opus cost).
  let writeNotes = [];
  const writeOut = async (fixes = []) => {
    const server = serverNumbers ? harness.molarSolution(material, item, mode, prior) : null;
    item.serverWritten = Boolean(server);
    if (server) { item.solution = server; ctx.log(`${item.label}: 서버가 선생님 해설 문장으로 해설을 씀`); return []; }
    return writeSolution(ctx, item, material, rules, fixes, trusted());
  };
  if (lean) { item.outline = item.solution; writeNotes = await writeOut(); }
  let rewrites = 0;
  // One repair by the designer: the problem, its solution and check program fixed for `failures`.
  const repairWith = async (failures, blind) => {
    const purpose = lean ? 'repair-lean' : 'repair';
    ctx.log(`${item.label}: 검토에서 발견된 ${failures.length}건 수정 중${ctx.routes?.[purpose] ? ` (${ctx.routes[purpose]})` : ''}`);
    // A molar-mass original: the numbers are the server's, so a repair keeps them and fixes the words — or takes
    // another of the server's tables whole. Qwen 3.6 dropped the server's table on its final's second repair and made
    // up numbers again (2026-10-12, run 2).
    const keepNumbers = shapeHint && /^서버가 계산한/.test(shapeHint)
      ? `\n\n[수치는 서버가 계산한 값]\n표의 수치·숨긴 칸·묻는 식·선택지·정답 번호는 아래 서버 후보에서 가져온 것이다. 수치를 새로 짐작해 바꾸지 말고 지적된 문장과 해설만 고친다. 지적이 수치 자체에 대한 것이면 아래 후보 중 다른 하나를 통째로 그대로 쓴다.\n${shapeHint}` : '';
    let fixed, repairShape = [];
    try {
      ({ data: fixed, shapeFixes: repairShape = [] } = await ctx.llm.json({
        purpose, jobId: ctx.job.id, budget: ctx.budget, signal: ctx.signal, effort: ctx.effort.generate, maxTokens: 64000,
        system: prompts.REPAIR_SYSTEM,
        // A lean repair sees the designer's own outline (not the long written solution) and returns only what changed.
        ...(({ context, text }) => ({ context, text: text + (lean ? prompts.LEAN_REPAIR : '') + keepNumbers }))(prompts.repairParts({ material, stage: item.stage, total, mode, rules, item: lean ? { ...item, solution: item.outline } : item, failures, blind, lean })),
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
      // Local models often return only the fixed problem; what they leave out (the design note, the STEPs used) stays
      // from the previous version instead of being wiped.
      const next = normalizeGenerated(fixed, { serverAnswer: serverNumbers });
      for (const key of ['designNote', 'usesSteps']) if (!next[key]?.length && item[key]?.length) next[key] = item[key];
      next.appliedRules = rulesAfter(next.appliedRules);
      Object.assign(item, next);
      rewrites = 0;
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
      item.attempts.push({ kind: 'precheck', design, at: new Date().toISOString(), failures: faults });
      ctx.log(`${item.label}: 코드 검사에서 ${faults.length}건 — 독립 풀이 전에 설계자가 고침`);
      await repairWith(faults, null);
    }
  };
  // The solution's layout is the system's: the writer gives each sentence as a teacher frame and its values, the server
  // writes the sentence, the titles and the choice heading (harness.renderFrames). The writer is asked again only for
  // what it left out (a frame's value) — never to reword (the user, 2026-10-13: format is not the model's job; Qwen
  // 3.8 spent round 6 rewording lines to fit frames).
  const polish = async () => {
    if (lean || !material.frames?.length || item.serverWritten) return;
    let missing = harness.renderFrames(material, item);
    // The designer fills what it left out (the PC model in a mixed run, the job's own model otherwise).
    for (let i = 0; i < 2 && missing.length && !ctx.signal?.aborted; i++) {
      item.attempts.push({ kind: 'fill', design, at: new Date().toISOString(), failures: missing });
      item.outline = item.solution;
      await writeSolution(ctx, item, material, rules, missing, trusted(), 'polish-solution');
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
  let lastRepair = null;
  for (let round = 0; ;) {
    if (ctx.signal?.aborted) break;
    // A fault only in the solution (wording, the teacher's sentence frame, a solution rule) is rewritten by the writer
    // — no redesign, no new solve. Outside a lean run the current solution is what gets rewritten.
    if (check.rewriteNotes.length && !repairReasons(check).length && !item.serverWritten && rewrites < (ctx.maxRewrites ?? 2) && (!ctx.budget.affords || ctx.budget.affords(2 + (ctx.reserveCalls || 0)))) {
      rewrites++;
      item.attempts.push({ kind: 'rewrite', design, at: new Date().toISOString(), failures: check.rewriteNotes });
      if (!lean) item.outline = item.solution;
      // The judge's notes are rewritten by the designer in a mixed run (free), then held to the frames again.
      writeNotes = await writeSolution(ctx, item, material, rules, check.rewriteNotes, trusted(), ctx.routes?.['polish-solution'] && !lean ? 'polish-solution' : 'write-solution');
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
    if (check.gate?.solutionOnly && !item.serverWritten && rewrites < (ctx.maxRewrites ?? 2) && (!ctx.budget.affords || ctx.budget.affords(3 + (ctx.reserveCalls || 0)))) {
      rewrites++;
      const notes = check.gate.faults.map((n) => '최종 검수: ' + n);
      item.attempts.push({ kind: 'rewrite', design, at: new Date().toISOString(), failures: notes });
      if (!lean) item.outline = item.solution;
      writeNotes = await writeSolution(ctx, item, material, rules, notes, trusted(), ctx.routes?.['polish-solution'] && !lean ? 'polish-solution' : 'write-solution');
      await polish();
      check = await verifyItem(ctx, item, material, rules, mode, prior, { blind: check.verification.blind, adjudication: check.verification.adjudication });
      continue;
    }
    if (!repairReasons(check).length || round >= ctx.maxRepairs) break;
    if (lastRepair && same(repairReasons(check), lastRepair)) break;
    // A repair costs a repair and a new solve; skip it when that would leave too little for the later problems.
    if (ctx.budget.affords && !ctx.budget.affords(3 + (ctx.reserveCalls || 0))) {
      const byCalls = ctx.budget.calls + 3 + (ctx.reserveCalls || 0) > ctx.budget.maxCalls;
      ctx.log(`${item.label}: 남은 문제를 만들 ${byCalls ? '호출' : '토큰'}을 남기려고 수정을 건너뜁니다`);
      check.soft.push(byCalls ? '세트당 AI 호출 상한 때문에 자동 수정을 더 하지 못했습니다 (학습 › 하네스에서 늘릴 수 있습니다).' : '세트 토큰 상한 때문에 자동 수정을 더 하지 못했습니다.');
      break;
    }
    round++;
    lastRepair = repairReasons(check);
    item.attempts.push({ kind: 'repair', design, at: new Date().toISOString(), failures: lastRepair });
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
async function produceItem(ctx, { material, item, prior, rules, mode, extraFeedback, previous, examples: allExamples = [] }) {
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
        item.attempts.push({ kind: 'redesign', design, at: new Date().toISOString(), failures: left.problems });
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
      if (seen.has(text)) continue;
      seen.add(text);
      faults.push({ label: item.label, text: text.slice(0, 400), left: [...left].some((x) => x.includes(text.slice(0, 60))) });
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
  for (const x of arr(data?.items).slice(0, 3)) {
    const text = str(x?.text, 600);
    if (text.length < 8 || existing.includes(text)) continue;
    const common = x?.scope === 'common';
    const rule = makeRule({
      text, stage: 'generation', target: ['problem', 'solution', 'all'].includes(x?.target) ? x.target : 'all',
      scope: common ? 'global' : 'material', layer: 'lesson',
      // A common item about this subject's content reaches only this subject's problems.
      subject: common && x?.subjectOnly === true ? material.subject || '' : common ? '' : material.subject || '',
      source: { materialId: job.materialId, jobId: job.id, label: job.title, from: 'auto' },
    });
    store.rules.put(rule);
    learned.push({ id: rule.id, text, scope: common ? 'common' : 'problem', target: rule.target, why: str(x?.why, 300) });
  }
  job.learned = learned;
  ctx.log(learned.length ? `학습 ${learned.length}개를 추가했습니다` : '새로 추가할 학습은 없습니다');
  ctx.save();
}

/**
 * The teacher's sentence frames of an original, extracted once by the job's model and kept with the original (see
 * harness.validateFrames): only frames that match the teacher's own lines stay. A failure leaves the set without them.
 */
async function ensureFrames(ctx, material) {
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
    if (stored) ctx.store.materials.put({ ...stored, frames: material.frames });
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
  if (ctx.finalGate && !job.analysisReview) await reviewAnalysis(ctx, material);
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
      await produceItem(ctx, { material, item, prior, rules, mode: job.options.mode, examples });
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
  if (!ctx.signal.aborted) await learnFromSet(ctx);
}

function pickRules(store, material) {
  // The problem a feedback was written about goes along: "이 조건은 불필요" means little without it.
  return selectRules(store.rules.all(), material).map((r) => ({ id: r.id, text: r.text, kind: r.kind, target: r.target, scope: r.scope, layer: layerOf(r),
    context: r.source?.excerpt ? `${r.source.label || '이전 생성 문제'}: ${r.source.excerpt.replace(/\s+/g, ' ').slice(0, 220)}` : '' }));
}

// What the pipeline checks and what happens on failure — shown on 학습 › 하네스. Keep in step with the code above.
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
    { label: '서버 계산', how: '계산 코드가 있는 유형(몰질량 표)은 표 수치·숨긴 값·정답·선택지 후보와 해설에 쓸 값(반응량, 남는 물질, 실젯값, 비례식)을 서버가 계산해 준다. AI는 후보를 고르기만 하고, 옮기다 틀린 수치는 서버 값으로 덮어쓴다.', onFail: 'fix', match: /서버가 계산한/ },
    { label: '문장 배치', how: 'AI는 해설 한 줄을 "[틀 STEP-번호] 자리=값"으로 내용만 정하고, 서버가 선생님 문장 틀에 값을 넣어 문장·STEP 제목·선택지 분석 머리말·분수·수식 표기를 만든다. 값이 빠진 자리만 AI에게 다시 묻는다.', onFail: 'fix', match: /\[틀 \d+-\d+\]/ },
    { label: '코드 검산', how: '생성 모델이 함께 쓴 검산 프로그램을 서버가 정확한 분수로 실행해, 정답 값이 선택지 하나와만 맞는지와 설계 조건(가정→모순 등)이 참인지 본다.', onFail: 'answer', match: /^코드 검산/ },
    { label: '독립 풀이', how: '정답을 모르는 별도 호출이 문제만 보고 풀어 정답을 대조하고, 모호·모순·조건 부족·결론 노출을 지적한다.', onFail: 'answer', match: /독립 풀이(의 정답|가 정답| 지적)/ },
    { label: '보기·정답 연결', how: '보기 수·중복·정답 번호, ㄱㄴㄷ 해설의 참 판정과 정답 보기가 맞는지 코드로 본다.', onFail: 'answer', match: /^(보기·정답|해설 O\/X)/ },
    { label: '해설 보기 분석', how: '선생님 해설이 ㄱㄴㄷ을 하나씩 판정하면, 변형 해설도 STEP 안에서 보기마다 ○/× 판정을 하고 정답 번호로 끝나는지 코드로 본다.', onFail: 'rewrite', match: /^해설 보기 분석/ },
    { label: 'STEP 범위', how: '독립 풀이에 원본 STEP 기법 중 무엇이 꼭 필요했는지로, 목표 범위(STEP 1, STEP 1~2, 전체)와 맞는지, 기법 없이 풀리는 지름길이 없는지 본다.', onFail: 'repair', match: /^STEP 범위|로직 없이|핵심 기법 없이|목표 범위 밖/ },
    { label: '안 쓰인 조건', how: '독립 풀이가 문제의 조건을 하나씩 나열해 풀이에 썼는지 표시한다. 쓰이지 않은 조건·문자 계수가 있으면 설계 결함이다.', onFail: 'repair', match: /쓰이지 않는 조건|문자 계수/ },
    { label: '통합 변형 여부', how: '최종 문제를 원본과 비교해 숫자만 바꿨는지(독립 판정 + 표 구조 비교) 본다.', onFail: 'repair', match: /숫자만 바뀌|통합 변형/ },
    { label: '숫자·질문 재사용', how: '표의 설계 수치가 원본·앞 문제와 같은지, 최종 문제의 질문·보기가 앞 문제와 같은지 본다. 그래프에서 읽는 값(막전위 등)은 제외.', onFail: 'repair', match: /수치\(|질문이 같|선택지가 같/ },
    { label: '교사 풀이 방법', how: '원본 해설의 보조 문자·STEP별 도입 순서·가정→모순 판정이 변형 해설에 그대로 있는지 코드로 본다.', onFail: 'repair', match: /가정→모순 판정 유지|보조 문자 유지|풀이 순서/ },
    { label: '결론 노출·표기 형식', how: '추론할 결론을 표에 미리 준 경우, 표 칸 수·수식 표기 오류를 코드로 본다.', onFail: 'repair', match: /결론을 표에|표기 형식/ },
    { label: '손계산 수치', how: '계산기 없이 풀 수 있는지 본다. 검산 프로그램의 값에 분모가 큰 분수가 나오거나, 문제·선택지에 간단한 분수가 아닌 소수(1.732, 0.333)가 있으면 수치를 다시 잡게 한다.', onFail: 'repair', match: /^손계산 수치/ },
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
  harnessStats, ON_FAIL, cleanHeading, reviewAnalysis, isPremise, learnFromSet, fitSolutionToStage, reviewSolution, writeSolution, verifyItem, adoptedExamples, SYSTEM_CHECKS, sourceChecks, tableRows, numbersReused, repeatsPrior, applyFixes, proposeStepAlignment, refreshStepCountNote, targetStepCount, analyzeMaterial, runGeneration, produceItem, pickRules, normalizeMaterial, normalizeGenerated, missingValues, ruleIdOf, coverage };
