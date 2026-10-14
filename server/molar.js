'use strict';
// Molar-mass reaction tables — A(g) + bB(g) → cC(g) + cD(g); per experiment the masses of A and B put in (in w), the
// mass of A or B left after the reaction, and a relative value of D's share of the gas — read the way the teacher's
// solution reads them, and tables found by search.
// A model guessing these numbers gave tables no mass ratio fits, answers not among the choices and rows whose leftover
// shows at a glance: 90% of what the judges sent back to Qwen 3.6 (molar-mass, 2026-10-12), each found only by an Opus
// solve. The numbers are the server's to find; the model writes the words.
//
// The teacher's reading (the 몰질량 original):
//   STEP 1  assume A all reacts in Ⅰ → the mass ratio that gives contradicts Ⅱ → B all reacts in Ⅰ; mass ratio A : B
//           = 1 : r; each experiment's limiting reactant and leftover follow.
//   STEP 2  A w g = n mol, B w g = m mol; reacted A (in n) gives c times as much C and D; moles after reaction.
//   STEP 3  D's share of the gas: rows with A left do not depend on m, so one given relative value fixes the scale K
//           (relative = K × actual) and a hidden one; a row with B left gives m : n. b = r·m/n, and by mass
//           conservation (M_C + M_D) / M_B = (M_A/M_B + b) / c with M_A/M_B = m/n.

// harness.plain, kept here so that harness can require this module.
const plain = (text) => String(text || '')
  .replace(/\\(?:ce|text|mathrm|mathbf)\s*\{([^{}]*)\}/g, '$1')
  .replace(/\\d?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, '$1/$2')
  .replace(/\\[,;:! ]/g, ' ')
  .replace(/\$/g, '');

// Exact fractions [numerator, denominator], reduced, denominator > 0.
const gcd = (a, b) => (b ? gcd(b, a % b) : Math.abs(a));
const Q = (n, d = 1) => { if (d < 0) { n = -n; d = -d; } const g = gcd(n, d) || 1; return [n / g, d / g]; };
const add = (x, y) => Q(x[0] * y[1] + y[0] * x[1], x[1] * y[1]);
const sub = (x, y) => Q(x[0] * y[1] - y[0] * x[1], x[1] * y[1]);
const mul = (x, y) => Q(x[0] * y[0], x[1] * y[1]);
const div = (x, y) => Q(x[0] * y[1], x[1] * y[0]);
const same = (x, y) => Boolean(x && y) && x[0] === y[0] && x[1] === y[1];
const less = (x, y) => x[0] * y[1] < y[0] * x[1];
const positive = (x) => x[0] > 0;
const whole = (x) => x[1] === 1;
const str = (x) => (x[1] === 1 ? String(x[0]) : `${x[0]}/${x[1]}`);
/** A value in w as the teacher writes it: w, 2w, 10/3w. */
const inW = (x) => (same(x, Q(1)) ? 'w' : str(x) + 'w');
/** "$\frac{10}{3}w$", "$w$", "$18$" — as the tables print them. */
const texOf = (x, unit = '') => {
  const body = x[1] === 1 ? (unit && x[0] === 1 ? '' : String(x[0])) : `\\frac{${x[0]}}{${x[1]}}`;
  return `$${body}${unit}$`;
};
// A number a student handles without a calculator: small, and a denominator of at most 4.
const friendly = (x, max = 60) => x[1] <= 4 && x[0] > 0 && x[0] / x[1] <= max;

const ROMAN = ['Ⅰ', 'Ⅱ', 'Ⅲ', 'Ⅳ'];
const romanOf = (s) => ({ I: 'Ⅰ', II: 'Ⅱ', III: 'Ⅲ', IV: 'Ⅳ' }[s] || s);

/** One cell: a number (in w when `w`), or a hidden value (a letter or ?). */
function cellValue(raw) {
  const t = plain(raw).replace(/\s+/g, '').replace(/^[AB](?=[\d/w])/, '');
  if (t === 'w') return { v: Q(1), w: true };
  const m = /^(\d+)(?:\/(\d+))?(w)?$/.exec(t);
  if (m) return { v: Q(Number(m[1]), m[2] ? Number(m[2]) : 1), w: Boolean(m[3]) };
  return { hidden: t || '?' };
}

/** The experiment table of a molar-mass problem: rows {name, a, b, left, rel} (cells as cellValue), or null. */
function readTable(text) {
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter((l) => /^\|.*\|$/.test(l));
  const split = (l) => l.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  // The header as one row, also when it was read as the printed two rows ("반응 전 | | 반응 후" over "A의 질량(g) | B의
  // 질량(g) | …", Qwen 3.8, 2026-10-13): each column's group (carried over the empty cells a span leaves) and its own
  // label joined.
  const isData = (cells) => /^(Ⅰ|Ⅱ|Ⅲ|Ⅳ|I|II|III|IV)$/.test(plain(cells[0] || '').trim());
  const isRule = (cells) => cells.every((c) => /^:?-{2,}:?$/.test(c) || !c);
  const firstData = lines.map(split).findIndex(isData);
  const heads = lines.map(split).slice(0, firstData < 0 ? lines.length : firstData).filter((c) => !isRule(c));
  const start = heads.findIndex((cells) => cells.some((c) => /반응\s*전/.test(plain(c))));
  if (start < 0) return null;
  const group = heads[start];
  const label = heads[start + 1] && !heads[start + 1].some((c) => /반응\s*전/.test(plain(c))) ? heads[start + 1] : null;
  let carry = '';
  const header = label
    ? label.map((c, i) => { if (group[i]) carry = group[i]; return `${i ? carry : group[i] || ''} ${c}`.trim(); })
    : group;
  const col = (re) => header.findIndex((c) => re.test(plain(c).replace(/\s+/g, '')));
  const at = { a: col(/반응전.*A/), b: col(/반응전.*B/), left: col(/반응후.*(A|B).*질량/), rel: col(/상댓값|D의양/) };
  // A two-level header read flat loses "반응 후" ("A 또는 B의 질량(g)", Qwen 3.8, 2026-10-13): the A-or-B mass column.
  if (at.left < 0) at.left = header.findIndex((c, i) => i !== at.a && i !== at.b && /(A|B)(또는|나)?.*질량/.test(plain(c).replace(/\s+/g, '')) && !/반응전/.test(plain(c).replace(/\s+/g, '')));
  if (at.a < 0 || at.b < 0 || at.left < 0) return null;
  const rows = lines.map(split).filter((c) => /^(Ⅰ|Ⅱ|Ⅲ|Ⅳ|I|II|III|IV)$/.test(plain(c[0]).trim()))
    .map((c) => ({ name: romanOf(plain(c[0]).trim()), a: cellValue(c[at.a]), b: cellValue(c[at.b]), left: cellValue(c[at.left]), rel: at.rel >= 0 ? cellValue(c[at.rel]) : null }));
  return rows.length >= 2 ? { rows, hasRel: at.rel >= 0, header, at } : null;
}

/** Mass ratios r (B per A, by mass) one row allows: A all reacts (B left) or B all reacts (A left). */
function rowRatios(row) {
  const out = [];
  if (row.a.v && row.b.v && row.left.v) {
    const bReacted = sub(row.b.v, row.left.v);
    if (positive(bReacted)) out.push({ r: div(bReacted, row.a.v), limit: 'A' });
    const aReacted = sub(row.a.v, row.left.v);
    if (positive(aReacted)) out.push({ r: div(row.b.v, aReacted), limit: 'B' });
  }
  return out;
}

/** With mass ratio r: which reactant all reacts, the reacted A (in w) and the leftover (which, how much). */
function react(a, b, r) {
  const need = mul(a, r);
  if (same(need, b)) return { limit: 'both', reactedA: a, leftOf: '', left: Q(0) };
  return less(need, b) ? { limit: 'A', reactedA: a, leftOf: 'B', left: sub(b, need) } : { limit: 'B', reactedA: div(b, r), leftOf: 'A', left: sub(a, div(b, r)) };
}

/** The teacher's STEP 1 on this table: rows where assuming the wrong reactant all reacts gives a ratio another row
 *  contradicts. Each { assume (row index), assumed ('A'|'B': the reactant assumed to all react), against (row index) }. */
