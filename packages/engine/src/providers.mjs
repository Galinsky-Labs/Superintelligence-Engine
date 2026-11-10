// Provider adapters with one normalized interface.
//
// chat(req) -> async iterator of events:
//   {type:'text',text} | {type:'tool_call',id,name,input} | {type:'usage',inputTokens,outputTokens}
//   | {type:'done',responseId,model,stopReason,raw}
// Normalized messages: {role:'user',content} | {role:'assistant',content,toolCalls:[{id,name,input}],raw}
//   | {role:'tool',toolCallId,name,content,isError}
// Media: image(), speech(), transcribe(), music(), video submit()/poll().
import Anthropic from '@anthropic-ai/sdk';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {deflateSync,crc32} from 'node:zlib';
import {EngineError,sha256,sleep} from './infra.mjs';

export class ProviderError extends EngineError {
  constructor(code,message,{status=502,retryable=false}={}){super(code,status,message);this.name='ProviderError';this.retryable=retryable;}
}
const MAX_BYTES=64*1024*1024;

async function httpError(res,provider){
  let detail='';try{detail=(await res.text()).slice(0,200)}catch{}
  const retryable=res.status===429||res.status>=500;
  const code=res.status===401||res.status===403?'provider_auth_failed':res.status===429?'provider_rate_limited':res.status>=500?'provider_unavailable':'provider_rejected';
  return new ProviderError(code,`${provider} returned HTTP ${res.status}: ${detail.replace(/\s+/g,' ')}`,{retryable});
}
async function* sseFrames(res,signal){
  if(!res.body)throw new ProviderError('missing_stream','Provider returned no stream');
  const reader=res.body.getReader(),decoder=new TextDecoder();let buf='',total=0;
  try{
    while(true){
      if(signal?.aborted)throw new ProviderError('cancelled','Cancelled',{status:499});
      const {done,value}=await reader.read();if(done)break;
      total+=value.byteLength;if(total>MAX_BYTES)throw new ProviderError('response_limit','Provider stream too large');
      buf+=decoder.decode(value,{stream:true});
      let m;
      while((m=/\r?\n\r?\n/.exec(buf))){
        const frame=buf.slice(0,m.index);buf=buf.slice(m.index+m[0].length);
        const data=frame.split(/\r?\n/).filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trimStart()).join('\n');
        if(!data||data==='[DONE]')continue;
        try{yield JSON.parse(data)}catch{throw new ProviderError('invalid_stream_event','Malformed provider event')}
      }
    }
  }finally{reader.cancel().catch(()=>{})}
}
async function readBytes(res){
  const len=Number(res.headers.get('content-length')||0);if(len>MAX_BYTES)throw new ProviderError('response_limit','Media too large');
  const b=Buffer.from(await res.arrayBuffer());if(b.length>MAX_BYTES)throw new ProviderError('response_limit','Media too large');return b;
}
/** User content is a string or parts [{type:'text',text}|{type:'image',mediaType,data(base64)}]. */
export const textOf=c=>typeof c==='string'?c:(c||[]).filter(p=>p.type==='text').map(p=>p.text).join('\n');
const partsOf=c=>typeof c==='string'?[{type:'text',text:c}]:c;
function safeJSON(text){try{return JSON.parse(text||'{}')}catch{return {_invalid:text}}}

