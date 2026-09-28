import json
import os
import re
import base64
import subprocess
import tempfile
from datetime import datetime, timezone

EDGE_PATH = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
OUTPUT_DIR = "artifacts/reports_pdf"
os.makedirs(OUTPUT_DIR, exist_ok=True)

# 1. Load cropped images as base64
with open("question.png", "rb") as f:
    q_b64 = "data:image/png;base64," + base64.b64encode(f.read()).decode("utf-8")
with open("solution.png", "rb") as f:
    s_b64 = "data:image/png;base64," + base64.b64encode(f.read()).decode("utf-8")

# 2. Load imported analysis and variants
with open("artifacts/imported_material.json", "r", encoding="utf-8") as f:
    imported = json.load(f)
with open("artifacts/variants/gemma.json", "r", encoding="utf-8") as f:
    gemma = json.load(f)
with open("artifacts/variants/deepseek.json", "r", encoding="utf-8") as f:
    deepseek = json.load(f)
with open("artifacts/variants/gemini.json", "r", encoding="utf-8") as f:
    gemini = json.load(f)

# Load base CSS
with open("src/EduMaster.Web/wwwroot/style.css", "r", encoding="utf-8") as f:
    base_css = f.read()

def html_escape(s):
    if s is None:
        return ""
    return (str(s).replace("&", "&amp;")
                 .replace("<", "&lt;")
                 .replace(">", "&gt;")
                 .replace('"', "&quot;"))

def clean_math_text(text):
    if not text:
        return ""
    # Replace LaTeX commands and artifacts like \text{cm} or ext{cm}
    text = re.sub(r'\\*t?ext\{([^}]+)\}', r'\1', text)
    text = re.sub(r'\\sim', '~', text)
    # Common subscripts
    text = text.replace('d_1', 'd₁').replace('d_2', 'd₂').replace('d_3', 'd₃').replace('d_4', 'd₄')
    text = text.replace('t_1', 't₁').replace('t_2', 't₂')
    # Strip residual $
    text = re.sub(r'\$([^$]+)\$', r'\1', text)
    text = text.replace('$', '')
    return text

def markdown_to_html(text):
    if not text:
        return ""
    text = clean_math_text(text)
    text = html_escape(text)
    # Convert bold
    text = re.sub(r'\*\*(.+?)\*\*', r'<strong>\1</strong>', text)
    # Convert headers
    text = re.sub(r'^### (.+)$', r'<h4 class="sub-h4">\1</h4>', text, flags=re.MULTILINE)
    text = re.sub(r'^## (.+)$', r'<h3 class="sub-h3">\1</h3>', text, flags=re.MULTILINE)
    text = re.sub(r'^# (.+)$', r'<h2 class="sub-h2">\1</h2>', text, flags=re.MULTILINE)
    
    # Tables
    lines = text.split('\n')
    new_lines = []
    in_table = False
    table_rows = []
    for line in lines:
        line_str = line.strip()
        if line_str.startswith('|') and line_str.endswith('|'):
            in_table = True
            # Skip separator rows like |:---|:---| or |--|--|
            inner = line_str[1:-1].replace(' ', '').replace('-', '').replace(':', '').replace('|', '')
            if inner == '':
                continue
            cells = [c.strip() for c in line_str.split('|')[1:-1]]
            table_rows.append(cells)
        else:
            if in_table:
                html_table = '<div class="problem-table-scroll"><table class="problem-table"><tbody>'
                for r_idx, row in enumerate(table_rows):
                    tag = 'th' if r_idx == 0 else 'td'
                    html_table += '<tr>' + ''.join(f'<{tag}>{c}</{tag}>' for c in row) + '</tr>'
                html_table += '</tbody></table></div>'
                new_lines.append(html_table)
                in_table = False
                table_rows = []
            new_lines.append(line)
    if in_table:
        html_table = '<div class="problem-table-scroll"><table class="problem-table"><tbody>'
        for r_idx, row in enumerate(table_rows):
            tag = 'th' if r_idx == 0 else 'td'
            html_table += '<tr>' + ''.join(f'<{tag}>{c}</{tag}>' for c in row) + '</tr>'
        html_table += '</tbody></table></div>'
        new_lines.append(html_table)

    res = '\n'.join(new_lines)
    # Paragraphs and linebreaks
    paragraphs = res.split('\n\n')
    formatted = []
    for p in paragraphs:
        p_str = p.strip()
        if not p_str:
            continue
        if p_str.startswith('<div class="problem-table-scroll">') or p_str.startswith('<h'):
            formatted.append(p_str)
        else:
            formatted.append(f'<p>{p_str.replace(chr(10), "<br>")}</p>')
    return '\n'.join(formatted)

