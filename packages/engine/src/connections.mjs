// Tenant integrations: MCP servers (Streamable HTTP), external A2A agents and HTTP services.
// Endpoints are registered by tenant admins; secrets are stored encrypted and never returned.
import {randomUUID} from 'node:crypto';
import {EngineError,check,fail,isObject,requireUUID,requireMembership,log} from './infra.mjs';
import {guardedFetch,egressPolicy} from './net.mjs';

const NAME=/^[a-z][a-z0-9_-]{1,40}$/;
const MCP_VERSION='2025-06-18';

function parseRpc(res,id){
  const text=res.bytes.toString('utf8');const ct=res.headers['content-type']||'';
  const msgs=ct.includes('text/event-stream')
    ?text.split(/\r?\n\r?\n/).map(f=>f.split(/\r?\n/).filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trim()).join('\n')).filter(Boolean).map(d=>{try{return JSON.parse(d)}catch{return null}})
    :[(()=>{try{return JSON.parse(text)}catch{return null}})()];
  const m=msgs.find(x=>x&&x.id===id);
  if(!m)throw new EngineError('mcp_invalid_response',502,'MCP server returned no matching JSON-RPC response');
  if(m.error)throw new EngineError('mcp_error',502,String(m.error.message||'MCP error').slice(0,300));
  return m.result;
}

export class McpClient {
  constructor({endpoint,token,policy=egressPolicy(),fetchImpl}){this.endpoint=endpoint;this.token=token;this.policy=policy;this.fetchImpl=fetchImpl;this.session=null;}
  headers(){return {'Content-Type':'application/json',Accept:'application/json, text/event-stream','MCP-Protocol-Version':MCP_VERSION,...(this.token?{Authorization:'Bearer '+this.token}:{}),...(this.session?{'Mcp-Session-Id':this.session}:{})}}
  async rpc(method,params,{notify=false}={}){
    const id=notify?undefined:randomUUID();
    const res=await guardedFetch(this.endpoint,{method:'POST',headers:this.headers(),body:JSON.stringify({jsonrpc:'2.0',...(id?{id}:{}),method,...(params?{params}:{})}),policy:this.policy,maxBytes:4*1024*1024,timeoutMs:30000,...(this.fetchImpl?{fetchImpl:this.fetchImpl}:{})});
    if(res.headers['mcp-session-id'])this.session=res.headers['mcp-session-id'];
    if(notify)return null;
    if(!res.ok)throw new EngineError('mcp_http_error',502,`MCP server returned HTTP ${res.status}`);
    return parseRpc(res,id);
  }
  async init(){
    if(this.initialized)return;
    await this.rpc('initialize',{protocolVersion:MCP_VERSION,capabilities:{},clientInfo:{name:'superintelligence-engine',version:'0.2.0'}});
    await this.rpc('notifications/initialized',undefined,{notify:true}).catch(()=>{});
    this.initialized=true;
  }
  async listTools(){await this.init();const r=await this.rpc('tools/list',{});return (r.tools||[]).slice(0,200);}
  async callTool(name,args){await this.init();return this.rpc('tools/call',{name,arguments:args});}
}

/** Minimal A2A (Agent2Agent) JSON-RPC client: message/send, returns the agent's text output. */
export async function a2aSend({endpoint,token,text,policy=egressPolicy(),fetchImpl}){
  const id=randomUUID();
  const body={jsonrpc:'2.0',id,method:'message/send',params:{message:{role:'user',messageId:randomUUID(),kind:'message',parts:[{kind:'text',text}]}}};
  const res=await guardedFetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify(body),policy,timeoutMs:120000,maxBytes:4*1024*1024,...(fetchImpl?{fetchImpl}:{})});
  if(!res.ok)throw new EngineError('external_agent_http_error',502,`External agent returned HTTP ${res.status}`);
  const result=parseRpc(res,id);
  const texts=[];
  const collect=parts=>{for(const p of parts||[])if((p.kind||p.type)==='text'&&typeof p.text==='string')texts.push(p.text);};
  if(result?.kind==='message'||result?.parts)collect(result.parts);
  for(const a of result?.artifacts||[])collect(a.parts);
  if(result?.status?.message)collect(result.status.message.parts);
  return {text:texts.join('\n').slice(0,200000),taskId:result?.id||null,state:result?.status?.state||'completed'};
}

