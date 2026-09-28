"""Create candid, source-linked reports for the three actual evaluation routes."""
from __future__ import annotations

import json
import re
from datetime import datetime
from html import escape
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    BaseDocTemplate, Flowable, Frame, Image, KeepTogether, PageBreak,
    PageTemplate, Paragraph, Spacer, Table, TableStyle,
)

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "artifacts" / "three-model-eval"
OUTPUT = ROOT / "output" / "pdf"
OUTPUT.mkdir(parents=True, exist_ok=True)

pdfmetrics.registerFont(TTFont("Malgun", r"C:\Windows\Fonts\malgun.ttf"))
pdfmetrics.registerFont(TTFont("MalgunBold", r"C:\Windows\Fonts\malgunbd.ttf"))
pdfmetrics.registerFontFamily("Malgun", normal="Malgun", bold="MalgunBold")

NAVY = colors.HexColor("#18304B")
TEAL = colors.HexColor("#087F76")
GREY = colors.HexColor("#5B6875")
LIGHT = colors.HexColor("#F1F5F8")
AMBER = colors.HexColor("#9E5B00")
RED = colors.HexColor("#A72828")

styles = getSampleStyleSheet()
styles.add(ParagraphStyle(name="KTitle", fontName="MalgunBold", fontSize=20, leading=27, textColor=NAVY, spaceAfter=14, wordWrap="CJK"))
styles.add(ParagraphStyle(name="KSub", fontName="MalgunBold", fontSize=12, leading=18, textColor=NAVY, spaceBefore=14, spaceAfter=8, wordWrap="CJK"))
styles.add(ParagraphStyle(name="KBody", fontName="Malgun", fontSize=9.2, leading=15.3, textColor=NAVY, spaceAfter=7, wordWrap="CJK"))
styles.add(ParagraphStyle(name="KSmall", fontName="Malgun", fontSize=8, leading=12, textColor=GREY, spaceAfter=5, wordWrap="CJK"))
styles.add(ParagraphStyle(name="KTable", fontName="Malgun", fontSize=8, leading=11.5, textColor=NAVY, wordWrap="CJK"))


def para(value: object, style="KBody") -> Paragraph:
    text = escape(str(value or "")).replace("\n", "<br/>")
    return Paragraph(text, styles[style])


def heading(text: str):
    return para(text, "KSub")


def make_table(rows, widths=None):
    prepared = [[para(cell, "KTable") for cell in row] for row in rows]
    table = Table(prepared, colWidths=widths, repeatRows=1, hAlign="LEFT")
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), LIGHT),
        ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#D2DCE5")),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 8),
        ("RIGHTPADDING", (0, 0), (-1, -1), 8),
        ("TOPPADDING", (0, 0), (-1, -1), 7),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
    ]))
    return table


def add_markdown_text(story, text):
    lines = str(text or "").splitlines()
    i = 0
    while i < len(lines):
        line = lines[i].strip()
        if not line:
            i += 1
            continue
        if line.startswith("|"):
            rows = []
            while i < len(lines) and lines[i].strip().startswith("|"):
                cells = [x.strip() for x in lines[i].strip().strip("|").split("|")]
                if any(re.search(r"[^\s:\-]", cell) for cell in cells):
                    rows.append(cells)
                i += 1
            if rows and len({len(r) for r in rows}) == 1:
                story.append(make_table(rows))
                story.append(Spacer(1, 8))
            else:
                for row in rows:
                    story.append(para(" | ".join(row)))
            continue
        story.append(para(line))
        i += 1


class DrawingPreview(Flowable):
    def __init__(self, drawing):
        super().__init__()
        self.drawing = drawing
        self.width = 474
        self.height = 150

    def draw(self):
        source_w = float(self.drawing.get("width") or 1000)
        source_h = float(self.drawing.get("height") or 300)
        sx, sy = self.width / source_w, self.height / source_h
        c = self.canv
        c.setStrokeColor(NAVY)
        c.setFillColor(NAVY)
        c.setLineWidth(1.2)
        for element in self.drawing.get("elements") or []:
            kind = element.get("type")
            a = element.get("coordinates") or []
            if kind in ("line", "arrow") and len(a) >= 4:
                x1, y1, x2, y2 = a[:4]
                x1, x2 = x1 * sx, x2 * sx
                y1, y2 = self.height - y1 * sy, self.height - y2 * sy
                c.line(x1, y1, x2, y2)
                if kind == "arrow":
                    c.line(x2, y2, x2 - 4, y2 + 7)
                    c.line(x2, y2, x2 + 4, y2 + 7)
            elif kind == "text" and len(a) >= 2:
                c.setFont("Malgun", min(8.5, float(element.get("fontSize") or 24) * sx))
                c.drawString(a[0] * sx, self.height - a[1] * sy, str(element.get("text") or ""))


