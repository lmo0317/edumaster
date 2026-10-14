'use strict';
// Nerve conduction with a synapse (two neurons A and B, points d1~d4, Ⅰ~Ⅳ unordered): the table as the student reads
// it — which (order of Ⅰ~Ⅳ, speed of A, t1, synapse box) every given value allows. Haiku 5.5's nerve finals came back
// round after round with a value the solve did not need or no numbers at all (R6~R10, 2026-10-11): the judges found
// those only after an Opus solve, and Haiku could not find numbers that met every condition by itself.

const ROMAN = ['Ⅰ', 'Ⅱ', 'Ⅲ', 'Ⅳ'];
const SPEEDS = [0.5, 1, 1.5, 2, 2.5, 3, 4, 5, 6];
const TIMES = Array.from({ length: 20 }, (_, i) => (i + 1) / 2);
const DELAYS = [0.5, 1, 1.5, 2];
const perms = (xs) => (xs.length <= 1 ? [xs] : xs.flatMap((x, i) => perms([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p])));
const ORDERS = perms([1, 2, 3, 4]);

/** The graph's value `e` ms after the impulse arrives: a tick, the resting potential, or unknown (null). */
function at(setup, e) {
  if (e < setup.ticks[0][0] || e >= setup.recover) return -70;
  const hit = setup.ticks.find(([t]) => Math.abs(t - e) < 1e-9);
  return hit ? hit[1] : null;
}

/** Where B's impulse is at d: 'on' (same neuron as the stimulus or past the synapse forward, `late` true then) or
 *  'never' (behind the synapse: cell bodies at the left end, so it crosses left to right only). Box k lies between
 *  d_k and d_{k+1}. */
function reach(stim, box, d, right = false) {
  // Cell bodies at the right end: the same picture mirrored (box k ↔ 4−k, d ↔ 5−d).
  if (right) return reach(5 - stim, 4 - box, 5 - d);
  if (box >= stim && d > box) return 'late';
  if (box < stim && d <= box) return 'never';
  return 'on';
}

/** Values B can show at d: one value without a synapse in the way, any earlier value (or rest) past it. */
function bValues(setup, p, d, vB) {
  const r = reach(p.stim, p.box, d, setup.right);
  if (r === 'never') return new Set([-70]);
  const e = p.t1 - Math.abs(setup.pos[d] - setup.pos[p.stim]) / vB;
  if (r === 'on') return new Set([at(setup, e)]);
  return new Set([-70, ...setup.ticks.filter(([t]) => t < e).map(([, v]) => v)]);
}

/** Every reading of a table ({Ⅰ: {A, B}, …}, null for ?) consistent with the graph: order, vA, t1, box. */
function readings(setup, table, vB) {
  const out = [];
  for (const order of ORDERS) {
    for (const vA of SPEEDS) {
      for (const t1 of TIMES) {
        const aOk = ROMAN.every((r, i) => table[r].A === null || at(setup, t1 - Math.abs(setup.pos[order[i]] - setup.pos[setup.stim]) / vA) === table[r].A);
        if (!aOk) continue;
        for (const box of [1, 2, 3]) {
          if (ROMAN.every((r, i) => table[r].B === null || bValues(setup, { stim: setup.stim, box, t1 }, order[i], vB).has(table[r].B))) out.push({ order, vA, t1, box });
        }
      }
    }
  }
  return out;
}

