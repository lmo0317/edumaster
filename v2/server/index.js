'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const config = require('./config');
const { openStore, newId, isId } = require('./store');
const { createLlm, PROVIDERS, Budget, pcModelLabel, pcModelKey } = require('./llm');
const { mock } = require('./mock-llm');
const { createJobs, FINISHED } = require('./jobs');
const { makeRule, updateRule, readingCorrections, recordCorrections, readingHint } = require('./learning');
const { normalizeStages, buildItems } = require('./plan');
const pipeline = require('./pipeline');
const prompts = require('./prompts');
const harness = require('./harness');

const VERSION = '2.0.0';

function readSecret(file) {
  try { return fs.readFileSync(file, 'utf8').trim(); } catch { return ''; }
}

function createApp(options = {}) {
  const cfg = { ...config, ...options, budget: { ...config.budget, ...options.budget }, deepseek: { ...config.deepseek, ...options.deepseek } };
  const store = openStore(cfg.dataDir);
  const apiKey = readSecret(path.join(cfg.dataDir, 'deepseek-api-key.txt'));
  const claudeKey = readSecret(path.join(cfg.dataDir, 'anthropic-api-key.txt'));
  let accessCode = readSecret(path.join(cfg.dataDir, 'access-code.txt'));
  if (!accessCode) {
    accessCode = crypto.randomBytes(6).toString('base64url');
    fs.writeFileSync(path.join(cfg.dataDir, 'access-code.txt'), accessCode + '\n', { mode: 0o600 });
    console.log(`접속 코드를 새로 만들었습니다: ${path.join(cfg.dataDir, 'access-code.txt')}`);
  }
  const llm = createLlm({ config: cfg, store, apiKey, claudeKey, mock });
  const jobs = createJobs({ store, llm, config: cfg });

  // ------------------------------------------------------------ sessions
  const sessionFile = path.join(cfg.dataDir, 'sessions.json');
  let sessions = {};
  try { sessions = JSON.parse(fs.readFileSync(sessionFile, 'utf8')); } catch { sessions = {}; }
  const saveSessions = () => fs.writeFileSync(sessionFile, JSON.stringify(sessions), { mode: 0o600 });
  const SESSION_DAYS = 30;
  const cookieName = 'em2_session';
  const sessionOf = (req) => {
    const token = /(?:^|;\s*)em2_session=([A-Za-z0-9_-]{20,})/.exec(req.headers.cookie || '')?.[1];
    if (!token) return null;
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    const s = sessions[hash];
    return s && s.expires > Date.now() ? hash : null;
  };
  const attempts = new Map();

  // ------------------------------------------------------------ helpers
  const security = {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  };
  const send = (res, status, body, headers = {}) => {
    const payload = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...security, ...headers });
    res.end(payload);
  };
  const fail = (status, message) => Object.assign(new Error(message), { status });
  const readBody = (req, limit) => new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(fail(413, '요청이 너무 큽니다. 이미지 크기를 줄여 주세요.')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(fail(400, '요청 형식이 올바르지 않습니다.')); }
    });
    req.on('error', reject);
  });
  const materialSummary = (m) => ({ id: m.id, title: m.title, subject: m.subject, topic: m.topic, status: m.status, createdAt: m.createdAt, stepCount: m.steps?.length || 0, solutionSource: m.solutionSource, images: m.images, error: m.error });
  const jobSummary = (j) => ({
    id: j.id, type: j.type, status: j.status, title: j.title, materialId: j.materialId, createdAt: j.createdAt, finishedAt: j.finishedAt, error: j.error, usage: j.usage, options: j.options,
    parentJobId: j.parentJobId, itemIndex: j.itemIndex,
    items: (j.items || []).map((i) => ({ index: i.index, label: i.label, status: i.status })),
  });
  const getJob = (id) => store.jobs.get(id) || (() => { throw fail(404, '작업을 찾지 못했습니다. 삭제되었거나 주소가 잘못되었습니다.'); })();
  const getMaterial = (id) => store.materials.get(id) || (() => { throw fail(404, '자료를 찾지 못했습니다.'); })();

  // ------------------------------------------------------------ routes
  const routes = [];
  const route = (method, pattern, handler, { open = false } = {}) => routes.push({ method, pattern, handler, open });

  route('GET', /^\/api\/status$/, async (req) => {
    const gemma = await llm.gemmaStatus();
    return {
      version: VERSION, authenticated: Boolean(sessionOf(req)), llm: cfg.llmMode,
      deepseekConfigured: Boolean(apiKey), visionModel: cfg.deepseek.visionModel, textModel: cfg.deepseek.textModel,
      providers: {
        deepseek: { label: PROVIDERS.deepseek.label, available: Boolean(apiKey) || cfg.llmMode === 'mock', note: '항상 사용 가능 · 유료 · 빠름' },
        gemma: { label: pcModelLabel(gemma.model), available: gemma.available, model: gemma.model, note: gemma.available ? 'PC 연결됨 · 무료 · 느림' : 'PC가 꺼져 있어 지금은 사용할 수 없음' },
        ...(claudeKey && cfg.claude.selectable ? { claude: { label: PROVIDERS.claude.label, available: true, note: '유료 · 품질 가장 높음 · DeepSeek보다 비쌈' } } : {}),
        ...(cfg.relay.dir ? { relay: { label: cfg.relay.label, available: true, note: '요청마다 외부 에이전트가 응답 (비교 실험용)' } } : {}),
      },
      activeJobs: jobs.activeCount(),
    };
  }, { open: true });

  // Picks the provider for a new job and refuses Gemma while the PC is off.
  const chooseProvider = async (value) => {
    if (value === 'relay') {
      if (!cfg.relay.dir) throw fail(409, '이 서버에는 중계 모델이 설정되어 있지 않습니다.');
      return 'relay';
    }
    if (value === 'claude') {
      if (!claudeKey) throw fail(409, '이 서버에는 Claude(Anthropic) API 키가 설정되어 있지 않습니다.');
      return 'claude';
    }
    const provider = value === 'gemma' ? 'gemma' : 'deepseek';
    if (provider === 'gemma' && !(await llm.gemmaStatus(true)).available) {
      throw fail(409, 'Gemma(PC)가 꺼져 있어 사용할 수 없습니다. DeepSeek을 선택하거나 PC를 켠 뒤 다시 시도해 주세요.');
    }
    return provider;
  };

  route('POST', /^\/api\/login$/, async (req, res) => {
    const ip = req.headers['x-real-ip'] || req.socket.remoteAddress;
    const recent = (attempts.get(ip) || []).filter((t) => t > Date.now() - 10 * 60000);
    if (recent.length >= 10) throw fail(429, '로그인 시도가 너무 많습니다. 10분 뒤 다시 시도해 주세요.');
    const { code } = await readBody(req, 4096);
    const given = Buffer.from(String(code || '').trim());
    const expected = Buffer.from(accessCode);
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
      attempts.set(ip, [...recent, Date.now()]);
      throw fail(401, '접속 코드가 맞지 않습니다.');
    }
    const token = crypto.randomBytes(32).toString('base64url');
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    for (const [k, v] of Object.entries(sessions)) if (v.expires < Date.now()) delete sessions[k];
    sessions[hash] = { created: Date.now(), expires: Date.now() + SESSION_DAYS * 86400000 };
    saveSessions();
    const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
    res.setHeader('Set-Cookie', `${cookieName}=${token}; Path=${cfg.cookiePath}; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure}`);
    return { ok: true };
  }, { open: true });

  route('POST', /^\/api\/logout$/, (req, res) => {
    const hash = sessionOf(req);
    if (hash) { delete sessions[hash]; saveSessions(); }
    res.setHeader('Set-Cookie', `${cookieName}=; Path=${cfg.cookiePath}; HttpOnly; SameSite=Lax; Max-Age=0`);
    return { ok: true };
  });

  route('GET', /^\/api\/balance$/, async () => {
    if (cfg.llmMode === 'mock') return { available: true, balance: '모의 모드' };
    if (!apiKey) return { available: false, balance: '키 없음' };
    const r = await fetch(cfg.deepseek.baseUrl + '/user/balance', { headers: { Authorization: 'Bearer ' + apiKey }, signal: AbortSignal.timeout(8000) });
    const data = await r.json();
    const info = data.balance_infos?.[0];
    return { available: Boolean(data.is_available), balance: info ? `${info.total_balance} ${info.currency}` : '알 수 없음' };
  });

  // materials
  route('GET', /^\/api\/materials$/, () => store.materials.all().map(materialSummary));
  route('POST', /^\/api\/materials$/, async (req) => {
    const body = await readBody(req, Math.ceil(cfg.maxUploadBytes * 1.4));
    if (!body.problemImage) throw fail(400, '문제 이미지를 넣어 주세요.');
    const provider = await chooseProvider(body.provider);
    const problem = store.files.saveDataUrl(body.problemImage);
    const sameImage = Boolean(body.sameImage);
    const solution = !sameImage && body.solutionImage ? store.files.saveDataUrl(body.solutionImage) : null;
    const views = (list) => (Array.isArray(list) ? list.slice(0, 6).map((d) => store.files.saveDataUrl(d).id) : []);
    const material = store.materials.put({
      id: newId(), createdAt: new Date().toISOString(), status: 'analyzing',
      title: String(body.title || '').trim().slice(0, 120) || '새 문제',
      titleFromUser: Boolean(String(body.title || '').trim()),
      note: String(body.note || '').trim().slice(0, 1000),
      images: {
        problem: problem.id, solution: sameImage ? problem.id : solution?.id || null, sameImage,
        views: { problem: views(body.problemViews), solution: solution ? views(body.solutionViews) : [] },
      },
    });
    const job = jobs.analyze(material, provider);
    return { material: materialSummary(material), jobId: job.id };
  });
  route('GET', /^\/api\/materials\/([a-f0-9]+)$/, (req, res, [id]) => {
    const m = getMaterial(id);
    const view = m.status === 'ready' && m.steps ? pipeline.refreshStepCountNote(m) : m;
    return { ...view, jobs: store.jobs.all().filter((j) => j.materialId === id).map(jobSummary) };
  });
  route('PUT', /^\/api\/materials\/([a-f0-9]+)$/, async (req, res, [id]) => {
    const m = getMaterial(id);
    if (m.status === 'analyzing') throw fail(409, '분석이 끝난 뒤에 수정할 수 있습니다.');
    const body = await readBody(req, 512 * 1024);
    const merged = pipeline.normalizeMaterial({ ...m, ...body, problem: { ...m.problem, ...body.problem } });
    if (!merged.steps.length) throw fail(400, 'STEP이 하나 이상 있어야 합니다.');
    // Reading RAG: a teacher's word fix of the model's transcription (물질량 → 몰질량) is remembered for later analyses.
    if (m.status === 'ready' && m.problem) recordCorrections(store, readingCorrections(m, merged), m);
    return store.materials.put(pipeline.refreshStepCountNote({ ...m, ...merged, status: 'ready', error: '', teacherEditedAt: new Date().toISOString() }));
  });
  route('DELETE', /^\/api\/materials\/([a-f0-9]+)$/, (req, res, [id]) => {
    getMaterial(id);
    if (store.jobs.all().some((j) => j.materialId === id && !FINISHED.has(j.status))) throw fail(409, '진행 중인 작업이 있어 삭제할 수 없습니다.');
    store.materials.remove(id);
    return { ok: true };
  });
  route('POST', /^\/api\/materials\/([a-f0-9]+)\/analyze$/, async (req, res, [id]) => {
    const m = getMaterial(id);
    if (m.status === 'analyzing') throw fail(409, '이미 분석 중입니다.');
    const body = await readBody(req, 8192);
    const provider = await chooseProvider(body.provider);
    store.materials.put({ ...m, status: 'analyzing', error: '', note: body.note !== undefined ? String(body.note).slice(0, 1000) : m.note });
    return { jobId: jobs.analyze(m, provider).id };
  });
  // Merges extra STEPs to match the teacher's step markers (for materials analyzed before auto-merge).
  route('POST', /^\/api\/materials\/([a-f0-9]+)\/align-steps$/, async (req, res, [id]) => {
    const m = getMaterial(id);
    if (m.status !== 'ready') throw fail(409, '분석이 끝난 자료만 정리할 수 있습니다.');
    const provider = apiKey || cfg.llmMode === 'mock' ? 'deepseek' : 'gemma';
    const budget = new Budget({ maxCalls: 2, maxTokens: 30000 });
    const proposal = await pipeline.proposeStepAlignment({ llm: { json: (args) => llm.json({ ...args, provider }) }, budget, jobId: 'align-' + id }, m);
    if (!proposal) return m;
    const saved = pipeline.refreshStepCountNote({ ...m, steps: proposal.steps, proofread: [...(m.proofread || []), `해설의 단계 표시에 맞춰 STEP을 합쳤습니다: ${proposal.summary}`] });
    return store.materials.put(saved);
  });
  route('GET', /^\/api\/files\/([a-f0-9]+)$/, (req, res, [id]) => {
    const found = store.files.find(id);
    if (!found) throw fail(404, '이미지를 찾지 못했습니다.');
    res.writeHead(200, { 'Content-Type': found.mime, 'Cache-Control': 'private, max-age=86400', ...security });
    fs.createReadStream(found.file).pipe(res);
    return undefined;
  });

  // generation
  route('POST', /^\/api\/generations$/, async (req) => {
    const body = await readBody(req, 64 * 1024);
    const material = getMaterial(body.materialId);
    if (material.status !== 'ready') throw fail(409, '분석이 끝난 자료만 생성할 수 있습니다.');
    const stages = normalizeStages(body.stages, material.steps.length);
    const items = buildItems(stages, material.steps.length, body.perStage);
    const mode = body.mode === 'integrated' ? 'integrated' : 'numeric';
    const effort = ['low', 'high'].includes(body.effort) ? body.effort : 'low';
    const provider = await chooseProvider(body.provider);
    const rules = pipeline.pickRules(store, material);
    const { images, ...snapshot } = material;
    const job = jobs.generate({ material: { ...snapshot, images }, items, rules, options: { mode, effort, provider, perStage: items.length / stages.length } });
    return { jobId: job.id };
  });
  route('GET', /^\/api\/jobs$/, (req) => {
    const url = new URL(req.url, 'http://x');
    const materialId = url.searchParams.get('materialId');
    return store.jobs.all().filter((j) => (!materialId || j.materialId === materialId) && (j.type !== 'analyze' || url.searchParams.get('all'))).slice(0, 100).map(jobSummary);
  });
  route('GET', /^\/api\/jobs\/([a-f0-9]+)$/, (req, res, [id]) => getJob(id));
  route('POST', /^\/api\/jobs\/([a-f0-9]+)\/cancel$/, (req, res, [id]) => { getJob(id); return { cancelled: jobs.cancel(id) }; });
  route('POST', /^\/api\/jobs\/([a-f0-9]+)\/resume$/, (req, res, [id]) => ({ jobId: jobs.resume(getJob(id)).id }));
  route('DELETE', /^\/api\/jobs\/([a-f0-9]+)$/, (req, res, [id]) => {
    const job = getJob(id);
    if (!FINISHED.has(job.status)) throw fail(409, '진행 중인 작업은 먼저 취소해 주세요.');
    store.jobs.remove(id);
    return { ok: true };
  });
  route('POST', /^\/api\/jobs\/([a-f0-9]+)\/items\/(\d+)\/regenerate$/, async (req, res, [id, index]) => {
    const parent = getJob(id);
    if (parent.type !== 'generate' || !parent.items[Number(index)]) throw fail(404, '문제를 찾지 못했습니다.');
    const body = await readBody(req, 16 * 1024);
    const feedback = String(body.feedback || '').trim().slice(0, 2000);
    return { jobId: jobs.regenerate(parent, Number(index), feedback).id };
  });

  // learning rules
  route('GET', /^\/api\/rules$/, () => store.rules.all());
  route('POST', /^\/api\/rules$/, async (req) => {
    const body = await readBody(req, 16 * 1024);
    let source = body.source;
    if (source?.jobId && isId(source.jobId)) {
      const job = store.jobs.get(source.jobId);
      const item = job?.items?.[source.itemIndex];
      if (job) source = { ...source, materialId: job.materialId, label: `${job.title} · ${item?.label || ''}`, excerpt: (item?.problem?.text || job.material?.problem?.text || '').slice(0, 600) };
      if (job && !body.subject) { body.subject = job.material?.subject; body.topic = job.material?.topic; }
    }
    return store.rules.put(makeRule({ ...body, source }));
  });
  route('PUT', /^\/api\/rules\/([a-f0-9]+)$/, async (req, res, [id]) => {
    const rule = store.rules.get(id) || (() => { throw fail(404, '지침을 찾지 못했습니다.'); })();
    return store.rules.put(updateRule(rule, await readBody(req, 16 * 1024)));
  });
  route('DELETE', /^\/api\/rules\/([a-f0-9]+)$/, (req, res, [id]) => ({ ok: store.rules.remove(id) }));
  // 학습 page: the exact text the stored knowledge adds to a model call (rules for every problem, reading hints).
  route('GET', /^\/api\/learning\/preview$/, () => {
    const global = store.rules.all().filter((r) => r.status === 'approved' && r.scope === 'global')
      .map((r) => ({ id: r.id, text: r.text, kind: r.kind, target: r.target, scope: r.scope }));
    return { rules: prompts.rulesBlock(global).trim(), reading: readingHint(store.corrections.all()) };
  });
  route('GET', /^\/api\/corrections$/, () => store.corrections.all().sort((a, b) => b.count - a.count));
  route('DELETE', /^\/api\/corrections\/([a-f0-9]+)$/, (req, res, [id]) => ({ ok: store.corrections.remove(id) }));

  route('GET', /^\/api\/prompts$/, () => ({ version: prompts.PROMPT_VERSION, ...prompts.SYSTEMS }));
  // The 시스템 page: the three core parts (prompts, harness, retrieval) with live data, plus usage per model.
  const PROMPT_PURPOSE = {
    analyze: '원본 문제·해설 이미지를 옮겨 적고 교사 풀이를 STEP으로 정리', proofread: '옮겨 적은 내용을 이미지와 글자 단위로 대조',
    'reread-question': '발문만 다시 읽기 (2회)', 'reread-problem': '필기 유입이 의심될 때 인쇄 글자만 다시 읽기',
    'reread-headings': '해설의 단계 제목만 다시 읽기 (2회)', regroup: 'STEP을 해설 단계 수에 맞게 묶기',
    'fix-verification': '실행되지 않는 원본 검산 프로그램 고치기', generate: '단계별 변형 문제 설계',
    solve: '정답을 모르는 독립 풀이 검토', repair: '검토에서 나온 문제를 고쳐 다시 설계',
  };
  function evalReports(limit = 4) {
    const dir = path.join(cfg.root, 'eval', 'reports');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort().reverse().slice(0, limit).map((f) => {
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        const results = Array.isArray(raw) ? raw : raw.results || [];
        const score = (list) => (list?.length ? { pass: list.filter((c) => c.pass).length, total: list.length } : null);
        return {
          file: f, stamp: raw.stamp || f.slice(0, 15), stage: raw.stage || results[0]?.stage || '', promptVersion: raw.promptVersion || '', learning: raw.learning || null,
          rows: results.map((r) => ({ case: r.case, provider: r.provider, analysis: score(r.analysis), generation: score(r.generation), minutes: r.minutes, error: r.error || '',
            failed: [...(r.analysis || []), ...(r.generation || [])].filter((c) => !c.pass)
              .map((c) => (c.detail ? `${c.name} — ${String(c.detail).replace(/\s+/g, ' ').slice(0, 140)}` : c.name)).slice(0, 12) })),
        };
      } catch { return null; }
    }).filter(Boolean);
  }
  // Cost per problem from real DeepSeek runs of the eval set: tokens of a whole generation job (design, blind
  // solve, repairs) divided by the problems it produced; the analysis of one original counted separately.
  // Opus is priced on the same token amounts (the relay run records no token counts).
  function costEstimate(onlyCase) {
    const dir = path.join(cfg.root, 'eval', 'reports');
    const perCase = [];
    const analyses = [];
    if (fs.existsSync(dir)) {
      for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
        let raw; try { raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
        for (const r of Array.isArray(raw) ? raw : raw.results || []) {
          if (r.provider !== 'deepseek' || (onlyCase && r.case !== onlyCase)) continue;
          if (r.analysisUsage?.calls) analyses.push(r.analysisUsage);
          const made = (r.generation || []).filter((c) => /: 문제 생성$/.test(c.name) && c.pass).length;
          if (r.generationUsage?.calls && made) perCase.push({ case: r.case, input: r.generationUsage.input / made, output: r.generationUsage.output / made });
        }
      }
    }
    const price = (u, p) => (u.input * cfg.pricing[p].input + u.output * cfg.pricing[p].output) / 1e6;
    const avg = (list) => (list.length ? { input: list.reduce((a, x) => a + x.input, 0) / list.length, output: list.reduce((a, x) => a + x.output, 0) / list.length } : null);
    const problem = avg(perCase);
    const analysis = avg(analyses);
    const both = (u) => (u ? { deepseek: price(u, 'deepseek'), opus: price(u, 'opus') } : null);
    return {
      pricing: cfg.pricing,
      basis: { problems: perCase.length, analyses: analyses.length },
      perProblem: both(problem),
      perProblemRange: perCase.length ? { deepseek: [Math.min(...perCase.map((u) => price(u, 'deepseek'))), Math.max(...perCase.map((u) => price(u, 'deepseek')))], opus: [Math.min(...perCase.map((u) => price(u, 'opus'))), Math.max(...perCase.map((u) => price(u, 'opus')))] } : null,
      perAnalysis: both(analysis),
      tokens: { problem, analysis },
    };
  }
  // Model comparison for teachers: the newest full eval of each model, grouped into what a teacher cares about.
  const QUALITY = [
    ['made', '문제를 끝까지 만들어 냄', (n) => /: 문제 생성$/.test(n)],
    ['correct', '계산과 정답이 맞음', (n) => /: (코드 검산|독립 풀이 정답 일치)$/.test(n)],
    ['clean', '쓸모없는 조건이 없음', (n) => /: 모든 조건이 풀이에 쓰임$/.test(n)],
    ['range', '목표한 STEP만으로 풀림', (n) => /: 목표 STEP 범위로 풀림$/.test(n)],
    ['method', '선생님 풀이 방법 유지', (n) => /: 교사 풀이 방법 보존$/.test(n)],
    ['structural', '최종 문제를 새 구조로 설계', (n) => /구조 변형/.test(n)],
    ['clear', '교사 검토 없이 바로 쓸 수 있음', (n) => /: 교사 검토 필요 없음$/.test(n)],
  ];
  // Every full run of a model counts (one run swings by ±4 of 29 checks). The PC provider is split by the local
  // model each run used; `only` limits the models shown (the comparison page leaves out rejected candidates).
  function modelComparison(onlyCase, only) {
    const dir = path.join(cfg.root, 'eval', 'reports');
    const runs = {};
    if (fs.existsSync(dir)) {
      for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
        let raw; try { raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
        const results = (Array.isArray(raw) ? raw : raw.results || []).filter((r) => !onlyCase || r.case === onlyCase);
        if (!results.length || (raw.stage || results[0]?.stage) !== 'full') continue;
        for (const r of results) {
          if (!(r.generation || []).length) continue; // stopped before making anything
          const key = r.provider === 'gemma' ? pcModelKey(r.model) : r.provider;
          if (only && !only.includes(key)) continue;
          (runs[key] = runs[key] || []).push({ ...r, when: raw.stamp || f.slice(0, 15) });
        }
      }
    }
    const tally = (pred, list) => { const hit = list.filter((c) => pred(c.name)); return { pass: hit.filter((c) => c.pass).length, total: hit.length }; };
    const out = {};
    for (const [key, rows] of Object.entries(runs)) {
      const gen = rows.flatMap((r) => r.generation || []);
      const pc = rows[0].provider === 'gemma';
      out[key] = {
        when: rows[rows.length - 1].when, runs: rows.length, pc,
        label: pc ? pcModelLabel(rows[rows.length - 1].model || 'gemma-4-12b').replace(' (PC)', '') : undefined,
        read: tally(() => true, rows.flatMap((r) => r.analysis || [])),
        overall: tally(() => true, gen),
        metrics: Object.fromEntries(QUALITY.map(([id, , pred]) => [id, tally(pred, gen)])),
        minutes: Math.round(rows.reduce((a, r) => a + (r.minutes || 0), 0) / rows.length),
      };
    }
    return { metrics: QUALITY.map(([id, label]) => ({ id, label })), models: out };
  }
  const COMPARED = ['relay', 'deepseek', 'qwen36', 'gemma12'];
  // 모델 비교 page: the same original made into problems by each model (files built by eval/compare-bundle.js).
  const compareDir = path.join(cfg.root, 'eval', 'compare');
  route('GET', /^\/api\/compare$/, () => (fs.existsSync(compareDir) ? fs.readdirSync(compareDir).filter((f) => f.endsWith('.json') && !f.endsWith('.feedback.json')).map((f) => {
    const b = JSON.parse(fs.readFileSync(path.join(compareDir, f), 'utf8'));
    return { id: b.id, title: b.title, models: b.models.map((m) => ({ key: m.key, label: m.label, score: m.score?.make || null })) };
  }) : []));
  const PDF_NAME = { relay: 'Claude_Opus_5.5', deepseek: 'DeepSeek_V4_Flash', qwen36: 'Qwen_3.6-35B', gemma12: 'Gemma_4_12B' };
  route('GET', /^\/api\/compare\/([a-z0-9-]+)\/pdf\/(relay|deepseek|qwen36|gemma12)$/, (req, res, [id, key]) => {
    const file = path.join(compareDir, id, `${key}.pdf`);
    if (!fs.existsSync(file)) throw fail(404, 'PDF를 찾지 못했습니다.');
    const name = `${id}_${PDF_NAME[key]}.pdf`;
    res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${name}"`, 'Content-Length': fs.statSync(file).size, ...security });
    fs.createReadStream(file).pipe(res);
    return undefined;
  });
  route('GET', /^\/api\/compare\/([a-z0-9-]+)$/, (req, res, [id]) => {
    const file = path.join(compareDir, `${id}.json`);
    if (!fs.existsSync(file)) throw fail(404, '비교 자료를 찾지 못했습니다.');
    const bundle = JSON.parse(fs.readFileSync(file, 'utf8'));
    // How each model met the teacher's written feedback (a reviewed judgement kept next to the bundle).
    const feedback = path.join(compareDir, `${id}.feedback.json`);
    if (fs.existsSync(feedback)) bundle.feedback = JSON.parse(fs.readFileSync(feedback, 'utf8'));
    // Quality and cost of each model on this case alone.
    bundle.overview = { compare: modelComparison(id, COMPARED), cost: costEstimate(id) };
    // Opus cost from what its run actually exchanged: 0.6–1.0 token per character (Korean + LaTeX), reasoning
    // tokens not measured so 0–2× the written answer, 1,000–1,600 tokens per image. A range, not one number.
    const rm = bundle.relayMeasure;
    const cost = bundle.overview.cost;
    if (rm && cost.pricing) {
      const pr = cost.pricing.opus;
      const usd = (inTok, outTok) => (inTok * pr.input + outTok * pr.output) / 1e6;
      const gen = rm.generation; const an = rm.analysis;
      const problem = [usd(gen.inChars * 0.6, gen.outChars * 0.6) / rm.problems, usd(gen.inChars, gen.outChars * 3) / rm.problems];
      const analysis = [usd(an.inChars * 0.6 + an.images * 1000, an.outChars * 0.6), usd(an.inChars + an.images * 1600, an.outChars * 3)];
      cost.opusRange = { problem, analysis, set: [analysis[0] + problem[0] * 3, analysis[1] + problem[1] * 3] };
      if (cost.perProblem) cost.perProblem.opus = (problem[0] + problem[1]) / 2;
    }
    // Where the final problem was compared by hand, that verdict replaces the automatic "structural" check
    // (the automatic one passed DeepSeek's final, which only changed numbers).
    // It judges one problem set, so it stands in only for a model evaluated once.
    for (const [key, m] of Object.entries(bundle.overview.compare.models)) {
      const verdict = bundle.feedback?.models?.[key]?.final?.[0];
      if (m.runs !== 1) continue;
      const auto = m.metrics.structural;
      if (!verdict || !auto?.total) continue;
      const pass = verdict === 'ok' ? auto.total : 0;
      m.overall = { pass: m.overall.pass - auto.pass + pass, total: m.overall.total };
      m.metrics.structural = { pass, total: auto.total, reviewed: true };
    }
    return bundle;
  });
  route('GET', /^\/api\/system$/, () => {
    const rules = store.rules.all();
    const corrections = store.corrections.all().sort((a, b) => b.count - a.count);
    const byProvider = {};
    for (const r of store.usage.all()) {
      const k = r.provider || 'deepseek';
      const a = byProvider[k] || (byProvider[k] = { calls: 0, input: 0, output: 0, reasoning: 0, total: 0 });
      a.calls++; a.input += r.input || 0; a.output += r.output || 0; a.reasoning += r.reasoning || 0; a.total += r.total || 0;
    }
    return {
      prompts: { version: prompts.PROMPT_VERSION, list: Object.entries(prompts.SYSTEMS).map(([id, text]) => ({ id, purpose: PROMPT_PURPOSE[id] || '', chars: text.length })) },
      checks: pipeline.SYSTEM_CHECKS,
      rag: {
        rules: { approved: rules.filter((r) => r.status === 'approved').length, pending: rules.filter((r) => r.status === 'pending').length,
          global: rules.filter((r) => r.status === 'approved' && r.scope === 'global').length, topic: rules.filter((r) => r.status === 'approved' && r.scope === 'topic').length,
          applied: rules.reduce((a, r) => a + (r.applied || 0), 0) },
        corrections: { count: corrections.length, top: corrections.slice(0, 5).map((c) => ({ wrong: c.wrong, right: c.right, count: c.count })) },
        confusable: harness.CONFUSABLE,
      },
      budget: cfg.budget,
      usage: byProvider,
      evals: evalReports(),
      cost: costEstimate(),
      compare: modelComparison(),
    };
  });
  route('GET', /^\/api\/usage$/, () => {
    const rows = store.usage.all();
    // paidInput/paidOutput exclude Gemma, which runs free on the teacher's PC.
    const sum = (list) => list.reduce((a, r) => {
      const paid = r.provider !== 'gemma';
      return { calls: a.calls + 1, input: a.input + (r.input || 0), output: a.output + (r.output || 0), total: a.total + (r.total || 0),
        paidInput: a.paidInput + (paid ? r.input || 0 : 0), paidOutput: a.paidOutput + (paid ? r.output || 0 : 0) };
    }, { calls: 0, input: 0, output: 0, total: 0, paidInput: 0, paidOutput: 0 });
    const day = new Date(Date.now() - 86400000).toISOString();
    return { all: sum(rows), last24h: sum(rows.filter((r) => r.createdAt > day)), recent: rows.slice(0, 50) };
  });

  // ------------------------------------------------------------ static
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.json': 'application/json' };
  const katexDir = path.join(cfg.root, 'node_modules', 'katex', 'dist');
  function serveStatic(req, res, pathname) {
    let base = cfg.publicDir; let rel = pathname;
    if (pathname.startsWith('/vendor/katex/')) { base = katexDir; rel = pathname.slice('/vendor/katex'.length); }
    if (rel === '/' || rel === '') rel = '/index.html';
    const file = path.normalize(path.join(base, decodeURIComponent(rel)));
    if (!file.startsWith(base + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...security }); res.end('Not found'); return;
    }
    const ext = path.extname(file);
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream', 'Cache-Control': ext === '.html' ? 'no-cache' : base === katexDir ? 'public, max-age=604800' : 'no-cache', ...security });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  }

  async function handle(req, res) {
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch { res.writeHead(400).end(); return; }
    if (!url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
      return serveStatic(req, res, url.pathname);
    }
    try {
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const match = r.pattern.exec(url.pathname);
        if (!match) continue;
        if (!r.open && !sessionOf(req)) throw fail(401, '로그인이 필요합니다.');
        if (req.method !== 'GET' && !r.open) {
          // Same-origin check for state-changing requests (cookie auth).
          const origin = req.headers.origin;
          if (origin && req.headers.host && new URL(origin).host !== (req.headers['x-forwarded-host'] || req.headers.host)) throw fail(403, '다른 사이트에서 온 요청은 받을 수 없습니다.');
        }
        const result = await r.handler(req, res, match.slice(1));
        if (result !== undefined && !res.headersSent) send(res, 200, result);
        return;
      }
      throw fail(404, '없는 API입니다.');
    } catch (e) {
      if (e.name === 'LlmFormatError') Object.assign(e, { status: 502, message: 'AI 응답 형식을 읽지 못했습니다. 잠시 후 다시 시도해 주세요.' });
      const status = e.status || 500;
      if (status >= 500) console.error(req.method, url.pathname, e);
      if (!res.headersSent) send(res, status, { error: status >= 500 && !e.status ? '서버 오류가 발생했습니다: ' + e.message : e.message });
      else res.destroy();
    }
  }

  const server = http.createServer((req, res) => { handle(req, res); });
  server.requestTimeout = 120000;
  return { server, store, jobs, config: cfg };
}

if (require.main === module) {
  const { server, config: cfg } = createApp();
  server.listen(cfg.port, cfg.host, () => console.log(`EduMaster v2 listening on http://${cfg.host}:${cfg.port} (llm=${cfg.llmMode}, data=${cfg.dataDir})`));
}

module.exports = { createApp };
