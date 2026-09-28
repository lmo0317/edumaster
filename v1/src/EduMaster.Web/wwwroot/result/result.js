'use strict';
const $=id=>document.getElementById(id),apiBase=new URL('../api/',document.currentScript.src);let access=sessionStorage.getItem('edumaster-access')||localStorage.getItem('edumaster-access')||'';
let allItems=[],activeFilter='all',variantsData=null;

async function request(path,options={}){const response=await fetch(new URL(path,apiBase),{...options,headers:{Authorization:'Bearer '+access,...options.headers}});if(response.status===401)throw Object.assign(new Error('비밀번호를 확인해 주세요.'),{unauthorized:true});if(!response.ok){let data={};try{data=await response.json();}catch{}throw new Error(data.error||'서버 응답을 확인하지 못했습니다.');}return response;}
function showLogin(message=''){$('login').hidden=false;$('archive').hidden=true;$('login-error').textContent=message;}
function formatSize(bytes){return bytes<1024*1024?Math.max(1,Math.round(bytes/1024))+' KB':(bytes/1024/1024).toFixed(1)+' MB';}

async function openPdf(item,download=false){
  const viewer=download?null:window.open('about:blank','_blank');
  try{
    $('archive-status').className='status';$('archive-status').textContent=(download?'다운로드':'PDF 열기')+' 준비 중…';
    const response=await request(`reports/${item.id}/file${download?'?download=true':''}`),blob=await response.blob(),url=URL.createObjectURL(blob);
    if(download){
      const a=document.createElement('a');a.href=url;a.download=item.title+'.pdf';a.click();
      setTimeout(()=>URL.revokeObjectURL(url),30000);
    }else if(viewer){
      viewer.location.href=url;setTimeout(()=>URL.revokeObjectURL(url),120000);
    }else{
      location.href=url;
    }
    $('archive-status').textContent=download?'다운로드를 시작했습니다.':'새 창에서 PDF를 열었습니다.';
  }catch(error){
    viewer?.close();$('archive-status').className='status error';$('archive-status').textContent=error.message;
  }
}

function reportGroupName(item){
 const title=(item.title||'').trim();
 const name=title.replace(/\s*·\s*\d+차 보고서(?:\s*\([^)]*\))?$/,'').replace(/\s*·\s*연습 \d+문제 \+ 쌍둥이 1문제$/,'').trim();
 return name&&name!=='화학 문제'?name:`report:${item.id}`;
}
function groupReports(items){
 const groups=new Map();
 for(const item of items){const name=reportGroupName(item),key=name.startsWith('report:')?name:name.normalize('NFKC');if(!groups.has(key))groups.set(key,{name:name.startsWith('report:')?item.title:name,items:[]});groups.get(key).items.push(item);}
 return [...groups.values()].sort((a,b)=>new Date(b.items[0].createdAt)-new Date(a.items[0].createdAt));
}
function reportLabel(item){return item.title.replace(/^.*?\s*·\s*(?=\d+차 보고서|연습 \d+문제)/,'').trim()||item.title;}

function detectModel(title){
  const t=(title||'').toLowerCase();
  if(t.includes('비교')||t.includes('종합'))return {key:'comparison',label:'3개 모델 비교',badgeClass:'badge-comparison'};
  if(t.includes('gemma'))return {key:'gemma',label:'Gemma 4 12B',badgeClass:'badge-gemma'};
  if(t.includes('deepseek'))return {key:'deepseek',label:'DeepSeek',badgeClass:'badge-deepseek'};
  if(t.includes('gpt'))return {key:'gpt',label:'GPT 시뮬레이션',badgeClass:'badge-gpt'};
  return {key:'default',label:'보고서',badgeClass:'badge-default'};
}

async function loadVariantsData(){
  if(variantsData)return variantsData;
  try{
    const res=await fetch('variants_data.json');
    if(res.ok)variantsData=await res.json();
  }catch{}
  return variantsData;
}

function openDetailModal(item){
  const modal=$('detail-modal');
  if(!modal)return;
  const modelInfo=detectModel(item.title);
  $('modal-model-badge').className=`item-badge ${modelInfo.badgeClass}`;
  $('modal-model-badge').textContent=modelInfo.label;
  $('modal-title').textContent=item.title;

  const data=variantsData?.[modelInfo.key];
  if(data){
    $('modal-problem-body').textContent=data.body||'';
    const choicesEl=$('modal-choices');
    choicesEl.replaceChildren();
    (data.choices||[]).forEach(c=>{
      const div=document.createElement('div');
      div.className='choice-item';
      div.textContent=c;
      choicesEl.appendChild(div);
    });
    $('modal-answer').textContent=data.answer||'';
    $('modal-explanation').textContent=data.explanation||'';
    $('modal-change-summary').textContent=data.changeSummary||'';
  }else{
    $('modal-problem-body').textContent='상세 데이터는 PDF 열기를 통해 전문을 확인하실 수 있습니다.';
    $('modal-choices').replaceChildren();
    $('modal-answer').textContent='-';
    $('modal-explanation').textContent='PDF 보기를 통해 확인해 주세요.';
    $('modal-change-summary').textContent='-';
  }

  const srcData=variantsData?.source;
  if(srcData){
    $('modal-source-problem').textContent=srcData.body||'';
    $('modal-source-explanation').textContent=(srcData.explanation||'')+'\n\n[풀이 단계]\n'+(srcData.steps||[]).map((s,i)=>`${i+1}. ${s}`).join('\n\n');
  }

  // Hook actions
  $('modal-open-pdf').onclick=()=>openPdf(item);
  $('modal-download-pdf').onclick=()=>openPdf(item,true);

  // Switch to problem tab by default
  switchModalTab('problem');
  modal.showModal();
}

