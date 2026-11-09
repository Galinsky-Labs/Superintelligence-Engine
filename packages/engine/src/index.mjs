// Composition root for the integrated engine (API and worker share it).
import {cpus} from 'node:os';
import {randomUUID,createHmac} from 'node:crypto';
import {createPools,SecretBox,log,metrics,sleep,installErrorReporter} from './infra.mjs';
import {IdentityService} from './identity.mjs';
import {ModelCatalog,Meter} from './catalog.mjs';
import {AssetStore} from './assets.mjs';
import {ProjectStore} from './projects.mjs';
import {RunStore} from './runs.mjs';
import {Executor} from './executor.mjs';
import {Sandbox} from './sandbox.mjs';
import {Workspace} from './workspace.mjs';
import {Connections} from './connections.mjs';
import {Scheduler} from './scheduler.mjs';
import {egressPolicy} from './net.mjs';
import {brokerFromEnvironment} from '../../auth/src/index.mjs';

export * from './infra.mjs';
export {listWorkspaces,compileOperation,OPERATIONS,DOMAINS} from './domains.mjs';
export {validateSpec,evaluateCondition} from './runs.mjs';
export {PROVIDERS} from './providers.mjs';

export function createEngine({env=process.env,pools,adapterOverrides,sandbox,fetchImpl}={}){
  installErrorReporter(env.SIE_ERROR_WEBHOOK_URL);
  const p=pools||createPools({databaseUrl:env.DATABASE_URL,appDatabaseUrl:env.APP_DATABASE_URL});
  const box=env.SIE_ENCRYPTION_KEY?new SecretBox(env.SIE_ENCRYPTION_KEY):null;
  const production=env.NODE_ENV==='production';
  const devAuth=env.SIE_DEV_AUTH==='1'&&!production;
  const egress=egressPolicy(env);
  const assets=new AssetStore({dir:env.SIE_STORAGE_DIR||'./var/storage',system:p.system,clamSocket:env.CLAMAV_SOCKET});
  const projects=new ProjectStore({tenant:p.tenant,system:p.system,assets});
  const runs=new RunStore({system:p.system});
  const catalog=new ModelCatalog({system:p.system,secretBox:box,env,adapterOverrides});
  const meter=new Meter({system:p.system});
  const sbx=sandbox||new Sandbox();
  const workspace=new Workspace({system:p.system,tenant:p.tenant,sandbox:sbx,storageDir:env.SIE_STORAGE_DIR||'./var/storage',previewSecret:env.SIE_PREVIEW_SECRET||(env.SIE_ENCRYPTION_KEY?createHmac('sha256',Buffer.from(env.SIE_ENCRYPTION_KEY,'hex')).update('sie-preview-token-v1').digest('hex'):undefined)}); // domain-separated key
  const connections=new Connections({system:p.system,secretBox:box,policy:egress,fetchImpl});
  const executor=new Executor({system:p.system,runs,catalog,meter,projects,assets,sandbox:sbx,workspace,connections,egress});
  const scheduler=new Scheduler({system:p.system,runs,projects});
  const identity=new IdentityService({system:p.system,oidcBroker:brokerFromEnvironment(env),devAuth});
  return {env,pools:p,box,production,devAuth,identity,catalog,meter,assets,projects,runs,executor,sandbox:sbx,workspace,connections,scheduler,
    async close(){await p.end();}};
}

/** Durable worker: claims ready nodes up to `concurrency`, runs lease recovery and schedules. */
export class Worker {
  constructor(engine,{concurrency=Number(engine.env.SIE_WORKER_CONCURRENCY||Math.max(8,cpus().length*8)),workerId=`worker-${process.pid}-${randomUUID().slice(0,6)}`,pollMs=Number(engine.env.SIE_WORKER_POLL_MS||400),leaseSeconds=60}={}){
    this.e=engine;this.concurrency=concurrency;this.id=workerId;this.pollMs=pollMs;this.lease=leaseSeconds;this.active=new Set();this.stopped=false;this.lastMaintenance=0;
  }
  async maintenance(){
    if(Date.now()-this.lastMaintenance<5000)return;this.lastMaintenance=Date.now();
    try{await this.e.runs.recoverExpired();}catch(e){log.error('recovery_failed',{message:e.message});}
    try{await this.e.scheduler.tick();}catch(e){log.error('scheduler_failed',{message:e.message});}
  }
  async tick(){
    await this.maintenance();
    const free=this.concurrency-this.active.size;if(free<=0)return 0;
    const claimed=await this.e.runs.claim({workerId:this.id,limit:Math.min(free,32),leaseSeconds:this.lease});
    for(const {node,run} of claimed){
      const p=this.e.executor.execute({node,run,leaseSeconds:this.lease}).catch(e=>log.error('execute_crashed',{message:e.message})).finally(()=>this.active.delete(p));
      this.active.add(p);
    }
    metrics.set('sie_worker_active_nodes',{worker:this.id},this.active.size);
    return claimed.length;
  }
  async run({signal}={}){
    log.info('worker_started',{workerId:this.id,concurrency:this.concurrency,sandbox:this.e.sandbox.info().backend});
    while(!this.stopped&&!signal?.aborted){
      let n=0;try{n=await this.tick()}catch(e){log.error('worker_tick_failed',{message:e.message});await sleep(2000);}
      if(!n)await sleep(this.pollMs);
    }
    await Promise.allSettled([...this.active]);
    log.info('worker_stopped',{workerId:this.id});
  }
  /** Run until every node of the run is terminal (used by tests and the inline API path). */
  async drain(runId,{timeoutMs=60000}={}){
    const end=Date.now()+timeoutMs;
    while(Date.now()<end){
      await this.tick();
      const r=(await this.e.pools.system.query('SELECT status FROM runs WHERE id=$1',[runId])).rows[0];
      if(['succeeded','failed','cancelled','awaiting_approval'].includes(r?.status)&&!this.active.size)return r.status;
      await sleep(50);
    }
    throw new Error('drain timeout');
  }
  stop(){this.stopped=true;}
}
