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
  const PROVIDER_LABEL = { deepseek: 'DeepSeek', gemma: 'PC 모델', relay: 'Claude Opus 5.5', claude: 'Claude Opus 5.5', 'claude-cli': 'Claude Opus 5.5 (구독)' };
  // Model picker: DeepSeek is always there; Gemma only while the teacher's PC is on.
  let statusCache = null;
  const loadStatus = async () => { statusCache = await api('GET', '/api/status'); paintModelState(statusCache); return statusCache; };
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
  const ITEM_STATUS = { pending: ['대기', ''], generating: ['설계 중', 'run'], verifying: ['검증 중', 'run'], repairing: ['수정 중', 'run'], passed: ['검증 통과', 'ok'], warning: ['통과 · 확인할 점', 'warn'], needs_review: ['교사 검토 필요', 'bad'], failed: ['실패', 'bad'] };
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
    el.innerHTML = `<form class="box"><h2>EduMaster 접속</h2><p class="muted small">관리자에게 받은 접속 코드를 입력하세요.</p>
      <input type="password" name="code" autocomplete="current-password" placeholder="접속 코드" required>
      <div class="row" style="margin-top:12px"><span class="spacer"></span><button class="primary">접속</button></div></form>`;
    document.body.appendChild(el);
    $('input', el).focus();
    $('form', el).addEventListener('submit', guard(async (e) => {
      e.preventDefault();
      await api('POST', '/api/login', { code: e.target.code.value });
      el.remove();
      $('#logout').hidden = false;
      loadStatus().catch(() => {});
      route();
    }));
  }
  $('#logout').addEventListener('click', guard(async () => { await api('POST', '/api/logout'); location.hash = '#/'; $('#model-state').textContent = ''; showLogin(); }));

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
      else if (hash.startsWith('#/rules') || hash.startsWith('#/learn')) { setNav('rules'); await rulesView(); }
      else if (hash.startsWith('#/system')) { setNav('system'); await systemView(); }
      else if (hash.startsWith('#/llm')) { setNav('llm'); await llmView(); }
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
      count('passed') && `바로 사용 ${count('passed')}`, count('warning') && `확인할 점 ${count('warning')}`,
      count('needs_review') && `검토 필요 ${count('needs_review')}`, count('failed') && `못 만듦 ${count('failed')}`,
    ].filter(Boolean).join(' · ');
    if (j.status === 'done') {
      const trouble = count('needs_review') + count('failed');
      return { cat: trouble ? 'check' : 'done', tone: trouble ? 'warn' : 'ok', label: trouble ? '완료 · 확인 필요' : count('warning') ? '완료 · 확인할 점 있음' : '완료 · 모두 바로 사용 가능', detail: parts };
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

  async function materialView(id, alive) {
    let m = await api('GET', '/api/materials/' + id);
    if (m.status === 'analyzing') {
      view.innerHTML = `<h1>${esc(m.title)}</h1><div class="grid2"><div class="panel">${originals(m.images)}</div>
        <div class="panel"><h2>분석 중 ${chip(MAT_STATUS, 'analyzing')}</h2><p class="muted">원본 문제를 옮겨 적고, 해설의 풀이 방법을 STEP으로 정리하고 있습니다. 보통 1~3분 걸립니다. 이 화면을 닫아도 서버에서 계속 진행됩니다.</p><div class="log" id="log"></div></div></div>`;
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
      view.innerHTML = `<h1>${esc(m.title)}</h1><div class="grid2"><div class="panel">${originals(m.images)}</div><div class="panel"><h2>분석 실패</h2>
        <div class="note bad">${esc(m.error || '분석 결과가 없습니다.')}</div>
        <label>분석 모델</label>${providerPicker('provider')}
        <label>AI에게 알려 줄 점 (선택)</label><textarea id="note">${esc(m.note || '')}</textarea>
        <div class="row" style="margin-top:10px"><button class="primary" id="again">다시 분석</button><button class="danger" id="del">자료 삭제</button></div></div></div>`;
      $('#again').addEventListener('click', guard(async () => { await api('POST', `/api/materials/${id}/analyze`, { note: $('#note').value, provider: $('[name=provider]:checked')?.value }); route(); }));
      $('#del').addEventListener('click', guard(async () => { if (confirm('이 자료를 삭제할까요?')) { await api('DELETE', '/api/materials/' + id); location.hash = '#/materials'; } }));
      return;
    }
    renderMaterial(m, false);
  }

  function renderMaterial(m, editing) {
    const n = m.steps.length;
    const gens = m.jobs.filter((j) => j.type === 'generate').sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    // Top to bottom: the original problem and the teacher's solution side by side, the reading (problem, then each
    // STEP), this problem's feedback, making variants from it, and the variants made so far.
    view.innerHTML = `
      <div class="row"><h1 style="margin-right:auto">${esc(m.title)}</h1>${chip(MAT_STATUS, m.status)}</div>
      <div class="panel"><div class="orig orig-2">${originalsInner(m.images)}</div></div>
      <div class="panel" id="analysis"></div>
      <div class="panel" id="feedback"></div>
      <div class="panel" id="generate"></div>
      <div class="panel" id="variants"></div>`;
    if (editing) editAnalysis(m); else showAnalysis(m);
    feedbackPanel(m, gens);
    generatePanel(m, n);
  }

  // This problem's own feedback: what the teacher taught about it (on the problem page or on one of its variants).
  // Every variant made from it gets all of it.
  const TARGET_TXT = { problem: '문제', solution: '해설', design: '문제', all: '전체' };
  async function feedbackPanel(m, gens) {
    const el = $('#feedback');
    if (!el) return;
    const rules = await api('GET', '/api/rules');
    const own = rules.filter((r) => r.scope === 'material' && r.source?.materialId === m.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const on = own.filter((r) => r.status === 'approved');
    const entry = (r, i) => `<div class="learn-item" data-rule="${r.id}">
      <div class="learn-item-main"><div class="learn-text"><b>${i + 1}.</b> ${esc(r.text)}</div>
        <div class="learn-meta"><span class="chip">${TARGET_TXT[r.target] || '전체'}</span>${r.status === 'approved' ? '' : '<span class="chip warn">꺼짐</span>'}
          <span class="muted small">${fmtTime(r.createdAt)}${r.source?.jobId ? ` · <a href="#/j/${r.source.jobId}">${esc(r.source.label || '변형 문제')}에서 남김</a>` : ''}</span></div></div>
      <div class="learn-actions">${r.status === 'approved' ? '<button class="small" data-act="off">끄기</button>' : '<button class="small primary" data-act="on">켜기</button>'}<button class="small" data-act="edit">수정</button><button class="small danger" data-act="del">삭제</button></div></div>`;
    el.innerHTML = `
      <h2 style="margin:0">변형 문제 피드백</h2>
      <p class="muted small" style="margin:4px 0 0">아래 <b>변형 문제 만들기</b>에서 AI가 지킬 점입니다. 켜진 ${on.length}개가 이 문제로 만드는 모든 변형 문제에 반영됩니다. 위 <b>분석 결과</b>(읽은 문제·STEP)가 틀렸다면 여기가 아니라 분석 결과의 <b>수정</b>에서 직접 고쳐 주세요.</p>
      <div class="learn-list" style="margin-top:8px">${own.map(entry).join('') || '<p class="muted small">아직 없습니다. 변형 문제를 보고 고칠 점이 있으면 적어 주세요.</p>'}</div>
      <div class="fb-add">
        <textarea id="fb-text" rows="3" placeholder="변형 문제를 만들 때 지킬 점. 예: STEP 1 연습에서는 남는 물질을 표에 적지 않는다. 최종 문제는 실험 Ⅱ에서 가정→모순을 판정하게 만든다."></textarea>
        <div class="fb-add-bar"><label for="fb-target">대상</label><select id="fb-target"><option value="all">전체</option><option value="problem">문제</option><option value="solution">해설</option></select>
          <span class="spacer"></span><button class="primary" id="fb-add">피드백 추가</button></div>
      </div>`;
    $('#fb-add', el).addEventListener('click', guard(async () => {
      const text = $('#fb-text', el).value.trim();
      if (!text) throw new Error('피드백 내용을 입력해 주세요.');
      await api('POST', '/api/rules', { text, target: $('#fb-target', el).value, kind: 'feedback', scope: 'material', source: { materialId: m.id } });
      toast('저장했습니다. 다음 변형 생성부터 반영됩니다.');
      feedbackPanel(m, gens);
      rulesPreview(m);
    }));
    $$('[data-rule] [data-act]', el).forEach((b) => b.addEventListener('click', guard(async () => {
      const id = b.closest('[data-rule]').dataset.rule;
      const act = b.dataset.act;
      if (act === 'del') { if (!confirm('이 피드백을 삭제할까요?')) return; await api('DELETE', '/api/rules/' + id); }
      else if (act === 'edit') {
        const text = prompt('피드백 수정', own.find((r) => r.id === id)?.text || '');
        if (text === null) return;
        await api('PUT', '/api/rules/' + id, { text });
      } else await api('PUT', '/api/rules/' + id, { status: act === 'on' ? 'approved' : 'pending' });
      feedbackPanel(m, gens);
      rulesPreview(m);
    })));
    variantsPanel(gens, on);
  }

  // The variants made from this problem, set by set, each problem with its state; a set made before later
  // feedback says how much of it it does not reflect.
  function variantsPanel(gens, on) {
    const el = $('#variants');
    if (!el) return;
    el.innerHTML = `<h2>변형 문제</h2>${gens.length ? gens.map((j, i) => {
      const st = setStatus(j);
      const later = on.filter((r) => r.createdAt > j.createdAt).length;
      return `<div class="variant-set">
        <a class="variant-head" href="#/j/${j.id}"><b>세트 ${gens.length - i}</b><span class="muted small">${fmtTime(j.createdAt)} · ${esc(j.modelLabel || PROVIDER_LABEL[j.options?.provider] || 'DeepSeek')} · ${j.options?.mode === 'integrated' ? '통합 변형' : '수치 변형'}</span>
          <span class="spacer"></span><span class="chip ${st.tone}">${esc(st.label)}</span>${later ? `<span class="chip warn">이후 피드백 ${later}개 미반영</span>` : ''}<span class="mat-open">열기 ›</span></a>
        <div class="variant-items">${j.items.map((it) => `<a class="variant-item" href="#/j/${j.id}"><span>${esc(it.label)}</span>${chip(ITEM_STATUS, it.status)}</a>`).join('')}</div></div>`;
    }).join('') : '<p class="muted small">아직 없습니다. 위에서 변형 문제를 만들어 주세요.</p>'}`;
  }

  function showAnalysis(m) {
    const el = $('#analysis');
    el.innerHTML = `
      <div class="row"><h2 style="margin:0">분석 결과</h2><span class="spacer"></span>
        <button class="small" id="edit">수정</button><button class="small" id="reanalyze">다시 분석</button><button class="small danger" id="del">삭제</button></div>
      <p class="muted small" style="margin:4px 0">AI가 원본을 읽고 정리한 내용입니다. 원본과 다른 곳은 <b>수정</b>으로 직접 고치세요 — 고친 내용이 변형 문제의 기준이 되고, 잘못 읽은 단어는 다음 판독 때 주의하도록 학습됩니다.</p>
      <p class="muted small">${esc([m.subject, m.topic].filter(Boolean).join(' · '))} · ${m.solutionSource === 'ai' ? '<span class="chip warn">해설 없음 → AI가 만든 풀이</span>' : '<span class="chip ok">교사 해설 기반</span>'} <span class="chip">분석: ${PROVIDER_LABEL[m.analyzedWith] || 'DeepSeek'}</span> ${m.teacherEditedAt ? '<span class="chip">교사 수정됨</span>' : ''}</p>
      ${m.steps.length > (m.targetSteps || 99) ? `<div class="note warn row"><span style="flex:1">해설의 단계 표시는 ${m.targetSteps}개인데 정리한 STEP은 ${m.steps.length}개입니다.</span><button class="small primary" id="align">해설 단계에 맞춰 합치기</button></div>` : ''}
      ${m.uncertainties?.filter((u) => !u.startsWith('해설의 단계 표시는')).length ? `<div class="note warn"><b>판독이 불확실한 부분 — 원본과 대조해 주세요</b><ul>${m.uncertainties.filter((u) => !u.startsWith('해설의 단계 표시는')).map((u) => `<li>${rich(u).replace(/^<p>|<\/p>$/g, '')}</li>`).join('')}</ul></div>` : ''}
      ${m.proofread?.length ? `<details data-k="proof"><summary>원본 대조로 자동 교정한 곳 ${m.proofread.length}건</summary><div class="inner"><ul class="small">${m.proofread.map((u) => `<li>${rich(u).replace(/^<p>|<\/p>$/g, '')}</li>`).join('')}</ul></div></details>` : ''}
      ${m.annotations?.length ? `<div class="note info"><b>문제 조건에서 뺀 필기·표시</b><ul>${m.annotations.map((u) => `<li>${rich(u).replace(/^<p>|<\/p>$/g, '')}</li>`).join('')}</ul></div>` : ''}
      <h3>읽은 문제</h3><div class="rich">${rich(m.problem.text)}</div>
      ${m.problem.figure ? `<div class="note info"><b>그림 설명</b><div class="rich">${rich(m.problem.figure)}</div></div>` : ''}
      ${choicesHtml(m.problem)}
      <p class="small muted">정답: ${m.problem.answer ? circled(m.problem.answer) : '없음/서술형'}</p>
      <h3>풀이 STEP (${m.steps.length}개)</h3>
      <div class="steps">${m.steps.map(stepHtml).join('')}</div>
      ${m.techniques?.length ? `<h3>변형 문제에서 재사용할 핵심 기법</h3><div class="rich">${m.techniques.map((t) => `<p class="bullet">• ${rich(t).replace(/^<p>|<\/p>$/g, '')}</p>`).join('')}</div>` : ''}
      ${m.finalCheck ? `<h3>정답 재확인</h3><div class="rich">${rich(m.finalCheck)}</div>` : ''}
      <div class="analysis-fb">
        <h3>분석 피드백</h3>
        <p class="muted small" style="margin:0 0 6px">읽은 내용이나 STEP 정리가 마음에 들지 않으면 적어 주세요. AI가 원본을 다시 읽을 때 지금까지의 분석 피드백을 모두 반영합니다. 몇 글자만 틀렸다면 위의 <b>수정</b>으로 바로 고치는 편이 빠릅니다.</p>
        ${(m.analysisFeedback || []).length ? `<ol class="small">${m.analysisFeedback.map((f, i) => `<li>${esc(f.text)} <span class="muted">${fmtTime(f.at)}</span> <button class="small" data-afb-del="${i}">삭제</button></li>`).join('')}</ol>` : ''}
        <textarea id="afb-text" rows="2" placeholder="예: STEP 2와 STEP 3을 선생님 해설처럼 나눠 주세요. 표 Ⅲ의 'B'는 학생 필기입니다."></textarea>
        <div class="fb-add-bar"><span class="spacer"></span><button class="primary" id="afb-go">피드백 반영해 다시 분석</button></div>
      </div>`;
    $('#afb-go').addEventListener('click', guard(async () => {
      const feedback = $('#afb-text').value.trim();
      if (!feedback) throw new Error('분석 피드백을 입력해 주세요.');
      const again = undefined; // the 기본 모델 (LLM tab)
      await api('POST', `/api/materials/${m.id}/analyze`, { feedback, provider: again });
      route();
    }));
    $$('[data-afb-del]').forEach((b) => b.addEventListener('click', guard(async () => {
      if (!confirm('이 분석 피드백을 지울까요?')) return;
      const saved = await api('DELETE', `/api/materials/${m.id}/analysis-feedback/${b.dataset.afbDel}`);
      showAnalysis({ ...m, analysisFeedback: saved.analysisFeedback });
    })));
    $('#edit').addEventListener('click', () => editAnalysis(m));
    $('#align')?.addEventListener('click', guard(async (e) => {
      e.target.disabled = true; e.target.textContent = '합치는 중…';
      try {
        const saved = await api('POST', `/api/materials/${m.id}/align-steps`);
        toast(`STEP을 ${saved.steps.length}개로 합쳤습니다.`);
        renderMaterial({ ...saved, jobs: m.jobs }, false);
      } finally { if (e.target.isConnected) { e.target.disabled = false; e.target.textContent = '해설 단계에 맞춰 합치기'; } }
    }));
    $('#reanalyze').addEventListener('click', guard(async () => {
      if (!confirm('원본을 다시 분석할까요? 지금 분석 결과(직접 고친 내용 포함)는 새 결과로 바뀝니다. 분석 피드백은 모두 반영됩니다.')) return;
      const again = undefined; // the 기본 모델 (LLM tab)
      await api('POST', `/api/materials/${m.id}/analyze`, { provider: again });
      route();
    }));
    $('#del').addEventListener('click', guard(async () => { if (confirm('이 자료를 삭제할까요? (만든 세트 기록은 남습니다)')) { await api('DELETE', '/api/materials/' + m.id); location.hash = '#/materials'; } }));
  }

  function editAnalysis(m) {
    const el = $('#analysis');
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

  async function generatePanel(m, n) {
    const el = $('#generate');
    const upto = Array.from({ length: n - 1 }, (_, i) => i + 1);
    const focus = Array.from({ length: Math.max(0, n - 1) }, (_, i) => i + 2);
    try { await loadStatus(); } catch { /* picker falls back to DeepSeek only */ }
    el.innerHTML = `
      <h2>변형 문제 만들기</h2>
      <p class="muted small">위 풀이 STEP ${n}개와 이 문제의 피드백, 공통 지침으로 만듭니다. 정답은 서버가 계산으로 확인하고 다른 풀이로 다시 대조합니다.</p>
      <div class="note info small" id="rules-preview">반영할 피드백과 지침을 확인하는 중…</div>
      <label>만들 문제</label>
      <div class="stage-picks">${upto.map((k) => `<label class="inline"><input type="checkbox" data-stage='{"kind":"upto","upto":${k}}' checked> ${k === 1 ? 'STEP 1 연습' : `STEP 1~${k} 연습`}</label>`).join('')}
        <label class="inline"><input type="checkbox" data-stage='{"kind":"twin"}' checked> 최종 문제 (STEP 1~${n})</label>
        ${focus.map((k) => `<label class="inline"><input type="checkbox" data-stage='{"kind":"focus","step":${k}}'> STEP ${k}만 연습</label>`).join('')}</div>
      <details class="gen-more" data-k="gen-more"><summary>세부 설정 <span class="muted small" id="gen-summary"></span></summary><div class="inner">
        <label>생성 모델</label>${providerPicker('genProvider')}
        <label>최종 문제 방식</label>
        <div><label class="inline"><input type="radio" name="mode" value="integrated" checked> 통합 변형 (권장) — 앞 연습 문제의 아이디어를 엮은 새 구조</label>
          <label class="inline"><input type="radio" name="mode" value="numeric"> 단순 수치 변형 — 원본과 같은 구조에 숫자만 새로</label></div>
        <div class="cols cols-2">
          <div><label>단계마다 만들 문제 수</label><select id="per"><option>1</option><option>2</option><option>3</option></select></div>
          <div><label>DeepSeek 사고 강도</label><select id="effort"><option value="low">기본 (비용 적음)</option><option value="high">정밀 (토큰 더 사용)</option></select></div>
        </div>
        <p class="muted small">STEP k만 연습: 앞 STEP의 결과를 조건으로 주고 STEP k만 쓰게 하는 문제입니다.</p>
      </div></details>
      <div class="gen-go"><span class="muted small" id="estimate"></span><button class="primary" id="go">생성 시작</button></div>`;
    const estimate = () => {
      const gemma = $('[name=genProvider]:checked', el)?.value === 'gemma';
      $('#effort').disabled = gemma;
      const count = $$('[data-stage]:checked', el).length * Number($('#per').value);
      $('#estimate').textContent = !count ? '만들 문제를 하나 이상 고르세요.'
        : `${count}문제 · 모델 호출 약 ${count * 2}~${count * 4}회 예상 (설계 + 독립 풀이, 필요할 때만 수정 1회)` + (gemma ? ' · Gemma는 무료지만 PC에서 돌아가 문제당 몇 분씩 걸릴 수 있습니다' : '');
      $('#go').disabled = !count;
      const picked = $('[name=genProvider]:checked', el);
      $('#gen-summary').textContent = `— ${picked?.closest('label')?.querySelector('b, strong')?.textContent || PROVIDER_LABEL[picked?.value] || 'DeepSeek'} · ${$('[name=mode]:checked', el).value === 'integrated' ? '통합 변형' : '수치 변형'} · 단계마다 ${$('#per').value}문제`;
    };
    $$('input, select', el).forEach((x) => x.addEventListener('change', estimate));
    estimate();
    $('#go').addEventListener('click', guard(async () => {
      $('#go').disabled = true;
      const r = await api('POST', '/api/generations', {
        materialId: m.id,
        stages: $$('[data-stage]:checked', el).map((x) => JSON.parse(x.dataset.stage)),
        mode: $('[name=mode]:checked', el).value, perStage: Number($('#per').value), effort: $('#effort').value,
        provider: $('[name=genProvider]:checked', el)?.value,
      });
      location.hash = '#/j/' + r.jobId;
    }));
    await rulesPreview(m);
  }

  // What the next set of this problem will carry: its own feedback and the rules for every problem.
  async function rulesPreview(m) {
    if (!$('#rules-preview')) return;
    const rules = await api('GET', '/api/rules');
    const own = rules.filter((r) => r.status === 'approved' && r.scope === 'material' && r.source?.materialId === m.id);
    const global = rules.filter((r) => r.status === 'approved' && r.scope === 'global');
    const topic = rules.filter((r) => r.status === 'approved' && r.scope === 'topic');
    if (!$('#rules-preview')) return;
    $('#rules-preview').innerHTML = `<details><summary><b>반영: 이 문제의 피드백 ${own.length}개 · 공통 지침 ${global.length + topic.length}개</b></summary>
      ${own.length ? '<div>피드백: 위 목록의 켜진 항목 전부</div>' : '<div>피드백: 아직 없음</div>'}
      ${global.length ? '<div>공통 지침:</div><ul>' + global.slice(0, 8).map((r) => `<li>${esc(r.text)}</li>`).join('') + '</ul>' : ''}
      ${topic.length ? `<div class="muted">예전 유형별 피드백 ${topic.length}개 중 이 문제와 비슷한 것도 함께 반영됩니다. <a href="#/learn">전체 피드백</a></div>` : ''}</details>`;
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
    const draw = () => {
      $('#job-head').innerHTML = jobHead(job, regenerating);
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
    };
    await refresh();
    draw();
    await poll(alive, () => (['queued', 'running'].includes(job.status) || regenerating.length ? 2000 : 15000), async () => {
      await refresh();
      if (alive()) draw();
      return false;
    });
  }

  function jobHead(job, regenerating) {
    const done = job.items.filter((i) => ['passed', 'warning', 'needs_review', 'failed'].includes(i.status)).length;
    return `<div class="panel">
      <div class="row"><h1 style="margin:0 auto 0 0">${esc(job.title)} <span class="muted" style="font-weight:500">— ${job.options.mode === 'integrated' ? '통합 변형' : '수치 변형'} 세트</span></h1>${chip(JOB_STATUS, job.status)}</div>
      <p class="muted small" style="margin:6px 0">${fmtTime(job.createdAt)} · ${done}/${job.items.length}문제 처리 · ${esc(job.modelLabel || PROVIDER_LABEL[job.options.provider] || 'DeepSeek')} · ${tokens(job.usage, job.options.provider)} (상한 ${job.budget.maxCalls}회 / ${Number(job.budget.maxTokens).toLocaleString()}토큰) · 사고 강도 ${job.options.effort === 'high' ? '정밀' : '기본'}</p>
      ${job.error ? `<div class="note ${job.status === 'cancelled' ? 'warn' : 'bad'}">${esc(job.error)}</div>` : ''}
      ${regenerating.length ? `<div class="note info">문제 ${regenerating.map((r) => r.itemIndex + 1).join(', ')}번을 피드백으로 다시 만드는 중입니다.</div>` : ''}
      <div class="progress">${job.items.map((i) => `<span class="chip ${(ITEM_STATUS[i.status] || [])[1] || ''}">${i.index + 1}. ${esc(i.label)} · ${(ITEM_STATUS[i.status] || [i.status])[0]}</span>`).join('')}</div>
      <div class="row">
        <a href="#/m/${job.materialId}">원본 자료</a>
        <span class="spacer"></span>
        ${['queued', 'running'].includes(job.status) ? '<button id="cancel" class="danger">취소</button>' : ''}
        ${['interrupted', 'failed', 'cancelled'].includes(job.status) ? '<button id="resume" class="primary">남은 문제 이어서 만들기</button>' : ''}
        <a class="btn" href="report.html?job=${job.id}" target="_blank" rel="noopener">학습지·PDF 보기</a>
        ${['queued', 'running'].includes(job.status) ? '' : '<button id="delete" class="danger small">세트 삭제</button>'}
      </div>
      <details data-k="log"><summary>진행 기록 (${(job.log || []).length})</summary><div class="inner"><div class="log">${(job.log || []).slice().reverse().map((l) => `<div>${fmtTime(l.t)} ${esc(l.message)}</div>`).join('')}</div></div></details>
      <details data-k="rules"><summary>이 세트에 붙인 교사 지침 (${job.rules.length})</summary><div class="inner">${job.rules.length ? '<ul>' + job.rules.map((r) => `<li>[${{ material: '이 문제', topic: '유형' }[r.scope] || '모든 문제'}·${KIND[r.kind]}·${TARGET[r.target]}] ${esc(r.text)}</li>`).join('') + '</ul>' : '<span class="muted small">없음</span>'}</div></details>
    </div>`;
  }
  function bindHead(job) {
    $('#cancel')?.addEventListener('click', guard(async () => { await api('POST', `/api/jobs/${job.id}/cancel`); toast('취소를 요청했습니다.'); wake(); }));
    $('#resume')?.addEventListener('click', guard(async () => { await api('POST', `/api/jobs/${job.id}/resume`); toast('이어서 진행합니다.'); route(); }));
    $('#delete')?.addEventListener('click', guard(async () => { if (confirm('이 세트를 삭제할까요?')) { await api('DELETE', '/api/jobs/' + job.id); location.hash = '#/m/' + job.materialId; } }));
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

  function itemCard(job, item, busy) {
    const p = item.problem;
    const v = item.verification;
    if (v?.blind && p) v.blind.match = v.blind.answer === p.answer;
    const repairs = (item.attempts || []).filter((a) => a.kind === 'repair').length;
    const running = ['generating', 'verifying', 'repairing'].includes(item.status);
    return `<div class="item" data-item="${item.index}">
      <div class="head"><span class="num">문제 ${item.index + 1}</span><span>${esc(item.label)}</span>${chip(ITEM_STATUS, item.status)}
        ${repairs ? `<span class="chip">검토 후 수정 ${repairs}회</span>` : ''}${item.history?.length ? `<span class="chip">피드백 재생성 ${item.history.length}회</span>` : ''}${busy ? '<span class="chip run">다시 만드는 중</span>' : ''}</div>
      <div class="body">
        ${item.status === 'failed' ? `<div class="note bad">${esc(item.error || '생성하지 못했습니다.')}</div>` : ''}
        ${!p ? `<p class="muted">${running ? '만드는 중입니다…' : item.status === 'pending' ? '차례를 기다리는 중입니다.' : ''}</p>` : `
          ${item.problems?.length ? `<div class="note bad"><b>교사 검토 필요 — 자동 검증에서 해결되지 않은 점</b><ul>${item.problems.map((x) => `<li>${inlineRich(x)}</li>`).join('')}</ul></div>` : ''}
          ${item.warnings?.length ? `<div class="note warn"><b>확인할 점</b><ul>${item.warnings.map((x) => `<li>${inlineRich(x)}</li>`).join('')}</ul></div>` : ''}
          <div class="rich">${rich(p.text)}</div>
          ${p.figure ? `<div class="note info"><b>그림</b><div class="rich">${rich(p.figure)}</div></div>` : ''}
          ${choicesHtml(p)}`}
      </div>
      ${p ? `
      <details data-k="sol" open><summary>정답과 해설 — 정답 ${p.answer ? circled(p.answer) : '(서술형)'}</summary><div class="inner">
        ${(item.solution?.steps || []).map((s) => `<div class="step"><div class="head">${s.step ? `<span class="badge">원본 STEP ${s.step}</span>` : ''}${rich(s.title).replace(/^<p>|<\/p>$/g, '')}</div><div class="rich">${rich(s.work)}</div></div>`).join('')}
        ${item.solution?.summary ? `<p><b>정리</b> ${rich(item.solution.summary).replace(/^<p>|<\/p>$/g, '')}</p>` : ''}</div></details>
      <details data-k="design"><summary>설계 의도</summary><div class="inner"><div class="rich">${rich(item.designNote || '')}</div><p class="small muted">사용한 원본 STEP: ${(item.usesSteps || []).join(', ')}</p></div></details>
      <details data-k="verify"><summary>검증 상세</summary><div class="inner">${verificationHtml(v)}</div></details>
      <details data-k="rules"><summary>교사 지침 적용 (${v?.rules?.length || 0})</summary><div class="inner">${v?.rules?.length ? `<table class="rules"><tr><th>지침</th><th>생성 모델이 밝힌 적용 방법</th><th>독립 검토</th></tr>${v.rules.map((r) => `<tr><td>${esc(r.text)}</td><td>${esc(r.how || '— (언급 없음)')}</td><td>${r.judged ? (r.judged.ok ? '✅ ' : '❌ ') + esc(r.judged.note || '') : '<span class="muted">해설 지침은 원문 확인</span>'}</td></tr>`).join('')}</table>` : '<span class="muted small">붙인 지침이 없습니다.</span>'}</div></details>` : ''}
      ${item.history?.length ? `<details data-k="hist"><summary>이전 버전 (${item.history.length})</summary><div class="inner">${item.history.map((h) => `<div class="note"><div class="small muted">${fmtTime(h.replacedAt)} 교체 · 피드백: ${esc(h.feedback || '없음')}</div><div class="rich">${rich(h.problem?.text || '')}</div>${h.problem ? choicesHtml(h.problem) : ''}</div>`).join('')}</div></details>` : ''}
      ${['passed', 'warning', 'needs_review', 'failed'].includes(item.status) ? `
      <details data-k="fb" ${item.status === 'needs_review' || item.status === 'failed' ? 'open' : ''}><summary>피드백 남기기 / 다시 만들기</summary><div class="inner">
        <p class="muted small">남긴 피드백은 <a href="#/m/${job.materialId}">원본 문제</a>의 피드백으로 모여, 이 문제로 만드는 모든 변형에 이 변형 문제 내용과 함께 전달됩니다.</p>
        <div><label>대상</label><select name="target"><option value="all">전체</option><option value="problem">문제</option><option value="solution">해설</option></select></div>
        <label>내용</label><textarea name="fb" placeholder="예: STEP 1 연습인데 남는 물질이 B라고 문제에서 알려줘서 STEP 1을 안 거쳐도 풀립니다. 추론할 결론은 주지 마세요."></textarea>
        <label class="inline"><input type="checkbox" name="approve" checked> 바로 켜기 — 다음 생성부터 적용</label>
        <div class="row" style="margin-top:8px"><span class="spacer"></span><button name="save">피드백 저장</button><button name="regen" class="primary" ${busy || !['done', 'failed', 'cancelled', 'interrupted'].includes(job.status) ? 'disabled' : ''}>저장하고 이 문제 다시 만들기</button></div>
      </div></details>` : ''}
    </div>`;
  }

  function bindItem(job, item, card) {
    const save = async (andRegen) => {
      const text = $('textarea[name=fb]', card).value.trim();
      if (!text && !andRegen) throw new Error('피드백 내용을 입력해 주세요.');
      if (text) {
        await api('POST', '/api/rules', {
          text, kind: 'feedback', target: $('[name=target]', card).value, scope: 'material',
          status: $('[name=approve]', card).checked ? 'approved' : 'pending', source: { jobId: job.id, itemIndex: item.index },
        });
      }
      if (andRegen) { await api('POST', `/api/jobs/${job.id}/items/${item.index}/regenerate`, { feedback: text }); wake(); }
      $('textarea[name=fb]', card).value = '';
      toast(andRegen ? '피드백을 저장하고 이 문제를 다시 만드는 중입니다.' : '피드백을 저장했습니다. ' + ($('[name=approve]', card).checked ? '다음 생성부터 적용됩니다.' : '원본 문제 화면에서 켜면 적용됩니다.'));
    };
    $('button[name=save]', card)?.addEventListener('click', guard(() => save(false)));
    $('button[name=regen]', card)?.addEventListener('click', guard(async (e) => { e.target.disabled = true; await save(true); }));
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

  // ------------------------------------------------------------------ rules
  async function rulesView() {
    const [rules, promptsText, corrections, preview, materials] = await Promise.all([api('GET', '/api/rules'), api('GET', '/api/prompts'), api('GET', '/api/corrections'), api('GET', '/api/learning/preview'), api('GET', '/api/materials')]);
    const titleOf = new Map(materials.map((x) => [x.id, x.title]));
    const on = rules.filter((r) => r.status === 'approved');
    const off = rules.filter((r) => r.status !== 'approved');
    const KIND_L = { do: '꼭 할 것', dont: '하지 말 것', feedback: '피드백' };
    const TARGET_L = { problem: '문제', solution: '해설', design: '문제', all: '문제·해설 전체' };
    const item = (r) => `<div class="learn-item" data-rule="${r.id}">
      <div class="learn-item-main">
        <div class="learn-text">${esc(r.text)}</div>
        <div class="learn-meta"><span class="chip">${KIND_L[r.kind] || r.kind}</span><span class="chip">${TARGET_L[r.target] || r.target}</span>${r.subject ? `<span class="chip">${esc(r.subject)}</span>` : ''}
          <span class="muted small">${r.applied ? `문제 세트 ${r.applied}개에 반영됨` : '아직 반영된 적 없음'}${r.source?.jobId ? ` · <a href="#/j/${r.source.jobId}">어떤 문제에 대한 피드백인지 보기</a>` : ''}</span></div>
      </div>
      <div class="learn-actions">${r.status === 'approved' ? '<button class="small" data-act="off">끄기</button>' : '<button class="small primary" data-act="on">켜기</button>'}<button class="small" data-act="edit">수정</button><button class="small danger" data-act="del">삭제</button></div>
    </div>`;
    const section = (title, when, list, empty) => `<div class="learn-sec"><div class="learn-sec-head"><h3>${title}</h3><span class="learn-when">${when}</span></div>
      <div class="learn-list">${list.map(item).join('') || `<p class="muted small">${empty}</p>`}</div></div>`;
    const EXAMPLES = ['풀이에 쓰이지 않는 조건이나 서술을 넣지 않는다.', '최종 문제는 숫자만 바꾸지 말고 앞 연습 문제의 아이디어를 엮어 새 구조로 만든다.', '해설은 원본 해설의 보조 문자와 풀이 순서를 그대로 따른다.'];
    // Problem feedback grouped by its problem, each group linking to the problem's workspace.
    const byMaterial = new Map();
    for (const r of on.filter((x) => x.scope === 'material')) byMaterial.set(r.source?.materialId, [...(byMaterial.get(r.source?.materialId) || []), r]);
    const perProblem = [...byMaterial].map(([id, list]) => `<div class="learn-sub"><div class="row"><b>${esc(titleOf.get(id) || '삭제된 문제')}</b><span class="spacer"></span>${titleOf.has(id) ? `<a href="#/m/${id}">문제 열기 ›</a>` : ''}</div><div class="learn-list">${list.map(item).join('')}</div></div>`).join('');
    view.innerHTML = `<h1>전체 피드백</h1>
      <div class="panel learn-intro">
        <p>피드백은 <b>문제마다</b> 쌓는 것이 기본입니다. 문제 화면에서 남긴 피드백은 그 문제로 만드는 변형에만 붙고, <b>모든 문제에 적용</b>으로 표시한 것은 모든 문제에 붙습니다. AI 모델을 다시 훈련시키지 않으므로 저장하면 <b>바로 다음 생성부터</b> 반영되고, 끄거나 지우면 바로 빠집니다.</p>
        <div class="learn-flow">
          <div><span class="num">1</span><b>가르치기</b><span>문제 화면의 피드백, 변형 문제 카드의 피드백, 아래 입력, 분석 결과 수정</span></div>
          <div><span class="num">2</span><b>저장</b><span>이 문제만 / 모든 문제 / 사진 읽기 중 어디에 쓸지 기억</span></div>
          <div><span class="num">3</span><b>다음에 전달</b><span>새 문제를 만들 때 맞는 내용을 골라 AI 지시문에 붙임</span></div>
          <div><span class="num">4</span><b>지켰는지 확인</b><span>문제 카드의 '교사 지침 적용'에서 어떻게 지켰는지와 독립 검토 판정을 보여 줌</span></div>
        </div>
      </div>

      <div class="panel">
        <h2>모든 문제에 적용할 피드백 추가</h2>
        <p class="muted small">한 문제에 대한 피드백은 그 문제 화면에서 남기세요.</p>
        <label>가르칠 내용</label>
        <textarea id="ntext" placeholder="예: 풀이에 쓰이지 않는 조건이나 서술을 넣지 않는다."></textarea>
        <div class="learn-examples">${EXAMPLES.map((t) => `<button type="button" class="small ex">${esc(t)}</button>`).join('')}</div>
        <div class="cols cols-3" style="margin-top:10px">
          <div><label>적용 범위</label><select id="ns"><option value="global">모든 문제</option></select></div>
          <div><label>종류</label><select id="nk"><option value="do">꼭 할 것</option><option value="dont">하지 말 것</option></select></div>
          <div><label>어디에</label><select id="nt"><option value="all">문제·해설 전체</option><option value="problem">문제 (조건·발문·선택지)</option><option value="solution">해설</option></select></div>
        </div>
        <div class="row" style="margin-top:10px"><span class="spacer"></span><button class="primary" id="add">추가</button></div>
      </div>

      <div class="panel">
        <h2>가르친 내용 (켜져 있는 것 ${on.length + corrections.length}개)</h2>
        ${section('모든 문제에 적용', '모든 문제를 만들 때', on.filter((r) => r.scope === 'global'), '아직 없습니다. 위에서 추가하거나, 문제 화면의 피드백에서 "모든 문제에 적용"을 누르세요.')}
        <div class="learn-sec"><div class="learn-sec-head"><h3>문제별 피드백</h3><span class="learn-when">그 문제로 변형을 만들 때 · 문제 화면에서 관리</span></div>
          ${perProblem || '<p class="muted small">아직 없습니다. 문제 화면에서 남기면 여기에 문제별로 모입니다.</p>'}</div>
        ${on.some((r) => r.scope === 'topic') ? section('예전 유형별 피드백', '같은 과목의 비슷한 문제를 만들 때 (이전 방식)', on.filter((r) => r.scope === 'topic'), '') : ''}
        <div class="learn-sec"><div class="learn-sec-head"><h3>사진 읽기 교정</h3><span class="learn-when">원본 사진을 읽을 때 · 분석 결과에서 단어를 고치면 자동으로 쌓임</span></div>
          <div class="learn-list">${corrections.map((c) => `<div class="learn-item" data-corr="${c.id}"><div class="learn-item-main"><div class="learn-text">"${esc(c.wrong)}"로 잘못 읽음 → 원본은 "${esc(c.right)}"</div>
            <div class="learn-meta"><span class="muted small">${c.count}번 고침 · ${esc(c.subject || '')} · 다음 판독 때 이 단어를 주의해서 읽게 하고 확인 항목에 올림</span></div></div>
            <div class="learn-actions"><button class="small danger" data-act="del-corr">삭제</button></div></div>`).join('') || '<p class="muted small">아직 없습니다. 분석 결과 화면에서 잘못 읽은 단어를 고치면 여기에 쌓입니다.</p>'}</div></div>
        ${off.length ? `<details class="learn-off" data-k="learn-off"><summary>꺼 둔 내용 (${off.length}) — 다음 생성에 쓰지 않음</summary><div class="learn-list">${off.map(item).join('')}</div></details>` : ''}
      </div>

      <div class="panel">
        <details data-k="learn-preview"><summary><b>AI에게 실제로 전달되는 모습</b> <span class="muted small">— 모든 문제에 붙는 부분</span></summary><div class="inner">
          <p class="muted small">문제를 만들 때 기본 지시문 뒤에 아래 내용이 그대로 붙습니다. 비슷한 문제용 피드백은 문제마다 골라서 더 붙습니다.</p>
          <pre class="values">${esc(preview.rules || '(붙일 내용 없음)')}</pre>
          ${preview.reading ? `<p class="muted small">사진을 읽을 때는 이 내용이 붙습니다.</p><pre class="values">${esc(preview.reading)}</pre>` : ''}
        </div></details>
      </div>

      <div class="panel"><details data-k="prompts"><summary>AI 기본 지시문 (고정 · 버전 ${esc(promptsText.version)}) — 학습 내용은 이 뒤에 덧붙습니다</summary><div class="inner">
        ${[['analyze', '원본 분석'], ['proofread', '원본 대조 교정'], ['reread-question', '발문 재판독'], ['reread-headings', '해설 단계 제목 재판독'], ['reread-problem', '문제 본문 재판독 (필기 유입 시)'], ['regroup', 'STEP 묶기'], ['fix-verification', '원본 검산 프로그램 수정'], ['generate', '변형 문제 설계'], ['solve', '독립 풀이 검토'], ['review-solution', '해설 대조 검토'], ['repair', '검토 후 수정']].map(([k, t]) => `<h3>${t}</h3><pre class="values" style="max-height:340px">${esc(promptsText[k])}</pre>`).join('')}</div></details></div>`;
    $$('.learn-examples .ex').forEach((b) => b.addEventListener('click', () => { $('#ntext').value = b.textContent; $('#ntext').focus(); }));
    $('#add').addEventListener('click', guard(async () => {
      if (!$('#ntext').value.trim()) throw new Error('가르칠 내용을 입력해 주세요.');
      await api('POST', '/api/rules', { text: $('#ntext').value, kind: $('#nk').value, target: $('#nt').value, scope: $('#ns').value });
      toast('학습에 추가했습니다. 다음 문제 생성부터 반영됩니다.'); rulesView();
    }));
    $$('[data-corr] [data-act]').forEach((b) => b.addEventListener('click', guard(async () => {
      if (!confirm('이 교정 기억을 삭제할까요?')) return;
      await api('DELETE', '/api/corrections/' + b.closest('[data-corr]').dataset.corr);
      rulesView();
    })));
    $$('[data-rule] [data-act]').forEach((b) => b.addEventListener('click', guard(async () => {
      const id = b.closest('[data-rule]').dataset.rule;
      const act = b.dataset.act;
      if (act === 'del') { if (!confirm('이 내용을 학습에서 삭제할까요?')) return; await api('DELETE', '/api/rules/' + id); }
      else if (act === 'edit') {
        const rule = rules.find((r) => r.id === id);
        const text = prompt('내용 수정', rule.text);
        if (text === null) return;
        await api('PUT', '/api/rules/' + id, { text });
      } else await api('PUT', '/api/rules/' + id, { status: act === 'on' ? 'approved' : 'pending' });
      rulesView();
    })));
  }


  // ------------------------------------------------------------------ system
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
          throw new Error('확인이 너무 오래 걸립니다. 잠시 후 시스템 화면을 다시 열어 확인해 주세요.');
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

  async function systemView() {
    const [status, sys] = await Promise.all([api('GET', '/api/status'), api('GET', '/api/system')]);
    const checks = [
      ['정답이 하나로 정해지는지', '보기 중 정답이 딱 하나인지, 조건끼리 모순은 없는지'],
      ['계산이 맞는지', '문제의 모든 수를 컴퓨터가 분수로 정확히 다시 계산'],
      ['처음 보는 사람도 풀리는지', '정답을 모르는 별도의 AI가 문제만 보고 풀어서 정답과 비교'],
      ['쓰이지 않는 조건이 없는지', '문제의 모든 문장과 수치가 풀이에 실제로 쓰이는지'],
      ['선생님 풀이 방법 그대로인지', '해설의 STEP 제목, 보조 문자, 가정→모순 판정, 풀이 순서를 유지하는지 — 별도 검토자가 만든 해설을 선생님 해설과 STEP별로 대조해 다른 논리·뒤바뀐 표기·빠진 단계를 찾음'],
      ['목표한 STEP만 필요한지', 'STEP 1 연습이면 STEP 1만으로, 최종 문제면 모든 STEP이 필요해야 함'],
      ['핵심 기법을 건너뛸 수 없는지', '가정→모순 같은 STEP의 기법 없이 결론이 나오면 안 됨 (예: 남은 질량이 넣은 질량보다 커서 남은 물질이 바로 보이거나, 표에 남은 물질을 적어 둔 경우)'],
      ['최종 문제가 숫자만 바꾼 게 아닌지', '실험 수·숨긴 값 위치·판정 방향·묻는 대상 중 둘 이상이 원본과 달라야 함 (표 구조와 숨긴 값 위치가 원본과 같으면 컴퓨터가 잡음)'],
      ['반응식·조건을 바꿔 쉽게 만들지 않았는지', '원본 반응식의 계수를 바꾸거나 정보 없는 소개 문장을 넣으면 안 됨'],
      ['선생님 지침을 지켰는지', '저장된 지침마다 어떻게 지켰는지 확인하고, 어기면 고치게 함'],
    ];

    view.innerHTML = `
      <section class="sys-hero">
        <div class="eyebrow">EduMaster 안내</div>
        <h1>선생님의 풀이로, 단계별 연습 문제를 만듭니다</h1>
        <p>문제와 해설 사진을 넣으면 선생님 해설의 풀이 순서를 그대로 따라 STEP 1 연습 → STEP 1~2 연습 → 최종 문제를 차례로 만들고, 만든 문제는 자동으로 검토합니다.</p>
        <div class="hero-points">
          <div><b>선생님 풀이 그대로</b><span>AI가 자기 방식으로 바꿔 풀지 않도록 해설의 방법을 기준으로 삼습니다.</span></div>
          <div><b>계산은 컴퓨터가 확인</b><span>AI가 쓴 수치와 정답을 컴퓨터가 다시 계산해 봅니다.</span></div>
          <div><b>피드백이 쌓일수록 좋아짐</b><span>남겨 주신 피드백과 수정 내용을 다음 문제에 반영합니다.</span></div>
        </div>
      </section>

      <div class="panel">
        <h2>문제는 이렇게 만들어집니다</h2>
        <div class="sys-steps">
          <div class="sys-step"><span class="num">1</span><b>원본 읽기</b><p>문제와 해설 사진을 읽어 옮겨 적고, 해설을 STEP으로 나눕니다. 연필·펜 필기는 문제 조건에서 뺍니다.</p></div>
          <div class="sys-step"><span class="num">2</span><b>선생님 확인</b><p>읽은 내용과 STEP을 보여 드립니다. 잘못 읽은 곳은 바로 고치실 수 있고, 고친 내용이 기준이 됩니다.</p></div>
          <div class="sys-step"><span class="num">3</span><b>단계별 문제 만들기</b><p>STEP 1만 알면 풀리는 문제, STEP 1~2가 필요한 문제, 모든 STEP이 필요한 최종 문제를 차례로 만듭니다.</p></div>
          <div class="sys-step"><span class="num">4</span><b>자동 검토</b><p>아래 항목을 검사해 문제가 있으면 AI가 스스로 고칩니다. 그래도 남으면 이유와 함께 '교사 검토 필요'로 표시합니다.</p></div>
        </div>
        <p class="muted small">최종 문제는 두 가지 중 고를 수 있습니다: <b>통합 변형</b>(앞 연습 문제의 아이디어를 엮어 새 구조로) 또는 <b>수치 변형</b>(같은 구조에 새 숫자로).</p>
      </div>

      <div class="panel">
        <h2>자동 검토에서 확인하는 것</h2>
        <div class="check-grid">${checks.map(([t, d]) => `<div class="check-item"><b>${t}</b><span>${d}</span></div>`).join('')}</div>
        <div class="note info small">검사를 통과해도 AI가 판단한 결과이므로, 학생에게 내기 전에 한 번 확인해 주세요. '교사 검토 필요'나 '확인할 점'이 붙은 문제는 그 이유를 문제 카드에서 볼 수 있습니다.</div>
      </div>

      <div class="panel sys-pointer">
        <div><h2>생성 모델</h2><p class="muted small">문제를 만들 때 DeepSeek과 Gemma 중에서 고를 수 있고, Claude Opus는 품질 비교용으로 평가했습니다. 문제를 얼마나 잘 만드는지, 한 문제에 얼마가 드는지, 실제로 만든 문제는 모델 비교 화면에 모아 두었습니다.</p></div>
        <a class="button primary" href="#/compare">모델 비교 보기</a>
      </div>

      <div class="panel">
        <h2>학습 — 무엇을 배우고, 어떻게 반영되나요</h2>
        <p class="muted small">AI 모델 자체를 다시 훈련시키지 않습니다. 선생님이 남긴 내용을 저장해 두었다가, 새 문제를 만들거나 사진을 읽을 때 <b>그 상황에 맞는 것을 찾아 AI에게 함께 전달</b>합니다(RAG). 그래서 저장하는 즉시 다음 작업부터 반영되고, 지우면 바로 빠집니다.</p>
        <div class="learn-rows">
          <div class="learn-row">
            <div class="learn-title"><span class="num">1</span><b>문제에 대한 피드백</b></div>
            <div class="learn-cell"><span class="lbl">선생님이 하시는 일</span>만든 문제 카드에 "STEP 1 연습인데 남는 물질을 문제에서 알려 줘서 추론할 게 없어요"처럼 피드백을 남깁니다.</div>
            <div class="learn-cell"><span class="lbl">시스템이 기억하는 것</span>피드백 문장과 함께, <b>어떤 문제에 대한 피드백이었는지</b>(과목·유형·그 문제 내용)를 저장합니다.</div>
            <div class="learn-cell"><span class="lbl">다음에 달라지는 것</span>같은 과목의 비슷한 문제를 만들 때 이 피드백과 당시 문제를 AI에게 보여 주고 같은 실수를 하지 말라고 지시합니다. 다른 과목 문제에는 붙지 않습니다.</div>
          </div>
          <div class="learn-row">
            <div class="learn-title"><span class="num">2</span><b>전체 지침</b></div>
            <div class="learn-cell"><span class="lbl">선생님이 하시는 일</span>'해야 할 것 / 하지 말 것'을 적습니다. 예: "풀이에 필요 없는 조건을 넣지 않는다", "최종 문제는 숫자만 바꾸지 않는다".</div>
            <div class="learn-cell"><span class="lbl">시스템이 기억하는 것</span>지침 문장과 적용 대상(문제·해설·설계)을 저장합니다.</div>
            <div class="learn-cell"><span class="lbl">다음에 달라지는 것</span>모든 문제를 만들 때 항상 전달합니다. 만든 문제마다 AI가 지침을 어떻게 지켰는지 적고, 독립 검토가 실제로 지켰는지 다시 판정해 결과 카드에 보여 줍니다.</div>
          </div>
          <div class="learn-row">
            <div class="learn-title"><span class="num">3</span><b>잘못 읽은 글자 수정</b></div>
            <div class="learn-cell"><span class="lbl">선생님이 하시는 일</span>분석 결과 화면에서 잘못 읽은 단어를 고칩니다. 예: "물질량" → "몰질량".</div>
            <div class="learn-cell"><span class="lbl">시스템이 기억하는 것</span>고치기 전과 후를 비교해 <b>바뀐 단어 쌍</b>만 뽑아 저장합니다 (숫자처럼 문제마다 다른 값은 저장하지 않음).</div>
            <div class="learn-cell"><span class="lbl">다음에 달라지는 것</span>다음 사진을 읽을 때 "이 단어를 전에 잘못 읽었다"고 알려 줘 더 주의해서 읽게 하고, 발문에서 맞게 읽힌 단어로 해설의 같은 오독도 함께 고치며, 원본 확인 항목에 올립니다.</div>
          </div>
        </div>
        <p class="small"><a href="#/learn">학습 화면</a>에서 저장된 내용을 보고 끄거나 고치거나 지울 수 있습니다.</p>
      </div>

      <div class="panel">
        <h2>알아 두실 점</h2>
        <ul class="plain-list">
          <li>그림이 꼭 필요한 문제는 그림 대신 글이나 표로 설명합니다. 그림을 새로 그리지는 않습니다.</li>
          <li>작은 사진은 잘못 읽을 수 있습니다. 분석 결과의 '원본과 대조해 주세요' 항목을 꼭 확인해 주세요.</li>
          <li>검토도 AI가 하므로 틀릴 수 있습니다. '검토 통과'는 선생님의 최종 확인을 대신하지 않습니다.</li>
        </ul>
      </div>

      <details class="panel dev-details" data-k="dev"><summary>개발자용 세부 정보</summary><div class="inner">${devDetails(sys)}</div></details>`;
  }

  // ------------------------------------------------------------------ LLM
  // Each model problems can be made with: whether it is connected and what it has used (today / 30 days). The
  // DeepSeek balance and the numbers are fetched when the page opens and on 새로 고침, not continuously.
  async function llmView() {
    view.innerHTML = `<div class="row"><h1 style="margin-right:auto">LLM</h1><span class="muted small" id="llm-at"></span><button id="llm-refresh">새로 고침</button></div>
      <p class="muted">문제를 만들 때 쓰는 AI 모델의 연결 상태와 사용량입니다. 잔액과 사용량은 이 화면을 열거나 <b>새로 고침</b>을 누를 때 가져옵니다.</p>
      <div class="llm-grid" id="llm-cards"><div class="panel muted">불러오는 중…</div></div>`;
    const won = (usd) => (usd ? `약 ${Math.round(usd * 1400).toLocaleString()}원` : '0원');
    const month = (u) => `<p>이번 달: 세트 <b>${u.month.sets}개</b>${u.month.usd ? ` · <b>${won(u.month.usd)}</b>` : ''} <span class="muted small">· 마지막 사용 ${u.lastAt ? fmtTime(u.lastAt) : '없음'}</span></p>`;
    // A window's remaining share as a bar: green with room left, amber when low, red when used up.
    const limitBar = (title, w) => {
      if (!w) return `<div class="limit"><div class="limit-head"><b>${title}</b><span class="muted small">정보 없음</span></div></div>`;
      const left = Math.max(0, Math.round((1 - w.used) * 100));
      return `<div class="limit"><div class="limit-head"><b>${title}</b><span><b>${left}%</b> 남음</span></div>
        <div class="limit-bar"><span class="${left <= 10 ? 'bad' : left <= 30 ? 'warn' : 'ok'}" style="width:${left}%"></span></div>
        <div class="muted small">${w.resetsAt ? fmtTime(w.resetsAt) + '에 다시 채워짐' : ''}</div></div>`;
    };
    const paint = async (fresh) => {
      // 새로 고침 asks Claude once (a tiny question) so the remaining share is current, not as of the last generation.
      if (fresh) await api('POST', '/api/claude-login/check').catch(() => null);
      const [status, llm] = await Promise.all([api('GET', '/api/status'), api('GET', '/api/llm')]);
      const p = status.providers || {};
      const def = status.defaultProvider || 'deepseek';
      // One card per model: its state, what matters for it, managing it, and making it the 기본 모델.
      const card = (key, title, ok, okText, badText, body) => `<div class="panel llm-card${def === key ? ' llm-default' : ''}">
        <div class="row"><h2 style="margin:0">${esc(title)}</h2><span class="spacer"></span><span class="chip ${ok ? 'ok' : 'warn'}">${ok ? okText : badText}</span></div>
        <div class="llm-default-row">${def === key ? '<span class="chip ok">기본 모델</span><span class="muted small">문제 분석·생성에서 처음 선택되는 모델</span>'
          : `<button class="small" data-default="${key}" ${ok ? '' : 'disabled'}>기본 모델로 사용</button>`}</div>${body}</div>`;
      const lim = llm.claude.loggedIn ? llm.claude.limits : null;
      $('#llm-cards').innerHTML = [
        card('claude-cli', 'Claude Opus 5.5 (구독)', llm.claude.loggedIn, '연결됨', '연결 안 됨',
          `${llm.claude.loggedIn ? `${limitBar('5시간 한도', lim?.fiveHour)}${limitBar('1주일 한도', lim?.sevenDay)}
            <p class="muted small">${lim ? `${fmtTime(lim.at)} 기준` : '아직 측정한 적 없음 — 새로 고침을 눌러 주세요'} · 구독으로 실행 · 호출당 비용 없음</p>${month(llm.usage['claude-cli'])}` : ''}
          <div id="claude-login"></div>`),
        card('deepseek', p.deepseek?.label || 'DeepSeek', p.deepseek?.available, '사용 가능', '키 없음',
          `<p>잔액: <b id="ds-balance">확인 중…</b></p>${month(llm.usage.deepseek)}<p class="muted small">쓴 만큼 결제 · 평일 한국 시간 10–13시, 15–19시는 단가 2배</p>
          <div class="fb-add-bar"><span class="muted small">API 키 ${esc(llm.deepseek.key || '없음')}</span><span class="spacer"></span><button class="small" id="ds-key-edit">키 변경</button></div>
          <div id="ds-key-form" hidden><input type="password" id="ds-key" autocomplete="off" placeholder="새 DeepSeek API 키 (sk-…)">
            <div class="fb-add-bar"><span class="muted small">저장 전에 DeepSeek에 확인합니다.</span><span class="spacer"></span><button class="small" id="ds-key-cancel">취소</button><button class="small primary" id="ds-key-save">저장</button></div></div>`),
        card('gemma', p.gemma?.label || 'PC 모델', p.gemma?.available, 'PC 켜짐', 'PC 꺼짐',
          `<p class="muted small">선생님 PC에서 실행 · 무료 · PC가 켜져 있을 때만${p.gemma?.model ? ` · ${esc(p.gemma.model)}` : ''}</p>${month(llm.usage.gemma)}`),
      ].join('');
      $('#llm-at').textContent = fmtTime(new Date().toISOString()) + ' 기준';
      api('GET', '/api/balance').then((x) => { if ($('#ds-balance')) $('#ds-balance').textContent = x.balance; }).catch(() => { if ($('#ds-balance')) $('#ds-balance').textContent = '확인 실패'; });
      $$('[data-default]').forEach((b) => b.addEventListener('click', guard(async () => {
        await api('PUT', '/api/llm/default', { provider: b.dataset.default });
        await loadStatus().catch(() => {});
        toast('기본 모델을 바꿨습니다. 문제 분석·생성에서 이 모델이 처음 선택됩니다.');
        await paint(false);
      })));
      $('#ds-key-edit').addEventListener('click', () => { $('#ds-key-form').hidden = false; $('#ds-key').focus(); });
      $('#ds-key-cancel').addEventListener('click', () => { $('#ds-key').value = ''; $('#ds-key-form').hidden = true; });
      $('#ds-key-save').addEventListener('click', guard(async (e) => {
        e.target.disabled = true;
        try { await api('PUT', '/api/llm/deepseek-key', { key: $('#ds-key').value }); toast('DeepSeek API 키를 바꿨습니다.'); await paint(false); }
        finally { if (e.target.isConnected) e.target.disabled = false; }
      }));
      claudeLoginPanel().catch(() => {});
    };
    $('#llm-refresh').addEventListener('click', guard(async (e) => { e.target.disabled = true; e.target.textContent = '가져오는 중…'; try { await paint(true); } finally { e.target.disabled = false; e.target.textContent = '새로 고침'; } }));
    await paint(false);
  }


  // Technical view of the same system (prompt version, every check, eval runs), folded away for teachers.
  function devDetails(sys) {
    const ON_FAIL = { fix: ['ok', '자동 수정'], repair: ['run', '모델에 수정 요청'], review: ['bad', '교사 검토 필요'], note: ['warn', '확인할 점'] };
    const checkTable = (list) => `<div class="table-wrap"><table class="rules sys"><tr><th>검사</th><th>하는 일</th><th>걸리면</th></tr>${list.map((c) => `<tr><td><b>${esc(c.label)}</b></td><td>${esc(c.how)}</td><td><span class="chip ${ON_FAIL[c.onFail][0]}">${ON_FAIL[c.onFail][1]}</span></td></tr>`).join('')}</table></div>`;
    const modelName = (p) => PROVIDER_LABEL[p] || p;
    const score = (s) => (s ? `${s.pass}/${s.total}` : '-');
    return `
      <h3>프롬프트 (버전 ${esc(sys.prompts.version)})</h3>
      <div class="table-wrap"><table class="rules sys"><tr><th>지시문</th><th>하는 일</th><th>길이</th></tr>${sys.prompts.list.map((p) => `<tr><td><code>${esc(p.id)}</code></td><td>${esc(p.purpose)}</td><td class="muted">${p.chars.toLocaleString()}자</td></tr>`).join('')}</table></div>
      <h3>하네스 — 분석 단계</h3>${checkTable(sys.checks.analysis)}
      <h3>하네스 — 생성 단계</h3>${checkTable(sys.checks.generation)}
      <p class="small muted">${esc(sys.checks.repair)}</p>
      <h3>평가 실행 기록</h3>
      ${sys.evals.map((e) => `<div class="small"><b>${esc(e.stamp)}</b> · ${e.stage === 'full' ? '분석+생성' : '분석'}${e.promptVersion ? ' · 프롬프트 ' + esc(e.promptVersion) : ''}${e.learning ? ` · ${e.learning.used === 'none' ? '학습 끔' : `지침 ${e.learning.rules}·교정 ${e.learning.corrections}`}` : ''}</div>
        <div class="table-wrap"><table class="rules sys"><tr><th>사례</th><th>모델</th><th>분석</th><th>생성</th><th>실패한 항목</th></tr>${e.rows.map((x) => `<tr><td>${esc(x.case)}</td><td>${esc(modelName(x.provider))}</td><td>${score(x.analysis)}</td><td>${score(x.generation)}</td><td class="small">${x.error ? esc(x.error) : x.failed.length ? x.failed.map(esc).join('<br>') : '없음'}</td></tr>`).join('')}</table></div>`).join('') || '<p class="muted small">평가 보고서 없음</p>'}
      <h3>작업별 한도</h3>
      <p class="small">분석 ${sys.budget.analyzeCalls}회·${sys.budget.analyzeTokens.toLocaleString()}토큰 / 세트 생성 ${sys.budget.generateCalls}회·${sys.budget.generateTokens.toLocaleString()}토큰 / 한 문제 다시 만들기 ${sys.budget.regenerateCalls}회·${sys.budget.regenerateTokens.toLocaleString()}토큰</p>`;
  }

  // ------------------------------------------------------------------ boot
  (async () => {
    try {
      const status = await loadStatus();
      if (!status.authenticated) return showLogin();
      $('#logout').hidden = false;
    } catch { /* shown per view */ }
    route();
  })();
})();
