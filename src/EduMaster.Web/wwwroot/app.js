'use strict';
const $=id=>document.getElementById(id);const prefix=new URL('.',document.currentScript?.src||location.href).href;let busy=false,jobId=null,result=null,previewUrl=null,separatePreviewUrls=[],selectedQuestionFile=null,selectedSolutionFile=null,materialReadPending=false,sourceId=null,requiresImage=false,sourceExpiresAt=null,importController=null,importTimedOut=false;
let pendingJob=null,generationStarted=false;
let imageReady=false;
let qualityChecking=false;
let renderController=null;
let comparisonOutputs=[];globalThis.currentStageProgress='';
const logicStepInputs=()=>[...$('logic-steps').querySelectorAll('textarea')];
const readLogicSteps=()=>logicStepInputs().map(input=>input.value.trim());
function updateLogicStepLabels(){logicStepInputs().forEach((input,index)=>{input.id='logic-step-'+(index+1);const row=input.closest('.logic-step-row');row.querySelector('label').htmlFor=input.id;row.querySelector('label b').textContent=index+1;row.querySelector('.logic-step-remove').ariaLabel=`풀이 단계 ${index+1} 삭제`;});$('logic-card-title').textContent=`풀이 로직 ${logicStepInputs().length}단계`;}
function addLogicStep(value=''){
 if(logicStepInputs().length>=12){feedback('풀이 단계는 12개까지 입력할 수 있습니다','서로 같은 계산을 반복한 부분은 한 단계로 정리해 주세요.',true);return;}
 const row=document.createElement('div');row.className='logic-step-row';const label=document.createElement('label'),number=document.createElement('b'),textarea=document.createElement('textarea'),remove=document.createElement('button');
 label.append(number,document.createTextNode(' 실제 풀이 단계'));textarea.maxLength=3000;textarea.placeholder='이 단계에서 실제로 판단하거나 계산하는 내용을 적어 주세요.';textarea.value=value;remove.type='button';remove.className='logic-step-remove';remove.textContent='×';
 textarea.addEventListener('input',clearResult);remove.onclick=()=>{if(busy)return;row.remove();if(!logicStepInputs().length)addLogicStep();updateLogicStepLabels();clearResult();};row.append(label,textarea,remove);$('logic-steps').append(row);updateLogicStepLabels();
}
function writeLogicSteps(steps=[]){$('logic-steps').replaceChildren();for(const step of (steps.length?steps:['']))addLogicStep(step);updateLogicStepLabels();}
writeLogicSteps();
function generationButtonText(){return '단계별 문제와 해설 만들기';}
function updateInputFormat(){$('combined-upload').hidden=true;$('separate-upload').hidden=false;$('preview').hidden=true;}
function hasValidLogic(){const steps=readLogicSteps();return steps.length>0&&steps.every(Boolean);}
function setWorkflowStage(stage){
 for(let index=1;index<=5;index++){
  const item=$('workflow-step-'+index);if(!item)continue;
  item.classList.toggle('done',index<stage);item.classList.toggle('active',index===stage);
 }
}
function updateWorkflowState(){
 const action=$('continue-action');
 const phaseTitle=$('feedback-title')?.textContent||'',phaseBody=$('feedback-body')?.textContent||'';
 let stage=1,badge='현재 단계 · 자료 입력',title='문제 이미지를 넣어 주세요',description='풀이 이미지가 있으면 함께 넣고, 없으면 문제 이미지만 넣어도 됩니다.',label='문제 이미지 선택',kind='select',disabled=!authenticated;
 if(busy){
  const checking=qualityChecking||/검사/.test(phaseTitle),solving=/풀이/.test(phaseTitle)&&!/쌍둥이/.test(phaseTitle),reading=!!importController&&!solving;
  stage=checking?5:reading?2:solving?3:5;badge='진행 중';title=phaseTitle||'처리 중입니다';description=phaseBody||'현재 작업이 끝나면 다음 단계가 열립니다.';label='처리 중…';kind='busy';disabled=true;
 }else if(pendingJob){
  stage=5;badge='이어하기 · 생성 작업';title='진행 중이던 생성 결과가 있습니다';description='새 요청 없이 기존 작업을 다시 확인합니다.';label='진행 결과 확인';kind='resume';disabled=!authenticated;
 }else if(materialReadPending){
  stage=2;badge='현재 단계 · 이미지 분석';title='선택한 이미지를 분석해 주세요';description='문제와 풀이를 분리해 실제 풀이 단계를 찾습니다.';label='선택한 이미지 분석하기';kind='read';disabled=!authenticated||!selectedQuestionFile;
 }else if(result){
  stage=5;badge='완료 · 최종 결과';title='단계별 문제와 해설이 완성됐습니다';description='각 결과를 순서대로 확인하세요.';label='다시 만들기';kind='generate';disabled=!authenticated;
 }else if($('body').value.trim()&&hasValidLogic()){
  stage=4;badge='현재 단계 · 문제 만들기';title=`풀이 로직 ${readLogicSteps().length}단계가 준비됐습니다`;description=`STEP 1부터 전체 로직까지 문제 ${readLogicSteps().length}개를 순서대로 만듭니다.`;label='단계별 문제와 해설 만들기';kind='generate';disabled=!authenticated;
 }else if($('body').value.trim()){
  stage=3;badge='현재 단계 · 분석 결과';title='풀이 단계를 완성해 주세요';description='풀이가 없으면 AI가 실제 판단과 계산 순서로 나눕니다.';label='풀이 단계 분석하기';kind='solve';disabled=!authenticated;
 }
 setWorkflowStage(stage);$('workflow-state-badge').textContent=badge;$('workflow-title').textContent=title;$('workflow-description').textContent=description;
 if(action){action.textContent=label;action.dataset.action=kind;action.disabled=disabled;}
 const hasBody=!!$('body').value.trim(),validLogic=hasValidLogic(),generating=busy&&!importController&&!(/풀이/.test(phaseTitle)&&!/쌍둥이/.test(phaseTitle));
 $('wizard-stage-2').hidden=!(materialReadPending||!!importController||hasBody);
 $('wizard-stage-3').hidden=!hasBody;
 $('wizard-stage-4').hidden=!(hasBody&&validLogic);
 $('wizard-stage-5').hidden=!(generationStarted||generating||pendingJob||result||comparisonOutputs.length);
 for(let index=1;index<=5;index++){const section=$('wizard-stage-'+index);if(section){section.classList.toggle('active',index===stage);section.classList.toggle('completed',index<stage);}}
 $('solve-problem').hidden=!(hasBody&&!validLogic)||busy;
 $('read-material').disabled=busy||!selectedQuestionFile;
 $('generate').disabled=busy||!validLogic||!authenticated;
 const count=readLogicSteps().filter(Boolean).length;
 if($('analysis-summary-steps'))$('analysis-summary-steps').textContent=count?`실제 풀이 ${count}단계`:'';
 if($('series-plan'))$('series-plan').textContent=count?`풀이 ${count}단계 → 누적 연습 문제 ${count}개를 하나씩 생성합니다.`:'분석된 풀이 단계 수만큼 문제를 만듭니다.';
 if($('series-preview'))$('series-preview').replaceChildren(...Array.from({length:count},(_,i)=>{const row=document.createElement('div'),number=document.createElement('b'),text=document.createElement('span');number.textContent=i+1;text.textContent=i===count-1?'전체 로직 쌍둥이 문제':i===0?'STEP 1 연습 문제':`STEP 1~${i+1} 누적 연습 문제`;row.append(number,text);return row;}));
 document.querySelector('.result')?.classList.toggle('has-result',!!result);
 if(result&&!materialReadPending&&!busy)$('result-footer').hidden=false;
 else if(!result)$('result-footer').hidden=true;
 const providerText=$('provider')?.selectedOptions?.[0]?.textContent?.split(' · ')[0];if($('provider-summary')&&providerText)$('provider-summary').textContent=providerText;
}
const fragment=new URLSearchParams(location.hash.slice(1));if(fragment.get('access')){sessionStorage.setItem('edumaster-access',fragment.get('access'));history.replaceState(null,'',location.pathname);}
let access=sessionStorage.getItem('edumaster-access')||localStorage.getItem('edumaster-access')||'',authenticated=false,connecting=false;

async function api(path,options={},attempt=0){
 const isGet=!options.method||options.method==='GET';
 const retrySafe=isGet||(path==='generate'&&options.idempotent===true);
 const retryLimit=path==='status'?0:4;
 const controller=retrySafe?new AbortController():null;
 const abort=()=>controller?.abort();options.signal?.addEventListener('abort',abort,{once:true});
 if(options.signal?.aborted)abort();
 const readTimeout=path.startsWith('jobs/')||path.startsWith('sources/')?30000:15000;
 const timeout=retrySafe?setTimeout(abort,isGet?readTimeout:15000):null;
 let response,data;
 try{
  response=await fetch(prefix+'api/'+path,{...options,signal:controller?.signal||options.signal,headers:{Authorization:'Bearer '+access,'X-EduMaster-Renderer':'beaker-v1',...options.headers}});
  try{data=await response.json()||{};}catch(e){
   if(e.name!=='SyntaxError')throw e;
   data={};
   if(response.ok){const error=new Error('서버 응답을 읽지 못했습니다. 입력과 작업 번호는 유지됩니다. 잠시 후 결과를 다시 확인해 주세요.');error.responseFormat=true;throw error;}
  }
 }catch(e){
  if(e.responseFormat)throw e;
  if(options.signal?.aborted)throw e;
  if(retrySafe&&attempt<retryLimit){
   clearTimeout(timeout);
   $('status').textContent='서버 연결 복구 중 · 재시도 '+(attempt+1)+'/4 · 입력과 생성 작업 유지';
   await new Promise(resolve=>setTimeout(resolve,1000*(attempt+1)));
   return api(path,options,attempt+1);
  }
  const error=new Error(path==='status'?'접속 서버가 응답하지 않습니다. 비밀번호를 확인하지 못했습니다. 서버 연결 복구 후 다시 입장해 주세요.':isGet?'서버 연결이 끊겨 결과를 확인하지 못했습니다. 입력은 유지됩니다. 연결 복구 후 다시 확인해 주세요.':retrySafe?'서버와 연결이 끊겼습니다. 입력과 요청 번호를 유지했습니다. 연결 복구 후 같은 생성 요청을 다시 확인해 주세요.':'서버와 연결하지 못했습니다. 입력은 유지됩니다. 요청이 전달됐는지는 확인되지 않아 자동으로 다시 보내지 않습니다.');
  error.networkFailure=true;throw error;
 }finally{if(timeout!==null)clearTimeout(timeout);options.signal?.removeEventListener('abort',abort);}
 if(options.signal?.aborted){const error=new Error('요청이 취소되었습니다.');error.name='AbortError';throw error;}
 if([502,503,504].includes(response.status)&&retrySafe&&attempt<retryLimit){
  $('status').textContent='서버 연결 복구 중 · 재시도 '+(attempt+1)+'/4 · 입력과 생성 작업 유지';
  await new Promise(resolve=>setTimeout(resolve,1000*(attempt+1)));
  return api(path,options,attempt+1);
 }
 if(response.status===404&&path.startsWith('jobs/')){const error=new Error('이 작업의 결과가 서버에 남아 있지 않습니다. 서버 재시작 또는 보관 만료로 종료됐습니다. 입력은 유지되니 ‘변형 문제 만들기’를 눌러 새로 생성해 주세요.');error.jobMissing=true;throw error;}
 if(response.status===401){
  authenticated=false;localStorage.removeItem('edumaster-access');sessionStorage.removeItem('edumaster-access');
  $('main-studio').hidden=true;$('lock-screen').hidden=false;$('disconnect').hidden=true;$('connection').textContent='🔒 잠김 (인증 필요)';
  setBusy(busy);throw new Error(data.error||'비밀번호가 올바르지 않습니다.');
 }
 if(!response.ok){const unavailable=[502,503,504].includes(response.status);const error=new Error(path==='status'&&unavailable?'문제 처리 서버와 연결되지 않습니다. 비밀번호를 확인하지 못했습니다. 서버 연결 복구 후 다시 입장해 주세요.':data.error||'연결하지 못했습니다. 다시 시도해 주세요.');if(unavailable)error.networkFailure=true;throw error;}
 return data;
}

async function loginStatus(){
 const controller=new AbortController();let deadline;
 try{
  return await Promise.race([api('status',{signal:controller.signal}),new Promise((resolve,reject)=>{
   deadline=setTimeout(()=>{const error=new Error('접속 서버가 15초 안에 응답하지 않았습니다. 비밀번호를 확인하지 못했습니다. 다시 입장해 주세요.');error.networkFailure=true;reject(error);controller.abort();},15000);
  })]);
 }finally{clearTimeout(deadline);}
}

