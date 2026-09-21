const fs=require('node:fs'),vm=require('node:vm'),test=require('node:test'),assert=require('node:assert/strict');
const source=fs.readFileSync('src/EduMaster.Web/wwwroot/app.js','utf8');
const apiSource=source.slice(source.indexOf('async function api('),source.indexOf('function feedback('));
const selectedUploadsSource=source.slice(source.indexOf('function selectedUploads(){'),source.indexOf('function generationButtonText(){'));
function context(fetch){
 const nodes=new Map();const storage={removeItem(){}};
 const c=vm.createContext({fetch,prefix:'https://example.test/edumaster/',access:'test-only',AbortController,authenticated:true,busy:false,qualityChecking:false,checkRenderedResult:async()=>{},qualitySummary:()=>'',localStorage:storage,sessionStorage:storage,setBusy(){},$:id=>{if(!nodes.has(id))nodes.set(id,{});return nodes.get(id)},setInterval:()=>2,clearInterval(){},setTimeout:(fn,ms)=>{if(ms<5000)queueMicrotask(fn);return 1},clearTimeout(){}});
 vm.runInContext(apiSource,c);return c;
}
const response=(data,status=200)=>({status,ok:status<400,json:async()=>data});
test('API base stays in script directory even without trailing page slash',()=>{
 const init=source.match(/const prefix=([^;]+);/)[1];const c=vm.createContext({URL,document:{currentScript:{src:'https://example.test/edumaster/app.js?v=9'}},location:{href:'https://example.test/edumaster'}});
 assert.equal(vm.runInContext(init,c),'https://example.test/edumaster/');
});
test('image result and preview reads have enough time to receive the full response',async()=>{
 const timers=[];const c=context(async()=>response({state:'ready'}));c.setTimeout=(fn,ms)=>{timers.push(ms);return 1};
 await c.api('jobs/job-1');await c.api('sources/source-1?preview=true');await c.api('status');
 assert.deepEqual(timers,[30000,30000,15000]);
});
test('GET recovers from Failed to fetch without losing job',async()=>{
 let count=0;const c=context(async url=>{assert.ok(url.endsWith('jobs/job-1'));if(++count<3)throw new TypeError('Failed to fetch');return response({state:'ready'})});
 assert.equal((await c.api('jobs/job-1')).state,'ready');assert.equal(count,3);
});

test('login connection failure stops after one request and explains that password was not checked',async()=>{
 let calls=0;const c=context(async()=>{calls++;throw new TypeError('Failed to fetch')});
 await assert.rejects(c.api('status'),e=>e.networkFailure===true&&e.message.includes('비밀번호를 확인하지 못했습니다'));
 assert.equal(calls,1);assert.equal(c.authenticated,true);
});

test('login gateway outage does not report a wrong password or keep retrying',async()=>{
 let calls=0;const c=context(async()=>{calls++;return response({error:'temporary'},503)});
 await assert.rejects(c.api('status'),e=>e.networkFailure===true&&!e.message.includes('비밀번호가 올바르지'));
 assert.equal(calls,1);assert.equal(c.authenticated,true);
});

test('login hard deadline returns even if fetch ignores abort and never resolves',async()=>{
 let deadline;const c=context(async()=>new Promise(()=>{}));
 c.setTimeout=(fn,ms)=>{if(ms===15000)deadline=fn;return 1};
 const task=c.loginStatus();deadline();
 await assert.rejects(task,e=>e.networkFailure===true&&e.message.includes('15초 안에'));
});

test('late login rejection after deadline cannot clear a newer authenticated session',async()=>{
 let deadline,release;const c=context(async()=>new Promise(resolve=>{release=resolve}));
 c.setTimeout=(fn,ms)=>{if(ms===15000)deadline=fn;return 1};
 const task=c.loginStatus();deadline();await assert.rejects(task,/15초 안에/);
 release(response({error:'old request'},401));await new Promise(resolve=>setImmediate(resolve));
 assert.equal(c.authenticated,true);
});

function loginContext(api){
 const c=context(async()=>response({}));const storage={setItem(){},removeItem(){}};
 Object.assign(c,{api,connecting:false,authenticated:false,localStorage:storage,sessionStorage:storage,result:null,pendingJob:null,feedback(){},restoreSourcePreview:async()=>{}});
 vm.runInContext(source.slice(source.indexOf('async function connect(){'),source.indexOf("$('disconnect').onclick=")),c);
 return c;
}

