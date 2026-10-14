'use strict';
// Code checks carried over from v1's ProblemQualityHarness / TeacherMethodPolicy / VariantDesignPolicy /
// ExplanationConsistencyCheck, rewritten for v2's data and made subject-independent where v1 was not.
// Each check returns { id, label, state: 'pass'|'fail', evidence, severity: 'hard'|'design' }:
//   hard   → the problem is wrong (goes to teacher review if the repair does not fix it)
//   design → the problem works but breaks a teacher/design rule (triggers the repair, then stays a warning)

const nerveTable = require('./nerve');
const molar = require('./molar');

/** Math-insensitive plain text: \ce{A} → A, \text{x} → x, \frac{a}{b} → a/b, $ removed. */
function plain(text) {
  return String(text || '')
    .replace(/\\(?:ce|text|mathrm|mathbf)\s*\{([^{}]*)\}/g, '$1')
    .replace(/\\d?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, '$1/$2')
    .replace(/\\[,;:! ]/g, ' ')
    .replace(/\$/g, '');
}

const result = (id, label, ok, evidence, severity = 'design') => ({ id, label, state: ok ? 'pass' : 'fail', evidence, severity });

// ---------------------------------------------------------------- teacher method (v1 TeacherMethodPolicy)

/** Letters the teacher defines to simplify the solution ("A w g의 양(mol)을 n", "…을 m이라 하면"). */
function helperVariables(text) {
  const t = plain(text);
  const found = [];
  for (const m of t.matchAll(/양\s*\(\s*mol\s*\)\s*을\s*([a-z])(?![A-Za-z])/g)) found.push(m[1]);
  for (const m of t.matchAll(/(?:을|를)\s*([a-z])\s*(?:,|이라|라고|라 하|으로\s*(?:놓|두)|로\s*(?:놓|두))/g)) found.push(m[1]);
  for (const sentence of t.split(/[\n。]|(?<!\d)\.(?!\d)/)) {
    if (!/이라|라고|으로\s*(?:놓|두|정)|로\s*(?:놓|두|정)/.test(sentence)) continue;
    for (const m of sentence.matchAll(/(?<![A-Za-z])([a-z])\s*(?:mol|몰)(?![A-Za-z])/g)) found.push(m[1]);
  }
  return [...new Set(found)];
}

/**
 * The teacher's choice heading ("| 선택지 분석 |", as the reading has it) before a solution's closing choice lines, when
 * the teacher's last STEP has one and the solution left it out. Any original: the line is the teacher's own from the
 * reading. Qwen 3.8 left it out of a final twice and each cost a judge round (2026-10-13, molar mass rounds 2 and 4).
 * Returns true when it added the heading.
 */
function teacherChoiceHeading(material, item) {
  const steps = material.steps || [];
  const box = String(steps[steps.length - 1]?.work || '').split('\n').map((l) => l.trim()).find((l) => /선택지 분석/.test(l));
  const last = item.solution?.steps?.[item.solution.steps.length - 1];
  if (!box || !last?.work) return false;
  const lines = String(last.work).split('\n');
  if (lines.some((l) => /선택지 분석/.test(l))) return false;
  const at = lines.findIndex((l) => /^\s*([①②③④⑤]|정답은)/.test(l));
  if (at < 0) return false;
  const blank = at > 0 && lines[at - 1].trim() ? [''] : [];
  last.work = [...lines.slice(0, at), ...blank, box, ...lines.slice(at)].join('\n');
  return true;
}

/*
 * The teacher's sentence frames: each line of the teacher's solution with its problem-specific parts as {이름} slots,
 * extracted once per original by the job's model (purpose extract-frames) and kept only where the frame matches the
 * teacher's own line. A variant's solution is then held to them by code — the judge's most frequent notes on Qwen's
 * solutions were frame slips (two sentences joined, "반응 후" added, "모두 반응하고" rewritten), 2026-10-13 rounds 1–4.
 */
// "$\ce{A(g)}$" and "A(g)" are the same words to a reader (the readings differ in this): compared without \ce.
const frameLine = (l) => String(l || '').replace(/\$\\ce\{([^{}]*)\}\$/g, '$1').replace(/\\ce\{([^{}]*)\}/g, '$1').replace(/\s+/g, ' ').trim();
// Not held to a frame: table rows, a line of formulas only (a proportion, the choice's own numbers — the teacher's has
// other numbers in it, so its frame is all slots), and the closing choice and answer lines (teacherChoiceHeading).
const frameSkip = (l) => !l || /^\|.*\|$/.test(l) || /^\|?\s*-{3}/.test(l) || /^([①②③④⑤]|정답은)/.test(l)
  || String(l).replace(/\$[^$]*\$/g, '').replace(/[^가-힣]/g, '').length < 4;
function frameRegex(frame) {
  const parts = String(frame).split(/《[^《》]{1,20}》/);
  return new RegExp(`^${parts.map((p) => frameLine(p).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s*')).join('(.+?)')}$`);
}
/** Frames worth holding a line to: enough fixed words that a frame is not "anything". */
function frameFixed(frame) {
  return frameLine(String(frame).replace(/《[^《》]{1,20}》/g, '')).replace(/[\s$\\{}()^_.,]/g, '').length;
}
/** The extracted frames kept: those that match a line of their own STEP of the teacher's solution. */
function validateFrames(material, extracted) {
  const out = [];
  for (const s of extracted?.steps || []) {
    const i = Number(s.step) - 1;
    // Every line but the table's: formula lines and the closing lines have frames too (round 10's mass-conservation
    // line had none, and Qwen's own wording of it broke the $ pairs).
    const lines = String(material.steps?.[i]?.work || '').split('\n').map(frameLine).filter((l) => l && !/^\|.*\|$/.test(l) && !/^\|?\s*-{3}/.test(l));
    // Every slot of a frame gets its own name: a frame with "《물질》 … 《물질》 … 《질량》 … 《질량》" (round 8) left the
    // writer no way to say which value goes where. Slots are 《…》: {…} took the braces of \text{C의 몰질량} (round 11).
    const unique = (f) => {
      const all = [...f.matchAll(/《([^《》]{1,20})》/g)].map((m) => m[1].replace(/\d+$/, ''));
      const seen = {};
      return f.replace(/《([^《》]{1,20})》/g, (m, name) => {
        const base = name.replace(/\d+$/, '');
        seen[base] = (seen[base] || 0) + 1;
        return all.filter((x) => x === base).length > 1 ? `《${base}${seen[base]}》` : `《${base}》`;
      });
    };
    const frames = [...new Set((s.frames || []).map(frameLine).map(unique))].filter((f) => f && frameFixed(f) >= 6 && lines.some((l) => frameRegex(f).test(l)));
    if (frames.length) out.push({ step: i + 1, frames, lines: lines.length, covered: lines.filter((l) => frames.some((f) => frameRegex(f).test(l))).length });
  }
  return out;
}
/** The teacher's lines (tables aside) that none of the kept frames matches: [{ step, line }]. */
function uncoveredLines(material) {
  const out = [];
  (material.steps || []).forEach((s, i) => {
    const mine = (material.frames || []).find((f) => f.step === i + 1)?.frames || [];
    for (const line of String(s.work || '').split('\n').map(frameLine)) {
      if (!line || /^\|.*\|$/.test(line) || /^\|?\s*-{3}/.test(line)) continue;
      if (!mine.some((f) => frameRegex(f).test(line))) out.push({ step: i + 1, line });
    }
  });
  return out;
}

/**
 * Lines of a solution that follow none of its STEP's teacher frames, each with the nearest frame — for the designer to
 * fix before the judge reads it. STEPs without frames are not checked. A line of the choice analysis or the answer is
 * held to the frames too (the teacher's closing lines are frames like any other).
 */
