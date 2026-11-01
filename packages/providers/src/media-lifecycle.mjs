import {createHash,createHmac} from 'node:crypto';
import {verifyProviderCallback} from './callbacks.mjs';
const ID=/^[A-Za-z0-9_-]{1,128}$/,PROVIDER=/^[a-z][a-z0-9-]{1,63}$/,UUID=/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const terminal=new Set(['completed','failed','cancelled']);
function fail(code){const e=new Error(code);e.code=code;throw e}
function check(v,re){if(typeof v!=='string'||!re.test(v))fail('invalid_identity')}
async function tx(pool,fn){const db=await pool.connect();try{await db.query('BEGIN');try{const r=await fn(db);await db.query('COMMIT');return r}catch(e){await db.query('ROLLBACK');throw e}}finally{db.release()}}
const view=r=>({id:r.id,providerId:r.provider_id,providerTaskId:r.provider_task_id,modality:r.modality,state:r.state,output:r.output,rights:r.rights,actualMicrounits:r.actual_micro===null?null:Number(r.actual_micro)});
export class MediaLifecycle {
 constructor({pool,secrets,adapters,clock=()=>Date.now()}={}){if(!pool?.connect||typeof secrets!=='function')throw new TypeError('Trusted pool and secret resolver required');this.pool=pool;this.secrets=secrets;this.adapters=adapters;this.clock=clock}
 async register({tenantId,providerId,providerTaskId,modality,reservationId}){
  check(tenantId,UUID);check(reservationId,UUID);check(providerId,PROVIDER);check(providerTaskId,ID);
  if(!['image','music','video'].includes(modality))fail('invalid_modality');
  return tx(this.pool,async db=>{
   const existing=(await db.query('SELECT * FROM media_tasks WHERE provider_id=$1 AND provider_task_id=$2',[providerId,providerTaskId])).rows[0];
   if(existing){
    if(existing.tenant_id!==tenantId||existing.reservation_id!==reservationId||existing.modality!==modality)fail('task_conflict');
    return view(existing);
   }
   const reservation=(await db.query('SELECT status FROM budget_reservations WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[tenantId,reservationId])).rows[0];
   if(!reservation||reservation.status!=='reserved')fail('reservation_inactive');
   const inserted=await db.query('INSERT INTO media_tasks(tenant_id,provider_id,provider_task_id,modality,reservation_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT(provider_id,provider_task_id) DO NOTHING RETURNING *',[tenantId,providerId,providerTaskId,modality,reservationId]);
   const task=inserted.rows[0]||(await db.query('SELECT * FROM media_tasks WHERE provider_id=$1 AND provider_task_id=$2',[providerId,providerTaskId])).rows[0];
   if(task.tenant_id!==tenantId||task.reservation_id!==reservationId||task.modality!==modality)fail('task_conflict');
   return view(task);
  });
 }
 async status({tenantId,identityId,providerId,providerTaskId}){
  check(tenantId,UUID);check(identityId,UUID);check(providerId,PROVIDER);check(providerTaskId,ID);
  const task=(await this.pool.query('SELECT t.* FROM media_tasks t JOIN memberships m ON m.tenant_id=t.tenant_id WHERE t.tenant_id=$1 AND t.provider_id=$2 AND t.provider_task_id=$3 AND m.identity_id=$4',[tenantId,providerId,providerTaskId,identityId])).rows[0];
  if(!task)fail('not_found');return view(task);
 }
 async submit({tenantId,providerId,modality,reservationId,dispatchKey,operation,region,commercial=false,input,options={}}){
  check(tenantId,UUID);check(reservationId,UUID);check(providerId,PROVIDER);check(dispatchKey,ID);
  if(!['image','music','video'].includes(modality))fail('invalid_modality');
  if(!this.adapters?.submit)fail('submit_unconfigured');
  const requestDigest=createHash('sha256').update(JSON.stringify([operation,region,commercial,input,options])).digest('hex');
  const prior=await tx(this.pool,async db=>{
   const existing=(await db.query('SELECT * FROM media_dispatches WHERE tenant_id=$1 AND dispatch_key=$2 FOR UPDATE',[tenantId,dispatchKey])).rows[0];
   if(existing){if(existing.provider_id!==providerId||existing.modality!==modality||existing.reservation_id!==reservationId||existing.request_digest!==requestDigest)fail('dispatch_conflict');return {fresh:false}}
   const reservation=(await db.query('SELECT status FROM budget_reservations WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[tenantId,reservationId])).rows[0];
   if(!reservation||reservation.status!== 'reserved')fail('reservation_inactive');
   const inserted=await db.query('INSERT INTO media_dispatches(tenant_id,dispatch_key,provider_id,modality,reservation_id,request_digest) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(tenant_id,dispatch_key) DO NOTHING RETURNING *',[tenantId,dispatchKey,providerId,modality,reservationId,requestDigest]);
   const row=inserted.rows[0]||(await db.query('SELECT * FROM media_dispatches WHERE tenant_id=$1 AND dispatch_key=$2 FOR UPDATE',[tenantId,dispatchKey])).rows[0];
   if(row.provider_id!==providerId||row.modality!==modality||row.reservation_id!==reservationId||row.request_digest!==requestDigest)fail('dispatch_conflict');
   return {fresh:Boolean(inserted.rows[0])};
  });
  if(!prior.fresh){
   const existing=(await this.pool.query('SELECT * FROM media_tasks WHERE tenant_id=$1 AND reservation_id=$2',[tenantId,reservationId])).rows[0];
   if(existing)return view(existing);
   fail('dispatch_uncertain');
  }
  // The durable started row fences retries after an ambiguous external effect.
  const receipt=await this.adapters.submit({tenantId,providerId,operation,region,commercial,reservationId,input,
   options:{...options,idempotencyKey:dispatchKey}});
  const task=await this.register({tenantId,providerId,providerTaskId:receipt.providerTaskId,modality,reservationId});
  await this.pool.query("UPDATE media_dispatches SET state='registered',provider_task_id=$3 WHERE tenant_id=$1 AND dispatch_key=$2",[tenantId,dispatchKey,receipt.providerTaskId]);
  return task;
 }
 async poll({tenantId,identityId,providerId,providerTaskId}){
  await this.status({tenantId,identityId,providerId,providerTaskId});
  if(!this.adapters?.poll)fail('poll_unconfigured');
  const receipt=await this.adapters.poll({providerId,providerTaskId});
  if(receipt.providerTaskId!==providerTaskId)fail('task_conflict');
  const digest=createHash('sha256').update(JSON.stringify(receipt)).digest('hex');
  const event={...receipt,providerTaskId,callbackId:'poll_'+digest.slice(0,64)};
  const body=Buffer.from(JSON.stringify(event));
  const timestamp=String(Math.floor(this.clock()/1000));
  const secret=await this.secrets(providerId);
  const signature='sha256='+createHmac('sha256',secret).update(timestamp).update('.').update(body).digest('hex');
  return this.receive({providerId,body,timestamp,signature});
 }
 async receive({providerId,body,timestamp,signature}){
  check(providerId,PROVIDER);
  const secret=await this.secrets(providerId);
  if(!verifyProviderCallback({body,timestamp,signature,secret,nowMs:this.clock()}))fail('invalid_signature');
  let event;try{event=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(body))}catch{fail('invalid_callback')}
  if(!event||typeof event!=='object'||Array.isArray(event))fail('invalid_callback');
  check(event.callbackId,ID);check(event.providerTaskId,ID);
  if(!['queued','running',...terminal].includes(event.state))fail('invalid_callback');
  if(event.state==='completed'&&(!Number.isSafeInteger(event.actualMicrounits)||event.actualMicrounits<0||
   !event.output||typeof event.output!=='object'||Array.isArray(event.output)||
   Object.keys(event.output).some(k=>k!=='assetIds')||!Array.isArray(event.output.assetIds)||
   event.output.assetIds.length<1||event.output.assetIds.length>50||
   event.output.assetIds.some(x=>typeof x!=='string'||!UUID.test(x))||
   new Set(event.output.assetIds).size!==event.output.assetIds.length||
   !event.rights||typeof event.rights!=='object'||Array.isArray(event.rights)||
   !['personal','commercial'].includes(event.rights.scope)||
   typeof event.rights.license!=='string'||event.rights.license.length<1||event.rights.license.length>256))
   fail('invalid_result');
  const digest=createHash('sha256').update(body).digest('hex');
  return tx(this.pool,async db=>{
   const task=(await db.query('SELECT * FROM media_tasks WHERE provider_id=$1 AND provider_task_id=$2 FOR UPDATE',[providerId,event.providerTaskId])).rows[0];
   if(!task)fail('unknown_task');
   const prior=(await db.query('SELECT * FROM media_callbacks WHERE provider_id=$1 AND callback_id=$2',[providerId,event.callbackId])).rows[0];
   if(prior){if(prior.task_id!==task.id||prior.digest!==digest)fail('callback_conflict');return {...view(task),replayed:true}}
   await db.query('INSERT INTO media_callbacks(provider_id,callback_id,task_id,digest) VALUES($1,$2,$3,$4)',[providerId,event.callbackId,task.id,digest]);
   if(terminal.has(task.state))return {...view(task),ignored:true};
   if(!terminal.has(event.state)){
    const state=task.state==='running'||event.state==='running'?'running':'queued';
    const updated=(await db.query('UPDATE media_tasks SET state=$2,updated_at=now() WHERE id=$1 RETURNING *',[task.id,state])).rows[0];return view(updated);
   }
   const global=(await db.query('SELECT * FROM budget_global WHERE singleton=1 FOR UPDATE')).rows[0];
   const account=(await db.query('SELECT * FROM budget_accounts WHERE tenant_id=$1 FOR UPDATE',[task.tenant_id])).rows[0];
   const reservation=(await db.query('SELECT * FROM budget_reservations WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[task.tenant_id,task.reservation_id])).rows[0];
   if(!global||!account||!reservation||reservation.status!=='reserved')fail('reservation_inactive');
   if(event.state==='completed'){
    const assets=await db.query("SELECT id FROM asset_metadata WHERE tenant_id=$1 AND id=ANY($2::uuid[]) AND scan_state='clean' FOR SHARE",[task.tenant_id,event.output.assetIds]);
    if(assets.rows.length!==event.output.assetIds.length)fail('asset_unavailable');
    for(const assetId of event.output.assetIds)await db.query('INSERT INTO media_task_assets(tenant_id,task_id,asset_id) VALUES($1,$2,$3)',[task.tenant_id,task.id,assetId]);
   }
   const charge=BigInt(event.state==='completed'?event.actualMicrounits:0),reserved=BigInt(reservation.reserved_micro);
   if(charge>reserved)fail('reservation_limit_exceeded');
   await db.query('UPDATE budget_global SET reserved_micro=reserved_micro-$1,spent_micro=spent_micro+$2 WHERE singleton=1',[String(reserved),String(charge)]);
   await db.query('UPDATE budget_accounts SET reserved_micro=reserved_micro-$1,spent_micro=spent_micro+$2,updated_at=now() WHERE tenant_id=$3',[String(reserved),String(charge),task.tenant_id]);
   await db.query("UPDATE budget_reservations SET status='settled',charged_micro=$1,provider_task_id=$2,settled_at=now() WHERE id=$3",[String(charge),task.provider_task_id,task.reservation_id]);
   await db.query("INSERT INTO budget_events(tenant_id,reservation_id,event_key,event_type,delta_reserved_micro,delta_spent_micro) VALUES($1,$2,$3,'settle',$4,$5)",[task.tenant_id,task.reservation_id,'settle:'+task.reservation_id,String(-reserved),String(charge)]);
   const updated=(await db.query('UPDATE media_tasks SET state=$2,output=$3::jsonb,rights=$4::jsonb,actual_micro=$5,updated_at=now() WHERE id=$1 RETURNING *',[task.id,event.state,event.state==='completed'?JSON.stringify(event.output):null,event.state==='completed'?JSON.stringify(event.rights):null,String(charge)])).rows[0];
   return view(updated);
  });
 }
}
