import test from 'node:test';import assert from 'node:assert/strict';
import {STUDIO_KINDS,defaultDoc,validateStudio,mixPlan,toSRT,toWebVTT,cutList,variationSpec,attachVariations,notebookProgram,applyNotebookRun,kindOfMediaType,mediaTypeOf} from '../src/studio.mjs';
test('templates are valid and media types round-trip',()=>{for(const k of STUDIO_KINDS){assert.deepEqual(validateStudio(k,defaultDoc(k)),[]);assert.equal(kindOfMediaType(mediaTypeOf(k)),k);}assert.equal(kindOfMediaType('application/json'),null);});
test('image board rejects bad masks, unknown parents and cycles; variations respect masks',()=>{
 assert.ok(validateStudio('image-board',{items:[{id:'a',prompt:'x',mask:{x:.8,y:0,w:.5,h:.1}}]}).some(e=>/mask/.test(e)));
 assert.ok(validateStudio('image-board',{items:[{id:'a',parentId:'b'},{id:'b',parentId:'a'}]}).some(e=>/cycle/.test(e)));
 const d={items:[{id:'a',prompt:'a red fox',artifactId:null,mask:{x:.1,y:.1,w:.2,h:.2}}]};
 const spec=variationSpec(d,{itemId:'a',count:3});assert.equal(spec.nodes.length,3);assert.match(spec.nodes[0].prompt,/Change only the region x 10-30%/);
 const run={id:'12345678-aaaa',nodes:[{key:'var1',state:'succeeded',artifactId:'11111111-1111-4111-8111-111111111111',config:{prompt:'p'},output:{simulated:true}},{key:'var2',state:'failed'}]};
 const next=attachVariations(d,run,{itemId:'a'});assert.equal(next.items.length,2);assert.equal(next.items[1].parentId,'a');assert.deepEqual(validateStudio('image-board',next),[]);
 assert.equal(attachVariations(next,run,{itemId:'a'}).items.length,2,'idempotent');
});
test('multitrack mix plan: timing from tempo, solo beats mute, missing stems listed',()=>{
 const d=defaultDoc('multitrack');const p=mixPlan(d);
 assert.equal(p.sections[1].startSeconds,10);assert.equal(p.totalSeconds,50);assert.deepEqual(p.missingStems.sort(),['bass','drums','melody']);
 const solo=mixPlan({...d,tracks:d.tracks.map(t=>t.id==='bass'?{...t,solo:true}:t)});assert.deepEqual(solo.sections[2].tracks.map(t=>t.id),['bass']);
 assert.ok(validateStudio('multitrack',{...d,tracks:[{...d.tracks[0],sections:['nope']}]}).length);
});
test('timeline rejects overlaps and exports SRT, WebVTT and a frame cut list',()=>{
 const d={fps:25,storyboard:[],tracks:[{id:'v',kind:'video',clips:[{id:'a',start:0,duration:2,artifactId:null},{id:'b',start:1.5,duration:1,artifactId:null}]}]};
 assert.ok(validateStudio('timeline',d).some(e=>/overlap/.test(e)));
 const ok={fps:25,storyboard:[],tracks:[{id:'v',kind:'video',clips:[{id:'a',start:0,duration:2,artifactId:null}]},{id:'c',kind:'caption',clips:[{id:'c2',start:62.5,duration:1.25,text:'Second'},{id:'c1',start:0.5,duration:1,text:'First'}]}]};
 assert.deepEqual(validateStudio('timeline',ok),[]);
 assert.equal(toSRT(ok),'1\n00:00:00,500 --> 00:00:01,500\nFirst\n\n2\n00:01:02,500 --> 00:01:03,750\nSecond\n');
 assert.match(toWebVTT(ok),/^WEBVTT\n\n00:00:00\.500 --> 00:00:01\.500\nFirst/);
 const cl=cutList(ok);assert.equal(cl.tracks[0].clips[0].outFrame,50);assert.deepEqual(cl.missingMedia,['a']);
});
test('notebook program delimits cell output and marks cells after a failure',()=>{
 const d={language:'python',cells:[{id:'a',type:'code',source:'print(1)'},{id:'m',type:'markdown',source:'x'},{id:'b',type:'code',source:'print(2)'}]};
 const prog=notebookProgram(d);assert.deepEqual(prog.cellIds,['a','b']);
 const next=applyNotebookRun(d,prog,{stdout:'__SIE_CELL_a__\n1\n__SIE_CELL_b__\n2\n'});
 assert.equal(next.cells[0].outputs[0].text,'1');assert.equal(next.cells[2].outputs[0].text,'2');assert.equal(next.cells[2].executionCount,2);
 const failed=applyNotebookRun(d,prog,{stdout:'__SIE_CELL_a__\nTraceback\n__SIE_CELL_ERROR__\n'});assert.match(failed.cells[2].outputs[0].text,/not executed/);
});
