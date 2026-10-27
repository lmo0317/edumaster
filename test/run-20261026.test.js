'use strict';
// The run of 2026-10-26 (seven originals, 학습 반복 to the target on all seven, in test/fixtures/run-20261026) as the
// system's regression data, with the earlier run of the same day that got stuck for four sets on a line the code put into
// every solution, and the model answers the reader could not use. Every function that turns a model's answer into data or
// writes into a problem is run over all of it: what the run accepted must still be accepted exactly as it was, what the
// reviewers faulted must be seen, and the answers the reader lost must be read. No model is called.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const harness = require('../server/harness');
const finalReview = require('../server/final-review');
const setCheck = require('../server/set-check');
const pipeline = require('../server/pipeline');
const faults = require('../server/faults');
const cli = require('../server/cli-models');
const { createLlm, Budget, extractJson, extractJsonInfo, repeating, REQUIRED } = require('../server/llm');
const { openStore } = require('../server/store');

const FIX = path.join(__dirname, 'fixtures', 'run-20261026');
const readDir = (d) => fs.readdirSync(path.join(FIX, d)).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(FIX, d, f), 'utf8')));
const materials = Object.fromEntries(readDir('materials').map((m) => [m.id, m]));
const sets = readDir('sets').sort((a, b) => a.createdAt.localeCompare(b.createdAt));
const trains = readDir('trains');
const rules = readDir('rules');
const reviewOf = (id) => JSON.parse(fs.readFileSync(path.join(FIX, 'reviews', `${id}.json`), 'utf8'));
const store = { rules: { all: () => rules }, materials: { get: (id) => materials[id] || null }, dataDir: FIX };
const clone = (x) => JSON.parse(JSON.stringify(x));
const items = sets.flatMap((j) => j.items.map((it) => ({ set: j, material: materials[j.materialId], item: it })));
const STUCK = trains.find((t) => t.id === '4496f4b5558b3637de51935b');
const MOLAR_SET_1 = '4a4fd8a3d8b57742ed302014';

test('the fixture is the run: seven originals, eight sets of 25 problems, seven 학습 반복 reached and one stuck', () => {
  assert.equal(Object.keys(materials).length, 7);
  assert.equal(sets.length, 8);
  assert.equal(items.length, 25);
  assert.ok(items.every(({ item }) => item.status === 'passed' && item.finalReview?.passed));
  assert.equal(trains.filter((t) => t.reached).length, 7);
  assert.equal(STUCK.rounds.length, 4);
});

// ---------------------------------------------------------------- the teacher's frames and the solutions laid out by code

test('every sentence frame of the seven originals is kept, and none carries a value of the original', () => {
  let frames = 0;
  for (const m of Object.values(materials)) {
    for (const s of m.frames) for (const f of s.frames) { frames++; assert.equal(harness.carriesValue(f), false, `${m.title}: ${f}`); }
    assert.deepEqual(harness.validateFrames(m, { steps: m.frames }).map((s) => s.frames), m.frames.map((s) => s.frames), `${m.title}: validateFrames keeps its own frames`);
  }
  assert.equal(frames, 110);
});

test('a unit of one that a rate is reckoned by is the method, an amount with its unit is a value', () => {
  for (const f of ['ㄴ. 1g에 들어 있는 전체 원자 수는 (나)>(다)이다. (○)', '따라서 1g에 들어 있는 전체 원자 수는 (나)>(다)이다.', '1 mol당 분자 수는 같다', '기체 1몰의 부피']) assert.equal(harness.carriesValue(f), false, f);
  for (const f of ['반응 전 질량 20 g에서', '질량은 $5w$ g이고 $x=《값》', 'B 1 g이 모두 반응하면', '$\\frac{w}{15}$ mol이다.']) assert.equal(harness.carriesValue(f), true, f);
});

test('every problem of the run renders with no frame left, the same twice over, and passes the code checks it passed then', () => {
  for (const { set, material, item } of items) {
    const once = clone(item);
    assert.deepEqual(harness.renderFrames(material, once), [], `${set.id} ${item.label}: a frame left`);
    const twice = clone(once);
    harness.renderFrames(material, twice);
    assert.deepEqual(twice.solution, once.solution, `${set.id} ${item.label}: renderFrames is not idempotent`);
    const checks = harness.inspectItem(material, once, set.options?.mode);
    assert.deepEqual(checks.filter((c) => c.state === 'fail' && c.severity === 'hard').map((c) => `${c.id}: ${c.evidence}`), [], `${set.id} ${item.label}`);
    assert.equal(checks.find((c) => c.id === 'frames').state, 'pass');
    assert.equal(checks.find((c) => c.id === 'format').state, 'pass', `${set.id} ${item.label}`);
  }
});

