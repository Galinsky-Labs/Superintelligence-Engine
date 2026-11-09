// Tools within permission/approval boundaries, MCP and external-agent integration, sandbox isolation,
// the code workspace (files, exec, tests, Git, preview), tenant isolation and RLS, egress controls.
import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {skip,freshDatabase,startApp,login,client} from '../helpers/harness.mjs';
import {startMockServices} from '../helpers/mock-services.mjs';
import {Sandbox} from '../../packages/engine/src/sandbox.mjs';
import {assertEgress,egressPolicy} from '../../packages/engine/src/net.mjs';
import {calculate} from '../../packages/engine/src/tools.mjs';

const SIM={provider:'deterministic',model:'sim-text'};
const sandboxSkip=new Sandbox().backend?false:'no sandbox backend on this host';

test('tools, integrations, workspace and security boundaries',{skip},async t=>{
  const db=await freshDatabase();const mock=await startMockServices();
  const app=await startApp(db,{...mock.env,SIE_EGRESS_ALLOWLIST:'example.invalid'});
  const a=await login(app.base,'alice');const p=(await a.post('/v1/projects',{title:'Tools',kind:'code'})).data;
  const runSpec=async spec=>{const r=await a.post(`/v1/projects/${p.id}/runs`,{spec});assert.equal(r.status,201,JSON.stringify(r.data));return r.data.id;};
  const drain=id=>app.worker.drain(id,{timeoutMs:60000});
  const get=async id=>(await a.get(`/v1/runs/${id}`)).data;
  try{
    await t.test('consequential tool call pauses for approval, executes only after admin approval',async()=>{
      const id=await runSpec({title:'notify',nodes:[{key:'agent',type:'agent',model:SIM,tools:['http_request','calculator'],
        instructions:`Notify the webhook.\nCALL_TOOL http_request {"method":"POST","url":"${mock.base}/webhook","body":"{\\"hello\\":1}"}\nCALL_TOOL calculator {"expression":"2^10"}`}]});
      assert.equal(await drain(id),'awaiting_approval');
      assert.equal(mock.log.filter(x=>x.path==='/webhook').length,0,'no external write before approval');
      const pending=(await a.get('/v1/approvals')).data.items.find(x=>x.runId===id);
      assert.equal(pending.effect,'external');assert.equal(pending.request.tool,'http_request');
      // members cannot approve
      const bob=await login(app.base,'bob');await a.put(`/v1/tenants/${a.tenantId}/members`,{identityId:bob.identityId,role:'member'});
      const asBob=client(app.base,{token:bob.token,tenant:a.tenantId});
      assert.equal((await asBob.post(`/v1/approvals/${pending.id}`,{decision:'approve'})).status,403);
      assert.equal((await a.post(`/v1/approvals/${pending.id}`,{decision:'approve',note:'ok'})).status,200);
      assert.equal(await drain(id),'succeeded');
      assert.equal(mock.log.filter(x=>x.path==='/webhook').length,1,'executed exactly once');
      const run=await get(id);assert.match(run.nodes[0].output.text,/Tool http_request returned/);assert.match(run.nodes[0].output.text,/1024/);
      assert.equal((await a.post(`/v1/approvals/${pending.id}`,{decision:'approve'})).status,409,'approval cannot be reused');
      const audit=(await a.get('/v1/tool-audit')).data.items;
      assert.ok(audit.some(x=>x.tool==='http_request'&&x.decision==='approval_required'));
      assert.ok(audit.some(x=>x.tool==='http_request'&&x.decision==='allowed'));
    });
    await t.test('denied approval is reported to the agent and the action never runs',async()=>{
      const before=mock.log.filter(x=>x.path==='/webhook').length;
      const id=await runSpec({nodes:[{key:'agent',type:'agent',model:SIM,tools:['http_request'],instructions:`CALL_TOOL http_request {"method":"DELETE","url":"${mock.base}/webhook"}`}]});
      assert.equal(await drain(id),'awaiting_approval');
      const ap=(await a.get('/v1/approvals')).data.items.find(x=>x.runId===id);
      await a.post(`/v1/approvals/${ap.id}`,{decision:'deny'});
      assert.equal(await drain(id),'succeeded');
      assert.equal(mock.log.filter(x=>x.path==='/webhook').length,before);
      assert.match((await get(id)).nodes[0].output.text,/denied/);
    });
    await t.test('tools not granted to a node are refused',async()=>{
      const id=await runSpec({nodes:[{key:'agent',type:'agent',model:SIM,tools:['calculator'],instructions:'CALL_TOOL calculator {"expression":"1+1"}\nCALL_TOOL file_write {"path":"x.txt","content":"pwned"}'}]});
      assert.equal(await drain(id),'succeeded');
      assert.equal((await a.get(`/v1/projects/${p.id}/files`)).data.items.length,0);
    });
    await t.test('approval workflow node gates downstream steps',async()=>{
      const id=await runSpec({nodes:[{key:'draft',type:'agent',model:SIM,instructions:'Draft press release'},{key:'gate',type:'approval',dependsOn:['draft'],effect:'publish',summary:'Publish the press release?'},{key:'publish',type:'agent',model:SIM,dependsOn:['gate'],instructions:'Finalize'}]});
      assert.equal(await drain(id),'awaiting_approval');
      const run=await get(id);assert.equal(run.status,'awaiting_approval');assert.equal(run.nodes.find(n=>n.key==='publish').state,'pending');
      await a.post(`/v1/approvals/${run.approvals[0].id}`,{decision:'approve'});
      assert.equal(await drain(id),'succeeded');
    });
    await t.test('web_fetch: allowlisted hosts allowed, others require approval; HTML scripts stripped',async()=>{
      const id=await runSpec({nodes:[{key:'r',type:'agent',model:SIM,tools:['web_fetch'],instructions:`CALL_TOOL web_fetch {"url":"${mock.base}/page"}`}]});
      assert.equal(await drain(id),'awaiting_approval','127.0.0.1 not on the allowlist for this app');
      const ap=(await a.get('/v1/approvals')).data.items.find(x=>x.runId===id);await a.post(`/v1/approvals/${ap.id}`,{decision:'approve'});
      assert.equal(await drain(id),'succeeded');
      const text=(await get(id)).nodes[0].output.text;assert.match(text,/Lithium supply facts/);assert.doesNotMatch(text,/evil\(\)/);
    });
    await t.test('MCP server: discovery, read tool runs, external tool needs approval',async()=>{
      const c=await a.post('/v1/connections',{kind:'mcp',name:'facts',endpoint:mock.base+'/mcp',secret:'mcp-secret',tools:{lookup:'read'}});
      assert.equal(c.status,201,JSON.stringify(c.data));assert.equal(c.data.hasSecret,true);assert.equal(c.data.tools.length,2);
      assert.ok(!JSON.stringify(c.data).includes('mcp-secret'));
      const id=await runSpec({nodes:[{key:'m',type:'agent',model:SIM,tools:['mcp'],instructions:'CALL_TOOL mcp_facts_lookup {"q":"graphene"}'}]});
      assert.equal(await drain(id),'succeeded');assert.match((await get(id)).nodes[0].output.text,/Fact about graphene/);
      const mcpCalls=mock.log.filter(x=>x.path==='/mcp');assert.ok(mcpCalls.some(x=>x.body?.method==='initialize'));assert.ok(mcpCalls.every(x=>x.headers.authorization==='Bearer mcp-secret'));
      const id2=await runSpec({nodes:[{key:'m',type:'agent',model:SIM,tools:['mcp'],instructions:'CALL_TOOL mcp_facts_create_ticket {"title":"Outage"}'}]});
      assert.equal(await drain(id2),'awaiting_approval');
    });
    await t.test('external agent delegation (A2A) requires approval and records untrusted output',async()=>{
      await a.post('/v1/connections',{kind:'external_agent',name:'partner',endpoint:mock.base+'/a2a'});
      const id=await runSpec({nodes:[{key:'d',type:'external_agent',connection:'partner',task:'Summarize Q3 numbers'}]});
      assert.equal(await drain(id),'awaiting_approval');
      const ap=(await a.get('/v1/approvals')).data.items.find(x=>x.runId===id);await a.post(`/v1/approvals/${ap.id}`,{decision:'approve'});
      assert.equal(await drain(id),'succeeded');
      const out=(await get(id)).nodes[0].output;assert.match(out.text,/External agent handled: Summarize Q3/);assert.equal(out.untrusted,true);
    });
    await t.test('code workspace: files, history, sandboxed exec/tests, diagnostics, git, preview',{skip:sandboxSkip},async()=>{
      const put=(path,content,expectedRevision)=>a.put(`/v1/projects/${p.id}/files/${path}`,{content,expectedRevision});
      assert.equal((await put('calc.py','def add(a, b):\n    return a + b\n')).status,200);
      await put('test_calc.py','import unittest\nfrom calc import add\nclass T(unittest.TestCase):\n    def test_add(self):\n        self.assertEqual(add(2, 3), 5)\n');
      await put('index.html','<h1>Preview works</h1><script>document.title="ok"</script>');
      assert.equal((await put('calc.py','x',0)).status,409,'optimistic concurrency on files');
      const tr=await a.post(`/v1/projects/${p.id}/test`,{});assert.equal(tr.data.passed,true,tr.data.stderr);assert.match(tr.data.stderr,/Ran 1 test/);
      const ex=await a.post(`/v1/projects/${p.id}/exec`,{command:['python3','-c','import calc;open("out.txt","w").write(str(calc.add(20,22)));print("done")'],persist:true});
      assert.equal(ex.data.exitCode,0,ex.data.stderr);assert.deepEqual(ex.data.persisted,['out.txt']);
      assert.equal((await a.get(`/v1/projects/${p.id}/files/out.txt`)).data.content,'42');
      await put('broken.py','def oops(:\n');
      const diag=(await a.get(`/v1/projects/${p.id}/diagnostics`)).data.items;assert.ok(diag.some(d=>d.path==='broken.py'&&d.severity==='error'));
      await a.del(`/v1/projects/${p.id}/files/broken.py`);
      const c1=await a.post(`/v1/projects/${p.id}/git/commit`,{message:'Initial calculator'});assert.equal(c1.status,201);assert.equal(c1.data.changed,true);
      await put('calc.py','def add(a, b):\n    return a + b + 0\n');
      const diff=(await a.get(`/v1/projects/${p.id}/git/diff`)).data.diff;assert.match(diff,/\+    return a \+ b \+ 0/);
      const c2=await a.post(`/v1/projects/${p.id}/git/commit`,{message:'Tweak'});
      const log=(await a.get(`/v1/projects/${p.id}/git/log`)).data.items;assert.equal(log.length,2);assert.equal(log[0].message,'Tweak');
      await a.post(`/v1/projects/${p.id}/git/checkout`,{commit:c1.data.commit});
      assert.equal((await a.get(`/v1/projects/${p.id}/files/calc.py`)).data.content,'def add(a, b):\n    return a + b\n');
      const hist=(await a.get(`/v1/projects/${p.id}/file-history/calc.py`)).data.items;assert.ok(hist.length>=3);
      const pv=(await a.post(`/v1/projects/${p.id}/preview`,{path:'index.html'})).data;
      const page=await fetch(app.base+pv.url);assert.equal(page.status,200);assert.match(await page.text(),/Preview works/);
      assert.match(page.headers.get('content-security-policy'),/sandbox allow-scripts/);
      assert.equal((await fetch(app.base+pv.url.replace(/\/[^/]+\/index.html$/,'/999999.bad/index.html'))).status,403);
      assert.ok(c2.data.commit);
    });
    await t.test('coding agent writes, runs and commits code through tools',{skip:sandboxSkip},async()=>{
      const id=await runSpec({nodes:[{key:'dev',type:'agent',model:SIM,tools:['code','git_commit'],instructions:
        'CALL_TOOL file_write {"path":"agent/hello.py","content":"print(sum(range(10)))"}\nCALL_TOOL workspace_exec {"command":["python3","agent/hello.py"]}\nCALL_TOOL git_commit {"message":"agent commit"}'}]});
      assert.equal(await drain(id),'succeeded');
      const out=(await get(id)).nodes[0].output.text;assert.match(out,/45/);
      assert.equal((await a.get(`/v1/projects/${p.id}/git/log`)).data.items[0].message,'agent commit');
    });
    await t.test('tenant isolation over the API',async()=>{
      const eve=await login(app.base,'eve');
      assert.equal((await eve.with({tenant:a.tenantId}).get('/v1/projects')).status,403,'not a member of alice tenant');
      const eveP=(await eve.post('/v1/projects',{title:'Eve',kind:'research'})).data;
      assert.equal((await eve.get(`/v1/projects/${p.id}`)).status,404,'cross-tenant project id invisible');
      assert.equal((await eve.get(`/v1/projects/${p.id}/artifacts`)).status,404);
      const aliceRun=(await a.get('/v1/runs')).data.items[0];
      assert.equal((await eve.get(`/v1/runs/${aliceRun.id}`)).status,404);
      assert.equal((await eve.post(`/v1/runs/${aliceRun.id}/cancel`)).status,404);
      assert.equal((await eve.post(`/v1/projects/${p.id}/runs`,{spec:{nodes:[{key:'x',type:'agent',model:SIM,instructions:'steal'}]}})).status,404);
      assert.equal((await a.get(`/v1/projects/${eveP.id}`)).status,404);
      const viewer=await login(app.base,'victor');await a.put(`/v1/tenants/${a.tenantId}/members`,{identityId:viewer.identityId,role:'viewer'});
      const v=viewer.with({tenant:a.tenantId});
      assert.equal((await v.get('/v1/projects')).status,200);
      assert.equal((await v.post('/v1/projects',{title:'nope'})).status,403,'viewers are read-only');
      assert.equal((await v.post(`/v1/projects/${p.id}/runs`,{spec:{nodes:[{key:'x',type:'agent',model:SIM,instructions:'x'}]}})).status,403);
      assert.equal((await client(app.base).get('/v1/projects')).status,401);
      assert.equal((await client(app.base,{token:'sie_'+'x'.repeat(43),tenant:a.tenantId}).get('/v1/projects')).status,401);
    });
    await t.test('row-level security blocks the app role without tenant context',async()=>{
      const c=new pg.Client({connectionString:db.appUrl});await c.connect();
      try{
        assert.equal((await c.query('SELECT count(*)::int n FROM projects')).rows[0].n,0);
        assert.equal((await c.query('SELECT count(*)::int n FROM project_artifacts')).rows[0].n,0);
        await c.query('BEGIN');await c.query("SELECT set_config('sie.tenant_id',$1,true),set_config('sie.identity_id',$2,true)",[a.tenantId,(await login(app.base,'mallory')).identityId]);
        assert.equal((await c.query('SELECT count(*)::int n FROM projects')).rows[0].n,0,'non-member sees nothing even with tenant set');
        await c.query('ROLLBACK');
        await assert.rejects(c.query("INSERT INTO budget_accounts(tenant_id,funded_micro,hard_limit_micro) VALUES ($1,1,1)",[a.tenantId]));
      }finally{await c.end();}
    });
    await t.test('revoked token and removed membership stop access',async()=>{
      const tok=await a.post('/v1/tokens',{label:'ci',days:1});const tc=client(app.base,{token:tok.data.token,tenant:a.tenantId});
      assert.equal((await tc.get('/v1/projects')).status,200);
      await a.del(`/v1/tokens/${tok.data.id}`);assert.equal((await tc.get('/v1/projects')).status,401);
    });
  }finally{await app.stop();await mock.close();await db.drop();}
});