function frameFindings(material, item, limit = 8) {
  const frames = material.frames || [];
  if (!frames.length) return [];
  const out = [];
  for (const [k, step] of (item.solution?.steps || []).entries()) {
    const no = Number(step.step) || k + 1;
    const mine = frames.find((f) => f.step === no);
    if (!mine) continue;
    for (const line of String(step.work || '').split('\n').map(frameLine)) {
      if (frameSkip(line) || mine.frames.some((f) => frameRegex(f).test(line))) continue;
      const literal = (f) => frameLine(f.replace(/《[^《》]{1,20}》/g, ''));
      const near = [...mine.frames].sort((a, b) => editDistance(literal(a), line) - editDistance(literal(b), line))[0];
      out.push(`해설 STEP ${no}의 문장이 선생님 문장 틀과 다릅니다: "${line.slice(0, 160)}" — 가장 가까운 선생님 틀: "${near}" (《…》에는 이 문제의 값을 넣고 나머지 글자는 틀 그대로 쓴다)`);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

/**
 * The solution laid out by the system, not by the model (the user, 2026-10-13: the model decides what the solution
 * says; lines, frames, headings and titles are the system's): a line the writer gave as "[틀 1-3] 실험=Ⅱ; 질량1=5w"
 * becomes the teacher's frame 3 of STEP 1 with those values; a STEP title worded otherwise gets the teacher's words with
 * the writer's experiment numbers; the teacher's choice heading goes before the closing lines. Lines the writer wrote
 * out themselves stay as written. Returns what it could not fill (a frame number that does not exist, a slot with no
 * value) — content for the writer, never wording.
 */
const FRAME_REF = /^\s*\[틀\s*(\d+)\s*[-–.]\s*(\d+)\]\s*(.*)$/;
const ROMAN = /Ⅰ|Ⅱ|Ⅲ|Ⅳ|Ⅴ/g;
function renderFrames(material, item) {
  const missing = [];
  const frames = material.frames || [];
  for (const step of item.solution?.steps || []) {
    const lines = String(step.work || '').split('\n').map((line) => {
      const m = FRAME_REF.exec(line);
      if (!m) return line;
      const frame = frames.find((f) => f.step === Number(m[1]))?.frames[Number(m[2]) - 1];
      if (!frame) { missing.push(`해설 STEP ${step.step}: [틀 ${m[1]}-${m[2]}]은 없는 틀 번호입니다.`); return m[3]; }
      const values = {};
      for (const part of m[3].split(/\s*;\s*/)) {
        const kv = /^[《{]?([^=》}]+?)[》}]?\s*=\s*(.*)$/.exec(part.trim());
        if (kv) values[kv[1].trim()] = kv[2].trim().replace(/^\$+|\$+$/g, '');
      }
      const empty = [];
      // A value goes in as the frame has it: inside the frame's $…$ as it is, outside them a formula gets its own $…$
      // (a frame whose slot held "$5w$" whole, round 11).
      const text = frame.replace(/《([^《》]{1,20})》/g, (all, name, at) => {
        const v = values[name];
        if (v == null || v === '') { empty.push(name); return all; }
        const inMath = (frame.slice(0, at).match(/\$/g) || []).length % 2 === 1;
        return !inMath && /[0-9\\^_=]|^[a-z]$/.test(v) && !/^[①-⑤Ⅰ-Ⅴ]$/.test(v) ? `$${v}$` : v;
      });
      // An unfilled frame stays the writer's reference line, to be filled on the next pass (never half a sentence).
      if (empty.length) { missing.push(`해설 STEP ${step.step}: [틀 ${m[1]}-${m[2]}]에 ${empty.map((x) => `《${x}》`).join(', ')} 값이 없습니다. 틀의 자리 이름 그대로 "자리=값"을 모두 쓴다.`); return line; }
      return text.replace(/\s+(에서|에서는|에서의)(?=\s|$)/g, '$1');
    });
    // Fractions as the teacher writes them: Qwen 3.8 wrote 24/7w and 21w/2 inside $…$ (round 10).
    step.work = lines.join('\n').replace(/\$[^$\n]*\$/g, (math) => math
      .replace(/(?<![\w{])(\d+)\s*\/\s*(\d+)\s*([a-z])(?![\w}])/g, '\\frac{$1}{$2}$3')
      .replace(/(?<![\w{])(\d+)\s*([a-z])\s*\/\s*(\d+)(?![\w}])/g, '\\frac{$1}{$3}$2')
      .replace(/(?<![\w{])(\d+)\s*\/\s*(\d+)(?![\w}])/g, '\\frac{$1}{$2}'));
    const original = material.steps?.[step.step - 1]?.title;
    if (original && step.title && titleKey(step.title) !== titleKey(original)) {
      const mine = String(step.title).match(ROMAN) || [];
      const theirs = String(original).match(ROMAN) || [];
      let k = 0;
      step.title = mine.length === theirs.length ? String(original).replace(ROMAN, () => mine[k++]) : original;
    }
  }
  teacherChoiceHeading(material, item);
  return missing;
}

/** Original STEPs a stage uses (1-based). */
function stageSteps(stage, total) {
  if (stage.kind === 'upto') return Array.from({ length: stage.upto }, (_, i) => i + 1);
  if (stage.kind === 'focus') return [stage.step];
  return Array.from({ length: total }, (_, i) => i + 1);
}

const hasLetter = (text, v) => new RegExp(`(?<![A-Za-z_\\\\])${v}(?![A-Za-z_])`).test(plain(text));

function checkHelpers(material, item) {
  const used = stageSteps(item.stage, material.steps.length);
  const helpers = [...new Set(used.flatMap((n) => helperVariables(material.steps[n - 1]?.work + '\n' + material.steps[n - 1]?.technique)))];
  if (!helpers.length) return [];
  const solution = (item.solution?.steps || []).map((s) => s.work).join('\n');
  const missing = helpers.filter((v) => !hasLetter(solution, v));
  const out = [result('source-method', '원본 풀이의 보조 문자 유지', !missing.length,
    missing.length ? `원본 해설이 정의한 ${missing.join(', ')}가 변형 해설에서 사라졌습니다. 같은 문자 정의와 계산 방법을 새 수치로 적용해야 합니다.` : `보조 문자 ${helpers.join(', ')} 유지`)];
  // Order: a letter introduced in original STEP s must not appear earlier in the generated solution.
  for (const v of helpers) {
    const introduced = material.steps.findIndex((s) => helperVariables(s.work + '\n' + s.technique).includes(v)) + 1;
    const early = (item.solution?.steps || []).find((s) => s.step && s.step < introduced && hasLetter(s.work, v));
    if (introduced && early) {
      out.push(result('source-method-order', '원본 STEP별 풀이 순서', false, `원본은 ${v}를 STEP ${introduced}에서 도입하는데 변형 해설은 STEP ${early.step}에서 먼저 씁니다.`));
    }
  }
  return out;
}

const assumes = (t) => /가정|만약/.test(t) && /모순|맞지\s*않|일치하지|성립하지|불가능/.test(t);

/** The case a solution first assumes and rules out ("만약 Ⅰ에서 A가 모두 반응했다면 … 맞지 않다"): "A", or '' when none. */
function assumedCase(text) {
  const m = /만약[^.\n]*?([A-Z])(?:\s*\([a-z]\))?\s*(?:가|이)\s*모두\s*반응했다면/.exec(plain(text));
  return m ? m[1] : '';
}

/**
 * 가정 방향 (요구서 1): asked to keep or flip which case the teacher's STEP 1 assumes and rules out, the variant's first
 * STEP must assume the same case (same) or the other one (flip). Not checked when either solution does not say.
 */
function checkDirection(material, item, direction) {
  if (!['same', 'flip'].includes(direction) || !stageSteps(item.stage, material.steps.length).includes(1)) return [];
  const original = assumedCase(material.steps[0]?.work);
  const variant = assumedCase((item.solution?.steps || []).filter((s) => s.step === 1).map((s) => s.work).join('\n'));
  if (!original || !variant) return [];
  const ok = direction === 'same' ? variant === original : variant !== original;
  return [result('assumption-direction', '가정 방향', ok, ok ? '' : direction === 'same'
    ? `원본처럼 ${original}가 모두 반응했다고 가정해 모순을 보이는 구조여야 하는데, 이 문제는 ${variant}를 가정합니다. 수치를 다시 잡아야 합니다.`
    : `원본과 반대로 원본에서 결론이던 쪽(${original}가 아닌 물질)을 가정해 모순을 보이는 구조여야 하는데, 이 문제도 ${variant}를 가정합니다. 어느 쪽이 모두 반응하는지가 원본과 바뀌게 수치를 다시 잡아야 합니다.`)];
}

function checkAssumption(material, item) {
  const first = material.steps[0];
  if (!first || !assumes(first.work + first.technique) || !stageSteps(item.stage, material.steps.length).includes(1)) return [];
  const steps = item.solution?.steps || [];
  const firstGenerated = steps.filter((s) => s.step === 1).map((s) => s.work).join('\n') || steps.map((s) => s.work).join('\n');
  // Which substance the teacher supposes used up ("만약 Ⅰ에서 A가 모두 반응했다면"): Haiku's R11 final supposed B
  // instead and the judges failed it three ways, five repairs on one final (molar-mass, 2026-10-12).
  const supposed = (t) => (/만약[^.\n]*?([A-Z])(?:\s*\(\s*g\s*\))?\s*(?:가|이)\s*모두\s*반응/.exec(plain(t).replace(/\\ce\{([^}]*)\}/g, '$1')) || [])[1];
  const want = supposed(first.work);
  const got = supposed(firstGenerated);
  return [result('source-assumption', '원본의 가정→모순 판정 유지', assumes(firstGenerated),
    assumes(firstGenerated) ? '가정과 모순 판정이 해설에 있음' : '원본 STEP 1의 가정→실험 비교→모순 판정이 변형 해설에서 사라졌습니다. 같은 추론이 필요하도록 문제와 해설을 고쳐야 합니다.'),
  ...(want && got ? [result('source-assumption-substance', '가정하는 물질이 선생님과 같음', want === got,
    want === got ? '' : `선생님은 "${want}가 모두 반응했다"고 가정해 모순을 보이는데 변형 해설은 ${got}를 가정했습니다. 가정하는 물질은 ${want} 그대로 두고, ${want}가 모두 반응했다고 가정하면 실제로 모순이 나는 실험(그 실험의 실제 한계 반응물이 ${want}가 아닌 실험)을 골라 가정·모순에 쓰세요. 어느 실험을 쓰는지는 변형 수치에 맞게 바꿔도 됩니다.`)] : [])];
}

// ---------------------------------------------------------------- problem structure (v1 choices / consistency)

function checkChoices(material, item) {
  const p = item.problem;
  if (!p.choices.length) return [];
  const want = material.problem.choices?.length || 5;
  const norm = p.choices.map((c) => plain(c).replace(/\s+/g, ''));
  const ok = p.choices.length === want && norm.every(Boolean) && new Set(norm).size === norm.length && p.answer >= 1 && p.answer <= p.choices.length;
  return [result('choices', '보기·정답 연결', ok,
    ok ? '' : `보기 ${p.choices.length}개(원본 ${want}개), 서로 다른 보기 ${new Set(norm).size}개, 정답 번호 ${p.answer}`, 'hard')];
}

/** Which of ㄱ·ㄴ·ㄷ a text judges, and how: "ㄱ. … (○)", "ㄴ은 옳지 않다". */
function judgments(raw) {
  const text = plain(raw);
  const judged = {};
  for (const m of text.matchAll(/([ㄱ-ㄹ])\s*[.)]?[^\n]{0,120}?\((O|X|○|×|o|x)\)/g)) judged[m[1]] = /O|○|o/.test(m[2]);
  for (const m of text.matchAll(/([ㄱ-ㄹ])\s*(?:은|는)\s*(옳지\s*않|옳|틀리|거짓|참|맞)/g)) judged[m[1]] = /^(옳|참|맞)$/.test(m[2].replace(/\s/g, '')) || m[2] === '옳';
  return judged;
}

/**
 * ㄱ·ㄴ·ㄷ problems. When the teacher's solution judges each statement, the variant's solution does too, inside its
 * STEPs (the summary does not count; 2026-10-03 a STEP 1~2 practice solution stopped at a mass ratio and never judged
 * ㄱ, ㄴ, ㄷ), and names the answer — else the solution is rewritten. The judgments must match the answer's combination.
 */
function checkOxConsistency(material, item) {
  const markers = [...new Set([...item.problem.text.matchAll(/(?:^|\n)\s*([ㄱ-ㄹ])\s*\./g)].map((m) => m[1]))];
  if (markers.length < 2 || !item.problem.answer) return [];
  const steps = (item.solution?.steps || []).map((s) => s.work).join('\n');
  const inSteps = judgments(steps);
  const teacherJudges = Object.keys(judgments((material?.steps || []).map((s) => s.work).join('\n'))).length >= 2;
  const unjudged = markers.filter((k) => !(k in inSteps));
  const named = /정답/.test(steps);
  const out = teacherJudges ? [result('explanation-complete', '해설 보기 분석', !unjudged.length && named,
    unjudged.length ? `해설 STEP에 보기 ${unjudged.join(', ')}의 판정(○/×와 근거)이 없습니다. 선생님 해설처럼 마지막 STEP 끝에서 보기마다 판정하고 정답 번호로 끝내야 합니다.`
      : named ? '' : '해설 STEP이 정답 번호로 끝나지 않습니다. 마지막 STEP을 "정답은 …이다."로 끝내야 합니다.')] : [];
  const judged = { ...judgments(item.solution?.summary || ''), ...inSteps };
  if (!markers.every((k) => k in judged)) return out;
  const claimed = new Set([...plain(item.problem.choices[item.problem.answer - 1] || '').matchAll(/[ㄱ-ㄹ]/g)].map((m) => m[0]));
  const trueSet = new Set(markers.filter((k) => judged[k]));
  const same = claimed.size === trueSet.size && [...claimed].every((k) => trueSet.has(k));
  return [...out, result('explanation-consistency', '해설 O/X 판정과 정답', same,
    same ? '' : `해설의 참 판정은 ${[...trueSet].join(', ') || '없음'}인데 정답 보기는 ${[...claimed].join(', ') || '없음'}입니다.`, 'hard')];
}

// ---------------------------------------------------------------- variant design (v1 VariantDesignPolicy)

/** Problem text with all numbers replaced, for "only the numbers changed" detection. */
function skeleton(text) {
  return plain(text).replace(/(?:^|\n)\s*[①②③④⑤][^\n]*/g, '').replace(/\d+(?:\s*[/.:]\s*\d+)?/g, '#').replace(/\s+/g, '');
}

function checkNumbersOnly(material, item, mode) {
  if (item.stage.kind !== 'twin' || mode !== 'integrated') return [];
  const same = skeleton(material.problem.text) === skeleton(item.problem.text);
  return [result('variant-design', '통합 변형: 숫자만 바꾸지 않았는지(코드 비교)', !same,
    same ? '원본과 문장·표 구조가 같고 숫자만 다릅니다. 조건 제시 방식, 자료 관계 또는 질문을 다시 설계해야 합니다.' : '')];
}

/** A problem whose STEP 1 infers the leftover reactant must not print A/B in the leftover column (v1 stage-clue-leak).
 * The final problem needs STEP 1 too (DeepSeek's final printed "A 8w", "B 2w" and so skipped it). */
