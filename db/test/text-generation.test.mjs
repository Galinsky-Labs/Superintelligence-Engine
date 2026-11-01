import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {TextGenerationService} from '../../packages/text-generation/src/index.mjs';
import {BudgetLedger} from '../../packages/budget/src/index.mjs';
import {createStructuredGenerationService} from '../../packages/structured-generation/src/index.mjs';
const dbUrl=process.env.TEST_DATABASE_URL;
const rates={inputMicroPerToken:2,outputMicroPerToken:5,fixedMicros:10,inputTokenCeiling:100};
function provider(events){
 let calls=0;
 return {get calls(){return calls},async *stream(){calls++;for(const e of events)yield e}};
}
async function makeFixture(pool,label){
 const tenantId=(await pool.query('INSERT INTO tenants(name) VALUES($1) RETURNING id',[label])).rows[0].id;
 const identityId=(await pool.query("INSERT INTO identities(issuer,subject) VALUES('text',gen_random_uuid()::text) RETURNING id")).rows[0].id;
 await pool.query("INSERT INTO memberships(tenant_id,identity_id,role) VALUES($1,$2,'owner')",[tenantId,identityId]);
 const projectId=(await pool.query("INSERT INTO projects(tenant_id,owner_id,title,kind) VALUES($1,$2,'Text Test','research') RETURNING id",[tenantId,identityId])).rows[0].id;
 await pool.query('UPDATE budget_global SET hard_limit_micro=1000000000 WHERE singleton=1');
 await pool.query('INSERT INTO budget_accounts(tenant_id,funded_micro,hard_limit_micro) VALUES($1,100000,100000)',[tenantId]);
 const ledger=new BudgetLedger({pool});
 const reservation=await ledger.reserve({tenantId,idempotencyKey:'test-generation-'+label.replaceAll(' ','-'),maximumMicrounits:10000});
 return {context:{tenantId,session:{identityId}},tenantId,projectId,reservationId:reservation.id};
}
function args(x){return {...x,providerId:'openai-text',operation:'text.generate',prompt:'A short poem',region:'us',commercial:true,maxOutputTokens:32}};
test('generated text is a durable artifact; actual usage charges exactly once',{skip:!dbUrl},async()=>{
 const pool=new pg.Pool({connectionString:dbUrl,max:8});
 try{
  const fixture=await makeFixture(pool,'text-completed');
  const mock=provider([{type:'token',text:'The dawn '},{type:'token',text:'arrived.'},{type:'usage',inputUnits:12,outputUnits:3},{type:'complete',responseId:'resp_test_1',modelRevision:'version-abc'}]);
  const service=new TextGenerationService({pool,providers:mock,pricing:rates,dispatchEnabled:true});
  const chunks=[],input={...args(fixture),onToken:token=>chunks.push(token)};
  const result=await service.generate(input);
  assert.equal(result.state,'completed');assert.equal(result.settledMicrounits,'49');assert.deepEqual(chunks,['The dawn ','arrived.']);
  assert.equal((await service.generate(input)).replayed,true);assert.equal(mock.calls,1);
  const stored=(await pool.query('SELECT body,provenance FROM artifact_revisions WHERE artifact_id=$1',[result.artifactId])).rows;
  assert.equal(stored.length,1);assert.equal(stored[0].body,'The dawn arrived.');
  assert.equal(stored[0].provenance.responseId,'resp_test_1');
  assert.equal((await service.inspect({context:fixture.context,dispatchId:result.id})).state,'completed');
  const reservation=(await pool.query('SELECT status,charged_micro FROM budget_reservations WHERE id=$1',[fixture.reservationId])).rows[0];
  assert.equal(reservation.status,'settled');assert.equal(reservation.charged_micro,'49');
 }finally{await pool.end()}
});
test('missing completion requires reconciliation; replay never generates twice',{skip:!dbUrl},async()=>{
 const pool=new pg.Pool({connectionString:dbUrl,max:8});
 try{
  const fixture=await makeFixture(pool,'text-uncertain');
  const mock=provider([{type:'token',text:'Partial generated words'}]);
  const service=new TextGenerationService({pool,providers:mock,pricing:rates,dispatchEnabled:true});
  await assert.rejects(service.generate(args(fixture)),e=>e.code==='incomplete_provider_result');
  await assert.rejects(service.generate(args(fixture)),e=>e.code==='dispatch_uncertain');
  assert.equal(mock.calls,1);
  const state=(await pool.query('SELECT state FROM text_generation_dispatches WHERE reservation_id=$1',[fixture.reservationId])).rows[0].state;
  assert.equal(state,'needs_reconciliation');
  const budget=(await pool.query('SELECT status FROM budget_reservations WHERE id=$1',[fixture.reservationId])).rows[0];
  assert.equal(budget.status,'reserved');
 }finally{await pool.end()}
});
test('unauthorized user, disabled dispatch, and insufficient reservation never call provider',{skip:!dbUrl},async()=>{
 const pool=new pg.Pool({connectionString:dbUrl,max:8});
 try{
  const fixture=await makeFixture(pool,'text-prohibited');
  const mock=provider([{type:'token',text:'Never called'}]);
  const blocked=new TextGenerationService({pool,providers:mock,pricing:rates});
  await assert.rejects(blocked.generate(args(fixture)),e=>e.code==='dispatch_disabled');
  const service=new TextGenerationService({pool,providers:mock,pricing:rates,dispatchEnabled:true});
  await assert.rejects(service.generate(args({...fixture,context:{tenantId:fixture.tenantId,session:{identityId:'00000000-0000-4000-8000-000000000111'}}})),e=>e.code==='project_forbidden');
  const second=await makeFixture(pool,'text-expensive');
  const expensive=new TextGenerationService({pool,providers:mock,pricing:{inputMicroPerToken:999999,outputMicroPerToken:1,fixedMicros:1,inputTokenCeiling:100},dispatchEnabled:true});
  await assert.rejects(expensive.generate(args(second)),e=>e.code==='reservation_insufficient');
  assert.equal(mock.calls,0);
 }finally{await pool.end()}
});
test('unknown or zero pricing cannot start a paid-capable generation service',()=>{
 const pool={query(){},connect(){}},providers={stream(){}};
 assert.throws(()=>new TextGenerationService({pool,providers}),/pricing/i);
 assert.throws(()=>new TextGenerationService({pool,providers,pricing:{inputMicroPerToken:0,outputMicroPerToken:0,fixedMicros:0,inputTokenCeiling:100}}),/pricing/i);
});

