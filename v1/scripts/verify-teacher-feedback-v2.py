"""Run on the existing server; credentials and source images remain there."""
import base64, datetime, json, os, sys, time, uuid, urllib.request, urllib.error
from pathlib import Path

root = Path('/home/lmo0317/apps/edumaster')
work = root / 'feedback-verification'
test = work / 'v2-api'
token = (root / 'backend/access-token.txt').read_text().strip()
base = os.environ.get('EDUMASTER_VERIFY_BASE_URL','http://127.0.0.1:18289')

def api(path, data=None):
    request = urllib.request.Request(base + path,
        data=None if data is None else json.dumps(data, ensure_ascii=False).encode(),
        headers={'Authorization': 'Bearer '+token, 'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        raise RuntimeError(f'HTTP {error.code}: {error.read().decode()}') from None

if sys.argv[1] == 'prepare':
    source_id = uuid.uuid4().hex
    pages = [{'Bytes':base64.b64encode((work/(name+'.png')).read_bytes()).decode(),
        'MimeType':'image/png', 'Page':number, 'ReadingRegion':'', 'MaterialRole':name}
        for number,name in enumerate(('question','solution'),1)]
    (test/'source-cache').mkdir(exist_ok=True)
    (test/'source-cache'/(source_id+'.json')).write_text(json.dumps({
        'Pages':pages,'Created':datetime.datetime.now(datetime.timezone.utc).isoformat()}))
    original = json.loads((work/'production-chemical-e2e.json').read_text())
    reference = original['outputs'][-1]['result']
    request = {'title':'교사 피드백 적용 검증 · 몰질량','body':reference['sourceProblem'],
        'answer':reference['sourceAnswer'],'explanation':reference['sourceExplanation'],
        'logicSteps':reference['sourceSteps'],'sourceId':source_id,'requiresImage':True,
        'provider':'deepseek','useSolutionLogic':True,'stageSeries':True,
        'expectedStageCount':len(reference['sourceSteps']),'variantMode':'integrated','requestId':uuid.uuid4().hex}
    (test/'request.json').write_text(json.dumps(request,ensure_ascii=False))
    print(json.dumps({'sourceImages':len(pages),'sourceSteps':len(reference['sourceSteps'])}))
elif sys.argv[1] == 'run':
    request=json.loads((test/'request.json').read_text())
    if (test/'material.json').exists() and os.environ.get('EDUMASTER_VERIFY_FRESH_IMPORT')!='1':material=json.loads((test/'material.json').read_text())
    else:
        boundary=uuid.uuid4().hex
        parts=[]
        for key,value in [('provider','deepseek'),('materialKind','problem-solution-separate'),('requestId',uuid.uuid4().hex)]:
            parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{key}"\r\n\r\n{value}\r\n'.encode())
        for key,name in [('questionFile','question'),('solutionFile','solution')]:
            parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{key}"; filename="{name}.png"\r\nContent-Type: image/png\r\n\r\n'.encode()+(work/(name+'.png')).read_bytes()+b'\r\n')
        import_request=urllib.request.Request(base+'/api/import',
            data=b''.join(parts)+f'--{boundary}--\r\n'.encode(),headers={
                'Authorization':'Bearer '+token,'Content-Type':'multipart/form-data; boundary='+boundary})
        with urllib.request.urlopen(import_request,timeout=300) as response:material=json.load(response)
        (test/'material.json').write_text(json.dumps(material,ensure_ascii=False,indent=2))
    for key in ('title','body','answer','explanation','sourceId'):request[key]=material[key]
    request['logicSteps']=material['steps'];request['expectedStageCount']=len(material['steps'])
    request['requestId']=uuid.uuid4().hex
    print('Real images imported:',len(material['steps']),'steps;',material['answer'],flush=True)
    start=api('/api/generate',request)
    (test/'start.json').write_text(json.dumps(start))
    print('Started',start,flush=True)
    job_id=start.get('id') or start.get('jobId')
    previous=None
    for _ in range(180):
        job=api('/api/jobs/'+job_id)
        (test/'result.json').write_text(json.dumps(job,ensure_ascii=False,indent=2))
        phase=job.get('phase')
        if previous!=phase:
            print(job.get('elapsedSeconds'),phase,flush=True);previous=phase
        if job['state']!='running':
            print(json.dumps({'id':job_id,'state':job['state'],'usage':job.get('usage'),
                'error':job.get('error'),'outputs':[{k:o.get(k) for k in ('stageNumber','state','error')} for o in job['outputs']]},ensure_ascii=False),flush=True)
            assert job['state']=='ready', 'Actual feedback generation failed'
            assert len(job['outputs'])==3
            for output in job['outputs']:
                result=output['result']
                assert result['promptVersion']=='reaction-learning-plan-v3-compiled-feedback'
                assert '피드백 적용 범위 확인' in result['generationNotice']
                assert not any(c['state']=='fail' for c in result['quality']['checks'])
                assert len(result['steps'])==output['stageNumber']
            assert job['usage']['calls']==1, 'Saved guidance bypassed or repeated paid generation occurred'
            break
        time.sleep(5)
    else:raise RuntimeError('Verification deadline reached')
