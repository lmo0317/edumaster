const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');

for(const alignment of ['center','right'])test(`fraction brackets and units do not overlap (${alignment})`,async()=>{
 const window={MathJax:{startup:{promise:Promise.resolve()},tex2svgPromise:async()=>({querySelector:()=>({setAttribute(){}})})}};
 const context={window,Blob,URL,Map,Set,Promise,Image:class{naturalWidth=1;naturalHeight=1;async decode(){}},XMLSerializer:class{serializeToString(){return '<svg/>';}}};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/EduMaster.Web/wwwroot/math-render.js'),'utf8'),context);
 await window.EduMath.preloadProblem({body:'(91/4)w'});
 const ink=[];
 const ctx={font:'16px sans-serif',textAlign:alignment,textBaseline:'middle',measureText:text=>({width:text.length*8}),drawImage:(image,x,y,width)=>ink.push([x,x+width])};
 const original=(text,x)=>{const width=ctx.measureText(text).width;const left=ctx.textAlign==='center'?x-width/2:ctx.textAlign==='right'?x-width:x;ink.push([left,left+width]);};
 window.EduMath.drawCanvasText(ctx,original,'(91/4)w',100,50);
 assert.equal(ink.length,3);
 for(let i=1;i<ink.length;i++)assert.ok(ink[i][0]>=ink[i-1][1]-1e-6,'bracket or unit overlaps the fraction');
 if(alignment==='center')assert.ok(Math.abs((ink[0][0]+ink.at(-1)[1])/2-100)<1e-6);
 else assert.ok(Math.abs(ink.at(-1)[1]-100)<1e-6);
 assert.equal(ctx.textAlign,alignment);
});
