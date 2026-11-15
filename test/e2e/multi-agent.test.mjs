// Acceptance: coordinated multi-agent execution — planner delegation, parallel workers,
// output exchange, persisted intermediates, final synthesized artifact; cancellation, retry, recovery.
import test from 'node:test';
import assert from 'node:assert/strict';
import {skip,freshDatabase,startApp,login} from '../helpers/harness.mjs';

const SIM={provider:'deterministic',model:'sim-text'};

test('multi-agent orchestration',{skip},async t=>{
  const db=await freshDatabase();const app=await startApp(db,{SIE_SIM_DELAY_MS:'3'});
  const a=await login(app.base,'alice');
  const p=(await a.post('/v1/projects',{title:'Agents',kind:'workflow'})).data;
  try{
    await t.test('fixed DAG: fan-out, conditional branch, structured exchange, fan-in',async()=>{
      const spec={title:'Market study',inputs:{topic:'solid-state batteries'},nodes:[
        {key:'scope',type:'agent',model:SIM,instructions:'Define research scope for {{inputs.topic}}',outputSchema:{type:'object',properties:{questions:{type:'array',items:{type:'string'}},priority:{type:'integer'}},required:['questions','priority']}},
        {key:'tech',type:'agent',model:SIM,dependsOn:['scope'],instructions:'Analyze technology for: {{nodes.scope.data.questions}}'},
        {key:'market',type:'agent',model:SIM,dependsOn:['scope'],instructions:'Analyze market'},
        {key:'risks',type:'agent',model:SIM,dependsOn:['scope'],instructions:'Analyze risks'},
        {key:'never',type:'agent',model:SIM,dependsOn:['scope'],when:{node:'scope',path:'priority',op:'gt',value:1000},instructions:'Should be skipped'},
        {key:'report',type:'agent',model:SIM,dependsOn:['tech','market','risks','never'],instructions:'Write the final report combining all analyses',artifact:{title:'Final report'}},
      ]};
      const r=await a.post(`/v1/projects/${p.id}/runs`,{spec,idempotencyKey:'study-1'});
      assert.equal(r.status,201);
      const again=await a.post(`/v1/projects/${p.id}/runs`,{spec,idempotencyKey:'study-1'});
      assert.equal(again.data.id,r.data.id,'idempotent run creation');
      assert.equal(await app.worker.drain(r.data.id),'succeeded');
      const run=(await a.get(`/v1/runs/${r.data.id}`)).data;
      const by=Object.fromEntries(run.nodes.map(n=>[n.key,n]));
      assert.equal(by.never.state,'skipped');
      for(const k of ['scope','tech','market','risks','report'])assert.equal(by[k].state,'succeeded',k);
      // parallel: the three middle agents overlapped in time
      const mids=['tech','market','risks'].map(k=>by[k]);
      const overlap=mids.some(x=>mids.some(y=>x!==y&&new Date(x.startedAt)<new Date(y.finishedAt)&&new Date(y.startedAt)<new Date(x.finishedAt)));
      assert.ok(overlap,'independent agents executed concurrently');
      // output exchange: report prompt included upstream outputs (the simulator echoes its prompt)
      assert.match(by.report.output.text,/Results from earlier steps/);
      assert.match(by.tech.output.text,/questions/,'template injected structured upstream data');
      // intermediate artifacts persisted
      const arts=(await a.get(`/v1/projects/${p.id}/artifacts`)).data.items;
      assert.ok(arts.length>=5);assert.ok(arts.some(x=>x.title==='Final report'));
      assert.ok(run.output.results.report.artifactId);
    });

    await t.test('planner delegates to dynamically created parallel agents and a synthesizer',async()=>{
      const spec={title:'Deep dive',nodes:[{key:'plan',type:'planner',model:SIM,maxTasks:4,instructions:'Investigate fusion energy timelines',worker:{model:SIM},synthesis:{title:'Synthesis',model:SIM}},
        {key:'publish',type:'agent',model:SIM,dependsOn:['plan'],instructions:'Prepare the final summary for publication'}]};
      const r=await a.post(`/v1/projects/${p.id}/runs`,{spec});
      assert.equal(await app.worker.drain(r.data.id),'succeeded');
      const run=(await a.get(`/v1/runs/${r.data.id}`)).data;
      const spawned=run.nodes.filter(n=>n.parent==='plan');
      assert.ok(spawned.length>=2,'planner spawned subtask agents');
      const synth=run.nodes.find(n=>n.key==='plan.synthesis');
      assert.equal(synth.state,'succeeded');
      for(const s of spawned.filter(n=>n.key!=='plan.synthesis'))assert.ok(synth.dependsOn.includes(s.key));
      const publish=run.nodes.find(n=>n.key==='publish');
      assert.ok(publish.dependsOn.includes('plan.synthesis'),'downstream rewired to wait for synthesis');
      assert.ok(new Date(publish.startedAt)>=new Date(synth.finishedAt));
      const ev=(await a.get(`/v1/runs/${r.data.id}/events?stream=0`)).data.items;
      assert.ok(ev.some(e=>e.type==='node.delegated'));
    });

    await t.test('large fan-out runs many agents concurrently',async()=>{
      const n=40;const nodes=Array.from({length:n},(_,i)=>({key:'w'+i,type:'agent',model:SIM,instructions:'Worker '+i,artifact:false}));
      nodes.push({key:'sum',type:'agent',model:SIM,dependsOn:nodes.map(x=>x.key),instructions:'Summarize all workers',artifact:false});
      const r=await a.post(`/v1/projects/${p.id}/runs`,{spec:{title:'fanout',nodes}});
      const t0=Date.now();assert.equal(await app.worker.drain(r.data.id,{timeoutMs:120000}),'succeeded');
      const run=(await a.get(`/v1/runs/${r.data.id}`)).data;
      assert.equal(run.nodes.filter(x=>x.state==='succeeded').length,n+1);
      const maxConcurrent=Math.max(...run.nodes.map(x=>run.nodes.filter(y=>new Date(y.startedAt)<=new Date(x.startedAt)&&new Date(y.finishedAt)>new Date(x.startedAt)).length));
      assert.ok(maxConcurrent>=8,`expected real concurrency, saw ${maxConcurrent}`);
      t.diagnostic(`fan-out ${n} agents in ${Date.now()-t0}ms, max concurrency ${maxConcurrent}`);
    });

    await t.test('cancellation stops queued and running work',async()=>{
      const slow=await startApp(db,{SIE_SIM_DELAY_MS:'40'});
      try{
        const r=await a.post(`/v1/projects/${p.id}/runs`,{spec:{title:'cancel me',nodes:[{key:'long',type:'agent',model:SIM,instructions:'word '.repeat(400)},{key:'after',type:'agent',model:SIM,dependsOn:['long'],instructions:'never'}]}});
        const drain=slow.worker.drain(r.data.id,{timeoutMs:30000});
        await new Promise(res=>setTimeout(res,400));
        const c=await a.post(`/v1/runs/${r.data.id}/cancel`);
        assert.equal(c.status,200);
        assert.equal(await drain,'cancelled');
        const run=(await a.get(`/v1/runs/${r.data.id}`)).data;
        assert.deepEqual(run.nodes.map(n=>n.state).sort(),['cancelled','cancelled']);
        const ev=(await a.get(`/v1/runs/${r.data.id}/events?stream=0`)).data.items;
        assert.ok(ev.some(e=>e.type==='node.delta'),'was streaming before cancel');
        assert.equal((await a.post(`/v1/runs/${r.data.id}/cancel`)).status,409);
        // retry resumes the cancelled run to completion
        const rt=await a.post(`/v1/runs/${r.data.id}/retry`);assert.equal(rt.status,200);
        assert.equal(await app.worker.drain(r.data.id,{timeoutMs:60000}),'succeeded');
      }finally{await slow.stop();}
    });

    await t.test('worker crash: expired lease is recovered and the node completes',async()=>{
      const r=await a.post(`/v1/projects/${p.id}/runs`,{spec:{title:'crash',nodes:[{key:'x',type:'agent',model:SIM,instructions:'survive'}]}});
      // simulate a worker that claimed the node and died
      const claimed=await app.engine.runs.claim({workerId:'dead-worker',limit:1,leaseSeconds:1});
      assert.equal(claimed.length,1);
      await new Promise(res=>setTimeout(res,1500));
      app.worker.lastMaintenance=0;
      assert.equal(await app.worker.drain(r.data.id),'succeeded');
      const ev=(await a.get(`/v1/runs/${r.data.id}/events?stream=0`)).data.items;
      assert.ok(ev.some(e=>e.type==='node.recovered'));
      const run=(await a.get(`/v1/runs/${r.data.id}`)).data;assert.equal(run.nodes[0].attempt,2);
    });

    await t.test('failure handling: invalid model fails without retry storm and run reports error',async()=>{
      const r=await a.post(`/v1/projects/${p.id}/runs`,{spec:{title:'bad',nodes:[{key:'x',type:'agent',model:{provider:'openai',model:'gpt-4.1'},instructions:'hi'},{key:'y',type:'agent',model:SIM,dependsOn:['x'],instructions:'never'}]}});
      assert.equal(await app.worker.drain(r.data.id),'failed');
      const run=(await a.get(`/v1/runs/${r.data.id}`)).data;
      assert.match(run.nodes.find(n=>n.key==='x').error,/provider_unconfigured/);
      assert.equal(run.nodes.find(n=>n.key==='y').state,'cancelled');
      assert.match(run.error,/provider_unconfigured/);
    });

    await t.test('live SSE stream replays and follows a run to completion',async()=>{
      const r=await a.post(`/v1/projects/${p.id}/runs`,{spec:{title:'sse',nodes:[{key:'a',type:'agent',model:SIM,instructions:'stream me'},{key:'b',type:'agent',model:SIM,dependsOn:['a'],instructions:'then me'}]}});
      const streamP=a.sse(`/v1/runs/${r.data.id}/events`);
      await app.worker.drain(r.data.id);
      const s=await streamP;
      const types=s.events.map(e=>e.event);
      assert.ok(types.includes('replay-end'));assert.ok(types.includes('node.delta'));assert.equal(types.at(-1),'run.succeeded');
    });
  }finally{await app.stop();await db.drop();}
});
