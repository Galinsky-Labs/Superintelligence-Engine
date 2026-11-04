import test from 'node:test';
import assert from 'node:assert/strict';
import {validateSandboxRequest} from '../src/admission.mjs';
const valid=()=>({runtime:'node22',cpuMillis:1000,memoryMiB:256,timeoutMs:3000,
 network:'disabled',mounts:[],secrets:[],workspaceId:'workspace-1'});
test('valid no-secret no-egress admission for Node and Python',()=>{
 for(const runtime of ['node22','python3']){
  const s=validateSandboxRequest({...valid(),runtime});
  assert.ok(Object.isFrozen(s)&&Object.isFrozen(s.mounts));
 }
});
test('secrets, egress, mounts, elevated budgets and unknown fields fail closed',()=>{
 for(const patch of [{network:'open'},{mounts:['/host']},{secrets:['API_KEY']},
  {timeoutMs:60001},{cpuMillis:30001},{memoryMiB:4096},
  {runtime:'bash'},{workspaceId:'../../etc'},{hostPath:'/'},
 ])assert.throws(()=>validateSandboxRequest({...valid(),...patch}));
});
test('accessor fields and nonplain objects fail closed without executing getter',()=>{
 const s=valid();Object.defineProperty(s,'runtime',{enumerable:true,get(){throw Error('executed')}});
 assert.throws(()=>validateSandboxRequest(s),/Unsafe sandbox admission/);
 assert.throws(()=>validateSandboxRequest(Object.assign(Object.create({secret:1}),valid())));
});
