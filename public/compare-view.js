'use strict';
// The 모델 비교 page body, shared by the app (#/compare, after login) and the public page (compare.html, no login).
(function () {
  const esc = window.EM.escape;

  // One comparison of the models: a problem-level quality score with its 95% range, the items behind it, what one
  // problem costs, how long a set takes and when each can be used.
  // ids: the models shown, in this order; names: a name for this view (Opus alone is 'Opus 5.5 단독' beside the mix).
  function overviewHtml(sys, { balance = false, ids = null, names = {}, costs = true, cards: withCards = true } = {}) {
    const P = sys.pricing; const cmp = sys.compare;
    const krw = (usd) => `${(Math.round((usd * P.krwPerUsd) / 10) * 10).toLocaleString()}원`;
    const pct = (s) => (s && s.total ? Math.round((s.pass / s.total) * 100) : null);
    const MODELS = [
      { id: 'claude-cli', name: 'Claude Opus 5.5', claude: true, use: '선생님 Claude 구독으로 (추가 비용 없이 주간 한도 안에서)' },
      { id: 'opus-haiku', name: 'Claude Opus 5.5 + Haiku 5.5', claude: true, use: '선생님 Claude 구독으로 — Haiku가 문제를 설계하고 Opus가 독립 풀이·검토·학습' },
      { id: 'opus-qwen', name: 'Claude Opus 5.5 + Qwen 3.6 (PC)', claude: true, use: '선생님 Claude 구독 + PC — (이 원본 전용 코드 포함, 일반 성능 아님) 서버가 수치·정답·해설을 선생님 해설 틀로 계산하고 PC의 Qwen이 문제를 쓰며, Opus가 원본 이해·독립 풀이·검토·학습 (PC가 켜져 있을 때만)' },
      { id: 'opus-qwen-sys', name: 'Claude Opus 5.5 + Qwen 3.8 (PC) + 시스템', claude: true, use: '선생님 Claude 구독 + PC (PC가 켜져 있을 때만) — 역할은 아래 표' },
      { id: 'deepseek', name: 'DeepSeek V4 Flash', use: '언제든 사용 (인터넷, 쓴 만큼 유료)' },
      { id: 'qwen38q4', name: 'Qwen 3.8-27B (PC) · 학습됨 + 시스템', free: true, trained: '몰질량 원본에서 쌓은 학습(교사 지침 114개, 판독 교정 4개)을 받아 만듦', use: '선생님 PC가 켜져 있을 때만 (지금 쓰는 PC 모델) — 만들기는 학습된 Qwen 혼자, 점수는 Opus가 다시 판정한 것' },
    ].filter((m) => cmp.models[m.id] && (!ids || ids.includes(m.id))).map((m) => ({ ...m, name: names[m.id] || m.name }));
    if (!MODELS.length) return '<p class="muted small">아직 평가 결과가 없습니다. 평가를 돌리면 모델별 비교가 표시됩니다.</p>';
    const quality = (m) => cmp.models[m.id].score ?? 0;
    // Highest problem-quality score first (the user, 2026-10-14).
    MODELS.sort((x, y) => quality(y) - quality(x));
    const best = Math.max(...MODELS.map(quality));
    const tag = (m) => [quality(m) === best ? '<span class="chip ok">문제 품질 1위</span>' : '', m.trained ? `<span class="chip run" title="${m.trained}">학습됨</span>` : '', m.free ? '<span class="chip ok">무료</span>' : m.claude ? '<span class="chip run">구독</span>' : '<span class="chip run">유료</span>'].join(' ');
    // Every model measured the same way: the tokens its own runs used and their list price. The subscription costs
    // nothing extra, so its list price is shown as the share of the weekly limit it fills.
    const tokens = (n) => (n == null ? '-' : n >= 1e4 ? `약 ${Math.round(n / 1e4)}만 토큰` : `약 ${Math.round(n).toLocaleString()} 토큰`);
    // Claude too at its API list price, like DeepSeek; what the subscription makes of it is at the end of the page.
    const money = (m, usd) => (m.free ? '0원' : usd == null ? '-' : `약 ${krw(usd)}`);
    const moneyNote = (m, usd, range) => (m.claude ? 'Claude API 정가' : !m.free && range && krw(range[0]) !== krw(range[1]) ? `${krw(range[0])} ~ ${krw(range[1])}` : '');
    const costOf = (m) => money(m, cmp.models[m.id].cost?.problemUsd);
    const tone = (v) => (v == null ? '' : v >= 90 ? 'ok' : v >= 60 ? 'warn' : 'bad');
    const cell = (s) => {
      const v = pct(s);
      if (v == null) return '<td class="muted small">해당 없음</td>';
      return `<td><div class="cmp-cell"><div class="meter"><span style="width:${v}%" class="${tone(v)}"></span></div><b>${v}%</b></div><div class="muted tiny">${s.pass}/${s.total}${s.reviewed ? " · 직접 비교해 판정" : ""}</div></td>`;
    };
    const cards = MODELS.map((m) => {
      const q = cmp.models[m.id];
      const v = quality(m);
      return `<div class="sys-card cmp-card">
        <div class="model-head"><b>${m.name}</b></div>
        <div class="cmp-tags">${tag(m)}</div>
        <div class="cmp-score"><span class="cmp-big ${tone(v)}">${v}</span><span class="cmp-unit">점</span><span class="muted small">문제 품질 점수</span></div>
        <div class="cmp-range"><div class="cmp-band"><span style="left:${q.low}%;width:${Math.max(1, q.high - q.low)}%"></span><i style="left:${v}%"></i></div><span class="muted tiny">믿을 수 있는 범위 ${q.low}~${q.high}점 · ${q.problems}문제(${q.runs}회) 평가 · ${q.olderReview ? '이전 검토 기준' : '현재 검토 기준'}</span></div>
        <div class="cmp-facts">
          <div><span>바로 쓸 수 있는 문제</span><b>${q.metrics.clear.pass}/${q.metrics.clear.total}</b></div>
          <div><span>끝까지 만든 문제</span><b>${q.metrics.made.pass}/${q.metrics.made.total}</b></div>
          <div><span>원본 읽기 정확도</span><b>${pct(q.read)}%</b></div>
          <div><span>연습 문제 1개 토큰</span><b>${tokens(q.cost?.problemTokens)}</b></div>
          <div><span>연습 문제 1개 비용</span><b>${costOf(m)}</b></div>
          <div><span>연습 문제 1개 생성</span><b>${q.time?.perProblem != null ? `약 ${q.time.perProblem}분` : '-'}</b></div>
          <div><span>3문제 세트 (분석 포함)</span><b>약 ${q.minutes}분</b></div>
          <div><span>사용 조건</span><b class="small">${m.use}</b></div>
        </div></div>`;
    }).join('');
    const scoreRow = `<tr class="cmp-total"><th>문제 품질 점수<div class="muted tiny">아래 항목의 가중 평균, 못 만든 문제는 0점</div></th>${MODELS.map((m) => { const q = cmp.models[m.id]; return `<td><b class="cmp-pct ${tone(q.score)}">${q.score}점</b><div class="muted tiny">범위 ${q.low}~${q.high} · ${q.problems}문제</div></td>`; }).join('')}</tr>`;
    const rows = cmp.metrics.map((x) => `<tr><th>${x.label}${x.weight ? `<div class="muted tiny">가중치 ${x.weight}</div>` : ''}</th>${MODELS.map((m) => cell(cmp.models[m.id].metrics[x.id])).join('')}</tr>`).join('');
    const costCell = (m, usd, range) => { const note = moneyNote(m, usd, range); return `<td><b>${money(m, usd)}</b>${note ? `<div class="muted tiny">${note}</div>` : ''}</td>`; };
    const costRows = [
      `<tr><th>연습 문제 1개 토큰<div class="muted tiny">원본 분석 몫 포함</div></th>${MODELS.map((m) => `<td><b>${tokens(cmp.models[m.id].cost?.problemTokens)}</b></td>`).join('')}</tr>`,
      `<tr><th>연습 문제 1개 비용</th>${MODELS.map((m) => { const k = cmp.models[m.id].cost || {}; return costCell(m, k.problemUsd, k.problemUsdRange); }).join('')}</tr>`,
      `<tr><th>3문제 세트 토큰<div class="muted tiny">원본 분석 포함</div></th>${MODELS.map((m) => `<td><b>${tokens(cmp.models[m.id].cost?.setTokens)}</b></td>`).join('')}</tr>`,
      `<tr><th>3문제 세트 비용<div class="muted tiny">원본 분석 포함</div></th>${MODELS.map((m) => costCell(m, cmp.models[m.id].cost?.setUsd)).join('')}</tr>`,
    ].join('');
    const mins = (v) => (v == null ? '<td class="muted small">-</td>' : `<td><b>${v}분</b></td>`);
    const timeRow = (label, note, get) => `<tr><th>${label}${note ? `<div class="muted tiny">${note}</div>` : ''}</th>${MODELS.map((m) => mins(get(cmp.models[m.id].time || {}))).join('')}</tr>`;
    const timeRows = [
      timeRow('원본 읽기·분석', '사진 판독과 STEP 정리', (t) => t.analysis),
      timeRow('연습 문제 1개 만들기', '설계 + 독립 검토 + 자동 수정, 못 만든 문제 포함', (t) => t.perProblem),
      timeRow('· STEP 1 연습', '', (t) => t.stages?.s1),
      timeRow('· STEP 1~2 연습', '', (t) => t.stages?.s12),
      timeRow('· 최종 문제', '', (t) => t.stages?.final),
      `<tr><th>문제당 자동 수정 횟수</th>${MODELS.map((m) => { const r = cmp.models[m.id].time?.repairs; return r == null ? '<td class="muted small">-</td>' : `<td><b>${r}회</b></td>`; }).join('')}</tr>`,
      `<tr><th>3문제 세트 전체<div class="muted tiny">원본 분석 포함</div></th>${MODELS.map((m) => mins(cmp.models[m.id].minutes)).join('')}</tr>`,
    ].join('');
    const when = MODELS.map((m) => cmp.models[m.id].when.slice(0, 8)).sort().pop();
    return `${withCards ? `<p class="swipe-hint mobile-only">카드를 옆으로 넘기면 다른 모델을 볼 수 있습니다.</p>
      <div class="sys-cards cmp-cards">${cards}</div>` : ''}
      <p class="swipe-hint mobile-only">표는 옆으로 밀어서 모델별로 볼 수 있습니다.</p>
      <div class="table-wrap"><table class="cmp-table">
        <tr><th></th>${MODELS.map((m) => `<th>${m.name}</th>`).join('')}</tr>
        <tr class="grp"><td colspan="${MODELS.length + 1}"><span class="grp-label">문제를 얼마나 잘 만드나 (만들려고 한 문제 하나하나를 기준으로)</span></td></tr>
        ${scoreRow}${rows}
        <tr class="grp"><td colspan="${MODELS.length + 1}"><span class="grp-label">시간 (평가 회차 평균)</span></td></tr>
        ${timeRows}
        ${costs ? `<tr class="grp"><td colspan="${MODELS.length + 1}"><span class="grp-label">비용</span></td></tr>` : ''}
        ${costs ? costRows : ''}
      </table></div>
      <details class="cmp-note"><summary class="small">점수·시간·토큰·비용을 잰 방법</summary>
      <p class="muted small">화학 몰질량 문제를 모델만 바꿔 똑같은 과정으로 만들고, 자동 검토 결과를 문제 하나하나 채점한 것입니다 (${when.slice(0, 4)}.${when.slice(4, 6)}.${when.slice(6, 8)} 기준). <b>문제 품질 점수</b>는 문제마다 항목별 가중치(정답·계산 30, STEP 범위 15, 풀이 방법 15, 조건 10, 지침 10, 바로 사용 10, 최종 문제의 새 구조 10)로 채점해 평균한 값이고, 만들지 못한 문제는 0점으로 셉니다. 같은 모델도 돌릴 때마다 결과가 달라서 여러 번 평가한 모델은 모든 회차를 합쳤습니다. <b>믿을 수 있는 범위</b>는 평가한 문제 수로 본 95% 신뢰 구간(윌슨 구간)입니다. 문제가 적으면 넓어지므로, 범위가 겹치는 모델끼리는 차이가 확실하지 않습니다. 최종 문제의 새 구조는 한 번만 평가한 모델이면 직접 비교한 판정을 씁니다. 자동 검토는 2026-09-30에 강화되었습니다(건너뛸 수 있는 STEP, 숫자만 바꾼 최종 문제, 선생님 STEP 제목, 표에 드러난 남은 물질까지 확인). '현재 검토 기준' 모델은 그 뒤의 평가만, '이전 검토 기준' 모델은 그 전 평가로 채점해 이전 모델의 점수가 실제보다 후할 수 있습니다.
      <b>시간</b>은 작업 기록의 시각으로 잰 것으로, 문제 하나의 시간은 설계부터 독립 검토·자동 수정을 거쳐 판정이 나올 때까지입니다. Claude는 서버의 Claude 구독(Claude Code), DeepSeek은 인터넷 API, Qwen·Gemma는 선생님 PC(RTX 5080)에서 잰 시간입니다.
      <b>토큰</b>은 평가에서 실제로 쓴 양으로, 원본 분석과 문제 3개의 설계·독립 풀이·검토·자동 수정을 모두 더한 것입니다. <b>비용</b>은 호출마다 그 모델의 공개 정가(DeepSeek V4 Flash는 시간대별 단가, Claude Opus 5.5는 입력 $4·출력 $20, Claude Haiku 5.5는 입력 $0.10·출력 $0.50 / 100만 토큰)로 계산해 1달러 = ${P.krwPerUsd.toLocaleString()}원으로 바꾼 것입니다. Claude도 API로 쓸 때의 정가로 표시했고, 선생님 Claude 구독으로 쓸 때의 값은 바로 아래에 있습니다. Qwen·Gemma는 선생님 PC에서 돌아 비용이 없습니다.${balance ? ' DeepSeek 충전 잔액: <span id="balance">확인 중…</span>' : ''}</p></details>`;
  }

  // Claude's cost two ways: at the API's list price, and on the Claude Max subscription (its monthly fee spread over
  // the weekly limit it buys, the limit filling by list price: ≈$5 per 1%).
  function claudeMoney(P) {
    const won = (krw) => `${(Math.round(krw / 10) * 10).toLocaleString()}원`;
    const api = (usd) => usd * P.krwPerUsd;
    const weekly = (usd) => usd / P.usdPerWeeklyPercent; // % of the weekly limit
    // One percent of the weekly limit is a hundredth of a week's share of the monthly fee.
    const max = (usd) => (weekly(usd) / 100) * (P.maxUsdPerMonth / (365 / 12 / 7)) * P.krwPerUsd;
    const cut = (x, y) => Math.round((1 - y / x) * 100);
    return { won, api, weekly, max, cut };
  }
  // A problem (3 practice problems with solutions) from a new original, and one more from the same original: the
  // reading of the original is done once and reused, so a further problem costs the other stages only.
  const readUsd = (q) => Object.values(q.cost.setByStage?.read || {}).reduce((x, v) => x + v.usd, 0);
  const firstAndMore = (q) => [q.cost.setUsd, q.cost.setUsd - readUsd(q)];
  const CLAUDE_LABEL = { 'claude-cli': 'Claude Opus 5.5 단독', 'opus-haiku': 'Claude Opus 5.5 + Haiku 5.5', 'opus-qwen': 'Claude Opus 5.5 + Qwen 3.6 (PC)', 'opus-qwen-sys': 'Claude Opus 5.5 + Qwen 3.8 (PC) + 시스템' };

  // The mixes shown against Opus alone: who designs (and repairs) while Opus solves, reviews, writes and learns.
  const MIXES = [
    { id: 'opus-haiku', name: 'Opus 5.5 + Haiku 5.5', helper: 'Haiku', note: 'Haiku 5.5가 설계·수정 (Claude, 정가 Opus의 40분의 1)' },
    { id: 'opus-qwen-sys', name: 'Opus 5.5 + Qwen 3.8 (PC) + 시스템', helper: 'Qwen', note: 'Qwen 3.8-27B가 선생님 PC에서 설계·해설 쓰기·고치기, 계산과 문장 틀 대조는 서버 코드 (0원)' },
  ];
  const helperOf = (m) => (/haiku/.test(m) ? 'Haiku' : m === 'local' ? 'Qwen' : 'Opus');

  // What each mix saves against Opus alone, all at the Claude API's list price, on the same runs as the table above.
  function savingsHtml(sys) {
    const P = sys.pricing; const a = sys.compare.models['claude-cli'];
    const mixes = MIXES.filter((x) => sys.compare.models[x.id]?.cost?.setUsd).map((x) => ({ ...x, q: sys.compare.models[x.id] }));
    if (!a?.cost?.setUsd || !mixes.length) return '';
    const { won, api, cut } = claudeMoney(P);
    const tok = (n) => `${Math.round(n / 1e4)}만`;
    const hundred = (q) => readUsd(q) + 100 * firstAndMore(q)[1];
    const byHelper = (q) => {
      const out = {};
      for (const [m, v] of Object.entries(q.cost.setByModel || {})) out[helperOf(m)] = (out[helperOf(m)] || 0) + v.tokens;
      return out;
    };
    const card = (title, q) => `<div class="save-card">
        <div class="save-title">${title}</div>
        <div class="save-line"><span>문제 1개</span><b>${won(api(q.cost.setUsd))}</b></div>
        <div class="save-line"><span>같은 원본으로 100개</span><b>${won(api(hundred(q)))}</b></div>
        <div class="save-line"><span>토큰 (문제 1개)</span><b>${tok(q.cost.setTokens)}</b></div>
        <div class="save-sub">${Object.entries(byHelper(q)).filter(([, n]) => n >= 5e3).map(([k, n]) => `${k} ${tok(n)}`).join(' · ')}</div>
        <div class="save-line"><span>점수 · 시간</span><b>${q.score}점 · ${q.minutes}분</b></div>
      </div>`;
    // Where a problem's cost goes: understanding and solving (reading the original, solving and writing up each made
    // problem) and making the problems (design with repairs, and learning).
    const st = (q, ids) => ids.flatMap((id) => Object.entries(q.cost.setByStage?.[id] || {}));
    const usdOf = (q, ids) => st(q, ids).reduce((x, [, v]) => x + v.usd, 0);
    const tokOf = (q, ids) => st(q, ids).reduce((x, [, v]) => x + v.tokens, 0);
    // Who did it: a model with under a tenth of the tokens only helped (e.g. Haiku re-reading headings).
    const who = (q, ids) => {
      const all = tokOf(q, ids); const by = {};
      for (const [m, v] of st(q, ids)) by[helperOf(m)] = (by[helperOf(m)] || 0) + v.tokens;
      return Object.entries(by).filter(([, t]) => t >= all / 10).map(([k]) => k).join(' + ');
    };
    const saved = (x, y) => (Math.abs(x - y) * P.krwPerUsd < 10 ? '<div class="muted tiny">비슷함</div>'
      : `<div class="tiny ${y < x ? 'save-up' : 'save-down'}">${y < x ? '' : '+'}${won(api(Math.abs(x - y)))} ${y < x ? `절감 (${cut(x, y)}%)` : '더 듦'}</div>`);
    const cols = [{ q: a }, ...mixes];
    const row = (label, note, ids, { cls = '', usd = null } = {}) => {
      const vals = usd || cols.map((c) => usdOf(c.q, ids));
      return `<tr class="${cls}"><th>${label}${note ? `<div class="muted tiny">${note}</div>` : ''}</th>${cols.map((c, i) => `<td><b>${won(api(vals[i]))}</b>${ids ? `<div class="muted tiny">${who(c.q, ids)} · ${tok(tokOf(c.q, ids))} 토큰</div>` : ''}${i ? saved(vals[0], vals[i]) : ''}</td>`).join('')}</tr>`;
    };
    const grp = (t) => `<tr class="grp"><td colspan="${cols.length + 1}"><span class="grp-label">${t}</span></td></tr>`;
    const head = (t, note) => `<tr><th>${t}${note ? `<div class="muted tiny">${note}</div>` : ''}</th><th>Opus 5.5 단독</th>${mixes.map((x) => `<th>${x.name}</th>`).join('')}</tr>`;
    const all = (f) => cols.map((c) => f(c.q));
    const staged = cols.every((c) => c.q.cost.setByStage);
    const day = (w) => `${w.slice(4, 6)}.${w.slice(6, 8)}`;
    return `<div class="panel">
      <h2>Opus 단독 대비 얼마나 아끼나 <span class="muted small">Claude API 정가 기준</span></h2>
      <p class="muted small">문제 1개 = 원본 하나로 연습 문제 3개와 풀이를 만드는 것 · 혼합은 설계·수정만 다른 모델이 하고, 원본 이해·독립 풀이·검토·해설·학습은 모두 Opus가 합니다.</p>
      <div class="save-grid">
        ${card('Claude Opus 5.5 단독', a)}
        ${mixes.map((x) => card(x.name, x.q)).join('')}
        <div class="save-card win">
          <div class="save-title">아끼는 양 (문제 1개 · 100개)</div>
          ${mixes.map((x) => `<div class="save-line"><span>${x.helper}</span><b>${won(api(a.cost.setUsd - x.q.cost.setUsd))} (${cut(a.cost.setUsd, x.q.cost.setUsd)}%) · ${won(api(hundred(a) - hundred(x.q)))}</b></div>`).join('')}
          <div class="save-note">${mixes.map((x) => x.note).join(' · ')}. 설계·수정 토큰은 혼합 쪽이 더 많이 쓰지만 Haiku는 단가가 낮고 Qwen은 PC에서 돌아 Claude 비용에 거의 잡히지 않습니다.</div>
        </div>
      </div>
      ${staged ? `<h3 class="save-h">단계별로 보면</h3>
      <div class="table-wrap"><table class="cmp-table save-stages">
        ${head('문제 1개', '연습 문제 3개 + 풀이')}
        ${grp('문제 이해 · 풀이')}
        ${row('문제 이해', '원본 문제·해설 사진 판독, STEP 정리 · 원본 하나당 한 번', ['read'])}
        ${row('풀이', '만든 문제를 따로 풀어 검산 + 해설 검토 + 해설 작성', ['solve'])}
        ${row('이해 · 풀이 합계', '', ['read', 'solve'], { cls: 'save-sub-total' })}
        ${grp('문제 생성')}
        ${row('문제 설계 · 수정', '연습 문제 3개 설계 + 검토에 걸린 문제 수정', ['design'])}
        ${row('학습', '이번에 배운 점 정리', ['learn'])}
        ${row('생성 합계', '', ['design', 'learn'], { cls: 'save-sub-total' })}
        ${row('문제 1개 총 비용', '이해 + 풀이 + 생성', null, { cls: 'cmp-total', usd: all((q) => q.cost.setUsd) })}
      </table></div>
      <h3 class="save-h">같은 원본으로 계속 만들면</h3>
      <div class="table-wrap"><table class="cmp-table save-stages">
        ${head('', '')}
        ${row('문제 1개', '처음, 원본 이해 포함', null, { cls: 'save-sub-total', usd: all((q) => firstAndMore(q)[0]) })}
        ${row('1개 더', '원본 이해는 재사용', null, { cls: 'save-sub-total', usd: all((q) => firstAndMore(q)[1]) })}
        ${row('100개', '원본 이해 1번 + 100개', null, { cls: 'cmp-total', usd: all(hundred) })}
      </table></div>
      <p class="muted small">원본 이해(해석)는 원본 하나당 한 번만 하고, 같은 원본으로 다시 만들 때는 저장된 해석을 그대로 씁니다. 아끼는 돈은 거의 다 <b>문제 생성</b>과 해설 고치기에서 나옵니다. Qwen + 시스템 혼합은 표의 수치·정답·선택지를 서버가 계산하고, 해설은 Qwen이 선생님 문장 틀대로 직접 쓰며, 틀에서 벗어난 줄은 코드가 찾아 Qwen이 고친 뒤에 Opus가 검토합니다.</p>` : ''}
      <p class="muted small">Claude API 정가는 호출마다 모델별 공개 정가(Opus 입력 $4·출력 $20, Haiku 입력 $0.10·출력 $0.50 / 100만 토큰)로 계산해 1달러 = ${P.krwPerUsd.toLocaleString()}원으로 바꾼 값이고, PC의 Qwen은 0원입니다. Opus 단독은 ${a.runs}회(${day(a.first)}~${day(a.when)}) 평균이고, 10.09에 Opus 토큰을 줄인 변경 전에 잰 값이라 지금 코드로 다시 재면 더 싸게 나와 절감 폭이 줄 수 있습니다. ${mixes.map((x) => `${x.name}는 ${x.q.runs}회 평균`).join(', ')}(Haiku는 R10~R13, Qwen + 시스템은 10.13 11~13회차)입니다.</p>
    </div>`;
  }

  // Who does what in Opus + Qwen + 시스템, and how the rounds on the molar-mass original went as each piece came in
  // (2026-10-13, eval reports; Opus at the API's list price).
  const ROLES = [
    ['Opus 5.5 (구독)', '판단과 판정 — 틀리면 문제 전체가 틀리는 일', ['원본 사진 판독·STEP 정리 (원본마다 1번)', '선생님 해설에서 문장 틀 뽑기 (원본마다 1번)', '만든 문제 독립 풀이 (판정 기준이라 바꾸지 않음)', '해설을 선생님 해설과 대조하는 최종 검토', '세트에서 나온 실수로 학습 정리']],
    ['시스템 (서버 코드, 0원)', '정해진 규칙으로 답이 하나인 일 — 계산·형식·대조', ['표의 수치·숨긴 값·정답·선택지 계산, 해설에 쓸 값 계산 (몰질량 표 유형)', '해설 문장 만들기: Qwen이 고른 선생님 문장 틀에 값을 넣어 문장·줄바꿈을 만듦 (모든 원본)', 'STEP 제목, 선택지 분석 머리말, 표기·범위·쓰이지 않는 조건 검사', '토큰·비용 집계']],
    ['Qwen 3.8-27B (PC, 0원)', '문제를 만들고 내용을 정하는 일 — 여러 번 해도 공짜', ['서버 후보 중 문제 구조 고르기, 문제 문장 쓰기', '해설의 내용 정하기 — 어느 선생님 문장을 어떤 순서로, 어떤 값으로 쓸지 (문장 자체는 시스템이 만듦)', 'Opus 검토가 지적한 내용(판단·값) 고치기']],
  ];
  const ROUNDS = [
    ['1~2', '서버가 해설을 대신 쓰지 않게 함 (Qwen이 직접 씀), Opus가 고쳐 씀', '29/29', 1.85],
    ['3', 'Qwen에게 C+D 질량·숨긴 실험 표시 등 계산값 추가', '29/29', 1.72],
    ['4', '(학습만 누적)', '29/29', 1.78],
    ['5', '선택지 분석 머리말을 코드가 넣음', '29/29', 1.51],
    ['6', '문장 틀 추출 + 코드 대조 + Qwen이 틀에 맞게 다시 쓰고 Opus 지적도 Qwen이 고침', '29/29', 1.39],
    ['7', 'Qwen이 다시 쓸 때도 서버 계산값을 줌', '29/29', 1.46],
    ['8', '<b>형식은 시스템이</b>: Qwen은 문장 틀 번호와 값만 정하고, 문장·제목·머리말은 서버가 만듦 (틀의 자리 이름이 겹쳐 값이 빠진 회차)', '29/29', 1.59],
    ['9', '틀의 자리마다 다른 이름을 붙임 — 연습 문제는 Opus 첫 검토에서 바로 통과', '29/29', 1.58],
    ['10', '서버가 실험별 실젯값·STEP 1 역할을 계산해 줌 (Opus가 원본 표의 인쇄된 값을 필기로 보고 뺀 첫 시도는 무효 — 판독 검사에 표 값 추가) · 틀 추출이 줄을 다 못 덮어 최종 1문제 남음', '26/29', 1.78],
    ['11', '틀의 자리 표시를 《 》로 바꿈(수식 { }와 구분), 틀 없는 줄은 한 번 더 추출, 빗금 분수는 코드가 \frac로 — <b>연습 두 문제가 Opus 지적 0건</b>', '29/29', 1.45],
    ['12', '비례식 두 줄(x, y)의 값을 서버가 줌 · 최종의 STEP 2 실험 종류를 Qwen이 잘못 골라 1문제 남음', '26/29', 1.78],
    ['13', '실험마다 어느 물질이 모두 반응했는지 서버가 표시 · Opus 해설 검토가 8번(출력 3.9만 토큰) 돌아 비용이 오름', '29/29', 1.99],
  ];
  function strategyHtml(sys) {
    const a = sys.compare.models['claude-cli'];
    return `<div class="panel">
      <h2>Opus · 시스템 · Qwen 역할 나누기</h2>
      <p class="muted small">비싼 Opus는 판단과 판정만, 정해진 규칙으로 되는 일(계산·문장 배치·형식)은 서버 코드가, 여러 번 해도 공짜인 일(문제 쓰기·고치기)은 PC의 Qwen이 맡습니다.</p>
      <div class="table-wrap"><table class="cmp-table save-stages">
        ${ROLES.map(([who, kind, jobs]) => `<tr><th>${who}<div class="muted tiny">${kind}</div></th><td class="small">${jobs.map((j) => `· ${j}`).join('<br>')}</td></tr>`).join('')}
      </table></div>
      <details class="cmp-note"><summary class="small">몰질량 원본으로 회차마다 잰 기록 (${ROUNDS.length}단계)</summary>
      <div class="table-wrap"><table class="cmp-table save-stages">
        <tr><th>회차</th><th>바꾼 것</th><th>자동 검토</th><th>Opus 정가 (1벌)</th></tr>
        ${a?.cost?.setUsd ? `<tr><th>Opus 단독</th><td class="small">Opus가 모두 함</td><td>26/29 <span class="muted tiny">(10.06 세트)</span></td><td>$${a.cost.setUsd.toFixed(2)}</td></tr>` : ''}
        ${ROUNDS.map(([n, what, score, usd]) => `<tr><th>${n}회차</th><td class="small">${what}</td><td>${score}</td><td>$${usd.toFixed(2)}${a?.cost?.setUsd ? `<div class="tiny save-up">−${Math.round((1 - usd / a.cost.setUsd) * 100)}%</div>` : ''}</td></tr>`).join('')}
      </table></div>
      <p class="muted small">해설 문장은 원본 전용 코드가 아니라 선생님 해설에서 뽑은 문장 틀로 만들어 다른 원본에도 그대로 쓰입니다. 수치 계산은 아직 몰질량 표 유형 전용이라, 원본마다 계산 프로그램을 Opus가 한 번 만들게 하는 것이 다음 단계입니다 (참고: <a href="https://arxiv.org/html/2511.07932v1" target="_blank" rel="noopener">Computational Blueprints</a>).</p></details>
    </div>`;
  }

  // The cost of each part of the work for each setup, at the API's list price and on the subscription, in one grid:
  // understanding the original and its solution (once per original), the step practice problems and the twin final
  // (every set), and the sums a teacher pays — a first set, and further sets reusing the understanding. The parts are
  // the runs' calls split by the problem they were made for (server/cost.js partOf); the set's learning is shared
  // between its problems by count.
  function costMatrixHtml(sys) {
    const P = sys.compare && sys.pricing;
    if (!P?.maxUsdPerMonth) return '';
    const ids = ['claude-cli', 'opus-haiku', 'opus-qwen-sys'].filter((id) => sys.compare.models[id]?.cost?.setByPart);
    if (!ids.length) return '';
    const { won, api, weekly, max } = claudeMoney(P);
    const NAME = { 'claude-cli': 'Opus 5.5 단독', 'opus-haiku': 'Opus 5.5 + Haiku 5.5', 'opus-qwen-sys': 'Opus 5.5 + Qwen + 시스템' };
    const parts = (id) => {
      const c = sys.compare.models[id].cost; const p = c.setByPart; const n = c.practices || 2;
      const learn = p.learn || 0;
      const practice = (p.practice || 0) + (learn * n) / (n + 1);
      const twin = (p.twin || 0) + learn / (n + 1);
      return { understand: p.understand || 0, solution: p.solution || 0, practice, twin };
    };
    // To 10 won, never rounded to 만 원: "5만 원" against "2만 원" looked like half of a −69% (the user, 2026-10-13).
    const big = (krw) => won(krw);
    const pct = (usd) => { const w = weekly(usd); return w < 1 ? w.toFixed(2) : w < 10 ? w.toFixed(1) : Math.round(w).toLocaleString(); };
    const ROWS = [
      ['문제 이해', '원본 문제 사진 판독·발문 확인 · 원본마다 1번', (q) => q.understand],
      ['문제 풀이', '원본 해설 STEP 정리·교정·문장 틀 · 원본마다 1번', (q) => q.solution],
      ['STEP 3 생성', '단계별 연습 문제(STEP 1 연습, STEP 1~2 연습) 설계·독립 풀이·해설', (q) => q.practice],
      ['쌍둥이 문제', '최종 문제(STEP 1~3 모두 쓰는 구조 변형) 설계·독립 풀이·해설', (q) => q.twin],
      ['이해 + 풀이 + STEP 3 생성 + 쌍둥이', '새 원본으로 처음 한 벌', (q) => q.understand + q.solution + q.practice + q.twin, 'save-sub-total'],
      ['재활용 + STEP 3 생성 + 쌍둥이 1개', '이해·풀이는 저장된 것을 다시 씀', (q) => q.practice + q.twin, 'save-sub-total'],
      ['재활용 + STEP 3 생성 + 쌍둥이 100개', '이해·풀이 재활용, 100벌', (q) => 100 * (q.practice + q.twin), 'cmp-total'],
    ];
    const qs = ids.map((id) => parts(id));
    const base = qs[0];
    return `<div class="panel">
      <h2>요금 한눈에 보기 <span class="muted small">몰질량 원본 · 1벌 = STEP 연습 2문제 + 쌍둥이 1문제</span></h2>
      <p class="swipe-hint mobile-only">표는 옆으로 밀어서 볼 수 있습니다.</p>
      <div class="table-wrap"><table class="cmp-table save-stages cost-matrix">
        <tr><th></th>${ids.map((id) => `<th>${NAME[id]}<div class="muted tiny">API 정가</div></th>`).join('')}${ids.map((id) => `<th>${NAME[id]}<div class="muted tiny">Claude 구독</div></th>`).join('')}</tr>
        ${ROWS.map(([label, note, f, cls]) => {
          // Against Opus alone on the same footing: −% when it costs less, +% when more.
          const diff = (q, i) => {
            const b = f(base); const usd = f(q);
            if (!i || !(b > 0)) return '';
            const d = Math.round((usd / b - 1) * 100);
            return d === 0 ? '<div class="muted tiny">±0%</div>' : `<div class="tiny ${d < 0 ? 'save-up' : 'save-down'}">${d < 0 ? '−' : '+'}${Math.abs(d)}%</div>`;
          };
          return `<tr class="${cls || ''}"><th>${label}<div class="muted tiny">${note}</div></th>`
            + qs.map((q, i) => `<td><b>${big(api(f(q)))}</b>${diff(q, i)}</td>`).join('')
            + qs.map((q, i) => `<td><b>${big(max(f(q)))}</b><div class="muted tiny">주간 한도 ${pct(f(q))}%</div>${diff(q, i)}</td>`).join('')
            + '</tr>';
        }).join('')}
      </table></div>
      <p class="muted small">API: 호출마다 공개 정가(100만 토큰당 Opus $4/$20, Haiku $0.10/$0.50), 1달러 = ${P.krwPerUsd.toLocaleString()}원 · 구독: Claude Max 20x(월 $${P.maxUsdPerMonth}) 구독료 중 쓴 주간 한도의 몫 · Qwen은 PC라 0원 · −%/+%는 같은 방식의 Opus 단독 대비 · 평가 회차 평균(${ids.map((id) => `${NAME[id]} ${sys.compare.models[id].cost.partRuns}회`).join(', ')})</p>
    </div>`;
  }

  // The last word on Claude: the same work paid at the API's list price, or done on the Claude Max subscription
  // (no extra money, it fills the weekly limit; shown as the share of the fee that limit costs).
  // Opus alone and each mix at the API's list price, and each mix on the subscription. One 벌 is the understanding of
  // the original (read once, reused after) and the three problems made from it (STEP 1, STEP 1~2, the twin final)
  // with their solving and solutions.
  function scenarioHtml(sys) {
    const P = sys.pricing; const a = sys.compare.models['claude-cli'];
    const mixes = MIXES.filter((x) => sys.compare.models[x.id]?.cost?.setByStage).map((x) => ({ ...x, q: sys.compare.models[x.id] }));
    if (!a?.cost?.setByStage || !mixes.length || !P.maxUsdPerMonth) return '';
    const { won, api, weekly, max, cut } = claudeMoney(P);
    // n originals, each understood once and made into `sets` 벌.
    const usd = (q, n, sets) => n * (readUsd(q) + sets * firstAndMore(q)[1]);
    const big = (krw) => (krw >= 1e8 ? `약 ${(krw / 1e8).toFixed(1)}억 원` : won(krw));
    const weeks = (x) => { const w = weekly(x) / 100; return w <= 1 ? `주간 한도 ${weekly(x) < 10 ? weekly(x).toFixed(1) : Math.round(weekly(x))}%` : `주간 한도 약 ${Math.ceil(w).toLocaleString()}주 분량`; };
    const row = (label, what, n, sets) => {
      const x = usd(a, n, sets);
      return `<tr><th>${label}<div class="muted tiny">${what}</div></th>
        <td><b>${big(api(x))}</b></td>
        ${mixes.map((m) => { const y = usd(m.q, n, sets); return `<td><b>${big(api(y))}</b><div class="tiny save-up">${big(api(x - y))} 절감 (${cut(x, y)}%)</div></td>`; }).join('')}
        ${mixes.map((m) => { const y = usd(m.q, n, sets); return `<td><b>약 ${big(max(y))}</b><div class="muted tiny">${weeks(y)}</div></td>`; }).join('')}</tr>`;
    };
    return `<div class="panel">
      <h2>원본 문제로 이렇게 쓰면</h2>
      <p class="muted small"><b>1벌</b> = 원본 이해(문제·해설 판독, STEP 정리) + 단계별 문제 3개(STEP 1 연습, STEP 1~2 연습, 쌍둥이 최종 문제)와 각각의 풀이·해설 · 문제 품질: Opus 단독 ${a.score}점, ${mixes.map((m) => `${m.helper} 혼합 ${m.q.score}점`).join(', ')}</p>
      <div class="table-wrap"><table class="cmp-table save-stages">
        <tr><th></th><th>Opus 5.5 단독<div class="muted tiny">Claude API 정가</div></th>${mixes.map((m) => `<th>${m.name}<div class="muted tiny">Claude API 정가</div></th>`).join('')}${mixes.map((m) => `<th>${m.name}<div class="muted tiny">Claude Max 구독</div></th>`).join('')}</tr>
        ${row('1차 · 1벌', '원본 이해 + 단계별 3문제(쌍둥이 포함) 1벌', 1, 1)}
        ${row('2차 · 같은 원본 100벌', '원본 이해는 한 번 하고 재활용 + 단계별 3문제 100벌', 1, 100)}
        ${row('3차 · 원본 100개 × 100벌', '2차를 원본 100개에 대해 (원본 이해 100번 + 1만 벌)', 100, 100)}
      </table></div>
      <p class="muted small">재활용되는 것은 원본 이해(사진 판독과 STEP 정리)뿐이고, 만든 문제마다 하는 독립 풀이·검토·해설 작성은 벌마다 새로 합니다. 구독은 쓴 만큼 돈이 더 나가지 않고 주간 한도를 쓰므로, 구독 금액은 그 한도를 사는 데 든 구독료의 몫(Max 20x 월 $${P.maxUsdPerMonth})이고 한도를 넘는 양은 여러 주에 나눠 만들어야 합니다. Qwen 혼합은 선생님 PC가 켜져 있어야 하고 1벌에 약 20분 걸립니다.</p>
    </div>`;
  }

  function subscriptionHtml(sys, ids) {
    const P = sys.pricing;
    const models = ids.filter((id) => CLAUDE_LABEL[id] && sys.compare.models[id]?.cost?.setUsd);
    if (!models.length || !P.maxUsdPerMonth) return '';
    const { won, api, weekly, max } = claudeMoney(P);
    const row = (label, note, usd, limit) => `<tr><th>${label}<div class="muted tiny">${note}</div></th><td><b>${won(api(usd))}</b></td><td><b>약 ${won(max(usd))}</b>${limit ? `<div class="muted tiny">주간 한도 ${weekly(usd) < 10 ? weekly(usd).toFixed(1) : Math.round(weekly(usd))}%</div>` : ''}</td><td><b class="save-up">${won(api(usd) - max(usd))} 덜 듦</b><div class="muted tiny">API의 ${Math.round((max(usd) / api(usd)) * 100)}%</div></td></tr>`;
    return `<div class="panel">
      <h2>Claude를 API로 쓸 때와 구독으로 쓸 때</h2>
      <div class="table-wrap"><table class="cmp-table save-stages">
        <tr><th></th><th>Claude API 정가</th><th>Claude Max 구독</th><th>구독이</th></tr>
        ${models.map((id) => {
          const q = sys.compare.models[id];
          const [first, more] = firstAndMore(q);
          return `<tr class="grp"><td colspan="4"><span class="grp-label">${CLAUDE_LABEL[id]}</span></td></tr>
            ${row('문제 1개', '연습 문제 3개 + 풀이, 원본 이해 포함', first, true)}
            ${row('같은 원본으로 100개', '원본 이해 1번 + 100개', readUsd(q) + 100 * more, true)}`;
        }).join('')}
      </table></div>
      <p class="muted small">Claude Max 구독(Max 20x, 월 $${P.maxUsdPerMonth})은 쓴 만큼 돈이 더 나가지 않고 주간 한도를 씁니다. 한도는 API 정가만큼 차서 정가 약 $${P.usdPerWeeklyPercent}가 주간 한도 1%입니다(2026-10-06 실측). 구독 금액은 그 한도를 사는 데 든 구독료의 몫으로, 한도를 다 쓴다고 볼 때의 값입니다. 한도가 남으면 실제로 더 나가는 돈은 없고, 한 주에 한도를 넘게 만들 수는 없습니다.</p>
    </div>`;
  }

  // One row per model: each problem's result and the PDF. The public page shows only this.
  function resultsHtml(b, { pdfBase = 'api/compare', fidelity = null, pdfSuffix = '' } = {}) {
    const RESULT = {
      passed: ['ok', '✓ 됨', ''], warning: ['ok', '✓ 됨 (확인할 점)', ''],
      needs_review: ['warn', '△ 검토 필요', ''], failed: ['bad', '✕ 안 됨', ''],
    };
    const why = (it) => {
      if (it.status === 'failed') return it.error || '만들지 못함';
      const first = (it.problems[0] || (it.status === 'warning' ? it.warnings[0] : '') || '').replace(/^[^:]{0,40}: /, '');
      return first.length > 70 ? first.slice(0, 70) + '…' : first;
    };
    const stageName = (it) => (it.stage?.kind === 'twin' ? '최종 문제' : it.label.replace(' 누적', ''));
    const row = (m) => {
      const done = m.items.filter((it) => ['passed', 'warning'].includes(it.status)).length;
      const f = fidelity?.(m);
      return `<div class="cv2-row">
        <div class="cv2-model"><b>${esc(m.label)}</b><span class="muted small">${m.items.length}문제 중 <b>${done}</b>개 바로 사용 가능</span>${f ? `<span class="small">요구사항 충실도 <b class="cv2-pct ${f.pct >= 90 ? 'ok' : f.pct >= 60 ? 'warn' : 'bad'}">${f.pct}%</b></span>` : ''}</div>
        ${m.items.map((it) => {
          const [tone, label, extra] = RESULT[it.status] || ['', it.status, ''];
          const reason = it.status === 'passed' ? '' : why(it) || extra;
          return `<div class="cv2-cell ${tone}"><span class="cv2-stage">${esc(stageName(it))}</span><b>${label}</b>${reason ? `<span class="cv2-why">${esc(reason)}</span>` : ''}</div>`;
        }).join('')}
        <div class="cv2-pdf">${m.pdf ? `<a class="button primary" href="${pdfBase}/${b.id}/pdf/${m.key}${pdfSuffix}" download>PDF 다운로드</a>` : '<span class="muted small">PDF 없음</span>'}</div>
      </div>`;
    };
    return `<div class="cv2">${b.models.map(row).join('')}</div>
      <p class="muted small">✓ 됨: 자동 검토를 통과해 바로 쓸 수 있음 (확인할 점은 가볍게 한 번 보시면 되는 내용) · △ 검토 필요: 만들었지만 선생님 확인이 필요함 · ✕ 안 됨: 문제를 만들지 못함</p>`;
  }

  // The same molar-mass original made into a problem set by each model: what worked, what did not, the PDF.
  // pdfBase: where the PDFs are served (the app's API or the public one); balance: show DeepSeek's balance slot.
  // 전체 비교: every setup, alone or mixed, on one page (the user, 2026-10-14) — short cards with the four prices a
  // teacher meets, quality against price as one chart, and the price of each part of the work in one grid. The detail
  // stays in the 단독 모델 / 혼합 모델 tabs.
  const ALL = [
    { id: 'opus-qwen-sys', name: 'Opus 5.5 + Qwen 3.8 + 시스템', short: 'Opus+Qwen+시스템', kind: '혼합', pay: 'claude', pc: true, how: 'Opus는 원본 이해·판정, PC의 Qwen이 문제 설계·해설 내용, 서버가 계산과 문장 배치' },
    { id: 'claude-cli', name: 'Claude Opus 5.5', short: 'Opus 단독', kind: '단독', pay: 'claude', how: 'Opus가 모든 일을 함' },
    { id: 'opus-haiku', name: 'Opus 5.5 + Haiku 5.5', short: 'Opus+Haiku', kind: '혼합', pay: 'claude', how: 'Haiku가 문제 설계·수정, Opus가 판정·해설·학습' },
    { id: 'qwen38q4', name: 'Qwen 3.8-27B · 학습됨 + 시스템', short: 'Qwen 3.8 학습됨', kind: '단독', pay: 'pc', pc: true, trained: true, how: '학습된 Qwen이 혼자 만들고 서버가 계산과 문장 배치 (점수는 Opus 판정)' },
    { id: 'deepseek', name: 'DeepSeek V4 Flash', short: 'DeepSeek', kind: '단독', pay: 'api', how: 'DeepSeek이 모든 일을 함 (인터넷 API)' },
  ];
  // A setup's Claude/API cost split in what one original costs once (understanding its problem and solution) and what
  // each further set of problems costs (the step problems, the twin, learning).
  function splitCost(q) {
    const p = q.cost?.setByPart;
    const set = q.cost?.setUsd || 0;
    if (p) {
      const once = (p.understand || 0) + (p.solution || 0);
      return { once, each: Math.max(0, set - once) };
    }
    const once = Object.values(q.cost?.setByStage?.read || {}).reduce((x, v) => x + v.usd, 0);
    return { once, each: Math.max(0, set - once) };
  }
  const SCENARIOS = [
    ['원본 1개 · 1벌', '문제 이해·풀이 + STEP 연습 + 쌍둥이 1벌', (c) => c.once + c.each],
    ['원본 1개 · 100벌', '이해·풀이는 한 번, STEP 연습 + 쌍둥이 100벌', (c) => c.once + 100 * c.each],
    ['원본 100개 · 1벌씩', '원본마다 이해·풀이 + 1벌', (c) => 100 * (c.once + c.each)],
    ['원본 100개 · 100벌씩', '원본마다 이해·풀이 + 100벌 (1만 벌)', (c) => 100 * (c.once + 100 * c.each)],
  ];
  function allHtml(sys, fb, subject = '화학 몰질량') {
    const P = sys.pricing; const cmp = sys.compare;
    const { won, api, weekly, max } = claudeMoney(P);
    const list = ALL.filter((m) => cmp.models[m.id]).map((m) => ({ ...m, q: cmp.models[m.id], c: splitCost(cmp.models[m.id]) }))
      .sort((x, y) => (y.q.score ?? 0) - (x.q.score ?? 0));
    if (!list.length) return '';
    const best = list[0].q.score;
    const money = (krw) => (krw >= 1e8 ? `${(krw / 1e8).toFixed(1)}억 원` : won(krw));
    const weeks = (usd) => { const w = weekly(usd); return w < 100 ? `주간 한도 ${w < 10 ? w.toFixed(1) : Math.round(w)}%` : `주간 한도 약 ${Math.ceil(w / 100).toLocaleString()}주 분량`; };
    const price = (m, usd) => (m.pay === 'pc' ? '<b>0원</b>'
      : m.pay === 'api' ? `<b>${money(api(usd))}</b><span class="muted tiny">API</span>`
        : `<b>${money(max(usd))}</b><span class="muted tiny">구독 · ${weeks(usd)}</span><span class="muted tiny">API면 ${money(api(usd))}</span>`);
    const fid = (id) => { const g = fb?.models?.[id]; if (!g) return null; const v = Object.values(g).map((x) => x[0]); return Math.round(((v.filter((x) => x === 'ok').length + v.filter((x) => x === 'partial').length / 2) / v.length) * 100); };
    const chips = (m) => [
      `<span class="chip ${m.kind === '혼합' ? 'mix' : 'solo'}">${m.kind}</span>`,
      m.pay === 'claude' ? '<span class="chip run">구독</span>' : m.pay === 'api' ? '<span class="chip run">유료</span>' : '<span class="chip ok">무료</span>',
      m.trained ? '<span class="chip run">학습됨</span>' : '', m.pc ? '<span class="chip">PC 필요</span>' : '',
      m.q.score === best ? '<span class="chip ok">품질 1위</span>' : '',
    ].join(' ');
    const tone = (s) => (s >= 85 ? 'ok' : s >= 60 ? 'warn' : 'bad');
    const cards = list.map((m) => {
      const usable = m.q.metrics?.clear;
      const f = fid(m.id);
      return `<div class="ov-card">
        <div class="ov-name">${m.name}</div>
        <div class="ov-chips">${chips(m)}</div>
        <div class="ov-score ${tone(m.q.score)}">${m.q.score}<small>점</small></div>
        <div class="muted tiny">${m.how}</div>
        <dl class="ov-facts">
          <dt>바로 쓸 문제</dt><dd>${usable ? `${usable.pass}/${usable.total}` : '-'}</dd>
          <dt>1벌 시간</dt><dd>${m.q.minutes}분</dd>
          ${f != null ? `<dt>요구사항 충실도</dt><dd>${f}%</dd>` : ''}
          <dt>평가</dt><dd>${m.q.runs}회 평균</dd>
        </dl>
      </div>`;
    }).join('');
    // Quality against the price of one set (API list price, so every setup is on one scale; PC models at 0). Each label
    // takes the first place around its point (right, left, above, below) that overlaps no other label or point and stays
    // inside the plot: the first version cut "97" at the top and ran labels into each other (the user, 2026-10-14).
    const W = 880; const H = 360; const L = 52; const R = 24; const T = 34; const B = 52;
    const xs = list.map((m) => (m.pay === 'pc' ? 0 : api(m.c.once + m.c.each)));
    const step = Math.max(...xs) > 4000 ? 1000 : 500;
    const xMax = Math.ceil((Math.max(1000, ...xs) * 1.02) / step) * step;
    const X = (v) => L + 10 + (v / xMax) * (W - L - R - 20);
    // The score axis starts just under the lowest model (no empty band at the bottom) and ends at 100 (the user,
    // 2026-10-14: with the weak PC models gone, 0~60 was empty).
    const yMin = Math.max(0, Math.floor((Math.min(...list.map((m) => m.q.score)) - 5) / 10) * 10);
    const yStep = 100 - yMin <= 40 ? 5 : 10;
    const yTicks = Array.from({ length: (100 - yMin) / yStep + 1 }, (_, k) => yMin + k * yStep);
    const Y = (sc) => T + (1 - (sc - yMin) / (100 - yMin)) * (H - T - B);
    const COLOR = { 단독: '#2a78d6', 혼합: '#eb6834' };
    const tick = (v) => (v >= 1000 ? (v / 1000) + '천 원' : v + '원');
    const xTicks = Array.from({ length: xMax / step + 1 }, (_, k) => k * step);
    const textW = (t) => [...t].reduce((n, ch) => n + (/[가-힣]/.test(ch) ? 12.5 : 7.4), 0);
    const pts = list.map((m, k) => ({ m, x: X(xs[k]), y: Y(m.q.score), usd: xs[k] }));
    const boxes = pts.map((pt) => ({ x0: pt.x - 9, x1: pt.x + 9, y0: pt.y - 9, y1: pt.y + 9 }));
    const hit = (a, b) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
    const labels = pts.map((pt) => {
      const text = pt.m.short + ' ' + pt.m.q.score + '점';
      const w = textW(text); const h = 16;
      const tries = [
        { x: pt.x + 13, y: pt.y + 5, a: 'start' }, { x: pt.x - 13, y: pt.y + 5, a: 'end' },
        { x: pt.x, y: pt.y - 14, a: 'middle' }, { x: pt.x, y: pt.y + 24, a: 'middle' },
        { x: pt.x + 13, y: pt.y - 12, a: 'start' }, { x: pt.x + 13, y: pt.y + 22, a: 'start' },
        { x: pt.x - 13, y: pt.y - 12, a: 'end' }, { x: pt.x - 13, y: pt.y + 22, a: 'end' },
      ];
      const box = (t) => { const x0 = t.a === 'start' ? t.x : t.a === 'end' ? t.x - w : t.x - w / 2; return { x0, x1: x0 + w, y0: t.y - h + 3, y1: t.y + 4 }; };
      const inside = (b) => b.x0 >= L + 2 && b.x1 <= W - 4 && b.y0 >= 2 && b.y1 <= H - B - 2;
      const pick = tries.find((t) => { const b = box(t); return inside(b) && !boxes.some((o) => hit(o, b)); }) || tries.find((t) => inside(box(t))) || tries[0];
      boxes.push(box(pick));
      return { ...pick, text };
    });
    const dots = pts.map((pt, k) => {
      const m = pt.m;
      const mark = m.kind === '혼합'
        ? '<rect x="' + (pt.x - 6.5) + '" y="' + (pt.y - 6.5) + '" width="13" height="13" transform="rotate(45 ' + pt.x + ' ' + pt.y + ')" fill="' + COLOR[m.kind] + '" stroke="#fff" stroke-width="2"/>'
        : '<circle cx="' + pt.x + '" cy="' + pt.y + '" r="7" fill="' + COLOR[m.kind] + '" stroke="#fff" stroke-width="2"/>';
      const tip = m.name + ' — 품질 ' + m.q.score + '점, 1벌 ' + (m.pay === 'pc' ? '0원 (PC)' : 'API ' + won(pt.usd)) + ', ' + m.q.minutes + '분';
      const lb = labels[k];
      return '<g class="ov-dot"><title>' + tip + '</title><circle cx="' + pt.x + '" cy="' + pt.y + '" r="16" fill="transparent"/>' + mark
        + '<text x="' + lb.x + '" y="' + lb.y + '" text-anchor="' + lb.a + '" class="ov-lbl">' + lb.text + '</text></g>';
    }).join('');
    const sweetX = X(xMax * 0.3); const sweetY = Y(85);
    const chart = '<svg class="ov-chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="문제 품질 점수와 1벌 비용">'
      + '<rect x="' + (L + 1) + '" y="' + T + '" width="' + (sweetX - L - 1) + '" height="' + (sweetY - T) + '" rx="6" class="ov-sweet"/>'
      + '<text x="' + (sweetX - 8) + '" y="' + (sweetY - 8) + '" class="ov-sweet-t" text-anchor="end">싸고 좋음</text>'
      + yTicks.map((v) => '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + Y(v) + '" y2="' + Y(v) + '" class="ov-gl"/><text x="' + (L - 8) + '" y="' + (Y(v) + 4) + '" class="ov-tick" text-anchor="end">' + v + '</text>').join('')
      + xTicks.map((v) => '<text x="' + X(v) + '" y="' + (H - B + 18) + '" class="ov-tick" text-anchor="middle">' + tick(v) + '</text>').join('')
      + '<text x="' + L + '" y="16" class="ov-axis" text-anchor="start">↑ 문제 품질 점수</text>'
      + '<text x="' + (W - R) + '" y="' + (H - 10) + '" class="ov-axis" text-anchor="end">원본 1개로 1벌 만드는 비용 (API 정가 · PC 모델은 0원) →</text>'
      + dots + '</svg>';
    const legend = `<div class="ov-legend"><span><svg width="14" height="14"><circle cx="7" cy="7" r="6" fill="#2a78d6"/></svg> 단독 모델</span><span><svg width="14" height="14"><rect x="3" y="3" width="8" height="8" transform="rotate(45 7 7)" fill="#eb6834"/></svg> 혼합 모델</span><span class="muted">점에 마우스를 올리면 자세한 값이 보입니다.</span></div>`;
    // The price of each part of the work for the setups still in use (old PC models left out).
    // Opus alone first: the other columns are read against it.
    const grid = list.filter((m) => !/qwen36|gemma12/.test(m.id) && m.q.cost?.setByPart || m.pay === 'pc' && m.id === 'qwen38q4')
      .sort((x, y) => (y.id === 'claude-cli') - (x.id === 'claude-cli'));
    const parts = (m) => {
      const p = m.q.cost?.setByPart || {}; const n = m.q.cost?.practices || 2; const learn = p.learn || 0;
      return { understand: p.understand || 0, solution: p.solution || 0, practice: (p.practice || 0) + (learn * n) / (n + 1), twin: (p.twin || 0) + learn / (n + 1) };
    };
    const ROWS = [
      ['문제 이해', '원본 문제 사진 판독 · 원본마다 1번', (q) => q.understand],
      ['문제 풀이', '원본 해설 STEP 정리·교정·문장 틀 · 원본마다 1번', (q) => q.solution],
      ['STEP 3 생성', 'STEP 1 연습 + STEP 1~2 연습 설계·검산·해설', (q) => q.practice],
      ['쌍둥이 문제', '최종 문제(STEP 1~3 구조 변형) 설계·검산·해설', (q) => q.twin],
      ['이해 + 풀이 + STEP 3 + 쌍둥이', '새 원본으로 처음 한 벌', (q) => q.understand + q.solution + q.practice + q.twin, 'save-sub-total'],
      ['재활용 + STEP 3 + 쌍둥이 1개', '이해·풀이는 저장된 것을 다시 씀', (q) => q.practice + q.twin, 'save-sub-total'],
      ['재활용 + STEP 3 + 쌍둥이 100개', '이해·풀이 재활용, 100벌', (q) => 100 * (q.practice + q.twin), 'cmp-total'],
    ];
    const opus = list.find((m) => m.id === 'claude-cli');
    const pct = (usd, base) => { if (!base || !(base > 0)) return ''; const d = Math.round((usd / base - 1) * 100); return `<div class="tiny ${d <= 0 ? 'save-up' : 'save-down'}">${d === 0 ? '±0' : (d < 0 ? '−' : '+') + Math.abs(d)}%</div>`; };
    const apiCols = grid.filter((m) => m.pay !== 'pc');
    // The grid at the API's list price only; what the Claude subscription makes of it below, for the sums a teacher
    // meets (the user, 2026-10-14: one way of pricing in the grid, the subscription as how much cheaper).
    const subCols = grid.filter((m) => m.pay === 'claude');
    const pcCols = grid.filter((m) => m.pay === 'pc');
    const matrix = '<div class="table-wrap"><table class="cmp-table save-stages cost-matrix">'
      + '<tr><th></th>' + apiCols.map((m) => '<th>' + m.short + '<div class="muted tiny">API 정가</div></th>').join('') + pcCols.map((m) => '<th>' + m.short + '<div class="muted tiny">PC</div></th>').join('') + '</tr>'
      + ROWS.map(([label, note, f, cls]) => {
        const base = opus ? f(parts(opus)) : 0;
        return '<tr class="' + (cls || '') + '"><th>' + label + '<div class="muted tiny">' + note + '</div></th>'
          + apiCols.map((m) => '<td><b>' + money(api(f(parts(m)))) + '</b>' + (m.id === 'claude-cli' ? '' : pct(f(parts(m)), base)) + '</td>').join('')
          + pcCols.map(() => '<td><b>0원</b></td>').join('') + '</tr>';
      }).join('')
      + '</table></div>';
    const SUB_ROWS = [ROWS[4], ROWS[5], ROWS[6]];
    const subscription = '<h3 class="save-h">Claude 구독으로 쓰면</h3>'
      + '<p class="muted small">Claude Max 20x(월 $' + P.maxUsdPerMonth + ')로 쓰면 쓴 만큼 돈이 더 나가지 않고 주간 한도를 씁니다. 아래는 그 한도를 사는 데 든 구독료의 몫으로 바꾼 값입니다(정가 약 $' + P.usdPerWeeklyPercent + '가 주간 한도 1%, 한도를 넘는 양은 여러 주에 나눠 만듦).</p>'
      + '<div class="table-wrap"><table class="cmp-table save-stages sub-table"><tr><th>상황</th>' + subCols.map((m) => '<th>' + m.short + '</th>').join('') + '</tr>'
      + SUB_ROWS.map(([label, note, f]) => '<tr><th>' + label + '<div class="muted tiny">' + note + '</div></th>' + subCols.map((m) => {
        const usd = f(parts(m)); const a = api(usd); const sb = max(usd); const w = weekly(usd);
        return '<td><span class="muted small">API ' + money(a) + ' →</span><div><b>구독 ' + money(sb) + '</b></div><div class="tiny save-up">−' + Math.round((1 - sb / a) * 100) + '% · 주간 한도 ' + (w < 10 ? w.toFixed(2) : Math.round(w)) + '%</div></td>';
      }).join('') + '</tr>').join('')
      + '</table></div>';
    return {
      cards: '<div class="panel"><h2>한눈에 보기 <span class="muted small">' + subject.replace(/^화학 /, '') + ' 원본 · 점수 높은 순</span></h2>'
        + '<p class="muted small"><b>품질 점수</b>는 모든 구성을 같은 기준(Opus의 독립 풀이·해설 대조를 포함한 자동 검토)으로 매긴 100점 만점이고, <b>요구사항 충실도</b>는 Claude·Gemini 독립 검수와 직접 검산으로 채운 아래 체크리스트의 점수입니다. <b>1벌</b> = 원본 하나로 만드는 STEP 연습 2문제(STEP 1, STEP 1~2)와 쌍둥이 최종 문제 1개, 각각의 풀이·해설. 가격은 바로 아래 따로 정리했습니다.</p>'
        + '<div class="ov-grid">' + cards + '</div></div>',
      price: '<div class="panel"><h2>모델별 가격 <span class="muted small">API 정가</span></h2>'
        + '<p class="muted small">일을 단계별로 나눈 값입니다. 문제 이해와 풀이는 원본마다 한 번만 하고, 같은 원본으로 계속 만들 때는 저장된 것을 다시 씁니다. 모든 금액은 API 정가(1달러 = ' + P.krwPerUsd.toLocaleString() + '원)이고, −%·+%는 Opus 단독 대비입니다. PC 모델은 0원.</p>'
        + matrix + '</div>',
      subscription: '<div class="panel">' + subscription.replace('<h3 class="save-h">Claude 구독으로 쓰면</h3>', '<h2>Claude 구독으로 쓰면 <span class="muted small">API 대비 할인</span></h2>') + '</div>',
      chart: '<div class="panel"><h2>가격 대비 품질</h2><p class="muted small">위로 갈수록 품질이 좋고 왼쪽으로 갈수록 쌉니다. 왼쪽 위 "싸고 좋음" 칸에 가까운 구성이 가성비가 좋습니다.</p>'
        + legend + '<div class="ov-chart-wrap">' + chart + '</div>'
        + '<details class="cmp-note"><summary class="small">표로 보기</summary><div class="table-wrap"><table class="cmp-table save-stages"><tr><th>구성</th><th>종류</th><th>품질 점수</th><th>1벌 비용 (API 정가)</th><th>1벌 시간</th></tr>'
        + list.map((m, k) => '<tr><th>' + m.name + '</th><td>' + m.kind + '</td><td>' + m.q.score + '점</td><td>' + (m.pay === 'pc' ? '0원' : won(xs[k])) + '</td><td>' + m.q.minutes + '분</td></tr>').join('')
        + '</table></div></details></div>',
    };
  }

  // 1차 and 2차 (the same setups and settings again with the molar-mass learning, 2026-10-16) as two views of one
  // page, 2차 first, with what changed between them at its top.
  function pageHtml(b, opts = {}) {
    if (!b.round2?.overview) return roundHtml(b, opts);
    const r2 = { ...b, models: b.round2.models, overview: b.round2.overview, feedback: b.round2.feedback };
    // 3차 (2026-10-16~): the same setups, settings and learning on another original (reaction-density): what carries over.
    const r3 = b.round3?.overview ? { ...b, id: b.id, models: b.round3.models, overview: b.round3.overview, feedback: b.round3.feedback || null, original: b.round3.original } : null;
    const intro3 = '3차 (2026-10-16): 2차와 같은 모델·같은 설정·같은 학습 묶음으로, 원본만 화학 반응식·밀도 문제로 바꿔 만든 세트입니다. 이 원본만의 학습은 없고, 몰질량 전용 서버 계산도 쓰이지 않습니다. 몰질량에서 쌓은 시스템과 학습이 다른 문제에도 통하는지를 봅니다. 구성마다 1벌씩, 점수는 모두 Opus 판정입니다.';
    const intro = '2차 (2026-10-16): 1차와 같은 모델·같은 설정으로 다시 만든 세트입니다. 달라진 것은 몰질량 원본에서 쌓은 학습(교사 지침 113개, 판독 교정 4개)을 모두 같은 묶음으로 받은 것과 지금의 시스템입니다. 구성마다 1벌씩, 점수는 모두 Opus 판정입니다. 표의 수치 후보는 서버가 계산해 내놓고 학습도 같아서, 구성이 달라도 같은 표를 고른 문제가 많습니다 (예: Opus 단독과 Opus + Qwen의 STEP 1 연습).';
    return `<div class="cmp-tabs cmp-rounds">
        ${r3 ? '<button class="cmp-tab" data-cmp-round-tab="3">3차 <span class="muted tiny">10-16 · 다른 원본</span></button>' : ''}
        <button class="cmp-tab" data-cmp-round-tab="2">2차 <span class="muted tiny">10-16 · 학습 반영</span></button>
        <button class="cmp-tab" data-cmp-round-tab="1">1차 <span class="muted tiny">10-06 ~ 10-14</span></button>
      </div>
      ${r3 ? `<div data-cmp-round="3">${changeHtml(r2.overview, r3.overview, { from: '2차', to: '3차', what: '같은 모델·설정·학습, 원본만 바꿈', note: '2차는 몰질량 원본, 3차는 화학 반응식·밀도 원본입니다. 둘 다 구성마다 1벌씩입니다. 세트 비용은 원본 분석을 포함한 3문제 1벌의 API 정가입니다.' })}${roundHtml(r3, { ...opts, pdfSuffix: '-r3', intro: intro3, subject: '화학 반응식·밀도' })}</div>` : ''}
      <div data-cmp-round="2" hidden>${changeHtml(b.overview, r2.overview)}${roundHtml(r2, { ...opts, pdfSuffix: '-r2', intro })}</div>
      <div data-cmp-round="1" hidden>${roundHtml(b, opts)}</div>`;
  }

  // 1차 → 2차 for each setup: the score, the API price of a set and the time of a set.
  function changeHtml(one, two, { from = '1차', to = '2차', what = '같은 모델·같은 설정, 학습만 반영', note = '1차는 구성마다 여러 번 잰 평균, 2차는 1벌씩입니다 (한 번에 ±4/29 정도 흔들립니다). 세트 비용은 원본 분석을 포함한 3문제 1벌의 API 정가입니다.' } = {}) {
    const krw = (usd) => `${(Math.round((usd * two.pricing.krwPerUsd) / 10) * 10).toLocaleString()}원`;
    // Only the setups measured in 2차 (DeepSeek left out, the user 2026-10-16).
    const rows = ALL.filter((m) => two.compare.models[m.id])
      .sort((x, y) => (two.compare.models[y.id]?.score ?? -1) - (two.compare.models[x.id]?.score ?? -1))
      .map((m) => {
        const a = one.compare.models[m.id]; const c = two.compare.models[m.id];
        const delta = (x, y, unit, lowerIsBetter) => {
          if (x == null || y == null) return '';
          const d = Math.round(y - x);
          if (!d) return '<div class="muted tiny">같음</div>';
          const good = lowerIsBetter ? d < 0 : d > 0;
          return `<div class="tiny ${good ? 'save-up' : 'save-down'}">${d > 0 ? '+' : '−'}${Math.abs(d).toLocaleString()}${unit}</div>`;
        };
        const price = (q) => (m.pay === 'pc' ? 0 : q?.cost?.setUsd);
        const cell = (q, fmt) => (q ? fmt(q) : '<span class="muted small">측정 못 함</span>');
        const won = (q) => (m.pay === 'pc' ? '0원' : q.cost?.setUsd != null ? krw(q.cost.setUsd) : '-');
        const usdA = price(a); const usdC = price(c);
        return `<tr><th>${m.name}${m.trained ? ' <span class="chip run">학습됨</span>' : ''}</th>
          <td>${cell(a, (q) => `${q.score}점${q.runs > 1 ? `<div class="muted tiny">${q.runs}회 평균</div>` : ''}`)}</td>
          <td><b>${c.score}점</b>${delta(a?.score, c.score, '점')}</td>
          <td>${cell(c, (q) => `${q.metrics.clear.pass}/${q.metrics.clear.total}`)}</td>
          <td>${cell(a, won)}</td>
          <td><b>${won(c)}</b>${usdA != null && usdC != null && usdA > 0 ? `<div class="tiny ${usdC <= usdA ? 'save-up' : 'save-down'}">${usdC <= usdA ? '−' : '+'}${Math.abs(Math.round((usdC / usdA - 1) * 100))}%</div>` : ''}</td>
          <td>${a ? `${a.minutes}분` : '-'} → <b>${c.minutes}분</b></td></tr>`;
      }).join('');
    return `<div class="panel"><h2>${from} → ${to} <span class="muted small">${what}</span></h2>
      <div class="table-wrap"><table class="cmp-table">
        <tr><th>구성</th><th>${from} 점수</th><th>${to} 점수</th><th>${to} 바로 쓸 문제</th><th>${from} 세트 (API 정가)</th><th>${to} 세트 (API 정가)</th><th>세트 시간</th></tr>
        ${rows}
      </table></div>
      <p class="muted small">${note}</p></div>`;
  }

  function roundHtml(b, { pdfBase = 'api/compare', balance = false, pdfSuffix = '', intro = '', subject = '화학 몰질량' } = {}) {
    const fb = b.feedback;
    const MARK = { ok: ['ok', '✓'], partial: ['warn', '△'], no: ['bad', '✕'] };
    const allItems = fb ? fb.groups.flatMap((g) => g.items) : [];
    // How faithfully a model met the checklist: ✓ counts 1, △ half.
    const fidelity = (m) => {
      const marks = allItems.map((it) => fb.models[m.key]?.[it.id]?.[0]);
      if (!fb?.models[m.key]) return null;
      const n = (g) => marks.filter((x) => x === g).length;
      return { pct: Math.round(((n('ok') + n('partial') / 2) / allItems.length) * 100), ok: n('ok'), partial: n('partial'), no: n('no') };
    };
    const tone = (pct) => (pct >= 90 ? 'ok' : pct >= 60 ? 'warn' : 'bad');
    // One tab: the overview, the checklist and the sets of the given models, laid out the same way in both tabs.
    const checklist = (sub) => (fb ? `<div class="panel cv2-check">
        <h2>요구사항 체크리스트</h2>
        <p class="swipe-hint mobile-only">표는 옆으로 밀어서 모델별로 볼 수 있습니다.</p>
        <div class="table-wrap"><table class="cv2-table" style="min-width:${170 + sub.models.length * 125}px">
          <tr><th>항목</th>${sub.models.map((m) => { const f = fidelity(m); return `<th><div>${esc(m.label)}</div>${f ? `<div class="cv2-score ${tone(f.pct)}">${f.pct}%</div><div class="muted tiny">✓ ${f.ok} · △ ${f.partial} · ✕ ${f.no}</div>` : ''}</th>`; }).join('')}</tr>
          ${fb.groups.map((g) => `<tr class="grp"><td colspan="${sub.models.length + 1}"><span class="grp-label">${esc(g.title)}</span></td></tr>${g.items.map((it) => `<tr><th>${esc(it.text)}</th>${sub.models.map((m) => {
            const [grade, note] = fb.models[m.key]?.[it.id] || ['', ''];
            const [t, mark] = MARK[grade] || ['', '-'];
            return `<td><div class="cv2-mark ${t}">${mark}</div><div class="cv2-note">${esc(note)}</div></td>`;
          }).join('')}</tr>`).join('')}`).join('')}
        </table></div>
        <p class="muted small">✓ 충족 · △ 일부 충족 · ✕ 못 함. 충실도는 ✓를 1, △를 0.5로 셉니다. ${esc(fb.by)}.</p>
        ${fb.quote ? `<details class="cv2-quote" data-k="fb-quote"><summary>받은 피드백 원문 보기</summary><blockquote>${esc(fb.quote)}</blockquote></details>` : ''}
      </div>` : '');
    const pane = (keys, names, intro, extra = '', { costPanels = true } = {}) => {
      // The checklist and the results by the same order as the cards: highest score first.
      const score = (m) => b.overview?.compare?.models?.[m.key]?.score ?? -1;
      const sub = { ...b, models: b.models.filter((m) => keys.includes(m.key)).map((m) => ({ ...m, label: names[m.key] || m.label })).sort((x, y) => score(y) - score(x)) };
      return `
      <div class="panel">
        <h2>품질과 비용 한눈에</h2>
        ${overviewHtml(b.overview, { balance, ids: keys, names, costs: costPanels })}
      </div>
      ${extra}
      ${costPanels ? subscriptionHtml(b.overview, keys) : ''}
      ${costPanels && keys.some((k) => MIXES.some((x) => x.id === k)) ? scenarioHtml(b.overview) : ''}
      <h2 class="cv2-h">${subject} 문제로 자세히 보기</h2>
      <p class="muted">${intro}</p>
      <div class="panel cv2-orig"><span class="muted small">원본</span>
        <img data-zoom src="${b.original.problemImage}" alt="원본 문제">${b.original.solutionImage ? `<img data-zoom src="${b.original.solutionImage}" alt="교사 해설">` : ''}
        <span class="muted small">사진을 누르면 크게 볼 수 있습니다.</span></div>
      ${checklist(sub)}
      <h2 class="cv2-h">모델별 결과와 PDF</h2>
      ${resultsHtml(sub, { pdfBase, fidelity })}`;
    };
    const ORIGINAL = '같은 ' + subject.replace(/^화학 /, '') + ' 원본 문제와 해설을 모델마다 똑같이 넣어, 연습 문제 3개(STEP 1 연습, STEP 1~2 연습, 최종 문제)를 만든 결과입니다. PDF에는 원본과 만든 문제·해설이 모두 들어 있습니다.';
    const parts = allHtml(b.overview, b.feedback, subject);
    const allKeys = ALL.map((m) => m.id).filter((id) => b.overview?.compare?.models?.[id]);
    const allNames = Object.fromEntries(ALL.map((m) => [m.id, m.name]));
    const allScore = (m) => b.overview?.compare?.models?.[m.key]?.score ?? -1;
    const allSub = { ...b, models: b.models.filter((m) => allKeys.includes(m.key)).map((m) => ({ ...m, label: allNames[m.key] || m.label })).sort((x, y) => allScore(y) - allScore(x)) };
    const all = parts ? parts.cards + parts.price + parts.subscription + parts.chart
      + '<div class="panel"><h2>문제를 얼마나 잘 만드나 <span class="muted small">만들려고 한 문제 하나하나 기준</span></h2>' + overviewHtml(b.overview, { balance, ids: allKeys, names: allNames, costs: false, cards: false }) + '</div>'
      // The molar-mass rounds' history: another original's set cost is not its baseline.
      + (subject === '화학 몰질량' ? strategyHtml(b.overview) : '')
      + '<h2 class="cv2-h">' + subject + ' 문제로 자세히 보기</h2><p class="muted">' + ORIGINAL + (intro ? ' ' + intro + '</p>' : ' 세트: Opus 단독 2026-10-06, DeepSeek 2026-09-30, Opus + Haiku 10-12 R12(4회 평균), Opus + Qwen + 시스템 10-13 11회차(11~13회차 평균), Qwen 3.8 학습됨 + 시스템 10-14 4회차(3·4회차 평균, 점수는 Opus가 다시 판정). 혼합과 Qwen 3.8 세트는 Claude·Gemini 독립 검수에서 정답 3/3입니다.</p>')
      + '<div class="panel cv2-orig"><span class="muted small">원본</span><img data-zoom src="' + b.original.problemImage + '" alt="원본 문제">' + (b.original.solutionImage ? '<img data-zoom src="' + b.original.solutionImage + '" alt="교사 해설">' : '') + '<span class="muted small">사진을 누르면 크게 볼 수 있습니다.</span></div>'
      + checklist(allSub)
      + '<h2 class="cv2-h">모델별 결과와 PDF</h2>' + resultsHtml(allSub, { pdfBase, fidelity, pdfSuffix }) : '';
    return all;
  }

  // Each tab has its own address to pass on: the app's #/compare?tab=mixed, the public page's compare.html#mixed.
  const inApp = () => location.hash.startsWith('#/compare');
  // 전체 비교 first; the others by address.
  const openTab = () => (/^#mixed$|[?&]tab=mixed(&|$)/.test(location.hash) ? 'mixed' : /^#single$|[?&]tab=single(&|$)/.test(location.hash) ? 'single' : 'all');
  function showTab(name) {
    document.querySelectorAll('[data-cmp-tab]').forEach((x) => x.classList.toggle('on', x.dataset.cmpTab === name));
    document.querySelectorAll('[data-cmp-pane]').forEach((x) => { x.hidden = x.dataset.cmpPane !== name; });
  }
  // The 단독 모델 / 혼합 모델 tabs (the page is built from HTML, so one listener on the document). The address follows
  // the tab without a new history entry (the app's router does not see a replaced address).
  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-cmp-tab]');
    if (!t) return;
    showTab(t.dataset.cmpTab);
    const name = t.dataset.cmpTab;
    const hash = inApp() ? `#/compare${name === 'all' ? '' : `?tab=${name}`}` : name === 'all' ? '' : `#${name}`;
    history.replaceState(null, '', location.pathname + location.search + hash);
  });
  // A shared address opened on a page already showing the comparison (e.g. compare.html#mixed pasted in the same tab).
  window.addEventListener('hashchange', () => { if (document.querySelector('[data-cmp-tab]') && (inApp() || !location.hash.startsWith('#/'))) showTab(openTab()); });

  // 1차 / 2차 / 3차: the newest first; the address keeps another (#/compare?round=1, compare.html#round1) without a new history entry.
  // The newest round unless the address names one (?round=2, #round2).
  const openRound = () => { const m = /[?&]round=(d)(&|$)|^#round(d)$/.exec(location.hash); const n = m && (m[1] || m[3]); const tabs = [...document.querySelectorAll('[data-cmp-round-tab]')].map((x) => x.dataset.cmpRoundTab); return n && tabs.includes(n) ? n : tabs[0]; };
  function showRound(n) {
    document.querySelectorAll('[data-cmp-round-tab]').forEach((x) => x.classList.toggle('on', x.dataset.cmpRoundTab === n));
    document.querySelectorAll('[data-cmp-round]').forEach((x) => { x.hidden = x.dataset.cmpRound !== n; });
  }
  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-cmp-round-tab]');
    if (!t) return;
    const n = t.dataset.cmpRoundTab;
    showRound(n);
    const newest = document.querySelector('[data-cmp-round-tab]')?.dataset.cmpRoundTab;
    const hash = inApp() ? `#/compare${n === newest ? '' : `?round=${n}`}` : n === newest ? '' : `#round${n}`;
    history.replaceState(null, '', location.pathname + location.search + hash);
  });
  // Called by the app and the public page once the page is in the document.
  const ready = () => { if (document.querySelector('[data-cmp-round-tab]')) showRound(openRound()); };

  window.EMCompare = { pageHtml, resultsHtml, ready };
})();