function contradictions(rows, r) {
  const out = [];
  rows.forEach((row, i) => {
    if (!row.a.v || !row.b.v || !row.left.v) return;
    const truth = react(row.a.v, row.b.v, r).limit;
    for (const wrong of rowRatios(row).filter((x) => x.limit !== truth && !same(x.r, r))) {
      rows.forEach((other, j) => {
        if (j === i || !other.a.v || !other.b.v || !other.left.v) return;
        if (!rowRatios(other).some((x) => same(x.r, wrong.r))) out.push({ assume: i, assumed: wrong.limit, wrongRatio: wrong.r, against: j });
      });
    }
  });
  return out;
}

/** D's share of the gas after reaction for reacted A `ra`, leftover of A or B, m : n = `q` (null: not needed). */
function share(c, out, q) {
  const products = mul(Q(2 * c), out.reactedA);
  const leftMoles = out.leftOf === 'B' ? (q ? mul(out.left, q) : null) : out.left;
  if (!leftMoles) return null;
  return div(mul(Q(c), out.reactedA), add(products, leftMoles));
}

/**
 * The table read as the teacher reads it. Returns { ok, why, r, rows (with limit/leftover per row), chains,
 * K, q (m : n), b, cdOverB, hidden: { 'Ⅰ.rel': value, … }, obvious (rows whose leftover shows by size), uses }.
 * c: C's and D's coefficient (A's is 1).
 */
function analyse(table, c = 2) {
  if (!table) return { ok: false, why: '표를 읽지 못함' };
  const rows = table.rows;
  // STEP 1: the mass ratio every fully given row allows.
  const given = rows.filter((x) => x.a.v && x.b.v && x.left.v);
  if (given.length < 2) return { ok: false, why: '반응 전후 질량이 모두 주어진 실험이 둘보다 적음' };
  let ratios = rowRatios(given[0]).map((x) => x.r);
  for (const row of given.slice(1)) ratios = ratios.filter((r) => rowRatios(row).some((x) => same(x.r, r)));
  if (ratios.length !== 1) return { ok: false, why: ratios.length ? `반응 질량비가 하나로 정해지지 않음 (A : B = ${ratios.map((r) => '1 : ' + str(r)).join(', ')})` : '모든 실험을 만족하는 반응 질량비가 없음 (자료가 서로 모순)' };
  const r = ratios[0];
  const hidden = {};
  const read = rows.map((row) => {
    let { a, b } = { a: row.a.v, b: row.b.v };
    // A hidden mass put in: both reactants could have all reacted; it must come out one way only.
    if ((!a || !b) && (a || b) && row.left.v) {
      if (a) {
        // b hidden: A all reacts (b = a·r + left) or B all reacts with A left (b = (a − left)·r).
        const cand = [add(mul(a, r), row.left.v), mul(sub(a, row.left.v), r)].filter((v) => positive(v) && same(react(a, v, r).left, row.left.v));
        if (cand.length !== 1) return { name: row.name, ambiguous: true };
        b = cand[0]; hidden[`${row.name}.b`] = b;
      } else {
        // a hidden: B all reacts (a = b/r + left) or A all reacts with B left (a = (b − left)/r).
        const cand = [add(div(b, r), row.left.v), div(sub(b, row.left.v), r)].filter((v) => positive(v) && same(react(v, b, r).left, row.left.v));
        if (cand.length !== 1) return { name: row.name, ambiguous: true };
        a = cand[0]; hidden[`${row.name}.a`] = a;
      }
    }
    if (!a || !b) return { name: row.name, ambiguous: true };
    const out = react(a, b, r);
    if (!row.left.v) hidden[`${row.name}.left`] = out.left;
    else if (!same(out.left, row.left.v)) return { name: row.name, contradiction: true };
    return { name: row.name, a, b, ...out };
  });
  const bad = read.find((x) => x.ambiguous || x.contradiction || x.limit === 'both');
  if (bad) return { ok: false, why: bad.ambiguous ? `${bad.name}의 숨긴 질량이 하나로 정해지지 않음` : bad.limit === 'both' ? `${bad.name}에서 A, B가 모두 반응해 남는 물질이 없음` : `${bad.name}의 남은 질량이 반응 질량비와 맞지 않음` };
  // A leftover as heavy as the A or B put in names the leftover by size: that row needs no assumption.
  const obvious = rows.filter((row) => row.a.v && row.b.v && row.left.v && (!less(row.left.v, row.a.v) || !less(row.left.v, row.b.v))).map((x) => x.name);
  const chains = contradictions(rows, r);
  const result = { ok: true, r, rows: read, chains, obvious, hidden, uses: {} };
  if (!table.hasRel) return result;

  // STEP 3: the scale K from a row with A left (its share does not depend on m : n), then m : n from a row with B left.
  const relRows = rows.map((row, i) => ({ row, i, out: read[i] })).filter((x) => x.row.rel);
  const fixed = relRows.filter((x) => x.out.leftOf !== 'B');
  const withM = relRows.filter((x) => x.out.leftOf === 'B');
  let kFrom = fixed.filter((x) => x.row.rel.v).map((x) => ({ i: x.i, K: div(x.row.rel.v, share(c, x.out, null)) }));
  if (kFrom.some((x) => !same(x.K, kFrom[0].K))) return { ...result, ok: false, why: 'A가 남는 실험들의 상댓값이 서로 맞지 않음' };
  const givenM = withM.filter((x) => x.row.rel.v);
  // No row with A left gives a relative value: two rows with B left fix m : n by the ratio of their relative values
  // (R10's final, 2026-10-11), then the scale. rel1·ra2·(2c·ra1 + L1·q) = rel2·ra1·(2c·ra2 + L2·q).
  if (!kFrom.length) {
    if (givenM.length < 2) return { ...result, ok: false, why: '상댓값의 기준(실젯값과의 비)이 정해지지 않음: A가 남는 실험의 상댓값이나, B가 남는 실험 둘의 상댓값이 있어야 함' };
    const [x1, x2] = givenM;
    const [ra1, ra2, L1, L2, v1, v2] = [x1.out.reactedA, x2.out.reactedA, x1.out.left, x2.out.left, x1.row.rel.v, x2.row.rel.v];
    const den = sub(mul(mul(v1, ra2), L1), mul(mul(v2, ra1), L2));
    if (den[0] === 0) return { ...result, ok: false, why: 'B가 남는 두 실험의 상댓값으로 m : n이 정해지지 않음' };
    const q0 = div(mul(mul(Q(2 * c), mul(ra1, ra2)), sub(v2, v1)), den);
    if (!positive(q0)) return { ...result, ok: false, why: 'B가 남는 두 실험의 상댓값으로 구한 m : n이 양수가 아님' };
    kFrom = [{ i: x1.i, K: div(v1, share(c, x1.out, q0)), viaQ: true }];
  }
  const K = kFrom[0].K;
  const qFrom = givenM.filter((x) => !(kFrom[0].viaQ && x.i === kFrom[0].i)).map((x) => {
    const actual = div(x.row.rel.v, K);
    // c·ra / (2c·ra + left·q) = actual  →  q = (c·ra/actual − 2c·ra) / left
    const ra = x.out.reactedA;
    return { i: x.i, q: div(sub(div(mul(Q(c), ra), actual), mul(Q(2 * c), ra)), x.out.left) };
  });
  if (qFrom.some((x) => !positive(x.q))) return { ...result, ok: false, why: 'B가 남는 실험의 상댓값으로 구한 m : n이 양수가 아님' };
  if (qFrom.some((x) => !same(x.q, qFrom[0].q))) return { ...result, ok: false, why: 'B가 남는 실험들의 상댓값이 서로 맞지 않음' };
  const q = qFrom[0]?.q || null;
  for (const x of relRows.filter((y) => !y.row.rel.v)) {
    const s = share(c, x.out, q);
    if (!s) return { ...result, ok: false, why: `${x.row.name}의 숨긴 상댓값을 구하려면 m : n이 필요한데 정해지지 않음` };
    hidden[`${x.row.name}.rel`] = mul(K, s);
  }
  const b = q ? mul(r, q) : null;
  const uses = {
    K: kFrom.map((x) => rows[x.i].name),
    q: qFrom.map((x) => rows[x.i].name),
    // More given relative values than the reading needs: the rest are conditions nothing uses.
    unusedRel: [...kFrom.slice(1), ...qFrom.slice(1)].map((x) => rows[x.i].name),
  };
  return { ...result, K, q, b, cdOverB: q ? div(add(q, b), Q(c)) : null, uses };
}

