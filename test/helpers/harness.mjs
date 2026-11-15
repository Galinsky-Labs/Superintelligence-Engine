// Integration harness: a fresh PostgreSQL database per test file, migrations applied,
// a non-superuser app role (so RLS is enforced), and an in-process API server.
import pg from 'pg';
import {randomBytes} from 'node:crypto';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {migrate} from '../../scripts/migrate.mjs';
import {makeServer} from '../../apps/api/src/server.mjs';
import {Worker} from '../../packages/engine/src/index.mjs';

process.env.LOG_LEVEL??='error';
export const ADMIN_URL=process.env.TEST_ADMIN_DATABASE_URL||process.env.TEST_DATABASE_URL||'';
export const skip=!ADMIN_URL&&'set TEST_ADMIN_DATABASE_URL (a PostgreSQL superuser URL) to run integration tests';

function withDb(url,db){const u=new URL(url);u.pathname='/'+db;return u.href;}
export async function freshDatabase(){
  const name='sie_t_'+randomBytes(5).toString('hex');
  const admin=new pg.Client({connectionString:ADMIN_URL});await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  const roleExists=(await admin.query("SELECT 1 FROM pg_roles WHERE rolname='sie_test_app'")).rowCount;
  if(!roleExists)await admin.query("CREATE ROLE sie_test_app LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD 'sie_test_app_pw'").catch(()=>{});
  await admin.end();
  const url=withDb(ADMIN_URL,name);
  await migrate({connectionString:url});
  const c=new pg.Client({connectionString:url});await c.connect();
  await c.query('GRANT sie_tenant_role TO sie_test_app');
  await c.query('GRANT USAGE ON SCHEMA public, sie TO sie_test_app');
  await c.query('GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO sie_test_app');
  await c.query('GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO sie_test_app');
  await c.end();
  const app=new URL(url);app.username='sie_test_app';app.password='sie_test_app_pw';
  return {name,url,appUrl:app.href,async drop(){const a=new pg.Client({connectionString:ADMIN_URL});await a.connect();await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);await a.end();}};
}

export async function startApp(db,extraEnv={},opts={}){
  const storage=extraEnv.SIE_STORAGE_DIR||await mkdtemp(join(tmpdir(),'sie-test-store-'));
  const env={...process.env,DATABASE_URL:db.url,APP_DATABASE_URL:db.appUrl,SIE_ENCRYPTION_KEY:'ab'.repeat(32),SIE_DEV_AUTH:'1',SIE_ENABLE_TEST_PROVIDER:'1',
    SIE_STORAGE_DIR:storage,LOG_LEVEL:process.env.LOG_LEVEL||'error',SIE_SIM_DELAY_MS:'1',NODE_ENV:'test',SIE_INLINE_WORKER:'0',SIE_HEARTBEAT_MS:'300',...extraEnv};
  for(const [k,v] of Object.entries(extraEnv))if(v===undefined)delete env[k];
  const server=makeServer({env,...opts});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base='http://127.0.0.1:'+server.address().port;
  const worker=new Worker(server.app.engine,{concurrency:opts.concurrency||16,pollMs:50});
  return {server,base,env,storage,engine:server.app.engine,worker,
    async stop(){worker.stop();await new Promise(r=>server.close(r));await server.app.close();}};
}

export function client(base,{token,tenant}={}){
  const h=(extra={})=>({...(token?{Authorization:'Bearer '+token}:{}),...(tenant?{'X-Tenant-Id':tenant}:{}),...extra});
  const call=async(method,path,body,headers={})=>{
    const res=await fetch(base+path,{method,headers:h({...(body!==undefined?{'Content-Type':'application/json'}:{}),...headers}),body:body===undefined?undefined:JSON.stringify(body)});
    const text=await res.text();let data;try{data=JSON.parse(text)}catch{data=text}
    return {status:res.status,data,headers:res.headers};
  };
  return {call,get:p=>call('GET',p),post:(p,b={})=>call('POST',p,b),put:(p,b)=>call('PUT',p,b),patch:(p,b)=>call('PATCH',p,b),del:p=>call('DELETE',p),
    with:o=>client(base,{token,tenant,...o}),
    async sse(path,body){
      const res=await fetch(base+path,{method:body?'POST':'GET',headers:h(body?{'Content-Type':'application/json'}:{}),body:body?JSON.stringify(body):undefined});
      const text=await res.text();const events=[];
      for(const f of text.split('\n\n')){const ev=/^event: (.+)$/m.exec(f)?.[1];const d=/^data: (.+)$/m.exec(f)?.[1];if(ev&&d)events.push({event:ev,data:JSON.parse(d)});}
      return {status:res.status,events};
    }};
}
export async function login(base,handle){
  const r=await client(base).post('/v1/dev/login',{handle});
  const c=client(base,{token:r.data.token});const t=(await c.get('/v1/tenants')).data.items[0];
  return client(base,{token:r.data.token,tenant:t.id}).with({}) && Object.assign(client(base,{token:r.data.token,tenant:t.id}),{identityId:r.data.identityId,tenantId:t.id,token:r.data.token});
}