function checkClueLeak(material, item) {
  if (!stageSteps(item.stage, material.steps.length).includes(1)) return [];
  const firstStep = material.steps[0] ? material.steps[0].title + material.steps[0].work : '';
  if (!/한계\s*반응물|남는|잔류|모두\s*반응/.test(firstStep)) return [];
  const leak = item.problem.text.split('\n').some((line) => {
    const cells = line.split('|').map((c) => plain(c).trim()).filter(Boolean);
    return cells.length >= 4 && /^(I|II|III|Ⅰ|Ⅱ|Ⅲ|IV|Ⅳ)$/.test(cells[0]) && /^[AB]\s*(?:\(?\d|w|\d)/.test(cells[3].replace(/\s+/g, ''));
  });
  return [result('stage-clue-leak', '추론할 결론을 표에 미리 노출', !leak,
    leak ? '남는 물질(A/B)을 추론하는 단계인데 표의 반응 후 칸에 A/B를 미리 적었습니다.' : '')];
}

// ---------------------------------------------------------------- rendering format (new; seen with Gemma)

function formatIssues(text) {
  const issues = [];
  const s = String(text || '');
  const dollars = (s.replace(/\\\$/g, '').match(/\$/g) || []).length;
  if (dollars % 2) issues.push('$ 기호 짝이 맞지 않습니다');
  const outside = s.replace(/\$\$[\s\S]*?\$\$|\$[^$]*\$/g, '');
  const raw = outside.match(/\\(?:frac|dfrac|ce|text|times|sqrt|cdot|rightarrow|longrightarrow)\b/g);
  if (raw) issues.push(`수식 기호가 $ 밖에 있습니다 (${[...new Set(raw)].join(' ')})`);
  let cols = null;
  for (const line of s.split('\n')) {
    if (!/^\s*\|/.test(line)) { cols = null; continue; }
    const n = line.trim().replace(/^\||\|$/g, '').split('|').length;
    if (cols !== null && n !== cols) { issues.push(`표의 칸 수가 행마다 다릅니다 (${cols} vs ${n})`); break; }
    cols = n;
  }
  return issues;
}

function checkFormat(item) {
  const issues = [
    ...formatIssues(item.problem.text).map((m) => '문제: ' + m),
    ...item.problem.choices.flatMap((c, i) => formatIssues(c).map((m) => `${i + 1}번 보기: ${m}`)),
    ...(item.solution?.steps || []).flatMap((st) => formatIssues(st.work).map((m) => `해설 STEP ${st.step}: ${m}`)),
  ];
  return [result('format', '표기 형식(수식·표)', !issues.length, issues.slice(0, 6).join('; '))];
}

/** A STEP of the teacher's solution that works in a table is written with a table too (the lean run's writer once
 * copied the designer's one-line outline and dropped the teacher's mass and mol tables). */
const hasTable = (text) => String(text || '').split('\n').filter((l) => /^\s*\|.*\|\s*$/.test(l)).length >= 3;
function checkSolutionTables(material, item) {
  const missing = (item.solution?.steps || []).filter((s) => hasTable(material.steps[s.step - 1]?.work) && !hasTable(s.work)).map((s) => s.step);
  if (!(item.solution?.steps || []).length) return [];
  return [result('source-tables', '선생님 해설의 표를 해설에서도 씀', !missing.length,
    missing.length ? `선생님 해설은 STEP ${missing.join(', ')}에서 표로 정리하는데 변형 해설에는 표가 없습니다. 같은 열 구성의 표로 써야 합니다.` : '')];
}

/** All code checks for one generated problem. */
/** The solution keeps the teacher's STEP titles; only the experiments or containers named ((Ⅰ~Ⅲ), (가)~(다)) follow the problem. */
const titleKey = (t) => plain(t).replace(/\((?:g|mol|L|mL|kg)\)/g, '').replace(/\([가-하]\)\s*(?:~|와|과|및|,)?\s*/g, '').replace(/Ⅰ|Ⅱ|Ⅲ|Ⅳ|\b(?:I{1,3}|IV)\b/g, '').replace(/[\s~,.:·()]/g, '');
function checkStepTitles(material, item) {
  const out = [];
  for (const s of item.solution?.steps || []) {
    const original = material.steps[s.step - 1]?.title;
    if (!original || !s.title) continue;
    if (titleKey(s.title) !== titleKey(original)) out.push(`STEP ${s.step} "${plain(s.title)}" → 원본 "${plain(original)}"`);
  }
  if (!(item.solution?.steps || []).length) return [];
  return [result('source-step-titles', '해설 STEP 제목이 선생님 해설과 같음', !out.length,
    out.length ? `해설 STEP 제목을 선생님 해설의 제목대로 써야 합니다: ${out.join('; ')}` : '')];
}

/** Data rows of the first table: experiment rows (Ⅰ, Ⅱ, …) and the cells that hold a hidden letter (x, y). */
function tableShape(text) {
  const rows = String(text || '').split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('|'))
    .map((l) => l.replace(/^\||\|$/g, '').split('|').map((c) => plain(c).trim()))
    .filter((cells) => /^(Ⅰ|Ⅱ|Ⅲ|Ⅳ|I|II|III|IV)$/.test(cells[0]));
  if (!rows.length) return null;
  // A letter used as the unit elsewhere ("5w") is a quantity when it stands alone ("w" = 1w), not a hidden value.
  const units = new Set(rows.flat().flatMap((c) => [...c.matchAll(/\d\s*([a-z])\b/g)].map((m) => m[1])));
  const hidden = rows.flatMap((cells, r) => cells.map((c, i) => (/^[a-z]$/.test(c) && !units.has(c) ? `${r}:${i}` : null)).filter(Boolean));
  return { rows: rows.length, cols: Math.max(...rows.map((c) => c.length)), hidden };
}

/** Ways out of the original's table shape, named by its own rows and columns: the cheap designer kept the original's
 *  table in the final after 11 code checks that only said "same shape" (molar-mass, Haiku 5.5, 2026-10-10). */
function shapeOptions(text, figure = '') {
  // Nerve conduction: rows are neurons, so the table shape says little; what the judges counted as structure in the
  // nerve finals (4 rounds numbers-only, 2026-10-10/11) is where the synapse is, which point is stimulated, the spacing.
  const nerve = /시냅스/.test(text) && nerveSetup(text, figure);
  if (nerve) {
    const others = [1, 2, 3, 4].filter((d) => d !== nerve.stim).map((d) => `$d_${d}$`).join('·');
    return [
      `원본: 자극 지점 $d_${nerve.stim}$, 지점 위치 ${[1, 2, 3, 4].map((d) => `$d_${d}=${nerve.pos[d]}$`).join(', ')} cm. 다음 중 둘 이상을 함께 바꾼다:`,
      '(1) 시냅스가 있는 곳을 원본의 정답과 다른 점선 상자로 정하고, 시냅스가 없다고 가정해 모순을 보이는 지점도 그에 맞춰 바꾼다.',
      `(2) 자극 지점을 ${others} 중 하나로 바꾼다 (A·B 막전위 비교로 자극 지점을 찾는 기법은 그대로 필요해야 한다).`,
      '(3) 지점 사이 거리를 바꿔 A의 속도와 $t_1$이 원본과 다른 값으로 나오게 한다.',
      '(4) 표에서 ?로 숨기는 칸이나 묻는 대상(t1, 속도, 시냅스 위치, 특정 지점의 상태)을 원본과 다르게 한다.',
      ...nerveExamples(text, nerve),
    ].join('\n');
  }
  const shape = tableShape(text);
  if (!shape || !shape.hidden.length) return '';
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter((l) => l.startsWith('|'));
  const header = (lines[0] || '').replace(/^\||\|$/g, '').split('|').map((c) => plain(c).trim());
  const rows = lines.map((l) => l.replace(/^\||\|$/g, '').split('|').map((c) => plain(c).trim())).filter((c) => /^(Ⅰ|Ⅱ|Ⅲ|Ⅳ|I|II|III|IV)$/.test(c[0])).map((c) => c[0]);
  const col = (i) => `'${header[i] || `${i + 1}번째 열`}'`;
  const hiddenAt = shape.hidden.map((h) => h.split(':').map(Number));
  const taken = new Set(shape.hidden);
  const moves = [];
  for (let r = 0; r < rows.length && moves.length < 4; r++) {
    for (let i = 1; i < shape.cols && moves.length < 4; i++) {
      if (!taken.has(`${r}:${i}`) && hiddenAt.some(([hr, hi]) => hr !== r || hi !== i) && (hiddenAt.some(([, hi]) => hi === i) || hiddenAt.some(([hr]) => hr === r))) moves.push(`${rows[r]}의 ${col(i)}`);
    }
  }
  const next = ['Ⅰ', 'Ⅱ', 'Ⅲ', 'Ⅳ', 'Ⅴ'][rows.length] || '새 실험';
  return [
    `원본 표: 실험 ${rows.join(', ')} ${rows.length}개, 숨긴 값 ${hiddenAt.map(([r, i]) => `${rows[r]}의 ${col(i)}`).join(', ')}. 다음 중 둘 이상을 함께 바꾼다:`,
    moves.length ? `(1) 숨긴 값을 다른 칸으로 옮긴다 — 예: ${moves.join(', ')}. 원래 숨긴 칸에는 수치를 준다.` : '',
    `(2) 실험 수를 바꾼다 — 실험 ${next}를 더해 ${rows.length + 1}개로 하거나, 풀이에 꼭 필요한 ${rows.length - 1}개만 둔다.`,
    '(3) 가정→모순을 판정하는 실험이나 남는 물질을 원본과 다르게 잡는다 (원본 STEP의 기법은 그대로 필요해야 한다).',
    '(4) 원본에서 수치로 준 칸 하나를 숨기고 그 값을 묻는 식에 쓴다.',
  ].filter(Boolean).join('\n');
}

/** An integrated final with the original's table shape and the hidden value in the same cell only changed numbers
 * (DeepSeek's final kept Ⅰ~Ⅲ, the same columns and x in row Ⅰ and just recombined b, x and the molar-mass ratio). */
function checkSameShape(material, item, mode) {
  if (item.stage.kind !== 'twin' || mode !== 'integrated') return [];
  // Nerve conduction: of the four ways out (synapse, stimulated point, spacing, hidden cells) the code sees three. All
  // three kept leaves the synapse alone, one change — numbers-only by the judges' count. Haiku's nerve finals came
  // back so from the Opus solve round after round, too late for a repair (2026-10-10/11).
  if (/시냅스/.test(material.problem.text)) {
    const a = nerveSetup(material.problem.text, material.problem.figure);
    const b = nerveSetup(item.problem.text, item.problem.figure || material.problem.figure);
    if (!a || !b) return [];
    // Hidden cells as neuron:point pairs, read either way round — R7's final put A and B in columns and kept every
    // hidden cell of the original.
    const hidden = (text) => {
      const rows = String(text).split('\n').map((l) => l.trim()).filter((l) => l.startsWith('|') && !/^\|[\s|:-]+\|$/.test(l))
        .map((l) => l.replace(/^\||\|$/g, '').split('|').map((c) => plain(c).trim()));
      const head = rows[0] || [];
      const cells = [];
      if (head.slice(1).some((c) => /^[AB]$/.test(c))) {
        for (const r of rows.slice(1)) r.forEach((x, i) => { if (x === '?' && /^[AB]$/.test(head[i])) cells.push(head[i] + ':' + r[0]); });
      } else {
        for (const r of rows.filter((x) => /^[AB]$/.test(x[0]))) r.forEach((x, i) => { if (x === '?') cells.push(r[0] + ':' + (head[i] || i)); });
      }
      return cells.sort().join(' ');
    };
    const same = a.stim === b.stim && [1, 2, 3, 4].every((d) => a.pos[d] === b.pos[d]) && hidden(material.problem.text) === hidden(item.problem.text);
    return [result('variant-shape', '통합 변형: 자극 지점·지점 간 거리·숨긴 칸을 바꿨는지', !same,
      same ? `자극 지점($d_${a.stim}$), 지점 위치, 표에서 ?로 숨긴 칸이 모두 원본과 같습니다. 남는 것은 시냅스 위치 하나뿐이라 숫자 변형입니다.\n${shapeOptions(material.problem.text, material.problem.figure)}` : '')];
  }
  const a = tableShape(material.problem.text);
  const b = tableShape(item.problem.text);
  if (!a || !b || !a.hidden.length) return [];
  const same = a.rows === b.rows && a.cols === b.cols && a.hidden.join() === b.hidden.join();
  return [result('variant-shape', '통합 변형: 표 구조와 숨긴 값 위치를 바꿨는지', !same,
    same ? `실험 ${a.rows}개, 열 ${a.cols}개, 숨긴 값의 위치까지 원본 표와 같습니다. 묻는 식만 바꾸면 숫자 변형입니다 — 실험 수·주는 값과 숨기는 값·판정 방향을 바꾸거나 표 밖의 새 실험을 넣어 구조를 바꿔야 합니다.\n${shapeOptions(material.problem.text)}` : '')];
}

/** In the leftover-reactant table, a row whose leftover is heavier than the A or B put in names the leftover by size
 * alone, and with it the mass ratio: the teacher's assume → contradiction is no longer needed (DeepSeek's finals
 * twice had such a row, and the independent solver did not notice). */
const wMultiple = (cell) => {
  const t = plain(cell).replace(/\s+/g, '').replace(/^[AB]/, '');
  const m = /^(\d+(?:\/\d+)?)?w$/.exec(t);
  if (!m) return null;
  if (!m[1]) return 1;
  const [a, b] = m[1].split('/').map(Number);
  return b ? a / b : a;
};
/** Rows that keep the assume → contradiction: for the reacting mass ratio A : B = p : q the solution states, the (A, B)
 * put in, in w, whose leftover is a whole w and lighter than both — the numbers a model must otherwise find by trial
 * (Haiku 5.5, 2026-10-08/09: the same obvious-leftover row in three designs in a row). Rows already used are skipped. */
