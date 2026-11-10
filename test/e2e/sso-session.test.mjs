// SSO session cookies (OIDC broker sessions) authenticate API calls; cookie-authenticated writes
// require the registered product origin (CSRF); sessions are product-bound and revocable.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import pg from 'pg';
import {skip,freshDatabase,startApp} from '../helpers/harness.mjs';

test('OIDC session cookies over the API',{skip},async()=>{
  const db=await freshDatabase();
  const app=await startApp(db,{OIDC_ISSUER:'https://idp.example',SESSION_ENCRYPTION_KEY_HEX:'cd'.repeat(32),AUTH_DATABASE_URL:db.url,
    OIDC_COMMAND_CLIENT_ID:'cmd',OIDC_COMMAND_REDIRECT_URI:'https://command.example/auth/command/callback',COMMAND_PUBLIC_ORIGIN:'https://command.example',ACADEMY_PUBLIC_ORIGIN:'https://academy.example'});
  const sql=new pg.Client({connectionString:db.url,options:'-c sie.system=on'});await sql.connect();
  try{
    const id=(await sql.query("INSERT INTO identities(issuer,subject,display_name) VALUES('https://idp.example','user-42','Sso User') RETURNING id")).rows[0].id;
    const secret=randomBytes(32).toString('base64url');
    await sql.query("INSERT INTO auth_sessions(session_hash,identity_id,product,expires_at) VALUES($1,$2,'command',now()+interval '1 hour')",[createHash('sha256').update(secret).digest('hex'),id]);
    const cookie='__Host-sie_session_command='+secret;
    const call=(method,path,{origin,product='command',body,tenant}={})=>fetch(app.base+path,{method,headers:{Cookie:cookie,'X-SIE-Product':product,...(origin?{Origin:origin}:{}),...(tenant?{'X-Tenant-Id':tenant}:{}),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
    const me=await call('GET','/v1/me');assert.equal(me.status,200);assert.equal((await me.json()).via,'oidc');
    assert.equal((await call('GET','/v1/me',{product:'academy'})).status,401,'session is bound to its product');
    assert.equal((await call('POST','/v1/tenants',{body:{name:'x'}})).status,403,'cookie write without Origin refused');
    assert.equal((await call('POST','/v1/tenants',{origin:'https://evil.example',body:{name:'x'}})).status,403);
    const ok=await call('POST','/v1/tenants',{origin:'https://command.example',body:{name:'SSO workspace'}});assert.equal(ok.status,201);
    assert.equal(ok.headers.get('access-control-allow-origin'),'https://command.example');
    const tenant=(await ok.json()).id;
    assert.equal((await call('POST','/v1/projects',{origin:'https://academy.example',tenant,body:{title:'p'}})).status,403,'academy origin cannot write as command');
    assert.equal((await call('POST','/v1/projects',{origin:'https://command.example',tenant,body:{title:'From Command Center',kind:'research'}})).status,201);
    await sql.query('UPDATE auth_sessions SET revoked_at=now()');
    assert.equal((await call('GET','/v1/me')).status,401,'revoked session rejected');
  }finally{await sql.end();await app.stop();await db.drop();}
});
