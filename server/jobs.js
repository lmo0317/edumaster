'use strict';
// Long model work runs as background jobs persisted on disk; the browser only polls.
// A restart marks unfinished jobs "interrupted"; resuming keeps every finished problem.
const { newId } = require('./store');
const { Budget, pcModelLabel, claudeCliChoice, harnessSettings, claudeLimits, PER_CALL_FREE } = require('./llm');
const pipeline = require('./pipeline');
const cliModels = require('./cli-models');
const { PROMPT_VERSION } = require('./prompts');

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
        ...(job.options?.designWith ? { generate: job.options.designWith, 'repair-lean': job.options.designWith, adjudicate: job.options.designWith } : {}),
        ...(job.options?.repairWith ? { repair: job.options.repairWith } : {}),
      },
      // Lean mixed run: the designer writes only an outline; this job's model writes the solution (see pipeline).
      lean: Boolean(job.options?.lean && job.options?.designWith),
      llm: { ...llm, json: (args) => llm.json({ ...args, provider: ctx.routes[args.purpose] || provider }) },
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
      const parent = store.jobs.get(ctx.job.parentJobId);
      const item = parent?.items?.[ctx.job.itemIndex];
      if (!item) throw new Error('다시 만들 문제를 찾지 못했습니다.');
      const previous = { problem: item.problem, solution: item.solution, verification: item.verification, status: item.status, designNote: item.designNote, replacedAt: new Date().toISOString(), feedback: ctx.job.feedback,
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
        await pipeline.produceItem(sub, { material: parent.material, item, prior, rules, mode: parent.options.mode, extraFeedback: ctx.job.feedback, previous, examples });
      } catch (e) {
        item.status = 'failed'; item.error = e.message; saveParent(); throw e;
      }
      item.regeneratedFrom = ctx.job.id;
      saveParent();
    },
  };

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
      if (ctx.provider === 'claude-cli') job.modelLabel = claudeCliChoice(config).label;
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

  return {
    analyze(material, provider = 'deepseek') { return create('analyze', { materialId: material.id, title: material.title, options: { provider } }, 'analyze'); },
    generate({ material, items, rules, options }) {
      return create('generate', { materialId: material.id, title: material.title, material, items, rules, options }, 'generate');
    },
    regenerate(parent, itemIndex, feedback) {
      if (!FINISHED.has(parent.status)) throw Object.assign(new Error('세트 생성이 끝난 뒤에 다시 만들 수 있습니다.'), { status: 409 });
      if ([...running.keys()].some((id) => { const j = store.jobs.get(id); return j?.type === 'regenerate' && j.parentJobId === parent.id; })) {
        throw Object.assign(new Error('이 세트의 다른 문제를 다시 만드는 중입니다.'), { status: 409 });
      }
      return create('regenerate', { parentJobId: parent.id, itemIndex, feedback, materialId: parent.materialId, title: parent.title, options: { provider: parent.options?.provider || 'deepseek', effort: parent.options?.effort, direction: parent.options?.direction } }, 'regenerate');
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
  };
}

module.exports = { createJobs, FINISHED };