// ---------------- OpenAI and OpenAI-compatible (chat completions) ----------------
export class OpenAIAdapter {
  constructor({apiKey,baseUrl='https://api.openai.com/v1',id='openai',fetchImpl=fetch}){this.apiKey=apiKey;this.base=baseUrl.replace(/\/$/,'');this.id=id;this.fetch=fetchImpl;}
  headers(json=true){return {...(this.apiKey?{Authorization:'Bearer '+this.apiKey}:{}),...(json?{'Content-Type':'application/json'}:{})}}
  toMessages(system,messages){
    const out=system?[{role:'system',content:system}]:[];
    for(const m of messages){
      if(m.role==='user')out.push({role:'user',content:typeof m.content==='string'?m.content:partsOf(m.content).map(p=>p.type==='image'?{type:'image_url',image_url:{url:`data:${p.mediaType};base64,${p.data}`}}:{type:'text',text:p.text})});
      else if(m.role==='assistant')out.push({role:'assistant',content:m.content||null,...(m.toolCalls?.length?{tool_calls:m.toolCalls.map(t=>({id:t.id,type:'function',function:{name:t.name,arguments:JSON.stringify(t.input||{})}}))}:{})});
      else if(m.role==='tool')out.push({role:'tool',tool_call_id:m.toolCallId,content:m.content});
    }
    return out;
  }
  async *chat({model,system,messages,tools=[],outputSchema,maxOutputTokens=4096,signal}){
    const body={model,messages:this.toMessages(system,messages),stream:true,stream_options:{include_usage:true},max_completion_tokens:maxOutputTokens};
    if(tools.length)body.tools=tools.map(t=>({type:'function',function:{name:t.name,description:t.description,parameters:t.inputSchema}}));
    if(outputSchema)body.response_format={type:'json_schema',json_schema:{name:'output',schema:outputSchema,strict:false}};
    let res;
    try{res=await this.fetch(this.base+'/chat/completions',{method:'POST',headers:{...this.headers(),Accept:'text/event-stream'},body:JSON.stringify(body),signal,redirect:'error'})}
    catch(e){if(signal?.aborted)throw new ProviderError('cancelled','Cancelled',{status:499});throw new ProviderError('provider_transport','Could not reach '+this.id,{retryable:true})}
    if(!res.ok)throw await httpError(res,this.id);
    const calls=new Map();let usage=null,id='',finish='',served=model;
    for await(const ev of sseFrames(res,signal)){
      if(ev.error)throw new ProviderError('provider_failed',String(ev.error.message||'provider error'));
      id=ev.id||id;served=ev.model||served;
      for(const ch of ev.choices||[]){
        const d=ch.delta||{};
        if(typeof d.content==='string'&&d.content)yield {type:'text',text:d.content};
        for(const tc of d.tool_calls||[]){
          const cur=calls.get(tc.index)||{id:'',name:'',args:''};
          if(tc.id)cur.id=tc.id;if(tc.function?.name)cur.name+=tc.function.name;if(tc.function?.arguments)cur.args+=tc.function.arguments;
          calls.set(tc.index,cur);
        }
        if(ch.finish_reason)finish=ch.finish_reason;
      }
      if(ev.usage)usage={inputTokens:ev.usage.prompt_tokens||0,outputTokens:ev.usage.completion_tokens||0};
    }
    for(const c of calls.values())yield {type:'tool_call',id:c.id||'call_'+sha256(c.name+c.args).slice(0,12),name:c.name,input:safeJSON(c.args)};
    if(!usage)throw new ProviderError('usage_missing','Provider returned no usage; cannot settle cost');
    yield {type:'usage',...usage};
    yield {type:'done',responseId:id,model:served,stopReason:finish};
  }
  async image({model,prompt,size='1024x1024',signal}){
    const res=await this.fetch(this.base+'/images/generations',{method:'POST',headers:this.headers(),body:JSON.stringify({model,prompt,size,n:1}),signal});
    if(!res.ok)throw await httpError(res,this.id);
    const j=await res.json();const b64=j.data?.[0]?.b64_json;
    if(b64)return {bytes:Buffer.from(b64,'base64'),mediaType:'image/png',units:1,responseId:String(j.created||'')};
    const url=j.data?.[0]?.url;if(!url)throw new ProviderError('invalid_response','No image returned');
    const img=await this.fetch(url,{signal,redirect:'error'}); // via guarded fetch when tenant-configuredif(!img.ok)throw await httpError(img,this.id);
    return {bytes:await readBytes(img),mediaType:img.headers.get('content-type')||'image/png',units:1};
  }
  async speech({model,text,voice='alloy',signal}){
    const res=await this.fetch(this.base+'/audio/speech',{method:'POST',headers:this.headers(),body:JSON.stringify({model,input:text,voice,response_format:'mp3'}),signal});
    if(!res.ok)throw await httpError(res,this.id);
    return {bytes:await readBytes(res),mediaType:'audio/mpeg',units:[...text].length};
  }
  async transcribe({model,bytes,mediaType,filename='audio',signal}){
    const form=new FormData();form.append('model',model);form.append('response_format','verbose_json');
    form.append('file',new Blob([bytes],{type:mediaType}),filename);
    const res=await this.fetch(this.base+'/audio/transcriptions',{method:'POST',headers:this.headers(false),body:form,signal});
    if(!res.ok)throw await httpError(res,this.id);
    const j=await res.json();return {text:String(j.text||''),units:Math.max(1/60,Number(j.duration||0)/60)};
  }
  async listModels(){
    const res=await this.fetch(this.base+'/models',{headers:this.headers(false),signal:AbortSignal.timeout(10000)});
    if(!res.ok)throw await httpError(res,this.id);
    const j=await res.json();return (j.data||[]).map(m=>m.id).filter(Boolean);
  }
}