def source_pages(story):
    for title, filename in [("입력 문제 원본 이미지", "question.png"), ("입력 풀이 원본 이미지", "solution.png")]:
        story.append(PageBreak())
        story.append(heading(title))
        path = ROOT / filename
        reader = ImageReader(str(path))
        width, height = reader.getSize()
        scale = min(475 / width, 625 / height)
        picture = Image(str(path), width=width * scale, height=height * scale)
        picture.hAlign = "CENTER"
        story.append(picture)
        story.append(Spacer(1, 6))
        story.append(para("원본에는 색상 필기와 풀이 표기가 섞여 있습니다. 인쇄된 조건과 필기를 구분해 검토해야 합니다.", "KSmall"))


def add_output(story, data):
    story.append(PageBreak())
    story.append(heading("생성된 문제 초안"))
    story.append(para(data.get("title")))
    add_markdown_text(story, data.get("body"))
    if data.get("drawings"):
        story.append(heading("모델이 제출한 그림 데이터"))
        for drawing in data["drawings"]:
            story.append(para(drawing.get("title"), "KSmall"))
            story.append(DrawingPreview(drawing))
            story.append(para(drawing.get("description"), "KSmall"))
    if data.get("choices"):
        story.append(heading("선택지와 생성 정답"))
        for index, choice in enumerate(data["choices"], 1):
            story.append(para(f"{index}. {choice}"))
        story.append(para("생성 정답: " + str(data.get("answer"))))
    story.append(heading("생성 해설"))
    for chunk in str(data.get("explanation") or "").splitlines():
        if chunk.strip():
            story.append(para(chunk))
    story.append(heading("풀이 단계"))
    for index, step in enumerate(data.get("steps") or [], 1):
        story.append(para(f"STEP {index}. {step}"))


def add_quality(story, data, observations):
    story.append(PageBreak())
    story.append(heading("검사 결과와 판단"))
    quality = data.get("quality") or {}
    rows = [["검사", "상태", "근거"]]
    selected = {"source-calculation", "choices", "conditions", "semantic-math", "visual-semantics", "calculation", "visual-data", "render"}
    for item in quality.get("checks") or []:
        if item.get("id") in selected:
            rows.append([item.get("label"), item.get("state"), item.get("evidence")])
    if len(rows) > 1:
        story.append(make_table(rows, [100, 62, 312]))
    story.append(Spacer(1, 12))
    for label, content in observations:
        story.append(heading(label))
        story.append(para(content))


def footer(canvas, doc):
    canvas.saveState()
    width, _ = A4
    canvas.setStrokeColor(colors.HexColor("#D5E0E8"))
    canvas.line(54, 43, width - 54, 43)
    canvas.setFont("Malgun", 7.5)
    canvas.setFillColor(GREY)
    canvas.drawString(54, 30, "EduMaster · 3모델 비교 · 2026-09-23")
    canvas.drawRightString(width - 54, 30, str(doc.page))
    canvas.restoreState()


def write_report(path, title, route, state, detail, data, observations, include_output=False):
    doc = BaseDocTemplate(str(path), pagesize=A4, leftMargin=54, rightMargin=54, topMargin=52, bottomMargin=57,
                          title=title, author="EduMaster")
    frame = Frame(54, 57, A4[0] - 108, A4[1] - 109, leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0)
    doc.addPageTemplates([PageTemplate(id="normal", frames=[frame], onPage=footer)])
    story = [para(title, "KTitle"), para("동일 입력 · 입력 문제 이미지 + 원본 풀이 이미지", "KSmall")]
    story.append(make_table([
        ["항목", "이번 실행 결과"], ["경로", route], ["상태", state], ["결론", detail],
    ], [110, 364]))
    story.append(Spacer(1, 12))
    story.append(heading("이 보고서를 읽는 법"))
    story.append(para("웹 /api/generate는 이 생명과학 문항의 입력 정답을 독립 계산기로 검산할 수 없어 HTTP 400으로 사전 차단했습니다. 아래 결과는 실제 EduMaster.Core의 모델 생성기와 검사 하네스를 별도 실행한 진단 결과입니다. '검토 필요' 또는 '실패'는 학생에게 제공 가능한 완성 문제를 뜻하지 않습니다."))
    story.append(heading("공통 입력 판독의 문제"))
    story.append(para("실제 OCR 산출물은 A의 IV 막전위를 -70 mV로 기록합니다. 그러나 제공된 풀이 이미지는 A의 II와 IV가 모두 0 mV라고 명시합니다. 이 불일치가 세 경로에 영향을 줄 수 있으므로, 모델 성능 평가에 앞서 문제·해설 분리 판독을 수정해야 합니다."))
    story.append(heading("실행 증거"))
    story.append(para("실험 결과 JSON: artifacts/three-model-eval/ 아래 provider별 파일. 실제 모델 호출은 DeepSeek V4 Flash API와 로컬 Gemma 4 12B 엔드포인트로 수행했습니다. GPT 항목은 이 대화의 어시스턴트가 GPT 역할로 직접 작성한 통제 변형을 같은 코드 검사기에 넣은 시뮬레이션 경로입니다."))
    if data.get("started"):
        story.append(para("시작: " + str(data.get("started")) + " UTC / 완료: " + str(data.get("finished") or "-") + " UTC", "KSmall"))
    if data.get("usageSummary"):
        story.append(para("모델 사용량: " + str(data.get("usageSummary")), "KSmall"))
    if include_output:
        add_output(story, data)
    else:
        story.append(heading("생성 결과"))
        story.append(para("필수 이미지 이해 또는 그림 데이터 단계에서 중단되었습니다. 완성된 문제·정답·해설은 없으며, 임의로 보충하지 않았습니다."))
        story.append(para(str(data.get("error") or "")))
    add_quality(story, data, observations)
    source_pages(story)
    doc.build(story)


