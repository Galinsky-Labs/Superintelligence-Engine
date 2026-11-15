// Studio documents (SIE-024 image board, SIE-025/026 multitrack music, SIE-027/028 timeline + captions,
// SIE-033 notebooks): versioned JSON artifacts with a strict schema per kind, validated on every save, plus
// the operations that turn them into real engine runs (variations, stems) and exports (SRT, cut list, mix plan).
import {EngineError,check} from './infra.mjs';

export const STUDIO_KINDS=Object.freeze(['image-board','multitrack','timeline','notebook']);
export const mediaTypeOf=kind=>`application/vnd.sie.${kind}+json`;
export function kindOfMediaType(mt){const m=/^application\/vnd\.sie\.([a-z-]+)\+json$/.exec(String(mt||''));return m&&STUDIO_KINDS.includes(m[1])?m[1]:null;}

const ID=/^[A-Za-z0-9_-]{1,64}$/;
const isObj=v=>v&&typeof v==='object'&&!Array.isArray(v);
const num=(v,min,max)=>typeof v==='number'&&Number.isFinite(v)&&v>=min&&v<=max;
const str=(v,max)=>typeof v==='string'&&v.length<=max;
const uuidOrNull=v=>v===null||v===undefined||/^[0-9a-f-]{36}$/i.test(v);
function ids(list,label,errors){const seen=new Set();for(const x of list){if(!ID.test(x?.id||''))errors.push(`${label}: invalid id ${x?.id}`);else if(seen.has(x.id))errors.push(`${label}: duplicate id ${x.id}`);seen.add(x.id);}return seen;}

