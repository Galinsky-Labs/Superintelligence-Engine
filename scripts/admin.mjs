#!/usr/bin/env node
// Operator CLI. Uses DATABASE_URL (privileged). Spending controls live here, not in the web API.
//   node scripts/admin.mjs status
//   node scripts/admin.mjs set-global-cap <usd>            # operator-wide hard cap (default 0 = no paid calls)
//   node scripts/admin.mjs fund-tenant <tenantId> <usd>     # add funds and raise the tenant hard limit by the same amount
//   node scripts/admin.mjs set-price <provider> <model> <inputUsdPerMTok> <outputUsdPerMTok> [unitUsd]
//   node scripts/admin.mjs create-user <handle> [displayName] [email]   # creates identity + tenant, prints an API token
//   node scripts/admin.mjs issue-token <identityId> [days]
import {createEngine} from '../packages/engine/src/index.mjs';
const [cmd,...a]=process.argv.slice(2);
const e=createEngine();const db=e.pools.system;
const usd=x=>{const n=Number(x);if(!Number.isFinite(n)||n<0)throw new Error('Invalid USD amount '+x);return Math.round(n*1e6);};
try{
  switch(cmd){
    case 'status':{
      const g=(await db.query('SELECT * FROM budget_global')).rows[0];
      const t=(await db.query('SELECT t.id,t.name,b.funded_micro,b.hard_limit_micro,b.spent_micro,b.reserved_micro FROM tenants t LEFT JOIN budget_accounts b ON b.tenant_id=t.id ORDER BY t.created_at')).rows;
      console.log(JSON.stringify({global:g,tenants:t,sandbox:e.sandbox.info()},null,2));break;}
    case 'set-global-cap':{const v=usd(a[0]);await db.query('UPDATE budget_global SET hard_limit_micro=$1 WHERE spent_micro+reserved_micro<=$1',[v]);console.log('global cap set to',v/1e6,'USD');break;}
    case 'fund-tenant':{const v=usd(a[1]);
      await db.query('INSERT INTO budget_accounts(tenant_id) VALUES($1) ON CONFLICT DO NOTHING',[a[0]]);
      await db.query("UPDATE budget_accounts SET funded_micro=funded_micro+$2,hard_limit_micro=hard_limit_micro+$2,updated_at=now() WHERE tenant_id=$1",[a[0],v]);
      await db.query("INSERT INTO budget_events(tenant_id,event_key,event_type,delta_funded_micro) VALUES($1,$2,'fund',$3)",[a[0],'fund:'+Date.now(),v]);
      console.log('funded tenant',a[0],'with',v/1e6,'USD');break;}
    case 'set-price':{const [p,m,i,o,u]=a;await db.query(`INSERT INTO model_prices(provider,model,input_micro_per_mtok,output_micro_per_mtok,unit_micro) VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(provider,model) DO UPDATE SET input_micro_per_mtok=EXCLUDED.input_micro_per_mtok,output_micro_per_mtok=EXCLUDED.output_micro_per_mtok,unit_micro=EXCLUDED.unit_micro,updated_at=now()`,[p,m,usd(i||0),usd(o||0),usd(u||0)]);console.log('price set',p,m);break;}
    case 'create-user':{const [handle,name,email]=a;
      const id=await e.identity.upsertIdentity({issuer:'urn:sie:local',subject:handle,displayName:name||handle,email:email||null});
      if(!(await e.identity.listTenants({identityId:id})).items.length)await e.identity.createTenant({identityId:id},{name:(name||handle)+"'s workspace"});
      const tok=await e.identity.issueToken(id,{label:'admin-cli',days:90});
      console.log(JSON.stringify({identityId:id,tenants:(await e.identity.listTenants({identityId:id})).items,token:tok.token,expiresAt:tok.expiresAt},null,2));break;}
    case 'issue-token':{const tok=await e.identity.issueToken(a[0],{label:'admin-cli',days:Number(a[1]||30)});console.log(tok.token);break;}
    default:console.log('Commands: status | set-global-cap <usd> | fund-tenant <tenantId> <usd> | set-price <provider> <model> <in$/MTok> <out$/MTok> [unit$] | create-user <handle> [name] [email] | issue-token <identityId> [days]');process.exitCode=cmd?1:0;
  }
}catch(err){console.error('Error:',err.message);process.exitCode=1;}finally{await e.close();}
