const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const test=require('node:test');
const vm=require('node:vm');

const source=fs.readFileSync(path.join(__dirname,'../src/EduMaster.Web/wwwroot/math-render.js'),'utf8');
const context={window:{},Blob,URL,Image:class{}};
vm.runInNewContext(source,context);

test('decimal ratio is tokenized as one fraction without zero denominator',()=>{
  const parts=context.window.EduMath.tokens('음이온/양이온 = 0.30/0.35 < 1');
  const fractions=parts.filter(part=>part.tex).map(part=>part.tex);
  assert.deepEqual([...fractions],['\\frac{0.30}{0.35}']);
  assert.equal(parts.find(part=>part.tex)?.fallback,'0.30/0.35');
});

test('answer choice fraction retains its number and full value',()=>{
  const parts=context.window.EduMath.tokens('정답 ⑤ 5/3');
  assert.deepEqual([...parts.filter(part=>part.tex).map(part=>part.tex)],['\\frac{5}{3}']);
  assert.equal(parts[0].text,'정답 ⑤ ');
});
