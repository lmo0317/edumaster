import hashlib
import json
import shutil
from datetime import datetime, timezone
from pathlib import Path

root = Path(__file__).resolve().parents[2]
source_dir = root / "output" / "pdf"
staging = root / "artifacts" / "three-model-eval" / "archive"
staging.mkdir(parents=True, exist_ok=True)

reports = [
    ("[Gemma 4 12B] 생명과학 변형 문제·해설 생성 결과", source_dir / "2026-09-23_생명과학_Gemma_생성결과.pdf"),
    ("[DeepSeek] 생명과학 변형 문제·해설 생성 결과", source_dir / "2026-09-23_생명과학_DeepSeek_생성결과.pdf"),
    ("[GPT 시뮬레이션] 생명과학 변형 문제·해설 생성 결과", source_dir / "2026-09-23_생명과학_GPT_생성결과.pdf"),
]

for old in staging.glob("*"):
    if old.is_file():
        old.unlink()

now = datetime.now(timezone.utc)
for index, (title, source) in enumerate(reports):
    report_id = hashlib.sha256(("2026-09-23|" + title).encode()).hexdigest()[:32]
    pdf_target = staging / f"{report_id}.pdf"
    json_target = staging / f"{report_id}.json"
    shutil.copy2(source, pdf_target)
    created = now.replace(microsecond=min(999999, now.microsecond + index))
    metadata = {
        "id": report_id,
        "title": title,
        "createdAt": created.isoformat().replace("+00:00", "Z"),
        "size": pdf_target.stat().st_size,
    }
    json_target.write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(report_id, title, metadata["size"])
