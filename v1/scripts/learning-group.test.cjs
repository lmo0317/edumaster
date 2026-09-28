const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync('src/EduMaster.Web/wwwroot/learning/learning.js','utf8');
const script=source.slice(0,source.indexOf("$('login-form').onsubmit"));
const nodes=Object.fromEntries(['panel-problem','panel-guidance','tab-problem','tab-guidance','prompt-provider','prompt-mode'].map(id=>[id,{hidden:false,attributes:{},setAttribute(name,value){this.attributes[name]=value;}}]));
let replacedUrl='';
const context={window:{},document:{currentScript:{src:'https://example.test/edumaster/learning/sets.js'},getElementById:id=>nodes[id]},sessionStorage:{getItem:()=>null},localStorage:{getItem:()=>null},location:{search:'',href:'https://example.test/edumaster/learning/',pathname:'/edumaster/learning/'},history:{replaceState(_state,_title,url){replacedUrl=url;}},URL,URLSearchParams};
vm.runInNewContext(script,context);
const job='a'.repeat(32),pdf='b'.repeat(32);
const entry=(id,stageNumber,stageLabel,reportId=null)=>({id,jobId:reportId||job,reportId,stageNumber,stageLabel,title:'화학 반응량 · '+stageLabel,createdAt:'2026-09-27T06:00:00Z',feedbackCount:0,approvedCount:0});
const groups=context.groupProblems([
    entry('1',2,'STEP 1~2 연습 문제'),entry('2',3,'전체 로직 쌍둥이 문제'),
    {...entry('3',1,'STEP 1 연습 문제'),pdfReportId:pdf},entry('4',1,'STEP 1 연습 문제',pdf)
]);
assert.equal(groups.length,1);
const generated=groups[0];
assert.equal(generated.items.length,3);
assert.deepEqual(Array.from(generated.items,item=>item.stageNumber),[1,2,3]);
assert.equal(generated.title,'화학 반응량');
assert.equal(generated.key,'job:'+job);
context.showTab('guidance');
assert.equal(nodes['panel-problem'].hidden,true);
assert.equal(nodes['panel-guidance'].hidden,false);
assert.equal(nodes['tab-guidance'].attributes['aria-selected'],'true');
assert.match(replacedUrl,/tab=guidance/);
context.showTab('problem');
assert.equal(nodes['panel-problem'].hidden,false);
assert.equal(nodes['panel-guidance'].hidden,true);
assert.doesNotMatch(replacedUrl,/tab=guidance/);
console.log('학습 목록: 생성 작업만 한 세트로 묶고 PDF 기록은 표시하지 않음');