// ---------------- Anthropic (official SDK) ----------------
export class AnthropicAdapter {
  constructor({apiKey,baseUrl,client,fetchImpl}){this.id='anthropic';this.client=client||new Anthropic({apiKey,baseURL:baseUrl||'https://api.anthropic.com',maxRetries:2,...(fetchImpl?{fetch:fetchImpl}:{})});}
  toMessages(messages){
    const out=[];
    for(const m of messages){
      if(m.role==='user')out.push({role:'user',content:typeof m.content==='string'?m.content:partsOf(m.content).map(p=>p.type==='image'?{type:'image',source:{type:'base64',media_type:p.mediaType,data:p.data}}:{type:'text',text:p.text})});
      else if(m.role==='assistant'){
        if(m.raw?.provider==='anthropic')out.push({role:'assistant',content:m.raw.content});
        else{const content=[];if(m.content)content.push({type:'text',text:m.content});for(const t of m.toolCalls||[])content.push({type:'tool_use',id:t.id,name:t.name,input:t.input||{}});out.push({role:'assistant',content:content.length?content:''});}
      }else if(m.role==='tool'){
        const block={type:'tool_result',tool_use_id:m.toolCallId,content:m.content,...(m.isError?{is_error:true}:{})};
        const last=out[out.length-1];
        // All tool results for one assistant turn go in a single user message.
        if(last&&last.role==='user'&&Array.isArray(last.content)&&last.content.every(b=>b.type==='tool_result'))last.content.push(block);
        else out.push({role:'user',content:[block]});
      }
    }
    return out;
  }
  async *chat({model,system,messages,tools=[],outputSchema,maxOutputTokens=16000,signal}){
    const params={model,max_tokens:maxOutputTokens,messages:this.toMessages(messages)};
    if(system)params.system=system;
    if(tools.length)params.tools=tools.map(t=>({name:t.name,description:t.description,input_schema:t.inputSchema}));
    if(outputSchema&&!tools.length)params.output_config={format:{type:'json_schema',schema:outputSchema}};
    let stream;
    try{
      stream=this.client.messages.stream(params,{signal});
      for await(const ev of stream){
        if(ev.type==='content_block_delta'&&ev.delta.type==='text_delta')yield {type:'text',text:ev.delta.text};
      }
      const msg=await stream.finalMessage();
      if(msg.stop_reason==='refusal')throw new ProviderError('provider_refusal','The model declined this request'+(msg.stop_details?.category?` (${msg.stop_details.category})`:''));
      for(const b of msg.content)if(b.type==='tool_use')yield {type:'tool_call',id:b.id,name:b.name,input:b.input};
      yield {type:'usage',inputTokens:(msg.usage.input_tokens||0)+(msg.usage.cache_creation_input_tokens||0)+(msg.usage.cache_read_input_tokens||0),outputTokens:msg.usage.output_tokens||0};
      yield {type:'done',responseId:msg.id,model:msg.model,stopReason:msg.stop_reason,raw:{provider:'anthropic',content:msg.content}};
    }catch(e){
      if(e instanceof ProviderError)throw e;
      if(signal?.aborted||e instanceof Anthropic.APIUserAbortError)throw new ProviderError('cancelled','Cancelled',{status:499});
      if(e instanceof Anthropic.AuthenticationError||e instanceof Anthropic.PermissionDeniedError)throw new ProviderError('provider_auth_failed','Anthropic rejected the credential');
      if(e instanceof Anthropic.RateLimitError)throw new ProviderError('provider_rate_limited','Anthropic rate limit',{retryable:true});
      if(e instanceof Anthropic.BadRequestError||e instanceof Anthropic.NotFoundError)throw new ProviderError('provider_rejected','Anthropic rejected the request: '+String(e.message).slice(0,300));
      if(e instanceof Anthropic.APIConnectionError)throw new ProviderError('provider_transport','Could not reach Anthropic',{retryable:true});
      if(e instanceof Anthropic.APIError)throw new ProviderError('provider_unavailable','Anthropic error '+(e.status||''),{retryable:(e.status||500)>=500});
      throw e;
    }
  }
  async listModels(){const ids=[];for await(const m of this.client.models.list())ids.push(m.id);return ids;}
}

