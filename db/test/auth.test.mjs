import test from 'node:test';import assert from 'node:assert/strict';import {randomBytes} from 'node:crypto';import pg from 'pg';import {AuthBroker} from '../../packages/auth/src/index.mjs';
import {available,testDatabase} from './database.mjs';
test('SSO shares verified identity but isolates Academy/Command sessions, CSRF state and replay', {skip:!available?'requires PostgreSQL':false},async()=>{
 const db=await testDatabase();
 const pool=new pg.Pool({connectionString:db.url});
 const driver={authorize:async({product,state})=>'https://idp.invalid/login?state='+state+'&product='+product,redeem:async({state,nonce,verifier})=>{assert.ok(state&&nonce&&verifier);return {issuer:'https://idp.invalid',subject:'test-user-42'};}};
 const auth=new AuthBroker({pool,driver,encryptionKeyHex:randomBytes(32).toString('hex'),sessionLifetimeSeconds:3600});
 try{
  const a=await auth.begin('academy'),s=new URL(a.url).searchParams.get('state');
  await assert.rejects(auth.complete({product:'academy',callbackUrl:'https://callback.invalid/?state='+s+'&code=ok',cookieHeader:''}),/missing/);
  const login=await auth.complete({product:'academy',callbackUrl:'https://callback.invalid/?state='+s+'&code=ok',cookieHeader:a.flowCookie.split(';')[0]});
  await assert.rejects(auth.complete({product:'academy',callbackUrl:'https://callback.invalid/?state='+s+'&code=ok',cookieHeader:a.flowCookie.split(';')[0]}),/replayed/);
  const academySession=login.sessionCookie.split(';')[0];
  assert.ok((await auth.session({product:'academy',cookieHeader:academySession})).identityId);
  assert.equal(await auth.session({product:'command',cookieHeader:academySession}),null);
  const c=await auth.begin('command'),cs=new URL(c.url).searchParams.get('state');
  const cLogin=await auth.complete({product:'command',callbackUrl:'https://callback.invalid/?state='+cs+'&code=ok',cookieHeader:c.flowCookie.split(';')[0]});
  assert.equal(login.identityId,cLogin.identityId);
  assert.ok(await auth.session({product:'command',cookieHeader:cLogin.sessionCookie.split(';')[0]}));
  await auth.logout({product:'academy',cookieHeader:academySession});
  assert.equal(await auth.session({product:'academy',cookieHeader:academySession}),null);
  assert.ok(await auth.session({product:'command',cookieHeader:cLogin.sessionCookie.split(';')[0]}));
  await auth.revokeAll(login.identityId);
  assert.equal(await auth.session({product:'command',cookieHeader:cLogin.sessionCookie.split(';')[0]}),null);
  assert.match(login.sessionCookie,/HttpOnly; Secure; SameSite=Lax/);
 }finally{await pool.end();await db.drop();}
});