// Quantities a question can ask that the original's solution did not have to find (item (5)): a ratio of the moles
// after reaction, a leftover or reacted mass, the moles made. Recombining what it did find (b, x, molar masses) is not.
const NEW_QUANTITIES = [['전체 기체의 양', /전체\s*기체의\s*양/], ['남은 질량', /남은[^.?]*질량|(^|[^a-z])z\s*\/\s*w/], ['생성된 양', /생성된/], ['반응한 양', /반응한/], ['밀도', /밀도/], ['부피', /부피/]];
/** The question sentence of a problem: the text after its last table. */
const questionOf = (text) => plain(String(text || '').split('\n').filter((l) => !/^\s*\|/.test(l)).slice(-3).join(' '));
function askOf(text) {
  const q = questionOf(text);
  return NEW_QUANTITIES.filter(([, re]) => re.test(q)).map(([name]) => name).sort().join(',');
}

/** What a full molar-mass table is, in the five structure items the judges use (prompts VARIATION_CRITERIA). */
function structure(table, a, ask = '') {
  const hiddenCells = Object.keys(a.hidden || {});
  return {
    rows: table.rows.length,
    columns: table.hasRel ? 'rel' : 'mass',
    // (2) the hidden value's kind and whether it needs m : n first
    hidden: hiddenCells.map((h) => {
      const [name, col] = h.split('.');
      const out = a.rows.find((x) => x.name === name);
      return col === 'rel' ? (out?.leftOf === 'B' ? 'rel-needs-q' : 'rel') : col;
    }).sort().join(','),
    // (3) the teacher's assumption: which reactant is assumed, in which row against which
    assumption: (a.chains || []).map((x) => `${ROMAN[x.assume]}${x.assumed}>${ROMAN[x.against]}`).sort().join(','),
    pattern: (a.rows || []).map((x) => x.leftOf).join(''),
    ask,
  };
}
/** Which of the five items differ between two structures (the final needs two or more). */
function structureChanges(orig, next) {
  const out = [];
  if (orig.rows !== next.rows || orig.columns !== next.columns) out.push('(1) 실험 수·열 구성');
  if (orig.hidden !== next.hidden) out.push('(2) 숨긴 값의 종류·역할');
  // The teacher's first assumption (Ⅰ, A) moved to another row or reactant.
  const first = (s) => s.assumption.split(',')[0] || '';
  if (first(orig) !== first(next) && !next.assumption.split(',').includes(first(orig))) out.push('(3) 가정→모순의 기준 실험·가정하는 쪽');
  // A quantity the original did not ask (the original's own question tokens do not count).
  const before = new Set(String(orig.ask || '').split(',').filter(Boolean));
  if (String(next.ask || '').split(',').some((t) => t && !before.has(t))) out.push('(5) 묻는 대상');
  return out;
}

// ---------------------------------------------------------------- search

// Friendlier ratios first (B per A by mass).
const RATIOS = [Q(2), Q(3, 2), Q(3), Q(1, 2), Q(2, 3), Q(5, 2), Q(4), Q(4, 3), Q(1, 3)];
const MN = [Q(1, 2), Q(2, 3), Q(1), Q(3, 2), Q(2), Q(3)];
const MASS = Array.from({ length: 14 }, (_, i) => Q(i + 1));

/** Rows (A, B in w) for mass ratio r whose leftover is friendly and lighter than both A and B put in. */
function rowsFor(r, leftOf, used) {
  const out = [];
  for (const a of MASS) for (const b of MASS) {
    if (used.has(`${str(a)},${str(b)}`)) continue;
    const x = react(a, b, r);
    if (x.leftOf !== leftOf || !friendly(x.left, 14) || x.left[1] > 3 || !less(x.left, a) || !less(x.left, b)) continue;
    out.push({ a, b, ...x });
  }
  return out;
}

const cellsOf = (row, hide = []) => ({
  name: row.name,
  a: hide.includes('a') ? { hidden: 'y' } : { v: row.a, w: true },
  b: hide.includes('b') ? { hidden: 'y' } : { v: row.b, w: true },
  left: hide.includes('left') ? { hidden: 'x' } : { v: row.left, w: true },
  rel: row.rel === undefined ? null : hide.includes('rel') ? { hidden: 'x' } : { v: row.rel },
});

/** Five choices with the answer among them: the answer, the values the likely mistakes give, then neighbours. */
// The answer's place among five ascending choices, spread over ②~④ (and sometimes ① or ⑤) by the answer itself.
function choicesFor(answer, mistakes = []) {
  const byValue = (x, y) => x[0] * y[1] - y[0] * x[1];
  const wrong = [];
  const keep = (v) => { if (v && positive(v) && friendly(v, 99) && !same(v, answer) && !wrong.some((x) => same(x, v))) wrong.push(v); };
  mistakes.forEach(keep);
  for (const k of [Q(1, 2), Q(2), Q(3, 2), Q(2, 3), Q(3), Q(1, 3), Q(4, 3), Q(3, 4), Q(4)]) keep(mul(answer, k));
  // Whole neighbours keep a whole answer's choices whole — only when the multiples run short: 34 beside an answer of
  // 35 was no mistake a student makes (Claude's review of run 18 set's neighbours, 2026-10-13).
  const multiples = wrong.length;
  if (whole(answer)) for (const d of [1, 2, 3, -1, -2]) keep(Q(answer[0] + d));
  // The likely mistakes first (up to three), then fillers: multiples of the answer (whole ones first for a whole
  // answer), then neighbours, placed so the answer lands near `want` wrong choices below it.
  const want = [2, 3, 1, 4, 0][(answer[0] + answer[1]) % 5];
  const pick = wrong.slice(0, Math.min(3, mistakes.filter(Boolean).length));
  const rank = (x) => (wrong.indexOf(x) >= multiples ? 2 : whole(answer) && !whole(x) ? 1 : 0);
  const rest = wrong.filter((x) => !pick.includes(x)).sort((x, y) => rank(x) - rank(y));
  while (pick.length < 4 && rest.length) {
    const below = pick.filter((x) => byValue(x, answer) < 0).length;
    const i = rest.findIndex((x) => (below < want ? byValue(x, answer) < 0 : byValue(x, answer) > 0));
    pick.push(rest.splice(i < 0 ? 0 : i, 1)[0]);
  }
  const five = [answer, ...pick].sort(byValue);
  return { choices: five, answer: five.findIndex((x) => same(x, answer)) + 1 };
}

/** The original's rows as used numbers (a design must not reuse them). */
const usedRows = (tables) => new Set(tables.flatMap((t) => (t?.rows || []).filter((x) => x.a.v && x.b.v).map((x) => `${str(x.a.v)},${str(x.b.v)}`)));

/**
 * Tables for a practice problem up to STEP `upto` (1 or 2), the teacher's STEP 1 kept: Ⅰ assumed (A all reacts),
 * contradicted by Ⅱ, the asked value in Ⅲ. upto 1 asks Ⅲ's leftover mass; upto 2 has B left in Ⅲ and asks
 * x/w × (C made in Ⅲ) / (reactant left in Ⅰ), in mol. Each { rows, ask, question?, answer, choices, r }.
 */
// How much a table looks unlike the teacher's: fractional leftovers, 1w masses, the same A and B, an answer of 1.
const awkward = (rows, value) => rows.reduce((s, x) => s + (whole(x.left) ? 0 : 4) + (x.a[0] === 1 && x.a[1] === 1 ? 2 : 0) + (x.b[0] === 1 && x.b[1] === 1 ? 2 : 0) + (same(x.a, x.b) ? 1 : 0), 0)
  + (same(value, Q(1)) ? 2 : 0) + (value[1] === 1 ? 0 : 2);

