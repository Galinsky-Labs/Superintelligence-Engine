import test from 'node:test';import assert from 'node:assert/strict';
import {OpenAIResponsesTextAdapter} from '../src/index.mjs';
import {ProviderAdapters,EnvironmentCredentialProvider,ProviderError} from '../../providers/src/index.mjs';
function sse(events){
 const text=events.map(x=>'event: '+x.type+'\ndata: '+JSON.stringify(x)+'\n\n').join('');
 const bytes=new TextEncoder().encode(text);
 return new ReadableStream({start(c){const mid=Math.floor(bytes.length/2);c.enqueue(bytes.slice(0,mid));c.enqueue(bytes.slice(mid));c.close()}});
}
const complete={type:'response.completed',response:{id:'resp_test_123',model:'approved-model',usage:{input_tokens:17,output_tokens:3}}};
test('real Responses SSE adapter streams deltas, reports trustworthy usage, disables store/tools',async()=>{
 let outbound;
 const adapter=new OpenAIResponsesTextAdapter({modelId:'approved-model',fetchImpl:async(url,opts)=>{outbound={url,opts};
 return new Response(sse([{type:'response.created'},{type:'response.output_text.delta',delta:'Hello '},{type:'response.output_text.delta',delta:'world'},complete]),{headers:{'content-type':'text/event-stream'}})}});
 const stream=[];for await(const e of adapter.stream({operation:'text.generate',input:{prompt:'Say hello'},credential:'secret-test',options:{maxOutputTokens:100}}))stream.push(e);
 assert.deepEqual(stream,[{type:'token',text:'Hello '},{type:'token',text:'world'}, {type:'usage',inputUnits:17,outputUnits:3},{type:'complete',responseId:'resp_test_123',modelRevision:'approved-model'}]);
 assert.equal(outbound.url,'https://api.openai.com/v1/responses');
 assert.equal(outbound.opts.redirect,'error');
 assert.equal(outbound.opts.headers.Authorization,'Bearer secret-test');
 const body=JSON.parse(outbound.opts.body);assert.equal(body.store,false);assert.equal(body.stream,true);
 assert.equal(body.max_output_tokens,100);assert.equal(body.tools,undefined);
});
test('provider budget authorization must succeed before any paid network request',async()=>{
 let calls=0;
 const adapter=new OpenAIResponsesTextAdapter({modelId:'approved-model',fetchImpl:async()=>{calls++;throw Error('must not call')}});
 const provider=new ProviderAdapters({secrets:new EnvironmentCredentialProvider({PROVIDER_OPENAI_API_KEY:'secret-test'}),budgetAuthority:{check:async()=>({authorized:false})}});
 provider.register({descriptor:{id:'openai-text',model:'approved-model',revision:'2026-10',operations:['text.generate'],licenseScope:'commercial',regions:['us'],priceMicrounits:200},adapter,secretRef:'PROVIDER_OPENAI_API_KEY'});
 await assert.rejects(async()=>{for await(const item of provider.stream({providerId:'openai-text',operation:'text.generate',tenantId:'tenant',reservationId:'reservation',region:'us',commercial:true,input:'hello'})){}},e=>e.code==='budget_denied');
 assert.equal(calls,0);
});
test('incomplete stream, missing usage, refusal and invalid model do not report success',async()=>{
 assert.throws(()=>new OpenAIResponsesTextAdapter({modelId:''}));
 for(const events of [
   [{type:'response.output_text.delta',delta:'partial'}],
   [{type:'response.completed',response:{id:'x',model:'approved-model'}}],
   [{type:'response.failed',response:{id:'x'}}]
 ]){
  const adapter=new OpenAIResponsesTextAdapter({modelId:'approved-model',fetchImpl:async()=>new Response(sse(events),{headers:{'content-type':'text/event-stream'}})});
  await assert.rejects(async()=>{for await(const event of adapter.stream({operation:'text.generate',input:'hello',credential:'key'})){}},error=>error instanceof ProviderError);
 }
});
test('text calls reject enormous prompts, unbounded output and disabled background submit',async()=>{
 let calls=0;const adapter=new OpenAIResponsesTextAdapter({modelId:'approved-model',fetchImpl:async()=>{calls++;throw Error('unexpected')}});
 await assert.rejects(async()=>{for await(const x of adapter.stream({operation:'text.generate',input:'hi',credential:'key',options:{maxOutputTokens:500000}})){}},e=>e.code==='output_limit');
 await assert.rejects(async()=>{for await(const x of adapter.stream({operation:'text.generate',input:'x'.repeat(100001),credential:'key'})){}},e=>e.code==='invalid_input');
 await assert.rejects(adapter.submit(),e=>e.code==='async_not_supported');
 assert.equal(calls,0);
});

test('structured format requires explicit model capability and forwards only a validated closed schema',async()=>{
 let body,calls=0;
 const fetchImpl=async(url,request)=>{calls++;body=JSON.parse(request.body);return new Response(sse([
  {type:'response.output_text.delta',delta:'{"answer":"ok"}'},complete]),{headers:{'content-type':'text/event-stream'}})};
 const textFormat={type:'json_schema',name:'answer',strict:true,schema:{type:'object',properties:{answer:{type:'string'}},required:['answer'],additionalProperties:false}};
 const disabled=new OpenAIResponsesTextAdapter({modelId:'approved-model',fetchImpl});
 await assert.rejects(async()=>{for await(const e of disabled.stream({operation:'text.generate',input:'return JSON',credential:'synthetic',options:{textFormat}})){}},e=>e.code==='structured_format_denied');
 assert.equal(calls,0);
 const enabled=new OpenAIResponsesTextAdapter({modelId:'approved-model',fetchImpl,structuredOutputs:true});
 const events=[];for await(const e of enabled.stream({operation:'text.generate',input:'return JSON',credential:'synthetic',options:{textFormat}}))events.push(e);
 assert.deepEqual(body.text.format,textFormat);assert.equal(body.tools,undefined);assert.equal(body.store,false);
 assert.equal(events.at(-1).type,'complete');
 const bad={...textFormat,schema:{...textFormat.schema,pattern:'unsupported'}};
 await assert.rejects(async()=>{for await(const e of enabled.stream({operation:'text.generate',input:'JSON',credential:'synthetic',options:{textFormat:bad}})){}},e=>e.code==='structured_schema_invalid');
 assert.equal(calls,1);
});

test('explicit provider refusal cannot become a completed structured result',async()=>{
 const adapter=new OpenAIResponsesTextAdapter({modelId:'approved-model',fetchImpl:async()=>new Response(sse([
  {type:'response.refusal.delta',delta:'No'},complete]),{headers:{'content-type':'text/event-stream'}})});
 await assert.rejects(async()=>{for await(const e of adapter.stream({operation:'text.generate',input:'hello',credential:'synthetic'})){}},e=>e.code==='provider_refused');
});

