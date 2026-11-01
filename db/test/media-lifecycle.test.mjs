import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac,randomUUID} from 'node:crypto';
import pg from 'pg';
import {BudgetLedger} from '../../packages/budget/src/index.mjs';
import {MediaLifecycle} from '../../packages/providers/src/media-lifecycle.mjs';
const url=process.env.TEST_DATABASE_URL;
test('signed callbacks settle a single durable result despite replays, reordered events and restart',{skip:!url},async()=>{
 const pool=new pg.Pool({connectionString:url,max:8});
 const secret='s'.repeat(40),timestamp=String(Math.floor(Date.now()/1000));
 const sign=body=>'sha256='+createHmac('sha256',secret).update(timestamp).update('.').update(body).digest('hex');
 try{
  const tenant=(await pool.query("INSERT INTO tenants(name) VALUES('Media lifecycle test') RETURNING id")).rows[0].id;
  const identity=(await pool.query("INSERT INTO identities(issuer,subject) VALUES('media-test',gen_random_uuid()::text) RETURNING id")).rows[0].id;
  await pool.query("INSERT INTO memberships(tenant_id,identity_id,role) VALUES($1,$2,'owner')",[tenant,identity]);
  const project=(await pool.query("INSERT INTO projects(tenant_id,owner_id,title,kind) VALUES($1,$2,'Media Asset','image') RETURNING id",[tenant,identity])).rows[0].id;
  const assetId=(await pool.query("INSERT INTO asset_metadata(tenant_id,project_id,storage_key,media_type,sha256,size_bytes,scan_state) VALUES($1,$2,$3,$4,$5,1,'clean') RETURNING id",[tenant,project,'test/'+randomUUID(),'image/test','a'.repeat(64)])).rows[0].id;
  await pool.query('UPDATE budget_global SET hard_limit_micro=GREATEST(hard_limit_micro,spent_micro+reserved_micro+1000) WHERE singleton=1');
  await pool.query('INSERT INTO budget_accounts(tenant_id,funded_micro,hard_limit_micro) VALUES($1,100,100)',[tenant]);
  const reservation=await new BudgetLedger({pool}).reserve({tenantId:tenant,idempotencyKey:randomUUID(),maximumMicrounits:50});
  const providerTaskId='task_'+randomUUID().replaceAll('-','');
  const providerId='mock-media';
  const service=()=>new MediaLifecycle({pool,secrets:async id=>{assert.equal(id,providerId);return secret}});
  const initial=await service().register({tenantId:tenant,providerId,providerTaskId,modality:'image',reservationId:reservation.id});
  assert.equal(initial.state,'queued');
  assert.equal((await service().register({tenantId:tenant,providerId,providerTaskId,modality:'image',reservationId:reservation.id})).id,initial.id);
  await assert.rejects(service().register({tenantId:tenant,providerId,providerTaskId,modality:'music',reservationId:reservation.id}),e=>e.code==='task_conflict');
  const callback=(callbackId,state,extra={})=>Buffer.from(JSON.stringify({callbackId,providerTaskId,state,...extra}));
  const complete=callback('complete','completed',{actualMicrounits:27,output:{assetIds:[assetId]},rights:{scope:'personal',license:'test-license'}});
  const send=(body,signature=sign(body))=>service().receive({providerId,body,timestamp,signature});
  await assert.rejects(send(complete,'sha256='+'0'.repeat(64)),e=>e.code==='invalid_signature');
  const result=await send(complete);assert.equal(result.state,'completed');
  assert.equal((await service().register({tenantId:tenant,providerId,providerTaskId,modality:'image',reservationId:reservation.id})).state,'completed');assert.equal(result.actualMicrounits,27);
  const [duplicate,late,failure]=await Promise.all([
   send(complete),send(callback('late-progress','running')),send(callback('late-failure','failed'))
  ]);
  assert.equal(duplicate.replayed,true);assert.equal(late.ignored,true);assert.equal(failure.ignored,true);
  assert.equal((await service().status({tenantId:tenant,identityId:identity,providerId,providerTaskId})).state,'completed');
  await assert.rejects(service().status({tenantId:'00000000-0000-4000-8000-000000000001',identityId:identity,providerId,providerTaskId}),e=>e.code==='not_found');
  const conflicting=callback('complete','completed',{actualMicrounits:1,output:{assetIds:[assetId]},rights:{scope:'personal',license:'test-license'}});
  await assert.rejects(send(conflicting),e=>e.code==='callback_conflict');
  const counts=await pool.query("SELECT count(*) AS n FROM budget_events WHERE reservation_id=$1 AND event_type='settle'",[reservation.id]);
  assert.equal(Number(counts.rows[0].n),1);
  const balance=await pool.query('SELECT status,charged_micro,provider_task_id FROM budget_reservations WHERE id=$1',[reservation.id]);
  assert.deepEqual(balance.rows[0],{status:'settled',charged_micro:'27',provider_task_id:providerTaskId});
 }finally{await pool.end()}
});