/** The table in a problem: Ⅰ~Ⅳ by A and B, either way round; null when it cannot be read. */
function readTable(text) {
  const plain = (s) => String(s).replace(/\$/g, '').replace(/\\mathrm\{[^}]*\}|\\text\{[^}]*\}|mV/g, '').replace(/−/g, '-').trim();
  const rows = String(text || '').split('\n').map((l) => l.trim()).filter((l) => l.startsWith('|') && !/^\|[\s|:-]+\|$/.test(l))
    .map((l) => l.replace(/^\||\|$/g, '').split('|').map(plain));
  if (rows.length < 3) return null;
  const cell = (c) => (c === '?' ? null : /^[+-]?\d+$/.test(c) ? Number(c) : undefined);
  const table = {};
  const head = rows[0];
  if (head.slice(1).includes('A') && head.slice(1).includes('B')) {
    const a = head.indexOf('A'); const b = head.indexOf('B');
    for (const r of rows.slice(1)) { const k = ROMAN.find((x) => r[0].endsWith(x)); if (k) table[k] = { A: cell(r[a]), B: cell(r[b]) }; }
  } else {
    const keys = head.slice(1).map((h) => ROMAN.find((x) => h.endsWith(x)));
    const a = rows.find((r) => r[0] === 'A'); const b = rows.find((r) => r[0] === 'B');
    if (!a || !b) return null;
    keys.forEach((k, i) => { if (k) table[k] = { A: cell(a[i + 1]), B: cell(b[i + 1]) }; });
  }
  if (!ROMAN.every((k) => table[k] && table[k].A !== undefined && table[k].B !== undefined)) return null;
  return table;
}

const key = (x) => `${x.order.join('')}|${x.vA}|${x.t1}|${x.box}`;

/** Does the table fix one reading, and which given values could go without changing that? */
function analyse(setup, table, vB) {
  const all = readings(setup, table, vB);
  const distinct = [...new Map(all.map((x) => [key(x), x])).values()];
  const unused = [];
  if (distinct.length === 1) {
    for (const r of ROMAN) {
      for (const n of ['A', 'B']) {
        if (table[r][n] === null) continue;
        const less = { ...table, [r]: { ...table[r], [n]: null } };
        if (new Set(readings(setup, less, vB).map(key)).size === 1) unused.push(`${n}의 ${r}`);
      }
    }
  }
  return { readings: distinct, unused };
}

/** The teacher's STEP 1 on a table: points where A and B both show and differ are not the stimulated point (`byB`),
 *  and of the rest, a point whose A value comes earlier on the graph than another point's cannot be it either
 *  (`byRight`; the stimulated point has the longest elapsed time). The original takes two by B and one by the graph —
 *  Haiku's practices took one by B and two by the graph, and the judges failed the order (R11, 2026-10-12). */
function stimSteps(setup, table) {
  const times = (v) => (v === null || v === -70 ? [] : setup.ticks.filter(([, x]) => x === v).map(([t]) => t));
  const byB = ROMAN.filter((r) => table[r].A !== null && table[r].B !== null && table[r].A !== table[r].B);
  const later = (c, q) => times(table[c].A).length && times(table[q].A).length && Math.min(...times(table[q].A)) > Math.max(...times(table[c].A));
  const byRight = ROMAN.filter((c) => !byB.includes(c) && ROMAN.some((q) => q !== c && later(c, q)));
  // A point B rules out that the graph would rule out too: its B value is needed only if a later STEP uses it (the
  // original's B of Ⅱ serves STEP 3; R12's STEP 1~2 practice copied the table and the judges called it unused).
  const alsoByRight = byB.filter((c) => ROMAN.some((q) => q !== c && later(c, q)));
  return { byB, byRight, alsoByRight, ok: byB.length === 2 && byRight.length === 1 };
}

/** The teacher's third move in STEP 1: the point nearest the stimulated one is the one whose A value is furthest
 *  right on the graph ("자극을 준 지점 d3에서 가장 가까운 지점은 d4 … −80이 0보다 더 오른쪽"). R12's final had the
 *  two nearest points both at 0 mV, so the solution had to argue another way and the judges failed it. `order` maps
 *  Ⅰ~Ⅳ to d1~d4. */
function nearestStep(setup, table, order) {
  const times = (v) => (v === null || v === -70 ? [] : setup.ticks.filter(([, x]) => x === v).map(([t]) => t));
  const others = ROMAN.filter((r, i) => order[i] !== setup.stim);
  const dist = (r) => Math.abs(setup.pos[order[ROMAN.indexOf(r)]] - setup.pos[setup.stim]);
  const nearest = others.filter((r) => dist(r) === Math.min(...others.map(dist)));
  if (nearest.length !== 1 || !times(table[nearest[0]].A).length) return { nearest: nearest[0] || null, ok: false };
  const n = nearest[0];
  const compared = others.filter((q) => q !== n && times(table[q].A).length);
  const ok = compared.length > 0 && compared.every((q) => Math.min(...times(table[n].A)) > Math.max(...times(table[q].A)));
  return { nearest: n, compared, ok };
}