function feedback(title,body,error=false){
 if(!result)$('output').hidden=true;$('comparison').hidden=true;$('feedback').hidden=false;
 $('feedback-title').textContent=title;$('feedback-body').textContent=body;
 $('feedback-body').classList.toggle('error',error);
 $('copy').disabled=$('print').disabled=true;
 if($('copy-image-footer'))$('copy-image-footer').disabled=$('download-image-footer').disabled=true;
 globalThis.updateWorkflowState?.();
}
function analysisStatus(title,body,state=''){
 const box=$('analysis-status');if(!box)return;box.hidden=false;box.className='stage-message '+state;$('analysis-status-title').textContent=title;$('analysis-status-body').textContent=body;
}

function setBusy(value){
 busy=value;
 for(const id of ['file','question-file','solution-file','read-material','solve-problem','add-logic-step','title','body','answer','explanation','generate','reset','material-kind','provider','copy-image-footer','download-image-footer']){
  const el=$(id);if(el)el.disabled=value||(!authenticated&&['file','question-file','solution-file','generate'].includes(id));
 }
 if(typeof logicStepInputs==='function')logicStepInputs().forEach(input=>input.disabled=value);document.querySelectorAll('.logic-step-remove').forEach(button=>button.disabled=value);
 $('generate').textContent=value?'생성 중…':generationButtonText();
 $('progress').hidden=!value||(!jobId&&!importController);
 document.querySelectorAll('.upload').forEach(up=>up.setAttribute('aria-disabled',String(!authenticated||value)));
 $('resume-job').hidden=!pendingJob||value||!authenticated;
 $('generate').disabled=value||!authenticated;
 if($('copy-image-footer'))$('copy-image-footer').disabled=$('download-image-footer').disabled=value||!imageReady;
 if(result)applyExportState();
 globalThis.updateWorkflowState?.();
}

function save(){
 $('resume-job').hidden=!pendingJob||busy||!authenticated;
 const saved={title:$('title').value,body:$('body').value,answer:$('answer').value,explanation:$('explanation').value,logicSteps:readLogicSteps(),sourceId,requiresImage,sourceExpiresAt,fromSolution:false,useSolutionLogic:true,materialKind:$('material-kind').value,provider:$('provider').value,comparisonOutputs:comparisonOutputs.filter(o=>o.state!=='running'),result,pendingJob};
 try{sessionStorage.setItem('edumaster-workspace',JSON.stringify(saved));}catch{
  saved.result=null;try{sessionStorage.setItem('edumaster-workspace',JSON.stringify(saved));}catch{}$('status').textContent='이미지가 커서 결과는 새로고침 후 복구되지 않습니다. 현재 화면에서 인쇄·PDF 저장해 주세요.';
 }
}

function show(r){
 r=prepareProblemDisplay(r);
 result=r;$('feedback').hidden=!(busy&&comparisonOutputs.some(o=>o.state==='running'));
 $('output').hidden=false;$('badge').textContent='AI 초안';
 $('result-footer').hidden=false;
 $('result-notice').textContent=r.generationNotice+'\n'+r.changeSummary+'\n'+r.model+' · '+r.usageSummary+'\n'+(r.visualVerification||'');
 $('result-figures').replaceChildren(...(r.figures||[]).map(f=>{
  const figure=document.createElement('figure'),caption=document.createElement('figcaption'),img=document.createElement('img');
  caption.textContent=f.caption;img.alt='연결 관계를 유지한 기준 그림';img.src=f.dataUrl;img.tabIndex=0;img.title='눌러서 크게 보기';img.setAttribute('aria-haspopup','dialog');figure.append(caption,img);return figure;
 }));
 const visualContext=$('visual-context');
 if(visualContext)visualContext.textContent=(r.visualContexts||[]).map(v=>[v.summary,...v.nodes.map(n=>n.id+': '+n.label),...v.edges.map(e=>e.from+' → '+e.to+': '+e.relation),...v.constraints].join('\n')).join('\n\n');
 for(const [id,key] of [['result-title','title'],['result-answer','answer']])$(id).textContent=r[key];
 renderProblemText($('source'),r.sourceProblem+(r.sourceExplanation?'\n\n기준 정답: '+(r.sourceAnswer||'미제공')+'\n\n기준 풀이:\n'+r.sourceExplanation:''));
 renderProblemText($('result-body'),r.body);
 renderProblemText($('result-explanation'),r.explanation,true);
 renderProblemChoices($('choices'),r);
 for(const [id,items] of [['steps',r.steps]]){
  $(id).replaceChildren(...items.map(text=>{const li=document.createElement('li');li.textContent=text;return li;}));
 }
 
 // Render problem image
 renderProblemToImage(r, $('toggle-image-answer')?$('toggle-image-answer').checked:false);

 renderQuality(r.quality);applyExportState();
 globalThis.updateWorkflowState?.();
 if(typeof matchMedia==='function'&&matchMedia('(max-width: 900px)').matches)setTimeout(()=>document.querySelector('.result')?.scrollIntoView({behavior:'smooth',block:'start'}),0);
 save();
}

function qualityState(report){
 if(!report?.checks?.length)return 'review_required';
 return report.checks.some(c=>c.state==='fail')?'fail':report.checks.some(c=>c.state!=='pass')?'review_required':'pass';
}
function qualitySummary(report){
 const state=qualityState(report);
 const errors=report?.checks?.filter(c=>c.state==='fail').length||0;
 const skipped=report?.checks?.some(c=>c.state==='skipped');
 return state==='fail'?'최종 검사 오류 '+errors+'건'+(skipped?' · 후속 검사 생략':'')+' · 복사·저장 차단':state==='pass'?'자동 검사 통과 · AI 검토 포함 · 교사 검수 전 초안':'최종 검사에 확인 불가 항목이 있습니다 · 교사 검수 전 초안';
}
function renderQuality(report){
 const panel=$('quality-panel');if(!panel)return;
 panel.hidden=false;panel.className='quality-panel '+qualityState(report);if(qualityState(report)!=='pass')panel.open=true;
 $('quality-summary').textContent=qualitySummary(report);
 const checks=report?.checks||[{label:'최종 검사',state:'unknown',evidence:'이전 결과에는 검사 기록이 없습니다. 새 생성부터 문항 검사가 적용됩니다.',method:'code'}];
 const rows=checks.map(c=>{
  const row=document.createElement('li'),heading=document.createElement('strong'),evidence=document.createElement('p');
  heading.textContent=(c.state==='pass'?'통과':c.state==='fail'?'오류':c.state==='skipped'?'검사 생략':'확인 불가')+' · '+c.label;
  evidence.textContent=c.evidence+' · '+(c.method==='code'?'코드 검사':'AI 검토');row.className=c.state;row.append(heading,evidence);return row;
 });$('quality-checks').replaceChildren(...rows);
 const hint=$('quality-action-hint');if(hint)hint.textContent=qualityState(report)==='fail'?'오류 근거를 확인해 주세요. 검사 생략은 추가 오류가 아닙니다. AI 판정이 의심되면 문항 재검사, 실제 생성 오류이면 원본 입력을 유지한 채 재생성하세요.':checks.some(c=>c.id==='calculation'&&c.state==='unknown')?'독립 검산 미지원은 재검사로 해결되지 않습니다. 교사 검산이 필요합니다.':qualityState(report)==='pass'?'구현된 자동 검사가 통과했습니다. 최종 사용 전 교사 검수를 진행해 주세요.':'검사 시간 초과·연결 실패는 해당 검사를 다시 시도할 수 있습니다.';
 $('badge').textContent=qualityChecking?'최종 이미지 검사 중':qualityState(report)==='fail'?'검사 오류 · 초안':'교사 검수 전 초안';
}
function applyExportState(){
 const blocked=busy||qualityChecking||!imageReady||qualityState(result?.quality)==='fail';
 for(const id of ['copy-image','copy-image-footer','download-image','download-image-footer','copy','print']){const el=$(id);if(el)el.disabled=blocked;}
 if($('toggle-image-answer'))$('toggle-image-answer').disabled=busy||qualityChecking;
 for(const id of ['retry-render-check','retry-text-check']){const el=$(id);if(el)el.disabled=busy||qualityChecking||!result?.qualityJobId||!imageReady;}
}
async function recheckText(){
 if(!result?.qualityJobId||busy||qualityChecking)return;
 const r=result;qualityChecking=true;setBusy(true);applyExportState();
 $('status').textContent='같은 문제의 문장·조건·수치·해설을 다시 검사합니다 · 문제는 수정하지 않습니다';
 const controller=new AbortController(),deadline=setTimeout(()=>controller.abort(),115000);renderController=controller;
 const started=Date.now(),clock=setInterval(()=>{$('elapsed').textContent=Math.floor((Date.now()-started)/1000)+'초 경과 · 문항 재검사 중 · 검사 중지 가능';},1000);
 $('feedback').hidden=false;$('feedback-title').textContent='문항 재검사 중';$('feedback-body').textContent='선택한 생성 모델을 별도로 한 번 호출합니다. DeepSeek는 API 비용이 추가됩니다.';$('progress').hidden=false;$('cancel').disabled=false;$('cancel').textContent='검사 중지';globalThis.updateWorkflowState?.();
 try{
  const report=await api('jobs/'+r.qualityJobId+'/text-check',{method:'POST',signal:controller.signal,headers:{'Content-Type':'application/json'},body:JSON.stringify({resultId:r.id})});
  if(!Array.isArray(report.checks)||!report.checks.length||report.checks.some(c=>!['pass','fail','unknown','skipped'].includes(c.state)))throw new Error('문항 검사 응답 형식이 잘못됐습니다.');
  if(result===r)result={...r,quality:report};$('status').textContent=qualitySummary(result?.quality);
 }catch(e){$('status').textContent='재검사를 완료하지 못했습니다 · 기존 검사 결과 유지 · '+(e.name==='AbortError'?'검사 시간 초과 또는 중지':e.message);}
 finally{clearTimeout(deadline);clearInterval(clock);renderController=null;qualityChecking=false;$('feedback').hidden=true;$('progress').hidden=true;setBusy(false);renderQuality(result?.quality);applyExportState();save();}
}
async function checkRenderedResult(){
 if(!result||!imageReady||qualityChecking)return;
 if(!result.qualityJobId){renderQuality(result.quality);return;}
 const r=result,wasBusy=busy;qualityChecking=true;setBusy(true);renderQuality(r.quality);applyExportState();
 $('feedback').hidden=false;$('feedback-title').textContent='완성된 문제 이미지를 검사합니다';$('feedback-body').textContent='문장·수치·보기·그림이 PNG에 올바르게 표시됐는지 로컬 이미지 모델로 대조합니다.';$('progress').hidden=false;$('cancel').disabled=false;globalThis.updateWorkflowState?.();
 $('status').textContent='완성 PNG 최종 검사 중 · 로컬 이미지 모델이 본문·수치·그림·잘림을 대조합니다';
 const controller=new AbortController(),deadline=setTimeout(()=>controller.abort(),90000);renderController=controller;$('cancel').textContent='최종 검사 중지';
 const started=Date.now(),clock=setInterval(()=>{$('elapsed').textContent=Math.floor((Date.now()-started)/1000)+'초 경과 · 최종 PNG 검사 중 · 검사 중지 가능';},1000);
 try{
  const report=await api('jobs/'+r.qualityJobId+'/render-check',{method:'POST',signal:controller.signal,headers:{'Content-Type':'application/json'},body:JSON.stringify({resultId:r.id,png:$('problem-canvas').toDataURL('image/png'),includeAnswer:!!$('toggle-image-answer')?.checked})});
  if(!Array.isArray(report.checks)||!report.checks.length||report.checks.some(c=>!['pass','fail','unknown','skipped'].includes(c.state)))throw new Error('검사 응답 형식이 올바르지 않습니다.');
  if(result===r)result={...r,quality:report};
 }catch(e){
  if(result===r){const checks=(r.quality?.checks||[]).filter(c=>c.id!=='render');checks.push({id:'render',label:'최종 PNG 대조',state:'unknown',evidence:'완성 이미지 검사를 완료하지 못했습니다 · '+(e.name==='AbortError'?'검사 시간 초과':e.message),method:'local-vision'});result={...r,quality:{version:'quality-harness-v1',checks}};}
 }finally{clearTimeout(deadline);clearInterval(clock);renderController=null;qualityChecking=false;$('feedback').hidden=true;$('progress').hidden=true;renderQuality(result?.quality);if(!wasBusy)setBusy(false);applyExportState();save();}
 $('status').textContent=qualitySummary(result?.quality);
}

function clearResult(){
 imageReady=false;generationStarted=false;
 result=null;comparisonOutputs=[];$('comparison').replaceChildren();$('badge').textContent='결과 없음';$('result-footer').hidden=true;
 feedback('아직 생성된 결과가 없습니다','왼쪽에 문제 자료를 넣은 뒤 화면 상단의 안내 버튼을 따라가세요.\n진행 상태와 완성된 문제 이미지가 이곳에 표시됩니다.');
 const img=$('problem-image');if(img)img.removeAttribute('src');
 if($('copy-image-footer'))$('copy-image-footer').disabled=$('download-image-footer').disabled=true;
 globalThis.updateWorkflowState?.();save();
}