function practiceDesigns(original, upto, { avoid = [], count = 3, c = 2 } = {}) {
  const used = usedRows([original, ...avoid]);
  const best = [];
  for (const r of RATIOS) {
    const aLeft = rowsFor(r, 'A', used);
    // STEP 1~2: Ⅲ is the row where A all reacts and B is left, as in the original. With A left in all three rows the
    // m the teacher defines was never used and the question named the leftover ("남은 A(g)의 양"), giving STEP 1's
    // conclusion away (Claude and Gemini review of the Haiku R12 and Qwen 5th sets, 2026-10-12).
    const third = upto >= 2 ? rowsFor(r, 'B', used) : [...rowsFor(r, 'B', used), ...aLeft];
    let pick = null;
    for (const one of aLeft) for (const two of aLeft) {
      if (one === two || same(one.a, two.a) || same(one.b, two.b)) continue;
      const rows = [{ name: 'Ⅰ', ...one }, { name: 'Ⅱ', ...two }];
      if (awkward(rows, Q(2)) > (pick ? pick.score : 6)) continue;
      const a = analyse({ rows: rows.map((x) => cellsOf(x)), hasRel: false }, c);
      // The teacher's STEP 1: assume A all reacts in Ⅰ, contradicted by Ⅱ.
      if (!a.ok || !a.chains.some((x) => x.assume === 0 && x.assumed === 'A' && x.against === 1) || a.obvious.length) continue;
      const wrong = a.chains.find((x) => x.assume === 0).wrongRatio;
      for (const t of third) {
        if (t === one || t === two || [one, two].some((x) => same(x.a, t.a) || same(x.b, t.b))) continue;
        // STEP 1~2 asks x (Ⅲ's leftover, in w) times the C made in Ⅲ over the reactant left in Ⅰ (A, in n): x is
        // used, the mol step is needed, and no leftover is named.
        const stepTwo = (row) => mul(row.left, div(mul(Q(c), row.reactedA), one.left));
        const value = upto >= 2 ? stepTwo(t) : t.left;
        // A whole answer that the wrong ratio (skipping the contradiction) does not also give.
        const misread = react(t.a, t.b, wrong);
        // x = w would make x/w a factor of 1 that the answer does not need.
        if (!whole(value) || value[0] > 99 || (upto >= 2 && same(t.left, Q(1))) || (upto < 2 ? same(misread.left, t.left) : same(stepTwo(misread), value))) continue;
        const full = [...rows, { name: 'Ⅲ', ...t }];
        const score = awkward(full, value);
        if (pick && score >= pick.score) continue;
        const mistakes = upto >= 2 ? [stepTwo(misread), mul(t.left, div(t.reactedA, one.left)), div(mul(Q(c), t.reactedA), one.left)] : [misread.left, t.a, t.b];
        pick = {
          score, r, rows: full, hide: { 'Ⅲ': ['left'] },
          ask: upto >= 2 ? 'x/w × Ⅲ에서 생성된 C의 양(mol) ÷ Ⅰ에서 반응 후 남은 반응물의 양(mol)' : 'Ⅲ에서 반응 후 남은 질량',
          ...(upto >= 2 ? { question: '$\\frac{x}{w}\\times\\frac{\\text{Ⅲ에서 생성된 C(g)의 양(mol)}}{\\text{Ⅰ에서 반응 후 남은 반응물의 양(mol)}}$은?' } : {}),
          unit: upto >= 2 ? '' : 'w', value, ...choicesFor(value, mistakes),
        };
      }
    }
    if (pick) best.push(pick);
  }
  // The least awkward first, one per mass ratio.
  return best.sort((x, y) => x.score - y.score).slice(0, count);
}

// The final's questions. Each gives the asked value from a reading (b, x = the hidden relative value, m : n as q,
// (C+D)/B, the moles of gas after reaction per row in n) and the words for it. ORIG is the original's own question.
const ASKS = [
  { id: 'orig', text: () => '$\\frac{b}{x}\\times\\frac{\\text{C의 몰질량}+\\text{D의 몰질량}}{\\text{B의 몰질량}}$은?', value: (v) => mul(div(v.b, v.x), v.cdOverB) },
  { id: 'totals', text: (i, j) => `$\\frac{x}{b}\\times\\frac{\\text{${i}에서 반응 후 전체 기체의 양(mol)}}{\\text{${j}에서 반응 후 전체 기체의 양(mol)}}\\times\\frac{\\text{B의 몰질량}}{\\text{C의 몰질량}+\\text{D의 몰질량}}$은?`, value: (v, i, j) => div(mul(div(v.x, v.b), div(v.total[i], v.total[j])), v.cdOverB), rows: true },
  // A hidden leftover z is asked for itself: a z only the question's totals took was "a letter nothing asks" to Claude's
  // review (run 15) and to Opus's solve (run 16).
  { id: 'zask', text: () => '$\\frac{x}{b}\\times\\frac{z}{w}\\times\\frac{\\text{B의 몰질량}}{\\text{C의 몰질량}+\\text{D의 몰질량}}$은?', value: (v) => div(mul(div(v.x, v.b), v.z), v.cdOverB), z: true },
  { id: 'totals2', text: (i, j) => `$\\frac{b}{x}\\times\\frac{\\text{C의 몰질량}+\\text{D의 몰질량}}{\\text{B의 몰질량}}\\times\\frac{\\text{${i}에서 반응 후 전체 기체의 양(mol)}}{\\text{${j}에서 반응 후 전체 기체의 양(mol)}}$은?`, value: (v, i, j) => mul(mul(div(v.b, v.x), v.cdOverB), div(v.total[i], v.total[j])), rows: true },
];
// Which reactant is left in Ⅰ~Ⅲ. The teacher's finals keep one row with B left (m enters once) and the scale and the
// hidden value on rows with A left (approved lessons 9da519e5, 67f9b802); the assumed reactant stays A (2369c278).
const PATTERNS = ['BAA', 'ABA', 'AAB'];

/**
 * Integrated finals found by search: tables whose reading is unique, keep the teacher's assume → contradiction, use
 * every value given, and differ from the original in two or more of the five structure items (counted by
 * structureChanges, the judges' criteria). Each { r, q, b, rows, hide, ask, question, value, choices, changes }.
 */
function finalDesigns(original, originalText, { avoid = [], count = 3, c = 2 } = {}) {
  const oa = analyse(original, c);
  if (!oa.ok || !original.hasRel) return [];
  const os = structure(original, oa, askOf(originalText));
  const used = usedRows([original, ...avoid]);
  const nearOriginal = (x) => original.rows.some((o) => [o.a.v && same(o.a.v, x.a), o.b.v && same(o.b.v, x.b), o.left.v && same(o.left.v, x.left)].filter(Boolean).length >= 2);
  const out = [];
  for (const pattern of PATTERNS) {
    let best = null;
    for (const r of RATIOS) {
      const lists = [...pattern].map((p) => rowsFor(r, p, used).filter((x) => whole(x.left) && x.a[0] <= 12 && x.b[0] <= 12)
        .sort((x, y) => awkward([x], Q(2)) - awkward([y], Q(2))).slice(0, 10));
      if (lists.some((l) => !l.length)) continue;
      for (const q of MN) {
        const b = mul(r, q);
        if (!whole(b) || b[0] < 2 || b[0] > 6) continue;
        for (const one of lists[0]) for (const two of lists[1]) for (const three of lists[2]) {
          const rows = [{ name: 'Ⅰ', ...one }, { name: 'Ⅱ', ...two }, { name: 'Ⅲ', ...three }];
          // No row two of whose three masses are an original row's: (2w, 5w, w) beside the original's (2w, 7w, w) gave
          // the same moles, y = 4/9 and m = n again (Claude's review of run 18, 2026-10-13).
          if (rows.some((x) => nearOriginal(x))) continue;
          // Different experiments: no two rows with the same masses; leftovers not all alike.
          const keys = new Set(rows.map((x) => `${str(x.a)},${str(x.b)}`));
          const lefts = new Set(rows.map((x) => str(x.left)));
          if (keys.size < 3) continue;
          // No two experiments with the same A or the same B put in (lesson f5606456: the leftover shows by the difference).
          if (new Set(rows.map((x) => str(x.a))).size < 3 || new Set(rows.map((x) => str(x.b))).size < 3) continue;
          const base = awkward(rows, Q(2)) + (lefts.size === 1 ? 3 : lefts.size === 2 ? 1 : 0);
          if (best && base >= best.score) continue;
          // The share of D per row at this m : n, and a scale K that makes every relative value whole and small.
          const shares = rows.map((x) => share(c, x, q));
          const K = Q(shares.reduce((k, s) => lcm(k, s[1]), 1));
          const rel = shares.map((s) => mul(K, s));
          if (rel.some((v) => !whole(v) || v[0] > 99) || new Set(rel.map(str)).size < 3) continue;
          rows.forEach((x, i) => { x.rel = rel[i]; });
          const total = rows.map((x) => add(mul(Q(2 * c), x.reactedA), x.leftOf === 'B' ? mul(x.left, q) : x.left));
          // Hide one relative value; the reading must find it (and m : n, b) from the rest alone.
          // Hide a relative value on a row with A left, and maybe one leftover mass too (found from the ratio, R10's final).
          for (const [h, z] of [0, 1, 2].flatMap((h) => [[h, -1], ...[0, 1, 2].filter((k) => k !== h).map((k) => [h, k])])) {
            if (rows[h].leftOf !== 'A') continue;
            const hideOf = (i) => [...(i === h ? ['rel'] : []), ...(i === z ? ['left'] : [])];
            const table = { rows: rows.map((x, i) => cellsOf(x, hideOf(i))), hasRel: true };
            const a = analyse(table, c);
            if (!a.ok || a.obvious.length || a.uses.unusedRel?.length || !a.q || !same(a.q, q) || !a.chains.some((x) => x.assumed === 'A')) continue;
            const s = structure(table, a, '');
            for (const ask of ASKS) for (const [i, j] of ask.rows ? [[0, 2], [1, 0], [2, 0], [1, 2]] : [[0, 0]]) {
              // A hidden leftover z only with a question that asks z itself (runs 10–16: otherwise the judges called it
              // unused); a question about z only when z is hidden.
              if (Boolean(ask.z) !== z >= 0) continue;
              const v = { b, x: rel[h], cdOverB: div(add(q, b), Q(c)), total, z: z >= 0 ? rows[z].left : null };
              const value = ask.value(v, i, j);
              if (!friendly(value, 60) || value[1] > 27) continue;
              const question = ask.text(ROMAN[i], ROMAN[j]);
              const changes = structureChanges(os, { ...s, ask: askOf(question) });
              if (changes.length < 2) continue;
              const score = base + (value[1] === 1 ? 0 : value[1] > 9 ? 2 : 1) - changes.length;
              if (best && score >= best.score) continue;
              const mistakes = [div(v.b, v.x), mul(value, Q(2)), div(value, Q(2))];
              const hide = Object.fromEntries(rows.map((x, k) => [x.name, hideOf(k)]).filter(([, v]) => v.length));
              best = { score: score + (z >= 0 ? 1 : 0), pattern, r, q, b, K, rows: rows.map((x) => ({ ...x })), hide, ask: ask.id, question, value, changes, assume: a.chains.find((x) => x.assumed === 'A'), ...choicesFor(value, mistakes) };
            }
          }
        }
      }
    }
    if (best) out.push(best);
  }
  // The least awkward first.
  return out.sort((x, y) => x.score - y.score).slice(0, count);
}
const lcm = (a, b) => (a / gcd(a, b)) * b;

