import json
import os
import re
import shutil
import subprocess
import hashlib
import tempfile
from datetime import datetime, timezone

EDGE_PATH = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
REPORTS_DIR = "artifacts/web/reports"
os.makedirs(REPORTS_DIR, exist_ok=True)

# Load variants
with open("artifacts/variants/gemma.json", "r", encoding="utf-8") as f:
    gemma = json.load(f)
with open("artifacts/variants/deepseek.json", "r", encoding="utf-8") as f:
    deepseek = json.load(f)
with open("artifacts/variants/gemini.json", "r", encoding="utf-8") as f:
    gemini = json.load(f)

# Save combined data for the web UI
variants_data = {
    "gemma": gemma,
    "deepseek": deepseek,
    "gemini": gemini
}
os.makedirs("src/EduMaster.Web/wwwroot/result", exist_ok=True)
os.makedirs("artifacts/web/wwwroot/result", exist_ok=True)
with open("src/EduMaster.Web/wwwroot/result/variants_data.json", "w", encoding="utf-8") as f:
    json.dump(variants_data, f, ensure_ascii=False, indent=2)
with open("artifacts/web/wwwroot/result/variants_data.json", "w", encoding="utf-8") as f:
    json.dump(variants_data, f, ensure_ascii=False, indent=2)

def html_escape(s):
    return (s.replace("&", "&amp;")
             .replace("<", "&lt;")
             .replace(">", "&gt;")
             .replace('"', "&quot;"))

def markdown_to_html(text):
    text = html_escape(text)
    # Convert bold
    text = re.sub(r'\*\*(.+?)\*\*', r'<strong>\1</strong>', text)
    # Convert headers
    text = re.sub(r'^### (.+)$', r'<h4>\1</h4>', text, flags=re.MULTILINE)
    text = re.sub(r'^## (.+)$', r'<h3>\1</h3>', text, flags=re.MULTILINE)
    text = re.sub(r'^# (.+)$', r'<h2>\1</h2>', text, flags=re.MULTILINE)
    # Convert markdown tables
    lines = text.split('\n')
    new_lines = []
    in_table = False
    table_rows = []
    for line in lines:
        line_str = line.strip()
        if line_str.startswith('|') and line_str.endswith('|'):
            in_table = True
            # Check if separator line
            if re.match(r'^\|[\s:-|]+\|$', line_str):
                continue
            cells = [c.strip() for c in line_str.split('|')[1:-1]]
            table_rows.append(cells)
        else:
            if in_table:
                # render table
                html_table = '<table class="report-table"><tbody>'
                for r_idx, row in enumerate(table_rows):
                    tag = 'th' if r_idx == 0 else 'td'
                    html_table += '<tr>' + ''.join(f'<{tag}>{c}</{tag}>' for c in row) + '</tr>'
                html_table += '</tbody></table>'
                new_lines.append(html_table)
                in_table = False
                table_rows = []
            new_lines.append(line)
    if in_table:
        html_table = '<table class="report-table"><tbody>'
        for r_idx, row in enumerate(table_rows):
            tag = 'th' if r_idx == 0 else 'td'
            html_table += '<tr>' + ''.join(f'<{tag}>{c}</{tag}>' for c in row) + '</tr>'
        html_table += '</tbody></table>'
        new_lines.append(html_table)
    return '\n'.join(new_lines).replace('\n', '<br>')

import re

