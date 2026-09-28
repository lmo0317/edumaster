import json,subprocess,urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT='https://minohlee.mooo.com/edumaster/'
OUT=Path('artifacts/prompt-view-20260928');OUT.mkdir(parents=True,exist_ok=True)
token=subprocess.run(['ssh','lmo0317@192.168.219.112','cat','/home/lmo0317/apps/edumaster/backend/access-token.txt'],capture_output=True,check=True,text=True).stdout.strip()
def data(path):
 req=urllib.request.Request(ROOT+'api/'+path,headers={'Authorization':'Bearer '+token})
 with urllib.request.urlopen(req,timeout=20) as r:return json.load(r)
preview=data('learning/prompts');guidance=data('learning/guidance');errors=[]
with sync_playwright() as p:
 browser=p.chromium.launch(headless=True)
 for name,width,height in [('desktop',1280,1200),('mobile',390,844)]:
  context=browser.new_context(viewport={'width':width,'height':height})
  context.add_init_script('(token=>{sessionStorage.setItem("edumaster-access",token);})('+json.dumps(token)+')')
  page=context.new_page();page.on('pageerror',lambda error:errors.append(str(error)))
  page.goto(ROOT+'learning/?tab=guidance',wait_until='domcontentloaded',timeout=45000)
  page.wait_for_function('() => !document.querySelector("#workspace").hidden && document.querySelector("#base-prompt").value.includes("approvedTeacherFeedback")',timeout=30000)
  assert page.locator('#panel-guidance').is_visible()
  assert page.locator('#base-prompt').get_attribute('readonly') is not None
  assert page.locator('#guidance-do').input_value()==guidance['do']
  assert page.locator('#guidance-dont').input_value()==guidance['dont']
  for provider in ('deepseek','gemma'):
   page.locator('#prompt-provider').select_option(provider)
   for mode in ('integrated','numeric','practice'):
    page.locator('#prompt-mode').select_option(mode)
    actual=page.locator('#base-prompt').input_value()
    expected=next(v['content'] for v in preview['variants'] if v['provider']==provider and v['mode']==mode)
    assert actual==expected.replace('\r\n','\n').replace('\r','\n'),(provider,mode,len(actual),len(expected))
  page.locator('#prompt-provider').select_option('deepseek');page.locator('#prompt-mode').select_option('integrated')
  assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth'),'horizontal overflow'
  page.screenshot(path=str(OUT/(name+'.png')),full_page=True)
  page.locator('#guidance-do').fill(guidance['do']+'\n시험용 미저장 메모')
  page.locator('#prompt-provider').select_option('gemma')
  assert page.locator('#guidance-do').input_value().endswith('시험용 미저장 메모')
  assert page.locator('#tab-guidance').inner_text().endswith('미저장')
  context.close()
 browser.close()
assert not errors,errors
assert data('learning/guidance')==guidance,'Saved teacher guidance changed during read-only verification'
(OUT/'verification.json').write_text(json.dumps({'variants':len(preview['variants']),'desktopMobile':True,'actualPromptMatchesApi':True,'readOnlyBasePrompt':True,'unsavedInstructionsPreserved':True,'existingGuidanceUnchanged':True},indent=2),encoding='utf-8')
print('PASS: desktop/mobile, 6 actual prompt variants, no overflow, existing and unsaved teacher instructions preserved')
