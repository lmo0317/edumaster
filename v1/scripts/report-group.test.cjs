const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const test=require('node:test');
const vm=require('node:vm');

const script=fs.readFileSync(path.join(__dirname,'../src/EduMaster.Web/wwwroot/result/result.js'),'utf8');
const source=script.match(/^function reportGroupName\(item\)\{[\s\S]*?^\}\nfunction groupReports\(items\)\{[\s\S]*?^\}/m)?.[0];
assert.ok(source);
const group=items=>vm.runInNewContext(`${source}\ngroupReports(items)`,{items});

test('versions of the same problem form one group without hiding report status',()=>{
 const items=[
  {id:'a',title:'H₂X·Y(OH)₂ 산·염기 혼합 · 2차 보고서 (PDF 수식 표기 오류)',createdAt:'2026-09-21T13:00:00Z'},
  {id:'b',title:'H₂X·Y(OH)₂ 산·염기 혼합 · 1차 보고서 (정답 오류)',createdAt:'2026-09-21T11:00:00Z'},
  {id:'c',title:'XY₂·YZ₄ 기체 혼합 · 1차 보고서',createdAt:'2026-09-21T10:00:00Z'}
 ];
 const groups=group(items);
 assert.equal(groups.length,2);
 assert.equal(groups[0].name,'H₂X·Y(OH)₂ 산·염기 혼합');
 assert.deepEqual(Array.from(groups[0].items,item=>item.id),['a','b']);
});

test('generic report titles remain separate',()=>{
 const groups=group([{id:'a',title:'화학 문제 · 연습 2문제 + 쌍둥이 1문제',createdAt:'2026-09-21'},
  {id:'b',title:'화학 문제 · 연습 2문제 + 쌍둥이 1문제',createdAt:'2026-09-20'}]);
 assert.equal(groups.length,2);
});
