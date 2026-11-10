// Superintelligence Engine HTTP API.
import {createServer} from 'node:http';
import {readFile,stat} from 'node:fs/promises';
import {extname,join,normalize} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {createEngine,Worker,EngineError,check,fail,isUUID,log,metrics,listWorkspaces,compileOperation,requireMembership} from '../../../packages/engine/src/index.mjs';
import {ENGINE_VERSION,WORKSPACE_KINDS} from '../../../packages/core/src/index.mjs';
import {handleProductCors,normalizeProductOrigins,isAllowedBrowserOrigin} from './product-cors.mjs';
import {authRoute} from './auth-routes.mjs';
import {safeRelPath} from '../../../packages/engine/src/sandbox.mjs';
import {zip} from '../../../packages/engine/src/zip.mjs';
import {tracer,Tracer} from '../../../packages/engine/src/tracing.mjs';

const CONSOLE_DIR=fileURLToPath(new URL('../../console/public/',import.meta.url));
const VERSION='0.2.0';
const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.json':'application/json','.txt':'text/plain; charset=utf-8','.md':'text/markdown; charset=utf-8','.wav':'audio/wav','.mp3':'audio/mpeg','.mp4':'video/mp4','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp'};
const SECURITY_HEADERS={'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','X-Frame-Options':'DENY'};