test('polling reconciles a terminal receipt and only the bound tenant member may read it',{skip:!url},async()=>{
 const pool=new pg.Pool({connectionString:url,max:4}),secret='p'.repeat(40);
 try{
  const tenant=(await pool.query("INSERT INTO tenants(name) VALUES('Poll lifecycle test') RETURNING id")).rows[0].id;
  const identity=(await pool.query("INSERT INTO identities(issuer,subject) VALUES('media-poll',gen_random_uuid()::text) RETURNING id")).rows[0].id;
  await pool.query("INSERT INTO memberships(tenant_id,identity_id,role) VALUES($1,$2,'owner')",[tenant,identity]);
  const project=(await pool.query("INSERT INTO projects(tenant_id,owner_id,title,kind) VALUES($1,$2,'Media Asset','music') RETURNING id",[tenant,identity])).rows[0].id;
  const assetId=(await pool.query("INSERT INTO asset_metadata(tenant_id,project_id,storage_key,media_type,sha256,size_bytes,scan_state) VALUES($1,$2,$3,$4,$5,1,'clean') RETURNING id",[tenant,project,'test/'+randomUUID(),'music/test','a'.repeat(64)])).rows[0].id;
  await pool.query('UPDATE budget_global SET hard_limit_micro=GREATEST(hard_limit_micro,spent_micro+reserved_micro+1000) WHERE singleton=1');
  await pool.query('INSERT INTO budget_accounts(tenant_id,funded_micro,hard_limit_micro) VALUES($1,50,50)',[tenant]);
  const reservation=await new BudgetLedger({pool}).reserve({tenantId:tenant,idempotencyKey:randomUUID(),maximumMicrounits:20});
  const providerTaskId='task_'+randomUUID().replaceAll('-',''),providerId='poll-media';
  const service=new MediaLifecycle({pool,secrets:async()=>secret,adapters:{poll:async()=>({providerTaskId,state:'completed',actualMicrounits:8,output:{assetIds:[assetId]},rights:{scope:'personal',license:'test-license'}})}});
  await service.register({tenantId:tenant,providerId,providerTaskId,modality:'music',reservationId:reservation.id});
  const args={tenantId:tenant,identityId:identity,providerId,providerTaskId};
  await assert.rejects(service.poll({...args,identityId:'00000000-0000-4000-8000-000000000001'}),e=>e.code==='not_found');
  assert.equal((await service.poll(args)).state,'completed');
  assert.equal((await service.poll(args)).replayed,true);
  assert.equal((await service.status(args)).actualMicrounits,8);
  const count=await pool.query("SELECT count(*) AS n FROM budget_events WHERE reservation_id=$1 AND event_type='settle'",[reservation.id]);
  assert.equal(Number(count.rows[0].n),1);
 }finally{await pool.end()}
});

test('durable dispatch intent prevents a second billable submit after ambiguity',{skip:!url},async()=>{
 const pool=new pg.Pool({connectionString:url,max:4});
 try{
  const tenantId=(await pool.query("INSERT INTO tenants(name) VALUES('Dispatch lifecycle test') RETURNING id")).rows[0].id;
  await pool.query('UPDATE budget_global SET hard_limit_micro=GREATEST(hard_limit_micro,spent_micro+reserved_micro+1000) WHERE singleton=1');
  await pool.query('INSERT INTO budget_accounts(tenant_id,funded_micro,hard_limit_micro) VALUES($1,50,50)',[tenantId]);
  const ledger=new BudgetLedger({pool}),reservation=await ledger.reserve({tenantId,idempotencyKey:randomUUID(),maximumMicrounits:20});
  const providerId='submit-media',providerTaskId='task_'+randomUUID().replaceAll('-',''),dispatchKey='dispatch_'+randomUUID().replaceAll('-','');
  let calls=0;
  const service=new MediaLifecycle({pool,secrets:async()=> 'x'.repeat(40),adapters:{submit:async request=>{calls++;assert.equal(request.options.idempotencyKey,dispatchKey);return {providerTaskId,state:'queued'}}}});
  const args={tenantId,providerId,providerTaskId,modality:'video',reservationId:reservation.id,dispatchKey,operation:'video.generate',region:'us',input:{prompt:'scene'}};
  const first=await service.submit(args);assert.equal(first.providerTaskId,providerTaskId);
  assert.equal((await service.submit(args)).id,first.id);assert.equal(calls,1);
  await assert.rejects(service.submit({...args,input:{prompt:'different'}}),e=>e.code==='dispatch_conflict');
  const other=await ledger.reserve({tenantId,idempotencyKey:randomUUID(),maximumMicrounits:20});
  const uncertainKey='uncertain_'+randomUUID().replaceAll('-','');
  const uncertain=new MediaLifecycle({pool,secrets:async()=> 'x'.repeat(40),adapters:{submit:async()=>{calls++;throw new Error('provider timeout')}}});
  const uncertainArgs={...args,reservationId:other.id,dispatchKey:uncertainKey};
  await assert.rejects(uncertain.submit(uncertainArgs),/provider timeout/);
  await assert.rejects(uncertain.submit(uncertainArgs),e=>e.code==='dispatch_uncertain');
  assert.equal(calls,2);
 }finally{await pool.end()}
});
