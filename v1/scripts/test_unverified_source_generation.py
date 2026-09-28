import os
import json
import time
import uuid
import urllib.request
import urllib.error
from pathlib import Path

BASE = "https://minohlee.mooo.com/edumaster/api/"
TOKEN = os.environ['EDUMASTER_ACCESS_CODE']
source = json.loads(Path("artifacts/imported_material.json").read_text(encoding="utf-8"))

payload = {
    "title": source["title"],
    "body": source["body"],
    "answer": source["answer"],
    "explanation": source["explanation"],
    "logicSteps": source["steps"],
    "variantMode": "integrated",
    "sourceId": source["sourceId"],
    "requiresImage": bool(source.get("needsReview")),
    "fromSolution": False,
    "useSolutionLogic": True,
    "provider": "deepseek",
    "requestId": uuid.uuid4().hex,
    "stageSeries": True,
    "expectedStageCount": len(source["steps"]),
}

def call(path, method="GET", value=None, timeout=60):
    body = None if value is None else json.dumps(value, ensure_ascii=False).encode("utf-8")
    headers = {"Authorization": "Bearer " + TOKEN}
    if body is not None:
        headers["Content-Type"] = "application/json; charset=utf-8"
    request = urllib.request.Request(BASE + path, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        raise RuntimeError(f"HTTP {error.code}: {error.read().decode('utf-8')}") from error

started = call("generate", "POST", payload)
assert started.get("id"), started
print("STARTED", started["id"], flush=True)

deadline = time.time() + max(720, len(source["steps"]) * 480 + 120)
last = None
while time.time() < deadline:
    job = call("jobs/" + started["id"], timeout=30)
    snapshot = (job.get("state"), job.get("phase"), tuple((o.get("state"), o.get("phase"), o.get("error")) for o in job.get("outputs", [])))
    if snapshot != last:
        print(json.dumps({"state": job.get("state"), "phase": job.get("phase"), "outputs": [
            {"stage": o.get("stageLabel"), "state": o.get("state"), "phase": o.get("phase"), "error": o.get("error")}
            for o in job.get("outputs", [])]}, ensure_ascii=False), flush=True)
        last = snapshot
    if job.get("state") in ("ready", "failed", "cancelled"):
        Path("artifacts/unverified-source-generation.json").write_text(json.dumps(job, ensure_ascii=False, indent=2), encoding="utf-8")
        assert job["state"] == "ready", job.get("error")
        assert len(job.get("outputs", [])) == len(source["steps"])
        assert all(o.get("state") == "ready" and o.get("result") for o in job["outputs"])
        print("READY", len(job["outputs"]), flush=True)
        break
    time.sleep(5)
else:
    raise TimeoutError("generation did not finish within the per-stage deadline")
