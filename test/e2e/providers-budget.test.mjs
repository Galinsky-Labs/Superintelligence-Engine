// Provider integrations over their real wire protocols (against local protocol mocks — NOT live
// providers), budget enforcement (global cap, tenant funding, run ceiling), usage settlement,
// tool calling, structured output, media generation and credential handling.
import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {skip,freshDatabase,startApp,login,client} from '../helpers/harness.mjs';
import {startMockServices} from '../helpers/mock-services.mjs';

test('providers and budgets',{skip},async t=>{
  const db=await freshDatabase();const mock=await startMockServices();
  const app=await startApp(db,mock.env);
  const sql=new pg.Client({connectionString:db.url});await sql.connect();
  const a=await login(app.base,'alice');
  const p=(await a.post('/v1/projects',{title:'Paid',kind:'research'})).data;
  const gen=body=>a.sse(`/v1/projects/${p.id}/generate`,body);
  const result=s=>s.events.find(e=>e.event==='result'||e.event==='error').data;
  const account=async()=>(await sql.query('SELECT * FROM budget_accounts WHERE tenant_id=$1',[a.tenantId])).rows[0];
  try{
    await t.test('zero operating budget blocks paid calls before any provider request',async()=>{
      const before=mock.log.length;
      const r=result(await gen({prompt:'hi',model:{provider:'openai',model:'gpt-4.1'}}));
      assert.equal(r.status,'failed');assert.match(r.error,/global_limit_exceeded/);
      assert.equal(mock.log.slice(before).filter(x=>x.path.includes('chat/completions')).length,0);
      const caps=(await a.get('/v1/capabilities')).data;assert.equal(caps.generationEnabled,true,'configured real provider reported');
    });
    await sql.query('UPDATE budget_global SET hard_limit_micro=10000000');
    await t.test('tenant without funds is still blocked',async()=>{
      const r=result(await gen({prompt:'hi',model:{provider:'openai',model:'gpt-4.1'}}));assert.match(r.error,/tenant_limit_exceeded/);
    });
    await sql.query('UPDATE budget_accounts SET funded_micro=5000000,hard_limit_micro=5000000 WHERE tenant_id=$1',[a.tenantId]);
    await t.test('OpenAI streaming generation settles exact token cost',async()=>{
      const s=await gen({prompt:'Say hello',model:{provider:'openai',model:'gpt-4.1'}});
      const r=result(s);assert.equal(r.status,'succeeded',JSON.stringify(r));
      assert.equal(r.output.text,'Hello from the OpenAI wire mock.');
      assert.equal(s.events.filter(e=>e.event==='token').map(e=>e.data.text).join(''),r.output.text);
      assert.equal(r.costMicro,6000,'1000 in * $2/M + 500 out * $8/M = $0.006');
      const acct=await account();assert.equal(Number(acct.spent_micro),6000);assert.equal(Number(acct.reserved_micro),0);
      const call=mock.log.findLast(x=>x.path.endsWith('/chat/completions'));
      assert.equal(call.body.stream,true);assert.equal(call.body.model,'gpt-4.1');
      assert.equal(r.output.model.model,'gpt-4.1-2026','served model revision recorded');
      const art=(await a.get(`/v1/projects/${p.id}/artifacts/${r.artifactId}`)).data;
      assert.equal(art.provenance.provider,'openai');assert.equal(art.provenance.simulated,false);
    });
    await t.test('run budget ceiling is enforced',async()=>{
      const r=result(await gen({prompt:'expensive',model:{provider:'openai',model:'gpt-4.1'},budgetCeilingMicro:1000}));
      assert.match(r.error,/run_budget_exceeded/);
    });
    await t.test('OpenAI tool calling loop executes the tool and finishes',async()=>{
      const r=result(await gen({prompt:'Please use the calculator for 6 times 7',model:{provider:'openai',model:'gpt-4.1-mini'},tools:['calculator']}));
      assert.equal(r.status,'succeeded',JSON.stringify(r));assert.equal(r.output.text,'The calculator says 42.');
      assert.equal(r.output.usage.toolCalls,1);assert.equal(r.output.usage.calls,2);
      const second=mock.log.findLast(x=>x.path.endsWith('/chat/completions'));
      assert.ok(second.body.messages.some(m=>m.role==='tool'&&m.tool_call_id==='call_1'));
    });
    await t.test('OpenAI structured output uses json_schema and validates',async()=>{
      const r=result(await gen({prompt:'structured',model:{provider:'openai',model:'gpt-4.1'},outputSchema:{type:'object',properties:{answer:{type:'string'},confidence:{type:'number'}},required:['answer','confidence']}}));
      assert.deepEqual(r.output.data,{answer:'forty-two',confidence:0.9});
      assert.equal(mock.log.findLast(x=>x.path.endsWith('/chat/completions')).body.response_format.type,'json_schema');
    });
    await t.test('Anthropic via official SDK: streaming, usage, tool loop, structured output',async()=>{
      const r=result(await gen({prompt:'hello',model:{provider:'anthropic',model:'claude-sonnet-5-5'}}));
      assert.equal(r.status,'succeeded',JSON.stringify(r));assert.equal(r.output.text,'Hello from the Anthropic wire mock.');
      assert.equal(r.costMicro,1400,'200 in * $2/M + 100 out * $10/M');
      const req=mock.log.findLast(x=>x.path==='/anthropic/v1/messages');assert.equal(req.body.stream,true);assert.ok(!('thinking' in req.body));
      assert.ok(req.headers['anthropic-version']);
      const tr=result(await gen({prompt:'add',model:{provider:'anthropic',model:'claude-opus-5-5'},tools:['calculator']}));
      assert.equal(tr.status,'succeeded',JSON.stringify(tr));assert.equal(tr.output.usage.toolCalls,1);
      const followup=mock.log.findLast(x=>x.path==='/anthropic/v1/messages');
      const resultBlock=followup.body.messages.at(-1).content[0];assert.equal(resultBlock.type,'tool_result');assert.equal(resultBlock.tool_use_id,'toolu_1');
      assert.equal(JSON.parse(resultBlock.content).result,5);
      const assistant=followup.body.messages.at(-2);assert.ok(assistant.content.some(b=>b.type==='tool_use'),'assistant content replayed verbatim');
      const sr=result(await gen({prompt:'json',model:{provider:'anthropic',model:'claude-haiku-5-5'},outputSchema:{type:'object',properties:{answer:{type:'string'},confidence:{type:'number'}},required:['answer']}}));
      assert.equal(sr.output.data.answer,'structured');
      assert.equal(mock.log.findLast(x=>x.path==='/anthropic/v1/messages').body.output_config.format.type,'json_schema');
    });
    await t.test('Gemini streaming',async()=>{
      const r=result(await gen({prompt:'hi',model:{provider:'gemini',model:'gemini-2.5-flash'}}));
      assert.equal(r.output.text,'Hello from Gemini mock.');assert.equal(r.costMicro,Math.ceil((80*300000+20*2500000)/1e6));
    });
    await t.test('media: image, speech, transcription, unknown price refusal, async video',async()=>{
      const run=async spec=>{const r=await a.post(`/v1/projects/${p.id}/runs`,{spec});await app.worker.drain(r.data.id,{timeoutMs:60000});return (await a.get(`/v1/runs/${r.data.id}`)).data;};
      const img=await run({nodes:[{key:'i',type:'media',operation:'image',prompt:'a lighthouse',model:{provider:'openai',model:'gpt-image-1'}}]});
      assert.equal(img.status,'succeeded',img.error);assert.equal(img.nodes[0].output.mediaType,'image/png');
      const bytes=Buffer.from(await (await fetch(`${app.base}/v1/assets/${img.nodes[0].output.assetId}`,{headers:{Authorization:'Bearer '+a.token,'X-Tenant-Id':a.tenantId}})).arrayBuffer());
      assert.equal(bytes.subarray(1,4).toString(),'PNG');
      const sp=await run({nodes:[{key:'s',type:'media',operation:'speech',prompt:'Hello world',model:{provider:'openai',model:'tts-1'}},{key:'t',type:'media',operation:'transcribe',dependsOn:['s'],model:{provider:'openai',model:'whisper-1'}}]});
      assert.equal(sp.status,'succeeded',sp.error);assert.equal(sp.nodes.find(n=>n.key==='t').output.text,'mock transcript');
      const el=await run({nodes:[{key:'v',type:'media',operation:'speech',prompt:'hi',model:{provider:'elevenlabs',model:'eleven_multilingual_v2'}}]});
      assert.match(el.error,/price_unknown/);
      await sql.query("INSERT INTO model_prices(provider,model,unit_micro) VALUES('elevenlabs','eleven_multilingual_v2',300),('replicate','minimax/video-01',500000)");
      app.engine.catalog.priceCache=null;
      const el2=await run({nodes:[{key:'v',type:'media',operation:'speech',prompt:'hi',model:{provider:'elevenlabs',model:'eleven_multilingual_v2'}}]});
      assert.equal(el2.status,'succeeded',el2.error);assert.equal(el2.spentMicro,600);
      const vid=await run({nodes:[{key:'v',type:'media',operation:'video',prompt:'waves',model:{provider:'replicate',model:'minimax/video-01'}}]});
      assert.equal(vid.status,'succeeded',vid.error);assert.equal(vid.nodes[0].output.mediaType,'video/mp4');
      assert.ok(mock.log.filter(x=>/\/predictions\/pred/.test(x.path)).length>=3,'polled asynchronously');
    });
    await t.test('tenant credentials: admin-only, encrypted, never returned; bad key releases reservation',async()=>{
      const bob=await login(app.base,'bob');
      await a.put(`/v1/tenants/${a.tenantId}/members`,{identityId:bob.identityId,role:'member'});
      const asBob=client(app.base,{token:bob.token,tenant:a.tenantId});
      assert.equal((await asBob.put('/v1/providers/openai',{apiKey:'sk-whatever-1234'})).status,403);
      const set=await a.put('/v1/providers/openai',{apiKey:'sk-wrong-key-9999',baseUrl:mock.env.SIE_OPENAI_BASE_URL});
      assert.equal(set.status,200);assert.equal(set.data.fingerprint,'…9999');
      const list=JSON.stringify((await a.get('/v1/providers')).data);assert.ok(!list.includes('sk-wrong'));
      const stored=(await sql.query("SELECT ciphertext FROM provider_credentials WHERE provider='openai'")).rows[0].ciphertext;
      assert.ok(!stored.toString('latin1').includes('sk-wrong'),'ciphertext at rest');
      const before=await account();
      const r=result(await gen({prompt:'hi',model:{provider:'openai',model:'gpt-4.1'}}));
      assert.match(r.error,/provider_auth_failed/);
      const after=await account();assert.equal(after.spent_micro,before.spent_micro);assert.equal(Number(after.reserved_micro),0);
      await a.del('/v1/providers/openai');
      const disc=await a.get('/v1/providers/openai/models');assert.deepEqual(disc.data.models,['gpt-4.1','gpt-4.1-mini']);
    });
  }finally{await sql.end();await app.stop();await mock.close();await db.drop();}
});