test('sandbox isolation properties',{skip:sandboxSkip},async()=>{
  const s=new Sandbox();
  const net=await s.run({language:'python',code:'import socket\ntry:\n  socket.create_connection(("1.1.1.1",53),timeout=2);print("NET")\nexcept Exception as e:print("blocked",type(e).__name__)'});
  assert.match(net.stdout,/blocked/);
  const fs=await s.run({language:'bash',code:'ls /home /root 2>&1; cat /etc/passwd 2>&1 | head -1; ls /work'});
  assert.doesNotMatch(fs.stdout,/superintelligence|root:x:/);
  const write=await s.run({language:'bash',code:'touch /usr/evil 2>&1 || echo readonly'});assert.match(write.stdout,/readonly|Read-only/);
  const loop=await s.run({language:'python',code:'while True: pass',timeoutMs:1500});assert.ok(loop.timedOut||loop.exitCode!==0);
  const mem=await s.run({language:'python',code:'x=bytearray(1024*1024*1024)\nprint("allocated")',memoryMb:128});assert.doesNotMatch(mem.stdout,/allocated/);
  if(process.getuid()===0){const fork=await s.run({language:'bash',code:'for i in $(seq 1 200); do sleep 5 & done; echo spawned',timeoutMs:3000,maxProcs:16});assert.ok(fork.exitCode!==0||/Resource|retry|fork/i.test(fork.stderr));}
  const env=await s.run({language:'node',code:'console.log(JSON.stringify(Object.keys(process.env)))'});assert.doesNotMatch(env.stdout,/DATABASE_URL|SIE_ENCRYPTION_KEY|API_KEY/);
});

test('egress policy and calculator',async()=>{
  const strict=egressPolicy({});
  await assert.rejects(assertEgress('http://example.com',strict),/HTTPS/);
  await assert.rejects(assertEgress('https://127.0.0.1/',strict),/private/);
  await assert.rejects(assertEgress('https://169.254.169.254/latest/meta-data',strict),/private/);
  await assert.rejects(assertEgress('https://[::1]/',strict),/private/);
  await assert.rejects(assertEgress('https://user:pw@example.com/',strict));
  assert.equal(calculate('2^10 + sqrt(16) * (3 - 1)'),1032);
  assert.throws(()=>calculate('process.exit()'));
});
