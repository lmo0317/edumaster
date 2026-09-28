"""Check only EduMaster login availability; never print the credential or fetch jobs."""
import json
import time
import urllib.error
import urllib.request
from pathlib import Path

root = Path(__file__).resolve().parent.parent
report = []
for base in ['http://127.0.0.1:18280/', 'https://minohlee.mooo.com/edumaster/']:
    for endpoint in ['', 'app.js', 'api/status']:
        started = time.monotonic()
        item = {'base': base, 'endpoint': endpoint, 'authenticatedRequest': False}
        try:
            with urllib.request.urlopen(base + endpoint, timeout=25) as response:
                body = response.read()
                item.update(status=response.status, bytes=len(body))
                if endpoint == '':
                    item['htmlMatchesLocal'] = body == (root / 'artifacts/web/wwwroot/index.html').read_bytes()
                elif endpoint == 'app.js':
                    item['jsMatchesLocal'] = body == (root / 'artifacts/web/wwwroot/app.js').read_bytes()
                else:
                    data = json.loads(body)
                    item['modelReady'] = data.get('ready')
                    item['error'] = data.get('error')
        except urllib.error.HTTPError as error:
            item['status'] = error.code
        except Exception as error:
            item.update(errorType=type(error).__name__, error=str(error))
        item['seconds'] = round(time.monotonic() - started, 2)
        report.append(item)
        print(json.dumps(item, ensure_ascii=False), flush=True)
(root / 'artifacts/evidence/web/login-diagnostics.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
