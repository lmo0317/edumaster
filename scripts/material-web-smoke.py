"""One selected requirements-PDF example through the local web API; no credential output."""
import json
import time
import uuid
import sys
import base64
import urllib.request
import urllib.error
from pathlib import Path

root = Path(__file__).resolve().parent.parent
base = 'http://127.0.0.1:18280/api/'
credential = (root / 'artifacts/web/access-token.txt').read_text().strip()
headers = {'Authorization': 'Bearer ' + credential, 'X-EduMaster-Renderer': 'beaker-v1'}
separate = '--separate' in sys.argv
problem_only = '--problem-only' in sys.argv
same_image = '--same-image' in sys.argv
evidence = root / ('artifacts/evidence/web/material-web-same-image-smoke.json' if same_image else 'artifacts/evidence/web/material-web-problem-only-smoke.json' if problem_only else 'artifacts/evidence/web/material-web-separate-smoke.json' if separate else 'artifacts/evidence/web/material-web-smoke.json')

def request(path, payload=None, content_type='application/json', timeout=300):
    req = urllib.request.Request(base+path, data=payload, headers={**headers, 'Content-Type': content_type})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        data=json.load(error)
        raise RuntimeError(str(error.code)+': '+data.get('error','Request failed')) from None

def save(report):
    evidence.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')

if '--text-review-only' in sys.argv:
    report=json.loads(evidence.read_text(encoding='utf-8'))
    result=report['generation']['result']
    review=request('jobs/'+report['jobId']+'/text-check',json.dumps({'resultId':result['id']}).encode(),timeout=150)
    report['generation']['result']['quality']=review;save(report)
    print('Web text quality: '+review['state'],flush=True)
    print(json.dumps([c for c in review['checks'] if c['id'] in ('language','conditions','semantic-math','visual-semantics')],ensure_ascii=False),flush=True)
    raise SystemExit(0 if all(c['state']=='pass' for c in review['checks'] if c['id']!='render') else 1)

if '--render-only' in sys.argv:
    report=json.loads(evidence.read_text(encoding='utf-8'))
    result=report['generation']['result']
    rendered='material-web-same-image-output.png' if same_image else 'material-web-problem-only-output.png' if problem_only else 'material-web-separate-output.png' if separate else 'material-web-output.png'
    png='data:image/png;base64,'+base64.b64encode((root/'artifacts/evidence/web'/rendered).read_bytes()).decode()
    review=request('jobs/'+report['jobId']+'/render-check',json.dumps({'resultId':result['id'],'png':png,'includeAnswer':False}).encode())
    report['generation']['result']['quality']=review;save(report)
    print('Web final PNG quality: '+review['state'],flush=True)
    print(json.dumps(review['checks'][-1],ensure_ascii=False),flush=True)
    raise SystemExit(0 if review['state']=='pass' else 1)

boundary = uuid.uuid4().hex
fields = b''.join((f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n').encode()
                  for name, value in [('provider','deepseek'),('materialKind','problem-only' if problem_only else 'problem-solution-separate' if separate or same_image else 'problem-solution')])
def part(name,filename,path,mime='image/png'):
    return (f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"; filename="{filename}"\r\nContent-Type: {mime}\r\n\r\n').encode()+path.read_bytes()+b'\r\n'
if same_image:
    image=root/'docs/샘플/샘플자료/원본이미지/02페이지_킬러문제와해설.jpeg'
    payload=fields+part('questionFile','same.jpeg',image,'image/jpeg')+part('solutionFile','same.jpeg',image,'image/jpeg')+f'--{boundary}--\r\n'.encode()
elif problem_only:
    payload=fields+part('questionFile','question.png',root/'docs/샘플/샘플자료/01_반응량_문제.png')+f'--{boundary}--\r\n'.encode()
elif separate:
    payload=fields+part('questionFile','question.png',root/'docs/샘플/샘플자료/01_반응량_문제.png')+part('solutionFile','solution.png',root/'docs/샘플/샘플자료/02_반응량_정답해설.png')+f'--{boundary}--\r\n'.encode()
else:
    image=root/'docs/샘플/샘플자료/원본이미지/02페이지_킬러문제와해설.jpeg'
    payload=fields+(f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="problem-and-solution.jpeg"\r\nContent-Type: image/jpeg\r\n\r\n').encode()+image.read_bytes()+f'\r\n--{boundary}--\r\n'.encode()
print('Importing the same combined image into both fixed roles.' if same_image else 'Importing a problem image without a solution.' if problem_only else 'Importing separate problem/solution images.' if separate else 'Importing the combined problem+solution image.', flush=True)
material = request('import', payload, 'multipart/form-data; boundary='+boundary)
assert material.get('sourceId')
if problem_only:
    assert not material.get('explanation') and not material.get('answer') and len(material.get('steps',[]))==0
    solved=request('solution',json.dumps({'title':material['title'],'body':material['body'],'provider':'deepseek','sourceId':material['sourceId']},ensure_ascii=False).encode())
    material.update(answer=solved['answer'],explanation=solved['explanation'],steps=solved['steps'],body=solved['body'],solutionMethod=solved['method'])
else:
    assert material.get('explanation') and material.get('answer') and 1 <= len(material.get('steps',[])) <= 12
report = {'import': {k:v for k,v in material.items() if k not in ('previewDataUrl','previewDataUrls')}, 'sourceHasPreview': bool(material.get('previewDataUrl')), 'sourcePreviewCount':len(material.get('previewDataUrls',[]))}
save(report)
print(f"Web import/solution passed: problem, answer, {len(material.get('steps',[]))} actual solution steps and original image are ready.", flush=True)
generation = {k:material[k] for k in ['title','body','answer','explanation','sourceId']}
generation.update(provider='deepseek',requiresImage=True,useSolutionLogic=True,logicSteps=material['steps'],requestId=uuid.uuid4().hex)
job = request('generate',json.dumps(generation,ensure_ascii=False).encode())
report['jobId'] = job['id'];save(report)
started = time.monotonic()
while time.monotonic()-started < 480:
    state = request('jobs/'+job['id'],timeout=30)
    report['generation'] = state;save(report)
    if state['state'] in ['ready','failed','cancelled']:
        print('Web generation: '+state['state'],flush=True)
        if state['state'] != 'ready':
            raise RuntimeError(state.get('error','Generation failed'))
        result = state['result']
        print('Web quality: '+result['quality']['state']+'; '+result['answer'],flush=True)
        break
    time.sleep(5)
else:
    raise TimeoutError('Job remains saved for later polling; not cancelled or replayed.')