function applyImportedMaterial(d){
 materialReadPending=false;
 sourceId=d.sourceId||null;requiresImage=!!d.needsReview;sourceExpiresAt=d.sourceExpiresAt||null;
 for(const id of ['title','body'])$(id).value=d[id]||'';$('answer').value=d.answer||'';$('explanation').value=d.explanation||'';writeLogicSteps(d.steps||[]);
 $('material-kind').value=d.explanation?'problem-solution-separate':'problem-only';
 if(d.explanation||d.steps?.some(Boolean))document.querySelector('.optional-details').open=true;
 $('file-info').textContent=d.fileName+' · '+d.readMethod;
 globalThis.analysisStatus?.('이미지 분석 완료',d.explanation?`문제·정답·해설과 실제 풀이 ${d.steps?.length||0}단계를 분리했습니다.`:'문제 본문을 분석했습니다. 다음 단계에서 풀이 과정을 분석하세요.','success');
 feedback(d.explanation?'문제와 풀이 로직을 분리해 읽었습니다':'문제 이미지를 읽었습니다',d.explanation?`문제 본문과 풀이가 분리됐습니다. 정답·해설과 실제 풀이 ${d.steps?.length||0}단계를 원본과 확인한 뒤 전체 로직의 쌍둥이 문제를 만드세요.`+(d.uncertainties?.length?'\n확인 필요: '+d.uncertainties.join(' · '):''):'문제 본문을 확인한 뒤 ‘STEP별 풀이 생성’을 누르세요.');
 $('status').textContent=d.explanation?`이미지 분석 완료 · 실제 풀이 ${d.steps?.length||0}단계 확인`:'문제 분석 완료 · 풀이 단계를 이어서 분석하세요.';globalThis.updateWorkflowState?.();setTimeout(()=>$('wizard-stage-3')?.scrollIntoView({behavior:'smooth',block:'start'}),0);save();
}

async function importFile(file){
 if(busy||!file)return;
 if(!authenticated){$('main-studio').hidden=true;$('lock-screen').hidden=false;return;}
 if(file.size>10*1024*1024){feedback('파일을 확인해 주세요','파일은 10MB까지 지원합니다.',true);return;}
 const oldPreview=previewUrl,oldPreviewSrc=$('preview').getAttribute('src'),oldPreviewHidden=$('preview').hidden;const newPreview=file.type.startsWith('image/')?URL.createObjectURL(file):null;
 comparisonOutputs=[];$('comparison').replaceChildren();importController=new AbortController();importTimedOut=false;result=null;jobId=null;setBusy(true);
 $('preview').hidden=!newPreview;if(newPreview)$('preview').src=newPreview;
 $('generate').textContent='파일 읽는 중…';$('file-info').textContent=file.name+' · 업로드·원본 이미지 준비 중';
 feedback('선택한 파일을 읽고 있습니다','원본 미리보기를 먼저 표시했습니다. AI 모델이 본문·표·수식을 읽고 있습니다.');
 $('cancel').disabled=false;$('cancel').textContent='파일 읽기 취소';$('elapsed').textContent='0초 경과 · 파일 읽기 취소 가능';
 const start=Date.now();const timer=setInterval(()=>{const seconds=Math.floor((Date.now()-start)/1000);$('file-info').textContent=file.name+' · 파일 읽기 중 · '+seconds+'초 경과';$('elapsed').textContent=seconds+'초 경과 · 파일 읽기 취소 가능';},1000);
 const deadline=setTimeout(()=>{importTimedOut=true;importController?.abort();},305000);
 try{
  const form=new FormData();form.append('file',file);const reading=selectedModel();form.append('provider',reading.provider);form.append('materialKind',$('material-kind').value);const d=await api('import',{method:'POST',body:form,signal:importController.signal});
  applyImportedMaterial(d);previewUrl=newPreview;if(!newPreview&&d.previewDataUrl){$('preview').src=d.previewDataUrl;$('preview').hidden=false;}if(oldPreview)URL.revokeObjectURL(oldPreview);
 }catch(e){
  if(newPreview)URL.revokeObjectURL(newPreview);$('preview').hidden=oldPreviewHidden;if(oldPreviewSrc)$('preview').src=oldPreviewSrc;else $('preview').removeAttribute('src');
  const message=e.name==='AbortError'?(importTimedOut?'문제·풀이 읽기가 5분을 넘었습니다. 한 문제와 풀이가 보이는 선명한 이미지로 다시 넣어 주세요.':'파일 읽기를 취소했습니다.'):e.message;
  $('file-info').textContent='파일 읽기 실패 · 기존 입력 유지 · '+message;feedback('파일을 읽지 못했습니다',message,true);
 }finally{clearInterval(timer);clearTimeout(deadline);importController=null;setBusy(false);$('file').value='';}
}

function showSeparatePreview(id,file,index){
 const image=$(id);if(separatePreviewUrls[index])URL.revokeObjectURL(separatePreviewUrls[index]);
 separatePreviewUrls[index]=file.type.startsWith('image/')?URL.createObjectURL(file):null;
 image.hidden=!separatePreviewUrls[index];if(separatePreviewUrls[index])image.src=separatePreviewUrls[index];
}
async function importSeparateFiles(questionFile,solutionFile=null){
 if(busy||!questionFile)return;
 if(!authenticated){$('main-studio').hidden=true;$('lock-screen').hidden=false;return;}
 if([questionFile,solutionFile].filter(Boolean).some(file=>file.size>10*1024*1024)){feedback('파일을 확인해 주세요','문제와 풀이 파일은 각각 10MB까지 지원합니다.',true);return;}
 comparisonOutputs=[];$('comparison').replaceChildren();importController=new AbortController();importTimedOut=false;result=null;jobId=null;setBusy(true);
 $('generate').textContent=solutionFile?'문제와 풀이 분리 중…':'문제 읽는 중…';$('file-info').textContent=solutionFile?questionFile.name+' + '+solutionFile.name+' · 두 파일 업로드 중':questionFile.name+' · 문제 이미지 업로드 중';
 feedback(solutionFile?'문제 이미지와 풀이 이미지를 읽고 있습니다':'문제 이미지를 읽고 있습니다',solutionFile?'두 파일의 역할을 고정해 문제 본문, 정답·해설, 실제 풀이 순서로 분리합니다.':'문제 본문·표·그림만 먼저 읽습니다. 완료 후 STEP별 풀이를 생성할 수 있습니다.');
 globalThis.analysisStatus?.('이미지 분석 중',solutionFile?'문제와 풀이를 구분하고 실제 풀이 단계를 찾고 있습니다.':'문제 본문·표·그림을 읽고 있습니다.');
 $('cancel').disabled=false;$('cancel').textContent='파일 읽기 취소';$('elapsed').textContent='0초 경과 · 파일 읽기 취소 가능';
 const start=Date.now();const timer=setInterval(()=>{const seconds=Math.floor((Date.now()-start)/1000);$('file-info').textContent=(solutionFile?'문제+풀이 분리 중':'문제 읽는 중')+' · '+seconds+'초 경과';$('elapsed').textContent=seconds+'초 경과 · 파일 읽기 취소 가능';},1000);
 const deadline=setTimeout(()=>{importTimedOut=true;importController?.abort();},305000);
 try{
  const form=new FormData();form.append('questionFile',questionFile);if(solutionFile)form.append('solutionFile',solutionFile);form.append('provider',selectedModel().provider);form.append('materialKind',solutionFile?'problem-solution-separate':'problem-only');
  const d=await api('import',{method:'POST',body:form,signal:importController.signal});applyImportedMaterial(d);
  if(d.previewDataUrls?.length){if(!$('question-preview').getAttribute('src'))$('question-preview').src=d.previewDataUrls[0];$('question-preview').hidden=false;if(d.previewDataUrls.length>=2){if(!$('solution-preview').getAttribute('src'))$('solution-preview').src=d.previewDataUrls[1];$('solution-preview').hidden=false;}}
 }catch(e){
 const message=e.name==='AbortError'?(importTimedOut?'이미지 읽기가 5분을 넘었습니다. 선명한 이미지로 다시 넣어 주세요.':'파일 읽기를 취소했습니다.'):e.message;
  $('file-info').textContent='이미지 분석 실패 · 선택한 파일 유지';globalThis.analysisStatus?.('이미지를 분석하지 못했습니다',message+'\n파일은 그대로 유지됩니다. 같은 단계에서 다시 분석할 수 있습니다.','error');feedback('이미지를 읽지 못했습니다',message,true);
 }finally{clearInterval(timer);clearTimeout(deadline);importController=null;setBusy(false);$('question-file').value='';$('solution-file').value='';}
}

$('file').addEventListener('change',()=>importFile($('file').files[0]));
$('question-file').addEventListener('change',()=>{selectedQuestionFile=$('question-file').files[0]||null;if(selectedQuestionFile){sourceId=null;requiresImage=false;for(const id of ['title','body','answer','explanation'])$(id).value='';writeLogicSteps([]);clearResult();if($('analysis-status'))$('analysis-status').hidden=true;showSeparatePreview('question-preview',selectedQuestionFile,0);}materialReadPending=!!(selectedQuestionFile||selectedSolutionFile);$('file-info').textContent=selectedQuestionFile?(selectedSolutionFile?'문제와 풀이 선택 완료':'문제 선택 완료 · 풀이가 없으면 문제만 분석할 수 있습니다'):'문제 이미지를 선택해 주세요.';globalThis.updateWorkflowState?.();$('wizard-stage-2')?.scrollIntoView({behavior:'smooth',block:'center'});});
$('solution-file').addEventListener('change',()=>{selectedSolutionFile=$('solution-file').files[0]||null;materialReadPending=!!(selectedQuestionFile||selectedSolutionFile);if(selectedSolutionFile)showSeparatePreview('solution-preview',selectedSolutionFile,1);$('file-info').textContent=selectedQuestionFile?'문제와 풀이 선택 완료':'풀이 선택 완료 · 문제 이미지도 선택해 주세요.';if($('analysis-status'))$('analysis-status').hidden=true;globalThis.updateWorkflowState?.();});
$('read-material').onclick=()=>{if(!selectedQuestionFile){feedback('문제 이미지가 필요합니다','문제 칸에 이미지나 한 페이지 PDF를 먼저 선택해 주세요.',true);return;}importSeparateFiles(selectedQuestionFile,selectedSolutionFile);};
const drop=document.querySelector('.upload');drop.addEventListener('dragover',e=>e.preventDefault());
drop.addEventListener('drop',e=>{
 e.preventDefault();if(e.dataTransfer.files.length!==1){feedback('파일 하나를 선택해 주세요','먼저 한 문제의 파일을 넣어 주세요.',true);return;}
 selectedQuestionFile=e.dataTransfer.files[0];materialReadPending=true;showSeparatePreview('question-preview',selectedQuestionFile,0);$('file-info').textContent='문제 선택 완료 · 풀이가 없으면 바로 읽을 수 있습니다';if(result)$('badge').textContent='이전 결과';globalThis.updateWorkflowState?.();
});

for(const id of ['title','body','answer','explanation'])$(id).addEventListener('input',clearResult);
$('add-logic-step').onclick=()=>{if(!busy){addLogicStep();clearResult();logicStepInputs().at(-1)?.focus();}};
$('reset').onclick=()=>{if(busy)return;sourceId=null;requiresImage=false;pendingJob=null;generationStarted=false;materialReadPending=false;selectedQuestionFile=selectedSolutionFile=null;for(const id of ['title','body','answer','explanation'])$(id).value='';writeLogicSteps([]);for(const id of ['preview','question-preview','solution-preview']){$(id).hidden=true;$(id).removeAttribute('src');}if($('analysis-status'))$('analysis-status').hidden=true;$('file-info').textContent='문제 이미지를 먼저 선택해 주세요.';setBusy(false);clearResult();$('wizard-stage-1')?.scrollIntoView({behavior:'smooth',block:'start'});};

