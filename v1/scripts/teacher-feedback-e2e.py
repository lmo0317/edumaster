"""Run on the existing backend host. No credentials are copied or printed."""
import json
import re
import time
import uuid
import urllib.request
from pathlib import Path

root = Path('/home/lmo0317/apps/edumaster')
work = root / 'feedback-verification'
token = (root / 'backend/access-token.txt').read_text().strip()
base = 'http://127.0.0.1:18282'

def api(path, data=None, method=None, content_type='application/json', timeout=240):
    if data is not None and not isinstance(data, bytes):
        data = json.dumps(data, ensure_ascii=False).encode()
    req = urllib.request.Request(base + path, data=data, method=method,
        headers={'Authorization': 'Bearer ' + token, 'Content-Type': content_type})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        raise RuntimeError(f'HTTP {error.code}: {error.read().decode()}') from None

def save(name, data):
    (work / name).write_text(json.dumps(data, ensure_ascii=False, indent=2))

desired = json.loads((work / 'guidance.json').read_text())
for attempt in range(30):
    try:
        old = api('/api/learning/guidance')
        break
    except urllib.error.URLError:
        time.sleep(1)
else:
    raise RuntimeError('Backend did not become ready')
save('guidance-before.json', old)
for key in ['do', 'dont']:
    if desired[key] not in old.get(key, ''):
        old[key] = (old.get(key, '') + '\n' + desired[key]).strip()
stored = api('/api/learning/guidance', {'do': old['do'], 'dont': old['dont']}, 'PUT')
print('Common teacher feedback saved:', stored.get('updatedAt'), flush=True)

boundary = uuid.uuid4().hex
parts = []
for key, value in [('provider', 'deepseek'), ('materialKind', 'problem-solution-separate'), ('requestId', uuid.uuid4().hex)]:
    parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{key}"\r\n\r\n{value}\r\n'.encode())
for key, file in [('questionFile', 'question.png'), ('solutionFile', 'solution.png')]:
    parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{key}"; filename="{file}"\r\nContent-Type: image/png\r\n\r\n'.encode() + (work / file).read_bytes() + b'\r\n')
body = b''.join(parts) + f'--{boundary}--\r\n'.encode()
material = api('/api/import', body, 'POST', f'multipart/form-data; boundary={boundary}')
save('material.json', material)
print('Original images analysed; answer:', material['answer'], 'STEP count:', len(material['steps']), flush=True)
print('Teacher explanation:', material['explanation'], flush=True)
assert len(material['steps']) == 3, 'The printed three STEP headings were not preserved'
assert all(re.search(r'(?<![A-Za-z])' + v + r'\s*mol', material['explanation']) for v in ['n', 'm']), 'Original n/m helper definitions were lost'
assert re.search('가정|만약', material['explanation']) and re.search('모순|자료와\s*맞지|일치하지', material['explanation']), 'Original comparison and contradiction method was lost'
request = {key: material[key] for key in ['title', 'body', 'answer', 'explanation', 'sourceId']}
request.update(title='교사 피드백 반영 검증 · 몰질량', provider='deepseek', requestId=uuid.uuid4().hex,
    requiresImage=True, useSolutionLogic=True, logicSteps=material['steps'], stageSeries=True,
    expectedStageCount=len(material['steps']), variantMode='integrated')
save('generation-request.json', request)
start = api('/api/generate', request, 'POST')
save('start.json', start)
print('Generation started:', start, flush=True)
job_id = start.get('jobId') or start.get('id')
assert job_id, start
previous = None
for _ in range(300):
    job = api('/api/jobs/' + job_id)
    if job.get('phase') != previous:
        print(job.get('elapsedSeconds'), job.get('phase'), flush=True)
        previous = job.get('phase')
    save('latest.json', job)
    if job['state'] in ['ready', 'failed', 'cancelled']:
        print('Final state:', job['state'], job.get('error'), flush=True)
        save('result.json', job)
        break
    time.sleep(5)
else:
    raise RuntimeError('Live verification deadline reached')
