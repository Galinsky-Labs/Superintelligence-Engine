// Shared infrastructure: errors, database pools, crypto, logging and metrics.
import {createCipheriv,createDecipheriv,createHash,randomBytes} from 'node:crypto';
import pg from 'pg';

export class EngineError extends Error {
  constructor(code,status=400,message,details){super(message||code);this.name='EngineError';this.code=code;this.status=status;if(details)this.details=details;}
}
export const fail=(code,status=400,message,details)=>{throw new EngineError(code,status,message,details)};
export const check=(ok,code,status=400,message)=>{if(!ok)throw new EngineError(code,status,message)};
export const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUUID=v=>typeof v==='string'&&UUID.test(v);
export const requireUUID=(v,label='id')=>{check(isUUID(v),'invalid_'+label,400,'Invalid '+label);return v};
export const sha256=v=>createHash('sha256').update(typeof v==='string'||Buffer.isBuffer(v)?v:JSON.stringify(v)).digest('hex');
export const randomToken=(bytes=32)=>randomBytes(bytes).toString('base64url');
export const isObject=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
export const sleep=ms=>new Promise(r=>setTimeout(r,ms));

/** Two pools: `system` (trusted server code, sets sie.system) and `tenant` (RLS enforced). */
export function createPools({databaseUrl=process.env.DATABASE_URL,appDatabaseUrl=process.env.APP_DATABASE_URL,max=Number(process.env.DB_POOL_MAX||16)}={}){
  if(!databaseUrl)throw new Error('DATABASE_URL is required');
  // The GUC is set at connection startup so every query on a system connection carries it.
  const system=new pg.Pool({connectionString:databaseUrl,max,connectionTimeoutMillis:10000,idleTimeoutMillis:30000,options:'-c sie.system=on'});
  system.on('error',e=>log.error('db_pool_error',{message:e.message}));
  const tenant=new pg.Pool({connectionString:appDatabaseUrl||databaseUrl,max,connectionTimeoutMillis:10000,idleTimeoutMillis:30000,options:'-c sie.system=off'});
  tenant.on('error',e=>log.error('db_pool_error',{message:e.message}));
  return {system,tenant,separateTenantRole:Boolean(appDatabaseUrl),end:async()=>{await Promise.allSettled([system.end(),tenant.end()]);}};
}

export async function tx(pool,fn){
  const db=await pool.connect();
  try{await db.query('BEGIN');try{const r=await fn(db);await db.query('COMMIT');return r}catch(e){await db.query('ROLLBACK').catch(()=>{});throw e}}
  finally{db.release()}
}

const ROLES=['owner','admin','member','viewer'];
export const roleAtLeast=(role,required)=>ROLES.includes(role)&&ROLES.indexOf(role)<=ROLES.indexOf(required);

/** Run fn inside a transaction bound to the principal; RLS sees sie.tenant_id/sie.identity_id. */
export async function withTenant(pool,principal,tenantId,requiredRole,fn){
  requireUUID(tenantId,'tenant');
  const db=await pool.connect();
  try{
    await db.query('BEGIN');
    try{
      await db.query("SELECT set_config('sie.identity_id',$1,true),set_config('sie.tenant_id',$2,true)",[principal.identityId,tenantId]);
      const m=await db.query('SELECT role FROM memberships WHERE tenant_id=$1 AND identity_id=$2',[tenantId,principal.identityId]);
      const role=m.rows[0]?.role;
      if(!role)throw new EngineError('tenant_access_denied',403);
      if(requiredRole&&!roleAtLeast(role,requiredRole))throw new EngineError('insufficient_role',403);
      const r=await fn(db,{role,tenantId,identityId:principal.identityId});
      await db.query('COMMIT');return r;
    }catch(e){await db.query('ROLLBACK').catch(()=>{});throw e}
  }finally{db.release()}
}

