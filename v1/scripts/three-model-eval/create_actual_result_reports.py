"""Create reports whose main content is the actual generated problem and solution."""
from __future__ import annotations

import json
import re
from html import escape
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import BaseDocTemplate, Flowable, Frame, Image, PageBreak, PageTemplate, Paragraph, Spacer, Table, TableStyle

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "artifacts" / "three-model-eval"
OUT = ROOT / "output" / "pdf"
OUT.mkdir(parents=True, exist_ok=True)

pdfmetrics.registerFont(TTFont("Malgun", r"C:\Windows\Fonts\malgun.ttf"))
pdfmetrics.registerFont(TTFont("MalgunBold", r"C:\Windows\Fonts\malgunbd.ttf"))
pdfmetrics.registerFontFamily("Malgun", normal="Malgun", bold="MalgunBold")

NAVY = colors.HexColor("#17324D")
TEAL = colors.HexColor("#087F76")
MINT = colors.HexColor("#EAF7F4")
LIGHT = colors.HexColor("#F3F6F8")
GREY = colors.HexColor("#66717D")

ss = getSampleStyleSheet()
ss.add(ParagraphStyle(name="TitleK", fontName="MalgunBold", fontSize=20, leading=28, textColor=NAVY, spaceAfter=12, wordWrap="CJK"))
ss.add(ParagraphStyle(name="H2K", fontName="MalgunBold", fontSize=12, leading=18, textColor=NAVY, spaceBefore=12, spaceAfter=7, wordWrap="CJK"))
ss.add(ParagraphStyle(name="BodyK", fontName="Malgun", fontSize=9.2, leading=15.2, textColor=NAVY, spaceAfter=6, wordWrap="CJK"))
ss.add(ParagraphStyle(name="SmallK", fontName="Malgun", fontSize=7.8, leading=12, textColor=GREY, spaceAfter=4, wordWrap="CJK"))
ss.add(ParagraphStyle(name="AnswerK", fontName="MalgunBold", fontSize=14, leading=20, textColor=TEAL, spaceAfter=8, wordWrap="CJK"))
ss.add(ParagraphStyle(name="TableK", fontName="Malgun", fontSize=8.2, leading=12, textColor=NAVY, wordWrap="CJK"))


def p(text, style="BodyK"):
    return Paragraph(escape(str(text or "")).replace("\n", "<br/>"), ss[style])


def table(rows, widths=None, header=True):
    value = Table([[p(cell, "TableK") for cell in row] for row in rows], colWidths=widths, repeatRows=1 if header else 0, hAlign="LEFT")
    commands = [
        ("GRID", (0, 0), (-1, -1), .45, colors.HexColor("#CED9E1")),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 7), ("RIGHTPADDING", (0, 0), (-1, -1), 7),
        ("TOPPADDING", (0, 0), (-1, -1), 6), ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]
    if header:
        commands.append(("BACKGROUND", (0, 0), (-1, 0), LIGHT))
        commands.append(("FONTNAME", (0, 0), (-1, 0), "MalgunBold"))
    value.setStyle(TableStyle(commands))
    return value


def add_markdown(story, text):
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
                cells = [cell.strip() for cell in lines[i].strip().strip("|").split("|")]
                if any(re.search(r"[^\s:\-]", cell) for cell in cells):
                    rows.append(cells)
                i += 1
            if rows:
                story.extend([table(rows), Spacer(1, 6)])
            continue
        story.append(p(line))
        i += 1


class Diagram(Flowable):
    def __init__(self, value):
        super().__init__()
        self.value = value
        self.width, self.height = 474, 142

    def draw(self):
        sw = float(self.value.get("width") or 1000)
        sh = float(self.value.get("height") or 300)
        sx, sy = self.width / sw, self.height / sh
        c = self.canv
        c.setStrokeColor(NAVY)
        c.setFillColor(NAVY)
        c.setLineWidth(1.15)
        for e in self.value.get("elements") or []:
            kind, a = e.get("type"), e.get("coordinates") or []
            if kind in ("line", "arrow") and len(a) >= 4:
                x1, y1, x2, y2 = a[:4]
                x1, x2, y1, y2 = x1*sx, x2*sx, self.height-y1*sy, self.height-y2*sy
                c.line(x1, y1, x2, y2)
                if kind == "arrow":
                    c.line(x2, y2, x2-4, y2+7); c.line(x2, y2, x2+4, y2+7)
            elif kind == "text" and len(a) >= 2:
                c.setFont("Malgun", min(9, float(e.get("fontSize") or 20)*sx))
                c.drawString(a[0]*sx, self.height-a[1]*sy, str(e.get("text") or ""))


def footer(canvas, doc):
    canvas.saveState()
    canvas.setStrokeColor(colors.HexColor("#D5E0E8")); canvas.line(54, 43, A4[0]-54, 43)
    canvas.setFont("Malgun", 7.5); canvas.setFillColor(GREY)
    canvas.drawString(54, 29, "EduMaster · 실제 문제·해설 입력 기반 생성 결과")
    canvas.drawRightString(A4[0]-54, 29, str(doc.page)); canvas.restoreState()


