'use strict';
// Long model work runs as background jobs persisted on disk; the browser only polls.
// A restart marks unfinished jobs "interrupted"; resuming keeps every finished problem.
const { newId } = require('./store');
const { Budget, pcModelLabel } = require('./llm');
const pipeline = require('./pipeline');
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
    const provider = ['gemma', 'relay', 'claude'].includes(job.options?.provider) ? job.options.provider : 'deepseek';
    const ctx = {
      store, job, budget, signal: controller.signal, provider,
      // Every model call in this job goes to the provider the teacher picked.
      // Except the calls a mixed run gives to another model: the problems (designWith) or only the repairs (repairWith).
      routes: { ...(job.options?.designWith ? { generate: job.options.designWith } : {}), ...(job.options?.repairWith ? { repair: job.options.repairWith } : {}) },
      llm: { ...llm, json: (args) => llm.json({ ...args, provider: ctx.routes[args.purpose] || provider }) },
      effort: { generate: job.options?.effort || 'low', solve: job.options?.effort || 'low' },
      maxRepairs: 2,
      save() { job.usage = budget.toJSON(); job.updatedAt = new Date().toISOString(); store.jobs.put(job); extraSave?.(); },
      log(message) { job.log = [...(job.log || []), { t: new Date().toISOString(), message }].slice(-200); ctx.save(); },
    };
    return ctx;
  }

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
    async generate(ctx) { await pipeline.runGeneration(ctx); },
    async regenerate(ctx) {
      const parent = store.jobs.get(ctx.job.parentJobId);
      const item = parent?.items?.[ctx.job.itemIndex];
      if (!item) throw new Error('다시 만들 문제를 찾지 못했습니다.');
      const previous = { problem: item.problem, solution: item.solution, verification: item.verification, status: item.status, designNote: item.designNote, replacedAt: new Date().toISOString(), feedback: ctx.job.feedback };
      item.history = [previous, ...(item.history || [])].slice(0, 3);
      const saveParent = () => store.jobs.put(parent);
      const sub = { ...ctx, save() { ctx.save(); saveParent(); }, log(m) { ctx.log(m); } };
      const prior = parent.items.filter((x) => x.index < item.index && x.problem);
      try {
        await pipeline.produceItem(sub, { material: parent.material, item, prior, rules: parent.rules, mode: parent.options.mode, extraFeedback: ctx.job.feedback, previous });
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
      // The PC provider serves whichever local model is loaded; the job keeps its name (reports, PDFs).
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

  function create(type, fields, budgetKey) {
    return enqueue({
      id: newId(), type, createdAt: new Date().toISOString(), log: [], promptVersion: PROMPT_VERSION,
      budget: { maxCalls: config.budget[budgetKey + 'Calls'], maxTokens: config.budget[budgetKey + 'Tokens'] },
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
      return create('regenerate', { parentJobId: parent.id, itemIndex, feedback, materialId: parent.materialId, title: parent.title, options: { provider: parent.options?.provider || 'deepseek', effort: parent.options?.effort } }, 'regenerate');
    },
    resume(job) {
      if (!['interrupted', 'failed', 'cancelled'].includes(job.status) || job.type !== 'generate') throw Object.assign(new Error('이어서 진행할 수 없는 작업입니다.'), { status: 409 });
      for (const item of job.items) if (!['passed', 'warning', 'needs_review'].includes(item.status)) item.status = 'pending';
      // A resumed job gets a fresh allowance on top of what it already spent.
      job.budget = { maxCalls: (job.usage?.calls || 0) + config.budget.generateCalls, maxTokens: (job.usage?.total || 0) + config.budget.generateTokens };
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
