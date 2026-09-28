const fs=require('node:fs'),vm=require('node:vm'),test=require('node:test'),assert=require('node:assert/strict');
const source=fs.readFileSync('src/EduMaster.Web/wwwroot/app.js','utf8');
test('job usage shows unknown and pending calls instead of pretending they cost zero',()=>{
 const c=vm.createContext({});vm.runInContext(source.slice(source.indexOf('function jobUsageText('),source.indexOf('function generationError(')),c);
 assert.equal(c.jobUsageText({calls:0,totalTokens:0}),'');
 const text=c.jobUsageText({calls:3,totalTokens:150,unknownUsageCalls:1,pendingCalls:1});
 assert.match(text,/요청 3회/);assert.match(text,/150토큰/);assert.match(text,/미확인 1회/);assert.match(text,/대기 1회/);
});
test('account HTTP error is not hidden by an earlier failed problem card',()=>{
 let visible;const c=vm.createContext({comparisonOutputs:[{state:'failed',stageNumber:2,stageCount:3}],jobId:'old-job',pendingJob:null,result:null,feedback:(_,text)=>visible=text,renderComparisons(){}});
 vm.runInContext(source.slice(source.indexOf('function generationError('),source.indexOf('async function submitGeneration(')),c);
 c.generationError({status:402,message:'DeepSeek 계정 잔액 부족'});assert.equal(visible,'DeepSeek 계정 잔액 부족');
 c.generationError({message:'검토 실패',usageText:'기록된 150토큰'});assert.match(visible,/문제 2\/3/);assert.match(visible,/150토큰/);
});
test('402 is surfaced with its status and is never automatically retried',async()=>{
 let calls=0;const c=vm.createContext({fetch:async()=>{calls++;return {status:402,ok:false,json:async()=>({error:'잔액 부족'})}},prefix:'https://example.test/',access:'test',AbortController,authenticated:true,busy:false,qualityChecking:false,localStorage:{removeItem(){}},sessionStorage:{removeItem(){}},setBusy(){},$:()=>({}),setTimeout:()=>1,clearTimeout(){}});
 vm.runInContext(source.slice(source.indexOf('async function api('),source.indexOf('function feedback(')),c);
 await assert.rejects(c.api('generate',{method:'POST',idempotent:true}),e=>e.status===402&&e.message==='잔액 부족');assert.equal(calls,1);
});
