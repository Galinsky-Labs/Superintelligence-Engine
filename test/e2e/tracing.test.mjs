// OTLP/HTTP trace export: API request spans continue W3C traceparent; each run is one trace with
// node spans and gen_ai provider-call spans carrying token usage.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {skip,freshDatabase,startApp,login} from '../helpers/harness.mjs';
import {tracer} from '../../packages/engine/src/tracing.mjs';

test('OpenTelemetry traces are exported',{skip},async()=>{
  const spans=[];
  const col=createServer((req,res)=>{let b='';req.on('data',d=>b+=d);req.on('end',()=>{if(req.url==='/v1/traces')for(const rs of JSON.parse(b).resourceSpans)for(const ss of rs.scopeSpans)spans.push(...ss.spans.map(s=>({...s,service:rs.resource.attributes.find(a=>a.key==='service.name').value.stringValue})));res.end('{}');});});
  await new Promise(r=>col.listen(0,'127.0.0.1',r));
  const db=await freshDatabase();const app=await startApp(db,{OTEL_EXPORTER_OTLP_ENDPOINT:`http://127.0.0.1:${col.address().port}`});
  try{
    const a=await login(app.base,'tracy');const p=(await a.post('/v1/projects',{title:'T',kind:'workflow'})).data;
    const parent='00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
    const res=await fetch(app.base+'/v1/projects',{headers:{Authorization:'Bearer '+a.token,'X-Tenant-Id':a.tenantId,traceparent:parent}});
    assert.match(res.headers.get('traceparent'),/^00-0af7651916cd43dd8448eb211c80319c-/);
    const r=await a.post(`/v1/projects/${p.id}/runs`,{spec:{nodes:[{key:'a',type:'agent',model:{provider:'deterministic',model:'sim-text'},instructions:'x'},{key:'b',type:'agent',dependsOn:['a'],model:{provider:'deterministic',model:'sim-text'},instructions:'y'}]}});
    await app.worker.drain(r.data.id);await tracer.flush();
    const traceId=r.data.id.replace(/-/g,'');
    const http=spans.find(s=>s.traceId==='0af7651916cd43dd8448eb211c80319c');assert.equal(http.parentSpanId,'b7ad6b7169203331');assert.equal(http.service,'superintelligence-engine');
    const nodes=spans.filter(s=>s.traceId===traceId&&s.name==='node agent');assert.equal(nodes.length,2);
    const chats=spans.filter(s=>s.traceId===traceId&&s.name==='chat sim-text');assert.equal(chats.length,2);
    assert.ok(nodes.some(n=>n.spanId===chats[0].parentSpanId));
    assert.ok(chats[0].attributes.some(x=>x.key==='gen_ai.usage.input_tokens'&&Number(x.value.intValue)>0));
  }finally{tracer.configure({});await app.stop();await db.drop();col.close();}
});
