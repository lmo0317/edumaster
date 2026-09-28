from __future__ import annotations

from pathlib import Path
from fractions import Fraction
from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "docs" / "샘플" / "샘플자료"
REGULAR = r"C:\Windows\Fonts\malgun.ttf"
BOLD = r"C:\Windows\Fonts\malgunbd.ttf"

WIDTH = 1600
MARGIN = 110
INK = "#172033"
MUTED = "#526176"
ACCENT = "#136f63"
LINE = "#aab4c2"
SOFT = "#edf7f5"


def verify_numbers() -> None:
    # MA:MB:MC = 2:4:5 follows from a=b and A+2B->2C.
    ma, mb, mc = Fraction(2), Fraction(4), Fraction(5)
    assert ma + 2 * mb == 2 * mc
    density_i = Fraction(40 + 80, 4 + Fraction(4, 2))
    density_ii = Fraction(60 + 160, Fraction(3, 2) * 4 + 4)
    assert density_i / density_ii == Fraction(10, 11)
    assert (mb + mc) / ma == Fraction(9, 2)


def font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(BOLD if bold else REGULAR, size)


def line(draw: ImageDraw.ImageDraw, xy, fill=LINE, width=2):
    draw.line(xy, fill=fill, width=width)


def wrapped(draw: ImageDraw.ImageDraw, text: str, x: int, y: int, max_width: int,
            f: ImageFont.FreeTypeFont, spacing: int = 16, fill=INK) -> int:
    lines: list[str] = []
    for paragraph in text.split("\n"):
        if not paragraph:
            lines.append("")
            continue
        current = ""
        for token in paragraph.split(" "):
            candidate = token if not current else f"{current} {token}"
            if draw.textbbox((0, 0), candidate, font=f)[2] <= max_width:
                current = candidate
            else:
                if current:
                    lines.append(current)
                current = token
        if current:
            lines.append(current)
    for item in lines:
        draw.text((x, y), item, font=f, fill=fill)
        y += f.size + spacing
    return y


def rounded_label(draw: ImageDraw.ImageDraw, text: str, x: int, y: int, w: int = 220):
    draw.rounded_rectangle((x, y, x + w, y + 54), radius=16, fill=SOFT)
    draw.text((x + 22, y + 10), text, font=font(25, True), fill=ACCENT)


def table(draw: ImageDraw.ImageDraw, x: int, y: int):
    widths = [150, 300, 300, 390]
    heights = [74, 78, 78]
    total_w = sum(widths)
    total_h = sum(heights)
    draw.rectangle((x, y, x + total_w, y + total_h), outline=INK, width=3)
    cx = x
    for w in widths[:-1]:
        cx += w
        line(draw, (cx, y, cx, y + total_h), fill=INK, width=2)
    cy = y
    for h in heights[:-1]:
        cy += h
        line(draw, (x, cy, x + total_w, cy), fill=INK, width=2)

    heads = ["실험", "A(g)의 질량(g)", "B(g)의 질량(g)", "반응 후 전체 기체의\n밀도(상댓값)"]
    rows = [["Ⅰ", "40w", "80w", "10"], ["Ⅱ", "60w", "160w", "11"]]
    cx = x
    for idx, (head, w) in enumerate(zip(heads, widths)):
        box = draw.multiline_textbbox((0, 0), head, font=font(25, True), spacing=5, align="center")
        tw, th = box[2] - box[0], box[3] - box[1]
        draw.multiline_text((cx + (w - tw) / 2, y + (heights[0] - th) / 2 - 2), head,
                            font=font(25, True), fill=INK, spacing=5, align="center")
        cx += w
    cy = y + heights[0]
    for row_index, row in enumerate(rows):
        cx = x
        for value, w in zip(row, widths):
            box = draw.textbbox((0, 0), value, font=font(29))
            tw, th = box[2] - box[0], box[3] - box[1]
            draw.text((cx + (w - tw) / 2, cy + (heights[row_index + 1] - th) / 2 - 5), value,
                      font=font(29), fill=INK)
            cx += w
        cy += heights[row_index + 1]


