// Agent tools. Every tool declares an effect class; the executor enforces:
//   read / compute / project_write  -> allowed when the node lists the tool
//   external / deploy / financial / publish / delete -> require an approval bound to the exact request
// All invocations are audited in tool_audit.
import {EngineError,check,fail,isObject,sha256,log} from './infra.mjs';
import {validate} from './schema.mjs';
import {guardedFetch,egressPolicy,hostAllowlisted,htmlToText} from './net.mjs';

export const APPROVAL_EFFECTS=new Set(['external','deploy','financial','publish','delete']);
const obj=(properties,required=Object.keys(properties))=>({type:'object',properties,required,additionalProperties:false});

// Safe arithmetic evaluator (no eval): numbers, + - * / % ^, parentheses, a few functions.
export function calculate(expr){
  check(typeof expr==='string'&&expr.length<=500,'invalid_expression');
  const tokens=expr.match(/\d+(?:\.\d+)?(?:e[+-]?\d+)?|[A-Za-z_]+|[-+*/%^(),]/gi)||[];
  check(tokens.join('')===expr.replace(/\s+/g,''),'invalid_expression',400,'Unsupported characters');
  const FN={sqrt:Math.sqrt,abs:Math.abs,log:Math.log,ln:Math.log,log10:Math.log10,exp:Math.exp,sin:Math.sin,cos:Math.cos,tan:Math.tan,round:Math.round,floor:Math.floor,ceil:Math.ceil,min:Math.min,max:Math.max};
  const CONST={pi:Math.PI,e:Math.E};let i=0;
  const peek=()=>tokens[i],next=()=>tokens[i++];
  const primary=()=>{const t=next();
    if(t==='('){const v=add();check(next()===')','invalid_expression');return v;}
    if(t==='-')return -unary();if(t==='+')return unary();
    if(/^[\d.]/.test(t||''))return Number(t);
    if(t&&CONST[t.toLowerCase()]!==undefined)return CONST[t.toLowerCase()];
    if(t&&FN[t.toLowerCase()]){check(next()==='(','invalid_expression');const args=[add()];while(peek()===','){next();args.push(add());}check(next()===')','invalid_expression');return FN[t.toLowerCase()](...args);}
    fail('invalid_expression',400,'Unexpected token '+t);};
  const unary=()=>{let v=primary();if(peek()==='^'){next();v=v**unary();}return v;};
  const mul=()=>{let v=unary();while(['*','/','%'].includes(peek())){const o=next(),r=unary();v=o==='*'?v*r:o==='/'?v/r:v%r;}return v;};
  const add=()=>{let v=mul();while(['+','-'].includes(peek())){const o=next(),r=mul();v=o==='+'?v+r:v-r;}return v;};
  const v=add();check(i===tokens.length,'invalid_expression');return v;
}