test('the one fault Gemini found in the run (a hidden $aw$ no solution needs) is a hint of the code now, and no other problem gets it', () => {
  const flagged = items.filter(({ material, item }) => harness.checkDecorativeLetters(material, item).some((c) => c.state === 'fail'));
  assert.deepEqual(flagged.map(({ set, item }) => `${set.id} ${item.label}`), [`${MOLAR_SET_1} 최종 문제`]);
  const check = harness.checkDecorativeLetters(flagged[0].material, flagged[0].item)[0];
  assert.equal(check.severity, 'hint');
  assert.match(check.evidence, /문자 a는 발문에서 묻지 않고/);
  // What Gemini wrote about it, in the stored review.
  const gemini = reviewOf(MOLAR_SET_1).reviews['agy-cli'].review.items.find((x) => x.index === 2);
  assert.ok(gemini.issues.some((x) => /\$aw\$/.test(x.detail) && x.rule === '조건'));
});

test('a code check of severity hint goes to the final review as a hint, never to a repair', async () => {
  const m = { id: 'm', subject: '화학', problem: { text: '| 실험 | 질량 |\n|---|---|\n| Ⅰ | $3w$ |\n$x$는?', choices: ['1', '2', '3', '4', '5'], answer: 3 }, steps: [{ title: 'STEP', work: '$x=3$이다.' }] };
  const it = { index: 0, label: 'STEP 1 연습', stage: { kind: 'upto', upto: 1 }, appliedRules: [], usesSteps: [1], attempts: [],
    problem: { text: '| 실험 | 질량 |\n|---|---|\n| Ⅰ | $aw$ |\n$x$는?', choices: ['1', '2', '3', '4', '5'], answer: 3 },
    solution: { steps: [{ step: 1, title: 'STEP', work: '남은 질량이 $5w$이므로 $a=5$이다.\n따라서 $x=3$이다.\n정답은 ③ 3이다.' }] },
    verificationSpec: { program: ['ans = 3'], answer: 'ans', choices: ['1', '2', '3', '4', '5'], checks: [] } };
  const blind = { answer: 3, solution: '', issues: [], stepsUsed: [1], shortcuts: [], conditions: [], rules: [] };
  const gated = await pipeline.verifyItem({ finalGate: true, job: { id: 't', rules: [] }, budget: {}, effort: {}, log() {}, save() {} }, clone(it), m, [], 'practice', [], { blind });
  assert.ok(gated.hints.some((h) => /문자 a는 발문에서 묻지 않고/.test(h)), gated.hints.join());
  assert.ok(!gated.designNotes.some((h) => /문자 a는/.test(h)) && !gated.hard.length, JSON.stringify([gated.designNotes, gated.hard]));
  const open = await pipeline.verifyItem({ finalGate: false, job: { id: 't', rules: [] }, budget: {}, effort: {}, log() {}, save() {} }, clone(it), m, [], 'practice', [], { blind });
  assert.ok(open.designNotes.some((h) => /문자 a는 발문에서 묻지 않고/.test(h)), open.designNotes.join());
});

test('the stuck run\'s fault: the teacher\'s choice heading on one line with her closing calculation goes in as the heading alone', () => {
  const first = reviewOf(STUCK.rounds[0].setId);
  const bad = first.set.items[0].solution.at(-1).work.split('\n').find((l) => /^\[선택지 분석\]/.test(l));
  assert.match(bad, /\$b=3\$, \$x=15\$/, 'the stored solution of the stuck run carries the original\'s values');
  const material = { steps: first.material.steps };
  const item = { problem: { answer: 2, choices: ['$2w$', '$3w$', '$4w$', '$5w$', '$6w$'] }, solution: { steps: [{ step: 1, title: 't', work: '따라서 $x=2w$이다.\n정답은 ② $2w$이다.' }] } };
  assert.equal(harness.teacherChoiceHeading(material, item), true);
  assert.equal(item.solution.steps[0].work, '따라서 $x=2w$이다.\n\n[선택지 분석]\n정답은 ② $2w$이다.');
  // Every solution of the reached run is free of it.
  for (const { item: it } of items) for (const s of it.solution.steps) assert.ok(!/\$b=3\$, \$x=15\$/.test(s.work));
});