test('login shows progress, prevents duplicate submits and restores button after network failure',async()=>{
 let release,calls=0;const c=loginContext(()=>{calls++;return new Promise((resolve,reject)=>{release=reject})});
 const first=c.connect();assert.equal(vm.runInContext("$('connect').disabled",c),true);
 assert.match(vm.runInContext("$('auth-error').textContent",c),/최대 15초/);
 await c.connect();assert.equal(calls,1);
 release(new Error('서버 연결 실패'));await first;
 assert.equal(c.authenticated,false);assert.equal(vm.runInContext("$('lock-screen').hidden",c),false);
 assert.equal(vm.runInContext("$('connect').disabled",c),false);assert.equal(c.access,'test-only');
});

test('successful login opens studio even when local generation model is not ready',async()=>{
 const c=loginContext(async()=>({ready:false,model:'Gemma'}));await c.connect();
 assert.equal(c.authenticated,true);assert.equal(vm.runInContext("$('main-studio').hidden",c),false);
 assert.equal(vm.runInContext("$('lock-screen').hidden",c),true);
});

test('ordinary password containing hash is preserved instead of parsed as an access link',async()=>{
 const c=loginContext(async()=>({ready:true,model:'Gemma'}));
 vm.runInContext("$('access-code').value='test#password'",c);
 await vm.runInContext("$('auth-form').onsubmit({preventDefault(){}})",c);
 assert.equal(c.access,'test#password');assert.equal(c.authenticated,true);
});
test('GET retries connection lost while reading response body',async()=>{
 let count=0;const c=context(async()=>++count===1?{status:200,ok:true,json:async()=>{throw new TypeError('Failed to fetch')}}:response({state:'ready'}));
 assert.equal((await c.api('jobs/job-1')).state,'ready');assert.equal(count,2);
});
test('upload POST is never silently replayed',async()=>{
 let count=0;const c=context(async()=>{count++;throw new TypeError('Failed to fetch')});
 await assert.rejects(c.api('import',{method:'POST'}),e=>e.networkFailure===true);assert.equal(count,1);
});
test('idempotent generation retry keeps exactly same request payload',async()=>{
 const payload='{"requestId":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","body":"test"}';let count=0;
 const c=context(async(url,options)=>{assert.equal(options.body,payload);if(++count===1)throw new TypeError('Failed to fetch');return response({id:'job-1'})});
 assert.equal((await c.api('generate',{method:'POST',idempotent:true,body:payload})).id,'job-1');assert.equal(count,2);
});
test('persistent disconnection is bounded and translated',async()=>{
 let count=0;const c=context(async()=>{count++;throw new TypeError('Failed to fetch')});
 await assert.rejects(c.api('jobs/job-1'),e=>e.networkFailure===true&&!e.message.includes('Failed to fetch'));assert.equal(count,5);
});
test('empty 404 job response is missing job, never a network retry',async()=>{
 let count=0;const c=context(async()=>{count++;return{status:404,ok:false,json:async()=>{throw new SyntaxError('Unexpected end of JSON input')}}});
 await assert.rejects(c.api('jobs/job-1'),e=>e.jobMissing===true&&!e.networkFailure);assert.equal(count,1);
});
test('non JSON gateway error uses HTTP retry and empty unauthorized error stays unauthorized',async()=>{
 let count=0;const c=context(async()=>++count===1?{status:503,ok:false,json:async()=>{throw new SyntaxError('Unexpected token <')}}:response({state:'ready'}));
 assert.equal((await c.api('jobs/job-1')).state,'ready');assert.equal(count,2);
 const unauthorized=context(async()=>({status:401,ok:false,json:async()=>{throw new SyntaxError('Empty response')}}));
 await assert.rejects(unauthorized.api('jobs/job-1'),e=>!e.networkFailure&&!e.jobMissing);
});
test('invalid success JSON is a response error, not a connection outage',async()=>{
 const c=context(async()=>({status:200,ok:true,json:async()=>{throw new SyntaxError('Bad JSON')}}));
 await assert.rejects(c.api('jobs/job-1'),e=>e.responseFormat===true&&!e.networkFailure);
});
test('temporary gateway failure retries but authentication rejection does not',async()=>{
 let count=0;const c=context(async()=>++count===1?response({error:'temporary'},503):response({state:'ready'}));
 assert.equal((await c.api('jobs/job-1')).state,'ready');assert.equal(count,2);
 count=0;const unauthorized=context(async()=>{count++;return response({error:'unauthorized'},401)});
 await assert.rejects(unauthorized.api('jobs/job-1'),/unauthorized/);assert.equal(count,1);
});
test('resume queries existing job without a new generation POST',async()=>{
 const c=context(async url=>{assert.ok(url.endsWith('jobs/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'));return response({state:'ready',result:{body:'variant'},outputs:[]})});
 Object.assign(c,{pendingJob:{id:'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',provider:'deepseek'},busy:false,jobId:null,result:null,feedback(){},renderComparisons(){},show(r){c.result=r},save(){}});
 vm.runInContext(source.slice(source.indexOf('async function waitForGeneration('),source.indexOf("$('generate').onclick=")),c);
 await vm.runInContext("$('resume-job').onclick()",c);
 assert.equal(c.result.body,'variant');assert.equal(c.pendingJob,null);
});
test('numbered image analysis retries a dropped response with the same upload',async()=>{
 let count=0;const body={requestId:'fixed-id'};const c=context(async(url,options)=>{
  assert.equal(options.body,body);
  if(++count===1)throw new TypeError('Failed to fetch');
  return response({sourceId:'saved-source'});
 });
 assert.equal((await c.api('import',{method:'POST',body,idempotent:true})).sourceId,'saved-source');
 assert.equal(count,2);
});
test('numbered image analysis retry is bounded and reports connection loss',async()=>{
 let count=0;const c=context(async()=>{count++;throw new TypeError('Failed to fetch')});
 await assert.rejects(c.api('import',{method:'POST',body:{},idempotent:true}),e=>e.networkFailure===true&&e.message.includes('이미지는 유지됩니다'));
 assert.equal(count,3);
});
test('completed stage series keeps every problem card and does not auto-run one global PNG check',async()=>{
 let renderChecks=0;const outputs=[1,2,3].map(n=>({stageNumber:n,stageCount:3,state:'ready',result:{id:'result-'+n,body:'variant '+n}}));
 const c=context(async()=>response({state:'ready',stageSeries:true,stageCount:3,result:outputs[2].result,outputs}));
 Object.assign(c,{pendingJob:{id:'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',provider:'deepseek'},busy:false,jobId:null,result:null,feedback(){},renderComparisons(value){c.rendered=value},show(r){c.result=r;c.$('output').hidden=false},checkRenderedResult:async()=>{renderChecks++},save(){}});
 vm.runInContext(source.slice(source.indexOf('async function waitForGeneration('),source.indexOf("$('generate').onclick=")),c);
 await vm.runInContext("$('resume-job').onclick()",c);
 assert.equal(c.rendered.length,3);assert.equal(renderChecks,0);assert.equal(c.$('output').hidden,true);assert.match(c.$('status').textContent,/각 문제 카드/);
});
test('completed job with a failed quality check is never announced as fully complete',async()=>{
 const outputs=[{stageNumber:1,stageCount:1,state:'ready',result:{id:'bad',body:'variant',quality:{checks:[{state:'fail',label:'수치·해설',evidence:'계산 누락'}]}}}];
 const c=context(async()=>response({state:'ready',stageSeries:true,stageCount:1,result:outputs[0].result,outputs}));
 Object.assign(c,{pendingJob:{id:'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',provider:'deepseek'},busy:false,jobId:null,result:null,feedback(title){c.feedbackTitle=title},renderComparisons(){},show(r){c.result=r},save(){}});
 vm.runInContext(source.slice(source.indexOf('async function waitForGeneration('),source.indexOf("$('generate').onclick=")),c);
 await vm.runInContext("$('resume-job').onclick()",c);
 assert.match(c.$('badge').textContent,/검사 오류/);
 assert.match(c.$('status').textContent,/사용하거나 PDF로 저장하지 마세요/);
 assert.equal(c.feedbackTitle,'생성 문항 검사 오류');
});
test('untouched per-stage PNG wait is hidden from the visible error summary',()=>{
 const c=vm.createContext({});
 vm.runInContext(source.slice(source.indexOf('function stageDisplayChecks('),source.indexOf('function qualityMethodLabel(')),c);
 const base=Array.from({length:11},(_,i)=>({id:'pass-'+i,state:'pass'}));
 const waiting={checks:[...base,{id:'render',state:'unknown',evidence:'브라우저 렌더링 후 로컬 이미지 검토 대기'}]};
 const failed={checks:[...base,{id:'render',state:'unknown',evidence:'이미지 검사 시간이 초과됐습니다.'}]};
 assert.equal(c.stageQualitySummary(waiting),'검사 통과 11');
 assert.equal(c.stageQualitySummary(failed),'추가 확인 1 · 통과 11');
 assert.match(source,/stageRenderQueue=stageRenderQueue\.then\(\(\)=>recheckStageResult\(o,'render',png\)\)/);
 assert.match(source,/브라우저 렌더링 후\|그림 라벨/);
});
test('full report keeps source material and orders every generated stage',()=>{
 const outputs=[3,1,2].map(n=>({stageNumber:n,state:'ready',result:{quality:{checks:[{state:'pass'}]},sourceProblem:n===3?'입력 문제':'',sourceAnswer:n===3?'입력 정답':'',sourceExplanation:n===3?'입력 해설':'',sourceSteps:n===3?['원본 단계 1']:[]}}));
 const fields={body:{value:'화면 문제'},answer:{value:'화면 정답'},explanation:{value:'화면 해설'}};
 const c=vm.createContext({comparisonOutputs:outputs,$:id=>fields[id],readLogicSteps:()=>['화면 단계'],qualityState:()=> 'pass',answerVerified:()=>true});
 vm.runInContext(source.slice(source.indexOf('function fullReportData('),source.indexOf('function buildFullReport(')),c);
 const report=c.fullReportData();assert.deepEqual(Array.from(report.ready,x=>x.stageNumber),[1,2,3]);assert.equal(report.sourceProblem,'화면 문제');assert.equal(report.sourceExplanation,'화면 해설');assert.deepEqual(Array.from(report.sourceSteps),['화면 단계']);
 c.comparisonOutputs[0].state='running';assert.throws(()=>c.fullReportData(),/모두 완성/);
});
test('full report includes role-specific original problem and solution images',()=>{
 assert.match(source,/appendReportSourceImage\(input,'원본 문제 이미지',questionImage,'업로드한 원본 문제 이미지'\)/);
 assert.match(source,/appendReportSourceImage\(input,'원본 해설 이미지',solutionImage,'업로드한 원본 해설 이미지'\)/);
 assert.match(source,/previewMaterialRoles/);assert.match(source,/waitForReportImages\(report\)/);
});
test('generated report always keeps the full explanation and numbered solution steps',()=>{
 assert.match(source,/appendReportSolution\(section,r\.answer,r\.explanation,r\.steps,true\)/);
 assert.match(source,/renderProblemText\(explanationBox,explanation\|\|'해설이 제공되지 않았습니다\.'/);
 assert.match(source,/appendReportHeading\(parent,4,'풀이 단계'\)/);
 assert.match(source,/for\(const step of steps\)/);
 assert.match(source,/Microsoft Print to PDF는 글자 검색이 되지 않을 수 있습니다/);
});
test('saved stage results refresh from their existing server job without creating a new job',async()=>{
 let path='';const latest=[{stageNumber:1,state:'ready',result:{id:'new',qualityJobId:'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'}}];
 const c=vm.createContext({comparisonOutputs:[{stageNumber:1,state:'ready',result:{id:'old',qualityJobId:'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'}}],result:null,api:async p=>{path=p;return{outputs:latest}},save(){},renderComparisons(v){c.rendered=v}});
 vm.runInContext(source.slice(source.indexOf('async function refreshSavedComparisonOutputs('),source.indexOf('function selectedModel(')),c);
 await c.refreshSavedComparisonOutputs();assert.equal(path,'jobs/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');assert.equal(c.rendered[0].result.id,'new');
});
test('failed resume preserves request and existing job for another attempt',async()=>{
 const c=context(async()=>{throw new TypeError('Failed to fetch')});
 Object.assign(c,{pendingJob:{id:'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',provider:'deepseek'},busy:false,jobId:null,result:null,comparisonOutputs:[],feedback(){},renderComparisons(){},save(){}});
 vm.runInContext(source.slice(source.indexOf('async function waitForGeneration('),source.indexOf("$('generate').onclick=")),c);
 await vm.runInContext("$('resume-job').onclick()",c);
 assert.equal(c.pendingJob.id,'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');assert.equal(c.jobId,null);
});
test('restored pending job does not disable primary button when signed in and idle',()=>{
 const c=context(async()=>response({}));
 Object.assign(c,{pendingJob:{id:'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',provider:'deepseek'},jobId:null,importController:null,result:null,imageReady:false,logicStepIds:['logic-step-1','logic-step-2','logic-step-3'],generationButtonText:()=>'',document:{querySelector:()=>null,querySelectorAll:()=>[]}});
 vm.runInContext(source.slice(source.indexOf('function setBusy('),source.indexOf('function save(')),c);
 vm.runInContext('setBusy(false)',c);assert.equal(vm.runInContext("$('generate').disabled",c),false);
 vm.runInContext('setBusy(true)',c);assert.equal(vm.runInContext("$('generate').disabled",c),true);
 c.authenticated=false;vm.runInContext('setBusy(false)',c);assert.equal(vm.runInContext("$('generate').disabled",c),true);
});
test('primary generation button resumes restored job without a duplicate POST',async()=>{
 let polls=0;const c=context(async url=>{assert.ok(url.endsWith('jobs/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'));polls++;return response({state:'ready',result:{body:'variant'},outputs:[]})});
 Object.assign(c,{pendingJob:{id:'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',provider:'deepseek'},busy:false,jobId:null,result:null,feedback(){},renderComparisons(){},show(r){c.result=r},save(){}});
 vm.runInContext(source.slice(source.indexOf('async function waitForGeneration('),source.indexOf("$('cancel').onclick=")),c);
 await vm.runInContext("$('generate').onclick()",c);
 assert.equal(polls,1);assert.equal(c.result.body,'variant');assert.equal(c.pendingJob,null);
});

test('elapsed time continues past 33 seconds while status response body stalls, then renders same job',async()=>{
 let count=0,release,entered,clock,cleared=false,now=100000;
 const stalled=new Promise(resolve=>entered=resolve);
 const c=context(async url=>{
  assert.ok(url.endsWith('jobs/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'));
  if(++count===1)return response({state:'running',phase:'그림 검증',elapsedSeconds:33,outputs:[]});
  return {status:200,ok:true,json:()=>new Promise(resolve=>{release=resolve;entered();})};
 });
 Object.assign(c,{Date:{now:()=>now},pendingJob:{id:'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',provider:'deepseek'},jobId:'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',renderComparisons(){},show(r){c.result=r},save(){},setInterval:fn=>{clock=fn;return 2},clearInterval:()=>{cleared=true}});
 vm.runInContext(source.slice(source.indexOf('async function waitForGeneration('),source.indexOf('function generationError(')),c);
 const task=c.waitForGeneration('deepseek');await stalled;now+=12000;clock();
 assert.match(vm.runInContext("$('elapsed').textContent",c),/^45초 경과.*서버 응답 대기.*마지막 확인 12초 전/);
 assert.match(vm.runInContext("$('status').textContent",c),/같은 작업 확인 중/);
 release({state:'ready',phase:'완료',elapsedSeconds:46,result:{body:'variant'},outputs:[]});await task;
 assert.equal(c.result.body,'variant');assert.equal(count,2);assert.equal(c.pendingJob,null);assert.equal(cleared,true);
});

test('overall deadline aborts a pending status fetch and keeps existing job for resume',async()=>{
 let deadline,entered,cleared=false;
 const pending=new Promise(resolve=>entered=resolve);
 const c=context(async (url,options)=>new Promise((resolve,reject)=>{options.signal.addEventListener('abort',()=>{const e=new Error('aborted');e.name='AbortError';reject(e)});entered();}));
 Object.assign(c,{pendingJob:{id:'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'},jobId:'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',save(){},clearInterval:()=>{cleared=true}});
 const previous=c.setTimeout;c.setTimeout=(fn,ms)=>{if(ms===750000)deadline=fn;return previous(fn,ms)};
 vm.runInContext(source.slice(source.indexOf('async function waitForGeneration('),source.indexOf('function generationError(')),c);
 const task=c.waitForGeneration('deepseek');await pending;deadline();
 await assert.rejects(task,/결과 확인 시간이 초과/);assert.equal(c.pendingJob.id,'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');assert.equal(cleared,true);
});


test('combined image import sends its input type and fills separate problem, answer and solution fields',async()=>{
 const nodes=new Map();const details={open:false};let sent;
 const c=vm.createContext({busy:false,authenticated:true,previewUrl:null,sourceId:null,requiresImage:false,sourceExpiresAt:null,result:null,jobId:null,importController:null,importTimedOut:false,comparisonOutputs:[],AbortController,crypto:require('node:crypto'),
  FormData:class{constructor(){this.values={}}append(k,v){this.values[k]=v}},URL:{createObjectURL:()=> 'blob:test',revokeObjectURL(){}},Date,
  document:{querySelector:()=>details},$:id=>{if(!nodes.has(id))nodes.set(id,{value:'',hidden:true,getAttribute:()=>null,replaceChildren(){},removeAttribute(){}});return nodes.get(id)},
  writeLogicSteps:steps=>steps.forEach((value,index)=>{const id='logic-step-'+(index+1);if(!nodes.has(id))nodes.set(id,{value:''});nodes.get(id).value=value}),
  selectedModel:()=>({provider:'deepseek'}),setMaterialMode(){},sourceReuseStatus(){},sourceTimeText(){return ''},setBusy(value){c.busy=value},feedback(){},save(){},setInterval:()=>1,clearInterval(){},setTimeout:()=>1,clearTimeout(){},
  api:async(path,options)=>{assert.equal(path,'import');sent=options.body.values;return {title:'원본',body:'문제 조건과 표',answer:'② 2/5',explanation:'가정과 모순으로 한계 반응물을 판단한다.',steps:['가정과 모순 확인','반응량 계산','답 검산'],readMethod:'로컬 문제·풀이 분리',fileName:'photo.jpg',needsReview:true,sourceId:'source',uncertainties:[]}}
 });
 vm.runInContext(source.slice(source.indexOf('function applyImportedMaterial('),source.indexOf("$('file').addEventListener")),c);
 vm.runInContext("$('material-kind').value='problem-solution'",c);
 await c.importFile({name:'photo.jpg',type:'image/jpeg',size:100});
 assert.equal(sent.materialKind,'problem-solution');assert.equal(sent.provider,'deepseek');
 assert.equal(nodes.get('body').value,'문제 조건과 표');assert.equal(nodes.get('answer').value,'② 2/5');assert.match(nodes.get('explanation').value,/모순/);
 assert.deepEqual(['logic-step-1','logic-step-2','logic-step-3'].map(id=>nodes.get(id).value),['가정과 모순 확인','반응량 계산','답 검산']);
 assert.equal(details.open,true);assert.equal(c.sourceId,'source');assert.equal(c.busy,false);
});
test('server-corrected step count is shown before starting generation',async()=>{
 const c=context(async url=>{assert.ok(url.endsWith('api/generate'));return response({planChanged:true,stageCount:3,logicSteps:['첫 판단','둘째 판단','셋째 판단'],explanation:'교정된 풀이',message:'이번에는 3문제를 만듭니다.'})});
 const original=c.$;c.$=id=>{const node=original(id);node.scrollIntoView??=()=>{};return node;};
 Object.assign(c,{pendingJob:{id:null},generationStarted:true,jobId:null,writeLogicSteps(steps){c.displayedSteps=steps},document:{querySelector:()=>({open:false})},feedback(title,message){c.feedbackText=title+' '+message},save(){}});
 vm.runInContext(source.slice(source.indexOf('async function submitGeneration('),source.indexOf('async function resumeGeneration(')),c);
 assert.equal(await c.submitGeneration({expectedStageCount:6}),false);
 assert.equal(c.pendingJob,null);assert.equal(c.generationStarted,false);
 assert.deepEqual(Array.from(c.displayedSteps),['첫 판단','둘째 판단','셋째 판단']);
 assert.match(c.$('status').textContent,/생성 예정 3문제/);
 assert.match(c.feedbackText,/3문제/);
});
test('selected upload remains available after the browser clears its native file input',()=>{
 const problem={name:'problem.jpg'},solution={name:'solution.jpg'};
 const inputs={'question-file':{files:[problem]},'solution-file':{files:[solution]}};
 const c=vm.createContext({inputs,selectedQuestionFile:null,selectedSolutionFile:null,$:id=>inputs[id]});
 vm.runInContext(selectedUploadsSource+';globalThis.readSelectedUploads=selectedUploads;',c);
 assert.equal(c.readSelectedUploads().question.name,'problem.jpg');
 inputs['question-file'].files=[];inputs['solution-file'].files=[];
 assert.equal(c.readSelectedUploads().question.name,'problem.jpg');
 assert.equal(c.readSelectedUploads().solution.name,'solution.jpg');
});

test('separate question and solution images are sent with fixed roles and fill one logic card',async()=>{
 const nodes=new Map();const details={open:false};let sent;
 const c=vm.createContext({busy:false,authenticated:true,sourceId:null,requiresImage:false,sourceExpiresAt:null,result:null,jobId:null,importController:null,importTimedOut:false,comparisonOutputs:[],AbortController,crypto:require('node:crypto'),Date,
  FormData:class{constructor(){this.values={}}append(k,v){this.values[k]=v}},document:{querySelector:()=>details},$:id=>{if(!nodes.has(id))nodes.set(id,{value:'',hidden:true,getAttribute:()=>null,replaceChildren(){}});return nodes.get(id)},
  writeLogicSteps:steps=>steps.forEach((value,index)=>{const id='logic-step-'+(index+1);if(!nodes.has(id))nodes.set(id,{value:''});nodes.get(id).value=value}),
  selectedModel:()=>({provider:'gemma'}),setMaterialMode(){},sourceReuseStatus(){},sourceTimeText(){return ''},setBusy(value){c.busy=value},feedback(){},save(){},setInterval:()=>1,clearInterval(){},setTimeout:()=>1,clearTimeout(){},
  api:async(path,options)=>{assert.equal(path,'import');sent=options.body.values;return {title:'문제 원본',body:'분리된 문제 본문',answer:'②',explanation:'분리된 해설',steps:['STEP 1','STEP 2','STEP 3','STEP 4'],readMethod:'문제·풀이 분리',fileName:'question.png + solution.png',needsReview:true,sourceId:'source-two',uncertainties:[]}}
 });
 vm.runInContext(source.slice(source.indexOf('function applyImportedMaterial('),source.indexOf("$('file').addEventListener")),c);
 const question={name:'question.png',size:100},solution={name:'solution.png',size:120};await c.importSeparateFiles(question,solution);
 assert.equal(sent.materialKind,'problem-solution-separate');assert.equal(sent.provider,'gemma');assert.equal(sent.questionFile,question);assert.equal(sent.solutionFile,solution);
 assert.equal(nodes.get('body').value,'분리된 문제 본문');assert.deepEqual(['logic-step-1','logic-step-2','logic-step-3','logic-step-4'].map(id=>nodes.get(id).value),['STEP 1','STEP 2','STEP 3','STEP 4']);
 assert.equal(c.sourceId,'source-two');assert.equal(c.busy,false);
});

test('problem image alone is imported without inventing a solution',async()=>{
 const nodes=new Map();const details={open:false};let sent,autoSolved=false;
 const c=vm.createContext({busy:false,authenticated:true,sourceId:null,requiresImage:false,sourceExpiresAt:null,result:null,jobId:null,importController:null,importTimedOut:false,comparisonOutputs:[],AbortController,crypto:require('node:crypto'),Date,
  FormData:class{constructor(){this.values={}}append(k,v){this.values[k]=v}},document:{querySelector:()=>details},$:id=>{if(!nodes.has(id))nodes.set(id,{value:'',hidden:true,getAttribute:()=>null,replaceChildren(){}});return nodes.get(id)},
  writeLogicSteps:steps=>['logic-step-1','logic-step-2','logic-step-3'].forEach((id,index)=>{if(!nodes.has(id))nodes.set(id,{value:''});nodes.get(id).value=steps[index]||''}),
  selectedModel:()=>({provider:'deepseek'}),setMaterialMode(){},sourceReuseStatus(){},sourceTimeText(){return ''},setBusy(value){c.busy=value},feedback(){},save(){},setInterval:()=>1,clearInterval(){},setTimeout:()=>1,clearTimeout(){},
  solveProblem:async auto=>{autoSolved=auto},
  api:async(path,options)=>{sent=options.body.values;return {title:'문제',body:'문제 본문',answer:'',explanation:'',steps:[],materialKind:'problem-only',readMethod:'문제 이미지 인식',fileName:'question.png',needsReview:true,sourceId:'source-only',uncertainties:[]}}
 });
 vm.runInContext(source.slice(source.indexOf('function applyImportedMaterial('),source.indexOf("$('file').addEventListener")),c);
 const question={name:'question.png',size:100};await c.importSeparateFiles(question,null);
 assert.equal(sent.materialKind,'problem-only');assert.equal(sent.questionFile,question);assert.equal(sent.solutionFile,undefined);
 assert.equal(nodes.get('body').value,'문제 본문');assert.equal(nodes.get('answer').value,'');assert.deepEqual(['logic-step-1','logic-step-2','logic-step-3'].map(id=>nodes.get(id).value),['','','']);
 assert.equal(c.sourceId,'source-only');assert.equal(c.busy,false);
 assert.equal(autoSolved,true);
});

test('input mode clearly supports problem-only auto solution and supplied solution',()=>{
 const html=fs.readFileSync('src/EduMaster.Web/wwwroot/index.html','utf8');
 const solver=fs.readFileSync('src/EduMaster.Core/ProblemSolver.cs','utf8');
 const css=fs.readFileSync('src/EduMaster.Web/wwwroot/style.css','utf8');
 assert.match(html,/문제만 넣기/);assert.match(html,/문제 \+ 해설 넣기/);
 assert.match(source,/if\(autoSolve\)await solveProblem\(true\)/);
 assert.match(solver,/STEP 1\./);
 assert.match(css,/input\[type="radio"\]\{appearance:auto;width:17px/);
 assert.match(html,/class="source-preview-card solution"/);
});

test('learning stages are capped at six and stale overlong jobs are not resumed',()=>{
 assert.match(source,/const MAX_LOGIC_STEPS=6/);
 assert.match(source,/consolidateLogicSteps/);
 assert.match(source,/if\(restoredSteps\.length>MAX_LOGIC_STEPS\).*saved\.pendingJob=null/);
 assert.match(source,/풀이 단계는 6개까지 입력할 수 있습니다/);
});

test('solution analysis retries one malformed or truncated model response',()=>{
 const server=fs.readFileSync('src/EduMaster.Web/Program.cs','utf8');
 assert.match(server,/catch\(InvalidDataException\)\{/);
 assert.match(server,/첫 응답 중단 후 자동 재시도/);
});

test('model selector keeps Gemma visible but disables it when the PC tunnel is offline',()=>{
 const html=fs.readFileSync('src/EduMaster.Web/wwwroot/index.html','utf8');
 assert.match(html,/Gemma 4 12B · 현재 PC가 켜져 있을 때만 사용 가능/);
 assert.match(source,/gemma\.disabled=!status\.gemmaAvailable/);
 assert.match(source,/if\(!status\.gemmaAvailable&&select\.value==='gemma'\)select\.value='deepseek'/);
});

test('refresh explicitly distinguishes reusable server image from an expired source',()=>{
 assert.match(source,/새로 이미지를 넣지 않아도 됩니다\. 현재 분석과 문제 생성에 이 원본을 그대로 사용합니다/);
 assert.match(source,/서버 보관 시간이 끝났습니다\. 그림·표를 포함해 생성하려면 원본 이미지를 다시 선택하세요/);
 assert.match(source,/sources\/'\+restoringId\+'\?preview=true/);
 assert.match(source,/sourceReuseStatus\('checking','이전 원본 확인 중'/);
});

test('image imports wait for the active reader instead of failing immediately',()=>{
 const server=fs.readFileSync('src/EduMaster.Web/Program.cs','utf8');
 assert.match(server,/await importGate\.WaitAsync\(token\);gateAcquired=true/);
 assert.match(server,/finally\{if\(gateAcquired\)importGate\.Release\(\);\}/);
 assert.doesNotMatch(server,/importGate\.WaitAsync\(0\)/);
 assert.match(source,/앞 작업이 있으면 끝난 뒤 자동 시작/);
});

test('saved report page is routed by the public gateway and uses authenticated report APIs',()=>{
 const gateway=fs.readFileSync('scripts/web-gateway.cjs','utf8');
 const resultPage=fs.readFileSync('src/EduMaster.Web/wwwroot/result/index.html','utf8');
 const resultScript=fs.readFileSync('src/EduMaster.Web/wwwroot/result/result.js','utf8');
 const server=fs.readFileSync('src/EduMaster.Web/Program.cs','utf8');
 assert.match(gateway,/result\/index\.html/);
 assert.match(gateway,/relative==='result'/);
 assert.match(resultPage,/저장된 PDF/);
 assert.match(resultScript,/request\('reports'\)/);
 assert.match(server,/MapPost\("\/api\/reports"/);
 assert.match(server,/MapGet\("\/api\/reports\/\{id\}\/file"/);
 assert.match(fs.readFileSync('scripts/update-web-runtime.ps1','utf8'),/must be a win-x64 self-contained publish/);
});
