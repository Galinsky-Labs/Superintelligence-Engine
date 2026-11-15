#!/usr/bin/env node
// SIE-037: concurrency and cost-accounting trial against a running engine (simulator by default, $0).
//   SIE_URL=https://engine.example SIE_TOKEN=sie_... node scripts/load-trial.mjs [--runs 40] [--concurrency 10] [--model deterministic/sim-text]
// Starts N short generations with bounded concurrency in a throwaway project, then reports throughput,
// latency percentiles, errors, and whether recorded usage equals the runs' charged cost (no leaks).
import {EngineClient} from '../packages/sdk/src/index.mjs';
export async function loadTrial({baseUrl,token,tenantId,runs=40,concurrency=10,model={provider:'deterministic',model:'sim-text'},fetchImpl}){
 const root=new EngineClient({baseUrl,token,...(fetchImpl?{fetchImpl}:{})});
 const c=root.forTenant(tenantId||(await root.tenants()).items[0].id);
 const before=await c.budget();
 const project=await c.createProject({title:'Load trial '+new Date().toISOString(),kind:'general'});
 const lat=[],errors={};let next=0;const t0=Date.now();
 await Promise.all(Array.from({length:Math.min(concurrency,runs)},async()=>{
  while(next<runs){const i=next++;const s=Date.now();
   try{const r=await c.generate(project.id,{prompt:`Load trial request ${i}: summarise why load tests matter.`,model,maxOutputTokens:64});if(r.status!=='succeeded')throw Object.assign(new Error(r.error||r.status),{code:r.status});lat.push(Date.now()-s);}
   catch(e){const k=e.code||e.message;errors[k]=(errors[k]||0)+1;}}
 }));
 const seconds=(Date.now()-t0)/1000;const after=await c.budget();
 const runList=(await c.runs({projectId:project.id,limit:runs})).items||[];
 const charged=runList.reduce((a,r)=>a+Number(r.spentMicro||0),0);
 const usageDelta=Number(after.tenant.spentMicro)-Number(before.tenant.spentMicro);
 lat.sort((a,b)=>a-b);const pct=p=>lat.length?lat[Math.min(lat.length-1,Math.floor(p/100*lat.length))]:null;
 await c.deleteProject(project.id).catch(()=>{});
 return {runs,concurrency,succeeded:lat.length,errors,seconds:+seconds.toFixed(2),throughputPerSecond:+(lat.length/seconds).toFixed(2),
  latencyMs:{p50:pct(50),p95:pct(95),max:lat.at(-1)??null},chargedMicro:charged,tenantSpendDeltaMicro:usageDelta,accountingConsistent:charged===usageDelta};
}
if(process.argv[1]&&import.meta.url===new URL('file://'+process.argv[1]).href){
 const a=process.argv.slice(2),opt=(k,d)=>{const i=a.indexOf(k);return i>=0?a[i+1]:d};
 const [provider,...rest]=opt('--model','deterministic/sim-text').split('/');
 const r=await loadTrial({baseUrl:process.env.SIE_URL||'http://localhost:8080',token:process.env.SIE_TOKEN,tenantId:process.env.SIE_TENANT,runs:Number(opt('--runs',40)),concurrency:Number(opt('--concurrency',10)),model:{provider,model:rest.join('/')}});
 console.log(JSON.stringify(r,null,2));process.exitCode=r.succeeded===r.runs&&r.accountingConsistent?0:1;
}
