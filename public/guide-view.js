'use strict';
// 설명 page: how to use EduMaster and how the system works — reading an original, making a set through the harness,
// learning and how it reaches the prompts (RAG), the models. Diagrams are inline SVG drawn from the page's tokens;
// the list of checks comes from /api/harness so it always matches the server. No counts of learned items.
(function () {
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const marker = (id) => `<defs><marker id="${id}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="gd-arrowhead"/></marker></defs>`;
  // A box with a title and up to two lines under it.
  const box = (x, y, w, h, title, lines = [], cls = '') => `<g class="gd-node ${cls}"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10"/>
    <text x="${x + w / 2}" y="${y + (lines.length ? 24 : h / 2 + 5)}" class="gd-t">${esc(title)}</text>
    ${lines.map((l, i) => `<text x="${x + w / 2}" y="${y + 44 + i * 17}" class="gd-s">${esc(l)}</text>`).join('')}</g>`;
  const line = (d, id, cls = '') => `<path d="${d}" class="gd-line ${cls}" marker-end="url(#${id})"/>`;
  const label = (x, y, t, cls = '') => `<text x="${x}" y="${y}" class="gd-l ${cls}">${esc(t)}</text>`;

  const USE = [
    ['문제 올리기', '문제 사진과 해설 사진을 올립니다. PDF에서 잘라 낸 이미지도 됩니다.', '문제 › 새 문제'],
    ['분석 확인', 'AI가 옮겨 적은 문제와 선생님 해설을 나눈 STEP을 확인하고, 틀린 곳은 바로 고칩니다. 고친 단어는 다음 분석부터 주의해서 읽습니다.', '문제 › ① 분석'],
    ['세트 만들기', '모델을 고르고 만들기를 누르면 STEP 1 연습부터 최종 문제까지 한 세트를 만듭니다. 만드는 동안 하네스가 검사하고 스스로 고칩니다.', '문제 › ② 문제 생성'],
    ['결과 보기', '세트마다 문제·해설·검사 리포트가 있습니다. 좋은 문제는 채택해 본보기로, 아쉬운 점은 고칠 점으로 남깁니다.', '문제 › ③ 문제 리스트'],
    ['학습 관리', '고칠 점과 세트에서 자동으로 배운 것이 학습으로 쌓입니다. 학습 지도에서 고치고, 끄고, 겹치는 것을 합칩니다.', '학습 › 학습 지도'],
  ];

  function usage() {
    return `<ol class="gd-use">${USE.map(([t, d, where], i) => `<li><span class="gd-no">${i + 1}</span><b>${t}</b><p>${d}</p><small>${where}</small></li>`).join('')}</ol>`;
  }

  // Browser → server → job queue → pipeline → models; the data the pipeline reads and writes.
  function architecture() {
    const id = 'gd-a1';
    return `<svg viewBox="0 0 900 330" class="gd-svg" role="img" aria-label="시스템 구조">${marker(id)}
      ${box(20, 120, 150, 80, '브라우저', ['선생님 화면', '(이 사이트)'])}
      ${box(220, 120, 160, 80, '웹 서버', ['로그인 · API', '작업 접수'])}
      ${box(430, 40, 200, 80, '작업 큐', ['분석 작업 · 세트 작업', '한 번에 하나씩 차례로'], 'accent')}
      ${box(430, 200, 200, 90, '파이프라인', ['분석 → 생성 → 검사', '→ 고치기 → 리포트'], 'accent')}
      ${box(690, 20, 190, 120, 'AI 모델', ['DeepSeek · Claude 구독', 'Gemini 구독 · GPT 구독', 'PC 로컬 모델'])}
      ${box(690, 190, 190, 120, '저장소', ['원본 · 세트 · 이미지', '학습 · 읽기 교정', '사용량 · 한도'])}
      ${line('M170,160 L215,160', id)}${line('M380,145 L425,95', id)}${line('M530,120 L530,195', id)}
      ${line('M630,225 L685,110', id)}${line('M630,255 L685,250', id, 'dash')}${line('M425,255 Q395,250 383,185', id, 'dash')}
      ${label(512, 165, '차례가 오면')}${label(660, 160, '호출')}${label(655, 282, '읽기·쓰기')}${label(370, 245, '진행 상황')}
    </svg>`;
  }

  // Reading an original: one read, then checks that re-read and fix before the teacher sees it.
  const ANALYSIS = [
    ['판독', '이미지 → 문제·해설·STEP'],
    ['원본 대조 교정', '글자 단위로 다시 대조'],
    ['필기 유입 재판독', '해설 값이 문제에 섞이면'],
    ['발문 재판독 ×2', '두 번 같으면 고침'],
    ['해설 제목 재판독 ×2', 'STEP 수와 제목'],
    ['STEP 수 맞추기', '단계 수보다 많으면 합침'],
    ['원본 정답 검산', '코드로 정확한 분수 계산'],
  ];
  function analysisFlow() {
    const id = 'gd-a2';
    // Two rows of four, left to right: the last of the first row leads down to the first of the second.
    const w = 190, gap = 32, x0 = 30, rows = [20, 150];
    const steps = [...ANALYSIS, ['분석 결과', '선생님이 확인·수정']];
    const at = (i) => [x0 + (i % 4) * (w + gap), rows[Math.floor(i / 4)]];
    const boxes = steps.map(([t, s], i) => { const [x, y] = at(i); return box(x, y, w, 72, t, [s], i === 0 ? 'accent' : i === steps.length - 1 ? 'ok' : ''); }).join('');
    const arrows = steps.slice(1).map((_, k) => {
      const i = k + 1, [x, y] = at(i), [px, py] = at(i - 1);
      return i % 4 ? line(`M${px + w},${y + 36} L${x - 4},${y + 36}`, id) : line(`M${px + w / 2},${py + 72} L${px + w / 2},${py + 101} L${x + w / 2},${py + 101} L${x + w / 2},${y - 4}`, id);
    }).join('');
    const [lx, ly] = at(steps.length - 1);
    return `<svg viewBox="0 0 900 290" class="gd-svg" role="img" aria-label="원본 분석 순서">${marker(id)}${boxes}${arrows}
      ${line(`M${lx + w / 2},${ly + 72} L${lx + w / 2},${ly + 106} L${x0 - 14},${ly + 106} L${x0 - 14},56 L${x0 - 4},56`, id, 'dash')}
      ${label(x0 + 4, ly + 126, '선생님이 고친 단어는 읽기 교정으로 쌓여 다음 판독부터 주의할 단어로 들어갑니다', 'start')}
    </svg>`;
  }

  // A set climbs the teacher's STEPs: each practice problem uses STEP 1..k only, the final uses all of them in a new structure.
  function staircase() {
    const rows = [['STEP 1 연습', 1], ['STEP 1~2 연습', 2], ['최종 문제', 3]];
    const x0 = 140, cw = 220, rh = 46, y0 = 40;
    const cols = ['STEP 1', 'STEP 2', 'STEP 3'].map((t, i) => `<text x="${x0 + i * cw + cw / 2}" y="26" class="gd-axis">${t}</text>`).join('');
    const grid = [0, 1, 2, 3].map((i) => `<line x1="${x0 + i * cw}" y1="34" x2="${x0 + i * cw}" y2="${y0 + rows.length * rh + 4}" class="gd-grid"/>`).join('');
    const bars = rows.map(([t, k], r) => `<text x="${x0 - 12}" y="${y0 + r * rh + 27}" class="gd-axis end">${t}</text>
      <rect x="${x0 + 4}" y="${y0 + r * rh + 8}" width="${k * cw - 8}" height="${rh - 16}" rx="6" class="gd-bar${k === 3 ? ' final' : ''}"/>
      <text x="${x0 + k * cw - 14}" y="${y0 + r * rh + 28}" class="gd-bar-t">${k === 3 ? '모든 STEP · 원본과 다른 구조' : `STEP ${k === 1 ? '1' : '1~2'}만으로 풀림`}</text>`).join('');
    return `<svg viewBox="0 0 820 222" class="gd-svg" role="img" aria-label="세트의 STEP 범위">${cols}${grid}${bars}
      <text x="${x0}" y="${y0 + rows.length * rh + 26}" class="gd-note">원본 해설이 STEP 3개일 때. 연습 문제에 뒤 STEP의 기법·값이 필요하거나, 기법 없이 풀리면 실패로 봅니다.</text></svg>`;
  }

  // One problem through the harness: design, check, fix (solution only, or the problem), redesign, finish.
  function harnessLoop() {
    const id = 'gd-a3';
    return `<svg viewBox="0 0 900 390" class="gd-svg" role="img" aria-label="하네스 순서">${marker(id)}
      ${box(30, 20, 160, 64, '새로 설계', ['남은 점을 알려 주고 처음부터'], 'warn')}
      ${box(30, 150, 160, 80, '설계', ['지침·학습·본보기를 넣어', '문제·해설·검산 코드'], 'accent')}
      ${box(250, 150, 170, 80, '검사', ['코드 검산 · 독립 풀이', '해설 대조 · 코드 점검'])}
      ${box(480, 20, 180, 64, '해설만 다시 쓰기', ['문제는 그대로'], 'warn')}
      ${box(480, 296, 180, 64, '문제 수정', ['결함을 알려 주고 고침'], 'warn')}
      ${box(700, 140, 180, 100, '마무리', ['결함이 가장 적은 설계', '문제별 리포트', '세트 끝: 자동 학습'], 'ok')}
      ${line('M190,190 L245,190', id)}${line('M420,190 L695,190', id, 'ok')}${label(560, 180, '통과', 'ok')}
      ${line('M380,150 L380,52 L475,52', id)}${label(428, 44, '해설만 다름')}
      ${line('M570,84 L570,120 L405,120 L405,146', id, 'dash')}${label(500, 112, '다시 검사')}
      ${line('M380,230 L380,328 L475,328', id)}${label(428, 320, '문제에 결함')}
      ${line('M570,296 L570,262 L405,262 L405,234', id, 'dash')}${label(500, 278, '다시 검사')}
      ${line('M290,150 L290,52 L195,52', id)}${label(242, 44, '고쳐도 남으면')}
      ${line('M110,84 L110,146', id)}
      ${label(30, 382, '횟수는 학습 › 하네스에서 정합니다 (기본: 해설 다시 쓰기 2번 · 문제 수정 2번 · 설계 3번)', 'start')}
    </svg>`;
  }

  // What one call carries, in the order the learning is picked; the cap drops the last ones first.
  function promptStack() {
    const parts = [['페르소나', 0.09, 'p0'], ['지침', 0.17, 'p1'], ['이 문제의 학습', 0.17, 'p2'], ['공통 학습', 0.25, 'p3'], ['본보기', 0.12, 'p4'], ['원본 · 요청', 0.2, 'p5']];
    let x = 20;
    const W = 820;
    const segs = parts.map(([t, f, c]) => { const w = f * W; const s = `<rect x="${x}" y="50" width="${w - 3}" height="46" rx="6" class="gd-seg ${c}"/><text x="${x + w / 2}" y="78" class="gd-seg-t">${t}</text>`; x += w; return s; }).join('');
    const capX = 20 + (0.09 + 0.17 + 0.17 + 0.25) * W - 2;
    return `<svg viewBox="0 0 860 170" class="gd-svg" role="img" aria-label="한 번의 호출에 들어가는 것">
      <text x="20" y="34" class="gd-axis start">한 번의 AI 호출에 붙는 것 (왼쪽부터 먼저 고름)</text>${segs}
      <line x1="${capX}" y1="40" x2="${capX}" y2="112" class="gd-cap"/><text x="${capX}" y="130" class="gd-axis">학습 한도</text>
      <text x="20" y="156" class="gd-note">학습은 생성에서 24개 · 6,000자, 분석에서 30개 · 8,000자까지 넣습니다. 넘치면 뒤쪽(공통 학습)부터 빠집니다.</text></svg>`;
  }

  // The learning cycle: taught or learned → kept → picked into a call → judged on the result → reported → learned again.
  function learningCycle() {
    const id = 'gd-a4';
    const cx = 450, cy = 190, r = 140;
    const nodes = [
      ['가르치기', '직접 입력 · 고칠 점 · 분석 수정'],
      ['학습 저장소', '지침 · 문제별 · 공통 · 읽기 교정'],
      ['고르기', '우선순위 + 한도 (검색)'],
      ['AI 호출', '프롬프트에 붙여 분석·생성'],
      ['지킴 판정', '독립 풀이·해설 검토가 판정'],
      ['세트 리포트 · 자동 학습', '나온 실수를 최대 3개로 정리'],
    ];
    // Nodes sit on an ellipse; each arrow follows the ellipse from one box's edge to the next box's edge.
    const RX = r * 1.75, RY = r, n = nodes.length;
    const angle = (i) => -Math.PI / 2 + (i * 2 * Math.PI) / n;
    const pos = nodes.map((_, i) => [cx + RX * Math.cos(angle(i)), cy + RY * Math.sin(angle(i))]);
    const inBox = ([x, y]) => pos.some(([bx, by]) => Math.abs(x - bx) < 113 && Math.abs(y - by) < 40);
    const arcs = nodes.map((_, i) => {
      const pts = [];
      for (let k = 0; k <= 60; k++) { const a = angle(i) + (k / 60) * (2 * Math.PI / n); const p = [cx + RX * Math.cos(a), cy + RY * Math.sin(a)]; if (!inBox(p)) pts.push(p); }
      return pts.length > 1 ? line('M' + pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' L'), id) : '';
    }).join('');
    const boxes = nodes.map(([t, s], i) => box(pos[i][0] - 105, pos[i][1] - 32, 210, 64, t, [s], i === 1 ? 'accent' : i === 4 ? 'ok' : '')).join('');
    return `<svg viewBox="0 0 900 390" class="gd-svg" role="img" aria-label="학습이 도는 방식">${marker(id)}${arcs}${boxes}
      <text x="${cx}" y="${cy - 6}" class="gd-t">학습 순환</text><text x="${cx}" y="${cy + 16}" class="gd-s">정리 후보: 겹치는 학습은 AI가 찾아 합치기를 제안</text></svg>`;
  }

  const RAG = [
    ['무엇을 찾나', '문서 조각', '선생님이 가르친 항목 한 줄 한 줄 (지침·학습·읽기 교정·채택한 본보기)'],
    ['어떻게 고르나', '질문과 비슷한 조각을 임베딩 유사도로 검색', '규칙으로 고름: 지침 → 이 문제의 학습 → 공통 학습 순서로, 한도 안에서 빠짐없이. 검색 오차로 필요한 지침이 빠지지 않음'],
    ['무엇이 바뀌나', '모델 가중치는 그대로, 프롬프트만', '같음 — 모델을 다시 학습시키지 않습니다 (파인튜닝 아님)'],
    ['효과 확인', '보통 없음', '항목마다 세트에서 지켰는지 판정해 지킴·어김으로 기록하고, 자주 어긴 학습을 드러냄'],
    ['쌓이는 방식', '문서를 넣으면 늘어남', '세트가 끝날 때 실수에서 자동으로 배우고, 겹치는 항목은 합쳐서 줄임'],
  ];

  function checksTable(h) {
    if (!h) return '<p class="muted">검사 목록을 불러오지 못했습니다.</p>';
    const groups = ['answer', 'repair', 'rewrite'].map((k) => [k, h.checks.generation.filter((c) => c.onFail === k)]);
    return `<div class="gd-checks">${groups.map(([k, list]) => `<section class="gd-check-col ${k}"><h4>${esc(h.onFail[k])}</h4>
      <ul>${list.map((c) => `<li><b>${esc(c.label)}</b><span>${esc(c.how)}</span></li>`).join('')}</ul></section>`).join('')}</div>`;
  }

  const MODELS = [
    ['DeepSeek V4 Flash', 'API (유료, 빠름)', '분석·생성 기본 모델. 이미지 판독과 문제 생성 모두.'],
    ['Claude Opus (구독)', '선생님 Claude 구독, 서버의 Claude Code', '분석·생성. 검수 스킬의 검토 모델.'],
    ['Gemini (구독)', '선생님 Google 계정, 서버의 agy', '분석·생성. 검수 스킬의 두 번째 검토 모델.'],
    ['GPT (구독)', '선생님 ChatGPT 계정, 서버의 codex', '분석·생성.'],
    ['PC 로컬 모델', '선생님 PC의 Qwen (터널로 연결)', 'PC가 켜져 있을 때만. 비용 없음.'],
  ];

  function html() {
    return `<div class="gd">
      <div class="lt-title"><h1>설명</h1><p class="lt-meta">EduMaster는 선생님의 문제와 해설로, 해설의 STEP을 하나씩 연습시키는 단계별 변형 문제 세트를 만듭니다. 사용법과 시스템이 돌아가는 방식입니다.</p></div>
      <nav class="gd-toc">${[['use', '사용법'], ['arch', '전체 구조'], ['analysis', '원본 분석'], ['generate', '문제 생성'], ['learn', '학습과 RAG'], ['models', '모델']].map(([k, t]) => `<a href="#/guide" data-jump="gd-${k}">${t}</a>`).join('')}</nav>

      <section class="gd-sec" id="gd-use"><h2>사용법</h2>${usage()}</section>

      <section class="gd-sec" id="gd-arch"><h2>전체 구조</h2>
        <p>화면에서 맡긴 일은 서버의 작업 큐에 들어가 차례로 실행됩니다. 창을 닫아도 서버에서 계속되고, 진행 상황은 다시 열면 이어서 보입니다.</p>
        <div class="gd-fig">${architecture()}</div></section>

      <section class="gd-sec" id="gd-analysis"><h2>원본 분석</h2>
        <p>사진을 한 번 읽고 끝내지 않습니다. 잘 틀리는 곳(필기가 조건에 섞임, 몰질량↔물질량 같은 오독, STEP 제목과 수)을 따로 다시 읽어 맞춘 뒤, 옮겨 적은 수치로 원본 정답이 다시 나오는지 코드로 계산합니다.</p>
        <div class="gd-fig gd-scroll">${analysisFlow()}</div>
        <p class="gd-small">STEP은 선생님 해설에 인쇄된 step 표시를 따릅니다. 선생님이 분석 학습으로 STEP 수나 나누는 방식을 정하면 그것이 우선합니다.</p></section>

      <section class="gd-sec" id="gd-generate"><h2>문제 생성</h2>
        <h3>세트는 STEP을 한 계단씩 올라갑니다</h3>
        <div class="gd-fig">${staircase()}</div>
        <h3>문제 하나를 만드는 순서 (하네스)</h3>
        <p>AI가 만든 문제를 서버가 검사하고 스스로 고칩니다. 끝까지 고쳐지지 않으면 결함이 가장 적은 설계를 남기고, 남은 점은 리포트에 적습니다. 선생님에게 넘기는 것은 정답을 확정하지 못한 문제뿐입니다.</p>
        <div class="gd-fig gd-scroll">${harnessLoop()}</div>
        <h3>검사와 걸렸을 때 하는 일</h3>
        <div id="gd-checks"><p class="muted">불러오는 중…</p></div></section>

      <section class="gd-sec" id="gd-learn"><h2>학습과 RAG</h2>
        <p>학습은 모델을 다시 훈련시키는 것이 아니라, 필요한 항목을 골라 AI 호출의 프롬프트에 붙이는 방식입니다(검색 증강, RAG). 부딪히면 <b>지침 → 이 문제의 학습 → 공통 학습</b> 순서로 따릅니다.</p>
        <div class="gd-layers">
          <div><b>지침</b><span>반드시 지킬 것. 모든 문제에 가장 먼저 들어갑니다.</span></div>
          <div><b>문제별 학습</b><span>한 원본에만. 그 문제를 다시 분석하거나 세트를 만들 때.</span></div>
          <div><b>공통 학습</b><span>여러 문제에 통하는 교훈. 분석 교훈과 생성 교훈(문제·해설·둘 다).</span></div>
          <div><b>읽기 교정</b><span>잘못 읽었다가 고친 단어. 다음 판독에서 주의할 단어로 들어갑니다.</span></div>
          <div><b>본보기</b><span>채택한 문제. 같은 원본의 같은 단계를 만들 때 예시로 들어갑니다.</span></div>
        </div>
        <div class="gd-fig gd-scroll">${learningCycle()}</div>
        <div class="gd-fig gd-scroll">${promptStack()}</div>
        <h3>일반 RAG와 다른 점</h3>
        <div class="gd-table"><table><thead><tr><th></th><th>일반 RAG</th><th>EduMaster 학습</th></tr></thead>
          <tbody>${RAG.map(([k, a, b]) => `<tr><th>${k}</th><td>${a}</td><td>${b}</td></tr>`).join('')}</tbody></table></div></section>

      <section class="gd-sec" id="gd-models"><h2>모델</h2>
        <p>분석과 세트마다 모델을 고를 수 있습니다. 구독 모델은 선생님 계정의 한도를 쓰며, 남은 한도는 LLM 탭에 보입니다. 세트 리포트에는 그 세트가 쓴 한도가 적힙니다.</p>
        <div class="gd-table"><table><thead><tr><th>모델</th><th>연결</th><th>쓰임</th></tr></thead>
          <tbody>${MODELS.map(([a, b, c]) => `<tr><th>${a}</th><td>${b}</td><td>${c}</td></tr>`).join('')}</tbody></table></div></section>
    </div>`;
  }

  async function mount(view, api) {
    view.innerHTML = html();
    view.querySelectorAll('[data-jump]').forEach((a) => a.addEventListener('click', (e) => {
      e.preventDefault();
      document.getElementById(a.dataset.jump)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }));
    let h = null;
    try { h = await api('GET', '/api/harness'); } catch { h = null; }
    const box = document.getElementById('gd-checks');
    if (box) box.innerHTML = checksTable(h);
  }

  window.EMGuide = { mount, html };
})();