/** Build the tool set available to one node. `allowed` = tool names / groups from the node config. */
export async function buildTools(ctx,allowed=[]){
  const {services,tenantId,projectId,identityId,runId,nodeKey}=ctx;
  const groups={project:['artifact_list','artifact_read','artifact_write'],files:['file_list','file_read','file_write'],code:['code_run','workspace_exec','file_list','file_read','file_write'],
    research:['web_fetch','artifact_list','artifact_read'],math:['calculator'],git:['git_commit','git_push']};
  const want=new Set(allowed.flatMap(a=>groups[a]||[a]));
  const policy=services.egress||egressPolicy();
  const tools=[
    {name:'artifact_list',description:'List artifacts saved in the current project (id, title, kind, media type).',inputSchema:obj({}),effect:'read',
      run:async()=>({items:await services.projects.systemListArtifacts({tenantId,projectId})})},
    {name:'artifact_read',description:'Read the current content of a project artifact by id.',inputSchema:obj({artifactId:{type:'string'}}),effect:'read',
      run:async a=>{const x=await services.projects.systemReadArtifact({tenantId,projectId,artifactId:a.artifactId});return {...x,body:typeof x.body==='string'?x.body.slice(0,60000):x.body};}},
    {name:'artifact_write',description:'Create a new project artifact, or a new revision of an existing one (previous revisions are kept).',
      inputSchema:{type:'object',properties:{title:{type:'string'},content:{type:'string'},kind:{type:'string'},artifactId:{type:'string'}},required:['title','content'],additionalProperties:false},effect:'project_write',
      run:async a=>a.artifactId?await services.projects.systemReviseArtifact({tenantId,projectId,artifactId:a.artifactId,identityId,content:{text:a.content},provenance:{source:'agent-tool',runId,nodeKey}})
        :await services.projects.systemCreateArtifact({tenantId,projectId,identityId,runId,title:a.title,kind:a.kind||'document',content:{text:a.content},provenance:{source:'agent-tool',runId,nodeKey}})},
    {name:'file_list',description:'List files in the project code workspace.',inputSchema:obj({}),effect:'read',run:async()=>({files:await services.workspace.systemList(tenantId,projectId)})},
    {name:'file_read',description:'Read a file from the project code workspace.',inputSchema:obj({path:{type:'string'}}),effect:'read',
      run:async a=>{const f=await services.workspace.systemRead(tenantId,projectId,a.path);return {path:a.path,revision:f.revision,content:f.content.slice(0,100000)};}},
    {name:'file_write',description:'Create or overwrite a file in the project code workspace (history is kept).',inputSchema:obj({path:{type:'string'},content:{type:'string'}}),effect:'project_write',
      run:async a=>services.workspace.systemWrite({tenantId,projectId,identityId},a.path,a.content)},
    {name:'code_run',description:'Run a self-contained program in an isolated sandbox (no network). Languages: python, node, bash. Returns stdout/stderr/exitCode.',
      inputSchema:{type:'object',properties:{language:{type:'string',enum:['python','node','bash']},code:{type:'string'},stdin:{type:'string'}},required:['language','code'],additionalProperties:false},effect:'compute',
      run:async a=>{const r=await services.sandbox.run({language:a.language,code:a.code,stdin:a.stdin||'',timeoutMs:30000,collect:false});return {exitCode:r.exitCode,timedOut:r.timedOut,stdout:r.stdout.slice(0,20000),stderr:r.stderr.slice(0,8000)};}},
    {name:'workspace_exec',description:'Run a command (argv array) against the project workspace files in the isolated sandbox, e.g. ["python3","-m","unittest"] or ["node","--test"]. Set persist=true to save files the command creates or changes.',
      inputSchema:{type:'object',properties:{command:{type:'array',items:{type:'string'},minItems:1},persist:{type:'boolean'}},required:['command'],additionalProperties:false},effect:'compute',
      run:async a=>{const r=await services.workspace.exec({tenantId,projectId,identityId,command:a.command,persist:Boolean(a.persist),timeoutMs:120000});return {...r,stdout:r.stdout.slice(0,20000),stderr:r.stderr.slice(0,8000)};}},
    {name:'calculator',description:'Evaluate an arithmetic expression exactly (supports + - * / % ^, parentheses, sqrt, log, exp, sin, cos, min, max, round).',inputSchema:obj({expression:{type:'string'}}),effect:'compute',
      run:async a=>({result:calculate(a.expression)})},
    {name:'web_fetch',description:'Fetch a public web page (HTTPS GET) and return its text. Hosts outside the egress allowlist require human approval.',inputSchema:obj({url:{type:'string'}}),
      effect:'read',effectFor:a=>{try{return hostAllowlisted(new URL(a.url).hostname,policy.allowlist)?'read':'external'}catch{return 'external'}},
      run:async a=>{const r=await guardedFetch(a.url,{policy,maxBytes:2*1024*1024});const ct=r.headers['content-type']||'';
        let text=r.bytes.toString('utf8');if(ct.includes('html'))text=htmlToText(text);
        return {url:r.url,status:r.status,contentType:ct,truncated:r.truncated,text:text.slice(0,50000),untrusted:true};}},
    {name:'http_request',description:'Send an HTTP request that may change external state (POST/PUT/PATCH/DELETE). Always requires human approval.',
      inputSchema:{type:'object',properties:{method:{type:'string',enum:['POST','PUT','PATCH','DELETE']},url:{type:'string'},body:{type:'string'},connection:{type:'string'}},required:['method','url'],additionalProperties:false},effect:'external',
      run:async a=>{const headers={'Content-Type':'application/json'};
        if(a.connection){const c=await services.connections.byName(tenantId,a.connection);check(c.kind==='http','invalid_connection');check(new URL(a.url).origin===new URL(c.endpoint).origin,'connection_origin_mismatch',403);if(c.secret)headers.Authorization='Bearer '+c.secret;}
        const r=await guardedFetch(a.url,{method:a.method,headers,body:a.body,policy});return {status:r.status,body:r.bytes.toString('utf8').slice(0,20000)};}},
    {name:'git_commit',description:'Commit the current workspace files to the project Git history.',inputSchema:obj({message:{type:'string'}}),effect:'project_write',
      run:async a=>services.workspace.commit({identityId},tenantId,projectId,{message:a.message})},
    {name:'git_push',description:'Push the project Git history to an external repository registered as an http connection. Requires approval.',
      inputSchema:obj({connection:{type:'string'},branch:{type:'string'}}),effect:'external',
      run:async a=>{const c=await services.connections.byName(tenantId,a.connection);check(c.kind==='http','invalid_connection');return services.workspace.push({tenantId,projectId,remoteUrl:c.endpoint,token:c.secret,branch:a.branch||'main'});}},
  ];
  // MCP tools registered by tenant admins
  if([...want].some(w=>w==='mcp'||w.startsWith('mcp_'))){
    for(const t of await services.connections.mcpTools(tenantId)){
      const name=`mcp_${t.connection}_${t.name}`.replace(/-/g,'_').slice(0,64);
      tools.push({name,description:`[MCP ${t.connection}] ${t.description}`,inputSchema:t.inputSchema,effect:t.effect,mcp:true,
        run:async a=>{const r=await services.connections.callMcp(tenantId,t.connection,t.name,a);return {...r,untrusted:true};}});
    }
  }
  if([...want].some(w=>w==='delegate'||w.startsWith('delegate_'))){
    for(const c of await services.connections.externalAgents(tenantId)){
      tools.push({name:`delegate_${c.name}`.replace(/-/g,'_'),description:`Delegate a task to the external agent "${c.name}" (${new URL(c.endpoint).host}). Requires approval.`,
        inputSchema:obj({task:{type:'string'}}),effect:'external',run:async a=>({...(await services.connections.delegate(tenantId,c.name,a.task)),untrusted:true})});
    }
  }
  return tools.filter(t=>want.has(t.name)||(t.mcp&&(want.has('mcp')||want.has(t.name)))||(t.name.startsWith('delegate_')&&(want.has('delegate')||want.has(t.name))));
}

export async function audit(db,{tenantId,runId,nodeKey,identityId,tool,effect,decision,input,detail}){
  await db.query('INSERT INTO tool_audit(tenant_id,run_id,node_key,identity_id,tool,effect,decision,input_sha256,detail) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [tenantId,runId,nodeKey,identityId,tool,effect,decision,sha256(input??{}),detail?String(detail).slice(0,500):null]).catch(e=>log.error('tool_audit_failed',{message:e.message}));
}

/** Validate arguments and decide whether the invocation needs approval. */
export function prepareInvocation(tool,args){
  const input=isObject(args)?args:{};
  const errors=validate(tool.inputSchema,input);
  if(errors.length)return {error:'Invalid arguments: '+errors.slice(0,3).join('; ')};
  const effect=tool.effectFor?tool.effectFor(input):tool.effect;
  return {input,effect,needsApproval:APPROVAL_EFFECTS.has(effect)};
}