function renderComparisons(outputs){
 comparisonOutputs=outputs;if(!outputs.length){$('comparison').hidden=true;return;}
 const ordered=[...outputs].sort((a,b)=>(a.stageNumber||0)-(b.stageNumber||0));
 const cards=ordered.map(o=>{
  const card=document.createElement('article');card.className='stage-result-card '+o.state;
  const head=document.createElement('div');head.className='stage-result-head';const heading=document.createElement('div'),number=document.createElement('b'),label=document.createElement('strong'),status=document.createElement('span');
  heading.className='stage-result-title';number.textContent=o.stageNumber&&o.stageCount?`문제 ${o.stageNumber}/${o.stageCount}`:'문제';label.textContent=o.stageLabel||o.model||o.result?.model||(o.provider==='deepseek'?'DeepSeek V4 Flash':'Gemma 4 12B');heading.append(number,label);
  status.textContent=o.state==='ready'?'✓ 문제·해설 완료':o.state==='waiting'?'앞 문제 완료 후 시작':o.state==='running'?(o.phase||'문제 생성 중'):o.error||'생성 실패';status.className='stage-state '+o.state;head.append(heading,status);card.append(head);
  if(!o.result){const state=document.createElement('div'),track=document.createElement('div');state.className='stage-progress-state';track.className='stage-progress-track';state.append(track,document.createTextNode(o.state==='waiting'?'순서대로 생성하기 위해 대기 중입니다.':o.state==='running'?'현재 이 문제를 만들고 검사하고 있습니다.':o.error||'생성을 완료하지 못했습니다.'));card.append(state);}
  if(o.result){
   const r=prepareProblemDisplay(o.result),summary=document.createElement('div'),title=document.createElement('h3'),answer=document.createElement('strong'),details=document.createElement('details'),detailSummary=document.createElement('summary'),content=document.createElement('div'),body=document.createElement('div'),choices=document.createElement('div'),explanation=document.createElement('div'),actions=document.createElement('div'),imageButton=document.createElement('button');
   summary.className='stage-ready-summary';title.textContent=r.title;answer.textContent='정답 · '+r.answer;summary.append(title,answer);
   details.className='stage-result-details';detailSummary.textContent='문제와 해설 펼쳐보기';content.className='stage-result-content';body.className='pre';renderProblemText(body,r.body);renderProblemChoices(choices,r);explanation.className='pre stage-explanation';explanation.textContent='해설\n'+r.explanation;content.append(body,choices,explanation);details.append(detailSummary,content);
   actions.className='stage-result-actions';imageButton.textContent='문제 이미지로 보기';imageButton.onclick=async()=>{if(qualityChecking)return;show(r);$('output').hidden=false;$('output').scrollIntoView({behavior:'smooth',block:'start'});await checkRenderedResult();};actions.append(imageButton);card.append(summary,details,actions);
  }
  return card;
 });
 $('comparison').replaceChildren(...cards);$('comparison').hidden=false;
}

function selectedModel(){const value=$('provider').value;return {provider:value==='gemma'?'gemma':value==='both'?'both':'deepseek'};}
$('provider').addEventListener('change',()=>{clearResult();globalThis.updateWorkflowState?.();});

$('solve-problem').onclick=async()=>{
 if(busy)return;
 const title=$('title').value.trim(),body=$('body').value.trim();
 if(!title||!body){feedback('먼저 문제를 읽어 주세요','문제 이미지를 선택하고 ‘선택한 문제·풀이 읽기’를 누르거나 문제 본문을 입력해 주세요.',true);return;}
 const selected=selectedModel().provider,provider=selected==='both'?'deepseek':selected;
 importController=new AbortController();importTimedOut=false;setBusy(true);$('cancel').disabled=false;$('cancel').textContent='풀이 생성 취소';
 feedback('STEP별 풀이를 만들고 있습니다','원본 문제를 먼저 직접 풀고, 실제 판단과 계산 순서에 맞춰 필요한 만큼 단계로 정리합니다.');
 const deadline=setTimeout(()=>{importTimedOut=true;importController?.abort();},305000);
 try{
  const solved=await api('solution',{method:'POST',signal:importController.signal,headers:{'Content-Type':'application/json'},body:JSON.stringify({title,body,provider,sourceId})});
  $('body').value=solved.body||body;$('answer').value=solved.answer||'';$('explanation').value=solved.explanation||'';writeLogicSteps(solved.steps||[]);$('material-kind').value='problem-solution-separate';
  document.querySelector('.optional-details').open=true;feedback('풀이 단계 분석이 완성됐습니다',`정답과 실제 풀이 ${solved.steps?.length||0}단계를 확인하세요.`);globalThis.analysisStatus?.('풀이 단계 분석 완료',`실제 풀이 ${solved.steps?.length||0}단계로 정리했습니다.`,'success');$('status').textContent=solved.method+' 완료 · 단계별 문제 생성 가능';save();
 }catch(e){const message=e.name==='AbortError'?(importTimedOut?'풀이 생성이 5분을 넘었습니다. 문제 한 개만 남겨 다시 시도해 주세요.':'풀이 생성을 취소했습니다.'):e.message;feedback('STEP별 풀이를 만들지 못했습니다',message,true);$('status').textContent='풀이 생성 실패 · 문제 입력은 유지됩니다.';}
 finally{clearTimeout(deadline);importController=null;setBusy(false);if(hasValidLogic())setTimeout(()=>$('wizard-stage-4')?.scrollIntoView({behavior:'smooth',block:'start'}),0);}
};

async function waitForGeneration(provider){
 const started=Date.now(),controller=new AbortController();
 let jobStarted=pendingJob?.startedAt||started,lastChecked=null;
 const tick=()=>{
  const now=Date.now(),seconds=Math.max(0,Math.floor((now-jobStarted)/1000));
  const age=Math.floor((now-(lastChecked??started))/1000);
  const waiting=age>=10;
  if(qualityChecking){$('elapsed').textContent=seconds+'초 경과 · 최종 PNG 검사 중 · 검사 중지 가능';return;}
  const stageProgress=globalThis.currentStageProgress||'';$('elapsed').textContent=seconds+'초 경과 · '+(stageProgress?stageProgress+' · ':'')+(waiting?'서버 응답 대기 · '+(lastChecked?'마지막 확인 '+age+'초 전':'아직 상태 응답 없음')+' · ':'')+'취소 가능';
  if(waiting)$('status').textContent='결과 조회 응답을 기다리고 있습니다 · 같은 작업 확인 중 · 작업 번호: '+jobId;
 };
 tick();const timer=setInterval(tick,1000),deadline=setTimeout(()=>controller.abort(),750000);
 try{for(;;){
  await new Promise(resolve=>setTimeout(resolve,1000));
  if(controller.signal.aborted)throw new Error('결과 확인 시간이 초과됐습니다. 작업 번호: '+jobId+'\n‘진행 중이던 결과 확인’으로 같은 작업을 다시 조회할 수 있습니다.');
  let j;
  try{j=await api('jobs/'+jobId,{signal:controller.signal});}catch(e){
   if(controller.signal.aborted)throw new Error('결과 확인 시간이 초과됐습니다. 작업 번호: '+jobId+'\n‘진행 중이던 결과 확인’으로 같은 작업을 다시 조회할 수 있습니다.');
   throw e;
  }
  lastChecked=Date.now();
  if(Number.isFinite(j.elapsedSeconds))jobStarted=lastChecked-j.elapsedSeconds*1000;
  if(pendingJob&&!pendingJob.startedAt){pendingJob.startedAt=jobStarted;save();}
  const outputs=j.outputs||[],readyStages=outputs.filter(o=>o.state==='ready').length,activeStage=outputs.find(o=>o.state==='running')||outputs.find(o=>o.state==='waiting');
  globalThis.currentStageProgress=activeStage&&j.stageSeries?`문제 ${activeStage.stageNumber}/${activeStage.stageCount} · ${activeStage.stageLabel} · ${activeStage.phase||'대기 중'}`:'';
  tick();if(j.stageSeries&&activeStage){$('feedback-title').textContent=`문제 ${activeStage.stageNumber}/${activeStage.stageCount} · ${activeStage.stageLabel}`;$('feedback-body').textContent=`${activeStage.phase||'진행 중'}\n완료 ${readyStages}/${j.stageCount} · 작업 번호: ${jobId}`;}else $('feedback-body').textContent=j.phase+'\n작업 번호: '+jobId;globalThis.updateWorkflowState?.();
  if(j.stageSeries)$('badge').textContent=`${readyStages}/${j.stageCount} 완료`;
  $('status').textContent='서버 상태 확인됨 · '+j.phase;renderComparisons(j.outputs||[]);
  if(j.state==='ready'){
   show(j.result);await checkRenderedResult();pendingJob=null;
   renderComparisons(j.outputs||[]);
   if(provider==='both'&&!j.stageSeries){$('output').hidden=true;$('copy').disabled=$('print').disabled=true;}
   globalThis.currentStageProgress='';$('badge').textContent=j.stageSeries?`단계별 ${j.stageCount}문제 완성`:'생성 완료';$('status').textContent=(j.stageSeries?`단계별 문제 ${j.stageCount}개 완성 · `:'문제 이미지 생성됨 · ')+qualitySummary(result?.quality);return;
  }
  if(j.state==='failed'||j.state==='cancelled'){pendingJob=null;throw new Error((j.error||'서버가 실패 원인을 반환하지 않았습니다.')+'\n작업 번호: '+jobId);}
 }}finally{clearInterval(timer);clearTimeout(deadline);}
}

function generationError(e){
 if(e.jobMissing||(!e.networkFailure&&!jobId))pendingJob=null;
 const message=e.message+(e.networkFailure&&jobId?'\n작업 번호: '+jobId+'\n‘진행 중이던 결과 확인’을 눌러 같은 작업을 다시 조회할 수 있습니다.':'');
 feedback(e.jobMissing?'이전 생성 결과가 서버에 남아 있지 않습니다':e.networkFailure?'웹 서버와 연결이 끊겼습니다':result?'문제는 생성됐지만 결과를 표시하지 못했습니다':'문제를 생성하지 못했습니다',message,true);renderComparisons(comparisonOutputs);
}

