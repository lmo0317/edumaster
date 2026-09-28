import json,subprocess,os
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT=os.environ.get('EDUMASTER_UI_TEST_URL','http://127.0.0.1:18499/edumaster/')
OUT=Path('artifacts/ui-unification-20260928');OUT.mkdir(parents=True,exist_ok=True)
token=subprocess.run(['ssh','lmo0317@192.168.219.112','cat','/home/lmo0317/apps/edumaster/backend/access-token.txt'],capture_output=True,check=True,text=True).stdout.strip()
pages=[('home','','메인'),('create','create/','문제 생성'),('learning','learning/','피드백'),('guidance','learning/?tab=guidance','피드백'),('contents','learning/contents/','피드백'),('system','system/','시스템 설명')]
expected=['메인','문제 생성','피드백','시스템 설명'];errors=[];results=[]
with sync_playwright() as p:
 browser=p.chromium.launch(headless=True)
 for size,width,height in [('desktop',1440,1000),('mobile',390,844),('narrow',320,720),('tablet',768,1024)]:
  context=browser.new_context(viewport={'width':width,'height':height})
  context.add_init_script('(token=>{sessionStorage.setItem("edumaster-access",token);})('+json.dumps(token)+')')
  for name,path,active in pages:
   page=context.new_page();page.on('pageerror',lambda error:errors.append(str(error)))
   page.goto(ROOT+path,wait_until='domcontentloaded',timeout=45000)
   if name=='create':
    page.wait_for_function('() => !document.querySelector("#main-studio").hidden',timeout=30000)
    page.locator('input[name="material-mode"][value="problem-solution-separate"]').check()
    assert page.locator('label[for="question-file"]').is_visible()
    assert page.locator('label[for="solution-file"]').is_visible()
    page.locator('input[name="material-mode"][value="problem-only"]').check()
    assert not page.locator('#solution-upload-block').is_visible()
   if name in ('learning','guidance','contents'):page.wait_for_function('() => !document.querySelector("#workspace").hidden',timeout=30000)
   if name=='learning':page.locator('.set-heading').wait_for(state='visible',timeout=30000)
   if name=='guidance':page.wait_for_function('() => document.querySelector("#base-prompt").value.includes("approvedTeacherFeedback")',timeout=30000)
   assert page.locator('.app-nav a').all_text_contents()==expected,name
   assert page.locator('.app-nav a[aria-current="page"]').inner_text()==active,name
   assert all(page.locator('.app-nav a').nth(i).is_visible() for i in range(4))
   assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth'),(name,width,'horizontal overflow')
   measurements=page.locator('.app-header').evaluate('el => ({height:el.getBoundingClientRect().height,background:getComputedStyle(el).backgroundColor,font:getComputedStyle(el).fontFamily})')
   for link in page.locator('.app-nav a').all():
    bounds=link.bounding_box();assert bounds['x']>=0 and bounds['x']+bounds['width']<=width+.5,(name,width,'menu outside screen')
   if name=='system':
    page.locator('.contents a[href="#rag"]').click();page.wait_for_function('() => document.querySelector("#rag").getBoundingClientRect().top < document.querySelector(".app-header").getBoundingClientRect().height + 120',timeout=10000)
    top=page.locator('#rag').bounding_box()['y'];assert top>=measurements['height']-1,(name,width,'anchor hidden by header')
    page.evaluate('window.scrollTo({top:0,behavior:"instant"})')
   if size in ('desktop','mobile'):page.screenshot(path=str(OUT/(size+'-'+name+'.png')),full_page=False)
   results.append({'page':name,'size':size,**measurements});page.close()
  context.close()
 browser.close()
assert not errors,errors
assert len({r['height'] for r in results if r['size']=='desktop'})==1,'Desktop header heights differ'
assert len({r['height'] for r in results if r['size']=='mobile'})==1,'Mobile header heights differ'
(OUT/'verification.json').write_text(json.dumps(results,ensure_ascii=False,indent=2),encoding='utf-8')
print('PASS: six screens x four widths, identical menus and header height, active state, no overflow, anchor positions')
