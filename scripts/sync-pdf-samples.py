"""Verify default samples against embedded PDF pixels, then copy web assets."""
from pathlib import Path
from io import BytesIO
import hashlib
import json
import pymupdf
from PIL import Image

root = Path(__file__).resolve().parents[1]
samples = root / 'docs/샘플/샘플자료'
if not samples.exists():
    samples = root / 'docs/참고자료/샘플자료'
web = root / 'src/EduMaster.Web/wwwroot/samples'
metadata = json.loads((samples / '추출정보.json').read_text(encoding='utf-8'))
pdf_path = root / metadata['source']
if not pdf_path.exists():
    pdf_path = root / 'docs/샘플/프로그램.pdf'
digest = lambda data: hashlib.sha256(data).hexdigest()
assert digest(pdf_path.read_bytes()) == metadata['source_sha256'], 'Source PDF changed'
doc = pymupdf.open(pdf_path)
checks = []
for source, original, asset in [
    ('01_반응량_문제.png', '02페이지_킬러문제와해설.jpeg', 'reaction.png'),
    ('04_분자구조_문제.png', '05페이지_분자구조문제와해설.jpeg', 'structure.png'),
]:
    info = next(item for item in metadata['images'] if item['file'] == source)
    raw = (samples / '원본이미지' / original).read_bytes()
    embedded = [doc.extract_image(item[0])['image'] for item in doc[info['page'] - 1].get_images(full=True)]
    assert raw in embedded, f'{original} differs from embedded PDF image'
    crop = Image.open(BytesIO(raw)).convert('RGB').crop(info['original_pixel_crops'][0])
    actual = Image.open(samples / source).convert('RGB')
    assert actual.size == crop.size and actual.tobytes() == crop.tobytes(), f'{source} changed PDF pixels'
    data = (samples / source).read_bytes()
    (web / asset).write_bytes(data)
    checks.append({'asset': asset, 'kind': 'pdf-original-crop', 'pdfPage': info['page'],
                   'originalEmbeddedBytesMatch': True, 'originalCropPixelsMatch': True,
                   'sha256': digest(data), 'width': actual.width, 'height': actual.height})
(web / 'reaction-original.png').write_bytes((web / 'reaction.png').read_bytes())
for source, asset in [('07_반응량_고해상도예시.png', 'reaction-reconstructed.png'),
                       ('08_직선그래프_연결관계예시.png', 'graph.png')]:
    data = (samples / source).read_bytes()
    (web / asset).write_bytes(data)
    checks.append({'asset': asset, 'kind': 'separately-created-test-fixture', 'sha256': digest(data)})
evidence = root / 'artifacts/evidence/web/pdf-sample-fidelity.json'
evidence.parent.mkdir(parents=True, exist_ok=True)
evidence.write_text(json.dumps({'sourcePdfSha256': metadata['source_sha256'], 'samples': checks},
                               ensure_ascii=False, indent=2), encoding='utf-8')
print('Verified PDF embedded bytes and original crop pixels; synchronized original defaults and separate test fixtures.')
