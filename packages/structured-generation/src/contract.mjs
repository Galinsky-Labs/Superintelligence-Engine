import {createHash} from 'node:crypto';

export class StructuredOutputError extends Error {
 constructor(code){super(code);this.name='StructuredOutputError';this.code=code}
}
const guard=(ok,code)=>{if(!ok)throw new StructuredOutputError(code)};
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const dangerous=new Set(['__proto__','prototype','constructor']);
const TYPES=['object','array','string','number','integer','boolean','null'];
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function principalCopy(p){
 guard(UUID.test(p?.tenantId||'')&&UUID.test(p?.identityId||''),'invalid_principal');
 return {tenantId:p.tenantId,identityId:p.identityId};
}
function freeze(x){if(x&&typeof x==='object'){for(const v of Object.values(x))freeze(v);Object.freeze(x)}return x}

/** Bounded JSON parser: duplicate keys and prototype-sensitive keys are errors, not last-write-wins. */
export function parseStrictJSON(text){
 guard(typeof text==='string'&&Buffer.byteLength(text)<=125000,'invalid_json_size');
 let i=0,nodes=0;
 const space=()=>{while(/[\t\n\r ]/.test(text[i]||'!'))i++};
 function string(){
  const start=i++;let escaped=false;
  while(i<text.length){const c=text[i++];if(!escaped&&c==='"'){
   try{return JSON.parse(text.slice(start,i))}catch{throw new StructuredOutputError('invalid_json')}
  }if(!escaped&&c==='\\')escaped=true;else escaped=false}
  throw new StructuredOutputError('invalid_json');
 }
 function value(depth){
  guard(depth<=16&&++nodes<=10000,'json_complexity_limit');space();const c=text[i];
  if(c==='"')return string();
  if(c==='{'||c==='['){
   i++;space();const isObject=c==='{',out=isObject?{}:[],close=isObject?'}':']',seen=new Set();
   if(text[i]===close){i++;return out}
   while(i<text.length){
    space();let key;
    if(isObject){guard(text[i]==='"','invalid_json');key=string();guard(!seen.has(key)&&!dangerous.has(key),'duplicate_or_unsafe_key');seen.add(key);space();guard(text[i++]===':','invalid_json')}
    const next=value(depth+1);if(isObject)out[key]=next;else out.push(next);
    space();if(text[i]===close){i++;return out}guard(text[i++]===',','invalid_json');
   }
   throw new StructuredOutputError('invalid_json');
  }
  for(const [word,result] of [['true',true],['false',false],['null',null]])if(text.startsWith(word,i)){i+=word.length;return result}
  const match=/-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(text.slice(i));
  guard(match&&match.index===0,'invalid_json');i+=match[0].length;const number=Number(match[0]);
  guard(Number.isFinite(number)&&(!Number.isInteger(number)||Number.isSafeInteger(number)),'unsafe_json_number');return number;
 }
 const result=value(0);space();guard(i===text.length,'invalid_json');return result;
}

