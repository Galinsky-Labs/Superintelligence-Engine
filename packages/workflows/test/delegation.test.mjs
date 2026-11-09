import test from 'node:test';
import assert from 'node:assert/strict';
import {createDelegationScope,delegationAuditEvent} from '../src/delegation.mjs';
const valid=()=>({taskId:'task-1',tenantId:'tenant-1',callerScopes:['image.read','image.edit'],
 remoteCapabilities:['image.read','music.generate'],requestedScopes:['image.read'],
 callerBudgetMicros:500,requestedBudgetMicros:100,callerDeadlineMs:5000,
 requestedDeadlineMs:4000,nowMs:1000});
test('remote task has least privilege and bounded budget/deadline',()=>{
 const s=createDelegationScope(valid());
 assert.deepEqual(s.scopes,['image.read']);assert.equal(s.budgetCeilingMicros,100);
 assert.ok(Object.isFrozen(s)&&Object.isFrozen(s.scopes));
 const audit=delegationAuditEvent(s,{remoteTaskId:'remote-7',state:'cancelled',atMs:2000});
 assert.equal(audit.remoteTaskId,'remote-7');
 assert.equal(Object.hasOwn(audit,'callerScopes'),false);
});
test('remote cannot receive tools the caller did not grant',()=>{
 for(const patch of [{requestedScopes:['music.generate']},
   {requestedScopes:['image.edit']},{requestedScopes:['image.read','image.read']},
   {requestedBudgetMicros:501},{requestedDeadlineMs:5001},
   {requestedDeadlineMs:999},{requestedScopes:[]},
 ])assert.throws(()=>createDelegationScope({...valid(),...patch}));
});
test('bad identifiers and unknown audit states fail closed',()=>{
 assert.throws(()=>createDelegationScope({...valid(),taskId:'../evil'}));
 assert.throws(()=>delegationAuditEvent(createDelegationScope(valid()),{remoteTaskId:'x',state:'charged'}));
});

test('untrusted or corrupted delegation scope cannot forge audit attribution',()=>{
 for(const scope of [{taskId:'../other',tenantId:'tenant-1',budgetCeilingMicros:1},
 {taskId:'task-1',tenantId:'../other',budgetCeilingMicros:1},
 {taskId:'task-1',tenantId:'tenant-1',budgetCeilingMicros:-1}])
  assert.throws(()=>delegationAuditEvent(scope,{remoteTaskId:'remote-1',state:'submitted',atMs:1234}),TypeError);
});
