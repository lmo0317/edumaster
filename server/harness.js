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

function checkAssumption(material, item) {
  const first = material.steps[0];
  if (!first || !assumes(first.work + first.technique) || !stageSteps(item.stage, material.steps.length).includes(1)) return [];
  const steps = item.solution?.steps || [];
  const firstGenerated = steps.filter((s) => s.step === 1).map((s) => s.work).join('\n') || steps.map((s) => s.work).join('\n');
  return [result('source-assumption', '원본의 가정→모순 판정 유지', assumes(firstGenerated),
    assumes(firstGenerated) ? '가정과 모순 판정이 해설에 있음' : '원본 STEP 1의 가정→실험 비교→모순 판정이 변형 해설에서 사라졌습니다. 같은 추론이 필요하도록 문제와 해설을 고쳐야 합니다.')];
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

/** ㄱ·ㄴ·ㄷ problems: the solution's O/X judgments must match the answer's combination. */
function checkOxConsistency(item) {
  const markers = [...new Set([...item.problem.text.matchAll(/(?:^|\n)\s*([ㄱ-ㄹ])\s*\./g)].map((m) => m[1]))];
  if (markers.length < 2 || !item.problem.answer) return [];
  const text = plain((item.solution?.steps || []).map((s) => s.work).join('\n') + '\n' + (item.solution?.summary || ''));
  const judged = {};
  for (const m of text.matchAll(/([ㄱ-ㄹ])\s*[.)]?[^\n]{0,120}?\((O|X|○|×|o|x)\)/g)) judged[m[1]] = /O|○|o/.test(m[2]);
  for (const m of text.matchAll(/([ㄱ-ㄹ])\s*(?:은|는)\s*(옳지\s*않|옳|틀리|거짓|참|맞)/g)) judged[m[1]] = /^(옳|참|맞)$/.test(m[2].replace(/\s/g, '')) || m[2] === '옳';
  if (!markers.every((k) => k in judged)) return [];
  const claimed = new Set([...plain(item.problem.choices[item.problem.answer - 1] || '').matchAll(/[ㄱ-ㄹ]/g)].map((m) => m[0]));
  const trueSet = new Set(markers.filter((k) => judged[k]));
  const same = claimed.size === trueSet.size && [...claimed].every((k) => trueSet.has(k));
  return [result('explanation-consistency', '해설 O/X 판정과 정답', same,
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
/** The solution keeps the teacher's STEP titles; only the experiment numbers (Ⅰ, Ⅱ, Ⅲ) may change. */
const titleKey = (t) => plain(t).replace(/\((?:g|mol|L|mL|kg)\)/g, '').replace(/Ⅰ|Ⅱ|Ⅲ|Ⅳ|\b(?:I{1,3}|IV)\b/g, '').replace(/[\s~,.:·()]/g, '');
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

/** An integrated final with the original's table shape and the hidden value in the same cell only changed numbers
 * (DeepSeek's final kept Ⅰ~Ⅲ, the same columns and x in row Ⅰ and just recombined b, x and the molar-mass ratio). */
function checkSameShape(material, item, mode) {
  if (item.stage.kind !== 'twin' || mode !== 'integrated') return [];
  const a = tableShape(material.problem.text);
  const b = tableShape(item.problem.text);
  if (!a || !b || !a.hidden.length) return [];
  const same = a.rows === b.rows && a.cols === b.cols && a.hidden.join() === b.hidden.join();
  return [result('variant-shape', '통합 변형: 표 구조와 숨긴 값 위치를 바꿨는지', !same,
    same ? `실험 ${a.rows}개, 열 ${a.cols}개, 숨긴 값의 위치까지 원본 표와 같습니다. 묻는 식만 바꾸면 숫자 변형입니다 — 실험 수·주는 값과 숨기는 값·판정 방향을 바꾸거나 표 밖의 새 실험을 넣어 구조를 바꿔야 합니다.` : '')];
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
function checkObviousLeftover(material, item) {
  const first = material.steps[0];
  if (!first || !assumes(first.work + first.technique) || !stageSteps(item.stage, material.steps.length).includes(1)) return [];
  const obvious = [];
  for (const line of String(item.problem.text || '').split('\n')) {
    const cells = line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
    if (cells.length < 4 || !/^(Ⅰ|Ⅱ|Ⅲ|Ⅳ|I|II|III|IV)$/.test(plain(cells[0]).trim())) continue;
    const [a, b, left] = [wMultiple(cells[1]), wMultiple(cells[2]), wMultiple(cells[3])];
    if (a != null && b != null && left != null && (left > a || left > b)) obvious.push(`${plain(cells[0]).trim()} (남은 ${plain(cells[3]).trim()} > 넣은 ${left > a ? 'A ' + plain(cells[1]).trim() : 'B ' + plain(cells[2]).trim()})`);
  }
  return [result('source-assumption-needed', '가정→모순 없이 남은 물질이 정해지는 실험이 없음', !obvious.length,
    obvious.length ? `실험 ${obvious.join(', ')}에서 남은 물질이 질량 크기만으로 정해져 질량비가 바로 나오므로 가정→모순 판정이 필요 없어집니다. 모든 실험의 남은 질량이 넣은 A, B의 질량보다 작도록 바꿔야 합니다.` : '')];
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

function inspectItem(material, item, mode) {
  return [
    ...checkChoices(material, item),
    ...checkOxConsistency(item),
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
  ];
}

// ---------------------------------------------------------------- analysis (source) checks

// Word pairs a reader confuses and that change the meaning (v1 source-quantity: 물질량 ↔ 몰질량).
const CONFUSABLE = [['물질량', '몰질량']];

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

module.exports = { plain, helperVariables, stageSteps, skeleton, formatIssues, inspectItem, hangulFixes, applyWordFixes, confusableFixes, applySubstringFixes, editDistance, CONFUSABLE };
