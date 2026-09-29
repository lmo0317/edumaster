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
  const cost = (u, provider) => (provider === 'gemma' ? 0 : ((u.paidInput ?? u.input ?? 0) * 0.30 + (u.paidOutput ?? u.output ?? 0) * 1.20) / 1e6);
  const tokens = (u, provider) => u ? `모델 호출 ${u.calls}회 · ${Number(u.total || 0).toLocaleString()}토큰 · ${provider === 'gemma' ? '무료(Gemma)' : provider === 'relay' ? '토큰 집계 없음(세션 중계)' : `최대 약 $${cost(u, provider).toFixed(3)}`}` : '';
  const PROVIDER_LABEL = { deepseek: 'DeepSeek', gemma: 'Gemma', relay: 'Claude Opus 5.5' };
  // Model picker: DeepSeek is always there; Gemma only while the teacher's PC is on.
  let statusCache = null;
  const loadStatus = async () => (statusCache = await api('GET', '/api/status'));
  function providerPicker(name, selected) {
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
  const TARGET = { problem: '문제', solution: '해설', design: '설계', all: '전체' };
  const KIND = { do: '할 것', dont: '하지 말 것', feedback: '피드백' };

  // ------------------------------------------------------------------ login
  function showLogin() {
    if ($('.overlay.login')) return;
    const el = document.createElement('div');
    el.className = 'overlay login';
    el.innerHTML = `<form class="box"><h2>EduMaster v2 접속</h2><p class="muted small">관리자에게 받은 접속 코드를 입력하세요.</p>
      <input type="password" name="code" autocomplete="current-password" placeholder="접속 코드" required>
      <div class="row" style="margin-top:12px"><span class="spacer"></span><button class="primary">접속</button></div></form>`;
    document.body.appendChild(el);
    $('input', el).focus();
    $('form', el).addEventListener('submit', guard(async (e) => {
      e.preventDefault();
      await api('POST', '/api/login', { code: e.target.code.value });
      el.remove();
      $('#logout').hidden = false;
      route();
    }));
  }
  $('#logout').addEventListener('click', guard(async () => { await api('POST', '/api/logout'); location.hash = '#/'; showLogin(); }));

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
      if ((m = /^#\/m\/([a-f0-9]+)/.exec(hash))) { setNav('materials'); await materialView(m[1], alive); }
      else if ((m = /^#\/j\/([a-f0-9]+)/.exec(hash))) { setNav('materials'); await jobView(m[1], alive); }
      else if (hash.startsWith('#/materials')) { setNav('materials'); await materialsView(); }
      else if (hash.startsWith('#/rules')) { setNav('rules'); await rulesView(); }
      else if (hash.startsWith('#/system')) { setNav('system'); await systemView(); }
      else { setNav('home'); await homeView(); }
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
      <h1>새 문제로 단계별 변형 문제 만들기</h1>
      <div class="panel">
        <h2>1. 원본 문제와 해설 넣기</h2>
        <p class="muted small">문제 이미지는 필수, 해설 이미지는 선택입니다. 해설을 넣으면 그 풀이 방법(보조 문자, 가정·모순, 비교 순서)을 그대로 STEP으로 정리하고, 없으면 AI가 먼저 풀이를 만듭니다. 이미지를 끌어 놓거나 클릭하거나 Ctrl+V로 붙여 넣으세요.</p>
        <div class="cols cols-2">
          <div><label>문제 이미지 (필수)</label><div class="drop" id="drop-problem"><span class="muted">문제 이미지를 넣어 주세요</span></div></div>
          <div><label>해설 이미지 (선택)</label><div class="drop" id="drop-solution"><span class="muted">교사 해설 이미지 (선택)</span></div>
            <label class="inline"><input type="checkbox" id="same"> 한 이미지에 문제와 해설이 함께 있음</label></div>
        </div>
        <label for="title">제목 (선택)</label><input type="text" id="title" placeholder="예: 몰질량 킬러 02페이지">
        <label>분석 모델</label>${providerPicker('provider', 'deepseek')}
        <label for="note">AI에게 알려 줄 점 (선택)</label><textarea id="note" placeholder="예: 표 III의 'B'는 학생 필기입니다. 해설은 STEP 3개입니다."></textarea>
        <div class="row" style="margin-top:12px"><span class="muted small" id="submit-hint">문제 이미지를 넣으면 분석을 시작할 수 있습니다.</span><span class="spacer"></span><button class="primary" id="start" disabled>분석 시작</button></div>
      </div>
      <div class="panel"><div class="row"><h2 style="margin:0">최근 자료</h2><span class="spacer"></span><a href="#/materials">전체 보기</a></div><div class="list" id="recent" style="margin-top:10px"><span class="muted small">불러오는 중…</span></div></div>`;
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
    const list = await api('GET', '/api/materials');
    $('#recent').innerHTML = list.length ? list.slice(0, 6).map(materialEntry).join('') : '<span class="muted small">아직 자료가 없습니다.</span>';
  }

  const materialEntry = (m) => `<a class="entry" href="#/m/${m.id}"><div style="flex:1"><div class="title">${esc(m.title)}</div>
    <div class="muted small">${esc([m.subject, m.topic].filter(Boolean).join(' · '))} ${m.stepCount ? `· STEP ${m.stepCount}개` : ''} · ${fmtTime(m.createdAt)}</div></div>${chip(MAT_STATUS, m.status)}</a>`;

  async function materialsView() {
    const [materials, jobs] = await Promise.all([api('GET', '/api/materials'), api('GET', '/api/jobs')]);
    view.innerHTML = `<h1>자료·결과</h1>
      <div class="panel"><h2>원본 자료</h2><div class="list">${materials.map(materialEntry).join('') || '<span class="muted">자료가 없습니다.</span>'}</div></div>
      <div class="panel"><h2>생성 세트</h2><div class="list">${jobs.filter((j) => j.type === 'generate').map(jobEntry).join('') || '<span class="muted">생성한 세트가 없습니다.</span>'}</div></div>`;
  }
  const jobEntry = (j) => `<a class="entry" href="#/j/${j.id}"><div style="flex:1"><div class="title">${esc(j.title || '')} — ${j.items.length}문제 ${j.options?.mode === 'integrated' ? '(통합 변형)' : '(수치 변형)'}</div>
    <div class="muted small">${fmtTime(j.createdAt)} · ${PROVIDER_LABEL[j.options?.provider] || 'DeepSeek'} · ${tokens(j.usage, j.options?.provider)} · ${j.items.map((i) => (ITEM_STATUS[i.status] || [i.status])[0]).join(' / ')}</div></div>${chip(JOB_STATUS, j.status)}</a>`;

  // ------------------------------------------------------------------ material
  function stepHtml(s, i) {
    return `<div class="step"><div class="head"><span class="badge">STEP ${i + 1}</span>${rich(s.title).replace(/^<p>|<\/p>$/g, '')}</div>
      ${s.purpose ? `<div class="meta"><b>결정하는 것</b> ${rich(s.purpose).replace(/^<p>|<\/p>$/g, '')}</div>` : ''}
      ${s.technique ? `<div class="meta"><b>핵심 기법</b> ${rich(s.technique).replace(/^<p>|<\/p>$/g, '')}</div>` : ''}
      <div class="rich">${rich(s.work)}</div>
      ${s.result ? `<div class="meta"><b>결론</b> ${rich(s.result).replace(/^<p>|<\/p>$/g, '')}</div>` : ''}</div>`;
  }
  function choicesHtml(p, showAnswer = true) {
    if (!p.choices?.length) return '';
    return `<div class="choices">${p.choices.map((c, i) => `<div class="c ${showAnswer && p.answer === i + 1 ? 'answer' : ''}"><span>${circled(i + 1)}</span><span class="rich">${rich(c).replace(/^<p>|<\/p>$/g, '')}</span></div>`).join('')}</div>`;
  }
  function originals(images) {
    const src = (id) => 'api/files/' + id;
    return `<div class="orig">${images.sameImage
      ? `<figure><figcaption>원본 (문제+해설)</figcaption><img data-zoom src="${src(images.problem)}" alt="원본"></figure>`
      : `<figure><figcaption>원본 문제</figcaption><img data-zoom src="${src(images.problem)}" alt="원본 문제"></figure>${images.solution ? `<figure><figcaption>교사 해설</figcaption><img data-zoom src="${src(images.solution)}" alt="원본 해설"></figure>` : ''}`}</div>`;
  }

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
        <label>분석 모델</label>${providerPicker('provider', m.analyzedWith || 'deepseek')}
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
    const gens = m.jobs.filter((j) => j.type === 'generate');
    view.innerHTML = `
      <div class="row"><h1 style="margin-right:auto">${esc(m.title)}</h1>${chip(MAT_STATUS, m.status)}</div>
      <div class="grid2">
        <div class="panel">${originals(m.images)}</div>
        <div class="panel" id="analysis"></div>
      </div>
      <div class="panel" id="generate"></div>
      <div class="panel"><h2>이 자료로 만든 세트</h2><div class="list">${gens.map(jobEntry).join('') || '<span class="muted small">아직 없습니다.</span>'}</div></div>`;
    if (editing) editAnalysis(m); else showAnalysis(m);
    generatePanel(m, n);
  }

  function showAnalysis(m) {
    const el = $('#analysis');
    el.innerHTML = `
      <div class="row"><h2 style="margin:0">분석 결과</h2><span class="spacer"></span>
        <button class="small" id="edit">수정</button><button class="small" id="reanalyze">다시 분석</button><button class="small danger" id="del">삭제</button></div>
      <p class="muted small">${esc([m.subject, m.topic].filter(Boolean).join(' · '))} · ${m.solutionSource === 'ai' ? '<span class="chip warn">해설 없음 → AI가 만든 풀이</span>' : '<span class="chip ok">교사 해설 기반</span>'} <span class="chip">분석: ${PROVIDER_LABEL[m.analyzedWith] || 'DeepSeek'}</span> ${m.teacherEditedAt ? '<span class="chip">교사 수정됨</span>' : ''}</p>
      ${m.steps.length > (m.targetSteps || 99) ? `<div class="note warn row"><span style="flex:1">해설의 단계 표시는 ${m.targetSteps}개인데 정리한 STEP은 ${m.steps.length}개입니다.</span><button class="small primary" id="align">해설 단계에 맞춰 합치기</button></div>` : ''}
      ${m.uncertainties?.filter((u) => !u.startsWith('해설의 단계 표시는')).length ? `<div class="note warn"><b>판독이 불확실한 부분 — 원본과 대조해 주세요</b><ul>${m.uncertainties.filter((u) => !u.startsWith('해설의 단계 표시는')).map((u) => `<li>${rich(u).replace(/^<p>|<\/p>$/g, '')}</li>`).join('')}</ul></div>` : ''}
      ${m.proofread?.length ? `<details data-k="proof"><summary>원본 대조로 자동 교정한 곳 ${m.proofread.length}건</summary><div class="inner"><ul class="small">${m.proofread.map((u) => `<li>${rich(u).replace(/^<p>|<\/p>$/g, '')}</li>`).join('')}</ul></div></details>` : ''}
      ${m.annotations?.length ? `<div class="note info"><b>문제 조건에서 뺀 필기·표시</b><ul>${m.annotations.map((u) => `<li>${rich(u).replace(/^<p>|<\/p>$/g, '')}</li>`).join('')}</ul></div>` : ''}
      <h3>문제</h3><div class="rich">${rich(m.problem.text)}</div>
      ${m.problem.figure ? `<div class="note info"><b>그림 설명</b><div class="rich">${rich(m.problem.figure)}</div></div>` : ''}
      ${choicesHtml(m.problem)}
      <p class="small muted">정답: ${m.problem.answer ? circled(m.problem.answer) : '없음/서술형'}</p>
      <h3>풀이 STEP (${m.steps.length}개)</h3>
      <div class="steps">${m.steps.map(stepHtml).join('')}</div>
      ${m.techniques?.length ? `<h3>변형 문제에서 재사용할 핵심 기법</h3><div class="rich">${m.techniques.map((t) => `<p class="bullet">• ${rich(t).replace(/^<p>|<\/p>$/g, '')}</p>`).join('')}</div>` : ''}
      ${m.finalCheck ? `<h3>정답 재확인</h3><div class="rich">${rich(m.finalCheck)}</div>` : ''}`;
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
      const note = prompt('다시 분석할 때 AI에게 알려 줄 점 (선택)', m.note || '');
      if (note === null) return;
      const again = statusCache?.providers?.[m.analyzedWith]?.available ? m.analyzedWith : 'deepseek';
      await api('POST', `/api/materials/${m.id}/analyze`, { note, provider: again });
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
      <h2>2. 단계별 변형 문제 만들기</h2>
      <p class="muted small">원본 풀이 STEP ${n}개를 기준으로 합니다. 각 문제는 서버가 검산 프로그램을 정확한 분수로 실행해 정답을 확인하고, 별도의 독립 풀이가 정답을 모른 채 다시 풀어 대조합니다. 어긋나면 한 번만 수정하고, 그래도 어긋나면 '교사 검토 필요'로 그대로 보여 줍니다.</p>
      <label>만들 문제</label>
      <div>${upto.map((k) => `<label class="inline"><input type="checkbox" data-stage='{"kind":"upto","upto":${k}}' checked> ${k === 1 ? 'STEP 1 연습' : `STEP 1~${k} 누적 연습`}</label>`).join('')}
        <label class="inline"><input type="checkbox" data-stage='{"kind":"twin"}' checked> 최종 쌍둥이 문제 (STEP 1~${n} 전체)</label></div>
      ${focus.length ? `<div>${focus.map((k) => `<label class="inline"><input type="checkbox" data-stage='{"kind":"focus","step":${k}}'> STEP ${k} 집중 연습 (${k === 2 ? 'STEP 1' : `STEP 1~${k - 1}`} 결과를 조건으로 제공)</label>`).join('')}</div>` : ''}
      <label>생성 모델</label>${providerPicker('genProvider', m.analyzedWith || 'deepseek')}
      <label>최종 문제 방식</label>
      <div><label class="inline"><input type="radio" name="mode" value="integrated" checked> 통합 변형 (권장) — 앞 연습 문제의 아이디어를 엮은 새 구조</label>
        <label class="inline"><input type="radio" name="mode" value="numeric"> 단순 수치 변형 — 원본과 같은 구조에 숫자만 새로</label></div>
      <div class="cols cols-2">
        <div><label>단계마다 만들 문제 수</label><select id="per"><option>1</option><option>2</option><option>3</option></select></div>
        <div><label>DeepSeek 사고 강도</label><select id="effort"><option value="low">기본 (비용 적음)</option><option value="high">정밀 (토큰 더 사용)</option></select></div>
      </div>
      <div class="note info small" id="rules-preview">적용할 교사 지침을 확인하는 중…</div>
      <div class="row"><span class="muted small" id="estimate"></span><span class="spacer"></span><button class="primary" id="go">생성 시작</button></div>`;
    const estimate = () => {
      const gemma = $('[name=genProvider]:checked', el)?.value === 'gemma';
      $('#effort').disabled = gemma;
      const count = $$('[data-stage]:checked', el).length * Number($('#per').value);
      $('#estimate').textContent = !count ? '만들 문제를 하나 이상 고르세요.'
        : `${count}문제 · 모델 호출 약 ${count * 2}~${count * 4}회 예상 (설계 + 독립 풀이, 필요할 때만 수정 1회)` + (gemma ? ' · Gemma는 무료지만 PC에서 돌아가 문제당 몇 분씩 걸릴 수 있습니다' : '');
      $('#go').disabled = !count;
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
    const rules = await api('GET', '/api/rules');
    const global = rules.filter((r) => r.status === 'approved' && r.scope === 'global');
    const topic = rules.filter((r) => r.status === 'approved' && r.scope === 'topic');
    $('#rules-preview').innerHTML = `<b>항상 적용되는 교사 지침 ${global.length}개</b>${global.length ? '<ul>' + global.slice(0, 8).map((r) => `<li>[${KIND[r.kind]}·${TARGET[r.target]}] ${esc(r.text)}</li>`).join('') + '</ul>' : ''}
      <div>유형별 피드백 ${topic.length}개 중 이 문제와 비슷한 것은 생성할 때 자동으로 골라 붙입니다. <a href="#/rules">지침 관리</a></div>`;
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
      <p class="muted small" style="margin:6px 0">${fmtTime(job.createdAt)} · ${done}/${job.items.length}문제 처리 · ${PROVIDER_LABEL[job.options.provider] || 'DeepSeek'} · ${tokens(job.usage, job.options.provider)} (상한 ${job.budget.maxCalls}회 / ${Number(job.budget.maxTokens).toLocaleString()}토큰) · 사고 강도 ${job.options.effort === 'high' ? '정밀' : '기본'}</p>
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
      <details data-k="rules"><summary>이 세트에 붙인 교사 지침 (${job.rules.length})</summary><div class="inner">${job.rules.length ? '<ul>' + job.rules.map((r) => `<li>[${KIND[r.kind]}·${TARGET[r.target]}${r.scope === 'topic' ? '·유형' : ''}] ${esc(r.text)}</li>`).join('') + '</ul>' : '<span class="muted small">없음</span>'}</div></details>
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
        <div class="cols cols-3">
          <div><label>대상</label><select name="target"><option value="problem">문제 (조건·발문·선택지)</option><option value="solution">해설</option><option value="design">설계 (단계·통합 방식)</option><option value="all">전체</option></select></div>
          <div><label>종류</label><select name="kind"><option value="feedback">피드백</option><option value="do">앞으로 할 것</option><option value="dont">앞으로 하지 말 것</option></select></div>
          <div><label>적용 범위</label><select name="scope"><option value="topic">비슷한 유형의 문제에 적용</option><option value="global">모든 문제에 항상 적용</option></select></div>
        </div>
        <label>내용</label><textarea name="fb" placeholder="예: STEP 1 연습인데 남는 물질이 B라고 문제에서 알려줘서 STEP 1을 안 거쳐도 풀립니다. 추론할 결론은 주지 마세요."></textarea>
        <label class="inline"><input type="checkbox" name="approve" checked> 바로 승인 — 다음 생성부터 적용</label>
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
          text, kind: $('[name=kind]', card).value, target: $('[name=target]', card).value, scope: $('[name=scope]', card).value,
          status: $('[name=approve]', card).checked ? 'approved' : 'pending', source: { jobId: job.id, itemIndex: item.index },
        });
      }
      if (andRegen) { await api('POST', `/api/jobs/${job.id}/items/${item.index}/regenerate`, { feedback: text }); wake(); }
      $('textarea[name=fb]', card).value = '';
      toast(andRegen ? '피드백을 저장하고 이 문제를 다시 만드는 중입니다.' : '피드백을 저장했습니다. ' + ($('[name=approve]', card).checked ? '다음 생성부터 적용됩니다.' : '지침 화면에서 승인하면 적용됩니다.'));
    };
    $('button[name=save]', card)?.addEventListener('click', guard(() => save(false)));
    $('button[name=regen]', card)?.addEventListener('click', guard(async (e) => { e.target.disabled = true; await save(true); }));
  }

  // ------------------------------------------------------------------ rules
  async function rulesView() {
    const [rules, promptsText] = await Promise.all([api('GET', '/api/rules'), api('GET', '/api/prompts')]);
    const group = (s) => rules.filter((r) => r.status === s);
    const row = (r) => `<div class="entry" data-rule="${r.id}" style="align-items:flex-start">
      <div style="flex:1"><div>${esc(r.text)}</div>
        <div class="muted small">[${KIND[r.kind]}·${TARGET[r.target]}·${r.scope === 'global' ? '항상' : '비슷한 유형'}] ${r.subject ? esc(r.subject) + ' · ' : ''}${fmtTime(r.createdAt)} · 적용된 세트 ${r.applied || 0}개
          ${r.source?.jobId ? ` · <a href="#/j/${r.source.jobId}">출처: ${esc(r.source.label || '생성 세트')}</a>` : ''}</div></div>
      <div class="row">${r.status !== 'approved' ? '<button class="small primary" data-act="approve">승인</button>' : '<button class="small" data-act="pending">보류</button>'}
        ${r.status !== 'rejected' ? '<button class="small" data-act="reject">반려</button>' : ''}<button class="small" data-act="edit">수정</button><button class="small danger" data-act="del">삭제</button></div></div>`;
    view.innerHTML = `<h1>지침·피드백</h1>
      <div class="panel"><h2>전체 생성 지침 추가</h2><p class="muted small">모든 문제 생성에 항상 붙습니다. 각 문제 결과의 '교사 지침 적용'에서 어떻게 지켰는지 확인할 수 있습니다.</p>
        <div class="cols cols-2"><div><label>종류</label><select id="nk"><option value="do">할 것</option><option value="dont">하지 말 것</option></select></div>
          <div><label>대상</label><select id="nt"><option value="all">전체</option><option value="problem">문제</option><option value="solution">해설</option><option value="design">설계</option></select></div></div>
        <label>내용</label><textarea id="ntext" placeholder="예: 원본 해설이 보조 문자를 쓰면 변형 해설에서도 같은 문자와 순서를 쓴다."></textarea>
        <div class="row" style="margin-top:8px"><span class="spacer"></span><button class="primary" id="add">추가</button></div></div>
      <div class="panel"><h2>승인 대기 (${group('pending').length})</h2><div class="list">${group('pending').map(row).join('') || '<span class="muted small">없음</span>'}</div></div>
      <div class="panel"><h2>적용 중 (${group('approved').length})</h2><div class="list">${group('approved').map(row).join('') || '<span class="muted small">없음</span>'}</div></div>
      <div class="panel"><details data-k="rej"><summary>반려됨 (${group('rejected').length})</summary><div class="inner list">${group('rejected').map(row).join('')}</div></details></div>
      <div class="panel"><details data-k="prompts"><summary>생성에 쓰는 기본 지시문 (읽기 전용)</summary><div class="inner">
        ${[['analyze', '원본 분석'], ['generate', '변형 문제 설계'], ['solve', '독립 풀이 검토'], ['repair', '검토 후 수정']].map(([k, t]) => `<h3>${t}</h3><pre class="values" style="max-height:340px">${esc(promptsText[k])}</pre>`).join('')}</div></details></div>`;
    $('#add').addEventListener('click', guard(async () => {
      await api('POST', '/api/rules', { text: $('#ntext').value, kind: $('#nk').value, target: $('#nt').value, scope: 'global' });
      toast('추가했습니다.'); rulesView();
    }));
    $$('[data-rule] [data-act]').forEach((b) => b.addEventListener('click', guard(async () => {
      const id = b.closest('[data-rule]').dataset.rule;
      const act = b.dataset.act;
      if (act === 'del') { if (!confirm('이 지침을 삭제할까요?')) return; await api('DELETE', '/api/rules/' + id); }
      else if (act === 'edit') {
        const rule = rules.find((r) => r.id === id);
        const text = prompt('지침 내용 수정', rule.text);
        if (text === null) return;
        await api('PUT', '/api/rules/' + id, { text });
      } else await api('PUT', '/api/rules/' + id, { status: { approve: 'approved', pending: 'pending', reject: 'rejected' }[act] });
      rulesView();
    })));
  }

  // ------------------------------------------------------------------ system
  async function systemView() {
    const [status, usage] = await Promise.all([api('GET', '/api/status'), api('GET', '/api/usage')]);
    view.innerHTML = `<h1>시스템</h1>
      <div class="panel"><h2>현재 상태</h2><div class="kv">
        <div class="k">버전</div><div>${esc(status.version)}</div>
        <div class="k">모델</div><div>${status.llm === 'mock' ? '<span class="chip warn">모의 모드 — 실제 모델을 호출하지 않음</span>' : Object.values(status.providers || {}).map((p) => `${esc(p.label)} ${p.available ? '<span class="chip ok">사용 가능</span>' : '<span class="chip">꺼짐</span>'} <span class="muted small">${esc(p.note || '')}</span>`).join('<br>')}</div>
        <div class="k">DeepSeek 잔액</div><div id="balance">확인 중…</div>
        <div class="k">진행 중 작업</div><div>${status.activeJobs}</div>
        <div class="k">최근 24시간</div><div>${tokens(usage.last24h)}</div>
        <div class="k">전체 누적</div><div>${tokens(usage.all)}</div></div></div>
      <div class="panel rich"><h2>v2는 이렇게 동작합니다</h2>
        <p><b>1. 원본 분석</b> — 문제·해설 이미지를 한 번에 읽어 인쇄된 문제와 필기를 분리하고, 교사 해설의 STEP 구분과 방법(보조 문자, 가정→모순, 비교 순서)을 그대로 정리합니다. STEP 개수는 원본에 따릅니다. 교사가 화면에서 직접 고칠 수 있고, 고친 내용이 생성 기준이 됩니다.</p>
        <p><b>2. 단계별 설계</b> — STEP 1, STEP 1~2, …, 최종 쌍둥이 순서로 한 문제씩 만듭니다. 뒤 문제를 만들 때는 앞에서 실제로 만든 문제 내용을 함께 넘겨, 통합 변형에서 그 아이디어를 엮게 합니다. 특정 유형용으로 고정한 코드 템플릿은 없습니다.</p>
        <p><b>3. 검증</b> — (a) 모델이 함께 쓴 검산 프로그램을 서버가 정확한 분수로 실행해 정답·선택지 중복·조건(가정의 모순 등)을 확인하고, (b) 정답을 모르는 별도 호출이 문제만 보고 다시 풀어 정답과 필요했던 STEP을 대조합니다. 어긋나면 수정은 한 번만 하고, 그래도 남으면 '교사 검토 필요'로 이유와 함께 보여 줍니다. 반복 재생성으로 토큰을 태우지 않습니다.</p>
        <p><b>4. 학습</b> — 문제별 피드백과 전체 지침은 승인되면 다음 생성의 지시문에 붙고, 결과마다 각 지침을 어떻게 지켰는지(생성 모델 자기 보고)와 독립 검토 판정이 표시됩니다. 모델 가중치를 학습시키는 방식(fine-tuning)은 아닙니다.</p>
        <p><b>5. 비용</b> — 작업마다 호출 수·토큰 상한이 있고, 넘기 전에 멈춥니다. 모든 호출의 토큰 사용량을 기록합니다.</p>
        <h3>한계</h3>
        <p class="bullet">• 그림이 꼭 필요한 문제는 그림을 글/표로 설명합니다. 그림 자동 생성은 아직 없습니다.</p>
        <p class="bullet">• ㄱㄴㄷ 선지형처럼 수치가 아닌 문제는 코드 검산 대상이 아니며 독립 풀이 대조에 의존합니다.</p>
        <p class="bullet">• 독립 풀이도 모델이므로 틀릴 수 있습니다. '검증 통과'는 교사 최종 승인과 같지 않습니다.</p></div>`;
    api('GET', '/api/balance').then((b) => { $('#balance').textContent = b.balance; }).catch(() => { $('#balance').textContent = '확인 실패'; });
  }

  // ------------------------------------------------------------------ boot
  (async () => {
    try {
      const status = await loadStatus();
      $('#model-state').textContent = status.llm === 'mock' ? '모의 모드' : '';
      if (!status.authenticated) return showLogin();
      $('#logout').hidden = false;
    } catch { /* shown per view */ }
    route();
  })();
})();