/** Every point's A and B value for one setting; null when the graph has no readable value there. */
function fullTable(setup, p, vB) {
  const table = {};
  p.order.forEach((d, i) => {
    const eA = p.t1 - Math.abs(setup.pos[d] - setup.pos[p.stim]) / p.vA;
    const r = reach(p.stim, p.box, d, setup.right);
    const eB = p.t1 - Math.abs(setup.pos[d] - setup.pos[p.stim]) / vB - (r === 'late' ? p.delay : 0);
    table[ROMAN[i]] = { A: at(setup, eA), B: r === 'never' ? -70 : at(setup, eB), d, eA, eB };
  });
  return table;
}

/** Tables a final could use, computed: one reading only, every given value needed, and the teacher's three moves
 *  still the way through — two points ruled out by A ≠ B and one by the graph (STEP 1, `stimSteps`), two A values alike at different times (STEP 2),
 *  a B value past the synapse earlier than no synapse would give (STEP 3) — with at least two of synapse box,
 *  stimulated point, spacing and hidden cells unlike the original's. Deterministic for a given original. */
function designs(original, origTable, vB, count = 3) {
  const orig = analyse(original, origTable, vB).readings[0];
  const origHidden = ROMAN.flatMap((r) => ['A', 'B'].filter((n) => origTable[r][n] === null).map((n) => n + r)).sort().join();
  const found = [];
  let seed = 7;
  const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const shuffle = (xs) => xs.map((x) => [rand(), x]).sort((a, b) => a[0] - b[0]).map(([, x]) => x);
  const G = [1, 2, 3, 4];
  const gaps = shuffle(G.flatMap((a) => G.flatMap((b) => G.map((c) => [a, b, c]))));
  const masks = Array.from({ length: 256 }, (_, m) => m).filter((m) => { const n = m.toString(2).split('1').length - 1; return n >= 3 && n <= 4; });
  for (const [a, b, c] of gaps) {
    const pos = { 1: 0, 2: a, 3: a + b, 4: a + b + c };
    for (const stim of shuffle([1, 2, 3, 4])) {
      const setup = { ...original, pos, stim };
      for (const box of shuffle([1, 2, 3])) {
        const changed = (box !== orig.box) + (stim !== original.stim) + [1, 2, 3, 4].some((d) => pos[d] !== original.pos[d]);
        if (changed < 1) continue;
        for (const vA of shuffle([1, 2, 3, 4])) {
          if (vA === vB) continue;
          for (const t1 of shuffle(TIMES.filter((t) => t >= 2 && t <= 6))) {
            for (const delay of DELAYS) {
              const order = shuffle([1, 2, 3, 4]);
              const full = fullTable(setup, { order, vA, t1, box, stim, delay }, vB);
              const late = ROMAN.filter((r) => reach(stim, box, full[r].d, setup.right) === 'late');
              if (ROMAN.some((r) => full[r].A === null || full[r].B === null) || !late.length) continue;
              // STEP 3: past the synapse B shows a value it would not without one.
              const noSyn = (r) => at(setup, full[r].eB + delay);
              if (!late.some((r) => full[r].B !== -70 && full[r].B !== noSyn(r))) continue;
              for (const mask of shuffle(masks)) {
                // Bits 0..3: A of Ⅰ~Ⅳ hidden, 4..7: B of Ⅰ~Ⅳ hidden (3~4 hidden, 4~5 given like the original's 5).
                const table = {};
                ROMAN.forEach((r, i) => { table[r] = { A: mask & (1 << i) ? null : full[r].A, B: mask & (1 << (i + 4)) ? null : full[r].B }; });
                const hidden = ROMAN.flatMap((r) => ['A', 'B'].filter((n) => table[r][n] === null).map((n) => n + r)).sort().join();
                if (changed + (hidden !== origHidden) < 2) continue;
                const step1 = stimSteps(setup, table);
                const step1b = nearestStep(setup, table, order);
                if (!step1.ok || !step1b.ok) continue;
                const aGiven = ROMAN.filter((r) => table[r].A !== null && table[r].A !== -70);
                const pairs = aGiven.flatMap((r) => aGiven.filter((q) => q > r && table[q].A === table[r].A && full[q].eA !== full[r].eA).map((q) => [r, q]));
                const step3 = late.filter((r) => table[r].B !== null && table[r].B !== -70 && table[r].B !== noSyn(r));
                if (!pairs.length || !step3.length) continue;
                // Every given value has a part in the teacher's moves (the judges' "모든 조건이 풀이에 쓰임"); taking one
                // away and still finding one reading by brute force is no test — the original's own A values fail it.
                const times = (v) => setup.ticks.filter(([, x]) => x === v).map(([t]) => t);
                const used = new Set([...step1.byB.flatMap((r) => ['A' + r, 'B' + r]), ...pairs.flat().map((r) => 'A' + r), ...step3.map((r) => 'B' + r)]);
                for (const r of [step1b.nearest, ...step1b.compared]) used.add('A' + r);
                for (const c of step1.byRight) {
                  used.add('A' + c);
                  const q = ROMAN.find((x) => x !== c && table[x].A !== null && times(table[x].A).length && Math.min(...times(table[x].A)) > Math.max(...times(table[c].A)));
                  if (q) used.add('A' + q);
                }
                if (ROMAN.some((r) => ['A', 'B'].some((n) => table[r][n] !== null && !used.has(n + r)))) continue;
                if (new Set(readings(setup, table, vB).map(key)).size !== 1) continue;
                found.push({ pos, stim, box, vA, t1, delay, table, order });
                break;
              }
              if (found.length >= count) return found;
            }
          }
        }
      }
    }
  }
  return found;
}

