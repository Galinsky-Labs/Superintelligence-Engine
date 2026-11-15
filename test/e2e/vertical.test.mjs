// Acceptance: authenticated user -> project -> model selection -> provider execution -> streamed output
// -> persistent artifact -> recorded usage -> completed run -> retrieval after a full restart.
// Uses the deterministic simulator provider (zero cost, outputs labeled SIMULATED).
import test from 'node:test';
import assert from 'node:assert/strict';
import {skip,freshDatabase,startApp,login,client} from '../helpers/harness.mjs';

test('vertical path survives restart',{skip},async()=>{
  const db=await freshDatabase();
  let app=await startApp(db);
  let ids;
  try{
    const a=await login(app.base,'alice');
    const models=await a.get('/v1/models?capability=chat');
    assert.equal(models.status,200);
    const sim=models.data.items.find(m=>m.provider==='deterministic');
    assert.ok(sim?.available,'simulator available when enabled');
    const p=await a.post('/v1/projects',{title:'Vertical',kind:'research',description:'acceptance'});
    assert.equal(p.status,201);
    const s=await a.sse(`/v1/projects/${p.data.id}/generate`,{prompt:'Explain write-ahead logging.',model:{provider:'deterministic',model:'sim-text'},title:'WAL explainer'});
    assert.equal(s.status,200);
    const tokens=s.events.filter(e=>e.event==='token');
    assert.ok(tokens.length>5,'streamed several token events');
    const result=s.events.find(e=>e.event==='result').data;
    assert.equal(result.status,'succeeded');
    assert.equal(tokens.map(t=>t.data.text).join(''),result.output.text,'streamed text equals persisted output');
    assert.equal(result.output.simulated,true);
    // usage recorded
    const usage=(await a.get('/v1/usage')).data.usage;
    assert.ok(usage.find(u=>u.provider==='deterministic'&&u.calls>=1&&u.inputTokens>0&&u.outputTokens>0));
    // edit the artifact (new revision), keep history
    const art=(await a.get(`/v1/projects/${p.data.id}/artifacts/${result.artifactId}`)).data;
    assert.equal(art.body,result.output.text);
    const edited=await a.put(`/v1/projects/${p.data.id}/artifacts/${art.id}`,{text:art.body+'\n\nEdited by Alice.',expectedRevision:1});
    assert.equal(edited.status,200);assert.equal(edited.data.revision,2);
    const conflict=await a.put(`/v1/projects/${p.data.id}/artifacts/${art.id}`,{text:'stale',expectedRevision:1});
    assert.equal(conflict.status,409);
    ids={project:p.data.id,artifact:art.id,run:result.runId,token:a.token,tenant:a.tenantId};
  }finally{await app.stop();}
  // ---- full restart: new engine, new pools, new server ----
  app=await startApp(db);
  try{
    const a=client(app.base,{token:ids.token,tenant:ids.tenant});
    const list=await a.get('/v1/projects');
    assert.ok(list.data.items.some(x=>x.id===ids.project));
    const art=await a.get(`/v1/projects/${ids.project}/artifacts/${ids.artifact}`);
    assert.equal(art.data.revision,2);assert.match(art.data.body,/Edited by Alice/);
    const hist=await a.get(`/v1/projects/${ids.project}/artifacts/${ids.artifact}/revisions`);
    assert.equal(hist.data.items.length,2);
    const restored=await a.post(`/v1/projects/${ids.project}/artifacts/${ids.artifact}/restore`,{revision:1});
    assert.equal(restored.status,201);assert.equal(restored.data.revision,3);
    const run=await a.get(`/v1/runs/${ids.run}`);
    assert.equal(run.data.status,'succeeded');assert.equal(run.data.nodes[0].state,'succeeded');
    const events=await a.get(`/v1/runs/${ids.run}/events?stream=0`);
    assert.ok(events.data.items.some(e=>e.type==='run.succeeded'));
    assert.ok(events.data.items.some(e=>e.type==='node.delta'),'token deltas persisted for replay');
    const dl=await fetch(`${app.base}/v1/projects/${ids.project}/artifacts/${ids.artifact}/download`,{headers:{Authorization:'Bearer '+ids.token,'X-Tenant-Id':ids.tenant}});
    assert.equal(dl.status,200);assert.match(dl.headers.get('content-disposition'),/attachment/);
    // export -> import round trip
    const exp=await a.get(`/v1/projects/${ids.project}/export`);
    assert.equal(exp.status,200);assert.equal(exp.data.artifacts.length,1);assert.equal(exp.data.artifacts[0].revisions.length,3);
    const z=await fetch(`${app.base}/v1/projects/${ids.project}/export?format=zip`,{headers:{Authorization:'Bearer '+ids.token,'X-Tenant-Id':ids.tenant}});
    const zb=Buffer.from(await z.arrayBuffer());assert.equal(z.headers.get('content-type'),'application/zip');assert.equal(zb.readUInt32LE(0),0x04034b50);
    const {execFileSync}=await import('node:child_process');const {writeFileSync,mkdtempSync}=await import('node:fs');const dir=mkdtempSync('/tmp/sie-zip-');writeFileSync(dir+'/p.zip',zb);
    const listing=execFileSync('python3',['-c','import zipfile,sys;z=zipfile.ZipFile(sys.argv[1]);assert z.testzip() is None;print("\\n".join(z.namelist()))',dir+'/p.zip']).toString();
    assert.match(listing,/artifacts\/WAL explainer\.md/);assert.match(listing,/project\.json/);
    const imp=await a.post('/v1/projects/import',exp.data);
    assert.equal(imp.status,201);assert.equal(imp.data.artifactCount,1);
    const tampered=await a.post('/v1/projects/import',{...exp.data,project:{...exp.data.project,title:'tampered'}});
    assert.equal(tampered.status,422);
  }finally{await app.stop();await db.drop();}
});
