#!/usr/bin/env node
// One-shot production preparation, run before the API starts (e.g. Render start command):
//   node scripts/prepare-production.mjs && node apps/api/src/server.mjs
// 1. applies migrations with DATABASE_URL (the database owner; on Neon the default owner role is fine);
// 2. when SIE_APP_DB_PASSWORD is set, creates/updates the non-superuser RLS application role
//    (SIE_APP_DB_ROLE, default sie_app); the API then derives APP_DATABASE_URL from DATABASE_URL;
// 3. when SIE_BOOTSTRAP_TOKEN is set, ensures an operator identity + workspace that the token signs in as,
//    so a deployment without OIDC or dev login still has a first user. Rotate by changing the variable;
//    the previous bootstrap token is revoked.
import pg from 'pg';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {migrate} from './migrate.mjs';
import {setupAppRole} from './setup-db-roles.mjs';

const env=process.env;
const TOKEN=/^sie_[A-Za-z0-9_-]{30,80}$/;
const sha256=s=>createHash('sha256').update(s).digest('hex');

export async function bootstrapOperator({connectionString,token,handle='operator',days=365}){
  if(!TOKEN.test(token))throw new Error('SIE_BOOTSTRAP_TOKEN must look like sie_<30-80 url-safe characters>');
  const c=new pg.Client({connectionString,options:'-c sie.system=on'});await c.connect();
  try{
    await c.query('BEGIN');
    const id=(await c.query(`INSERT INTO identities(issuer,subject,display_name) VALUES('urn:sie:bootstrap',$1,$2)
      ON CONFLICT(issuer,subject) DO UPDATE SET display_name=identities.display_name RETURNING id`,[handle,'Operator'])).rows[0].id;
    let tenant=(await c.query('SELECT tenant_id FROM memberships WHERE identity_id=$1 ORDER BY created_at LIMIT 1',[id])).rows[0]?.tenant_id;
    if(!tenant){
      tenant=(await c.query("INSERT INTO tenants(name) VALUES('Operator workspace') RETURNING id")).rows[0].id;
      await c.query("INSERT INTO memberships(tenant_id,identity_id,role) VALUES($1,$2,'owner')",[tenant,id]);
      await c.query('INSERT INTO budget_accounts(tenant_id) VALUES($1) ON CONFLICT DO NOTHING',[tenant]);
    }
    const hash=sha256(token);
    await c.query(`UPDATE api_tokens SET revoked_at=now() WHERE identity_id=$1 AND label='bootstrap' AND token_hash<>$2 AND revoked_at IS NULL`,[id,hash]);
    await c.query(`INSERT INTO api_tokens(token_hash,identity_id,product,label,expires_at) VALUES($1,$2,'engine','bootstrap',now()+($3::int*interval '1 day'))
      ON CONFLICT(token_hash) DO UPDATE SET expires_at=EXCLUDED.expires_at WHERE api_tokens.identity_id=EXCLUDED.identity_id AND api_tokens.revoked_at IS NULL`,[hash,id,days]);
    await c.query('COMMIT');
    return {identityId:id,tenantId:tenant};
  }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{await c.end();}
}

async function main(){
  if(!env.DATABASE_URL)throw new Error('DATABASE_URL is required');
  const applied=await migrate({connectionString:env.DATABASE_URL});
  console.log(JSON.stringify({event:'migrations',applied:applied.filter(x=>x.status==='applied').map(x=>x.filename),total:applied.length}));
  if(env.SIE_APP_DB_PASSWORD&&!env.APP_DATABASE_URL){
    console.log(JSON.stringify({event:'app_role',...await setupAppRole({connectionString:env.DATABASE_URL,role:env.SIE_APP_DB_ROLE||'sie_app',password:env.SIE_APP_DB_PASSWORD})}));
  }
  if(env.SIE_BOOTSTRAP_TOKEN){
    const r=await bootstrapOperator({connectionString:env.DATABASE_URL,token:env.SIE_BOOTSTRAP_TOKEN});
    console.log(JSON.stringify({event:'bootstrap_operator',identityId:r.identityId,tenantId:r.tenantId}));
  }
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===resolve(process.argv[1]))main().catch(e=>{console.error('Production preparation failed:',e.message);process.exit(1);});
