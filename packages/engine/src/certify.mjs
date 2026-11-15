// SIE-040: provider-adapter certification. Runs the behavioural contract every adapter must meet before it
// is registered: streamed chat event order and usage (needed to settle cost), cancellation, tool-call and
// structured-output shapes, typed retry-aware errors, credential redaction and media result shapes.
// It certifies conformance to this engine's contract only — not provider quality, pricing or terms.
import {ProviderError} from './providers.mjs';

const CANARY='sk-cert-canary-0123456789abcdef';
const isInt=n=>Number.isSafeInteger(n)&&n>=0;
async function collect(gen,{limit=20000}={}){const out=[];for await(const ev of gen){out.push(ev);if(out.length>limit)throw new Error('stream did not end');}return out;}
function check(name,fn){return {name,fn};}

export function chatChecks({model}){
 return [
  check('chat streams text then usage then done',async a=>{
   const evs=await collect(a.chat({model,system:'Reply briefly.',messages:[{role:'user',content:'Say hello.'}],maxOutputTokens:64}));
   const types=evs.map(e=>e.type);
   if(!types.includes('text'))throw new Error('no text events');
   if(types.at(-1)!=='done')throw new Error('last event must be done, got '+types.at(-1));
   const u=evs.filter(e=>e.type==='usage');if(u.length!==1)throw new Error('exactly one usage event required, got '+u.length);
   if(!isInt(u[0].inputTokens)||!isInt(u[0].outputTokens))throw new Error('usage token counts must be non-negative integers');
   if(types.indexOf('usage')>types.indexOf('done'))throw new Error('usage must precede done');
   if(evs.some(e=>e.type==='text'&&typeof e.text!=='string'))throw new Error('text events need string text');
   const d=evs.at(-1);if(typeof d.model!=='string'||!d.model)throw new Error('done must name the served model');
  }),
  check('chat honours an aborted signal with a cancelled ProviderError',async a=>{
   const ac=new AbortController();ac.abort();
   try{await collect(a.chat({model,messages:[{role:'user',content:'Count to one hundred.'}],maxOutputTokens:256,signal:ac.signal}));}
   catch(e){if(e instanceof ProviderError&&e.code==='cancelled')return;throw new Error('expected ProviderError cancelled, got '+(e.code||e.message));}
   throw new Error('aborted stream completed');
  }),
  check('tool calls carry id, a declared name and an object input',async a=>{
   const tools=[{name:'lookup',description:'Look up a term',inputSchema:{type:'object',properties:{term:{type:'string'}},required:['term']}}];
   const evs=await collect(a.chat({model,tools,messages:[{role:'user',content:'Use the lookup tool for "tides".\nCALL_TOOL lookup {"term":"tides"}'}],maxOutputTokens:128}));
   for(const t of evs.filter(e=>e.type==='tool_call')){
    if(typeof t.id!=='string'||!t.id)throw new Error('tool call without id');
    if(!tools.some(x=>x.name===t.name))throw new Error('undeclared tool '+t.name);
    if(!t.input||typeof t.input!=='object'||Array.isArray(t.input))throw new Error('tool input must be an object');
   }
  }),
  check('structured output is parseable JSON',async a=>{
   const schema={type:'object',properties:{answer:{type:'string'}},required:['answer']};
   const evs=await collect(a.chat({model,outputSchema:schema,messages:[{role:'user',content:'Answer in JSON: what is 2+2?'}],maxOutputTokens:128}));
   const text=evs.filter(e=>e.type==='text').map(e=>e.text).join('');
   let v;try{v=JSON.parse(text)}catch{throw new Error('structured output is not JSON')}
   if(!v||typeof v!=='object')throw new Error('structured output is not an object');
  })
 ];
}
export const MEDIA_CHECKS={
 image:a=>a.image({model:'cert',prompt:'a red square'}),speech:a=>a.speech({model:'cert',text:'Certification test.'}),
 music:a=>a.music({model:'cert',prompt:'short calm tone',durationSeconds:2})
};
function mediaCheck(kind){
 return check(kind+' returns bytes, a media type and units',async a=>{
  const r=await MEDIA_CHECKS[kind](a);
  if(!(r?.bytes instanceof Uint8Array)||!r.bytes.length)throw new Error('missing bytes');
  if(!/^(image|audio|video)\/[a-z0-9.+-]+$/.test(r.mediaType||''))throw new Error('invalid mediaType '+r.mediaType);
  if(!(Number(r.units)>0))throw new Error('units must be positive for metering');
 });
}
/** HTTP adapters only: errors must be typed, retry-aware and never echo the credential. */
export function errorChecks({make,model}){
 if(!make)return [];
 const failing=status=>async()=>new Response(JSON.stringify({error:{message:'Invalid key '+CANARY}}),{status,headers:{'Content-Type':'application/json'}});
 return [401,429,503].map(status=>check(`HTTP ${status} becomes a typed ProviderError without the credential`,async()=>{
  const a=make({apiKey:CANARY,fetchImpl:failing(status)});
  try{await collect(a.chat({model,messages:[{role:'user',content:'hi'}],maxOutputTokens:8}));}
  catch(e){
   if(!(e instanceof ProviderError))throw new Error('not a ProviderError: '+e.message);
   if(String(e.message).includes(CANARY)||String(e.message).includes(CANARY.slice(-8)))throw new Error('error message leaks the credential');
   if(typeof e.retryable!=='boolean')throw new Error('retryable must be boolean');
   if((status===429||status>=500)!==e.retryable)throw new Error(`HTTP ${status} retryable should be ${status===429||status>=500}`);
   return;
  }
  throw new Error('HTTP '+status+' did not raise');
 }));
}
/**
 * @param adapter  instance to certify (chat checks run when it has chat())
 * @param opts {model, media:['image',...], make:(opts)=>adapter for error checks with a fake fetch}
 * @returns {{adapter:string, passed:boolean, results:{name,passed,error?}[]}}
 */
export async function certifyAdapter(adapter,{model,media=[],make}={}){
 const checks=[...(typeof adapter.chat==='function'?chatChecks({model}):[]),...media.map(mediaCheck),...errorChecks({make,model})];
 const results=[];
 for(const c of checks){try{await c.fn(adapter);results.push({name:c.name,passed:true})}catch(e){results.push({name:c.name,passed:false,error:String(e.message||e).slice(0,300)})}}
 return {adapter:adapter.id||'unknown',model,certifiedAt:new Date().toISOString(),scope:'engine adapter contract only',passed:results.length>0&&results.every(r=>r.passed),results};
}