/** One row of a table design as markdown cells. */
function rowCells(x, hide = [], withRel = false) {
  // The hidden relative value (or a practice's hidden leftover) is x; a final's hidden leftover is z.
  const cell = (k) => (hide.includes(k) ? (k === 'rel' || (k === 'left' && !withRel) ? '$x$' : k === 'left' ? '$z$' : '$y$') : k === 'rel' ? texOf(x.rel) : texOf(x[k], 'w'));
  return [x.name, cell('a'), cell('b'), cell('left'), ...(withRel ? [cell('rel')] : [])];
}
function describe(design) {
  const withRel = design.rows.some((x) => x.rel);
  const lines = design.rows.map((x) => `| ${rowCells(x, design.hide[x.name] || [], withRel).join(' | ')} |`);
  const mark = '①②③④⑤'[design.choices.findIndex((x) => same(x, design.value))];
  return [`반응 질량비 A : B = 1 : ${str(design.r)}${design.q ? `, m : n = ${str(design.q)}, b = ${str(design.b)}` : ''} · 묻는 값: ${design.ask} = ${design.unit ? inW(design.value) : str(design.value)} · 선택지 ${design.choices.map((x) => (design.unit ? inW(x) : str(x))).join(', ')} (정답 ${mark})`, ...lines].join('\n');
}

/** The teacher's STEP 1 sentence for a table, worked by code: one row's reactant assumed to all react, and the row
 *  it fails on. { text, row, limit (what does all react in that row) } or null. */
function assumptionSentence(table, a = analyse(table)) {
  if (!a.ok) return null;
  const chain = [...a.chains].sort((x, y) => (x.assumed === 'A' ? 0 : 1) - (y.assumed === 'A' ? 0 : 1) || x.assume - y.assume || x.against - y.against)[0];
  if (!chain) return null;
  const mass = (x) => texOf(x, 'w');
  const row = table.rows[chain.assume];
  const other = table.rows[chain.against];
  const wr = chain.wrongRatio;
  const ra = chain.assumed === 'A' ? row.a.v : sub(row.a.v, row.left.v);
  const kept = chain.assumed === 'A' ? 'B' : 'A';
  const p = react(other.a.v, other.b.v, wr);
  const then = p.limit === 'both' ? '남는 물질이 없어야' : `반응 후 ${p.leftOf} ${mass(p.left)} g이 남아야`;
  return {
    text: `만약 ${row.name}에서 ${chain.assumed}가 모두 반응했다면 A ${mass(ra)} g과 B ${mass(mul(ra, wr))} g이 반응해서 반응 후 ${kept} ${mass(row.left.v)} g이 남은 것이므로 ${other.name}에서는 A ${mass(p.reactedA)} g과 B ${mass(mul(p.reactedA, wr))} g이 반응해서 ${then} 하는데 주어진 자료와 맞지 않다.`,
    row: row.name, limit: kept,
    // The same values without the teacher's sentence: what a writer is given (the sentence is the original's frame).
    facts: `가정 실험 ${row.name}, 가정: ${chain.assumed}가 모두 반응 → A ${mass(ra)} g과 B ${mass(mul(ra, wr))} g 반응, ${kept} ${mass(row.left.v)} g 남음; 모순 실험 ${other.name}: 같은 비로 A ${mass(p.reactedA)} g과 B ${mass(mul(p.reactedA, wr))} g 반응, ${p.limit === 'both' ? '남는 물질 없음' : `${p.leftOf} ${mass(p.left)} g 남아야 함`} — 자료와 맞지 않음 → ${row.name}에서 모두 반응한 것은 ${kept}`,
  };
}

/**
 * The teacher's whole STEP 1 for a table, in the teacher's five sentences: the assumption and its contradiction, the
 * row's real limit, that row, the contradicting row checked against the data, and the third row. Qwen 3.6 changed
 * "반응해서" to "반응하고", dropped "반응 후" and the "이는 주어진 자료와 일치한다" check, and each cost an Opus
 * rewrite (2026-10-13, run 8). Returns { title, text, row } or null.
 */
function stepOneText(table, a = analyse(table)) {
  const first = assumptionSentence(table, a);
  if (!first) return null;
  const mass = (x) => texOf(x, 'w');
  const byName = Object.fromEntries(a.rows.map((x) => [x.name, x]));
  const chain = [...a.chains].sort((x, y) => (x.assumed === 'A' ? 0 : 1) - (y.assumed === 'A' ? 0 : 1) || x.assume - y.assume || x.against - y.against)[0];
  const other = table.rows[chain.against].name;
  const third = table.rows.map((x) => x.name).find((n) => n !== first.row && n !== other);
  const reacts = (n) => `A ${mass(byName[n].reactedA)} g과 B ${mass(mul(byName[n].reactedA, a.r))} g이 반응해서`;
  const leaves = (n, done) => (byName[n].leftOf ? `${byName[n].leftOf} ${mass(byName[n].left)} g이 남${done}` : `남는 물질이 없${done === '는다' ? '다' : '고'}`);
  const lines = [
    first.text,
    `따라서 ${first.row}에서 모두 반응한 것은 ${first.limit}이다.`,
    `${first.row}에서 ${reacts(first.row)} 반응 후 ${leaves(first.row, '았고')},`,
    `${other}에서 ${reacts(other)} ${leaves(other, '았고')}, 이는 주어진 자료와 일치한다.`,
    ...(third ? [`따라서 ${third}에서는 ${reacts(third)} ${leaves(third, '는다')}.`] : []),
  ];
  return { title: `${first.row}에서 한계 반응물을 구한다.`, text: lines.join('\n'), row: first.row };
}

