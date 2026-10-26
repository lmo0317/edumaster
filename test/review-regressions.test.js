'use strict';
// Regressions from the 2026-10-23 review. Isolated data, no external model calls.
process.env.EDUMASTER_MOCK_DELAY_MS = '5';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { createApp } = require('../server');
const { createUsers } = require('../server/users');
const { newId } = require('../server/store');
const pipeline = require('../server/pipeline');
const review = require('../server/final-review');
const sets = require('../server/set-check');
const { makeRule } = require('../server/learning');
const clone = x => JSON.parse(JSON.stringify(x));
const mat = () => ({ id: newId(), status: 'ready', title: 'Review fixture', subject: '수학', topic: '덧셈', createdAt: new Date().toISOString(), problem: { text: 'OLD SOURCE 1+1의 값은?', choices: ['1','2','3','4','5'], answer: 2 }, steps: [{ title: '덧셈하기', work: 'OLD WORK 1+1=2이다.' }], images: {} });
const item = (index=0) => ({ index, label: index ? '최종 문제' : 'STEP 1 연습', stage: index ? {kind:'twin'} : {kind:'upto',upto:1}, status:'passed', problem:{text:'OLD VARIANT 2+2의 값은?', choices:['1','2','3','4','5'],answer:4}, solution:{steps:[{step:1,title:'덧셈하기',work:'2+2=4이다.'}]}, attempts:[] });
const FULL = Object.fromEntries(review.ITEM_NAMES.map((n) => [n, 'ok']));
const good = label => ({label,verdict:'use',answerOk:true,markedAnswer:4,myAnswer:'4',checks:FULL,issues:[]});