// ---------------- Google Gemini ----------------
export class GeminiAdapter {
  constructor({apiKey,baseUrl='https://generativelanguage.googleapis.com/v1beta',fetchImpl=fetch}){this.id='gemini';this.apiKey=apiKey;this.base=baseUrl.replace(/\/$/,'');this.fetch=fetchImpl;}
  async *chat({model,system,messages,tools=[],outputSchema,maxOutputTokens=8192,signal}){
    const contents=[];
    for(const m of messages){
      if(m.role==='user')contents.push({role:'user',parts:partsOf(m.content).map(p=>p.type==='image'?{inlineData:{mimeType:p.mediaType,data:p.data}}:{text:p.text})});
      else if(m.role==='assistant'){const parts=[];if(m.content)parts.push({text:m.content});for(const t of m.toolCalls||[])parts.push({functionCall:{name:t.name,args:t.input||{}}});contents.push({role:'model',parts});}
      else if(m.role==='tool')contents.push({role:'user',parts:[{functionResponse:{name:m.name,response:{content:m.content}}}]});
    }
    const body={contents,generationConfig:{maxOutputTokens}};
    if(system)body.systemInstruction={parts:[{text:system}]};
    if(tools.length)body.tools=[{functionDeclarations:tools.map(t=>({name:t.name,description:t.description,parametersJsonSchema:t.inputSchema}))}];
    if(outputSchema&&!tools.length)Object.assign(body.generationConfig,{responseMimeType:'application/json',responseJsonSchema:outputSchema});
    let res;
    try{res=await this.fetch(`${this.base}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`,{method:'POST',headers:{'Content-Type':'application/json','x-goog-api-key':this.apiKey},body:JSON.stringify(body),signal})}
    catch{if(signal?.aborted)throw new ProviderError('cancelled','Cancelled',{status:499});throw new ProviderError('provider_transport','Could not reach Gemini',{retryable:true})}
    if(!res.ok)throw await httpError(res,'gemini');
    let usage=null,id='',finish='',n=0;
    for await(const ev of sseFrames(res,signal)){
      id=ev.responseId||id;
      for(const c of ev.candidates||[]){
        for(const p of c.content?.parts||[]){
          if(typeof p.text==='string'&&!p.thought)yield {type:'text',text:p.text};
          if(p.functionCall)yield {type:'tool_call',id:'gem_'+(++n)+'_'+sha256(JSON.stringify(p.functionCall)).slice(0,8),name:p.functionCall.name,input:p.functionCall.args||{}};
        }
        if(c.finishReason)finish=c.finishReason;
      }
      if(ev.usageMetadata)usage={inputTokens:ev.usageMetadata.promptTokenCount||0,outputTokens:(ev.usageMetadata.candidatesTokenCount||0)+(ev.usageMetadata.thoughtsTokenCount||0)};
    }
    if(!usage)throw new ProviderError('usage_missing','Gemini returned no usage metadata');
    yield {type:'usage',...usage};yield {type:'done',responseId:id,model,stopReason:finish};
  }
  async listModels(){
    const res=await this.fetch(`${this.base}/models?pageSize=200`,{headers:{'x-goog-api-key':this.apiKey},signal:AbortSignal.timeout(10000)});
    if(!res.ok)throw await httpError(res,'gemini');return ((await res.json()).models||[]).map(m=>String(m.name).replace(/^models\//,''));
  }
}

// ---------------- ElevenLabs ----------------
export class ElevenLabsAdapter {
  constructor({apiKey,baseUrl='https://api.elevenlabs.io/v1',fetchImpl=fetch}){this.id='elevenlabs';this.apiKey=apiKey;this.base=baseUrl.replace(/\/$/,'');this.fetch=fetchImpl;}
  async speech({model,text,voice='21m00Tcm4TlvDq8ikWAM',signal}){
    const res=await this.fetch(`${this.base}/text-to-speech/${encodeURIComponent(voice)}?output_format=mp3_44100_128`,{method:'POST',headers:{'xi-api-key':this.apiKey,'Content-Type':'application/json',Accept:'audio/mpeg'},body:JSON.stringify({text,model_id:model}),signal});
    if(!res.ok)throw await httpError(res,'elevenlabs');
    return {bytes:await readBytes(res),mediaType:'audio/mpeg',units:[...text].length};
  }
  async music({prompt,durationSeconds=30,signal}){
    const res=await this.fetch(`${this.base}/music?output_format=mp3_44100_128`,{method:'POST',headers:{'xi-api-key':this.apiKey,'Content-Type':'application/json',Accept:'audio/mpeg'},body:JSON.stringify({prompt,music_length_ms:Math.round(durationSeconds*1000)}),signal});
    if(!res.ok)throw await httpError(res,'elevenlabs');
    return {bytes:await readBytes(res),mediaType:'audio/mpeg',units:durationSeconds};
  }
  async listModels(){const res=await this.fetch(`${this.base}/models`,{headers:{'xi-api-key':this.apiKey}});if(!res.ok)throw await httpError(res,'elevenlabs');return (await res.json()).map(m=>m.model_id);}
}

// ---------------- Replicate (asynchronous predictions) ----------------
export class ReplicateAdapter {
  constructor({apiKey,baseUrl='https://api.replicate.com/v1',fetchImpl=fetch,allowedOutputHosts=['replicate.delivery','pbxt.replicate.delivery']}){this.id='replicate';this.apiKey=apiKey;this.base=baseUrl.replace(/\/$/,'');this.fetch=fetchImpl;this.outHosts=allowedOutputHosts;}
  h(){return {Authorization:'Bearer '+this.apiKey,'Content-Type':'application/json'}}
  async submit({model,input,signal}){
    if(!/^[a-z0-9][a-z0-9_.-]*\/[a-z0-9][a-z0-9_.-]*$/i.test(model))throw new ProviderError('invalid_model','Replicate model must be owner/name',{status:400});
    const res=await this.fetch(`${this.base}/models/${model}/predictions`,{method:'POST',headers:this.h(),body:JSON.stringify({input}),signal});
    if(!res.ok)throw await httpError(res,'replicate');
    const j=await res.json();return {taskId:String(j.id),status:j.status};
  }
  async poll({taskId,signal}){
    if(!/^[a-z0-9]{6,64}$/i.test(taskId))throw new ProviderError('invalid_task','Invalid prediction id',{status:400});
    const res=await this.fetch(`${this.base}/predictions/${taskId}`,{headers:this.h(),signal});
    if(!res.ok)throw await httpError(res,'replicate');
    const j=await res.json();
    if(j.status==='succeeded'){
      const url=Array.isArray(j.output)?j.output[0]:j.output;
      if(typeof url!=='string')throw new ProviderError('invalid_response','Prediction produced no file');
      const u=new URL(url);
      if(u.protocol!=='https:'&&!this.base.startsWith('http://'))throw new ProviderError('unsafe_output','Non-HTTPS output');
      if(!this.outHosts.includes(u.hostname)&&!this.base.startsWith('http://'))throw new ProviderError('unsafe_output','Output host not allowlisted');
      const file=await this.fetch(url,{signal});if(!file.ok)throw await httpError(file,'replicate');
      return {status:'succeeded',bytes:await readBytes(file),mediaType:file.headers.get('content-type')||'application/octet-stream',units:Number(j.metrics?.predict_time||1)};
    }
    if(j.status==='failed'||j.status==='canceled')return {status:'failed',error:String(j.error||j.status).slice(0,300)};
    return {status:'running'};
  }
  async cancel({taskId}){await this.fetch(`${this.base}/predictions/${taskId}/cancel`,{method:'POST',headers:this.h()}).catch(()=>{});}
}

// ---------------- Deterministic simulator (tests / offline development) ----------------
function pngSolid(seed,size=64){
  const h=Buffer.from(sha256(seed),'hex');const [r,g,b]=[h[0],h[1],h[2]];
  const row=Buffer.alloc(1+size*3);for(let x=0;x<size;x++){row[1+x*3]=r;row[2+x*3]=g;row[3+x*3]=(b+x*3)&255;}
  const raw=Buffer.concat(Array.from({length:size},()=>row));
  const chunk=(type,data)=>{const len=Buffer.alloc(4);len.writeUInt32BE(data.length);const td=Buffer.concat([Buffer.from(type),data]);const c=Buffer.alloc(4);c.writeUInt32BE(crc32(td)>>>0);return Buffer.concat([len,td,c]);};
  const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(size,0);ihdr.writeUInt32BE(size,4);ihdr[8]=8;ihdr[9]=2;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);
}
function wavTone(seed,seconds=1,rate=8000){
  const f=220+(Buffer.from(sha256(seed),'hex')[0]%200)*2,n=Math.round(seconds*rate),data=Buffer.alloc(n*2);
  for(let i=0;i<n;i++)data.writeInt16LE(Math.round(Math.sin(2*Math.PI*f*i/rate)*8000),i*2);
  const h=Buffer.alloc(44);h.write('RIFF',0);h.writeUInt32LE(36+data.length,4);h.write('WAVEfmt ',8);h.writeUInt32LE(16,16);h.writeUInt16LE(1,20);h.writeUInt16LE(1,22);
  h.writeUInt32LE(rate,24);h.writeUInt32LE(rate*2,28);h.writeUInt16LE(2,32);h.writeUInt16LE(16,34);h.write('data',36);h.writeUInt32LE(data.length,40);
  return Buffer.concat([h,data]);
}
function fromSchema(schema,seed,path='value',depth=0){
  if(!schema||depth>8)return null;
  if(schema.enum)return schema.enum[Buffer.from(sha256(seed+path),'hex')[0]%schema.enum.length];
  switch(schema.type){
    case 'object':return Object.fromEntries(Object.entries(schema.properties||{}).map(([k,v])=>[k,fromSchema(v,seed,path+'.'+k,depth+1)]));
    case 'array':{if(/dependsOn$/.test(path)&&!schema.minItems)return [];const n=Math.max(schema.minItems||0,Math.min(schema.maxItems??3,3));return Array.from({length:n},(_,i)=>fromSchema(schema.items,seed,path+'['+i+']',depth+1));}
    case 'integer':return Math.max(schema.minimum??0,Math.min(schema.maximum??100,Buffer.from(sha256(seed+path),'hex')[0]));
    case 'number':return Math.max(schema.minimum??0,Math.min(schema.maximum??1,Buffer.from(sha256(seed+path),'hex')[0]/255));
    case 'boolean':return Buffer.from(sha256(seed+path),'hex')[0]%2===0;
    case 'null':return null;
    case 'string':{
      const leaf=path.replace(/\[\d+\]/g,m=>'-'+(Number(m.slice(1,-1))+1)).split('.').pop();
      let s=`${leaf} (simulated ${sha256(seed+path).slice(0,6)})`;
      if(schema.maxLength)s=s.slice(0,schema.maxLength);
      if(schema.minLength&&s.length<schema.minLength)s=s.padEnd(schema.minLength,'.');
      return s;
    }
    default:return null;
  }
}
const approxTokens=s=>Math.ceil(String(s||'').length/4);
export class DeterministicAdapter {
  constructor({delayMs=Number(process.env.SIE_SIM_DELAY_MS||4)}={}){this.id='deterministic';this.delay=delayMs;this.tasks=new Map();}
  async *chat({model,system,messages,tools=[],outputSchema,maxOutputTokens=4096,signal}){
    const last=[...messages].reverse().find(m=>m.role==='user');
    const afterLastUser=messages.slice(messages.lastIndexOf(last)+1);
    const images=typeof last?.content==='string'?[]:(last?.content||[]).filter(p=>p.type==='image');
    const transcript=JSON.stringify({system,messages:messages.map(m=>({role:m.role,content:textOf(m.content)}))});
    const inputTokens=approxTokens(transcript);
    const id='sim_'+sha256(transcript).slice(0,16);
    // Tool directive: "CALL_TOOL <name> <json>" lines in the latest user message trigger tool calls once.
    const directives=textOf(last?.content).split('\n').map(l=>/^CALL_TOOL\s+([A-Za-z0-9_-]+)\s+(\{.*\})\s*$/.exec(l.trim())).filter(Boolean);
    if(tools.length&&directives.length&&!afterLastUser.some(m=>m.role==='tool')){
      let i=0;for(const d of directives){if(tools.some(t=>t.name===d[1]))yield {type:'tool_call',id:`${id}_t${i++}`,name:d[1],input:safeJSON(d[2])};}
      yield {type:'usage',inputTokens,outputTokens:20};yield {type:'done',responseId:id,model,stopReason:'tool_use'};return;
    }
    let text;
    if(outputSchema)text=JSON.stringify(fromSchema(outputSchema,transcript));
    else{
      const toolNotes=afterLastUser.filter(m=>m.role==='tool').map(m=>`Tool ${m.name} returned: ${String(m.content).slice(0,400)}`);
      const prompt=textOf(last?.content).replace(/\s+/g,' ').trim();
      if(images.length)toolNotes.unshift(`Received ${images.length} image(s): ${images.map(i=>`${i.mediaType} ${Math.round(i.data.length*3/4)} bytes (digest ${sha256(i.data).slice(0,8)})`).join(', ')}`);
      text=`[SIMULATED OUTPUT — deterministic test provider, not a real model]\nTask digest ${sha256(transcript).slice(0,10)}.\n`+
        (toolNotes.length?toolNotes.join('\n')+'\n':'')+`Response to: ${prompt.slice(0,600)}`;
    }
    const words=text.match(/\S+\s*|\s+/g)||[];let out=0;
    for(const w of words){
      if(signal?.aborted)throw new ProviderError('cancelled','Cancelled',{status:499});
      if(out>=maxOutputTokens*4)break;out+=w.length;
      yield {type:'text',text:w};if(this.delay)await sleep(this.delay);
    }
    yield {type:'usage',inputTokens,outputTokens:approxTokens(text)};
    yield {type:'done',responseId:id,model,stopReason:'end_turn'};
  }
  async image({prompt}){return {bytes:pngSolid(prompt),mediaType:'image/png',units:1,simulated:true};}
  async speech({text}){return {bytes:wavTone(text,Math.min(5,Math.max(0.5,[...text].length/40))),mediaType:'audio/wav',units:[...text].length,simulated:true};}
  async music({prompt,durationSeconds=2}){return {bytes:wavTone(prompt,Math.min(10,durationSeconds)),mediaType:'audio/wav',units:durationSeconds,simulated:true};}
  async transcribe({bytes}){return {text:`[SIMULATED TRANSCRIPT] ${bytes.length} bytes of audio received (digest ${sha256(bytes).slice(0,10)}).`,units:1,simulated:true};}
  async submit({input}){const taskId='sim'+sha256(JSON.stringify(input)+Date.now()+Math.random()).slice(0,20);this.tasks.set(taskId,{input,polls:0});return {taskId,status:'starting'};}
  async poll({taskId}){
    const t=this.tasks.get(taskId);if(!t)return {status:'failed',error:'unknown simulated task'};
    if(++t.polls<2)return {status:'running'};
    this.tasks.delete(taskId);
    return {status:'succeeded',...(await renderSimVideo(String(t.input?.prompt||''))),units:1,simulated:true};
  }
  async cancel({taskId}){this.tasks.delete(taskId);}
  async listModels(){return ['sim-text','sim-media'];}
}
async function renderSimVideo(prompt){
  // A short test-pattern MP4 via ffmpeg when available; otherwise a still PNG preview.
  const dir=await mkdtemp(join(tmpdir(),'sie-sim-'));
  try{
    const out=join(dir,'v.mp4');
    const ok=await new Promise(r=>{const p=spawn('ffmpeg',['-loglevel','error','-f','lavfi','-i','testsrc=duration=1:size=160x90:rate=8','-pix_fmt','yuv420p','-metadata','comment='+prompt.slice(0,80),out],{stdio:'ignore'});p.on('error',()=>r(false));p.on('close',c=>r(c===0));});
    if(ok)return {bytes:await readFile(out),mediaType:'video/mp4'};
    return {bytes:pngSolid(prompt),mediaType:'image/png'};
  }finally{await rm(dir,{recursive:true,force:true})}
}

// ---------------- Registry ----------------
export const PROVIDERS={
  anthropic:{label:'Anthropic',env:'ANTHROPIC_API_KEY',make:({apiKey,baseUrl,fetchImpl})=>new AnthropicAdapter({apiKey,baseUrl,fetchImpl})},
  openai:{label:'OpenAI',env:'OPENAI_API_KEY',make:({apiKey,baseUrl,fetchImpl})=>new OpenAIAdapter({apiKey,baseUrl:baseUrl||'https://api.openai.com/v1',...(fetchImpl?{fetchImpl}:{})})},
  'openai-compatible':{label:'OpenAI-compatible endpoint',env:'OPENAI_COMPATIBLE_API_KEY',baseEnv:'OPENAI_COMPATIBLE_BASE_URL',requiresBaseUrl:true,make:({apiKey,baseUrl,fetchImpl})=>new OpenAIAdapter({apiKey,baseUrl,id:'openai-compatible',...(fetchImpl?{fetchImpl}:{})})},
  gemini:{label:'Google Gemini',env:'GEMINI_API_KEY',make:({apiKey,baseUrl,fetchImpl})=>new GeminiAdapter({apiKey,...(baseUrl?{baseUrl}:{}),...(fetchImpl?{fetchImpl}:{})})},
  elevenlabs:{label:'ElevenLabs',env:'ELEVENLABS_API_KEY',make:({apiKey,baseUrl,fetchImpl})=>new ElevenLabsAdapter({apiKey,...(baseUrl?{baseUrl}:{}),...(fetchImpl?{fetchImpl}:{})})},
  replicate:{label:'Replicate',env:'REPLICATE_API_TOKEN',make:({apiKey,baseUrl,fetchImpl})=>new ReplicateAdapter({apiKey,...(baseUrl?{baseUrl}:{}),...(fetchImpl?{fetchImpl}:{})})},
  deterministic:{label:'Deterministic simulator (test only)',env:null,make:()=>new DeterministicAdapter()},
};
