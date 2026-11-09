// SDK against a live engine (simulator provider): the same calls Academy / Command Center make.
import test from 'node:test';
import assert from 'node:assert/strict';
import {EngineClient,EngineError} from '../src/index.mjs';
import {skip,freshDatabase,startApp} from '../../../test/helpers/harness.mjs';

test('SDK sends auth/tenant headers and surfaces errors',async()=>{
  const calls=[];const c=new EngineClient({baseUrl:'https://engine.test/',token:'sie_t',tenantId:'t1',product:'command',fetchImpl:async(url,o)=>{calls.push({url,o});return new Response(JSON.stringify({code:'nope',message:'Nope'}),{status:403});}});
  await assert.rejects(c.projects(),e=>e instanceof EngineError&&e.status===403&&e.code==='nope');
  assert.equal(calls[0].url,'https://engine.test/v1/projects');
  assert.equal(calls[0].o.headers.Authorization,'Bearer sie_t');assert.equal(calls[0].o.headers['X-Tenant-Id'],'t1');assert.equal(calls[0].o.headers['X-SIE-Product'],'command');
});

test('SDK end-to-end against the engine',{skip},async()=>{
  const db=await freshDatabase();const app=await startApp(db);
  const ac=new AbortController();const loop=app.worker.run({signal:ac.signal});
  try{
    const anon=new EngineClient({baseUrl:app.base});
    const {token}=await anon.devLogin('sdkuser');
    const me=new EngineClient({baseUrl:app.base,token});
    const tenant=(await me.tenants()).items[0];const c=me.forTenant(tenant.id);
    const p=await c.createProject({title:'SDK',kind:'writing'});
    let text='',result;
    for await(const ev of await c.generateStream(p.id,{prompt:'hello',model:{provider:'deterministic',model:'sim-text'}})){if(ev.event==='token')text+=ev.data.text;if(ev.event==='result')result=ev.data;}
    assert.equal(result.status,'succeeded');assert.equal(text,result.output.text);
    const run=await c.runOperation(p.id,'writing.poem',{topic:'rivers'},{model:{provider:'deterministic',model:'sim-text'}});
    const events=[];for await(const ev of await c.followRun(run.id))events.push(ev.event);
    assert.equal(events.at(-1),'run.succeeded');
    const done=await c.run(run.id);assert.equal(done.status,'succeeded');
    const arts=(await c.artifacts(p.id)).items;assert.ok(arts.length>=3);
    const dl=await c.downloadArtifact(p.id,arts[0].id);assert.ok(dl.bytes.length>0);
    const bundle=await c.exportProject(p.id);const copy=await c.importProject(bundle);assert.equal(copy.artifactCount,arts.length);
  }finally{ac.abort();await loop;await app.stop();await db.drop();}
});
