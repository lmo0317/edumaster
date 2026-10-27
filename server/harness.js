'use strict';
// Code checks carried over from v1's ProblemQualityHarness / TeacherMethodPolicy / VariantDesignPolicy /
// ExplanationConsistencyCheck, rewritten for v2's data and made subject-independent where v1 was not.
// Each check returns { id, label, state: 'pass'|'fail', evidence, severity: 'hard'|'design' }:
//   hard   → the problem is wrong (goes to teacher review if the repair does not fix it)
//   design → the problem works but breaks a teacher/design rule (triggers the repair, then stays a warning)


/** Math-insensitive plain text: \ce{A} → A, \text{x} → x, \frac{a}{b} → a/b, $ removed. */
function plain(text) {
  return String(text || '')
    .replace(/\\(?:ce|text|mathrm|mathbf)\s*\{([^{}]*)\}/g, '$1')
    .replace(/\\d?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, '$1/$2')
    .replace(/\\[,;:! ]/g, ' ')
    .replace(/\$/g, '');
}

const result = (id, label, ok, evidence, severity = 'design') => ({ id, label, state: ok ? 'pass' : 'fail', evidence, severity });

// ---------------------------------------------------------------- notation (the system's, never the model's)

const SUBSCRIPT = '₀₁₂₃₄₅₆₇₈₉';
const subDigits = (t) => String(t).replace(/[₀-₉]/g, (d) => String(SUBSCRIPT.indexOf(d)));
// A chemical formula written as plain text: element-like capitals with a count (X2, X₂, CO2, X2Z4) or a state (A(s)).
const FORMULA = /(?<![A-Za-z0-9\\{}_^])((?:[A-Z][a-z]?[0-9₀-₉]*)+(?:\((?:g|l|s|aq)\))?)(?![A-Za-z0-9{(])/g;
// A count in a formula is 2 or more, so a label like S1 or A1 is not one.
const isFormula = (f) => /[0-9₀-₉]|\((?:g|l|s|aq)\)$/.test(f) && (subDigits(f).match(/\d+/g) || []).every((n) => n !== '1' && n[0] !== '0');
/**
 * Every chemical formula outside $…$ written as $\ce{…}$, the form the review criteria hold all text to (D 표기). The
 * system writes it, in every text a problem has — its question, choices, figure, the solution's titles and lines —
 * so no fault of notation ever goes back to a model. Fixed where it was seen only (the body lines of density's
 * frames, 2026-10-16), the STEP titles the system copies from the analysis kept X₂ and the gas original's four sets
 * failed on it to the end (2026-10-21).
 */
// Outside chemistry a capital with a count is a quantity, not a formula: 생명 E37's force F₂ became $\ce{F2}$ in a STEP
// title (학습 반복, 2026-10-23, Gemini). There a letter with a subscript (F₁, t₂) is written as math, $F_1$.
function notation(text, known = [], { formulas = true } = {}) {
  // Unpaired $ (an opened formula never closed) would turn every later Korean word into \text{…}; the field is left as
  // it is and checkFormat names the fault.
  if ((String(text ?? '').replace(/\\\$/g, '').match(/\$/g) || []).length % 2) return String(text ?? '');
  return josa(String(text ?? '').split(/(\$\$?[^$]*\$\$?)/).map((part, i) => (i % 2 ? mathPart(part, formulas)
    : formulas ? bareFormulas(part, Array.isArray(known) ? known : []).replace(FORMULA, (all, f) => (isFormula(f) ? `$\\ce{${subDigits(f)}}$` : all))
      : part.replace(/(?<![A-Za-z0-9\\{}_^$])([A-Za-z])([₀-₉]+)(?![A-Za-z0-9₀-₉])/g, (all, l, d) => `$${l}_${d.length > 1 ? `{${subDigits(d)}}` : subDigits(d)}$`))).join(''));
}
const formulasIn = (material) => !material?.subject || /화학/.test(material.subject);
// Inside $…$: a formula alone written as math ($Y2Z$, no subscript) is $\ce{…}$, and Korean is put in \text{} (as
// $\frac{질량}{양(mol)}$ or 24g/몰 were left on 화학 C38 and C32, 2026-10-22, the reviewers' notes on every set).
function mathPart(part, formulas = true) {
  const [, open, body, close] = /^(\$\$?)([\s\S]*?)(\$\$?)$/.exec(part) || [];
  if (body === undefined) return part;
  const alone = body.trim();
  if (formulas && /^(?:[A-Z][a-z]?[0-9₀-₉]*)+(?:\((?:g|l|s|aq)\))?$/.test(alone) && isFormula(alone)) return `${open}\\ce{${subDigits(alone)}}${close}`;
  const fixed = body.split(/(\\(?:text|ce|mathrm|operatorname)\s*\{[^{}]*\})/).map((seg, k) => (k % 2 ? seg
    : seg.replace(/[가-힣]+(?:\s+[가-힣]+)*/g, (ko) => `\\text{${ko}}`))).join('');
  return open + fixed + close;
}
// Formulas without a count (XZ) cannot be told from other capitals, so only those the problem itself writes as \ce are
// put in \ce where the solution leaves them bare ("XZ 분자 수를 n이라 하면", 화학 C38 2026-10-22).
function bareFormulas(part, known) {
  let out = part;
  for (const f of known) out = out.replace(new RegExp(`(?<![A-Za-z0-9\\\\{}_^])${f.replace(/[()]/g, '\\$&')}(?![A-Za-z0-9{(])`, 'g'), `$\\ce{${f}}$`);
  return out;
}
const knownFormulas = (text) => [...new Set([...String(text || '').matchAll(/\\ce\{([A-Za-z0-9()]+)\}/g)].map((m) => m[1]).filter((f) => /^[A-Z]/.test(f) && f.length >= 2))].sort((a, b) => b.length - a.length);
// The particle after a Roman numeral as it is read (Ⅰ 일, Ⅱ 이, Ⅲ 삼, Ⅳ 사, Ⅴ 오): the teacher's sentence frames take
// another numeral in its place and kept the particle ("Ⅳ이 d₄이다", "Ⅰ와 Ⅲ는"), which both reviewers marked on 생명 D50.
const FINAL = { 'Ⅰ': 'ㄹ', 'Ⅱ': '', 'Ⅲ': 'ㅁ', 'Ⅳ': '', 'Ⅴ': '' };
const PAIRS = [['은', '는'], ['이', '가'], ['을', '를'], ['과', '와']];
// The same for a name or value ending in a digit, read by its last digit: a number in Korean ($3$ 삼, 구성원 4 사, 0 as
// 영·십·백), a letter's index in English as the teachers write it ($d_3$는 디쓰리, step 3를, $d_1$은 디원). A frame that
// took $d_1$ for the teacher's $d_3$ kept "$d_1$는" (생명 D50 학습 반복, 2026-10-23, Claude).
const DIGIT_FINAL = { 0: 'ㅇ', 1: 'ㄹ', 2: '', 3: 'ㅁ', 4: '', 5: '', 6: 'ㄱ', 7: 'ㄹ', 8: 'ㄹ', 9: '' };
const INDEX_FINAL = { 0: '', 1: 'ㄴ', 2: '', 3: '', 4: '', 5: '', 6: '', 7: 'ㄴ', 8: 'ㅅ', 9: 'ㄴ' };
const SUB_DIGIT = '₀₁₂₃₄₅₆₇₈₉';
function josa(text) {
  const fit = (final, p) => {
    if (p === '으로' || p === '로') return final && final !== 'ㄹ' ? '으로' : '로';
    const pair = PAIRS.find((x) => x.includes(p));
    return final ? pair[0] : pair[1];
  };
  return text.replace(/([ⅠⅡⅢⅣⅤ])(으로|로|은|는|이|가|을|를|과|와)(?![가-힣])/g, (all, n, p) => n + fit(FINAL[n], p))
    .replace(/([0-9₀-₉])(\}?\$?)(으로|로|은|는|이|가|을|를|과|와)(?![가-힣])/g, (all, d, close, p, at, s) => {
      // A count in a formula is read in English ($\ce{XY3}$ 엑스와이쓰리): left as written.
      const before = s.slice(0, at + 1);
      // A valence (3가 양이온, 1가 알코올) is not a particle.
      if (p === '가' && /^\s+(?:양이온|음이온|알코올|산|염기|아민|알켄|페놀)/.test(s.slice(at + all.length))) return all;
      // A fraction is read denominator first (\frac{1}{3} 삼분의 일): left as written too.
      if (/\\ce\{[^}]*$/.test(before) || /[A-Z][0-9₀-₉]+$/.test(before) || /\\[dt]?frac\{[^}]*\}\{[^}]*$/.test(before)) return all;
      const digit = SUB_DIGIT.includes(d) ? SUB_DIGIT.indexOf(d) : Number(d);
      const indexed = /[A-Za-z]\s*_?\{?[0-9₀-₉]+$/.test(before);
      return d + close + fit((indexed ? INDEX_FINAL : DIGIT_FINAL)[digit], p);
    });
}
/** notation() over all of a problem's text (mutates `item`); formulas only in a chemistry original's problems. */
function notateItem(item, material) {
  const opts = { formulas: formulasIn(material) };
  const at = (t, known = []) => notation(t, known, opts);
  if (item.problem) {
    item.problem.text = at(item.problem.text);
    item.problem.choices = (item.problem.choices || []).map((c) => at(c));
    if (item.problem.figure) item.problem.figure = at(item.problem.figure);
  }
  const known = opts.formulas ? knownFormulas(item.problem?.text) : [];
  for (const s of item.solution?.steps || []) { s.title = at(s.title, known); s.work = at(s.work, known); }
  if (item.solution?.summary) item.solution.summary = at(item.solution.summary, known);
}
/** The original as the system shows it to writers and reviewers: the same notation (a copy). */
function notateMaterial(material) {
  if (!material?.problem) return material;
  const at = (t) => notation(t, [], { formulas: formulasIn(material) });
  return {
    ...material,
    problem: { ...material.problem, text: at(material.problem.text), choices: (material.problem.choices || []).map((c) => at(c)), figure: material.problem.figure ? at(material.problem.figure) : material.problem.figure },
    steps: (material.steps || []).map((s) => ({ ...s, title: at(s.title), work: at(s.work), result: s.result ? at(s.result) : s.result })),
  };
}

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
// Only the heading is the teacher's: a reading may put the heading and the teacher's own closing calculation on one
// line ("[선택지 분석] $b=3$, $x=15$, … $=\\frac{2}{5}$이다.", molar mass read on 2026-10-26), and that whole line put
// into every variant was the one fault of four sets in a row (78·79, the 학습 반복 rewording a lesson each time).
// The heading is the line up to its closing bracket or bar; what follows it stays where it is.
// Only a line that starts as the heading is one ("| 선택지 분석 |", "[선택지 분석] …", "선택지 분석:"); a sentence that
// uses the words ("선택지 분석을 하면 …") is not.
const HEADING_LINE = /^[\[［|【*\s]*선택지\s*분석(?:\s*[\]］|】*:：]+|\s*$)/;
const choiceHeading = (line) => {
  const t = String(line || '').trim();
  if (!HEADING_LINE.test(t)) return null;
  const m = t.match(/^(.*?선택지\s*분석(?:\s*[\]］|】*:：]+)?)\s*(.*)$/);
  return m ? { head: m[1].trim(), rest: m[2].trim() } : null;
};
function teacherChoiceHeading(material, item) {
  const steps = material.steps || [];
  const teacher = String(steps[steps.length - 1]?.work || '').split('\n').map(choiceHeading).find(Boolean);
  const last = item.solution?.steps?.[item.solution.steps.length - 1];
  if (!teacher || !last?.work) return false;
  const box = teacher.head;
  const lines = String(last.work).split('\n');
  // A heading the writer gave in its own form ("선택지 분석" for "| 선택지 분석 |") is the teacher's heading; what the
  // writer put after it on the line is its own and stays.
  const own = lines.findIndex((l) => choiceHeading(l));
  if (own >= 0) {
    const mine = choiceHeading(lines[own]);
    const next = mine.rest ? `${box} ${mine.rest}` : box;
    if (lines[own].trim() === next) return false;
    lines[own] = next;
    last.work = lines.join('\n');
    return true;
  }
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
// So are X₂ and X2 (notation writes every formula as $\ce{X2}$).
const frameLine = (l) => subDigits(String(l || '').replace(/\$\\ce\{([^{}]*)\}\$/g, '$1').replace(/\\ce\{([^{}]*)\}/g, '$1')).replace(/\s+/g, ' ').trim();
// Not held to a frame: table rows, a line of formulas only (a proportion, the choice's own numbers — the teacher's has
// other numbers in it, so its frame is all slots), and the closing choice and answer lines (teacherChoiceHeading).
const frameSkip = (l) => !l || /^\|.*\|$/.test(l) || /^\|?\s*-{3}/.test(l) || /^[★*•\s]*([①②③④⑤]|정답은)/.test(l)
  || String(l).replace(/\$[^$]*\$/g, '').replace(/[^가-힣]/g, '').length < 4;
// The fixed parts of a frame (its text between the slots), and the regex that holds a line to it. Slots that stand next
// to each other with nothing but spaces between them are one slot: "《물질1》 《질량1》 《물질2》 《질량2》" gave four
// unbounded groups in a row, and a long line that does not match made the regex try every split of it — n^4 steps,
// 40 seconds on a 1,000-letter line, the whole server frozen with it (2026-10-27 review). The regexes are kept by frame.
const SLOT = /《[^《》]{1,20}》/g;
const frameRegexes = new Map();
function frameRegex(frame) {
  let re = frameRegexes.get(frame);
  if (re) return re;
  // Whitespace-only fixed parts are dropped with the slot before them merged into the next.
  const parts = String(frame).split(SLOT).map(frameLine);
  const merged = [parts[0]];
  for (let i = 1; i < parts.length; i++) { if (parts[i] === '' && i < parts.length - 1) continue; merged.push(parts[i]); }
  re = new RegExp(`^${merged.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s*')).join('(.+?)')}$`);
  if (frameRegexes.size > 2000) frameRegexes.clear();
  frameRegexes.set(frame, re);
  return re;
}
const FRAME_LINE_MAX = 600;
/** Whether the line fits the frame: a cheap check that every fixed part occurs in order first, the regex only then. */
function frameMatches(frame, line) {
  if (!line || line.length > FRAME_LINE_MAX) return false;
  let at = 0;
  for (const p of String(frame).split(SLOT).map(frameLine)) {
    if (!p) continue;
    const i = line.replace(/\s+/g, '').indexOf(p.replace(/\s+/g, ''), at);
    if (i < 0) return false;
    at = i + p.replace(/\s+/g, '').length;
  }
  return frameRegex(frame).test(line);
}
/** Frames worth holding a line to: enough fixed words that a frame is not "anything". */
function frameFixed(frame) {
  return frameLine(String(frame).replace(/《[^《》]{1,20}》/g, '')).replace(/[\s$\\{}()^_.,]/g, '').length;
}
// A frame is the teacher's sentence with the problem's values as slots. One whose fixed text still carries a value —
// "따라서 $x=15$이고 $b=3$이다.", "$\frac{w}{15}$ mol", "20 g", "②가 정답이다", a $ left open — would put the original's
// number into every variant that fills it (the class of the 2026-10-26 molar-mass fault, where the teacher's closing
// line went into every solution). Such a frame is not kept: the writer writes that line itself and the review judges
// it. A count that is part of the method (2배, 2k, 식 (1), 계수는 각각 2) is not a value.
const VALUE_IN_FIXED = [
  /[①②③④⑤]/,
  /=\s*\$?\s*-?\d+(?:\.\d+)?\s*(?:\$|$|[가-힣,;.)\s])/,
  /\\[dt]?frac\{\s*(?:-?\d+(?:\.\d+)?|[a-zA-Z]{1,2})\s*\}\{\s*-?\d+(?:\.\d+)?\s*\}/,
  /\d+(?:\.\d+)?\s*[a-z]?\s*\$?\s*(?:g|mol|L|mL|cm|mm|μm|\\mu ?m|%|℃|°C|kJ|J|atm|Pa)(?![A-Za-z])/,
];
function carriesValue(frame) {
  const fixed = String(frame).replace(/《[^《》]{1,20}》/g, ' ');
  if ((fixed.replace(/\\\$/g, '').match(/\$/g) || []).length % 2) return true;
  return VALUE_IN_FIXED.some((re) => re.test(fixed));
}

