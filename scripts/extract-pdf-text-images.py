"""Crop original problem text pixels from PDF images, without OCR or retyping."""
from pathlib import Path
from io import BytesIO
import hashlib
import json
import pymupdf
from PIL import Image

root = Path(__file__).resolve().parents[1]
samples = root / 'docs/참고자료/샘플자료'
metadata_path = samples / '추출정보.json'
metadata = json.loads(metadata_path.read_text(encoding='utf-8'))
pdf_path = root / metadata['source']
assert hashlib.sha256(pdf_path.read_bytes()).hexdigest() == metadata['source_sha256']
doc = pymupdf.open(pdf_path)
output = samples / '원본문자'
output.mkdir(exist_ok=True)
web = root / 'src/EduMaster.Web/wwwroot/samples'
entries = []
specs = [
    (2, '02페이지_킬러문제와해설.jpeg', '01_반응량_문자.png', 'reaction-text.png',
     [('지문·반응식', (16, 44, 305, 144)), ('질문', (16, 287, 305, 335)),
      ('정답 선택지', (16, 376, 305, 400))]),
    (5, '05페이지_분자구조문제와해설.jpeg', '02_분자구조_문자.png', 'structure-text.png',
     [('지문', (35, 70, 510, 100)), ('질문', (35, 391, 510, 443)),
      ('보기 본문', (48, 478, 495, 635)), ('정답 선택지', (30, 657, 500, 690))]),
]
for page, original, filename, asset, regions in specs:
    reference = (samples / '원본이미지' / original).read_bytes()
    extracted = [doc.extract_image(item[0])['image'] for item in doc[page - 1].get_images(full=True)]
    raw = next((data for data in extracted if data == reference), None)
    assert raw is not None, f'Original embedded image changed: {original}'
    original_image = Image.open(BytesIO(raw)).convert('RGB')
    height = sum(box[3] - box[1] for _, box in regions) + 12 * (len(regions) - 1)
    combined = Image.new('RGB', (original_image.width if page == 2 else 536, height), 'white')
    offset = 0
    recorded_regions = []
    for label, box in regions:
        crop = original_image.crop(box)
        combined.paste(crop, (box[0], offset))
        copied = combined.crop((box[0], offset, box[2], offset + crop.height))
        assert copied.tobytes() == crop.tobytes(), 'Text pixels changed'
        recorded_regions.append({'label': label, 'original_pixel_crop': list(box),
                                 'output_origin': [box[0], offset], 'pixels_match': True})
        offset += crop.height + 12
    # Keep only the problem column, without the answer/explanation column.
    if page == 2:
        combined = combined.crop((0, 0, 321, combined.height))
    combined.save(output / filename)
    data = (output / filename).read_bytes()
    (web / asset).write_bytes(data)
    entries.append({'file': '원본문자/' + filename, 'web_asset': asset, 'page': page,
                    'original_image': original, 'width': combined.width, 'height': combined.height,
                    'sha256': hashlib.sha256(data).hexdigest(), 'regions': recorded_regions})
metadata['text_only_extraction_note'] = 'PDF 내장 이미지에서 지문·반응식·질문·보기의 원본 픽셀만 잘라 세로로 배치했습니다. OCR·재입력·재조판·확대 없음. 표와 분류도는 제외하며, 선택한 문자 영역의 원본 필기는 보존합니다. 완전한 문제 입력용 자료가 아닙니다.'
metadata['text_only_images'] = entries
metadata_path.write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print('Extracted 2 original text-only images; all 7 source regions retain identical pixels.')