const VALIDATORS={
 'image-board'(d,e){
  if(!Array.isArray(d.items)||d.items.length>500)return e.push('items must be an array (max 500)');
  const known=ids(d.items,'items',e);
  for(const it of d.items){
   if(!str(it.prompt??'',4000))e.push(`item ${it.id}: prompt too long`);
   if(!uuidOrNull(it.artifactId))e.push(`item ${it.id}: invalid artifactId`);
   if(it.parentId!=null&&(!known.has(it.parentId)||it.parentId===it.id))e.push(`item ${it.id}: unknown parent`);
   if(it.mask!=null&&!(isObj(it.mask)&&['x','y','w','h'].every(k=>num(it.mask[k],0,1))&&it.mask.x+it.mask.w<=1.0001&&it.mask.y+it.mask.h<=1.0001))e.push(`item ${it.id}: mask must be x,y,w,h fractions inside the image`);
   if(it.pinned!==undefined&&typeof it.pinned!=='boolean')e.push(`item ${it.id}: pinned must be boolean`);
  }
  // no parent cycles
  const parent=new Map(d.items.map(i=>[i.id,i.parentId]));
  for(const it of d.items){let p=it.parentId,n=0;while(p!=null&&n<=d.items.length){if(p===it.id){e.push(`item ${it.id}: variation cycle`);break;}p=parent.get(p);n++;}}
 },
 multitrack(d,e){
  if(!num(d.bpm,20,300))e.push('bpm must be 20-300');
  if(!Number.isInteger(d.beatsPerBar)||d.beatsPerBar<1||d.beatsPerBar>16)e.push('beatsPerBar must be 1-16');
  if(!Array.isArray(d.sections)||!d.sections.length||d.sections.length>64)return e.push('sections: 1-64 required');
  if(!Array.isArray(d.tracks)||d.tracks.length>32)return e.push('tracks: up to 32');
  const secs=ids(d.sections,'sections',e);ids(d.tracks,'tracks',e);
  for(const s of d.sections){if(!Number.isInteger(s.bars)||s.bars<1||s.bars>512)e.push(`section ${s.id}: bars 1-512`);if(!str(s.name??'',80))e.push(`section ${s.id}: name too long`);}
  for(const t of d.tracks){
   if(!['drums','bass','harmony','melody','vocals','fx','other'].includes(t.role))e.push(`track ${t.id}: unknown role`);
   if(!num(t.gainDb??0,-60,12))e.push(`track ${t.id}: gainDb -60..12`);
   if(!uuidOrNull(t.stemArtifactId))e.push(`track ${t.id}: invalid stemArtifactId`);
   if(!Array.isArray(t.sections)||t.sections.some(s=>!secs.has(s)))e.push(`track ${t.id}: sections must reference known sections`);
  }
 },
 timeline(d,e){
  if(![24,25,30,50,60].includes(d.fps))e.push('fps must be 24, 25, 30, 50 or 60');
  if(!Array.isArray(d.storyboard)||d.storyboard.length>200)e.push('storyboard must be an array (max 200)');else{ids(d.storyboard,'storyboard',e);for(const s of d.storyboard)if(!str(s.description??'',2000)||!uuidOrNull(s.imageArtifactId))e.push(`shot ${s.id}: invalid`);}
  if(!Array.isArray(d.tracks)||d.tracks.length>16)return e.push('tracks: up to 16');
  ids(d.tracks,'tracks',e);
  for(const t of d.tracks){
   if(!['video','audio','caption'].includes(t.kind))e.push(`track ${t.id}: kind must be video, audio or caption`);
   if(!Array.isArray(t.clips)||t.clips.length>1000){e.push(`track ${t.id}: clips`);continue;}
   ids(t.clips,`track ${t.id} clips`,e);
   const sorted=[...t.clips].sort((a,b)=>a.start-b.start);
   for(const [i,c] of sorted.entries()){
    if(!num(c.start,0,86400)||!num(c.duration,0.04,86400))e.push(`clip ${c.id}: start/duration in seconds`);
    if(t.kind==='caption'?!(typeof c.text==='string'&&c.text.trim()&&c.text.length<=500):!uuidOrNull(c.artifactId))e.push(`clip ${c.id}: ${t.kind==='caption'?'caption text required':'invalid artifactId'}`);
    if(i>0&&sorted[i-1].start+sorted[i-1].duration>c.start+1e-6)e.push(`track ${t.id}: clips ${sorted[i-1].id} and ${c.id} overlap`);
   }
  }
 },
 notebook(d,e){
  if(d.language!=='python')e.push('language must be python');
  if(!Array.isArray(d.cells)||d.cells.length>200)return e.push('cells must be an array (max 200)');
  ids(d.cells,'cells',e);
  for(const c of d.cells){if(!['markdown','code'].includes(c.type))e.push(`cell ${c.id}: type`);if(!str(c.source,100000))e.push(`cell ${c.id}: source`);if(c.outputs!==undefined&&!Array.isArray(c.outputs))e.push(`cell ${c.id}: outputs`);}
 }
};
export function validateStudio(kind,doc){
 check(STUDIO_KINDS.includes(kind),'unknown_studio_kind',404);
 const e=[];if(!isObj(doc))e.push('document must be an object');else VALIDATORS[kind](doc,e);
 if(JSON.stringify(doc||{}).length>2_000_000)e.push('document too large');
 return e;
}
export function assertStudio(kind,doc){const e=validateStudio(kind,doc);if(e.length)throw new EngineError('invalid_studio_document',400,e.slice(0,5).join('; '));}
export function defaultDoc(kind){
 return {'image-board':{items:[]},
  multitrack:{bpm:96,beatsPerBar:4,sections:[{id:'intro',name:'Intro',bars:4},{id:'verse',name:'Verse',bars:8},{id:'chorus',name:'Chorus',bars:8}],
   tracks:[{id:'drums',name:'Drums',role:'drums',gainDb:0,mute:false,solo:false,stemArtifactId:null,sections:['verse','chorus']},{id:'bass',name:'Bass',role:'bass',gainDb:-3,mute:false,solo:false,stemArtifactId:null,sections:['verse','chorus']},{id:'melody',name:'Melody',role:'melody',gainDb:-2,mute:false,solo:false,stemArtifactId:null,sections:['intro','chorus']}]},
  timeline:{fps:25,storyboard:[],tracks:[{id:'v1',kind:'video',clips:[]},{id:'a1',kind:'audio',clips:[]},{id:'cc',kind:'caption',clips:[]}]},
  notebook:{language:'python',cells:[{id:'intro',type:'markdown',source:'# Notebook\nCells run top to bottom in a fresh sandbox each time, so results are reproducible.',outputs:[]},{id:'c1',type:'code',source:'print(sum(range(10)))',outputs:[]}]}}[kind];
}

