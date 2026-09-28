'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const config = require('./config');
const { openStore, newId, isId } = require('./store');
const { createLlm } = require('./llm');
const { mock } = require('./mock-llm');
const { createJobs, FINISHED } = require('./jobs');
const { makeRule, updateRule } = require('./learning');
const { normalizeStages, buildItems } = require('./plan');
const pipeline = require('./pipeline');
const prompts = require('./prompts');

const VERSION = '2.0.0';

function readSecret(file) {
  try { return fs.readFileSync(file, 'utf8').trim(); } catch { return ''; }
}

function createApp(options = {}) {
  const cfg = { ...config, ...options, budget: { ...config.budget, ...options.budget }, deepseek: { ...config.deepseek, ...options.deepseek } };
  const store = openStore(cfg.dataDir);
  const apiKey = readSecret(path.join(cfg.dataDir, 'deepseek-api-key.txt'));
  let accessCode = readSecret(path.join(cfg.dataDir, 'access-code.txt'));
  if (!accessCode) {
    accessCode = crypto.randomBytes(6).toString('base64url');
    fs.writeFileSync(path.join(cfg.dataDir, 'access-code.txt'), accessCode + '\n', { mode: 0o600 });
    console.log(`접속 코드를 새로 만들었습니다: ${path.join(cfg.dataDir, 'access-code.txt')}`);
  }
  const llm = createLlm({ config: cfg, store, apiKey, mock });
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

  route('GET', /^\/api\/status$/, (req) => ({
    version: VERSION, authenticated: Boolean(sessionOf(req)), llm: cfg.llmMode,
    deepseekConfigured: Boolean(apiKey), visionModel: cfg.deepseek.visionModel, textModel: cfg.deepseek.textModel,
    activeJobs: jobs.activeCount(),
  }), { open: true });

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
    const job = jobs.analyze(material);
    return { material: materialSummary(material), jobId: job.id };
  });
  route('GET', /^\/api\/materials\/([a-f0-9]+)$/, (req, res, [id]) => {
    const m = getMaterial(id);
    return { ...m, jobs: store.jobs.all().filter((j) => j.materialId === id).map(jobSummary) };
  });
  route('PUT', /^\/api\/materials\/([a-f0-9]+)$/, async (req, res, [id]) => {
    const m = getMaterial(id);
    if (m.status === 'analyzing') throw fail(409, '분석이 끝난 뒤에 수정할 수 있습니다.');
    const body = await readBody(req, 512 * 1024);
    const merged = pipeline.normalizeMaterial({ ...m, ...body, problem: { ...m.problem, ...body.problem } });
    if (!merged.steps.length) throw fail(400, 'STEP이 하나 이상 있어야 합니다.');
    return store.materials.put({ ...m, ...merged, status: 'ready', error: '', teacherEditedAt: new Date().toISOString() });
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
    store.materials.put({ ...m, status: 'analyzing', error: '', note: body.note !== undefined ? String(body.note).slice(0, 1000) : m.note });
    return { jobId: jobs.analyze(m).id };
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
    const rules = pipeline.pickRules(store, material);
    const { images, ...snapshot } = material;
    const job = jobs.generate({ material: { ...snapshot, images }, items, rules, options: { mode, effort, perStage: items.length / stages.length } });
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

  route('GET', /^\/api\/prompts$/, () => ({
    analyze: prompts.ANALYZE_SYSTEM, generate: prompts.GENERATE_SYSTEM, solve: prompts.SOLVE_SYSTEM, repair: prompts.REPAIR_SYSTEM,
  }));
  route('GET', /^\/api\/usage$/, () => {
    const rows = store.usage.all();
    const sum = (list) => list.reduce((a, r) => ({ calls: a.calls + 1, input: a.input + (r.input || 0), output: a.output + (r.output || 0), total: a.total + (r.total || 0) }), { calls: 0, input: 0, output: 0, total: 0 });
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