function send(res,status,data,headers={}){
  if(res.headersSent){try{res.end()}catch{}return;}
  res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...SECURITY_HEADERS,...headers});
  res.end(JSON.stringify(data));
}
async function readBody(req,limit=4*1024*1024){
  const chunks=[];let n=0;
  for await(const c of req){n+=c.length;if(n>limit)throw new EngineError('request_too_large',413);chunks.push(c);}
  return Buffer.concat(chunks);
}
async function json(req,limit){
  const b=await readBody(req,limit);if(!b.length)return {};
  check((req.headers['content-type']||'').includes('application/json'),'json_required',415,'Content-Type must be application/json');
  try{const v=JSON.parse(b.toString('utf8'),(k,v)=>k==='__proto__'?undefined:v);check(v&&typeof v==='object'&&!Array.isArray(v),'invalid_json');return v;}
  catch(e){if(e instanceof EngineError)throw e;throw new EngineError('invalid_json',400);}
}
function sseOpen(res){res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-store, no-transform','X-Accel-Buffering':'no',Connection:'keep-alive',...SECURITY_HEADERS});res.flushHeaders?.();}
function sse(res,event,data,id){if(res.writableEnded)return;res.write(`${id!==undefined?`id: ${id}\n`:''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);}

/** Per-key token bucket (per API process). */
class RateLimiter {
  constructor(perMinute){this.rate=perMinute;this.b=new Map();}
  take(key,cost=1){
    if(!this.rate)return true;const now=Date.now();let e=this.b.get(key);
    if(!e){e={t:this.rate,at:now};this.b.set(key,e);if(this.b.size>50000)this.b.clear();}
    e.t=Math.min(this.rate,e.t+(now-e.at)*this.rate/60000);e.at=now;
    if(e.t<cost)return false;e.t-=cost;return true;
  }
}

/** Postgres LISTEN fan-out for live run events. */
class EventHub {
  constructor(url){this.url=url;this.subs=new Map();this.client=null;this.ready=null;}
  async start(){
    if(this.ready)return this.ready;
    this.ready=(async()=>{
      try{
        this.client=new pg.Client({connectionString:this.url,options:'-c sie.system=on'});
        this.client.on('error',e=>{log.warn('event_hub_error',{message:e.message});this.client=null;this.ready=null;});
        await this.client.connect();await this.client.query('LISTEN sie_run_events');
        this.client.on('notification',m=>{for(const fn of this.subs.get(m.payload)||[])fn();});
      }catch(e){log.warn('event_hub_unavailable',{message:e.message});this.client=null;}
    })();
    return this.ready;
  }
  subscribe(runId,fn){if(!this.subs.has(runId))this.subs.set(runId,new Set());this.subs.get(runId).add(fn);return()=>{const s=this.subs.get(runId);s?.delete(fn);if(s&&!s.size)this.subs.delete(runId);};}
  async stop(){try{await this.client?.end()}catch{}}
}

export function createApp({engine,env=process.env,inlineWorker}={}){
  const e=engine||createEngine({env});
  const origins=normalizeProductOrigins({academy:env.ACADEMY_PUBLIC_ORIGIN,command:env.COMMAND_PUBLIC_ORIGIN,extra:(env.SIE_CONSOLE_ORIGINS||'').split(',').filter(Boolean)});
  const selfOrigin=env.SIE_PUBLIC_ORIGIN||null;
  const hub=new EventHub(env.DATABASE_URL);
  const apiWorkerId=`api-${process.pid}-${randomUUID().slice(0,6)}`;
  const worker=inlineWorker??(env.SIE_INLINE_WORKER==='1'?new Worker(e):null);
  const routes=[];
  const limiter=new RateLimiter(Number(env.SIE_RATE_LIMIT_PER_MINUTE??1200)),publicLimiter=new RateLimiter(Number(env.SIE_PUBLIC_RATE_LIMIT_PER_MINUTE??120));
  const route=(method,pattern,handler,opts={})=>{
    const keys=[];const rx=new RegExp('^'+pattern.replace(/:(\w+)(\*?)/g,(_,k,star)=>{keys.push(k);return star?'(.+)':'([^/]+)'})+'$');
    routes.push({method,rx,keys,handler,opts});
  };
  // ---------------- public ----------------
  route('GET','/health',async()=>({status:'ok',version:VERSION,engineVersion:ENGINE_VERSION}),{public:true});
  route('GET','/ready',async()=>{
    await e.pools.system.query('SELECT 1');
    const m=await e.pools.system.query("SELECT count(*)::int n FROM schema_migrations");
    return {status:'ready',database:'ok',migrations:m.rows[0].n,sandbox:e.sandbox.info()};
  },{public:true});
  route('GET','/metrics',async(ctx)=>{
    if(env.SIE_METRICS_TOKEN&&ctx.req.headers.authorization!=='Bearer '+env.SIE_METRICS_TOKEN)fail('unauthorized',401);
    const q=await e.pools.system.query(`SELECT status,count(*)::int n FROM runs GROUP BY status`);
    for(const r of q.rows)metrics.set('sie_runs',{status:r.status},r.n);
    const n=await e.pools.system.query(`SELECT state,count(*)::int n FROM run_nodes WHERE state IN ('ready','running','awaiting_approval') GROUP BY state`);
    for(const s of ['ready','running','awaiting_approval'])metrics.set('sie_nodes',{state:s},n.rows.find(r=>r.state===s)?.n||0);
    ctx.res.writeHead(200,{'Content-Type':'text/plain; version=0.0.4','Cache-Control':'no-store'});ctx.res.end(metrics.render());return undefined;
  },{public:true,raw:true});
  route('GET','/v1/capabilities',async(ctx)=>{
    let providers=[],generationEnabled=false,models=[];
    const tenantId=ctx.req.headers['x-tenant-id'];
    if(ctx.principal&&isUUID(tenantId)&&(await e.pools.system.query('SELECT 1 FROM memberships WHERE tenant_id=$1 AND identity_id=$2',[tenantId,ctx.principal.identityId])).rowCount){
      models=(await e.catalog.models(tenantId)).filter(m=>m.available);
      providers=[...new Set(models.map(m=>m.provider))];
      generationEnabled=models.some(m=>!m.simulated&&m.capabilities.includes('chat'));
    }
    return {version:VERSION,workspaceKinds:WORKSPACE_KINDS,domains:listWorkspaces().map(d=>d.id),availableProviders:providers,generationEnabled,
      simulatedProviderEnabled:models.some(m=>m.simulated),sandbox:e.sandbox.info(),authentication:{devLogin:e.devAuth,oidc:Boolean(e.identity.oidc),apiTokens:true}};
  },{public:true,optionalAuth:true});
  route('POST','/v1/dev/login',async(ctx)=>{const b=await json(ctx.req);return e.identity.devLogin({handle:b.handle,displayName:b.displayName,product:b.product||'engine'});},{public:true,status:201});

  // ---------------- identity ----------------
  route('GET','/v1/me',async c=>e.identity.me(c.principal));
  route('GET','/v1/tokens',async c=>({items:await e.identity.listTokens(c.principal.identityId)}));
  route('POST','/v1/tokens',async c=>{const b=await json(c.req);return e.identity.issueToken(c.principal.identityId,{product:b.product||'engine',label:b.label||'',days:b.days||30});},{status:201});
  route('DELETE','/v1/tokens/:id',async c=>e.identity.revokeToken(c.principal.identityId,c.params.id));
  route('GET','/v1/tenants',async c=>e.identity.listTenants(c.principal));
  route('POST','/v1/tenants',async c=>e.identity.createTenant(c.principal,await json(c.req)),{status:201});
  route('GET','/v1/tenants/:tid/members',async c=>e.identity.listMembers(c.principal,c.params.tid));
  route('PUT','/v1/tenants/:tid/members',async c=>e.identity.setMember(c.principal,c.params.tid,await json(c.req)));
  route('DELETE','/v1/tenants/:tid/members/:iid',async c=>e.identity.removeMember(c.principal,c.params.tid,c.params.iid));

  // ---------------- providers, models, budget ----------------
  route('GET','/v1/models',async c=>{await requireMembership(e.pools.system,c.principal,c.tenant,'viewer');const cap=c.query.get('capability');const items=(await e.catalog.models(c.tenant)).filter(m=>!cap||m.capabilities.includes(cap));return {items};},{tenant:true});
  route('GET','/v1/providers',async c=>e.catalog.providers(c.principal,c.tenant),{tenant:true});
  route('PUT','/v1/providers/:provider',async c=>e.catalog.setCredential(c.principal,c.tenant,{provider:c.params.provider,...await json(c.req)}),{tenant:true});
  route('DELETE','/v1/providers/:provider',async c=>e.catalog.deleteCredential(c.principal,c.tenant,c.params.provider),{tenant:true});
  route('GET','/v1/providers/:provider/models',async c=>e.catalog.discover(c.principal,c.tenant,c.params.provider),{tenant:true});
  route('GET','/v1/budget',async c=>e.meter.summary(c.principal,c.tenant,{days:Number(c.query.get('days')||30)}),{tenant:true});
  route('GET','/v1/usage',async c=>e.meter.summary(c.principal,c.tenant,{days:Number(c.query.get('days')||30)}),{tenant:true});
  route('PUT','/v1/budget',async c=>e.meter.setTenantLimit(c.principal,c.tenant,await json(c.req)),{tenant:true});

  // ---------------- projects & artifacts ----------------
  route('GET','/v1/projects',async c=>e.projects.listProjects(c.principal,c.tenant,{includeArchived:c.query.get('archived')==='1',q:c.query.get('q')||undefined}),{tenant:true});
  route('POST','/v1/projects',async c=>e.projects.createProject(c.principal,c.tenant,await json(c.req)),{tenant:true,status:201});
  route('POST','/v1/projects/import',async c=>e.projects.importProject(c.principal,c.tenant,await json(c.req,200*1024*1024)),{tenant:true,status:201});
  route('GET','/v1/projects/:pid',async c=>e.projects.getProject(c.principal,c.tenant,c.params.pid),{tenant:true});
  route('PATCH','/v1/projects/:pid',async c=>e.projects.updateProject(c.principal,c.tenant,c.params.pid,await json(c.req)),{tenant:true});
  route('DELETE','/v1/projects/:pid',async c=>e.projects.deleteProject(c.principal,c.tenant,c.params.pid),{tenant:true});
  route('GET','/v1/projects/:pid/export',async c=>{
    const x=await e.projects.exportProject(c.principal,c.tenant,c.params.pid,{embedAssets:c.query.get('assets')!=='0'||c.query.get('format')==='zip'});
    if(c.query.get('format')==='zip'){
      const ext={'text/markdown':'md','text/plain':'txt','application/json':'json','image/png':'png','image/jpeg':'jpg','image/webp':'webp','image/gif':'gif','audio/mpeg':'mp3','audio/wav':'wav','video/mp4':'mp4','text/csv':'csv','application/pdf':'pdf'};
      const used=new Set();const safe=t=>{let n=String(t||'artifact').replace(/[^A-Za-z0-9._ -]+/g,'_').slice(0,80)||'artifact';let k=n,i=2;while(used.has(k))k=`${n} (${i++})`;used.add(k);return k;};
      const entries=[];
      for(const a of x.artifacts){const v=a.revisions.at(-1);if(!v)continue;const name=safe(a.title);
        if(v.assetId&&x.assets[v.assetId])entries.push({name:`artifacts/${name}.${ext[v.mediaType]||'bin'}`,data:Buffer.from(x.assets[v.assetId].base64,'base64')});
        else entries.push({name:`artifacts/${name}.${typeof v.body==='string'?(ext[v.mediaType]||'md'):'json'}`,data:typeof v.body==='string'?v.body:JSON.stringify(v.body,null,2)});}
      for(const f of x.workspaceFiles)entries.push({name:`workspace/${f.path}`,data:f.content});
      entries.push({name:'project.json',data:JSON.stringify(x)});
      const buf=zip(entries);
      c.res.writeHead(200,{'Content-Type':'application/zip','Content-Length':buf.length,'Cache-Control':'no-store','Content-Disposition':`attachment; filename="project-${c.params.pid}.zip"`,...SECURITY_HEADERS});return c.res.end(buf);
    }
    c.res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Content-Disposition':`attachment; filename="project-${c.params.pid}.json"`,...SECURITY_HEADERS});c.res.end(JSON.stringify(x));
  },{tenant:true,raw:true});
  route('GET','/v1/projects/:pid/artifacts',async c=>e.projects.listArtifacts(c.principal,c.tenant,c.params.pid,{kind:c.query.get('kind')||undefined,q:c.query.get('q')||undefined}),{tenant:true});
  route('POST','/v1/projects/:pid/artifacts',async c=>e.projects.createArtifact(c.principal,c.tenant,c.params.pid,await json(c.req)),{tenant:true,status:201});
  route('GET','/v1/projects/:pid/artifacts/:aid',async c=>e.projects.getArtifact(c.principal,c.tenant,c.params.pid,c.params.aid,{revision:c.query.get('revision')?Number(c.query.get('revision')):undefined}),{tenant:true});
  route('PUT','/v1/projects/:pid/artifacts/:aid',async c=>e.projects.reviseArtifact(c.principal,c.tenant,c.params.pid,c.params.aid,await json(c.req)),{tenant:true});
  route('DELETE','/v1/projects/:pid/artifacts/:aid',async c=>e.projects.deleteArtifact(c.principal,c.tenant,c.params.pid,c.params.aid),{tenant:true});
  route('GET','/v1/projects/:pid/artifacts/:aid/revisions',async c=>e.projects.history(c.principal,c.tenant,c.params.pid,c.params.aid),{tenant:true});
  route('POST','/v1/projects/:pid/artifacts/:aid/restore',async c=>e.projects.restore(c.principal,c.tenant,c.params.pid,c.params.aid,await json(c.req)),{tenant:true,status:201});
  route('GET','/v1/projects/:pid/artifacts/:aid/download',async c=>{
    const a=await e.projects.getArtifact(c.principal,c.tenant,c.params.pid,c.params.aid,{revision:c.query.get('revision')?Number(c.query.get('revision')):undefined});
    let bytes,type;
    if(a.assetId){const x=await e.assets.read({tenantId:c.tenant,assetId:a.assetId});bytes=x.bytes;type=x.mediaType;}
    else if(typeof a.body==='string'){bytes=Buffer.from(a.body);type=(a.mediaType.startsWith('text/')?a.mediaType:'text/plain')+'; charset=utf-8';}
    else{bytes=Buffer.from(JSON.stringify(a.body,null,2));type='application/json; charset=utf-8';}
    const ext={'text/markdown':'md','text/plain':'txt','application/json':'json','image/png':'png','image/jpeg':'jpg','audio/mpeg':'mp3','audio/wav':'wav','video/mp4':'mp4'}[type.split(';')[0]]||'bin';
    const name=(a.title||'artifact').replace(/[^A-Za-z0-9._ -]+/g,'_').slice(0,80);
    c.res.writeHead(200,{'Content-Type':type,'Content-Length':bytes.length,'Content-Disposition':`${c.query.get('inline')?'inline':'attachment'}; filename="${name}.${ext}"`,'Cache-Control':'private, no-store','Content-Security-Policy':"default-src 'none'; sandbox",...SECURITY_HEADERS});
    c.res.end(bytes);
  },{tenant:true,raw:true});
  route('POST','/v1/projects/:pid/assets',async c=>{
    await requireMembership(e.pools.system,c.principal,c.tenant,'member');
    const p=await e.projects.getProject(c.principal,c.tenant,c.params.pid);
    const bytes=await readBody(c.req,Number(env.SIE_MAX_ASSET_BYTES||50*1024*1024));
    const asset=await e.assets.put({tenantId:c.tenant,projectId:p.id,bytes,mediaType:(c.req.headers['content-type']||'application/octet-stream').split(';')[0].trim()});
    const title=c.query.get('title');
    const artifact=title?await e.projects.createArtifact(c.principal,c.tenant,p.id,{title,kind:c.query.get('kind')||'upload',assetId:asset.id,provenance:{source:'upload'}}):null;
    return {asset,artifact};
  },{tenant:true,status:201});
  route('GET','/v1/assets/:id',async c=>{
    await requireMembership(e.pools.system,c.principal,c.tenant,'viewer');
    const a=await e.assets.read({tenantId:c.tenant,assetId:c.params.id});
    c.res.writeHead(200,{'Content-Type':a.mediaType,'Content-Length':a.bytes.length,'Cache-Control':'private, no-store','Content-Security-Policy':"default-src 'none'; sandbox",...SECURITY_HEADERS});c.res.end(a.bytes);
  },{tenant:true,raw:true});

  // ---------------- generation (streamed, persisted) ----------------
  route('POST','/v1/projects/:pid/generate',async c=>{
    const b=await json(c.req);
    check(typeof b.prompt==='string'&&b.prompt.trim()&&b.prompt.length<=200000,'invalid_prompt');
    const node={key:'generate',type:'agent',instructions:b.prompt,role:b.role||'a helpful expert assistant',includeInputs:false,maxAttempts:1,
      ...(b.model?{model:b.model}:{}),...(b.outputSchema?{outputSchema:b.outputSchema}:{}),...(b.tools?{tools:b.tools}:{}),...(b.system?{system:b.system}:{}),
      maxOutputTokens:b.maxOutputTokens||8192,artifact:{title:(b.title||b.prompt.split('\n')[0]).slice(0,200),kind:b.kind||'generation'}};
    const run=await e.runs.createRun(c.principal,c.tenant,c.params.pid,{kind:'generation',title:(b.title||b.prompt).slice(0,120),spec:{nodes:[node],budgetCeilingMicro:b.budgetCeilingMicro||0},idempotencyKey:c.req.headers['idempotency-key']||undefined});
    const stream=b.stream!==false;
    if(stream){sseOpen(c.res);sse(c.res,'run',{runId:run.id,status:run.status});}
    let claimed=null;
    if(!run.replayed)claimed=await e.runs.claimNode(run.id,'generate',{workerId:apiWorkerId});
    let result;
    if(claimed){
      const ka=stream?setInterval(()=>c.res.write(': keep-alive\n\n'),15000):null;
      try{result=await e.executor.execute({...claimed,onDelta:stream?t=>sse(c.res,'token',{text:t}):undefined});}finally{if(ka)clearInterval(ka);}
    }
    const full=await e.runs.get(c.principal,c.tenant,run.id);
    const n=full.nodes[0];
    const payload={runId:run.id,status:full.status,artifactId:n?.artifactId||null,output:n?.output||null,error:n?.error||full.error||null,costMicro:full.spentMicro,replayed:Boolean(run.replayed)};
    if(stream){sse(c.res,full.status==='succeeded'?'result':'error',payload);c.res.end();return undefined;}
    return payload;
  },{tenant:true,raw:true});

  // ---------------- runs & approvals ----------------
  route('POST','/v1/projects/:pid/runs',async c=>{const b=await json(c.req);return e.runs.createRun(c.principal,c.tenant,c.params.pid,{kind:'workflow',spec:b.spec||b,title:b.title,idempotencyKey:b.idempotencyKey||c.req.headers['idempotency-key']||undefined});},{tenant:true,status:201});
  route('GET','/v1/runs',async c=>e.runs.list(c.principal,c.tenant,{projectId:c.query.get('projectId')||undefined,status:c.query.get('status')||undefined,limit:c.query.get('limit')}),{tenant:true});
  route('GET','/v1/runs/:rid',async c=>e.runs.get(c.principal,c.tenant,c.params.rid),{tenant:true});
  route('POST','/v1/runs/:rid/cancel',async c=>e.runs.cancel(c.principal,c.tenant,c.params.rid),{tenant:true});
  route('POST','/v1/runs/:rid/retry',async c=>e.runs.retry(c.principal,c.tenant,c.params.rid),{tenant:true});
  route('GET','/v1/runs/:rid/events',async c=>{
    const after=Number(c.req.headers['last-event-id']||c.query.get('after')||0);check(Number.isSafeInteger(after)&&after>=0,'invalid_cursor');
    let cursor=after;
    const first=await e.runs.events(c.principal,c.tenant,c.params.rid,{after:cursor});
    if(c.query.get('stream')==='0'){send(c.res,200,{items:first});return undefined;}
    sseOpen(c.res);
    const push=list=>{for(const ev of list){sse(c.res,ev.type,ev,ev.id);cursor=ev.id;}};
    push(first);sse(c.res,'replay-end',{cursor});
    let closed=false,busy=false,again=false;
    const finish=()=>{if(closed)return;closed=true;unsub();clearInterval(poll);clearInterval(ka);c.res.end();};
    const pull=async()=>{
      if(closed)return;if(busy){again=true;return;}busy=true;
      try{do{again=false;const evs=await e.runs.events(c.principal,c.tenant,c.params.rid,{after:cursor});push(evs);
        if(evs.some(x=>['run.succeeded','run.failed','run.cancelled'].includes(x.type)))return finish();}while(again);}
      catch{finish();}finally{busy=false;}
    };
    await hub.start();const unsub=hub.subscribe(c.params.rid,pull);
    const poll=setInterval(pull,hub.client?5000:1000),ka=setInterval(()=>!closed&&c.res.write(': keep-alive\n\n'),15000);
    c.req.on('close',finish);
    if(first.some(x=>['run.succeeded','run.failed','run.cancelled'].includes(x.type)))finish();
    return undefined;
  },{tenant:true,raw:true});
  route('GET','/v1/approvals',async c=>e.runs.listApprovals(c.principal,c.tenant,{status:c.query.has('status')?c.query.get('status')||null:'pending'}),{tenant:true});
  route('POST','/v1/approvals/:id',async c=>e.runs.decide(c.principal,c.tenant,c.params.id,await json(c.req)),{tenant:true});

  // ---------------- saved workflows ----------------
  route('GET','/v1/projects/:pid/workflows',async c=>e.workflows.list(c.principal,c.tenant,c.params.pid),{tenant:true});
  route('POST','/v1/projects/:pid/workflows',async c=>e.workflows.create(c.principal,c.tenant,c.params.pid,await json(c.req)),{tenant:true,status:201});
  route('GET','/v1/workflows/:id',async c=>e.workflows.get(c.principal,c.tenant,c.params.id),{tenant:true});
  route('PUT','/v1/workflows/:id',async c=>e.workflows.update(c.principal,c.tenant,c.params.id,await json(c.req)),{tenant:true});
  route('DELETE','/v1/workflows/:id',async c=>e.workflows.remove(c.principal,c.tenant,c.params.id),{tenant:true});
  route('GET','/v1/workflows/:id/versions',async c=>e.workflows.versions(c.principal,c.tenant,c.params.id),{tenant:true});
  route('POST','/v1/workflows/:id/runs',async c=>e.workflows.run(c.principal,c.tenant,c.params.id,await json(c.req)),{tenant:true,status:201});

  // ---------------- domain workspaces ----------------
  route('GET','/v1/workspaces',async()=>({items:listWorkspaces()}),{public:true});
  route('POST','/v1/projects/:pid/operations/:op',async c=>{
    const b=await json(c.req);const input={...(b.input||{})};
    const {op,spec}=compileOperation(c.params.op,input,{model:b.model,budgetCeilingMicro:b.budgetCeilingMicro});
    if(op.prepare==='dataset'){ // place the dataset into the workspace so sandboxed code can read it
      let data=input.data;
      if(!data&&input.artifactId){const a=await e.projects.getArtifact(c.principal,c.tenant,c.params.pid,input.artifactId);
        data=a.assetId?(await e.assets.read({tenantId:c.tenant,assetId:a.assetId})).bytes.toString('utf8'):typeof a.body==='string'?a.body:JSON.stringify(a.body);}
      check(typeof data==='string'&&data.length,'dataset_required',400,'Provide data or an artifactId');
      const path=data.trim().startsWith('{')||data.trim().startsWith('[')?'data/input.json':'data/input.csv';
      await e.workspace.write(c.principal,c.tenant,c.params.pid,path,{content:data});
      spec.nodes[0].instructions=spec.nodes[0].instructions.replace('data/input.csv',path);
    }
    return e.runs.createRun(c.principal,c.tenant,c.params.pid,{kind:'operation',spec,title:spec.title,idempotencyKey:b.idempotencyKey});
  },{tenant:true,status:201});

  // ---------------- code workspace ----------------
  route('GET','/v1/projects/:pid/files',async c=>e.workspace.list(c.principal,c.tenant,c.params.pid),{tenant:true});
  route('GET','/v1/projects/:pid/files/:path*',async c=>e.workspace.read(c.principal,c.tenant,c.params.pid,c.params.path),{tenant:true});
  route('PUT','/v1/projects/:pid/files/:path*',async c=>{const b=await json(c.req,2*1024*1024);return e.workspace.write(c.principal,c.tenant,c.params.pid,c.params.path,b);},{tenant:true});
  route('DELETE','/v1/projects/:pid/files/:path*',async c=>e.workspace.remove(c.principal,c.tenant,c.params.pid,c.params.path),{tenant:true});
  route('GET','/v1/projects/:pid/file-history/:path*',async c=>e.workspace.history(c.principal,c.tenant,c.params.pid,c.params.path),{tenant:true});
  route('POST','/v1/projects/:pid/exec',async c=>e.workspace.userExec(c.principal,c.tenant,c.params.pid,await json(c.req,2*1024*1024)),{tenant:true});
  route('POST','/v1/projects/:pid/test',async c=>e.workspace.test(c.principal,c.tenant,c.params.pid,await json(c.req)),{tenant:true});
  route('GET','/v1/projects/:pid/diagnostics',async c=>e.workspace.diagnostics(c.principal,c.tenant,c.params.pid),{tenant:true});
  route('POST','/v1/projects/:pid/git/commit',async c=>e.workspace.commit(c.principal,c.tenant,c.params.pid,await json(c.req)),{tenant:true,status:201});
  route('GET','/v1/projects/:pid/git/log',async c=>e.workspace.log(c.principal,c.tenant,c.params.pid),{tenant:true});
  route('GET','/v1/projects/:pid/git/diff',async c=>e.workspace.diff(c.principal,c.tenant,c.params.pid,{from:c.query.get('from')||undefined,to:c.query.get('to')||undefined}),{tenant:true});
  route('POST','/v1/projects/:pid/git/checkout',async c=>e.workspace.checkout(c.principal,c.tenant,c.params.pid,await json(c.req)),{tenant:true});
  route('POST','/v1/projects/:pid/preview',async c=>{
    await e.projects.getProject(c.principal,c.tenant,c.params.pid);
    const token=e.workspace.previewToken(c.tenant,c.params.pid);const b=await json(c.req);const entry=safeRelPath(b.path||'index.html');
    return {url:`/preview/${c.tenant}/${c.params.pid}/${token}/${entry}`,expiresInSeconds:3600};
  },{tenant:true});
  route('GET','/preview/:tid/:pid/:token/:path*',async c=>{
    check(isUUID(c.params.tid)&&isUUID(c.params.pid)&&e.workspace.verifyPreview(c.params.tid,c.params.pid,c.params.token),'preview_forbidden',403);
    const path=safeRelPath(decodeURIComponent(c.params.path));
    const f=(await e.pools.system.query('SELECT content FROM workspace_files WHERE tenant_id=$1 AND project_id=$2 AND path=$3',[c.params.tid,c.params.pid,path])).rows[0];
    check(f,'file_not_found',404);
    // The preview runs in an opaque sandboxed origin: no access to engine cookies/storage, no network beyond itself.
    c.res.writeHead(200,{'Content-Type':MIME[extname(path)]||'text/plain; charset=utf-8','Cache-Control':'no-store','Content-Security-Policy':"sandbox allow-scripts allow-forms; default-src 'self' 'unsafe-inline' data: blob:; connect-src 'none'",'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});
    c.res.end(f.content);
  },{public:true,raw:true});

  // ---------------- integrations & schedules ----------------
  route('GET','/v1/connections',async c=>e.connections.list(c.principal,c.tenant),{tenant:true});
  route('POST','/v1/connections',async c=>e.connections.create(c.principal,c.tenant,await json(c.req)),{tenant:true,status:201});
  route('PATCH','/v1/connections/:id/tools',async c=>e.connections.setToolEffect(c.principal,c.tenant,c.params.id,await json(c.req)),{tenant:true});
  route('DELETE','/v1/connections/:id',async c=>e.connections.remove(c.principal,c.tenant,c.params.id),{tenant:true});
  route('GET','/v1/tool-audit',async c=>{await requireMembership(e.pools.system,c.principal,c.tenant,'admin');
    const r=await e.pools.system.query('SELECT id,run_id,node_key,tool,effect,decision,detail,recorded_at FROM tool_audit WHERE tenant_id=$1 ORDER BY id DESC LIMIT 200',[c.tenant]);
    return {items:r.rows.map(x=>({id:Number(x.id),runId:x.run_id,node:x.node_key,tool:x.tool,effect:x.effect,decision:x.decision,detail:x.detail,recordedAt:x.recorded_at}))};},{tenant:true});
  route('GET','/v1/schedules',async c=>e.scheduler.list(c.principal,c.tenant,{projectId:c.query.get('projectId')||undefined}),{tenant:true});
  route('POST','/v1/projects/:pid/schedules',async c=>e.scheduler.create(c.principal,c.tenant,c.params.pid,await json(c.req)),{tenant:true,status:201});
  route('PATCH','/v1/schedules/:id',async c=>e.scheduler.update(c.principal,c.tenant,c.params.id,await json(c.req)),{tenant:true});
  route('DELETE','/v1/schedules/:id',async c=>e.scheduler.remove(c.principal,c.tenant,c.params.id),{tenant:true});

  async function serveConsole(req,res,path){
    let rel=path.replace(/^\/app\/?/,'')||'index.html';
    const full=normalize(join(CONSOLE_DIR,rel));
    if(!full.startsWith(CONSOLE_DIR))return send(res,404,{code:'not_found'});
    let file=full;
    try{if((await stat(file)).isDirectory())file=join(file,'index.html');}catch{file=join(CONSOLE_DIR,'index.html');}
    try{
      const body=await readFile(file);
      res.writeHead(200,{'Content-Type':MIME[extname(file)]||'application/octet-stream','Cache-Control':'no-cache',...SECURITY_HEADERS,
        'Content-Security-Policy':"default-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-src 'self'; frame-ancestors 'none'"});
      res.end(body);
    }catch{send(res,404,{code:'not_found'});}
  }

  async function handler(req,res){
    const started=process.hrtime.bigint();const reqId=randomUUID();res.setHeader('X-Request-Id',reqId);
    const url=new URL(req.url||'/','http://localhost');const path=url.pathname;
    let matchedRoute='unmatched';
    const parent=Tracer.parseTraceparent(req.headers.traceparent);
    const span=tracer.start(`${req.method} http`,{traceId:parent?.traceId,parentSpanId:parent?.spanId,kind:2,attributes:{'http.request.method':req.method,'url.path':path.slice(0,200)}});
    if(tracer.enabled)res.setHeader('traceparent',span.traceparent);
    res.on('finish',()=>{span.set('http.route',matchedRoute).set('http.response.status_code',res.statusCode);if(res.statusCode>=500)span.error('HTTP '+res.statusCode);span.end();const ms=Number(process.hrtime.bigint()-started)/1e6;metrics.inc('sie_http_requests_total',{route:matchedRoute,status:String(res.statusCode)});metrics.observe('sie_http_request_seconds',{route:matchedRoute},ms/1000);
      if(path!=='/health')log.info('http_request',{reqId,method:req.method,path:matchedRoute,status:res.statusCode,ms:Math.round(ms)});});
    try{
      if(handleProductCors(req,res,path,{origins,selfOrigin}))return;
      if(path==='/'&&req.method==='GET'){res.writeHead(302,{Location:'/app/'});return res.end();}
      if(path.startsWith('/app')&&req.method==='GET')return serveConsole(req,res,path);
      if(authRoute(req,res,path))return;
      const candidates=routes.filter(r=>r.rx.test(path));
      if(!candidates.length)return send(res,404,{code:'not_found',message:'Unknown API route'});
      const r=candidates.find(x=>x.method===req.method);
      if(!r)return send(res,405,{code:'method_not_allowed'});
      matchedRoute=r.rx.source;
      const m=r.rx.exec(path);let params;
      try{params=Object.fromEntries(r.keys.map((k,i)=>[k,decodeURIComponent(m[i+1])]));}catch{return send(res,400,{code:'invalid_path'});}
      // Single-segment parameters must not smuggle path separators or traversal after decoding.
      for(const [k,v] of Object.entries(params))if(k!=='path'&&(/[\/\\]/.test(v)||v==='..'||v==='.'))return send(res,400,{code:'invalid_path'});
      let principal=null;
      const ip=(env.SIE_TRUST_PROXY==='1'&&String(req.headers['x-forwarded-for']||'').split(',')[0].trim())||req.socket.remoteAddress||'?';
      if(r.opts.public&&!r.opts.optionalAuth&&req.method!=='GET'&&!publicLimiter.take('ip:'+ip))return send(res,429,{code:'rate_limited',message:'Too many requests'},{'Retry-After':'30'});
      if(!r.opts.public||r.opts.optionalAuth){
        principal=await e.identity.authenticate(req);
        if(!principal&&!r.opts.public)return send(res,401,{code:'authentication_required',message:'Provide a Bearer API token or a valid session'});
        if(principal&&!limiter.take('id:'+principal.identityId))return send(res,429,{code:'rate_limited',message:'Too many requests'},{'Retry-After':'10'});
        // Cookie-authenticated browser writes must come from a registered origin (CSRF defense).
        if(principal?.via==='oidc'&&!['GET','HEAD'].includes(req.method)&&!isAllowedBrowserOrigin(req.headers.origin,origins,selfOrigin,req.headers.host))return send(res,403,{code:'origin_not_allowed'});
      }
      let tenant=null;
      if(r.opts.tenant){tenant=req.headers['x-tenant-id']||url.searchParams.get('tenant');if(!isUUID(tenant))return send(res,400,{code:'tenant_required',message:'Set the X-Tenant-Id header'});}
      const ctx={req,res,params,query:url.searchParams,principal,tenant};
      const out=await r.handler(ctx);
      if(r.opts.raw)return;
      send(res,r.opts.status||200,out??{});
    }catch(err){
      if(err instanceof EngineError){
        if(res.headersSent){if(!res.writableEnded){sse(res,'error',{code:err.code,message:err.message});res.end();}return;}
        return send(res,err.status||400,{code:err.code,message:err.message,...(err.details?{details:err.details}:{})});
      }
      log.error('http_unhandled',{reqId,path,message:err.message,stack:err.stack?.split('\n').slice(0,5).join(' | ')});
      if(res.headersSent){if(!res.writableEnded){sse(res,'error',{code:'server_error'});res.end();}return;}
      send(res,500,{code:'server_error',message:'Unexpected server error',requestId:reqId});
    }
  }
  return {handler,engine:e,worker,hub,routes,async close(){worker?.stop();await hub.stop();await tracer.flush();await e.close();}};
}

export function makeServer(options={}){
  const app=createApp(options);
  const server=createServer((req,res)=>{app.handler(req,res)});
  server.app=app;
  server.requestTimeout=0;server.headersTimeout=60000;
  return server;
}

if(process.argv[1]&&import.meta.url===new URL('file://'+process.argv[1]).href){
  const port=Number(process.env.PORT||8080);
  const server=makeServer();
  const ac=new AbortController();
  server.listen(port,process.env.HOST||'0.0.0.0',()=>log.info('api_listening',{port,inlineWorker:Boolean(server.app.worker),devAuth:server.app.engine.devAuth,sandbox:server.app.engine.sandbox.info().backend}));
  if(server.app.worker)server.app.worker.run({signal:ac.signal});
  const shutdown=async sig=>{log.info('shutdown',{signal:sig});ac.abort();server.close();setTimeout(()=>process.exit(0),10000).unref();await server.app.close().catch(()=>{});process.exit(0);};
  process.once('SIGTERM',shutdown);process.once('SIGINT',shutdown);
}
