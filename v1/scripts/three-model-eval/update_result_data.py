import json
from pathlib import Path

root = Path(__file__).resolve().parents[2]
data_dir = root / "artifacts" / "three-model-eval"
source = json.loads((data_dir / "source-verified.json").read_text(encoding="utf-8"))
deepseek = json.loads((data_dir / "deepseek.json").read_text(encoding="utf-8"))
gemma_text = json.loads((data_dir / "gemma-text.json").read_text(encoding="utf-8"))
gpt = json.loads((data_dir / "gpt.json").read_text(encoding="utf-8"))

def public_result(value):
    return {key: value.get(key) for key in (
        "title", "body", "choices", "answer", "explanation", "steps", "changeSummary",
        "model", "runtimeModelId", "state", "quality", "systemRepair", "manualVerification"
    ) if value.get(key) is not None}

payload = {
    "gemma": public_result(gemma_text),
    "deepseek": public_result(deepseek),
    "gpt": public_result(gpt),
    "source": {
        "title": source.get("title", "입력 문제"),
        "body": source.get("body", ""),
        "answer": source.get("answer", ""),
        "explanation": source.get("explanation", ""),
        "steps": source.get("steps", []),
    },
}

text = json.dumps(payload, ensure_ascii=False, indent=2)
for destination in (root / "variants_data.json", root / "src" / "EduMaster.Web" / "wwwroot" / "result" / "variants_data.json"):
    destination.write_text(text + "\n", encoding="utf-8")
    print(destination)