function switchModalTab(tabKey){
  document.querySelectorAll('.modal-tab').forEach(t=>t.classList.toggle('active',t.dataset.tab===tabKey));
  document.querySelectorAll('.tab-pane').forEach(p=>p.classList.toggle('active',p.id===`tab-content-${tabKey}`));
}

function reportRow(item,showFullTitle=false){
  const row=document.createElement('article'),info=document.createElement('div'),head=document.createElement('div'),badge=document.createElement('span'),title=document.createElement('h3'),meta=document.createElement('div'),actions=document.createElement('div'),viewDetail=document.createElement('button'),viewPdf=document.createElement('button'),download=document.createElement('button');

  const modelInfo=detectModel(item.title);
  row.className='item';
  row.dataset.model=modelInfo.key;

  head.className='item-head';
  badge.className=`item-badge ${modelInfo.badgeClass}`;
  badge.textContent=modelInfo.label;
  title.textContent=showFullTitle?item.title:reportLabel(item);
  head.append(badge,title);

  meta.className='meta';
  meta.textContent=`${new Date(item.createdAt).toLocaleString('ko-KR')} · ${formatSize(item.size)}`;
  info.append(head,meta);

  actions.className='actions';
  if(modelInfo.key!=='comparison'){
    viewDetail.className='secondary';
    viewDetail.textContent='문제·해설 보기';
    viewDetail.onclick=()=>openDetailModal(item);
    actions.append(viewDetail);
  }
  viewPdf.className='primary';
  viewPdf.textContent='PDF 열기';
  download.textContent='다운로드';
  viewPdf.onclick=()=>openPdf(item);
  download.onclick=()=>openPdf(item,true);
  actions.append(viewPdf,download);

  row.append(info,actions);
  return row;
}

function render(items){
  const filtered=activeFilter==='all'?items:items.filter(item=>detectModel(item.title).key===activeFilter);
  const groups=groupReports(filtered);
  $('count').textContent=`보고서 ${filtered.length}개`;
  $('empty').hidden=filtered.length>0;

  $('list').replaceChildren(...groups.map(group=>{
    if(group.items.length===1)return reportRow(group.items[0],true);
    const section=document.createElement('details'),summary=document.createElement('summary'),heading=document.createElement('span'),count=document.createElement('span'),body=document.createElement('div');
    section.className='report-group';
    section.open=true;
    heading.className='group-title';
    heading.textContent=group.name;
    count.className='group-count';
    count.textContent=`보고서 ${group.items.length}개 · 접기/펼치기`;
    summary.append(heading,count);
    body.className='group-items';
    body.append(...group.items.map(i=>reportRow(i,true)));
    section.append(summary,body);
    return section;
  }));
}

async function load(persist=false){
  try{
    await loadVariantsData();
    const response=await request('reports');
    allItems=await response.json();
    if(persist)localStorage.setItem('edumaster-access',access);
    $('login').hidden=true;
    $('archive').hidden=false;
    $('archive-status').textContent='';
    render(allItems);
  }catch(e){
    if(e.unauthorized)showLogin(e.message);
    else showLogin('목록을 불러오지 못했습니다. '+e.message);
  }
}

// Event Listeners
if($('login-form'))$('login-form').onsubmit=async event=>{event.preventDefault();access=$('password').value;await load(true);};
if($('refresh'))$('refresh').onclick=()=>load();

// Filter buttons
document.querySelectorAll('.filter-btn').forEach(btn=>{
  btn.onclick=()=>{
    document.querySelectorAll('.filter-btn').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
    activeFilter=btn.dataset.filter;
    render(allItems);
  };
});

// Summary toggle
if($('toggle-summary')){
  $('toggle-summary').onclick=()=>{
    const body=$('summary-body');
    body.hidden=!body.hidden;
  };
}

// Modal tab switching & closing
document.querySelectorAll('.modal-tab').forEach(tab=>{
  tab.onclick=()=>switchModalTab(tab.dataset.tab);
});
if($('modal-close'))$('modal-close').onclick=()=>$('detail-modal').close();
if($('modal-dismiss'))$('modal-dismiss').onclick=()=>$('detail-modal').close();

load();