export class Connections {
  constructor({system,secretBox,policy=egressPolicy(),fetchImpl}){this.db=system;this.box=secretBox;this.policy=policy;this.fetchImpl=fetchImpl;}
  serialize(r){return {id:r.id,kind:r.kind,name:r.name,endpoint:r.endpoint,hasSecret:Boolean(r.secret_ciphertext),tools:r.tools,enabled:r.enabled,createdAt:r.created_at}}
  async list(principal,tenantId){
    await requireMembership(this.db,principal,tenantId,'viewer');
    return {items:(await this.db.query('SELECT * FROM connections WHERE tenant_id=$1 ORDER BY name',[tenantId])).rows.map(r=>this.serialize(r))};
  }
  async create(principal,tenantId,{kind,name,endpoint,secret,tools}){
    await requireMembership(this.db,principal,tenantId,'admin');
    check(['mcp','external_agent','http'].includes(kind),'invalid_kind');check(NAME.test(name||''),'invalid_name',400,'Name must match [a-z][a-z0-9_-]{1,40}');
    let u;try{u=new URL(endpoint)}catch{fail('invalid_endpoint')}
    check(u.protocol==='https:'||(this.policy.allowHttp&&u.protocol==='http:'),'endpoint_https_required');
    check(!u.username&&!u.password,'invalid_endpoint');
    if(secret!==undefined&&secret!==null&&secret!=='')check(this.box,'encryption_unconfigured',503);
    let toolDefs=[];
    if(kind==='mcp'){
      const client=new McpClient({endpoint,token:secret||undefined,policy:this.policy,fetchImpl:this.fetchImpl});
      const remote=await client.listTools();
      const effects=isObject(tools)?tools:{}; // admin may mark specific tools read-only: {toolName:'read'}
      toolDefs=remote.filter(t=>/^[A-Za-z0-9_-]{1,64}$/.test(t.name||'')).map(t=>({name:t.name,description:String(t.description||'').slice(0,1000),inputSchema:isObject(t.inputSchema)?t.inputSchema:{type:'object',properties:{}},effect:effects[t.name]==='read'?'read':'external'}));
    }
    const r=await this.db.query(`INSERT INTO connections(tenant_id,kind,name,endpoint,secret_ciphertext,tools,created_by) VALUES($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT(tenant_id,name) DO UPDATE SET kind=EXCLUDED.kind,endpoint=EXCLUDED.endpoint,
        secret_ciphertext=CASE WHEN EXCLUDED.secret_ciphertext IS NOT NULL THEN EXCLUDED.secret_ciphertext WHEN connections.endpoint=EXCLUDED.endpoint AND connections.kind=EXCLUDED.kind THEN connections.secret_ciphertext ELSE NULL END,
        tools=EXCLUDED.tools,enabled=true RETURNING *` /* a stored secret never follows a changed endpoint */,
      [tenantId,kind,name,u.href,secret?this.box.seal(secret):null,JSON.stringify(toolDefs),principal.identityId]);
    return this.serialize(r.rows[0]);
  }
  async setToolEffect(principal,tenantId,id,{tool,effect}){
    await requireMembership(this.db,principal,tenantId,'admin');requireUUID(id,'connection');check(['read','external'].includes(effect),'invalid_effect');
    const c=(await this.db.query('SELECT * FROM connections WHERE tenant_id=$1 AND id=$2',[tenantId,id])).rows[0];check(c,'connection_not_found',404);
    const tools=c.tools.map(t=>t.name===tool?{...t,effect}:t);
    await this.db.query('UPDATE connections SET tools=$3 WHERE tenant_id=$1 AND id=$2',[tenantId,id,JSON.stringify(tools)]);
    return this.serialize({...c,tools});
  }
  async remove(principal,tenantId,id){
    await requireMembership(this.db,principal,tenantId,'admin');requireUUID(id,'connection');
    const r=await this.db.query('DELETE FROM connections WHERE tenant_id=$1 AND id=$2',[tenantId,id]);check(r.rowCount,'connection_not_found',404);return {deleted:true};
  }
  async byName(tenantId,name){
    const r=(await this.db.query('SELECT * FROM connections WHERE tenant_id=$1 AND name=$2 AND enabled',[tenantId,name])).rows[0];
    check(r,'connection_not_found',404,'Unknown connection '+name);
    return {...r,secret:r.secret_ciphertext&&this.box?this.box.open(r.secret_ciphertext):undefined};
  }
  async mcpTools(tenantId){
    const r=await this.db.query("SELECT name,tools FROM connections WHERE tenant_id=$1 AND kind='mcp' AND enabled",[tenantId]);
    return r.rows.flatMap(c=>c.tools.map(t=>({connection:c.name,...t})));
  }
  async externalAgents(tenantId){return (await this.db.query("SELECT name,endpoint FROM connections WHERE tenant_id=$1 AND kind='external_agent' AND enabled",[tenantId])).rows;}
  async callMcp(tenantId,connection,tool,args){
    const c=await this.byName(tenantId,connection);check(c.kind==='mcp','not_mcp');
    const client=new McpClient({endpoint:c.endpoint,token:c.secret,policy:this.policy,fetchImpl:this.fetchImpl});
    const r=await client.callTool(tool,args);
    const text=(r?.content||[]).map(p=>p.type==='text'?p.text:p.type==='resource'?JSON.stringify(p.resource).slice(0,4000):`[${p.type} content]`).join('\n');
    return {isError:Boolean(r?.isError),text:text.slice(0,100000),structured:r?.structuredContent??null};
  }
  async delegate(tenantId,connection,text){
    const c=await this.byName(tenantId,connection);check(c.kind==='external_agent','not_external_agent');
    return a2aSend({endpoint:c.endpoint,token:c.secret,text,policy:this.policy,fetchImpl:this.fetchImpl});
  }
}
