import test from 'node:test';import assert from 'node:assert/strict';
import {certifyAdapter} from '../src/certify.mjs';
import {DeterministicAdapter,OpenAIAdapter,GeminiAdapter} from '../src/providers.mjs';

// A minimal OpenAI-compatible server double: streams chat completions, tool calls and JSON output.
function openAIFake(){
 return async(url,init)=>{
  if(init.signal?.aborted)throw Object.assign(new Error('aborted'),{name:'AbortError'});
  const body=JSON.parse(init.body);const frames=[];
  const chunk=delta=>frames.push({id:'c1',model:body.model,choices:[{index:0,delta}]});
  if(body.tools)chunk({tool_calls:[{index:0,id:'call_1',function:{name:'lookup',arguments:'{"term":'}},]}),chunk({tool_calls:[{index:0,function:{arguments:'"tides"}'}}]});
  else if(body.response_format)chunk({content:'{"answer":'}),chunk({content:'"4"}'});
  else chunk({content:'Hello'}),chunk({content:' there'});
  frames.push({id:'c1',model:body.model,choices:[{index:0,delta:{},finish_reason:'stop'}]},{id:'c1',model:body.model,choices:[],usage:{prompt_tokens:9,completion_tokens:3}});
  const text=frames.map(f=>'data: '+JSON.stringify(f)+'\n\n').join('')+'data: [DONE]\n\n';
  return new Response(text,{status:200,headers:{'Content-Type':'text/event-stream'}});
 };
}
test('the deterministic simulator meets the chat and media contract',async()=>{
 const r=await certifyAdapter(new DeterministicAdapter({delayMs:0}),{model:'sim-text',media:['image','speech','music']});
 assert.equal(r.passed,true,JSON.stringify(r.results.filter(x=>!x.passed)));assert.equal(r.results.length,7);
});
test('the OpenAI adapter meets the contract, including typed errors that never echo the key',async()=>{
 const make=({apiKey,fetchImpl})=>new OpenAIAdapter({apiKey,baseUrl:'https://api.example.test/v1',fetchImpl:fetchImpl||openAIFake()});
 const r=await certifyAdapter(make({apiKey:'sk-test'}),{model:'gpt-test',make});
 assert.equal(r.passed,true,JSON.stringify(r.results.filter(x=>!x.passed)));
 assert.ok(r.results.some(x=>/HTTP 401/.test(x.name)));
});
test('Gemini errors are redacted too',async()=>{
 const make=({apiKey,fetchImpl})=>new GeminiAdapter({apiKey,baseUrl:'https://gemini.example.test/v1beta',fetchImpl});
 const r=await certifyAdapter({id:'gemini-errors-only'},{model:'gemini-test',make});
 assert.equal(r.passed,true,JSON.stringify(r.results.filter(x=>!x.passed)));
});
test('a non-conforming adapter is rejected with the failing rule named',async()=>{
 const broken={id:'broken',async *chat(){yield {type:'text',text:'hi'};yield {type:'done',model:'x'};}};
 const r=await certifyAdapter(broken,{model:'x'});
 assert.equal(r.passed,false);
 assert.match(r.results.find(x=>!x.passed).error,/usage/);
});
