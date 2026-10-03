'use strict';
const prompts = require('./prompts');
const { codeCheck } = require('./verify');
const { selectRules, analysisLearning, layerOf, readingHint, readingPairs, makeRule } = require('./learning');
const harness = require('./harness');

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
const isPremise = (t) => /반응하지\s*않|임의의\s*원소\s*기호/.test(String(t || ''));
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

function normalizeSolution(solution) {
  return {
    steps: arr(solution?.steps).map((s) => ({ step: Number.parseInt(s?.step, 10) || 0, title: str(s?.title, 300), work: str(s?.work, 8000) })).filter((s) => s.work).slice(0, 12),
    summary: str(solution?.summary, 1000),
  };
}

function normalizeGenerated(data) {
  const problem = normalizeProblem(data?.problem);
  if (problem.text.length < 5) throw Object.assign(new Error('모델이 문제 본문을 만들지 않았습니다.'), { status: 422 });
  if (problem.choices.length && !problem.answer) throw Object.assign(new Error('모델이 정답 번호를 주지 않았습니다.'), { status: 422 });
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
  if (hasSolution && headingReads.length === 2 && headingReads[0].length && headingReads[0].length === headingReads[1].length) {
    result.stepHeadings = headingReads[0];
    result.solutionStepCount = headingReads[0].length;
  } else if (hasSolution) {
    result.uncertainties.push('해설 단계 제목 재판독 두 번의 결과가 달라 STEP 수를 교차 확인하지 못했습니다.');
  }
  if (questions.length < 2) { result.uncertainties.push('발문 재판독을 끝내지 못해 교차 확인을 건너뛰었습니다.'); return; }
  const [a, b] = questions;
  // Question: fix words that both focused reads read differently from the first pass (one-letter slips).
  const lines = result.problem.text.split('\n');
  const qIndex = lines.map((l, i) => [i, harness.hangulFixes(l, a, b, ctx.readingPairs).length || 0, (harness.plain(l).match(/[가-힣]+/g) || []).length]).filter(([, , n]) => n > 0);
  const target = qIndex.map(([i]) => i).reverse().find((i) => /[?？]|은\?|는\?|것은|인가/.test(lines[i])) ?? qIndex.map(([i]) => i).pop();
  if (target === undefined) return;
  const fixes = harness.hangulFixes(lines[target], a, b, ctx.readingPairs);
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
      system: prompts.SOLVE_SYSTEM, text: prompts.solveText({ item, material, rules, compareOriginal }),
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
    rules: arr(data?.rules).map((r) => ({ id: str(r?.id, 40), ok: r?.ok !== false, note: str(r?.note, 400) })).filter((r) => r.id),
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
      system: prompts.SOLUTION_REVIEW_SYSTEM, text: prompts.solutionReviewText({ item, material, rules }),
    }));
  } catch (e) {
    if (e.name !== 'LlmFormatError') throw e;
    return { steps: [], rules: [], error: e.message };
  }
  // Only what deviates comes back with words: the STEPs with issues, the rules broken (kept ones by id), which keeps
  // the reviewer's answer short (2026-10-03: review and rewrite were about half of a set's tokens). The older shape
  // (every STEP and rule with ok and a note) is still read.
  const ruleList = Array.isArray(data?.rules) ? data.rules
    : [...arr(data?.rules?.kept).map((id) => ({ id, ok: true })), ...arr(data?.rules?.broken).map((r) => ({ ...r, ok: false }))];
  return {
    steps: arr(data?.steps).map((s) => ({ step: Number.parseInt(s?.step, 10) || 0, ok: s?.ok === true ? true : !arr(s?.issues).length, issues: arr(s?.issues).map((x) => str(x, 400)).filter(Boolean).slice(0, 6) })),
    rules: ruleList.map((r) => (typeof r === 'string' ? { id: r, ok: true } : r)).map((r) => ({ id: str(r?.id, 40), ok: r?.ok !== false, note: str(r?.note, 400) })).filter((r) => r.id),
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
const designedRows = (text, vocab) => tableRows(text).filter((r) => !r.sig.split(',').every((v) => vocab.has(v)));

/** Experiment rows whose given amounts match the original's or (for the final problem) an earlier problem's. */
function numbersReused(item, prior, material) {
  const vocab = readingVocabulary(material);
  const mine = designedRows(item.problem.text, vocab);
  if (!mine.length) return [];
  const notes = [];
  const compare = (text, whose) => {
    const theirs = new Set(designedRows(text, vocab).map((r) => r.sig));
    for (const r of mine) if (theirs.has(r.sig)) notes.push(`${whose}의 실험 수치(${r.sig})를 그대로 썼습니다 (${r.label} 행).`);
  };
  compare(material.problem.text, '원본');
  if (item.stage.kind === 'twin') for (const other of prior) if (other.problem && other.index !== item.index) compare(other.problem.text, `앞 문제(${other.label})`);
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
function missingValues(outline, solution) {
  const text = flat(solution.steps.map((s) => s.work).join('\n') + '\n' + solution.summary);
  const values = new Set();
  for (const s of outline.steps) {
    for (const m of String(s.work).matchAll(/\$([^$]+)\$/g)) {
      const v = flat(m[1].split('=').pop());
      if (/\d/.test(v) && v.length <= 24) values.add(v);
    }
  }
  return [...values].filter((v) => !text.includes(v));
}

/** The job's own model writes the outline out as a full solution; returns warnings for the teacher. */
async function writeSolution(ctx, item, material, rules, fixes = []) {
  ctx.log(`${item.label}: 해설 풀어 쓰는 중${fixes.length ? ` (고칠 점 ${fixes.length}건)` : ''}`);
  let written = null;
  let missing = [];
  for (let attempt = 0; attempt < 2 && (!written || missing.length); attempt++) {
    const notes = [...fixes, ...missing.map((v) => `출제자 요지의 값 ${v}가 해설에 없습니다. 요지의 판정과 값을 그대로 쓴다.`)];
    let data;
    try {
      ({ data } = await ctx.llm.json({
        // With thinking off, Qwen 3.6 copied the outline instead of rewriting it in the teacher's format.
        purpose: 'write-solution', jobId: ctx.job.id, budget: ctx.budget, signal: ctx.signal, effort: ctx.effort.solve, maxTokens: 20000,
        system: prompts.WRITE_SOLUTION_SYSTEM, text: prompts.writeSolutionText({ item, material, rules, outline: item.outline, fixes: notes }),
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
  item.solution = written;
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

async function verifyItem(ctx, item, material, rules, mode, prior = [], keep = null) {
  if (fitSolutionToStage(item)) ctx.log(`${item.label}: 범위 밖 STEP으로 쓴 정답 계산을 마지막 STEP에 합침`);
  const code = item.verificationSpec
    ? await codeCheck(item.verificationSpec, { answer: item.problem.answer, choiceCount: item.problem.choices.length })
    : { status: 'fail', reasons: ['검산 프로그램이 없습니다.'] };
  // For an integrated final problem the solver also sees the original, to tell a real redesign from new numbers.
  const integratedFinal = item.stage.kind === 'twin' && mode === 'integrated';
  // A rewrite of the solution alone keeps the problem, so the solve (and its adjudication) is not repeated.
  const blind = keep?.blind || await blindSolve(ctx, item, material, rules, integratedFinal);
  const solutionReview = await reviewSolution(ctx, item, material, rules);
  const lean = Boolean(ctx.lean);
  const hard = [];
  const soft = [];
  const rewriteNotes = [];
  // Faults that make the problem unusable: the server's calculation fails, or the independent solver gets another
  // answer or finds it ambiguous, contradictory, short of a condition or giving away its conclusion.
  const invalid = [];
  let adjudication = keep?.adjudication || null;
  if (code.status === 'fail') invalid.push(...code.reasons.map((r) => '코드 검산: ' + r));
  soft.push(...(code.warnings || []));
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
    if (item.stage.kind === 'twin' && cov.expected.some((n) => !cov.used.includes(n))) hard.push(...cov.notes.filter((n) => n.includes('없이')));
    soft.push(...cov.notes);
  }
  // Code checks carried over from v1's quality harness (teacher method, choices, O/X consistency, clue leak, format).
  const codeChecks = harness.inspectItem(material, item, mode);
  const failed = codeChecks.filter((x) => x.state === 'fail');
  for (const c of failed) {
    if (solutionOnly(c) && c.severity !== 'hard') rewriteNotes.push(`${c.label}: ${c.evidence}`);
    else if (c.severity === 'hard') { hard.push(`${c.label}: ${c.evidence}`); invalid.push(`${c.label}: ${c.evidence}`); }
    else soft.push(`${c.label}: ${c.evidence}`);
  }
  const reviewNotes = solutionReview.steps.flatMap((s) => s.issues.map((x) => `해설이 선생님 해설과 다름 (STEP ${s.step}): ${x}`));
  rewriteNotes.push(...reviewNotes);
  // Teacher feedback: problems carried conditions nothing used, and the "integrated" final only changed numbers.
  const designNotes = [
    ...(lean ? [] : blind.conditions.filter((c) => !c.used && !isPremise(c.text)).map((c) => `풀이에 쓰이지 않는 조건: ${c.text}`)),
    ...(!lean && integratedFinal && blind.variation === 'numbers-only' ? [`통합 변형인데 원본에서 숫자만 바뀌었습니다. ${blind.variationNote}`.trim()] : []),
    ...(item.stage.kind === 'twin' ? repeatsPrior(item, prior) : []),
    ...numbersReused(item, prior, material),
    ...failed.filter((c) => c.severity === 'design' && !solutionOnly(c)).map((c) => `${c.label}: ${c.evidence}`),
  ];
  soft.push(...designNotes);
  const ruleResults = rules.map((r) => {
    const self = item.appliedRules.find((a) => a.id === r.id);
    // Problem rules are judged by the independent solver, solution rules by the solution reviewer.
    const byReviewer = solutionReview.rules.find((b) => b.id === r.id);
    const judged = blind.rules.find((b) => b.id === r.id) || byReviewer;
    // A rule the independent reviewer finds broken is sent back for repair like any other design fault (in a lean
    // run a solution rule goes back to the writer, and a problem rule judged by the solver is only recorded).
    if (judged && !judged.ok) {
      const note = `교사 지침 미준수: ${r.text.slice(0, 80)} — ${judged.note}`;
      if (judged === byReviewer) rewriteNotes.push(note);
      else if (!lean) designNotes.push(note);
    }
    return { id: r.id, text: r.text, target: r.target, how: self?.how || '', judged: judged ? { ok: judged.ok, note: judged.note } : null };
  });
  return {
    hard, invalid, soft, coverageNotes: cov.notes, designNotes, rewriteNotes,
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

// The fields one version of a problem consists of: kept per design so the best one can be put back.
const VERSION_KEYS = ['problem', 'solution', 'outline', 'usesSteps', 'designNote', 'appliedRules', 'verificationSpec'];
const versionOf = (item) => Object.fromEntries(VERSION_KEYS.filter((k) => item[k] !== undefined).map((k) => [k, item[k]]));
// A design with fewer faults that make it unusable wins; then fewer design faults; then fewer solution notes.
const faultScore = (r) => r.check.invalid.length * 1000 + r.reasons.length * 10 + r.check.rewriteNotes.length;

/** One design of a problem: generated, checked, repaired (problem) and rewritten (solution) until it passes or stops
 *  getting better. Mutates `item`; returns its version, the last check and what is still wrong. */
async function designOnce(ctx, { material, item, prior, rules, mode, extraFeedback, previous, examples, design }) {
  const total = material.steps.length;
  const lean = Boolean(ctx.lean);
  item.status = 'generating'; item.error = ''; ctx.save();
  ctx.log(`${item.label}: 문제 설계 중${design > 1 ? ` (${design}번째 설계)` : ''}`);
  const { data, shapeFixes: generateShape = [] } = await ctx.llm.json({
    purpose: 'generate', jobId: ctx.job.id, budget: ctx.budget, signal: ctx.signal, effort: ctx.effort.generate, maxTokens: 64000,
    system: prompts.GENERATE_SYSTEM,
    text: prompts.generateText({ material, stage: item.stage, total, mode, prior, rules, variantNo: item.variantNo, extraFeedback, previous, examples, usedRows: usedRowsFor(item, prior, material, examples) }) + (lean ? prompts.LEAN_DESIGN : ''),
  });
  if (generateShape.length) ctx.log(`${item.label}: 응답 JSON 구조 보정 (${generateShape.join(', ')})`);
  Object.assign(item, normalizeGenerated(data));
  item.attempts.push({ kind: 'generate', design, at: new Date().toISOString() });
  // Lean run: what the designer wrote is the outline; the job's own model writes it out as the solution.
  let writeNotes = [];
  if (lean) { item.outline = item.solution; writeNotes = await writeSolution(ctx, item, material, rules); }
  item.status = 'verifying'; ctx.save();

  let check = await verifyItem(ctx, item, material, rules, mode, prior);
  // In a lean run the solver's STEP tagging does not send the problem back (see verifyItem).
  const repairReasons = (c) => [...c.hard, ...(lean ? [] : c.coverageNotes.map((n) => 'STEP 범위: ' + n)), ...c.designNotes.map((n) => '문제 설계: ' + n)];
  // Up to ctx.maxRepairs repairs, a further one only when the previous one changed what is wrong (the same complaints
  // twice means the model is stuck: a fresh design does better). The solution alone is rewritten up to twice.
  const same = (x, y) => x.length === y.length && x.every((v, i) => v === y[i]);
  let lastRepair = null;
  let rewrites = 0;
  for (let round = 0; ;) {
    if (ctx.signal?.aborted) break;
    // A fault only in the solution (wording, the teacher's sentence frame, a solution rule) is rewritten by the writer
    // — no redesign, no new solve. Outside a lean run the current solution is what gets rewritten.
    if (check.rewriteNotes.length && !repairReasons(check).length && rewrites < (ctx.maxRewrites ?? 2) && (!ctx.budget.affords || ctx.budget.affords(2 + (ctx.reserveCalls || 0)))) {
      rewrites++;
      item.attempts.push({ kind: 'rewrite', design, at: new Date().toISOString(), failures: check.rewriteNotes });
      if (!lean) item.outline = item.solution;
      writeNotes = await writeSolution(ctx, item, material, rules, check.rewriteNotes);
      const before = check.rewriteNotes;
      check = await verifyItem(ctx, item, material, rules, mode, prior, { blind: check.verification.blind, adjudication: check.verification.adjudication });
      if (same(before, check.rewriteNotes)) rewrites = Infinity; // the same notes again: rewriting more will not help
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
    const purpose = lean ? 'repair-lean' : 'repair';
    ctx.log(`${item.label}: 검토에서 발견된 ${lastRepair.length}건 수정 중${ctx.routes?.[purpose] ? ` (${ctx.routes[purpose]})` : ''}`);
    const { data: fixed, shapeFixes: repairShape = [] } = await ctx.llm.json({
      purpose, jobId: ctx.job.id, budget: ctx.budget, signal: ctx.signal, effort: ctx.effort.generate, maxTokens: 64000,
      system: prompts.REPAIR_SYSTEM,
      // A lean repair sees the designer's own outline (not the long written solution) and returns only what changed.
      text: prompts.repairText({ material, stage: item.stage, total, mode, rules, item: lean ? { ...item, solution: item.outline } : item, failures: lastRepair, blind: check.verification.blind })
        + (lean ? prompts.LEAN_REPAIR : ''),
    });
    if (repairShape.length) ctx.log(`${item.label}: 응답 JSON 구조 보정 (${repairShape.join(', ')})`);
    if (lean) {
      const kept = { problem: item.problem, solution: item.outline, usesSteps: item.usesSteps, designNote: item.designNote, appliedRules: item.appliedRules, verification: item.verificationSpec };
      const changed = Object.fromEntries(Object.entries(fixed || {}).filter(([k, v]) => k in kept && v != null && v !== ''));
      Object.assign(item, normalizeGenerated({ ...kept, ...changed }));
      item.outline = item.solution;
      writeNotes = await writeSolution(ctx, item, material, rules);
      rewrites = 0;
    } else {
      // Local models often return only the fixed problem; what they leave out (how each rule was kept, the design
      // note) stays from the previous version instead of being wiped.
      const next = normalizeGenerated(fixed);
      for (const key of ['designNote', 'appliedRules', 'usesSteps']) if (!next[key]?.length && item[key]?.length) next[key] = item[key];
      Object.assign(item, next);
      rewrites = 0;
    }
    item.status = 'verifying'; ctx.save();
    check = await verifyItem(ctx, item, material, rules, mode, prior);
  }
  return { version: versionOf(item), check, writeNotes, reasons: repairReasons(check), design };
}

/** Makes one problem without stopping for the teacher: up to ctx.maxDesigns designs (each repaired and rewritten), the
 *  best one kept. What was found and fixed along the way is in item.attempts (the report); what is still left is in
 *  item.problems (the answer cannot be trusted) or item.warnings (the problem is usable). Mutates `item`. */
async function produceItem(ctx, { material, item, prior, rules, mode, extraFeedback, previous, examples: allExamples = [] }) {
  const examples = examplesFor(item, allExamples);
  item.examplesUsed = examples.length;
  item.attempts = [];
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
      ctx.log(`${item.label}: 고쳐도 ${best.reasons.length}건이 남아 새로 설계합니다`);
      item.attempts.push({ kind: 'redesign', design, at: new Date().toISOString(), failures: left.problems });
      item.redesigned = design - 1;
    }
    const result = await designOnce(ctx, { material, item, prior, rules, mode, extraFeedback, previous: left, examples, design });
    if (!best || faultScore(result) < faultScore(best)) best = result;
    if (!result.reasons.length) break;
    left = { problem: item.problem, solution: item.solution, problems: result.reasons };
  }
  // The best design is the one kept.
  Object.assign(item, best.version);
  const check = best.check;
  item.verification = check.verification;
  item.design = best.design;
  // Only a problem whose answer cannot be trusted is held back for the teacher; anything else the checks could not fix
  // is listed with the problem as 남은 점.
  item.problems = [...new Set(check.invalid)];
  item.warnings = [...new Set([
    ...best.reasons.filter((r) => !check.invalid.some((x) => r.endsWith(x))),
    ...check.soft.filter((w) => !check.coverageNotes.includes(w) && !check.designNotes.includes(w) && !check.invalid.includes(w)),
    ...check.rewriteNotes.map((n) => '해설: ' + n), ...best.writeNotes,
  ])];
  item.status = item.problems.length ? 'needs_review' : item.warnings.length ? 'warning' : 'passed';
  const fixes = item.attempts.filter((x) => x.kind !== 'generate').length;
  ctx.log(`${item.label}: ${{ passed: '완성', warning: `완성 (남은 점 ${item.warnings.length}개)`, needs_review: '정답을 확정하지 못함' }[item.status]}${fixes ? ` — 자동 수정 ${fixes}번${item.redesigned ? `, 새 설계 ${item.redesigned}번` : ''}` : ''}`);
  ctx.save();
}

// After a set: what its checks found becomes at most three learning items (this problem's or every problem's), so the
// next set avoids it from the start. Recorded on the job for its report. A failure here never fails the set.
async function learnFromSet(ctx) {
  const { job, store } = ctx;
  const faults = [];
  for (const item of job.items) {
    const seen = new Set();
    const left = new Set([...(item.problems || []), ...(item.warnings || [])]);
    for (const a of item.attempts || []) for (const f of a.failures || []) {
      const text = String(f).replace(/^(문제 설계|STEP 범위|해설): /, '');
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

async function runGeneration(ctx) {
  const { job, store } = ctx;
  const material = job.material;
  const rules = job.rules;
  // What the teacher adopted from earlier sets of this original (examples for the same stages).
  const examples = adoptedExamples(store, job.materialId, {});
  for (const item of job.items) {
    if (ctx.signal.aborted) throw new Error('작업이 취소되었습니다.');
    if (['passed', 'warning', 'needs_review'].includes(item.status)) continue; // resume keeps finished work
    const prior = job.items.filter((x) => x.index < item.index && x.problem);
    try {
      // Budget kept for the problems still to come (generate + solve each), so repairs of an early practice
      // problem never starve the final problem.
      ctx.reserveCalls = job.items.filter((x) => x.index > item.index && !['passed', 'warning', 'needs_review'].includes(x.status)).length * 3;
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
    { label: '원본 정답 검산', how: '원본을 해설대로 계산하는 프로그램을 정확한 분수로 실행해 옮겨 적은 수치와 정답이 맞는지 본다. 프로그램이 실행되지 않으면 오류를 보여 주고 한 번 고치게 한다.', onFail: 'fix' },
  ],
  generation: [
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
  harnessStats, ON_FAIL, cleanHeading, isPremise, learnFromSet, fitSolutionToStage, reviewSolution, writeSolution, adoptedExamples, SYSTEM_CHECKS, sourceChecks, tableRows, numbersReused, repeatsPrior, applyFixes, proposeStepAlignment, refreshStepCountNote, targetStepCount, analyzeMaterial, runGeneration, produceItem, pickRules, normalizeMaterial, normalizeGenerated, coverage };
