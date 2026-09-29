'use strict';
const prompts = require('./prompts');
const { codeCheck } = require('./verify');
const { selectRules, readingHint, readingPairs } = require('./learning');
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
  };
}

// ---------------------------------------------------------------- STEP count vs. the teacher's step markers

const STEP_COUNT_NOTE = /^(해설의 단계 표시는|교정 단계에서 해설의 STEP 표시를)/;
const markerNumber = (marker) => Number.parseInt(String(marker || '').replace(/[^0-9]/g, ''), 10) || 0;

/** How many STEPs the teacher's solution has, if the solution shows step markers. */
function targetStepCount(material) {
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
  const { data, shapeFixes: analyzeShape = [] } = await llm.json({
    purpose: 'analyze', jobId: ctx.job.id, budget, signal, vision: true, effort: 'off', maxTokens: 16000,
    system: prompts.ANALYZE_SYSTEM,
    text: withHint(prompts.analyzeText({ hasSolution: Boolean(material.images.solution), sameImage: material.images.sameImage, note: material.note })),
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
    result.steps.forEach((s, i) => { for (const k of ['title', 'work', 'result']) fields[`steps[${i}].${k}`] = s[k]; });
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
  // Printed step headings are the truest STEP titles.
  if (result.stepHeadings.length && result.stepHeadings.length === result.steps.length) {
    result.steps.forEach((s, i) => {
      const heading = result.stepHeadings[i];
      if (heading && harness.plain(heading).replace(/\s/g, '') !== harness.plain(s.title).replace(/\s/g, '')) {
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
  if (seen.length) result.uncertainties.push(`"${seen.join('", "')}"은(는) 판독에서 뒤바뀐 적이 있는 단어입니다(${hit.map((p) => p.join('↔')).join(', ')}). 원본과 같은지 확인해 주세요.`);
  if (corrections.length) result.proofread.push(`과거 교사 교정 ${corrections.length}건을 판독에 참고했습니다.`);
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
  const cleanHeading = (h) => str(h?.title ?? h, 300).replace(/^\s*(?:step|STEP)\s*\d+\s*[.:)·]?\s*/, '').replace(/[.。]\s*$/, '');
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
function usedRowsFor(item, prior, material) {
  const texts = [material.problem.text, ...(item.stage.kind === 'twin' ? prior.filter((p) => p.problem).map((p) => p.problem.text) : [])];
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
  // Code checks carried over from v1's quality harness (teacher method, choices, O/X consistency, clue leak, format).
  const codeChecks = harness.inspectItem(material, item, mode);
  for (const c of codeChecks.filter((x) => x.state === 'fail')) (c.severity === 'hard' ? hard : soft).push(`${c.label}: ${c.evidence}`);
  // Teacher feedback: problems carried conditions nothing used, and the "integrated" final only changed numbers.
  const designNotes = [
    ...blind.conditions.filter((c) => !c.used).map((c) => `풀이에 쓰이지 않는 조건: ${c.text}`),
    ...(integratedFinal && blind.variation === 'numbers-only' ? [`통합 변형인데 원본에서 숫자만 바뀌었습니다. ${blind.variationNote}`.trim()] : []),
    ...(item.stage.kind === 'twin' ? repeatsPrior(item, prior) : []),
    ...numbersReused(item, prior, material),
    ...codeChecks.filter((c) => c.state === 'fail' && c.severity === 'design').map((c) => `${c.label}: ${c.evidence}`),
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
      harness: codeChecks,
      rules: ruleResults,
    },
  };
}

/** Generates, checks, and (at most once) repairs one problem. Mutates `item` and saves progress. */
async function produceItem(ctx, { material, item, prior, rules, mode, extraFeedback, previous }) {
  const total = material.steps.length;
  item.status = 'generating'; item.error = ''; ctx.save();
  ctx.log(`${item.label}: 문제 설계 중`);
  const { data, shapeFixes: generateShape = [] } = await ctx.llm.json({
    purpose: 'generate', jobId: ctx.job.id, budget: ctx.budget, signal: ctx.signal, effort: ctx.effort.generate, maxTokens: 64000,
    system: prompts.GENERATE_SYSTEM,
    text: prompts.generateText({ material, stage: item.stage, total, mode, prior, rules, variantNo: item.variantNo, extraFeedback, previous, usedRows: usedRowsFor(item, prior, material) }),
  });
  if (generateShape.length) ctx.log(`${item.label}: 응답 JSON 구조 보정 (${generateShape.join(', ')})`);
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
    // A repair costs a repair and a new solve; skip it when that would leave too little for the later problems.
    if (ctx.budget.affords && !ctx.budget.affords(2 + (ctx.reserveCalls || 0))) {
      ctx.log(`${item.label}: 남은 문제를 만들 토큰을 남기려고 수정을 건너뜁니다`);
      check.soft.push('토큰 상한 때문에 자동 수정을 건너뛰었습니다. 교사 검토가 필요합니다.');
      break;
    }
    item.attempts.push({ kind: 'repair', at: new Date().toISOString(), failures: repairReasons(check) });
    item.status = 'repairing'; item.verification = check.verification; ctx.save();
    ctx.log(`${item.label}: 검토에서 발견된 ${repairReasons(check).length}건 수정 중`);
    const { data: fixed, shapeFixes: repairShape = [] } = await ctx.llm.json({
      purpose: 'repair', jobId: ctx.job.id, budget: ctx.budget, signal: ctx.signal, effort: ctx.effort.generate, maxTokens: 64000,
      system: prompts.REPAIR_SYSTEM,
      text: prompts.repairText({ material, stage: item.stage, total, mode, rules, item, failures: repairReasons(check), blind: check.verification.blind }),
    });
    if (repairShape.length) ctx.log(`${item.label}: 응답 JSON 구조 보정 (${repairShape.join(', ')})`);
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
      // Budget kept for the problems still to come (generate + solve each), so repairs of an early practice
      // problem never starve the final problem.
      ctx.reserveCalls = job.items.filter((x) => x.index > item.index && !['passed', 'warning', 'needs_review'].includes(x.status)).length * 2;
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
  // The problem a feedback was written about goes along: "이 조건은 불필요" means little without it.
  return selectRules(store.rules.all(), material).map((r) => ({ id: r.id, text: r.text, kind: r.kind, target: r.target, scope: r.scope,
    context: r.source?.excerpt ? `${r.source.label || '이전 생성 문제'}: ${r.source.excerpt.replace(/\s+/g, ' ').slice(0, 220)}` : '' }));
}

// What the pipeline checks and what happens on failure — shown on the 시스템 page. Keep in step with the code above.
// onFail: 'fix' = the pipeline corrects it itself, 'repair' = the problem goes back to the model once more,
// 'review' = shown to the teacher as 교사 검토 필요, 'note' = shown as 확인할 점.
const SYSTEM_CHECKS = {
  analysis: [
    { label: '원본 대조 교정', how: '옮겨 적은 문제·해설을 이미지와 글자 단위로 다시 대조해 오독(몰질량↔물질량, 숫자, 로마 숫자)을 고친다.', onFail: 'fix' },
    { label: '필기 유입 재판독', how: '해설에서 구하는 값(x=15, 2cm/ms)이 문제 본문에 있으면 문제 이미지만 인쇄 글자 기준으로 두 번 다시 읽는다. 두 번 다 있으면 인쇄된 조건으로 인정한다.', onFail: 'fix' },
    { label: '발문 재판독 (2회)', how: '발문만 따로 두 번 읽어, 두 번 일치한 글자로 첫 판독을 고친다. 알려진·교사가 고친 혼동 단어는 해설까지 함께 고친다.', onFail: 'fix' },
    { label: '해설 단계 제목 재판독 (2회)', how: '해설에 인쇄된 step 제목을 두 번 읽어 STEP 수와 제목을 정한다.', onFail: 'fix' },
    { label: 'STEP 수 맞추기', how: '정리한 STEP이 해설의 단계 수보다 많으면 이웃한 STEP을 합친다.', onFail: 'fix' },
    { label: '원본 정답 검산', how: '원본을 해설대로 계산하는 프로그램을 정확한 분수로 실행해 옮겨 적은 수치와 정답이 맞는지 본다. 프로그램이 실행되지 않으면 오류를 보여 주고 한 번 고치게 한다.', onFail: 'review' },
    { label: '혼동 단어 확인', how: '뒤바뀐 적이 있는 단어(기본 목록 + 교사 교정 기억)가 나오면 원본 확인 항목에 올린다.', onFail: 'note' },
  ],
  generation: [
    { label: '코드 검산', how: '생성 모델이 함께 쓴 검산 프로그램을 서버가 정확한 분수로 실행: 정답 값이 선택지 하나와만 맞는지, 설계 조건(가정→모순 등)이 참인지.', onFail: 'repair' },
    { label: '독립 풀이', how: '정답을 모르는 별도 호출이 문제만 보고 풀어 정답을 대조하고, 모호·모순·조건 부족·결론 노출을 지적한다.', onFail: 'repair' },
    { label: 'STEP 범위', how: '독립 풀이에 원본 STEP 기법 중 무엇이 꼭 필요했는지로, 목표 범위(STEP 1, STEP 1~2, 전체)와 맞는지 본다.', onFail: 'repair' },
    { label: '안 쓰인 조건', how: '독립 풀이가 문제의 조건을 하나씩 나열해 풀이에 썼는지 표시한다. 안 쓰인 조건이 있으면 설계 결함.', onFail: 'repair' },
    { label: '통합 변형 여부', how: '통합 모드의 최종 문제를 원본과 비교해 숫자만 바꿨는지(독립 판정 + 코드 골격 비교) 본다.', onFail: 'repair' },
    { label: '숫자·질문 재사용', how: '표의 설계 수치가 원본·앞 문제와 같은지, 최종 문제의 질문이 앞 문제와 같은지 본다. 그래프에서 읽는 값(막전위 등)은 제외.', onFail: 'repair' },
    { label: '교사 풀이 방법 (v1 하네스)', how: '원본 해설의 보조 문자·STEP별 도입 순서·가정→모순 판정이 변형 해설에 그대로 있는지 코드로 확인.', onFail: 'repair' },
    { label: '보기·정답 연결, O/X 일관성', how: '보기 수·중복·정답 번호, ㄱㄴㄷ 해설의 참 판정과 정답 보기가 맞는지 코드로 확인.', onFail: 'review' },
    { label: '결론 노출·표기 형식', how: '앞 STEP의 결론을 표에 미리 준 경우, 표 칸 수·수식 표기 오류를 코드로 확인.', onFail: 'repair' },
    { label: '교사 지침 준수', how: '생성 모델이 지침별로 적용 방법을 적고, 독립 풀이가 문제에 관한 지침을 다시 판정한다.', onFail: 'note' },
  ],
  repair: '발견된 문제를 모델에 보여 주고 최대 2번 수정한다. 같은 지적이 반복되면 멈추고, 뒤에 만들 문제의 토큰이 부족해질 것 같으면 수정을 건너뛴다. 남은 문제는 교사 검토 필요 또는 확인할 점으로 표시한다.',
};

module.exports = { SYSTEM_CHECKS, sourceChecks, tableRows, numbersReused, repeatsPrior, applyFixes, proposeStepAlignment, refreshStepCountNote, targetStepCount, analyzeMaterial, runGeneration, produceItem, pickRules, normalizeMaterial, normalizeGenerated, coverage };