function leftoverRows(p, q, used, count = 4) {
  const out = [];
  for (let sum = 3; sum <= 24 && out.length < count * 3; sum++) {
    for (let A = 1; A < sum && A <= 12; A++) {
      const B = sum - A;
      if (B > 12 || used.has(`${A},${B}`)) continue;
      // B all reacts when A / B > p / q; otherwise A all reacts.
      const bLimits = A * q > B * p;
      const left = bLimits ? A - (B * p) / q : B - (A * q) / p;
      if (left > 0 && Number.isInteger(left) && left < Math.min(A, B)) out.push({ A, B, left, rest: bLimits ? 'A' : 'B' });
    }
  }
  // Both kinds of row (A left over, B left over), small numbers first.
  const pick = [...out.filter((r) => r.rest === 'A').slice(0, Math.ceil(count / 2)), ...out.filter((r) => r.rest === 'B').slice(0, Math.floor(count / 2))];
  return pick.map((r) => `A $${r.A}w$, B $${r.B}w$ → ${r.rest === 'A' ? 'B' : 'A'}가 모두 반응, ${r.rest} $${r.left === 1 ? '' : r.left}w$ 남음`);
}
const tableRowsAB = (text) => String(text || '').split('\n').map((line) => line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()))
  .filter((cells) => cells.length >= 4 && /^(Ⅰ|Ⅱ|Ⅲ|Ⅳ|I|II|III|IV)$/.test(plain(cells[0]).trim()))
  .map((cells) => ({ name: plain(cells[0]).trim(), cells, a: wMultiple(cells[1]), b: wMultiple(cells[2]), left: wMultiple(cells[3]) }));

function checkObviousLeftover(material, item) {
  const first = material.steps[0];
  if (!first || !assumes(first.work + first.technique) || !stageSteps(item.stage, material.steps.length).includes(1)) return [];
  const rows = tableRowsAB(item.problem.text);
  const obvious = rows.filter((r) => r.a != null && r.b != null && r.left != null && (r.left > r.a || r.left > r.b))
    .map((r) => `${r.name} (남은 ${plain(r.cells[3]).trim()} > 넣은 ${r.left > r.a ? 'A ' + plain(r.cells[1]).trim() : 'B ' + plain(r.cells[2]).trim()})`);
  let hint = '';
  const ratio = /A\s*:\s*B\s*(?:=|는|은)?\s*\$?\s*(\d+)\s*:\s*(\d+)/.exec(plain((item.solution?.steps || []).map((x) => x.work).join('\n')));
  if (obvious.length && ratio) {
    const used = new Set([...rows, ...tableRowsAB(material.problem.text)].filter((r) => r.a != null && r.b != null).map((r) => `${r.a},${r.b}`));
    const rowsOk = leftoverRows(Number(ratio[1]), Number(ratio[2]), used);
    if (rowsOk.length) hint = ` 이 문제의 반응 질량비 A : B = ${ratio[1]} : ${ratio[2]}로 쓸 수 있는 행(서버 계산): ${rowsOk.join('; ')}.`;
  }
  return [result('source-assumption-needed', '가정→모순 없이 남은 물질이 정해지는 실험이 없음', !obvious.length,
    obvious.length ? `실험 ${obvious.join(', ')}에서 남은 물질이 질량 크기만으로 정해져 질량비가 바로 나오므로 가정→모순 판정이 필요 없어집니다. 모든 실험의 남은 질량이 넣은 A, B의 질량보다 작도록 바꿔야 합니다.${hint}` : '')];
}

/** A reaction equation printed in the problem keeps the original's coefficients (DeepSeek set b to 1 so the
 * molar relation came for free and a STEP was skipped). Leaving the equation out is fine. */
const equationKey = (text) => {
  const m = /\\ce\{([^{}]*->[^{}]*)\}/.exec(String(text || ''));
  return m ? m[1].replace(/\s+/g, '').replace(/\(g\)|\(l\)|\(s\)|\(aq\)/g, '') : null;
};
function checkEquation(material, item) {
  const a = equationKey(material.problem.text);
  const b = equationKey(item.problem.text);
  if (!a || !b || a === b) return [];
  return [result('source-equation', '반응식 계수를 원본대로 둠', false,
    `문제의 반응식 ${b}가 원본 ${a}와 다릅니다. 계수를 바꾸면 원본 STEP의 추론을 건너뛰게 되므로 원본 반응식을 그대로 쓰거나 반응식을 빼야 합니다.`)];
}

/** A letter coefficient printed in the equation ("bB", "(b는 반응 계수)") that neither the question nor the solution
 * uses is an unused condition (DeepSeek's STEP 1~2 practice kept it; the reviewer caught it in one set, not another). */
function checkUnusedCoefficient(item) {
  const text = String(item.problem.text || '');
  const eq = /\\ce\{([^{}]*->[^{}]*)\}/.exec(text);
  if (!eq) return [];
  const letters = [...new Set([...eq[1].matchAll(/(?:^|[\s+])([a-z])\s*[A-Z]/g)].map((m) => m[1]))];
  if (!letters.length) return [];
  const solution = plain((item.solution?.steps || []).map((s) => s.work).join('\n') + '\n' + (item.solution?.summary || ''));
  const rest = plain(text.replace(eq[0], '').replace(/\(\s*\$?[a-z]\$?\s*는\s*반응\s*계수\s*\)/g, ''));
  const unused = letters.filter((l) => !new RegExp(`(^|[^A-Za-z])${l}\\s*=`).test(solution) && !new RegExp(`(^|[^A-Za-z\\\\])${l}([^A-Za-z]|$)`).test(rest));
  return [result('unused-coefficient', '반응식의 문자 계수가 풀이에 쓰임', !unused.length,
    unused.length ? `반응식의 계수 ${unused.join(', ')}가 발문에도 해설에도 쓰이지 않습니다. 풀이에 쓰이지 않는 조건이므로 계수 관계를 필요한 만큼만 문장으로 주거나 묻는 값에 쓰이게 해야 합니다.` : '')];
}

/**
 * Students have no calculator (요구서 1). A decimal in the problem or its choices that is not a simple fraction (1.732,
 * 0.333 — as against 0.125 = 1/8 or 22.4) makes the problem one to redesign with friendlier numbers.
 */
function checkCleanNumbers(item) {
  const gcd = (a, b) => (b ? gcd(b, a % b) : a);
  const text = plain([item.problem.text, ...(item.problem.choices || [])].join('\n'));
  const bad = [...new Set((text.match(/\d+\.\d+/g) || []).filter((d) => {
    const [whole, frac] = d.split('.');
    const num = Number(whole + frac), den = 10 ** frac.length;
    return den / gcd(num, den) > 60;
  }))];
  return [result('clean-numbers', '손계산 수치', !bad.length,
    bad.length ? `계산기 없이 다루기 어려운 수가 문제에 있습니다: ${bad.slice(0, 5).join(', ')}. 작은 정수나 분모가 작은 분수가 되게 수치를 다시 잡아야 합니다.` : '')];
}

