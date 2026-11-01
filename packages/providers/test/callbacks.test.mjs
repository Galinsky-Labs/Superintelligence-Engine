import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {verifyProviderCallback,reconcileProviderEvents} from '../src/callbacks.mjs';
const secret='a'.repeat(40),body=Buffer.from('{"task":"t"}'),timestamp='1700000000';
const sign=bytes=> 'sha256='+createHmac('sha256',secret).update(timestamp).update('.').update(bytes).digest('hex');
test('signature protects exact bytes and bounded clock freshness',()=>{
 const base={body,timestamp,signature:sign(body),secret,nowMs:1700000000000};
 assert.equal(verifyProviderCallback(base),true);
 assert.equal(verifyProviderCallback({...base,body:Buffer.from('{"task":"x"}')}),false);
 assert.equal(verifyProviderCallback({...base,nowMs:1700000400000}),false);
 assert.equal(verifyProviderCallback({...base,signature:'sha256='+'0'.repeat(64)}),false);
 assert.equal(verifyProviderCallback({...base,secret:'weak'}),false);
});
test('duplicate/out-of-order events cannot replace a terminal state',()=>{
 const event=(callbackId,state)=>({callbackId,providerTaskId:'task-1',state});
 let current=reconcileProviderEvents(null,event('complete','completed'));
 current=reconcileProviderEvents(current,event('late-running','running'));
 current=reconcileProviderEvents(current,event('complete','failed'));
 assert.equal(current.state,'completed');
 assert.deepEqual(current.seenIds,['complete','late-running']);
 assert.equal(Object.isFrozen(current.seenIds),true);
});
test('invalid callbacks and cross-task substitution fail closed',()=>{
 const initial=reconcileProviderEvents(null,{callbackId:'a',providerTaskId:'task-1',state:'running'});
 assert.throws(()=>reconcileProviderEvents(initial,{callbackId:'b',providerTaskId:'task-2',state:'completed'}));
 assert.throws(()=>reconcileProviderEvents(initial,{callbackId:'!',providerTaskId:'task-1',state:'completed'}));
});

test('malformed prior reducer state fails closed',()=>{
 const event={callbackId:'new',providerTaskId:'task-1',state:'completed'};
 for(const prior of [{providerTaskId:'task-1',state:'unknown',seenIds:[]},
 {providerTaskId:'task-1',state:'running',seenIds:[7]}])
  assert.throws(()=>reconcileProviderEvents(prior,event),TypeError);
});
