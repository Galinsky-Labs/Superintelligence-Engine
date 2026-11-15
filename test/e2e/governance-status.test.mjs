// Workspace policies, audit log, public status and the load/cost-accounting trial.
import test from 'node:test';import assert from 'node:assert/strict';
import {skip,freshDatabase,startApp,login} from '../helpers/harness.mjs';
import {loadTrial} from '../../scripts/load-trial.mjs';
test('policies are enforced, admin actions are audited, status and load trial report truthfully',{skip,timeout:180000},async()=>{
 const db=await freshDatabase();const app=await startApp(db,{SIE_SIM_DELAY_MS:'1',OPENAI_API_KEY:'sk-test-not-real-000000'});
 const ac=new AbortController();const loop=app.worker.run({signal:ac.signal});
 try{
  const owner=await login(app.base,'gov-owner');const other=await login(app.base,'gov-member');const third=await login(app.base,'gov-third');
  const t=owner.tenantId;
  // policy
  assert.equal((await owner.get(`/v1/tenants/${t}/policy`)).data.maxRunBudgetMicro,null);
  assert.equal((await owner.put(`/v1/tenants/${t}/policy`,{maxRunBudgetMicro:0})).status,400,'zero would mean unlimited');
  const pol=await owner.put(`/v1/tenants/${t}/policy`,{maxRunBudgetMicro:25000,allowedProviders:['anthropic'],seatLimit:2});assert.equal(pol.status,200,JSON.stringify(pol.data));
  const p=(await owner.post('/v1/projects',{title:'Gov',kind:'general'})).data;
  const run=(await owner.post(`/v1/projects/${p.id}/runs`,{spec:{nodes:[{key:'a',type:'agent',instructions:'hi',model:{provider:'deterministic',model:'sim-text'}}],budgetCeilingMicro:999999}})).data;
  assert.equal(run.budgetCeilingMicro,25000,'ceiling clamped to policy');
  const uncapped=(await owner.post(`/v1/projects/${p.id}/runs`,{spec:{nodes:[{key:'a',type:'agent',instructions:'hi',model:{provider:'deterministic',model:'sim-text'}}]}})).data;
  assert.equal(uncapped.budgetCeilingMicro,25000,'no ceiling requested gets the policy cap');
  const models=(await owner.get('/v1/models')).data.items;
  assert.ok(models.filter(m=>m.provider==='openai').every(m=>m.available===false&&m.blockedByPolicy));
  const blocked=(await owner.post(`/v1/projects/${p.id}/generate`,{stream:false,prompt:'x',model:{provider:'openai',model:'gpt-4.1-mini'}})).data;
  assert.equal(blocked.status,'failed');assert.match(String(blocked.error),/provider_not_allowed|does not allow/);
  // seats
  const me2=(await other.get('/v1/me')).data,me3=(await third.get('/v1/me')).data;
  assert.equal((await owner.put(`/v1/tenants/${t}/members`,{identityId:me2.id,role:'member'})).status,200);
  const full=await owner.put(`/v1/tenants/${t}/members`,{identityId:me3.id,role:'member'});assert.equal(full.status,409);assert.equal(full.data.code,'seat_limit_reached');
  assert.equal((await owner.put(`/v1/tenants/${t}/members`,{identityId:me2.id,role:'viewer'})).status,200,'role changes do not need a seat');
  assert.equal((await owner.put(`/v1/tenants/${t}/policy`,{seatLimit:1})).status,409);
  // audit
  assert.equal((await other.with({tenant:t}).get(`/v1/tenants/${t}/audit`)).status,403,'viewers cannot read the audit log');
  const audit=(await owner.get(`/v1/tenants/${t}/audit`)).data.items;
  const actions=audit.map(a=>a.action);
  for(const a of ['policy.update','member.set'])assert.ok(actions.includes(a),a);
  assert.equal(audit.filter(a=>a.action==='member.set').length,2);assert.ok(audit[0].at>=audit.at(-1).at);
  // status
  const st=await fetch(app.base+'/v1/status');const sj=await st.json();
  assert.equal(st.status,200);assert.equal(sj.status,'operational');assert.equal(sj.components.database.status,'ok');assert.deepEqual(sj.components.providers.configured,['openai']);
  assert.equal(JSON.stringify(sj).includes('sk-test'),false);
  const html=await fetch(app.base+'/status');assert.match(await html.text(),/Superintelligence Engine status/);
  // load trial (simulator) on a fresh, policy-free workspace
  const lt=await login(app.base,'load');
  const r=await loadTrial({baseUrl:app.base,token:lt.token,tenantId:lt.tenantId,runs:16,concurrency:8});
  assert.equal(r.succeeded,16,JSON.stringify(r.errors));assert.equal(r.accountingConsistent,true);assert.ok(r.latencyMs.p95>0);
 }finally{ac.abort();await loop;await app.stop();await db.drop();}
});
