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
  const ITEM_STATUS = { pending: ['대기', ''], generating: ['설계 중', 'run'], verifying: ['검증 중', 'run'], repairing: ['수정 중', 'run'], passed: ['검증 통과', 'ok'], warning: ['확인할 점', 'warn'], needs_review: ['교사 검토 필요', 'bad'], failed: ['실패', 'bad'] };
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
      else if (hash.startsWith('#/learning')) { setNav('learning'); await learningView(); }
      else if (hash.startsWith('#/common') || hash.startsWith('#/rules') || hash.startsWith('#/learn')) { location.replace('#/learning'); return; }
      else if (hash.startsWith('#/system')) { location.replace('#/llm'); return; }
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

  // ------------------------------------------------------------------ the problem's progress
  // The whole way a problem goes, across the top of its page: each step done, running, waiting for the teacher or not
  // reached yet, and one line on what is happening now (with a spinner while the server works) or what to do next.
  const FLOW = [['upload', '원본'], ['read', '분석'], ['check', '확인'], ['make', '변형 생성'], ['review', '검토·채택']];
  const isBusy = (j) => ['queued', 'running'].includes(j.status);
  const setsOf = (m) => (m.jobs || []).filter((j) => j.type === 'generate').sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  function flowState(m) {
    const gens = setsOf(m);
    const making = gens.find(isBusy);
    const regen = (m.jobs || []).find((j) => j.type === 'regenerate' && isBusy(j));
    const ready = m.status === 'ready' && m.steps;
    const open = ready ? analysisNotes(m).open : 0;
    const st = { upload: { state: 'done', note: '' } };
    st.read = m.status === 'analyzing' ? { state: 'run', note: '분석 중' } : m.status === 'failed' || !m.steps ? { state: 'bad', note: '분석 실패' } : { state: 'done', note: `STEP ${m.steps.length}개` };
    st.check = !ready ? { state: 'todo', note: '' } : open ? { state: 'warn', note: `남은 확인 ${open}개` } : { state: 'done', note: '확인 완료' };
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
      st.review = regen ? { state: 'run', note: '다시 만드는 중' } : review ? { state: 'warn', note: `검토 필요 ${review}` }
        : adopted ? { state: 'done', note: `채택 ${adopted}/${items.length}` } : { state: 'warn', note: `채택 0/${items.length}` };
    }
    let now;
    if (m.status === 'analyzing') now = { tone: 'run', text: 'AI가 원본을 읽고 STEP으로 정리하고 있습니다. 보통 1~3분 걸리고, 화면을 닫아도 서버에서 계속됩니다. 끝나면 이 화면이 저절로 바뀝니다.' };
    else if (st.read.state === 'bad') now = { tone: 'bad', text: '분석하지 못했습니다. 다시 분석하거나 더 선명한 사진을 넣어 주세요.' };
    else if (making) now = { tone: 'run', text: `변형 문제를 만드는 중입니다 (${making.status === 'queued' ? '순서 기다리는 중' : st.make.done}). 문제마다 설계 → 검산 → 다시 풀어 보기를 거쳐 몇 분 걸립니다. 끝나면 저절로 바뀝니다.`, href: '#/j/' + making.id, action: '진행 보기' };
    else if (regen) now = { tone: 'run', text: '세트의 문제 하나를 다시 만드는 중입니다. 끝나면 저절로 바뀝니다.', href: '#/j/' + regen.parentJobId, action: '진행 보기' };
    else if (open) now = { tone: 'warn', text: `분석 결과에 확인할 곳이 ${open}개 있습니다. 원본과 비교해 맞음·틀림을 눌러 주세요.`, go: 'check', action: '확인하러 가기' };
    else if (!gens.length) now = { tone: 'ok', text: '분석이 끝났습니다. 이제 변형 문제를 만들 수 있습니다.', go: 'make', action: '변형 문제 만들러 가기' };
    else if (st.review.state === 'warn') now = { tone: 'warn', text: `세트 ${no}의 문제를 검토해 주세요 (${st.review.note}). 좋은 문제는 채택, 아쉬운 점은 고칠 점으로 남기면 다음 세트에 반영됩니다.`, href: '#/j/' + latest.id, action: '세트 열기' };
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
      $(`[data-stage-tab="${go === 'check' ? 'read' : 'make'}"]`)?.click();
      if (go === 'check') {
        openSet(m.id).add('a:check');
        const row = $('[data-row="a:check"]');
        row?.classList.add('open');
        row?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      } else $('#generate')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
  // 확인할 곳: what the analysis was unsure of, corrected by itself, or left out as handwriting — each for the teacher
  // to call right (✓ 맞음) or wrong (✏️ 틀림: what is right becomes analysis feedback). Verdicts are kept by the note's text.
  const NOTE_KIND = { word: '단어 확인', uncertain: '판독이 불확실한 곳', proofread: 'AI가 원본과 대조해 스스로 고친 곳', annotation: '필기로 보고 문제 조건에서 뺀 것' };
  // A word the reading has confused before (몰질량↔물질량): from the current note, or the older one-line note.
  function wordNote(text) {
    const now = /^단어 확인: 읽은 내용에 "(.+?)"이\(가\) \d+번 나옵니다\. AI가 "(.+?)"과\(와\) "(.+?)"을\(를\)/.exec(text);
    if (now) return [{ word: now[1], other: now[2] === now[1] ? now[3] : now[2] }];
    const old = /^"(.+)"은\(는\) 판독에서 뒤바뀐 적이 있는 단어입니다\((.+)\)/.exec(text);
    if (!old) return null;
    const pairs = old[2].split(', ').map((p) => p.split('↔'));
    return old[1].split('", "').map((word) => ({ word, other: pairs.find((p) => p.includes(word))?.find((w) => w !== word) })).filter((x) => x.other);
  }
  // Where a word appears in the reading: how often, and a short piece of text around its first appearance.
  function wordUse(m, word) {
    const texts = [m.problem?.text, m.problem?.figure, ...(m.problem?.choices || []), ...(m.steps || []).flatMap((x) => [x.title, x.purpose, x.technique, x.work, x.result])].filter(Boolean);
    const count = texts.reduce((n, t) => n + t.split(word).length - 1, 0);
    const t = texts.find((x) => x.includes(word)) || '';
    const i = t.indexOf(word);
    const piece = i < 0 ? '' : t.slice(Math.max(0, i - 18), i + word.length + 18).replace(/\$+|\\[a-zA-Z]+|\\.|[{}^_]/g, ' ').replace(/\s+/g, ' ').trim();
    return { count, piece };
  }
  const noteKey = (t) => String(t).trim().slice(0, 600);
  function analysisNotes(m) {
    const states = m.noteStates || {};
    const items = [
      ...(m.uncertainties || []).filter((u) => !/^(해설의 단계 표시는|선생님 피드백의 STEP 수는)/.test(u))
        .flatMap((text) => wordNote(text)?.map((w) => ({ kind: 'word', text, ...w })) || [{ kind: 'uncertain', text }]),
      ...(m.proofread || []).filter((t) => !t.startsWith('과거 교사 교정')).map((text) => ({ kind: 'proofread', text })),
      ...(m.annotations || []).map((text) => ({ kind: 'annotation', text })),
    ].map((x) => ({ ...x, state: states[noteKey(x.text)] || '' }));
    return { items, open: items.filter((x) => !x.state).length, misaligned: m.steps.length > (m.targetSteps || 99) };
  }
  // What to start the 틀림 box with, by kind of note.
  function noteFixDraft(x) {
    if (x.kind === 'proofread') {
      const pair = [...x.text.matchAll(/"([^"]+)"\s*→\s*"([^"]+)"/g)].pop();
      return pair ? `"${pair[2]}"가 아니라 원래대로 "${pair[1]}"가 맞다.` : '';
    }
    if (x.kind === 'annotation') return `필기로 뺀 "${x.text.replace(/\s+/g, ' ').slice(0, 80)}"은(는) 인쇄된 문제 조건이니 문제에 넣는다.`;
    return '';
  }

  // The problem page is two stages, each the same loop: what the AI made → what the teacher teaches about it → do it
  // again. ① 원본 분석: the reading and its STEPs, analysis feedback, 다시 분석. ② 변형 문제: the sets made, generation
  // feedback and the adopted models, a new set. Feedback sits right under what it is about, so there is no choosing
  // which kind it is. The stage last opened on this problem is opened again.
  function renderMaterial(m, editing) {
    const n = m.steps.length;
    const gens = m.jobs.filter((j) => j.type === 'generate').sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    if (!openRows.has(m.id)) {
      // First visit: open what needs a look — an unsure reading, the newest set.
      const s = openSet(m.id);
      const notes = analysisNotes(m);
      if (notes.open || notes.misaligned) s.add('a:check');
      if (gens[0]) s.add('s:' + gens[0].id);
    }
    const key = 'em-stage-' + m.id;
    let stage = '';
    try { stage = localStorage.getItem(key) || ''; } catch { /* no storage */ }
    if (editing) stage = 'read';
    if (!['read', 'make'].includes(stage)) stage = gens.length ? 'make' : 'read';
    view.innerHTML = `<div class="lt">
      <div class="lt-title" id="m-name">
        <div class="name-show"><div class="name-text"><h1>${esc(m.title)}</h1><p class="lt-meta">${esc([m.subject, m.topic].filter(Boolean).join(' · ')) || '과목·유형 없음'}</p></div><button class="small" id="name-edit">✏️ 제목 수정</button></div>
        <form class="name-form panel" hidden>
          <div><label for="name-title">제목</label><input type="text" id="name-title" maxlength="120" value="${esc(m.title)}" required></div>
          <div class="name-row"><div><label for="name-subject">과목</label><input type="text" id="name-subject" maxlength="40" value="${esc(m.subject || '')}" placeholder="예: 화학"></div>
            <div><label for="name-topic">유형</label><input type="text" id="name-topic" maxlength="120" value="${esc(m.topic || '')}" placeholder="예: 화학 반응의 양적 관계"></div></div>
          <div class="lt-actions"><span class="muted small">다시 분석해도 여기서 정한 제목은 바뀌지 않습니다.</span><span class="spacer"></span><button type="button" class="small" id="name-cancel">취소</button><button type="submit" class="small primary">저장</button></div>
        </form>
      </div>
      <div class="flow" id="m-flow"></div>
      <nav class="stage-tabs" role="tablist">
        <button type="button" role="tab" data-stage-tab="read"><span class="stage-no">1</span><span class="stage-txt"><b>원본 분석</b><small id="st-read"></small></span></button>
        <button type="button" role="tab" data-stage-tab="make"><span class="stage-no">2</span><span class="stage-txt"><b>변형 문제</b><small id="st-make"></small></span></button>
      </nav>
      <div class="stage" data-pane="read">
        <section class="lt-sec">
          <div class="lt-sec-head lt-sec-row"><div><h2>분석 결과</h2><p>AI가 원본을 읽고 STEP으로 정리한 내용입니다. 변형 문제는 이 STEP을 기준으로 만듭니다.</p></div><div class="lt-sec-btns"><button class="small" id="edit">✏️ 분석 결과 수정</button></div></div>
          <div class="panel lt-list" id="analysis"></div>
        </section>
        <section class="lt-sec">
          <div class="lt-sec-head"><h2>분석 피드백</h2><p>분석에서 바꾸고 싶은 점을 적고 다시 분석하면 AI가 모두 따릅니다. 몇 글자 오타는 위의 분석 결과 수정으로 바로 고치는 편이 빠릅니다.</p></div>
          <div class="fb-wrap" id="afb"></div>
        </section>
      </div>
      <div class="stage" data-pane="make">
        <section class="lt-sec">
          <div class="lt-sec-head"><h2>만든 세트</h2><p>세트를 열어 문제마다 👍 채택하거나 ✏️ 고칠 점을 남기세요. 고칠 점은 아래 생성 피드백으로 모이고, 채택한 문제는 본보기가 됩니다.</p></div>
          <div class="panel lt-list" id="variants"></div>
        </section>
        <section class="lt-sec">
          <div class="lt-sec-head"><h2>생성 피드백</h2><p>변형 문제를 만들 때마다 AI가 지킬 점입니다.</p></div>
          <div class="fb-wrap" id="gfb"><div class="panel muted">불러오는 중…</div></div>
        </section>
        <section class="lt-sec">
          <div class="lt-sec-head"><h2>새 세트 만들기</h2><p>위 피드백과 본보기를 반영해 만듭니다. 정답은 서버가 계산으로 확인하고, 문제만 보고 다시 풀어 대조합니다.</p></div>
          <div class="panel" id="generate"></div>
        </section>
      </div>
      <div class="lt-foot"><button class="small danger" id="del">이 문제 삭제</button></div>
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
    $('#del').addEventListener('click', guard(async () => { if (confirm('이 문제를 삭제할까요? (만든 세트 기록은 남습니다)')) { await api('DELETE', '/api/materials/' + m.id); location.hash = '#/'; } }));
    if (editing) editAnalysis(m); else showAnalysis(m);
    analysisFeedbackPanel(m);
    generatePanel(m, n);
    // Generation feedback, the sets and what the next set will carry come from the same two reads; a change repaints them.
    const side = async () => {
      const [rules, learning] = await Promise.all([api('GET', '/api/rules'), api('GET', `/api/materials/${m.id}/learning`)]);
      if (!$('#gfb')) return;
      const gens = setsOf(m);
      const own = rules.filter((r) => r.scope === 'material' && r.source?.materialId === m.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      const on = own.filter((r) => r.status === 'approved');
      const common = rules.filter((r) => r.status === 'approved' && ['global', 'topic'].includes(r.scope));
      $('#st-make').textContent = [`세트 ${gens.length}개`, `피드백 ${on.length}개`, learning.adopted ? `본보기 ${learning.adopted}개` : ''].filter(Boolean).join(' · ');
      generationFeedbackPanel(m, own, learning, gens, side, common.length);
      variantsPanel(m, gens, on, learning);
      carryLine(m, n, on, common, learning.adopted);
    };
    side().catch((e) => { if ($('#gfb')) $('#gfb').innerHTML = `<div class="panel bad">${esc(e.message)}</div>`; });
    liveMaterial = { m, side };
    paintFlow(m);
  }

  // Shared by both stages' feedback: rows that open in place to edit.
  const TARGET_TXT = { problem: '문제', solution: '해설', design: '문제', all: '전체' };
  const targetOptions = (sel) => Object.entries({ all: '전체', problem: '문제', solution: '해설' }).map(([v, t]) => `<option value="${v}" ${v === sel ? 'selected' : ''}>${t}</option>`).join('');
  const emptyRow = (text) => `<div class="lt-row lt-plain fb-empty"><span class="muted small">${text}</span></div>`;

  // ① Analysis feedback: one box to add (and re-analyze), then what was asked so far with how the last analysis applied it.
  function analysisFeedbackPanel(m) {
    const el = $('#afb');
    if (!el) return;
    const opened = openSet(m.id);
    const o = (k) => (opened.has(k) ? ' open' : '');
    const afb = m.analysisFeedback || [];
    // How the last analysis says it applied each one (matched by text, else by position when the counts agree).
    const applied = m.feedbackApplied || [];
    const howOf = (f, i) => (applied.find((x) => x.feedback.trim() === f.text.trim()) || (applied.length === afb.length ? applied[i] : null))?.how;
    const isPending = (f) => !(m.analyzedAt && f.at < m.analyzedAt);
    const pending = afb.filter(isPending).length;
    const state = (f, i) => {
      if (isPending(f)) return '<span class="warn">아직 반영 전 — 다시 분석하면 반영됩니다</span>';
      const how = howOf(f, i);
      return how ? `반영: ${esc(how)}` : '<span class="warn">분석에 들어갔지만 어떻게 반영했는지 보고가 없습니다</span>';
    };
    const row = (f, i) => `<div class="lt-row lt-plain${o('af:' + i)}" data-row="af:${i}" data-afb="${i}">
        <div class="lt-main"><span class="lt-name lt-clamp">${esc(f.text)}</span><span class="lt-sub lt-wrap">${fmtTime(f.at)} · ${state(f, i)}</span></div>
        <button class="small lt-open" data-open>편집</button>
        <div class="lt-more">
          <textarea data-f="text" rows="3">${esc(f.text)}</textarea>
          <div class="lt-actions"><button class="small" data-act="promote">모든 문제에 적용</button><button class="small danger" data-act="del">삭제</button><span class="spacer"></span><button class="small" data-act="cancel">취소</button><button class="small primary" data-act="save">저장</button></div>
        </div>
      </div>`;
    el.innerHTML = `
      <div class="panel fb-new">
        <textarea id="afb-text" rows="2" placeholder="예: STEP을 4개로 나눠 주세요. 설명을 더 쉽게 풀어 써 주세요. 표 Ⅲ의 'B'는 학생 필기입니다."></textarea>
        <div class="lt-actions"><span class="muted small">${pending ? `<span class="warn">아직 반영 안 된 피드백 ${pending}개</span>` : ''}</span><span class="spacer"></span>
          <button class="small" id="afb-add">추가만</button><button class="small primary" id="afb-go">다시 분석</button></div>
      </div>
      <div class="panel lt-list">${afb.map(row).join('') || emptyRow('아직 없습니다.')}</div>
      <p class="fb-common muted small"></p>`;
    rowToggles(el, opened);
    api('GET', '/api/common').then((c) => {
      const n = c.analysis.length;
      if ($('.fb-common', el)) $('.fb-common', el).innerHTML = n ? `모든 문제에 적용되는 분석 피드백 ${n}개도 함께 들어갑니다 · <a href="#/learning">학습에서 보기</a>` : '모든 문제에 적용할 분석 피드백은 <a href="#/learning">학습</a>에서 넣습니다.';
    }).catch(() => {});
    const st = $('#st-read');
    if (st) st.innerHTML = `STEP ${m.steps.length}개 · 피드백 ${afb.length}개${pending ? ` · <span class="warn">반영 전 ${pending}</span>` : ''}`;
    const box = $('#afb-text', el);
    const go = $('#afb-go', el);
    const label = () => { go.textContent = box.value.trim() ? '추가하고 다시 분석' : '다시 분석'; };
    box.addEventListener('input', label);
    $('#afb-add', el).addEventListener('click', guard(async () => {
      const text = box.value.trim();
      if (!text) throw new Error('피드백 내용을 입력해 주세요.');
      m.analysisFeedback = (await api('POST', `/api/materials/${m.id}/analysis-feedback`, { text })).analysisFeedback;
      toast('추가했습니다. 다시 분석하면 반영됩니다.');
      analysisFeedbackPanel(m);
    }));
    go.addEventListener('click', guard(async () => {
      const text = box.value.trim();
      const total = afb.length + (text ? 1 : 0);
      if (!confirm(`원본을 다시 분석할까요?${total ? ` 분석 피드백 ${total}개를 모두 반영합니다.` : ''} 지금 분석 결과(직접 고친 내용 포함)는 새 결과로 바뀝니다.`)) return;
      await api('POST', `/api/materials/${m.id}/analyze`, text ? { feedback: text } : {}); // the 기본 모델 (LLM tab)
      route();
    }));
    $$('[data-afb]', el).forEach((r) => {
      const i = Number(r.dataset.afb);
      $('[data-act=cancel]', r).addEventListener('click', () => { $('[data-f=text]', r).value = afb[i].text; r.classList.remove('open'); opened.delete('af:' + i); });
      $('[data-act=save]', r).addEventListener('click', guard(async () => {
        m.analysisFeedback = (await api('PUT', `/api/materials/${m.id}/analysis-feedback/${i}`, { text: $('[data-f=text]', r).value })).analysisFeedback;
        opened.delete('af:' + i);
        toast('저장했습니다. 다시 분석하면 반영됩니다.');
        analysisFeedbackPanel(m);
      }));
      $('[data-act=promote]', r).addEventListener('click', guard(async () => {
        m.analysisFeedback = (await api('POST', `/api/materials/${m.id}/analysis-feedback/${i}/promote`)).analysisFeedback;
        [...opened].filter((k) => k.startsWith('af:')).forEach((k) => opened.delete(k));
        toast('모든 문제의 분석 피드백으로 옮겼습니다. 학습에서 볼 수 있습니다.');
        analysisFeedbackPanel(m);
      }));
      $('[data-act=del]', r).addEventListener('click', guard(async () => {
        if (!confirm('이 피드백을 삭제할까요?')) return;
        m.analysisFeedback = (await api('DELETE', `/api/materials/${m.id}/analysis-feedback/${i}`)).analysisFeedback;
        // Row keys are positions; the ones after this one moved up.
        [...opened].filter((k) => k.startsWith('af:')).forEach((k) => opened.delete(k));
        analysisFeedbackPanel(m);
      }));
    });
  }

  // ② Generation feedback: one box to add, then what every new set gets — the feedback (with how the later variants
  // kept it; the checkbox switches one off) and the adopted variants shown as models.
  function generationFeedbackPanel(m, own, learning, gens, refresh, common = 0) {
    const el = $('#gfb');
    if (!el) return;
    const opened = openSet(m.id);
    const o = (k) => (opened.has(k) ? ' open' : '');
    const record = new Map(learning.feedback.map((f) => [f.id, f]));
    const from = (label) => esc(String(label || '변형 문제').replace(m.title + ' · ', ''));
    const ruleRow = (r) => {
      const f = record.get(r.id) || {};
      const judged = (f.kept || 0) + (f.broken || 0);
      const where = r.source?.jobId ? `<a href="#/j/${r.source.jobId}${r.source.itemIndex !== undefined ? `?item=${r.source.itemIndex}` : ''}">${from(r.source.label)}에서</a>` : fmtTime(r.createdAt);
      const kept = judged ? `변형 ${judged}개에서 지킴 ${f.kept}${f.broken ? ` · <span class="bad">어김 ${f.broken}</span>` : ''}` : '아직 검토 전';
      return `<div class="lt-row lt-pick${r.status === 'approved' ? '' : ' off'}${o('f:' + r.id)}" data-row="f:${r.id}" data-rule="${r.id}">
        <input type="checkbox" data-act="toggle" ${r.status === 'approved' ? 'checked' : ''} aria-label="이 피드백 적용">
        <div class="lt-main"><span class="lt-name lt-clamp">${esc(r.text)}</span><span class="lt-sub">${TARGET_TXT[r.target] || '전체'} · ${where} · ${kept}</span></div>
        <button class="small lt-open" data-open>편집</button>
        <div class="lt-more">
          <textarea data-f="text" rows="3">${esc(r.text)}</textarea>
          <div class="lt-actions"><select data-f="target" aria-label="대상">${targetOptions(r.target)}</select><button class="small" data-act="promote">모든 문제에 적용</button><button class="small danger" data-act="del">삭제</button><span class="spacer"></span><button class="small" data-act="cancel">취소</button><button class="small primary" data-act="save">저장</button></div>
        </div>
      </div>`;
    };
    const examples = gens.flatMap((j, i) => (j.items || []).filter((it) => it.adopted).map((it) => ({ j, it, no: gens.length - i })));
    const exampleRow = ({ j, it, no }) => `<div class="lt-row lt-plain">
        <div class="lt-main"><span class="lt-name">${esc(it.label)}</span><span class="lt-sub lt-clip">세트 ${no} · ${it.preview ? inlineRich(it.preview) : ''}</span></div>
        <a class="btn small" href="#/j/${j.id}?item=${it.index}">열기</a>
      </div>`;
    const on = own.filter((r) => r.status === 'approved');
    const off = own.filter((r) => r.status !== 'approved');
    el.innerHTML = `
      <div class="panel fb-new">
        <textarea id="fb-text" rows="2" placeholder="예: STEP 1 연습에서는 남는 물질을 표에 적지 않는다. 최종 문제는 실험 Ⅱ에서 가정→모순을 판정하게 만든다."></textarea>
        <div class="lt-actions"><label for="fb-target" class="fb-target-label">대상</label><select id="fb-target">${targetOptions('all')}</select><span class="spacer"></span><button class="small primary" id="fb-add">추가</button></div>
      </div>
      <div class="panel lt-list">
        <div class="fb-kind"><b>지킬 점</b><span>${on.length}개</span><span class="muted">체크를 끄면 다음 세트부터 빠집니다</span></div>
        ${on.map(ruleRow).join('') || emptyRow('아직 없습니다. 위에 적거나, 세트에서 ✏️ 고칠 점을 누르면 여기로 모입니다.')}
        <div class="fb-kind"><b>본보기</b><span>${examples.length}개</span><span class="muted">채택한 문제 · 같은 단계 변형에 최대 2개씩 보여 줍니다</span></div>
        ${examples.map(exampleRow).join('') || emptyRow('아직 없습니다. 세트에서 좋은 문제를 👍 채택하면 쌓입니다.')}
        ${off.length ? `<details class="lt-off"><summary>꺼 둔 피드백 ${off.length}개</summary>${off.map(ruleRow).join('')}</details>` : ''}
      </div>
      <p class="fb-common muted small">${common ? `모든 문제에 적용되는 생성 피드백 ${common}개도 함께 들어갑니다 · <a href="#/learning">학습에서 보기</a>` : '모든 문제에 적용할 생성 피드백은 <a href="#/learning">학습</a>에서 넣습니다.'}</p>`;
    rowToggles(el, opened);
    $('#fb-add', el).addEventListener('click', guard(async () => {
      const text = $('#fb-text', el).value.trim();
      if (!text) throw new Error('피드백 내용을 입력해 주세요.');
      await api('POST', '/api/rules', { text, target: $('#fb-target', el).value, kind: 'feedback', scope: 'material', source: { materialId: m.id } });
      toast('추가했습니다. 다음에 만드는 세트부터 들어갑니다.');
      await refresh();
    }));
    $$('[data-rule]', el).forEach((r) => {
      const id = r.dataset.rule;
      const rule = own.find((x) => x.id === id);
      $('[data-act=toggle]', r).addEventListener('change', guard(async (e) => {
        try { await api('PUT', '/api/rules/' + id, { status: e.target.checked ? 'approved' : 'pending' }); }
        catch (err) { e.target.checked = !e.target.checked; throw err; }
        toast(e.target.checked ? '다시 적용합니다. 다음에 만드는 세트부터 들어갑니다.' : '껐습니다. 다음 세트부터 빠집니다.');
        await refresh();
      }));
      $('[data-act=cancel]', r).addEventListener('click', () => {
        $('[data-f=text]', r).value = rule.text; $('[data-f=target]', r).value = rule.target;
        r.classList.remove('open'); opened.delete('f:' + id);
      });
      $('[data-act=save]', r).addEventListener('click', guard(async () => {
        await api('PUT', '/api/rules/' + id, { text: $('[data-f=text]', r).value, target: $('[data-f=target]', r).value });
        opened.delete('f:' + id);
        toast('저장했습니다.');
        await refresh();
      }));
      $('[data-act=promote]', r).addEventListener('click', guard(async () => {
        await api('PUT', '/api/rules/' + id, { scope: 'global' });
        opened.delete('f:' + id);
        toast('모든 문제의 생성 피드백으로 넓혔습니다. 학습에서 볼 수 있습니다.');
        await refresh();
      }));
      $('[data-act=del]', r).addEventListener('click', guard(async () => {
        if (!confirm('이 피드백을 삭제할까요?')) return;
        await api('DELETE', '/api/rules/' + id);
        opened.delete('f:' + id);
        await refresh();
      }));
    });
  }

  // The sets made from this problem, newest first: when and with what each was made, how far its review got, and its
  // problems one line each (opened in place). A set made before later feedback says how much of it is missing.
  const SET_ITEM = { adopted: ['채택', 'ok'], needs_review: ['검토 필요', 'bad'], warning: ['확인할 점', 'warn'], passed: ['통과', ''], failed: ['못 만듦', 'bad'], generating: ['만드는 중', 'run'], verifying: ['검증 중', 'run'], repairing: ['고치는 중', 'run'], pending: ['대기', ''] };
  function variantsPanel(m, gens, on, learning) {
    const el = $('#variants');
    if (!el) return;
    if (!gens.length) { el.innerHTML = '<div class="lt-row lt-plain"><span class="muted">아직 만든 세트가 없습니다.</span></div>'; return; }
    const opened = openSet(m.id);
    const stats = new Map(learning.sets.map((s) => [s.id, s]));
    const row = (j, i) => {
      const s = stats.get(j.id) || { no: gens.length - i, feedbackBefore: 0, examples: 0 };
      const busy = ['queued', 'running'].includes(j.status);
      const items = j.items || [];
      const count = (st) => items.filter((it) => !it.adopted && it.status === st).length;
      const adopted = items.filter((it) => it.adopted).length;
      const later = on.filter((r) => r.createdAt > j.createdAt).length;
      const made = items.filter((it) => ['passed', 'warning', 'needs_review', 'failed'].includes(it.status)).length;
      const fact = busy ? `<span class="run">만드는 중 ${made}/${items.length}</span>`
        : [`채택 ${adopted}/${items.length}`, count('needs_review') && `<span class="bad">검토 필요 ${count('needs_review')}</span>`, count('failed') && `<span class="bad">못 만듦 ${count('failed')}</span>`].filter(Boolean).join(' · ');
      return `<div class="lt-row lt-set${opened.has('s:' + j.id) ? ' open' : ''}" data-row="s:${j.id}">
        <div class="lt-main"><a class="lt-name" href="#/j/${j.id}">세트 ${s.no} · ${j.options?.mode === 'integrated' ? '통합 변형' : '수치 변형'}</a>
          <span class="lt-sub lt-wrap">${fmtTime(j.createdAt)} · ${esc(j.modelLabel || PROVIDER_LABEL[j.options?.provider] || 'DeepSeek')} · 피드백 ${s.feedbackBefore}개${s.examples ? `·본보기 ${s.examples}개` : ''}로 만듦${later ? ` · <span class="warn">그 뒤 남긴 피드백 ${later}개는 빠져 있음</span>` : ''}</span></div>
        <div class="lt-fact">${fact}</div>
        <button class="small lt-open" data-open>문제 보기</button>
        <div class="lt-more"><div class="lt-items">${items.map((it) => {
          const [t, c] = SET_ITEM[it.adopted ? 'adopted' : it.status] || [it.status, ''];
          return `<a class="lt-item" href="#/j/${j.id}?item=${it.index}"><b>${esc(it.label)}</b><span class="lt-item-text">${it.preview ? inlineRich(it.preview) : ''}</span><span class="lt-state ${c}">${t}</span></a>`;
        }).join('')}</div></div>
      </div>`;
    };
    const rows = gens.map(row);
    el.innerHTML = rows.slice(0, 5).join('') + (rows.length > 5 ? `<details class="lt-off"><summary>이전 세트 ${rows.length - 5}개 더 보기</summary>${rows.slice(5).join('')}</details>` : '');
    rowToggles(el, opened);
  }

  function showAnalysis(m) {
    const el = $('#analysis');
    el.classList.remove('editing');
    $$('.lt-sec-btns button').forEach((b) => { b.hidden = false; });
    const opened = openSet(m.id);
    const o = (key) => (opened.has(key) ? ' open' : '');
    const { items, open, misaligned } = analysisNotes(m);
    const list = (items) => `<ul class="lt-ul">${items.map((u) => `<li>${flat(u)}</li>`).join('')}</ul>`;
    const row = (key, name, sub, more, label = '보기', dot = '') => `<div class="lt-row lt-plain${o(key)}" data-row="${key}">
        <div class="lt-main"><span class="lt-name">${dot}${name}</span><span class="lt-sub lt-clip">${sub}</span></div>
        <button class="small lt-open" data-open>${label}</button>
        <div class="lt-more">${more}</div>
      </div>`;
    const src = (id) => 'api/files/' + id;
    const thumbs = [m.images.problem, !m.images.sameImage && m.images.solution].filter(Boolean).map((id) => `<img data-zoom src="${src(id)}" alt="원본">`).join('');
    const count = (k) => items.filter((x) => x.kind === k).length;
    const checkParts = [count('word') && `단어 확인 ${count('word')}`, count('uncertain') && `판독 불확실 ${count('uncertain')}`, count('proofread') && `자동 교정 ${count('proofread')}`, count('annotation') && `뺀 필기 ${count('annotation')}`, misaligned && `STEP ${m.steps.length}개 → 해설 ${m.targetSteps}단계`].filter(Boolean);
    const wordItem = (x, i) => {
      const { count: n, piece } = wordUse(m, x.word);
      const done = x.state === 'fixed' ? `<span class="chk-state ok">✓ "${esc(x.other)}"(으)로 바꿈</span>`
        : x.state ? `<span class="chk-state ok">✓ "${esc(x.word)}"이(가) 맞음</span><button class="small chk-link" data-undo>되돌리기</button>` : '';
      return `<li class="chk${x.state ? ' done' : ''}" data-note="${i}">
        <div class="chk-text">AI가 읽은 내용에 <b>"${esc(x.word)}"</b>이(가) ${n}번 나옵니다${piece ? ` (예: "…${esc(piece)}…")` : ''}.
          AI가 이 단어를 <b>"${esc(x.other)}"</b>과(와) 헷갈린 적이 있습니다. <b>원본 사진에도 "${esc(x.word)}"(으)로 인쇄되어 있나요?</b></div>
        <div class="chk-act">${done || `<button class="small" data-word-ok>✓ 네, "${esc(x.word)}"이(가) 맞아요</button><button class="small" data-word-swap>아니요, "${esc(x.other)}"(으)로 바꾸기</button>`}</div>
      </li>`;
    };
    const noteItem = (x, i) => x.kind === 'word' ? wordItem(x, i) : `<li class="chk${x.state ? ' done' : ''}" data-note="${i}">
        <div class="chk-line"><span class="chk-text">${flat(x.text)}</span><span class="chk-act">${x.state
          ? `<span class="chk-state ${x.state === 'ok' ? 'ok' : ''}">${x.state === 'ok' ? '✓ 맞음' : '✏️ 피드백 남김'}</span><button class="small chk-link" data-undo>되돌리기</button>`
          : '<button class="small" data-ok>✓ 맞음</button><button class="small" data-wrong>✏️ 틀림</button>'}</span></div>
        <div class="chk-fix" hidden><textarea rows="2" placeholder="원본에서 무엇이 맞는지 적어 주세요. 예: ①은 학생 필기라 무시한다.">${esc(noteFixDraft(x))}</textarea>
          <div class="lt-actions"><button class="small chk-link" data-edit>분석 결과 수정에서 직접 고치기</button><span class="spacer"></span><button class="small" data-cancel>취소</button><button class="small" data-save>피드백으로 저장</button><button class="small primary" data-go>저장하고 다시 분석</button></div></div>
      </li>`;
    const checkBody = `<p class="chk-help">AI가 확신하지 못했거나 스스로 판단한 곳입니다. 원본 사진과 비교해 맞으면 <b>✓ 맞음</b>, 틀리면 <b>✏️ 틀림</b>을 누르고 무엇이 맞는지 적어 주세요. 적은 내용은 분석 피드백으로 저장되고, 다시 분석할 때 반영됩니다.</p>
        ${misaligned ? `<div class="lt-actions"><span>해설의 단계 표시는 ${m.targetSteps}개인데 정리한 STEP은 ${m.steps.length}개입니다.</span><span class="spacer"></span><button class="small primary" id="align">해설 단계에 맞춰 합치기</button></div>` : ''}
        ${Object.keys(NOTE_KIND).filter((k) => count(k)).map((k) => `<div class="chk-group"><b>${NOTE_KIND[k]}</b><ul class="chk-list">${items.map((x, i) => (x.kind === k ? noteItem(x, i) : '')).join('')}</ul></div>`).join('')}`;
    el.innerHTML = [
      `<div class="lt-row lt-plain${o('a:orig')}" data-row="a:orig">
        <div class="lt-main lt-thumbrow"><span class="lt-thumbs">${thumbs}</span><span class="lt-main"><span class="lt-name">${m.images.sameImage || !m.images.solution ? '원본' : '원본 문제 · 교사 해설'}</span>
          <span class="lt-sub lt-clip">${m.solutionSource === 'ai' ? '해설 없음 → AI가 만든 풀이' : '교사 해설 기반'} · ${esc(PROVIDER_LABEL[m.analyzedWith] || 'DeepSeek')}로 분석${m.teacherEditedAt ? ' · 직접 고침' : ''}</span></span></div>
        <button class="small lt-open" data-open>크게 보기</button>
        <div class="lt-more"><div class="orig orig-2">${originalsInner(m.images)}</div></div>
      </div>`,
      checkParts.length ? row('a:check', '확인할 곳', `${open ? `<span class="warn">남은 확인 ${open}개</span>` : '모두 확인함'} · ${checkParts.join(' · ')}`, checkBody, '보기', `<i class="lt-dot ${open || misaligned ? 'warn' : 'ok'}"></i>`) : '',
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
    const setNote = async (x, state) => {
      const saved = await api('PUT', `/api/materials/${m.id}/checks`, { note: noteKey(x.text), state });
      m.noteStates = saved.noteStates;
      return saved;
    };
    $$('#analysis [data-note]').forEach((li) => {
      const x = items[Number(li.dataset.note)];
      const fix = $('.chk-fix', li);
      const wrote = () => {
        const t = $('textarea', fix).value.trim();
        if (!t) throw new Error('무엇이 맞는지 적어 주세요.');
        return `${t} (확인할 곳: ${x.text.replace(/\s+/g, ' ').slice(0, 80)})`;
      };
      $('[data-word-ok]', li)?.addEventListener('click', guard(async () => { await setNote(x, 'ok'); showAnalysis(m); paintFlow(m); }));
      $('[data-word-swap]', li)?.addEventListener('click', guard(async () => {
        const { count: n } = wordUse(m, x.word);
        if (!confirm(`분석 결과의 "${x.word}" ${n}곳을 모두 "${x.other}"(으)로 바꿀까요? 이 착오는 기억해 두고 다음 분석부터 주의합니다.`)) return;
        const saved = await api('POST', `/api/materials/${m.id}/replace-word`, { from: x.word, to: x.other, note: noteKey(x.text) });
        toast(`"${x.word}" ${saved.replaced}곳을 "${x.other}"(으)로 바꿨습니다.`);
        renderMaterial({ ...saved, jobs: m.jobs }, false);
      }));
      $('[data-ok]', li)?.addEventListener('click', guard(async () => { await setNote(x, 'ok'); showAnalysis(m); paintFlow(m); }));
      $('[data-undo]', li)?.addEventListener('click', guard(async () => { await setNote(x, null); showAnalysis(m); paintFlow(m); }));
      if (x.kind === 'word') return; // the rest is the 틀림 box of the ordinary notes
      $('[data-wrong]', li)?.addEventListener('click', () => { fix.hidden = false; $('textarea', fix).focus(); });
      $('[data-cancel]', li).addEventListener('click', () => { fix.hidden = true; });
      $('[data-edit]', li).addEventListener('click', () => editAnalysis(m));
      $('[data-save]', li).addEventListener('click', guard(async () => {
        const text = wrote();
        await api('POST', `/api/materials/${m.id}/analysis-feedback`, { text });
        const saved = await setNote(x, 'feedback');
        m.analysisFeedback = saved.analysisFeedback;
        toast('분석 피드백으로 저장했습니다. 다시 분석하면 반영됩니다.');
        showAnalysis(m);
        paintFlow(m);
        analysisFeedbackPanel(m);
      }));
      $('[data-go]', li).addEventListener('click', guard(async () => {
        const text = wrote();
        if (!confirm(`이 내용을 더해 원본을 다시 분석할까요? 분석 피드백 ${(m.analysisFeedback || []).length + 1}개를 모두 반영하고, 지금 분석 결과(직접 고친 내용 포함)는 새 결과로 바뀝니다.`)) return;
        await setNote(x, 'feedback');
        await api('POST', `/api/materials/${m.id}/analyze`, { feedback: text }); // the 기본 모델 (LLM tab)
        route();
      }));
    });
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

  async function generatePanel(m, n) {
    const el = $('#generate');
    const upto = Array.from({ length: n - 1 }, (_, i) => i + 1);
    const focus = Array.from({ length: Math.max(0, n - 1) }, (_, i) => i + 2);
    try { await loadStatus(); } catch { /* picker falls back to DeepSeek only */ }
    if (!$('#generate')) return;
    el.innerHTML = `
      <div id="rules-preview" class="lt-carry">${carryText.get(m.id) || '<span class="muted">반영할 내용을 확인하는 중…</span>'}</div>
      <div class="gen-picks"><span class="gen-label">만들 문제</span>
        <div class="stage-picks">${upto.map((k) => `<label class="inline"><input type="checkbox" data-stage='{"kind":"upto","upto":${k}}' checked> ${k === 1 ? 'STEP 1 연습' : `STEP 1~${k} 연습`}</label>`).join('')}
        <label class="inline"><input type="checkbox" data-stage='{"kind":"twin"}' checked> 최종 문제 (STEP 1~${n})</label>
        ${focus.map((k) => `<label class="inline"><input type="checkbox" data-stage='{"kind":"focus","step":${k}}'> STEP ${k}만 연습</label>`).join('')}</div></div>
      <details class="gen-more lt-base" data-k="gen-more"><summary>세부 설정 <span class="muted" id="gen-summary"></span></summary><div class="gen-more-in">
        <label>만들 모델</label>${providerPicker('genProvider')}
        <label>최종 문제 방식</label>
        <div><label class="inline"><input type="radio" name="mode" value="integrated" checked> 통합 변형 (권장) — 앞 연습 문제의 아이디어를 엮은 새 구조</label>
          <label class="inline"><input type="radio" name="mode" value="numeric"> 단순 수치 변형 — 원본과 같은 구조에 숫자만 새로</label></div>
        <div class="cols cols-2">
          <div><label>단계마다 만들 문제 수</label><select id="per"><option>1</option><option>2</option><option>3</option></select></div>
          <div id="effort-box"><label>DeepSeek 사고 강도</label><select id="effort"><option value="low">기본 (비용 적음)</option><option value="high">정밀 (토큰 더 사용)</option></select></div>
          <div id="claude-effort-note" hidden><label>Claude 추론 강도</label><p class="small" style="margin:6px 0"><b id="claude-effort-name"></b> <a href="#/llm">LLM 탭에서 변경</a></p></div>
        </div>
        <p class="muted small">STEP k만 연습: 앞 STEP의 결과를 조건으로 주고 STEP k만 쓰게 하는 문제입니다.</p>
      </div></details>
      <div class="gen-go"><span class="muted small" id="estimate"></span><button class="primary" id="go">변형 문제 만들기</button></div>`;
    const estimate = () => {
      const chosen = $('[name=genProvider]:checked', el)?.value || 'deepseek';
      // Each model's own reasoning setting: DeepSeek's here, Claude's from the LLM tab, none for the PC model.
      $('#effort-box').hidden = chosen !== 'deepseek';
      $('#claude-effort-note').hidden = chosen !== 'claude-cli';
      if (chosen === 'claude-cli') $('#claude-effort-name').textContent = EFFORT_TXT[statusCache?.providers?.['claude-cli']?.effort] || '자동';
      const count = $$('[data-stage]:checked', el).length * Number($('#per').value);
      $('#estimate').textContent = !count ? '만들 문제를 하나 이상 고르세요.'
        : `${count}문제${chosen === 'gemma' ? ' · PC 모델은 무료지만 문제당 몇 분씩 걸릴 수 있습니다' : ''}`;
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
  }

  // What the next set of this problem will carry, in one sentence; 자세히 lists the common rules. Kept per problem so
  // generatePanel shows it whichever of the two is drawn first.
  const carryText = new Map();
  function carryLine(m, n, on, common, adopted) {
    carryText.set(m.id, `<p>STEP ${n}개, 켜 둔 피드백 ${on.length}개${adopted ? `, 채택한 문제 ${adopted}개(본보기)` : ''}, 공통 지침 ${common.length}개를 반영합니다.</p>
        <details class="lt-base"><summary>자세히</summary><div class="lt-carry-more">
          <p>본보기: ${adopted ? `채택한 문제 ${adopted}개 중 같은 단계의 것을 최대 2개 보여 주고, 그 숫자는 피합니다.` : '아직 없습니다. 세트에서 좋은 문제를 👍 채택하면 쌓입니다.'}</p>
          ${common.length ? `<p>공통 지침 (모든 문제)</p><ul class="lt-ul">${common.slice(0, 8).map((r) => `<li>${esc(r.text)}</li>`).join('')}</ul>${common.length > 8 ? `<p class="muted">외 ${common.length - 8}개</p>` : ''}` : ''}
          <p><a href="#/learning">학습에서 모든 문제의 피드백 관리</a></p>
        </div></details>`);
    if ($('#rules-preview')) $('#rules-preview').innerHTML = carryText.get(m.id);
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
    const line = job.status === 'queued' ? '<i class="spin"></i>순서를 기다리는 중'
      : busy ? `<i class="spin"></i>${made}/${items.length} 만드는 중${now ? ` — 문제 ${now.index + 1} ${(ITEM_STATUS[now.status] || [''])[0]}` : ''} · ${model}`
      : `${items.length}문제 · 채택 ${adopted}${review ? ` · <span class="bad">검토 필요 ${review}</span>` : ''} · ${model}`;
    return `<div class="lt jt-head">
      <a class="lt-back" href="#/m/${job.materialId}">‹ ${esc(job.materialTitle || job.title)}</a>
      <div class="lt-head"><h1>${no ? `세트 ${no}` : '변형 세트'} · ${job.options.mode === 'integrated' ? '통합 변형' : '수치 변형'}</h1>
        <a class="btn small" href="report.html?job=${job.id}" target="_blank" rel="noopener">학습지·PDF</a></div>
      <div class="jt-status"><span class="lt-meta">${line}</span><span class="spacer"></span>
        ${busy ? '<button id="cancel" class="small danger">취소</button>' : ''}
        ${['interrupted', 'failed', 'cancelled'].includes(job.status) ? '<button id="resume" class="small primary">남은 문제 이어서 만들기</button>' : ''}</div>
      ${busy ? `<div class="jt-bar"><span style="width:${items.length ? Math.round((made / items.length) * 100) : 0}%"></span></div><p class="muted small jt-wait">문제마다 설계 → 검산 → 다시 풀어 보기를 거쳐 몇 분 걸립니다. 화면을 닫아도 서버에서 계속되고, 이 화면은 저절로 바뀝니다.</p>` : ''}
      ${job.error ? `<div class="note ${job.status === 'cancelled' ? 'warn' : 'bad'}">${esc(job.error)}</div>` : ''}
      ${regenerating.length ? `<div class="note info"><i class="spin"></i> 문제 ${regenerating.map((r) => r.itemIndex + 1).join(', ')}번을 다시 만드는 중입니다. 끝나면 저절로 바뀝니다.</div>` : ''}
      <nav class="jt-jump">${items.map((i) => `<button type="button" data-jump="${i.index}"><i class="lt-dot ${JUMP[i.adopted ? 'adopted' : i.status] || ''}"></i>${i.index + 1} ${esc(i.label)}${i.adopted ? ' ✓' : ''}</button>`).join('')}</nav>
      <details class="lt-base jt-log" data-k="log"><summary>만든 기록</summary><div class="jt-log-in">
        <p class="small">${fmtTime(job.createdAt)} · ${tokens(job.usage, job.options.provider)} · 상한 ${job.budget.maxCalls}회 / ${Number(job.budget.maxTokens).toLocaleString()}토큰${job.options.provider === 'deepseek' ? ` · 사고 강도 ${job.options.effort === 'high' ? '정밀' : '기본'}` : ''}</p>
        <p class="small"><b>붙인 피드백·지침 ${job.rules.length}개</b></p>
        ${job.rules.length ? `<ul class="lt-ul small">${job.rules.map((r) => `<li>[${{ material: '이 문제', topic: '유형' }[r.scope] || '모든 문제'}·${TARGET[r.target]}] ${esc(r.text)}</li>`).join('')}</ul>` : ''}
        <p class="small"><b>진행 기록</b></p>
        <div class="log">${(job.log || []).slice().reverse().map((l) => `<div>${fmtTime(l.t)} ${esc(l.message)}</div>`).join('')}</div>
        ${busy ? '' : '<p><button id="delete" class="small danger">세트 삭제</button></p>'}
      </div></details>
    </div>`;
  }
  function bindHead(job) {
    $('#cancel')?.addEventListener('click', guard(async () => { await api('POST', `/api/jobs/${job.id}/cancel`); toast('취소를 요청했습니다.'); wake(); }));
    $('#resume')?.addEventListener('click', guard(async () => { await api('POST', `/api/jobs/${job.id}/resume`); toast('이어서 진행합니다.'); route(); }));
    $('#delete')?.addEventListener('click', guard(async () => { if (confirm('이 세트를 삭제할까요?')) { await api('DELETE', '/api/jobs/' + job.id); location.hash = '#/m/' + job.materialId; } }));
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

  // Quick feedback: one tap per common fault; each becomes this original's feedback in full sentences (the same tag
  // on another variant switches the same feedback back on instead of adding it twice).
  const FIX_TAGS = [
    ['조건 불필요', 'problem', '풀이에 쓰이지 않는 조건이나 서술을 넣지 않는다.'],
    ['단서 노출', 'problem', '학생이 추론해야 할 결론(예: 남는 물질, 앞 STEP의 결과)을 문제에 미리 알려주지 않는다.'],
    ['STEP 범위', 'problem', '목표한 STEP의 핵심 기법이 꼭 필요하고, 목표 범위 밖 STEP은 필요 없게 만든다.'],
    ['숫자만 바꿈', 'problem', '최종 문제는 숫자만 바꾸지 말고 앞 연습 문제의 아이디어를 엮어 구조를 바꾼다.'],
    ['계산 복잡', 'problem', '계산기 없이 풀 수 있게 주어진 값과 중간값, 정답을 작은 정수나 간단한 분수로 만든다.'],
    ['너무 쉬움', 'problem', '원본 수준의 난도를 유지하고, 최종 문제가 앞 연습 문제보다 쉬워지지 않게 한다.'],
    ['해설 방식', 'solution', '해설은 선생님 해설의 STEP 제목, 문장 틀, 표 구성, 보조 문자를 그대로 따른다.'],
    ['표기 오류', 'solution', '수식, 표, 화학식 표기를 정확히 쓴다 (상태 표시는 \\ce 안에, 표의 칸 수를 맞춘다).'],
  ];
  // One line under the problem: what still needs a look and how it kept the feedback. Opened at once when something
  // is wrong (left for the teacher, or a feedback broken), with the broken ones named.
  function checkLine(item) {
    const v = item.verification;
    const problems = [...new Set(item.problems || [])];
    const warnings = [...new Set(item.warnings || [])];
    const rules = v?.rules || [];
    const bad = rules.filter((r) => r.judged && !r.judged.ok);
    const ok = rules.filter((r) => r.judged?.ok).length;
    const parts = [
      problems.length && `<span class="bad">검토 필요 ${problems.length}</span>`,
      warnings.length && `<span class="warn">확인할 점 ${warnings.length}</span>`,
      ok + bad.length && `피드백 지킴 ${ok}/${ok + bad.length}${bad.length ? ` · <span class="bad">어김 ${bad.length}</span>` : ''}`,
    ].filter(Boolean);
    if (!parts.length) return '';
    const list = (xs) => `<ul class="lt-ul">${xs.map((x) => `<li>${inlineRich(x)}</li>`).join('')}</ul>`;
    return `<details class="jt-check${problems.length || bad.length ? ' bad' : ''}" data-k="check" ${problems.length || bad.length ? 'open' : ''}><summary>${parts.join(' · ')}</summary><div class="jt-check-in">
      ${problems.length ? `<div><b>자동 검토에서 해결되지 않은 점</b>${list(problems)}</div>` : ''}
      ${warnings.length ? `<div><b>확인할 점</b>${list(warnings)}</div>` : ''}
      ${bad.length ? `<div><b>어긴 피드백</b><ul class="lt-ul">${bad.map((r) => `<li>${esc(r.text)}${r.judged.note ? ` <span class="muted">— ${esc(r.judged.note)}</span>` : ''}</li>`).join('')}</ul></div>` : ''}
    </div></details>`;
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
    const canRegen = !busy && ['done', 'failed', 'cancelled', 'interrupted'].includes(job.status);
    const state = item.adopted ? '<span class="chip ok">채택됨</span>'
      : item.status === 'warning' ? `<span class="chip warn">확인할 점 ${new Set(item.warnings || []).size}</span>` : chip(ITEM_STATUS, item.status);
    const made = [
      item.examplesUsed && `채택한 문제 ${item.examplesUsed}개를 본보기로 참고`,
      repairs && `검토 후 고친 횟수 ${repairs}회`,
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
        <button data-rv="regen" ${canRegen ? '' : 'disabled'}>🔄 다시<span class="rv-long"> 만들기</span></button></div>
      <details class="fix-panel" data-k="fb" ${item.status === 'needs_review' || item.status === 'failed' ? 'open' : ''}><summary>고칠 점</summary><div class="fix-in">
        <div class="fix-tags">${FIX_TAGS.map(([name, target, text], i) => `<button type="button" class="fix-tag" data-tag="${i}" title="${esc(text)}">${esc(name)}<small>${target === 'solution' ? '해설' : '문제'}</small></button>`).join('')}</div>
        <textarea name="fb" rows="2" placeholder="더 구체적으로 (선택). 예: 실험 Ⅲ의 남은 질량이 넣은 A보다 커서 가정 없이 풀립니다."></textarea>
        <div class="lt-actions"><span class="muted small">누른 항목과 적은 내용은 이 문제의 피드백으로 저장되어 앞으로 만드는 변형에 모두 들어갑니다.</span><span class="spacer"></span><button class="small" name="save">저장</button><button name="regen" class="small primary" ${canRegen ? '' : 'disabled'}>저장하고 다시 만들기</button></div>
      </div></details>` : ''}
      ${p ? `
      <details data-k="sol"><summary>정답과 해설 — 정답 ${p.answer ? circled(p.answer) : '(서술형)'}</summary><div class="inner">
        ${(item.solution?.steps || []).map((s) => `<div class="step"><div class="head">${s.step ? `<span class="badge">원본 STEP ${s.step}</span>` : ''}${flat(s.title)}</div><div class="rich">${rich(s.work)}</div></div>`).join('')}
        ${item.solution?.summary ? `<p><b>정리</b> ${flat(item.solution.summary)}</p>` : ''}</div></details>
      <details data-k="more"><summary>만든 과정</summary><div class="inner">
        ${made.length ? `<p class="small muted">${made.join(' · ')}</p>` : ''}
        ${item.designNote ? `<h3>설계 의도</h3><div class="rich">${rich(item.designNote)}</div>` : ''}
        <h3>자동 검토</h3>${verificationHtml(v)}
        <h3>피드백을 지켰는지 (${v?.rules?.length || 0})</h3>${v?.rules?.length ? `<div class="table-wrap"><table class="rules"><tr><th>피드백·지침</th><th>AI가 밝힌 적용 방법</th><th>독립 검토</th></tr>${v.rules.map((r) => `<tr><td>${esc(r.text)}</td><td>${esc(r.how || '— (언급 없음)')}</td><td>${r.judged ? (r.judged.ok ? '✅ ' : '❌ ') + esc(r.judged.note || '') : '<span class="muted">해설 지침은 원문 확인</span>'}</td></tr>`).join('')}</table></div>` : '<p class="muted small">붙인 피드백이 없습니다.</p>'}
        ${item.history?.length ? `<h3>이전 버전 (${item.history.length})</h3>${item.history.map((h) => `<div class="note"><div class="small muted">${fmtTime(h.replacedAt)} 교체 · 남긴 점: ${esc(h.feedback || '없음')}</div><div class="rich">${rich(h.problem?.text || '')}</div>${h.problem ? choicesHtml(h.problem) : ''}</div>`).join('')}` : ''}
      </div></details>` : ''}
    </div>`;
  }

  function bindItem(job, item, card) {
    const panel = $('.fix-panel', card);
    $$('.fix-tag', card).forEach((b) => b.addEventListener('click', () => b.classList.toggle('on')));
    // Saves the picked tags (one feedback each) and the note (with this variant attached), then regenerates if asked.
    const save = async (andRegen) => {
      const tags = $$('.fix-tag.on', card).map((b) => FIX_TAGS[Number(b.dataset.tag)]);
      const note = $('textarea[name=fb]', card)?.value.trim() || '';
      if (!tags.length && !note && !andRegen) throw new Error('해당하는 것을 누르거나 내용을 적어 주세요.');
      const source = { jobId: job.id, itemIndex: item.index };
      for (const [, target, text] of tags) await api('POST', '/api/rules', { text, kind: 'feedback', target, scope: 'material', source });
      if (note) await api('POST', '/api/rules', { text: note, kind: 'feedback', target: 'all', scope: 'material', source });
      const said = [...tags.map(([, , text]) => text), note].filter(Boolean).join('\n');
      if (andRegen) { await api('POST', `/api/jobs/${job.id}/items/${item.index}/regenerate`, { feedback: said }); wake(); }
      $$('.fix-tag.on', card).forEach((b) => b.classList.remove('on'));
      if ($('textarea[name=fb]', card)) $('textarea[name=fb]', card).value = '';
      const n = tags.length + (note ? 1 : 0);
      toast(andRegen ? `피드백${n ? ` ${n}개를 저장하고` : '을 반영해'} 이 문제를 다시 만드는 중입니다.` : `피드백 ${n}개를 저장했습니다. 다음에 만드는 변형부터 들어갑니다.`);
    };
    $('button[name=save]', card)?.addEventListener('click', guard(() => save(false)));
    $('button[name=regen]', card)?.addEventListener('click', guard(async (e) => { e.target.disabled = true; await save(true); }));
    // The review bar: 채택 toggles at once; 고칠 점 opens or closes the panel right under it; 다시 만들기 uses what is picked in it.
    $('[data-rv="adopt"]', card)?.addEventListener('click', guard(async (e) => {
      const r = await api('PUT', `/api/jobs/${job.id}/items/${item.index}/review`, { adopted: !item.adopted });
      item.adopted = r.adopted;
      card.classList.toggle('adopted', r.adopted);
      e.target.classList.toggle('on', r.adopted);
      e.target.textContent = r.adopted ? '✓ 채택됨' : '👍 채택';
      const state = $('.head .chip', card);
      if (state && !item.status.match(/ing$/)) state.outerHTML = r.adopted ? '<span class="chip ok">채택됨</span>' : chip(ITEM_STATUS, item.status);
      toast(r.adopted ? '채택했습니다. 학습지에 들어가고, 다음 세트의 본보기가 됩니다.' : '채택을 취소했습니다.');
    }));
    $('[data-rv="fix"]', card)?.addEventListener('click', () => { if (panel) panel.open = !panel.open; });
    $('[data-rv="regen"]', card)?.addEventListener('click', guard(async (e) => {
      const picked = $$('.fix-tag.on', card).length || $('textarea[name=fb]', card)?.value.trim();
      if (!picked && !confirm('고칠 점 없이 이 문제를 다시 만들까요? (이 문제의 피드백은 모두 반영됩니다)')) return;
      e.target.disabled = true;
      await save(true);
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

  // ------------------------------------------------------------------ 학습
  // Everything the AI has been taught, in one place: a count of each kind by where it applies, the latest things
  // learned (when, where from), then ① 분석 and ② 생성 with the 모든 문제 items (added here) and each problem's items
  // (added on the problem page), all editable in place; a problem's item can be widened to every problem.
  const learnOpen = new Set();
  async function learningView() {
    const key = 'em-learn-stage';
    let stage = 'make';
    try { stage = localStorage.getItem(key) || 'make'; } catch { /* no storage */ }
    view.innerHTML = `<div class="lt">
      <div class="lt-title"><h1>학습</h1><p class="lt-meta">AI에게 가르친 모든 것입니다. 항목마다 어디에 적용되는지(모든 문제 또는 문제 이름)와 어디서 배웠는지가 나옵니다. 가르친 내용은 바로 다음 분석·생성부터 들어갑니다.</p></div>
      <section class="lt-sec"><div class="lt-sec-head"><h2>한눈에 보기</h2></div><div class="panel learn-sum" id="l-sum"><span class="muted">불러오는 중…</span></div></section>
      <section class="lt-sec"><div class="lt-sec-head"><h2>최근 학습</h2></div><div class="panel lt-list" id="l-recent"></div></section>
      <nav class="stage-tabs" role="tablist">
        <button type="button" role="tab" data-stage-tab="read"><span class="stage-no">1</span><span class="stage-txt"><b>분석 학습</b><small id="lst-read"></small></span></button>
        <button type="button" role="tab" data-stage-tab="make"><span class="stage-no">2</span><span class="stage-txt"><b>생성 학습</b><small id="lst-make"></small></span></button>
      </nav>
      <div class="stage" data-pane="read">
        <section class="lt-sec" id="l-ra"><div class="lt-sec-head"><h2>분석 피드백 · 모든 문제</h2><p>모든 문제를 분석할 때 AI가 따릅니다. 한 문제의 피드백과 부딪히면 그 문제의 것을 따릅니다.</p></div><div class="fb-wrap" id="l-ca"></div></section>
        <section class="lt-sec" id="l-rp"><div class="lt-sec-head"><h2>분석 피드백 · 문제별</h2><p>그 문제를 다시 분석할 때만 들어갑니다. 문제 페이지의 ① 원본 분석에서 남깁니다.</p></div><div class="panel lt-list" id="l-pa"></div></section>
        <section class="lt-sec" id="l-rc"><div class="lt-sec-head"><h2>읽기 교정 · 모든 문제</h2><p>잘못 읽은 단어를 고치면(분석 결과 수정, 단어 확인 → 바꾸기) 자동으로 쌓이고, 다음 분석부터 그 단어를 주의해서 읽습니다.</p></div><div class="panel lt-list" id="l-corr"></div></section>
      </div>
      <div class="stage" data-pane="make">
        <section class="lt-sec" id="l-ga"><div class="lt-sec-head"><h2>생성 피드백 · 모든 문제</h2><p>모든 문제의 변형을 만들 때 AI가 지킬 점입니다. 만든 문제마다 지켰는지 검사합니다.</p></div><div class="fb-wrap" id="l-cg"></div></section>
        <section class="lt-sec" id="l-gp"><div class="lt-sec-head"><h2>생성 피드백 · 문제별</h2><p>그 문제의 변형에만 들어갑니다. 문제 페이지의 ② 변형 문제나 세트의 ✏️ 고칠 점에서 남깁니다.</p></div><div class="panel lt-list" id="l-pg"></div></section>
        <section class="lt-sec" id="l-ge"><div class="lt-sec-head"><h2>본보기 · 문제별</h2><p>세트에서 👍 채택한 문제입니다. 그 문제의 같은 단계 변형을 만들 때 본보기로 보여 줍니다.</p></div><div class="panel lt-list" id="l-ex"></div></section>
      </div>
      <section class="lt-sec"><div class="lt-sec-head"><h2>AI 역할 · 모든 문제</h2><p>분석·생성·검토, 모든 AI 호출의 맨 앞에 붙습니다.</p></div><div class="panel lt-list" id="l-persona"></div></section>
      <section class="lt-sec"><div class="panel lt-checks" id="l-checks"></div></section>
    </div>`;
    const show = (tab) => {
      $$('[data-stage-tab]').forEach((b) => { b.classList.toggle('on', b.dataset.stageTab === tab); b.setAttribute('aria-selected', String(b.dataset.stageTab === tab)); });
      $$('[data-pane]').forEach((p) => { p.hidden = p.dataset.pane !== tab; });
      try { localStorage.setItem(key, tab); } catch { /* no storage */ }
    };
    $$('[data-stage-tab]').forEach((b) => b.addEventListener('click', () => show(b.dataset.stageTab)));
    show(stage);
    await paintLearning();
  }

  async function paintLearning() {
    const d = await api('GET', '/api/learning');
    if (!$('#l-sum')) return;
    const o = (k) => (learnOpen.has(k) ? ' open' : '');
    const editMore = (text, extra = '', target) => `<div class="lt-more"><textarea data-f="text" rows="3">${esc(text)}</textarea>
        <div class="lt-actions">${target ? `<select data-f="target" aria-label="대상">${targetOptions(target === 'design' ? 'problem' : target)}</select>` : ''}${extra}<span class="spacer"></span><button class="small" data-act="cancel">취소</button><button class="small primary" data-act="save">저장</button></div></div>`;
    const group = (title, n, href) => `<div class="fb-kind"><b>${esc(title)}</b><span>${n}개</span>${href ? `<a class="muted" href="${href}">문제 열기 ›</a>` : ''}</div>`;
    const byProblem = (list, idOf, titleOf) => [...list.reduce((map, x) => map.set(idOf(x), [...(map.get(idOf(x)) || []), x]), new Map())].map(([id, xs]) => ({ id, title: titleOf(xs[0]), xs }));

    // Counts by kind and by where they apply; each count opens its list.
    const on = (rs) => rs.filter((r) => r.status === 'approved');
    const pa = d.analysis.problems;
    const pg = on(d.generation.problems);
    const cell = (n, problems, jump) => (n ? `<button class="learn-n" data-jump="${jump}">${n}개${problems ? ` <small>${problems}문제</small>` : ''}</button>` : '<span class="muted">–</span>');
    const nProblems = (xs, idOf) => new Set(xs.map(idOf)).size;
    $('#l-sum').innerHTML = `<div class="table-wrap"><table class="learn-table2">
      <tr><th></th><th>모든 문제</th><th>문제별</th></tr>
      <tr><th>분석 피드백</th><td>${cell(d.analysis.common.length, 0, 'read:l-ra')}</td><td>${cell(pa.reduce((n, p) => n + p.items.length, 0), pa.length, 'read:l-rp')}</td></tr>
      <tr><th>읽기 교정</th><td>${cell(d.corrections.length, 0, 'read:l-rc')}</td><td><span class="muted">–</span></td></tr>
      <tr><th>생성 피드백</th><td>${cell(on(d.generation.common).length + on(d.generation.topic).length, 0, 'make:l-ga')}</td><td>${cell(pg.length, nProblems(pg, (r) => r.source?.materialId), 'make:l-gp')}</td></tr>
      <tr><th>본보기 (채택)</th><td><span class="muted">–</span></td><td>${cell(d.examples.length, nProblems(d.examples, (e) => e.materialId), 'make:l-ge')}</td></tr>
      <tr><th>AI 역할</th><td>${d.persona ? '<button class="learn-n" data-jump="all:l-persona">정함</button>' : '<span class="muted">없음</span>'}</td><td><span class="muted">–</span></td></tr>
    </table></div>`;
    const recentRow = (x) => `<div class="lt-row lt-plain">
        <div class="lt-main"><span class="lt-name lt-clamp">${esc(x.text)}</span><span class="lt-sub lt-wrap">${fmtTime(x.at)} · <b>${esc(x.kind)}</b> · ${esc(x.scope)} · ${esc(x.from)}에서</span></div>
        ${x.href ? `<a class="btn small" href="${x.href}">보기</a>` : ''}</div>`;
    $('#l-recent').innerHTML = (d.recent.slice(0, 5).map(recentRow).join('') || emptyRow('아직 학습한 것이 없습니다. 문제 페이지에서 피드백을 남기거나 세트에서 채택하면 여기에 쌓입니다.'))
      + (d.recent.length > 5 ? `<details class="lt-off"><summary>그 전 ${d.recent.length - 5}개</summary>${d.recent.slice(5).map(recentRow).join('')}</details>` : '');
    $('#lst-read').textContent = `모든 문제 ${d.analysis.common.length + d.corrections.length} · 문제별 ${pa.reduce((n, p) => n + p.items.length, 0)}`;
    $('#lst-make').textContent = `모든 문제 ${on(d.generation.common).length + on(d.generation.topic).length} · 문제별 ${pg.length} · 본보기 ${d.examples.length}`;

    // ① 분석 — 모든 문제
    $('#l-ca').innerHTML = `<div class="panel fb-new"><textarea id="la-text" rows="2" placeholder="예: 해설의 step 하나에 판단이 여러 개 있으면 판단마다 STEP을 나눈다. 해설은 학생이 읽기 쉽게 풀어 쓴다."></textarea>
        <div class="lt-actions"><span class="muted small">이미 분석한 문제는 다시 분석하면 반영됩니다.</span><span class="spacer"></span><button class="small primary" id="la-add">추가</button></div></div>
      <div class="panel lt-list">${d.analysis.common.map((a, i) => `<div class="lt-row lt-plain${o('ca:' + i)}" data-row="ca:${i}" data-ca="${i}">
          <div class="lt-main"><span class="lt-name lt-clamp">${esc(a.text)}</span><span class="lt-sub">${fmtTime(a.at)} · 학습 페이지에서</span></div>
          <button class="small lt-open" data-open>편집</button>${editMore(a.text, '<button class="small danger" data-act="del">삭제</button>')}</div>`).join('') || emptyRow('아직 없습니다.')}</div>`;
    // ① 분석 — 문제별
    $('#l-pa').innerHTML = pa.map((p) => group(p.title, p.items.length, `#/m/${p.materialId}`) + p.items.map((f) => `<div class="lt-row lt-plain${o(`pa:${p.materialId}:${f.i}`)}" data-row="pa:${p.materialId}:${f.i}" data-pa="${p.materialId}:${f.i}">
          <div class="lt-main"><span class="lt-name lt-clamp">${esc(f.text)}</span><span class="lt-sub">${fmtTime(f.at)} · ${f.applied ? '지금 분석에 반영됨' : '<span class="warn">다시 분석하면 반영</span>'}</span></div>
          <button class="small lt-open" data-open>편집</button>${editMore(f.text, '<button class="small" data-act="promote">모든 문제에 적용</button><button class="small danger" data-act="del">삭제</button>')}</div>`).join('')).join('')
      || emptyRow('아직 없습니다. 문제 페이지의 ① 원본 분석에서 남깁니다.');
    $('#l-corr').innerHTML = d.corrections.map((c) => `<div class="lt-row lt-plain" data-corr="${c.id}">
        <div class="lt-main"><span class="lt-name">"${esc(c.wrong)}" → "${esc(c.right)}"</span><span class="lt-sub">${c.count}번 고침${c.subject ? ` · ${esc(c.subject)}` : ''}</span></div>
        <button class="small danger" data-act="del-corr">삭제</button></div>`).join('') || emptyRow('아직 없습니다.');

    // ② 생성 — rows for a rule, wherever it applies
    const ruleRow = (r) => {
      const judged = r.kept + r.broken;
      const from = r.source?.jobId ? `<a href="#/j/${r.source.jobId}${r.source.itemIndex !== undefined ? `?item=${r.source.itemIndex}` : ''}">${esc(String(r.source.label || '변형 문제').replace((r.materialTitle || '') + ' · ', ''))}의 고칠 점에서</a>` : r.scope === 'material' ? '문제 페이지에서' : '학습 페이지에서';
      return `<div class="lt-row lt-pick${r.status === 'approved' ? '' : ' off'}${o('r:' + r.id)}" data-row="r:${r.id}" data-rule="${r.id}">
        <input type="checkbox" data-act="toggle" ${r.status === 'approved' ? 'checked' : ''} aria-label="이 피드백 적용">
        <div class="lt-main"><span class="lt-name lt-clamp">${esc(r.text)}</span><span class="lt-sub lt-wrap">${TARGET_TXT[r.target] || '전체'} · ${fmtTime(r.createdAt)} ${from} · ${judged ? `변형 ${judged}개에서 지킴 ${r.kept}${r.broken ? ` · <span class="bad">어김 ${r.broken}</span>` : ''}` : '아직 검토 전'}</span></div>
        <button class="small lt-open" data-open>편집</button>${editMore(r.text, `${r.scope === 'material' ? '<button class="small" data-act="promote">모든 문제에 적용</button>' : ''}<button class="small danger" data-act="del">삭제</button>`, r.target)}</div>`;
    };
    const common = [...d.generation.common, ...d.generation.topic];
    $('#l-cg').innerHTML = `<div class="panel fb-new"><textarea id="lg-text" rows="2" placeholder="예: 풀이에 쓰이지 않는 조건이나 서술을 넣지 않는다."></textarea>
        <div class="lt-actions"><label for="lg-target" class="fb-target-label">대상</label><select id="lg-target">${targetOptions('all')}</select><span class="spacer"></span><button class="small primary" id="lg-add">추가</button></div></div>
      <div class="panel lt-list">${on(common).map(ruleRow).join('') || emptyRow('아직 없습니다.')}
        ${common.some((r) => r.status !== 'approved') ? `<details class="lt-off"><summary>꺼 둔 것 ${common.filter((r) => r.status !== 'approved').length}개</summary>${common.filter((r) => r.status !== 'approved').map(ruleRow).join('')}</details>` : ''}</div>`;
    const groups = byProblem(d.generation.problems, (r) => r.source?.materialId, (r) => r.materialTitle);
    $('#l-pg').innerHTML = groups.map((g) => group(g.title, on(g.xs).length, `#/m/${g.id}`) + g.xs.map(ruleRow).join('')).join('')
      || emptyRow('아직 없습니다. 문제 페이지의 ② 변형 문제나 세트의 ✏️ 고칠 점에서 남깁니다.');
    const ex = byProblem(d.examples, (e) => e.materialId, (e) => e.title);
    $('#l-ex').innerHTML = ex.map((g) => group(g.title, g.xs.length, `#/m/${g.id}`) + g.xs.map((e) => `<div class="lt-row lt-plain">
        <div class="lt-main"><span class="lt-name">${esc(e.label)}</span><span class="lt-sub lt-clip">${fmtTime(e.at)} 채택 · ${esc(e.preview)}</span></div>
        <a class="btn small" href="#/j/${e.jobId}?item=${e.index}">열기</a></div>`).join('')).join('')
      || emptyRow('아직 없습니다. 세트에서 좋은 문제를 👍 채택하면 쌓입니다.');

    // AI 역할, and how the results are checked
    $('#l-persona').innerHTML = `<div class="lt-row lt-plain${o('persona')}" data-row="persona">
        <div class="lt-main"><span class="lt-name${d.persona ? ' lt-clamp' : ''}">${esc(d.persona || '아직 정하지 않았습니다')}</span><span class="lt-sub lt-wrap">${d.persona ? '모든 AI 호출의 맨 앞에 붙습니다' : '예: 고등학교 화학 선생님의 출제를 돕는 조교로서, 학생이 읽는 문장은 교과서 말투로 쓰고 단위를 빠뜨리지 않는다.'}</span></div>
        <button class="small lt-open" data-open>편집</button>${editMore(d.persona)}</div>`;
    const list = (items) => `<ul>${items.map((x) => `<li><b>${esc(x.label)}</b><span>${esc(x.how)}</span></li>`).join('')}</ul>`;
    $('#l-checks').innerHTML = `<details><summary>AI가 만든 결과는 어떻게 검토하나요? (검사 ${d.checks.generation.length + d.checks.analysis.length}개)</summary>
      <p class="small">만든 문제는 저장하기 전에 자동으로 검토합니다. 걸린 곳은 AI가 최대 2번 고치고, 그래도 남으면 <b>교사 검토 필요</b>로 표시합니다.</p>
      <div class="lt-check-groups"><div><h3>변형 문제</h3>${list(d.checks.generation)}</div><div><h3>원본 분석</h3>${list(d.checks.analysis)}</div></div></details>`;

    // Handlers
    $$('[data-jump]').forEach((b) => b.addEventListener('click', () => {
      const [tab, sec] = b.dataset.jump.split(':');
      if (tab !== 'all') $(`[data-stage-tab="${tab}"]`).click();
      $('#' + sec)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }));
    ['#l-ca', '#l-pa', '#l-cg', '#l-pg', '#l-persona'].forEach((sel) => rowToggles($(sel), learnOpen));
    const done = async (msg, row) => { if (row) learnOpen.delete(row.dataset.row); if (msg) toast(msg); await paintLearning(); };
    const cancel = (row, text) => $('[data-act=cancel]', row).addEventListener('click', () => { $('[data-f=text]', row).value = text; row.classList.remove('open'); learnOpen.delete(row.dataset.row); });
    const pr = $('[data-row=persona]');
    cancel(pr, d.persona);
    $('[data-act=save]', pr).addEventListener('click', guard(async () => { await api('PUT', '/api/common/persona', { persona: $('[data-f=text]', pr).value }); await done('AI 역할을 저장했습니다.', pr); }));
    $('#la-add').addEventListener('click', guard(async () => {
      const text = $('#la-text').value.trim();
      if (!text) throw new Error('내용을 입력해 주세요.');
      await api('POST', '/api/common/analysis', { text });
      await done('학습했습니다. 다음 분석부터 모든 문제에 들어갑니다.');
    }));
    $$('[data-ca]').forEach((row) => {
      const i = row.dataset.ca;
      cancel(row, d.analysis.common[i].text);
      $('[data-act=save]', row).addEventListener('click', guard(async () => { await api('PUT', '/api/common/analysis/' + i, { text: $('[data-f=text]', row).value }); await done('저장했습니다.', row); }));
      $('[data-act=del]', row).addEventListener('click', guard(async () => { if (!confirm('삭제할까요?')) return; await api('DELETE', '/api/common/analysis/' + i); learnOpen.clear(); await done('삭제했습니다.'); }));
    });
    $$('[data-pa]').forEach((row) => {
      const [mid, i] = row.dataset.pa.split(':');
      cancel(row, pa.find((p) => p.materialId === mid).items.find((f) => String(f.i) === i).text);
      $('[data-act=save]', row).addEventListener('click', guard(async () => { await api('PUT', `/api/materials/${mid}/analysis-feedback/${i}`, { text: $('[data-f=text]', row).value }); await done('저장했습니다.', row); }));
      $('[data-act=promote]', row).addEventListener('click', guard(async () => { await api('POST', `/api/materials/${mid}/analysis-feedback/${i}/promote`); learnOpen.clear(); await done('모든 문제의 분석 피드백으로 옮겼습니다.'); }));
      $('[data-act=del]', row).addEventListener('click', guard(async () => { if (!confirm('삭제할까요?')) return; await api('DELETE', `/api/materials/${mid}/analysis-feedback/${i}`); learnOpen.clear(); await done('삭제했습니다.'); }));
    });
    $$('#l-corr [data-act=del-corr]').forEach((b) => b.addEventListener('click', guard(async () => {
      if (!confirm('이 읽기 교정을 삭제할까요?')) return;
      await api('DELETE', '/api/corrections/' + b.closest('[data-corr]').dataset.corr);
      await done('삭제했습니다.');
    })));
    $('#lg-add').addEventListener('click', guard(async () => {
      const text = $('#lg-text').value.trim();
      if (!text) throw new Error('내용을 입력해 주세요.');
      await api('POST', '/api/rules', { text, kind: 'feedback', target: $('#lg-target').value, scope: 'global' });
      await done('학습했습니다. 다음에 만드는 세트부터 모든 문제에 들어갑니다.');
    }));
    const allRules = [...common, ...d.generation.problems];
    $$('[data-rule]').forEach((row) => {
      const id = row.dataset.rule;
      const rule = allRules.find((r) => r.id === id);
      cancel(row, rule.text);
      $('[data-act=toggle]', row).addEventListener('change', guard(async (e) => {
        try { await api('PUT', '/api/rules/' + id, { status: e.target.checked ? 'approved' : 'pending' }); }
        catch (err) { e.target.checked = !e.target.checked; throw err; }
        await done(e.target.checked ? '다시 적용합니다.' : '껐습니다. 다음 세트부터 빠집니다.');
      }));
      $('[data-act=save]', row).addEventListener('click', guard(async () => { await api('PUT', '/api/rules/' + id, { text: $('[data-f=text]', row).value, target: $('[data-f=target]', row).value }); await done('저장했습니다.', row); }));
      $('[data-act=promote]', row)?.addEventListener('click', guard(async () => { await api('PUT', '/api/rules/' + id, { scope: 'global' }); await done('모든 문제의 생성 피드백으로 넓혔습니다.', row); }));
      $('[data-act=del]', row).addEventListener('click', guard(async () => { if (!confirm('삭제할까요?')) return; await api('DELETE', '/api/rules/' + id); await done('삭제했습니다.', row); }));
    });
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
      <p class="muted small">AI에게 가르친 역할과 피드백은 <a href="#/learning">학습</a>에서 관리합니다.</p>
    </div>`;
    const opened = new Set(); // rows left open survive a repaint
    const toggleRows = (box) => rowToggles(box, opened);
    const isOpen = (key) => (opened.has(key) ? ' open' : '');

    const won = (usd) => `약 ${Math.round(usd * 1400).toLocaleString()}원`;
    const month = (u) => (u?.month?.sets ? `이번 달 ${u.month.sets}세트${u.month.usd ? ' · ' + won(u.month.usd) : ''}` : '이번 달 사용 없음');
    const left = (w) => (w ? Math.max(0, Math.round((1 - w.used) * 100)) : null);
    const meter = (title, w) => {
      const n = left(w);
      return `<span class="lt-meter"><span>${title}</span><span class="lt-bar"><i class="${n === null ? '' : n <= 10 ? 'bad' : n <= 30 ? 'warn' : 'ok'}" style="width:${n ?? 0}%"></i></span><b>${n === null ? '–' : n + '%'}</b></span>`;
    };

    const paintModels = async (fresh) => {
      // 새로 고침 asks Claude once (a tiny question) so the remaining share is current, not as of the last generation.
      if (fresh) await api('POST', '/api/claude-login/check').catch(() => null);
      const [status, llm] = await Promise.all([api('GET', '/api/status'), api('GET', '/api/llm')]);
      const p = status.providers || {};
      const def = status.defaultProvider || 'deepseek';
      const c = llm.claude;
      const lim = c.loggedIn ? c.limits : null;
      const row = (key, { name, ok, state, fact, more, open = '관리' }) => `<div class="lt-row${isOpen(key)}" data-row="${key}">
        <input type="radio" name="lt-default" id="lt-def-${key}" value="${key}" aria-label="${esc(name)} 기본 모델로 사용" ${def === key ? 'checked' : ''} ${ok ? '' : 'disabled'}>
        <div class="lt-main">
          <span class="lt-name">${esc(name)}${def === key ? '<span class="lt-tag">기본</span>' : ''}</span>
          <span class="lt-sub"><i class="lt-dot ${ok ? 'ok' : ''}"></i>${state}</span>
        </div>
        <div class="lt-fact">${fact}</div>
        <button class="small lt-open" data-open>${open}</button>
        <div class="lt-more">${more}</div>
      </div>`;
      $('#lt-models').innerHTML = [
        row('claude-cli', {
          name: c.label || 'Claude (구독)', ok: c.loggedIn,
          state: c.loggedIn ? `연결됨 · ${month(llm.usage['claude-cli'])}` : '연결 안 됨',
          fact: c.loggedIn ? `${meter('5시간', lim?.fiveHour)}${meter('1주일', lim?.sevenDay)}` : '',
          open: c.loggedIn ? '관리' : '연결하기',
          more: `<div class="lt-fields">
              <div><label for="cl-model">모델</label><select id="cl-model">${Object.entries(c.models || {}).map(([id, n]) => `<option value="${id}" ${id === c.model ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select></div>
              <div><label for="cl-effort">추론 강도</label><select id="cl-effort">${(c.efforts || []).map((e) => `<option value="${e}" ${e === c.effort ? 'selected' : ''}>${EFFORT_TXT[e] || e}</option>`).join('')}</select></div>
            </div>
            ${c.loggedIn ? `<p class="lt-note">구독으로 실행되어 호출당 비용이 없습니다. ${lim ? `한도는 ${fmtTime(lim.at)} 기준이고, 5시간 한도는 ${lim.fiveHour?.resetsAt ? fmtTime(lim.fiveHour.resetsAt) : '-'}, 1주일 한도는 ${lim.sevenDay?.resetsAt ? fmtTime(lim.sevenDay.resetsAt) : '-'}에 다시 채워집니다.` : '한도는 새로 고침을 누르면 가져옵니다.'}</p>` : ''}
            <div id="claude-login"></div>`,
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
      toggleRows($('#lt-models'));
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
    };

    $('#llm-refresh').addEventListener('click', guard(async (e) => { e.target.disabled = true; e.target.textContent = '가져오는 중…'; try { await paintModels(true); } finally { e.target.disabled = false; e.target.textContent = '새로 고침'; } }));
    await paintModels(false);
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
