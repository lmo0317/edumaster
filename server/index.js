'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const config = require('./config');
const { openStore, newId, isId } = require('./store');
const cliModels = require('./cli-models');
const { createLlm, PROVIDERS, Budget, pcModelLabel, pcModelKey, claudeCliReady, claudeLimits, claudeCliChoice, llmSettings, saveLlmSettings, CLAUDE_MODELS, CLAUDE_EFFORTS, HARNESS_LIMITS, harnessSettings } = require('./llm');
const { REVIEW_VERSION, DIMENSIONS, problemResults, problemScore, wilson, timeSummary } = require('./scoring');
const { mock } = require('./mock-llm');
const { createJobs, FINISHED } = require('./jobs');
const { createUsers } = require('./users');
const { makeRule, updateRule, readingCorrections, recordCorrections, migrateLearning, analysisLearning, selectRules, layerOf, stageOf } = require('./learning');
const { normalizeStages, buildItems } = require('./plan');
const learningMap = require('./learning-map');
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
  // Learning lives in one store (docs/learning.md): bring older analysis feedback and settings over, once.
  const migrated = migrateLearning(store, llmSettings(cfg.dataDir), (patch) => saveLlmSettings(cfg.dataDir, patch));
  if (migrated) console.log(`[learning] ${migrated}개 항목을 하나의 학습 저장소로 옮겼습니다.`);
  let apiKey = readSecret(path.join(cfg.dataDir, 'deepseek-api-key.txt'));
  const claudeKey = readSecret(path.join(cfg.dataDir, 'anthropic-api-key.txt'));
  // Accounts (server/users.js). The first one is made on the server: node scripts/user.js add <name>.
  const users = createUsers(cfg.dataDir);
  if (!users.count()) console.log('[계정] 아직 계정이 없습니다. 서버에서 node scripts/user.js add <아이디> 로 관리자 계정을 만드세요.');
  const llm = createLlm({ config: cfg, store, apiKey, claudeKey, mock });
  const jobs = createJobs({ store, llm, config: cfg });

  // ------------------------------------------------------------ sessions
  const sessionFile = path.join(cfg.dataDir, 'sessions.json');
  let sessions = {};
  try { sessions = JSON.parse(fs.readFileSync(sessionFile, 'utf8')); } catch { sessions = {}; }
  const saveSessions = () => fs.writeFileSync(sessionFile, JSON.stringify(sessions), { mode: 0o600 });
  const SESSION_DAYS = 30;
  const cookieName = 'em2_session';
  // A session belongs to an account; one from the access-code days (no account) or of an account that was switched
  // off or deleted no longer counts. Returns the session's key (the token's hash).
  const sessionOf = (req) => {
    const token = /(?:^|;\s*)em2_session=([A-Za-z0-9_-]{20,})/.exec(req.headers.cookie || '')?.[1];
    if (!token) return null;
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    const s = sessions[hash];
    if (!s || s.expires <= Date.now() || !s.userId) return null;
    const u = users.get(s.userId);
    return u && !u.disabled ? hash : null;
  };
  const userOf = (req) => { const h = sessionOf(req); return h ? users.get(sessions[h].userId) : null; };
  // Failed logins: 10 per address and 5 per name in 10 minutes, then wait.
  const attempts = new Map();
  const failedFor = (key) => (attempts.get(key) || []).filter((t) => t > Date.now() - 10 * 60000);
  const endSessionsOf = (userId, keep) => { for (const [k, v] of Object.entries(sessions)) if (v.userId === userId && k !== keep) delete sessions[k]; saveSessions(); };

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
  const materialSummary = (m, rules = store.rules.all()) => ({ id: m.id, title: m.title, analysisFeedbackCount: rules.filter((r) => r.scope === 'material' && r.source?.materialId === m.id && stageOf(r) === 'analysis').length, subject: m.subject, topic: m.topic, status: m.status, createdAt: m.createdAt, stepCount: m.steps?.length || 0, solutionSource: m.solutionSource, images: m.images, error: m.error,
    feedbackCount: rules.filter((r) => r.scope === 'material' && r.status === 'approved' && r.source?.materialId === m.id).length });
  const jobSummary = (j) => ({
    id: j.id, type: j.type, status: j.status, title: j.title, materialId: j.materialId, createdAt: j.createdAt, finishedAt: j.finishedAt, error: j.error, usage: j.usage, options: j.options,
    parentJobId: j.parentJobId, itemIndex: j.itemIndex, modelLabel: j.modelLabel,
    items: (j.items || []).map((i) => ({ index: i.index, label: i.label, status: i.status, adopted: Boolean(i.adopted), preview: questionLine(i.problem?.text),
      // 남은 점 in the problem itself (not only the solution's wording), for the list's state.
      problemLeft: (i.warnings || []).some((w) => !/^해설: /.test(w)), designed: Boolean(i.design) })),
  });
  const getJob = (id) => store.jobs.get(id) || (() => { throw fail(404, '작업을 찾지 못했습니다. 삭제되었거나 주소가 잘못되었습니다.'); })();
  const getMaterial = (id) => store.materials.get(id) || (() => { throw fail(404, '자료를 찾지 못했습니다.'); })();

  // ------------------------------------------------------------ routes
  const routes = [];
  const route = (method, pattern, handler, { open = false } = {}) => routes.push({ method, pattern, handler, open });

  route('GET', /^\/api\/status$/, async (req) => {
    const gemma = await llm.gemmaStatus();
    return {
      version: VERSION, authenticated: Boolean(sessionOf(req)), user: userOf(req), llm: cfg.llmMode,
      deepseekConfigured: Boolean(apiKey), visionModel: cfg.deepseek.visionModel, textModel: cfg.deepseek.textModel,
      providers: {
        deepseek: { label: PROVIDERS.deepseek.label, available: Boolean(apiKey) || cfg.llmMode === 'mock', note: '항상 사용 가능 · 유료 · 빠름' },
        gemma: { label: pcModelLabel(gemma.model), available: gemma.available, model: gemma.model, note: gemma.available ? 'PC 연결됨 · 무료 · 느림' : 'PC가 꺼져 있어 지금은 사용할 수 없음' },
        ...(claudeKey && cfg.claude.selectable ? { claude: { label: PROVIDERS.claude.label, available: true, note: '유료 · 품질 가장 높음 · DeepSeek보다 비쌈' } } : {}),
        ...(claudeCliReady(cfg) ? { 'claude-cli': { label: claudeCliChoice(cfg).label, effort: claudeCliChoice(cfg).effort, available: true, note: '서버의 Claude 구독으로 실행 · 추가 비용 없음 · 품질 가장 높음 · 느릴 수 있음' } } : {}),
        ...(cfg.relay.dir ? { relay: { label: cfg.relay.label, available: true, note: '요청마다 외부 에이전트가 응답 (비교 실험용)' } } : {}),
        ...Object.fromEntries(cliModels.CLIS.filter((c) => cliModels.cliReady(cfg, c)).map((c) => [c, { label: cliModels.cliChoice(cfg, c).label, available: true, note: `서버의 ${cliModels.NAME[c]} 구독으로 실행 · 추가 비용 없음 · 느릴 수 있음` }])),
      },
      activeJobs: jobs.activeCount(),
      defaultProvider: defaultProvider(),
    };
  }, { open: true });

  // Picks the provider for a new job and refuses Gemma while the PC is off.
  const DEFAULTABLE = ['deepseek', 'claude-cli', 'agy-cli', 'codex-cli', 'gemma'];
  const defaultProvider = () => {
    const p = llmSettings(cfg.dataDir).defaultProvider;
    return DEFAULTABLE.includes(p) ? p : 'deepseek';
  };
  const chooseProvider = async (value) => {
    // No model named: the 기본 모델 chosen on the LLM tab, if it can be used right now; otherwise DeepSeek.
    if (!value) {
      const preferred = defaultProvider();
      if (preferred === 'claude-cli' && claudeCliReady(cfg)) return 'claude-cli';
      if (cliModels.CLIS.includes(preferred) && cliModels.cliReady(cfg, preferred)) return preferred;
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
    if (cliModels.CLIS.includes(value)) {
      if (!cliModels.cliReady(cfg, value)) throw fail(409, `${cliModels.NAME[value]} 구독이 연결되어 있지 않습니다. LLM 탭에서 연결해 주세요.`);
      return value;
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
    const { username, password } = await readBody(req, 4096);
    const name = String(username || '').trim().toLowerCase();
    const byIp = failedFor('ip:' + ip);
    const byName = failedFor('name:' + name);
    if (byIp.length >= 10 || byName.length >= 5) throw fail(429, '로그인 시도가 너무 많습니다. 10분 뒤 다시 시도해 주세요.');
    if (!users.count()) throw fail(503, '아직 계정이 없습니다. 서버에서 관리자 계정을 먼저 만들어 주세요.');
    const user = users.verify(name, password);
    if (!user) {
      attempts.set('ip:' + ip, [...byIp, Date.now()]);
      attempts.set('name:' + name, [...byName, Date.now()]);
      throw fail(401, '아이디 또는 비밀번호가 올바르지 않습니다.');
    }
    attempts.delete('name:' + name);
    const token = crypto.randomBytes(32).toString('base64url');
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    for (const [k, v] of Object.entries(sessions)) if (v.expires < Date.now() || !v.userId) delete sessions[k];
    sessions[hash] = { created: Date.now(), expires: Date.now() + SESSION_DAYS * 86400000, userId: user.id };
    saveSessions();
    const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
    res.setHeader('Set-Cookie', `${cookieName}=${token}; Path=${cfg.cookiePath}; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure}`);
    return { ok: true, user };
  }, { open: true });

  // The signed-in account, changing one's own password (other devices are signed out), and — for an admin — the
  // accounts: add, reset a password, change the role, switch off, delete. One admin always remains.
  route('GET', /^\/api\/me$/, (req) => userOf(req));
  route('PUT', /^\/api\/me\/password$/, async (req) => {
    const me = userOf(req);
    const { current, next } = await readBody(req, 4096);
    if (!users.verify(me.username, current)) throw fail(400, '지금 비밀번호가 맞지 않습니다.');
    users.setPassword(me.id, next);
    endSessionsOf(me.id, sessionOf(req));
    return { ok: true };
  });
  const adminOnly = (req) => { const me = userOf(req); if (me?.role !== 'admin') throw fail(403, '관리자만 할 수 있습니다.'); return me; };
  route('GET', /^\/api\/users$/, (req) => { adminOnly(req); return users.list(); });
  route('POST', /^\/api\/users$/, async (req) => { adminOnly(req); const b = await readBody(req, 4096); return users.create({ username: b.username, password: b.password, role: b.role }); });
  route('PUT', /^\/api\/users\/([a-f0-9]+)$/, async (req, res, [id]) => {
    const me = adminOnly(req);
    const b = await readBody(req, 4096);
    if (id === me.id && (b.disabled || (b.role && b.role !== 'admin'))) throw fail(409, '자기 계정은 끄거나 관리자에서 내릴 수 없습니다.');
    if (b.password !== undefined) { users.setPassword(id, b.password); endSessionsOf(id, id === me.id ? sessionOf(req) : null); }
    const u = users.update(id, { role: b.role, disabled: b.disabled });
    if (u.disabled) endSessionsOf(id, null);
    return u;
  });
  route('DELETE', /^\/api\/users\/([a-f0-9]+)$/, (req, res, [id]) => {
    const me = adminOnly(req);
    if (id === me.id) throw fail(409, '자기 계정은 지울 수 없습니다.');
    users.remove(id);
    endSessionsOf(id, null);
    return { ok: true };
  });

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
    for (const p of ['deepseek', 'gemma', 'claude-cli', 'agy-cli', 'codex-cli', 'claude']) {
      const mine = rows.filter((r) => r.provider === p);
      const at = (r) => new Date(r.createdAt).getTime();
      usage[p] = {
        today: sum(mine.filter((r) => at(r) >= start.getTime())), days30: sum(mine.filter((r) => at(r) >= since30)),
        month: { ...sum(mine.filter((r) => at(r) >= month.getTime())), sets: sets.filter((j) => (j.options?.provider || 'deepseek') === p).length },
        lastAt: mine.map((r) => r.createdAt).sort().pop() || '',
      };
    }
    const cliInfo = (c) => ({ installed: fs.existsSync(c === 'agy-cli' ? cfg.agyCli.bin : cfg.codexCli.bin), loggedIn: cliModels.cliReady(cfg, c), ...cliModels.cliChoice(cfg, c), models: cliModels.cliModels(cfg, c), login: cliModels.loginState(c) });
    return { usage, claude: { loggedIn: claudeCliReady(cfg), ...claudeCliChoice(cfg), limits: claudeLimits(cfg), models: CLAUDE_MODELS, efforts: CLAUDE_EFFORTS }, deepseek: { key: apiKey ? '…' + apiKey.slice(-4) : '' },
      'agy-cli': { ...cliInfo('agy-cli'), limits: cliModels.cliReady(cfg, 'agy-cli') ? cliModels.agyLimitsFresh(cfg) : null }, 'codex-cli': { ...cliInfo('codex-cli'), efforts: cliModels.CODEX_EFFORTS, limits: cliModels.cliReady(cfg, 'codex-cli') ? cliModels.codexLimits(cfg) : null } };
  });
  // Gemini (agy) and GPT (Codex) on the LLM tab: the model (and GPT's reasoning effort), sign-in, a check, sign-out.
  const CLI_RE = '(agy-cli|codex-cli)';
  route('PUT', new RegExp(`^/api/llm/cli/${CLI_RE}$`), async (req, res, [c]) => {
    const body = await readBody(req, 1024);
    const list = cliModels.cliModels(cfg, c);
    if (body.model && !list.some((m) => m.id === body.model)) throw fail(400, '고를 수 없는 모델입니다.');
    if (c === 'codex-cli' && body.effort && !cliModels.CODEX_EFFORTS.includes(body.effort)) throw fail(400, '추론 강도 값이 올바르지 않습니다.');
    saveLlmSettings(cfg.dataDir, { [c === 'agy-cli' ? 'agy' : 'codex']: { model: body.model || '', ...(c === 'codex-cli' ? { effort: body.effort || 'high' } : {}) } });
    return cliModels.cliChoice(cfg, c);
  });
  route('GET', new RegExp(`^/api/cli-login/${CLI_RE}$`), (req, res, [c]) => ({ loggedIn: cliModels.cliReady(cfg, c), ...cliModels.loginState(c) }));
  route('POST', new RegExp(`^/api/cli-login/${CLI_RE}/start$`), async (req, res, [c]) => {
    if (!fs.existsSync(c === 'agy-cli' ? cfg.agyCli.bin : cfg.codexCli.bin)) throw fail(409, '서버에 이 CLI가 설치되어 있지 않습니다.');
    return cliModels.loginStart(cfg, c, cfg.root);
  });
  route('POST', new RegExp(`^/api/cli-login/${CLI_RE}/code$`), async (req, res, [c]) => cliModels.loginCode(c, String((await readBody(req, 4096)).code || '').trim()));
  // 새로 고침 on the LLM tab: Gemini's remaining limits read now.
  route('POST', /^\/api\/cli-login\/agy-cli\/limits$/, async () => ({ limits: await cliModels.refreshAgyLimits(cfg) }));
  route('POST', new RegExp(`^/api/cli-login/${CLI_RE}/cancel$`), (req, res, [c]) => { cliModels.loginCancel(c); return { ok: true }; });
  route('POST', new RegExp(`^/api/cli-login/${CLI_RE}/logout$`), async (req, res, [c]) => { await cliModels.logout(cfg, c); return { loggedIn: cliModels.cliReady(cfg, c) }; });
  route('POST', new RegExp(`^/api/cli-login/${CLI_RE}/check$`), async (req, res, [c]) => {
    if (!cliModels.cliReady(cfg, c)) throw fail(409, `${cliModels.NAME[c]} 구독이 연결되어 있지 않습니다.`);
    const started = Date.now();
    try {
      const { data } = await llm.json({ provider: c, purpose: 'solve', jobId: c + '-check', budget: new Budget({ maxCalls: 2, maxTokens: 400000 }), effort: 'off', maxTokens: 2000,
        system: 'JSON만 출력한다.', text: '12×7의 값을 {"answer": 값} 형식으로만 답하라.' });
      return { ok: Number(data.answer) === 84, answer: data.answer, seconds: Math.round((Date.now() - started) / 100) / 10, model: cliModels.cliChoice(cfg, c).label };
    } catch (e) {
      return { ok: false, error: e.message.slice(0, 300), seconds: Math.round((Date.now() - started) / 100) / 10 };
    }
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
  // How each generation item fared over every variant judged so far: kept / broken.
  function keptByRule() {
    const out = new Map();
    const alias = learningMap.aliasesOf(store.rules.all()); // a merged item keeps the record of the ones merged into it
    for (const it of store.jobs.all().filter((j) => j.type === 'generate').flatMap((j) => j.items || [])) {
      for (const r of it.verification?.rules || []) {
        if (!r.judged) continue;
        const k = out.get(alias(r.id)) || { kept: 0, broken: 0 };
        if (r.judged.ok) k.kept++; else k.broken++;
        out.set(alias(r.id), k);
      }
    }
    return out;
  }
  const titleOfMaterial = (id) => (id ? store.materials.get(id)?.title || '삭제된 문제' : '');
  // An item as the pages show it: which of 지침 / 이 문제 / 공통 학습, where it was learned, and how it fared.
  const itemView = (r, kept) => ({
    id: r.id, layer: layerOf(r), stage: stageOf(r), text: r.text, target: r.target, status: r.status, createdAt: r.createdAt,
    from: r.source?.from || 'input', fromLabel: r.source?.label || '', jobId: r.source?.jobId || '', itemIndex: r.source?.itemIndex,
    learnedOn: titleOfMaterial(r.promotedFrom || (r.scope === 'material' ? '' : r.source?.materialId)),
    kept: kept.get(r.id)?.kept || 0, broken: kept.get(r.id)?.broken || 0,
  });
  route('GET', /^\/api\/materials\/([a-f0-9]+)\/learning$/, (req, res, [id]) => {
    const m = getMaterial(id);
    const all = store.rules.all();
    const kept = keptByRule();
    const sets = store.jobs.all().filter((j) => j.type === 'generate' && j.materialId === id).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const own = all.filter((r) => r.scope === 'material' && r.source?.materialId === id);
    const ownGen = own.filter((r) => stageOf(r) === 'generation');
    const judged = (list) => ({ kept: list.filter((r) => r.judged?.ok).length, broken: list.filter((r) => r.judged && !r.judged.ok).length });
    // Analysis: what applies now (지침, this problem's, lessons) plus this problem's switched-off ones; for each, whether
    // the current analysis had it and what it said it did.
    const used = new Set((m.learningUsed || []).map((x) => x.id));
    const how = (text) => (m.feedbackApplied || []).find((x) => x.feedback.trim() === text.trim())?.how || '';
    const learn = m.status === 'ready' ? analysisLearning(all, m) : { guides: [], own: [], lessons: [] };
    const analysisItems = [...learn.guides, ...learn.own, ...own.filter((r) => stageOf(r) === 'analysis' && r.status !== 'approved'), ...learn.lessons]
      // An analysis from before learningUsed was kept: an item it had is one taught before it ran.
      .map((r) => ({ ...itemView(r, kept), inAnalysis: m.learningUsed ? used.has(r.id) : Boolean(m.analyzedAt && r.createdAt < m.analyzedAt), how: how(r.text) }));
    // Generation: what the next set gets (in that order), plus this problem's switched-off ones; the models.
    const picked = selectRules(all, m);
    const generationItems = [...picked, ...ownGen.filter((r) => r.status !== 'approved')].map((r) => itemView(r, kept));
    const examples = sets.flatMap((j, i) => (j.items || []).filter((it) => it.adopted && it.problem).map((it) => ({
      jobId: j.id, setNo: i + 1, index: it.index, label: it.label, at: it.reviewedAt || j.createdAt,
      preview: String(it.problem.text || '').split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('|'))?.slice(0, 140) || '' })));
    return {
      analysis: { analyzedAt: m.analyzedAt || '', correctionsUsed: m.correctionsUsed || 0, items: analysisItems },
      generation: { items: generationItems, examples },
      sets: sets.map((j, i) => {
        const made = (j.items || []).filter((it) => it.problem);
        return {
          id: j.id, no: i + 1, createdAt: j.createdAt, model: j.modelLabel || PROVIDERS[j.options?.provider]?.label || 'DeepSeek', status: j.status,
          items: (j.items || []).length, made: made.length, adopted: made.filter((it) => it.adopted).length,
          passed: made.filter((it) => ['passed', 'warning'].includes(it.status)).length,
          feedbackBefore: ownGen.filter((r) => r.status === 'approved' && r.createdAt < j.createdAt).length,
          rules: (j.rules || []).length,
          examples: made.reduce((n, it) => n + (it.examplesUsed || 0), 0),
          ...judged(made.flatMap((it) => it.verification?.rules || [])),
        };
      }),
      feedback: ownGen.map((r) => {
        const uses = sets.flatMap((j) => j.items || []).flatMap((it) => (it.verification?.rules || []).filter((x) => x.id === r.id));
        return { id: r.id, text: r.text, target: r.target, status: r.status, createdAt: r.createdAt, used: uses.length, ...judged(uses) };
      }),
      adopted: examples.length,
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
    const jobs = store.jobs.all().filter((j) => j.materialId === id);
    if (jobs.some((j) => !FINISHED.has(j.status))) throw fail(409, '진행 중인 작업이 있어 삭제할 수 없습니다.');
    // Everything that belongs to the problem goes with it: its sets (and analyses) and its own learning. Learning
    // moved up to 공통 학습 or 지침 stays.
    const own = store.rules.all().filter((r) => r.scope === 'material' && r.source?.materialId === id);
    for (const j of jobs) store.jobs.remove(j.id);
    for (const r of own) store.rules.remove(r.id);
    store.materials.remove(id);
    return { ok: true, sets: jobs.filter((j) => j.type === 'generate').length, learning: own.length };
  });
  route('POST', /^\/api\/materials\/([a-f0-9]+)\/analyze$/, async (req, res, [id]) => {
    const m = getMaterial(id);
    if (m.status === 'analyzing') throw fail(409, '이미 분석 중입니다.');
    const body = await readBody(req, 8192);
    const provider = await chooseProvider(body.provider);
    // Feedback on the reading ("STEP 3 제목은 …", "표 Ⅲ의 B는 필기") accumulates on the problem; every later
    // analysis of it gets all of it.
    const feedback = String(body.feedback || '').trim().slice(0, 1000);
    if (feedback) store.rules.put(makeRule({ text: feedback, scope: 'material', stage: 'analysis', source: { materialId: m.id, label: m.title, from: body.from === 'check' ? 'check' : 'input' } }));
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
    const mode = body.mode === 'integrated' ? 'integrated' : 'numeric';
    const items = buildItems(stages, material.steps.length, body.perStage, mode);
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
    // 가정 방향: keep or flip which case STEP 1 assumes and rules out (only for an original whose STEP 1 does that).
    const direction = ['same', 'flip'].includes(body.direction) && harness.assumedCase(material.steps[0]?.work) ? body.direction : undefined;
    const job = jobs.generate({ material: { ...snapshot, images }, items, rules, options: { mode, effort, provider, designWith, repairWith, lean, direction, perStage: items.length / stages.length } });
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
      // A problem's own item records its subject; an every-problem item is tagged only when the teacher tags it.
      if (job && !body.subject && body.scope !== 'global') { body.subject = job.material?.subject; body.topic = job.material?.topic; }
    } else if (source?.materialId && isId(source.materialId)) {
      // Feedback written on the problem page itself (on the original, its reading or the variants in general).
      const material = getMaterial(source.materialId);
      source = { materialId: material.id, label: material.title, from: source.from };
      if (!body.subject && body.scope !== 'global') { body.subject = material.subject; body.topic = material.topic; }
    }
    // Feedback on a problem belongs to that problem unless the teacher widens it.
    const scope = body.scope || (source?.materialId ? 'material' : 'global');
    // The same sentence on the same problem (a quick-feedback tag pressed on several variants) is one feedback:
    // it is switched back on instead of being stored twice.
    const same = scope === 'material' && store.rules.all().find((r) => r.scope === 'material' && r.source?.materialId === source?.materialId && stageOf(r) === (body.stage || 'generation') && r.text.trim() === String(body.text || '').trim());
    if (same) return store.rules.put(updateRule(same, { status: 'approved' }));
    return store.rules.put(makeRule({ ...body, scope, source }));
  });
  route('PUT', /^\/api\/rules\/([a-f0-9]+)$/, async (req, res, [id]) => {
    const rule = store.rules.get(id) || (() => { throw fail(404, '지침을 찾지 못했습니다.'); })();
    return store.rules.put(updateRule(rule, await readBody(req, 16 * 1024)));
  });
  route('DELETE', /^\/api\/rules\/([a-f0-9]+)$/, (req, res, [id]) => ({ ok: store.rules.remove(id) }));
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
          // A mixed run (another model designed, analyzed or repaired, or Claude models mixed) is not this model's own result.
          if (r.designWith || r.analyzeWith || r.repairWith || r.claudeMix) continue;
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
      // What the model used on these same runs: every token of the run (the analysis, the three problems, their
      // reviews and repairs) and its list price call by call (eval/recost.js for reports written before a price was
      // kept). The PC models cost nothing; the Claude subscription costs nothing extra but fills its weekly limit by
      // list price.
      const used = rows.map((r) => ({ made: (r.generation || []).filter((c) => /: 문제 생성$/.test(c.name) && c.pass).length, tokens: (r.analysisUsage?.total || 0) + (r.generationUsage?.total || 0), usd: r.provider === 'gemma' ? 0 : r.cost?.usd ?? null }));
      const avg = (xs) => (xs.length ? xs.reduce((x, y) => x + y, 0) / xs.length : null);
      const priced = used.filter((u) => u.usd != null && u.made);
      const counted = used.filter((u) => u.tokens && u.made);
      const cost = {
        setTokens: avg(counted.map((u) => u.tokens)), problemTokens: avg(counted.map((u) => u.tokens / u.made)),
        setUsd: avg(priced.map((u) => u.usd)), problemUsd: avg(priced.map((u) => u.usd / u.made)),
        problemUsdRange: priced.length > 1 ? [Math.min(...priced.map((u) => u.usd / u.made)), Math.max(...priced.map((u) => u.usd / u.made))] : null,
      };
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
        cost,
      };
    }
    return { metrics: DIMENSIONS.map(([id, label, weight]) => ({ id, label, weight })), models: out };
  }
  const COMPARED = ['claude-cli', 'deepseek', 'qwen36', 'gemma12'];
  // 모델 비교 page: the same original made into problems by each model (files built by eval/compare-bundle.js).
  const compareDir = path.join(cfg.root, 'eval', 'compare');
  route('GET', /^\/api\/compare$/, () => (fs.existsSync(compareDir) ? fs.readdirSync(compareDir).filter((f) => f.endsWith('.json') && !f.endsWith('.feedback.json')).map((f) => {
    const b = JSON.parse(fs.readFileSync(path.join(compareDir, f), 'utf8'));
    return { id: b.id, title: b.title, models: b.models.map((m) => ({ key: m.key, label: m.label, score: m.score?.make || null })) };
  }) : []));
  const PDF_NAME = { 'claude-cli': 'Claude_Opus_5.5', deepseek: 'DeepSeek_V4_Flash', qwen36: 'Qwen_3.6-35B', gemma12: 'Gemma_4_12B' };
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
    // The Claude subscription's weekly limit fills by list price: ≈$5 per 1% (measured 2026-10-06).
    bundle.overview = { compare: modelComparison(id, COMPARED, verdicts), pricing: { krwPerUsd: cfg.pricing.krwPerUsd, usdPerWeeklyPercent: 5 } };
    return bundle;
  }
  route('GET', /^\/api\/compare\/([a-z0-9-]+)\/pdf\/(claude-cli|deepseek|qwen36|gemma12)$/, (req, res, [id, key]) => comparePdf(res, id, key));
  route('GET', /^\/api\/compare\/([a-z0-9-]+)$/, (req, res, [id]) => compareBundle(id));
  // The public copy of this page (compare.html): the whole comparison, no login and nothing else of the system.
  // The colleague's message the checklist was built from stays private; the checklist itself is shown.
  const PUBLIC_COMPARE = 'chem-molar-mass';
  route('GET', /^\/api\/public\/compare$/, () => {
    const bundle = compareBundle(PUBLIC_COMPARE);
    if (bundle.feedback) bundle.feedback = { ...bundle.feedback, quote: '' };
    return bundle;
  }, { open: true });
  route('GET', /^\/api\/public\/compare\/([a-z0-9-]+)\/pdf\/(claude-cli|deepseek|qwen36|gemma12)$/, (req, res, [id, key]) => {
    if (id !== PUBLIC_COMPARE) throw fail(404, 'PDF를 찾지 못했습니다.');
    return comparePdf(res, id, key);
  }, { open: true });
  // 학습 (docs/learning.md): each problem's own items (문제별 학습) and the every-problem items by layer and stage, with where each was learned and how
  // it fared; the reading corrections (공통 학습 of analysis); the persona and, read-only, how results are checked (지침).
  route('GET', /^\/api\/learning$/, () => {
    const kept = keptByRule();
    const global = store.rules.all().filter((r) => r.scope !== 'material').sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((r) => itemView(r, kept));
    const pick = (layer, stage) => global.filter((r) => r.layer === layer && r.stage === stage);
    // 문제별 학습: each problem's own items, problems with the newest teaching first. An analysis item says whether the
    // problem's current analysis had it (as on the problem page).
    const own = store.rules.all().filter((r) => r.scope === 'material' && r.source?.materialId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const problems = store.materials.all().map((m) => {
      const mine = own.filter((r) => r.source.materialId === m.id);
      const used = new Set((m.learningUsed || []).map((x) => x.id));
      const view = (r) => (stageOf(r) === 'analysis'
        ? { ...itemView(r, kept), inAnalysis: m.learningUsed ? used.has(r.id) : Boolean(m.analyzedAt && r.createdAt < m.analyzedAt) }
        : itemView(r, kept));
      return { id: m.id, title: m.title, subject: m.subject || '', topic: m.topic || '', latest: mine.at(-1)?.createdAt || '',
        analysis: mine.filter((r) => stageOf(r) === 'analysis').map(view), generation: mine.filter((r) => stageOf(r) === 'generation').map(view) };
    }).filter((p) => p.analysis.length + p.generation.length).sort((a, b) => b.latest.localeCompare(a.latest));
    return {
      problems,
      map: learningMapView(kept),
      materials: store.materials.all().length,
      persona: llmSettings(cfg.dataDir).persona || '',
      guides: { analysis: pick('guide', 'analysis'), generation: pick('guide', 'generation') },
      lessons: { analysis: pick('lesson', 'analysis'), generation: pick('lesson', 'generation') },
      corrections: store.corrections.all().sort((a, b) => b.count - a.count),
      // How results are checked is on 학습 › 하네스 (/api/harness).
    };
  });
  // 학습 지도: every item with how many problems carried it, its mark on the recent sets and what it was learned from;
  // the summary (how many, how many lately, what one problem gets against the cap); the pairs the AI found to be one
  // item (정리 후보), checked a few at a time in the background as items come in.
  const mergesFile = path.join(cfg.dataDir, 'learning-merges.json');
  const readMerges = () => { try { return JSON.parse(fs.readFileSync(mergesFile, 'utf8')); } catch { return {}; } };
  const saveMerge = (key, decision) => fs.writeFileSync(mergesFile, JSON.stringify({ ...readMerges(), [key]: { ...decision, at: new Date().toISOString() } }, null, 1));
  let mergeCheck = null;
  const MERGE_CHECKS = 6;
  function checkMergePairs() {
    if (mergeCheck) return;
    const todo = learningMap.mergePairs(store.rules.all(), readMerges()).filter((p) => !p.decision).slice(0, MERGE_CHECKS);
    const provider = cfg.llmMode === 'mock' ? 'deepseek' : claudeCliReady(cfg) ? 'claude-cli' : apiKey ? 'deepseek' : '';
    if (!todo.length || !provider) return;
    const budget = new Budget({ maxCalls: todo.length * 2, maxTokens: 200000 });
    mergeCheck = (async () => {
      for (const p of todo) {
        const { data } = await llm.json({ provider, purpose: 'merge', budget, effort: 'low', maxTokens: 3000, system: prompts.MERGE_SYSTEM, text: prompts.mergeText({ a: p.a.text, b: p.b.text }) });
        const text = String(data?.text || '').trim().slice(0, 1500);
        saveMerge(p.key, { decision: data?.same === true && text.length > 8 ? 'same' : 'distinct', text, why: String(data?.why || '').trim().slice(0, 300), by: 'ai' });
      }
    })().catch((e) => console.log(`[learning] 정리 후보 확인 실패: ${e.message}`)).finally(() => { mergeCheck = null; });
  }
  function learningMapView(kept) {
    const all = store.rules.all();
    const jobsAll = store.jobs.all();
    const marks = learningMap.setMarks(jobsAll, all);
    const jobsById = new Map(jobsAll.map((j) => [j.id, j]));
    const materials = store.materials.all();
    const analysisUses = (id) => materials.filter((m) => (m.learningUsed || []).some((x) => x.id === id)).length;
    const items = all.sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((r) => ({
      ...itemView(r, kept), scope: r.scope, subject: r.scope === 'material' ? '' : r.subject || '', materialId: r.scope === 'material' ? r.source?.materialId || '' : '', fromProblem: Boolean(r.source?.materialId),
      uses: stageOf(r) === 'analysis' ? analysisUses(r.id) : marks.uses(r.id),
      marks: stageOf(r) === 'analysis' ? null : marks.marks(r.id), evidence: learningMap.evidenceOf(r, jobsById), merged: (r.mergedFrom || []).length,
    }));
    const pairs = learningMap.mergePairs(all, readMerges());
    if (pairs.some((p) => !p.decision)) checkMergePairs();
    // What the next set of the problem worked on last gets, against the cap (learning.selectRules).
    const lastSet = jobsAll.filter((j) => j.type === 'generate').sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    const last = (lastSet && store.materials.get(lastSet.materialId)) || materials.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
    const picked = last ? selectRules(all, last) : [];
    const week = new Date(Date.now() - 7 * 864e5).toISOString();
    const lately = all.filter((r) => r.createdAt >= week);
    return {
      items, sets: marks.sets,
      // The subjects an every-problem item can be tagged with: those of the problems, and any already used.
      subjects: [...new Set([...materials.map((m) => m.subject), ...all.map((r) => r.scope !== 'material' && r.subject)].filter(Boolean))].sort(),
      recent: { added: lately.length, auto: lately.filter((r) => r.source?.from === 'auto').length },
      load: last ? { materialId: last.id, title: last.title, items: picked.length, chars: picked.reduce((n, r) => n + r.text.length, 0), limit: 24, maxChars: 6000 } : null,
      candidates: pairs.filter((p) => p.decision?.decision === 'same').map((p) => ({ key: p.key, a: { id: p.a.id, text: p.a.text, layer: layerOf(p.a) }, b: { id: p.b.id, text: p.b.text, layer: layerOf(p.b) }, text: p.decision.text, why: p.decision.why })),
      checking: pairs.filter((p) => !p.decision).length,
    };
  }
  // Merging a candidate: the item that stays (지침 over 공통 학습 over a problem's, then the older) takes the merged
  // sentence and keeps both originals; the other is removed. Skipping keeps both and does not ask again.
  const pairOf = (key) => learningMap.mergePairs(store.rules.all()).find((p) => p.key === key) || (() => { throw fail(409, '두 학습 중 하나가 그새 바뀌었습니다. 새로 고쳐 주세요.'); })();
  route('POST', /^\/api\/learning\/merge$/, async (req) => {
    const body = await readBody(req, 16 * 1024);
    const p = pairOf(String(body.key || ''));
    const [keep, drop] = learningMap.keeperOf(p.a, p.b);
    const next = updateRule(keep, { text: body.text });
    next.mergedFrom = [...(keep.mergedFrom || []), ...(drop.mergedFrom || []), ...[keep, drop].map((r) => ({ id: r.id, text: r.text, from: r.source?.from || 'input', createdAt: r.createdAt }))];
    store.rules.put(next);
    store.rules.remove(drop.id);
    saveMerge(p.key, { decision: 'merged', text: next.text, by: 'teacher' });
    return { id: next.id };
  });
  route('POST', /^\/api\/learning\/skip$/, async (req) => {
    const p = pairOf(String((await readBody(req, 4096)).key || ''));
    saveMerge(p.key, { decision: 'distinct', by: 'teacher' });
    return { ok: true };
  });
  // 하네스 (학습 › 하네스): how results are checked and fixed, how that went on the recent sets, and the counts the teacher
  // can change. A change applies to sets started after it.
  const strip = ({ match, ...c }) => c;
  route('GET', /^\/api\/harness$/, () => ({
    settings: harnessSettings(cfg.dataDir), limits: HARNESS_LIMITS,
    checks: { analysis: pipeline.SYSTEM_CHECKS.analysis.map(strip), generation: pipeline.SYSTEM_CHECKS.generation.map(strip) }, onFail: pipeline.ON_FAIL,
    stats: pipeline.harnessStats(store.jobs.all()),
  }));
  route('PUT', /^\/api\/harness$/, async (req) => {
    const body = await readBody(req, 4096);
    const next = {};
    for (const [k, [lo, hi]] of Object.entries(HARNESS_LIMITS)) {
      if (body[k] === undefined) continue;
      const v = Number(body[k]);
      if (!Number.isInteger(v) || v < lo || v > hi) throw fail(400, `${k}은(는) ${lo}~${hi} 사이의 정수여야 합니다.`);
      next[k] = v;
    }
    saveLlmSettings(cfg.dataDir, { harness: { ...harnessSettings(cfg.dataDir), ...next } });
    return { settings: harnessSettings(cfg.dataDir) };
  });
  const PERSONA_MAX = 4000;
  route('PUT', /^\/api\/persona$/, async (req) => {
    const persona = String((await readBody(req, 64 * 1024)).persona || '').trim();
    if (persona.length > PERSONA_MAX) throw fail(400, `페르소나는 ${PERSONA_MAX.toLocaleString()}자까지 쓸 수 있습니다.`);
    saveLlmSettings(cfg.dataDir, { persona });
    return { persona };
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