def create_report_html(title, model_name, model_badge_class, variant, original_info):
    body_html = markdown_to_html(variant["body"])
    expl_html = markdown_to_html(variant["explanation"])
    change_html = markdown_to_html(variant.get("changeSummary", ""))
    choices_html = "".join(f'<div class="choice-item">{html_escape(c)}</div>' for c in variant.get("choices", []))
    
    return f"""<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<title>{html_escape(title)}</title>
<style>
@page {{ size: A4; margin: 15mm; }}
body {{
  font-family: -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Malgun Gothic", "Noto Sans KR", sans-serif;
  color: #17243a;
  background: #fff;
  margin: 0;
  padding: 0;
  line-height: 1.6;
}}
.report-print {{
  display: block;
  max-width: 800px;
  margin: 0 auto;
}}
.header {{
  border-bottom: 2px solid #087f70;
  padding-bottom: 12px;
  margin-bottom: 20px;
  display: flex;
  justify-content: space-between;
  align-items: flex-end;
}}
.brand {{
  font-size: 20px;
  font-weight: 900;
  color: #10233d;
}}
.model-badge {{
  display: inline-block;
  padding: 4px 10px;
  border-radius: 6px;
  font-size: 13px;
  font-weight: 700;
  color: #fff;
}}
.badge-gemma {{ background: #4f46e5; }}
.badge-deepseek {{ background: #0284c7; }}
.badge-gemini {{ background: #087f70; }}
.badge-comparison {{ background: #b45309; }}
.meta-info {{
  font-size: 12px;
  color: #64748b;
  margin-top: 4px;
}}
h1 {{
  font-size: 22px;
  margin: 10px 0 6px;
  color: #0f172a;
}}
h2 {{
  font-size: 16px;
  border-left: 4px solid #087f70;
  padding-left: 10px;
  margin: 22px 0 10px;
  color: #1e293b;
}}
.box {{
  background: #f8fafc;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  padding: 16px;
  margin-bottom: 16px;
  font-size: 14px;
}}
.original-box {{
  background: #f1f5f9;
  border-left: 4px solid #94a3b8;
}}
.report-table {{
  width: 100%;
  border-collapse: collapse;
  margin: 12px 0;
  font-size: 13px;
}}
.report-table th, .report-table td {{
  border: 1px solid #cbd5e1;
  padding: 8px 10px;
  text-align: center;
}}
.report-table th {{
  background: #e2e8f0;
  font-weight: 700;
}}
.choices-grid {{
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  margin: 14px 0;
}}
.choice-item {{
  background: #fff;
  border: 1px solid #cbd5e1;
  border-radius: 6px;
  padding: 8px 12px;
  font-size: 13.5px;
}}
.answer-tag {{
  background: #ecfdf5;
  border: 1px solid #6ee7b7;
  color: #065f46;
  font-weight: 800;
  padding: 6px 14px;
  border-radius: 6px;
  display: inline-block;
  font-size: 15px;
  margin-bottom: 12px;
}}
.footer {{
  border-top: 1px solid #e2e8f0;
  margin-top: 30px;
  padding-top: 10px;
  font-size: 11px;
  color: #94a3b8;
  display: flex;
  justify-content: space-between;
}}
</style>
</head>
<body class="printing-report">
<article class="report-print">
  <div class="header">
    <div>
      <div class="brand">EduMaster · 수능 생명과학 I 변형 스튜디오</div>
      <h1>{html_escape(title)}</h1>
      <div class="meta-info">출처: 2022 대비 9월 모의평가 16번 [자극의 전달 / 흥분 전도와 시냅스] · 생성일시: {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}</div>
    </div>
    <span class="model-badge {model_badge_class}">{html_escape(model_name)}</span>
  </div>

  <h2>1. 기준 원본 문제 정보</h2>
  <div class="box original-box">
    <strong>[원본 출제 정보]</strong> 2022학년도 9월 모의평가 16번 (정답률 39%, 1등급 변별 문항)<br>
    <strong>[핵심 개념]</strong> 민말이집 신경 A, B의 흥분 전도 속도(1cm/ms), 활동 전위 막전위 그래프(-70, -60, +30, 0, -80mV), 시냅스 위치(㉠~㉢) 추론<br>
    <strong>[원본 정답]</strong> ② (ㄴ)
  </div>

  <h2>2. {html_escape(model_name)} 생성 변형 문제</h2>
  <div class="box">
    {body_html}
    <div class="choices-grid">
      {choices_html}
    </div>
  </div>

  <h2>3. 정답 및 단계별 상세 해설</h2>
  <div class="box">
    <div class="answer-tag">정답: {html_escape(variant.get("answer", ""))}</div>
    {expl_html}
  </div>

  <h2>4. 원본 대비 변형 분석 및 출제 의도</h2>
  <div class="box">
    {change_html}
  </div>

  <div class="footer">
    <span>EduMaster AI 변형 문제 리포트 · {html_escape(model_name)}</span>
    <span>교사 검토 및 승인용 자료</span>
  </div>
</article>
</body>
</html>"""