async function submitGeneration(payload){
 const d=await api('generate',{method:'POST',idempotent:true,headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
 if(!/^[a-f0-9]{32}$/.test(d.id))throw new Error('서버가 올바른 생성 작업 번호를 반환하지 않았습니다.');
 jobId=d.id;pendingJob={id:jobId,provider:payload.provider,stageSeries:!!payload.stageSeries,startedAt:Date.now()};save();$('progress').hidden=false;$('cancel').disabled=false;
}

async function resumeGeneration(){
 if(busy||!pendingJob||!authenticated)return;
 generationStarted=true;
 jobId=pendingJob.id;const provider=pendingJob.provider;setBusy(true);
 feedback('진행 중이던 생성 결과를 확인합니다','새 생성 요청 없이 기존 작업을 조회합니다.');$('cancel').disabled=false;
 try{if(!jobId)await submitGeneration(pendingJob.payload);await waitForGeneration(provider);}catch(e){generationError(e);}finally{setBusy(false);jobId=null;save();}
}
$('resume-job').onclick=resumeGeneration;

$('generate').onclick=async()=>{
 if(busy)return;if(pendingJob)return resumeGeneration();if(!$('title').value.trim()||!$('body').value.trim()){feedback('기준 자료를 확인해 주세요','1단계에서 문제 이미지나 본문을 입력해 주세요.',true);return;}
 const logicSteps=readLogicSteps();if(logicSteps.length<1||logicSteps.length>12||logicSteps.some(step=>!step)){document.querySelector('.optional-details').open=true;feedback('실제 풀이 단계를 확인해 주세요','쌍둥이 문제는 원본 풀이의 모든 단계를 같은 순서로 사용합니다. 빈 단계 없이 1~12개로 정리하거나, 풀이가 없으면 먼저 STEP별 풀이를 생성해 주세요.',true);logicStepInputs()[0]?.scrollIntoView({behavior:'smooth',block:'center'});return;}
 const {provider}=selectedModel();result=null;comparisonOutputs=[];jobId=null;generationStarted=true;
 $('elapsed').textContent='0초 경과 · 생성 취소 가능';$('cancel').textContent='생성 취소';setBusy(true);save();
 feedback('단계별 문제와 해설을 만들고 있습니다',`총 ${logicSteps.length}개 문제를 STEP 1부터 전체 로직까지 순서대로 생성합니다.`);$('badge').textContent=`0/${logicSteps.length} 완료`;document.querySelector('.result').scrollIntoView({behavior:'smooth',block:'start'});
 try{
  if(requiresImage){const source=sourceId?await api('sources/'+sourceId):{ready:false};if(!source.ready){throw new Error('원본 보관 시간이 끝났거나 이전 버전에서 사라진 이미지입니다. 본문은 유지됩니다. 파일을 한 번 다시 넣어 주세요.');}}
  const requestId=crypto.randomUUID().replace(/-/g,'');
  const payload={title:$('title').value.trim(),body:$('body').value.trim(),answer:$('answer').value.trim(),explanation:$('explanation').value.trim(),logicSteps,sourceId,requiresImage,fromSolution:false,useSolutionLogic:true,materialKind:'problem-solution',provider,requestId,stageSeries:true};
  pendingJob={id:null,provider,payload};save();
  await submitGeneration(payload);
  await waitForGeneration(provider);
 }catch(e){generationError(e);}finally{setBusy(false);jobId=null;save();}
};

$('continue-action').onclick=()=>{
 if(busy)return;
 switch($('continue-action').dataset.action){
  case 'read':$('read-material').click();break;
  case 'solve':$('solve-problem').click();break;
  case 'generate':$('generate').click();break;
  case 'resume':resumeGeneration();break;
  default:$('question-file').click();
 }
};

$('cancel').onclick=async()=>{if(renderController){renderController.abort();return;}if(importController){importController.abort();return;}if(!jobId)return;$('cancel').disabled=true;try{await api('jobs/'+jobId+'/cancel',{method:'POST'});}catch(e){$('feedback-body').textContent=e.message;}};
$('copy').onclick=async()=>{
 if(!result)return;
 const text=problemExportText(result);
 try{
  await navigator.clipboard.writeText(text);$('status').textContent='문제·해설 텍스트를 복사했습니다.';
 }catch{
  const area=document.createElement('textarea');area.value=text;document.body.append(area);area.select();document.execCommand('copy');area.remove();
  $('status').textContent='문제·해설 텍스트를 복사했습니다.';
 }
};
$('print').onclick=()=>window.print();

// Problem Image Card Rendering
function formatProblemMath(text){
 const sub='₀₁₂₃₄₅₆₇₈₉',sup={'0':'⁰','1':'¹','2':'²','3':'³','4':'⁴','5':'⁵','6':'⁶','7':'⁷','8':'⁸','9':'⁹','+':'⁺','-':'⁻'};
 return String(text??'').replace(/\*\*([^*\n]+)\*\*/g,'$1').replace(/`([^`\n]+)`/g,'$1')
  .replace(/([A-Za-z])_\{?(\d+)\}?/g,(_,v,n)=>v+[...n].map(d=>sub[Number(d)]).join(''))
  .replace(/(?<![A-Za-z])([dVvxyqt])(\d+)(?=$|[^A-Za-z\d]|[dVvxyqt]\d)/g,(_,v,n)=>v+[...n].map(d=>sub[Number(d)]).join(''))
  .replace(/\^(?:\{([+-]?\d+|[+-])\}|([+-]?\d+|[+-]))/g,(_,a,b)=>[...(a||b)].map(c=>sup[c]).join(''));
}

function problemTextBlocks(text){
 const lines=String(text??'').split('\n'),blocks=[];
 const cells=line=>line.trim().replace(/^\|/,'').replace(/\|$/,'').split(/(?<!\\)\|/).map(c=>c.trim().replace(/\\\|/g,'|'));
 for(let i=0;i<lines.length;){
  if(lines[i].trim().startsWith('|')&&i+1<lines.length){
   const headers=cells(lines[i]),separator=cells(lines[i+1]);
   if(headers.length>1&&separator.length===headers.length&&separator.every(c=>/^:?-{3,}:?$/.test(c))){
    let end=i+2;const rows=[];
    while(end<lines.length&&lines[end].trim().startsWith('|')){const row=cells(lines[end]);if(row.length!==headers.length)break;rows.push(row);end++;}
    if(rows.length){blocks.push({type:'table',headers,rows,raw:lines.slice(i,end).join('\n')});i=end;continue;}
   }
  }
  if(blocks.at(-1)?.type==='text')blocks.at(-1).text+='\n'+lines[i];else blocks.push({type:'text',text:lines[i]});i++;
 }
 return blocks;
}

function prepareProblemDisplay(r){
 const cleanChoice=s=>formatProblemMath(s).replace(/^(?:[①②③④⑤]\s*|[1-5][.)]\s+)/,'').trim();
 const choices=(r.choices||[]).map(cleanChoice),canonical=s=>cleanChoice(s).replace(/\s+/g,'').replace(/；/g,';');
 let choiceTable=r.choiceTable||null;
 const blocks=problemTextBlocks(r.body);
 const kept=blocks.filter(block=>{
  if(block.type!=='table'||block.rows.length!==5||choices.length!==5)return true;
  const values=block.rows.map((row,i)=>{
   const match=row[0].match(/^([①②③④⑤])\s*(.*)$/);
   if(!match||match[1]!==['①','②','③','④','⑤'][i])return null;
   return match[2]?[match[2],...row.slice(1)]:row.slice(1);
  });
  if(values.some((row,i)=>!row||canonical(row.join(' ; '))!==canonical(choices[i])))return true;
  const separateNumber=block.rows[0][0].trim()==='①';
  choiceTable={headers:['보기',...(separateNumber?block.headers.slice(1):block.headers)].map(formatProblemMath),rows:values.map((row,i)=>[['①','②','③','④','⑤'][i],...row.map(formatProblemMath)])};
  return false;
 });
 let body=kept.map(b=>b.type==='table'?b.raw:b.text).join('\n').trim();
 const lines=body.split('\n'),tail=lines.slice(-5);
 if(choices.length===5&&tail.length===5&&tail.every((s,i)=>s.trim().startsWith(['①','②','③','④','⑤'][i])&&canonical(s)===canonical(choices[i])))body=lines.slice(0,-5).join('\n').trim();
 body=body.replace(/^\[페이지\s*\d+\]\s*\n/,'');
 return {...r,body:formatProblemMath(body),choices,choiceTable,answer:formatProblemMath(r.answer),explanation:formatProblemMath(r.explanation),steps:(r.steps||[]).map(s=>formatProblemMath(s).replace(/^[1-3][.)]\s+/,'')),sourceProblem:formatProblemMath(r.sourceProblem)};
}

function createProblemTable(table){
 const wrapper=document.createElement('div');wrapper.className='problem-table-scroll';
 const el=document.createElement('table');el.className='problem-table';
 const head=document.createElement('thead'),heading=document.createElement('tr');
 for(const text of table.headers){const th=document.createElement('th');th.scope='col';th.textContent=formatProblemMath(text);heading.append(th);}head.append(heading);
 const body=document.createElement('tbody');
 for(const row of table.rows){const tr=document.createElement('tr');for(const text of row){const td=document.createElement('td');td.textContent=formatProblemMath(text);tr.append(td);}body.append(tr);}
 el.append(head,body);wrapper.append(el);return wrapper;
}

function renderProblemText(el,text,sentences=false){
 const children=[];
 for(const block of problemTextBlocks(formatProblemMath(text))){
  if(block.type==='table'){children.push(createProblemTable(block));continue;}
  const content=sentences?block.text.replace(/([.!?])\s+(?=[가-힣(])/g,'$1\n\n'):block.text;
  for(const para of content.split(/\n\s*\n/)){if(!para.trim())continue;const p=document.createElement('p');p.className='problem-paragraph';p.textContent=para.trim();children.push(p);}
 }
 el.replaceChildren(...children);
}

function renderProblemChoices(el,r){
 if(r.choiceTable){el.replaceChildren(createProblemTable(r.choiceTable));return;}
 const list=document.createElement('ol');list.className='problem-choice-list';
 for(const [i,text] of (r.choices||[]).entries()){const li=document.createElement('li');li.textContent=['①','②','③','④','⑤'][i]+' '+text;list.append(li);}el.replaceChildren(list);
}

function problemExportText(r){
 r=prepareProblemDisplay(r);
 const options=r.choiceTable?['| '+r.choiceTable.headers.join(' | ')+' |','| '+r.choiceTable.headers.map(()=>'---').join(' | ')+' |',...r.choiceTable.rows.map(row=>'| '+row.join(' | ')+' |')].join('\n'):r.choices.map((c,i)=>['①','②','③','④','⑤'][i]+' '+c).join('\n');
 return [r.title,r.body,options,'정답: '+r.answer,'해설: '+r.explanation,...r.steps].join('\n\n');
}

function parseProblemTable(text) {
 const blocks=problemTextBlocks(text),tables=blocks.filter(b=>b.type==='table');
 return {hasTable:tables.length>0,tables,headers:tables[0]?.headers||[],rows:tables[0]?.rows||[],cleanText:blocks.filter(b=>b.type==='text').map(b=>b.text).join('\n').replace(/\n{3,}/g,'\n\n')};
}

function synthesizeReactionGraph(r) {
 if(Array.isArray(r.diagrams)&&r.diagrams.length){
  for(const panel of r.diagrams){
   if(!Array.isArray(panel.charges)||panel.charges.length<2||panel.charges.some(c=>!Number.isFinite(c.position)))throw new Error('모식도의 전하 위치가 누락됐습니다. 임의 위치로 그리지 않습니다.');
  }
  return {type:'charges',panels:r.diagrams};
 }
 if(r.graph&&Array.isArray(r.graph.xPoints)&&r.graph.xPoints.length>=2&&r.graph.xPoints.length===r.graph.yPoints?.length)return r.graph;
 return null;
}

function wrapTextLines(ctx, text, maxWidth) {
 const lines = [];
 const paragraphs = (text || '').split('\n');
 for (const para of paragraphs) {
  const trimmed = para.trim();
  if (!trimmed) { lines.push({ text: '', isCondition: false }); continue; }
  const isCondition = trimmed.startsWith('(단,') || trimmed.startsWith('단,') || (trimmed.includes('→') && !trimmed.startsWith('①'));
  const words = trimmed.split(' ');
  let current = '';
  for (let i = 0; i < words.length; i++) {
   const w = words[i];
   const testLine = current ? current + ' ' + w : w;
   if (ctx.measureText(testLine).width <= maxWidth) {
    current = testLine;
   } else {
    if (current) lines.push({ text: current, isCondition });
    if (ctx.measureText(w).width > maxWidth) {
     let chunk = '';
     for (const ch of w) {
      if (ctx.measureText(chunk + ch).width > maxWidth) {
       lines.push({ text: chunk, isCondition });
       chunk = ch;
      } else {
       chunk += ch;
      }
     }
     current = chunk;
    } else {
     current = w;
    }
   }
  }
  if (current) lines.push({ text: current, isCondition });
 }
 return lines;
}

function roundRect(ctx, x, y, width, height, radius) {
 ctx.beginPath();
 ctx.moveTo(x + radius, y);
 ctx.lineTo(x + width - radius, y);
 ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
 ctx.lineTo(x + width, y + height - radius);
 ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
 ctx.lineTo(x + radius, y + height);
 ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
 ctx.lineTo(x, y + radius);
 ctx.quadraticCurveTo(x, y, x + radius, y);
 ctx.closePath();
}

function problemTableColumnWidths(table,width){
 const count=table.headers.length;if(!count)return [];
 const minimum=table.headers.map((header,index)=>index===0&&/^(실험|구분|번호)$/.test(header.trim())?56:72);
 const scores=table.headers.map((header,index)=>{
  if(index===0&&/^(실험|구분|번호)$/.test(header.trim()))return .35;
  const longest=Math.max(header.length,...table.rows.map(row=>(row[index]||'').length));return Math.max(.8,Math.min(2.8,longest/10));
 });
 const remain=Math.max(0,width-minimum.reduce((sum,value)=>sum+value,0)),scoreTotal=scores.reduce((sum,value)=>sum+value,0)||1;
 return minimum.map((value,index)=>value+remain*scores[index]/scoreTotal);
}

function drawProblemTable(ctx, table, x, y, width, fontMain) {
 const colCount = table.headers.length;
 if (colCount === 0) return 0;
 const colWidths=problemTableColumnWidths(table,width),colStarts=[];let offset=x;for(const colWidth of colWidths){colStarts.push(offset);offset+=colWidth;}
 ctx.save();
 ctx.font = `bold 12.5px ${fontMain}`;
 const headerLines=table.headers.map((text,index)=>wrapTextLines(ctx,text,colWidths[index]-18));
 const headerH=Math.max(34,...headerLines.map(lines=>lines.length*17+16));
 ctx.font = `13.5px ${fontMain}`;
 const cellLines=table.rows.map(row=>table.headers.map((_,c)=>wrapTextLines(ctx,row[c]||'',colWidths[c]-18)));
 const rowHeights=cellLines.map(row=>Math.max(30,...row.map(lines=>lines.length*16+12)));
 const totalH=headerH+rowHeights.reduce((sum,h)=>sum+h,0);
 // Background
 ctx.fillStyle = '#ffffff';
 roundRect(ctx, x, y, width, totalH, 6);
 ctx.fill();
 ctx.strokeStyle = '#94a3b8';
 ctx.lineWidth = 1.2;
 roundRect(ctx, x, y, width, totalH, 6);
 ctx.stroke();

 // Header background
 ctx.fillStyle = '#f1f5f9';
 ctx.beginPath();
 ctx.moveTo(x + 6, y);
 ctx.lineTo(x + width - 6, y);
 ctx.quadraticCurveTo(x + width, y, x + width, y + 6);
 ctx.lineTo(x + width, y + headerH);
 ctx.lineTo(x, y + headerH);
 ctx.lineTo(x, y + 6);
 ctx.quadraticCurveTo(x, y, x + 6, y);
 ctx.closePath();
 ctx.fill();

 // Header border
 ctx.strokeStyle = '#cbd5e1';
 ctx.lineWidth = 1;
 ctx.beginPath();
 ctx.moveTo(x, y + headerH);
 ctx.lineTo(x + width, y + headerH);
 ctx.stroke();

 // Header text
 ctx.font = `bold 12.5px ${fontMain}`;
 ctx.fillStyle = '#1e293b';
 ctx.textAlign = 'center';
 ctx.textBaseline = 'middle';
 for (let c = 0; c < colCount; c++) {
  headerLines[c].forEach((line,i)=>ctx.fillText(line.text,colStarts[c]+colWidths[c]/2,y+headerH/2+(i-(headerLines[c].length-1)/2)*17));
 }

 // Data rows
 ctx.font = `13.5px ${fontMain}`;
 let rowY=y+headerH;
 for (let r = 0; r < table.rows.length; r++) {
  const rowH=rowHeights[r];
  if (r % 2 === 1) {
   ctx.fillStyle = '#f8fafc';
   ctx.fillRect(x + 1, rowY, width - 2, rowH);
  }
  ctx.fillStyle = '#334155';
  for (let c = 0; c < colCount; c++) {
   const lines=cellLines[r][c];lines.forEach((line,i)=>ctx.fillText(line.text,colStarts[c]+colWidths[c]/2,rowY+rowH/2+(i-(lines.length-1)/2)*16));
  }
  if (r < table.rows.length - 1) {
   ctx.strokeStyle = '#e2e8f0';
   ctx.beginPath();
   ctx.moveTo(x, rowY + rowH);
   ctx.lineTo(x + width, rowY + rowH);
   ctx.stroke();
  }
  rowY+=rowH;
 }
 ctx.strokeStyle='#cbd5e1';
 for(let c=1;c<colCount;c++){ctx.beginPath();ctx.moveTo(colStarts[c],y);ctx.lineTo(colStarts[c],y+totalH);ctx.stroke();}
 ctx.restore();
 return totalH;
}

function drawProblemGraph(ctx, graph, x, y, width, height, fontMain) {
 ctx.save();ctx.fillStyle='#fff';ctx.strokeStyle='#cbd5e1';ctx.lineWidth=1;
 roundRect(ctx,x,y,width,height,8);ctx.fill();ctx.stroke();
 ctx.fillStyle='#0f172a';ctx.font=`bold 13px ${fontMain}`;ctx.textAlign='center';ctx.fillText(graph.title||'자료 그래프',x+width/2,y+22);
 const xs=graph.xPoints,ys=graph.yPoints;
 const minX=Math.min(0,...xs),maxX=Math.max(0,...xs),minY=Math.min(0,...ys),maxY=Math.max(0,...ys);
 const dx=maxX-minX||1,dy=maxY-minY||1;
 const left=x+72,right=x+width-32,top=y+45,bottom=y+height-60;
 const mapX=v=>left+(v-minX)/(dx*1.08)*(right-left);
 const mapY=v=>bottom-(v-minY)/(dy*1.12)*(bottom-top);
 ctx.font=`11px ${fontMain}`;ctx.lineWidth=1;ctx.strokeStyle='#e2e8f0';ctx.fillStyle='#475569';ctx.setLineDash([3,3]);
 const ticks=xs.length<=8?xs.map((_,i)=>i):[...new Set([0,...Array.from({length:5},(_,i)=>Math.round((i+1)*(xs.length-1)/6)),xs.length-1])];
 for(const i of ticks){const px=mapX(xs[i]),py=mapY(ys[i]);ctx.beginPath();ctx.moveTo(px,top);ctx.lineTo(px,bottom);ctx.stroke();ctx.beginPath();ctx.moveTo(left,py);ctx.lineTo(right,py);ctx.stroke();ctx.textAlign='center';ctx.fillText(String(xs[i]),px,bottom+18);ctx.textAlign='right';ctx.fillText(String(ys[i]),left-8,py+4);}
 ctx.setLineDash([]);ctx.strokeStyle='#334155';ctx.lineWidth=1.4;
 ctx.beginPath();ctx.moveTo(left,mapY(0));ctx.lineTo(right,mapY(0));ctx.stroke();ctx.beginPath();ctx.moveTo(mapX(0),bottom);ctx.lineTo(mapX(0),top);ctx.stroke();
 ctx.fillStyle='#334155';ctx.textAlign='center';ctx.font=`12px ${fontMain}`;ctx.fillText(graph.xLabel||'x',x+width/2,y+height-14);
 ctx.save();ctx.translate(x+18,y+height/2);ctx.rotate(-Math.PI/2);ctx.fillText(graph.yLabel||'y',0,0);ctx.restore();
 ctx.strokeStyle='#0284c7';ctx.lineWidth=2.5;ctx.beginPath();xs.forEach((v,i)=>i===0?ctx.moveTo(mapX(v),mapY(ys[i])):ctx.lineTo(mapX(v),mapY(ys[i])));ctx.stroke();
 for(let i=0;i<xs.length;i++){ctx.beginPath();ctx.arc(mapX(xs[i]),mapY(ys[i]),3,0,Math.PI*2);ctx.fillStyle='#fff';ctx.fill();ctx.stroke();}
 ctx.restore();
}

function collectProblemVisuals(r){
 const visuals=[];
 if(r.graph){const graph=synthesizeReactionGraph({graph:r.graph});if(!graph||graph.xPoints.some(v=>!Number.isFinite(v))||graph.yPoints.some(v=>!Number.isFinite(v)))throw new Error('그래프 좌표가 누락되거나 유효하지 않습니다.');visuals.push({kind:'graph',data:graph});}
 if(r.diagrams?.length)visuals.push({kind:'charges',data:synthesizeReactionGraph({diagrams:r.diagrams})});
 for(const drawing of r.drawings||[]){if(drawing.width!==1000||!Number.isFinite(drawing.height)||drawing.height<200||drawing.height>1000||!drawing.elements?.length)throw new Error('그림 크기 또는 요소가 누락됐습니다.');visuals.push({kind:'drawing',data:drawing});}
 if(!visuals.length&&(r.requiresVisuals||/그림|회로도|모식도|도식|배치도|도형|그래프/.test(r.body||'')))throw new Error('필수 그림이 누락된 결과입니다. 그림 없는 문제 이미지는 만들지 않습니다.');
 return visuals;
}

function drawBeaker(ctx,p,fill){
 const [x,y,w,h,level]=p;
 if(p.length!==5||w<=0||h<=0||level<0||level>1)throw new Error('비커 크기·액면 정보가 유효하지 않습니다.');
 const left=x+w*.11,right=x+w*.86,top=y+h*.09,bottom=y+h*.95,rx=w*.375,ry=h*.045,cx=(left+right)/2,r=w*.10;
 const vessel=()=>{ctx.beginPath();ctx.moveTo(left,top);ctx.lineTo(left+w*.025,bottom-r);ctx.quadraticCurveTo(left+w*.025,bottom,left+r,bottom);ctx.lineTo(right-r,bottom);ctx.quadraticCurveTo(right-w*.025,bottom,right-w*.025,bottom-r);ctx.lineTo(right,top);};
 ctx.save();ctx.setLineDash([]);ctx.lineJoin='round';ctx.lineCap='round';
 // Fill clipped to the curved glass walls; the mouth remains open.
 if(level>0&&fill!=='none'){
  const surface=bottom-level*(bottom-top-h*.07);
  ctx.save();vessel();ctx.closePath();ctx.clip();ctx.fillStyle=fill==='gray'?'#e5eaf0':'#eff4f8';ctx.fillRect(left,surface,right-left,bottom-surface+ry);
  ctx.fillStyle='#f5f7fa';ctx.beginPath();ctx.ellipse(cx,surface,rx-w*.018,ry*.8,0,0,Math.PI*2);ctx.fill();ctx.strokeStyle='#7d8a99';ctx.lineWidth=1.5;ctx.stroke();ctx.restore();
 }
 ctx.strokeStyle='#283442';ctx.lineWidth=3;vessel();ctx.stroke();
 // Rolled elliptical rim with a pouring lip on the right.
 ctx.beginPath();ctx.ellipse(cx,top,rx,ry,0,.30,Math.PI*2-.30);ctx.stroke();
 ctx.beginPath();ctx.moveTo(cx+rx*Math.cos(.30),top+ry*Math.sin(.30));ctx.quadraticCurveTo(x+w*.96,top+ry*.12,x+w*.98,top-ry*.65);ctx.lineTo(cx+rx*Math.cos(.30),top-ry*Math.sin(.30));ctx.stroke();
 // Unnumbered graduation marks do not invent a capacity.
 ctx.strokeStyle='#6b7785';ctx.lineWidth=1.4;
 for(let i=0;i<5;i++){const ty=top+h*.20+i*h*.11;ctx.beginPath();ctx.moveTo(right-w*.15,ty);ctx.lineTo(right-w*(i%2===0?.31:.24),ty);ctx.stroke();}
 ctx.strokeStyle='#a8b2be';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(left+w*.045,top+h*.09);ctx.lineTo(left+w*.065,bottom-r-h*.02);ctx.stroke();ctx.restore();
}

function drawScientificDrawing(ctx,drawing,x,y,width,fontMain){
 const scale=width/drawing.width,height=drawing.height*scale;
 ctx.save();ctx.fillStyle='#fff';ctx.strokeStyle='#cbd5e1';ctx.lineWidth=1;roundRect(ctx,x,y,width,height+40,8);ctx.fill();ctx.stroke();
 ctx.fillStyle='#0f172a';ctx.font=`bold 13px ${fontMain}`;ctx.textAlign='center';ctx.fillText(drawing.title,x+width/2,y+22);
 ctx.translate(x,y+36);ctx.scale(scale,scale);ctx.strokeStyle='#0f172a';ctx.fillStyle='#0f172a';ctx.lineWidth=2.5;
 for(const e of drawing.elements){
  const p=e.coordinates;
  if(!Array.isArray(p)||p.some(v=>!Number.isFinite(v)))throw new Error('그림 요소 좌표가 유효하지 않습니다.');
  ctx.save();ctx.setLineDash(e.dashed?[10,7]:[]);ctx.font=`${e.fontSize||26}px ${fontMain}`;ctx.textAlign='left';ctx.textBaseline='middle';
  if(e.type==='beaker'){drawBeaker(ctx,p,e.fill);ctx.restore();continue;}
  if(e.type==='text'){
   const textWidth=ctx.measureText(e.text).width,tx=Math.max(0,Math.min(p[0],drawing.width-textWidth)),ty=Math.max((e.fontSize||26)/2,Math.min(p[1],drawing.height-(e.fontSize||26)/2));
   ctx.strokeStyle='#fff';ctx.lineWidth=6;ctx.lineJoin='round';ctx.strokeText(e.text,tx,ty);ctx.fillText(e.text,tx,ty);ctx.restore();continue;
  }
  ctx.beginPath();
  switch(e.type){
   case 'line':case 'arrow':ctx.moveTo(p[0],p[1]);ctx.lineTo(p[2],p[3]);break;
   case 'circle':ctx.arc(p[0],p[1],p[2],0,Math.PI*2);break;
   case 'ellipse':ctx.ellipse(p[0],p[1],p[2],p[3],0,0,Math.PI*2);break;
   case 'rect':ctx.rect(...p);break;
   case 'polyline':case 'polygon':ctx.moveTo(p[0],p[1]);for(let i=2;i<p.length;i+=2)ctx.lineTo(p[i],p[i+1]);if(e.type==='polygon')ctx.closePath();break;
   default:throw new Error('지원하지 않는 그림 요소: '+e.type);
  }
  if(['circle','ellipse','rect','polygon'].includes(e.type)&&e.fill!=='none'){ctx.fillStyle=e.fill==='gray'?'#e5e7eb':'#fff';ctx.fill();}ctx.stroke();ctx.fillStyle='#0f172a';
  if(e.type==='arrow'){const a=Math.atan2(p[3]-p[1],p[2]-p[0]),h=16;ctx.setLineDash([]);ctx.beginPath();ctx.moveTo(p[2],p[3]);ctx.lineTo(p[2]-h*Math.cos(a-.4),p[3]-h*Math.sin(a-.4));ctx.lineTo(p[2]-h*Math.cos(a+.4),p[3]-h*Math.sin(a+.4));ctx.closePath();ctx.fill();}
  if(e.text){ctx.textAlign='center';const lx=e.type==='rect'?p[0]+p[2]/2:p[0],ly=e.type==='rect'?p[1]+p[3]/2:p[1];ctx.fillText(e.text,lx,ly);}
  ctx.restore();
 }
 ctx.restore();return height+40;
}

function drawPointChargesDiagram(ctx, diag, x, y, width, height, fontMain) {
 ctx.save();
 const positions=diag.panels.flatMap(p=>p.charges.map(c=>c.position));
 const min=Math.min(0,...positions),max=Math.max(...positions)+0.7,span=max-min;
 const columns=Math.min(2,diag.panels.length),panelW=(width-20*(columns-1))/columns;
 for(let i=0;i<diag.panels.length;i++){
  const panel=diag.panels[i],left=x+(i%columns)*(panelW+20),top=y+Math.floor(i/columns)*150;
  const axisY=top+65,axisStart=left+24,axisEnd=left+panelW-22;
  const map=value=>axisStart+(value-min)/span*(axisEnd-axisStart);
  ctx.strokeStyle='#1e293b';ctx.fillStyle='#ffffff';ctx.lineWidth=1.5;
  roundRect(ctx,left,top,panelW,138,7);ctx.stroke();
  ctx.beginPath();ctx.moveTo(axisStart,axisY);ctx.lineTo(axisEnd+10,axisY);ctx.stroke();
  ctx.fillStyle='#1e293b';ctx.beginPath();ctx.moveTo(axisEnd+10,axisY);ctx.lineTo(axisEnd+3,axisY-4);ctx.lineTo(axisEnd+3,axisY+4);ctx.closePath();ctx.fill();
  ctx.textAlign='center';ctx.textBaseline='top';ctx.font=`italic 12px ${fontMain}`;ctx.fillText('x',axisEnd+8,axisY+13);
  const ticks=new Set(panel.charges.map(c=>c.position));if(span<=8)for(let tick=Math.ceil(min);tick<=Math.floor(max);tick++)ticks.add(tick);
  for(const position of [...ticks].sort((a,b)=>a-b)){
   const px=map(position);ctx.beginPath();ctx.moveTo(px,axisY-4);ctx.lineTo(px,axisY+4);ctx.stroke();
   ctx.fillText(position===0?'0':(position===1?'':position===-1?'-':String(position))+panel.unit,px,axisY+20);
  }
  for(const charge of panel.charges){
   const px=map(charge.position);ctx.fillStyle='#ffffff';ctx.beginPath();ctx.arc(px,axisY,10,0,Math.PI*2);ctx.fill();ctx.stroke();
   ctx.fillStyle='#1e293b';ctx.font=`bold 13px ${fontMain}`;ctx.textBaseline='bottom';ctx.fillText(charge.name,px,axisY-14);
   if(charge.sign==='+'||charge.sign==='-'){ctx.textBaseline='middle';ctx.fillText(charge.sign==='-'?'−':'+',px,axisY);}
   if(charge.forceDirection==='+x'||charge.forceDirection==='-x'){
    const direction=charge.forceDirection==='+x'?1:-1,start=px+direction*12,end=start+direction*22;
    ctx.beginPath();ctx.moveTo(start,axisY);ctx.lineTo(end,axisY);ctx.stroke();ctx.beginPath();ctx.moveTo(end,axisY);ctx.lineTo(end-direction*6,axisY-4);ctx.lineTo(end-direction*6,axisY+4);ctx.closePath();ctx.fill();
   }
  }
  ctx.textBaseline='top';ctx.font=`bold 14px ${fontMain}`;ctx.fillText(panel.title,left+panelW/2,top+114);
 }
 ctx.restore();
}

function renderProblemToImage(r, includeAnswer = false) {
 imageReady=false;
 if($('problem-image'))$('problem-image').removeAttribute('src');
 if($('copy-image-footer'))$('copy-image-footer').disabled=$('download-image-footer').disabled=true;
 if (!r) return;
 r=prepareProblemDisplay(r);
 const canvas = $('problem-canvas');
 if (!canvas) return;
 const ctx = canvas.getContext('2d');
 const baseWidth = 900;
 const margin = 48;
 const contentWidth = baseWidth - margin * 2;
 const fontMain = '"Pretendard", "맑은 고딕", "Malgun Gothic", -apple-system, sans-serif';

 // 1. Parse table and clean body text
 const tableInfo = parseProblemTable(r.body || '');

 // 2. Measure text heights
 ctx.font = `16px ${fontMain}`;
 const bodyLines = wrapTextLines(ctx, tableInfo.cleanText, contentWidth);

 // Table height
 const tableH = tableInfo.tables.reduce((h,table)=>h+drawProblemTable(ctx,table,0,0,contentWidth,fontMain)+24,0);

 const visuals=collectProblemVisuals(r);
 const visualHeights=visuals.map(v=>v.kind==='charges'?150*Math.ceil(v.data.panels.length/2)+10:v.kind==='drawing'?v.data.height/v.data.width*contentWidth+40:270);
 const graphH=visualHeights.reduce((sum,h)=>sum+h+16,0);

 const choices = r.choices || [];
 const choiceIcons = ['①', '②', '③', '④', '⑤'];
 ctx.font = `15px ${fontMain}`;
 let maxChoiceW = 0;
 for (let i = 0; i < choices.length; i++) {
  const w = ctx.measureText(`${choiceIcons[i]} ${choices[i]}`).width;
  if (w > maxChoiceW) maxChoiceW = w;
 }
 const isFiveAcross=choices.length===5&&maxChoiceW<(contentWidth/5-20);
 const isTwoCol=!isFiveAcross&&maxChoiceW<(contentWidth/2-35);
 const choiceLineHeight = 32;
 const choicesHeight = r.choiceTable?drawProblemTable(ctx,r.choiceTable,0,0,contentWidth,fontMain)+24:isFiveAcross?42:isTwoCol ? (Math.ceil(choices.length / 2) * choiceLineHeight) : (choices.length * choiceLineHeight);

 let explLines = [];
 const steps = r.steps || [];
 let stepLines = [];
 let answerHeight = 0;
 if (includeAnswer) {
  ctx.font = `14px ${fontMain}`;
  explLines = wrapTextLines(ctx, r.explanation || '', contentWidth);
  ctx.font = `13px ${fontMain}`;
  stepLines = steps.map(step => wrapTextLines(ctx, step, contentWidth - 50));
  answerHeight = 110 + (explLines.length * 24) + stepLines.reduce((height, lines) => height + lines.length * 24 + 8, 0);
 }

 const bodyHeight=bodyLines.reduce((height,line)=>height+(line.text?28:12),0);
 const totalHeight=Math.max(430,94+bodyHeight+tableH+graphH+16+choicesHeight+answerHeight+70);

 // 3. Setup 2x Canvas
 const scale = 2;
 canvas.width = baseWidth * scale;
 canvas.height = totalHeight * scale;
 ctx.setTransform(scale, 0, 0, scale, 0, 0);

 // Background
 ctx.fillStyle = '#ffffff';
 ctx.fillRect(0, 0, baseWidth, totalHeight);

 // Outer Border
 ctx.strokeStyle = '#cbd5e1';
 ctx.lineWidth = 1.5;
 roundRect(ctx, 10, 10, baseWidth - 20, totalHeight - 20, 14);
 ctx.stroke();

 // Top Header
 let y = 48;
 ctx.fillStyle = '#087f70';
 roundRect(ctx, margin, y - 18, 92, 26, 6);
 ctx.fill();
 ctx.fillStyle = '#ffffff';
 ctx.font = `bold 12px ${fontMain}`;
 ctx.textAlign = 'left';
 ctx.textBaseline = 'alphabetic';
 const badgeLabel = '학습 변형 문항';
 ctx.fillText(badgeLabel, margin + 10, y - 1);

 ctx.fillStyle = '#0f172a';
 ctx.font = `bold 17px ${fontMain}`;
 const titleText = (r.title || '변형 문제').slice(0, 25);
 ctx.fillText(titleText, margin + 104, y);

 ctx.fillStyle = '#64748b';
 ctx.font = `12px ${fontMain}`;
 const modelText = r.model || 'EduMaster AI';
 const modelW = ctx.measureText(modelText).width;
 ctx.fillText(modelText, baseWidth - margin - modelW, y - 1);

 // Divider
 y += 18;
 ctx.strokeStyle = '#e2e8f0';
 ctx.lineWidth = 1;
 ctx.beginPath();
 ctx.moveTo(margin, y);
 ctx.lineTo(baseWidth - margin, y);
 ctx.stroke();

 // Problem Body
 y += 28;
 ctx.font = `16px ${fontMain}`;
 for (let i = 0; i < bodyLines.length; i++) {
  const line = bodyLines[i];
  if (!line.text) { y += 12; continue; }
  if (line.isCondition) {
   ctx.fillStyle = '#f8fafc';
   roundRect(ctx, margin - 6, y - 18, contentWidth + 12, 26, 4);
   ctx.fill();
   ctx.strokeStyle = '#e2e8f0';
   ctx.lineWidth = 1;
   ctx.stroke();

   ctx.fillStyle = '#1e293b';
   ctx.font = `500 15px ${fontMain}`;
   ctx.fillText(line.text, margin + 4, y);
   ctx.font = `16px ${fontMain}`;
  } else {
   ctx.fillStyle = '#1e293b';
   ctx.fillText(line.text, margin, y);
  }
  y += 28;
 }

 // Draw Table if present
 for(const table of tableInfo.tables){
  y += 8;
  const actualTableH = drawProblemTable(ctx, table, margin, y, contentWidth, fontMain);
  y += actualTableH + 20;
 }

 // Render every visual block; no drawing is hidden by a different visual type.
 visuals.forEach((visual,index)=>{
  y+=10;
  if(visual.kind==='charges')drawPointChargesDiagram(ctx,visual.data,margin,y,contentWidth,visualHeights[index]-10,fontMain);
  else if(visual.kind==='drawing')drawScientificDrawing(ctx,visual.data,margin,y,contentWidth,fontMain);
  else drawProblemGraph(ctx,visual.data,margin,y,contentWidth,260,fontMain);
  y+=visualHeights[index]+6;
 });

 // Choices
 y += 16;
 ctx.font = `15px ${fontMain}`;
 if(r.choiceTable){
  y+=drawProblemTable(ctx,r.choiceTable,margin,y,contentWidth,fontMain)+24;
 }else if(isFiveAcross){
  const slot=contentWidth/5;
  for(let i=0;i<choices.length;i++){
   const text=`${choiceIcons[i]}  ${choices[i]}`,textW=ctx.measureText(text).width,curX=margin+i*slot+(slot-textW)/2;
   ctx.fillStyle='#087f70';ctx.font=`bold 16px ${fontMain}`;ctx.textAlign='left';ctx.fillText(choiceIcons[i],curX,y);
   ctx.fillStyle='#1e293b';ctx.font=`15px ${fontMain}`;ctx.fillText(choices[i],curX+25,y);
  }
  y+=42;
 }else if (isTwoCol) {
  const col2X = margin + Math.floor(contentWidth / 2) + 15;
  const rows=Math.ceil(choices.length/2);
  for (let i = 0; i < choices.length; i++) {
   const isCol2=i>=rows;
   const row=isCol2?i-rows:i;
   const curX = isCol2 ? col2X : margin + 10;
   const curY = y + row * choiceLineHeight;

   ctx.fillStyle = '#087f70';
   ctx.font = `bold 16px ${fontMain}`;
   ctx.textAlign = 'left';
   ctx.textBaseline = 'alphabetic';
   ctx.fillText(choiceIcons[i], curX, curY);

   ctx.fillStyle = '#1e293b';
   ctx.font = `15px ${fontMain}`;
   ctx.fillText(choices[i], curX + 24, curY);
  }
  y += rows * choiceLineHeight;
 } else {
  for (let i = 0; i < choices.length; i++) {
   const curY = y + i * choiceLineHeight;
   ctx.fillStyle = '#087f70';
   ctx.font = `bold 16px ${fontMain}`;
   ctx.textAlign = 'left';
   ctx.textBaseline = 'alphabetic';
   ctx.fillText(choiceIcons[i], margin + 10, curY);

   ctx.fillStyle = '#1e293b';
   ctx.font = `15px ${fontMain}`;
   ctx.fillText(choices[i], margin + 34, curY);
  }
  y += choices.length * choiceLineHeight;
 }

 // Answer & Explanation (if enabled)
 if (includeAnswer) {
  y += 20;
  ctx.strokeStyle = '#94a3b8';
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(margin, y);
  ctx.lineTo(baseWidth - margin, y);
  ctx.stroke();
  ctx.setLineDash([]);

  y += 30;
  ctx.fillStyle = '#ecfdf5';
  roundRect(ctx, margin, y - 20, 260, 32, 6);
  ctx.fill();
  ctx.strokeStyle = '#059669';
  ctx.lineWidth = 1.2;
  ctx.stroke();

  ctx.fillStyle = '#047857';
  ctx.font = `bold 14px ${fontMain}`;
  ctx.fillText('정답: ' + (r.answer || '미지정'), margin + 14, y + 2);

  y += 34;
  ctx.fillStyle = '#047857';
  ctx.font = `bold 14px ${fontMain}`;
  ctx.fillText('[해설 및 풀이]', margin, y);

  y += 22;
  ctx.font = `14px ${fontMain}`;
  ctx.fillStyle = '#334155';
  for (const line of explLines) {
   if (line.text) ctx.fillText(line.text, margin, y);
   y += 24;
  }

  if (steps.length > 0) {
   y += 8;
   for (let i = 0; i < steps.length; i++) {
    ctx.fillStyle = '#087f70';
    ctx.font = `bold 12px ${fontMain}`;
    ctx.fillText(`단계 ${i + 1}`, margin, y);

    ctx.fillStyle = '#475569';
    ctx.font = `13px ${fontMain}`;
    for (const line of stepLines[i]) {
     if (line.text) ctx.fillText(line.text, margin + 50, y);
     y += 24;
    }
    y += 8;
   }
  }
 }

 // Footer
 y = totalHeight - 35;
 ctx.strokeStyle = '#f1f5f9';
 ctx.lineWidth = 1;
 ctx.beginPath();
 ctx.moveTo(margin, y - 15);
 ctx.lineTo(baseWidth - margin, y - 15);
 ctx.stroke();

 ctx.fillStyle = '#94a3b8';
 ctx.font = `11px ${fontMain}`;
 ctx.textAlign = 'left';
 ctx.fillText('EduMaster 문제 스튜디오 · AI 문항 출제 시스템', margin, y);

 const rightFoot = '교사 검수 전 초안 문항';
 const rfW = ctx.measureText(rightFoot).width;
 ctx.fillText(rightFoot, baseWidth - margin - rfW, y);

 // Convert to PNG and set to image element
 try {
  const dataUrl = canvas.toDataURL('image/png');
  const imgEl = $('problem-image');
  if (imgEl) imgEl.src = dataUrl;
  imageReady=true;
  if($('copy-image-footer'))$('copy-image-footer').disabled=$('download-image-footer').disabled=busy;
 } catch (e) {
  $('status').textContent='문제 이미지 변환 실패 · '+e.message;throw e;
 }
}

async function copyImageCard() {
 if(qualityChecking||qualityState(result?.quality)==='fail'){$('status').textContent=qualitySummary(result?.quality);return;}
 if(!imageReady){$('status').textContent='아직 올바른 문제 이미지가 없습니다. 문제를 다시 생성해 주세요.';return;}
 const canvas = $('problem-canvas');
 if (!canvas) return;
 try {
  canvas.toBlob(async blob => {
   if (!blob) throw new Error('이미지를 만들지 못했습니다.');
   await navigator.clipboard.write([
    new ClipboardItem({ 'image/png': blob })
   ]);
   $('status').textContent = '✅ 변형 문제 이미지를 클립보드에 복사했습니다! 한글(HWP)이나 Word, PPT에 바로 Ctrl+V 하세요.';
  }, 'image/png');
 } catch (err) {
  $('status').textContent = '클립보드 이미지 복사가 브라우저에 의해 제한되었습니다. [이미지 저장 (PNG)] 버튼을 클릭해 주세요.';
 }
}

function downloadImageCard() {
 if(qualityChecking||qualityState(result?.quality)==='fail'){$('status').textContent=qualitySummary(result?.quality);return;}
 if(!imageReady){$('status').textContent='아직 올바른 문제 이미지가 없습니다. 문제를 다시 생성해 주세요.';return;}
 const canvas = $('problem-canvas');
 if (!canvas) return;
 const link = document.createElement('a');
 const title = (result && result.title ? result.title.replace(/[\\/:*?"<>|]/g, '_') : '화학_변형문제');
 link.download = `EduMaster_${title}.png`;
 link.href = canvas.toDataURL('image/png');
 link.click();
 $('status').textContent = '✅ 변형 문제 이미지를 다운로드했습니다 (' + link.download + ').';
}

if ($('copy-image')) $('copy-image').onclick = copyImageCard;
if ($('copy-image-footer')) $('copy-image-footer').onclick = copyImageCard;
if ($('download-image')) $('download-image').onclick = downloadImageCard;
if ($('download-image-footer')) $('download-image-footer').onclick = downloadImageCard;
if ($('toggle-image-answer')) {
 $('toggle-image-answer').onchange = async() => {
  if (!result||busy||qualityChecking) return;
  renderProblemToImage(result, $('toggle-image-answer').checked);await checkRenderedResult();
 };
}



try{
 const saved=JSON.parse(sessionStorage.getItem('edumaster-workspace')||'null');
 if(saved){
  const legacy=!Object.prototype.hasOwnProperty.call(saved,'requiresImage');
  sourceId=legacy?null:(saved.sourceId||null);
  sourceExpiresAt=saved.sourceExpiresAt||null;
  $('material-kind').value=saved.materialKind==='problem-only'?'problem-only':'problem-solution-separate';updateInputFormat();
  $('provider').value=saved.provider==='gemma'?'gemma':saved.provider==='both'?'both':'deepseek';
  if(!$('provider').value)$('provider').value='deepseek';
  comparisonOutputs=saved.comparisonOutputs||[];
  if(saved.pendingJob&&['gemma','deepseek','both'].includes(saved.pendingJob.provider)&&(/^[a-f0-9]{32}$/.test(saved.pendingJob.id)||(/^[a-f0-9]{32}$/.test(saved.pendingJob.payload?.requestId)&&saved.pendingJob.payload.provider===saved.pendingJob.provider)))pendingJob=saved.pendingJob;
  requiresImage=legacy?!!saved.body:!!saved.requiresImage;
  if(legacy)saved.result=null;
  for(const id of ['title','body','answer','explanation'])$(id).value=saved[id]||'';writeLogicSteps(saved.logicSteps||saved.pendingJob?.payload?.logicSteps||[]);
  if(saved.result){try{show(saved.result);}catch(e){feedback('저장된 결과의 그림을 표시할 수 없습니다',e.message+' · 기준 입력을 유지했으니 다시 생성해 주세요.',true);$('status').textContent=e.message;}}
  if(comparisonOutputs.length>1)renderComparisons(comparisonOutputs);
  if(requiresImage)$('file-info').textContent='원본 이미지도 생성에 사용합니다 · 보관 2시간, 만료 시 파일 재선택';
 }
}catch{}

async function connect(){
 if(connecting)return;
 connecting=true;
 const button=$('connect');button.disabled=true;button.textContent='접속 확인 중…';
 if(access){$('auth-error').textContent='서버 연결과 비밀번호를 확인하고 있습니다. 최대 15초가 걸립니다.';$('connection').textContent='접속 확인 중';}
 try{
  setBusy(false);
  if(!access)throw new Error('비밀번호를 입력해 주세요.');
  const d=await loginStatus();
  authenticated=true;
  $('disconnect').hidden=false;$('disconnect').textContent='로그아웃';
  if($('remember-access').checked){localStorage.setItem('edumaster-access',access);}else{localStorage.removeItem('edumaster-access');}
  sessionStorage.setItem('edumaster-access',access);
  $('lock-screen').hidden=true;$('main-studio').hidden=false;
  $('access-code').value='';$('auth-error').textContent='';
  $('connection').textContent=d.ready?'● '+d.model+' 연결됨':'● 모델 연결 실패';
  setBusy(false);
  if(!result){
   const hasRestoredBody=!!String($('body').value||'').trim();
   if(pendingJob)feedback('진행 중이던 생성 결과가 있습니다','화면 상단의 ‘진행 결과 확인’을 누르면 새 요청 없이 기존 작업을 조회합니다.');
   else if(hasRestoredBody&&typeof hasValidLogic==='function'&&hasValidLogic())feedback('기준 문제와 풀이 로직이 준비됐습니다','화면 상단의 ‘쌍둥이 문제 만들기’를 누르면 생성이 시작됩니다.');
   else if(hasRestoredBody)feedback('기준 문제가 준비됐습니다','화면 상단의 ‘풀이 단계 만들기’를 눌러 실제 풀이 순서를 정리하세요.');
   else feedback('1단계: 문제 이미지를 넣어 주세요',d.ready?'문제와 풀이 이미지를 넣으면 본문과 실제 풀이 순서를 읽습니다.':'모델 서버에 연결하지 못했습니다.',!d.ready);
  }
 }catch(e){
  authenticated=false;$('main-studio').hidden=true;$('lock-screen').hidden=false;$('disconnect').hidden=true;
  $('connection').textContent='🔒 잠김 (인증 필요)';
  if(access)$('auth-error').textContent=e.message;else $('auth-error').textContent='';
  setBusy(false);
 }finally{
  connecting=false;button.disabled=false;button.textContent='스튜디오 입장하기';
 }
 if(authenticated){await restoreSourcePreview();if(result?.qualityJobId)await checkRenderedResult();}
}

$('auth-form').onsubmit=async e=>{
 e.preventDefault();if(connecting)return;const value=$('access-code').value.trim();
 const accessLink=/^https?:\/\//i.test(value)&&value.includes('#');
 access=accessLink?new URLSearchParams(value.split('#')[1]).get('access')||'':value;
 if(!access){$('auth-error').textContent='비밀번호를 입력해 주세요.';return;}
 await connect();
};

$('disconnect').onclick=()=>{
 if(busy)return;
 localStorage.removeItem('edumaster-access');sessionStorage.removeItem('edumaster-access');access='';authenticated=false;
 $('main-studio').hidden=true;$('lock-screen').hidden=false;$('disconnect').hidden=true;
 $('connection').textContent='🔒 잠김 (인증 필요)';$('access-code').value='';$('access-code').focus();setBusy(false);
};
$('retry-render-check').onclick=()=>checkRenderedResult();
$('retry-text-check').onclick=()=>recheckText();
connect();

async function restoreSourcePreview(){
 if(!requiresImage||!sourceId)return;const restoringId=sourceId;
 try{
  const d=await api('sources/'+restoringId+'?preview=true');if(sourceId!==restoringId)return;
  if(d.ready){
   sourceExpiresAt=d.expiresAt;
   if(d.previewDataUrls?.length){$('question-preview').src=d.previewDataUrls[0];$('question-preview').hidden=false;if(d.previewDataUrls.length>=2){$('solution-preview').src=d.previewDataUrls[1];$('solution-preview').hidden=false;}}
   else if(d.previewDataUrl){$('question-preview').src=d.previewDataUrl;$('question-preview').hidden=false;}
   $('file-info').textContent='원본 이미지 복구 완료 · '+d.pageCount+'페이지 · 2시간 보관';save();
  } else {
   $('file-info').textContent='원본 보관 만료 또는 이전 버전에서 유실 · 본문 유지 · 파일 재선택 필요';
   feedback('원본 파일을 한 번 다시 넣어 주세요','이전 버전에서 사라진 원본은 복구할 수 없습니다. 새로 넣은 파일은 서버 재시작 후에도 보관 시간 내 복구됩니다.',true);
  }
 }catch(e){$('file-info').textContent='원본 복구 연결 확인 필요 · '+e.message;}
}

updateInputFormat();if(!busy)$('generate').textContent=generationButtonText();globalThis.updateWorkflowState?.();

// Native modal keeps focus and Esc handling inside the viewer.
let imageViewerZoom=1,imageViewerSource=null;
function sizeImageViewer(){
 const image=$('image-viewer-image'),stage=$('image-viewer-stage');
 const width=Math.min(image.naturalWidth||imageViewerSource?.naturalWidth||stage.clientWidth,Math.max(1,stage.clientWidth-32));
 image.style.width=Math.round(width*imageViewerZoom)+'px';
 $('image-viewer-scale').textContent=Math.round(imageViewerZoom*100)+'%';
 $('image-viewer-out').disabled=imageViewerZoom<=0.5;$('image-viewer-in').disabled=imageViewerZoom>=4;
}

function openImageViewer(source){
 if(!source.getAttribute('src')||source.hidden)return;
 const dialog=$('image-viewer'),image=$('image-viewer-image');
 imageViewerSource=source;imageViewerZoom=1;
 image.alt=source.alt||'문제 이미지';$('image-viewer-title').textContent=image.alt;
 image.onload=sizeImageViewer;image.src=source.currentSrc||source.src;
 if(!dialog.open)dialog.showModal();
 document.body.classList.add('image-viewer-open');sizeImageViewer();
 $('image-viewer-stage').scrollTop=$('image-viewer-stage').scrollLeft=0;
}
function setupImageViewer(){
 const dialog=$('image-viewer');if(!dialog)return;
 const selector='#preview, #question-preview, #solution-preview, #problem-image, #result-figures img';
 document.addEventListener('click',event=>{const image=event.target.closest?.(selector);if(image)openImageViewer(image);});
 document.addEventListener('keydown',event=>{if(event.key!=='Enter'&&event.key!==' ')return;const image=event.target.closest?.(selector);if(image){event.preventDefault();openImageViewer(image);}});
 $('image-viewer-close').onclick=()=>dialog.close();
 dialog.addEventListener('click',event=>{if(event.target===dialog){const rect=dialog.getBoundingClientRect();if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)dialog.close();}});
 dialog.addEventListener('close',()=>{document.body.classList.remove('image-viewer-open');$('image-viewer-image').removeAttribute('src');imageViewerSource?.focus();imageViewerSource=null;});
 $('image-viewer-in').onclick=()=>{imageViewerZoom=Math.min(4,imageViewerZoom+0.5);sizeImageViewer();};
 $('image-viewer-out').onclick=()=>{imageViewerZoom=Math.max(0.5,imageViewerZoom-0.5);sizeImageViewer();};
 $('image-viewer-fit').onclick=()=>{imageViewerZoom=1;sizeImageViewer();$('image-viewer-stage').scrollTop=$('image-viewer-stage').scrollLeft=0;};
 window.addEventListener('resize',()=>{if(dialog.open)sizeImageViewer();});
}
setupImageViewer();

