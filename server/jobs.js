'use strict';
// Long model work runs as background jobs persisted on disk; the browser only polls.
// A restart marks unfinished jobs "interrupted"; resuming keeps every finished problem.
const { newId } = require('./store');
const { Budget, pcModelLabel, claudeCliChoice, claudeDesignModel, CLAUDE_MODELS, harnessSettings, claudeLimits, PER_CALL_FREE } = require('./llm');
const pipeline = require('./pipeline');
const cliModels = require('./cli-models');
const { PROMPT_VERSION } = require('./prompts');
const setCheck = require('./set-check');

const FINISHED = new Set(['done', 'failed', 'cancelled', 'interrupted']);

function createJobs({ store, llm, config }) {
  const running = new Map(); // id -> AbortController
  const queue = [];
  const concurrency = 2;

  for (const job of store.jobs.all()) {
    if (!FINISHED.has(job.status)) {
      job.status = 'interrupted'; job.error = '서버가 다시 시작되어 작업이 멈췄습니다. 이어서 진행할 수 있습니다.';
      for (const item of job.items || []) if (['generating', 'verifying', 'repairing'].includes(item.status)) item.status = 'pending';
      store.jobs.put(job);
      if (job.type === 'analyze') {
        const m = store.materials.get(job.materialId);
        if (m && m.status === 'analyzing') store.materials.put({ ...m, status: 'failed', error: job.error });
      }
    }
  }

  function context(job, controller, extraSave) {
    const budget = new Budget(job.budget);
    Object.assign(budget, { calls: job.usage?.calls || 0, input: job.usage?.input || 0, output: job.usage?.output || 0, reasoning: job.usage?.reasoning || 0, total: job.usage?.total || 0 });
    const provider = ['gemma', 'relay', 'claude', 'claude-cli', 'agy-cli', 'codex-cli'].includes(job.options?.provider) ? job.options.provider : 'deepseek';
    const ctx = {
      store, job, budget, signal: controller.signal, provider,
      // Every model call in this job goes to the provider the teacher picked.
      // Except the calls a mixed run gives to another model: the problems (designWith) or only the repairs (repairWith).
      routes: {
        ...(job.options?.designWith ? { generate: job.options.designWith, 'repair-lean': job.options.designWith, 'repair-notes': job.options.designWith, adjudicate: job.options.designWith, 'polish-solution': job.options.designWith } : {}),
        ...(job.options?.repairWith ? { repair: job.options.repairWith } : {}),
      },
      // Lean mixed run: the designer writes only an outline; this job's model writes the solution (see pipeline).
      lean: Boolean(job.options?.lean && job.options?.designWith),
      // A cheaper designer's problems are checked by code before the judge solves them (see designOnce): a cheaper
      // Claude model, or another provider designing for Claude (the PC's Qwen under Opus).
      precheck: provider === 'claude-cli' && Boolean(claudeDesignModel(config) || job.options?.designWith),
      // A problem is made only once it passes the final review a finished set gets (pipeline.finalGate, 2026-10-19).
      finalGate: job.options?.finalGate !== false,
      // A second reviewer of each problem while it is made (pipeline.finalGate), only when a set asks for it: problems are
      // made first and the set reviewed after (the user, 2026-10-22: make them, find what is wrong, fix the system or keep
      // it as learning, then review) — Gemini on every problem made a set take over an hour.
      secondReviewer: job.options?.secondReviewer || '',
      llm: { ...llm, json: (args) => llm.json({ ...args, provider: args.purpose === 'final-review-second' ? args.provider : ctx.routes[args.purpose] || provider }) },
      effort: { generate: job.options?.effort || 'low', solve: job.options?.effort || 'low' },
      direction: job.options?.direction || '',
      ...(({ maxRepairs, maxRewrites, maxDesigns }) => ({ maxRepairs, maxRewrites, maxDesigns }))(harnessSettings(config.dataDir)),
      save() { job.usage = budget.toJSON(); job.updatedAt = new Date().toISOString(); store.jobs.put(job); extraSave?.(); },
      log(message) { job.log = [...(job.log || []), { t: new Date().toISOString(), message }].slice(-200); ctx.save(); },
    };
    return ctx;
  }

  // A subscription's remaining limits as of now, for the set report (how much of them a set used). Gemini's are read off
  // agy's /usage screen (no model call). Claude's and GPT's come with every call: a reading from the last ten minutes
  // is used, else (at the start of a set only) one tiny call outside the set's budget. Never fails the set.
  const QUOTA = {
    'claude-cli': () => claudeLimits(config),
    'codex-cli': () => cliModels.codexLimits(config),
  };
  async function limitsNow(provider, { start }) {
    try {
      if (provider === 'agy-cli') return await cliModels.refreshAgyLimits(config);
      const read = QUOTA[provider];
      if (!read) return null;
      const last = read();
      if (!start || (last && Date.now() - new Date(last.at).getTime() < 600000)) return last;
      await llm.json({ provider, purpose: 'solve', jobId: 'quota', budget: new Budget({ maxCalls: 2, maxTokens: 400000 }), effort: 'off', maxTokens: 2000,
        system: 'JSON만 출력한다.', text: '12×7의 값을 {"answer": 값} 형식으로만 답하라.' });
      return read();
    } catch { return null; }
  }
  const snap = (l) => (l ? { at: l.at, fiveHour: l.fiveHour || null, sevenDay: l.sevenDay || null } : null);

  const workers = {
    async analyze(ctx) {
      const material = store.materials.get(ctx.job.materialId);
      if (!material) throw new Error('자료를 찾지 못했습니다.');
      try {
        const result = await pipeline.analyzeMaterial(ctx, material);
        const current = store.materials.get(material.id);
        // A title the teacher typed wins over the one the model suggests.
        store.materials.put({ ...current, ...result, title: current.titleFromUser ? current.title : result.title, analyzedWith: ctx.provider, promptVersion: PROMPT_VERSION, status: 'ready', error: '', analyzedAt: new Date().toISOString() });
        ctx.log('분석 완료');
      } catch (e) {
        store.materials.put({ ...store.materials.get(material.id), status: 'failed', error: e.message });
        throw e;
      }
    },
    async generate(ctx) {
      // How much of the subscription's limits the set used: read before (kept when a set is resumed) and after.
      const quota = ['claude-cli', 'codex-cli', 'agy-cli'].includes(ctx.provider);
      if (quota && !ctx.job.quota?.before) { ctx.job.quota = { provider: ctx.provider, before: snap(await limitsNow(ctx.provider, { start: true })) }; ctx.save(); }
      try {
        await pipeline.runGeneration(ctx);
      } finally {
        if (quota && ctx.job.quota) { ctx.job.quota.after = snap(await limitsNow(ctx.provider, { start: false })); ctx.save(); }
      }
    },
    async regenerate(ctx) {
      await remake(ctx, ctx.job.itemIndex, ctx.job.feedback);
    },
    // 검수하고 고치기 (server/set-check.js): Claude and Gemini review the set; what they find is fixed — the analysis
    // against the images, each problem they would not hand out made again with their faults as the note — and the set
    // is reviewed again, up to `rounds` times. Without `fix` it is the review alone.
    async check(ctx) {
      const parentId = ctx.job.parentJobId;
      const material = store.materials.get(ctx.job.materialId);
      if (!store.jobs.get(parentId) || !material) throw new Error('검수할 세트를 찾지 못했습니다.');
      const images = pipeline.originalImages(store, material);
      // Each reviewer on its own subscription, outside the set's budget (as scripts/review-problem.js).
      const call = (provider, args) => llm.json({ ...args, provider, jobId: ctx.job.id, signal: ctx.signal, budget: new Budget({ maxCalls: 2, maxTokens: 3000000 }) });
      const maxFix = ctx.job.options?.fix ? (ctx.job.options.rounds ?? 2) : 0;
      const rounds = [];
      let record = null;
      const save = (rec) => setCheck.writeCheck(config.dataDir, parentId, { ...rec, rounds, jobId: ctx.job.id, fix: maxFix > 0, running: true });
      try {
        for (let round = 0; ; round++) {
          ctx.log(round ? `고친 세트를 다시 검수하는 중 (${round + 1}번째 검수)` : 'Claude·Gemini가 세트를 검수하는 중');
          record = await setCheck.reviewSet({ store, set: store.jobs.get(parentId), call, images, save });
          const errors = Object.entries(record.reviews).filter(([, v]) => v.error);
          if (errors.length === Object.keys(record.reviews).length) throw new Error(`검수하지 못했습니다: ${errors.map(([p, v]) => `${setCheck.NAME[p] || p} ${v.error}`).join(' / ')}`);
          const fails = setCheck.failing(record);
          const issues = setCheck.analysisIssues(record);
          const step = { at: record.at, scores: Object.fromEntries(Object.entries(record.checklist.models).map(([p, m]) => [p, m.score])), failing: fails.map((f) => f.label), analysisIssues: issues.length };
          rounds.push(step);
          ctx.log(`${round + 1}번째 검수: ${fails.length ? `걸린 문제 ${fails.map((f) => f.label).join(', ')}` : '모든 문제 통과'}${issues.length ? ` · 원본 분석 지적 ${issues.length}건` : ''}`);
          if (round >= maxFix || (!fails.length && !issues.length)) break;
          if (issues.length) {
            const parent = store.jobs.get(parentId);
            const fixed = await pipeline.fixAnalysis(ctx, parent.material, issues);
            if (fixed.length) { store.jobs.put(parent); step.analysisFixed = fixed; }
          }
          step.remade = [];
          for (const f of fails) {
            ctx.log(`${f.label}: 검수에서 걸린 ${f.faults.length}건을 고쳐 다시 만드는 중`);
            await remake(ctx, f.index, setCheck.remakeNote(f));
            step.remade.push(f.label);
          }
          save(record);
          if (!step.remade.length && !step.analysisFixed) break;
        }
      } finally {
        const last = setCheck.readCheck(config.dataDir, parentId);
        if (last?.jobId === ctx.job.id) setCheck.writeCheck(config.dataDir, parentId, { ...last, rounds, running: false });
      }
    },
    // 학습 반복: a set is made, Claude·Gemini review it (the 검수하기 review, kept with the set), and until both score it
    // at `target` with every problem passed, what they found changes the learning (pipeline.learnFromReview) — never the
    // code — and a new set is made with it, up to `maxRounds` sets. Each set is an ordinary set of the problem.
    // After the first set, the next keeps every problem both reviewers passed and makes again only the ones they failed,
    // each with their faults as its note (as 검수하고 고치기): making the whole set afresh drew new faults in problems that
    // had passed — on the gas original (2026-10-21) the practice problems passed in most of seven sets and were made anew
    // each time, and the scores went up and down instead of up.
    async train(ctx) {
      const t = ctx.job;
      const images = pipeline.originalImages(store, store.materials.get(t.materialId));
      const call = (provider, args) => llm.json({ ...args, provider, jobId: t.id, signal: ctx.signal, budget: new Budget({ maxCalls: 2, maxTokens: 3000000 }) });
      t.rounds = t.rounds || [];
      for (let r = t.rounds.length; r < t.maxRounds; r++) {
        const material = store.materials.get(t.materialId);
        if (!material) throw new Error('문제를 찾지 못했습니다.');
        const { images: im, ...snapshot } = material;
        const items = carryOver(t.rounds[r - 1]) || JSON.parse(JSON.stringify(t.items));
        const set = {
          id: newId(), type: 'generate', createdAt: new Date().toISOString(), log: [], promptVersion: PROMPT_VERSION,
          materialId: t.materialId, title: material.title, material: { ...snapshot, images: im }, items,
          rules: pipeline.pickRules(store, material), options: t.options, trainJobId: t.id, trainRound: r + 1,
          budget: { maxCalls: callCap(items.length, t.options?.provider), maxTokens: tokenCap(t.options?.provider, 'generate') },
          usage: { calls: 0, input: 0, output: 0, reasoning: 0, total: 0 }, status: 'running', startedAt: new Date().toISOString(),
        };
        const sctx = context(set, { signal: ctx.signal });
        if (sctx.provider === 'claude-cli') set.modelLabel = claudeCliChoice(config).label;
        sctx.save();
        ctx.log(`${r + 1}번째 세트를 만드는 중`);
        try {
          await workers.generate(sctx);
          set.status = 'done';
        } catch (e) {
          set.status = ctx.signal.aborted ? 'cancelled' : 'failed';
          set.error = e.message;
          if (ctx.signal.aborted) throw e;
        } finally {
          set.finishedAt = new Date().toISOString();
          sctx.save();
        }
        // A set not made, or a review one reviewer could not give, stops the repeat (the subscription's limit, a lost
        // connection): on 2026-10-22 the limit left sets empty and Claude's review failed, and two repeats ran six
        // rounds each on Gemini's 100 for nothing.
        const unmade = set.status === 'failed' ? set.error : (set.items.find((it) => !it.problem)?.error || (set.items.some((it) => !it.problem) && '문제가 만들어지지 않음'));
        if (unmade) throw new Error(`${r + 1}번째 세트를 만들지 못해 멈췄습니다: ${unmade}`);
        ctx.log(`${r + 1}번째 세트를 Claude·Gemini가 검수하는 중`);
        const save = (rec) => setCheck.writeCheck(config.dataDir, set.id, { ...rec, jobId: t.id, running: true });
        const record = await setCheck.reviewSet({ store, set: store.jobs.get(set.id), call, images, save });
        setCheck.writeCheck(config.dataDir, set.id, { ...record, jobId: t.id, running: false });
        const lost = Object.entries(record.reviews || {}).find(([, v]) => v.error);
        if (lost) throw new Error(`${r + 1}번째 세트의 ${setCheck.NAME[lost[0]] || lost[0]} 검수가 실패해 멈췄습니다: ${lost[1].error}`);
        const scores = setCheck.scores(record);
        const fails = setCheck.failing(record);
        const issues = setCheck.analysisIssues(record);
        const pass = setCheck.reaches(record, t.target);
        const round = { setId: set.id, at: new Date().toISOString(), scores, failing: fails.map((f) => f.label), faults: fails, analysisIssues: issues.length, pass };
        t.rounds.push(round);
        ctx.log(`${r + 1}번째 세트: ${Object.entries(scores).map(([p, s]) => `${setCheck.NAME[p] || p} ${s ?? '실패'}%`).join(' · ')}${fails.length ? ` — 걸린 문제 ${round.failing.join(', ')}` : ''}${issues.length ? ` · 원본 분석 지적 ${issues.length}건` : ''}`);
        ctx.save();
        if (pass) { t.reached = true; ctx.log(`목표(${t.target}점)에 도달했습니다`); return; }
        if (r + 1 >= t.maxRounds) break;
        // The analysis the reviewers fault is fixed against the original's images; everything else goes into learning.
        if (issues.length) round.analysisFixed = await pipeline.fixAnalysis(ctx, store.materials.get(t.materialId), issues);
        round.learned = await pipeline.learnFromReview(ctx, store.materials.get(t.materialId), set, fails.flatMap((f) => f.faults.map((text) => ({ label: f.label, text }))));
        ctx.save();
      }
      t.reached = false;
      ctx.log(`${t.maxRounds}번 만들었지만 목표(${t.target}점)에 이르지 못했습니다`);
    },
  };

  // 🔄 다시 만들기 of one problem of a set (a teacher's note, or what the review found), through the final review while made.
  /** The next 학습 반복 set's problems from the last round's set: passed ones as they are, failed ones to be made again. */
  function carryOver(round) {
    const last = round && store.jobs.get(round.setId);
    if (!last?.items?.length) return null;
    const failed = new Map((round.faults || []).map((f) => [f.index, f]));
    return last.items.map((it) => {
      const copy = JSON.parse(JSON.stringify(it));
      delete copy.adopted;
      const f = failed.get(it.index);
      if (!f) return copy;
      const previous = { problem: it.problem, solution: it.solution, verification: it.verification, status: it.status, designNote: it.designNote, replacedAt: new Date().toISOString(), feedback: setCheck.remakeNote(f), problems: [...new Set(it.problems || [])], warnings: [...new Set(it.warnings || [])] };
      return { index: it.index, stage: it.stage, variantNo: it.variantNo, label: it.label, status: 'pending', remakeNote: setCheck.remakeNote(f), history: [previous, ...(it.history || [])].slice(0, 3) };
    });
  }

  async function remake(ctx, itemIndex, feedback) {
    const parent = store.jobs.get(ctx.job.parentJobId);
    const item = parent?.items?.[itemIndex];
    if (!item) throw new Error('다시 만들 문제를 찾지 못했습니다.');
    const previous = { problem: item.problem, solution: item.solution, verification: item.verification, status: item.status, designNote: item.designNote, replacedAt: new Date().toISOString(), feedback,
    // What the checks could not fix last time: the remake must fix it, with or without a note from the teacher.
    problems: [...new Set(item.problems || [])], warnings: [...new Set(item.warnings || [])] };
    item.history = [previous, ...(item.history || [])].slice(0, 3);
    item.adopted = false; // a new version is reviewed afresh
    const saveParent = () => store.jobs.put(parent);
    const sub = { ...ctx, save() { ctx.save(); saveParent(); }, log(m) { ctx.log(m); } };
    const prior = parent.items.filter((x) => x.index < item.index && x.problem);
    // The feedback as it is now (not as it was when the set was made — the teacher has usually just added some),
    // and the variants adopted so far, except this one.
    const rules = pipeline.pickRules(store, parent.material);
    const examples = pipeline.adoptedExamples(store, parent.materialId, { jobId: parent.id, index: item.index });
    try {
      await pipeline.produceItem(sub, { material: parent.material, item, prior, rules, mode: parent.options.mode, extraFeedback: feedback, previous, examples });
    } catch (e) {
      item.status = 'failed'; item.error = e.message; saveParent(); throw e;
    }
    item.regeneratedFrom = ctx.job.id;
    saveParent();
  }

  function pump() {
    while (running.size < concurrency && queue.length) {
      const id = queue.shift();
      const job = store.jobs.get(id);
      if (!job || job.status !== 'queued') continue;
      const controller = new AbortController();
      running.set(id, controller);
      job.status = 'running'; job.startedAt = job.startedAt || new Date().toISOString();
      const ctx = context(job, controller);
      ctx.save();
      // The PC provider serves whichever local model is loaded, and the subscription runs the Claude model chosen on
      // the LLM tab; the job keeps that name (reports, PDFs).
      if (ctx.provider === 'claude-cli') job.modelLabel = claudeCliChoice(config).label + (ctx.precheck ? ` · 설계 ${CLAUDE_MODELS[claudeDesignModel(config)]}` : '');
      if (cliModels.CLIS.includes(ctx.provider)) job.modelLabel = cliModels.cliChoice(config, ctx.provider).label;
      const named = ctx.provider === 'gemma' && llm.gemmaStatus
        ? llm.gemmaStatus(true).then((s) => { if (s.model) job.modelLabel = pcModelLabel(s.model).replace(' (PC)', ''); }).catch(() => {})
        : Promise.resolve();
      named.then(() => workers[job.type](ctx)).then(() => {
        job.status = 'done';
      }).catch((e) => {
        job.status = controller.signal.aborted ? 'cancelled' : 'failed';
        job.error = controller.signal.aborted ? '작업을 취소했습니다.' : e.message;
        if (!controller.signal.aborted && e.name !== 'BudgetExceeded') console.error(`[job ${id}]`, e);
      }).finally(() => {
        job.finishedAt = new Date().toISOString();
        ctx.save();
        running.delete(id);
        pump();
      });
    }
  }

  function enqueue(job) {
    job.status = 'queued'; job.updatedAt = new Date().toISOString();
    store.jobs.put(job);
    queue.push(job.id);
    pump();
    return job;
  }

  // A paid API is held by tokens and calls; a model that costs nothing per call by calls (config.budget.perCallFreeTokens).
  // The 하네스 call cap is for a set of three problems; a set with more problems gets proportionally more (up to the
  // configured ceiling), so the later problems are not left unfixed.
  const callCap = (problems = 3, provider = '') => {
    const h = harnessSettings(config.dataDir);
    return Math.min(Math.round((provider === 'gemma' ? h.localCalls : h.setCalls) * Math.max(problems, 3) / 3), config.budget.generateCalls);
  };
  const tokenCap = (provider, budgetKey) => (PER_CALL_FREE.has(provider) ? config.budget.perCallFreeTokens : config.budget[budgetKey + 'Tokens']);
  function create(type, fields, budgetKey) {
    return enqueue({
      id: newId(), type, createdAt: new Date().toISOString(), log: [], promptVersion: PROMPT_VERSION,
      budget: { maxCalls: budgetKey === 'generate' ? callCap(fields.items?.length, fields.options?.provider) : config.budget[budgetKey + 'Calls'], maxTokens: tokenCap(fields.options?.provider, budgetKey) },
      usage: { calls: 0, input: 0, output: 0, reasoning: 0, total: 0 },
      ...fields,
    });
  }

  function busyGuard(parent) {
    const busy = [...running.keys(), ...queue].map((id) => store.jobs.get(id)).find((j) => ['regenerate', 'check'].includes(j?.type) && j.parentJobId === parent.id);
    if (busy) throw Object.assign(new Error(busy.type === 'check' ? '이 세트를 검수하는 중입니다.' : '이 세트의 다른 문제를 다시 만드는 중입니다.'), { status: 409 });
  }

  return {
    analyze(material, provider = 'deepseek') { return create('analyze', { materialId: material.id, title: material.title, options: { provider } }, 'analyze'); },
    generate({ material, items, rules, options }) {
      return create('generate', { materialId: material.id, title: material.title, material, items, rules, options }, 'generate');
    },
    // 학습 반복: the job's own budget is for the learning calls; each set it makes has a set's budget.
    train({ material, items, options, target = 90, maxRounds = 4 }) {
      return create('train', { materialId: material.id, title: material.title, items, options, target, maxRounds, rounds: [] }, 'analyze');
    },
    regenerate(parent, itemIndex, feedback) {
      if (!FINISHED.has(parent.status)) throw Object.assign(new Error('세트 생성이 끝난 뒤에 다시 만들 수 있습니다.'), { status: 409 });
      busyGuard(parent);
      return create('regenerate', { parentJobId: parent.id, itemIndex, feedback, materialId: parent.materialId, title: parent.title, options: { provider: parent.options?.provider || 'deepseek', effort: parent.options?.effort, direction: parent.options?.direction } }, 'regenerate');
    },
    // One review at a time per set (each reviewer is a subscription), and no remake while it runs.
    check(parent, { fix = false, rounds = 2 } = {}) {
      if (parent.type !== 'generate' || !FINISHED.has(parent.status)) throw Object.assign(new Error('세트 생성이 끝난 뒤에 검수할 수 있습니다.'), { status: 409 });
      busyGuard(parent);
      return create('check', { parentJobId: parent.id, materialId: parent.materialId, title: parent.title, options: { provider: parent.options?.provider || 'deepseek', effort: parent.options?.effort, direction: parent.options?.direction, fix, rounds } }, 'generate');
    },
    resume(job) {
      if (!['interrupted', 'failed', 'cancelled'].includes(job.status) || job.type !== 'generate') throw Object.assign(new Error('이어서 진행할 수 없는 작업입니다.'), { status: 409 });
      for (const item of job.items) if (!['passed', 'warning', 'needs_review'].includes(item.status)) item.status = 'pending';
      // A resumed job gets a fresh allowance on top of what it already spent.
      job.budget = { maxCalls: (job.usage?.calls || 0) + callCap(job.items.filter((it) => it.status === 'pending').length, job.options?.provider), maxTokens: (job.usage?.total || 0) + tokenCap(job.options?.provider, 'generate') };
      job.error = '';
      return enqueue(job);
    },
    cancel(id) {
      const controller = running.get(id);
      if (controller) { controller.abort(); return true; }
      const i = queue.indexOf(id);
      if (i >= 0) { queue.splice(i, 1); const job = store.jobs.get(id); if (job) store.jobs.put({ ...job, status: 'cancelled', error: '작업을 취소했습니다.' }); return true; }
      return false;
    },
    activeCount: () => running.size + queue.length,
    list: () => [...running.keys(), ...queue].map((id) => store.jobs.get(id)).filter(Boolean),
  };
}

module.exports = { createJobs, FINISHED };
