// Saved/versioned workflows (incl. scheduled), image inputs for agents across providers, asset GC.
import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {skip,freshDatabase,startApp,login} from '../helpers/harness.mjs';
import {startMockServices} from '../helpers/mock-services.mjs';

const SIM={provider:'deterministic',model:'sim-text'};
const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC','base64');

test('saved workflows, vision inputs and asset GC',{skip},async t=>{
  const db=await freshDatabase();const mock=await startMockServices();
  const app=await startApp(db,{...mock.env,OPENAI_COMPATIBLE_API_KEY:'sk-test-openai',OPENAI_COMPATIBLE_BASE_URL:mock.env.SIE_OPENAI_BASE_URL});
  const sql=new pg.Client({connectionString:db.url});await sql.connect();
  const a=await login(app.base,'alice');const p=(await a.post('/v1/projects',{title:'WF',kind:'workflow'})).data;
  const drain=id=>app.worker.drain(id,{timeoutMs:60000});
  try{
    await t.test('save, re-run with new inputs, version, run an old version, schedule',async()=>{
      const spec={title:'Brief',inputs:{topic:'default'},nodes:[{key:'w',type:'agent',model:SIM,instructions:'Brief on {{inputs.topic}}'}]};
      const w=await a.post(`/v1/projects/${p.id}/workflows`,{title:'Topic brief',spec});assert.equal(w.status,201,JSON.stringify(w.data));assert.equal(w.data.version,1);
      const r1=await a.post(`/v1/workflows/${w.data.id}/runs`,{inputs:{topic:'tidal power'}});assert.equal(r1.status,201);
      assert.equal(await drain(r1.data.id),'succeeded');
      const run1=(await a.get(`/v1/runs/${r1.data.id}`)).data;assert.match(run1.nodes[0].output.text,/tidal power/);assert.equal(run1.workflowId,w.data.id);assert.equal(run1.workflowVersion,1);
      const upd=await a.put(`/v1/workflows/${w.data.id}`,{spec:{...spec,nodes:[{...spec.nodes[0],instructions:'Detailed brief on {{inputs.topic}}'}]},expectedVersion:1});assert.equal(upd.data.version,2);
      assert.equal((await a.put(`/v1/workflows/${w.data.id}`,{title:'stale',expectedVersion:1})).status,409);
      assert.equal((await a.get(`/v1/workflows/${w.data.id}/versions`)).data.items.length,2);
      const r2=await a.post(`/v1/workflows/${w.data.id}/runs`,{inputs:{topic:'geothermal'},version:1});await drain(r2.data.id);
      const run2=(await a.get(`/v1/runs/${r2.data.id}`)).data;assert.doesNotMatch(run2.nodes[0].output.text,/Detailed/);assert.equal(run2.workflowVersion,1);
      const s=await a.post(`/v1/projects/${p.id}/schedules`,{title:'Nightly brief',cron:'0 2 * * *',workflowId:w.data.id});assert.equal(s.status,201,JSON.stringify(s.data));
      await sql.query("UPDATE schedules SET next_run_at=now()-interval '1 minute' WHERE id=$1",[s.data.id]);
      assert.equal(await app.engine.scheduler.tick(),1);
      const sr=(await a.get(`/v1/runs?projectId=${p.id}`)).data.items.find(x=>x.kind==='schedule');await drain(sr.id);
      assert.match((await a.get(`/v1/runs/${sr.id}`)).data.nodes[0].output.text,/Detailed brief/,'schedule uses the latest version');
      assert.equal((await a.del(`/v1/workflows/${w.data.id}`)).status,200);
    });
    const up=await fetch(`${app.base}/v1/projects/${p.id}/assets?title=diagram.png`,{method:'POST',headers:{Authorization:'Bearer '+a.token,'X-Tenant-Id':a.tenantId,'Content-Type':'image/png'},body:PNG});
    const img=(await up.json()).artifact;
    await t.test('agents receive image artifacts (simulator, OpenAI and Anthropic wire formats)',async()=>{
      const run=async model=>{const r=await a.post(`/v1/projects/${p.id}/runs`,{spec:{nodes:[{key:'v',type:'agent',model,instructions:'Describe the diagram',inputArtifacts:[img.id]}]}});await drain(r.data.id);return (await a.get(`/v1/runs/${r.data.id}`)).data;};
      const sim=await run(SIM);assert.match(sim.nodes[0].output.text,/Received 1 image\(s\): image\/png/);
      await sql.query('UPDATE budget_global SET hard_limit_micro=100000000');await sql.query('UPDATE budget_accounts SET funded_micro=100000000,hard_limit_micro=100000000 WHERE tenant_id=$1',[a.tenantId]);
      const oa=await run({provider:'openai',model:'gpt-4.1'});assert.equal(oa.status,'succeeded',oa.error);
      const oreq=mock.log.findLast(x=>x.path.endsWith('/chat/completions'));const parts=oreq.body.messages.find(m=>m.role==='user').content;
      assert.ok(parts.some(x=>x.type==='image_url'&&x.image_url.url===`data:image/png;base64,${PNG.toString('base64')}`));
      const an=await run({provider:'anthropic',model:'claude-sonnet-5-5'});assert.equal(an.status,'succeeded',an.error);
      const areq=mock.log.findLast(x=>x.path==='/anthropic/v1/messages');
      assert.ok(areq.body.messages[0].content.some(b=>b.type==='image'&&b.source.media_type==='image/png'&&b.source.data===PNG.toString('base64')));
      const cp=(await sql.query("SELECT checkpoint::text c FROM run_nodes WHERE run_id=$1",[an.id])).rows[0].c||'';
      assert.ok(!cp.includes(PNG.toString('base64')),'checkpoints hold asset references, not image bytes');
    });
    await t.test('upstream generated images flow into the next agent; non-vision models refuse',async()=>{
      const r=await a.post(`/v1/projects/${p.id}/runs`,{spec:{nodes:[{key:'img',type:'media',operation:'image',prompt:'a bridge',model:{provider:'deterministic',model:'sim-media'}},{key:'critic',type:'agent',model:SIM,dependsOn:['img'],instructions:'Critique the image'}]}});
      await drain(r.data.id);const run=(await a.get(`/v1/runs/${r.data.id}`)).data;
      assert.match(run.nodes.find(n=>n.key==='critic').output.text,/Received 1 image/);
      await sql.query("INSERT INTO model_prices(provider,model,input_micro_per_mtok,output_micro_per_mtok) VALUES('openai-compatible','text-only-llm',100000,100000)");app.engine.catalog.priceCache=null;
      const bad=await a.post(`/v1/projects/${p.id}/runs`,{spec:{nodes:[{key:'v',type:'agent',model:{provider:'openai-compatible',model:'text-only-llm'},instructions:'see',inputArtifacts:[img.id]}]}});
      await drain(bad.data.id);assert.match((await a.get(`/v1/runs/${bad.data.id}`)).data.error,/capability_unsupported/);
    });
    await t.test('asset blobs are garbage-collected after their project is deleted',async()=>{
      const q=(await a.post('/v1/projects',{title:'Temp',kind:'image'})).data;
      const unique=Buffer.concat([PNG,Buffer.from('gc-test')]);
      const res=await fetch(`${app.base}/v1/projects/${q.id}/assets`,{method:'POST',headers:{Authorization:'Bearer '+a.token,'X-Tenant-Id':a.tenantId,'Content-Type':'image/png'},body:unique});
      const asset=(await res.json()).asset;const file=join(app.storage,'assets',asset.sha256.slice(0,2),asset.sha256.slice(2,4),asset.sha256);
      assert.ok(existsSync(file));
      assert.equal((await app.engine.assets.gc({minAgeMs:0})).removed,0,'referenced blobs are kept');
      await a.del(`/v1/projects/${q.id}`);
      assert.ok((await app.engine.assets.gc({minAgeMs:0})).removed>=1);assert.ok(!existsSync(file));
      assert.ok(existsSync(join(app.storage,'assets',(await app.engine.assets.meta({tenantId:a.tenantId,assetId:img.assetId})).sha256.slice(0,2))),'other project assets untouched');
    });
  }finally{await sql.end();await app.stop();await mock.close();await db.drop();}
});