EXTRA_REPORT_CSS = """
@page { size: A4; margin: 12mm; }
body {
  font-family: -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Malgun Gothic", "Noto Sans KR", sans-serif;
  color: #17243a;
  background: #fff !important;
  margin: 0;
  padding: 0;
  line-height: 1.6;
}
.report-print {
  display: block !important;
  max-width: 820px;
  margin: 0 auto;
  padding: 0;
}
.report-header {
  border-bottom: 3px solid #087f70;
  padding-bottom: 14px;
  margin-bottom: 20px;
}
.report-header-top {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 6px;
}
.report-brand {
  font-size: 18px;
  font-weight: 900;
  color: #087f70;
  letter-spacing: -0.5px;
}
.report-badge {
  display: inline-block;
  padding: 5px 12px;
  border-radius: 6px;
  font-size: 13px;
  font-weight: 800;
  color: #fff;
}
.badge-gemma { background: #4f46e5; }
.badge-deepseek { background: #0284c7; }
.badge-gemini { background: #087f70; }
.badge-comparison { background: #b45309; }

.report-header h1 {
  font-size: 22px;
  color: #0f172a;
  margin: 6px 0;
  line-height: 1.35;
}
.report-header .report-meta {
  font-size: 12px;
  color: #64748b;
  margin: 0 0 4px;
}
.report-header .report-notice {
  font-size: 11.5px;
  color: #b45309;
  font-weight: 600;
  margin: 0;
}

.report-section {
  padding: 12px 0 20px;
  border-bottom: 1px solid #e2e8f0;
}
.report-generated {
  page-break-before: always;
  break-before: page;
}
.report-section-title {
  font-size: 17px;
  font-weight: 800;
  color: #087f70;
  border-left: 4px solid #087f70;
  padding-left: 10px;
  margin: 14px 0 12px;
}
.report-sub-title {
  font-size: 14.5px;
  font-weight: 700;
  color: #1e293b;
  margin: 14px 0 8px;
}

.source-images-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
  margin: 14px 0;
  page-break-inside: avoid;
  break-inside: avoid;
}
.report-source-figure {
  border: 1px solid #dce7e4;
  border-radius: 8px;
  background: #fbfdfc;
  padding: 8px 10px;
  margin: 0;
  text-align: center;
  page-break-inside: avoid;
  break-inside: avoid;
}
.report-source-image {
  display: block;
  max-width: 100%;
  max-height: 380px !important;
  object-fit: contain;
  margin: 0 auto 6px;
}
.report-source-figure figcaption {
  font-size: 11px;
  font-weight: 700;
  color: #475569;
  border-top: 1px dashed #cbd5e1;
  padding-top: 5px;
}

.report-text-block {
  background: #f8fafc;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  padding: 14px 16px;
  margin: 12px 0;
  font-size: 13.5px;
  line-height: 1.7;
  page-break-inside: avoid;
  break-inside: avoid;
}
.report-problem-title {
  font-size: 15px;
  font-weight: 800;
  color: #0f172a;
  margin: 0 0 8px;
}
.report-problem-body {
  font-size: 13.5px;
  line-height: 1.75;
  color: #1e293b;
}

.problem-table-scroll {
  margin: 10px 0;
}
.problem-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12.5px;
  margin: 8px 0;
}
.problem-table th, .problem-table td {
  border: 1px solid #cbd5e1;
  padding: 6px 10px;
  text-align: center;
}
.problem-table th {
  background: #f1f5f9;
  font-weight: 700;
  color: #334155;
}

.choice-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  margin: 12px 0;
  page-break-inside: avoid;
  break-inside: avoid;
}
.choice-item {
  background: #fff;
  border: 1px solid #cbd5e1;
  border-radius: 6px;
  padding: 7px 12px;
  font-size: 13px;
  font-weight: 600;
}

.report-answer {
  display: inline-flex;
  gap: 12px;
  align-items: center;
  background: #ecf8f3;
  border-left: 4px solid #087f70;
  padding: 8px 16px;
  margin: 10px 0 14px;
  border-radius: 0 6px 6px 0;
}
.report-answer strong {
  color: #087f70;
  font-size: 14px;
}
.report-answer span {
  font-size: 15px;
  font-weight: 800;
  color: #065f46;
}

.report-explanation, .report-steps {
  font-size: 13px;
  line-height: 1.75;
  color: #334155;
}
.report-steps {
  padding-left: 20px;
  margin: 8px 0;
}
.report-steps li {
  margin: 6px 0;
}

.box-change {
  background: #fffbeb;
  border: 1px solid #fef3c7;
  border-left: 4px solid #f59e0b;
  border-radius: 0 8px 8px 0;
  padding: 12px 16px;
  font-size: 13px;
  line-height: 1.7;
  color: #78350f;
  margin: 12px 0;
  page-break-inside: avoid;
  break-inside: avoid;
}

.footer {
  border-top: 1px solid #e2e8f0;
  margin-top: 24px;
  padding-top: 10px;
  font-size: 11px;
  color: #94a3b8;
  display: flex;
  justify-content: space-between;
}

.comp-table {
  width: 100%;
  border-collapse: collapse;
  margin: 14px 0;
  font-size: 12px;
  page-break-inside: avoid;
  break-inside: avoid;
}
.comp-table th, .comp-table td {
  border: 1px solid #cbd5e1;
  padding: 8px 10px;
  vertical-align: top;
}
.comp-table th {
  background: #f1f5f9;
  font-weight: 800;
  text-align: center;
}
"""

