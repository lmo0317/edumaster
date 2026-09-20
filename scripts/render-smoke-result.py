"""Render a saved web-smoke result with the production canvas code, without browser authentication."""
import json
import subprocess
import sys
from pathlib import Path

root = Path(__file__).resolve().parent.parent
kind = "same-image" if "--same-image" in sys.argv else "problem-only" if "--problem-only" in sys.argv else "separate" if "--separate" in sys.argv else "combined"
stem = {
    "same-image": "material-web-same-image",
    "problem-only": "material-web-problem-only",
    "separate": "material-web-separate",
    "combined": "material-web",
}[kind]
evidence = root / "artifacts" / "evidence" / "web"
report = json.loads((evidence / f"{stem}-smoke.json").read_text(encoding="utf-8"))
result = report["generation"]["result"]
source = (root / "src" / "EduMaster.Web" / "wwwroot" / "app.js").read_text(encoding="utf-8")
start = source.index("// Problem Image Card Rendering")
end = source.index("async function copyImageCard()")
renderer = source[start:end]
payload = json.dumps(result, ensure_ascii=False).replace("</", "<\\/")
html = f"""<!doctype html><meta charset="utf-8"><style>html,body{{margin:0;background:white}}#problem-image{{display:block;width:800px;height:auto}}canvas{{display:none}}</style>
<canvas id="problem-canvas"></canvas><img id="problem-image"><button id="copy-image-footer" hidden></button><button id="download-image-footer" hidden></button>
<script>const $=id=>document.getElementById(id);let imageReady=false,busy=false;{renderer}\nconst result={payload};renderProblemToImage(result,false);</script>"""
page = evidence / f"{stem}-render.html"
output = evidence / f"{stem}-output.png"
page.write_text(html, encoding="utf-8")
edge = Path(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe")
profile = evidence / "edge-smoke-profile"
completed = subprocess.run([str(edge), "--headless", "--disable-gpu", "--hide-scrollbars", "--no-first-run", f"--user-data-dir={profile}", "--window-size=800,3000", f"--screenshot={output.resolve()}", page.resolve().as_uri()], text=True, encoding="utf-8", errors="replace", capture_output=True)
if completed.returncode or not output.exists() or output.stat().st_size < 10_000:
    raise SystemExit((completed.stderr or "").strip() or "PNG render failed")
print(f"Rendered {output.name}: {output.stat().st_size} bytes; source steps={len(report['import']['steps'])}; result steps={len(result['steps'])}")
