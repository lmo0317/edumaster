import base64,hashlib,json,subprocess,urllib.request,urllib.error
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT='https://minohlee.mooo.com/edumaster/'
REMOTE='/home/lmo0317/apps/edumaster/'
OUT=Path('artifacts/learning-pdf-20260928');OUT.mkdir(parents=True,exist_ok=True)
def remote(path):
    return subprocess.run(['ssh','lmo0317@192.168.219.112','cat',REMOTE+path],check=True,capture_output=True).stdout
token=remote('backend/access-token.txt').decode().strip()
def request(path,data=None,method=None):
    req=urllib.request.Request(ROOT+'api/'+path,data=json.dumps(data).encode() if data is not None else None,method=method,headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'})
    return urllib.request.urlopen(req,timeout=130)
def value(path,data=None,method=None):
    with request(path,data,method) as r:return json.load(r)
import uuid,datetime
job=json.loads(remote('feedback-verification/integrated-result.json'))
job_id=uuid.uuid4().hex
before=value('learning/problems');before_ids={p['id'] for p in before}
# Use real, completed result content in an isolated hidden QA set, without any LLM calls.
created=datetime.datetime.now(datetime.timezone.utc).isoformat()
fixtures=[]
for output in job['outputs']:
    result_id=uuid.uuid4()
    output['result']['id']=str(result_id)
    output['result']['qualityJobId']=job_id
    fixtures.append({'id':result_id.hex,'jobId':job_id,'stageNumber':output['stageNumber'],
        'stageLabel':output['stageLabel'],'createdAt':created,'result':output['result'],
        'feedback':[],'addedManually':False})
fixture_code="from pathlib import Path\nimport json\nentries=json.loads("+repr(json.dumps(fixtures,ensure_ascii=False))+ ")\nroot=Path('/home/lmo0317/apps/edumaster/backend/learning-archive')\nfor item in entries:(root/(item['id']+'.json')).write_text(json.dumps(item,ensure_ascii=False),encoding='utf-8')\n"
subprocess.run(['ssh','lmo0317@192.168.219.112','python3','-'],input=fixture_code.encode(),check=True,capture_output=True)
(OUT/'fixtures.json').write_text(json.dumps({'jobId':job_id,'ids':[x['id'] for x in fixtures]}),encoding='utf-8')
images={role:'data:image/png;base64,'+base64.b64encode(remote('feedback-verification/'+role+'.png')).decode() for role in ('question','solution')}
try:
    try:value('learning/jobs/'+job_id,{'pdfReportId':'0'*32})
    except urllib.error.HTTPError as e:assert e.code==400
    else:raise AssertionError('Missing PDF allowed learning save')
    assert value('learning/jobs/'+job_id+'/status')['added']==False
    with sync_playwright() as p:
        browser=p.chromium.launch(headless=True)
        context=browser.new_context(viewport={'width':1280,'height':1000},accept_downloads=True,bypass_csp=True)
        context.add_init_script('(token => {sessionStorage.setItem("edumaster-access",token);localStorage.setItem("edumaster-access",token);})('+json.dumps(token)+')')
        page=context.new_page();errors=[]
        page.on('pageerror',lambda error:errors.append(str(error)))
        page.goto(ROOT+'create/',wait_until='domcontentloaded',timeout=60000)
        page.wait_for_function('() => typeof archiveCurrentReport === "function" && authenticated',timeout=30000)
        page.evaluate('''({job,images})=>{
            comparisonOutputs=job.outputs;result=job.outputs.at(-1).result;
            const reference=result;
            $('title').value='몰질량 풀이 로직 검증';$('body').value=reference.sourceProblem;
            $('answer').value=reference.sourceAnswer;$('explanation').value=reference.sourceExplanation;
            writeLogicSteps(reference.sourceSteps);sourceId=null;requiresImage=true;hasSolutionImage=true;
            for(const [role,src] of Object.entries(images)){const image=$(role+'-preview');image.src=src;image.hidden=false;}
            busy=false;qualityChecking=false;generationStarted=true;learningAddedJobId=null;imageReady=true;
            $('wizard-stage-5').hidden=false;$('result-footer').hidden=false;applyExportState();
        }''',{'job':job,'images':images})
        page.locator('#add-learning').click()
        page.wait_for_function('() => !reportSavePending',timeout=150000)
        assert page.evaluate('learningAddedJobId !== null'),page.locator('#status').inner_text()
        saved=page.evaluate('currentReportArchive.saved');status=page.locator('#status').inner_text()
        (OUT/'save-metadata.json').write_text(json.dumps({'jobId':job_id,'pdf':saved,'status':status},ensure_ascii=False,indent=2),encoding='utf-8')
        added=value('learning/problems');mine=[item for item in added if item['jobId']==job_id]
        assert len(mine)==3 and all(item['pdfReportId']==saved['id'] and item['reportId'] is None for item in mine)
        assert value('learning/jobs/'+job_id+'/status')=={'added':True,'pdfSaved':True}
        with request('reports/'+saved['id']+'/file?download=true') as r:original=r.read()
        with request('learning/jobs/'+job_id+'/pdf') as r:download=r.read()
        assert original==download
        (OUT/'generation-report.pdf').write_bytes(original)
        report_posts=[]
        page.on('request',lambda r:report_posts.append(r.url) if r.method=='POST' and '/api/reports' in r.url else None)
        page.goto(ROOT+'learning/?problem='+mine[0]['id'],wait_until='domcontentloaded')
        button=page.get_by_role('button',name='세트 PDF 다운로드',exact=True)
        button.wait_for(state='visible',timeout=30000)
        assert button.is_enabled()
        for number in (1,2):
            with page.expect_download(timeout=40000) as info:button.click()
            file=info.value;target=OUT/('learning-download-'+str(number)+'.pdf');file.save_as(target)
            assert target.read_bytes()==original
            button.wait_for(state='visible');page.wait_for_function('() => !document.querySelector(".set-pdf-actions button").disabled')
        assert not report_posts,'Learning page rebuilt the PDF'
        page.screenshot(path=str(OUT/'learning-pdf-download.png'),full_page=False)
        browser.close()
        assert not errors,errors
    evidence={'stages':len(mine),'samePdfBytes':True,'sha256':hashlib.sha256(original).hexdigest(),'learningReportPosts':len(report_posts),'pdfBytes':len(original),'pdfId':saved['id'],'jobId':job_id}
    (OUT/'verification.json').write_text(json.dumps(evidence,indent=2),encoding='utf-8')
    print(json.dumps(evidence))
finally:
    # Remove only records added by this isolated QA run; never touch user sets or feedback.
    now=value('learning/problems')
    for entry in now:
        if entry['jobId']==job_id and entry['id'] not in before_ids:
            value('learning/problems/'+entry['id'],method='DELETE')
    after=value('learning/problems')
    assert {entry['id'] for entry in after}==before_ids,'User learning records changed during QA'

    cleanup="from pathlib import Path\nimport json\nroot=Path('/home/lmo0317/apps/edumaster/backend/learning-archive')\nids="+repr([x['id'] for x in fixtures])+"\nfor id in ids:\n p=root/(id+'.json')\n if p.exists() and json.loads(p.read_text()).get('jobId')=="+repr(job_id)+":p.unlink()\n (root/(id+'.deleted')).unlink(missing_ok=True)\n"
    subprocess.run(['ssh','lmo0317@192.168.219.112','python3','-'],input=cleanup.encode(),check=True,capture_output=True)
