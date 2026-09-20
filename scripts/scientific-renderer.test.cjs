const fs=require('node:fs'),vm=require('node:vm'),test=require('node:test'),assert=require('node:assert/strict');
const source=fs.readFileSync('src/EduMaster.Web/wwwroot/app.js','utf8');
const context=vm.createContext({});
vm.runInContext(source.slice(source.indexOf('function formatProblemMath('),source.indexOf('function synthesizeReactionGraph(')),context);
vm.runInContext(source.slice(source.indexOf('function synthesizeReactionGraph('),source.indexOf('function wrapTextLines(')),context);
vm.runInContext(source.slice(source.indexOf('function roundRect('),source.indexOf('function drawProblemTable(')),context);
vm.runInContext(source.slice(source.indexOf('function drawPointChargesDiagram('),source.indexOf('function renderProblemToImage(')),context);
vm.runInContext(source.slice(source.indexOf('function drawProblemGraph('),source.indexOf('function drawPointChargesDiagram(')),context);
test('whole application script parses',()=>assert.doesNotThrow(()=>new vm.Script(source)));

test('failed quality report blocks every export even after generation is no longer busy',()=>{
 const nodes=new Map();const c=vm.createContext({busy:false,qualityChecking:false,imageReady:true,result:{quality:{checks:[{state:'fail'}]}},$:id=>{if(!nodes.has(id))nodes.set(id,{});return nodes.get(id)}});
 vm.runInContext(source.slice(source.indexOf('function qualityState('),source.indexOf('async function checkRenderedResult(')),c);
 c.applyExportState();for(const id of ['copy-image','copy-image-footer','download-image','download-image-footer','copy','print'])assert.equal(nodes.get(id).disabled,true);
 c.result.quality.checks[0].state='unknown';c.applyExportState();assert.equal(nodes.get('download-image-footer').disabled,false);assert.match(c.qualitySummary(c.result.quality),/확인 불가/);
 c.qualityChecking=true;c.applyExportState();assert.equal(nodes.get('download-image-footer').disabled,true);
});
test('text recheck queries the existing result once and preserves failure on disconnect',async()=>{
 const nodes=new Map();let calls=0;
 const c=vm.createContext({busy:false,qualityChecking:false,imageReady:true,result:{id:'own-result',qualityJobId:'own-job',quality:{checks:[{id:'conditions',state:'fail'}]}},$:id=>{if(!nodes.has(id))nodes.set(id,{replaceChildren(){}});return nodes.get(id)},api:async(path,options)=>{calls++;assert.equal(path,'jobs/own-job/text-check');assert.equal(JSON.parse(options.body).resultId,'own-result');throw new Error('test disconnect')},setBusy(value){c.busy=value},renderQuality(){},save(){},setTimeout:()=>1,clearTimeout(){},setInterval:()=>2,clearInterval(){},AbortController,document:{createElement:()=>({append(){}})}});
 vm.runInContext(source.slice(source.indexOf('function qualityState('),source.indexOf('async function checkRenderedResult(')),c);
 // Keep this check focused on state and network behavior; the report rendering is tested separately.
 c.renderQuality=()=>{};await c.recheckText();
 assert.equal(calls,1);assert.equal(c.result.quality.checks[0].state,'fail');assert.equal(nodes.get('download-image').disabled,true);assert.match(nodes.get('status').textContent,/기존 검사 결과 유지/);assert.equal(c.busy,false);
});
test('skipped checks are displayed separately from unknown and actual errors',()=>{
 const nodes=new Map();const c=vm.createContext({busy:false,qualityChecking:false,imageReady:true,result:null,$:id=>{if(!nodes.has(id))nodes.set(id,{replaceChildren(...children){this.children=children}});return nodes.get(id)},document:{createElement:()=>({children:[],append(...children){this.children.push(...children)}})}});
 vm.runInContext(source.slice(source.indexOf('function qualityState('),source.indexOf('async function checkRenderedResult(')),c);
 c.renderQuality({checks:[{state:'fail',label:'질량 조건',evidence:'소비량 불일치',method:'code'},{state:'skipped',label:'문장',evidence:'선행 오류',method:'ai'}]});
 assert.match(nodes.get('quality-summary').textContent,/오류 1건/);assert.match(nodes.get('quality-checks').children[1].children[0].textContent,/검사 생략/);assert.doesNotMatch(nodes.get('quality-checks').children[1].children[0].textContent,/확인 불가/);
});
test('long table headers and cell values wrap inside columns and increase table height',()=>{
 const calls=[];const ctx=new Proxy({measureText:text=>({width:text.length*13.5}),fillText:(text,x,y)=>calls.push({text,x,y})},{get:(o,k)=>k in o?o[k]:(()=>{})});
 const c=vm.createContext({});vm.runInContext(source.slice(source.indexOf('function wrapTextLines('),source.indexOf('function drawProblemGraph(')),c);
 const table={headers:['실험','반응 후 남은 A 또는 B의 질량(g)','D의 양(mol)/전체 기체의 양(mol) (상댓값)'],rows:[['I','A (1000/3)w','x']]};
 const height=c.drawProblemTable(ctx,table,0,0,420,'Arial');assert.ok(height>64);
 const widths=c.problemTableColumnWidths(table,420),starts=widths.map((_,index)=>widths.slice(0,index).reduce((sum,value)=>sum+value,0));
 assert.ok(widths[0]<widths[1]&&widths[0]<widths[2],'short experiment column must be narrower than descriptive columns');
 for(const call of calls){const column=starts.findIndex((start,index)=>call.x>=start&&call.x<=start+widths[index]);assert.ok(column>=0);assert.ok(ctx.measureText(call.text).width<=widths[column]-18+.01,'cell text must fit its allocated column');assert.ok(call.y>=0&&call.y<=height);}
 assert.ok(calls.map(call=>call.text).join(' ').includes('1000/3'),'wrapped cell value must remain present');
});