test('every problem of the run reads back through normalizeGenerated as it was stored', () => {
  for (const { set, item } of items) {
    const back = pipeline.normalizeGenerated({ problem: item.problem, solution: item.solution, usesSteps: item.usesSteps, designNote: item.designNote, appliedRules: item.appliedRules, verification: item.verificationSpec });
    assert.deepEqual(back.problem, item.problem, `${set.id} ${item.label}`);
    assert.deepEqual(back.solution.steps.map((s) => [s.step, s.title, s.work]), item.solution.steps.map((s) => [s.step, s.title, s.work]), `${set.id} ${item.label}`);
    assert.deepEqual(back.usesSteps, item.usesSteps);
  }
});

test('the seven analyses as read pass the source checks', async () => {
  for (const m of Object.values(materials)) {
    const checks = await pipeline.sourceChecks(m);
    assert.deepEqual(checks.filter((c) => c.state === 'fail').map((c) => `${c.id}: ${c.evidence}`), [], m.title);
  }
});

// ---------------------------------------------------------------- the reviews as the run scored them

test('every review of the run and of the stuck run is read as it was scored: the reviewer\'s answer, the scores, what failed, the verdict', () => {
  let reviewed = 0;
  for (const t of trains) {
    for (const [r, round] of t.rounds.entries()) {
      const record = reviewOf(round.setId);
      const set = sets.find((j) => j.id === round.setId) || { materialId: t.materialId, rules: [] };
      for (const v of Object.values(record.reviews)) for (const it of v.review.items) { reviewed++; assert.ok(finalReview.answerOf(it.myAnswer) > 0, `${round.setId}: ${it.myAnswer}`); }
      const advisory = setCheck.advisoryOf(store, { ...set, material: record.material });
      const scores = setCheck.checklist(record, advisory).models;
      for (const p of Object.keys(scores)) assert.equal(scores[p].score, record.checklist.models[p].score, `${round.setId} ${p}`);
      // From the second round on, a problem both reviewers passed the round before is settled: its verdict stands.
      const previous = t.rounds[r - 1];
      const settled = previous ? new Set(reviewOf(previous.setId).set.items.map((x) => x.index).filter((i) => !previous.faults.some((f) => f.index === i))) : null;
      assert.deepEqual(setCheck.failing(record, settled, advisory).map((f) => f.label), round.failing, `${round.setId}`);
      assert.equal(setCheck.reaches(record, t.target || 90, settled, advisory), round.pass, `${round.setId}`);
      if (round.flipped) assert.deepEqual(setCheck.failing(record, null, advisory).filter((f) => settled.has(f.index)).map((f) => f.label), round.flipped.map((f) => f.label));
    }
  }
  assert.equal(reviewed, 50 + 24);
});

test('the 학습 반복 stop rule stops the stuck run at its third set and none of the seven that reached the target', () => {
  assert.equal(setCheck.stuckAfterLearning(STUCK.rounds, 1), false);
  assert.equal(setCheck.stuckAfterLearning(STUCK.rounds, 2), true);
  assert.equal(setCheck.stuckAfterLearning(STUCK.rounds, 3), true);
  for (const t of trains.filter((x) => x.reached)) for (const r of t.rounds.keys()) assert.equal(setCheck.stuckAfterLearning(t.rounds, r), false, t.id);
  // A healthy run with many first-time faults is not stuck; one with new learning but faults that are its own is.
  const stats = (faults, own) => ({ faultStats: { faults, own }, learned: [{ kind: 'add' }] });
  assert.equal(setCheck.stuckAfterLearning([stats(10, 1), stats(10, 2), stats(10, 3)]), false);
  assert.equal(setCheck.stuckAfterLearning([stats(10, 1), stats(10, 9), stats(5, 5)]), true);
  assert.equal(setCheck.stuckAfterLearning([{ faultStats: { faults: 10, own: 1 }, learned: [] }, stats(10, 9), stats(5, 5)]), true, 'with or without a learning change');
});

test('each set\'s fault statistics are what the run recorded', () => {
  for (const j of sets) {
    const earlier = sets.filter((x) => x.createdAt < j.createdAt);
    const history = faults.index(earlier, { dataDir: FIX, exclude: j.id });
    assert.deepEqual(faults.setStats(j, history), j.faultStats, `${j.id}`);
  }
});

// ---------------------------------------------------------------- the answers the reader lost