def create_comparison_html(gemma, deepseek, gemini):
    return f"""<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<title>[3개 모델 비교 종합] Gemma 4 12B · DeepSeek · Gemini 3.8 Flash 변형 문제 비교 보고서</title>
<style>
@page {{ size: A4; margin: 12mm; }}
body {{
  font-family: -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Malgun Gothic", "Noto Sans KR", sans-serif;
  color: #17243a;
  background: #fff;
  margin: 0;
  padding: 0;
  line-height: 1.5;
}}
.report-print {{
  display: block;
  max-width: 820px;
  margin: 0 auto;
}}
.header {{
  border-bottom: 2px solid #087f70;
  padding-bottom: 12px;
  margin-bottom: 18px;
}}
.brand {{ font-size: 20px; font-weight: 900; color: #10233d; }}
h1 {{ font-size: 21px; margin: 8px 0 4px; color: #0f172a; }}
.meta-info {{ font-size: 12px; color: #64748b; }}
.comp-table {{
  width: 100%;
  border-collapse: collapse;
  margin: 16px 0;
  font-size: 12.5px;
}}
.comp-table th, .comp-table td {{
  border: 1px solid #cbd5e1;
  padding: 10px 12px;
  vertical-align: top;
}}
.comp-table th {{ background: #f1f5f9; text-align: center; font-weight: 700; }}
.badge {{ display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 700; color: #fff; }}
.badge-gemma {{ background: #4f46e5; }}
.badge-deepseek {{ background: #0284c7; }}
.badge-gemini {{ background: #087f70; }}
.section-title {{
  font-size: 15px;
  border-left: 4px solid #087f70;
  padding-left: 8px;
  margin: 20px 0 10px;
  color: #1e293b;
}}
.model-summary-card {{
  background: #f8fafc;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  padding: 14px;
  margin-bottom: 14px;
  font-size: 13px;
}}
.footer {{
  border-top: 1px solid #e2e8f0;
  margin-top: 24px;
  padding-top: 8px;
  font-size: 11px;
  color: #94a3b8;
  display: flex;
  justify-content: space-between;
}}
</style>
</head>
<body class="printing-report">
<article class="report-print">
  <div class="header">
    <div class="brand">EduMaster · 다중 모델 변형 문제 비교 분석</div>
    <h1>3개 모델(Gemma 4 12B · DeepSeek · Gemini 3.8 Flash) 생성 결과 비교</h1>
    <div class="meta-info">대상 원본: 2022 대비 9월 모의평가 16번 [생명과학 I 흥분 전도와 전달] · 작성일시: {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}</div>
  </div>

  <h2 class="section-title">1. 모델별 핵심 변형 요소 비교 매트릭스</h2>
  <table class="comp-table">
    <thead>
      <tr>
        <th style="width:18%">구분</th>
        <th style="width:27%"><span class="badge badge-gemma">Gemma 4 12B</span></th>
        <th style="width:27%"><span class="badge badge-deepseek">DeepSeek</span></th>
        <th style="width:28%"><span class="badge badge-gemini">Gemini 3.8 Flash</span></th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td><strong>지점 거리</strong></td>
        <td>A: 0, 3, 6, 9cm<br>B: 0, 4, 7, 10cm</td>
        <td>0, 3, 6, 9cm (균등 간격 3cm)</td>
        <td>0, 3, 6, 10cm (3, 3, 4cm 다변화)</td>
      </tr>
      <tr>
        <td><strong>전도 속도</strong></td>
        <td>A, B 모두 1.5cm/ms</td>
        <td>B 속도 2.0cm/ms</td>
        <td>A: 3cm/ms, B: 2cm/ms 차등화</td>
      </tr>
      <tr>
        <td><strong>자극 지점</strong></td>
        <td>$d_3$ 동시 자극</td>
        <td>$d_1 \\sim d_4$ 동시 자극</td>
        <td>$d_2$ 자극 (양방향 전도 활용)</td>
      </tr>
      <tr>
        <td><strong>시냅스 위치</strong></td>
        <td>㉡ ($d_3$)</td>
        <td>㉢ ($d_3 \\sim d_4$ 사이)</td>
        <td>㉢ ($d_3 \\sim d_4$ 사이)</td>
      </tr>
      <tr>
        <td><strong>측정 시간 $t_1$</strong></td>
        <td>2.5ms 근처</td>
        <td>4.0ms</td>
        <td>4.0ms</td>
      </tr>
      <tr>
        <td><strong>최종 정답</strong></td>
        <td><strong>② ㄴ</strong></td>
        <td><strong>② ㄴ</strong></td>
        <td><strong>④ ㄴ, ㄷ</strong></td>
      </tr>
      <tr>
        <td><strong>출제 특징 및 강점</strong></td>
        <td>비균등 거리 지점 배치를 통해 기하학적 전도 거리 계산 능력을 평가.</td>
        <td>균등 3cm 간격과 시냅스 지연 시간을 수학적으로 결합하여 정밀 추론 유도.</td>
        <td>A, B 속도 비율(3:2)과 $d_2$ 양방향 전도 및 탈분극/재분극 구간 판별을 종합 평가하는 최상위 변별력 문항.</td>
      </tr>
    </tbody>
  </table>

  <h2 class="section-title">2. 모델별 생성 문제 요약</h2>
  <div class="model-summary-card">
    <strong style="color:#4f46e5;">[Gemma 4 12B]</strong> {html_escape(gemma.get("title", ""))}<br>
    - <strong>핵심 지문:</strong> 신경 A(0, 3, 6, 9cm)와 B(0, 4, 7, 10cm)의 비대칭 지점 구조에서 $d_3$ 자극 후 $t_1$ 시점 막전위 분석.<br>
    - <strong>정답:</strong> {html_escape(gemma.get("answer", ""))}
  </div>
  <div class="model-summary-card">
    <strong style="color:#0284c7;">[DeepSeek]</strong> {html_escape(deepseek.get("title", ""))}<br>
    - <strong>핵심 지문:</strong> 3cm 간격의 4개 지점과 속도 2cm/ms에서 시냅스 지연 시간을 감안한 t₁=4ms 막전위 매칭.<br>
    - <strong>정답:</strong> {html_escape(deepseek.get("answer", ""))}
  </div>
  <div class="model-summary-card">
    <strong style="color:#087f70;">[Gemini 3.8 Flash]</strong> {html_escape(gemini.get("title", ""))}<br>
    - <strong>핵심 지문:</strong> d₂ 자극 양방향 전도와 A(3cm/ms), B(2cm/ms) 속도 차등화를 통한 t₁=4ms 시점 막전위 및 상태 분석.<br>
    - <strong>정답:</strong> {html_escape(gemini.get("answer", ""))}
  </div>

  <div class="footer">
    <span>EduMaster 생성 모델별 종합 비교 분석 보고서</span>
    <span>수능 생명과학 I 킬러 문항 스튜디오</span>
  </div>
</article>
</body>
</html>"""

