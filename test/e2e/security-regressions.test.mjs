// Regression tests reproducing the findings of the AI-assisted security review.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import pg from 'pg';
import {skip,freshDatabase,startApp,login,client} from '../helpers/harness.mjs';
import {startMockServices} from '../helpers/mock-services.mjs';
import {assertEgress,egressPolicy,guardedFetch,isPrivateAddress} from '../../packages/engine/src/net.mjs';
import {Sandbox} from '../../packages/engine/src/sandbox.mjs';

const SIM={provider:'deterministic',model:'sim-text'};

test('egress: mapped/NAT64/encoded private addresses are refused',async()=>{
  const strict=egressPolicy({});
  for(const u of ['https://[::ffff:127.0.0.1]/','https://[::ffff:7f00:1]/','https://[64:ff9b::a9fe:a9fe]/','https://2130706433/','https://0x7f.1/','https://[::]/','https://100.100.100.200/'])
    await assert.rejects(assertEgress(u,strict),/private|egress/,u);
  assert.equal(isPrivateAddress('8.8.8.8'),false);assert.equal(isPrivateAddress('::ffff:8.8.8.8'),false);
});

test('egress: credentials dropped on cross-origin redirect, 307 cross-origin refused, redirect veto',async()=>{
  const seen=[];
  const b=createServer((req,res)=>{seen.push({url:req.url,auth:req.headers.authorization});res.end('ok');});
  await new Promise(r=>b.listen(0,'127.0.0.1',r));
  const a=createServer((req,res)=>{res.writeHead(req.url==='/307'?307:302,{Location:`http://localhost:${b.address().port}/landed`});res.end();});
  await new Promise(r=>a.listen(0,'127.0.0.1',r));
  const policy={allowHttp:true,allowPrivate:true,allowlist:[]};
  try{
    await guardedFetch(`http://127.0.0.1:${a.address().port}/302`,{headers:{Authorization:'Bearer secret'},policy});
    assert.equal(seen[0].url,'/landed');assert.equal(seen[0].auth,undefined,'Authorization not forwarded to another origin');
    await assert.rejects(guardedFetch(`http://127.0.0.1:${a.address().port}/307`,{method:'POST',body:'x',policy}),/cross_origin|another origin/);
    await assert.rejects(guardedFetch(`http://127.0.0.1:${a.address().port}/302`,{policy,redirectAllowed:()=>false}),/approval|outside/);
  }finally{a.close();b.close();}
});

test('review findings over the API',{skip},async t=>{
  const db=await freshDatabase();const mock=await startMockServices();const app=await startApp(db,mock.env);
  const sql=new pg.Client({connectionString:db.url});await sql.connect();
  const alice=await login(app.base,'alice');const eve=await login(app.base,'evelyn');
  const p=(await alice.post('/v1/projects',{title:'Victim',kind:'code'})).data;
  try{
    await t.test('workspace files cannot target .git (host RCE via git config)',async()=>{
      for(const path of ['.git/config','sub/.git/config','.GIT/config'])assert.equal((await alice.put(`/v1/projects/${p.id}/files/${path}`,{content:'[core]\n\tfsmonitor = "touch /tmp/pwned; false"\n'})).status,400,path);
      await assert.rejects(sql.query("INSERT INTO workspace_files(tenant_id,project_id,path,content,sha256,updated_by) VALUES($1,$2,'.git/config','x','x',$3)",[alice.tenantId,p.id,alice.identityId]));
      const id=(await alice.post(`/v1/projects/${p.id}/runs`,{spec:{nodes:[{key:'x',type:'agent',model:SIM,tools:['files','git_commit'],instructions:'CALL_TOOL file_write {"path":".git/config","content":"[core]\\n\\tfsmonitor=\\"id\\""}'}]}})).data.id;
      await app.worker.drain(id);
      assert.match((await alice.get(`/v1/runs/${id}`)).data.nodes[0].output.text,/invalid_path/);
    });
    await t.test('git routes reject traversal and foreign projects',async()=>{
      if(new Sandbox().backend!==undefined){await alice.put(`/v1/projects/${p.id}/files/secret.txt`,{content:'TOP SECRET'});await alice.post(`/v1/projects/${p.id}/git/commit`,{message:'secret'});}
      const own=eve.tenantId;
      const r1=await eve.get(`/v1/projects/..%2F${alice.tenantId}%2F${p.id}/git/log`);assert.equal(r1.status,400);
      const r2=await eve.get(`/v1/projects/${p.id}/git/log`);assert.equal(r2.status,404,'foreign project id in own tenant');
      const r3=await eve.get(`/v1/projects/${p.id}/git/diff?from=4b825dc642cb6eb9a060e54bf8d69288fbee4904`);assert.equal(r3.status,404);
      assert.ok(own);
    });
    await t.test('capabilities do not reveal another tenant configuration',async()=>{
      const c=await client(app.base,{token:eve.token,tenant:alice.tenantId}).get('/v1/capabilities');
      assert.deepEqual(c.data.availableProviders,[]);
    });
    await t.test('connection secret does not follow a changed endpoint',async()=>{
      await alice.post('/v1/connections',{kind:'http',name:'api',endpoint:mock.base+'/webhook',secret:'s3cret-token'});
      const moved=await alice.post('/v1/connections',{kind:'http',name:'api',endpoint:'https://attacker.example/'});
      assert.equal(moved.data.hasSecret,false);
    });
    await t.test('tenant-configured provider base URL cannot target private addresses',async()=>{
      const strictApp=await startApp(db,{SIE_ALLOW_PRIVATE_EGRESS:'0'});
      try{const s=client(strictApp.base,{token:alice.token,tenant:alice.tenantId});
        const r=await s.put('/v1/providers/openai',{apiKey:'sk-test-12345678',baseUrl:'https://127.0.0.1/v1'});assert.equal(r.status,403);}
      finally{await strictApp.stop();}
    });
    await t.test('run budget ceiling holds under concurrent reservations',async()=>{
      await sql.query('UPDATE budget_global SET hard_limit_micro=100000000');
      await sql.query('UPDATE budget_accounts SET funded_micro=100000000,hard_limit_micro=100000000 WHERE tenant_id=$1',[alice.tenantId]);
      const run=(await alice.post(`/v1/projects/${p.id}/runs`,{spec:{budgetCeilingMicro:2500,nodes:[{key:'x',type:'approval'}]}})).data;
      const results=await Promise.allSettled(Array.from({length:12},(_,i)=>app.engine.meter.reserve({tenantId:alice.tenantId,runId:run.id,key:'k'+i,micro:1000})));
      assert.equal(results.filter(r=>r.status==='fulfilled').length,2);
    });
  }finally{await sql.end();await app.stop();await mock.close();await db.drop();}
});