test('every model answer the run\'s reader could not use is read now, but an empty answer still is not', () => {
  const dir = path.join(FIX, 'llm-failures');
  const files = fs.readdirSync(dir);
  const body = (f) => fs.readFileSync(path.join(dir, f), 'utf8').split('\n').slice(3).join('\n');
  for (const f of files.filter((x) => /-learn\.txt$/.test(x))) assert.deepEqual(extractJsonInfo(body(f)), { data: { items: [] }, repaired: false }, f);
  for (const f of files.filter((x) => /-review-solution\.txt$/.test(x) && fs.statSync(path.join(dir, x)).size > 100)) {
    const { data, repaired } = extractJsonInfo(body(f));
    assert.deepEqual(data.steps, []); assert.ok(data.rules.kept.length >= 10); assert.equal(repaired, false, f);
  }
  const generate = extractJson(body('b131804c6eda178962982d17-generate.txt'));
  assert.deepEqual(Object.keys(generate), ['problem', 'solution', 'usesSteps', 'designNote', 'appliedRules', 'verification'], 'a full-width comma between members');
  assert.equal(generate.appliedRules.length, 25);
  const written = extractJson(body('b141a1d3b0bee0f78bdc76ed-write-solution.txt'));
  assert.equal(written.solution.steps.length, 1, 'a note after the closing fence');
  assert.match(written.solution.summary, /한계 반응물/);
  for (const f of ['72fa5ce34ec3b01fa0ba31ef-review-solution.txt', 'd33919d0504c713d8e5344d5-review-solution.txt']) assert.throws(() => extractJson(body(f)), /JSON을 찾지 못했습니다/);
});

test('an empty list is the model\'s answer when the JSON was read as written, and suspect only when it had to be repaired', () => {
  assert.deepEqual(extractJsonInfo('{"items":[]}'), { data: { items: [] }, repaired: false });
  assert.deepEqual(extractJsonInfo('{"items":[],"x":[{"a":1}'), { data: { items: [], x: [{ a: 1 }] }, repaired: true });
  assert.deepEqual(REQUIRED.learn, ['items']);
});

test('json() takes {"items":[]} as nothing to learn in one call, and asks for a missing item by name', async () => {
  const answers = [];
  const seen = [];
  const server = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => { seen.push(JSON.parse(b)); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: answers.shift() } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })); });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const url = `http://127.0.0.1:${server.address().port}/v1`;
    const llm = createLlm({ config: { llmMode: 'deepseek', deepseek: { baseUrl: url, visionModel: 'v', textModel: 't', timeoutMs: 5000 }, gemma: {} }, store: openStore(fs.mkdtempSync(path.join(os.tmpdir(), 'em-run-'))), apiKey: 'k', mock: null });
    answers.push('{"items":[]}');
    const learned = await llm.json({ provider: 'deepseek', purpose: 'learn', jobId: 'j', budget: new Budget({ maxCalls: 5, maxTokens: 1000 }), system: 's', text: 't', effort: 'off' });
    assert.deepEqual(learned.data, { items: [] });
    assert.equal(seen.length, 1, 'one call, no retry');
    answers.push('{"solution":"못 풀었다","answer":null}', '{"solution":"못 풀었다","answer":0}');
    const solved = await llm.json({ provider: 'deepseek', purpose: 'solve', jobId: 'j', budget: new Budget({ maxCalls: 5, maxTokens: 1000 }), system: 's', text: 't', effort: 'off' });
    assert.equal(solved.data.answer, 0);
    assert.equal(seen.length, 3);
    assert.match(seen[2].messages[3].content, /answer 항목이 없거나 비어 있다. 실제로 넣을 것이 없으면/);
    assert.doesNotMatch(seen[2].messages[3].content, /올바른 JSON이 아니다/);
  } finally { server.close(); }
});