/** Deliberately restrictive JSON Schema subset. Unsupported keywords never silently pass. */
export function compileOutputSchema(input){
 const schema=parseStrictJSON(JSON.stringify(input));let nodes=0;
 guard(Buffer.byteLength(JSON.stringify(schema))<=16384,'schema_size_limit');
 function check(s,depth){
  guard(object(s)&&TYPES.includes(s.type)&&depth<=10&&++nodes<=200,'invalid_schema');
  const keys={object:['properties','required','additionalProperties'],array:['items','minItems','maxItems'],
   string:['minLength','maxLength'],number:['minimum','maximum'],integer:['minimum','maximum'],boolean:[],null:[]};
  guard(Object.keys(s).every(k=>['type','enum',...keys[s.type]].includes(k)),'unsupported_schema_keyword');
  if(s.type==='object'){
   guard(object(s.properties)&&s.additionalProperties===false&&Array.isArray(s.required),'closed_object_required');
   const names=Object.keys(s.properties);
   guard(names.length<=100&&names.every(n=>n.length<=100&&!dangerous.has(n))&&s.required.length===names.length&&
    new Set(s.required).size===names.length&&s.required.every(n=>Object.hasOwn(s.properties,n)),'all_properties_required');
   for(const child of Object.values(s.properties))check(child,depth+1);
  }
  if(s.type==='array')check(s.items,depth+1);
  for(const [lo,hi] of [['minLength','maxLength'],['minItems','maxItems'],['minimum','maximum']]){
   for(const key of [lo,hi])if(Object.hasOwn(s,key))guard(typeof s[key]==='number'&&Number.isFinite(s[key])&&
     (key==='minimum'||key==='maximum'||Number.isSafeInteger(s[key])&&s[key]>=0),'invalid_schema_bound');
   if(Object.hasOwn(s,lo)&&Object.hasOwn(s,hi))guard(s[lo]<=s[hi],'invalid_schema_bound');
  }
  if(s.enum!==undefined)guard(!['object','array'].includes(s.type)&&Array.isArray(s.enum)&&s.enum.length>0&&s.enum.length<=100&&
   s.enum.every(x=>matchesType(x,s.type)),'invalid_schema_enum');
 }
 check(schema,0);
 function validate(x,s,depth=0){
  guard(depth<=16&&matchesType(x,s.type),'schema_mismatch');
  if(s.enum)guard(s.enum.includes(x),'schema_mismatch');
  if(s.type==='object'){
   guard(Object.keys(x).length===s.required.length&&s.required.every(k=>Object.hasOwn(x,k)),'schema_mismatch');
   for(const [k,v] of Object.entries(x)){guard(Object.hasOwn(s.properties,k)&&!dangerous.has(k),'schema_mismatch');validate(v,s.properties[k],depth+1)}
  }else if(s.type==='array'){
   guard(x.length<=Math.min(s.maxItems??200,200)&&x.length>=(s.minItems??0),'schema_mismatch');
   for(const v of x)validate(v,s.items,depth+1);
  }else if(s.type==='string'){
   const length=[...x].length;guard(length<=(s.maxLength??64000)&&length>=(s.minLength??0),'schema_mismatch');
  }else if(s.type==='number'||s.type==='integer')guard(x>=(s.minimum??-Infinity)&&x<=(s.maximum??Infinity),'schema_mismatch');
 }
 return Object.freeze({schema:freeze(schema),validate:x=>{validate(x,schema);return x}});
}
function matchesType(x,type){
 if(type==='object')return object(x);
 if(type==='array')return Array.isArray(x);
 if(type==='null')return x===null;
 if(type==='integer')return Number.isSafeInteger(x);
 if(type==='number')return typeof x==='number'&&Number.isFinite(x);
 return typeof x===type;
}

/** Only the existing scoped gateway may read sources. Documents cannot create grants. */
export async function retrieveCitedSources({gateway,principal,resources}={}){
 const scope=principalCopy(principal);
 guard(typeof gateway?.readResource==='function'&&Array.isArray(resources)&&resources.length<=16,'invalid_retrieval');
 const sources=[];let bytes=0;
 for(const resource of resources){
  guard(object(resource)&&typeof resource.connectionId==='string'&&typeof resource.uri==='string','invalid_retrieval');
  const envelope=await gateway.readResource({principal:scope,connectionId:resource.connectionId,uri:resource.uri});
  guard(envelope?.untrusted===true&&envelope.result&&!envelope.result.isError,'invalid_retrieval_result');
  const content=envelope.result.contents??envelope.result.content;
  guard(Array.isArray(content)&&content.length>0&&content.length<=100&&content.every(c=>typeof c?.text==='string'),'invalid_retrieval_result');
  const text=content.map(c=>c.text).join('\n');bytes+=Buffer.byteLength(text);
  guard(text.length>0&&Buffer.byteLength(text)<=65536&&bytes<=131072,'retrieval_size_limit');
  const source={...scope,connectionId:resource.connectionId,uri:resource.uri,text,
   sha256:digest(text),sourceId:digest([resource.connectionId,resource.uri,text]),untrusted:true};
  guard(!sources.some(s=>s.sourceId===source.sourceId),'duplicate_source');sources.push(freeze(source));
 }
 return freeze(sources);
}