// ---------------- multitrack ----------------
export function sectionTimeline(d){
 const barSec=60/d.bpm*d.beatsPerBar;let t=0;
 return d.sections.map(s=>{const out={id:s.id,name:s.name,startSeconds:+t.toFixed(3),durationSeconds:+(s.bars*barSec).toFixed(3)};t+=s.bars*barSec;return out;});
}
/** Which tracks are audible in each section (solo wins over mute), with timings: the render/mix plan. */
export function mixPlan(d){
 const anySolo=d.tracks.some(t=>t.solo);
 const audible=t=>anySolo?t.solo:!t.mute;
 const sections=sectionTimeline(d);
 return {bpm:d.bpm,beatsPerBar:d.beatsPerBar,totalSeconds:+sections.reduce((a,s)=>a+s.durationSeconds,0).toFixed(3),
  sections:sections.map(s=>({...s,tracks:d.tracks.filter(t=>audible(t)&&t.sections.includes(s.id)).map(t=>({id:t.id,role:t.role,gainDb:t.gainDb??0,stemArtifactId:t.stemArtifactId||null}))})),
  missingStems:d.tracks.filter(t=>audible(t)&&!t.stemArtifactId).map(t=>t.id)};
}
export function stemSpec(d,trackId,{prompt,title}={}){
 const t=d.tracks.find(x=>x.id===trackId);check(t,'track_not_found',404);
 const dur=Math.max(5,Math.min(300,Math.round(sectionTimeline(d).filter(s=>t.sections.includes(s.id)).reduce((a,s)=>a+s.durationSeconds,0))||10));
 const p=(prompt||`${t.role} stem, ${d.bpm} BPM, ${d.beatsPerBar}/4`).slice(0,1000);
 return {title:(title||`Stem: ${t.name}`).slice(0,200),nodes:[{key:'stem',type:'media',operation:'music',prompt:`${p} (isolated ${t.role} stem only, ${d.bpm} BPM)`,durationSeconds:dur,title:`Stem — ${t.name}`.slice(0,150)}]};
}

// ---------------- image board ----------------
export function variationSpec(d,{itemId,prompt,count=2,mask=null,size}={}){
 check(Number.isInteger(count)&&count>=1&&count<=4,'invalid_count');
 const base=itemId?d.items.find(i=>i.id===itemId):null;check(!itemId||base,'item_not_found',404);
 const p=String(prompt||base?.prompt||'').trim();check(p&&p.length<=4000,'invalid_prompt');
 const m=mask||base?.mask||null;
 const region=m?` Change only the region x ${Math.round(m.x*100)}-${Math.round((m.x+m.w)*100)}%, y ${Math.round(m.y*100)}-${Math.round((m.y+m.h)*100)}%; keep everything else.`:'';
 return {title:`Variations: ${p}`.slice(0,200),nodes:Array.from({length:count},(_,k)=>({key:`var${k+1}`,type:'media',operation:'image',prompt:`${p}${region} (variation ${k+1} of ${count})`,...(size?{size}:{}),title:`Variation ${k+1}: ${p}`.slice(0,150)}))};
}
/** Adds the images a finished variations run produced to the board as children of the source item. */
export function attachVariations(d,run,{itemId,mask=null}={}){
 const made=(run.nodes||[]).filter(n=>/^var\d+$/.test(n.key)&&n.state==='succeeded'&&n.artifactId);
 const items=[...d.items];
 for(const n of made){
  if(items.some(i=>i.artifactId===n.artifactId))continue;
  items.push({id:`${run.id.slice(0,8)}-${n.key}`,artifactId:n.artifactId,prompt:String(n.config?.prompt||'').slice(0,4000),parentId:itemId||null,mask:mask||null,pinned:false,note:n.output?.simulated?'SIMULATED':''});
 }
 return {...d,items};
}

