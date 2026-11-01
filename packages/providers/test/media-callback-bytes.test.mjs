import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {MediaLifecycle} from '../src/media-lifecycle.mjs';

test('correctly signed malformed UTF-8 is rejected before any database effect',async()=>{
 const secret='s'.repeat(40),timestamp='1700000000';let databaseCalls=0;
 const lifecycle=new MediaLifecycle({pool:{connect:async()=>{databaseCalls++;throw new Error('database must not be reached')}},secrets:async()=>secret,clock:()=>1700000000000});
 const begin=Buffer.from('{"callbackId":"c1","providerTaskId":"t1","state":"completed","actualMicrounits":1,"output":{"assetIds":["00000000-0000-4000-8000-000000000001"]},"rights":{"scope":"personal","license":"');
 for(const invalid of [[0xff],[0xc3,0x28],[0xed,0xa0,0x80]]){
  const body=Buffer.concat([begin,Buffer.from(invalid),Buffer.from('"}}')]);
  const signature='sha256='+createHmac('sha256',secret).update(timestamp).update('.').update(body).digest('hex');
  await assert.rejects(lifecycle.receive({providerId:'mock-media',body,timestamp,signature}),error=>error.code==='invalid_callback');
 }
 assert.equal(databaseCalls,0);
});
test('signed valid UTF-8 retains non-ASCII license text without a decode replacement',async()=>{
 const secret='s'.repeat(40),timestamp='1700000000';let reached=false;
 const lifecycle=new MediaLifecycle({pool:{connect:async()=>{reached=true;throw new Error('synthetic database stop')}},secrets:async()=>secret,clock:()=>1700000000000});
 const body=Buffer.from(JSON.stringify({callbackId:'c1',providerTaskId:'t1',state:'completed',actualMicrounits:1,output:{assetIds:['00000000-0000-4000-8000-000000000001']},rights:{scope:'personal',license:'Création autorisée'}}));
 const signature='sha256='+createHmac('sha256',secret).update(timestamp).update('.').update(body).digest('hex');
 await assert.rejects(lifecycle.receive({providerId:'mock-media',body,timestamp,signature}),/synthetic database stop/);assert.equal(reached,true);
});