const structuredSchema={type:'object',properties:{answer:{type:'string',minLength:1}},required:['answer'],additionalProperties:false};
function structuredService(pool,mock,fixture){return createStructuredGenerationService({pool,providers:mock,
 pricing:{inputMicroPerToken:1,outputMicroPerToken:1,fixedMicros:1,inputTokenCeiling:6000},dispatchEnabled:true,
 schema:structuredSchema,principal:{tenantId:fixture.tenantId,identityId:fixture.context.session.identityId}})}
function structuredProvider(text){return provider([{type:'token',text},{type:'usage',inputUnits:100,outputUnits:20},
 {type:'complete',responseId:'structured-'+Math.random(),modelRevision:'fixture-model'}])}

test('validated structured output persists through real project/billing services exactly once',{skip:!dbUrl},async()=>{
 const pool=new pg.Pool({connectionString:dbUrl,max:8});
 try{
  const fixture=await makeFixture(pool,'structured-completed');
  const mock=structuredProvider(JSON.stringify({data:{answer:'Validated answer'},citations:[],toolCalls:[]}));
  const service=structuredService(pool,mock,fixture),chunks=[];
  const input={...args(fixture),maxOutputTokens:128,onToken:x=>chunks.push(x)};
  const result=await service.generate(input);
  assert.equal(result.state,'completed');assert.equal(result.settledMicrounits,'121');
  assert.deepEqual(chunks,[],'unvalidated partial output must not escape');
  assert.equal((await service.generate(input)).replayed,true);assert.equal(mock.calls,1);
  const stored=(await pool.query('SELECT media_type,body,provenance FROM artifact_revisions WHERE artifact_id=$1',[result.artifactId])).rows[0];
  assert.equal(stored.media_type,'application/json');assert.equal(stored.body.data.answer,'Validated answer');
  assert.equal(stored.body.toolCallsExecuted,false);assert.ok(stored.body.warnings.includes('no_citations'));
  assert.match(stored.provenance.structuredPolicySha256,/^[a-f0-9]{64}$/);
  const reservation=(await pool.query('SELECT status,charged_micro FROM budget_reservations WHERE id=$1',[fixture.reservationId])).rows[0];
  assert.equal(reservation.status,'settled');assert.equal(reservation.charged_micro,'121');
 }finally{await pool.end()}
});

test('malformed schema/citation/tool outputs create no artifact and cannot trigger automatic paid retries',{skip:!dbUrl},async()=>{
 const pool=new pg.Pool({connectionString:dbUrl,max:8});
 try{
  const outputs=['{"data":',JSON.stringify({data:{answer:42},citations:[],toolCalls:[]}),
   JSON.stringify({data:{answer:'Forgery'},citations:[{sourceId:'invented',quote:'Evidence'}],toolCalls:[]}),
   JSON.stringify({data:{answer:'Injection'},citations:[],toolCalls:[{connectionId:'evil',toolName:'transfer',argumentsJson:'{}'}]})];
  for(let i=0;i<outputs.length;i++){
   const fixture=await makeFixture(pool,'structured-rejected-'+i),mock=structuredProvider(outputs[i]);
   const service=structuredService(pool,mock,fixture),chunks=[];
   const input={...args(fixture),maxOutputTokens:128,onToken:x=>chunks.push(x)};
   await assert.rejects(service.generate(input),e=>e.code==='structured_output_rejected');
   assert.deepEqual(chunks,[]);
   assert.equal((await pool.query('SELECT count(*)::integer AS count FROM project_artifacts WHERE project_id=$1',[fixture.projectId])).rows[0].count,0);
   const dispatch=(await pool.query('SELECT state,failure_code FROM text_generation_dispatches WHERE reservation_id=$1',[fixture.reservationId])).rows[0];
   assert.equal(dispatch.state,'needs_reconciliation');assert.equal(dispatch.failure_code,'structured_output_rejected');
   await assert.rejects(service.generate(input),e=>e.code==='dispatch_uncertain');assert.equal(mock.calls,1);
   assert.equal((await pool.query('SELECT status FROM budget_reservations WHERE id=$1',[fixture.reservationId])).rows[0].status,'reserved');
  }
 }finally{await pool.end()}
});

test('structured policy identity binding rejects cross-tenant use before dispatch',{skip:!dbUrl},async()=>{
 const pool=new pg.Pool({connectionString:dbUrl,max:8});
 try{
  const fixture=await makeFixture(pool,'structured-principal'),mock=structuredProvider('{}');
  const service=structuredService(pool,mock,fixture);
  assert.throws(()=>service.generate({...args(fixture),context:{tenantId:fixture.projectId,session:fixture.context.session}}),e=>e.code==='structured_scope_denied');
  assert.equal(mock.calls,0);
  assert.equal((await pool.query('SELECT count(*)::integer AS count FROM text_generation_dispatches WHERE reservation_id=$1',[fixture.reservationId])).rows[0].count,0);
 }finally{await pool.end()}
});

