"""Replace code only after checking for active requests; preserve user data."""
import datetime,json,shutil,subprocess,time,urllib.request
from pathlib import Path
root=Path('/home/lmo0317/apps/edumaster')
backend=root/'backend'
work=root/'feedback-verification'
token=(backend/'access-token.txt').read_text().strip()
def api(path):
    req=urllib.request.Request('http://127.0.0.1:18282'+path,headers={'Authorization':'Bearer '+token})
    with urllib.request.urlopen(req,timeout=15) as response:return json.load(response)
status=api('/api/status')
pending=[r for r in api('/api/usage')['calls'] if r.get('outcome')=='started']
if status.get('activeGenerations',0)>0 or pending:raise RuntimeError('Active generation/request: do not restart')
def counts():return {name:len(list((backend/name).glob('*.json'))) for name in ('reports','learning-archive')}
before=counts()
backup=work/('backup-teacher-feedback-'+datetime.datetime.now().strftime('%Y%m%d-%H%M%S'))
backup.mkdir()
for name in ('EduMaster.Core.dll','EduMaster.Web.dll'):shutil.copy2(backend/name,backup/name)
shutil.copy2(root/'public/app.js',backup/'app.js')
shutil.copy2(root/'public/create/index.html',backup/'create-index.html')
subprocess.run(['systemctl','--user','stop','edumaster-api'],check=True)
try:
    for name in ('EduMaster.Core.dll','EduMaster.Web.dll'):shutil.copy2(work/name,backend/name)
    for destination in (backend/'wwwroot',root/'public'):
        shutil.copy2(work/'app.js',destination/'app.js')
        shutil.copy2(work/'create-index-v80.html',destination/'create/index.html')
finally:subprocess.run(['systemctl','--user','start','edumaster-api'],check=True)
for _ in range(15):
    try:
        current=api('/api/status')
        break
    except Exception:time.sleep(1)
else:raise RuntimeError('API did not return')
assert before==counts(), 'User reports/learning records changed'
assert current['ready'] and current['activeGenerations']==0
print(json.dumps({'serviceReady':True,'activeGenerations':current['activeGenerations'],'preserved':before,'backup':str(backup)}))
