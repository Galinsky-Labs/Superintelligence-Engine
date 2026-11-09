// Superintelligence Engine client for companion applications (Academy, Command Center) and scripts.
// Server-side use: pass an API token. Browser use with SSO cookies: omit token, set credentials:'include'.
export class EngineError extends Error {
  constructor(status,body){super(body?.message||body?.code||`HTTP ${status}`);this.name='EngineError';this.status=status;this.code=body?.code;this.body=body;}
}
const enc=encodeURIComponent;

/** Parse a text/event-stream response body into {event,data,id} objects. */
export async function* readEvents(response,{signal}={}){
  const reader=response.body.getReader(),dec=new TextDecoder();let buf='';
  const onAbort=()=>reader.cancel().catch(()=>{});signal?.addEventListener('abort',onAbort);
  try{
    while(true){
      const {done,value}=await reader.read();if(done)break;buf+=dec.decode(value,{stream:true});
      let i;
      while((i=buf.indexOf('\n\n'))>=0){
        const frame=buf.slice(0,i);buf=buf.slice(i+2);if(frame.startsWith(':'))continue;
        const event=/^event: (.*)$/m.exec(frame)?.[1]||'message';const data=/^data: (.*)$/m.exec(frame)?.[1];const id=/^id: (.*)$/m.exec(frame)?.[1];
        if(data!==undefined)yield {event,data:JSON.parse(data),id:id?Number(id):undefined};
      }
    }
  }finally{signal?.removeEventListener('abort',onAbort);}
}