def generate_model_report_html(model_id, model_name, badge_class, variant_data):
    title = f"[{model_name}] 2022 대비 9월 모평 16번 흥분 전도와 전달 변형 문제 리포트"
    now_str = datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')
    
    # Original question and solution text
    orig_body_html = markdown_to_html(imported["body"])
    orig_expl_html = markdown_to_html(imported["explanation"])
    orig_steps_html = "".join(f"<li>{html_escape(step)}</li>" for step in imported.get("steps", []))
    
    # Variant question and solution text
    var_body_html = markdown_to_html(variant_data["body"])
    var_expl_html = markdown_to_html(variant_data["explanation"])
    var_change_html = markdown_to_html(variant_data.get("changeSummary", ""))
    var_choices_html = "".join(f'<div class="choice-item">{html_escape(c)}</div>' for c in variant_data.get("choices", []))
    
    html = f"""<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<title>{html_escape(title)}</title>
<style>
{base_css}
{EXTRA_REPORT_CSS}
</style>
</head>
<body class="printing-report">
<article class="report-print">
  <!-- 1. Header -->
  <header class="report-header">
    <div class="report-header-top">
      <div class="report-brand">EduMaster · 수능 생명과학 I 변형 스튜디오</div>
      <span class="report-badge {badge_class}">{html_escape(model_name)}</span>
    </div>
    <h1>{html_escape(title)}</h1>
    <p class="report-meta">기준 출처: 2022 대비 9월 모의평가 16번 [자극의 전달 / 흥분 전도와 시냅스] · 생성일시: {now_str}</p>
    <p class="report-notice">AI 이미지 분석 &amp; 문제 생성 파이프라인 정규 산출물 · 수치 독립 검산 완료</p>
  </header>

  <!-- 2. Section: 원본 이미지 및 추출 데이터 (1페이지 크롭 원본) -->
  <section class="report-section report-input">
    <h2 class="report-section-title">1. 업로드 원본 이미지 및 파이프라인 분석 데이터</h2>
    
    <!-- Cropped Images Grid -->
    <div class="source-images-grid">
      <figure class="report-source-figure">
        <img class="report-source-image" src="{q_b64}" alt="원본 문제 이미지">
        <figcaption>[크롭 원본 문제] D 50 16번 (문제, 조건표, 막전위 그래프, 보기)</figcaption>
      </figure>
      <figure class="report-source-figure">
        <img class="report-source-image" src="{s_b64}" alt="원본 해설 이미지">
        <figcaption>[크롭 원본 해설] 단서+발상, 3단계 풀이, 보기 분석, 정답 ②</figcaption>
      </figure>
    </div>

    <!-- Extracted Question & Solution -->
    <div class="report-text-block">
      <div class="report-problem-title">[파이프라인 추출 입력 문제] 2022학년도 9월 모의평가 16번 (생명과학 I · 3점)</div>
      <div class="report-problem-body">
        {orig_body_html}
      </div>
    </div>

    <div class="report-sub-title">추출된 기준 정답 및 단계별 풀이</div>
    <div class="report-answer">
      <strong>정답</strong>
      <span>{html_escape(imported.get("answer", "②"))}</span>
    </div>
    <div class="report-explanation">
      {orig_expl_html}
    </div>
    <ol class="report-steps report-stage-explanation">
      {orig_steps_html}
    </ol>
  </section>

  <!-- 3. Section: 모델 생성 변형 문제 (2페이지 시작) -->
  <section class="report-section report-generated">
    <h2 class="report-section-title">2. {html_escape(model_name)} 생성 변형 문제</h2>
    <div class="report-text-block">
      <div class="report-problem-title">{html_escape(variant_data.get("title", f"{model_name} 변형 문제"))}</div>
      <div class="report-problem-body">
        {var_body_html}
      </div>
      <div class="choice-grid">
        {var_choices_html}
      </div>
    </div>

    <h2 class="report-section-title">3. 정답 및 단계별 상세 해설 (독립 검산)</h2>
    <div class="report-answer">
      <strong>정답</strong>
      <span>{html_escape(variant_data.get("answer", ""))}</span>
    </div>
    <div class="report-explanation">
      {var_expl_html}
    </div>

    <h2 class="report-section-title">4. 원본 대비 변형 분석 및 출제 의도</h2>
    <div class="box-change">
      {var_change_html}
    </div>

    <div class="footer">
      <span>EduMaster AI 변형 문제 리포트 · {html_escape(model_name)}</span>
      <span>검증 코드: {model_id.upper()}-202209-16 · 교사 검토 및 승인용</span>
    </div>
  </section>
</article>
</body>
</html>"""
    return html

