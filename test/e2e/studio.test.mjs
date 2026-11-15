// Studio documents end to end: image board variations, multitrack stems, timeline captions, notebook runs.
import test from 'node:test';import assert from 'node:assert/strict';
import {skip,freshDatabase,startApp,login} from '../helpers/harness.mjs';
test('studio documents drive real runs and exports',{skip,timeout:180000},async()=>{
 const db=await freshDatabase();const app=await startApp(db,{SIE_SIM_DELAY_MS:'1'});
 const ac=new AbortController();const loop=app.worker.run({signal:ac.signal});
 try{
  const c=await login(app.base,'studio');const p=(await c.post('/v1/projects',{title:'Studio',kind:'image'})).data;
  const wait=async id=>{for(let i=0;i<300;i++){const r=(await c.get('/v1/runs/'+id)).data;if(['succeeded','failed','cancelled'].includes(r.status))return r;await new Promise(s=>setTimeout(s,100));}throw new Error('timeout');};
  // image board
  const board=(await c.post(`/v1/projects/${p.id}/studio`,{kind:'image-board',title:'Moodboard',doc:{items:[{id:'seed',prompt:'lighthouse at dusk',artifactId:null,mask:null}]}})).data;
  assert.equal(board.mediaType,'application/vnd.sie.image-board+json');
  const vr=(await c.post(`/v1/projects/${p.id}/studio/${board.id}/variations`,{itemId:'seed',count:2,mask:{x:0,y:0,w:.5,h:.5}})).data;
  assert.equal((await wait(vr.id)).status,'succeeded');
  const att=await c.post(`/v1/projects/${p.id}/studio/${board.id}/attach`,{runId:vr.id,itemId:'seed'});assert.equal(att.status,200,JSON.stringify(att.data));
  const b2=(await c.get(`/v1/projects/${p.id}/artifacts/${board.id}`)).data;assert.equal(b2.body.items.length,3);assert.ok(b2.body.items[1].artifactId);assert.equal(b2.currentRevision,2);
  // generic saves are validated too
  const bad=await c.put(`/v1/projects/${p.id}/artifacts/${board.id}`,{body:{items:[{id:'x',parentId:'nope'}]},mediaType:b2.mediaType,expectedRevision:2});assert.equal(bad.status,400);assert.equal(bad.data.code,'invalid_studio_document');
  // multitrack stems
  const mt=(await c.post(`/v1/projects/${p.id}/studio`,{kind:'multitrack',title:'Song'})).data;
  const sr=(await c.post(`/v1/projects/${p.id}/studio/${mt.id}/stems`,{trackId:'bass'})).data;assert.equal((await wait(sr.id)).status,'succeeded');
  assert.equal((await c.post(`/v1/projects/${p.id}/studio/${mt.id}/stems/attach`,{runId:sr.id,trackId:'bass'})).status,200);
  const plan=(await c.get(`/v1/projects/${p.id}/studio/${mt.id}/export`)).data;assert.equal(plan.missingStems.includes('bass'),false);assert.equal(plan.totalSeconds,50);
  // timeline captions
  const tl=(await c.post(`/v1/projects/${p.id}/studio`,{kind:'timeline',title:'Cut',doc:{fps:25,storyboard:[{id:'s1',description:'Opening',imageArtifactId:null}],tracks:[{id:'cc',kind:'caption',clips:[{id:'c1',start:0,duration:2,text:'Hello'}]}]}})).data;
  const srt=await fetch(`${app.base}/v1/projects/${p.id}/studio/${tl.id}/export?format=srt`,{headers:{Authorization:'Bearer '+c.token,'X-Tenant-Id':c.tenantId}});
  assert.equal(srt.status,200);assert.equal(await srt.text(),'1\n00:00:00,000 --> 00:00:02,000\nHello\n');
  assert.equal((await c.get(`/v1/projects/${p.id}/studio/${tl.id}/export`)).data.durationFrames,50);
  // notebook
  const nb=(await c.post(`/v1/projects/${p.id}/studio`,{kind:'notebook',title:'Analysis',doc:{language:'python',cells:[{id:'a',type:'code',source:'x=21'},{id:'b',type:'code',source:'print(x*2)'}]}})).data;
  const run=await c.post(`/v1/projects/${p.id}/studio/${nb.id}/run`,{});
  if(app.engine.sandbox.backend){assert.equal(run.status,200,JSON.stringify(run.data));assert.equal(run.data.artifact.body.cells[1].outputs[0].text,'42');}
  else{assert.equal(run.status,503);assert.equal(run.data.code,'sandbox_unavailable');}
  assert.equal((await c.post(`/v1/projects/${p.id}/studio`,{kind:'nope'})).status,400);
 }finally{ac.abort();await loop;await app.stop();await db.drop();}
});
