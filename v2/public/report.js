'use strict';
(async function () {
  const { escape: esc, rich, circled } = window.EM;
  const doc = document.getElementById('doc');
  const id = new URLSearchParams(location.search).get('job');
  const strip = (html) => html.replace(/^<p>|<\/p>$/g, '');
  let job;
  try {
    const res = await fetch('api/jobs/' + encodeURIComponent(id || ''), { credentials: 'same-origin' });
    const data = await res.json();
    if (!res.ok) throw new Error(res.status === 401 ? '로그인이 필요합니다. 메인 화면에서 접속한 뒤 다시 열어 주세요.' : data.error);
    job = data;
  } catch (e) {
    doc.innerHTML = `<p class="note bad">${esc(e.message)}</p>`;
    return;
  }
  const m = job.material;
  const choices = (p) => (p.choices?.length ? `<div class="choices">${p.choices.map((c, i) => `<div class="c"><span>${circled(i + 1)}</span><span class="rich">${strip(rich(c))}</span></div>`).join('')}</div>` : '');

  function draw() {
    const withOriginal = document.getElementById('opt-original').checked;
    const withSolution = document.getElementById('opt-solution').checked;
    const withReview = document.getElementById('opt-review').checked;
    const items = job.items.filter((i) => i.problem && (withReview || !['needs_review', 'failed'].includes(i.status)));
    const flag = (i) => (i.status === 'needs_review' ? '<span class="review-flag">[교사 검토 필요]</span>'
      : i.status === 'failed' ? `<span class="review-flag">[검증 미완료: ${esc(i.error || '')}]</span>` : '');
    doc.innerHTML = `
      <h1>${esc(m.title)} — 단계별 연습 ${items.length}문제</h1>
      <p class="muted small">${esc([m.subject, m.topic].filter(Boolean).join(' · '))} · ${job.options.mode === 'integrated' ? '통합 변형' : '수치 변형'} · 모델: ${esc({ deepseek: 'DeepSeek V4 Flash', gemma: 'Gemma 4 12B', relay: 'Claude Opus 5.5' }[job.options.provider] || 'DeepSeek V4 Flash')} · ${new Date(job.createdAt).toLocaleDateString('ko-KR')}</p>
      ${withOriginal ? `
        <h2>원본 문제</h2>
        <img class="orig-img" src="api/files/${m.images.problem}" alt="원본 문제">
        ${m.images.solution && !m.images.sameImage ? `<h2>원본 해설</h2><img class="orig-img" src="api/files/${m.images.solution}" alt="원본 해설">` : ''}
        <h2>원본 풀이 로직 — STEP ${m.steps.length}개</h2>
        ${m.steps.map((s, i) => `<div class="step"><div class="head"><span class="badge">STEP ${i + 1}</span>${strip(rich(s.title))}</div>
          ${s.technique ? `<div class="meta"><b>핵심 기법</b> ${strip(rich(s.technique))}</div>` : ''}<div class="rich">${rich(s.work)}</div>
          ${s.result ? `<div class="meta"><b>결론</b> ${strip(rich(s.result))}</div>` : ''}</div>`).join('')}
        <div class="page-break"></div>` : ''}
      <h2>연습 문제</h2>
      ${items.map((i, n) => `<div class="q"><div class="qhead">${n + 1}. <span class="tag">${esc(i.label)}</span>${flag(i)}</div>
        <div class="rich">${rich(i.problem.text)}</div>
        ${i.problem.figure ? `<div class="note info"><b>그림</b><div class="rich">${rich(i.problem.figure)}</div></div>` : ''}
        ${choices(i.problem)}</div>`).join('')}
      ${withSolution ? `<div class="page-break"></div><h2>정답과 해설</h2>
        ${items.map((i, n) => `<div class="ans"><div class="qhead">${n + 1}. 정답 ${i.problem.answer ? circled(i.problem.answer) : ''} <span class="tag muted small">${esc(i.label)}</span>${flag(i)}</div>
          ${(i.solution?.steps || []).map((s) => `<div class="step"><div class="head">${s.step ? `<span class="badge">STEP ${s.step}</span>` : ''}${strip(rich(s.title))}</div><div class="rich">${rich(s.work)}</div></div>`).join('')}
          ${i.solution?.summary ? `<p><b>정리</b> ${strip(rich(i.solution.summary))}</p>` : ''}</div>`).join('')}` : ''}`;
    document.title = `${m.title} 학습지`;
  }
  ['opt-original', 'opt-solution', 'opt-review'].forEach((x) => document.getElementById(x).addEventListener('change', draw));
  document.getElementById('print').addEventListener('click', () => window.print());
  draw();
})();
