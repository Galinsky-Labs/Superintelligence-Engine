import test from 'node:test';
import assert from 'node:assert/strict';
import {workflowTransition} from '../src/approvals.mjs';
const state=(effect='publish')=>({state:'pending',effect,version:0});
test('sensitive action requires approver and cannot skip approval',()=>{
 const pending=state();
 assert.throws(()=>workflowTransition(pending,'start',{expectedVersion:0}));
 const awaiting=workflowTransition(pending,'request',{expectedVersion:0});
 assert.throws(()=>workflowTransition(awaiting,'approve',{expectedVersion:1,actorRole:'viewer'}));
 const approved=workflowTransition(awaiting,'approve',{expectedVersion:1,actorRole:'approver'});
 assert.equal(workflowTransition(approved,'start',{expectedVersion:2}).state,'running');
});
test('denied action cannot retry or escalate scope',()=>{
 const awaiting=workflowTransition(state('purchase'),'request',{expectedVersion:0});
 const denied=workflowTransition(awaiting,'deny',{expectedVersion:1,actorRole:'approver'});
 assert.throws(()=>workflowTransition(denied,'retry',{expectedVersion:2}));
 assert.throws(()=>workflowTransition(denied,'start',{expectedVersion:2}));
});
test('failed sensitive work must renew human approval before retry',()=>{
 let s=workflowTransition(state('send'),'request',{expectedVersion:0});
 s=workflowTransition(s,'approve',{expectedVersion:1,actorRole:'approver'});
 s=workflowTransition(s,'start',{expectedVersion:2});
 s=workflowTransition(s,'fail',{expectedVersion:3});
 s=workflowTransition(s,'retry',{expectedVersion:4});
 assert.equal(s.state,'awaiting_approval');
 assert.throws(()=>workflowTransition(s,'start',{expectedVersion:5}));
 assert.throws(()=>workflowTransition(s,'approve',{expectedVersion:4,actorRole:'approver'}));
});

test('unknown effect cannot bypass sensitive approval through optimistic default',()=>{
 for(const effect of ['transfer_funds','publish_public','',null])
  assert.throws(()=>workflowTransition(state(effect),'start',{expectedVersion:0}),TypeError);
 assert.equal(workflowTransition(state('read'),'start',{expectedVersion:0}).state,'running');
});
