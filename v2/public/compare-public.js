'use strict';
// Public 모델 비교 page (compare.html): each model's results and its PDF, from login-free routes, nothing else.
(async function () {
  const view = document.getElementById('view');
  try {
    const res = await fetch('api/public/compare');
    if (!res.ok) throw new Error(res.status);
    const b = await res.json();
    view.innerHTML = `<h1>모델 비교 — 화학 몰질량</h1>
      <p class="muted">같은 몰질량 원본 문제와 해설로 모델마다 연습 문제 3개(STEP 1 연습, STEP 1~2 연습, 최종 문제)를 만든 결과입니다. PDF에는 원본과 만든 문제·해설이 모두 들어 있습니다.</p>
      ${window.EMCompare.resultsHtml(b, { pdfBase: 'api/public/compare' })}`;
  } catch {
    view.innerHTML = '<h1>모델 비교</h1><div class="panel muted">결과를 불러오지 못했습니다. 잠시 후 다시 열어 주세요.</div>';
  }
}());
