'use strict';
// The 모델 비교 page body, shared by the app (#/compare, after login) and the public page (compare.html, no login).
(function () {
  const esc = window.EM.escape;

  // One comparison of the models: a problem-level quality score with its 95% range, the items behind it, what one
  // problem costs, how long a set takes and when each can be used.
  function overviewHtml(sys, { selectable = false, balance = false } = {}) {
    const c = sys.cost; const cmp = sys.compare;
    const krw = (usd) => `${(Math.round((usd * c.pricing.krwPerUsd) / 10) * 10).toLocaleString()}원`;
    const pct = (s) => (s && s.total ? Math.round((s.pass / s.total) * 100) : null);
    const MODELS = [
      { id: 'relay', name: 'Claude Opus 5.5', price: 'opus', use: selectable ? '선택 가능' : '지금은 비교 평가만 (화면에서 선택 불가)' },
      { id: 'deepseek', name: 'DeepSeek V4 Flash', price: 'deepseek', use: '언제든 사용 (인터넷)' },
      { id: 'qwen36', name: 'Qwen 3.6-35B (PC)', price: null, use: '선생님 PC가 켜져 있을 때만 (지금 쓰는 PC 모델)' },
      { id: 'gemma12', name: 'Gemma 4 12B (PC)', price: null, use: '선생님 PC가 켜져 있을 때만 (이전 PC 모델)' },
    ].filter((m) => cmp.models[m.id]);
    if (!MODELS.length) return '<p class="muted small">아직 평가 결과가 없습니다. 평가를 돌리면 모델별 비교가 표시됩니다.</p>';
    const quality = (m) => cmp.models[m.id].score ?? 0;
    const best = Math.max(...MODELS.map(quality));
    const paid = MODELS.filter((m) => m.price && c.perProblem);
    const cheapest = paid.length ? paid.reduce((a, m) => (c.perProblem[m.price] < c.perProblem[a.price] ? m : a)) : null;
    const tag = (m) => [quality(m) === best ? '<span class="chip ok">문제 품질 1위</span>' : '', m === cheapest ? '<span class="chip run">저렴한 유료</span>' : '', !m.price ? '<span class="chip ok">무료</span>' : ''].join(' ');
    const range = (r) => `약 ${krw(r[0])} ~ ${krw(r[1])}`;
    const costOf = (m) => (!m.price ? '0원' : m.price === 'opus' && c.opusRange ? range(c.opusRange.problem) : c.perProblem ? `약 ${krw(c.perProblem[m.price])}` : '-');
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
          <div><span>문제 1개 비용</span><b>${costOf(m)}</b></div>
          <div><span>문제 1개 생성</span><b>${q.time?.perProblem != null ? `약 ${q.time.perProblem}분` : '-'}</b></div>
          <div><span>3문제 세트 (분석 포함)</span><b>약 ${q.minutes}분</b></div>
          <div><span>사용 조건</span><b class="small">${m.use}</b></div>
        </div></div>`;
    }).join('');
    const scoreRow = `<tr class="cmp-total"><th>문제 품질 점수<div class="muted tiny">아래 항목의 가중 평균, 못 만든 문제는 0점</div></th>${MODELS.map((m) => { const q = cmp.models[m.id]; return `<td><b class="cmp-pct ${tone(q.score)}">${q.score}점</b><div class="muted tiny">범위 ${q.low}~${q.high} · ${q.problems}문제</div></td>`; }).join('')}</tr>`;
    const rows = cmp.metrics.map((x) => `<tr><th>${x.label}${x.weight ? `<div class="muted tiny">가중치 ${x.weight}</div>` : ''}</th>${MODELS.map((m) => cell(cmp.models[m.id].metrics[x.id])).join('')}</tr>`).join('');
    const costRow = `<tr><th>문제 1개 비용</th>${MODELS.map((m) => `<td><b>${costOf(m)}</b>${m.price && c.perProblemRange && krw(c.perProblemRange[m.price][0]) !== krw(c.perProblemRange[m.price][1]) ? `<div class="muted tiny">${krw(c.perProblemRange[m.price][0])} ~ ${krw(c.perProblemRange[m.price][1])}</div>` : ''}</td>`).join('')}</tr>`;
    const mins = (v) => (v == null ? '<td class="muted small">-</td>' : `<td><b>${v}분</b></td>`);
    const timeRow = (label, note, get) => `<tr><th>${label}${note ? `<div class="muted tiny">${note}</div>` : ''}</th>${MODELS.map((m) => mins(get(cmp.models[m.id].time || {}))).join('')}</tr>`;
    const timeRows = [
      timeRow('원본 읽기·분석', '사진 판독과 STEP 정리', (t) => t.analysis),
      timeRow('문제 1개 만들기', '설계 + 독립 검토 + 자동 수정, 못 만든 문제 포함', (t) => t.perProblem),
      timeRow('· STEP 1 연습', '', (t) => t.stages?.s1),
      timeRow('· STEP 1~2 연습', '', (t) => t.stages?.s12),
      timeRow('· 최종 문제', '', (t) => t.stages?.final),
      `<tr><th>문제당 자동 수정 횟수</th>${MODELS.map((m) => { const r = cmp.models[m.id].time?.repairs; return r == null ? '<td class="muted small">-</td>' : `<td><b>${r}회</b></td>`; }).join('')}</tr>`,
      `<tr><th>3문제 세트 전체<div class="muted tiny">원본 분석 포함</div></th>${MODELS.map((m) => mins(cmp.models[m.id].minutes)).join('')}</tr>`,
    ].join('');
    const setRow = c.perProblem ? `<tr><th>3문제 세트 비용<div class="muted tiny">원본 분석 포함</div></th>${MODELS.map((m) => `<td><b>${!m.price ? '0원' : m.price === 'opus' && c.opusRange ? range(c.opusRange.set) : `약 ${krw(c.perAnalysis[m.price] + c.perProblem[m.price] * 3)}`}</b></td>`).join('')}</tr>` : '';
    const when = Object.values(cmp.models).map((q) => q.when.slice(0, 8)).sort().pop();
    return `<p class="swipe-hint mobile-only">카드를 옆으로 넘기면 다른 모델을 볼 수 있습니다.</p>
      <div class="sys-cards cmp-cards">${cards}</div>
      <p class="swipe-hint mobile-only">표는 옆으로 밀어서 모델별로 볼 수 있습니다.</p>
      <div class="table-wrap"><table class="cmp-table">
        <tr><th></th>${MODELS.map((m) => `<th>${m.name}</th>`).join('')}</tr>
        <tr class="grp"><td colspan="${MODELS.length + 1}"><span class="grp-label">문제를 얼마나 잘 만드나 (만들려고 한 문제 하나하나를 기준으로)</span></td></tr>
        ${scoreRow}${rows}
        <tr class="grp"><td colspan="${MODELS.length + 1}"><span class="grp-label">시간 (평가 회차 평균)</span></td></tr>
        ${timeRows}
        <tr class="grp"><td colspan="${MODELS.length + 1}"><span class="grp-label">비용</span></td></tr>
        ${costRow}${setRow}
      </table></div>
      <p class="muted small">화학 몰질량 문제를 모델만 바꿔 똑같은 과정으로 만들고, 자동 검토 결과를 문제 하나하나 채점한 것입니다 (${when.slice(0, 4)}.${when.slice(4, 6)}.${when.slice(6, 8)} 기준). <b>문제 품질 점수</b>는 문제마다 항목별 가중치(정답·계산 30, STEP 범위 15, 풀이 방법 15, 조건 10, 지침 10, 바로 사용 10, 최종 문제의 새 구조 10)로 채점해 평균한 값이고, 만들지 못한 문제는 0점으로 셉니다. 같은 모델도 돌릴 때마다 결과가 달라서 여러 번 평가한 모델은 모든 회차를 합쳤습니다. <b>믿을 수 있는 범위</b>는 평가한 문제 수로 본 95% 신뢰 구간(윌슨 구간)입니다. 문제가 적으면 넓어지므로, 범위가 겹치는 모델끼리는 차이가 확실하지 않습니다. 최종 문제의 새 구조는 한 번만 평가한 모델이면 직접 비교한 판정을 씁니다. 자동 검토는 2026-09-30에 강화되었습니다(건너뛸 수 있는 STEP, 숫자만 바꾼 최종 문제, 선생님 STEP 제목, 표에 드러난 남은 물질까지 확인). '현재 검토 기준' 모델은 그 뒤의 평가만, '이전 검토 기준' 모델은 그 전 평가로 채점해 이전 모델의 점수가 실제보다 후할 수 있습니다.
      <b>시간</b>은 작업 기록의 시각으로 잰 것으로, 문제 하나의 시간은 설계부터 독립 검토·자동 수정을 거쳐 판정이 나올 때까지입니다. DeepSeek은 인터넷 API, Qwen·Gemma는 선생님 PC(RTX 5080)에서 잰 시간이고, Opus는 API가 아닌 세션 중계로 돌려 실제 API 속도와는 다를 수 있습니다.
      비용은 실제로 쓴 토큰 양에 공개 단가(DeepSeek 입력 $${c.pricing.deepseek.input}·출력 $${c.pricing.deepseek.output}, Opus 5.5 입력 $${c.pricing.opus.input}·출력 $${c.pricing.opus.output} / 100만 토큰)와 1달러 = ${c.pricing.krwPerUsd.toLocaleString()}원을 적용했고, 검토·수정 비용까지 포함합니다. ${c.opusRange ? 'Opus는 토큰 수가 기록되지 않는 방식으로 돌렸기 때문에, 실제로 주고받은 글자 수로 추정한 범위입니다 (생각 토큰은 측정하지 못해 답변의 0~2배로 잡음).' : 'Opus는 DeepSeek과 같은 양의 토큰을 쓴다고 본 추정입니다.'}${balance ? ' DeepSeek 충전 잔액: <span id="balance">확인 중…</span>' : ''}</p>`;
  }

  // One row per model: each problem's result and the PDF. The public page shows only this.
  function resultsHtml(b, { pdfBase = 'api/compare', fidelity = null } = {}) {
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
        <div class="cv2-pdf">${m.pdf ? `<a class="button primary" href="${pdfBase}/${b.id}/pdf/${m.key}" download>PDF 다운로드</a>` : '<span class="muted small">PDF 없음</span>'}</div>
      </div>`;
    };
    return `<div class="cv2">${b.models.map(row).join('')}</div>
      <p class="muted small">✓ 됨: 자동 검토를 통과해 바로 쓸 수 있음 (확인할 점은 가볍게 한 번 보시면 되는 내용) · △ 검토 필요: 만들었지만 선생님 확인이 필요함 · ✕ 안 됨: 문제를 만들지 못함</p>`;
  }

  // The same molar-mass original made into a problem set by each model: what worked, what did not, the PDF.
  // pdfBase: where the PDFs are served (the app's API or the public one); balance: show DeepSeek's balance slot.
  function pageHtml(b, { pdfBase = 'api/compare', selectable = false, balance = false } = {}) {
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
    return `
      <div class="panel">
        <h2>품질과 비용 한눈에</h2>
        ${overviewHtml(b.overview, { selectable, balance })}
      </div>
      <h2 class="cv2-h">화학 몰질량 문제로 자세히 보기</h2>
      <p class="muted">같은 몰질량 원본 문제와 해설을 네 모델에 똑같이 넣어, 연습 문제 3개(STEP 1 연습, STEP 1~2 연습, 최종 문제)를 만든 결과입니다. PDF에는 원본과 만든 문제·해설이 모두 들어 있습니다. Opus와 DeepSeek 세트는 2026-09-30 강화된 자동 검토로 다시 만든 것이고, 문제마다 수치를 직접 다시 계산해 확인했습니다. '교사 검토 필요'로 표시된 문제는 PDF에도 표시됩니다.</p>
      <div class="panel cv2-orig"><span class="muted small">원본</span>
        <img data-zoom src="${b.original.problemImage}" alt="원본 문제">${b.original.solutionImage ? `<img data-zoom src="${b.original.solutionImage}" alt="교사 해설">` : ''}
        <span class="muted small">사진을 누르면 크게 볼 수 있습니다.</span></div>
      ${fb ? `<div class="panel cv2-check">
        <h2>요구사항 체크리스트</h2>
        <p class="swipe-hint mobile-only">표는 옆으로 밀어서 모델별로 볼 수 있습니다.</p>
        <div class="table-wrap"><table class="cv2-table">
          <tr><th>항목</th>${b.models.map((m) => { const f = fidelity(m); return `<th><div>${esc(m.label)}</div>${f ? `<div class="cv2-score ${tone(f.pct)}">${f.pct}%</div><div class="muted tiny">✓ ${f.ok} · △ ${f.partial} · ✕ ${f.no}</div>` : ''}</th>`; }).join('')}</tr>
          ${fb.groups.map((g) => `<tr class="grp"><td colspan="${b.models.length + 1}"><span class="grp-label">${esc(g.title)}</span></td></tr>${g.items.map((it) => `<tr><th>${esc(it.text)}</th>${b.models.map((m) => {
            const [grade, note] = fb.models[m.key]?.[it.id] || ['', ''];
            const [t, mark] = MARK[grade] || ['', '-'];
            return `<td><div class="cv2-mark ${t}">${mark}</div><div class="cv2-note">${esc(note)}</div></td>`;
          }).join('')}</tr>`).join('')}`).join('')}
        </table></div>
        <p class="muted small">✓ 충족 · △ 일부 충족 · ✕ 못 함. 충실도는 ✓를 1, △를 0.5로 셉니다. ${esc(fb.by)}.</p>
        ${fb.quote ? `<details class="cv2-quote" data-k="fb-quote"><summary>받은 피드백 원문 보기</summary><blockquote>${esc(fb.quote)}</blockquote></details>` : ''}
      </div>` : ''}
      <h2 class="cv2-h">모델별 결과와 PDF</h2>
      ${resultsHtml(b, { pdfBase, fidelity })}`;
  }

  window.EMCompare = { pageHtml, resultsHtml };
})();