export class EngineClient {
  /**
   * @param {{baseUrl:string, token?:string, tenantId?:string, product?:'academy'|'command'|'engine', fetchImpl?:typeof fetch, credentials?:RequestCredentials}} options
   */
  constructor({baseUrl,token,tenantId,product,fetchImpl=globalThis.fetch,credentials}={}){
    if(!baseUrl)throw new TypeError('baseUrl is required');
    this.base=String(baseUrl).replace(/\/$/,'');this.token=token;this.tenantId=tenantId;this.product=product;this.fetch=fetchImpl;this.credentials=credentials;
  }
  /** Return a client bound to another tenant. */
  forTenant(tenantId){return new EngineClient({baseUrl:this.base,token:this.token,tenantId,product:this.product,fetchImpl:this.fetch,credentials:this.credentials});}
  headers(extra={}){return {...(this.token?{Authorization:'Bearer '+this.token}:{}),...(this.tenantId?{'X-Tenant-Id':this.tenantId}:{}),...(this.product?{'X-SIE-Product':this.product}:{}),...extra};}
  async raw(method,path,{body,headers={},signal}={}){
    const isBytes=body instanceof Uint8Array||(typeof Blob!=='undefined'&&body instanceof Blob);
    return this.fetch(this.base+path,{method,signal,credentials:this.credentials,headers:this.headers({...(body!==undefined&&!isBytes?{'Content-Type':'application/json'}:{}),...headers}),
      body:body===undefined?undefined:isBytes?body:JSON.stringify(body)});
  }
  async request(method,path,body,opts={}){
    const res=await this.raw(method,path,{...opts,body});
    const text=await res.text();let data=null;try{data=text?JSON.parse(text):null}catch{data={message:text}}
    if(!res.ok)throw new EngineError(res.status,data);
    return data;
  }
  async stream(method,path,body,{signal}={}){
    const res=await this.raw(method,path,{body,signal,headers:{Accept:'text/event-stream'}});
    if(!res.ok){let d=null;try{d=await res.json()}catch{}throw new EngineError(res.status,d);}
    return readEvents(res,{signal});
  }
  // ---- platform ----
  health(){return this.request('GET','/health')}
  ready(){return this.request('GET','/ready')}
  capabilities(){return this.request('GET','/v1/capabilities')}
  me(){return this.request('GET','/v1/me')}
  devLogin(handle){return this.request('POST','/v1/dev/login',{handle})}
  createToken({label,days,product}={}){return this.request('POST','/v1/tokens',{label,days,product})}
  revokeToken(id){return this.request('DELETE',`/v1/tokens/${enc(id)}`)}
  tenants(){return this.request('GET','/v1/tenants')}
  createTenant(name){return this.request('POST','/v1/tenants',{name})}
  members(tenantId=this.tenantId){return this.request('GET',`/v1/tenants/${enc(tenantId)}/members`)}
  setMember({identityId,email,role},tenantId=this.tenantId){return this.request('PUT',`/v1/tenants/${enc(tenantId)}/members`,{identityId,email,role})}
  // ---- models, providers, budget ----
  models({capability}={}){return this.request('GET','/v1/models'+(capability?`?capability=${enc(capability)}`:''))}
  providers(){return this.request('GET','/v1/providers')}
  setProviderCredential(provider,{apiKey,baseUrl}){return this.request('PUT',`/v1/providers/${enc(provider)}`,{apiKey,baseUrl})}
  budget(){return this.request('GET','/v1/budget')}
  // ---- projects & artifacts ----
  projects({q,archived}={}){return this.request('GET','/v1/projects'+(q||archived?`?${new URLSearchParams({...(q?{q}:{}),...(archived?{archived:'1'}:{})})}`:''))}
  createProject({title,kind='general',description}){return this.request('POST','/v1/projects',{title,kind,description})}
  project(id){return this.request('GET',`/v1/projects/${enc(id)}`)}
  updateProject(id,patch){return this.request('PATCH',`/v1/projects/${enc(id)}`,patch)}
  deleteProject(id){return this.request('DELETE',`/v1/projects/${enc(id)}`)}
  exportProject(id,{assets=true}={}){return this.request('GET',`/v1/projects/${enc(id)}/export${assets?'':'?assets=0'}`)}
  importProject(bundle){return this.request('POST','/v1/projects/import',bundle)}
  artifacts(projectId,{kind,q}={}){const qs=new URLSearchParams({...(kind?{kind}:{}),...(q?{q}:{})}).toString();return this.request('GET',`/v1/projects/${enc(projectId)}/artifacts${qs?'?'+qs:''}`)}
  artifact(projectId,artifactId,{revision}={}){return this.request('GET',`/v1/projects/${enc(projectId)}/artifacts/${enc(artifactId)}${revision?`?revision=${revision}`:''}`)}
  createArtifact(projectId,{title,kind,text,body,mediaType,assetId,provenance}){return this.request('POST',`/v1/projects/${enc(projectId)}/artifacts`,{title,kind,text,body,mediaType,assetId,provenance})}
  reviseArtifact(projectId,artifactId,{text,body,mediaType,assetId,title,expectedRevision}){return this.request('PUT',`/v1/projects/${enc(projectId)}/artifacts/${enc(artifactId)}`,{text,body,mediaType,assetId,title,expectedRevision})}
  artifactHistory(projectId,artifactId){return this.request('GET',`/v1/projects/${enc(projectId)}/artifacts/${enc(artifactId)}/revisions`)}
  restoreArtifact(projectId,artifactId,revision,expectedRevision){return this.request('POST',`/v1/projects/${enc(projectId)}/artifacts/${enc(artifactId)}/restore`,{revision,expectedRevision})}
  deleteArtifact(projectId,artifactId){return this.request('DELETE',`/v1/projects/${enc(projectId)}/artifacts/${enc(artifactId)}`)}
  async downloadArtifact(projectId,artifactId,{revision}={}){const r=await this.raw('GET',`/v1/projects/${enc(projectId)}/artifacts/${enc(artifactId)}/download${revision?`?revision=${revision}`:''}`);if(!r.ok)throw new EngineError(r.status,null);return {mediaType:r.headers.get('content-type'),bytes:new Uint8Array(await r.arrayBuffer())};}
  uploadAsset(projectId,bytes,{mediaType,title,kind}={}){const qs=new URLSearchParams({...(title?{title}:{}),...(kind?{kind}:{})}).toString();return this.request('POST',`/v1/projects/${enc(projectId)}/assets${qs?'?'+qs:''}`,bytes,{headers:{'Content-Type':mediaType||'application/octet-stream'}});}
  // ---- generation ----
  /** Streamed generation. Yields {event:'token'|'run'|'result'|'error', data}. Output is persisted as an artifact. */
  generateStream(projectId,{prompt,model,outputSchema,tools,system,title,budgetCeilingMicro,maxOutputTokens},{signal}={}){return this.stream('POST',`/v1/projects/${enc(projectId)}/generate`,{prompt,model,outputSchema,tools,system,title,budgetCeilingMicro,maxOutputTokens,stream:true},{signal});}
  generate(projectId,input){return this.request('POST',`/v1/projects/${enc(projectId)}/generate`,{...input,stream:false})}
  // ---- runs (multi-agent workflows) ----
  startRun(projectId,spec,{idempotencyKey}={}){return this.request('POST',`/v1/projects/${enc(projectId)}/runs`,{spec,idempotencyKey})}
  runOperation(projectId,operationId,input,{model,budgetCeilingMicro,idempotencyKey}={}){return this.request('POST',`/v1/projects/${enc(projectId)}/operations/${enc(operationId)}`,{input,model,budgetCeilingMicro,idempotencyKey})}
  workspaces(){return this.request('GET','/v1/workspaces')}
  runs({projectId,status,limit}={}){const qs=new URLSearchParams({...(projectId?{projectId}:{}),...(status?{status}:{}),...(limit?{limit:String(limit)}:{})}).toString();return this.request('GET','/v1/runs'+(qs?'?'+qs:''))}
  run(id){return this.request('GET',`/v1/runs/${enc(id)}`)}
  cancelRun(id){return this.request('POST',`/v1/runs/${enc(id)}/cancel`)}
  retryRun(id){return this.request('POST',`/v1/runs/${enc(id)}/retry`)}
  runEvents(id,{after=0}={}){return this.request('GET',`/v1/runs/${enc(id)}/events?stream=0&after=${after}`)}
  /** Live run events (replay from `after`, then follow until the run finishes). */
  followRun(id,{after=0,signal}={}){return this.stream('GET',`/v1/runs/${enc(id)}/events?after=${after}`,undefined,{signal})}
  async waitForRun(id,{signal,timeoutMs=600000}={}){
    const end=Date.now()+timeoutMs;
    while(Date.now()<end){const r=await this.run(id);if(['succeeded','failed','cancelled','awaiting_approval'].includes(r.status))return r;if(signal?.aborted)throw new Error('aborted');await new Promise(x=>setTimeout(x,1000));}
    throw new Error('timeout waiting for run');
  }
  approvals({status='pending'}={}){return this.request('GET',`/v1/approvals?status=${enc(status)}`)}
  decide(approvalId,decision,note){return this.request('POST',`/v1/approvals/${enc(approvalId)}`,{decision,note})}
  // ---- code workspace ----
  files(projectId){return this.request('GET',`/v1/projects/${enc(projectId)}/files`)}
  readFile(projectId,path){return this.request('GET',`/v1/projects/${enc(projectId)}/files/${path.split('/').map(enc).join('/')}`)}
  writeFile(projectId,path,content,{expectedRevision}={}){return this.request('PUT',`/v1/projects/${enc(projectId)}/files/${path.split('/').map(enc).join('/')}`,{content,expectedRevision})}
  deleteFile(projectId,path){return this.request('DELETE',`/v1/projects/${enc(projectId)}/files/${path.split('/').map(enc).join('/')}`)}
  exec(projectId,{command,language,code,persist,timeoutMs,stdin}){return this.request('POST',`/v1/projects/${enc(projectId)}/exec`,{command,language,code,persist,timeoutMs,stdin})}
  test(projectId,{command}={}){return this.request('POST',`/v1/projects/${enc(projectId)}/test`,{command})}
  diagnostics(projectId){return this.request('GET',`/v1/projects/${enc(projectId)}/diagnostics`)}
  commit(projectId,message){return this.request('POST',`/v1/projects/${enc(projectId)}/git/commit`,{message})}
  gitLog(projectId){return this.request('GET',`/v1/projects/${enc(projectId)}/git/log`)}
  gitDiff(projectId,{from,to}={}){const qs=new URLSearchParams({...(from?{from}:{}),...(to?{to}:{})}).toString();return this.request('GET',`/v1/projects/${enc(projectId)}/git/diff${qs?'?'+qs:''}`)}
  checkout(projectId,commit){return this.request('POST',`/v1/projects/${enc(projectId)}/git/checkout`,{commit})}
  previewUrl(projectId,path='index.html'){return this.request('POST',`/v1/projects/${enc(projectId)}/preview`,{path}).then(r=>({...r,url:this.base+r.url}))}
  // ---- integrations & schedules ----
  connections(){return this.request('GET','/v1/connections')}
  addConnection({kind,name,endpoint,secret,tools}){return this.request('POST','/v1/connections',{kind,name,endpoint,secret,tools})}
  schedules({projectId}={}){return this.request('GET','/v1/schedules'+(projectId?`?projectId=${enc(projectId)}`:''))}
  createSchedule(projectId,{title,cron,timezone,spec,condition}){return this.request('POST',`/v1/projects/${enc(projectId)}/schedules`,{title,cron,timezone,spec,condition})}
  updateSchedule(id,patch){return this.request('PATCH',`/v1/schedules/${enc(id)}`,patch)}
}
