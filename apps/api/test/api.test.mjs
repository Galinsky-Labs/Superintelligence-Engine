import test from 'node:test';
import assert from 'node:assert/strict';
import {skip,freshDatabase,startApp,client} from '../../../test/helpers/harness.mjs';

test('API health, readiness, capabilities, metrics and fail-closed authentication',{skip},async()=>{
  const db=await freshDatabase();const app=await startApp(db,{SIE_ENABLE_TEST_PROVIDER:'0'});
  try{
    const c=client(app.base);
    const h=await c.get('/health');assert.equal(h.status,200);assert.equal(h.data.status,'ok');
    const r=await c.get('/ready');assert.equal(r.data.status,'ready');assert.ok(r.data.migrations>=13);
    const caps=await c.get('/v1/capabilities');assert.equal(caps.status,200);
    assert.equal(caps.data.generationEnabled,false,'no provider credentials configured => no real generation');
    assert.deepEqual(caps.data.availableProviders,[]);assert.ok(caps.data.workspaceKinds.includes('code'));
    assert.equal((await c.get('/v1/projects')).status,401);
    assert.equal((await c.get('/v1/nonsense')).status,404);
    assert.equal((await c.call('PATCH','/health')).status,405);
    const m=await fetch(app.base+'/metrics');assert.match(await m.text(),/sie_http_requests_total/);
    const ws=await c.get('/v1/workspaces');assert.ok(ws.data.items.length>=10);
    const login=await c.post('/v1/dev/login',{handle:'carol'});assert.equal(login.status,201);
    const me=await client(app.base,{token:login.data.token}).get('/v1/me');assert.equal(me.data.id,login.data.identityId);
  }finally{await app.stop();await db.drop();}
});

test('dev login is disabled in production mode',{skip},async()=>{
  const db=await freshDatabase();const app=await startApp(db,{NODE_ENV:'production'});
  try{assert.equal((await client(app.base).post('/v1/dev/login',{handle:'mallory'})).status,404);}
  finally{await app.stop();await db.drop();}
});