/** The extracted frames kept: those that match a line of their own STEP of the teacher's solution. */
function validateFrames(material, extracted) {
  const out = [];
  // One entry per STEP: the frames asked for again for the lines left over came back as a second entry of the same STEP,
  // and every lookup took the first — the choice analysis' frames ([틀 3-4] on) were "없는 틀 번호" and the writer was
  // asked again and again (7 of 9 new originals on 2026-10-21/22; molar mass and density, framed in one pass, had one).
  const byStep = new Map();
  // The model's shape is not trusted: steps that is not a list, an entry that is not an object, frames that is not a
  // list of strings — one such entry lost the frames of every STEP (the TypeError was caught a level up).
  for (const s of Array.isArray(extracted?.steps) ? extracted.steps : []) {
    if (!s || typeof s !== 'object') continue;
    const k = Number(s.step);
    if (!Number.isInteger(k) || k < 1) continue;
    const list = Array.isArray(s.frames) ? s.frames.filter((f) => typeof f === 'string') : [];
    byStep.set(k, { step: k, frames: [...(byStep.get(k)?.frames || []), ...list] });
  }
  for (const s of [...byStep.values()].sort((a, b) => a.step - b.step)) {
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
    // In the order of the teacher's lines, so [틀 n-k] runs down the STEP as the teacher wrote it.
    const at = (f) => lines.findIndex((l) => frameMatches(f, l));
    // A frame of more than five slots is a list of values, not a sentence to hold a line to.
    const slots = (f) => (f.match(SLOT) || []).length;
    const frames = [...new Set((s.frames || []).map(frameLine).map(unique))].filter((f) => f && slots(f) <= 5 && frameFixed(f) >= 6 && at(f) >= 0 && !carriesValue(f)).sort((a, b) => at(a) - at(b));
    if (frames.length) out.push({ step: i + 1, frames, lines: lines.length, covered: lines.filter((l) => frames.some((f) => frameMatches(f, l))).length });
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
      if (!mine.some((f) => frameMatches(f, line))) out.push({ step: i + 1, line });
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
      if (frameSkip(line) || line.length > FRAME_LINE_MAX || mine.frames.some((f) => frameMatches(f, line))) continue;
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
// Full-width brackets, bold marks and a trailing \r are the writer's spellings of the same reference.
const FRAME_REF = /^\s*(?:\*\*)?\s*[\[［]\s*틀\s*(\d+)\s*[-–.]\s*(\d+)\s*[\]］]\s*(?:\*\*)?\s*(.*?)\s*$/;
// Frames are kept without \ce (frameLine), so a species the teacher writes as "$\ce{A(s)}$" goes back in that form
// outside the frame's $…$ (reaction-density, 2026-10-16: every set wrote "A(s)" and the judge failed the notation).
function teacherCe(material, text) {
  const species = new Set();
  for (const s of material.steps || []) for (const m of String(s.work || '').matchAll(/\$\\ce\{([A-Za-z0-9]+\([a-z]+\))\}\$/g)) species.add(m[1]);
  if (!species.size) return text;
  const any = new RegExp(`(?<![A-Za-z0-9{])(${[...species].map((x) => x.replace(/[()]/g, '\\$&')).join('|')})`, 'g');
  return text.split(/(\$[^$]*\$)/).map((part, i) => (i % 2 ? part : part.replace(any, '$\\ce{$1}$'))).join('');
}
function renderFrames(material, item) {
  const missing = [];
  const frames = material.frames || [];
  for (const step of item.solution?.steps || []) {
    const lines = String(step.work || '').replace(/\r/g, '').split('\n').map((line) => {
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
      return teacherCe(material, text.replace(/\s+(에서|에서는|에서의)(?=\s|$)/g, '$1'));
    });
    // Fractions as the teacher writes them: Qwen 3.8 wrote 24/7w and 21w/2 inside $…$ (round 10).
    step.work = lines.join('\n').replace(/\$[^$\n]*\$/g, (math) => math
      .replace(/(?<![\w{])(\d+)\s*\/\s*(\d+)\s*([a-z])(?![\w}])/g, '\\frac{$1}{$2}$3')
      .replace(/(?<![\w{])(\d+)\s*([a-z])\s*\/\s*(\d+)(?![\w}])/g, '\\frac{$1}{$3}$2')
      .replace(/(?<![\w{])(\d+)\s*\/\s*(\d+)(?![\w}])/g, '\\frac{$1}{$2}'));
    const original = material.steps?.[step.step - 1]?.title;
    if (original && step.title) step.title = stepTitle(original, step.title);
  }
  answerLine(item);
  teacherChoiceHeading(material, item);
  notateItem(item, material);
  return missing;
}

// Labels a problem names its experiments, containers or points by: Ⅰ, (가), ㉠, and runs of them ("(가)~(다)",
// "Ⅰ과 Ⅱ", "(가), (나)").
const LABEL = '(?:[ⅠⅡⅢⅣⅤ]|\\([가-하]\\)|[㉠-㉭])';
const LABEL_RUN = new RegExp(`${LABEL}(?:\\s*(?:~|,|와|과|및)\\s*${LABEL})*`, 'g');
// A title also names the problem's members, parts and moments: "구성원 3, 4, 8", ⓐ~ⓒ, ㄹ~ㅂ as read, t₁. Without the
// numbers the system put L64's "3, 4, 8" back over the writer's "3, 4, 7" in two runs (2026-10-22).
const TITLE_LABEL = `(?:${LABEL}|[㉮-㉻ⓐ-ⓩⒶ-Ⓩㄱ-ㅎ]|t(?:[₀-₉]+|_?\\{?\\d+\\}?)|\\d+|[₀-₉]+)`;
const TITLE_RUN = new RegExp(`${TITLE_LABEL}(?:\\s*(?:~|,|와|과|및)\\s*${TITLE_LABEL})*`, 'g');
/**
 * A solution STEP's title: the teacher's words to the letter, with the labels the problem has. The writer's title is
 * taken where it is the teacher's title with other label runs ("(가)와 (나)" for "(가)~(다)", "Ⅱ" for "Ⅰ"), so a
 * problem with fewer containers names its own; anything else gets the teacher's title. Only Roman numerals were carried
 * over before, so a title kept "(가)~(다)" for a problem with (가), (나) and no model could change it (the criteria,
 * D STEP 제목). "Ⅰ 에서" and "A-D" for "Ⅰ에서" and "A~D" are not taken (Haiku's set, Gemini's review, 2026-10-16).
 */
function stepTitle(original, mine) {
  const o = String(original);
  // F₁, $F_1$ and F1 are one name.
  const plainTitle = (s) => frameLine(s).replace(/\s*\.$/, '').replace(/\$([A-Za-z]_?\{?\d*\}?)\$/g, '$1').replace(/([A-Za-z])_\{?(\d+)\}?/g, '$1$2');
  const parts = plainTitle(o).split(TITLE_RUN);
  if (parts.length < 2) return o;
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s*');
  const m = new RegExp(`^${parts.map(esc).join(`\\s*(${TITLE_RUN.source})\\s*`)}$`).exec(plainTitle(mine));
  // The teacher's title names the original's containers and values ("(가)~(다)", "20 g"); when the writer's title does
  // not line up with it, those would go into a problem that has other ones, so the writer's title stays and the title
  // check reports the difference in words (2026-10-26 audit).
  const foreign = /[ⅠⅡⅢⅣⅤ]|\([가-하]\)|[㉠-㉭㉮-㉻ⓐ-ⓩⒶ-Ⓩ]|\d+(?:\.\d+)?\s*(?:g|mol|L|mL|cm|μm|%|℃)(?![A-Za-z가-힣])/.test(o);
  if (!m || (o.match(TITLE_RUN) || []).length !== parts.length - 1) return foreign ? String(mine) : o;
  let k = 1;
  // The plain form reads t₁ and $t_1$ as t1; the title writes it as the teacher's title does.
  // An index alone (F₁'s ₁, read F1) is written the teacher's way too (생명 E37, 2026-10-23).
  const sub = (d) => [...d].map((c) => '₀₁₂₃₄₅₆₇₈₉'[c]).join('');
  const asTeacher = (mineRun, teacherRun) => (/^[₀-₉]+$/.test(teacherRun) && /^\d+$/.test(mineRun) ? sub(mineRun)
    : mineRun.replace(/t_?\{?(\d+)\}?/g, (x, d) => (/t_/.test(teacherRun) ? `t_${d}` : /t[₀-₉]/.test(teacherRun) ? 't' + sub(d) : 't' + d)));
  return o.replace(TITLE_RUN, (run) => asTeacher(m[k++].trim(), run));
}

/**
 * "정답은 …이다." says the item's own answer: the teacher's "★ 정답은 ② 20이다." was kept as a frame with no slot and
 * Qwen 3.8 copied it under its answer ④ 27 (reaction-density 4차, 2026-10-17, Claude's and Gemini's reviews). The
 * teacher's form stays (a leading ★, a mark without its value).
 */
function answerLine(item) {
  const p = item.problem;
  const n = Number(p?.answer);
  const choice = p?.choices?.[n - 1];
  if (!(n >= 1 && n <= 5) || choice == null) return;
  const mark = '①②③④⑤'[n - 1];
  const shown = String(choice).trim().replace(/^\$\s*(-?[\d.]+)\s*\$$/, '$1');
  // A choice that is a sentence ("반응 후 남은 기체는 A이다.") is not repeated after the mark.
  const line = (shown.match(/[가-힣]/g) || []).length >= 6 ? `${mark}이다.` : `${mark} ${shown}이다.`;
  const steps = item.solution?.steps || [];
  for (const step of steps) {
    // A table row is left alone; a line's closing bold marks stay.
    step.work = String(step.work || '').split('\n').map((l) => (/^\s*\|/.test(l) ? l : l.replace(/^(.*?정답은\s*)([①②③④⑤])(.*?)(\*\*)?\s*$/, (all, head, had, rest, bold) => (
      /^\s*(이다|입니다)/.test(rest) ? `${head}${mark}${rest}${bold || ''}` : `${head}${line}${bold || ''}`)))).join('\n');
  }
  // A solution that ends without it gets it at the end of its last STEP: Opus's STEP 1~2 practice ended on its reaction
  // table (reaction-density 3차, 2026-10-18, Claude's review), its teacher's answer line being in STEP 3.
  const last = steps[steps.length - 1];
  if (last && !steps.some((s) => /정답은\s*[①②③④⑤]/.test(s.work || ''))) last.work = `${String(last.work || '').trimEnd()}\n정답은 ${line}`;
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

// "만약 … 이라면 … 그러나 … 이므로" is the same reasoning without the word 모순 (reaction-density's teacher, 2026-10-16:
// every variant that kept her sentences failed this check).
const assumes = (t) => /가정|만약/.test(t) && /모순|맞지\s*않|일치하지|성립하지|불가능|그러나|하지만/.test(t);

// Any STEP of the teacher's that reasons by assumption, not STEP 1 only (where the originals it was written for had it).
function checkAssumption(material, item) {
  const used = stageSteps(item.stage, material.steps.length);
  // The STEP's own reasoning, not the choice analysis at its end: 생명 L64's STEP 4 matches members by A+b values, and
  // only its analysis of ㄱ recalls STEP 2's assumption — the check asked STEP 4 for one and the solution was written
  // again 26 times (2026-10-21/22).
  const own = (s) => String(s.work || '').split(/\n\s*\[?\s*(?:보기|선택지)\s*분석/)[0] + (s.technique || '');
  const want = used.filter((n) => material.steps[n - 1] && assumes(own(material.steps[n - 1])));
  if (!want.length) return [];
  const steps = item.solution?.steps || [];
  const all = steps.map((s) => s.work).join('\n');
  const lost = want.filter((n) => !assumes(steps.filter((s) => s.step === n).map((s) => s.work).join('\n') || all));
  return [result('source-assumption', '원본의 가정→모순 판정 유지', !lost.length,
    !lost.length ? '가정과 모순 판정이 해설에 있음' : `원본 STEP ${lost.join(', ')}의 가정→비교→모순 판정이 변형 해설에서 사라졌습니다. 같은 추론이 필요하도록 문제와 해설을 고쳐야 합니다.`)];
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
    ...formatIssues(item.problem.figure || '').map((m) => '그림 설명: ' + m),
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
// X₂ and $\ce{X2}$ are one title (화학 C32, 2026-10-22: the check flagged the title the system had itself notated).
// The names a problem gives its parts follow the problem too: ㉠~㉥ and ⓐ~ⓒ (ㄹ~ㅂ as read), member numbers, t₁ and t₂.
// Held to the teacher's letters, the title fought the final review over "구성원 ㉢ 추론" for five rewrites (L64, 2026-10-22).
// The particle after a name changes with it (㉡과, 2와), so it is read as one.
const PART_NAME = '㉠-㉿Ⓐ-ⓩㄱ-ㅎ\\dⅠ-Ⅴ)';
const PARTICLES = [['과|와', '와'], ['은|는', '는'], ['이|가', '가', '(?![가-힣])'], ['을|를', '를']];
const titleKey = (t) => PARTICLES.reduce((s, [any, one, end = '']) => s.replace(new RegExp(`([${PART_NAME}])(?:${any})${end}`, 'g'), '$1' + one), subDigits(plain(t)))
  .replace(/\((?:g|mol|L|mL|kg)\)/g, '').replace(/\([가-하]\)\s*(?:~|와|과|및|,)?\s*/g, '').replace(/Ⅰ|Ⅱ|Ⅲ|Ⅳ|\b(?:I{1,3}|IV)\b/g, '')
  .replace(/[㉠-㉿Ⓐ-ⓩㄱ-ㅎ\d]/g, '').replace(/\bt(?=[^A-Za-z]|$)/g, '').replace(/[\s~,.:·()_{}]/g, '');
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

// A table's data rows are those named by a label: experiments Ⅰ, Ⅱ (or I, II), containers or gases (가), (나), ㉠. Only
// Roman numerals were read before, so the gas original's (가)~(다) table had no shape and its final's "only the numbers
// changed" check never ran (2026-10-21).
const rowLabel = (c) => new RegExp(`^(?:${LABEL}|I{1,3}|IV)$`).test(String(c).trim());
const LABEL_SERIES = ['ⅠⅡⅢⅣⅤ', '가나다라마바사아자차카타파하', '㉠㉡㉢㉣㉤㉥㉦㉧㉨㉩㉪㉫㉬㉭'];
function nextLabel(last) {
  const t = String(last || '').replace(/^I{1,3}$|^IV$/, (r) => ({ I: 'Ⅰ', II: 'Ⅱ', III: 'Ⅲ', IV: 'Ⅳ' })[r]);
  const ch = t.replace(/[()]/g, '');
  for (const series of LABEL_SERIES) {
    const i = series.indexOf(ch);
    if (i >= 0 && i + 1 < series.length) return t.startsWith('(') ? `(${series[i + 1]})` : series[i + 1];
  }
  return '새 행';
}

/** Data rows of the first table: labelled rows (Ⅰ, (가), ㉠ …) and the cells that hold a hidden letter (x, y). */
function tableShape(text) {
  const rows = String(text || '').split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('|'))
    .map((l) => l.replace(/^\||\|$/g, '').split('|').map((c) => plain(c).trim()))
    .filter((cells) => rowLabel(cells[0]));
  if (!rows.length) return null;
  // A letter used as the unit elsewhere ("5w") is a quantity when it stands alone ("w" = 1w), not a hidden value.
  const units = new Set(rows.flat().flatMap((c) => [...c.matchAll(/\d\s*([a-z])\b/g)].map((m) => m[1])));
  const hidden = rows.flatMap((cells, r) => cells.map((c, i) => (/^[a-z]$/.test(c) && !units.has(c) ? `${r}:${i}` : null)).filter(Boolean));
  return { rows: rows.length, cols: Math.max(...rows.map((c) => c.length)), hidden };
}

/** Ways out of the original's table shape, named by its own rows and columns: the cheap designer kept the original's
 *  table in the final after 11 code checks that only said "same shape" (molar-mass, Haiku 5.5, 2026-10-10). */
function shapeOptions(text) {
  const shape = tableShape(text);
  if (!shape || !shape.hidden.length) return '';
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter((l) => l.startsWith('|'));
  const header = (lines[0] || '').replace(/^\||\|$/g, '').split('|').map((c) => plain(c).trim());
  const rows = lines.map((l) => l.replace(/^\||\|$/g, '').split('|').map((c) => plain(c).trim())).filter((c) => rowLabel(c[0])).map((c) => c[0]);
  const col = (i) => `'${header[i] || `${i + 1}번째 열`}'`;
  const hiddenAt = shape.hidden.map((h) => h.split(':').map(Number));
  const taken = new Set(shape.hidden);
  const moves = [];
  for (let r = 0; r < rows.length && moves.length < 4; r++) {
    for (let i = 1; i < shape.cols && moves.length < 4; i++) {
      if (!taken.has(`${r}:${i}`) && hiddenAt.some(([hr, hi]) => hr !== r || hi !== i) && (hiddenAt.some(([, hi]) => hi === i) || hiddenAt.some(([hr]) => hr === r))) moves.push(`${rows[r]}의 ${col(i)}`);
    }
  }
  const next = nextLabel(rows[rows.length - 1]);
  return [
    `원본 표: 행 ${rows.join(', ')} ${rows.length}개, 숨긴 값 ${hiddenAt.map(([r, i]) => `${rows[r]}의 ${col(i)}`).join(', ')}. 행 ${rows.length}개와 열은 그대로 두고(${next} 같은 행을 더하면 검수의 '용기·실험 구성' 결함이다), 다음 중 둘 이상을 함께 바꾼다:`,
    moves.length ? `(1) 숨긴 값을 다른 종류의 칸으로 옮긴다 — 예: ${moves.join(', ')}. 원래 숨긴 칸에는 수치를 준다.` : '',
    '(2) 원본 풀이가 기준으로 삼는 행이나 판정·계산의 방향(무엇을 주고 무엇을 구하는지)을 원본과 다르게 잡는다. 방향이 바뀐 STEP은 선생님의 같은 관계식을 같은 문장 틀로 반대쪽 값을 구하는 데 쓴다 (원본 STEP의 기법은 그대로 필요해야 한다).',
    '(3) 선생님 해설의 STEP 결과들을 그대로 써서 나오는, 원본에서 묻지 않던 양을 묻는다 (새 계산 단계가 필요하면 안 된다).',
  ].filter(Boolean).join('\n');
}

/** An integrated final with the original's table shape and the hidden value in the same cell only changed numbers
 * (DeepSeek's final kept Ⅰ~Ⅲ, the same columns and x in row Ⅰ and just recombined b, x and the molar-mass ratio). */
function checkSameShape(material, item, mode) {
  if (item.stage.kind !== 'twin' || mode !== 'integrated') return [];
  const a = tableShape(material.problem.text);
  const b = tableShape(item.problem.text);
  if (!a || !b || !a.hidden.length) return [];
  const same = a.rows === b.rows && a.cols === b.cols && a.hidden.join() === b.hidden.join();
  return [result('variant-shape', '통합 변형: 표 구조와 숨긴 값 위치를 바꿨는지', !same,
    same ? `행 ${a.rows}개, 열 ${a.cols}개, 숨긴 값의 위치까지 원본 표와 같습니다. 묻는 식만 바꾸면 숫자 변형입니다 — 행 수와 열은 그대로 두고, 주는 값과 숨기는 값의 종류나 판정 방향을 바꾸어 구조를 바꿔야 합니다.\n${shapeOptions(material.problem.text)}` : '')];
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

/** A frame reference the renderer could not turn into a sentence ([틀 2-1] with a value missing, a frame number that does
 * not exist) must not reach the student: the line is a hard fault, not a wording note. */
function checkFramesFilled(item) {
  const left = (item.solution?.steps || []).flatMap((st) => String(st.work || '').split('\n')
    .filter((l) => /[\[［]\s*틀\s*\d+/.test(l) || (!/\$/.test(l) && /^[^=;|]{1,20}=[^;=|]{1,60};\s*[^=;|]{1,20}=/.test(l)))
    .map((l) => `STEP ${st.step}: ${l.trim().slice(0, 80)}`));
  return [result('frames', '해설 문장 틀 채움', !left.length, left.length ? `틀 참조가 문장으로 바뀌지 않고 남았습니다: ${left.slice(0, 3).join(' / ')}` : '', 'hard')];
}

// A letter the problem introduces ($aw$ in a table cell, $x$ in the question) that the solution never uses is a
// decoration the student has to wonder about (Gemini on molar mass, 2026-10-26: "$aw$로 숨겼으나 … 풀이에 불필요한
// 조건"): every such letter must be used in the solution.
// One or two lowercase letters standing alone ($x$, $aw$ = a·w); a unit (cm, kg) is not a letter.
const PROBLEM_LETTER = /(?<![A-Za-z\\{_^])([a-z]{1,2})(?![A-Za-z}])/g;
const UNIT_WORDS = new Set(['cm', 'mm', 'kg', 'mg', 'nm', 'ms', 'pm', 'km', 'dm', 'hr', 'ml']);
function problemLetters(problem, { mathOnly = true } = {}) {
  const parts = [problem?.text, problem?.figure, ...(problem?.choices || [])].map((t) => String(t || ''));
  const text = (mathOnly ? parts.map((t) => (t.match(/\$[^$]*\$/g) || []).join(' ')) : parts).join(' ')
    .replace(/\\(?:ce|text|mathrm|operatorname)\s*\{[^{}]*\}/g, ' ').replace(/\([a-z]{1,2}\)/g, ' ');
  return [...new Set([...text.matchAll(PROBLEM_LETTER)].map((m) => m[1]).filter((w) => !UNIT_WORDS.has(w)).flatMap((w) => [...w]))];
}
function checkUnusedLetters(material, item) {
  // The original's own letters (its w, its x, wherever its reading wrote them) are the family's; the letters the
  // variant adds are what must be used.
  const inherited = new Set(problemLetters(material?.problem, { mathOnly: false }));
  const letters = problemLetters(item.problem).filter((v) => !inherited.has(v));
  if (!letters.length) return [];
  const solution = (item.solution?.steps || []).map((s) => s.work).join('\n');
  const unused = letters.filter((v) => !hasLetter(solution, v));
  return [result('unused-letter', '문제의 문자가 풀이에 쓰임', !unused.length,
    unused.length ? `문제가 도입한 문자 ${unused.join(', ')}가 해설 어디에도 쓰이지 않습니다. 묻는 값이나 계산에 쓰이게 하거나 수치로 바꿔야 합니다.` : `문자 ${letters.join(', ')} 모두 해설에 쓰임`)];
}

function inspectItem(material, item, mode) {
  return [
    ...checkFramesFilled(item),
    ...checkUnusedLetters(material, item),
    ...checkChoices(material, item),
    ...checkOxConsistency(material, item),
    ...checkHelpers(material, item),
    ...checkAssumption(material, item),
    ...checkStepTitles(material, item),
    ...checkSolutionTables(material, item),
    ...checkEquation(material, item),
    ...checkUnusedCoefficient(item),
    ...checkNumbersOnly(material, item, mode),
    ...checkSameShape(material, item, mode),
    ...checkFormat(item),
    ...checkCleanNumbers(item),
  ];
}

// ---------------------------------------------------------------- analysis (source) checks

// Word pairs a reader confuses and that change the meaning (v1 source-quantity: 물질량 ↔ 몰질량).
// 실젯값 ↔ 실댓값: Qwen 3.8's reading of the molar-mass solution (2026-10-13).
const CONFUSABLE = [];

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

module.exports = { notation, notateItem, notateMaterial, stepTitle, uncoveredLines, renderFrames, validateFrames, carriesValue, frameFindings, frameRegex, teacherChoiceHeading, checkFramesFilled, checkUnusedLetters, problemLetters, checkFormat, shapeOptions, judgments, assumes, titleKey, plain, helperVariables, stageSteps, skeleton, formatIssues, inspectItem, hangulFixes, applyWordFixes, confusableFixes, applySubstringFixes, editDistance, CONFUSABLE };