/** Installed by trusted server code for one principal/source inventory, never by generated text. */
export function createStructuredPolicy({schema,sources=[],principal,allowedTools=[]}={}){
 const scope=principalCopy(principal);
 const data=compileOutputSchema(schema);guard(data.schema.type==='object','object_schema_required');
 guard(Array.isArray(sources)&&sources.length<=16&&Array.isArray(allowedTools)&&allowedTools.length<=16,'invalid_policy');
 const inventory=parseStrictJSON(JSON.stringify(sources));
 for(const s of inventory)guard(s.tenantId===scope.tenantId&&s.identityId===scope.identityId&&s.untrusted===true&&
  typeof s.text==='string'&&Buffer.byteLength(s.text)<=65536&&s.sha256===digest(s.text)&&
  s.sourceId===digest([s.connectionId,s.uri,s.text]),'invalid_source_scope');
 guard(new Set(inventory.map(s=>s.sourceId)).size===inventory.length,'duplicate_source');
 freeze(inventory);
 const tools=allowedTools.map(t=>{
  guard(object(t)&&/^[a-z][a-z0-9_.-]{1,99}$/.test(t.connectionId||'')&&/^[a-z][a-z0-9_.-]{1,99}$/.test(t.toolName||''),'invalid_tool_policy');
  return {...t,inputSchema:compileOutputSchema(t.inputSchema).schema};
 });
 guard(new Set(tools.map(t=>t.connectionId+':'+t.toolName)).size===tools.length,'invalid_tool_policy');
 const obj=properties=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
 // Arguments are JSON text so providers never receive an unconstrained object schema.
 const envelope=compileOutputSchema(obj({data:data.schema,
  citations:{type:'array',maxItems:64,items:obj({sourceId:{type:'string',maxLength:64},quote:{type:'string',minLength:1,maxLength:4096}})},
  toolCalls:{type:'array',maxItems:16,items:obj({connectionId:{type:'string',maxLength:100},toolName:{type:'string',maxLength:100},argumentsJson:{type:'string',maxLength:16384}})}}));
 const sourceMap=new Map(inventory.map(s=>[s.sourceId,s]));
 // Project artifacts can be exported by other authorized project viewers.
 // Preserve provenance without copying every uncited private source into them.
 const artifactSources=freeze(inventory.map(({text,...metadata})=>metadata));
 const identity=digest({scope,schema:envelope.schema,sources:inventory,tools});
 const format=freeze({type:'json_schema',name:'sie_structured_output',strict:true,schema:envelope.schema});
 function validate(raw,context){
  guard(context?.tenantId===scope.tenantId&&context?.session?.identityId===scope.identityId,'structured_scope_denied');
  const result=envelope.validate(parseStrictJSON(raw));
  const cited=new Set();
  for(const c of result.citations){const s=sourceMap.get(c.sourceId);guard(s&&s.text.includes(c.quote),'invalid_citation');cited.add(c.sourceId)}
  for(const call of result.toolCalls){
   const tool=tools.find(t=>t.connectionId===call.connectionId&&t.toolName===call.toolName);
   guard(tool,'tool_proposal_denied');compileOutputSchema(tool.inputSchema).validate(parseStrictJSON(call.argumentsJson));
  }
  const warnings=['citation_text_match_is_not_semantic_verification','model_confidence_not_calibrated'];
  if(cited.size<inventory.length)warnings.push('incomplete_source_coverage');
  if(result.citations.length===0)warnings.push('no_citations');
  return {title:'Validated structured generation',mediaType:'application/json',body:{...result,
   sourceInventory:artifactSources,warnings,citationCoverage:inventory.length?cited.size/inventory.length:null,
   toolCallsExecuted:false},provenance:{structuredPolicySha256:identity}};
 }
 return Object.freeze({id:identity,format,validate,
  assertContext:context=>guard(context?.tenantId===scope.tenantId&&context?.session?.identityId===scope.identityId,'structured_scope_denied')});
}

/** Explicit invocation entry point; the gateway rechecks revocable consent, egress and read-only effect. */
export async function executeApprovedToolProposal({gateway,principal,proposal,allowedTools}={}){
 principalCopy(principal);
 guard(object(proposal)&&Array.isArray(allowedTools)&&typeof gateway?.callTool==='function','invalid_tool_proposal');
 const tool=allowedTools.find(t=>t.connectionId===proposal.connectionId&&t.toolName===proposal.toolName);
 guard(tool,'tool_proposal_denied');
 const args=compileOutputSchema(tool.inputSchema).validate(parseStrictJSON(proposal.argumentsJson));
 return gateway.callTool({principal,connectionId:tool.connectionId,toolName:tool.toolName,args});
}