/** Membership lookup through the system pool (used by services operating on behalf of a principal). */
export async function requireMembership(system,principal,tenantId,requiredRole='viewer'){
  requireUUID(tenantId,'tenant');
  const r=await system.query('SELECT role FROM memberships WHERE tenant_id=$1 AND identity_id=$2',[tenantId,principal.identityId]);
  const role=r.rows[0]?.role;
  if(!role)throw new EngineError('tenant_access_denied',403);
  if(!roleAtLeast(role,requiredRole))throw new EngineError('insufficient_role',403);
  return role;
}

export class SecretBox {
  constructor(keyHex){
    if(typeof keyHex!=='string'||!/^[a-fA-F0-9]{64}$/.test(keyHex))throw new Error('SIE_ENCRYPTION_KEY must be 64 hex characters (32 bytes)');
    this.key=Buffer.from(keyHex,'hex');
  }
  seal(text){const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',this.key,iv);return Buffer.concat([iv,c.update(String(text),'utf8'),c.final(),c.getAuthTag()]);}
  open(buf){const b=Buffer.from(buf),d=createDecipheriv('aes-256-gcm',this.key,b.subarray(0,12));d.setAuthTag(b.subarray(b.length-16));return Buffer.concat([d.update(b.subarray(12,b.length-16)),d.final()]).toString('utf8');}
}

// ---- Structured logging ----
const LEVELS={debug:10,info:20,warn:30,error:40};
const threshold=()=>LEVELS[process.env.LOG_LEVEL||'info']??20;
const errorHooks=new Set();
function emit(level,event,fields){
  if(LEVELS[level]<threshold())return;
  const line=JSON.stringify({ts:new Date().toISOString(),level,event,...fields});
  (level==='error'||level==='warn'?process.stderr:process.stdout).write(line+'\n');
  if(level==='error')for(const h of errorHooks){try{h({event,...fields})}catch{}}
}
export const log={debug:(e,f={})=>emit('debug',e,f),info:(e,f={})=>emit('info',e,f),warn:(e,f={})=>emit('warn',e,f),error:(e,f={})=>emit('error',e,f),
  onError:h=>{errorHooks.add(h);return()=>errorHooks.delete(h)}};

/** Optional error reporting to a webhook (e.g. Slack/Sentry relay). Fire-and-forget, bounded. */
export function installErrorReporter(url=process.env.SIE_ERROR_WEBHOOK_URL){
  if(!url)return;
  let inflight=0;
  log.onError(payload=>{
    if(inflight>=4)return;inflight++;
    fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({service:'superintelligence-engine',...payload}).slice(0,16000),signal:AbortSignal.timeout(5000)})
      .catch(()=>{}).finally(()=>{inflight--});
  });
}

// ---- Prometheus-style metrics ----
class Metrics {
  constructor(){this.counters=new Map();this.gauges=new Map();this.hist=new Map();}
  key(name,labels){return name+JSON.stringify(labels||{})}
  inc(name,labels={},v=1){const k=this.key(name,labels);const e=this.counters.get(k)||{name,labels,value:0};e.value+=v;this.counters.set(k,e);}
  set(name,labels={},v){this.gauges.set(this.key(name,labels),{name,labels,value:v});}
  observe(name,labels={},v){const k=this.key(name,labels);const e=this.hist.get(k)||{name,labels,count:0,sum:0};e.count++;e.sum+=v;this.hist.set(k,e);}
  render(){
    const fmt=l=>{const p=Object.entries(l).map(([k,v])=>`${k}="${String(v).replace(/["\\\n]/g,'_')}"`);return p.length?'{'+p.join(',')+'}':''};
    const out=[];
    for(const e of this.counters.values())out.push(`${e.name}${fmt(e.labels)} ${e.value}`);
    for(const e of this.gauges.values())out.push(`${e.name}${fmt(e.labels)} ${e.value}`);
    for(const e of this.hist.values()){out.push(`${e.name}_count${fmt(e.labels)} ${e.count}`);out.push(`${e.name}_sum${fmt(e.labels)} ${e.sum}`);}
    return out.join('\n')+'\n';
  }
}
export const metrics=new Metrics();
