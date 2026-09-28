'use strict';
function createVisualNode(tag,attrs={},label){const node=document.createElementNS('http://www.w3.org/2000/svg',tag);for(const [name,value] of Object.entries(attrs))node.setAttribute(name,String(value));if(label!==undefined)node.textContent=label;return node;}
function renderLearningVisuals(result,parent){
 const drawings=result.drawings||[],diagrams=result.diagrams||[],graph=result.graph;
 if(!drawings.length&&!diagrams.length&&!graph)return;
 const title=document.createElement('h3');title.textContent='문제 그림·자료';parent.append(title);
 for(const drawing of drawings){
  const width=Number(drawing.width)||1000,height=Number(drawing.height)||500;
  const card=document.createElement('section');card.className='visual-card';const heading=document.createElement('strong');heading.textContent=drawing.title||'그림';card.append(heading);
  const svg=createVisualNode('svg',{viewBox:`0 0 ${width} ${height}`,role:'img','aria-label':drawing.description||drawing.title||'문제 그림'});svg.classList.add('visual');
  for(const item of drawing.elements||[]){const p=item.coordinates||[];if(p.some(v=>!Number.isFinite(v)))continue;let node;
   switch(item.type){case 'line':case 'arrow':node=createVisualNode('line',{x1:p[0],y1:p[1],x2:p[2],y2:p[3]});break;
    case 'rect':node=createVisualNode('rect',{x:p[0],y:p[1],width:p[2],height:p[3]});break;
    case 'circle':node=createVisualNode('circle',{cx:p[0],cy:p[1],r:p[2]});break;
    case 'ellipse':node=createVisualNode('ellipse',{cx:p[0],cy:p[1],rx:p[2],ry:p[3]});break;
    case 'polyline':case 'polygon':node=createVisualNode(item.type,{points:p.reduce((a,v,i)=>a+(i%2?',':' ')+v,'').trim()});break;
    case 'beaker':{const [x,y,w,h]=p;node=createVisualNode('path',{d:`M ${x} ${y} L ${x+9} ${y+h-12} Q ${x+w/2} ${y+h+7} ${x+w-9} ${y+h-12} L ${x+w} ${y}`,fill:'none'});break;}
    case 'text':node=createVisualNode('text',{x:p[0],y:p[1],'font-size':item.fontSize||26},item.text||'');break;
    default:continue;}
   node.setAttribute('stroke','#203149');if(item.dashed)node.setAttribute('stroke-dasharray','10 7');if(item.type!=='text'&&item.type!=='beaker')node.setAttribute('fill',item.fill==='gray'?'#e5e7eb':'white');svg.append(node);
   if(item.type==='arrow'){const dx=p[2]-p[0],dy=p[3]-p[1],angle=Math.atan2(dy,dx),size=15;svg.append(createVisualNode('polygon',{points:`${p[2]},${p[3]} ${p[2]-size*Math.cos(angle-.4)},${p[3]-size*Math.sin(angle-.4)} ${p[2]-size*Math.cos(angle+.4)},${p[3]-size*Math.sin(angle+.4)}`,fill:'#203149'}));}
   if(item.text&&item.type!=='text')svg.append(createVisualNode('text',{x:p[0],y:p[1]-10,'font-size':item.fontSize||24},item.text));
  }
  card.append(svg);parent.append(card);
 }
 for(const diagram of diagrams){const card=document.createElement('section');card.className='visual-card';const heading=document.createElement('strong');heading.textContent=diagram.title||'전하 배치';card.append(heading);const svg=createVisualNode('svg',{viewBox:'0 0 600 150',role:'img','aria-label':diagram.title||'전하 배치'});svg.classList.add('visual');svg.append(createVisualNode('line',{x1:35,y1:70,x2:565,y2:70,stroke:'#203149'}));const charges=diagram.charges||[],values=charges.map(c=>Number(c.position)||0),min=Math.min(0,...values),span=Math.max(1,...values)-min+1;for(const charge of charges){const x=55+490*((Number(charge.position)||0)-min)/span;svg.append(createVisualNode('circle',{cx:x,cy:70,r:16,fill:'white',stroke:'#203149'}),createVisualNode('text',{x,y:43,'text-anchor':'middle'},charge.name||''),createVisualNode('text',{x,y:76,'text-anchor':'middle'},charge.sign==='unknown'?'':charge.sign||''),createVisualNode('text',{x,y:110,'text-anchor':'middle'},String(charge.position)+(diagram.unit||'')));if(charge.forceDirection==='+x'||charge.forceDirection==='-x')svg.append(createVisualNode('text',{x:x+(charge.forceDirection==='+x'?27:-27),y:76,'text-anchor':'middle'},charge.forceDirection==='+x'?'→':'←'));}card.append(svg);parent.append(card);}
 if(graph){const card=document.createElement('section');card.className='visual-card';const heading=document.createElement('strong');heading.textContent=graph.title||'그래프 자료';card.append(heading);const table=document.createElement('table');table.className='graph-table';const head=document.createElement('tr');for(const text of [graph.xLabel||'x',graph.yLabel||'y']){const th=document.createElement('th');th.textContent=text;head.append(th);}table.append(head);for(let i=0;i<Math.min(graph.xPoints?.length||0,graph.yPoints?.length||0);i++){const row=document.createElement('tr');for(const value of [graph.xPoints[i],graph.yPoints[i]]){const cell=document.createElement('td');cell.textContent=String(value);row.append(cell);}table.append(row);}card.append(table);parent.append(card);}
}
