import json
from pathlib import Path

root = Path(__file__).resolve().parents[2]
source = json.loads((root / "artifacts" / "imported_material.json").read_text(encoding="utf-8"))
body = source["body"]

# The question image contains handwritten answer notes. The printed table headers are
# I-IV only, and the provided solution explicitly says A's II and IV are both 0 mV.
old_header = "| | Ⅰ d₄ | Ⅱ d₂ | Ⅲ d₃ | Ⅳ d₁ |"
old_a = "| A | -80 | 0 | ? | -70 |"
if old_header not in body or old_a not in body:
    raise RuntimeError("The fresh import no longer matches the reviewed source; inspect it before generating.")
body = body.replace(old_header, "| | Ⅰ | Ⅱ | Ⅲ | Ⅳ |")
body = body.replace(old_a, "| A | -80 | 0 | ? | 0 |")

verified = {
    "title": "2022 대비 9월 모의평가 생명과학 I 16번",
    "body": body,
    "answer": source["answer"],
    "explanation": source["explanation"],
    "steps": source["steps"],
    "sourceId": source["sourceId"],
    "sourceImages": ["question.png", "solution.png"],
    "readMethod": source.get("readMethod"),
    "corrections": [
        "문제 표 머리글에서 손글씨 d₄/d₂/d₃/d₁ 매칭을 제거",
        "풀이 이미지의 'A의 II와 IV는 모두 0mV'와 대조해 A IV를 -70mV에서 0mV로 교정",
    ],
}
(root / "artifacts" / "three-model-eval" / "source-verified.json").write_text(
    json.dumps(verified, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
)
print("source verified", verified["answer"], len(verified["steps"]))
