import glob
import os
from pathlib import Path

import pymupdf
from PIL import Image, ImageDraw

root = Path(__file__).resolve().parents[2]
files = sorted(glob.glob(str(root / "output" / "pdf" / "2026-09-23_생명과학_*.pdf")))
temp = root / "tmp" / "pdfs"
temp.mkdir(parents=True, exist_ok=True)
tiles = []
for path in files:
    doc = pymupdf.open(path)
    print(os.path.basename(path), "pages", len(doc), "text chars", [len(page.get_text()) for page in doc])
    if len(doc) < 3 or any(len(page.get_text()) < 25 for page in doc):
        raise RuntimeError("PDF has unexpectedly empty pages")
    for index, page in enumerate(doc):
        pix = page.get_pixmap(matrix=pymupdf.Matrix(1.0, 1.0), alpha=False)
        img = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
        img.thumbnail((420, 590))
        tile = Image.new("RGB", (450, 640), "white")
        tile.paste(img, ((450 - img.width) // 2, 18))
        ImageDraw.Draw(tile).text((10, 610), f"{Path(path).stem} p{index+1}", fill="black")
        tiles.append(tile)
canvas = Image.new("RGB", (450 * 3, 640 * ((len(tiles) + 2) // 3)), "#ddd")
for index, tile in enumerate(tiles):
    canvas.paste(tile, ((index % 3) * 450, (index // 3) * 640))
out = temp / "contact.png"
canvas.save(out)
print(out)
