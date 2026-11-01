import test from 'node:test';
import assert from 'node:assert/strict';
import {makeServer} from '../src/server.mjs';
const tenantId='10000000-0000-4000-8000-000000000001',identityId='20000000-0000-4000-8000-000000000002';
test('media task status and polling require session, origin and tenant member scope',async()=>{
 const calls=[];
 const server=makeServer({originConfig:{academy:'https://academy.example',command:'https://command.example'},mediaAuth:{session:async({cookieHeader})=>cookieHeader==='session=yes'?{identityId}:null},
  mediaOrigins:['https://academy.example'],mediaLifecycle:{
   status:async args=>{calls.push(['status',args]);return {state:'running'}},
   poll:async args=>{calls.push(['poll',args]);return {state:'completed'}}
  }});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const url='http://127.0.0.1:'+server.address().port+'/v1/media-tasks/mock-media/task-1';
 const headers={'x-sie-product':'academy','x-tenant-id':tenantId,origin:'https://academy.example',cookie:'session=yes'};
 try{
  assert.equal((await fetch(url,{headers})).status,200);
  assert.equal((await fetch(url+'/poll',{method:'POST',headers})).status,200);
  assert.deepEqual(calls.map(x=>x[0]),['status','poll']);
  assert.equal(calls[0][1].identityId,identityId);assert.equal(calls[0][1].tenantId,tenantId);
  assert.equal((await fetch(url,{headers:{...headers,cookie:'session=no'}})).status,401);
  assert.equal((await fetch(url,{headers:{...headers,origin:'https://attacker.example'}})).status,403);
  assert.equal((await fetch(url,{headers:{...headers,'x-tenant-id':'wrong'}})).status,401);
  assert.equal((await fetch(url+'/poll',{method:'GET',headers})).status,405);
 }finally{await new Promise(r=>server.close(r))}
});
