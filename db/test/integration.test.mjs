import test from 'node:test';import assert from 'node:assert/strict';import pg from 'pg';import {migrate,migrationFiles} from '../../scripts/migrate.mjs';
import {available,testDatabase} from './database.mjs';
test('migration files are sorted and explicit',()=>{assert.ok(migrationFiles().length>0);assert.equal(migrationFiles()[0],'001_foundation.sql');});
test('PostgreSQL migration, foreign keys and forced RLS', {skip:!available?'requires TEST_DATABASE_URL':false},async()=>{
 const db=await testDatabase();
 const client=new pg.Client({connectionString:db.url});await client.connect();
 try{
  const first=await migrate({client});assert.ok(first.some(x=>['applied','unchanged'].includes(x.status)));
  const second=await migrate({client});assert.ok(second.every(x=>x.status==='unchanged'));
  const tenant=await client.query("INSERT INTO tenants(name) VALUES('Migration test') RETURNING id");
  const uid=await client.query("INSERT INTO identities(issuer,subject) VALUES('test',gen_random_uuid()::text) RETURNING id");
  const project=await client.query("INSERT INTO projects(tenant_id,owner_id,title,kind) VALUES($1,$2,'Test Project','code') RETURNING id",[tenant.rows[0].id,uid.rows[0].id]);
  const other=await client.query("INSERT INTO tenants(name) VALUES('Foreign tenant') RETURNING id");
  await assert.rejects(client.query("INSERT INTO asset_metadata(tenant_id,project_id,storage_key,media_type,sha256,size_bytes) VALUES($1,$2,'x','text/plain',$3,1)",[other.rows[0].id,project.rows[0].id,'a'.repeat(64)]),/asset_same_tenant_project|foreign key/i);
  const rls=await client.query("SELECT c.relname AS tablename,c.relrowsecurity AS rowsecurity,c.relforcerowsecurity AS forcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname IN ('tenants','identities','memberships','projects','asset_metadata')");
  assert.equal(rls.rows.length,5);for(const row of rls.rows){assert.equal(row.rowsecurity,true);assert.equal(row.forcerowsecurity,true);}
  const policies=await client.query("SELECT policyname, tablename FROM pg_policies WHERE schemaname='public'");assert.ok(policies.rows.some(r=>r.policyname==='memberships_self_read'&&r.tablename==='memberships'));assert.ok(policies.rows.some(r=>r.policyname==='projects_member_read'&&r.tablename==='projects'));
 } finally {await client.end();await db.drop();}
});
