// Asset storage on an S3-compatible backend (local S3-protocol stand-in, not AWS).
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import pg from 'pg';
import {skip,freshDatabase} from '../helpers/harness.mjs';
import {AssetStore} from '../../packages/engine/src/assets.mjs';

test('assets round-trip through an S3-compatible bucket',{skip},async()=>{
  const objects=new Map();const seen=[];
  const s3=createServer((req,res)=>{const chunks=[];req.on('data',c=>chunks.push(c));req.on('end',()=>{
    seen.push(req.method+' '+req.url.split('?')[0]);const key=decodeURIComponent(req.url.split('?')[0]);
    if(req.method==='PUT'){objects.set(key,Buffer.concat(chunks));res.writeHead(200,{ETag:'"x"'});return res.end();}
    if(!objects.has(key)){res.writeHead(404,{'Content-Type':'application/xml'});return res.end('<Error><Code>NoSuchKey</Code></Error>');}
    const b=objects.get(key);res.writeHead(200,{'Content-Length':b.length,'Content-Type':'application/octet-stream',ETag:'"x"'});res.end(req.method==='HEAD'?undefined:b);});});
  await new Promise(r=>s3.listen(0,'127.0.0.1',r));
  const saved={...process.env};Object.assign(process.env,{AWS_ACCESS_KEY_ID:'test',AWS_SECRET_ACCESS_KEY:'test',AWS_SESSION_TOKEN:''});
  const db=await freshDatabase();const pool=new pg.Pool({connectionString:db.url,options:'-c sie.system=on'});
  try{
    const t=(await pool.query("INSERT INTO tenants(name) VALUES('s3') RETURNING id")).rows[0].id;
    const i=(await pool.query("INSERT INTO identities(issuer,subject) VALUES('t','s3') RETURNING id")).rows[0].id;
    const p=(await pool.query("INSERT INTO projects(tenant_id,owner_id,title,kind) VALUES($1,$2,'p','image') RETURNING id",[t,i])).rows[0].id;
    const store=new AssetStore({system:pool,s3:{bucket:'engine-assets',region:'us-east-1',endpoint:`http://127.0.0.1:${s3.address().port}`}});
    const bytes=Buffer.from('id,value\n1,2\n');
    const a=await store.put({tenantId:t,projectId:p,bytes,mediaType:'text/csv'});
    assert.ok(seen.some(x=>x.startsWith('PUT /engine-assets/assets/')));
    const back=await store.read({tenantId:t,assetId:a.id});assert.deepEqual(back.bytes,bytes);assert.equal(back.mediaType,'text/csv');
    const row=(await pool.query('SELECT storage_key FROM asset_metadata WHERE id=$1',[a.id])).rows[0];assert.match(row.storage_key,/^s3:/);
    await assert.rejects(store.put({tenantId:t,projectId:p,bytes:Buffer.from([0x4d,0x5a,0x90,0,3,0,0,0,4,0,0,0,0xff,0xff,0,0]),mediaType:'application/octet-stream'}),/executable_rejected|unrecognized|unsupported/);
  }finally{process.env=saved;await pool.end();await db.drop();s3.close();}
});
