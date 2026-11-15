import test from 'node:test';import assert from 'node:assert/strict';import pg from 'pg';import {BudgetLedger,BudgetError} from '../../packages/budget/src/index.mjs';
const url=process.env.TEST_DATABASE_URL;
test('Atomic concurrent reservations, settlement, replay, release and refund', {skip:!url?'requires disposable PostgreSQL':false},async()=>{
 const pool=new pg.Pool({connectionString:url,max:16});
 try{
  const tenant=(await pool.query("INSERT INTO tenants(name) VALUES('Budget test') RETURNING id")).rows[0].id;
  await pool.query("UPDATE budget_global SET spent_micro=0,reserved_micro=0,hard_limit_micro=1000 WHERE singleton=1");
  await pool.query('INSERT INTO budget_accounts(tenant_id,funded_micro,hard_limit_micro) VALUES($1,50,50)',[tenant]);
  const ledger=new BudgetLedger({pool});
  const attempts=await Promise.allSettled(Array.from({length:20},(_,i)=>ledger.reserve({tenantId:tenant,idempotencyKey:'job-'+i,maximumMicrounits:10})));
  const good=attempts.filter(x=>x.status==='fulfilled').map(x=>x.value);
  const bad=attempts.filter(x=>x.status==='rejected').map(x=>x.reason);
  assert.equal(good.length,5);assert.equal(bad.length,15);assert.ok(bad.every(x=>x instanceof BudgetError));
  const report=await pool.query('SELECT spent_micro,reserved_micro FROM budget_accounts WHERE tenant_id=$1',[tenant]);
  assert.equal(report.rows[0].reserved_micro,'50');
  const first=good[0];
  await assert.rejects(ledger.settle({tenantId:tenant,reservationId:first.id,actualMicrounits:11}),/exceeds/);
  const settled=await ledger.settle({tenantId:tenant,reservationId:first.id,actualMicrounits:7,providerTaskId:'task-1'});
  assert.equal(settled.chargedMicrounits,'7');
  assert.deepEqual(await ledger.settle({tenantId:tenant,reservationId:first.id,actualMicrounits:7,providerTaskId:'task-1'}),settled);
  await assert.rejects(ledger.settle({tenantId:tenant,reservationId:first.id,actualMicrounits:8}),/replay/);
  const refunded=await ledger.refund({tenantId:tenant,reservationId:first.id,amountMicrounits:3,eventKey:'receipt-1'});assert.equal(refunded.refundedMicrounits,'3');
  assert.deepEqual(await ledger.refund({tenantId:tenant,reservationId:first.id,amountMicrounits:3,eventKey:'receipt-1'}),refunded);
  await assert.rejects(ledger.refund({tenantId:tenant,reservationId:first.id,amountMicrounits:8,eventKey:'receipt-2'}),/Refund/);
  await ledger.release({tenantId:tenant,reservationId:good[1].id});
  const summary=await pool.query('SELECT spent_micro,reserved_micro FROM budget_accounts WHERE tenant_id=$1',[tenant]);assert.equal(summary.rows[0].spent_micro,'4');assert.equal(summary.rows[0].reserved_micro,'30');
  const count=await pool.query("SELECT count(*) FROM budget_events WHERE tenant_id=$1 AND event_type='settle'",[tenant]);assert.equal(Number(count.rows[0].count),1);
 }finally{await pool.end();}
});
