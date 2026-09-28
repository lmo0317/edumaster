from pathlib import Path
import fitz
from PIL import Image, ImageDraw

root = Path(__file__).resolve().parents[2]
out = root / "tmp" / "actual-reports"
out.mkdir(parents=True, exist_ok=True)

for pdf in sorted((root / "output" / "pdf").glob("*_생성결과.pdf")):
    doc = fitz.open(pdf)
    images = []
    for index, page in enumerate(doc):
        pix = page.get_pixmap(matrix=fitz.Matrix(1.15, 1.15), alpha=False)
        target = out / f"{pdf.stem}-{index+1}.png"
        pix.save(target)
        images.append(Image.open(target).convert("RGB"))
    thumb_w = 430
    thumbs = []
    for image in images:
        height = round(image.height * thumb_w / image.width)
        thumbs.append(image.resize((thumb_w, height)))
    canvas = Image.new("RGB", (thumb_w * 2 + 30, max(thumb.height for thumb in thumbs) * ((len(thumbs)+1)//2) + 60), "#d9dde2")
    draw = ImageDraw.Draw(canvas)
    for index, thumb in enumerate(thumbs):
        x = 10 + (index % 2) * (thumb_w + 10)
        y = 10 + (index // 2) * (thumb.height + 20)
        canvas.paste(thumb, (x, y)); draw.text((x+4, y+thumb.height+2), str(index+1), fill="black")
    contact = out / f"{pdf.stem}-contact.png"
    canvas.save(contact)
    print(pdf.name, len(doc), contact)