/**
 * The teacher's STEP 2 for a table: the mass table after reaction, n and m, and one sentence per row in the
 * teacher's two shapes (A left: "… mol 중 … mol이 반응하고, … mol이 남았고"; A all used: "… mol이 모두 반응하고, B는
 * … 남았고"), the first row with the coefficient reason. Qwen 3.6's outline put B's leftover on a row with A left and
 * "B 10m mol 중 10m mol" on it (2026-10-13, run 9). withD false: a practice that gives only C's coefficient.
 * Returns { lines, isRowLine } or null.
 */
function stepTwoText(table, a = analyse(table), { c = 2, withD = true } = {}) {
  if (!a.ok) return null;
  const mass = (x) => texOf(x, 'w');
  const n = (x) => texOf(x, 'n');
  const m = (x) => texOf(x, 'm');
  const ce = (s) => `$\\ce{${s}(g)}$`;
  const products = withD ? `${ce('C')}와 ${ce('D')}` : ce('C');
  const each = withD ? '각각 ' : '';
  // The teacher's header either way: the judges read "생성물" as a changed column (run 10).
  const head = '| 실험 | A(g) | B(g) | C(g)+D(g) |';
  // Values only, as the teacher's STEP 2 table has them ("x=2w" in a cell was a changed table to the judges, run 17);
  // a hidden leftover is named where the question uses it (the closing line's "z=3w", "x=2w").
  const leftCell = (x) => mass(x.left);
  const rows = a.rows.map((x) => {
    const rb = mul(x.reactedA, a.r);
    return `| ${x.name} | ${x.leftOf === 'A' ? leftCell(x) : '$0$'} | ${x.leftOf === 'B' ? leftCell(x) : '$0$'} | ${mass(add(x.reactedA, rb))} |`;
  });
  const sentence = (x, i) => {
    const made = n(mul(Q(c), x.reactedA));
    const used = x.leftOf === 'A'
      ? `${ce('A')}는 ${n(x.a)} mol 중 ${n(x.reactedA)} mol이 반응하고, ${n(x.left)} mol이 남`
      : `${ce('A')}는 ${n(x.reactedA)} mol이 모두 반응하고, ${ce('B')}는 ${m(x.b)} mol 중 ${m(mul(x.reactedA, a.r))} mol이 반응하고 ${m(x.left)} mol 남`;
    if (i === 0) return `${x.name}에서 ${used}았다. ${withD ? '화학 반응식에서' : '주어진 계수에서'} ${products}의 계수는 ${each}${c}로 ${ce('A')}의 ${c}배이므로 ${ce('A')}가 ${n(x.reactedA)} mol 반응할 때 생성되는 ${products}의 양(mol)은 ${each}${made} mol이다.`;
    return `${x.name}에서 ${used}았고, ${products}는 ${each}${made} mol 생성되었다.`;
  };
  const lines = [
    `Ⅰ~Ⅲ에서 반응 후 기체의 질량(g)에 대한 자료는 다음과 같다.`, '',
    head, '|---|---|---|---|', ...rows, '',
    `${ce('A')} $w$ g의 양(mol)을 $n$, ${ce('B')} $w$ g의 양(mol)을 $m$이라 하면`,
    ...a.rows.map(sentence),
  ];
  const names = a.rows.map((x) => x.name).join('|');
  const isRowLine = (l) => new RegExp(`^\\s*(${names})\\s*에서\\s*(\\$\\\\ce\\{A\\(g\\)\\}\\$|A\\(g\\)|A)는`).test(l);
  return { lines, isRowLine };
}

/**
 * The teacher's STEP 3 up to the choices for a final whose reading is the teacher's (K from rows with A left, m = n from
 * one row with B left, hidden relative values only on rows with A left): the mole table, the proportions, m = n, b and
 * the mass-conservation line. Qwen 3.6's outlines took the hidden x as the proportion's reference, put y = 4/9 in as
 * known, and broke the $ of "B의 몰질량 × 3" (2026-10-13, run 10). `ask`: the question, for which way up the molar-mass
 * ratio is written. Returns the lines, or null for any other reading.
 */
function stepThreeText(table, a = analyse(table), ask = '', c = 2) {
  if (!a.ok || !a.K || !a.q || !same(a.q, Q(1)) || a.uses.q.length !== 1 || a.uses.unusedRel.length) return null;
  const rows = table.rows.map((row, i) => ({ row, out: a.rows[i] }));
  const ref = rows.find((x) => x.row.name === a.uses.K[0]);
  const qRow = rows.find((x) => x.row.name === a.uses.q[0]);
  const hiddenRel = rows.filter((x) => x.row.rel && !x.row.rel.v);
  if (!ref || !qRow || hiddenRel.some((x) => x.out.leftOf !== 'A') || hiddenRel.length > 1) return null;
  const bare = (x, unit = '') => texOf(x, unit).slice(1, -1);
  const actual = (x) => share(c, x.out, a.q);
  const made = (x) => mul(Q(c), x.out.reactedA);
  const fracD = '$\\frac{\\text{D의 양(mol)}}{\\text{전체 기체의 양(mol)}}$';
  const letter = (x) => x.row.rel.hidden && x.row.rel.hidden !== '?' ? x.row.rel.hidden : 'x';
  const cells = (x) => {
    const relCell = x.row.rel.v ? `$${bare(x.row.rel.v)}$` : `$${letter(x)}=${bare(a.hidden[`${x.row.name}.rel`])}$`;
    const actCell = x === qRow ? `$y=${bare(actual(x))}$` : `$${bare(actual(x))}$`;
    return `| ${x.row.name} | ${x.out.leftOf === 'A' ? texOf(x.out.left, 'n') : '$0$'} | ${x.out.leftOf === 'B' ? texOf(x.out.left, 'm') : '$0$'} | ${texOf(made(x), 'n')} | ${texOf(made(x), 'n')} | ${actCell} | ${relCell} |`;
  };
  const targets = [...hiddenRel.map((x) => `${x.row.name}에서의 상댓값`), `${qRow.row.name}에서 이 실젯값`];
  const head = `${bare(actual(ref))}:${bare(ref.row.rel.v)}`;
  const first = rows[0];
  const rb = mul(first.out.reactedA, a.r);
  const flip = /\\frac\{\\text\{B의 몰질량\}\}\{\\text\{C의 몰질량\}\s*\+\s*\\text\{D의 몰질량\}\}/.test(ask);
  const ratio = flip
    ? `$\\frac{\\text{B의 몰질량}}{\\text{C의 몰질량}+\\text{D의 몰질량}}=${bare(div(Q(1), a.cdOverB))}$`
    : `$\\frac{\\text{C의 몰질량}+\\text{D의 몰질량}}{\\text{B의 몰질량}}=${bare(a.cdOverB)}$`;
  return [
    `Ⅰ~Ⅲ에서 반응 후 기체의 양(mol)과 ${fracD}에 대해 정리하면 다음과 같다.`, '',
    '| 실험 | A(g) | B(g) | C(g) | D(g) | 실젯값 | 상댓값 |', '|---|---|---|---|---|---|---|',
    ...rows.map(cells), '',
    `${ref.row.name}에서 ${fracD}의 실젯값이 ${texOf(actual(ref))}인데 상댓값은 ${str(ref.row.rel.v)}이므로 ${targets.join('과 ')}은 다음과 같이 비례식으로 구할 수 있다.`,
    ...hiddenRel.map((x) => `$${head}=${bare(actual(x))}:${letter(x)} \\Rightarrow ${letter(x)}=${bare(a.hidden[`${x.row.name}.rel`])}$`),
    `$${head}=y:${bare(qRow.row.rel.v)} \\Rightarrow y=${bare(actual(qRow))}$이다.`,
    `${qRow.row.name}에서 ${fracD}의 실젯값이 ${texOf(actual(qRow))}이므로 $m=n$이다. 따라서 A의 몰질량과 B의 몰질량은 서로 같다.`,
    `$m=n$이므로 ${first.row.name}에서 $\\ce{A(g)}$는 ${texOf(first.out.reactedA, 'n')} mol과 $\\ce{B(g)}$는 ${texOf(rb, 'n')} mol이 반응하므로 $\\ce{A(g)}$와 $\\ce{B(g)}$의 계수비는 $1:${bare(a.b)}$이다. 따라서 $b=${bare(a.b)}$이다.`,
    `A와 B의 몰질량이 같으므로 B의 몰질량$\\times ${bare(add(a.q, a.b))}=$(C의 몰질량$+$D의 몰질량)$\\times ${c}$이다. 따라서 ${ratio}이다.`,
  ];
}

