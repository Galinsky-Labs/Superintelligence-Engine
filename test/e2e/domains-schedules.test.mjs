// Every domain workspace operation compiles to a real run and completes (deterministic simulator
// for text/media; protocol mocks are covered elsewhere). Also: scheduled and conditional workflows.
import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {skip,freshDatabase,startApp,login} from '../helpers/harness.mjs';
import {Sandbox} from '../../packages/engine/src/sandbox.mjs';
import {parseCron,nextRun} from '../../packages/engine/src/scheduler.mjs';

const SIM={provider:'deterministic',model:'sim-text'};
const hasSandbox=Boolean(new Sandbox().backend);

test('domain workspaces execute real operations',{skip},async t=>{
  const db=await freshDatabase();const app=await startApp(db);
  const a=await login(app.base,'alice');
  try{
    const ws=(await a.get('/v1/workspaces')).data.items;
    for(const d of ['research','writing','legislation','code','data','image','music','video','voice','cross-media'])assert.ok(ws.find(w=>w.id===d)?.operations.length,`domain ${d} has operations`);
    const p=(await a.post('/v1/projects',{title:'Domains',kind:'cross-media'})).data;
    const op=async(id,input)=>{
      const r=await a.post(`/v1/projects/${p.id}/operations/${id}`,{input,model:SIM});
      assert.equal(r.status,201,`${id}: ${JSON.stringify(r.data)}`);
      const status=await app.worker.drain(r.data.id,{timeoutMs:90000});
      const run=(await a.get(`/v1/runs/${r.data.id}`)).data;
      assert.equal(status,'succeeded',`${id}: ${run.error}`);return run;
    };
    const cases=[
      ['research.brief',{question:'What limits battery energy density?'}],
      ['research.deep',{question:'Future of grid storage',maxAgents:3}],
      ['writing.poem',{topic:'tidal pools',form:'sonnet'}],
      ['writing.persuasive',{thesis:'Cities should fund libraries',length:300}],
      ['writing.fiction',{premise:'A lighthouse keeper receives letters from the future'}],
      ['legislation.draft',{subject:'Right to repair for farm equipment',jurisdiction:'State of Example'}],
      ['legislation.analyze',{text:'Section 1. All drones must be registered.'}],
      ['image.generate',{prompt:'A cathedral made of glass'}],
      ['image.art-direct',{brief:'Moody poster for a jazz night'}],
      ['music.compose',{idea:'A sea shanty about databases',durationSeconds:5}],
      ['video.generate',{prompt:'Clouds over mountains'}],
      ['voice.speak',{text:'Welcome to the engine.'}],
      ['crossmedia.campaign',{topic:'Community solar'}],
    ];
    for(const [id,input] of cases)await t.test(id,async()=>{
      const run=await op(id,input);
      assert.ok(run.output.artifactIds.length>=1,'produced artifacts');
      if(id.startsWith('image')){const n=run.nodes.find(x=>x.type==='media');assert.equal(n.output.mediaType,'image/png');}
      if(id==='voice.speak')assert.equal(run.nodes[0].output.mediaType,'audio/wav');
      if(id==='video.generate')assert.match(run.nodes[0].output.mediaType,/video\/mp4|image\/png/);
      if(id==='legislation.draft')assert.ok(run.nodes.find(n=>n.key==='draft').output.data.sections.length>=1);
    });
    await t.test('voice.transcribe uses an uploaded audio asset',async()=>{
      const speak=await op('voice.speak',{text:'Transcribe me'});
      const assetId=speak.nodes[0].output.assetId;
      const run=await op('voice.transcribe',{assetId});assert.match(run.nodes[0].output.text,/SIMULATED TRANSCRIPT/);
    });
    await t.test('writing.revise saves a new revision of the same artifact',async()=>{
      const art=(await a.post(`/v1/projects/${p.id}/artifacts`,{title:'Draft',text:'Original text.'})).data;
      await op('writing.revise',{artifactId:art.id,instructions:'Make it formal'});
      const after=(await a.get(`/v1/projects/${p.id}/artifacts/${art.id}`)).data;assert.equal(after.revision,2);
      assert.equal((await a.get(`/v1/projects/${p.id}/artifacts/${art.id}/revisions`)).data.items.length,2);
    });
    await t.test('data.analyze places the dataset in the workspace',{skip:!hasSandbox&&'no sandbox'},async()=>{
      const run=await op('data.analyze',{question:'Average price?',data:'item,price\na,10\nb,20\n'});
      assert.equal((await a.get(`/v1/projects/${p.id}/files/data/input.csv`)).data.content,'item,price\na,10\nb,20\n');
      assert.ok(run.output.artifactIds.length);
    });
    await t.test('code.build runs the coding agent then a real sandboxed verification step',{skip:!hasSandbox&&'no sandbox'},async()=>{
      // Seed passing tests so the verification node has something real to run with the simulator.
      await a.put(`/v1/projects/${p.id}/files/test_seed.py`,{content:'import unittest\nclass T(unittest.TestCase):\n    def test_ok(self):\n        self.assertTrue(True)\n'});
      const run=await op('code.build',{task:'a string reverser',language:'python'});
      const verify=run.nodes.find(n=>n.key==='verify');assert.equal(verify.output.exitCode,0);assert.match(verify.output.stderr,/OK/);
    });
    await t.test('invalid operation input is rejected',async()=>{
      assert.equal((await a.post(`/v1/projects/${p.id}/operations/writing.poem`,{input:{}})).status,400);
      assert.equal((await a.post(`/v1/projects/${p.id}/operations/nope`,{input:{}})).status,404);
    });
  }finally{await app.stop();await db.drop();}
});

