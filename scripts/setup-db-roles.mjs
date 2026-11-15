#!/usr/bin/env node
// Creates (or updates) a non-privileged application role used by the API's tenant pool so PostgreSQL
// row-level security is enforced for every user-scoped query. Run with an admin DATABASE_URL.
//   node scripts/setup-db-roles.mjs <roleName> <password>
// Then set APP_DATABASE_URL=postgres://<roleName>:<password>@host/db (or SIE_APP_DB_PASSWORD, see docs/DEPLOY_RENDER.md)
import pg from 'pg';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

export const ROLE_NAME=/^[a-z_][a-z0-9_]{1,40}$/;
export async function setupAppRole({connectionString=process.env.DATABASE_URL,role='sie_app',password}={}){
  if(!ROLE_NAME.test(role)||!password||password.length<12)throw new Error('role must match '+ROLE_NAME+' and password must be at least 12 characters');
  const c=new pg.Client({connectionString});await c.connect();
  try{
    const exists=(await c.query('SELECT 1 FROM pg_roles WHERE rolname=$1',[role])).rowCount;
    const pw=password.replace(/'/g,"''");
    // Managed PostgreSQL owners (non-superusers) may not touch SUPERUSER/BYPASSRLS on an existing role,
    // so only the password is updated and the attributes are verified instead.
    await c.query(exists?`ALTER ROLE ${role} LOGIN PASSWORD '${pw}'`:`CREATE ROLE ${role} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${pw}'`);
    const attrs=(await c.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=$1',[role])).rows[0];
    if(attrs.rolsuper||attrs.rolbypassrls)throw new Error(`role ${role} is SUPERUSER or BYPASSRLS; row-level security would not apply`);
    await c.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='sie_tenant_role') THEN CREATE ROLE sie_tenant_role NOLOGIN; END IF; END $$`);
    await c.query(`GRANT sie_tenant_role TO ${role}`);
    await c.query(`GRANT USAGE ON SCHEMA public, sie TO ${role}`);
    await c.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO ${role}`);
    await c.query(`GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role}`);
    await c.query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA sie TO ${role}`);
    return {role,rowLevelSecurity:'enforced (NOSUPERUSER NOBYPASSRLS)'};
  }finally{await c.end();}
}

if(process.argv[1]&&fileURLToPath(import.meta.url)===resolve(process.argv[1])){
  const [role='sie_app',password]=process.argv.slice(2);
  setupAppRole({role,password}).then(r=>console.log(JSON.stringify(r))).catch(e=>{console.error('Usage: setup-db-roles.mjs <role> <password(min 12 chars)> —',e.message);process.exitCode=1;});
}
