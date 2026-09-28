"""Reuse validated exercises and regenerate the rejected final draft only."""
import json
import time
import uuid
import urllib.request
from pathlib import Path

root = Path('/home/lmo0317/apps/edumaster')
work = root / 'feedback-verification'
token = (root / 'backend/access-token.txt').read_text().strip()
base = 'http://127.0.0.1:18282'

def api(path, data=None):
    request = urllib.request.Request(base + path,
        data=None if data is None else json.dumps(data).encode(),
        headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
    with urllib.request.urlopen(request, timeout=240) as response:
        return json.load(response)

old_id = json.loads((work / 'start.json').read_text())['id']
old = api('/api/jobs/' + old_id)
print('Rechecked cached set:', old['state'], [(o['stageNumber'], o['state']) for o in old['outputs']], flush=True)
assert old['state'] == 'failed', 'The method-changing draft was not rejected'
request = json.loads((work / 'generation-request.json').read_text())
request['requestId'] = uuid.uuid4().hex
start = api('/api/generate', request)
job_id = start['id']
(work / 'resume-start.json').write_text(json.dumps(start))
print('Resumed:', start, flush=True)
previous = None
for _ in range(240):
    job = api('/api/jobs/' + job_id)
    if previous is None and job.get('preparedCount', 0) != 2:
        api('/api/jobs/' + job_id + '/cancel', {})
        raise RuntimeError('The validated two-exercise prefix was not reused')
    if job.get('phase') != previous:
        print(job.get('elapsedSeconds'), job.get('phase'), flush=True)
        previous = job.get('phase')
    (work / 'resume-latest.json').write_text(json.dumps(job, ensure_ascii=False, indent=2))
    if job['state'] in ['ready', 'failed', 'cancelled']:
        print('Final state:', job['state'], job.get('error'), flush=True)
        (work / 'resume-result.json').write_text(json.dumps(job, ensure_ascii=False, indent=2))
        break
    time.sleep(5)
