"""Makes reading views for scripts/e2e-real.js, mirroring readingViews() in public/app.js."""
import math, os, sys
from PIL import Image

def views(path):
    im = Image.open(path).convert('RGB')
    w, h = im.size
    scale = min(3, max(1, 1400 / w))
    W, H = round(w * scale), round(h * scale)
    tile = round(W * 1.3)
    if scale == 1 and H <= tile * 1.25:
        return []
    overlap = round(tile * 0.12)
    if math.ceil((H - overlap) / (tile - overlap)) > 6:
        tile = math.ceil(H / 6) + overlap
        overlap = round(tile * 0.12)
    big = im.resize((W, H), Image.LANCZOS)
    out, y = [], 0
    while len(out) < 6:
        hh = min(tile, H - y)
        out.append(big.crop((0, y, W, y + hh)))
        if y + hh >= H:
            break
        y += tile - overlap
    return out

for path in sys.argv[1:]:
    folder = path + '.views'
    os.makedirs(folder, exist_ok=True)
    for i, v in enumerate(views(path)):
        v.save(os.path.join(folder, f'{i:02d}.jpg'), quality=93)
    print(path, len(os.listdir(folder)), 'views')