/** Nerve conduction: the membrane-potential graph as (ms, mV) ticks, the points' positions and the stimulated point. */
function nerveSetup(text, figure) {
  const fig = String(figure || '');
  const all = plain(String(text || '') + '\n' + fig).replace(/−/g, '-');
  // Either "1.5 ms에 0", "1 ms 무렵 -60", "1.5 ms에 상승하면서 0" or the graph as points "(1.5, 0)"; the resting
  // potential after the last tick is the recovery time ("4 ms에는 약 -70으로 돌아온다").
  const pairs = [...plain(fig).replace(/−/g, '-').matchAll(/(\d+(?:\.\d+)?)\s*ms\s*(?:에는|에|무렵|쯤)?\s*(?:[가-힣]+\s*){0,3}?([+-]?\d+)\s*(?:mV)?|\((\d+(?:\.\d+)?),\s*([+-]?\d+)\)/g)]
    .map((m) => (m[3] !== undefined ? [m[3], m[4]] : [m[1], m[2]]))
    .map(([t, v]) => [Number(t), Number(v)]).filter(([t, v]) => t > 0 && v >= -100 && v <= 60);
  const ticks = pairs.filter(([, v]) => v !== -70);
  const last = ticks.length ? ticks[ticks.length - 1][0] : 0;
  const recover = (pairs.find(([t, v]) => v === -70 && t > last) || [])[0]
    || Number((/(\d+(?:\.\d+)?)\s*ms\s*까지/.exec(plain(fig)) || [])[1]) || (ticks.length ? last + 1 : 0);
  // Positions as the designs write them: "d_1~d_4는 각각 0, 2, 5, 7 cm", "d_1=0", "d_1(0 cm)", "눈금 0, 1, 4, 6(cm)
  // 위치에 d_1, …", "d_1과 d_2 사이의 거리는 2 cm" / "d_1~d_2 사이는 1 cm"; the first reading of four rising values.
  const list = (s) => s.split(',').map((x) => Number(x.trim())).reduce((o, x, i) => ({ ...o, [i + 1]: x }), {});
  const ways = [
    () => { const m = /d_?\{?1\}?\s*~\s*\$?d_?\{?4\}?[^.\n]*?각각\s*([\d.,\s]+)\s*cm/.exec(all); return m ? list(m[1]) : {}; },
    () => { const p = {}; for (const m of all.matchAll(/d_?\{?(\d)\}?(?:\s*(?:=|는|은|:|\()\s*(\d+(?:\.\d+)?)(?![\d.]*\d)|\s+(\d+(?:\.\d+)?)\s*cm)/g)) if (!(m[1] in p)) p[m[1]] = Number(m[2] ?? m[3]); return p; },
    () => { const m = /눈금\s*(?:\(cm\)\s*:?\s*)?([\d.]+(?:\s*,\s*[\d.]+){3})\s*\(?cm\)?/.exec(all); return m ? list(m[1]) : {}; },
    () => {
      const p = { 1: 0 };
      for (const m of all.matchAll(/d_?\{?(\d)\}?\s*(?:[과와]|~)\s*\$?d_?\{?(\d)\}?\s*사이(?:의\s*거리)?(?:는|은)?\s*(\d+(?:\.\d+)?)\s*cm/g)) {
        if (m[1] in p && Number(m[2]) === Number(m[1]) + 1) p[m[2]] = p[m[1]] + Number(m[3]);
      }
      return p;
    },
  ];
  const rising = (p) => [1, 2, 3, 4].every((d) => Number.isFinite(p[d])) && p[1] < p[2] && p[2] < p[3] && p[3] < p[4];
  const pos = ways.map((f) => f()).find(rising) || {};
  const stim = Number((/d_?\{?(\d)\}?\s*에\s*(?:역치\s*이상의\s*)?자극/.exec(all) || [])[1]) || 0;
  if (ticks.length < 3 || !recover || Object.keys(pos).length !== 4 || !stim) return null;
  // Cell bodies drawn at the right end turn the one-way synapse around (server/nerve.js).
  const right = /오른쪽\s*끝(?:에|은|이|의)?\s*(?:신경\s*)?세포체/.test(plain(fig));
  return { ticks, recover, pos, stim, ...(right ? { right } : {}) };
}

/** The value the graph gives `e` ms after the impulse arrives: a tick, the resting potential, or unknown (null). */
function graphValue(setup, e) {
  if (e < setup.ticks[0][0] || e >= setup.recover) return -70;
  const hit = setup.ticks.find(([t]) => Math.abs(t - e) < 1e-9);
  return hit ? hit[1] : null;
}

/** B's speed as the problem states it ("B를 구성하는 두 뉴런의 흥분 전도 속도는 1 cm/ms로 같다"). */
function speedB(text) {
  return Number((/B[^.\n]*?속도는\s*(\d+(?:\.\d+)?)/.exec(plain(text).replace(/\\,/g, ' ')) || [])[1]) || null;
}

/** Tables the server found that keep the teacher's three moves, give one reading and need every value given —
 *  Haiku 5.5 gave up on a nerve final after looking for such numbers itself (R10, 2026-10-12). */
const nerveFound = new Map();
function nerveExamples(text, setup) {
  const table = nerveTable.readTable(text);
  const vB = speedB(text);
  if (!setup || !table || !vB || nerveTable.analyse(setup, table, vB).readings.length !== 1) return [];
  // The search takes about 2 s; the same original is asked for at every design and every final check.
  const memo = JSON.stringify([setup, table, vB]);
  if (!nerveFound.has(memo)) nerveFound.set(memo, nerveTable.designs(setup, table, vB, 3));
  const found = nerveFound.get(memo);
  return found.length ? [`서버가 계산한 예 — 표의 값이 그래프·속도·한 방향 시냅스로 하나의 해석만 갖고, 준 값이 모두 풀이에 쓰이며, 선생님의 세 단계(A·B가 다른 두 지점을 먼저 제외하고 남은 후보 하나를 더 오른쪽 값으로 제외해 자극 지점, A의 같은 값 두 개로 속도, 시냅스 너머 B 값으로 모순)가 그대로 필요하다. 하나를 골라 그대로 쓰거나 같은 방식으로 잡는다 (B의 속도 ${vB} cm/ms 그대로):`, ...found.map((x) => '- ' + nerveTable.describe(x))] : [];
}

/** Tables for a nerve practice up to STEP 1 or 2, computed the teacher's way ('' for any other stage or problem):
 *  Haiku 5.5 made the practice tables by hand and the judges sent each back seven times (R13, 2026-10-12). */
const practiceFound = new Map();
function practiceOptions(material, stage) {
  if (stage.kind !== 'upto' || stage.upto > 2 || !/시냅스/.test(material.problem.text)) return '';
  const setup = nerveSetup(material.problem.text, material.problem.figure);
  const table = nerveTable.readTable(material.problem.text);
  const vB = speedB(material.problem.text);
  if (!setup || !table || !vB || !nerveTable.practiceRead(setup, table, vB, stage.upto).ok) return '';
  const memo = JSON.stringify([setup, table, vB, stage.upto]);
  if (!practiceFound.has(memo)) practiceFound.set(memo, nerveTable.practiceDesigns(setup, table, vB, stage.upto, 3));
  const found = practiceFound.get(memo);
  if (!found.length) return '';
  const moves = 'A·B 값이 다른 두 지점을 먼저 제외 → 남은 후보 하나를 더 오른쪽 값으로 제외해 자극 지점 → 자극 지점에서 가장 가까운 지점은 A 값이 그래프에서 가장 오른쪽인 지점' + (stage.upto >= 2 ? ' → A의 같은 값 두 개(상승기·하강기)로 A의 속도' : '');
  const ask = stage.upto >= 2 ? 'A의 흥분 전도 속도를 묻는다' : '자극 지점과 그 지점에서 가장 가까운 지점이 Ⅰ~Ⅳ 중 어느 것인지 묻는다 (예: "$d_3$와 $d_4$에 해당하는 지점을 옳게 짝지은 것은?") — 가장 가까운 지점을 물어야 지점 위치가 풀이에 쓰인다';
  return [`서버가 계산한 연습용 표 — 선생님 판단 순서(${moves})가 그대로 필요하고, 표에 준 값이 모두 이 판단에 쓰이며, 답이 하나로 정해진다. 하나를 골라 자극 지점·지점 위치·표의 A·B 값과 ?를 그대로 쓴다 (B의 속도 ${vB} cm/ms 그대로; 시냅스 위치와 $t_1$은 표를 맞춘 값이며 묻지 않는다). ${ask}:`,
    ...found.map((x) => '- ' + nerveTable.describe(x))].join('\n');
}

/** A nerve practice's table against the teacher's STEP 1 (and 2): values a move does not use, an answer that is not
 *  one, no reading at all. STEP 1's order itself is `checkNerveStimOrder`'s. */
function checkNervePractice(material, item) {
  if (item.stage.kind !== 'upto' || item.stage.upto > 2 || !/시냅스/.test(material.problem.text)) return [];
  const origSetup = nerveSetup(material.problem.text, material.problem.figure);
  const origTable = nerveTable.readTable(material.problem.text);
  const origVB = speedB(material.problem.text);
  if (!origSetup || !origTable || !origVB || !nerveTable.practiceRead(origSetup, origTable, origVB, item.stage.upto).ok) return [];
  const setup = nerveSetup(item.problem.text, item.problem.figure || material.problem.figure);
  const table = nerveTable.readTable(item.problem.text);
  if (!setup || !table) return [];
  const r = nerveTable.practiceRead(setup, table, speedB(item.problem.text), item.stage.upto);
  if (!r.step1.ok) return [];
  const problems = [];
  if (!r.readings) problems.push('표의 값이 막전위 그래프·전도 속도·시냅스와 함께 성립하는 해석이 없습니다.');
  else if (r.answers > 1) problems.push(`표의 값만으로는 ${item.stage.upto >= 2 ? '자극 지점·가장 가까운 지점·A의 속도' : '자극 지점과 그 지점에서 가장 가까운 지점'}를 하나로 정할 수 없습니다.`);
  else if (!r.near.ok) problems.push('선생님 STEP 1의 세 번째 판단(자극 지점에서 가장 가까운 지점은 A 값이 그래프에서 가장 오른쪽인 지점)이 이 표로는 되지 않습니다.');
  else if (item.stage.upto >= 2 && !r.pairs.length) problems.push('선생님 STEP 2(A의 같은 값 두 개가 상승기·하강기로 다른 시간이라 속도가 나온다)에 쓸 같은 A 값 두 개가 없습니다.');
  else if (r.unused.length) problems.push(`선생님 STEP 1${item.stage.upto >= 2 ? '~2' : ''}의 판단 어디에도 쓰이지 않는 값이 있습니다: ${r.unused.join(', ')}. 빼서 ?로 두거나 판단에 쓰이게 하세요.`);
  if (!problems.length) return [result('nerve-practice', '연습 표가 선생님 판단으로 하나로 풀림', true, '')];
  const options = practiceOptions(material, item.stage);
  return [result('nerve-practice', '연습 표가 선생님 판단으로 하나로 풀림', false, [...problems, options].filter(Boolean).join('\n'))];
}

/** An integrated nerve final's table read the way the student reads it: no reading means the values contradict the
 *  graph, the speeds or the one-way synapse (R4's final had B's impulse cross the synapse backwards, and the judges
 *  passed it); more than one means the order, t1 or the synapse is not fixed (R8/R9: "Ⅱ·Ⅳ 중 어느 것이 d_1인지"). */
function checkNerveReading(material, item, mode) {
  if (item.stage.kind !== 'twin' || mode !== 'integrated' || !/시냅스/.test(item.problem.text)) return [];
  const setup = nerveSetup(item.problem.text, item.problem.figure || material.problem.figure);
  const table = nerveTable.readTable(item.problem.text);
  const vB = speedB(item.problem.text);
  if (!setup || !table || !vB) return [];
  const { readings } = nerveTable.analyse(setup, table, vB);
  if (readings.length === 1) return [result('nerve-reading', '신경 표가 하나의 해석으로 정해짐', true, '')];
  const box = ['㉠', '㉡', '㉢'];
  const say = (x) => `Ⅰ~Ⅳ = ${x.order.map((d) => '$d_' + d + '$').join(', ')}, A ${x.vA} cm/ms, $t_1=${x.t1}$ ms, 시냅스 ${box[x.box - 1]}`;
  const why = readings.length
    ? `표의 값으로 해석이 하나로 정해지지 않습니다 — 가능한 해석 ${readings.length}개: ${readings.slice(0, 3).map(say).join(' / ')}`
    : '표의 값이 막전위 그래프·전도 속도·시냅스와 함께 성립하는 해석이 없습니다. 시냅스는 세포체 쪽 뉴런에서 다음 뉴런으로 한 방향으로만 전달되고(반대쪽 지점은 휴지 전위), 넘어간 쪽 지점은 시냅스 지연만큼 늦습니다.';
  const examples = nerveExamples(material.problem.text, nerveSetup(material.problem.text, material.problem.figure));
  return [result('nerve-reading', '신경 표가 하나의 해석으로 정해짐', false, [why, ...examples].join('\n'))];
}

/** The row of neuron A (no synapse): some speed, t1 and order of Ⅰ~Ⅳ must give every value in it — Haiku 5.5's nerve
 *  tables were contradictory design after design, each found only by the Opus solve (2026-10-10/11). When none does,
 *  the server lists rows that work with this problem's positions. */
function checkNerveRow(item) {
  const setup = nerveSetup(item.problem.text, item.problem.figure);
  if (!setup) return [];
  const row = String(item.problem.text).split('\n').map((l) => l.trim()).filter((l) => l.startsWith('|'))
    .map((l) => l.replace(/^\||\|$/g, '').split('|').map((c) => plain(c).replace(/−/g, '-').trim())).find((c) => c[0] === 'A');
  if (!row || row.length !== 5) return [];
  const cells = row.slice(1).map((c) => (/^[+-]?\d+$/.test(c) ? Number(c) : null));
  const dist = (d) => Math.abs(setup.pos[d] - setup.pos[setup.stim]);
  const speeds = [0.5, 1, 1.5, 2, 2.5, 3, 4, 5, 6];
  const times = Array.from({ length: 40 }, (_, i) => (i + 1) / 2);
  const perms = (xs) => (xs.length <= 1 ? [xs] : xs.flatMap((x, i) => perms([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p])));
  const orders = perms([1, 2, 3, 4]);
  const fits = speeds.some((v) => times.some((t1) => orders.some((order) => cells.every((c, i) => c === null || graphValue(setup, t1 - dist(order[i]) / v) === c))));
  if (fits) return [];
  const rows = [];
  for (const v of speeds) {
    for (const t1 of times) {
      const vals = [1, 2, 3, 4].map((d) => graphValue(setup, t1 - dist(d) / v));
      if (vals.every((x) => x !== null) && new Set(vals).size >= 3 && rows.length < 3) rows.push(`속도 ${v} cm/ms, $t_1=${t1}$ ms → ${vals.map((x, i) => `$d_${i + 1}$ ${x > 0 ? '+' + x : x}`).join(', ')}`);
    }
  }
  return [result('nerve-row', '신경 A의 막전위가 그래프로 성립', false,
    `신경 A 행의 막전위가 어떤 전도 속도·$t_1$·지점 배치로도 막전위 그래프의 값과 맞지 않습니다 (이 문제의 지점 위치와 자극 지점 $d_${setup.stim}$ 기준). 각 지점의 경과 시간 = $t_1$ − (자극 지점과의 거리)÷속도로 다시 잡아야 합니다.${rows.length ? ` 이 위치로 성립하는 예(서버 계산): ${rows.join(' / ')}` : ''}`)];
}

/** STEP 1 of a nerve table the teacher's way — two points out by A ≠ B, then one by the graph — when the original
 *  itself goes that way and the item uses STEP 1. Haiku's R11 practices took one by B and two by the graph; the
 *  judges failed the order after an Opus solve, four repairs for one practice (2026-10-12). */
function checkNerveStimOrder(material, item) {
  const used = stageSteps(item.stage, material.steps.length);
  if (!used.includes(1)) return [];
  const origSetup = nerveSetup(material.problem.text, material.problem.figure);
  const origTable = nerveTable.readTable(material.problem.text);
  if (!origSetup || !origTable || !nerveTable.stimSteps(origSetup, origTable).ok) return [];
  // Only the graph's ticks count for the first two moves, so a practice that hides the stimulated point reads with
  // the original's graph.
  const own = nerveSetup(item.problem.text, item.problem.figure || material.problem.figure);
  const setup = own || origSetup;
  const table = nerveTable.readTable(item.problem.text);
  if (!table) return [];
  const { byB, byRight, ok } = nerveTable.stimSteps(setup, table);
  const list = (xs) => (xs.length ? xs.join('·') : '없음');
  const problems = [];
  if (!ok) problems.push(`선생님 STEP 1은 A·B 값이 둘 다 주어지고 서로 다른 지점 두 개를 먼저 제외하고, 남은 두 후보 중 하나를 '더 오른쪽 값'(A 값이 그래프에서 다른 지점보다 앞선 값)으로 제외합니다. 이 표는 A·B로 제외되는 지점 ${byB.length}개(${list(byB)}), 남은 후보 중 더 오른쪽 값으로 제외되는 지점 ${byRight.length}개(${list(byRight)})입니다. A·B가 다른 지점이 정확히 둘, 남은 비자극 후보 하나만 그래프로 제외되도록 표의 값이나 ?를 다시 잡으세요.`);
  // The third move — the point nearest the stimulated one has the A value furthest right — when the original has it.
  const vB = speedB(item.problem.text);
  const origRead = nerveTable.analyse(origSetup, origTable, speedB(material.problem.text) || 1).readings;
  if (own && vB && origRead.length === 1 && nerveTable.nearestStep(origSetup, origTable, origRead[0].order).ok) {
    const rs = nerveTable.analyse(own, table, vB).readings;
    if (rs.length === 1) {
      const near = nerveTable.nearestStep(own, table, rs[0].order);
      if (!near.ok) problems.push(`선생님 STEP 1의 세 번째 판단(자극 지점에서 가장 가까운 지점은 A 값이 그래프에서 가장 오른쪽인 지점)이 이 표로는 되지 않습니다 — ${near.nearest ? `가장 가까운 ${near.nearest}의 A 값이 ?이거나 다른 지점의 A 값보다 확실히 오른쪽 값이 아닙니다` : '가장 가까운 지점이 하나로 정해지지 않습니다'}. 가장 가까운 지점의 A 값이 나머지 지점의 A 값보다 그래프에서 더 오른쪽이 되게 잡으세요.`);
    }
  }
  if (!problems.length) return [result('nerve-stim-order', '자극 지점 판정 순서가 선생님과 같음', true, '')];
  return [result('nerve-stim-order', '자극 지점 판정 순서가 선생님과 같음', false, problems.join('\n'))];
}

// ---------------------------------------------------------------- molar mass (server/molar.js)

const molarFound = new Map();
const tableHead = (text) => String(text || '').split('\n').map((l) => l.trim()).filter((l) => /^\|.*\|$/.test(l)).slice(0, 2);
/** The designs the server found for this problem of a molar-mass original (none for any other original). */
function molarDesigns(material, stage, mode, prior = []) {
  const table = molar.readTable(material.problem.text);
  if (!table || !molar.analyse(table).ok) return [];
  const avoid = prior.map((p) => molar.readTable(p.problem?.text)).filter(Boolean);
  const key = JSON.stringify([material.problem.text, stage, mode, avoid.length]);
  if (!molarFound.has(key)) {
    molarFound.set(key, stage.kind === 'upto' && stage.upto <= 2 ? molar.practiceDesigns(table, stage.upto, { avoid, count: 3 })
      : stage.kind === 'twin' && mode === 'integrated' && table.hasRel ? molar.finalDesigns(table, material.problem.text, { avoid, count: 3 }) : []);
  }
  return molarFound.get(key);
}
/** The same as words for the designer: tables to copy, with the question, the choices in order and the answer. */
/** A server design as the problem prints it: table lines (the original's header, spaced as the teacher spaces it),
 *  the question and the choices. */
function molarPrinted(material, stage, d) {
  const withRel = d.rows.some((x) => x.rel);
  // The header from the columns the server read, each under its 반응 전/반응 후 group whatever shape the reading had:
  // Qwen 3.8 read it flat without "반응 후" and every variant table lost it (Claude's review, 2026-10-14).
  const t = molar.readTable(material.problem.text);
  const cell = (i, group) => {
    const c = String(t.header[i] || '').replace(/반응\s*전/g, '반응 전').replace(/반응\s*후/g, '반응 후').trim();
    return /반응 (전|후)/.test(c) ? c : `${group} ${c}`;
  };
  const cols = t && ['실험', cell(t.at.a, '반응 전'), cell(t.at.b, '반응 전'), cell(t.at.left, '반응 후'), ...(withRel && t.at.rel >= 0 ? [cell(t.at.rel, '반응 후')] : [])];
  const head = tableHead(material.problem.text).map((l) => l.replace(/반응\s*전/g, '반응 전').replace(/반응\s*후/g, '반응 후'));
  const header = cols ? [`| ${cols.join(' | ')} |`, `|${cols.map(() => '---').join('|')}|`]
    : withRel ? head : [head[0].split('|').slice(0, 5).join('|') + '|', '|---|---|---|---|'];
  const rows = d.rows.map((x) => `| ${molar.rowCells(x, d.hide[x.name] || [], withRel).join(' | ')} |`);
  const ask = d.question || '실험 Ⅲ에서 반응 후 남은 $\\ce{A(g)}$ 또는 $\\ce{B(g)}$의 질량 $x$는?';
  const choices = d.choices.map((x) => (d.unit ? `${molar.texOf(x, 'w')} g` : molar.texOf(x)));
  // A practice problem opens with the original's premise (the cylinder, the reaction run to completion): without it
  // the assumption step has no ground (Claude's review of the Qwen 5th set, 2026-10-12). STEP 1~2 gives the two
  // coefficients it uses instead of the equation.
  const lead = stage.kind === 'twin' ? null : [
    '표는 실린더에 $\\ce{A(g)}$와 $\\ce{B(g)}$를 넣고 반응을 완결시킨 실험 Ⅰ~Ⅲ에 대한 자료이다.',
    ...(stage.upto >= 2 ? ['$\\ce{A(g)}$와 $\\ce{B(g)}$가 반응하여 $\\ce{C(g)}$와 $\\ce{D(g)}$를 생성하는 이 반응에서 $\\ce{A(g)}$의 계수는 1, $\\ce{C(g)}$의 계수는 2이다.'] : []),
  ].join(' ');
  return { table: [...header, ...rows], ask, choices, lead };
}
function molarOptions(material, stage, mode, prior = []) {
  const found = molarDesigns(material, stage, mode, prior);
  if (!found.length) return '';
  const one = (d, i) => {
    const p = molarPrinted(material, stage, d);
    const facts = molar.solutionFacts(molar.readTable(p.table.join('\n')), 2, { withD: stage.kind === 'twin' });
    return [`(${i + 1}) ${d.changes ? `원본과 달라진 구조: ${d.changes.join(', ')} · ` : ''}반응 질량비 A : B = 1 : ${molar.str(d.r)}${d.q ? `, m : n = ${molar.str(d.q)}, b = ${molar.str(d.b)}` : ''}`,
      ...p.table, `묻는 것: ${p.ask}`, `선택지: ${p.choices.map((x, k) => `${'①②③④⑤'[k]} ${x}`).join('  ')} — 정답 ${'①②③④⑤'[d.answer - 1]}`,
      `해설에 쓸 값 (서버 계산 — 해설의 판정과 수치는 이것과 같게 쓴다):`, ...facts.map((f) => `- ${f}`)].join('\n');
  };
  const intro = stage.kind === 'twin'
    ? '서버가 계산한 최종 문제 후보 — 표를 선생님 풀이로 읽으면 반응 질량비, m : n, b, 숨긴 값이 하나로 정해지고, 가정→모순이 필요하며, 준 값이 모두 쓰이고, 원본과 구조가 둘 이상 다르다는 것을 서버가 확인했다(구조 항목은 코드로 셌다). 수치를 새로 정하지 말고 하나를 골라 표의 수치, 숨긴 칸, 묻는 식, 선택지(순서 그대로)와 정답 번호를 그대로 쓴다. 반응식은 원본대로 두고, "(단, 실린더 속 기체의 온도와 압력은 일정하다.)" 같은 단서는 풀이에 쓰이지 않으므로 넣지 않는다:'
    : `서버가 계산한 연습용 표 — 선생님 STEP 1(Ⅰ에서 A가 모두 반응했다고 가정하면 Ⅱ와 모순 → Ⅰ에서는 B가 모두 반응)이 그대로 필요하고, 크기 비교만으로 남는 물질이 정해지는 실험이 없으며, 정답이 하나로 정해지는 것을 서버가 확인했다. 수치를 새로 정하지 말고 하나를 골라 표의 수치, 묻는 것, 선택지(순서 그대로)와 정답 번호를 그대로 쓴다.${stage.upto >= 2 ? ' 반응식은 싣지 않고 "$\\ce{A(g)}$와 $\\ce{B(g)}$가 반응하여 $\\ce{C(g)}$와 $\\ce{D(g)}$를 생성하는 이 반응에서 $\\ce{A(g)}$의 계수는 1, $\\ce{C(g)}$의 계수는 2이다."처럼 풀이에 쓰는 계수만 문장으로 준다.' : ' 반응식과 상댓값 열은 싣지 않는다.'}`;
  return [intro, ...found.map(one)].join('\n\n');
}

/** The check program of a problem written on one of the server's tables: the server's value and choices (null when
 *  the problem's table is not one of them). */
function molarDesignOf(material, item, mode, prior = []) {
  const table = molar.readTable(item.problem?.text);
  if (!table) return null;
  const cellKey = (c) => (c?.v ? molar.str(c.v) : c ? '?' : '');
  const itemKey = table.rows.map((x) => [x.name, cellKey(x.a), cellKey(x.b), cellKey(x.left), cellKey(x.rel)].join(',')).join(';');
  return molarDesigns(material, item.stage, mode, prior).find((d) => d.rows.map((x) => {
    const hide = d.hide[x.name] || [];
    const v = (k) => (hide.includes(k) ? '?' : x[k] ? molar.str(x[k]) : '');
    return [x.name, v('a'), v('b'), v('left'), table.hasRel ? v('rel') : ''].join(',');
  }).join(';') === itemKey) || null;
}
/**
 * A designer who copied none of the server's tables gets the server's first one: the original's lines before its
 * table (the equation, for a final), the table and the question. Qwen 3.6 put the original's own rows back (run 12) and
 * each such design cost a repair round. Returns true when the problem was replaced.
 */
function molarAdopt(material, item, mode, prior = [], { sameRowsOnly = false } = {}) {
  if (molarDesignOf(material, item, mode, prior)) return false;
  const found = molarDesigns(material, item.stage, mode, prior);
  // A table with a candidate's masses put in but a hidden cell filled in (Qwen printed z's value 2w after a repair,
  // run 14) is that candidate.
  const mine = molar.readTable(item.problem?.text);
  const putIn = (rows) => rows.map((x) => `${x.name}:${x.a?.v ? molar.str(x.a.v) : '?'},${x.b?.v ? molar.str(x.b.v) : '?'}`).join(';');
  const same = mine && found.find((d) => putIn(d.rows.map((x) => ({ name: x.name, a: { v: x.a }, b: { v: x.b } }))) === putIn(mine.rows));
  const design = same || (sameRowsOnly ? null : found[0]);
  if (!design) return false;
  const p = molarPrinted(material, item.stage, design);
  const lines = String(material.problem.text).split('\n');
  const start = lines.findIndex((l) => /^\s*\|.*\|\s*$/.test(l));
  const points = (lines.filter((l) => l.trim()).pop().match(/\(\d점\)\s*$/) || [''])[0];
  const before = item.stage.kind === 'twin' && start > 0 ? lines.slice(0, start) : [];
  item.problem = { ...item.problem, text: [...before, ...p.table, '', `${p.ask}${points && item.stage.kind === 'twin' ? ` ${points}` : ''}`].join('\n') };
  molarNormalize(material, item, mode, prior);
  return true;
}

/**
 * The whole solution of a problem on one of the server's tables, in the teacher's sentences on the server's values —
 * every STEP its stage uses, ending with the answer — or null when the server cannot write all of it. With this the
 * job's model need not write the solution out (runs 9–11: everything it wrote here was replaced by the server's text).
 */
function molarSolution(material, item, mode, prior = []) {
  if (!serverSolution() || !molarDesignOf(material, item, mode, prior)) return null;
  const count = item.stage.kind === 'twin' ? 3 : Math.min(item.stage.upto || 1, 3);
  const titles = (material.steps || []).map((s) => s.title || '');
  const one = molar.stepOneText(molar.readTable(molarPrinted(material, item.stage, molarDesignOf(material, item, mode, prior)).table.join('\n')));
  if (!one) return null;
  const draft = { ...item, problem: { ...item.problem }, outline: null, solution: { summary: '', steps: [
    { step: 1, title: '한계 반응물', work: one.text.match(/^만약 \S+에서 [AB]가/)[0] },
    { step: 2, title: titles[1] || '', work: 'Ⅰ~Ⅲ에서 반응 후 기체의 질량(g)에 대한 자료는 다음과 같다.' },
    { step: 3, title: titles[2] || '', work: '정답은' },
  ].slice(0, count) } };
  molarNormalize(material, draft, mode, prior);
  const [s1, s2, s3] = draft.solution.steps;
  const whole = s1?.work.startsWith('만약') && (count < 2 || (/자료는 다음과 같다/.test(s2.work) && s2.work.split('\n').length > 6))
    && (count < 3 || /반응 후 기체의 양\(mol\)/.test(s3.work)) && /정답은 [①②③④⑤]/.test(draft.solution.steps[count - 1].work);
  return whole ? draft.solution : null;
}

/** Whether the server writes a molar-mass solution in the teacher's sentences (off unless asked for, see molarNormalize). */
function serverSolution() {
  return process.env.EDUMASTER_MOLAR_SOLUTION === '1';
}

/**
 * A problem on one of the server's tables, printed and solved as the server prints and solves it: molarNormalize, then
 * the whole solution from molarSolution in place of the designer's (run 13 ran without lean, and Qwen's own summary and
 * any STEP the patterns missed stayed). Returns true when something changed.
 */
function molarServe(material, item, mode, prior = []) {
  let changed = molarAdopt(material, item, mode, prior, { sameRowsOnly: true });
  changed = molarNormalize(material, item, mode, prior) || changed;
  const server = molarSolution(material, item, mode, prior);
  // A repair that leaves the server's tables gives the solution back to the designer and the judges' rewrites.
  item.serverWritten = Boolean(server);
  if (server && JSON.stringify(server) !== JSON.stringify(item.solution)) { item.solution = server; changed = true; }
  return changed;
}

/**
 * The original's answer worked by code on a molar-mass original: { ok, evidence } or null for any other original.
 * Opus's own check program wrote r2=(4*4)/(2+4+4) for 4/10 and failed a right transcription (2026-10-13, runs 10, 11).
 */
function molarSourceCheck(material) {
  const table = molar.readTable(material.problem?.text);
  if (!table?.hasRel) return null;
  const a = molar.analyse(table);
  // Printed values read as handwriting leave the table unsolvable: one reading left Ⅰ's and Ⅲ's leftover cells empty
  // and the whole set was made without the server's numbers (2026-10-13, Qwen 3.8 round 10).
  const empty = table.rows.filter((r) => !r.left || r.left.hidden === '?').map((r) => r.name);
  if (!a.ok && empty.length) return { ok: false, evidence: `표의 반응 후 질량 칸(${empty.join(', ')})이 비어 있어 선생님 풀이대로 계산할 수 없습니다. 인쇄된 값을 필기로 보고 뺐는지 원본을 확인하세요.` };
  const ask = String(material.problem.text).split('\n').map((l) => l.trim()).filter(Boolean).pop() || '';
  const value = a.ok ? molar.questionValue(table, a, ask) : null;
  const marked = material.problem.choices?.[material.problem.answer - 1];
  const given = marked ? molar.cellValue(marked).v : null;
  if (!value || !given) return null;
  const facts = `x = ${molar.str(a.hidden[Object.keys(a.hidden).find((k) => k.endsWith('.rel'))] || [0, 1])}, m : n = ${molar.str(a.q)}, b = ${molar.str(a.b)}, 값 ${molar.str(value)}`;
  return molar.str(value) === molar.str(given)
    ? { ok: true, evidence: `서버 계산(선생님 풀이대로 표를 읽음): ${facts} — 원본 정답 ${marked}와 일치` }
    : { ok: false, evidence: `서버 계산(선생님 풀이대로 표를 읽음): ${facts} — 원본 정답 ${marked}와 다름` };
}

/** The server's values for writing the solution of a problem on one of its tables (the same list the designer got
 *  with the table), or null for any other problem. */
function molarFacts(material, item, mode, prior = []) {
  const design = molarDesignOf(material, item, mode, prior);
  if (!design) return null;
  const facts = molar.solutionFacts(molar.readTable(molarPrinted(material, item.stage, design).table.join('\n')), 2, { withD: item.stage.kind === 'twin' });
  return facts.length ? facts : null;
}

/** The values a written solution on one of the server's tables must show — its hidden values, b and the answer —
 *  or null for any other problem. */
function molarTrusted(material, item, mode, prior = []) {
  const design = molarDesignOf(material, item, mode, prior);
  if (!design) return null;
  const p = molarPrinted(material, item.stage, design);
  const a = molar.analyse(molar.readTable(p.table.join('\n')));
  if (!a.ok) return null;
  const hidden = Object.entries(a.hidden || {}).map(([k, v]) => (k.endsWith('.rel') ? molar.texOf(v) : molar.texOf(v, 'w')));
  return [...hidden, ...(a.b && item.stage.kind === 'twin' ? [molar.texOf(a.b)] : []), p.choices[design.answer - 1]];
}
function molarSpec(material, item, mode, prior = []) {
  const design = molarDesignOf(material, item, mode, prior);
  if (!design) return null;
  return { program: [`ans = ${molar.str(design.value)}`], answer: 'ans', choices: design.choices.map(molar.str), free: [], checks: [] };
}

/**
 * A problem written on one of the server's tables gets the server's print of it: the table, the question sentence
 * and the choices with the answer. Qwen 3.6 copied them with slips the judges then failed (a lost ")", "반응후",
 * "III" for Ⅲ, the choices once more inside the text, 2026-10-12). Returns true when it changed something.
 */
function molarNormalize(material, item, mode, prior = []) {
  const design = molarDesignOf(material, item, mode, prior);
  if (!design) return false;
  const p = molarPrinted(material, item.stage, design);
  const lines = String(item.problem.text).split('\n');
  const isRow = (l) => /^\s*\|.*\|\s*$/.test(l);
  const start = lines.findIndex((l) => isRow(l) && /반응\s*전/.test(l));
  if (start < 0) return false;
  let end = start;
  while (end + 1 < lines.length && isRow(lines[end + 1])) end++;
  const isChoice = (l) => /^\s*(\(?[1-5]\)|[①②③④⑤])\s*\S/.test(l);
  const after = lines.slice(end + 1).filter((l) => !isChoice(l));
  const last = after.map((l) => l.trim()).lastIndexOf(after.map((l) => l.trim()).filter(Boolean).pop());
  const points = last >= 0 ? (after[last].match(/\(\d점\)\s*$/) || [''])[0] : '';
  if (last >= 0) after[last] = `${p.ask}${points ? ` ${points}` : ''}`;
  else after.push('', p.ask);
  // A final keeps the original's equation line: Qwen 3.6 wrote b = 2 into it (A + 2B), which gives STEP 3 away and
  // cost a repair (2026-10-13, run 8).
  const equation = String(material.problem.text).split('\n').find((l) => /\\ce\{[^}]*->/.test(l));
  const before = lines.slice(0, start).map((l) => (equation && /\\ce\{[^}]*->/.test(l) ? equation : l));
  // A practice problem is the server's whole: its premise, the table and the question.
  const text = p.lead ? [p.lead, '', ...p.table, '', p.ask].join('\n') : [...before, ...p.table, ...after].join('\n');
  let changed = text !== item.problem.text || JSON.stringify(item.problem.choices) !== JSON.stringify(p.choices) || item.problem.answer !== design.answer;
  item.problem = { ...item.problem, text, choices: p.choices, answer: design.answer };
  // The solution is the job's model's own, in every original: the server's numbers stay, its copy of this one
  // original's teacher sentences does not (2026-10-13 — hand-copied text scored 29/29 for any model and carried to no
  // other original). EDUMASTER_MOLAR_SOLUTION=1 brings the server-written solution back for comparison.
  // A practice prints no equation, only the coefficients: the teacher’s "화학 반응식에서" becomes "주어진 계수에서"
  // (Claude, 2026-10-12; again on Qwen 3.8’s frames, round 11).
  if (p.lead) for (const sol of [item.solution, item.outline]) for (const st of sol?.steps || []) {
    // Nor D's: the practice gives only C's coefficient (D's would be a condition its question never uses — Claude and
    // Gemini on Qwen 3.8's set, round 2 of the review; leaving D in the solution was the first review's note), so the
    // teacher's "C(g)와 D(g) … 각각" sentences speak of C alone.
    const w = String(st.work || '').replace(/화학 반응식에서/g, '주어진 계수에서')
      .replace(/(\$\\ce\{C\(g\)\}\$|C\(g\))와 (\$\\ce\{D\(g\)\}\$|D\(g\))의 계수는 각각/g, '$1의 계수는')
      .replace(/(\$\\ce\{C\(g\)\}\$|C\(g\))와 (\$\\ce\{D\(g\)\}\$|D\(g\))의 양\(mol\)은 각각/g, '$1의 양(mol)은')
      .replace(/(\$\\ce\{C\(g\)\}\$|C\(g\))와 (\$\\ce\{D\(g\)\}\$|D\(g\))는 각각/g, '$1는');
    if (w !== st.work) { st.work = w; changed = true; }
  }
  if (!serverSolution()) {
    for (const sol of [item.solution, item.outline]) {
      const summary = `정답은 ${'①②③④⑤'[design.answer - 1]} ${p.choices[design.answer - 1]}이다.`;
      if (sol?.steps?.length && sol.summary !== summary) { sol.summary = summary; changed = true; }
    }
    return changed;
  }
  // The teacher's STEP 1 sentence, worked by code: Qwen 3.6 wrote "B 2.5w g이 반응해서 1.5w g이 남은" for a row
  // with 4w of B and 3w left, beside the server's own values (2026-10-12, run 6).
  // The whole of STEP 1 is the teacher's five sentences on the server's values (run 8: each slip in their wording
  // cost an Opus rewrite); a closing "정답은 …" line of a STEP 1 practice stays.
  // The server's sentences break lines where this reading of the teacher's solution does: one reading had "…남았고,
  // Ⅱ에서 …" and "…m이라 하면 Ⅰ에서 …" on one line, another on two, and the judges held each to its own reading
  // (2026-10-13, run 10).
  const teacher = (i) => String(material.steps?.[i]?.work || '');
  const likeReading = (text, i) => {
    const t = teacher(i);
    let out = String(text);
    if (/남았고,[ \t]+\S+\s*에서/.test(t)) out = out.replace(/(남았고,)\n(?=\S+에서 A )/, '$1 ');
    if (/하면[ \t]+\S+\s*에서/.test(t)) out = out.replace(/(이라 하면)\n/, '$1 ');
    return out;
  };
  // The teacher's choice heading as this reading has it ("| 선택지 분석 |" in one, a plain line in another, run 12)
  // closes every solution, practice ones too (Claude's review of run 18).
  const box = teacher(material.steps.length - 1).split('\n').map((l) => l.trim()).find((l) => /선택지 분석/.test(l)) || null;
  const mark = '①②③④⑤'[design.answer - 1];
  const tableA = molar.readTable(p.table.join('\n'));
  const read = molar.analyse(tableA);
  const one = molar.stepOneText(tableA);
  if (one) one.text = likeReading(one.text, 0);
  if (one) {
    for (const sol of [item.solution, item.outline]) {
      const step = sol?.steps?.[0];
      if (!step?.work) continue;
      // Only the same assumption (row and reactant) is replaced; a STEP 1 on another row is left to the judges.
      const head = one.text.match(/^만약 \S+에서 [AB]가/)[0];
      if (!String(step.work).includes(head)) continue;
      // A STEP 1 practice ends with its choice: Ⅲ's leftover, read off the last sentence.
      const x3 = read.ok && read.hidden['Ⅲ.left'];
      const three3 = read.ok && read.rows.find((r) => r.name === 'Ⅲ');
      const close1 = p.lead && sol.steps.length === 1 && x3 && three3
        ? ['', ...(box ? [box] : []), `${mark} Ⅲ에서는 ${three3.leftOf} ${molar.texOf(x3, 'w')} g이 남으므로 $x=${molar.texOf(x3, 'w').slice(1, -1)}$이다.`, `정답은 ${mark} ${p.choices[design.answer - 1]}이다.`] : null;
      const work = [one.text, ...(close1 || String(step.work).split('\n').filter((l) => /^정답은/.test(l.trim())))].join('\n');
      // The title ends as the original's STEP 1 title ends (with or without the period, as the reading has it).
      const dot = /\.\s*$/.test(material.steps?.[0]?.title || '.') ? one.title : one.title.replace(/\.$/, '');
      const title = /한계 반응물/.test(step.title || '') ? dot : step.title;
      if (work !== step.work || title !== step.title) { step.work = work; step.title = title; changed = true; }
    }
  }
  // STEP 2's mass table, n and m, and the row sentences are the teacher's on the server's values; what the writer
  // added after them (the practice's answer worked out) stays.
  const two = molar.stepTwoText(molar.readTable(p.table.join('\n')), undefined, { withD: item.stage.kind === 'twin' });
  if (two) {
    for (const sol of [item.solution, item.outline]) {
      const step = sol?.steps?.[1];
      if (!step?.work || !/자료는 다음과 같다|양\(mol\)을/.test(step.work)) continue;
      const kept = String(step.work).split('\n').filter((l) => l.trim() && !/^\s*\|/.test(l) && !/자료는 다음과 같다/.test(l) && !/양\(mol\)을\s*\$?n/.test(l) && !two.isRowLine(l));
      // A STEP 1~2 practice ends with its question worked out, by code when the server can read the question.
      const t2 = molar.readTable(p.table.join('\n'));
      const closing2 = p.lead && item.stage.upto >= 2 && sol.steps.length === 2
        ? molar.practiceAnswerText(t2, molar.analyse(t2), p.ask, p.choices[design.answer - 1], '①②③④⑤'[design.answer - 1]) : null;
      const work = likeReading([...two.lines, ...(closing2 ? ['', ...(box ? [box] : []), `${mark} ${closing2[0]}`, ...closing2.slice(1)] : kept)].join('\n'), 1);
      if (work !== step.work) { step.work = work; changed = true; }
    }
  }
  // A final's STEP 3 up to the choices is the teacher's on the server's values; the writer's choice analysis and the
  // answer worked out for this question stay.
  const table3 = molar.readTable(p.table.join('\n'));
  let three = item.stage.kind === 'twin' ? molar.stepThreeText(table3, undefined, p.ask) : null;
  // "Ⅲ에서 이 실젯값은" in one reading, "Ⅲ에서의 실젯값은" in another (run 11): the reading's wording.
  if (three && /에서의 실젯값은/.test(teacher(2)) && !/에서 이 실젯값/.test(teacher(2))) three = three.map((l) => l.replace(/에서 이 실젯값은/, '에서의 실젯값은'));
  const closing = three ? molar.answerText(table3, molar.analyse(table3), p.ask, p.choices[design.answer - 1], mark) : null;
  if (three) {
    for (const sol of [item.solution, item.outline]) {
      const step = sol?.steps?.[2];
      if (!step?.work) continue;
      const lines = String(step.work).split('\n');
      const from = lines.findIndex((l) => /선택지 분석|^\s*[①②③④⑤]|^\s*정답은/.test(l));
      if (from < 0 && !closing) continue;
      // The answer worked out is the server's when it can read the question; else the writer's lines stay.
      const tail = closing || lines.slice(from);
      const work = [...three, '', ...(box && !/선택지 분석/.test(tail[0]) ? [box] : []), ...tail].join('\n');
      if (work !== step.work) { step.work = work; changed = true; }
    }
  }
  for (const sol of [item.solution, item.outline]) {
    const steps = sol?.steps || [];
    if (!steps.length) continue;
    // A practice without the equation: the coefficients are the problem's, not "the equation's" (Claude, 2026-10-12).
    if (p.lead) for (const s of steps) {
      const work = String(s.work || '').replace(/화학 반응식에서/g, '주어진 계수에서');
      if (work !== s.work) { s.work = work; changed = true; }
    }
    // The app's one-line summary is the server's answer: the outline's said 15 for an answer of 30 (Claude's review of
    // run 12, 2026-10-13).
    const summary = `정답은 ${'①②③④⑤'[design.answer - 1]} ${p.choices[design.answer - 1]}이다.`;
    if (sol.summary !== summary) { sol.summary = summary; changed = true; }
    // The teacher's last line, "정답은 ② 2w g이다." — the STEP 1 practice once ended without it (Claude, 2026-10-12).
    const last = steps[steps.length - 1];
    if (!steps.some((s) => /정답은/.test(s.work || ''))) {
      last.work = `${String(last.work || '').trimEnd()}\n정답은 ${'①②③④⑤'[design.answer - 1]} ${p.choices[design.answer - 1]}이다.`;
      changed = true;
    }
  }
  return changed;
}

/** A molar-mass problem's table read by the teacher's method (molar.analyse): one reading, the assumption needed, and
 *  for an integrated final two or more structure items changed — counted by code, not judged by a model each time. */
function checkMolar(material, item, mode) {
  const orig = molar.readTable(material.problem.text);
  const oa = orig && molar.analyse(orig);
  const table = molar.readTable(item.problem.text);
  if (!oa?.ok || !table) return [];
  const a = molar.analyse(table);
  const options = () => molarOptions(material, item.stage, mode);
  const out = [];
  if (!a.ok) {
    out.push(result('molar-reading', '몰질량 표가 선생님 풀이로 하나로 풀림', false, `${a.why}. 수치를 다시 짐작하지 말고 서버가 계산한 표를 그대로 쓴다.\n${options()}`, 'hard'));
    return out;
  }
  if (!a.chains.length) out.push(result('molar-reading', '몰질량 표가 선생님 풀이로 하나로 풀림', false, `어느 실험에서 가정해도 다른 실험과 모순이 나지 않아 선생님의 가정→모순 판정이 필요 없습니다.\n${options()}`));
  // The asked hidden value of a practice: the marked choice must be the value the table gives.
  const hidden = Object.entries(a.hidden);
  if (item.stage.kind === 'upto' && hidden.length === 1 && /남은[^?]*질량/.test(plain(item.problem.text).split('\n').slice(-2).join(' '))) {
    const marked = molar.cellValue(String(item.problem.choices[item.problem.answer - 1] || '').replace(/\s*g\s*$/, ''));
    if (marked.v && molar.str(marked.v) !== molar.str(hidden[0][1])) out.push(result('molar-answer', '정답이 표로 계산한 값과 같음', false, `표로 계산하면 ${hidden[0][0]} = ${molar.str(hidden[0][1])}w인데 표시된 정답은 ${molar.str(marked.v)}w입니다.`, 'hard'));
  }
  if (item.stage.kind === 'twin' && mode === 'integrated' && orig.hasRel) {
    const changes = molarChanges(material, item);
    out.push(result('molar-structure', '최종 문제가 원본과 구조가 다름 (코드 판정)', changes.length >= 2,
      changes.length >= 2 ? `달라진 항목: ${changes.join(', ')}` : `원본과 달라진 구조 항목이 ${changes.length}개${changes.length ? `(${changes.join(', ')})` : ''}뿐입니다. 둘 이상이어야 합니다.\n${options()}`));
  }
  return out;
}
/** The structure items (prompts VARIATION_CRITERIA) a molar-mass final changed, by code; null when not one. */
function molarChanges(material, item) {
  const orig = molar.readTable(material.problem.text);
  const table = molar.readTable(item.problem?.text);
  const oa = orig && molar.analyse(orig);
  const a = table && molar.analyse(table);
  if (!oa?.ok || !a?.ok || !orig.hasRel) return null;
  return molar.structureChanges(molar.structure(orig, oa, molar.askOf(material.problem.text)), molar.structure(table, a, molar.askOf(item.problem.text)));
}

function inspectItem(material, item, mode) {
  return [
    ...checkMolar(material, item, mode),
    ...checkChoices(material, item),
    ...checkOxConsistency(material, item),
    ...checkHelpers(material, item),
    ...checkAssumption(material, item),
    ...checkStepTitles(material, item),
    ...checkSolutionTables(material, item),
    ...checkEquation(material, item),
    ...checkUnusedCoefficient(item),
    ...checkObviousLeftover(material, item),
    ...checkNumbersOnly(material, item, mode),
    ...checkSameShape(material, item, mode),
    ...checkClueLeak(material, item),
    ...checkFormat(item),
    ...checkCleanNumbers(item),
    ...checkNerveRow(item),
    ...checkNerveReading(material, item, mode),
    ...checkNerveStimOrder(material, item),
    ...checkNervePractice(material, item),
  ];
}

// ---------------------------------------------------------------- analysis (source) checks

// Word pairs a reader confuses and that change the meaning (v1 source-quantity: 물질량 ↔ 몰질량).
// 실젯값 ↔ 실댓값: Qwen 3.8's reading of the molar-mass solution (2026-10-13).
const CONFUSABLE = [['물질량', '몰질량'], ['실댓값', '실젯값']];

/** Hangul words of `target` that two independent re-reads agree should be different (e.g. 물질량 → 몰질량). */
function hangulFixes(target, readA, readB, pairs = CONFUSABLE, maxDistance = 1) {
  const words = (s) => [...plain(s).replace(/[－−–]/g, '-').matchAll(/[가-힣]+|-?\d+(?:\.\d+)?/g)].map((m) => m[0]);
  const a = words(readA); const b = words(readB);
  if (!a.length || a.join('|') !== b.join('|')) return [];
  const t = words(target);
  // Align by longest common subsequence; unmatched runs of equal length are compared pairwise.
  const dp = Array.from({ length: t.length + 1 }, () => new Array(a.length + 1).fill(0));
  for (let i = t.length - 1; i >= 0; i--) for (let j = a.length - 1; j >= 0; j--) dp[i][j] = t[i] === a[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const fixes = [];
  let i = 0; let j = 0; let runT = []; let runA = [];
  const flush = () => {
    if (runT.length && runT.length === runA.length) {
      runT.forEach((w, k) => {
        const r = runA[k];
        const numeric = /^-?\d/.test(w) && /^-?\d/.test(r);
        // Words: one letter changed, missing or extra (물질량→몰질량, 질량→몰질량), or a known/learned confusable
        // pair with the same ending (질량비는→부피비는). Numbers: any change.
        const known = pairs.some((p) => p.some((x) => w.startsWith(x) && p.some((y) => y !== x && r === y + w.slice(x.length))));
        const d = numeric ? 0 : editDistance(w, r);
        // A change of more than one letter counts only as an isolated one-word substitution, not inside a rewrite.
        const similar = d === 1 || (d >= 2 && d <= maxDistance && runT.length === 1 && Math.min(w.length, r.length) > d);
        if (numeric ? w !== r : similar || known) fixes.push([w, r]);
      });
    }
    runT = []; runA = [];
  };
  while (i < t.length && j < a.length) {
    if (t[i] === a[j]) { flush(); i++; j++; } else if (dp[i + 1][j] >= dp[i][j + 1]) runT.push(t[i++]); else runA.push(a[j++]);
  }
  runT.push(...t.slice(i)); runA.push(...a.slice(j)); flush();
  return fixes;
}

function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  }
  return d[a.length][b.length];
}