/** What a practice up to STEP `upto` asks of a table, by the teacher's moves: the given values each move needs, and
 *  whether the answer (the stimulated and the nearest point; with STEP 2 also A's speed) comes out one way. */
function practiceRead(setup, table, vB, upto) {
  const step1 = stimSteps(setup, table);
  // A practice that does not give B's speed (R13's STEP 1 practice) is read by A alone: B's values only tell the
  // stimulated point apart there.
  const aOnly = Object.fromEntries(ROMAN.map((r) => [r, { A: table[r].A, B: null }]));
  const rs = vB ? readings(setup, table, vB) : readings(setup, aOnly, 1);
  const distinct = [...new Map(rs.map((x) => [key(x), x])).values()];
  const asked = (x) => [ROMAN[x.order.indexOf(setup.stim)], nearestStep(setup, table, x.order).nearest, upto >= 2 ? x.vA : ''].join('|');
  const answers = new Set(distinct.map(asked));
  const times = (v) => (v === null || v === -70 ? [] : setup.ticks.filter(([, x]) => x === v).map(([t]) => t));
  const used = new Set(step1.byB.flatMap((r) => ['A' + r, 'B' + r]));
  for (const c of step1.byRight) {
    used.add('A' + c);
    const q = ROMAN.find((x) => x !== c && times(table[x].A).length && Math.min(...times(table[x].A)) > Math.max(...times(table[c].A)));
    if (q) used.add('A' + q);
  }
  let near = { ok: false };
  if (answers.size === 1) {
    near = nearestStep(setup, table, distinct[0].order);
    if (near.ok) for (const r of [near.nearest, ...near.compared]) used.add('A' + r);
  }
  // STEP 2: two A values alike at different times (0 mV rising and falling) give A's speed.
  const aGiven = ROMAN.filter((r) => times(table[r].A).length > 1);
  // Two points as far from the stimulus show the same value at the same time and give no speed.
  const dist = (x, r) => Math.abs(setup.pos[x.order[ROMAN.indexOf(r)]] - setup.pos[setup.stim]);
  const pairs = aGiven.flatMap((r) => aGiven.filter((q) => q > r && table[q].A === table[r].A && distinct.every((x) => dist(x, r) !== dist(x, q))).map((q) => [r, q]));
  if (upto >= 2) pairs.flat().forEach((r) => used.add('A' + r));
  const unused = ROMAN.flatMap((r) => ['A', 'B'].filter((n) => table[r][n] !== null && !used.has(n + r)).map((n) => `${n}의 ${r}`));
  return { readings: distinct.length, answers: answers.size, step1, near, pairs, unused,
    ok: distinct.length > 0 && answers.size === 1 && step1.ok && near.ok && (upto < 2 || pairs.length > 0) && !unused.length };
}