def create_problem() -> Path:
    height = 1800
    image = Image.new("RGB", (WIDTH, height), "white")
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((46, 46, WIDTH - 46, height - 46), radius=28, outline="#92a1b6", width=4)

    draw.text((MARGIN, 92), "화학Ⅰ · 고난도 양적 관계 샘플", font=font(32, True), fill=ACCENT)
    draw.text((MARGIN, 164), "01", font=font(44, True), fill=INK)
    y = 260
    y = wrapped(draw,
        "다음은 A(g)와 B(g)가 반응하여 C(g)를 생성하는 반응의 화학 반응식이다.",
        MARGIN, y, WIDTH - 2 * MARGIN, font(34), 20)
    draw.text((470, y + 20), "A(g) + 2B(g) → 2C(g)", font=font(42, True), fill=INK)
    y += 110
    y = wrapped(draw,
        "표는 실린더에 A(g)와 B(g)의 질량을 달리하여 넣고 반응을 완결시킨 실험 Ⅰ과 Ⅱ에 대한 자료이다.",
        MARGIN, y, WIDTH - 2 * MARGIN, font(34), 20)
    y += 30
    table(draw, MARGIN + 80, y)
    y += 290
    draw.rounded_rectangle((MARGIN, y, WIDTH - MARGIN, y + 108), radius=18, fill="#f6f8fb")
    wrapped(draw, "두 실험에서 B(g)는 모두 반응하였다. 실린더 속 기체의 온도와 압력은 일정하다.",
            MARGIN + 28, y + 24, WIDTH - 2 * MARGIN - 56, font(28), 12, MUTED)
    y += 160
    y = wrapped(draw, "(B의 분자량 + C의 분자량) / A의 분자량은?  [3점]",
                MARGIN, y, WIDTH - 2 * MARGIN, font(36, True), 18)
    y += 55
    choices = ["①  7/2", "②  4", "③  17/4", "④  9/2", "⑤  5"]
    draw.rounded_rectangle((MARGIN, y, WIDTH - MARGIN, y + 105), radius=20, outline=LINE, width=3)
    x = MARGIN + 38
    for choice in choices:
        draw.text((x, y + 31), choice, font=font(31), fill=INK)
        x += 258

    draw.text((MARGIN, height - 125), "EduMaster 내부 생성 샘플 · 원문 기출과 수치·문장 분리", font=font(23), fill=MUTED)
    path = OUTPUT / "06_유사킬러_화학반응_문제.png"
    image.save(path, optimize=True)
    return path


def stage(draw: ImageDraw.ImageDraw, number: str, title: str, body: str, y: int) -> int:
    rounded_label(draw, f"STEP {number}", MARGIN, y, 185)
    draw.text((MARGIN + 220, y + 6), title, font=font(31, True), fill=INK)
    y += 78
    y = wrapped(draw, body, MARGIN + 20, y, WIDTH - 2 * MARGIN - 40, font(28), 15)
    y += 30
    line(draw, (MARGIN, y, WIDTH - MARGIN, y), fill="#d8dee7", width=2)
    return y + 35


def create_solution() -> Path:
    height = 2380
    image = Image.new("RGB", (WIDTH, height), "white")
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((46, 46, WIDTH - 46, height - 46), radius=28, outline="#92a1b6", width=4)

    draw.text((MARGIN, 92), "정답 및 풀이", font=font(48, True), fill=INK)
    draw.rounded_rectangle((MARGIN, 180, WIDTH - MARGIN, 300), radius=22, fill=SOFT)
    draw.text((MARGIN + 38, 210), "정답 ④   9/2", font=font(39, True), fill=ACCENT)
    y = 355

    y = stage(draw, "1", "기준 물질량을 둔다",
        "실험 Ⅰ의 40w g A(g)의 양을 a mol, 80w g B(g)의 양을 b mol이라 둔다. "
        "B가 모두 반응하므로 실험 Ⅰ의 반응 후 기체는 (a - b/2) mol의 A와 b mol의 C이다. "
        "따라서 반응 후 전체 기체의 양은 a + b/2 mol이다.", y)

    y = stage(draw, "2", "두 실험의 반응 후 물질량을 비교한다",
        "실험 Ⅱ에서 A의 처음 양은 3a/2 mol, B의 처음 양은 2b mol이다. "
        "B가 모두 반응한 뒤에는 (3a/2 - b) mol의 A와 2b mol의 C가 남는다. "
        "반응 후 전체 기체의 양은 3a/2 + b mol이다.", y)

    y = stage(draw, "3", "밀도비로 a와 b의 관계를 구한다",
        "같은 온도와 압력에서 기체의 밀도는 '전체 질량 / 전체 물질량'에 비례한다.\n"
        "[120w / (a + b/2)] : [220w / (3a/2 + b)] = 10 : 11\n"
        "이를 정리하면 a = b이다.", y)

    y = stage(draw, "4", "분자량비와 물음의 값을 계산한다",
        "MA : MB = (40w/a) : (80w/b) = 1 : 2이다.\n"
        "반응식 A + 2B → 2C에서 질량 보존을 적용하면 MA + 2MB = 2MC이다. "
        "따라서 MB = 2MA, MC = (5/2)MA이다.\n"
        "(MB + MC) / MA = 2 + 5/2 = 9/2이므로 정답은 ④이다.", y)

    draw.rounded_rectangle((MARGIN, y + 10, WIDTH - MARGIN, y + 160), radius=20, fill="#f6f8fb")
    draw.text((MARGIN + 28, y + 34), "검산", font=font(27, True), fill=ACCENT)
    wrapped(draw, "MA : MB : MC = 2 : 4 : 5로 두면 2 + 2×4 = 2×5가 성립하고, 두 실험의 밀도비도 10 : 11이다.",
            MARGIN + 128, y + 32, WIDTH - 2 * MARGIN - 160, font(26), 12, MUTED)

    draw.text((MARGIN, height - 125), "EduMaster 내부 생성 샘플 · 풀이 단계는 이 문항의 실제 계산 흐름에 맞춰 구성", font=font(23), fill=MUTED)
    path = OUTPUT / "07_유사킬러_화학반응_정답해설.png"
    image.save(path, optimize=True)
    return path


if __name__ == "__main__":
    verify_numbers()
    OUTPUT.mkdir(parents=True, exist_ok=True)
    for created in (create_problem(), create_solution()):
        with Image.open(created) as img:
            print(f"{created}: {img.width}x{img.height}")
