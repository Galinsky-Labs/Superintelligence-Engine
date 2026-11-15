// Production start path on managed PostgreSQL: a non-superuser CREATEROLE owner runs
// scripts/prepare-production.mjs (migrations, RLS app role, bootstrap operator token), then the API runs
// with NODE_ENV=production, no dev login, and the derived non-superuser tenant pool.
import test from 'node:test';import assert from 'node:assert/strict';import pg from 'pg';import {randomBytes} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {makeServer} from '../../apps/api/src/server.mjs';
const ADMIN=process.env.TEST_ADMIN_DATABASE_URL;
const at=(url,{db,user,password}={})=>{const u=new URL(url);if(db)u.pathname='/'+db;if(user){u.username=user;u.password=password;}return u.href;};

test('prepare-production + production API with bootstrap token and RLS app role',{skip:!ADMIN&&'requires TEST_ADMIN_DATABASE_URL',timeout:120000},async()=>{
  const id=randomBytes(4).toString('hex'),owner='sie_powner_'+id,role='sie_papp_'+id,db='sie_pp_'+id,pw='pw_'+randomBytes(8).toString('hex');
  const admin=new pg.Client({connectionString:ADMIN});await admin.connect();
  await admin.query(`CREATE ROLE ${owner} LOGIN CREATEROLE NOSUPERUSER PASSWORD '${pw}'`);
  await admin.query(`CREATE DATABASE ${db} OWNER ${owner}`);
  const v16=Number((await admin.query("SELECT current_setting('server_version_num') AS v")).rows[0].v)>=160000;
  if(v16&&(await admin.query("SELECT 1 FROM pg_roles WHERE rolname='sie_tenant_role'")).rowCount)
    await admin.query(`GRANT sie_tenant_role TO ${owner} WITH ADMIN OPTION, INHERIT FALSE, SET FALSE`);
  const ext=new pg.Client({connectionString:at(ADMIN,{db})});await ext.connect();await ext.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');await ext.end();
  const token='sie_'+randomBytes(32).toString('hex');
  const env={...process.env,DATABASE_URL:at(ADMIN,{db,user:owner,password:pw}),SIE_APP_DB_ROLE:role,SIE_APP_DB_PASSWORD:pw+'_app',SIE_BOOTSTRAP_TOKEN:token,
    NODE_ENV:'production',SIE_ENCRYPTION_KEY:'cd'.repeat(32),SIE_ENABLE_TEST_PROVIDER:'1',SIE_SANDBOX:'disabled',SIE_INLINE_WORKER:'1',LOG_LEVEL:'error',SIE_DEV_AUTH:'1'};
  delete env.APP_DATABASE_URL;
  let server;
  try{
    for(let i=0;i<2;i++){ // idempotent: a restart re-runs preparation
      const r=spawnSync(process.execPath,['scripts/prepare-production.mjs'],{env,encoding:'utf8'});
      assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/bootstrap_operator/);
    }
    server=makeServer({env});await new Promise(r=>server.listen(0,'127.0.0.1',r));
    const base='http://127.0.0.1:'+server.address().port;
    assert.equal(server.app.engine.pools.separateTenantRole,true,'tenant pool uses the derived RLS role');
    assert.equal((await fetch(base+'/ready')).status,200);
    assert.equal((await fetch(base+'/v1/dev/login',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"handle":"x"}'})).status>=400,true,'no dev login in production');
    assert.equal((await fetch(base+'/v1/me')).status,401);
    const auth={Authorization:'Bearer '+token};
    const tenants=await (await fetch(base+'/v1/tenants',{headers:auth})).json();
    assert.equal(tenants.items.length,1);
    const h={...auth,'X-Tenant-Id':tenants.items[0].id,'Content-Type':'application/json'};
    const p=await fetch(base+'/v1/projects',{method:'POST',headers:h,body:JSON.stringify({title:'Prod smoke',kind:'general'})});
    assert.equal(p.status,201);
    const list=await (await fetch(base+'/v1/projects',{headers:h})).json();
    assert.equal(list.items.length,1);
    const c=new pg.Client({connectionString:at(ADMIN,{db,user:role,password:pw+'_app'}),options:'-c sie.system=on'});await c.connect();
    try{assert.equal((await c.query('SELECT sie.is_system() s')).rows[0].s,false);assert.equal((await c.query('SELECT count(*)::int n FROM projects')).rows[0].n,0,'RLS hides rows without a principal');}
    finally{await c.end();}
  }finally{
    if(server){await new Promise(r=>server.close(r));await server.app.close();}
    await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
    for(const r of [role,owner])await admin.query(`DROP ROLE IF EXISTS ${r}`).catch(()=>{});
    await admin.end();
  }
});
