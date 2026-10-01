'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const config = require('./config');
const { openStore, newId, isId } = require('./store');
const { createLlm, PROVIDERS, Budget, pcModelLabel, pcModelKey, claudeCliReady, claudeLimits, claudeCliChoice, llmSettings, saveLlmSettings, CLAUDE_MODELS, CLAUDE_EFFORTS, PROMPT_STAGES } = require('./llm');
const { REVIEW_VERSION, DIMENSIONS, problemResults, problemScore, wilson, timeSummary } = require('./scoring');
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
  let apiKey = readSecret(path.join(cfg.dataDir, 'deepseek-api-key.txt'));
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
  // The question sentence of a problem (its last line that is not a table row), to tell variants apart in lists.
  const questionLine = (text) => String(text || '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('|')).pop()?.slice(0, 160) || '';
  const materialSummary = (m, rules = store.rules.all()) => ({ id: m.id, title: m.title, subject: m.subject, topic: m.topic, status: m.status, createdAt: m.createdAt, stepCount: m.steps?.length || 0, solutionSource: m.solutionSource, images: m.images, error: m.error,
    feedbackCount: rules.filter((r) => r.scope === 'material' && r.status === 'approved' && r.source?.materialId === m.id).length });
  const jobSummary = (j) => ({
    id: j.id, type: j.type, status: j.status, title: j.title, materialId: j.materialId, createdAt: j.createdAt, finishedAt: j.finishedAt, error: j.error, usage: j.usage, options: j.options,
    parentJobId: j.parentJobId, itemIndex: j.itemIndex, modelLabel: j.modelLabel,
    items: (j.items || []).map((i) => ({ index: i.index, label: i.label, status: i.status, adopted: Boolean(i.adopted), preview: questionLine(i.problem?.text) })),
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
        ...(claudeCliReady(cfg) ? { 'claude-cli': { label: claudeCliChoice(cfg).label, effort: claudeCliChoice(cfg).effort, available: true, note: '서버의 Claude 구독으로 실행 · 추가 비용 없음 · 품질 가장 높음 · 느릴 수 있음' } } : {}),
        ...(cfg.relay.dir ? { relay: { label: cfg.relay.label, available: true, note: '요청마다 외부 에이전트가 응답 (비교 실험용)' } } : {}),
      },
      activeJobs: jobs.activeCount(),
      defaultProvider: defaultProvider(),
    };
  }, { open: true });

  // Picks the provider for a new job and refuses Gemma while the PC is off.
  const DEFAULTABLE = ['deepseek', 'claude-cli', 'gemma'];
  const defaultProvider = () => {
    const p = llmSettings(cfg.dataDir).defaultProvider;
    return DEFAULTABLE.includes(p) ? p : 'deepseek';
  };
  const chooseProvider = async (value) => {
    // No model named: the 기본 모델 chosen on the LLM tab, if it can be used right now; otherwise DeepSeek.
    if (!value) {
      const preferred = defaultProvider();
      if (preferred === 'claude-cli' && claudeCliReady(cfg)) return 'claude-cli';
      if (preferred === 'gemma' && (await llm.gemmaStatus()).available) return 'gemma';
      value = 'deepseek';
    }
    if (value === 'relay') {
      if (!cfg.relay.dir) throw fail(409, '이 서버에는 중계 모델이 설정되어 있지 않습니다.');
      return 'relay';
    }
    if (value === 'claude-cli') {
      if (!claudeCliReady(cfg)) throw fail(409, '이 서버의 Claude Code에 로그인되어 있지 않습니다. 서버에서 claude를 실행해 한 번 로그인해 주세요.');
      return 'claude-cli';
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
  // LLM tab: what each model has used, from the call ledger — today (server time) and over the last 30 days, with
  // the list-price cost where the model has one (the subscription and PC models cost nothing per call).
  route('GET', /^\/api\/llm$/, () => {
    const { callCost } = require('./cost');
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const since30 = Date.now() - 30 * 86400000;
    const rows = store.usage.all().filter((r) => r.outcome && r.outcome !== 'started');
    const sum = (list) => {
      const t = list.reduce((acc, r) => { acc.calls++; acc.input += r.input || 0; acc.output += r.output || 0; acc.usd += callCost(r) || 0; acc.errors += r.outcome === 'error' ? 1 : 0; return acc; }, { calls: 0, input: 0, output: 0, usd: 0, errors: 0 });
      return { ...t, usd: Math.round(t.usd * 1000) / 1000 };
    };
    const usage = {};
    const month = new Date(); month.setDate(1); month.setHours(0, 0, 0, 0);
    const sets = store.jobs.all().filter((j) => j.type === 'generate' && new Date(j.createdAt) >= month);
    for (const p of ['deepseek', 'gemma', 'claude-cli', 'claude']) {
      const mine = rows.filter((r) => r.provider === p);
      const at = (r) => new Date(r.createdAt).getTime();
      usage[p] = {
        today: sum(mine.filter((r) => at(r) >= start.getTime())), days30: sum(mine.filter((r) => at(r) >= since30)),
        month: { ...sum(mine.filter((r) => at(r) >= month.getTime())), sets: sets.filter((j) => (j.options?.provider || 'deepseek') === p).length },
        lastAt: mine.map((r) => r.createdAt).sort().pop() || '',
      };
    }
    return { usage, claude: { loggedIn: claudeCliReady(cfg), ...claudeCliChoice(cfg), limits: claudeLimits(cfg), models: CLAUDE_MODELS, efforts: CLAUDE_EFFORTS }, deepseek: { key: apiKey ? '…' + apiKey.slice(-4) : '' } };
  });
  // The Claude model and effort the subscription runs (LLM tab).
  route('PUT', /^\/api\/llm\/claude$/, async (req) => {
    const body = await readBody(req, 1024);
    if (!CLAUDE_MODELS[body.model]) throw fail(400, '고를 수 없는 Claude 모델입니다.');
    if (!CLAUDE_EFFORTS.includes(body.effort)) throw fail(400, '추론 강도 값이 올바르지 않습니다.');
    saveLlmSettings(cfg.dataDir, { claude: { model: body.model, effort: body.effort } });
    return claudeCliChoice(cfg);
  });
  // 기본 모델: the model pages preselect and requests without a model use (LLM tab).
  route('PUT', /^\/api\/llm\/default$/, async (req) => {
    const body = await readBody(req, 1024);
    if (!DEFAULTABLE.includes(body.provider)) throw fail(400, '기본 모델로 고를 수 없는 모델입니다.');
    saveLlmSettings(cfg.dataDir, { defaultProvider: body.provider });
    return { defaultProvider: defaultProvider() };
  });
  // Replacing the DeepSeek key from the LLM tab: the new key is tried on DeepSeek's balance endpoint first and kept
  // (data/, mode 600) only if DeepSeek accepts it. The key is never sent back, only its last 4 characters.
  route('PUT', /^\/api\/llm\/deepseek-key$/, async (req) => {
    const body = await readBody(req, 4096);
    const key = String(body.key || '').trim();
    if (!/^sk-[A-Za-z0-9]{16,}$/.test(key)) throw fail(400, 'DeepSeek API 키 형식이 아닙니다 (sk-로 시작).');
    let r;
    try { r = await fetch(cfg.deepseek.baseUrl + '/user/balance', { headers: { Authorization: 'Bearer ' + key }, signal: AbortSignal.timeout(10000) }); }
    catch { throw fail(502, 'DeepSeek에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.'); }
    if (r.status === 401) throw fail(400, 'DeepSeek이 이 키를 받지 않습니다. 키를 다시 확인해 주세요.');
    if (!r.ok) throw fail(502, `DeepSeek 확인 오류 (${r.status})`);
    const file = path.join(cfg.dataDir, 'deepseek-api-key.txt');
    fs.writeFileSync(file, key + '\n', { mode: 0o600 });
    fs.chmodSync(file, 0o600);
    apiKey = key;
    llm.setApiKey(key);
    return { key: '…' + key.slice(-4) };
  });

  // materials
  route('GET', /^\/api\/materials$/, () => { const rules = store.rules.all(); return store.materials.all().map((m) => materialSummary(m, rules)); });
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
  // 학습 현황 of one original: set by set, how many variants were made, passed the checks and were adopted, and how
  // the feedback fared; and for each feedback, on how many variants made after it was checked, kept or broken.
  route('GET', /^\/api\/materials\/([a-f0-9]+)\/learning$/, (req, res, [id]) => {
    getMaterial(id);
    const sets = store.jobs.all().filter((j) => j.type === 'generate' && j.materialId === id).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const rules = store.rules.all().filter((r) => r.scope === 'material' && r.source?.materialId === id);
    const judged = (list) => ({ kept: list.filter((r) => r.judged?.ok).length, broken: list.filter((r) => r.judged && !r.judged.ok).length });
    return {
      sets: sets.map((j, i) => {
        const made = (j.items || []).filter((it) => it.problem);
        return {
          id: j.id, no: i + 1, createdAt: j.createdAt, model: j.modelLabel || PROVIDERS[j.options?.provider]?.label || 'DeepSeek', status: j.status,
          items: (j.items || []).length, made: made.length, adopted: made.filter((it) => it.adopted).length,
          passed: made.filter((it) => ['passed', 'warning'].includes(it.status)).length,
          feedbackBefore: rules.filter((r) => r.status === 'approved' && r.createdAt < j.createdAt).length,
          examples: made.reduce((n, it) => n + (it.examplesUsed || 0), 0),
          ...judged(made.flatMap((it) => it.verification?.rules || [])),
        };
      }),
      feedback: rules.map((r) => {
        const uses = sets.flatMap((j) => j.items || []).flatMap((it) => (it.verification?.rules || []).filter((x) => x.id === r.id));
        return { id: r.id, text: r.text, target: r.target, status: r.status, createdAt: r.createdAt, used: uses.length, ...judged(uses) };
      }),
      adopted: sets.flatMap((j) => j.items || []).filter((it) => it.adopted && it.problem).length,
    };
  });
  route('PUT', /^\/api\/materials\/([a-f0-9]+)$/, async (req, res, [id]) => {
    const m = getMaterial(id);
    if (m.status === 'analyzing') throw fail(409, '분석이 끝난 뒤에 수정할 수 있습니다.');
    const body = await readBody(req, 512 * 1024);
    const merged = pipeline.normalizeMaterial({ ...m, ...body, problem: { ...m.problem, ...body.problem } });
    if (!merged.steps.length) throw fail(400, 'STEP이 하나 이상 있어야 합니다.');
    // Reading RAG: a teacher's word fix of the model's transcription (물질량 → 몰질량) is remembered for later analyses.
    if (m.status === 'ready' && m.problem) recordCorrections(store, readingCorrections(m, merged), m);
    // A title the teacher changed is theirs from then on: a later analysis does not rename the problem.
    const titleFromUser = m.titleFromUser || (body.title !== undefined && merged.title !== m.title);
    return store.materials.put(pipeline.refreshStepCountNote({ ...m, ...merged, titleFromUser, status: 'ready', error: '', teacherEditedAt: new Date().toISOString() }));
  });
  // The name of the problem (title, subject, topic), changed from the problem page's head without touching the analysis.
  route('PUT', /^\/api\/materials\/([a-f0-9]+)\/name$/, async (req, res, [id]) => {
    const m = getMaterial(id);
    const body = await readBody(req, 8192);
    const title = String(body.title ?? m.title).trim().slice(0, 120);
    if (!title) throw fail(400, '제목을 입력해 주세요.');
    return store.materials.put({ ...m, title, subject: String(body.subject ?? m.subject ?? '').trim().slice(0, 40), topic: String(body.topic ?? m.topic ?? '').trim().slice(0, 120), titleFromUser: m.titleFromUser || title !== m.title });
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
    // Feedback on the reading ("STEP 3 제목은 …", "표 Ⅲ의 B는 필기") accumulates on the problem; every later
    // analysis of it gets all of it.
    const feedback = String(body.feedback || '').trim().slice(0, 1000);
    const analysisFeedback = [...(m.analysisFeedback || []), ...(feedback ? [{ text: feedback, at: new Date().toISOString() }] : [])].slice(-20);
    store.materials.put({ ...m, status: 'analyzing', error: '', analysisFeedback, note: body.note !== undefined ? String(body.note).slice(0, 1000) : m.note });
    return { jobId: jobs.analyze(m, provider).id };
  });
  // Analysis feedback is also added and edited on its own (the problem's feedback list); it is used at the next analysis.
  const analysisNote = (body) => {
    const text = String(body.text || '').trim().slice(0, 1000);
    if (text.length < 2) throw fail(400, '피드백 내용을 입력해 주세요.');
    return text;
  };
  route('POST', /^\/api\/materials\/([a-f0-9]+)\/analysis-feedback$/, async (req, res, [id]) => {
    const m = getMaterial(id);
    const text = analysisNote(await readBody(req, 8192));
    return store.materials.put({ ...m, analysisFeedback: [...(m.analysisFeedback || []), { text, at: new Date().toISOString() }].slice(-20) });
  });
  route('PUT', /^\/api\/materials\/([a-f0-9]+)\/analysis-feedback\/(\d+)$/, async (req, res, [id, index]) => {
    const m = getMaterial(id);
    const list = [...(m.analysisFeedback || [])];
    if (!list[Number(index)]) throw fail(404, '피드백을 찾지 못했습니다.');
    list[Number(index)] = { ...list[Number(index)], text: analysisNote(await readBody(req, 8192)) };
    return store.materials.put({ ...m, analysisFeedback: list });
  });
  route('DELETE', /^\/api\/materials\/([a-f0-9]+)\/analysis-feedback\/(\d+)$/, (req, res, [id, index]) => {
    const m = getMaterial(id);
    const analysisFeedback = (m.analysisFeedback || []).filter((_, i) => i !== Number(index));
    return store.materials.put({ ...m, analysisFeedback });
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
    // Mixed run: another model writes the problems (designWith: design + repairs) or only the repairs (repairWith);
    // the chosen provider does the rest (independent solve, solution review, checks).
    const other = async (name) => (name && name !== provider ? chooseProvider(name) : undefined);
    const designWith = await other(body.designWith);
    const repairWith = designWith || (await other(body.repairWith));
    // lean: the design model writes only an outline and the chosen provider writes the solution out (pipeline).
    const lean = Boolean(body.lean && designWith) || undefined;
    const rules = pipeline.pickRules(store, material);
    const { images, ...snapshot } = material;
    const job = jobs.generate({ material: { ...snapshot, images }, items, rules, options: { mode, effort, provider, designWith, repairWith, lean, perStage: items.length / stages.length } });
    return { jobId: job.id };
  });
  route('GET', /^\/api\/jobs$/, (req) => {
    const url = new URL(req.url, 'http://x');
    const materialId = url.searchParams.get('materialId');
    return store.jobs.all().filter((j) => (!materialId || j.materialId === materialId) && (j.type !== 'analyze' || url.searchParams.get('all'))).slice(0, 100).map(jobSummary);
  });
  // The problem's name as it is now (it may have been renamed since the set was made).
  route('GET', /^\/api\/jobs\/([a-f0-9]+)$/, (req, res, [id]) => { const job = getJob(id); return { ...job, materialTitle: store.materials.get(job.materialId)?.title || job.title }; });
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
  // The teacher's verdict on one variant: 채택 (a good problem — it goes on the worksheet and is kept as an example
  // for this original), or not. A regenerated problem starts unreviewed again.
  route('PUT', /^\/api\/jobs\/([a-f0-9]+)\/items\/(\d+)\/review$/, async (req, res, [id, index]) => {
    const job = getJob(id);
    const item = job.items?.[Number(index)];
    if (job.type !== 'generate' || !item?.problem) throw fail(404, '문제를 찾지 못했습니다.');
    const body = await readBody(req, 1024);
    item.adopted = body.adopted === true;
    item.reviewedAt = new Date().toISOString();
    store.jobs.put(job);
    return { adopted: item.adopted };
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
    } else if (source?.materialId && isId(source.materialId)) {
      // Feedback written on the problem page itself (on the original, its reading or the variants in general).
      const material = getMaterial(source.materialId);
      source = { materialId: material.id, label: material.title };
      if (!body.subject) { body.subject = material.subject; body.topic = material.topic; }
    }
    // Feedback on a problem belongs to that problem unless the teacher widens it.
    const scope = body.scope || (source?.materialId ? 'material' : 'global');
    // The same sentence on the same problem (a quick-feedback tag pressed on several variants) is one feedback:
    // it is switched back on instead of being stored twice.
    const same = scope === 'material' && store.rules.all().find((r) => r.scope === 'material' && r.source?.materialId === source?.materialId && r.text.trim() === String(body.text || '').trim());
    if (same) return store.rules.put(updateRule(same, { status: 'approved' }));
    return store.rules.put(makeRule({ ...body, scope, source }));
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
  // Claude subscription login for the CLI provider, from the LLM tab (no SSH session needed): the server runs
  // deploy/claude-login.py, which runs `claude setup-token` in a pseudo-terminal (it needs one; `claude auth login`
  // only waits for a browser callback to the server itself), shows the sign-in link, takes the code the teacher
  // pastes after signing in, and saves the long-lived token in data/ (mode 600). The code and the token are never
  // logged or sent back. One login at a time, given up after 10 minutes.
  let claudeLogin = null;
  let lastLoginResult = null;
  route('GET', /^\/api\/claude-login$/, () => ({
    loggedIn: claudeCliReady(cfg), pending: Boolean(claudeLogin?.url), url: claudeLogin?.url || '',
    checking: Boolean(claudeLogin?.codeSent && !claudeLogin.result), result: lastLoginResult,
  }));
  route('POST', /^\/api\/claude-login\/start$/, async () => {
    if (claudeLogin?.url && !claudeLogin.done) return { url: claudeLogin.url };
    const { spawn } = require('node:child_process');
    const child = spawn('python3', [path.join(cfg.root, 'deploy', 'claude-login.py'), path.join(cfg.dataDir, 'claude-oauth-token.txt')],
      { env: { ...process.env, CLAUDE_BIN: cfg.claudeCli.bin } });
    const state = { child, url: '', done: false, result: null };
    claudeLogin = state;
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d;
      for (let i; (i = buf.indexOf('\n')) >= 0;) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        try { const msg = JSON.parse(line); if (msg.url) state.url = msg.url; if ('ok' in msg) { state.result = msg; lastLoginResult = { ...msg, at: new Date().toISOString() }; } } catch { /* not a status line */ }
      }
    });
    child.on('close', () => { state.done = true; if (!state.result) state.result = { ok: false, error: '로그인 과정이 끝났습니다.' }; if (claudeLogin === state) claudeLogin = null; });
    child.on('error', () => { state.done = true; state.result = { ok: false, error: '로그인 도구를 실행하지 못했습니다.' }; });
    setTimeout(() => { if (!state.done) child.kill('SIGTERM'); }, 10 * 60 * 1000).unref();
    for (let i = 0; i < 280 && !state.url && !state.done; i++) await new Promise((r) => setTimeout(r, 250));
    if (!state.url) { child.kill('SIGTERM'); throw fail(502, state.result?.error || '로그인 링크를 받지 못했습니다.'); }
    return { url: state.url };
  });
  route('POST', /^\/api\/claude-login\/code$/, async (req) => {
    const body = await readBody(req, 4096);
    const code = String(body.code || '').trim();
    const state = claudeLogin;
    if (!state || state.done) throw fail(409, '진행 중인 로그인이 없습니다. 로그인을 다시 시작해 주세요.');
    if (!code || /\s/.test(code)) throw fail(400, '코드를 그대로 붙여 넣어 주세요.');
    if (state.codeSent) throw fail(409, '이미 코드를 확인하는 중입니다.');
    // The check takes up to a minute or so; the page asks GET /api/claude-login for the result instead of waiting here.
    state.codeSent = true;
    lastLoginResult = null;
    state.child.stdin.write(code + '\n');
    return { checking: true };
  });
  route('POST', /^\/api\/claude-login\/cancel$/, () => { claudeLogin?.child.kill('SIGTERM'); claudeLogin = null; return { ok: true }; });
  // Disconnect: the saved token is deleted (the account itself stays signed in elsewhere; the token can also be
  // revoked on claude.ai).
  route('POST', /^\/api\/claude-login\/logout$/, () => {
    fs.rmSync(path.join(cfg.dataDir, 'claude-oauth-token.txt'), { force: true });
    lastLoginResult = null;
    return { loggedIn: claudeCliReady(cfg) };
  });
  // A short real call, to see that the connection works (and which model and CLI answer), not just that a token is saved.
  route('POST', /^\/api\/claude-login\/check$/, async () => {
    if (!claudeCliReady(cfg)) throw fail(409, 'Claude 구독이 연결되어 있지 않습니다.');
    const started = Date.now();
    try {
      const { data } = await llm.json({ provider: 'claude-cli', purpose: 'solve', jobId: 'claude-check', budget: new Budget({ maxCalls: 2, maxTokens: 200000 }), effort: 'off', maxTokens: 2000,
        system: 'JSON만 출력한다.', text: '12×7의 값을 {"answer": 값} 형식으로만 답하라.' });
      return { ok: Number(data.answer) === 84, answer: data.answer, seconds: Math.round((Date.now() - started) / 100) / 10, model: claudeCliChoice(cfg).label, limits: claudeLimits(cfg) };
    } catch (e) {
      return { ok: false, error: e.message.slice(0, 300), seconds: Math.round((Date.now() - started) / 100) / 10 };
    }
  });

  route('GET', /^\/api\/corrections$/, () => store.corrections.all().sort((a, b) => b.count - a.count));
  route('DELETE', /^\/api\/corrections\/([a-f0-9]+)$/, (req, res, [id]) => ({ ok: store.corrections.remove(id) }));

  route('GET', /^\/api\/prompts$/, () => ({ version: prompts.PROMPT_VERSION, ...prompts.SYSTEMS }));
  // What each built-in instruction is for (LLM tab).
  const PROMPT_PURPOSE = {
    analyze: '원본 문제·해설 이미지를 옮겨 적고 교사 풀이를 STEP으로 정리', proofread: '옮겨 적은 내용을 이미지와 글자 단위로 대조',
    'reread-question': '발문만 다시 읽기 (2회)', 'reread-problem': '필기 유입이 의심될 때 인쇄 글자만 다시 읽기',
    'reread-headings': '해설의 단계 제목만 다시 읽기 (2회)', regroup: 'STEP을 해설 단계 수에 맞게 묶기',
    'fix-verification': '실행되지 않는 원본 검산 프로그램 고치기', generate: '단계별 변형 문제 설계',
    solve: '정답을 모르는 독립 풀이 검토', 'review-solution': '만든 해설을 선생님 해설과 STEP별로 대조', repair: '검토에서 나온 문제를 고쳐 다시 설계',
    'write-solution': '출제 모델의 STEP 요지를 선생님 해설 형식으로 풀어 쓰기 (혼합 실행)', adjudicate: '독립 풀이와 정답이 다를 때 출제 모델이 누가 옳은지 재확인 (혼합 실행)',
  };
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
  // Model comparison for teachers (scoring in scoring.js). Every full run of a model counts (one run swings by ±4 of 29 checks). The PC provider is split by the local
  // model each run used; `only` limits the models shown (the comparison page leaves out rejected candidates).
  // verdicts: a hand-checked verdict on a model's final problem ('ok' / 'no'), used for a model evaluated once
  // (the automatic check passed DeepSeek's final, which only changed numbers).
  function modelComparison(onlyCase, only, verdicts = {}) {
    const dir = path.join(cfg.root, 'eval', 'reports');
    const runs = {};
    if (fs.existsSync(dir)) {
      for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
        let raw; try { raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
        const results = (Array.isArray(raw) ? raw : raw.results || []).filter((r) => !onlyCase || r.case === onlyCase);
        if (!results.length || (raw.stage || results[0]?.stage) !== 'full') continue;
        for (const r of results) {
          if (!(r.generation || []).length) continue; // stopped before making anything
          // A mixed run (another model designed, analyzed or repaired) is not this model's own result.
          if (r.designWith || r.analyzeWith || r.repairWith) continue;
          const key = r.provider === 'gemma' ? pcModelKey(r.model) : r.provider;
          if (only && !only.includes(key)) continue;
          (runs[key] = runs[key] || []).push({ ...r, when: raw.stamp || f.slice(0, 15), reviewVersion: raw.reviewVersion });
        }
      }
    }
    const tally = (pred, list) => { const hit = list.filter((c) => pred(c.name)); return { pass: hit.filter((c) => c.pass).length, total: hit.length }; };
    const out = {};
    for (const [key, all] of Object.entries(runs)) {
      // The review got stricter on 2026-09-30 (skippable STEPs, numbers-only finals, teacher's STEP titles, leftovers
      // printed or obvious): a model evaluated since then is scored on those runs only, so an earlier pass under the
      // looser review does not count; a model with no such run keeps its older runs and is marked as such.
      const strict = all.filter((r) => r.reviewVersion === REVIEW_VERSION);
      const rows = strict.length ? strict : all;
      const problems = rows.flatMap(problemResults);
      const verdict = rows.length === 1 ? verdicts[key] : null;
      if (verdict) for (const p of problems) if (p.final && p.dims.made) p.dims.structural = verdict === 'ok';
      for (const p of problems) p.score = problemScore(p);
      const pc = rows[0].provider === 'gemma';
      const scores = problems.map((p) => p.score);
      const mean = scores.reduce((a, s) => a + s, 0) / (scores.length || 1);
      const [low, high] = wilson(mean, scores.length);
      const rate = (dim) => { const hit = problems.filter((p) => p.dims[dim] !== undefined); return { pass: hit.filter((p) => p.dims[dim]).length, total: hit.length }; };
      out[key] = {
        when: rows[rows.length - 1].when, runs: rows.length, pc, olderReview: !strict.length,
        label: pc ? pcModelLabel(rows[rows.length - 1].model || 'gemma-4-12b').replace(' (PC)', '') : undefined,
        read: tally(() => true, rows.flatMap((r) => r.analysis || [])),
        problems: problems.length,
        // 0–100 with a 95% range from the number of problems: 3 perfect problems prove less than 30 would.
        score: Math.round(mean * 100), low: Math.round(low * 100), high: Math.round(high * 100),
        metrics: Object.fromEntries(DIMENSIONS.map(([id]) => [id, { ...rate(id), ...(id === 'structural' && verdict ? { reviewed: true } : {}) }])),
        minutes: Math.round(rows.reduce((a, r) => a + (r.minutes || 0), 0) / rows.length),
        time: timeSummary(rows.map((r) => r.timing).filter(Boolean)),
      };
    }
    return { metrics: DIMENSIONS.map(([id, label, weight]) => ({ id, label, weight })), models: out };
  }
  const COMPARED = ['relay', 'deepseek', 'qwen36', 'gemma12'];
  // 모델 비교 page: the same original made into problems by each model (files built by eval/compare-bundle.js).
  const compareDir = path.join(cfg.root, 'eval', 'compare');
  route('GET', /^\/api\/compare$/, () => (fs.existsSync(compareDir) ? fs.readdirSync(compareDir).filter((f) => f.endsWith('.json') && !f.endsWith('.feedback.json')).map((f) => {
    const b = JSON.parse(fs.readFileSync(path.join(compareDir, f), 'utf8'));
    return { id: b.id, title: b.title, models: b.models.map((m) => ({ key: m.key, label: m.label, score: m.score?.make || null })) };
  }) : []));
  const PDF_NAME = { relay: 'Claude_Opus_5.5', deepseek: 'DeepSeek_V4_Flash', qwen36: 'Qwen_3.6-35B', gemma12: 'Gemma_4_12B' };
  function comparePdf(res, id, key) {
    const file = path.join(compareDir, id, `${key}.pdf`);
    if (!fs.existsSync(file)) throw fail(404, 'PDF를 찾지 못했습니다.');
    const name = `${id}_${PDF_NAME[key]}.pdf`;
    res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${name}"`, 'Content-Length': fs.statSync(file).size, ...security });
    fs.createReadStream(file).pipe(res);
    return undefined;
  }
  function compareBundle(id) {
    const file = path.join(compareDir, `${id}.json`);
    if (!fs.existsSync(file)) throw fail(404, '비교 자료를 찾지 못했습니다.');
    const bundle = JSON.parse(fs.readFileSync(file, 'utf8'));
    // How each model met the teacher's written feedback (a reviewed judgement kept next to the bundle).
    const feedback = path.join(compareDir, `${id}.feedback.json`);
    if (fs.existsSync(feedback)) bundle.feedback = JSON.parse(fs.readFileSync(feedback, 'utf8'));
    // Quality and cost of each model on this case alone.
    const verdicts = Object.fromEntries(Object.entries(bundle.feedback?.models || {}).map(([k, v]) => [k, v.final?.[0]]).filter(([, v]) => v));
    bundle.overview = { compare: modelComparison(id, COMPARED, verdicts), cost: costEstimate(id) };
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
    return bundle;
  }
  route('GET', /^\/api\/compare\/([a-z0-9-]+)\/pdf\/(relay|deepseek|qwen36|gemma12)$/, (req, res, [id, key]) => comparePdf(res, id, key));
  route('GET', /^\/api\/compare\/([a-z0-9-]+)$/, (req, res, [id]) => compareBundle(id));
  // The public copy of this page (compare.html): the whole comparison, no login and nothing else of the system.
  // The colleague's message the checklist was built from stays private; the checklist itself is shown.
  const PUBLIC_COMPARE = 'chem-molar-mass';
  route('GET', /^\/api\/public\/compare$/, () => {
    const bundle = compareBundle(PUBLIC_COMPARE);
    if (bundle.feedback) bundle.feedback = { ...bundle.feedback, quote: '' };
    return bundle;
  }, { open: true });
  route('GET', /^\/api\/public\/compare\/([a-z0-9-]+)\/pdf\/(relay|deepseek|qwen36|gemma12)$/, (req, res, [id, key]) => {
    if (id !== PUBLIC_COMPARE) throw fail(404, 'PDF를 찾지 못했습니다.');
    return comparePdf(res, id, key);
  }, { open: true });
  // LLM tab: the AI's persona, each stage's built-in instructions (read-only) with the teacher's addition, and the
  // checks every made problem goes through (read-only).
  function promptSettings() {
    const s = llmSettings(cfg.dataDir);
    return {
      version: prompts.PROMPT_VERSION,
      persona: s.persona || '',
      stages: Object.entries(PROMPT_STAGES).map(([key, st]) => ({
        key, label: st.label, about: st.about, addendum: s.addenda?.[key] || '',
        prompts: st.purposes.filter((p) => prompts.SYSTEMS[p]).map((p) => ({ id: p, purpose: PROMPT_PURPOSE[p] || '', text: prompts.SYSTEMS[p] })),
      })),
      checks: {
        analysis: pipeline.SYSTEM_CHECKS.analysis, generation: pipeline.SYSTEM_CHECKS.generation, repair: pipeline.SYSTEM_CHECKS.repair,
      },
      budget: cfg.budget,
    };
  }
  const PERSONA_MAX = 4000;
  const ADDENDUM_MAX = 4000;
  route('GET', /^\/api\/llm\/prompts$/, () => promptSettings());
  route('PUT', /^\/api\/llm\/prompts$/, async (req) => {
    const body = await readBody(req, 64 * 1024);
    const patch = {};
    if (body.persona !== undefined) {
      const persona = String(body.persona || '').trim();
      if (persona.length > PERSONA_MAX) throw fail(400, `공통 지시는 ${PERSONA_MAX.toLocaleString()}자까지 쓸 수 있습니다.`);
      patch.persona = persona;
    }
    if (body.addenda !== undefined) {
      const addenda = { ...(llmSettings(cfg.dataDir).addenda || {}) };
      for (const [key, text] of Object.entries(body.addenda || {})) {
        if (!PROMPT_STAGES[key]) throw fail(400, '알 수 없는 단계입니다.');
        const t = String(text || '').trim();
        if (t.length > ADDENDUM_MAX) throw fail(400, `단계별 추가 지시는 ${ADDENDUM_MAX.toLocaleString()}자까지 쓸 수 있습니다.`);
        if (t) addenda[key] = t; else delete addenda[key];
      }
      patch.addenda = addenda;
    }
    saveLlmSettings(cfg.dataDir, patch);
    return promptSettings();
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
  server.listen(cfg.port, cfg.host, () => console.log(`EduMaster listening on http://${cfg.host}:${cfg.port} (llm=${cfg.llmMode}, data=${cfg.dataDir})`));
}

module.exports = { createApp };