const concentrationChoices=['d2/d1 ; 50/(25d1 - 2)','2d2/d1 ; 50/(25d2 - 2)','2d1/d2 ; 50/(25d1 - 2)','2d2/d1 ; 50/(25d1 - 2)','2d2/d1 ; 25/(25d1 - 2)'];
const concentrationTable='| 몰농도(M) | 몰랄 농도(m) |\n|---|---|\n'+concentrationChoices.map((c,i)=>'| '+['①','②','③','④','⑤'][i]+' '+c.split(' ; ').join(' | ')+' |').join('\n');
test('matching choice table appears once with both column headings and original correct answer',()=>{
 const r=context.prepareProblemDisplay({body:'[페이지 1]\n밀도는 d1과 d2이다.\n\n'+concentrationTable,choices:concentrationChoices,answer:'④ '+concentrationChoices[3],explanation:'V1 L에서 2V1 mol이다.',steps:[]});
 assert.equal(r.body,'밀도는 d₁과 d₂이다.');assert.equal(r.choiceTable.headers.join(','),'보기,몰농도(M),몰랄 농도(m)');
 assert.equal(r.choiceTable.rows[3].join(','),'④,2d₂/d₁,50/(25d₁ - 2)');assert.equal(r.answer,'④ 2d₂/d₁ ; 50/(25d₁ - 2)');
 const exported=context.problemExportText(r);assert.equal(exported.match(/몰농도\(M\)/g).length,1);assert.equal(exported.match(/\| ④ \|/g).length,1);
 assert.equal(JSON.stringify(context.prepareProblemDisplay(r)),JSON.stringify(r));
});
test('nonmatching table and 보기 statements are retained instead of silently removed',()=>{
 const body='<보기>\nㄱ. A는 양전하이다.\n\n'+concentrationTable.replace('50/(25d1 - 2)','999');
 const r=context.prepareProblemDisplay({body,choices:concentrationChoices,answer:'④',steps:[]});
 assert.equal(r.choiceTable,null);assert.ok(r.body.includes('999'));assert.ok(r.body.includes('ㄱ. A는 양전하이다.'));
});
test('separate data tables keep independent rows and ordinary absolute value text stays text',()=>{
 const parsed=context.parseProblemTable('| 실험 | 값 |\n|---|---|\n| I | 10 |\n\n중간 조건 |x|\n\n| 온도 | 시간 |\n|---|---|\n| 20 | 3 |');
 assert.equal(parsed.tables.length,2);assert.equal(parsed.tables[0].rows[0][1],'10');assert.equal(parsed.tables[1].rows[0][1],'3');assert.match(parsed.cleanText,/중간 조건 \|x\|/);
});
test('only explicit powers and known variable indices are typeset without changing arithmetic or chemical names',()=>{
 assert.equal(context.formatProblemMath('1000d1V1 - 80V1, x_2^2, 10^{-3}, NaOH, H2O, text1, d1word'),'1000d₁V₁ - 80V₁, x₂², 10⁻³, NaOH, H2O, text1, d1word');
});
test('untrusted table cells are assigned as text and never parsed as HTML',()=>{
 function node(tag){return{tag,children:[],append(...children){this.children.push(...children)}}}
 const c=vm.createContext({document:{createElement:node}});vm.runInContext(source.slice(source.indexOf('function formatProblemMath('),source.indexOf('function parseProblemTable(')),c);
 const table=c.createProblemTable({headers:['값','메모'],rows:[['<img src=x onerror=alert(1)>','d1']]});
 const cell=table.children[0].children[1].children[0].children[0];assert.equal(cell.textContent,'<img src=x onerror=alert(1)>');assert.equal(cell.children.length,0);
});
test('beaker has curved open walls, elliptical rim, and clipped liquid instead of a box',()=>{
 const calls=[];const ctx=new Proxy({quadraticCurveTo:(...p)=>calls.push(['curve',...p]),ellipse:(...p)=>calls.push(['ellipse',...p]),clip:()=>calls.push(['clip']),fillRect:(...p)=>calls.push(['liquid',...p])},{get:(o,k)=>k in o?o[k]:(()=>{})});
 context.drawBeaker(ctx,[100,150,180,230,.55],'gray');
 assert.equal(calls.filter(c=>c[0]==='clip').length,1);assert.ok(calls.filter(c=>c[0]==='curve').length>=3);assert.equal(calls.filter(c=>c[0]==='ellipse').length,2);assert.equal(calls.filter(c=>c[0]==='liquid').length,1);
 calls.length=0;context.drawBeaker(ctx,[100,150,180,230,0],'gray');assert.equal(calls.filter(c=>c[0]==='liquid').length,0);
});
test('ready result renders against current HTML without removed visual-context element',()=>{
 const html=fs.readFileSync('src/EduMaster.Web/wwwroot/index.html','utf8');
 const elements=new Map([...html.matchAll(/id="([^"]+)"/g)].map(m=>[m[1],{hidden:false,disabled:true,checked:false,textContent:'',replaceChildren(...children){this.children=children}}]));
 assert.equal(elements.has('visual-context'),false);
 let rendered=null,saved=false;
 const ui=vm.createContext({$:id=>elements.get(id)||null,result:null,busy:false,qualityChecking:false,imageReady:true,comparisonOutputs:[],document:{createElement:()=>({append(){}})},renderProblemToImage:r=>rendered=r,save:()=>saved=true});
 vm.runInContext(source.slice(source.indexOf('function formatProblemMath('),source.indexOf('function parseProblemTable(')),ui);
 vm.runInContext(source.slice(source.indexOf('function show('),source.indexOf('function clearResult(')),ui);
 const r={title:'점전하 변형',body:'B를 4d로 옮긴다.',choices:['ㄱ','ㄷ','ㄱ, ㄴ','ㄴ, ㄷ','ㄱ, ㄴ, ㄷ'],steps:['조건 확인','힘 관계 계산','보기 판단','원조건 검산'],answer:'④ ㄴ, ㄷ',visualContexts:[],figures:[]};
 assert.doesNotThrow(()=>ui.show(r));assert.equal(rendered.body,r.body);assert.equal(saved,true);assert.equal(elements.get('output').hidden,false);assert.equal(elements.get('result-body').children[0].textContent,r.body);assert.equal(elements.get('steps').children.length,4);assert.equal(elements.get('copy').disabled,false);
});
test('chemical name alone cannot create fabricated graph',()=>assert.equal(context.synthesizeReactionGraph({body:'탄산칼슘 10g을 분해할 때 CO₂ 몰수를 구하시오.'}),null));
test('all-negative real graph is still a graph',()=>{const graph={xPoints:[0,1],yPoints:[-1,-2]};assert.equal(context.synthesizeReactionGraph({graph}),graph)});
test('missing charge position fails instead of drawing default 4d',()=>assert.throws(()=>context.synthesizeReactionGraph({diagrams:[{charges:[{name:'A',position:0},{name:'B'}]}]})));
test('nonstandard positions and only specified force arrows are rendered',()=>{
 const calls=[];const ctx=new Proxy({fillText:(text,x,y)=>calls.push({text,x,y}),arc:(x,y)=>calls.push({arc:x,y})},{get:(obj,key)=>key in obj?obj[key]:(()=>{})});
 context.drawPointChargesDiagram(ctx,{panels:[{title:'(나)',unit:'d',charges:[{name:'A',position:-1,sign:'unknown',forceDirection:'none'},{name:'C',position:1.5,sign:'unknown',forceDirection:'none'},{name:'B',position:3,sign:'+',forceDirection:'-x'}]}]},0,0,600,140,'Arial');
 const a=calls.find(c=>c.text==='A'),b=calls.find(c=>c.text==='B'),c=calls.find(c=>c.text==='C');assert.ok(a.x<c.x&&c.x<b.x);assert.ok(calls.some(c=>c.text==='1.5d'));assert.ok(calls.some(c=>c.text==='3d'));assert.equal(calls.filter(c=>c.text==='+').length,1);
});
test('graph, charge panels, and general drawings all reach renderer together',()=>{
 const r={graph:{xPoints:[-1,1],yPoints:[-2,2]},diagrams:[{charges:[{position:0},{position:1}]}],drawings:[{width:1000,height:400,elements:[{type:'line',coordinates:[0,0,100,100]}]}]};
 assert.deepEqual(Array.from(context.collectProblemVisuals(r),v=>v.kind),['graph','charges','drawing']);
});
test('required visual missing from result does not silently create blank problem card',()=>assert.throws(()=>context.collectProblemVisuals({body:'그림의 회로에서 전류는?'}),/필수 그림/));
test('geometry coordinates, dashed line and arrow are drawn as supplied',()=>{
 const calls=[];const ctx=new Proxy({measureText:text=>({width:text.length*20}),fillText:text=>calls.push(['text',text]),lineTo:(...p)=>calls.push(['line',...p]),setLineDash:d=>calls.push(['dash',...d])},{get:(o,k)=>k in o?o[k]:(()=>{})});
 context.drawScientificDrawing(ctx,{title:'기하 도형',width:1000,height:600,elements:[{type:'polygon',coordinates:[100,100,100,500,700,500],text:''},{type:'arrow',coordinates:[200,200,400,300],dashed:true,text:''},{type:'text',coordinates:[400,550],text:'8',fontSize:26}]},0,0,712,'Arial');
 assert.ok(calls.some(c=>c[0]==='line'&&c[1]===700&&c[2]===500));assert.ok(calls.some(c=>c[0]==='line'&&c[1]===400&&c[2]===300));assert.ok(calls.some(c=>c[0]==='text'&&c[1]==='8'));assert.ok(calls.some(c=>c[0]==='dash'&&c[1]===10));
});
test('negative graph points stay inside plot instead of being clipped below zero',()=>{
 const points=[];const ctx=new Proxy({arc:(x,y)=>points.push([x,y])},{get:(o,k)=>k in o?o[k]:(()=>{})});
 context.drawProblemGraph(ctx,{xPoints:[-2,0,2],yPoints:[-4,-2,3]},0,0,700,260,'Arial');
 assert.equal(points.length,3);assert.ok(points.every(([x,y])=>x>=72&&x<=668&&y>=45&&y<=200));
});
