const {test}=require('node:test'),assert=require('node:assert/strict');
const {JobRegistry,MechanicJob}=require('../server/jobs');
function setup(){let netId=44,time=0;const applied=[],remembered=[],session={},ctx={src:7,session};
 const job=new MechanicJob({inspect:()=>({netId,plate:'TEST'}),apply:async(c,q)=>{applied.push(q);return {ok:true};},remember:(c,t)=>remembered.push(t),now:()=>time});
 return {job,ctx,applied,remembered,setVehicle:id=>netId=id,advance:ms=>time+=ms};}
test('only the assigned job exposes its actions',async()=>{
 const registry=new JobRegistry(),s=setup();registry.register(s.job);assert.equal(registry.tools('mechanic').length,2);assert.deepEqual(registry.tools('journalist'),[]);await assert.rejects(()=>registry.execute('journalist','mechanic_quote',s.ctx,{service:'repair'}),/métier/);
});
test('mechanic quote has no side effects and requires explicit agreement',async()=>{
 const s=setup(),q=await s.job.execute('mechanic_quote',s.ctx,{service:'repair'});assert.equal(q.price,0);assert.equal(s.applied.length,0);await assert.rejects(()=>s.job.execute('mechanic_perform',s.ctx,{quoteId:q.quoteId,confirmed:false}),/Accord/);assert.equal(s.applied.length,0);
});
test('confirmed repair is applied once and remembered only after success',async()=>{
 const s=setup(),q=await s.job.execute('mechanic_quote',s.ctx,{service:'repair'});const result=await s.job.execute('mechanic_perform',s.ctx,{quoteId:q.quoteId,confirmed:true});assert.equal(result.completed,true);assert.equal(s.applied.length,1);assert.equal(s.remembered.length,1);await assert.rejects(()=>s.job.execute('mechanic_perform',s.ctx,{quoteId:q.quoteId,confirmed:true}),/Devis/);
});
test('quotes cannot be used by another player or session',async()=>{
 const s=setup(),q=await s.job.execute('mechanic_quote',s.ctx,{service:'repair'});await assert.rejects(()=>s.job.execute('mechanic_perform',{src:8,session:s.ctx.session},{quoteId:q.quoteId,confirmed:true}),/Devis/);await assert.rejects(()=>s.job.execute('mechanic_perform',{src:7,session:{}},{quoteId:q.quoteId,confirmed:true}),/Devis/);
});
test('expired quotes and changed vehicle cannot cause an intervention',async()=>{
 const s=setup(),q=await s.job.execute('mechanic_quote',s.ctx,{service:'repair'});s.setVehicle(45);await assert.rejects(()=>s.job.execute('mechanic_perform',s.ctx,{quoteId:q.quoteId,confirmed:true}),/véhicule/i);s.setVehicle(44);s.advance(60001);await assert.rejects(()=>s.job.execute('mechanic_perform',s.ctx,{quoteId:q.quoteId,confirmed:true}),/Devis/);assert.equal(s.applied.length,0);
});
test('paint uses validated RGB colours and rejects unsupported values',async()=>{
 const s=setup();await assert.rejects(()=>s.job.execute('mechanic_quote',s.ctx,{service:'repaint',colour:'invalid'}),/Couleur/);const q=await s.job.execute('mechanic_quote',s.ctx,{service:'repaint',colour:'red'});await s.job.execute('mechanic_perform',s.ctx,{quoteId:q.quoteId,confirmed:true});assert.deepEqual(s.applied[0].colour,[220,30,30]);
});
test('failed application never records a successful service',async()=>{
 const s=setup();s.job.apply=async()=>({ok:false,error:'Vehicle unavailable'});const q=await s.job.execute('mechanic_quote',s.ctx,{service:'repair'});const result=await s.job.execute('mechanic_perform',s.ctx,{quoteId:q.quoteId,confirmed:true});assert.equal(result.ok,false);assert.equal(s.remembered.length,0);
});
test('closing a session invalidates outstanding quotes',async()=>{
 const s=setup(),q=await s.job.execute('mechanic_quote',s.ctx,{service:'repair'});s.job.forget(s.ctx.session);await assert.rejects(()=>s.job.execute('mechanic_perform',s.ctx,{quoteId:q.quoteId,confirmed:true}),/Devis/);
});

test('multiple tool results resume voice once after the current response ends',()=>{
 const {ToolTurnCoordinator}=require('../server/jobs');let resumes=0;const t=new ToolTurnCoordinator(()=>resumes++);
 t.created();t.begin();t.begin();t.complete();t.done();assert.equal(resumes,0);t.complete();assert.equal(resumes,1);t.done();assert.equal(resumes,1);
 t.created();t.begin();t.complete();assert.equal(resumes,1);t.done();assert.equal(resumes,2);
});