test('large intermediate reciprocals reach final review without forcing a numerical redesign', async () => {
  const m = mat();
  const it = { ...item(), appliedRules: [], usesSteps: [1], verificationSpec: {
    program: ['p1 = 1/40', 'p2 = 1/92', 'ratio = (p1*3)/(p2*6)'],
    choices: [], checks: [{ expr: 'ratio == 23/20' }],
  } };
  const blind = { answer: 4, solution: '', issues: [], stepsUsed: [1], shortcuts: [], conditions: [], rules: [] };
  const ctx = { finalGate: true, job: { id: 'test', rules: [] }, budget: {}, effort: {}, log() {}, save() {} };
  const checked = await pipeline.verifyItem(ctx, it, m, [], 'integrated', [], { blind });
  assert.equal(checked.verification.code.status, 'pass');
  assert.ok(!checked.designNotes.some(n => /손계산/.test(n)));
  assert.match(checked.hints.join(), /1\/92/);
  let prompt = '';
  ctx.llm = { json: async a => { prompt = a.text; return { data: { items: [good(it.label)] } }; } };
  assert.deepEqual((await pipeline.finalGate(ctx, it, m, [], checked.hints)).faults, []);
  assert.match(prompt, /1\/92/);
  assert.match(prompt, /어려운 경우에만/);
  // Visible difficult numbers still require repair before the final review.
  it.problem.text += ' 1.732';
  const difficult = await pipeline.verifyItem(ctx, it, m, [], 'integrated', [], { blind });
  assert.ok(difficult.designNotes.some(n => /손계산.*1\.732/.test(n)));
});
async function fixture() {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'em-review-'));
  createUsers(dir).create({username:'reviewer',password:'review-test-only',role:'admin'});
  const app=createApp({dataDir:dir,llmMode:'mock'});
  await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${app.server.address().port}`;
  const login=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'reviewer',password:'review-test-only'})});
  const cookie=login.headers.get('set-cookie').split(';')[0];await login.json();
  const call=async(method,url,body)=>{const r=await fetch(base+url,{method,headers:{cookie,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,data:await r.json()};};
  return {app,dir,call,close:()=>new Promise(r=>app.server.close(()=>{fs.rmSync(dir,{recursive:true,force:true});r();}))};
}
async function waitJob(app,id) {for(let n=0;n<100;n++){const j=app.store.jobs.get(id);if(['done','failed','cancelled'].includes(j.status))return j;await new Promise(r=>setTimeout(r,10));}throw Error('timeout');}
function seed(s) {const m=mat();s.app.store.materials.put(m);const j={id:newId(),type:'generate',status:'done',title:m.title,materialId:m.id,material:clone(m),createdAt:m.createdAt,items:[item()],rules:[],options:{provider:'deepseek',mode:'integrated'}};s.app.store.jobs.put(j);return {m,j};}

test('malformed static URLs return 400 and the server still serves the next request',async()=>{
  const root=path.resolve(__dirname,'..');const dir=fs.mkdtempSync(path.join(os.tmpdir(),'em-uri-'));
  const code=`const assert=require('node:assert/strict');const {createApp}=require(${JSON.stringify(path.join(root,'server'))});const a=createApp({dataDir:${JSON.stringify(dir)},llmMode:'mock'});a.server.listen(0,'127.0.0.1',async()=>{try {const base='http://127.0.0.1:'+a.server.address().port;assert.equal((await fetch(base+'/%E0%A4%A')).status,400);assert.equal((await fetch(base+'/')).status,200);}catch(e){console.error(e);process.exitCode=1;}finally{a.server.close();}});`;
  const child=spawn(process.execPath,['-e',code],{cwd:root});let err='';child.stderr.on('data',d=>err+=d);child.stdout.resume();
  const timer=setTimeout(()=>child.kill(),5000);const [exit]=await once(child,'close');clearTimeout(timer);
  assert.equal(exit,0,err);fs.rmSync(dir,{recursive:true,force:true});
});
test('incomplete and internally contradictory reviews fail closed',()=>{
  assert.ok(review.itemFaults({items:[{verdict:'use'}]}).length);
  assert.ok(review.itemFaults({items:[{verdict:'use',answerOk:true,checks:{'정답':'fix'},issues:[]}]}).length);
  assert.ok(review.itemFaults({items:[{...good('x'),verdict:'reject',issues:[{severity:'low',rule:'표기',detail:'low'}]}]}).length);
  assert.ok(review.itemFaults({items:[{...good('x'),issues:'invalid'}]}).length);
  assert.deepEqual(review.itemFaults({items:[good('x')]}),[]);
});
test('changing the source STEP invalidates frames and analysis review',async()=>{
  const s=await fixture();try{const {m}=seed(s);m.frames=[{step:1,frames:['OLD WORK 1+1=2이다.']}];s.app.store.materials.put(m);
    const r=await s.call('PUT',`/api/materials/${m.id}`,{steps:[{title:'새 계산',work:'NEW WORK 3+3=6이다.'}]});
    assert.equal(r.status,200);assert.match(r.data.steps[0].work,/NEW/);assert.equal(r.data.frames,undefined);assert.equal(r.data.analysisReview,undefined);
  }finally{await s.close();}
});
test('reviewing an old set uses its generation source snapshot',async()=>{
  const s=await fixture();try{const {m,j}=seed(s);m.problem.text='NEW SOURCE 100+100의 값은?';s.app.store.materials.put(m);let prompt='';
    const record=await sets.reviewSet({store:s.app.store,set:j,images:[],providers:['fake'],call:async(p,a)=>{prompt=a.text;return {data:{analysis:{verdict:'ok',issues:[]},items:[good(j.items[0].label)]}};}});
    assert.match(prompt,/OLD SOURCE/);assert.match(j.material.problem.text,/OLD SOURCE/);assert.match(record.material.problem,/OLD SOURCE/);
  }finally{await s.close();}
});
test('reversed review items target the matching problem for remake',()=>{
  const record={set:{items:[{index:0,label:'STEP 1 연습'},{index:1,label:'최종 문제'}]},reviews:{'claude-cli':{review:{items:[{...good('최종 문제'),verdict:'fix',answerOk:false,issues:[{severity:'high',rule:'정답',detail:'최종 문제 정답 오류'}]},good('STEP 1 연습')]}}}};
  assert.equal(sets.failing(record)[0].index,1);assert.equal(sets.failing(record)[0].label,'최종 문제');
});
// bio-k61 (2026-10-23): the same final passed the set review in round 3 and was failed in round 4 by the same reviewer.
test('a settled problem (passed earlier, carried over unchanged) is not failed by a later round\'s verdict',()=>{
  const record={set:{items:[{index:0,label:'STEP 1 연습'},{index:1,label:'최종 문제'}]},checklist:{models:{'claude-cli':{score:94},'agy-cli':{score:100}}},
    reviews:{'claude-cli':{review:{analysis:{verdict:'ok',issues:[]},items:[{...good('최종 문제'),verdict:'fix',issues:[{severity:'mid',rule:'학습',detail:'숨긴 칸이 STEP 1에서 정해진다'}]},good('STEP 1 연습')]}},'agy-cli':{review:{analysis:{verdict:'ok',issues:[]},items:[good('최종 문제'),good('STEP 1 연습')]}}}};
  assert.equal(sets.failing(record).length,1);
  assert.deepEqual(sets.failing(record,new Set([1])),[]);
  assert.equal(sets.reaches(record,90),false);
  assert.equal(sets.reaches(record,90,new Set([1])),true);
  assert.equal(sets.reaches(record,95,new Set([1])),false,'the scores still count');
});

test('a review with wrong item identities is retried and both responses are retained', async () => {
  const s = await fixture();
  try {
    const { j } = seed(s); let calls = 0;
    const record = await sets.reviewSet({ store: s.app.store, set: j, providers: ['fake'], images: [], call: async (p, a) => {
      calls++;
      assert.ok(a.text.includes(JSON.stringify([{ index: 0, label: j.items[0].label }])));
      if (calls === 2) assert.match(a.text, /이전 응답의 문항 식별자/);
      return { data: { analysis: { verdict: 'ok', issues: [] }, items: [{ ...good(calls === 1 ? '잘못 붙인 제목' : j.items[0].label), index: 0 }] } };
    } });
    assert.equal(calls, 2);
    assert.equal(record.reviews.fake.responses.length, 2);
    assert.equal(record.reviews.fake.error, undefined);
    assert.deepEqual(sets.failing(record), []);
  } finally { await s.close(); }
});

test('persistently mismatched review identities are response errors, not false wrong answers', async () => {
  const s = await fixture();
  try {
    const { j } = seed(s); let calls = 0;
    const record = await sets.reviewSet({ store: s.app.store, set: j, providers: ['fake'], images: [], call: async () => {
      calls++;
      return { data: { analysis: { verdict: 'ok', issues: [] }, items: [good('다른 문항')] } };
    } });
    assert.equal(calls, 2);
    assert.match(record.reviews.fake.error, /정답 오류 판정이 아니/);
    assert.equal(record.reviews.fake.review, undefined);
    assert.equal(sets.reaches(record, 90), false);
  } finally { await s.close(); }
});
test('regeneration invalidates the previous cross-review',async()=>{
  const s=await fixture();const original=pipeline.produceItem;try{const {j}=seed(s);
    sets.writeCheck(s.dir,j.id,{done:true,at:'2020-01-01',set:{items:[{problem:'OLD VARIANT'}]},reviews:{}});
    pipeline.produceItem=async(ctx,{item})=>{item.problem.text='NEW VARIANT';item.status='passed';ctx.save();};
    const regen=s.app.jobs.regenerate(j,0,'change');assert.equal((await waitJob(s.app,regen.id)).status,'done');
    assert.equal(s.app.store.jobs.get(j.id).items[0].problem.text,'NEW VARIANT');assert.equal(sets.readCheck(s.dir,j.id).stale,true);const shown=await s.call('GET',`/api/jobs/${j.id}/check`);assert.deepEqual(shown.data.check.reviews,{});assert.equal(shown.data.check.checklist,null);
  }finally{pipeline.produceItem=original;await s.close();}
});
test('deleting a set is blocked while a child remake is running',async()=>{
  const s=await fixture();const original=pipeline.produceItem;let release;try{const {j}=seed(s);let started;
    const entered=new Promise(r=>started=r);const hold=new Promise(r=>release=r);
    pipeline.produceItem=async(ctx,{item})=>{started();await hold;item.status='passed';ctx.save();};
    const regen=s.app.jobs.regenerate(j,0,'change');await entered;
    assert.equal((await s.call('DELETE',`/api/jobs/${j.id}`)).status,409);assert.ok(s.app.store.jobs.get(j.id));
    release();await waitJob(s.app,regen.id);assert.ok(s.app.store.jobs.get(j.id));
  }finally{release?.();pipeline.produceItem=original;await s.close();}
});
test('a final gate without a job rule snapshot selects applicable rules',async()=>{
  const s=await fixture();try{const {m,j}=seed(s);const rule=makeRule({text:'UNIQUE_REQUIRED_RULE 새 지침입니다.',scope:'material',stage:'generation',source:{materialId:m.id}});s.app.store.rules.put(rule);let system='';
    await pipeline.finalGate({job:{id:newId(),materialId:m.id},store:s.app.store,budget:{},effort:{solve:'low'},log(){},save(){},llm:{json:async a=>{system=a.system;return {data:{items:[good('STEP 1 연습')]}};}}},j.items[0],m,[]);
    assert.equal(pipeline.pickRules(s.app.store,m).length,1);assert.ok(system.includes('UNIQUE_REQUIRED_RULE'));
  }finally{await s.close();}
});
test('failed analysis is reviewed and repaired again on a subsequent attempt',async()=>{
  const s=await fixture();try{const {m}=seed(s);const purposes=[];const ctx={job:{id:newId(),materialId:m.id,rules:[]},store:s.app.store,budget:{},effort:{solve:'low'},log(){},save(){},llm:{json:async a=>{purposes.push(a.purpose);return {data:a.purpose==='final-review'?{analysis:{verdict:'issues',issues:[{severity:'high',rule:'정답',detail:'원본 정답 오류'}]}}:{fixes:[]}};}}};
    await pipeline.reviewAnalysis(ctx,m);assert.deepEqual(purposes,['final-review','fix-analysis']);purposes.length=0;delete ctx.job.analysisReview;
    await pipeline.reviewAnalysis(ctx,m);assert.equal(ctx.job.analysisReview.verdict,'issues');assert.deepEqual(purposes,['final-review','fix-analysis']);
  }finally{await s.close();}
});
test('server restart clears running reviews and permits a fresh review',async()=>{
  const s=await fixture();try{const {m,j}=seed(s);const check={id:newId(),type:'check',status:'running',parentJobId:j.id,materialId:m.id,createdAt:m.createdAt,options:{provider:'deepseek'}};s.app.store.jobs.put(check);
    sets.writeCheck(s.dir,j.id,{done:false,running:true,jobId:check.id,reviews:{}});
    const restarted=createApp({dataDir:s.dir,llmMode:'mock'});
    assert.equal(restarted.store.jobs.get(check.id).status,'interrupted');assert.equal(sets.readCheck(s.dir,j.id).running,false);assert.equal(sets.readCheck(s.dir,j.id).interrupted,true);
    assert.throws(()=>restarted.jobs.resume(restarted.store.jobs.get(check.id)),/이어서 진행할 수 없는/);
  }finally{await s.close();}
});
test('teacher adoption survives progress saves while the rest of the set runs',async()=>{
  const s=await fixture();const original=pipeline.runGeneration;let release;try{const {m}=seed(s);let started;
    const entered=new Promise(r=>started=r);const hold=new Promise(r=>release=r);
    pipeline.runGeneration=async ctx=>{started();await hold;ctx.log('later progress');};
    const j=s.app.jobs.generate({material:m,items:[item()],rules:[],options:{provider:'deepseek',mode:'integrated'}});await entered;
    assert.equal((await s.call('PUT',`/api/jobs/${j.id}/items/0/review`,{adopted:true})).data.adopted,true);
    assert.equal(s.app.store.jobs.get(j.id).items[0].adopted,true);
    release();await waitJob(s.app,j.id);assert.equal(s.app.store.jobs.get(j.id).items[0].adopted,true);
  }finally{release?.();pipeline.runGeneration=original;await s.close();}
});
test('cross-subject lessons cannot be merged through candidates or the API',async()=>{
  const s=await fixture();try{
    const lm=require('../server/learning-map');
    const a=makeRule({text:'문제의 모든 조건을 풀이에서 사용한다.',scope:'global',subject:'화학'});
    const b=makeRule({text:'문제의 모든 조건을 풀이에서 사용한다.',scope:'global',subject:'생명과학'});
    s.app.store.rules.put(a);s.app.store.rules.put(b);assert.deepEqual(lm.mergePairs([a,b]),[]);
    const r=await s.call('POST','/api/learning/merge',{key:lm.pairKey(a,b),text:a.text});assert.equal(r.status,409);
    assert.equal(s.app.store.rules.all().length,2);
  }finally{await s.close();}
});

test('duplicate or mismatched item identities cannot pass a review', () => {
  const expected = [{ index: 0, label: '연습' }, { index: 1, label: '최종' }];
  for (const items of [[good('연습'), good('연습')], [{ ...good('최종'), index: 0 }], []]) {
    const normalized = sets.normalizeReview({ items }, expected);
    assert.ok(review.itemFaults({ items: [normalized.items[0]] }).length);
  }
  const normalized = sets.normalizeReview({ items: [{ ...good('최종'), index: 1 }, { ...good('연습'), index: 0 }] }, expected);
  assert.deepEqual(normalized.items.map(x => x.label), ['연습', '최종']);
});

test('malformed or contradictory analysis reviews never count as clean', () => {
  for (const a of [undefined, {}, { verdict: 'ok', issues: 'bad' }, { verdict: 'ok', checks: { 정답: 'fix' }, issues: [] }]) {
    assert.ok(review.analysisFaults(a).length);
  }
  assert.deepEqual(review.analysisFaults({ verdict: 'ok', issues: [] }), []);
});

test('unresolved source analysis stops generation before designing a problem', async () => {
  const s = await fixture();
  try {
    const { m, j } = seed(s), purposes = [];
    const ctx = { job: j, store: s.app.store, budget: {}, signal: new AbortController().signal, finalGate: true,
      effort: {}, save() {}, log() {}, llm: { json: async a => {
        purposes.push(a.purpose);
        return { data: a.purpose === 'final-review' ? { analysis: { verdict: 'issues', issues: [{ severity: 'high', rule: '정답', detail: '정답 오류' }] } } : { fixes: [] } };
      } } };
    await assert.rejects(pipeline.runGeneration(ctx), /원본 분석 검수를 통과하지 못/);
    assert.deepEqual(purposes, ['final-review', 'fix-analysis']);
    assert.equal(j.material.problem.text, m.problem.text);
  } finally { await s.close(); }
});

test('repairing an old snapshot cannot overwrite a teachers newer analysis or caches', async () => {
  const s = await fixture();
  try {
    const { m, j } = seed(s);
    m.steps[0].work = 'TEACHER NEW WORK'; m.frames = [{ step: 1, frames: ['TEACHER NEW WORK'] }];
    s.app.store.materials.put(m);
    const ctx = { job: { id: newId(), materialId: m.id }, store: s.app.store, budget: {}, effort: {}, log() {}, save() {},
      llm: { json: async () => ({ data: { fixes: [{ field: 'steps[0].work', wrong: 'OLD WORK', right: 'FIXED WORK' }] } }) } };
    await pipeline.fixAnalysis(ctx, j.material, [{ detail: 'fix the old work' }]);
    assert.match(j.material.steps[0].work, /FIXED WORK/);
    assert.equal(s.app.store.materials.get(m.id).steps[0].work, 'TEACHER NEW WORK');
    assert.equal(s.app.store.materials.get(m.id).frames[0].frames[0], 'TEACHER NEW WORK');
  } finally { await s.close(); }
});

test('legacy single-entry frames are validated against the current source', async () => {
  const s = await fixture();
  try {
    const { m } = seed(s); m.frames = [{ step: 1, frames: ['OUTDATED SENTENCE'] }];
    let calls = 0;
    await pipeline.ensureFrames({ job: { id: newId(), materialId: m.id }, store: s.app.store, budget: {}, log() {}, save() {},
      llm: { json: async () => { calls++; return { data: { steps: [] } }; } } }, m);
    assert.ok(calls > 0); assert.ok(!JSON.stringify(m.frames).includes('OUTDATED'));
    assert.equal(m.framesKey, require('../server/material-version').materialKey(m));
  } finally { await s.close(); }
});

test('review fingerprints detect a changed answer, solution or figure and handle legacy records', () => {
  const m = mat(), j = { id: newId(), material: m, items: [item()] };
  const rec = sets.checkRecord(m, j);
  assert.equal(sets.matchesSet(rec, j), true);
  for (const change of [x => x.items[0].problem.answer++, x => x.items[0].solution.steps[0].work = 'NEW', x => x.items[0].problem.figure = '<svg />']) {
    const newer = clone(j); change(newer); assert.equal(sets.matchesSet(rec, newer), false);
  }
  delete rec.contentKey;
  assert.equal(sets.matchesSet(rec, j), true);
  j.items[0].problem.text = 'NEW'; assert.equal(sets.matchesSet(rec, j), false);
});

test('cancelling a parallel review waits for every reviewer before final cleanup', async () => {
  const s = await fixture();
  try {
    const { j } = seed(s); let lateFinished = false;
    await assert.rejects(sets.reviewSet({ store: s.app.store, set: j, providers: ['cancelled', 'late'], images: [],
      call: async p => {
        if (p === 'cancelled') throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
        await new Promise(r => setTimeout(r, 30)); lateFinished = true;
        return { data: { analysis: { verdict: 'ok', issues: [] }, items: [good(j.items[0].label)] } };
      } }), { name: 'AbortError' });
    assert.equal(lateFinished, true);
  } finally { await s.close(); }
});

test('a remake passes its newly selected rules to the generation context', async () => {
  const s = await fixture(), original = pipeline.produceItem;
  try {
    const { m, j } = seed(s);
    const rule = makeRule({ text: 'NEW REMAKE RULE', scope: 'material', stage: 'generation', source: { materialId: m.id } });
    s.app.store.rules.put(rule);
    let seen;
    pipeline.produceItem = async (ctx, args) => { seen = [ctx.generationRules, args.rules]; args.item.status = 'passed'; };
    const regen = s.app.jobs.regenerate(j, 0, 'fix');
    assert.equal((await waitJob(s.app, regen.id)).status, 'done');
    assert.equal(seen[0][0].id, rule.id); assert.deepEqual(seen[0], seen[1]);
  } finally { pipeline.produceItem = original; await s.close(); }
});