/**
 * The teacher's last lines for a final on a server table: the values gathered for the question and the question worked
 * out after the answer's mark, then "정답은 …이다." — the writer once ended with "정답은 ③이다." and no working
 * (2026-10-13, run 11). `ask` is the question as printed. Returns the lines, or null for a question it cannot read.
 */
function answerText(table, a, ask, choice, mark, c = 2) {
  if (!a?.ok || !a.b || !a.cdOverB) return null;
  const bare = (x, unit = '') => texOf(x, unit).slice(1, -1);
  const hidden = Object.entries(a.hidden).find(([k]) => k.endsWith('.rel'));
  if (!hidden) return null;
  const x = hidden[1];
  const cd = '\\frac{\\text{C의 몰질량}+\\text{D의 몰질량}}{\\text{B의 몰질량}}';
  const bcd = '\\frac{\\text{B의 몰질량}}{\\text{C의 몰질량}+\\text{D의 몰질량}}';
  const q = String(ask).replace(/은\?.*$/, '').replace(/^\$|\$$/g, '');
  const totalOf = (name) => {
    const row = a.rows.find((r) => r.name === name);
    if (!row) return null;
    const made = mul(Q(c), row.reactedA);
    const left = row.leftOf === 'B' ? mul(row.left, a.q) : row.left;
    return { parts: [left, made, made].map((v) => bare(v, 'n')).join('+'), total: add(left, mul(Q(2), made)) };
  };
  const rowsAsked = [...q.matchAll(/\\text\{(\S+)에서 반응 후 전체 기체의 양\(mol\)\}/g)].map((m) => m[1]);
  // x/b × z/w × B/(C+D): z is the hidden leftover, found in STEP 1.
  const zKey = Object.keys(a.hidden).find((k) => k.endsWith('.left'));
  if (rowsAsked.length === 0 && q.startsWith('\\frac{x}{b}\\times\\frac{z}{w}') && zKey) {
    const z = a.hidden[zKey];
    const inv = div(Q(1), a.cdOverB);
    return [`${mark} $x=${bare(x)}$, $b=${bare(a.b)}$, $z=${bare(z, 'w')}$, $${bcd}=${bare(inv)}$이므로 $${q}=\\frac{${bare(x)}}{${bare(a.b)}}\\times ${bare(z)}\\times ${bare(inv)}=${bare(mul(mul(div(x, a.b), z), inv))}$이다.`, `정답은 ${mark} ${choice}이다.`];
  }
  if (rowsAsked.length === 0 && q.startsWith('\\frac{b}{x}')) {
    return [`${mark} $b=${bare(a.b)}$, $x=${bare(x)}$, $${cd}=${bare(a.cdOverB)}$이므로 $${q}=\\frac{${bare(a.b)}}{${bare(x)}}\\times ${bare(a.cdOverB)}=${bare(mul(div(a.b, x), a.cdOverB))}$이다.`, `정답은 ${mark} ${choice}이다.`];
  }
  if (rowsAsked.length !== 2) return null;
  const [i, j] = rowsAsked.map(totalOf);
  if (!i || !j) return null;
  const ratio = div(i.total, j.total);
  const totals = `${rowsAsked[0]}에서 반응 후 전체 기체의 양은 $${i.parts}=${bare(i.total, 'n')}$ mol, ${rowsAsked[1]}에서 반응 후 전체 기체의 양은 $${j.parts}=${bare(j.total, 'n')}$ mol이므로 $\\frac{\\text{${rowsAsked[0]}에서 반응 후 전체 기체의 양(mol)}}{\\text{${rowsAsked[1]}에서 반응 후 전체 기체의 양(mol)}}=${bare(ratio)}$이다.`;
  if (q.startsWith('\\frac{x}{b}')) {
    const inv = div(Q(1), a.cdOverB);
    return [`${mark} $x=${bare(x)}$, $b=${bare(a.b)}$, $${bcd}=${bare(inv)}$이고, ${totals}`,
      `$${q}=\\frac{${bare(x)}}{${bare(a.b)}}\\times ${bare(ratio)}\\times ${bare(inv)}=${bare(mul(mul(div(x, a.b), ratio), inv))}$이다.`, `정답은 ${mark} ${choice}이다.`];
  }
  if (q.startsWith('\\frac{b}{x}')) {
    return [`${mark} $b=${bare(a.b)}$, $x=${bare(x)}$, $${cd}=${bare(a.cdOverB)}$이고, ${totals}`,
      `$${q}=\\frac{${bare(a.b)}}{${bare(x)}}\\times ${bare(a.cdOverB)}\\times ${bare(ratio)}=${bare(mul(mul(div(a.b, x), a.cdOverB), ratio))}$이다.`, `정답은 ${mark} ${choice}이다.`];
  }
  return null;
}

/**
 * The STEP 1~2 practice's closing lines (x/w × C made in Ⅲ ÷ reactant left in Ⅰ, the question practiceDesigns asks),
 * in the shape the writer gave them in runs 9–11. Returns the lines, or null for another question.
 */
function practiceAnswerText(table, a, ask, choice, mark, c = 2) {
  if (!a?.ok || !/Ⅲ에서 생성된 C\(g\)의 양\(mol\)/.test(ask) || !/Ⅰ에서 반응 후 남은 반응물의 양\(mol\)/.test(ask)) return null;
  const three = a.rows.find((r) => r.name === 'Ⅲ');
  const one = a.rows.find((r) => r.name === 'Ⅰ');
  const x = a.hidden['Ⅲ.left'];
  if (!three || !one || !x) return null;
  const bare = (v, unit = '') => texOf(v, unit).slice(1, -1);
  const made = mul(Q(c), three.reactedA);
  // Ⅰ keeps A in every practice design (the teacher's STEP 1 ends "Ⅰ에서 모두 반응한 것은 B"); a B left would need m : n.
  if (one.leftOf !== 'A') return null;
  const unit = 'n';
  const value = mul(x, div(made, one.left));
  const q = String(ask).replace(/은\?.*$/, '').replace(/^\$|\$$/g, '');
  return [
    `Ⅲ에서 남은 ${three.leftOf}의 질량은 ${texOf(x, 'w')} g이므로 $x=${bare(x, 'w')}$이고, $\\frac{x}{w}=${bare(x)}$이다. Ⅲ에서 생성된 $\\ce{C(g)}$의 양은 ${texOf(made, 'n')} mol, Ⅰ에서 반응 후 남은 반응물인 $\\ce{${one.leftOf}(g)}$의 양은 ${texOf(one.left, unit)} mol이므로 $${q}=${bare(x)}\\times\\frac{${bare(made, 'n')}}{${bare(one.left, unit)}}=${bare(value)}$이다.`,
    `정답은 ${mark} ${choice}이다.`,
  ];
}

/** The value of a printed question (the original's or a server final's) for a table, or null for one it cannot read. */
function questionValue(table, a, ask, c = 2) {
  if (!a?.ok || !a.b || !a.cdOverB) return null;
  const hidden = Object.entries(a.hidden || {}).find(([k]) => k.endsWith('.rel'));
  if (!hidden) return null;
  const x = hidden[1];
  const q = String(ask).replace(/은\?.*$/, '').replace(/^\$|\$$/g, '');
  const total = (name) => {
    const row = a.rows.find((r) => r.name === name);
    return row ? add(row.leftOf === 'B' ? mul(row.left, a.q) : row.left, mul(Q(2 * c), row.reactedA)) : null;
  };
  const rows = [...q.matchAll(/\\text\{(\S+)에서 반응 후 전체 기체의 양\(mol\)\}/g)].map((m) => total(m[1]));
  if (rows.some((v) => !v)) return null;
  const ratio = rows.length === 2 ? div(rows[0], rows[1]) : Q(1);
  if (rows.length && rows.length !== 2) return null;
  const zKey = Object.keys(a.hidden).find((k) => k.endsWith('.left'));
  if (q.startsWith('\\frac{x}{b}\\times\\frac{z}{w}') && zKey && !rows.length) return mul(mul(div(x, a.b), a.hidden[zKey]), div(Q(1), a.cdOverB));
  if (q.startsWith('\\frac{b}{x}')) return mul(mul(div(a.b, x), a.cdOverB), ratio);
  if (q.startsWith('\\frac{x}{b}') && rows.length === 2) return mul(mul(div(x, a.b), ratio), div(Q(1), a.cdOverB));
  return null;
}