def render_html_to_pdf(html_content, output_pdf_path):
    abs_output = os.path.abspath(output_pdf_path)
    temp_dir = tempfile.mkdtemp(prefix="edumaster_report_")
    html_file = os.path.abspath(os.path.join(temp_dir, "report.html"))
    with open(html_file, "w", encoding="utf-8") as f:
        f.write(html_content)
    
    profile_dir = os.path.abspath(os.path.join(temp_dir, "profile"))
    url = f"file:///{html_file.replace(chr(92), '/')}"
    cmd = [
        EDGE_PATH,
        "--headless=new",
        "--disable-gpu",
        "--no-pdf-header-footer",
        "--run-all-compositor-stages-before-draw",
        "--virtual-time-budget=5000",
        f"--user-data-dir={profile_dir}",
        f"--print-to-pdf={abs_output}",
        url
    ]
    proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if proc.returncode != 0 or not os.path.exists(abs_output):
        print(f"Edge error (returncode {proc.returncode}): {proc.stderr}")
    shutil.rmtree(temp_dir, ignore_errors=True)

# 1. Gemma Report
gemma_id = hashlib.md5(b"gemma_variant_20260922").hexdigest()
gemma_title = "[Gemma 4 12B] 흥분 전도와 전달 변형 문제 · 1차 보고서"
gemma_html = create_report_html(gemma_title, "Gemma 4 12B", "badge-gemma", gemma, {})
gemma_pdf_path = os.path.join(REPORTS_DIR, f"{gemma_id}.pdf")
print("Rendering Gemma PDF...")
render_html_to_pdf(gemma_html, gemma_pdf_path)
gemma_size = os.path.getsize(gemma_pdf_path)
with open(os.path.join(REPORTS_DIR, f"{gemma_id}.json"), "w", encoding="utf-8") as f:
    json.dump({
        "id": gemma_id,
        "title": gemma_title,
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "size": gemma_size
    }, f, ensure_ascii=False, indent=2)

