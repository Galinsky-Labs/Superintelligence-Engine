#!/usr/bin/env node
// Creates (or updates) a non-privileged application role used by the API's tenant pool so PostgreSQL
// row-level security is enforced for every user-scoped query. Run with an admin DATABASE_URL.
//   node scripts/setup-db-roles.mjs <roleName> <password>
// Then set APP_DATABASE_URL=postgres://<roleName>:<password>@host/db
import pg from 'pg';
const [role='sie_app',password]=process.argv.slice(2);
if(!/^[a-z_][a-z0-9_]{1,40}$/.test(role)||!password||password.length<12){console.error('Usage: setup-db-roles.mjs <role> <password(min 12 chars)>');process.exit(1);}
const c=new pg.Client({connectionString:process.env.DATABASE_URL});await c.connect();
try{
  const exists=(await c.query('SELECT 1 FROM pg_roles WHERE rolname=$1',[role])).rowCount;
  const pw=password.replace(/'/g,"''");
  await c.query(exists?`ALTER ROLE ${role} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${pw}'`:`CREATE ROLE ${role} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${pw}'`);
  await c.query(`GRANT USAGE ON SCHEMA public, sie TO ${role}`);
  await c.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO ${role}`);
  await c.query(`GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role}`);
  await c.query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA sie TO ${role}`);
  console.log(JSON.stringify({role,rowLevelSecurity:'enforced (NOSUPERUSER NOBYPASSRLS)'}));
}finally{await c.end();}
