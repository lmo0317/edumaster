"""Run against the production API on its host using the reported job's original two images.
Never modifies teacher guidance or adds/deletes learning data. Credentials stay on host.
"""
import base64,json,time,uuid,urllib.request,urllib.error,os
from pathlib import Path

root=Path('/home/lmo0317/apps/edumaster')
work=root/'feedback-verification/nerve-failure-564a';work.mkdir(parents=True,exist_ok=True)
token=(root/'backend/access-token.txt').read_text().strip()
base=os.environ.get('EDUMASTER_REPRO_BASE','http://127.0.0.1:18282')

def api(path,data=None,content_type='application/json',timeout=360):
    if data is not None and not isinstance(data,bytes):data=json.dumps(data,ensure_ascii=False).encode()
    req=urllib.request.Request(base+path,data=data,headers={'Authorization':'Bearer '+token,'Content-Type':content_type})
    try:
        with urllib.request.urlopen(req,timeout=timeout) as response:return json.load(response)
    except urllib.error.HTTPError as e:raise RuntimeError(f'HTTP {e.code}: {e.read().decode()}') from None

def save(name,data):(work/name).write_text(json.dumps(data,ensure_ascii=False,indent=2))

old=json.loads((root/'backend/job-cache/564a8ae3bc3e4fd5b5dc5a5c374c6d48.json').read_text())
figures=old['outputs'][0]['result']['figures'];assert len(figures)==2
boundary=uuid.uuid4().hex;parts=[]
for key,value in [('provider','deepseek'),('materialKind','problem-solution-separate'),('requestId',uuid.uuid4().hex)]:
    parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{key}"\r\n\r\n{value}\r\n'.encode())
for key,f in zip(['questionFile','solutionFile'],figures):
    image=base64.b64decode(f['dataUrl'].split(',',1)[1])
    parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{key}"; filename="{key}.png"\r\nContent-Type: image/png\r\n\r\n'.encode()+image+b'\r\n')
print('Original question and solution images: analysis started',flush=True)
material=api('/api/import',b''.join(parts)+f'--{boundary}--\r\n'.encode(),f'multipart/form-data; boundary={boundary}')
save('material.json',material)
print('Analysed:',material.get('answer'),'steps:',len(material.get('steps',[])),flush=True)
assert len(material['steps'])==3,'Printed three STEP headings were not preserved'
request={k:material[k] for k in ['body','answer','explanation','sourceId']}
request.update(title='신경 흥분 전도 · 동일 입력 회귀 검증',provider='deepseek',requestId=uuid.uuid4().hex,
    requiresImage=True,useSolutionLogic=True,logicSteps=material['steps'],stageSeries=True,expectedStageCount=3,variantMode='integrated')
save('generation-request.json',request)
start=api('/api/generate',request);save('start.json',start)
print('Started:',start,flush=True)
previous=None
for _ in range(240):
    job=api('/api/jobs/'+start['id'],timeout=30)
    if job.get('phase')!=previous:
        print(job.get('elapsedSeconds'),job.get('phase'),flush=True);previous=job.get('phase')
    save('latest.json',job)
    if job['state'] in ['ready','failed','cancelled']:
        save('result.json',job)
        print('FINAL:',job['state'],flush=True)
        for o in job['outputs']:
            print('STAGE',o['stageNumber'],o['state'],o.get('error','')[:1000],flush=True)
            for c in (o.get('result') or {}).get('quality',{}).get('checks',[]):
                if c['state']=='fail':print('FAILED CHECK:',c['id'],c['evidence'][:700],flush=True)
        break
    time.sleep(5)
else:raise RuntimeError('Verification deadline exceeded; existing job kept')