/** Replaces whole words only, so fixing 질량→몰질량 never turns an existing 몰질량 into 몰몰질량. */
function applyWordFixes(text, fixes) {
  let out = String(text || '');
  for (const [wrong, right] of fixes) {
    const escaped = wrong.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
    out = out.replace(new RegExp(`(?<![가-힣0-9])${escaped}(?![가-힣0-9])`, 'g'), right);
  }
  return out;
}

/**
 * Once two focused reads confirm a word of a known confusable pair (e.g. the question says 몰질량), the same
 * reader's slips to its partner elsewhere (해설의 물질량) are corrected too — as substrings, since Korean
 * attaches particles (물질량을). Only for listed pairs, where the confusion is known to be systematic
 * (the built-in list plus the teacher's past corrections, see learning.readingPairs).
 */
function confusableFixes(confirmedWords, pairs = CONFUSABLE) {
  const out = [];
  for (const pair of pairs) {
    const right = pair.find((w) => confirmedWords.some((c) => c.startsWith(w)));
    if (right) for (const wrong of pair) if (wrong !== right) out.push([wrong, right]);
  }
  return out;
}

function applySubstringFixes(text, fixes) {
  let out = String(text || '');
  for (const [wrong, right] of fixes) out = out.split(wrong).join(right);
  return out;
}

module.exports = { uncoveredLines, renderFrames, molarFacts, validateFrames, frameFindings, frameRegex, teacherChoiceHeading, molarOptions, molarChanges, molarSpec, molarNormalize, molarTrusted, molarSourceCheck, molarSolution, molarAdopt, molarServe, shapeOptions, practiceOptions, nerveSetup, checkNerveRow, judgments, assumedCase, checkDirection, titleKey, plain, helperVariables, stageSteps, skeleton, formatIssues, inspectItem, hangulFixes, applyWordFixes, confusableFixes, applySubstringFixes, editDistance, CONFUSABLE };