// ---------------- timeline ----------------
const ts=(s,sep)=>{const ms=Math.round(s*1000),h=Math.floor(ms/3600000),m=Math.floor(ms/60000)%60,sec=Math.floor(ms/1000)%60;return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}${sep}${String(ms%1000).padStart(3,'0')}`;};
export function toSRT(d){
 const caps=d.tracks.filter(t=>t.kind==='caption').flatMap(t=>t.clips).sort((a,b)=>a.start-b.start);
 return caps.map((c,i)=>`${i+1}\n${ts(c.start,',')} --> ${ts(c.start+c.duration,',')}\n${c.text.trim()}\n`).join('\n');
}
export function toWebVTT(d){return 'WEBVTT\n\n'+toSRT(d).replace(/(\d\d:\d\d:\d\d),(\d{3})/g,'$1.$2').replace(/^\d+\n/gm,'');}
export function cutList(d){
 const frames=s=>Math.round(s*d.fps);
 const tracks=d.tracks.filter(t=>t.kind!=='caption').map(t=>({track:t.id,kind:t.kind,clips:[...t.clips].sort((a,b)=>a.start-b.start).map(c=>({clip:c.id,artifactId:c.artifactId||null,inFrame:frames(c.start),outFrame:frames(c.start+c.duration)}))}));
 const end=Math.max(0,...d.tracks.flatMap(t=>t.clips.map(c=>c.start+c.duration)));
 return {fps:d.fps,durationSeconds:+end.toFixed(3),durationFrames:frames(end),tracks,missingMedia:tracks.flatMap(t=>t.clips.filter(c=>!c.artifactId).map(c=>c.clip))};
}

// ---------------- notebook ----------------
const MARK='__SIE_CELL_';
/** One script that runs all code cells up to `untilCellId` in order, delimiting each cell's output. */
export function notebookProgram(d,untilCellId){
 const cells=d.cells.filter(c=>c.type==='code');
 const stop=untilCellId?cells.findIndex(c=>c.id===untilCellId):cells.length-1;
 check(!untilCellId||stop>=0,'cell_not_found',404);
 const chosen=cells.slice(0,stop+1);
 const body=chosen.map(c=>`print(${JSON.stringify(MARK+c.id+'__')}, flush=True)\ntry:\n    exec(compile(${JSON.stringify(c.source)}, ${JSON.stringify('cell '+c.id)}, 'exec'), _ns)\nexcept Exception as _e:\n    import traceback; traceback.print_exc(); import sys; sys.stdout.flush(); print(${JSON.stringify(MARK+'ERROR__')}, flush=True); raise SystemExit(1)`).join('\n');
 return {code:'import sys\n_ns={"__name__":"__main__"}\nsys.stderr=sys.stdout\n'+body+'\n',cellIds:chosen.map(c=>c.id)};
}
export function applyNotebookRun(d,{cellIds},result){
 const out=String(result.stdout||'');const parts=new Map();let cur=null;
 for(const line of out.split('\n')){const m=new RegExp('^'+MARK+'([A-Za-z0-9_-]+)__$').exec(line.trim());if(m){if(m[1]==='ERROR'){cur=null;continue;}cur=m[1];parts.set(cur,[]);continue;}if(cur)parts.get(cur).push(line);}
 let n=Math.max(0,...d.cells.map(c=>c.executionCount||0));
 return {...d,cells:d.cells.map(c=>cellIds.includes(c.id)?{...c,executionCount:++n,outputs:parts.has(c.id)?[{stream:'stdout',text:parts.get(c.id).join('\n').replace(/\n$/,'')}]:[{stream:'stderr',text:'not executed (an earlier cell failed)'}]}:c)};
}
