'use strict';
// Public 모델 비교 page (compare.html): the same view as the app's, from login-free routes, with nothing else of the
// system attached.
(async function () {
  const view = document.getElementById('view');
  try {
    const res = await fetch('api/public/compare');
    if (!res.ok) throw new Error(res.status);
    const b = await res.json();
    view.innerHTML = '<h1>모델 비교</h1>' + window.EMCompare.pageHtml(b, { pdfBase: 'api/public/compare' });
  } catch {
    view.innerHTML = '<h1>모델 비교</h1><div class="panel muted">비교 자료를 불러오지 못했습니다. 잠시 후 다시 열어 주세요.</div>';
  }
  // Tap a scan to see it full size.
  document.addEventListener('click', (e) => {
    const img = e.target.closest('img[data-zoom]');
    if (!img) return;
    const el = document.createElement('div');
    el.className = 'zoom';
    const big = document.createElement('img');
    big.src = img.src; big.alt = '확대 이미지';
    el.appendChild(big);
    el.addEventListener('click', () => el.remove());
    document.body.appendChild(el);
  });
}());