test('the reader takes what is inside a fence or an object whatever the model wrote after it, drops thinking, and keeps LaTeX', () => {
  assert.deepEqual(extractJson('```json\n{"answer":2}\n```\n참고: $\\frac{1}{2}$은 {맞다}'), { answer: 2 });
  assert.deepEqual(extractJson('{"answer":2}\n\n설명: {"answer":3}은 틀렸다 \\frac{1}{2}'), { answer: 2 });
  assert.deepEqual(extractJson('<think>초안 {"answer":1}</think>\n{"answer":2}'), { answer: 2 });
  assert.deepEqual(extractJson('{"a":1}\n{"a":2}'), { a: 1 }, 'two objects: the first complete one');
  assert.deepEqual(extractJson('{"a":1}，\n"b":2}'), { a: 1 });
  assert.deepEqual(extractJson('{"a":"x"，"b":2}'), { a: 'x', b: 2 }, 'a full-width comma between members');
  assert.equal(extractJson(String.raw`{"w":"$x \neq y$이고 \n다음 줄 not"}`).w, '$x \\neq y$이고 \n다음 줄 not');
  assert.equal(extractJson(String.raw`{"w":"$a \ne b$, $\nu$"}`).w, '$a \\ne b$, $\\nu$');
  assert.equal(extractJson(String.raw`{"w":"$\ce{H2} \uparrow$"}`).w, '$\\ce{H2} \\uparrow$');
  assert.equal(extractJson('{"w":"\\u00e9"}').w, 'é', 'a unicode escape stays one');
  assert.deepEqual(extractJson('[{"a":1},{"a":2}]'), { a: 1 }, 'a list of objects: the first one');
});

test('a rule of dashes, a wide divider or a long decimal is not a looping model; a loop still is', () => {
  assert.equal(repeating('x'.repeat(500) + '\n' + '-'.repeat(70)), false);
  assert.equal(repeating('표\n' + '|---'.repeat(20) + '|\n' + Array.from({ length: 60 }, (_, i) => `${i}번째 줄의 내용은 ${i * 7}이다.`).join('\n')), false);
  assert.equal(repeating('a'.repeat(400) + '0.' + '3'.repeat(65)), false);
  assert.equal(repeating('(M_A/M_B) * '.repeat(80)), true);
  assert.equal(repeating('같은 문장을 또 쓴다. '.repeat(300)), true);
});

test('a CLI that exits before reading its prompt fails the call, not the server', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'em-cli-exit-'));
  const early = path.join(dir, 'exit-early.js');
  fs.writeFileSync(early, 'process.exit(3);\n');
  const config = { dataDir: dir, codexCli: { bin: process.execPath, binArgs: [early], timeoutMs: 20000 }, agyCli: { off: true } };
  let crashed = null;
  const onError = (e) => { crashed = e; };
  process.on('uncaughtException', onError);
  try {
    await assert.rejects(cli.sendCli(config, 'codex-cli', { messages: [{ role: 'system', content: 'x'.repeat(400000) }, { role: 'user', content: 'y'.repeat(400000) }], effort: 'low' }), /실행 오류|오류/);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(crashed, null, crashed && crashed.message);
  } finally { process.off('uncaughtException', onError); }
});

test('the final review that answers about another problem is asked once more, told so, before it counts as a fault', async () => {
  const FULL = Object.fromEntries(finalReview.ITEM_NAMES.map((n) => [n, 'ok']));
  const m = { id: 'm', subject: '화학', problem: { text: '1+1은?', choices: ['1', '2', '3', '4', '5'], answer: 2 }, steps: [{ title: '덧셈', work: '1+1=2이다.' }] };
  const it = { index: 1, label: '최종 문제', stage: { kind: 'twin' }, attempts: [], problem: { text: '2+2는?', choices: ['1', '2', '3', '4', '5'], answer: 4 }, solution: { steps: [{ step: 1, title: '덧셈', work: '2+2=4이다.' }] } };
  const good = { index: 1, label: '최종 문제', verdict: 'use', answerOk: true, markedAnswer: 4, myAnswer: '④ 4', checks: FULL, issues: [] };
  const other = { ...good, index: 0, label: 'STEP 1 연습' };
  const texts = [];
  const ctx = (answers) => ({ finalGate: true, store, job: { id: 't', materialId: 'm', rules: [] }, budget: { affords: () => true }, effort: {}, log() {}, save() {},
    llm: { json: async ({ text }) => { texts.push(text); return { data: { items: [answers.shift()] } }; } } });
  const asked = await pipeline.finalGate(ctx([other, good]), clone(it), m, [], []);
  assert.deepEqual(asked.faults, []);
  assert.equal(texts.length, 2);
  assert.match(texts[1], /이전 응답이 불완전했습니다.*index 1, label "최종 문제"/);
  const twice = await pipeline.finalGate(ctx([other, other]), clone(it), m, [], []);
  assert.deepEqual(twice.faults, []);
  assert.match(twice.skipped, /두 번 모두 불완전했습니다.*이 문항\(index·label\)의 판정을 돌려주지 않았습니다/);
  assert.equal(texts.length, 4);
  const straight = await pipeline.finalGate(ctx([good]), clone(it), m, [], []);
  assert.deepEqual(straight.faults, []);
  assert.equal(texts.length, 5);
});