/**
 * The values of the teacher's solution for a table, by code: the STEP 1 assumption and the row it fails on, each
 * row's reacted and leftover masses and moles (n = mol of A per w, m = mol of B per w), and STEP 3's K, m : n, b.
 * The designer writes the solution around these; its own arithmetic differed from the writer's (2026-10-12).
 */
function solutionFacts(table, c = 2, { withD = true } = {}) {
  const a = analyse(table, c);
  if (!a.ok) return [];
  const times = (x, s) => texOf(x, s);
  const mass = (x) => texOf(x, 'w');
  const out = [];
  const first = assumptionSentence(table, a);
  // Values only: the sentence is the writer's, in the original's frame (2026-10-13 — a server-written sentence is this
  // one original's text copied by hand, and carries to no other original).
  if (first) out.push(`STEP 1 가정→모순: ${first.facts}`);
  for (const x of a.rows) {
    const leftMol = x.leftOf === 'A' ? times(x.left, 'n') : times(x.left, 'm');
    // The products' mass (mass conservation) and whether the row's leftover is printed: Qwen 3.8 wrote C+D as 4w, 8w, 12w
    // for 5w, 10w, 15w and confirmed STEP 1 on a row whose leftover was the hidden z (2026-10-13, Qwen 3.8 round 2).
    const hiddenLeft = Object.prototype.hasOwnProperty.call(a.hidden || {}, `${x.name}.left`);
    // Which reactant ran out, said outright: Qwen 3.8 wrote the "A … 중 … 반응하고, … 남았다" sentence for a row where A
    // ran out (2026-10-13, round 12).
    out.push(`${x.name} (${x.leftOf === 'A' ? 'B가 모두 반응하고 A가 남은 실험' : x.leftOf === 'B' ? 'A가 모두 반응하고 B가 남은 실험' : 'A와 B가 모두 반응한 실험'}): A ${mass(x.reactedA)} g과 B ${mass(mul(x.reactedA, a.r))} g이 반응하고 ${x.leftOf} ${mass(x.left)} g이 남음 — 반응 후 C(g)+D(g)의 질량 ${mass(add(x.reactedA, mul(x.reactedA, a.r)))} (반응한 A와 B 질량의 합), A ${times(x.reactedA, 'n')} mol, B ${times(mul(x.reactedA, a.r), 'm')} mol 반응, ${withD ? 'C와 D 각각' : 'C'} ${times(mul(Q(c), x.reactedA), 'n')} mol 생성, 남은 ${x.leftOf} ${leftMol} mol${hiddenLeft ? ' — 반응 후 질량이 문제에서 숨겨진 실험이므로 "주어진 자료와 일치한다"의 근거로 쓰지 않는다' : ''}`);
  }
  // Which row does what in STEP 1's check once B is the limit: the assumed row, the row that contradicted it (now
  // agreeing with the data) and the third row worked out. Qwen 3.8 swapped the first two (2026-10-13, round 9).
  const chain = first && [...a.chains].sort((x, y) => (x.assumed === 'A' ? 0 : 1) - (y.assumed === 'A' ? 0 : 1) || x.assume - y.assume || x.against - y.against)[0];
  if (chain) {
    const third = table.rows.find((_, i) => i !== chain.assume && i !== chain.against);
    out.push(`STEP 1 확인 문장의 실험 순서: ${table.rows[chain.assume].name}(가정 실험 — 실제 반응량과 '반응 후 … 남았고,') → ${table.rows[chain.against].name}(모순 실험 — 실제 반응량과 '…이 남았고, 이는 주어진 자료와 일치한다.')${third ? ` → ${third.name}('따라서 ${third.name}에서는 …이 남는다.')` : ''}`);
  }
  // Each row's gas after reaction and its actual D fraction, in n (m = q n): Qwen 3.8 wrote 5/12 for 10/21 (round 9).
  if (a.q && withD) {
    for (const x of a.rows) {
      const aLeft = x.leftOf === 'A' ? x.left : Q(0);
      const bLeft = x.leftOf === 'B' ? mul(x.left, a.q) : Q(0);
      const each = mul(Q(c), x.reactedA);
      const total = add(add(aLeft, bLeft), add(each, each));
      const mol = (v) => (v[0] ? times(v, 'n') : '0');
      out.push(`${x.name} 반응 후 양(mol): A ${mol(aLeft)}, B ${mol(bLeft)}, C ${times(each, 'n')}, D ${times(each, 'n')}, 전체 ${times(total, 'n')} → D의 양/전체 기체의 양 실젯값 ${str(div(each, total))}`);
    }
  }
  if (a.K) {
    out.push(`STEP 3: 상댓값 = 실젯값 × ${str(a.K)}${a.q ? `, m : n = ${str(a.q)} : 1 (m = ${times(a.q, 'n')}), b = ${str(a.b)}, (C의 몰질량 + D의 몰질량) / B의 몰질량 = ${str(a.cdOverB)}` : ''}`);
    // The mass-conservation line with its multipliers: Qwen 3.6 wrote "B의 몰질량 × 2" for b = 2 (1 + b = 3) and
    // reached 20 for an answer of 30 (2026-10-13, run 8).
    // The proportion's reference: a row whose actual value comes straight out and whose relative value is given — not
    // the hidden one (Qwen 3.6's final made x its reference, a circle, 2026-10-13 run 9).
    const ref = a.uses?.K?.[0] && table.rows.find((x) => x.name === a.uses.K[0]);
    if (ref?.rel?.v) out.push(`STEP 3 비례식 기준 실험: ${ref.name} (실젯값 ${str(div(ref.rel.v, a.K))}, 상댓값 ${str(ref.rel.v)}) — 숨긴 상댓값과 B가 남는 실험의 실젯값은 이 실험과의 비례식으로 구한다`);
    // The proportions themselves, with the letter each unknown takes: Qwen 3.8 wrote the m row's actual value as known
    // and left its y out of the table (2026-10-13, round 11).
    const qRow = a.q && a.uses?.q?.[0] && table.rows.find((x) => x.name === a.uses.q[0]);
    if (ref?.rel?.v) {
      const head = `${str(div(ref.rel.v, a.K))}:${str(ref.rel.v)}`;
      for (const [i, row] of table.rows.entries()) {
        if (row === ref || !row.rel || row.rel.v) continue;
        const L = row.rel.hidden && row.rel.hidden !== '?' ? row.rel.hidden : 'x';
        out.push(`STEP 3 비례식 (${row.name}의 숨긴 상댓값 ${L}): ${head}=${str(share(c, a.rows[i], a.q || Q(1)))}:${L} ⇒ ${L}=${str(a.hidden[`${row.name}.rel`])}`);
      }
      if (qRow && qRow.rel?.v) {
        const i = table.rows.indexOf(qRow);
        out.push(`STEP 3 비례식 (${qRow.name}의 실젯값은 m이 들어 있어 y로 둔다, 표의 실젯값 칸은 "y=값"): ${head}=y:${str(qRow.rel.v)} ⇒ y=${str(share(c, a.rows[i], a.q))} → 이 실젯값으로 m=${str(a.q) === "1" ? "" : str(a.q)}n`);
      }
    }
    if (a.q) out.push(`STEP 3 질량 보존: ${same(a.q, Q(1)) ? 'A와 B의 몰질량이 같으므로 ' : ''}B의 몰질량 × ${str(add(a.q, a.b))} = (C의 몰질량 + D의 몰질량) × ${c}, B의 몰질량 / (C의 몰질량 + D의 몰질량) = ${str(div(Q(c), add(a.q, a.b)))}`);
    for (const [k, v] of Object.entries(a.hidden)) out.push(`숨긴 값 ${k.replace('.rel', '의 상댓값').replace('.left', '의 남은 질량')} = ${k.endsWith('.rel') ? str(v) : mass(v)}`);
  }
  return out;
}

module.exports = { Q, str, texOf, cellValue, rowCells, readTable, analyse, askOf, finalDesigns, rowRatios, react, contradictions, structure, structureChanges, practiceDesigns, choicesFor, describe, rowsFor, solutionFacts, assumptionSentence, stepOneText, stepTwoText, stepThreeText, answerText, questionValue, practiceAnswerText };