deepseek = json.loads((DATA / "deepseek.json").read_text(encoding="utf-8"))
gemma = json.loads((DATA / "gemma.json").read_text(encoding="utf-8"))
gemma_text = json.loads((DATA / "gemma-text.json").read_text(encoding="utf-8"))
gpt = json.loads((DATA / "gpt.json").read_text(encoding="utf-8"))

write_report(
    OUTPUT / "2026-09-23_생명과학_DeepSeek_실행검토.pdf",
    "DeepSeek V4 Flash · 실제 실행 검토", "EduMaster.Core DeepSeekVisualGenerator → QualityReviewClient",
    "초안 생성 / 하네스 review_required / 정답 미검증",
    "문제와 해설은 생성됐지만 그림·본문의 좌표 수치가 누락되어 사용 불가",
    deepseek,
    [
        ("확인된 결함", "모델의 변경 요약은 d₁=0, d₂=2, d₃=6, d₄=8 cm를 사용했다고 하지만 실제 문제 본문과 그림의 라벨에는 숫자 좌표가 없습니다. 해설은 d₁~d₃=6 cm와 d₁~d₂=2 cm를 전제로 계산하므로 학생이 문제만 보고 풀 수 없습니다."),
        ("원본 판독 영향", "입력 OCR은 A IV=-70 mV로 저장했으나 원본 풀이에는 A II와 IV 모두 0 mV로 쓰여 있습니다. 원본 풀이 로직이 잘못 전달되었을 가능성이 큽니다."),
        ("판정", "AI 검토의 일부 항목이 통과해도 생명과학 독립 계산 검사는 unknown이고 최종 그림 대조도 완료되지 않았습니다. 정답 ③은 검증된 정답이 아니라 모델의 주장입니다."),
    ], True,
)

gemma["error"] = "이미지 입력: " + str(gemma.get("error")) + "\n텍스트 재시도: " + str(gemma_text.get("error"))
write_report(
    OUTPUT / "2026-09-23_생명과학_Gemma_실행검토.pdf",
    "Gemma 4 12B · 실제 실행 검토", "EduMaster.Core LocalGemmaGenerator (로컬 GPU)",
    "이미지 경로 실패 / 텍스트 재시도 실패 / 완성 문항 없음",
    "이미지 이해 응답이 잘렸고, 텍스트 재시도 결과에는 필수 그림 데이터가 빠짐",
    gemma,
    [
        ("첫 번째 실행", str(gemma.get("error"))),
        ("두 번째 실행", str(gemma_text.get("error"))),
        ("판정", "두 실패 모두 실제 생성기의 예외입니다. 완성 초안이 없으므로 정답·해설을 평가하거나 다른 모델의 결과를 Gemma 출력으로 대신할 수 없습니다."),
    ], False,
)

write_report(
    OUTPUT / "2026-09-23_생명과학_GPT_시뮬레이션_검토.pdf",
    "GPT · 생성 시뮬레이션 및 코드 검사", "GPT 역할 시뮬레이션 → EduMaster.Core ProblemQualityHarness",
    "통제 변형 작성 / 하네스 review_required / 독립 코드 정답 검증 없음",
    "거리·속도를 1.5배로 조정하고 보기를 재구성한 비교용 문항",
    gpt,
    [
        ("작성 방식", "이 결과는 GPT API를 연결한 자동 생성 결과가 아닙니다. 이 대화의 어시스턴트가 GPT 모델 역할을 시뮬레이션하여 원본 풀이 이미지의 세 단계 로직을 읽고 직접 작성했으며, 실제 EduMaster.Core 검사기로 구조와 기본 조건을 확인했습니다."),
        ("수작업 수치 대조", "A의 속도 3 cm/ms에서 d₃→d₄=1 ms, t₁=4 ms입니다. B의 속도 1.5 cm/ms에서 d₃→d₂=3 ms, d₃→d₄=2 ms이며, ⓒ에서 0.5 ms 지연되면 B의 d₄는 막전위 0 mV가 됩니다. 이것은 이 문항에 대한 직접 산술 검토이며, 범용 독립 검산기 통과를 뜻하지 않습니다."),
        ("한계", "숫자 비율과 보기 초점을 바꾼 통제 변형입니다. 새로운 개념 결합형 쌍둥이 문제로 평가하지 않았습니다. 원본 OCR의 A IV 오류는 보고서에만 설명하고 이 초안의 표에서는 풀이 이미지에 맞춰 0 mV로 바로잡았습니다."),
    ], True,
)

for file in OUTPUT.glob("2026-09-23_생명과학_*검토.pdf"):
    print(file)