# 2. DeepSeek Report
ds_id = hashlib.md5(b"deepseek_variant_20260922").hexdigest()
ds_title = "[DeepSeek] 흥분 전도와 전달 변형 문제 · 1차 보고서"
ds_html = create_report_html(ds_title, "DeepSeek", "badge-deepseek", deepseek, {})
ds_pdf_path = os.path.join(REPORTS_DIR, f"{ds_id}.pdf")
print("Rendering DeepSeek PDF...")
render_html_to_pdf(ds_html, ds_pdf_path)
ds_size = os.path.getsize(ds_pdf_path)
with open(os.path.join(REPORTS_DIR, f"{ds_id}.json"), "w", encoding="utf-8") as f:
    json.dump({
        "id": ds_id,
        "title": ds_title,
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "size": ds_size
    }, f, ensure_ascii=False, indent=2)

# 3. Gemini 3.8 Flash Report
gemini_id = hashlib.md5(b"gemini_variant_20260922").hexdigest()
gemini_title = "[Gemini 3.8 Flash] 흥분 전도와 전달 변형 문제 · 1차 보고서"
gemini_html = create_report_html(gemini_title, "Gemini 3.8 Flash", "badge-gemini", gemini, {})
gemini_pdf_path = os.path.join(REPORTS_DIR, f"{gemini_id}.pdf")
print("Rendering Gemini PDF...")
render_html_to_pdf(gemini_html, gemini_pdf_path)
gemini_size = os.path.getsize(gemini_pdf_path)
with open(os.path.join(REPORTS_DIR, f"{gemini_id}.json"), "w", encoding="utf-8") as f:
    json.dump({
        "id": gemini_id,
        "title": gemini_title,
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "size": gemini_size
    }, f, ensure_ascii=False, indent=2)

# 4. Comparison Report
comp_id = hashlib.md5(b"model_comparison_20260922").hexdigest()
comp_title = "[3개 모델 종합 비교] Gemma · DeepSeek · Gemini 3.8 Flash 변형 문제 비교 보고서"
comp_html = create_comparison_html(gemma, deepseek, gemini)
comp_pdf_path = os.path.join(REPORTS_DIR, f"{comp_id}.pdf")
print("Rendering Comparison PDF...")
render_html_to_pdf(comp_html, comp_pdf_path)
comp_size = os.path.getsize(comp_pdf_path)
with open(os.path.join(REPORTS_DIR, f"{comp_id}.json"), "w", encoding="utf-8") as f:
    json.dump({
        "id": comp_id,
        "title": comp_title,
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "size": comp_size
    }, f, ensure_ascii=False, indent=2)

print("All 4 reports (PDF + JSON) successfully created in artifacts/web/reports/!")
