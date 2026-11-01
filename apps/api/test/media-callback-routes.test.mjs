import test from 'node:test';
import assert from 'node:assert/strict';
import {makeServer} from '../src/server.mjs';
test('provider callback route passes exact bytes and rejects oversize or unconfigured access',async()=>{
 let seen;
 const server=makeServer({mediaLifecycle:{receive:async args=>{seen=args;return {state:'completed'}}}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base='http://127.0.0.1:'+server.address().port;
 try{
  const body='{"callbackId":"abc"}';
  const response=await fetch(base+'/v1/providers/mock-media/callbacks',{method:'POST',headers:{'content-type':'application/json','x-provider-timestamp':'1700000000','x-provider-signature':'sha256='+'a'.repeat(64)},body});
  assert.equal(response.status,200);assert.equal(seen.body.toString(),body);assert.equal(seen.providerId,'mock-media');
  assert.equal((await fetch(base+'/v1/providers/mock-media/callbacks',{method:'GET'})).status,405);
  assert.equal((await fetch(base+'/v1/providers/mock-media/callbacks',{method:'POST',headers:{'content-type':'application/json'},body:'a'.repeat(1048577)})).status,413);
 }finally{await new Promise(r=>server.close(r))}
});