test('cron parsing',()=>{
  assert.throws(()=>parseCron('* * *'));
  assert.throws(()=>parseCron('61 * * * *'));
  const n=nextRun('30 9 * * 1','UTC',new Date('2026-11-09T10:00:00Z'));assert.equal(n.toISOString(),'2026-11-16T09:30:00.000Z');
  assert.equal(nextRun('*/15 * * * *','UTC',new Date('2026-11-09T10:07:00Z')).toISOString(),'2026-11-09T10:15:00.000Z');
  assert.equal(nextRun('0 9 * * *','America/New_York',new Date('2026-11-09T12:00:00Z')).toISOString(),'2026-11-09T14:00:00.000Z');
});

test('scheduled and conditional workflows',{skip},async()=>{
  const db=await freshDatabase();const app=await startApp(db);const sql=new pg.Client({connectionString:db.url});await sql.connect();
  const a=await login(app.base,'alice');const p=(await a.post('/v1/projects',{title:'Sched',kind:'workflow'})).data;
  try{
    const spec={title:'Daily digest',nodes:[{key:'digest',type:'agent',model:SIM,instructions:'Write the digest for {{inputs.scheduledAt}}'}]};
    const s=await a.post(`/v1/projects/${p.id}/schedules`,{title:'Digest',cron:'0 7 * * *',timezone:'UTC',spec});
    assert.equal(s.status,201,JSON.stringify(s.data));
    await sql.query('UPDATE schedules SET next_run_at=now()-interval \'1 minute\' WHERE id=$1',[s.data.id]);
    assert.equal(await app.engine.scheduler.tick(),1);
    assert.equal(await app.engine.scheduler.tick(),0,'occurrence fires once');
    const runs=(await a.get(`/v1/runs?projectId=${p.id}`)).data.items;assert.equal(runs.length,1);assert.equal(runs[0].kind,'schedule');
    assert.equal(await app.worker.drain(runs[0].id),'succeeded');
    const after=(await a.get('/v1/schedules')).data.items[0];assert.ok(new Date(after.nextRunAt)>new Date());
    // conditional: only when a watched artifact changes
    const art=(await a.post(`/v1/projects/${p.id}/artifacts`,{title:'Watched',text:'v1'})).data;
    const c=(await a.post(`/v1/projects/${p.id}/schedules`,{title:'On change',cron:'*/5 * * * *',spec,condition:{artifactChanged:art.id}})).data;
    const due=()=>sql.query('UPDATE schedules SET next_run_at=now()-interval \'1 minute\' WHERE id=$1',[c.id]);
    await due();assert.equal(await app.engine.scheduler.tick(),1,'first evaluation fires');
    await due();assert.equal(await app.engine.scheduler.tick(),0,'unchanged artifact does not fire');
    await a.put(`/v1/projects/${p.id}/artifacts/${art.id}`,{text:'v2'});
    await due();assert.equal(await app.engine.scheduler.tick(),1,'changed artifact fires');
    assert.equal((await a.patch(`/v1/schedules/${c.id}`,{enabled:false})).data.enabled,false);
    assert.equal((await a.post(`/v1/projects/${p.id}/schedules`,{title:'bad',cron:'nope',spec})).status,400);
  }finally{await sql.end();await app.stop();await db.drop();}
});