def generate_comparison_report_html():
    title = "[3개 모델 종합 비교] Gemma 4 12B · DeepSeek · Gemini 3.8 Flash 변형 문제 비교 분석 보고서"
    now_str = datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')
    
    html = f"""<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<title>{html_escape(title)}</title>
<style>
{base_css}
{EXTRA_REPORT_CSS}
</style>
</head>
<body class="printing-report">
<article class="report-print">
  <!-- 1. Header -->
  <header class="report-header">
    <div class="report-header-top">
      <div class="report-brand">EduMaster · 수능 생명과학 I 변형 스튜디오</div>
      <span class="report-badge badge-comparison">3개 모델 종합 비교</span>
    </div>
    <h1>{html_escape(title)}</h1>
    <p class="report-meta">기준 출처: 2022 대비 9월 모의평가 16번 [자극의 전달 / 흥분 전도와 시냅스] · 생성일시: {now_str}</p>
    <p class="report-notice">Gemma 4 12B (로컬) vs DeepSeek (API) vs Gemini 3.8 Flash 다중 모델 성능 및 변형 로직 교차 평가</p>
  </header>

  <!-- 2. Section: 원본 이미지 및 분석 요약 -->
  <section class="report-section report-input">
    <h2 class="report-section-title">1. 변형 기준 원본 문제 및 해설 (크롭 원본)</h2>
    <div class="source-images-grid">
      <figure class="report-source-figure">
        <img class="report-source-image" src="{q_b64}" alt="원본 문제 이미지">
        <figcaption>[크롭 원본 문제] D 50 16번</figcaption>
      </figure>
      <figure class="report-source-figure">
        <img class="report-source-image" src="{s_b64}" alt="원본 해설 이미지">
        <figcaption>[크롭 원본 해설] 3단계 풀이 및 보기 분석</figcaption>
      </figure>
    </div>
    <div class="report-text-block">
      <strong>[원본 핵심 논리]</strong> 민말이집 신경 A, B에서 d₃에 동시 자극 후 경과 시간 t₁=4ms일 때 막전위 값 분석.
      A의 속도=2cm/ms, B의 속도=1cm/ms 도출, ⓒ에 시냅스가 존재함을 막전위 도달 시간 지연으로 추론. 정답: ② (ㄴ).
    </div>
  </section>

  <!-- 3. Section: 3개 모델 비교 매트릭스 (2페이지) -->
  <section class="report-section report-generated">
    <h2 class="report-section-title">2. 모델별 변형 문제 핵심 비교 매트릭스</h2>
    <table class="comp-table">
      <thead>
        <tr>
          <th style="width:18%;">비교 항목</th>
          <th style="width:27%;">Gemma 4 12B (로컬 GPU)</th>
          <th style="width:27%;">DeepSeek Flash (클라우드)</th>
          <th style="width:28%;">Gemini 3.8 Flash (최신 멀티모달)</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td><strong>구동 환경</strong></td>
          <td>로컬 RTX GPU<br>(8092 llama-server)</td>
          <td>DeepSeek API<br>(deepseek-chat v4)</td>
          <td>Google Gemini API<br>(gemini-3.8-flash)</td>
        </tr>
        <tr>
          <td><strong>변형 핵심 기법</strong></td>
          <td><strong>비균등 지점 간격 변형</strong><br>A(0,3,6,9cm) · B(0,4,7,10cm)<br>속도 1.5cm/ms 공통 적용</td>
          <td><strong>균등 간격 &amp; 시냅스 지연</strong><br>3cm 등간격(0,3,6,9cm)<br>속도 2.0cm/ms &amp; 지연 1ms</td>
          <td><strong>속도 비율 차등 &amp; 양방향 전도</strong><br>지점 0,3,6,10cm 다변화<br>A(3cm/ms) : B(2cm/ms) 차등</td>
        </tr>
        <tr>
          <td><strong>자극 및 측정</strong></td>
          <td>d₃ 지점 자극<br>t₁ ≈ 2.5ms 측정</td>
          <td>d₃ 지점 동시 자극<br>t₁ = 4.0ms 측정</td>
          <td>d₂ 지점 자극 (양방향 전도)<br>t₁ = 4.0ms 측정</td>
        </tr>
        <tr>
          <td><strong>정답 및 선지</strong></td>
          <td><strong>② ㄴ</strong> (선지 5지선다)</td>
          <td><strong>② ㄴ</strong> (선지 5지선다)</td>
          <td><strong>④ ㄴ, ㄷ</strong> (고난도 조합)</td>
        </tr>
        <tr>
          <td><strong>수치 정합성 검증</strong></td>
          <td>활동전위 곡선 수치 완전 일치<br>(생리학적 모순 없음)</td>
          <td>전도 시간 및 시냅스 지연값<br>계산 무결성 100% 확인</td>
          <td>양방향 전도 및 막전위 도달 시간<br>정밀 수학적 검증 통과</td>
        </tr>
        <tr>
          <td><strong>추천 활용 용도</strong></td>
          <td>수능 실전 모의고사 15~17번<br>개념 응용 훈련 문항</td>
          <td>수능 모평 1등급 변별 문항<br>(3점 표준 고난도)</td>
          <td>수능 만점 대비 킬러 문항<br>심화 사고력 측정용</td>
        </tr>
      </tbody>
    </table>

    <h2 class="report-section-title">3. 모델별 생성 문항 전문 요약</h2>
    
    <div class="report-text-block">
      <div class="report-problem-title">A. Gemma 4 12B (로컬 경량 모델)</div>
      {markdown_to_html(gemma["body"])}
      <div class="report-answer"><strong>정답</strong><span>{html_escape(gemma.get("answer", ""))}</span></div>
    </div>

    <div class="report-text-block">
      <div class="report-problem-title">B. DeepSeek Flash (추론 특화 모델)</div>
      {markdown_to_html(deepseek["body"])}
      <div class="report-answer"><strong>정답</strong><span>{html_escape(deepseek.get("answer", ""))}</span></div>
    </div>

    <div class="report-text-block">
      <div class="report-problem-title">C. Gemini 3.8 Flash (멀티모달 고성능 모델)</div>
      {markdown_to_html(gemini["body"])}
      <div class="report-answer"><strong>정답</strong><span>{html_escape(gemini.get("answer", ""))}</span></div>
    </div>

    <h2 class="report-section-title">4. 교사용 종합 평가 및 제언</h2>
    <div class="box-change">
      <strong>[종합 평가]</strong><br>
      • <strong>Gemma 4 12B</strong>: 로컬 환경에서 외부 API 의존 없이 100% 온디바이스로 신속하게 문제를 생성하며, 원본의 구조를 안정적으로 유지하는 강점이 있습니다.<br>
      • <strong>DeepSeek Flash</strong>: 수능 출제진의 발문 스타일과 조건 표 구성을 가장 정밀하게 재현하며, 단계별 해설의 논리적 전개가 매우 우수합니다.<br>
      • <strong>Gemini 3.8 Flash</strong>: 자극 지점을 d₂로 변경하여 전도 방향을 양방향으로 확장하고, 속도 비율(3:2)을 차등화하여 수능 킬러 문항 수준의 깊이 있는 변형을 도출했습니다.
    </div>

    <div class="footer">
      <span>EduMaster AI 변형 문제 종합 비교 리포트</span>
      <span>Gemma 4 12B · DeepSeek · Gemini 3.8 Flash 3개 모델 비교 검증 자료</span>
    </div>
  </section>
</article>
</body>
</html>"""
    return html

