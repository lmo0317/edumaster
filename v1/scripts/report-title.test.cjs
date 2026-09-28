const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const test=require('node:test');
const vm=require('node:vm');

const script=fs.readFileSync(path.join(__dirname,'../src/EduMaster.Web/wwwroot/app.js'),'utf8');
const implementation=script.match(/^function reportArchiveTitle\(source,inputTitle,count\)\{[\s\S]*?^\}/m)?.[0];
assert.ok(implementation);
const title=(source,inputTitle,count)=>vm.runInNewContext(`${implementation}\nreportArchiveTitle(source,inputTitle,count)`,{source,inputTitle,count});

test('placeholder filename becomes recognizable acid-base report title',()=>{
  assert.equal(title('19번 자료\n19. 다음은 H₂X(aq), Y(OH)₂(aq)를 혼합한다.','제목_없음 (1)',3),
    'H₂X·Y(OH)₂ 산·염기 혼합 · 연습 2문제 + 쌍둥이 1문제');
});

test('gas mixture and custom titles remain identifiable',()=>{
  assert.equal(title('18. 다음은 XY₂, YZ₄ 기체의 자료이다.','제목_없음',3),
    'XY₂·YZ₄ 기체 혼합·원자량 비 · 연습 2문제 + 쌍둥이 1문제');
  assert.equal(title('다음 문제를 푼다.','중화 반응 복습',2),
    '중화 반응 복습 · 연습 1문제 + 쌍둥이 1문제');
});