/** Tables a practice up to STEP 1 or 2 could use, computed like the final's: the teacher's moves, one answer, every
 *  given value needed, the stimulated point or the spacing unlike the original's. Haiku 5.5 made these by hand and
 *  the judges sent each practice back seven times (R13, 2026-10-12: "B의 Ⅱ 쓰이지 않음", "배치가 하나로 정해지지 않음"). */
function practiceDesigns(original, origTable, vB, upto, count = 3) {
  const found = [];
  let seed = 11 + upto;
  const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const shuffle = (xs) => xs.map((x) => [rand(), x]).sort((a, b) => a[0] - b[0]).map(([, x]) => x);
  const G = [1, 2, 3, 4];
  const gaps = shuffle(G.flatMap((a) => G.flatMap((b) => G.map((c) => [a, b, c]))));
  const masks = Array.from({ length: 256 }, (_, m) => m).filter((m) => { const n = m.toString(2).split('1').length - 1; return n >= 2 && n <= 5; });
  // One table per spacing, so the examples differ.
  spacing: for (const [a, b, c] of gaps) {
    const pos = { 1: 0, 2: a, 3: a + b, 4: a + b + c };
    for (const stim of shuffle([1, 2, 3, 4])) {
      if (stim === original.stim && [1, 2, 3, 4].every((d) => pos[d] === original.pos[d])) continue;
      const setup = { ...original, pos, stim };
      for (const vA of shuffle([1, 2, 3, 4])) {
        if (vA === vB) continue;
        for (const t1 of shuffle(TIMES.filter((t) => t >= 2 && t <= 6))) {
          const box = 1 + Math.floor(rand() * 3);
          const order = shuffle([1, 2, 3, 4]);
          const full = fullTable(setup, { order, vA, t1, box, stim, delay: 1 }, vB);
          for (const mask of shuffle(masks)) {
            const table = {};
            ROMAN.forEach((r, i) => { table[r] = { A: mask & (1 << i) ? null : full[r].A, B: mask & (1 << (i + 4)) ? null : full[r].B }; });
            if (ROMAN.some((r) => table[r].A === undefined || table[r].B === undefined)) continue;
            // Cheap filters first: the first STEP 1 move, then the full read.
            if (!stimSteps(setup, table).ok) continue;
            if (!practiceRead(setup, table, vB, upto).ok) continue;
            found.push({ pos, stim, box, vA, t1, delay: 1, table, order });
            if (found.length >= count) return found;
            continue spacing;
          }
        }
      }
    }
  }
  return found;
}

const BOX = ['㉠', '㉡', '㉢'];
const signed = (v) => (v > 0 ? '+' + v : String(v));
/** One computed table, said the way a design prompt can use it. */
function describe(x) {
  const row = (n) => ROMAN.map((r) => (x.table[r][n] === null ? '?' : signed(x.table[r][n]))).join(', ');
  return `자극 $d_${x.stim}$, 위치 ${[1, 2, 3, 4].map((d) => `$d_${d}=${x.pos[d]}$`).join(', ')} cm, 시냅스 ${BOX[x.box - 1]}(시냅스 지연 ${x.delay} ms), A ${x.vA} cm/ms, $t_1=${x.t1}$ ms, Ⅰ~Ⅳ = ${x.order.map((d) => `$d_${d}$`).join(', ')} → A: ${row('A')} / B: ${row('B')}`;
}

module.exports = { at, reach, bValues, readings, readTable, analyse, stimSteps, nearestStep, fullTable, designs, practiceRead, practiceDesigns, describe, ROMAN };
