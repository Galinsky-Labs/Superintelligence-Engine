// Managed PostgreSQL (Neon, RDS, ...) runs migrations as a non-superuser CREATEROLE owner. That owner must
// still act as "system" when it sets sie.system=on, while the RLS application role never can.
import test from 'node:test';import assert from 'node:assert/strict';import pg from 'pg';import {randomBytes} from 'node:crypto';
import {migrate} from '../../scripts/migrate.mjs';
const ADMIN=process.env.TEST_ADMIN_DATABASE_URL;
const at=(url,{db,user,password}={})=>{const u=new URL(url);if(db)u.pathname='/'+db;if(user){u.username=user;u.password=password;}return u.href;};
test('non-superuser CREATEROLE owner is system; the tenant application role is not',{skip:!ADMIN&&'requires TEST_ADMIN_DATABASE_URL'},async()=>{
  const id=randomBytes(4).toString('hex'),owner='sie_owner_'+id,app='sie_app_'+id,db='sie_mo_'+id,pw='pw_'+randomBytes(8).toString('hex');
  const admin=new pg.Client({connectionString:ADMIN});await admin.connect();
  await admin.query(`CREATE ROLE ${owner} LOGIN CREATEROLE NOSUPERUSER PASSWORD '${pw}'`);
  await admin.query(`CREATE DATABASE ${db} OWNER ${owner}`);
  // sie_tenant_role is cluster-wide. When it already exists, reproduce what PostgreSQL 16+ gives a CREATEROLE
  // owner that creates it: an ADMIN-only membership (no INHERIT, no SET).
  const v16=Number((await admin.query("SELECT current_setting('server_version_num') AS v")).rows[0].v)>=160000;
  if(v16&&(await admin.query("SELECT 1 FROM pg_roles WHERE rolname='sie_tenant_role'")).rowCount)
    await admin.query(`GRANT sie_tenant_role TO ${owner} WITH ADMIN OPTION, INHERIT FALSE, SET FALSE`);
  const ext=new pg.Client({connectionString:at(ADMIN,{db})});await ext.connect();await ext.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');await ext.end();
  try{
    const ownerUrl=at(ADMIN,{db,user:owner,password:pw});
    await migrate({connectionString:ownerUrl});
    const sys=new pg.Client({connectionString:ownerUrl,options:'-c sie.system=on'});await sys.connect();
    try{
      assert.equal((await sys.query('SELECT sie.is_system() AS s')).rows[0].s,true,'owner with sie.system=on is system');
      await sys.query(`CREATE ROLE ${app} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${pw}'`);
      await sys.query(`GRANT sie_tenant_role TO ${app}`);
    }finally{await sys.end();}
    const tenant=new pg.Client({connectionString:at(ADMIN,{db,user:app,password:pw}),options:'-c sie.system=on'});await tenant.connect();
    try{assert.equal((await tenant.query('SELECT sie.is_system() AS s')).rows[0].s,false,'tenant role can never be system');}
    finally{await tenant.end();}
  }finally{
    await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
    await admin.query(`DROP ROLE IF EXISTS ${app}`).catch(()=>{});await admin.query(`DROP ROLE IF EXISTS ${owner}`).catch(()=>{});
    await admin.end();
  }
});