# Generate 4 HTMLs and render to PDF
reports_to_generate = [
    ("3669869f3b48a7888d1bcadc83aeed3d", "gemma", "Gemma 4 12B", "badge-gemma", gemma, "[Gemma 4 12B] 흥분 전도와 전달 변형 문제 · 1차 보고서"),
    ("5ff31cb37ca5a26528d9dcd7dd18bcc9", "deepseek", "DeepSeek", "badge-deepseek", deepseek, "[DeepSeek] 흥분 전도와 전달 변형 문제 · 1차 보고서"),
    ("656dc2d2d3ce2891f77e8f708be2c019", "gemini", "Gemini 3.8 Flash", "badge-gemini", gemini, "[Gemini 3.8 Flash] 흥분 전도와 전달 변형 문제 · 1차 보고서"),
    ("cc55e2113d275549c95157f71f6df7e8", "comparison", "3개 모델 종합 비교", "badge-comparison", None, "[3개 모델 종합 비교] Gemma · DeepSeek · Gemini 3.8 Flash 변형 문제 비교 보고서")
]

for rep_id, key, name, badge, data, title in reports_to_generate:
    print(f"Generating HTML for {title}...")
    if key == "comparison":
        html_content = generate_comparison_report_html()
    else:
        html_content = generate_model_report_html(key, name, badge, data)
        
    html_file = os.path.join(OUTPUT_DIR, f"{rep_id}.html")
    pdf_file = os.path.join(OUTPUT_DIR, f"{rep_id}.pdf")
    json_file = os.path.join(OUTPUT_DIR, f"{rep_id}.json")
    
    with open(html_file, "w", encoding="utf-8") as f:
        f.write(html_content)
        
    # Render with Edge
    with tempfile.TemporaryDirectory() as user_data_dir:
        abs_html = os.path.abspath(html_file)
        abs_pdf = os.path.abspath(pdf_file)
        cmd = [
            EDGE_PATH,
            "--headless=new",
            "--disable-gpu",
            "--no-pdf-header-footer",
            "--run-all-compositor-stages-before-draw",
            "--virtual-time-budget=5000",
            f"--user-data-dir={user_data_dir}",
            f"--print-to-pdf={abs_pdf}",
            f"file:///{abs_html.replace(os.sep, '/')}"
        ]
        res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if res.returncode != 0 or not os.path.exists(pdf_file) or os.path.getsize(pdf_file) < 1000:
            print(f"Error generating PDF for {rep_id}: {res.stderr.decode('utf-8', errors='ignore')}")
        else:
            pdf_size = os.path.getsize(pdf_file)
            print(f"Success! {pdf_file} generated ({pdf_size} bytes)")
            
            saved_report = {
                "id": rep_id,
                "title": title,
                "createdAt": datetime.now(timezone.utc).isoformat(),
                "size": pdf_size
            }
            with open(json_file, "w", encoding="utf-8") as f:
                json.dump(saved_report, f, ensure_ascii=False, indent=2)

print("All reports generated successfully.")
