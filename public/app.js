'use strict';
(function () {
  const { escape: esc, rich, circled } = window.EM;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const view = $('#view');
  let routeToken = 0;

  // ------------------------------------------------------------------ api
  class NetworkError extends Error {}
  async function api(method, url, body) {
    let res;
    try {
      res = await fetch(url.replace(/^\//, ''), {
        method, credentials: 'same-origin',
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      // "Failed to fetch": no response at all (Wi-Fi drop, sleep, server restart). Work on the server continues.
      throw new NetworkError('서버와 연결이 잠시 끊겼습니다. 인터넷 연결을 확인하고 다시 시도해 주세요. 진행 중이던 작업은 서버에서 계속됩니다.');
    }
    if (res.status === 502 || res.status === 503 || res.status === 504) {
      throw new NetworkError('서버가 잠시 응답하지 않습니다 (재시작 중일 수 있음). 잠시 후 다시 시도해 주세요.');
    }
    let data = null;
    try { data = await res.json(); } catch { /* non-json */ }
    if (res.status === 401 && !url.endsWith('/login')) { showLogin(); throw new Error('로그인이 필요합니다.'); }
    if (!res.ok) throw new Error(data?.error || `요청 실패 (${res.status})`);
    return data;
  }

  function toast(message, bad) {
    const el = document.createElement('div');
    el.className = 'toast' + (bad ? ' bad' : '');
    el.textContent = message;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), bad ? 6000 : 2800);
  }
  const guard = (fn) => async (...args) => { try { await fn(...args); } catch (e) { if (e.message !== '로그인이 필요합니다.') toast(e.message, true); } };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // Polling naps can be cut short after the user starts something, so the screen updates right away.
  let wake = () => {};
  const nap = (ms) => new Promise((r) => { const t = setTimeout(r, ms); wake = () => { clearTimeout(t); r(); }; });

  // Keeps a screen refreshing until `tick` returns true or the user leaves. A dropped request only shows a
  // "reconnecting" banner and retries with a growing delay; it never replaces the screen with an error.
  function connectionBanner(show) {
    let el = document.getElementById('conn');
    if (!show) { el?.remove(); return; }
    if (!el) {
      el = document.createElement('div');
      el.id = 'conn'; el.className = 'conn';
      el.textContent = '서버와 연결이 잠시 끊겨 다시 연결하는 중입니다… (작업은 서버에서 계속 진행됩니다)';
      document.body.appendChild(el);
    }
  }
  async function poll(alive, interval, tick) {
    let failures = 0;
    while (alive()) {
      await nap(failures ? Math.min(30000, 2000 * 2 ** (failures - 1)) : interval());
      if (!alive()) break;
      try {
        const done = await tick();
        failures = 0; connectionBanner(false);
        if (done) break;
      } catch (e) {
        if (!(e instanceof NetworkError)) { connectionBanner(false); throw e; }
        failures++; connectionBanner(true);
      }
    }
    if (!alive()) connectionBanner(false);
  }
  window.addEventListener('online', () => wake());
  const fmtTime = (iso) => iso ? new Date(iso).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
  // Upper bound at DeepSeek Flash peak prices ($0.30 / 1M input, $1.20 / 1M output).
  // USD per million tokens (input, output); Gemma runs free on the teacher's PC, the relay records no tokens.
  const PRICE = { deepseek: [0.30, 1.20], claude: [4, 20] };
  const cost = (u, provider = 'deepseek') => (PRICE[provider] ? ((u.paidInput ?? u.input ?? 0) * PRICE[provider][0] + (u.paidOutput ?? u.output ?? 0) * PRICE[provider][1]) / 1e6 : 0);
  const tokens = (u, provider) => u ? `모델 호출 ${u.calls}회 · ${Number(u.total || 0).toLocaleString()}토큰 · ${provider === 'gemma' ? '무료(PC 모델)' : provider === 'relay' ? '토큰 집계 없음(세션 중계)' : `최대 약 $${cost(u, provider).toFixed(3)}`}` : '';
  const PROVIDER_LABEL = { deepseek: 'DeepSeek', gemma: 'PC 모델', relay: 'Claude Opus 5.5', claude: 'Claude Opus 5.5', 'claude-cli': 'Claude Opus 5.5 (구독)', 'agy-cli': 'Gemini (구독)', 'codex-cli': 'GPT (구독)' };
  // Model picker: DeepSeek is always there; Gemma only while the teacher's PC is on.
  let statusCache = null;
  const loadStatus = async () => { statusCache = await api('GET', '/api/status'); paintModelState(statusCache); paintAccount(statusCache.user); return statusCache; };
  function paintAccount(user) {
    const a = $('#account');
    if (!a) return;
    a.hidden = !user;
    a.textContent = user ? user.username : '';
    a.title = user ? `${user.username} · ${user.role === 'admin' ? '관리자' : '선생님'} — 계정` : '';
    $('#logout').hidden = !user;
  }
  // Header: the 기본 모델 (links to the LLM tab), and when it cannot be used right now, what is used instead.
  function paintModelState(status) {
    const el = $('#model-state');
    if (!el) return;
    if (!status?.authenticated) { el.textContent = status?.llm === 'mock' ? '모의 모드' : ''; return; }
    const key = status.defaultProvider || 'deepseek';
    const p = status.providers?.[key];
    const label = p?.label || PROVIDER_LABEL[key] || key;
    el.innerHTML = `<a class="model-state" href="#/llm" title="기본 모델 바꾸기">기본 모델: <b>${esc(label)}</b>${p?.available === false || !p ? ' <span class="chip warn">꺼짐 → DeepSeek 사용</span>' : ''}${status.llm === 'mock' ? ' · 모의 모드' : ''}</a>`;
  }
  // Starts on the 기본 모델 chosen on the LLM tab (or DeepSeek when that one cannot be used right now).
  function providerPicker(name, selected = statusCache?.defaultProvider) {
    const providers = statusCache?.providers || { deepseek: { label: 'DeepSeek V4 Flash', available: true, note: '' } };
    const pick = providers[selected]?.available ? selected : 'deepseek';
    return `<div class="providers">${Object.entries(providers).map(([key, p]) => `
      <label class="provider ${p.available ? '' : 'off'}"><input type="radio" name="${name}" value="${key}" ${key === pick ? 'checked' : ''} ${p.available ? '' : 'disabled'}>
        <span><b>${esc(p.label)}</b><small>${esc(p.note || '')}</small></span></label>`).join('')}</div>`;
  }

  const JOB_STATUS = { queued: ['대기 중', 'run'], running: ['진행 중', 'run'], done: ['완료', 'ok'], failed: ['실패', 'bad'], cancelled: ['취소됨', ''], interrupted: ['중단됨', 'warn'] };
  const ITEM_STATUS = { pending: ['대기', ''], generating: ['설계 중', 'run'], verifying: ['검증 중', 'run'], repairing: ['수정 중', 'run'], passed: ['완성', 'ok'], warning: ['완성 · 남은 점', 'warn'], needs_review: ['정답 확인 필요', 'bad'], failed: ['실패', 'bad'] };
  // A set made before 2026-10-02 stopped after two repairs and marked design faults 검토 필요 (its items have no design).
  const legacyReview = (item) => item.status === 'needs_review' && !item.design;
  const MAT_STATUS = { analyzing: ['분석 중', 'run'], ready: ['분석 완료', 'ok'], failed: ['분석 실패', 'bad'] };
  const inlineRich = (t) => rich(t).replace(/^<p>|<\/p>$/g, '');
  const chip = (map, s) => { const [t, c] = map[s] || [s, '']; return `<span class="chip ${c}">${esc(t)}</span>`; };
  const TARGET = { problem: '문제', solution: '해설', design: '문제', all: '전체' };
  const KIND = { do: '할 것', dont: '하지 말 것', feedback: '피드백' };

  // ------------------------------------------------------------------ login
  function showLogin() {
    if ($('.overlay.login')) return;
    const el = document.createElement('div');
    el.className = 'overlay login';
    el.innerHTML = `<form class="box login-box"><h2>EduMaster 로그인</h2>
      <label for="login-name">아이디</label><input type="text" id="login-name" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" required>
      <label for="login-pw">비밀번호</label><input type="password" id="login-pw" name="password" autocomplete="current-password" required>
      <p class="bad small" id="login-error" hidden></p>
      <div class="row" style="margin-top:12px"><span class="muted small">계정은 관리자에게 받으세요.</span><span class="spacer"></span><button class="primary">로그인</button></div></form>`;
    document.body.appendChild(el);
    $('input', el).focus();
    $('form', el).addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = $('#login-error', el);
      err.hidden = true;
      try {
        await api('POST', '/api/login', { username: e.target.username.value, password: e.target.password.value });
      } catch (x) {
        err.textContent = x.message; err.hidden = false;
        e.target.password.value = ''; e.target.password.focus();
        return;
      }
      el.remove();
      await loadStatus().catch(() => {});
      route();
    });
  }
  $('#logout').addEventListener('click', guard(async () => { await api('POST', '/api/logout'); location.hash = '#/'; $('#model-state').textContent = ''; paintAccount(null); showLogin(); }));

  // ------------------------------------------------------------------ images
  async function readImage(file) {
    if (!file || !/^image\/(png|jpeg|webp)$/.test(file.type)) throw new Error('PNG, JPG, WEBP 이미지만 넣을 수 있습니다.');
    const bitmap = await createImageBitmap(file);
    const longest = Math.max(bitmap.width, bitmap.height);
    if (file.size <= 4 * 1024 * 1024 && longest <= 3000) {
      return await new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = reject; r.readAsDataURL(file); });
    }
    const scale = 2400 / longest;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * Math.min(1, scale));
    canvas.height = Math.round(bitmap.height * Math.min(1, scale));
    const g = canvas.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, canvas.width, canvas.height);
    g.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.92);
  }
  // Small scans (e.g. 317px wide) are unreadable for the model. Upscale to ~1400px wide and cut tall pages
  // into overlapping tiles; the model reads these "reading views" while the original is kept for display.
  async function readingViews(dataUrl) {
    const img = await new Promise((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = reject; i.src = dataUrl; });
    const w = img.naturalWidth, h = img.naturalHeight;
    const scale = Math.min(3, Math.max(1, 1400 / w));
    const W = Math.round(w * scale), H = Math.round(h * scale);
    let tile = Math.round(W * 1.3);
    if (scale === 1 && H <= tile * 1.25) return [];
    let overlap = Math.round(tile * 0.12);
    if (Math.ceil((H - overlap) / (tile - overlap)) > 6) { tile = Math.ceil(H / 6) + overlap; overlap = Math.round(tile * 0.12); }
    const views = [];
    for (let y = 0; views.length < 6; y += tile - overlap) {
      const hh = Math.min(tile, H - y);
      const c = document.createElement('canvas');
      c.width = W; c.height = hh;
      const g = c.getContext('2d');
      g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
      g.fillStyle = '#fff'; g.fillRect(0, 0, W, hh);
      g.drawImage(img, 0, y / scale, w, hh / scale, 0, 0, W, hh);
      views.push(c.toDataURL('image/jpeg', 0.93));
      if (y + hh >= H) break;
    }
    return views;
  }
  function zoom(src) {
    const el = document.createElement('div');
    el.className = 'zoom';
    el.innerHTML = `<img src="${esc(src)}" alt="확대 이미지">`;
    el.addEventListener('click', () => el.remove());
    document.addEventListener('keydown', function close(e) { if (e.key === 'Escape') { el.remove(); document.removeEventListener('keydown', close); } });
    document.body.appendChild(el);
  }
  document.addEventListener('click', (e) => { const img = e.target.closest('img[data-zoom]'); if (img) zoom(img.src); });

  // ------------------------------------------------------------------ router
  function setNav(name) { $$('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.nav === name)); }
  async function route() {
    const token = ++routeToken;
    const hash = location.hash || '#/';
    const alive = () => token === routeToken;
    let m;
    try {
      // Each original problem is a workspace (reading, its own feedback, variant sets); the home page lists them.
      if ((m = /^#\/m\/([a-f0-9]+)/.exec(hash))) { setNav('home'); await materialView(m[1], alive); }
      else if ((m = /^#\/j\/([a-f0-9]+)/.exec(hash))) { setNav('home'); await jobView(m[1], alive); }
      else if (hash.startsWith('#/new')) { setNav('home'); await homeView(); }
      else if (hash.startsWith('#/materials')) { location.replace('#/'); return; }
      else if ((m = /^#\/compare\/([a-z0-9-]+)/.exec(hash))) { setNav('compare'); await compareView(m[1]); }
      else if (hash.startsWith('#/compare')) { setNav('compare'); await compareView(); }
      else if ((m = /^#\/learn\/(map|harness)(?:\/([a-z0-9-]+))?/.exec(hash))) { setNav('learn'); await learnView(m[1], m[2]); }
      // The older 학습 tabs are branches of 학습 지도.
      else if ((m = /^#\/(?:learn\/)?(problems|common|guides|lessons|rules)/.exec(hash))) { location.replace('#/learn/map/' + ({ lessons: 'common', rules: 'problems' }[m[1]] || m[1])); return; }
      else if (hash.startsWith('#/learn')) { location.replace('#/learn/map'); return; }
      else if (hash.startsWith('#/system')) { location.replace('#/llm'); return; }
      else if (hash.startsWith('#/llm')) { setNav('llm'); await llmView(); }
      else if (hash.startsWith('#/account')) { setNav(''); await accountView(); }
      else { setNav('home'); await materialsView(); }
    } catch (e) {
      if (alive() && e.message !== '로그인이 필요합니다.') {
        view.innerHTML = `<div class="panel"><div class="note bad">${esc(e.message)}</div><div class="row"><button class="primary" id="retry">다시 시도</button><a href="#/">처음으로</a></div></div>`;
        $('#retry').addEventListener('click', () => route());
        // After a dropped connection, reload this screen by itself once the network is back.
        if (e instanceof NetworkError) window.addEventListener('online', () => { if (alive()) route(); }, { once: true });
      }
    }
  }
  window.addEventListener('hashchange', route);

  // ------------------------------------------------------------------ home
  function dropZone(el, onImage) {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = 'image/png,image/jpeg,image/webp'; input.hidden = true;
    el.appendChild(input);
    const take = guard(async (file) => onImage(await readImage(file)));
    el.addEventListener('click', (e) => { if (!e.target.closest('.clear')) input.click(); });
    input.addEventListener('change', () => input.files[0] && take(input.files[0]));
    el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('over'); });
    el.addEventListener('dragleave', () => el.classList.remove('over'));
    el.addEventListener('drop', (e) => { e.preventDefault(); el.classList.remove('over'); if (e.dataTransfer.files[0]) take(e.dataTransfer.files[0]); });
  }

  async function homeView() {
    const state = { problem: null, solution: null };
    try { await loadStatus(); } catch { /* picker falls back to DeepSeek only */ }
    view.innerHTML = `
      <div class="row"><h1 style="margin-right:auto">문제 추가</h1><a href="#/">← 문제 목록</a></div>
      <div class="panel">
        <h2>원본 문제와 해설 넣기</h2>
        <p class="muted small">넣은 문제마다 작업 공간이 생깁니다. 읽은 내용을 확인하고, 그 문제에 피드백을 쌓아 가며 변형 문제를 만듭니다.</p>
        <p class="muted small">문제 이미지는 필수, 해설 이미지는 선택입니다. 해설을 넣으면 그 풀이 방법(보조 문자, 가정·모순, 비교 순서)을 그대로 STEP으로 정리하고, 없으면 AI가 먼저 풀이를 만듭니다. 이미지를 끌어 놓거나 클릭하거나 Ctrl+V로 붙여 넣으세요.</p>
        <div class="cols cols-2">
          <div><label>문제 이미지 (필수)</label><div class="drop" id="drop-problem"><span class="muted">문제 이미지를 넣어 주세요</span></div></div>
          <div><label>해설 이미지 (선택)</label><div class="drop" id="drop-solution"><span class="muted">교사 해설 이미지 (선택)</span></div>
            <label class="inline"><input type="checkbox" id="same"> 한 이미지에 문제와 해설이 함께 있음</label></div>
        </div>
        <label for="title">제목 (선택)</label><input type="text" id="title" placeholder="예: 몰질량 킬러 02페이지">
        <label>분석 모델</label>${providerPicker('provider')}
        <label for="note">AI에게 알려 줄 점 (선택)</label><textarea id="note" placeholder="예: 표 III의 'B'는 학생 필기입니다. 해설은 STEP 3개입니다."></textarea>
        <div class="row" style="margin-top:12px"><span class="muted small" id="submit-hint">문제 이미지를 넣으면 분석을 시작할 수 있습니다.</span><span class="spacer"></span><button class="primary" id="start" disabled>분석 시작</button></div>
      </div>`;
    const paint = (key) => {
      const el = $('#drop-' + key);
      $$('img, .clear', el).forEach((x) => x.remove());
      $('span', el).hidden = Boolean(state[key]);
      if (state[key]) {
        el.insertAdjacentHTML('beforeend', `<img src="${state[key]}" alt=""><button class="small clear" type="button">지우기</button>`);
        $('.clear', el).addEventListener('click', () => { state[key] = null; paint(key); });
      }
      $('#start').disabled = !state.problem;
      $('#submit-hint').textContent = state.problem ? (state.solution || $('#same').checked ? '문제와 해설을 함께 분석합니다.' : '해설 없이 분석하면 AI가 풀이를 먼저 만듭니다.') : '문제 이미지를 넣으면 분석을 시작할 수 있습니다.';
    };
    dropZone($('#drop-problem'), (d) => { state.problem = d; paint('problem'); });
    dropZone($('#drop-solution'), (d) => { state.solution = d; paint('solution'); });
    $('#same').addEventListener('change', (e) => { $('#drop-solution').classList.toggle('disabled', e.target.checked); paint('solution'); });
    const onPaste = guard(async (e) => {
      if (!$('#drop-problem')) return document.removeEventListener('paste', onPaste);
      const file = [...(e.clipboardData?.files || [])].find((f) => f.type.startsWith('image/'));
      if (!file) return;
      const data = await readImage(file);
      const key = !state.problem ? 'problem' : 'solution';
      state[key] = data; paint(key);
    });
    document.addEventListener('paste', onPaste);
    $('#start').addEventListener('click', guard(async () => {
      $('#start').disabled = true;
      try {
        const same = $('#same').checked;
        const solution = same ? null : state.solution;
        const [problemViews, solutionViews] = await Promise.all([readingViews(state.problem), solution ? readingViews(solution) : []]);
        const r = await api('POST', '/api/materials', { problemImage: state.problem, solutionImage: solution, problemViews, solutionViews, sameImage: same, provider: $('[name=provider]:checked')?.value, title: $('#title').value, note: $('#note').value });
        location.hash = '#/m/' + r.material.id;
      } finally { if ($('#start')) $('#start').disabled = false; }
    }));
  }

  // A problem set in plain words: still being made, finished (and how many can be used as is), or stopped.
  function setStatus(j) {
    const n = j.items.length;
    const count = (s) => j.items.filter((i) => i.status === s).length;
    const made = j.items.filter((i) => ['passed', 'warning', 'needs_review'].includes(i.status)).length;
    if (j.status === 'queued') return { cat: 'busy', tone: 'run', label: '순서 기다리는 중', detail: '' };
    if (j.status === 'running') return { cat: 'busy', tone: 'run', label: `만드는 중 · ${made}/${n}문제 완성`, detail: '' };
    const parts = [
      count('passed') && `완성 ${count('passed')}`, count('warning') && `남은 점 있음 ${count('warning')}`,
      count('needs_review') && `정답 확인 필요 ${count('needs_review')}`, count('failed') && `못 만듦 ${count('failed')}`,
    ].filter(Boolean).join(' · ');
    if (j.status === 'done') {
      const trouble = count('needs_review') + count('failed');
      return { cat: trouble ? 'check' : 'done', tone: trouble ? 'warn' : 'ok', label: trouble ? '완료 · 확인 필요' : count('warning') ? '완료 · 남은 점 있음' : '완료 · 모두 완성', detail: parts };
    }
    return { cat: 'check', tone: 'bad', label: `멈춤 · ${made}/${n}문제까지 완성`, detail: j.error ? '' : parts };
  }
  const jobEntry = (j, no) => {
    const st = setStatus(j);
    return `<a class="set-row" href="#/j/${j.id}">
      <div class="set-main"><b>${no ? `문제 세트 ${no}` : esc(j.title || '문제 세트')}</b><span class="muted small">${j.items.length}문제 · ${j.options?.mode === 'integrated' ? '통합 변형' : '수치 변형'} · ${esc(j.modelLabel || PROVIDER_LABEL[j.options?.provider] || 'DeepSeek')} · ${fmtTime(j.createdAt)}</span></div>
      <div class="set-state"><span class="chip ${st.tone}">${esc(st.label)}</span>${st.detail ? `<span class="muted small">${esc(st.detail)}</span>` : ''}</div></a>`;
  };

  // What an original problem needs next: reading, a teacher look, or nothing.
  function materialState(m, sets) {
    if (m.status === 'analyzing') return { cat: 'busy', tone: 'run', label: '사진 읽는 중', next: '잠시 후 읽은 내용을 확인할 수 있습니다.' };
    if (m.status === 'failed') return { cat: 'check', tone: 'bad', label: '읽기 실패', next: '다시 분석하거나 더 선명한 사진을 넣어 주세요.' };
    if (!sets.length) return { cat: 'check', tone: 'warn', label: '문제 만들 준비됨', next: '읽은 내용과 STEP을 확인한 뒤 문제를 만드세요.' };
    const latest = setStatus(sets[0]);
    if (sets.some((j) => ['queued', 'running'].includes(j.status))) return { cat: 'busy', tone: 'run', label: '문제 만드는 중', next: '' };
    if (latest.cat === 'check') return { cat: 'check', tone: 'warn', label: '결과 확인 필요', next: '검토가 필요한 문제가 있습니다.' };
    return { cat: 'done', tone: 'ok', label: '완료', next: '' };
  }

  async function materialsView() {
    const [materials, jobs] = await Promise.all([api('GET', '/api/materials'), api('GET', '/api/jobs')]);
    const setsOf = (id) => jobs.filter((j) => j.type === 'generate' && j.materialId === id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const rows = materials.map((m) => ({ m, sets: setsOf(m.id) })).map((x) => ({ ...x, st: materialState(x.m, x.sets) }));
    const TABS = [['all', '전체'], ['busy', '진행 중'], ['check', '확인 필요'], ['done', '완료']];
    const count = (cat) => (cat === 'all' ? rows.length : rows.filter((x) => x.st.cat === cat).length);
    const card = ({ m, sets, st }) => `<div class="mat-card" data-cat="${st.cat}">
      <a class="mat-head" href="#/m/${m.id}">
        ${m.images?.problem ? `<img class="mat-thumb" src="api/files/${m.images.problem}" alt="" loading="lazy">` : '<div class="mat-thumb"></div>'}
        <div class="mat-info">
          <div class="mat-title">${esc(m.title)}</div>
          <div class="muted small">${esc([m.subject, m.topic].filter(Boolean).join(' · '))}${m.stepCount ? ` · 풀이 STEP ${m.stepCount}개` : ''} · ${fmtTime(m.createdAt)}</div>
          <div class="mat-state"><span class="chip ${st.tone}">${st.label}</span><span class="chip">피드백 ${m.feedbackCount || 0}</span><span class="chip">변형 세트 ${sets.length}</span>${st.next ? `<span class="muted small">${st.next}</span>` : ''}</div>
        </div>
        <span class="mat-open">열기 ›</span>
      </a>
    </div>`;
    view.innerHTML = `<div class="row"><h1 style="margin-right:auto">문제</h1><a class="button primary" href="#/new">문제 추가</a></div>
      <p class="muted">문제마다 읽은 내용, 그 문제에 쌓인 피드백, 만든 변형 세트가 한곳에 있습니다. 문제를 열어 피드백을 쌓고 변형 문제를 만드세요.</p>
      <div class="tabs" role="tablist">${TABS.map(([k, t], i) => `<button type="button" class="tab${i ? '' : ' on'}" data-tab="${k}">${t} <span class="count">${count(k)}</span></button>`).join('')}</div>
      <div class="mat-list">${rows.map(card).join('') || '<div class="panel muted">아직 넣은 문제가 없습니다. <a href="#/new">문제 추가</a>에서 시작하세요.</div>'}</div>
      <p class="muted small empty-note" hidden>이 분류에 해당하는 문제가 없습니다.</p>`;
    $$('.tab').forEach((b) => b.addEventListener('click', () => {
      $$('.tab').forEach((x) => x.classList.toggle('on', x === b));
      let shown = 0;
      $$('.mat-card').forEach((c) => { const on = b.dataset.tab === 'all' || c.dataset.cat === b.dataset.tab; c.hidden = !on; shown += on ? 1 : 0; });
      $('.empty-note').hidden = shown > 0 || !rows.length;
    }));
  }

  // ------------------------------------------------------------------ material
  function stepHtml(s, i) {
    return `<div class="step"><div class="head"><span class="badge">STEP ${i + 1}</span>${rich(s.title).replace(/^<p>|<\/p>$/g, '')}</div>
      ${s.purpose ? `<div class="meta"><b>결정하는 것</b> ${rich(s.purpose).replace(/^<p>|<\/p>$/g, '')}</div>` : ''}
      ${s.technique ? `<div class="meta"><b>핵심 기법</b> ${rich(s.technique).replace(/^<p>|<\/p>$/g, '')}</div>` : ''}
      <div class="meta"><b>해설</b></div><div class="rich">${rich(s.work)}</div>
      ${s.result ? `<div class="meta"><b>결론</b> ${rich(s.result).replace(/^<p>|<\/p>$/g, '')}</div>` : ''}</div>`;
  }
  function choicesHtml(p, showAnswer = true) {
    if (!p.choices?.length) return '';
    return `<div class="choices">${p.choices.map((c, i) => `<div class="c ${showAnswer && p.answer === i + 1 ? 'answer' : ''}"><span>${circled(i + 1)}</span><span class="rich">${rich(c).replace(/^<p>|<\/p>$/g, '')}</span></div>`).join('')}</div>`;
  }
  function originalsInner(images) {
    const src = (id) => 'api/files/' + id;
    return images.sameImage
      ? `<figure><figcaption>원본 (문제+해설)</figcaption><img data-zoom src="${src(images.problem)}" alt="원본"></figure>`
      : `<figure><figcaption>원본 문제</figcaption><img data-zoom src="${src(images.problem)}" alt="원본 문제"></figure>${images.solution ? `<figure><figcaption>교사 해설</figcaption><img data-zoom src="${src(images.solution)}" alt="원본 해설"></figure>` : ''}`;
  }
  const originals = (images) => `<div class="orig">${originalsInner(images)}</div>`;

  // ------------------------------------------------------------------ the problem's progress
  // The whole way a problem goes, across the top of its page: each step done, running, waiting for the teacher or not
  // reached yet, and one line on what is happening now (with a spinner while the server works) or what to do next.
  const FLOW = [['upload', '원본'], ['read', '분석'], ['make', '변형 생성'], ['review', '검토·채택']];
  const isBusy = (j) => ['queued', 'running'].includes(j.status);
  const setsOf = (m) => (m.jobs || []).filter((j) => j.type === 'generate').sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  function flowState(m) {
    const gens = setsOf(m);
    const making = gens.find(isBusy);
    const regen = (m.jobs || []).find((j) => j.type === 'regenerate' && isBusy(j));
    const st = { upload: { state: 'done', note: '' } };
    st.read = m.status === 'analyzing' ? { state: 'run', note: '분석 중' } : m.status === 'failed' || !m.steps ? { state: 'bad', note: '분석 실패' } : { state: 'done', note: `STEP ${m.steps.length}개` };
    if (making) {
      const items = making.items || [];
      const made = items.filter((i) => ['passed', 'warning', 'needs_review', 'failed'].includes(i.status)).length;
      st.make = { state: 'run', note: making.status === 'queued' ? '순서 기다리는 중' : `만드는 중 ${made}/${items.length}`, done: `${made}/${items.length} 완성` };
    } else st.make = gens.length ? { state: 'done', note: `세트 ${gens.length}개` } : { state: 'todo', note: '아직 없음' };
    const latest = gens.find((j) => !isBusy(j));
    const no = latest ? gens.length - gens.indexOf(latest) : 0;
    if (!latest) st.review = { state: 'todo', note: '' };
    else {
      const items = latest.items || [];
      const review = items.filter((i) => !i.adopted && i.status === 'needs_review').length;
      const adopted = items.filter((i) => i.adopted).length;
      st.review = regen ? { state: 'run', note: '다시 만드는 중' } : review ? { state: 'warn', note: `확인 필요 ${review}` }
        : adopted ? { state: 'done', note: `채택 ${adopted}/${items.length}` } : { state: 'warn', note: `채택 0/${items.length}` };
    }
    let now;
    if (m.status === 'analyzing') now = { tone: 'run', text: 'AI가 원본을 읽고 STEP으로 정리하고 있습니다. 보통 1~3분 걸리고, 화면을 닫아도 서버에서 계속됩니다. 끝나면 이 화면이 저절로 바뀝니다.' };
    else if (st.read.state === 'bad') now = { tone: 'bad', text: '분석하지 못했습니다. 다시 분석하거나 더 선명한 사진을 넣어 주세요.' };
    else if (making) now = { tone: 'run', text: `변형 문제를 만드는 중입니다 (${making.status === 'queued' ? '순서 기다리는 중' : st.make.done}). 문제마다 설계 → 검산 → 다시 풀어 보기를 거쳐 몇 분 걸립니다. 끝나면 저절로 바뀝니다.`, href: '#/j/' + making.id, action: '진행 보기' };
    else if (regen) now = { tone: 'run', text: '세트의 문제 하나를 다시 만드는 중입니다. 끝나면 저절로 바뀝니다.', href: '#/j/' + regen.parentJobId, action: '진행 보기' };
    else if (!gens.length) now = { tone: 'ok', text: '분석이 끝났습니다. 분석 결과를 보고, 틀린 곳은 고치거나 분석 학습에 적은 뒤 문제를 만드세요.', go: 'make', action: '문제 생성으로 가기' };
    else if (st.review.state === 'warn') now = { tone: 'warn', text: `세트 ${no}가 완성되었습니다 (${st.review.note}). 리포트를 보고 좋은 문제는 채택, 아쉬운 점은 고칠 점으로 남기면 다음 세트에 반영됩니다.`, href: '#/j/' + latest.id, action: '세트 열기' };
    else now = { tone: 'ok', text: '여기까지 끝났습니다. 생성 피드백을 더 남기고 새 세트를 만들면 더 나아집니다.', go: 'make', action: '새 세트 만들러 가기' };
    return { st, now };
  }
  function flowHtml(m) {
    const { st, now } = flowState(m);
    const current = FLOW.find(([k]) => st[k].state !== 'done')?.[0];
    return `<ol class="flow-steps">${FLOW.map(([k, label], i) => `<li class="fs ${st[k].state}${k === current ? ' current' : ''}">
        <span class="fs-dot">${st[k].state === 'done' ? '✓' : st[k].state === 'run' ? '<i class="spin"></i>' : i + 1}</span>
        <span class="fs-txt"><b>${label}</b>${st[k].note ? `<small>${esc(st[k].note)}</small>` : ''}</span></li>`).join('')}</ol>
      <div class="flow-now ${now.tone}">${now.tone === 'run' ? '<i class="spin"></i>' : ''}<span>${esc(now.text)}</span>${now.action ? (now.href ? `<a class="btn small" href="${now.href}">${now.action}</a>` : `<button class="small" data-flow-go="${now.go}">${now.action}</button>`) : ''}</div>`;
  }
  // Paints the progress on the problem page; its buttons take the teacher to the step.
  function paintFlow(m) {
    const el = $('#m-flow');
    if (!el) return;
    el.innerHTML = flowHtml(m);
    $('[data-flow-go]', el)?.addEventListener('click', (e) => {
      const go = e.target.dataset.flowGo;
      $('[data-stage-tab="make"]')?.click();
      $('#generate')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }
  // The problem page being shown, so the poll can repaint its progress and sets without redrawing the page.
  let liveMaterial = null;

  async function materialView(id, alive) {
    let m = await api('GET', '/api/materials/' + id);
    if (m.status === 'analyzing') {
      view.innerHTML = `<div class="lt"><div class="lt-title"><h1>${esc(m.title)}</h1></div>
        <div class="flow" id="m-flow">${flowHtml(m)}</div>
        <section class="lt-sec"><div class="lt-sec-head"><h2>진행 기록</h2></div><div class="panel"><div class="log" id="log"><span class="muted">시작하는 중…</span></div></div></section></div>`;
      await poll(alive, () => 2500, async () => {
        m = await api('GET', '/api/materials/' + id);
        const job = m.jobs.filter((j) => j.type === 'analyze')[0];
        if (job && $('#log')) {
          const full = await api('GET', '/api/jobs/' + job.id);
          $('#log').innerHTML = (full.log || []).map((l) => `<div>${fmtTime(l.t)} ${esc(l.message)}</div>`).join('') + `<div>${tokens(full.usage, full.options?.provider)}</div>`;
        }
        return m.status !== 'analyzing';
      });
      if (alive()) materialView(id, alive);
      return;
    }
    if (m.status === 'failed' || !m.steps) {
      view.innerHTML = `<h1>${esc(m.title)}</h1><div class="flow" id="m-flow">${flowHtml(m)}</div><div class="grid2"><div class="panel">${originals(m.images)}</div><div class="panel"><h2>분석 실패</h2>
        <div class="note bad">${esc(m.error || '분석 결과가 없습니다.')}</div>
        <label>분석 모델</label>${providerPicker('provider')}
        <label>AI에게 알려 줄 점 (선택)</label><textarea id="note">${esc(m.note || '')}</textarea>
        <div class="row" style="margin-top:10px"><button class="primary" id="again">다시 분석</button><button class="danger" id="del">자료 삭제</button></div></div></div>`;
      $('#again').addEventListener('click', guard(async () => { await api('POST', `/api/materials/${id}/analyze`, { note: $('#note').value, provider: $('[name=provider]:checked')?.value }); route(); }));
      $('#del').addEventListener('click', guard(async () => { if (confirm('이 자료를 삭제할까요?')) { await api('DELETE', '/api/materials/' + id); location.hash = '#/materials'; } }));
      return;
    }
    renderMaterial(m, false);
    const mark = (x) => JSON.stringify([x.status, (x.jobs || []).map((j) => [j.id, j.status, (j.items || []).map((i) => [i.status, i.adopted])])]);
    let last = mark(m);
    await poll(alive, () => ((liveMaterial?.m.jobs || []).some(isBusy) ? 3000 : 15000), async () => {
      const fresh = await api('GET', '/api/materials/' + id);
      if (fresh.status !== 'ready') { if (alive()) materialView(id, alive); return true; } // analysis started elsewhere
      const next = mark(fresh);
      if (next === last || liveMaterial?.m.id !== id) return false;
      last = next;
      liveMaterial.m.jobs = fresh.jobs;
      paintFlow(liveMaterial.m);
      liveMaterial.side().catch(() => {});
      return false;
    });
  }

  // Rows that open in place (LLM tab, problem page): the row's 관리/보기/편집 button toggles it, and the keys of open rows
  // are kept in `opened` so a repaint keeps them open.
  function rowToggles(box, opened) {
    $$('[data-open]', box).forEach((b) => b.addEventListener('click', () => {
      const row = b.closest('.lt-row');
      row.classList.toggle('open');
      if (row.classList.contains('open')) opened.add(row.dataset.row); else opened.delete(row.dataset.row);
    }));
  }

  // Problem page rows work like the LLM tab: each item's state on one line, 보기/편집 opens it in place. Which rows
  // are open is remembered per problem while the app is open.
  const openRows = new Map();
  const openSet = (id) => { if (!openRows.has(id)) openRows.set(id, new Set()); return openRows.get(id); };
  const flat = (t) => rich(t).replace(/^<p>|<\/p>$/g, '');
  // The first line of a text worth showing in a one-line preview (not a table row).
  const firstLine = (t) => String(t || '').split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('|')) || '';
  // The STEPs outnumber the steps printed in the solution: offered as one merge.
  const misalignedSteps = (m) => m.steps.length > (m.targetSteps || 99);

  // ------------------------------------------------------------------ learning (docs/learning.md)
  // A learning item as a row: the text, when it was taught, what it did (분석: 반영 / 생성: 지킴·어김); the checkbox
  // switches it off, 편집 opens the text with 삭제.
  const TARGET_TXT = { problem: '문제', solution: '해설', design: '문제', all: '전체' };
  const targetOptions = (sel) => Object.entries({ all: '전체', problem: '문제', solution: '해설' }).map(([v, t]) => `<option value="${v}" ${v === sel ? 'selected' : ''}>${t}</option>`).join('');
  const emptyRow = (text) => `<div class="lt-row lt-plain fb-empty"><span class="muted small">${text}</span></div>`;
  const FROM_TXT = { check: '확인할 곳에서', fix: '세트의 고칠 점에서', auto: '세트 리포트에서 자동으로' };
  function learnEffect(x) {
    if (x.status !== 'approved') return '꺼짐';
    if (x.stage === 'analysis') {
      if (x.inAnalysis === undefined) return '모든 분석에 들어감';
      return x.inAnalysis ? (x.how ? `반영: ${inlineRich(x.how)}` : '반영됨') : '<span class="warn">다시 분석하면 반영</span>';
    }
    const judged = x.kept + x.broken;
    return judged ? `지킴 ${x.kept}${x.broken ? ` · <span class="bad">어김 ${x.broken}</span>` : ''}` : '아직 검토 전';
  }
  function learnRow(x, opened) {
    const key = 'L:' + x.id;
    const from = ['fix', 'auto'].includes(x.from) && x.jobId ? `<a href="#/j/${x.jobId}${x.itemIndex !== undefined ? `?item=${x.itemIndex}` : ''}">${FROM_TXT[x.from]}</a>` : FROM_TXT[x.from] || '';
    return `<div class="lt-row lt-pick${x.status === 'approved' ? '' : ' off'}${opened.has(key) ? ' open' : ''}" data-row="${key}" data-learn="${x.id}">
        <input type="checkbox" data-act="toggle" ${x.status === 'approved' ? 'checked' : ''} aria-label="적용">
        <div class="lt-main"><span class="lt-name lt-clamp">${inlineRich(x.text)}</span>
          <span class="lt-sub lt-wrap">${[fmtTime(x.createdAt), from, learnEffect(x)].filter(Boolean).join(' · ')}</span></div>
        <button class="small lt-open" data-open>편집</button>
        <div class="lt-more"><textarea data-f="text" rows="3">${esc(x.text)}</textarea>
          <div class="lt-actions"><button class="small danger" data-act="del">삭제</button><span class="spacer"></span><button class="small" data-act="cancel">취소</button><button class="small primary" data-act="save">저장</button></div></div>
      </div>`;
  }
  function bindLearnRows(box, items, opened, refresh) {
    rowToggles(box, opened);
    $$('[data-learn]', box).forEach((row) => {
      const x = items.find((i) => i.id === row.dataset.learn);
      if (!x) return;
      const close = () => { row.classList.remove('open'); opened.delete(row.dataset.row); };
      $('[data-act=toggle]', row).addEventListener('change', guard(async (e) => {
        try { await api('PUT', '/api/rules/' + x.id, { status: e.target.checked ? 'approved' : 'pending' }); }
        catch (err) { e.target.checked = !e.target.checked; throw err; }
        toast(e.target.checked ? '다시 적용합니다.' : '껐습니다.');
        await refresh();
      }));
      $('[data-act=cancel]', row).addEventListener('click', () => { $('[data-f=text]', row).value = x.text; close(); });
      $('[data-act=save]', row).addEventListener('click', guard(async () => {
        await api('PUT', '/api/rules/' + x.id, { text: $('[data-f=text]', row).value });
        close(); toast('저장했습니다.'); await refresh();
      }));
      $('[data-act=del]', row).addEventListener('click', guard(async () => {
        if (!confirm('삭제할까요?')) return;
        await api('DELETE', '/api/rules/' + x.id);
        close(); await refresh();
      }));
    });
  }
  // Adds one item: this problem's (on its page, or from a set's 고칠 점), or every problem's (공통 학습 / 지침).
  async function teach({ text, stage, scope = 'problem', target = 'all', materialId, from = 'input', jobId, itemIndex }) {
    const body = scope === 'problem'
      ? { text, stage, target, scope: 'material', source: jobId ? { jobId, itemIndex, from } : { materialId, from } }
      : { text, stage, target, scope: 'global', layer: scope };
    return api('POST', '/api/rules', body);
  }

  // The problem page in three tabs: 분석 (the result, then this problem's 분석 학습), 문제 생성 (this problem's
  // 생성 학습, a new set) and 문제 리스트 (the sets made). Every-problem learning lives on 학습 (공통 학습, 지침).
  function renderMaterial(m, editing) {
    const n = m.steps.length;
    const gens = setsOf(m);
    if (!openRows.has(m.id)) {
      // First visit: open the newest set.
      const s = openSet(m.id);
      if (gens[0]) s.add('s:' + gens[0].id);
    }
    const key = 'em-stage-' + m.id;
    let stage = '';
    try { stage = localStorage.getItem(key) || ''; } catch { /* no storage */ }
    if (editing) stage = 'read';
    if (!['read', 'make', 'list'].includes(stage)) stage = gens.length ? 'list' : 'read';
    view.innerHTML = `<div class="lt">
      <div class="lt-title" id="m-name">
        <div class="name-show"><div class="name-text"><h1>${esc(m.title)}</h1><p class="lt-meta">${esc([m.subject, m.topic].filter(Boolean).join(' · ')) || '과목·유형 없음'}</p></div><div class="name-btns"><button class="small" id="name-edit">✏️ 제목 수정</button><button class="small danger" id="del">원본 문제 삭제</button></div></div>
        <form class="name-form panel" hidden>
          <div><label for="name-title">제목</label><input type="text" id="name-title" maxlength="120" value="${esc(m.title)}" required></div>
          <div class="name-row"><div><label for="name-subject">과목</label><input type="text" id="name-subject" maxlength="40" value="${esc(m.subject || '')}" placeholder="예: 화학"></div>
            <div><label for="name-topic">유형</label><input type="text" id="name-topic" maxlength="120" value="${esc(m.topic || '')}" placeholder="예: 화학 반응의 양적 관계"></div></div>
          <div class="lt-actions"><span class="muted small">다시 분석해도 여기서 정한 제목은 바뀌지 않습니다.</span><span class="spacer"></span><button type="button" class="small" id="name-cancel">취소</button><button type="submit" class="small primary">저장</button></div>
        </form>
      </div>
      <div class="flow" id="m-flow"></div>
      <nav class="stage-tabs" role="tablist">
        <button type="button" role="tab" data-stage-tab="read"><span class="stage-no">1</span><span class="stage-txt"><b>분석</b><small id="st-read"></small></span></button>
        <button type="button" role="tab" data-stage-tab="make"><span class="stage-no">2</span><span class="stage-txt"><b>문제 생성</b><small id="st-make"></small></span></button>
        <button type="button" role="tab" data-stage-tab="list"><span class="stage-no">3</span><span class="stage-txt"><b>문제 리스트</b><small id="st-list"></small></span></button>
      </nav>
      <div class="stage" data-pane="read">
        <section class="lt-sec">
          <div class="lt-sec-head lt-sec-row"><div><h2>분석 결과</h2><p>AI가 원본을 읽고 STEP으로 정리한 내용입니다.</p></div><div class="lt-sec-btns"><button class="small" id="edit">✏️ 분석 결과 수정</button></div></div>
          <div class="panel lt-list" id="analysis"></div>
        </section>
        <section class="lt-sec">
          <div class="lt-sec-head"><h2>분석 학습</h2><p>이 문제를 분석할 때 AI가 따를 점입니다. 다시 분석하면 반영됩니다.</p></div>
          <div class="fb-wrap">
            <div class="panel lt-list" id="a-learn"></div>
            <div class="panel fb-new"><textarea id="at-text" rows="2" placeholder="예: STEP을 4개로 나눠 주세요. 설명을 더 쉽게 풀어 써 주세요."></textarea>
              <div class="lt-actions"><span class="spacer"></span><button class="small" id="at-add">추가</button><button class="small primary" id="at-go">다시 분석</button></div></div>
          </div>
        </section>
      </div>
      <div class="stage" data-pane="make">
        <section class="lt-sec">
          <div class="lt-sec-head"><h2>생성 학습</h2><p>이 문제로 변형을 만들 때 AI가 지킬 점입니다. 다음 세트부터 들어갑니다.</p></div>
          <div class="fb-wrap">
            <div class="panel lt-list" id="g-learn"></div>
            <div class="panel fb-new"><textarea id="gt-text" rows="2" placeholder="예: 최종 문제는 실험 Ⅱ에서 가정→모순을 판정하게 만든다."></textarea>
              <div class="lt-actions"><span class="spacer"></span><button class="small primary" id="gt-add">추가</button></div></div>
          </div>
        </section>
        <section class="lt-sec">
          <div class="lt-sec-head"><h2>새 세트 만들기</h2><p>정답은 서버가 계산으로 확인하고, 문제만 보고 다시 풀어 대조합니다.</p></div>
          <div class="panel" id="generate"></div>
        </section>
      </div>
      <div class="stage" data-pane="list">
        <section class="lt-sec">
          <div class="lt-sec-head"><h2>만든 세트</h2><p>문제를 눌러 열고 👍 채택하거나 ✏️ 고칠 점을 남기세요. 고칠 점은 생성 학습이 되고, 채택한 문제는 다음 세트의 본보기가 됩니다.</p></div>
          <div id="variants"></div>
        </section>
      </div>
    </div>`;
    const show = (tab) => {
      $$('[data-stage-tab]').forEach((b) => { b.classList.toggle('on', b.dataset.stageTab === tab); b.setAttribute('aria-selected', String(b.dataset.stageTab === tab)); });
      $$('[data-pane]').forEach((p) => { p.hidden = p.dataset.pane !== tab; });
      try { localStorage.setItem(key, tab); } catch { /* no storage */ }
    };
    $$('[data-stage-tab]').forEach((b) => b.addEventListener('click', () => show(b.dataset.stageTab)));
    show(stage);
    $('#edit').addEventListener('click', () => editAnalysis(m));
    // The name in place: 제목 수정 swaps the heading for a small form.
    const nameForm = $('#m-name .name-form');
    const naming = (on) => { $('#m-name .name-show').hidden = on; nameForm.hidden = !on; if (on) $('#name-title').focus(); };
    $('#name-edit').addEventListener('click', () => naming(true));
    $('#name-cancel').addEventListener('click', () => { nameForm.reset(); naming(false); });
    nameForm.addEventListener('submit', guard(async (e) => {
      e.preventDefault();
      const saved = await api('PUT', `/api/materials/${m.id}/name`, { title: $('#name-title').value, subject: $('#name-subject').value, topic: $('#name-topic').value });
      Object.assign(m, { title: saved.title, subject: saved.subject, topic: saved.topic, titleFromUser: saved.titleFromUser });
      $('#m-name h1').textContent = saved.title;
      $('#m-name .lt-meta').textContent = [saved.subject, saved.topic].filter(Boolean).join(' · ') || '과목·유형 없음';
      naming(false);
      toast('제목을 바꿨습니다.');
    }));
    // Deleting the problem takes everything of it: says exactly what goes and what stays.
    $('#del').addEventListener('click', guard(async () => {
      const sets = setsOf(m).length;
      if (!confirm(`이 원본 문제를 삭제할까요?\n「${m.title}」\n\n함께 지워집니다: 분석 결과${sets ? `, 만든 세트 ${sets}개` : ''}, 이 문제의 분석·생성 학습\n남습니다: 공통 학습, 지침\n\n되돌릴 수 없습니다.`)) return;
      await api('DELETE', '/api/materials/' + m.id);
      toast('원본 문제를 삭제했습니다.');
      location.hash = '#/';
    }));
    if (editing) editAnalysis(m); else showAnalysis(m);
    generatePanel(m, n);

    // This problem's learning and its sets: one read, repainted after every change.
    const side = async () => {
      const L = await api('GET', `/api/materials/${m.id}/learning`);
      if (!$('#a-learn')) return;
      const gens = setsOf(m);
      const opened = openSet(m.id);
      const mine = (items) => items.filter((x) => x.layer === 'problem');
      const on = (items) => items.filter((x) => x.status === 'approved');
      const a = mine(L.analysis.items);
      const g = mine(L.generation.items);
      const ex = L.generation.examples;
      $('#a-learn').innerHTML = a.map((x) => learnRow(x, opened)).join('') || emptyRow('아직 없습니다.');
      bindLearnRows($('#a-learn'), a, opened, side);
      $('#g-learn').innerHTML = (g.map((x) => learnRow(x, opened)).join('') || emptyRow('아직 없습니다.'))
        + (ex.length ? `<div class="lt-row lt-plain"><div class="lt-main"><span class="lt-name">본보기 ${ex.length}개</span><span class="lt-sub lt-wrap">채택한 문제 · ${ex.map((e) => `<a href="#/j/${e.jobId}?item=${e.index}">세트 ${e.setNo} ${esc(e.label)}</a>`).join(', ')}</span></div></div>` : '');
      bindLearnRows($('#g-learn'), g, opened, side);
      $('#st-read').textContent = `STEP ${m.steps.length}개 · 학습 ${on(a).length}개`;
      $('#st-make').textContent = `생성 학습 ${on(g).length}개${ex.length ? ` · 본보기 ${ex.length}개` : ''}`;
      const review = gens.filter((j) => !isBusy(j)).flatMap((j) => j.items || []).filter((it) => !it.adopted && it.status === 'needs_review').length;
      $('#st-list').innerHTML = gens.some(isBusy) ? '<span class="run">만드는 중</span>' : `세트 ${gens.length}개${review ? ` · <span class="warn">확인 필요 ${review}</span>` : ''}`;
      variantsPanel(m, gens, on(g), L);
      carryLine(m, n, on(g).length, on(L.generation.items).length - on(g).length, ex.length);
    };
    side().catch((e) => { if ($('#a-learn')) $('#a-learn').innerHTML = `<div class="lt-row lt-plain"><span class="bad">${esc(e.message)}</span></div>`; });

    const textOf = (id) => { const t = $(id).value.trim(); if (!t) throw new Error('내용을 적어 주세요.'); return t; };
    const goBtn = $('#at-go');
    $('#at-text').addEventListener('input', () => { goBtn.textContent = $('#at-text').value.trim() ? '추가하고 다시 분석' : '다시 분석'; });
    $('#at-add').addEventListener('click', guard(async () => {
      await teach({ text: textOf('#at-text'), stage: 'analysis', materialId: m.id });
      $('#at-text').value = ''; goBtn.textContent = '다시 분석';
      toast('추가했습니다. 다시 분석하면 반영됩니다.');
      await side();
    }));
    goBtn.addEventListener('click', guard(async () => {
      const text = $('#at-text').value.trim();
      if (!confirm('원본을 다시 분석할까요? 분석 학습을 모두 반영하고, 지금 분석 결과(직접 고친 내용 포함)는 새 결과로 바뀝니다.')) return;
      await api('POST', `/api/materials/${m.id}/analyze`, text ? { feedback: text } : {}); // the 기본 모델 (LLM tab)
      route();
    }));
    $('#gt-add').addEventListener('click', guard(async () => {
      await teach({ text: textOf('#gt-text'), stage: 'generation', materialId: m.id });
      $('#gt-text').value = '';
      toast('추가했습니다. 다음 세트부터 들어갑니다.');
      await side();
    }));
    liveMaterial = { m, side };
    paintFlow(m);
  }

  // The sets made from this problem, newest first, one card each: when and with what it was made, how far its
  // review got, and its problems in staircase order, each one line that opens it. A set made before later feedback
  // says how much of it is missing.
  const SET_ITEM = { adopted: ['채택', 'ok'], needs_review: ['정답 확인 필요', 'bad'], legacy: ['검토 필요', 'bad'], warning: ['남은 점 있음', 'warn'], passed: ['완성', ''], failed: ['못 만듦', 'bad'], generating: ['만드는 중', 'run'], verifying: ['검증 중', 'run'], repairing: ['고치는 중', 'run'], pending: ['대기', ''] };
  // 을/를 after a set number, read as Sino-Korean (1 일을, 2 이를, 3 삼을 …).
  const eulReul = (n) => ('013678'.includes(String(n).slice(-1)) ? '을' : '를');
  async function deleteSet(no, items, id) {
    const adopted = items.filter((it) => it.adopted).length;
    if (!confirm(`세트 ${no}${eulReul(no)} 삭제할까요?\n\n함께 지워집니다: 이 세트의 문제 ${items.length}개${adopted ? ` (채택한 ${adopted}개와 그 본보기 포함)` : ''}\n남습니다: 원본 문제와 분석, 다른 세트, 고칠 점으로 남긴 생성 학습\n\n되돌릴 수 없습니다.`)) return false;
    await api('DELETE', '/api/jobs/' + id);
    toast(`세트 ${no}${eulReul(no)} 삭제했습니다.`);
    return true;
  }
  function variantsPanel(m, gens, on, learning) {
    const el = $('#variants');
    if (!el) return;
    if (!gens.length) {
      el.innerHTML = '<div class="panel set-empty"><p>아직 만든 세트가 없습니다.</p><button class="small primary" data-go-make>문제 생성으로 가기</button></div>';
      $('[data-go-make]', el).addEventListener('click', () => $('[data-stage-tab="make"]')?.click());
      return;
    }
    const stats = new Map(learning.sets.map((s) => [s.id, s]));
    const card = (j, i) => {
      const s = stats.get(j.id) || { no: gens.length - i, examples: 0 };
      const busy = isBusy(j);
      const items = j.items || [];
      const n = (pick) => items.filter(pick).length;
      const adopted = n((it) => it.adopted);
      const review = n((it) => !it.adopted && it.status === 'needs_review' && it.designed);
      const legacy = n((it) => !it.adopted && it.status === 'needs_review' && !it.designed);
      const failed = n((it) => !it.adopted && it.status === 'failed');
      const made = n((it) => ['passed', 'warning', 'needs_review', 'failed'].includes(it.status));
      const later = on.filter((r) => r.createdAt > j.createdAt).length;
      const tally = busy
        ? `<span class="set-pill run"><i class="spin"></i>${j.status === 'queued' ? '순서 기다리는 중' : `만드는 중 ${made}/${items.length}`}</span>`
        : [`<span class="set-pill${adopted ? ' ok' : ''}">채택 ${adopted}/${items.length}</span>`,
          review && `<span class="set-pill bad">정답 확인 필요 ${review}</span>`,
          legacy && `<span class="set-pill bad">검토 필요 ${legacy}</span>`,
          failed && `<span class="set-pill bad">못 만듦 ${failed}</span>`].filter(Boolean).join('');
      const meta = [fmtTime(j.createdAt), esc(j.modelLabel || PROVIDER_LABEL[j.options?.provider] || 'DeepSeek'),
        `학습 ${s.rules || 0}개${s.examples ? `·본보기 ${s.examples}개` : ''} 반영`,
        s.kept + s.broken ? `지킴 ${s.kept}/${s.kept + s.broken}` : ''].filter(Boolean).join(' · ');
      return `<article class="panel set-card${busy ? ' busy' : ''}">
        <header class="set-head">
          <div class="set-title"><a href="#/j/${j.id}">세트 ${s.no}</a>${i === 0 ? '<span class="set-new">최신</span>' : ''}<span class="set-meta">${meta}</span></div>
          <div class="set-tally">${tally}</div>
          <div class="set-acts"><a class="btn small set-open" href="#/j/${j.id}">${busy ? '진행 보기' : '세트 열기'} ›</a>${busy ? '' : `<button class="small set-del" data-del-set="${j.id}" data-no="${s.no}">세트 삭제</button>`}</div>
        </header>
        ${later && !busy && i === 0 ? `<p class="set-later">이 세트 뒤에 가르친 생성 학습 ${later}개는 들어가 있지 않습니다. 새 세트를 만들면 반영됩니다.</p>` : ''}
        <ol class="set-items">${items.map((it, k) => {
          const shown = it.adopted ? 'adopted' : it.status === 'needs_review' && !it.designed ? 'legacy' : it.status === 'warning' && !it.problemLeft ? 'passed' : it.status;
          const [t, c] = SET_ITEM[shown] || [it.status, ''];
          const last = it.stage?.kind === 'twin' || k === items.length - 1;
          return `<li><a class="set-item" href="#/j/${j.id}?item=${it.index}">
            <span class="si-no${last ? ' last' : ''}">${k + 1}</span>
            <span class="si-main"><b>${esc(it.label)}</b><span class="si-text">${it.preview ? inlineRich(it.preview) : '<span class="muted">아직 내용이 없습니다</span>'}</span></span>
            <span class="set-pill ${c}">${c === 'run' ? '<i class="spin"></i>' : ''}${t}</span></a></li>`;
        }).join('')}</ol>
      </article>`;
    };
    const cards = gens.map(card);
    el.innerHTML = `<div class="set-list">${cards.slice(0, 4).join('')}</div>`
      + (cards.length > 4 ? `<details class="set-older"><summary>이전 세트 ${cards.length - 4}개 더 보기</summary><div class="set-list">${cards.slice(4).join('')}</div></details>` : '');
    $$('[data-del-set]', el).forEach((b) => b.addEventListener('click', guard(async () => {
      const j = gens.find((x) => x.id === b.dataset.delSet);
      if (!(await deleteSet(b.dataset.no, j.items || [], j.id))) return;
      m.jobs = (m.jobs || []).filter((x) => x.id !== j.id);
      paintFlow(m);
      await liveMaterial?.side();
    })));
  }

  function showAnalysis(m) {
    const el = $('#analysis');
    el.classList.remove('editing');
    $$('.lt-sec-btns button').forEach((b) => { b.hidden = false; });
    const opened = openSet(m.id);
    const o = (key) => (opened.has(key) ? ' open' : '');
    const misaligned = misalignedSteps(m);
    const list = (items) => `<ul class="lt-ul">${items.map((u) => `<li>${flat(u)}</li>`).join('')}</ul>`;
    const row = (key, name, sub, more, label = '보기', dot = '') => `<div class="lt-row lt-plain${o(key)}" data-row="${key}">
        <div class="lt-main"><span class="lt-name">${dot}${name}</span><span class="lt-sub lt-clip">${sub}</span></div>
        <button class="small lt-open" data-open>${label}</button>
        <div class="lt-more">${more}</div>
      </div>`;
    const src = (id) => 'api/files/' + id;
    const thumbs = [m.images.problem, !m.images.sameImage && m.images.solution].filter(Boolean).map((id) => `<img data-zoom src="${src(id)}" alt="원본">`).join('');
    el.innerHTML = [
      `<div class="lt-row lt-plain${o('a:orig')}" data-row="a:orig">
        <div class="lt-main lt-thumbrow"><span class="lt-thumbs">${thumbs}</span><span class="lt-main"><span class="lt-name">${m.images.sameImage || !m.images.solution ? '원본' : '원본 문제 · 교사 해설'}</span>
          <span class="lt-sub lt-clip">${m.solutionSource === 'ai' ? '해설 없음 → AI가 만든 풀이' : '교사 해설 기반'} · ${esc(PROVIDER_LABEL[m.analyzedWith] || 'DeepSeek')}로 분석${m.teacherEditedAt ? ' · 직접 고침' : ''}</span></span></div>
        <button class="small lt-open" data-open>크게 보기</button>
        <div class="lt-more"><div class="orig orig-2">${originalsInner(m.images)}</div></div>
      </div>`,
      misaligned ? `<div class="lt-row lt-plain"><div class="lt-main"><span class="lt-name">STEP ${m.steps.length}개 · 해설의 단계 표시는 ${m.targetSteps}개</span><span class="lt-sub">해설 단계에 맞추려면 이웃한 STEP을 합칩니다.</span></div><button class="small primary" id="align">해설 단계에 맞춰 합치기</button></div>` : '',
      row('a:problem', '읽은 문제', `${inlineRich(firstLine(m.problem.text))} · 정답 ${m.problem.answer ? circled(m.problem.answer) : '서술형'}`, `
        <div class="rich">${rich(m.problem.text)}</div>
        ${m.problem.figure ? `<div><b>그림 설명</b><div class="rich">${rich(m.problem.figure)}</div></div>` : ''}
        ${choicesHtml(m.problem)}
        ${m.finalCheck ? `<div><b>정답 재확인</b><div class="rich">${rich(m.finalCheck)}</div></div>` : ''}`),
      ...m.steps.map((s, i) => row('a:step' + i, `STEP ${i + 1} · ${flat(s.title)}`, flat(s.result || s.purpose || ''), `
        ${s.purpose ? `<div class="lt-kv"><b>결정하는 것</b><span>${flat(s.purpose)}</span></div>` : ''}
        ${s.technique ? `<div class="lt-kv"><b>핵심 기법</b><span>${flat(s.technique)}</span></div>` : ''}
        <div class="rich">${rich(s.work)}</div>
        ${s.result ? `<div class="lt-kv"><b>결론</b><span>${flat(s.result)}</span></div>` : ''}`)),
      m.techniques?.length ? row('a:tech', '변형에서 다시 쓸 핵심 기법', m.techniques.map(flat).join(' · '), list(m.techniques)) : '',
    ].join('');
    rowToggles(el, opened);
    $('#align')?.addEventListener('click', guard(async (e) => {
      e.target.disabled = true; e.target.textContent = '합치는 중…';
      try {
        const saved = await api('POST', `/api/materials/${m.id}/align-steps`);
        toast(`STEP을 ${saved.steps.length}개로 합쳤습니다.`);
        renderMaterial({ ...saved, jobs: m.jobs }, false);
      } finally { if (e.target.isConnected) { e.target.disabled = false; e.target.textContent = '해설 단계에 맞춰 합치기'; } }
    }));
  }

  function editAnalysis(m) {
    const el = $('#analysis');
    el.classList.add('editing');
    $$('.lt-sec-btns button').forEach((b) => { b.hidden = true; });
    const steps = m.steps.map((s) => ({ ...s }));
    const draw = () => {
      el.innerHTML = `
        <div class="row"><h2 style="margin:0">분석 결과 수정</h2><span class="spacer"></span><button class="small" id="cancel">취소</button><button class="small primary" id="save">저장</button></div>
        <p class="muted small">수식은 $...$ 안에 LaTeX로, 표는 | 로 구분한 Markdown 표로 적습니다. 여기서 고친 내용이 생성의 기준이 됩니다.</p>
        <div class="cols cols-title"><div><label>제목</label><input type="text" name="title" value="${esc(m.title)}"></div>
          <div><label>과목</label><input type="text" name="subject" value="${esc(m.subject)}"></div><div><label>유형</label><input type="text" name="topic" value="${esc(m.topic)}"></div></div>
        <label>문제 본문</label><textarea class="code" name="text" rows="12" data-preview>${esc(m.problem.text)}</textarea><div class="preview rich"></div>
        <label>그림 설명</label><textarea class="code" name="figure" rows="2">${esc(m.problem.figure)}</textarea>
        <div class="cols cols-3-1"><div><label>선택지 (한 줄에 하나)</label><textarea class="code" name="choices" rows="5" data-preview="lines">${esc(m.problem.choices.join('\n'))}</textarea><div class="preview rich"></div></div>
          <div><label>정답 번호</label><input type="text" name="answer" value="${m.problem.answer || ''}"></div></div>
        <h3>풀이 STEP</h3>
        <div id="steps">${steps.map((s, i) => `
          <div class="edit-step" data-i="${i}"><div class="row"><b>STEP ${i + 1}</b><span class="spacer"></span>
            <button class="small" data-act="up" ${i === 0 ? 'disabled' : ''}>위로</button><button class="small" data-act="down" ${i === steps.length - 1 ? 'disabled' : ''}>아래로</button>
            ${i > 0 ? '<button class="small" data-act="merge">위 STEP과 합치기</button>' : ''}<button class="small danger" data-act="del" ${steps.length === 1 ? 'disabled' : ''}>삭제</button></div>
            <label>제목</label><input type="text" data-f="title" value="${esc(s.title)}">
            <label>결정하는 것</label><input type="text" data-f="purpose" value="${esc(s.purpose)}">
            <label>핵심 기법</label><textarea class="code" data-f="technique" rows="2">${esc(s.technique)}</textarea>
            <label>풀이</label><textarea class="code" data-f="work" rows="6" data-preview>${esc(s.work)}</textarea><div class="preview rich"></div>
            <label>결론</label><input type="text" data-f="result" value="${esc(s.result)}"></div>`).join('')}</div>
        <button class="small" id="add">STEP 추가</button>
        <label>핵심 기법 (한 줄에 하나)</label><textarea class="code" name="techniques" rows="3">${esc((m.techniques || []).join('\n'))}</textarea>`;
      // Live preview under LaTeX fields so the teacher sees the rendered result while fixing it.
      $$('[data-preview]', el).forEach((ta) => {
        const box = ta.nextElementSibling;
        const draw = () => {
          box.innerHTML = ta.dataset.preview === 'lines'
            ? ta.value.split('\n').filter((l) => l.trim()).map((l, i) => `<p>${circled(i + 1)} ${inlineRich(l)}</p>`).join('')
            : rich(ta.value);
        };
        let timer;
        ta.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(draw, 250); });
        draw();
      });
      const sync = () => $$('.edit-step', el).forEach((box) => { const s = steps[box.dataset.i]; $$('[data-f]', box).forEach((f) => { s[f.dataset.f] = f.value; }); });
      $$('.edit-step [data-act]', el).forEach((b) => b.addEventListener('click', () => {
        sync();
        const i = Number(b.closest('.edit-step').dataset.i);
        const act = b.dataset.act;
        if (act === 'up') [steps[i - 1], steps[i]] = [steps[i], steps[i - 1]];
        if (act === 'down') [steps[i + 1], steps[i]] = [steps[i], steps[i + 1]];
        if (act === 'del') steps.splice(i, 1);
        if (act === 'merge') {
          const a = steps[i - 1], s = steps[i];
          steps.splice(i - 1, 2, { title: `${a.title} / ${s.title}`, purpose: [a.purpose, s.purpose].filter(Boolean).join(' / '), technique: [a.technique, s.technique].filter(Boolean).join('\n'), work: [a.work, s.work].filter(Boolean).join('\n\n'), result: s.result || a.result });
        }
        draw();
      }));
      $('#add', el).addEventListener('click', () => { sync(); steps.push({ title: '', purpose: '', technique: '', work: '', result: '' }); draw(); });
      $('#cancel', el).addEventListener('click', () => showAnalysis(m));
      $('#save', el).addEventListener('click', guard(async () => {
        sync();
        const q = (name) => $(`[name=${name}]`, el).value;
        const saved = await api('PUT', '/api/materials/' + m.id, {
          title: q('title'), subject: q('subject'), topic: q('topic'),
          problem: { text: q('text'), figure: q('figure'), choices: q('choices').split('\n').map((s) => s.trim()).filter(Boolean), answer: Number(q('answer')) || 0 },
          steps: steps.filter((s) => s.title.trim() || s.work.trim()),
          techniques: q('techniques').split('\n').map((s) => s.trim()).filter(Boolean),
        });
        toast('저장했습니다.');
        renderMaterial({ ...saved, jobs: m.jobs }, false);
      }));
    };
    draw();
  }

  // 새 세트 만들기: every setting is one row of small choices, then one line saying what will be made and with what,
  // and the button. What the set will carry (this problem's learning, every-problem learning, models) comes from
  // carryLine, which may arrive before or after this panel is drawn.
  const carryCounts = new Map();
  async function generatePanel(m, n) {
    const el = $('#generate');
    // A set is always the whole staircase: STEP 1 연습, STEP 1~2 연습, …, and the final problem using every STEP,
    // made as a new structure (never numbers only).
    const stages = [...Array.from({ length: n - 1 }, (_, i) => ({ kind: 'upto', upto: i + 1 })), { kind: 'twin' }];
    const stageName = (s) => (s.kind === 'twin' ? `최종 문제 (STEP 1~${n})` : s.upto === 1 ? 'STEP 1 연습' : `STEP 1~${s.upto} 연습`);
    try { await loadStatus(); } catch { /* the choices fall back to DeepSeek only */ }
    if (!$('#generate')) return;
    const providers = statusCache?.providers || { deepseek: { label: 'DeepSeek V4 Flash', available: true, note: '' } };
    const def = providers[statusCache?.defaultProvider]?.available ? statusCache.defaultProvider : 'deepseek';
    const opt = (name, value, label, on, attrs = '') => `<label class="opt"><input type="radio" name="${name}" value="${value}" ${on ? 'checked' : ''} ${attrs}><span>${label}</span></label>`;
    el.innerHTML = `
      <div class="gen-form">
        <div class="gen-row"><span class="gen-k">세트 구성</span><div class="gen-v">${stages.map(stageName).join(' → ')}</div></div>
        <div class="gen-row"><span class="gen-k">모델</span><div class="opts">
          ${Object.entries(providers).map(([key, p]) => opt('genProvider', key, esc(p.label), key === def, p.available ? '' : 'disabled')).join('')}</div></div>
        <div class="gen-row" id="effort-box"><span class="gen-k">사고 강도</span><div class="opts">
          ${opt('effort', 'low', '기본', true)}${opt('effort', 'high', '정밀 (토큰 더 씀)', false)}</div></div>
        <div class="gen-row" id="claude-effort-note" hidden><span class="gen-k">추론 강도</span><div class="gen-v"><b id="claude-effort-name"></b> <a class="muted small" href="#/llm">LLM 탭에서 변경</a></div></div>
        <p class="gen-hint" id="gen-hint"></p>
      </div>
      <div class="gen-go"><span id="estimate"></span><button class="primary" id="go">세트 만들기</button></div>`;
    const value = (name) => $(`[name=${name}]:checked`, el)?.value;
    const summary = () => {
      const chosen = value('genProvider') || 'deepseek';
      // Each model's own reasoning setting: DeepSeek's here, Claude's from the LLM tab, none for the PC model.
      $('#effort-box').hidden = chosen !== 'deepseek';
      $('#claude-effort-note').hidden = chosen !== 'claude-cli';
      if (chosen === 'claude-cli') $('#claude-effort-name').textContent = EFFORT_TXT[providers['claude-cli']?.effort] || '자동';
      $('#gen-hint').textContent = providers[chosen]?.note || '';
      const c = carryCounts.get(m.id);
      $('#estimate').textContent = [`${stages.length}문제`, c ? `학습 ${c.own + c.common}개${c.adopted ? `·본보기 ${c.adopted}개` : ''} 반영` : '', providers[chosen]?.label || ''].filter(Boolean).join(' · ');
    };
    el.summary = summary;
    $$('input', el).forEach((x) => x.addEventListener('change', summary));
    summary();
    $('#go').addEventListener('click', guard(async () => {
      $('#go').disabled = true;
      const r = await api('POST', '/api/generations', { materialId: m.id, stages, mode: 'integrated', perStage: 1, effort: value('effort'), provider: value('genProvider') });
      try { localStorage.setItem('em-stage-' + m.id, 'list'); } catch { /* no storage */ }
      location.hash = '#/j/' + r.jobId;
    }));
  }

  // What the next set of this problem will carry, counted for the line above the button.
  function carryLine(m, n, own, common, adopted) {
    carryCounts.set(m.id, { own, common, adopted });
    $('#generate')?.summary?.();
  }

  // ------------------------------------------------------------------ job
  async function jobView(id, alive) {
    let job = await api('GET', '/api/jobs/' + id);
    if (job.type === 'regenerate') { location.hash = '#/j/' + job.parentJobId; return; }
    const openState = new Map();
    const drafts = new Map();
    const rendered = new Map();
    view.innerHTML = `<div id="job-head"></div><div id="items"></div>`;
    let regenerating = [];
    let setNo = 0;
    const draw = () => {
      $('#job-head').innerHTML = jobHead(job, regenerating, setNo);
      bindHead(job);
      const box = $('#items');
      job.items.forEach((item) => {
        const key = JSON.stringify([job.status, item.status, item.problem, item.verification, item.history?.length, item.error, regenerating.some((r) => r.itemIndex === item.index)]);
        let card = box.querySelector(`[data-item="${item.index}"]`);
        if (card && rendered.get(item.index) === key) return;
        if (card) {
          $$('details', card).forEach((d) => openState.set(item.index + ':' + d.dataset.k, d.open));
          const ta = $('textarea[name=fb]', card); if (ta) drafts.set(item.index, ta.value);
        }
        const html = itemCard(job, item, regenerating.some((r) => r.itemIndex === item.index));
        const holder = document.createElement('div'); holder.innerHTML = html;
        const next = holder.firstElementChild;
        if (card) card.replaceWith(next); else box.appendChild(next);
        $$('details', next).forEach((d) => { const k = item.index + ':' + d.dataset.k; if (openState.has(k)) d.open = openState.get(k); });
        const ta = $('textarea[name=fb]', next); if (ta && drafts.has(item.index)) ta.value = drafts.get(item.index);
        bindItem(job, item, next);
        rendered.set(item.index, key);
      });
    };
    const refresh = async () => {
      job = await api('GET', '/api/jobs/' + id);
      const all = await api('GET', '/api/jobs?materialId=' + job.materialId);
      regenerating = all.filter((j) => j.type === 'regenerate' && j.parentJobId === id && ['queued', 'running'].includes(j.status));
      setNo = all.filter((j) => j.type === 'generate').sort((a, b) => a.createdAt.localeCompare(b.createdAt)).findIndex((j) => j.id === id) + 1;
    };
    await refresh();
    draw();
    // Opened from a variant in a list: go straight to that problem.
    const focus = /[?&]item=(\d+)/.exec(location.hash)?.[1];
    if (focus) $(`#item-${focus}`)?.scrollIntoView({ block: 'start' });
    await poll(alive, () => (['queued', 'running'].includes(job.status) || regenerating.length ? 2000 : 15000), async () => {
      await refresh();
      if (alive()) draw();
      return false;
    });
  }

  // The set page head: back to the problem, the set's name, one status line, a strip to jump to each problem, and
  // the making record (tokens, cost, the rules it carried, the log) folded away.
  const JUMP = { adopted: 'ok', needs_review: 'bad', failed: 'bad', warning: 'warn', passed: '', generating: 'run', verifying: 'run', repairing: 'run', pending: '' };
  function jobHead(job, regenerating, no) {
    const items = job.items;
    const busy = ['queued', 'running'].includes(job.status);
    const made = items.filter((i) => ['passed', 'warning', 'needs_review', 'failed'].includes(i.status)).length;
    const now = items.find((i) => ['generating', 'verifying', 'repairing'].includes(i.status));
    const adopted = items.filter((i) => i.adopted).length;
    const review = items.filter((i) => !i.adopted && i.status === 'needs_review').length;
    const model = esc(job.modelLabel || PROVIDER_LABEL[job.options.provider] || 'DeepSeek');
    // How long the current step has run, so a slow step (a remake can take minutes) reads as working, not stuck.
    const lastAt = (job.log || []).slice(-1)[0]?.t;
    const mins = lastAt ? Math.floor((Date.now() - new Date(lastAt).getTime()) / 60000) : 0;
    const stepFor = mins >= 1 ? ` · 이 단계 ${mins}분째` : '';
    const line = job.status === 'queued' ? '<i class="spin"></i>순서를 기다리는 중'
      : busy ? `<i class="spin"></i>${made}/${items.length} 만드는 중${now ? ` — 문제 ${now.index + 1} ${(ITEM_STATUS[now.status] || [''])[0]}` : ''}${stepFor} · ${model}`
      : `${items.length}문제 · 채택 ${adopted}${review ? ` · <span class="bad">확인 필요 ${review}</span>` : ''} · ${model}`;
    return `<div class="lt jt-head">
      <a class="lt-back" href="#/m/${job.materialId}">‹ ${esc(job.materialTitle || job.title)}</a>
      <div class="lt-head"><h1>${no ? `세트 ${no}` : '변형 세트'}${job.options.mode === 'numeric' ? ' · 수치 변형' : ''}</h1>
        <div class="name-btns"><a class="btn small" href="report.html?job=${job.id}" target="_blank" rel="noopener">학습지·PDF</a>${busy ? '' : '<button id="delete" class="small danger">세트 삭제</button>'}</div></div>
      <div class="jt-status"><span class="lt-meta">${line}</span><span class="spacer"></span>
        ${busy ? '<button id="cancel" class="small danger">취소</button>' : ''}
        ${['interrupted', 'failed', 'cancelled'].includes(job.status) ? '<button id="resume" class="small primary">남은 문제 이어서 만들기</button>' : ''}</div>
      ${busy ? `<div class="jt-bar"><span style="width:${items.length ? Math.round((made / items.length) * 100) : 0}%"></span></div><p class="muted small jt-wait">문제마다 설계 → 검산 → 다시 풀어 보기를 거쳐 몇 분 걸립니다. 화면을 닫아도 서버에서 계속되고, 이 화면은 저절로 바뀝니다.</p>` : ''}
      ${job.error ? `<div class="note ${job.status === 'cancelled' ? 'warn' : 'bad'}">${esc(job.error)}</div>` : ''}
      ${regenerating.length ? `<div class="note info"><i class="spin"></i> 문제 ${regenerating.map((r) => r.itemIndex + 1).join(', ')}번을 다시 만드는 중입니다. 끝나면 저절로 바뀝니다.</div>` : ''}
      ${busy ? '' : setReport(job)}
      ${busy ? '' : '<p class="jt-howto">문제마다 <b>👍 채택</b>하면 이 원본으로 다음 세트를 만들 때 같은 단계 문제의 본보기(좋은 예시)로 AI에게 보여 줍니다. <b>✏️ 고칠 점</b>은 이 문제의 생성 학습이 되어 다음 세트부터 지킵니다. <b>🔄 다시 만들기</b>는 그 문제 하나만 새로 만듭니다.</p>'}
      <nav class="jt-jump">${items.map((i) => `<button type="button" data-jump="${i.index}"><i class="lt-dot ${JUMP[i.adopted ? 'adopted' : i.status] || ''}"></i>${i.index + 1} ${esc(i.label)}${i.adopted ? ' ✓' : ''}</button>`).join('')}</nav>
      <details class="lt-base jt-log" data-k="log"><summary>만든 기록</summary><div class="jt-log-in">
        <p class="small">${fmtTime(job.createdAt)} · ${tokens(job.usage, job.options.provider)} · 상한 ${job.budget.maxCalls}회 / ${Number(job.budget.maxTokens).toLocaleString()}토큰${job.options.provider === 'deepseek' ? ` · 사고 강도 ${job.options.effort === 'high' ? '정밀' : '기본'}` : ''}</p>
        <p class="small"><b>붙인 피드백·지침 ${job.rules.length}개</b></p>
        ${job.rules.length ? `<ul class="lt-ul small">${job.rules.map((r) => `<li>[${{ material: '이 문제', topic: '유형' }[r.scope] || '모든 문제'}·${TARGET[r.target]}] ${inlineRich(r.text)}</li>`).join('')}</ul>` : ''}
        <p class="small"><b>진행 기록</b></p>
        <div class="log">${(job.log || []).slice().reverse().map((l) => `<div>${fmtTime(l.t)} ${esc(l.message)}</div>`).join('')}</div>
      </div></details>
    </div>`;
  }
  // What the set's checks found and fixed, what is left, and what was learned from it.
  function setReport(job) {
    const items = job.items.filter((i) => i.problem);
    if (!items.length) return '';
    const count = (kind) => items.reduce((n, i) => n + (i.attempts || []).filter((a) => a.kind === kind).length, 0);
    const done = items.filter((i) => ['passed', 'warning'].includes(i.status));
    const first = done.filter((i) => !(i.attempts || []).some((a) => a.kind !== 'generate'));
    const left = items.filter((i) => i.status === 'warning');
    const unsure = items.filter((i) => i.status === 'needs_review');
    const fixes = [count('rewrite') && `해설 다시 쓰기 ${count('rewrite')}번`, count('repair') && `문제 수정 ${count('repair')}번`, count('redesign') && `새로 설계 ${count('redesign')}번`].filter(Boolean);
    const learned = job.learned;
    // How much of the subscription's 1-week and 5-hour limits the set used (read before and after it).
    const q = job.quota;
    const usedOf = (k) => {
      const b = q?.before?.[k]; const e = q?.after?.[k];
      if (!b || !e) return '';
      const name = k === 'sevenDay' ? '1주일' : '5시간';
      // The window refilled while the set ran: only the part after the refill is known.
      if (b.resetsAt && e.resetsAt && Math.abs(new Date(e.resetsAt) - new Date(b.resetsAt)) > 15 * 60000) return `${name} 한도는 중간에 다시 채워져 ${(e.used * 100).toFixed(1)}%p 이상`;
      // Claude reports whole percents: no change means under one.
      const d = Math.max(0, (e.used - b.used) * 100);
      return `${name} 한도 <b>${d < 0.05 ? '1%p 미만' : `${d.toFixed(1)}%p`}</b> (${(b.used * 100).toFixed(1)}% → ${(e.used * 100).toFixed(1)}% 사용)`;
    };
    const tokenCount = (n) => (n >= 1e4 ? `${Math.round(n / 1e3) / 10}만` : (n || 0).toLocaleString());
    const quotaLine = q?.after ? [usedOf('sevenDay'), usedOf('fiveHour'), job.usage?.calls && `호출 ${job.usage.calls}번 · 토큰 ${tokenCount(job.usage.total)}`].filter(Boolean).join(' · ') : '';
    return `<section class="jt-report">
      <h2>세트 리포트</h2>
      <p><b>${done.length === job.items.length ? `${done.length}문제 모두 완성` : `${job.items.length}문제 중 ${done.length}문제 완성`}</b>${first.length ? ` · 첫 설계로 통과 ${first.length}` : ''}${left.length ? ` · 남은 점이 있는 문제 ${left.length}` : ''}${unsure.length ? ` · <span class="bad">정답 확인 필요 ${unsure.length}</span>` : ''}</p>
      ${quotaLine ? `<p class="muted">이 세트가 쓴 구독 한도: ${quotaLine}. 같은 시간에 이 구독을 쓴 다른 작업이 있었다면 그 몫도 들어 있습니다.</p>` : ''}
      ${fixes.length ? `<p class="muted">자동으로 고친 것: ${fixes.join(' · ')}. 문제마다 아래 <b>리포트</b>에 무엇을 찾아 어떻게 고쳤는지 있습니다.</p>` : '<p class="muted">자동 검토에서 고칠 것이 없었습니다.</p>'}
      ${learned ? (learned.length ? `<div class="jt-learned"><b>이번 세트에서 배운 학습 ${learned.length}개</b> — 다음 세트부터 들어갑니다. 학습 메뉴에서 고치거나 끌 수 있습니다.
        <ul>${learned.map((l) => `<li><span class="lt-tag">${l.scope === 'common' ? '공통 학습' : '이 문제'}</span> ${inlineRich(l.text)}${l.why ? ` <span class="muted">— ${inlineRich(l.why)}</span>` : ''} <a href="#/learn/map/${l.scope === 'common' ? 'common' : 'p-' + job.materialId}">보기</a></li>`).join('')}</ul></div>`
        : '<p class="muted">이번 세트에서 새로 추가할 학습은 없었습니다.</p>') : ''}
    </section>`;
  }
  function bindHead(job) {
    $('#cancel')?.addEventListener('click', guard(async () => { await api('POST', `/api/jobs/${job.id}/cancel`); toast('취소를 요청했습니다.'); wake(); }));
    $('#resume')?.addEventListener('click', guard(async () => { await api('POST', `/api/jobs/${job.id}/resume`); toast('이어서 진행합니다.'); route(); }));
    $('#delete')?.addEventListener('click', guard(async () => {
      const no = /세트 (\d+)/.exec($('.jt-head h1')?.textContent || '')?.[1] || '';
      if (await deleteSet(no, job.items || [], job.id)) location.hash = '#/m/' + job.materialId;
    }));
    $$('[data-jump]').forEach((b) => b.addEventListener('click', () => $(`#item-${b.dataset.jump}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })));
  }

  function verificationHtml(v) {
    if (!v) return '<span class="muted small">아직 검증하지 않았습니다.</span>';
    const code = v.code || {};
    const blind = v.blind || {};
    const cstat = { pass: ['통과', 'ok'], fail: ['불일치', 'bad'], skip: ['수치 검산 대상 아님', ''] };
    return `
      <h3>코드 검산 ${chip(cstat, code.status)}</h3>
      <p class="muted small">모델이 쓴 검산 프로그램을 서버가 ${code.mode === 'number' ? '실수 계산(무리수 포함)' : '정확한 분수 계산'}으로 실행해 정답·선택지·조건을 확인합니다.</p>
      ${code.reasons?.length ? `<div class="note bad"><ul>${code.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul></div>` : ''}
      ${code.checks?.length ? `<ul class="small">${code.checks.map((c) => `<li>${c.ok ? '✅' : '❌'} ${esc(c.desc || c.expr)} <span class="muted">(${esc(c.expr)})</span></li>`).join('')}</ul>` : ''}
      ${code.values?.length ? `<pre class="values">${esc(code.values.join('\n'))}</pre>` : ''}
      <h3>독립 풀이 ${blind.answer ? chip({ ok: ['정답 일치', 'ok'], bad: ['정답 불일치', 'bad'] }, blind.match ? 'ok' : 'bad') : ''}</h3>
      <p class="muted small">정답과 해설을 보지 않은 별도 호출이 문제만 보고 풀었습니다.</p>
      <div class="kv"><div class="k">고른 답</div><div>${blind.answer ? circled(blind.answer) : '없음'} ${inlineRich(blind.answerValue || '')} ${blind.confident === false ? '<span class="chip warn">확신 낮음</span>' : ''}</div>
        <div class="k">필요했던 STEP</div><div>${(blind.stepsUsed || []).join(', ') || '-'} ${v.coverage ? `(목표: ${v.coverage.expected.join(', ')}) ${chip({ pass: ['범위 일치', 'ok'], warn: ['범위 확인', 'warn'] }, v.coverage.status)}` : ''}</div></div>
      ${blind.conditions?.length ? `<details data-k="conds"><summary>조건 사용 점검 (${blind.conditions.filter((c) => !c.used).length ? `안 쓰인 조건 ${blind.conditions.filter((c) => !c.used).length}개` : '모두 사용'})</summary><div class="inner"><ul class="small">${blind.conditions.map((c) => `<li>${c.used ? '✅' : '⚠️ 안 쓰임 —'} ${inlineRich(c.text)}</li>`).join('')}</ul></div></details>` : ''}
      ${blind.variation && blind.variation !== 'n/a' ? `<p class="small">원본 대비 변형: ${blind.variation === 'structural' ? '<span class="chip ok">구조 변형</span>' : '<span class="chip warn">숫자만 바뀜</span>'} ${inlineRich(blind.variationNote || '')}</p>` : ''}
      ${blind.issues?.length ? `<div class="note warn"><b>독립 풀이가 지적한 점</b><ul>${blind.issues.map((i) => `<li>[${esc(i.type)}] ${inlineRich(i.detail)}</li>`).join('')}</ul></div>` : ''}
      ${blind.solution ? `<details data-k="blind"><summary>독립 풀이 전문</summary><div class="inner rich">${rich(blind.solution)}</div></details>` : ''}`;
  }

  // Under the problem, its report: one line on how it was made (first design, fixed n times, or an answer that could
  // not be confirmed), and in a fold what each check found and what was done about it, what is left, and the learning
  // it kept or broke.
  const ATTEMPT_TXT = {
    rewrite: (n) => `해설이 선생님 해설과 달라 해설을 다시 씀 (${n}건)`,
    repair: (n) => `검토에서 ${n}건을 찾아 문제를 고침`,
    redesign: (n) => `고쳐도 ${n}건이 남아 처음부터 새로 설계`,
  };
  function checkLine(item) {
    const v = item.verification;
    const plain = (x) => String(x).replace(/^(문제 설계|STEP 범위|해설): /, '');
    const rules = v?.rules || [];
    const bad = rules.filter((r) => r.judged && !r.judged.ok);
    const ok = rules.filter((r) => r.judged?.ok).length;
    const list = (xs) => `<ul class="lt-ul">${xs.map((x) => `<li>${x}</li>`).join('')}</ul>`;
    if (legacyReview(item)) {
      const issues = [...new Set((item.problems || []).map(plain))];
      return `<div class="jt-need"><p><b>예전 방식으로 만든 문제라 자동 수정이 두 번에서 멈췄습니다.</b> 🔄 다시 만들기를 누르면 남은 점을 끝까지 자동으로 고쳐 다시 만듭니다.</p>
        <details data-k="check"><summary>남은 점 ${issues.length}가지</summary>${list(issues.map((x) => inlineRich(x)))}</details></div>`;
    }
    const steps = (item.attempts || []).filter((x) => ATTEMPT_TXT[x.kind]);
    // What is left, by what it touches. A broken learning item is listed once, under 학습 지킴.
    const notRule = (x) => !plain(x).startsWith('교사 지침 미준수');
    const inSolution = [...new Set((item.warnings || []).filter((x) => /^해설: /.test(x) && notRule(x)).map(plain))];
    const inProblem = [...new Set((item.warnings || []).filter((x) => !/^해설: /.test(x) && notRule(x)).map(plain))];
    const unsure = [...new Set((item.problems || []).map(plain))];
    const fixed = steps.length ? `자동으로 ${steps.length}번 고쳐 완성했습니다.` : '첫 설계로 검토를 통과했습니다.';
    // One sentence on what the teacher has to do, if anything.
    const head = item.status === 'needs_review'
      ? `<b>정답을 확정하지 못했습니다.</b> ${(item.redesigned || 0) + 1}번 설계하고 고쳐 봤지만 검산이나 독립 풀이와 정답이 맞지 않았습니다. 학생에게 내기 전에 정답을 확인해 주세요.`
      : inProblem.length ? `<b>${fixed}</b> 정답은 검증됐지만 문제 설계에서 끝내 못 고친 점이 ${inProblem.length}개 있습니다. 리포트를 보고 연습용으로 쓰기 어렵다면 🔄 다시 만들기를 누르세요.`
      : inSolution.length ? `<b>${fixed}</b> 문제와 정답은 검증됐습니다. 해설 표현이 선생님 해설과 다른 곳이 ${inSolution.length}군데 남았지만 따로 할 일은 없습니다. 학습지에 쓰기 전에 해설만 한번 훑어보세요.`
      : `<b>${fixed}</b>`;
    const tone = item.status === 'needs_review' ? 'bad' : inProblem.length ? 'warn' : 'ok';
    const body = [
      steps.length && `<ol class="jt-steps">${steps.map((x) => `<li>${ATTEMPT_TXT[x.kind]((x.failures || []).length)}${(x.failures || []).length ? list(x.failures.map((f) => inlineRich(plain(f)))) : ''}</li>`).join('')}</ol>`,
      unsure.length && `<div><b>정답이 맞지 않은 이유</b>${list(unsure.map((x) => inlineRich(x)))}</div>`,
      inProblem.length && `<div><b>문제에 남은 점</b>${list(inProblem.map((x) => inlineRich(x)))}</div>`,
      inSolution.length && `<div><b>해설에 남은 점</b>${list(inSolution.map((x) => inlineRich(x)))}</div>`,
      ok + bad.length && `<div><b>학습 지킴 ${ok}/${ok + bad.length}</b>${bad.length ? list(bad.map((r) => `어김: ${inlineRich(r.text)}${r.judged.note ? ` <span class="muted">— ${inlineRich(r.judged.note)}</span>` : ''}`)) : ''}</div>`,
    ].filter(Boolean);
    return `<div class="jt-report-item ${tone}"><p>${head}</p>${body.length ? `<details data-k="check"><summary>리포트 보기</summary><div class="jt-check-in">${body.join('')}</div></details>` : ''}</div>`;
  }

  // A problem of the set: its state, the problem itself first, the check line, then the review (채택 / 고칠 점 /
  // 다시 만들기) with the fix panel right under it; the solution and how it was made are folded below.
  function itemCard(job, item, busy) {
    const p = item.problem;
    const v = item.verification;
    if (v?.blind && p) v.blind.match = v.blind.answer === p.answer;
    const repairs = (item.attempts || []).filter((a) => a.kind === 'repair').length;
    const running = ['generating', 'verifying', 'repairing'].includes(item.status);
    const finished = p && ['passed', 'warning', 'needs_review'].includes(item.status);
    const state = item.adopted ? '<span class="chip ok">채택됨</span>'
      : item.status === 'warning' ? ((item.warnings || []).some((x) => !/^해설: /.test(x)) ? `<span class="chip warn">완성 · 남은 점 있음</span>` : '<span class="chip ok">완성</span>')
      : legacyReview(item) ? '<span class="chip bad">검토 필요</span>' : chip(ITEM_STATUS, item.status);
    const made = [
      item.examplesUsed && `채택한 문제 ${item.examplesUsed}개를 본보기로 참고`,
      repairs && `검토 후 고친 횟수 ${repairs}회`,
      item.redesigned && `새로 설계 ${item.redesigned}번 (${item.design}번째 설계를 씀)`,
      item.history?.length && `다시 만든 횟수 ${item.history.length}회`,
      item.usesSteps?.length && `사용한 원본 STEP ${item.usesSteps.join(', ')}`,
    ].filter(Boolean);
    return `<div class="item${item.adopted ? ' adopted' : ''}" data-item="${item.index}" id="item-${item.index}">
      <div class="head"><span class="num">문제 ${item.index + 1}</span><span>${esc(item.label)}</span><span class="spacer"></span>${busy ? '<span class="chip run">다시 만드는 중</span>' : state}</div>
      <div class="body">
        ${item.status === 'failed' ? `<div class="note bad">${esc(item.error || '만들지 못했습니다.')}</div>` : ''}
        ${!p ? `<p class="muted">${running ? '만드는 중입니다…' : item.status === 'pending' ? '차례를 기다리는 중입니다.' : ''}</p>` : `
          <div class="rich">${rich(p.text)}</div>
          ${p.figure ? `<div class="note info"><b>그림</b><div class="rich">${rich(p.figure)}</div></div>` : ''}
          ${choicesHtml(p)}
          ${checkLine(item)}`}
      </div>
      ${finished || item.status === 'failed' ? `<div class="review-bar">
        ${finished ? `<button class="rv-adopt${item.adopted ? ' on' : ''}" data-rv="adopt">${item.adopted ? '✓ 채택됨' : '👍 채택'}</button>` : ''}
        <button data-rv="fix">✏️ 고칠 점</button>
        <button data-rv="regen">🔄 다시<span class="rv-long"> 만들기</span></button></div>
      <details class="fix-panel" data-k="fb"><summary>고칠 점</summary><div class="fix-in">
        <textarea name="fb" rows="2" placeholder="이 문제에서 고칠 점. 예: 실험 Ⅲ의 남은 질량이 넣은 A보다 커서 가정 없이 풀립니다."></textarea>
        <div class="lt-actions"><span class="muted small">이 문제의 생성 학습으로 저장되어 다음 세트부터 들어갑니다.</span><span class="spacer"></span><button class="small" name="save">저장</button><button name="regen" class="small primary">저장하고 다시 만들기</button></div>
      </div></details>` : ''}
      ${p ? `
      <details data-k="sol"><summary>정답과 해설 — 정답 ${p.answer ? circled(p.answer) : '(서술형)'}</summary><div class="inner">
        ${(item.solution?.steps || []).map((s) => `<div class="step"><div class="head">${s.step ? `<span class="badge">원본 STEP ${s.step}</span>` : ''}${flat(s.title)}</div><div class="rich">${rich(s.work)}</div></div>`).join('')}
        ${item.solution?.summary ? `<p><b>정리</b> ${flat(item.solution.summary)}</p>` : ''}</div></details>
      <details data-k="more"><summary>만든 과정</summary><div class="inner">
        ${made.length ? `<p class="small muted">${made.join(' · ')}</p>` : ''}
        ${item.designNote ? `<h3>설계 의도</h3><div class="rich">${rich(item.designNote)}</div>` : ''}
        <h3>자동 검토</h3>${verificationHtml(v)}
        <h3>피드백을 지켰는지 (${v?.rules?.length || 0})</h3>${v?.rules?.length ? `<div class="table-wrap"><table class="rules"><tr><th>피드백·지침</th><th>AI가 밝힌 적용 방법</th><th>독립 검토</th></tr>${v.rules.map((r) => `<tr><td>${inlineRich(r.text)}</td><td>${esc(r.how || '— (언급 없음)')}</td><td>${r.judged ? (r.judged.ok ? '✅ ' : '❌ ') + esc(r.judged.note || '') : '<span class="muted">해설 지침은 원문 확인</span>'}</td></tr>`).join('')}</table></div>` : '<p class="muted small">붙인 피드백이 없습니다.</p>'}
        ${item.history?.length ? `<h3>이전 버전 (${item.history.length})</h3>${item.history.map((h) => `<div class="note"><div class="small muted">${fmtTime(h.replacedAt)} 교체 · 남긴 점: ${esc(h.feedback || '없음')}</div><div class="rich">${rich(h.problem?.text || '')}</div>${h.problem ? choicesHtml(h.problem) : ''}</div>`).join('')}` : ''}
      </div></details>` : ''}
    </div>`;
  }

  function bindItem(job, item, card) {
    const panel = $('.fix-panel', card);
    // Saves what the teacher wrote as this problem's generation learning (with this variant attached), then remakes this
    // problem if asked.
    const notYet = () => {
      if (['queued', 'running'].includes(job.status)) {
        const made = job.items.filter((i) => ['passed', 'warning', 'needs_review', 'failed'].includes(i.status)).length;
        return `세트를 다 만든 뒤에 다시 만들 수 있습니다 (지금 ${made}/${job.items.length} 완성). 고칠 점은 지금 저장해 둘 수 있습니다.`;
      }
      if (card.querySelector('.head .chip.run')) return '이 문제를 다시 만드는 중입니다. 끝나면 다시 만들 수 있습니다.';
      return '';
    };
    const save = async (andRegen) => {
      if (andRegen && notYet()) throw new Error(notYet());
      const note = $('textarea[name=fb]', card)?.value.trim() || '';
      if (!note && !andRegen) throw new Error('고칠 점을 적어 주세요.');
      if (note) await teach({ text: note, stage: 'generation', jobId: job.id, itemIndex: item.index, from: 'fix' });
      if (andRegen) { await api('POST', `/api/jobs/${job.id}/items/${item.index}/regenerate`, { feedback: note }); wake(); }
      if ($('textarea[name=fb]', card)) $('textarea[name=fb]', card).value = '';
      toast(andRegen ? `${note ? '생성 학습에 더하고 ' : ''}이 문제를 다시 만드는 중입니다.` : '생성 학습에 더했습니다. 다음 세트부터 들어갑니다.');
    };
    $('button[name=save]', card)?.addEventListener('click', guard(() => save(false)));
    $('button[name=regen]', card)?.addEventListener('click', guard(async (e) => {
      if (notYet()) throw new Error(notYet());
      e.target.disabled = true;
      try { await save(true); } finally { if (e.target.isConnected) e.target.disabled = false; }
    }));
    // The review bar: 채택 toggles at once; 고칠 점 opens or closes the panel right under it; 다시 만들기 uses what is picked in it.
    $('[data-rv="adopt"]', card)?.addEventListener('click', guard(async (e) => {
      const r = await api('PUT', `/api/jobs/${job.id}/items/${item.index}/review`, { adopted: !item.adopted });
      item.adopted = r.adopted;
      card.classList.toggle('adopted', r.adopted);
      e.target.classList.toggle('on', r.adopted);
      e.target.textContent = r.adopted ? '✓ 채택됨' : '👍 채택';
      const state = $('.head .chip', card);
      if (state && !item.status.match(/ing$/)) state.outerHTML = r.adopted ? '<span class="chip ok">채택됨</span>' : chip(ITEM_STATUS, item.status);
      toast(r.adopted ? '채택했습니다. 다음 세트에서 같은 단계 문제의 본보기가 됩니다.' : '채택을 취소했습니다.');
    }));
    $('[data-rv="fix"]', card)?.addEventListener('click', () => { if (panel) panel.open = !panel.open; });
    $('[data-rv="regen"]', card)?.addEventListener('click', guard(async (e) => {
      if (notYet()) throw new Error(notYet());
      const picked = $('textarea[name=fb]', card)?.value.trim();
      if (!picked && !confirm('고칠 점 없이 이 문제를 다시 만들까요? (이 문제의 생성 학습은 모두 반영됩니다)')) return;
      e.target.disabled = true;
      try { await save(true); } finally { if (e.target.isConnected) e.target.disabled = false; }
    }));
  }

  // ------------------------------------------------------------------ model comparison
  // The same molar-mass original made into a problem set by each model: what worked, what did not, the PDF.
  async function compareView(id) {
    const list = await api('GET', '/api/compare');
    if (!list.length) { view.innerHTML = '<h1>모델 비교</h1><div class="panel muted">아직 비교 자료가 없습니다.</div>'; return; }
    const [b, status] = await Promise.all([api('GET', '/api/compare/' + (id || list[0].id)), api('GET', '/api/status')]);
    view.innerHTML = '<h1>모델 비교</h1>' + window.EMCompare.pageHtml(b, { pdfBase: 'api/compare', selectable: Boolean(status.providers?.relay), balance: true });
    api('GET', '/api/balance').then((x) => { if ($('#balance')) $('#balance').textContent = x.balance; }).catch(() => { if ($('#balance')) $('#balance').textContent = '확인 실패'; });
  }

  // ------------------------------------------------------------------ 학습 (docs/learning.md)
  // Two tabs. 학습 지도: every item in one place — the summary (how many, how many lately, what one problem gets against
  // the cap), a tree by where items apply (지침, 공통 학습 by stage and target, each problem's own), the items of the
  // chosen branch with how they fared on the recent sets, and the pairs the AI found to say the same thing (정리 후보).
  // 하네스: how results are checked and fixed.
  const LEARN_TABS = [['map', '학습 지도'], ['harness', '하네스']];
  async function learnView(tab, node) {
    view.innerHTML = `<div class="lt lm">
      <div class="lt-title"><h1>학습</h1><p class="lt-meta">AI가 문제를 분석하고 만들 때 따르는 것들입니다. 부딪히면 <b>지침 → 문제별 학습 → 공통 학습</b> 순서로 따릅니다.</p></div>
      <nav class="lt-tabs" role="tablist">${LEARN_TABS.map(([k, label]) => `<button type="button" role="tab" data-learn-tab="${k}" class="lt-tab${k === tab ? ' on' : ''}" aria-selected="${k === tab}">${label}</button>`).join('')}</nav>
      <div id="learn-pane" class="${tab === 'harness' ? 'stage' : 'lm-pane'}"></div>
    </div>`;
    $$('[data-learn-tab]').forEach((b) => b.addEventListener('click', () => { location.hash = '#/learn/' + b.dataset.learnTab; }));
    const pane = $('#learn-pane');
    if (tab === 'harness') await harnessView(pane);
    else await learnMap(pane, node);
  }

  // The tree: a branch is a filter over the items. Adding is offered where the branch fixes what is added.
  const LM_ADD = {
    'guide-a': { stage: 'analysis', layer: 'guide', hint: '예: 연필·색 펜 필기는 문제 조건에 넣지 않는다.' },
    'guide-g': { stage: 'generation', layer: 'guide', target: 'all', hint: '예: 풀이에 쓰이지 않는 조건이나 서술을 넣지 않는다.' },
    'lesson-a': { stage: 'analysis', layer: 'lesson', hint: '예: 해설의 step 하나에 판단이 여러 개 있으면 판단마다 STEP을 나눈다.' },
    'lesson-p': { stage: 'generation', layer: 'lesson', target: 'problem', hint: '예: 수는 계산기 없이 풀리게 작은 정수로 잡는다.' },
    'lesson-s': { stage: 'generation', layer: 'lesson', target: 'solution', hint: '예: 해설의 비례식은 선생님 해설과 같은 순서로 쓴다.' },
    'lesson-all': { stage: 'generation', layer: 'lesson', target: 'all', hint: '예: 연습 문제와 해설 모두 목표 STEP 밖의 값을 쓰지 않는다.' },
  };
  const lmFilter = (node) => {
    const gen = (x) => x.stage === 'generation';
    const f = {
      all: () => true,
      guides: (x) => x.layer === 'guide', 'guide-a': (x) => x.layer === 'guide' && !gen(x), 'guide-g': (x) => x.layer === 'guide' && gen(x),
      common: (x) => x.layer === 'lesson', 'lesson-a': (x) => x.layer === 'lesson' && !gen(x),
      'lesson-p': (x) => x.layer === 'lesson' && gen(x) && ['problem', 'design'].includes(x.target),
      'lesson-s': (x) => x.layer === 'lesson' && gen(x) && x.target === 'solution',
      'lesson-all': (x) => x.layer === 'lesson' && gen(x) && x.target === 'all',
      problems: (x) => x.layer === 'problem',
    }[node];
    if (f) return f;
    if (node.startsWith('p-')) return (x) => x.layer === 'problem' && x.materialId === node.slice(2);
    return () => false;
  };
  const LM_FROM = { input: '직접 입력', check: '확인할 곳에서', fix: '고칠 점에서', auto: '세트 자동', migrated: '옮겨 옴', promote: '올림', merge: '합침' };
  const LM_PROVIDER = { 'claude-cli': 'Claude', 'agy-cli': 'Gemini', 'codex-cli': 'GPT', deepseek: 'DeepSeek', relay: 'Claude', claude: 'Claude', gemma: 'PC' };
  const LM_MARK = { k: '지킴', b: '어김', u: '넣었지만 판정 없음' };
  const LM_LAYER = { guide: '지침', lesson: '공통 학습', problem: '문제별' };
  const lmDay = (iso) => { const d = new Date(iso); return `${d.getMonth() + 1}/${d.getDate()}`; };
  const lmSetName = (s) => `${fmtTime(s.at)} ${LM_PROVIDER[s.provider] || s.provider || ''}`.trim();
  // How an item is doing, in a word: switched off, maybe the same as another, often broken, not carried yet, kept.
  function lmState(x, pairIds) {
    if (x.status !== 'approved') return ['꺼짐', 'idle'];
    if (pairIds.has(x.id)) return ['겹침 의심', 'warn'];
    if (x.stage === 'analysis') return x.uses ? [`분석 ${x.uses}번 반영`, 'ok'] : ['아직 안 쓰임', 'idle'];
    if (x.broken >= 2 && x.broken >= x.kept) return ['자주 어김', 'bad'];
    if (!x.uses) return ['아직 안 쓰임', 'idle'];
    if (!x.kept && !x.broken) return ['판정 전', 'idle'];
    return ['잘 지킴', 'ok'];
  }
  const lmOpen = { item: null, edit: null, cand: null };
  async function learnMap(pane, node = 'all') {
    pane.innerHTML = '<p class="muted">불러오는 중…</p>';
    let polls = 0;
    const paint = async () => {
      const d = await api('GET', '/api/learning');
      if (!pane.isConnected) return;
      const M = d.map;
      const items = M.items;
      const pairIds = new Set(M.candidates.flatMap((c) => [c.a.id, c.b.id]));
      const titleOf = new Map(d.problems.map((p) => [p.id, p.title]));
      const problemIds = [...new Set(items.filter((x) => x.layer === 'problem').map((x) => x.materialId))];
      if (node.startsWith('p-') && !problemIds.includes(node.slice(2))) node = 'problems';
      const on = items.filter((x) => x.status === 'approved');
      const count = (n) => on.filter(lmFilter(n)).length;
      const dotOf = (list) => (list.some((x) => ['warn', 'bad'].includes(lmState(x, pairIds)[1])) ? 'warn' : list.some((x) => lmState(x, pairIds)[1] === 'ok') ? 'ok' : '');
      const leaf = (id, label, depth, n = count(id)) => `<button type="button" class="lm-node d${depth}${node === id ? ' on' : ''}" data-node="${id}" title="${esc(label)}"><span class="lm-dot ${dotOf(items.filter(lmFilter(id)))}"></span><span class="lm-label">${esc(label)}</span><span class="n">${n || ''}</span></button>`;
      const tree = [
        leaf('all', '전체', 0, on.length),
        `<div class="lm-group">지침</div>`, leaf('persona', '페르소나', 1, d.persona ? 1 : 0), leaf('guide-a', '분석 지침', 1), leaf('guide-g', '생성 지침', 1),
        `<div class="lm-group">공통 학습</div>`, leaf('lesson-a', '원본 읽기', 1), leaf('corr', '읽기 교정', 1, d.corrections.length),
        leaf('lesson-p', '문제 만들기', 1), leaf('lesson-s', '해설 쓰기', 1), leaf('lesson-all', '문제와 해설', 1),
        `<div class="lm-group">문제별 학습</div>`, ...problemIds.map((id) => leaf('p-' + id, titleOf.get(id) || '삭제된 문제', 1)),
        problemIds.length ? '' : '<p class="lm-none">아직 없습니다</p>',
      ].join('');
      const label = { all: '전체', persona: '페르소나', 'guide-a': '분석 지침', 'guide-g': '생성 지침', 'lesson-a': '원본 읽기', corr: '읽기 교정', 'lesson-p': '문제 만들기', 'lesson-s': '해설 쓰기', 'lesson-all': '문제와 해설', guides: '지침', common: '공통 학습', problems: '문제별 학습' }[node] || titleOf.get(node.slice(2)) || '';
      const NOTE = {
        all: '모든 학습입니다. 왼쪽에서 분류를 고르면 그 분류만 보고, 새 학습을 넣을 수 있습니다.',
        persona: '분석·생성·검토, 모든 AI 호출의 맨 앞에 붙는 AI의 역할입니다.',
        'guide-a': '원본을 읽고 STEP으로 정리할 때 반드시 지킬 것입니다. 모든 문제에 가장 먼저 들어갑니다.',
        'guide-g': '변형 문제를 만들 때 반드시 지킬 것입니다. 만든 문제마다 지켰는지 검사합니다.',
        'lesson-a': '모든 문제를 분석할 때 들어가는 교훈입니다. 한 문제의 학습과 부딪히면 그 문제의 것을 따릅니다.',
        corr: '사진에서 잘못 읽은 단어입니다. 분석 결과를 고치면 자동으로 쌓이고, 다음 분석부터 그 단어를 주의해서 읽습니다.',
        'lesson-p': '모든 문제의 변형을 설계할 때 들어갑니다.', 'lesson-s': '모든 문제의 해설을 쓸 때 들어갑니다.', 'lesson-all': '모든 문제의 변형과 해설에 함께 들어갑니다.',
      }[node] || (node.startsWith('p-') ? '이 문제에만 들어가는 학습입니다. 새 학습은 문제 페이지에서 결과를 보며 넣습니다.' : '');
      const list = items.filter(lmFilter(node));
      const often = list.filter((x) => lmState(x, pairIds)[0] === '자주 어김').length;
      const sets = M.sets;
      const markCells = (x) => (x.marks ? `<span class="lm-cells" aria-label="최근 세트">${x.marks.map((k, i) => `<i class="${k}" title="${esc(lmSetName(sets[i]))} · ${LM_MARK[k] || '없던 학습'}"></i>`).join('')}</span>` : '<span class="lm-cells"></span>');
      const chips = (x) => [
        node === 'all' || node === 'problems' ? `<span class="lm-chip">${x.layer === 'problem' ? esc(titleOf.get(x.materialId) || '문제별') : LM_LAYER[x.layer]}</span>` : '',
        `<span class="lm-chip${x.from === 'auto' ? ' auto' : ''}">${LM_FROM[x.from] || '직접 입력'} · ${lmDay(x.createdAt)}</span>`,
        x.merged ? `<span class="lm-chip">${x.merged}개를 합침</span>` : '',
        node === 'all' || node.startsWith('p-') || node === 'problems' ? `<span class="lm-chip">${x.stage === 'analysis' ? '분석' : `생성 · ${TARGET_TXT[x.target] || '전체'}`}</span>` : '',
        x.stage === 'generation' ? `<span class="lm-chip">${x.uses}번 쓰임</span>` : '',
      ].join('');
      const row = (x) => {
        const [st, cls] = lmState(x, pairIds);
        const open = lmOpen.item === x.id;
        const editing = lmOpen.edit === x.id;
        const used = x.marks ? x.marks.map((k, i) => (k === '-' ? '' : `<a href="#/j/${sets[i].id}">${esc(lmSetName(sets[i]))}</a> ${LM_MARK[k]}`)).filter(Boolean).join(' · ') : '';
        const moves = [['guide', '지침'], ['lesson', '공통 학습'], ...(x.fromProblem ? [['problem', '이 문제만']] : [])].filter(([k]) => k !== x.layer);
        return `<div class="lm-item${open ? ' open' : ''}${x.status === 'approved' ? '' : ' off'}" data-item="${x.id}">
          <button type="button" class="lm-row" data-toggle aria-expanded="${open}">
            <span class="lm-txt"><strong>${inlineRich(x.text)}</strong><span class="lm-chips">${chips(x)}</span></span>
            ${markCells(x)}<span class="lm-state ${cls}">${st}</span>
          </button>
          ${open ? `<div class="lm-detail">
            ${editing ? `<div class="lm-edit"><textarea data-f="text" rows="3">${esc(x.text)}</textarea>
              <div class="lt-actions">${x.stage === 'generation' ? `<label class="fb-target-label">대상</label><select data-f="target">${targetOptions(x.target === 'design' ? 'problem' : x.target)}</select>` : ''}<span class="spacer"></span><button class="small" data-act="cancel">취소</button><button class="small primary" data-act="save">저장</button></div></div>` : ''}
            <dl class="lm-kv">
              <dt>근거</dt><dd>${x.evidence.length ? x.evidence.map((e) => `<div class="lm-quote">${inlineRich(e)}</div>`).join('') : '<span class="muted">선생님이 직접 넣음</span>'}${x.from === 'auto' && x.jobId ? ` <a href="#/j/${x.jobId}">그 세트 보기</a>` : ''}</dd>
              ${x.stage === 'generation' ? `<dt>결과</dt><dd>${x.kept + x.broken ? `지킴 ${x.kept}${x.broken ? ` · <span class="bad">어김 ${x.broken}</span>` : ''}` : '아직 판정 없음'}${used ? `<div class="muted small">최근 세트: ${used}</div>` : ''}</dd>` : `<dt>결과</dt><dd>${x.uses ? `분석 ${x.uses}번에 들어감` : '아직 이 학습으로 분석한 문제가 없습니다'}</dd>`}
              ${pairIds.has(x.id) ? '<dt>겹침</dt><dd>AI가 다른 학습과 같은 지시라고 봤습니다. 아래 <b>정리 후보</b>에서 합치거나 따로 둡니다.</dd>' : ''}
              ${x.learnedOn ? `<dt>배운 곳</dt><dd>${esc(x.learnedOn)}</dd>` : ''}
            </dl>
            <div class="lt-actions">${editing ? '' : '<button class="small" data-act="edit">고치기</button>'}
              ${moves.length ? `<select class="lm-move" data-act="move" aria-label="옮기기"><option value="">옮기기…</option>${moves.map(([k, t]) => `<option value="${k}">${t}로</option>`).join('')}</select>` : ''}
              <button class="small" data-act="onoff">${x.status === 'approved' ? '끄기' : '다시 켜기'}</button><span class="spacer"></span><button class="small danger" data-act="del">삭제</button></div>
          </div>` : ''}
        </div>`;
      };
      const persona = () => `<div class="lm-item open"><div class="lm-detail lm-persona">
          <textarea id="lm-persona" rows="4" placeholder="예: 고등학교 화학 선생님의 출제를 돕는 조교로서, 학생이 읽는 문장은 교과서 말투로 쓰고 단위를 빠뜨리지 않는다.">${esc(d.persona)}</textarea>
          <div class="lt-actions"><span class="muted small">${d.persona ? '모든 AI 호출의 맨 앞에 붙습니다' : '아직 정하지 않았습니다'}</span><span class="spacer"></span><button class="small primary" id="lm-persona-save">저장</button></div></div></div>`;
      const corrections = () => d.corrections.map((c) => `<div class="lm-item" data-corr="${c.id}"><div class="lm-row lm-static">
          <span class="lm-txt"><strong>"${esc(c.wrong)}" → "${esc(c.right)}"</strong><span class="lm-chips"><span class="lm-chip">${c.count}번 고침</span>${c.subject ? `<span class="lm-chip">${esc(c.subject)}</span>` : ''}</span></span>
          <span></span><button class="small danger" data-act="del-corr">삭제</button></div></div>`).join('');
      const body = node === 'persona' ? persona() : node === 'corr' ? corrections() : list.map(row).join('');
      const empty = node === 'corr' ? '아직 읽기 교정이 없습니다.' : '이 분류에는 아직 학습이 없습니다.';
      const add = LM_ADD[node];
      const L = M.load;
      const loadPct = L ? Math.min(100, Math.round(100 * Math.max(L.items / L.limit, L.chars / L.maxChars))) : 0;
      const off = items.length - on.length;
      pane.innerHTML = `
        <section class="lm-tiles" aria-label="학습 요약">
          <div class="lm-tile"><b>${on.length}</b><span>켜진 학습 (지침 ${on.filter((x) => x.layer === 'guide').length} · 공통 ${on.filter((x) => x.layer === 'lesson').length} · 문제별 ${on.filter((x) => x.layer === 'problem').length})${off ? ` · 꺼짐 ${off}` : ''}</span></div>
          <div class="lm-tile"><b>+${M.recent.added}</b><span>최근 7일 늘어남${M.recent.added ? ` · 자동 ${M.recent.auto}` : ''}</span></div>
          <div class="lm-tile${M.candidates.length ? ' warn' : ''}"><b>${M.candidates.length}</b><span>정리 후보${M.checking ? ` · AI가 ${M.checking}쌍 확인 중` : ''}</span></div>
          <div class="lm-tile${loadPct >= 90 ? ' warn' : ''}"><b>${L ? `${L.items} / ${L.limit}` : '–'}</b><span>${L ? `${esc(L.title)}의 다음 세트에 넣는 생성 학습` : '아직 문제가 없습니다'}</span>${L ? `<div class="lm-meter" title="개수 ${L.items}/${L.limit} · 글자 ${L.chars.toLocaleString()}/${L.maxChars.toLocaleString()}"><i style="width:${loadPct}%"></i></div>` : ''}</div>
        </section>
        <div class="lm-body">
          <nav class="lm-tree" aria-label="학습 분류">${tree}</nav>
          <div class="lm-main">
            <div class="lm-head"><div><h2>${esc(label)}</h2><p>${esc(NOTE)}${node.startsWith('p-') ? ` <a href="#/m/${node.slice(2)}">문제 열기</a>` : ''}</p></div>
              ${list.some((x) => x.marks) && !['persona', 'corr'].includes(node) ? `<div class="lm-legend"><span><i class="k"></i>지킴</span><span><i class="b"></i>어김</span><span><i class="u"></i>판정 없음</span><span><i></i>없던 학습</span><span class="muted">· 칸은 최근 세트 ${sets.length}개</span></div>` : ''}</div>
            ${node === 'persona' || node === 'corr' ? '' : `<p class="lm-count">${list.length}개${often ? ` · <span class="bad">자주 어김 ${often}</span>` : ''}</p>`}
            <div class="lm-list">${body || `<p class="lm-empty">${empty}</p>`}</div>
            ${add ? `<div class="lm-add"><textarea id="lm-add-text" rows="2" placeholder="${esc(add.hint)}"></textarea><div class="lt-actions"><span class="muted small">${esc(label)}에 넣으면 ${add.layer === 'guide' ? '모든 문제에 가장 먼저 들어갑니다' : '모든 문제에 들어갑니다'}</span><span class="spacer"></span><button class="small primary" id="lm-add">추가</button></div></div>` : ''}
            <section class="lm-inbox" aria-label="정리 후보">
              <div class="lm-inbox-head"><b>정리 후보</b><span>AI가 같은 지시라고 본 학습입니다. 합치면 두 원문은 근거로 남습니다.</span></div>
              ${M.candidates.map((c) => `<div class="lm-cand" data-cand="${esc(c.key)}">
                <div class="lm-pair"><div><small>${LM_LAYER[c.a.layer]}</small>${inlineRich(c.a.text)}</div><div><small>${LM_LAYER[c.b.layer]}</small>${inlineRich(c.b.text)}</div></div>
                ${lmOpen.cand === c.key ? `<textarea data-f="merged" rows="3">${esc(c.text)}</textarea>` : `<div class="lm-merged"><small>합친 문장 (AI 제안)</small>${inlineRich(c.text)}</div>`}
                ${c.why ? `<p class="muted small">${inlineRich(c.why)}</p>` : ''}
                <div class="lt-actions"><button class="small" data-act="skip">따로 두기</button><span class="spacer"></span>${lmOpen.cand === c.key ? '' : '<button class="small" data-act="edit-merged">합친 문장 고치기</button>'}<button class="small primary" data-act="merge">합치기</button></div></div>`).join('')
              || `<p class="lm-done">${M.checking ? `AI가 표현이 겹치는 학습 ${M.checking}쌍을 확인하는 중입니다.` : '정리할 학습이 없습니다.'}</p>`}
            </section>
          </div>
        </div>`;
      // On a phone the tree is one scrolling row: keep the chosen branch in view.
      const tr = $('.lm-tree', pane), onNode = $('.lm-node.on', pane);
      if (tr && onNode && getComputedStyle(tr).display === 'flex' && tr.scrollWidth > tr.clientWidth) tr.scrollLeft = onNode.offsetLeft - (tr.clientWidth - onNode.offsetWidth) / 2;
      $$('[data-node]', pane).forEach((b) => b.addEventListener('click', () => {
        lmOpen.item = lmOpen.edit = null;
        history.replaceState(null, '', '#/learn/map/' + b.dataset.node);
        node = b.dataset.node; paint();
      }));
      $$('.lm-item[data-item]', pane).forEach((el) => {
        const x = items.find((i) => i.id === el.dataset.item);
        $('[data-toggle]', el).addEventListener('click', () => { lmOpen.item = lmOpen.item === x.id ? null : x.id; lmOpen.edit = null; paint(); });
        const act = (name, fn) => { const b = $(`[data-act=${name}]`, el); if (b) b.addEventListener(name === 'move' ? 'change' : 'click', guard(fn)); };
        act('edit', async () => { lmOpen.edit = x.id; await paint(); $('[data-f=text]', pane)?.focus(); });
        act('cancel', async () => { lmOpen.edit = null; await paint(); });
        act('save', async () => {
          await api('PUT', '/api/rules/' + x.id, { text: $('[data-f=text]', el).value, ...($('[data-f=target]', el) ? { target: $('[data-f=target]', el).value } : {}) });
          lmOpen.edit = null; toast('저장했습니다.'); await paint();
        });
        act('onoff', async () => {
          await api('PUT', '/api/rules/' + x.id, { status: x.status === 'approved' ? 'pending' : 'approved' });
          toast(x.status === 'approved' ? '껐습니다. 다음 분석·세트부터 들어가지 않습니다.' : '다시 켰습니다.'); await paint();
        });
        act('move', async (e) => {
          const to = e.target.value;
          if (!to) return;
          await api('PUT', '/api/rules/' + x.id, to === 'problem' ? { scope: 'material' } : { scope: 'global', layer: to });
          toast(`${to === 'problem' ? '이 문제의 학습' : LM_LAYER[to]}으로 옮겼습니다.`); await paint();
        });
        act('del', async () => {
          if (!confirm('이 학습을 삭제할까요?')) return;
          await api('DELETE', '/api/rules/' + x.id);
          lmOpen.item = null; await paint();
        });
      });
      $$('[data-corr] [data-act=del-corr]', pane).forEach((b) => b.addEventListener('click', guard(async () => {
        if (!confirm('이 읽기 교정을 삭제할까요?')) return;
        await api('DELETE', '/api/corrections/' + b.closest('[data-corr]').dataset.corr);
        await paint();
      })));
      $('#lm-persona-save', pane)?.addEventListener('click', guard(async () => {
        await api('PUT', '/api/persona', { persona: $('#lm-persona', pane).value }); toast('페르소나를 저장했습니다.'); await paint();
      }));
      $('#lm-add', pane)?.addEventListener('click', guard(async () => {
        const text = $('#lm-add-text', pane).value.trim();
        if (!text) throw new Error('내용을 적어 주세요.');
        await teach({ text, stage: add.stage, scope: add.layer, target: add.target || 'all' });
        toast(add.layer === 'guide' ? '지침에 넣었습니다. 모든 문제에 가장 먼저 들어갑니다.' : '공통 학습에 넣었습니다. 모든 문제에 들어갑니다.');
        await paint();
      }));
      $$('[data-cand]', pane).forEach((el) => {
        const key = el.dataset.cand;
        const act = (name, fn) => $(`[data-act=${name}]`, el)?.addEventListener('click', guard(fn));
        act('edit-merged', async () => { lmOpen.cand = key; await paint(); });
        act('skip', async () => { await api('POST', '/api/learning/skip', { key }); lmOpen.cand = null; toast('따로 두었습니다. 다시 묻지 않습니다.'); await paint(); });
        act('merge', async () => {
          const c = M.candidates.find((x) => x.key === key);
          const text = $('[data-f=merged]', el)?.value ?? c.text;
          await api('POST', '/api/learning/merge', { key, text });
          lmOpen.cand = null; toast('합쳤습니다. 두 원문은 근거에 남았습니다.'); await paint();
        });
      });
      // The AI is still checking pairs: look again in a while (not while the teacher is writing).
      if (M.checking && polls++ < 20) setTimeout(() => { if (pane.isConnected && !lmOpen.edit && !lmOpen.cand && !pane.contains(document.activeElement?.closest('textarea') || null)) paint().catch(() => {}); }, 8000);
    };
    await paint();
  }

  // 하네스: how a set is checked and fixed (in the order it happens, with the counts the settings give), how that went on
  // the recent sets, the counts the teacher can change, and every check with what happens when it fails and how often
  // it did. The numbers say what the harness does now; the checks are fixed in code.
  const HN_SETTINGS = [
    ['maxRewrites', '해설 다시 쓰기', '해설만 선생님 해설과 다를 때 문제는 두고 해설만 다시 쓰는 횟수 (설계마다)'],
    ['maxRepairs', '문제 수정', '문제에 결함이 있을 때 고치게 하는 횟수 (설계마다). 같은 지적이 되풀이되면 일찍 멈춘다'],
    ['maxDesigns', '설계 횟수', '고쳐도 남으면 처음부터 새로 설계한다. 첫 설계를 포함한 최대 횟수 (문제마다)'],
    ['setCalls', '세트당 AI 호출 상한', '한 세트가 쓸 수 있는 AI 호출 수. 뒤 문제를 만들 몫은 남겨 두고 고친다'],
  ];
  async function harnessView(pane) {
    pane.innerHTML = '<p class="muted">불러오는 중…</p>';
    const paint = async () => {
      const h = await api('GET', '/api/harness');
      if (!pane.isConnected) return;
      const { settings: v, stats: st, limits } = h;
      const fired = new Map(st.checks.map((c) => [c.label, c]));
      const checkRow = (c, withStats) => {
        const f = fired.get(c.label);
        return `<div class="lt-row lt-plain"><div class="lt-main"><span class="lt-name">${esc(c.label)}</span><span class="lt-sub lt-wrap">${esc(c.how)}</span>
          ${withStats && st.problems ? `<span class="lt-sub">최근 ${st.problems}문제 중 걸림 <b>${f?.fired || 0}</b> · 끝내 남음 <b>${f?.left || 0}</b></span>` : ''}</div>
          <span class="hn-fail ${c.onFail}">${esc(h.onFail[c.onFail] || '')}</span></div>`;
      };
      pane.innerHTML = `
        <p class="lp-intro">하네스는 AI가 만든 문제를 서버가 검사하고 스스로 고치는 장치입니다. 문제마다 아래 순서로 돌고, 선생님에게 넘기는 것은 정답을 확정하지 못한 문제뿐입니다.</p>
        <section class="lt-sec"><div class="lt-sec-head"><h2>문제 하나를 만드는 순서</h2></div>
          <ol class="hn-flow panel">
            <li><b>설계</b><span>지침·학습·본보기를 넣어 문제, 해설, 검산 프로그램을 만든다.</span></li>
            <li><b>검사</b><span>코드 검산, 정답을 모르는 독립 풀이, 선생님 해설과의 대조, 코드 점검까지 아래 ${h.checks.generation.length}가지.</span></li>
            <li><b>고치기</b><span>해설만 다르면 해설만 다시 쓴다(최대 ${v.maxRewrites}번). 문제에 결함이 있으면 고친다(최대 ${v.maxRepairs}번).</span></li>
            <li><b>새로 설계</b><span>그래도 남으면 남은 점을 알려 주고 처음부터 다시 설계한다. 문제마다 최대 ${v.maxDesigns}번.</span></li>
            <li><b>마무리</b><span>결함이 가장 적은 설계를 남기고 문제마다 리포트를 쓴다. 세트가 끝나면 나온 실수를 학습으로 정리해 자동으로 넣는다.</span></li>
          </ol></section>
        <section class="lt-sec"><div class="lt-sec-head"><h2>최근 성적</h2><p>최근 세트 ${st.sets}개에서 만든 문제입니다.</p></div>
          <div class="panel hn-stats">${st.problems ? [
            ['문제', st.problems], ['첫 설계로 통과', st.first], ['고쳐서 완성', st.made - st.first], ['정답 확인 필요', st.answer], ['못 만듦', st.failed],
            ['세트당 호출', `${st.calls}번`], ['세트당 시간', `${st.minutes}분`],
          ].map(([k, n]) => `<div><b>${n}</b><span>${k}</span></div>`).join('') : '<p class="muted">아직 만든 세트가 없습니다.</p>'}</div></section>
        <section class="lt-sec"><div class="lt-sec-head"><h2>설정</h2><p>바꾼 값은 새로 만드는 세트부터 적용됩니다. 횟수를 늘리면 더 끝까지 고치지만 시간과 호출이 늘어납니다.</p></div>
          <form class="panel hn-form" id="hn-form">${HN_SETTINGS.map(([k, label, sub]) => `<div class="hn-set">
              <label for="hn-${k}">${label}</label>
              <input type="number" id="hn-${k}" name="${k}" min="${limits[k][0]}" max="${limits[k][1]}" step="1" value="${v[k]}" required>
              <p class="muted small">${sub} (${limits[k][0]}~${limits[k][1]}, 기본 ${limits[k][2]})</p></div>`).join('')}
            <div class="lt-actions"><button type="button" class="small" id="hn-reset">기본값으로</button><span class="spacer"></span><button type="submit" class="small primary">저장</button></div>
          </form></section>
        <section class="lt-sec"><div class="lt-sec-head"><h2>생성 검사</h2><p>만든 문제마다 이 검사를 모두 거칩니다. 오른쪽은 걸렸을 때 하네스가 하는 일입니다.</p></div>
          <div class="panel lt-list">${h.checks.generation.map((c) => checkRow(c, true)).join('')}</div></section>
        <section class="lt-sec"><div class="lt-sec-head"><h2>원본 분석 검사</h2><p>사진을 읽고 STEP으로 정리할 때 거치는 검사입니다.</p></div>
          <div class="panel lt-list">${h.checks.analysis.map((c) => checkRow(c, false)).join('')}</div></section>`;
      $('#hn-form', pane).addEventListener('submit', guard(async (e) => {
        e.preventDefault();
        const body = Object.fromEntries(HN_SETTINGS.map(([k]) => [k, Number($('#hn-' + k, pane).value)]));
        await api('PUT', '/api/harness', body);
        toast('저장했습니다. 새로 만드는 세트부터 적용됩니다.');
        await paint();
      }));
      $('#hn-reset', pane).addEventListener('click', () => { for (const [k] of HN_SETTINGS) $('#hn-' + k, pane).value = limits[k][2]; });
    };
    await paint();
  }

  // ------------------------------------------------------------------ Claude login
  // Signing the server's Claude Code in to the teacher's Claude subscription (for the "Claude Opus 5.5 (구독)" model):
  // the server shows the sign-in link, the teacher signs in on any device and pastes the code here.
  async function claudeLoginPanel() {
    const el = $('#claude-login');
    if (!el) return;
    const st = await api('GET', '/api/claude-login');
    if (st.loggedIn) {
      el.innerHTML = `<div class="fb-add-bar"><span class="muted small" id="cl-check-result"></span><span class="spacer"></span>
          <button class="small" id="cl-check">연결 확인</button><button class="small danger" id="cl-logout">연결 해제</button></div>`;
      $('#cl-check', el).addEventListener('click', guard(async (e) => {
        e.target.disabled = true; $('#cl-check-result', el).textContent = 'Opus에 짧은 질문을 보내는 중…';
        try {
          const r = await api('POST', '/api/claude-login/check');
          $('#cl-check-result', el).innerHTML = r.ok ? `<span class="chip ok">정상</span> ${esc(r.model)}이 ${r.seconds}초 만에 답했습니다.` : `<span class="chip bad">실패</span> ${esc(r.error || `답이 맞지 않음 (${r.answer})`)}`;
        } finally { e.target.disabled = false; }
      }));
      $('#cl-logout', el).addEventListener('click', guard(async () => {
        if (!confirm('Claude 구독 연결을 해제할까요? 서버에 저장된 로그인 정보를 지웁니다. 다시 쓰려면 로그인해야 합니다.')) return;
        await api('POST', '/api/claude-login/logout');
        toast('연결을 해제했습니다.'); await loadStatus().catch(() => {}); route();
      }));
      return;
    }
    el.innerHTML = `<p class="muted small">서버를 선생님의 Claude 구독에 한 번 연결하면 <b>Claude Opus 5.5 (구독)</b>을 쓸 수 있습니다 (추가 비용 없음).</p>
      <ol class="small">
        <li><b>로그인 시작</b>을 누르면 로그인 링크가 나옵니다.</li>
        <li>링크를 열어 Claude 계정으로 로그인하고 승인하면 <b>코드</b>가 표시됩니다.</li>
        <li>그 코드를 아래 칸에 붙여 넣고 <b>연결</b>을 누르세요.</li>
      </ol>
      ${st.result && !st.result.ok ? `<div class="note bad small">지난 연결 시도가 실패했습니다: ${esc(st.result.error || '이유를 알 수 없음')} — 로그인을 다시 시작해 주세요.</div>` : ''}
      <div id="cl-step">${st.url ? '' : '<button class="primary" id="cl-start">로그인 시작</button>'}</div>`;
    const showCode = (url) => {
      $('#cl-step', el).innerHTML = `<p><a class="button primary" href="${esc(url)}" target="_blank" rel="noopener">로그인 링크 열기</a></p>
        <label for="cl-code">로그인 후 표시된 코드</label><input type="text" id="cl-code" autocomplete="off" spellcheck="false" placeholder="코드를 붙여 넣으세요">
        <div class="fb-add-bar"><button id="cl-cancel">취소</button><span class="spacer"></span><button class="primary" id="cl-send">연결</button></div>`;
      $('#cl-send', el).addEventListener('click', guard(async (e) => {
        e.target.disabled = true; e.target.textContent = '확인하는 중… (최대 1~2분)';
        try {
          await api('POST', '/api/claude-login/code', { code: $('#cl-code', el).value });
          // The server checks the code with Claude in the background; ask for the result every few seconds.
          for (let i = 0; i < 60; i++) {
            await new Promise((r) => setTimeout(r, 2500));
            const st = await api('GET', '/api/claude-login');
            if (st.loggedIn) { toast('Claude 구독에 연결했습니다.'); await loadStatus().catch(() => {}); route(); return; }
            if (!st.checking && st.result && !st.result.ok) throw new Error('연결되지 않았습니다: ' + (st.result.error || '코드를 다시 확인해 주세요.') + ' 로그인을 다시 시작해 주세요.');
          }
          throw new Error('확인이 너무 오래 걸립니다. 잠시 후 LLM 탭을 다시 열어 확인해 주세요.');
        } finally {
          if (e.target.isConnected) { e.target.disabled = false; e.target.textContent = '연결'; }
          if ($('#claude-login') && !(await api('GET', '/api/claude-login').catch(() => ({}))).pending) claudeLoginPanel();
        }
      }));
      $('#cl-cancel', el).addEventListener('click', guard(async () => { await api('POST', '/api/claude-login/cancel'); claudeLoginPanel(); }));
    };
    if (st.url) showCode(st.url);
    $('#cl-start', el)?.addEventListener('click', guard(async (e) => {
      e.target.disabled = true; e.target.textContent = '링크를 만드는 중…';
      try { showCode((await api('POST', '/api/claude-login/start')).url); }
      finally { if (e.target.isConnected) { e.target.disabled = false; e.target.textContent = '로그인 시작'; } }
    }));
  }

  // Signing the server's agy (Gemini) or Codex (GPT) in to the teacher's account. Gemini: open the link, sign in with
  // Google, paste the code shown back here. GPT: open the link and type the code shown here; the server notices by itself.
  const CLI_TXT = {
    'agy-cli': { name: 'Gemini', account: 'Google 계정', where: 'Antigravity' },
    'codex-cli': { name: 'GPT', account: 'ChatGPT 계정', where: 'Codex' },
  };
  async function cliLoginPanel(c) {
    const el = $(`#login-${c}`);
    if (!el) return;
    const t = CLI_TXT[c];
    const st = await api('GET', '/api/cli-login/' + c);
    if (st.loggedIn) {
      el.innerHTML = `<div class="fb-add-bar"><span class="muted small" data-r="check"></span><span class="spacer"></span>
          <button class="small" data-a="check">연결 확인</button><button class="small danger" data-a="logout">연결 해제</button></div>`;
      $('[data-a=check]', el).addEventListener('click', guard(async (e) => {
        e.target.disabled = true; $('[data-r=check]', el).textContent = `${t.name}에 짧은 질문을 보내는 중…`;
        try {
          const r = await api('POST', `/api/cli-login/${c}/check`);
          $('[data-r=check]', el).innerHTML = r.ok ? `<span class="chip ok">정상</span> ${esc(r.model)}이 ${r.seconds}초 만에 답했습니다.` : `<span class="chip bad">실패</span> ${esc(r.error || `답이 맞지 않음 (${r.answer})`)}`;
        } finally { e.target.disabled = false; }
      }));
      $('[data-a=logout]', el).addEventListener('click', guard(async () => {
        if (!confirm(`${t.name} 구독 연결을 해제할까요? 다시 쓰려면 로그인해야 합니다.`)) return;
        await api('POST', `/api/cli-login/${c}/logout`);
        toast('연결을 해제했습니다.'); await loadStatus().catch(() => {}); route();
      }));
      return;
    }
    const steps = c === 'agy-cli'
      ? ['<b>로그인 시작</b>을 누르면 Google 로그인 링크가 나옵니다.', `링크를 열어 ${t.account}으로 로그인하고 허용하면 <b>코드</b>가 표시됩니다.`, '그 코드를 아래 칸에 붙여 넣고 <b>연결</b>을 누르세요.']
      : ['<b>로그인 시작</b>을 누르면 링크와 <b>일회용 코드</b>가 나옵니다.', `링크를 열어 ${t.account}으로 로그인하고 그 코드를 입력하세요 (15분 안에).`, '입력을 마치면 이 화면이 저절로 연결됨으로 바뀝니다.',
        '“기기 코드 로그인을 활성화”하라는 안내가 나오면 ChatGPT 웹의 <b>설정 › 보안</b>에서 Codex 기기 코드 로그인을 켠 뒤, 여기서 로그인을 다시 시작하세요 (코드는 새로 받습니다).'];
    el.innerHTML = `<p class="muted small">서버를 선생님의 ${t.account} 구독에 한 번 연결하면 ${t.name}을 문제 분석·생성에 쓸 수 있습니다 (추가 비용 없음).</p>
      <ol class="small">${steps.map((x) => `<li>${x}</li>`).join('')}</ol>
      ${st.result && !st.result.ok ? `<div class="note bad small">지난 연결 시도가 실패했습니다: ${esc(st.result.error || '이유를 알 수 없음')} — 로그인을 다시 시작해 주세요.</div>` : ''}
      <div data-r="step"><button class="primary" data-a="start">로그인 시작</button></div>`;
    // Waits for the sign-in to finish (GPT: after the code is entered on OpenAI's page; Gemini: after the code is pasted).
    const wait = async (btn) => {
      for (let i = 0; i < 360; i++) {
        await new Promise((r) => setTimeout(r, 2500));
        if (!$(`#login-${c}`)) return;
        const now = await api('GET', '/api/cli-login/' + c);
        if (now.loggedIn) { toast(`${t.name} 구독에 연결했습니다.`); await loadStatus().catch(() => {}); route(); return; }
        if (!now.pending && now.result && !now.result.ok) { toast('연결되지 않았습니다: ' + (now.result.error || ''), true); cliLoginPanel(c); return; }
        if (btn?.isConnected && now.checking) btn.textContent = '확인하는 중… (최대 1~2분)';
      }
    };
    const show = (login) => {
      if (login.url === '-') { wait(); return; } // already signed in on the server: being checked
      $('[data-r=step]', el).innerHTML = `<p><a class="button primary" href="${esc(login.url)}" target="_blank" rel="noopener">로그인 링크 열기</a></p>
        ${c === 'codex-cli' ? `<p>입력할 코드: <b class="cli-code">${esc(login.code)}</b></p><p class="muted small"><i class="spin"></i>코드를 입력하고 로그인을 마치면 저절로 연결됩니다.</p>`
          : `<label for="code-${c}">로그인 후 표시된 코드</label><input type="text" id="code-${c}" autocomplete="off" spellcheck="false" placeholder="코드를 붙여 넣으세요">`}
        <div class="fb-add-bar"><button data-a="cancel">취소</button><span class="spacer"></span>${c === 'agy-cli' ? '<button class="primary" data-a="send">연결</button>' : ''}</div>`;
      $('[data-a=cancel]', el).addEventListener('click', guard(async () => { await api('POST', `/api/cli-login/${c}/cancel`); cliLoginPanel(c); }));
      $('[data-a=send]', el)?.addEventListener('click', guard(async (e) => {
        e.target.disabled = true; e.target.textContent = '확인하는 중… (최대 1~2분)';
        await api('POST', `/api/cli-login/${c}/code`, { code: $(`#code-${c}`).value });
        await wait(e.target);
      }));
      if (c === 'codex-cli') wait();
    };
    if (st.pending && st.url) show(st);
    $('[data-a=start]', el)?.addEventListener('click', guard(async (e) => {
      e.target.disabled = true; e.target.textContent = '링크를 만드는 중…';
      try { show(await api('POST', `/api/cli-login/${c}/start`)); }
      finally { if (e.target.isConnected) { e.target.disabled = false; e.target.textContent = '로그인 시작'; } }
    }));
  }

  // ------------------------------------------------------------------ LLM
  // One column, three sections, one pattern: every model and every instruction is a row with its state on one line,
  // and 관리/편집 opens that row in place. The balance and limits are fetched when the page opens and on 새로 고침.
  const EFFORT_TXT = { auto: '자동 (설계·검토는 높게)', low: '낮음 (빠름)', medium: '중간', high: '높음', xhigh: '매우 높음', max: '최대 (느림·한도 많이 씀)' };

  async function llmView() {
    view.innerHTML = `<div class="lt">
      <div class="lt-head"><h1>LLM</h1><span class="muted small" id="llm-at"></span><button class="small" id="llm-refresh">새로 고침</button></div>
      <section class="lt-sec">
        <div class="lt-sec-head"><h2>모델</h2><p>고른 모델이 <b>기본 모델</b>이 되어 문제 분석·생성에서 먼저 선택됩니다.</p></div>
        <div class="panel lt-list" id="lt-models"><div class="lt-row lt-plain"><span class="muted">불러오는 중…</span></div></div>
      </section>
      <p class="muted small">AI의 페르소나와 반드시 지킬 규칙은 <a href="#/learn/map/guide-g">학습 › 지침</a>에서 관리합니다.</p>
    </div>`;
    const won = (usd) => `약 ${Math.round(usd * 1400).toLocaleString()}원`;
    const tok = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : String(n || 0));
    const used = (u) => `<span class="lt-money">오늘 <b>${tok((u?.today?.input || 0) + (u?.today?.output || 0))}</b> · 이번 달 <b>${tok((u?.month?.input || 0) + (u?.month?.output || 0))}</b> 토큰</span>`;
    const month = (u) => (u?.month?.sets ? `이번 달 ${u.month.sets}세트${u.month.usd ? ' · ' + won(u.month.usd) : ''}` : '이번 달 사용 없음');
    const left = (w) => (w ? Math.max(0, Math.round((1 - w.used) * 100)) : null);
    const meter = (title, w) => {
      const n = left(w);
      return `<span class="lt-meter"><span>${title}</span><span class="lt-bar"><i class="${n === null ? '' : n <= 10 ? 'bad' : n <= 30 ? 'warn' : 'ok'}" style="width:${n ?? 0}%"></i></span><b>${n === null ? '–' : n + '%'}</b></span>`;
    };

    const paintModels = async (fresh) => {
      // 새로 고침 asks Claude once (a tiny question) so the remaining share is current, not as of the last generation.
      if (fresh) await Promise.all([api('POST', '/api/claude-login/check').catch(() => null), api('POST', '/api/cli-login/agy-cli/limits').catch(() => null), api('POST', '/api/cli-login/codex-cli/check').catch(() => null)]);
      const [status, llm] = await Promise.all([api('GET', '/api/status'), api('GET', '/api/llm')]);
      const p = status.providers || {};
      const def = status.defaultProvider || 'deepseek';
      const c = llm.claude;
      const lim = c.loggedIn ? c.limits : null;
      const row = (key, { name, ok, state, fact, more }) => `<div class="lt-row lt-llm open" data-row="${key}">
        <input type="radio" name="lt-default" id="lt-def-${key}" value="${key}" aria-label="${esc(name)} 기본 모델로 사용" ${def === key ? 'checked' : ''} ${ok ? '' : 'disabled'}>
        <div class="lt-main">
          <span class="lt-name">${esc(name)}${def === key ? '<span class="lt-tag">기본</span>' : ''}</span>
          <span class="lt-sub"><i class="lt-dot ${ok ? 'ok' : ''}"></i>${state}</span>
        </div>
        <div class="lt-fact">${fact}</div>
        <div class="lt-more">${more}</div>
      </div>`;
      $('#lt-models').innerHTML = [
        row('claude-cli', {
          name: c.label || 'Claude (구독)', ok: c.loggedIn,
          state: c.loggedIn ? `연결됨 · ${month(llm.usage['claude-cli'])}` : '연결 안 됨',
          fact: c.loggedIn ? `${meter('5시간', lim?.fiveHour)}${meter('1주일', lim?.sevenDay)}` : '',
          more: `<div class="lt-fields">
              <div><label for="cl-model">모델</label><select id="cl-model">${Object.entries(c.models || {}).map(([id, n]) => `<option value="${id}" ${id === c.model ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select></div>
              <div><label for="cl-effort">추론 강도</label><select id="cl-effort">${(c.efforts || []).map((e) => `<option value="${e}" ${e === c.effort ? 'selected' : ''}>${EFFORT_TXT[e] || e}</option>`).join('')}</select></div>
            </div>
            ${c.loggedIn ? `<p class="lt-note">구독으로 실행되어 호출당 비용이 없습니다. ${lim ? `한도는 ${fmtTime(lim.at)} 기준이고, 5시간 한도는 ${lim.fiveHour?.resetsAt ? fmtTime(lim.fiveHour.resetsAt) : '-'}, 1주일 한도는 ${lim.sevenDay?.resetsAt ? fmtTime(lim.sevenDay.resetsAt) : '-'}에 다시 채워집니다.` : '한도는 새로 고침을 누르면 가져옵니다.'}</p>` : ''}
            <div id="claude-login"></div>`,
        }),
        ...['agy-cli', 'codex-cli'].map((k) => {
          const x = llm[k] || {};
          const t = CLI_TXT[k];
          const modelOpts = k === 'codex-cli' ? [['', 'Codex 기본 모델'], ...(x.models || []).map((m) => [m.id, m.label])] : (x.models || []).map((m) => [m.id, m.label]);
          return row(k, {
            name: x.loggedIn && x.label ? x.label : `${t.name} (구독)`, ok: x.loggedIn,
            state: !x.installed ? '서버에 설치되어 있지 않음' : x.loggedIn ? `연결됨 · ${month(llm.usage[k])}` : '연결 안 됨',
            fact: !x.loggedIn ? '<span class="lt-money">구독</span>' : x.limits ? `${meter('5시간', x.limits.fiveHour)}${meter('1주일', x.limits.sevenDay)}` : used(llm.usage[k]),
            more: `${x.loggedIn ? `<div class="lt-fields">
                <div><label for="m-${k}">모델</label><select id="m-${k}" data-cli="${k}">${modelOpts.length ? modelOpts.map(([id, n]) => `<option value="${esc(id)}" ${id === (x.model || '') ? 'selected' : ''}>${esc(n)}</option>`).join('') : '<option value="">목록을 불러오는 중 (새로 고침)</option>'}</select></div>
                ${k === 'codex-cli' ? `<div><label for="e-${k}">추론 강도</label><select id="e-${k}" data-cli="${k}">${(x.efforts || []).map((e) => `<option value="${e}" ${e === x.effort ? 'selected' : ''}>${EFFORT_TXT[e] || e}</option>`).join('')}</select></div>` : ''}
              </div>` : ''}
              <p class="lt-note">서버의 ${t.where} CLI가 선생님의 ${t.account} 구독으로 실행되어 호출당 비용이 없습니다. 구독의 사용 한도가 적용되고, Claude보다 느릴 수 있습니다. ${x.limits ? `한도는 ${fmtTime(x.limits.at)} 기준이고, 5시간 한도는 ${x.limits.fiveHour?.resetsAt ? fmtTime(x.limits.fiveHour.resetsAt) : '-'}, 1주일 한도는 ${x.limits.sevenDay?.resetsAt ? fmtTime(x.limits.sevenDay.resetsAt) : '-'}에 다시 채워집니다. 이 서버에서 오늘 ${tok((llm.usage[k]?.today?.input || 0) + (llm.usage[k]?.today?.output || 0))} 토큰을 썼습니다.` : `남은 한도는 한 번 호출한 뒤부터 보입니다 (새로 고침을 누르면 바로 가져옵니다).`}</p>
              ${x.installed ? `<div id="login-${k}"></div>` : ''}`,
          });
        }),
        row('deepseek', {
          name: p.deepseek?.label || 'DeepSeek', ok: p.deepseek?.available,
          state: p.deepseek?.available ? `사용 가능 · ${month(llm.usage.deepseek)}` : 'API 키 없음',
          fact: `<span class="lt-money">잔액 <b id="ds-balance">…</b></span>`,
          more: `<p class="lt-note">쓴 만큼 결제합니다. 평일 한국 시간 10–13시, 15–19시는 단가가 2배입니다.</p>
            <div><label for="ds-key">API 키 바꾸기 <span class="muted small">(지금 키 ${esc(llm.deepseek.key || '없음')})</span></label>
            <div class="lt-inline"><input type="password" id="ds-key" autocomplete="off" placeholder="새 DeepSeek API 키 (sk-…)"><button class="primary" id="ds-key-save">저장</button></div>
            <p class="lt-note">저장하기 전에 DeepSeek에 맞는 키인지 확인합니다.</p></div>`,
        }),
        row('gemma', {
          name: p.gemma?.label || 'PC 모델', ok: p.gemma?.available,
          state: p.gemma?.available ? `PC 켜짐 · ${month(llm.usage.gemma)}` : 'PC 꺼짐',
          fact: '<span class="lt-money">무료</span>',
          more: `<p class="lt-note">선생님 PC에서 실행되어 비용이 없지만 느리고, PC가 켜져 있을 때만 쓸 수 있습니다.${p.gemma?.model ? ` 지금 모델: ${esc(p.gemma.model)}` : ''}</p>`,
        }),
      ].join('');
      $('#llm-at').textContent = fmtTime(new Date().toISOString()) + ' 기준';
      api('GET', '/api/balance').then((x) => { if ($('#ds-balance')) $('#ds-balance').textContent = x.balance; }).catch(() => { if ($('#ds-balance')) $('#ds-balance').textContent = '확인 실패'; });
      $$('[name=lt-default]').forEach((r) => r.addEventListener('change', guard(async () => {
        await api('PUT', '/api/llm/default', { provider: r.value });
        await loadStatus().catch(() => {});
        toast('기본 모델을 바꿨습니다.');
        await paintModels(false);
      })));
      // Model and effort are saved as soon as one is picked; the next Claude call uses them.
      const saveChoice = guard(async () => {
        await api('PUT', '/api/llm/claude', { model: $('#cl-model').value, effort: $('#cl-effort').value });
        await loadStatus().catch(() => {});
        toast('Claude 설정을 바꿨습니다. 다음 호출부터 적용됩니다.');
        await paintModels(false);
      });
      $('#cl-model').addEventListener('change', saveChoice);
      $('#cl-effort').addEventListener('change', saveChoice);
      $('#ds-key-save').addEventListener('click', guard(async (e) => {
        e.target.disabled = true;
        try { await api('PUT', '/api/llm/deepseek-key', { key: $('#ds-key').value }); toast('DeepSeek API 키를 바꿨습니다.'); await paintModels(false); }
        finally { if (e.target.isConnected) e.target.disabled = false; }
      }));
      claudeLoginPanel().catch(() => {});
      $$('select[data-cli]').forEach((sel) => sel.addEventListener('change', guard(async () => {
        const k = sel.dataset.cli;
        await api('PUT', '/api/llm/cli/' + k, { model: $('#m-' + k).value, effort: $('#e-' + k)?.value });
        await loadStatus().catch(() => {});
        toast(`${CLI_TXT[k].name} 설정을 바꿨습니다. 다음 호출부터 적용됩니다.`);
        await paintModels(false);
      })));
      for (const k of ['agy-cli', 'codex-cli']) cliLoginPanel(k).catch(() => {});
    };

    $('#llm-refresh').addEventListener('click', guard(async (e) => { e.target.disabled = true; e.target.textContent = '가져오는 중…'; try { await paintModels(true); } finally { e.target.disabled = false; e.target.textContent = '새로 고침'; } }));
    await paintModels(false);
  }

  // ------------------------------------------------------------------ 계정
  const ROLE_TXT = { admin: '관리자', teacher: '선생님' };
  async function accountView() {
    const me = await api('GET', '/api/me');
    const isAdmin = me.role === 'admin';
    view.innerHTML = `<div class="lt">
      <div class="lt-title"><h1>계정</h1><p class="lt-meta">${esc(me.username)} · ${ROLE_TXT[me.role]}${me.lastLoginAt ? ` · 마지막 로그인 ${fmtTime(me.lastLoginAt)}` : ''}</p></div>
      <section class="lt-sec"><div class="lt-sec-head"><h2>비밀번호 바꾸기</h2><p>바꾸면 이 기기를 뺀 다른 기기에서는 로그아웃됩니다.</p></div>
        <form class="panel acc-form" id="pw-form">
          <div><label for="pw-cur">지금 비밀번호</label><input type="password" id="pw-cur" autocomplete="current-password" required></div>
          <div><label for="pw-new">새 비밀번호 (8자 이상)</label><input type="password" id="pw-new" autocomplete="new-password" minlength="8" required></div>
          <div><label for="pw-new2">새 비밀번호 확인</label><input type="password" id="pw-new2" autocomplete="new-password" minlength="8" required></div>
          <p class="bad small" id="pw-error" hidden></p>
          <div class="lt-actions"><span class="spacer"></span><button class="small primary">비밀번호 바꾸기</button></div>
        </form></section>
      ${isAdmin ? `<section class="lt-sec"><div class="lt-sec-head"><h2>계정 관리</h2><p>선생님 계정은 문제·학습·LLM을 모두 쓰고, 관리자 계정은 계정 관리도 합니다.</p></div>
        <div class="panel lt-list" id="acc-list"></div>
        <form class="panel acc-form acc-add" id="acc-add">
          <div><label for="add-name">아이디</label><input type="text" id="add-name" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="영문 소문자·숫자" required></div>
          <div><label for="add-pw">처음 비밀번호 (8자 이상)</label><input type="password" id="add-pw" autocomplete="new-password" minlength="8" required></div>
          <div><label for="add-role">역할</label><select id="add-role"><option value="teacher">선생님</option><option value="admin">관리자</option></select></div>
          <p class="bad small" id="add-error" hidden></p>
          <div class="lt-actions"><span class="muted small">처음 비밀번호를 알려 주고, 로그인한 뒤 바꾸게 하세요.</span><span class="spacer"></span><button class="small primary">계정 추가</button></div>
        </form></section>` : ''}
    </div>`;
    const showErr = (id, m) => { const e = $(id); e.textContent = m; e.hidden = !m; };
    $('#pw-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      if ($('#pw-new').value !== $('#pw-new2').value) return showErr('#pw-error', '새 비밀번호 두 칸이 서로 다릅니다.');
      try { await api('PUT', '/api/me/password', { current: $('#pw-cur').value, next: $('#pw-new').value }); }
      catch (x) { return showErr('#pw-error', x.message); }
      showErr('#pw-error', ''); e.target.reset(); toast('비밀번호를 바꿨습니다.');
    });
    if (!isAdmin) return;
    const paintList = async () => {
      const list = await api('GET', '/api/users');
      $('#acc-list').innerHTML = list.map((u) => `<div class="lt-row lt-plain acc-row${u.disabled ? ' off' : ''}" data-user="${u.id}">
        <div class="lt-main"><span class="lt-name">${esc(u.username)}<span class="lt-tag">${ROLE_TXT[u.role]}</span>${u.disabled ? '<span class="chip">꺼짐</span>' : ''}${u.id === me.id ? '<span class="chip">나</span>' : ''}</span>
          <span class="lt-sub">${u.lastLoginAt ? `마지막 로그인 ${fmtTime(u.lastLoginAt)}` : '아직 로그인하지 않음'}</span></div>
        ${u.id === me.id ? '<span></span>' : `<div class="acc-acts">
          <button class="small" data-a="reset">비밀번호 초기화</button>
          <button class="small" data-a="role">${u.role === 'admin' ? '선생님으로' : '관리자로'}</button>
          <button class="small" data-a="toggle">${u.disabled ? '켜기' : '끄기'}</button>
          <button class="small danger" data-a="del">삭제</button></div>`}
        <form class="acc-reset" hidden><input type="password" autocomplete="new-password" minlength="8" placeholder="새 비밀번호 (8자 이상)" required><button class="small primary">초기화</button><button type="button" class="small" data-a="cancel">취소</button></form>
      </div>`).join('');
      $$('#acc-list [data-user]').forEach((row) => {
        const id = row.dataset.user;
        const u = list.find((x) => x.id === id);
        const form = $('.acc-reset', row);
        $('[data-a=reset]', row)?.addEventListener('click', () => { form.hidden = false; $('input', form).focus(); });
        $('[data-a=cancel]', row)?.addEventListener('click', () => { form.hidden = true; form.reset(); });
        form?.addEventListener('submit', guard(async (e) => { e.preventDefault(); await api('PUT', '/api/users/' + id, { password: $('input', form).value }); toast(`${u.username}의 비밀번호를 바꿨습니다. 그 계정은 다시 로그인해야 합니다.`); await paintList(); }));
        $('[data-a=role]', row)?.addEventListener('click', guard(async () => { await api('PUT', '/api/users/' + id, { role: u.role === 'admin' ? 'teacher' : 'admin' }); await paintList(); }));
        $('[data-a=toggle]', row)?.addEventListener('click', guard(async () => { await api('PUT', '/api/users/' + id, { disabled: !u.disabled }); toast(u.disabled ? '계정을 켰습니다.' : '계정을 껐습니다. 그 계정은 바로 로그아웃됩니다.'); await paintList(); }));
        // Deleting asks in the row itself (the page cannot show confirm dialogs everywhere).
        $('[data-a=del]', row)?.addEventListener('click', guard(async (e) => {
          if (e.target.dataset.sure !== '1') { e.target.dataset.sure = '1'; e.target.textContent = '정말 삭제'; return; }
          await api('DELETE', '/api/users/' + id); toast(`${u.username} 계정을 삭제했습니다.`); await paintList();
        }));
      });
    };
    await paintList();
    $('#acc-add').addEventListener('submit', async (e) => {
      e.preventDefault();
      try { await api('POST', '/api/users', { username: $('#add-name').value, password: $('#add-pw').value, role: $('#add-role').value }); }
      catch (x) { return showErr('#add-error', x.message); }
      showErr('#add-error', ''); e.target.reset(); toast('계정을 추가했습니다.'); await paintList();
    });
  }

  // ------------------------------------------------------------------ boot
  (async () => {
    try {
      const status = await loadStatus();
      if (!status.authenticated) return showLogin();
    } catch { /* shown per view */ }
    route();
  })();
})();
