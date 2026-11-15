// Durable worker process: executes ready run nodes, recovers expired leases, fires schedules.
import {createEngine,Worker,log} from '../../../packages/engine/src/index.mjs';

export function workerStatus(env=process.env){return Object.freeze({status:env.DATABASE_URL?'configured':'unconfigured',paidProviderDispatchEnabled:Boolean(env.DATABASE_URL)});}

if(process.argv[1]&&import.meta.url===new URL('file://'+process.argv[1]).href){
  if(!process.env.DATABASE_URL){console.log(JSON.stringify(workerStatus()));process.exit(0);}
  const engine=createEngine();
  const worker=new Worker(engine);
  const ac=new AbortController();
  for(const s of ['SIGTERM','SIGINT'])process.once(s,()=>{log.info('worker_shutdown',{signal:s});ac.abort();});
  worker.run({signal:ac.signal}).then(()=>engine.close()).catch(e=>{log.error('worker_crashed',{message:e.message});process.exitCode=1;});
}