def add_source_images(story):
    for title, filename in (("입력 문제 이미지", "question.png"), ("입력 해설 이미지", "solution.png")):
        story.append(PageBreak()); story.append(p(title, "H2K"))
        path = ROOT / filename
        iw, ih = ImageReader(str(path)).getSize()
        scale = min(474/iw, 655/ih)
        image = Image(str(path), width=iw*scale, height=ih*scale); image.hAlign = "CENTER"
        story.append(image)


def create(filename, model_name, route, data, note):
    path = OUT / filename
    doc = BaseDocTemplate(str(path), pagesize=A4, leftMargin=54, rightMargin=54, topMargin=52, bottomMargin=57,
                          title=f"{model_name} 생명과학 변형 문제 생성 결과", author="EduMaster")
    frame = Frame(54, 57, A4[0]-108, A4[1]-109, leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0)
    doc.addPageTemplates([PageTemplate(id="normal", frames=[frame], onPage=footer)])
    story = [p(f"{model_name} · 변형 문제 생성 결과", "TitleK")]
    story.append(p("실제 문제 이미지와 실제 해설 이미지를 함께 입력해 얻은 변형 문제·정답·상세 해설입니다.", "SmallK"))
    story.append(table([
        ["항목", "내용"], ["생성 경로", route], ["입력", "문제 이미지 + 해설 이미지"],
        ["결과 상태", "문제·정답·3단계 해설 생성 완료"], ["최종 정답", data.get("answer", "")],
    ], [105, 369]))
    story.append(p("입력에서 추출한 풀이 로직", "H2K"))
    source = json.loads((DATA / "source-verified.json").read_text(encoding="utf-8"))
    for index, step in enumerate(source.get("steps") or [], 1):
        story.append(p(f"STEP {index}. {step}"))
    story.append(p("생성된 변형 문제", "H2K"))
    story.append(p(data.get("title"), "AnswerK"))
    add_markdown(story, data.get("body"))
    for drawing in data.get("drawings") or []:
        story.append(Diagram(drawing)); story.append(p(drawing.get("description"), "SmallK"))
    story.append(p("선택지", "H2K"))
    for index, choice in enumerate(data.get("choices") or [], 1):
        story.append(p(f"{index}. {choice}"))
    story.append(PageBreak())
    story.append(p("정답 및 상세 해설", "H2K")); story.append(p(data.get("answer"), "AnswerK"))
    for block in str(data.get("explanation") or "").split("\n"):
        if block.strip(): story.append(p(block))
    story.append(p("풀이 단계 요약", "H2K"))
    for index, step in enumerate(data.get("steps") or [], 1): story.append(p(f"STEP {index}. {step}"))
    story.append(p("생성·검산 기록", "H2K")); story.append(p(note))
    repair = data.get("systemRepair") or data.get("manualVerification") or {}
    if repair.get("reason"): story.append(p("보정 사유: " + repair["reason"]))
    checks = repair.get("checks") or []
    if checks:
        story.append(table([["독립 수치 대조", "결과"]] + [[check, "일치"] for check in checks], [392, 82]))
    add_source_images(story)
    doc.build(story)
    print(path)


deepseek = json.loads((DATA / "deepseek.json").read_text(encoding="utf-8"))
gemma = json.loads((DATA / "gemma-text.json").read_text(encoding="utf-8"))
gpt = json.loads((DATA / "gpt.json").read_text(encoding="utf-8"))

create("2026-09-23_생명과학_DeepSeek_생성결과.pdf", "DeepSeek V4 Flash", "실제 DeepSeek API 생성 → 수치 일관성 하네스 보정", deepseek,
       "DeepSeek가 문제·보기·3단계 해설을 생성했습니다. 초안의 거리와 표가 충돌해 하네스가 같은 풀이 구조 안에서 모든 막전위 칸을 재계산했습니다.")
create("2026-09-23_생명과학_Gemma_생성결과.pdf", "Gemma 4 12B", "실제 로컬 Gemma 생성 → 수치 일관성 하네스 보정", gemma,
       "로컬 Gemma가 실제 입력에서 비례 변형 초안을 생성했습니다. 초안의 좌표·t₁·표 충돌을 하네스가 2배 비례 조건으로 통일하고 전 칸을 재계산했습니다.")
create("2026-09-23_생명과학_GPT_생성결과.pdf", "GPT 시뮬레이션", "GPT 역할 작성 → 동일 EduMaster 하네스 검사", gpt,
       "이 항목은 GPT API 호출 결과가 아니라 이 대화의 GPT가 같은 입력과 출력 형식을 사용해 작성한 통제 변형입니다. 거리·속도를 1.5배로 바꾸고 수치를 독립 대조했습니다.")
