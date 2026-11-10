// Durable run/node state machine on PostgreSQL. Every transition is a guarded UPDATE so
// concurrent workers, API cancellation and lease recovery cannot double-apply.
import {randomUUID} from 'node:crypto';
import {EngineError,check,fail,isObject,sha256,requireUUID,requireMembership,tx,log,metrics} from './infra.mjs';

export const NODE_TYPES=['agent','planner','tool','approval','code','media','external_agent'];
const KEY=/^[A-Za-z0-9_.-]{1,64}$/;
const TERMINAL_NODE=['succeeded','failed','skipped','cancelled'];
export const MAX_NODES=Number(process.env.SIE_MAX_RUN_NODES||2000);

// ---------- conditions ----------
export function getPath(obj,path){
  if(!path)return obj;
  let cur=obj;
  for(const part of String(path).split('.')){
    if(cur==null)return undefined;
    if(['__proto__','constructor','prototype'].includes(part))return undefined;
    cur=Array.isArray(cur)&&/^\d+$/.test(part)?cur[Number(part)]:cur[part];
  }
  return cur;
}
export function evaluateCondition(cond,outputs){
  if(cond==null)return true;
  check(isObject(cond),'invalid_condition');
  if(cond.all)return cond.all.every(c=>evaluateCondition(c,outputs));
  if(cond.any)return cond.any.some(c=>evaluateCondition(c,outputs));
  if(cond.not)return !evaluateCondition(cond.not,outputs);
  const v=getPath(outputs[cond.node],cond.path);
  const x=cond.value;
  switch(cond.op||'truthy'){
    case 'eq':return JSON.stringify(v)===JSON.stringify(x);
    case 'ne':return JSON.stringify(v)!==JSON.stringify(x);
    case 'gt':return Number(v)>Number(x);
    case 'gte':return Number(v)>=Number(x);
    case 'lt':return Number(v)<Number(x);
    case 'lte':return Number(v)<=Number(x);
    case 'contains':return typeof v==='string'?v.includes(String(x)):Array.isArray(v)?v.some(y=>JSON.stringify(y)===JSON.stringify(x)):false;
    case 'exists':return v!==undefined&&v!==null;
    case 'truthy':return Boolean(v);
    case 'falsy':return !v;
    default:fail('invalid_condition',400,'Unknown operator '+cond.op);
  }
}
function conditionNodes(cond,acc=new Set()){
  if(!isObject(cond))return acc;
  for(const k of ['all','any'])if(Array.isArray(cond[k]))cond[k].forEach(c=>conditionNodes(c,acc));
  if(cond.not)conditionNodes(cond.not,acc);
  if(typeof cond.node==='string')acc.add(cond.node);
  return acc;
}

/** Validate and normalize a workflow spec. Returns {title, nodes, inputs, budgetCeilingMicro}. */
export function validateSpec(spec,{maxNodes=MAX_NODES}={}){
  check(isObject(spec)&&Array.isArray(spec.nodes),'invalid_workflow',400,'Workflow must have a nodes array');
  check(spec.nodes.length>=1&&spec.nodes.length<=maxNodes,'invalid_workflow',400,`Workflow needs 1..${maxNodes} nodes`);
  check(Buffer.byteLength(JSON.stringify(spec))<=1024*1024,'workflow_too_large',413);
  const keys=new Set();
  const nodes=spec.nodes.map(n=>{
    check(isObject(n)&&KEY.test(n.key||'')&&!keys.has(n.key),'invalid_node_key',400,'Node keys must be unique [A-Za-z0-9_.-]{1,64}: '+n?.key);
    keys.add(n.key);
    check(NODE_TYPES.includes(n.type),'invalid_node_type',400,'Unsupported node type '+n.type);
    const dependsOn=n.dependsOn??[];check(Array.isArray(dependsOn)&&dependsOn.every(d=>typeof d==='string'),'invalid_dependencies');
    const maxAttempts=n.maxAttempts??3;check(Number.isInteger(maxAttempts)&&maxAttempts>=1&&maxAttempts<=20,'invalid_max_attempts');
    const {key,type,dependsOn:_d,maxAttempts:_m,...config}=n;
    return {key,type,dependsOn:[...new Set(dependsOn)],maxAttempts,config};
  });
  for(const n of nodes){
    for(const d of n.dependsOn)check(keys.has(d)&&d!==n.key,'unknown_dependency',400,`${n.key} depends on unknown node ${d}`);
    for(const c of conditionNodes(n.config.when))check(n.dependsOn.includes(c),'condition_dependency',400,`${n.key} condition references ${c} which it does not depend on`);
  }
  const state=new Map(),by=new Map(nodes.map(n=>[n.key,n]));
  const visit=k=>{const s=state.get(k);if(s===1)fail('workflow_cycle',400,'Dependency cycle at '+k);if(s===2)return;state.set(k,1);for(const d of by.get(k).dependsOn)visit(d);state.set(k,2);};
  nodes.forEach(n=>visit(n.key));
  const ceiling=spec.budgetCeilingMicro??0;check(Number.isSafeInteger(ceiling)&&ceiling>=0,'invalid_budget_ceiling');
  return {title:typeof spec.title==='string'?spec.title.slice(0,256):'',nodes,inputs:isObject(spec.inputs)?spec.inputs:{},budgetCeilingMicro:ceiling};
}

export function canonical(v){if(Array.isArray(v))return '['+v.map(canonical).join(',')+']';if(isObject(v))return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';return JSON.stringify(v);}
const lockRun=(db,runId)=>db.query('SELECT id FROM runs WHERE id=$1 FOR UPDATE',[runId]);
function serializeRun(r){return {id:r.id,projectId:r.project_id,kind:r.kind,title:r.title,status:r.status,budgetCeilingMicro:Number(r.budget_ceiling_micro),spentMicro:Number(r.spent_micro),
  output:r.output,error:r.error,createdBy:r.created_by,scheduleId:r.schedule_id,workflowId:r.workflow_id||null,workflowVersion:r.workflow_version??null,createdAt:r.created_at,startedAt:r.started_at,finishedAt:r.finished_at,updatedAt:r.updated_at}}
function serializeNode(n){return {key:n.node_key,type:n.type,state:n.state,dependsOn:n.depends_on,parent:n.parent_key,attempt:n.attempt,maxAttempts:n.max_attempts,
  output:n.output,artifactId:n.artifact_id,error:n.error,costMicro:Number(n.cost_micro),startedAt:n.started_at,finishedAt:n.finished_at,config:n.config}}

export class RunStore {
  constructor({system,notify=true}){this.db=system;this.notify=notify;}

  async event(db,run,type,payload={},nodeKey=null){
    const r=await db.query('INSERT INTO run_events(tenant_id,run_id,node_key,type,payload) VALUES($1,$2,$3,$4,$5) RETURNING id',[run.tenant_id||run.tenantId,run.id,nodeKey,type,JSON.stringify(payload)]);
    if(this.notify)await db.query("SELECT pg_notify('sie_run_events',$1)",[run.id]);
    return r.rows[0].id;
  }

  async createRun(principal,tenantId,projectId,{kind='workflow',spec,title,idempotencyKey,scheduleId=null}){
    requireUUID(projectId,'project');
    await requireMembership(this.db,principal,tenantId,'member');
    const v=validateSpec(spec);
    if(idempotencyKey!==undefined)check(typeof idempotencyKey==='string'&&/^[A-Za-z0-9_.:-]{1,128}$/.test(idempotencyKey),'invalid_idempotency_key');
    return tx(this.db,async db=>{
      check((await db.query('SELECT 1 FROM projects WHERE tenant_id=$1 AND id=$2 AND archived_at IS NULL',[tenantId,projectId])).rowCount,'project_not_found',404);
      if(idempotencyKey){
        const prev=(await db.query('SELECT * FROM runs WHERE tenant_id=$1 AND idempotency_key=$2',[tenantId,idempotencyKey])).rows[0];
        if(prev){check(sha256(canonical(prev.spec))===sha256(canonical(JSON.parse(JSON.stringify(v)))),'idempotency_conflict',409);return {...serializeRun(prev),replayed:true};}
      }
      const run=(await db.query(`INSERT INTO runs(tenant_id,project_id,created_by,kind,title,spec,budget_ceiling_micro,idempotency_key,schedule_id,status)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'queued') RETURNING *`,[tenantId,projectId,principal.identityId,kind,(title||v.title||kind).slice(0,256),JSON.stringify(v),v.budgetCeilingMicro,idempotencyKey||null,scheduleId])).rows[0];
      await this.insertNodes(db,run,v.nodes);
      await this.event(db,run,'run.created',{kind,title:run.title,nodes:v.nodes.map(n=>({key:n.key,type:n.type,dependsOn:n.dependsOn}))});
      metrics.inc('sie_runs_created_total',{kind});
      return serializeRun(run);
    });
  }
  async insertNodes(db,run,nodes,parentKey=null){
    for(const n of nodes){
      await db.query(`INSERT INTO run_nodes(tenant_id,run_id,node_key,type,config,depends_on,parent_key,state,max_attempts) VALUES($1,$2,$3,$4,$5,$6,$7,'pending',$8)`,
        [run.tenant_id,run.id,n.key,n.type,JSON.stringify(n.config),n.dependsOn,parentKey,n.maxAttempts]);
    }
    await this.promote(db,run);
  }

  /** Move pending nodes whose dependencies are satisfied to ready (or skipped/cancelled). Settles run status. */
  async promote(db,run){
    for(let pass=0;pass<50;pass++){
      const rows=(await db.query('SELECT node_key,state,depends_on,config,output FROM run_nodes WHERE run_id=$1',[run.id])).rows;
      const by=new Map(rows.map(r=>[r.node_key,r]));let changed=false;
      const outputs=Object.fromEntries(rows.map(r=>[r.node_key,r.output]));
      for(const n of rows.filter(r=>r.state==='pending')){
        const deps=n.depends_on.map(d=>by.get(d));
        if(deps.some(d=>!d||!TERMINAL_NODE.includes(d.state)))continue;
        const blocking=deps.find(d=>(d.state==='failed'&&!by.get(d.node_key).config?.optional)||d.state==='cancelled');
        let next,reason=null;
        if(blocking){next='cancelled';reason='dependency_'+blocking.state+':'+blocking.node_key;}
        else if(deps.length&&deps.every(d=>d.state==='skipped')&&!n.config.runIfDependenciesSkipped){next='skipped';reason='dependencies_skipped';}
        else{
          let ok;try{ok=evaluateCondition(n.config.when,outputs)}catch{ok=false;reason='condition_error'}
          next=ok?'ready':'skipped';if(!ok)reason=reason||'condition_false';
        }
        await db.query(`UPDATE run_nodes SET state=$3,error=$4,updated_at=now(),finished_at=CASE WHEN $3 IN ('skipped','cancelled') THEN now() ELSE finished_at END WHERE run_id=$1 AND node_key=$2 AND state='pending'`,[run.id,n.node_key,next,reason]);
        await this.event(db,run,next==='ready'?'node.ready':'node.'+next,reason?{reason}:{},n.node_key);
        changed=true;
      }
      if(!changed)break;
    }
    return this.settleRun(db,run);
  }
  async settleRun(db,run){
    const cur=(await db.query('SELECT * FROM runs WHERE id=$1 FOR UPDATE',[run.id])).rows[0];
    if(!cur||['succeeded','failed','cancelled'].includes(cur.status))return cur;
    const rows=(await db.query('SELECT node_key,state,output,artifact_id,config,error FROM run_nodes WHERE run_id=$1',[run.id])).rows;
    const allTerminal=rows.every(r=>TERMINAL_NODE.includes(r.state));
    if(allTerminal){
      const failed=rows.filter(r=>(r.state==='failed'&&!r.config?.optional)||r.state==='cancelled');
      const keys=new Set(rows.map(r=>r.node_key));
      const deps=new Set((await db.query('SELECT unnest(depends_on) d FROM run_nodes WHERE run_id=$1',[run.id])).rows.map(r=>r.d));
      const sinks=rows.filter(r=>!deps.has(r.node_key)&&keys.has(r.node_key)&&r.state==='succeeded');
      const output={results:Object.fromEntries(sinks.map(s=>[s.node_key,{output:s.output,artifactId:s.artifact_id}])),artifactIds:rows.map(r=>r.artifact_id).filter(Boolean)};
      const status=failed.length?'failed':'succeeded';
      const err=failed.length?failed.map(f=>`${f.node_key}: ${f.error||f.state}`).join('; ').slice(0,2000):null;
      await db.query('UPDATE runs SET status=$2,output=$3,error=$4,finished_at=now(),updated_at=now() WHERE id=$1',[run.id,status,JSON.stringify(output),err]);
      await this.event(db,cur,'run.'+status,{output,error:err});
      metrics.inc('sie_runs_finished_total',{status});
      return {...cur,status};
    }
    const waiting=rows.some(r=>r.state==='awaiting_approval')&&!rows.some(r=>['ready','running'].includes(r.state));
    const status=waiting?'awaiting_approval':rows.some(r=>r.state==='running'||r.attempt>0)?'running':cur.status==='awaiting_approval'?'running':cur.status;
    if(status!==cur.status){
      await db.query('UPDATE runs SET status=$2,started_at=coalesce(started_at,now()),updated_at=now() WHERE id=$1',[run.id,status]);
      await this.event(db,cur,'run.status',{status});
    }
    return {...cur,status};
  }

  // ---------- worker side ----------
  async claim({workerId,limit=1,leaseSeconds=60,tenantConcurrency=Number(process.env.SIE_TENANT_CONCURRENCY||0)}){
    const r=await this.db.query(`UPDATE run_nodes n SET state='running',attempt=n.attempt+1,lease_owner=$1,lease_token=gen_random_uuid(),lease_expires_at=now()+($3::int*interval '1 second'),
        started_at=coalesce(n.started_at,now()),updated_at=now()
      WHERE n.id IN (SELECT c.id FROM run_nodes c JOIN runs r ON r.id=c.run_id
        WHERE c.state='ready' AND c.next_attempt_at<=now() AND r.status IN ('queued','running','awaiting_approval')
          AND NOT (r.kind='generation' AND c.attempt=0 AND r.created_at>now()-interval '30 seconds') -- streaming generations are executed by the API request that created them; workers pick them up only if that request died
          AND ($4::int=0 OR (SELECT count(*) FROM run_nodes x WHERE x.tenant_id=c.tenant_id AND x.state='running')<$4)
        ORDER BY c.next_attempt_at,c.id FOR UPDATE OF c SKIP LOCKED LIMIT $2)
      RETURNING n.*`,[workerId,limit,leaseSeconds,tenantConcurrency]);
    const out=[];
    for(const node of r.rows){
      const run=(await this.db.query('SELECT * FROM runs WHERE id=$1',[node.run_id])).rows[0];
      await tx(this.db,async db=>{
        await this.event(db,run,'node.started',{attempt:node.attempt,worker:workerId},node.node_key);
        if(run.status==='queued'){await db.query("UPDATE runs SET status='running',started_at=coalesce(started_at,now()),updated_at=now() WHERE id=$1 AND status='queued'",[run.id]);await this.event(db,run,'run.status',{status:'running'});}
      });
      out.push({node,run});
    }
    return out;
  }
  /** Claim one specific ready node (inline execution by the API process for streaming generation). */
  async claimNode(runId,nodeKey,{workerId,leaseSeconds=60}){
    const r=await this.db.query(`UPDATE run_nodes SET state='running',attempt=attempt+1,lease_owner=$3,lease_token=gen_random_uuid(),lease_expires_at=now()+($4::int*interval '1 second'),started_at=coalesce(started_at,now()),updated_at=now()
      WHERE run_id=$1 AND node_key=$2 AND state='ready' RETURNING *`,[runId,nodeKey,workerId,leaseSeconds]);
    if(!r.rows[0])return null;
    const run=(await this.db.query('SELECT * FROM runs WHERE id=$1',[runId])).rows[0];
    await tx(this.db,async db=>{
      await this.event(db,run,'node.started',{attempt:r.rows[0].attempt,worker:workerId},nodeKey);
      await db.query("UPDATE runs SET status='running',started_at=coalesce(started_at,now()),updated_at=now() WHERE id=$1 AND status='queued'",[runId]);
    });
    return {node:r.rows[0],run};
  }
  async heartbeat(node,leaseSeconds=60){
    const r=await this.db.query(`UPDATE run_nodes n SET lease_expires_at=now()+($3::int*interval '1 second') FROM runs r WHERE n.id=$1 AND n.lease_token=$2 AND n.state='running' AND r.id=n.run_id RETURNING r.status`,[node.id,node.lease_token,leaseSeconds]);
    return r.rows[0]?(r.rows[0].status==='cancelled'?'cancelled':'ok'):'lost';
  }
  async checkpoint(node,data){
    const r=await this.db.query("UPDATE run_nodes SET checkpoint=$3,updated_at=now() WHERE id=$1 AND lease_token=$2 AND state='running'",[node.id,node.lease_token,JSON.stringify(data)]);
    return r.rowCount===1;
  }
  async outputs(runId){
    const r=await this.db.query("SELECT node_key,output,artifact_id,state FROM run_nodes WHERE run_id=$1",[runId]);
    return Object.fromEntries(r.rows.map(x=>[x.node_key,{output:x.output,artifactId:x.artifact_id,state:x.state}]));
  }
  async complete(node,{output=null,artifactId=null,costMicro=0,spawn=null}){
    return tx(this.db,async db=>{
      await lockRun(db,node.run_id);
      const r=await db.query(`UPDATE run_nodes SET state='succeeded',output=$3,artifact_id=$4,cost_micro=cost_micro+$5,error=NULL,lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,finished_at=now(),updated_at=now()
        WHERE id=$1 AND lease_token=$2 AND state='running' RETURNING *`,[node.id,node.lease_token,JSON.stringify(output),artifactId,costMicro]);
      if(!r.rowCount)return false; // cancelled or lease lost
      const run=(await db.query('SELECT * FROM runs WHERE id=$1',[node.run_id])).rows[0];
      await this.event(db,run,'node.succeeded',{artifactId,costMicro,output:summarize(output)},node.node_key);
      if(spawn?.nodes?.length){
        const existing=(await db.query('SELECT count(*)::int n FROM run_nodes WHERE run_id=$1',[run.id])).rows[0].n;
        check(existing+spawn.nodes.length<=MAX_NODES,'workflow_too_large',413);
        const taken=new Set((await db.query('SELECT node_key FROM run_nodes WHERE run_id=$1',[run.id])).rows.map(x=>x.node_key));
        for(const s of spawn.nodes)check(!taken.has(s.key),'invalid_node_key',400,'Spawned node key already exists: '+s.key);
        // Validate the spawned sub-graph with the spawning node as a stub root, then drop the stub.
        const withParent=validateSpec({nodes:[{key:node.node_key,type:'tool'},...spawn.nodes]}).nodes.filter(n=>n.key!==node.node_key);
        if(spawn.rewire)await db.query('UPDATE run_nodes SET depends_on=array_append(depends_on,$3) WHERE run_id=$1 AND $2=ANY(depends_on) AND state=\'pending\'',[run.id,node.node_key,spawn.rewire]);
        await this.insertNodes(db,run,withParent,node.node_key);
        await this.event(db,run,'node.delegated',{tasks:withParent.map(n=>({key:n.key,type:n.type,dependsOn:n.dependsOn}))},node.node_key);
      }else await this.promote(db,run);
      return true;
    });
  }
  async failNode(node,{error,retryable=false,delaySeconds}){
    return tx(this.db,async db=>{
      await lockRun(db,node.run_id);
      const cur=(await db.query("SELECT * FROM run_nodes WHERE id=$1 AND lease_token=$2 AND state='running' FOR UPDATE",[node.id,node.lease_token])).rows[0];
      if(!cur)return 'lost';
      const run=(await db.query('SELECT * FROM runs WHERE id=$1',[node.run_id])).rows[0];
      const again=retryable&&cur.attempt<cur.max_attempts;
      const delay=delaySeconds??Math.min(300,2**cur.attempt);
      await db.query(`UPDATE run_nodes SET state=$2,error=$3,lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,next_attempt_at=now()+($4::int*interval '1 second'),
        finished_at=CASE WHEN $2='failed' THEN now() ELSE NULL END,updated_at=now() WHERE id=$1`,[node.id,again?'ready':'failed',String(error).slice(0,2000),again?delay:0]);
      await this.event(db,run,again?'node.retry_scheduled':'node.failed',{error:String(error).slice(0,500),attempt:cur.attempt,...(again?{delaySeconds:delay}:{})},node.node_key);
      metrics.inc('sie_nodes_failed_total',{retry:String(again)});
      await this.promote(db,run);
      return again?'retrying':'failed';
    });
  }
  /** Node needs a human decision; it stays parked with its checkpoint until approved/denied. */
  async park(node,{approval,checkpoint}){
    return tx(this.db,async db=>{
      await lockRun(db,node.run_id);
      const r=await db.query("UPDATE run_nodes SET state='awaiting_approval',checkpoint=coalesce($3,checkpoint),lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,attempt=greatest(attempt-1,0),updated_at=now() WHERE id=$1 AND lease_token=$2 AND state='running' RETURNING *",
        [node.id,node.lease_token,checkpoint===undefined?null:JSON.stringify(checkpoint)]);
      if(!r.rowCount)return null;
      const run=(await db.query('SELECT * FROM runs WHERE id=$1',[node.run_id])).rows[0];
      const reqSha=sha256(canonical(approval.request));
      const a=(await db.query(`INSERT INTO approvals(tenant_id,run_id,node_key,action,effect,summary,request,request_sha256,requested_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
        ON CONFLICT(run_id,node_key,request_sha256) DO UPDATE SET status=CASE WHEN approvals.status IN ('denied','expired','consumed') THEN 'pending' ELSE approvals.status END,decided_by=CASE WHEN approvals.status IN ('denied','expired','consumed') THEN NULL ELSE approvals.decided_by END,expires_at=now()+interval '7 days' RETURNING *`,
        [run.tenant_id,run.id,node.node_key,approval.action.slice(0,120),approval.effect,String(approval.summary||'').slice(0,4000),JSON.stringify(approval.request),reqSha,run.created_by])).rows[0];
      await this.event(db,run,'approval.requested',{approvalId:a.id,action:a.action,effect:a.effect,summary:a.summary},node.node_key);
      await this.settleRun(db,run);
      return a;
    });
  }

  /** Lease recovery after worker crash: running nodes whose lease expired go back to ready (or fail). */
  async recoverExpired(){
    const expired=(await this.db.query("SELECT id,run_id FROM run_nodes WHERE state='running' AND lease_expires_at<now() LIMIT 500")).rows;
    let n=0;
    for(const x of expired){
      await tx(this.db,async db=>{
        await lockRun(db,x.run_id);
        const r=(await db.query(`UPDATE run_nodes SET state=CASE WHEN attempt<max_attempts THEN 'ready' ELSE 'failed' END,
            error=CASE WHEN attempt<max_attempts THEN 'lease_expired_recovered' ELSE 'lease_expired_attempts_exhausted' END,
            lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,next_attempt_at=now(),updated_at=now()
          WHERE id=$1 AND state='running' AND lease_expires_at<now() RETURNING node_key,state`,[x.id])).rows[0];
        if(!r)return;
        const run=(await db.query('SELECT * FROM runs WHERE id=$1',[x.run_id])).rows[0];
        await this.event(db,run,'node.recovered',{state:r.state},r.node_key);await this.promote(db,run);n++;
        log.warn('node_lease_recovered',{runId:x.run_id,node:r.node_key,state:r.state});
      });
    }
    return n;
  }

  // ---------- user side ----------
  async get(principal,tenantId,runId){
    requireUUID(runId,'run');await requireMembership(this.db,principal,tenantId,'viewer');
    const run=(await this.db.query('SELECT * FROM runs WHERE tenant_id=$1 AND id=$2',[tenantId,runId])).rows[0];check(run,'run_not_found',404);
    const nodes=(await this.db.query('SELECT * FROM run_nodes WHERE run_id=$1 ORDER BY started_at NULLS LAST,node_key',[runId])).rows;
    const approvals=(await this.db.query('SELECT id,node_key,action,effect,summary,request,status,created_at,decided_at,decided_by,decision_note FROM approvals WHERE run_id=$1 ORDER BY created_at',[runId])).rows;
    return {...serializeRun(run),spec:run.spec,nodes:nodes.map(serializeNode),approvals:approvals.map(serializeApproval)};
  }
  async list(principal,tenantId,{projectId,status,limit=50}={}){
    await requireMembership(this.db,principal,tenantId,'viewer');
    if(projectId)requireUUID(projectId,'project');
    const r=await this.db.query(`SELECT * FROM runs WHERE tenant_id=$1 AND ($2::uuid IS NULL OR project_id=$2) AND ($3::text IS NULL OR status=$3) ORDER BY created_at DESC LIMIT $4`,
      [tenantId,projectId||null,status||null,Math.min(200,Math.max(1,Number(limit)||50))]);
    return {items:r.rows.map(serializeRun)};
  }
  async events(principal,tenantId,runId,{after=0,limit=500}={}){
    requireUUID(runId,'run');await requireMembership(this.db,principal,tenantId,'viewer');
    check((await this.db.query('SELECT 1 FROM runs WHERE tenant_id=$1 AND id=$2',[tenantId,runId])).rowCount,'run_not_found',404);
    const r=await this.db.query('SELECT id,node_key,type,payload,created_at FROM run_events WHERE run_id=$1 AND id>$2 ORDER BY id LIMIT $3',[runId,after,Math.min(2000,limit)]);
    return r.rows.map(e=>({id:Number(e.id),node:e.node_key,type:e.type,payload:e.payload,createdAt:e.created_at}));
  }
  async cancel(principal,tenantId,runId,{reason='cancelled_by_user'}={}){
    requireUUID(runId,'run');await requireMembership(this.db,principal,tenantId,'member');
    return tx(this.db,async db=>{
      const run=(await db.query('SELECT * FROM runs WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[tenantId,runId])).rows[0];check(run,'run_not_found',404);
      if(['succeeded','failed','cancelled'].includes(run.status))fail('invalid_state',409,'Run already finished');
      const n=await db.query(`UPDATE run_nodes SET state='cancelled',error=$2,lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,finished_at=now(),updated_at=now() WHERE run_id=$1 AND state IN ('pending','ready','running','awaiting_approval') RETURNING node_key`,[runId,reason]);
      await db.query("UPDATE approvals SET status='expired' WHERE run_id=$1 AND status='pending'",[runId]);
      await db.query("UPDATE runs SET status='cancelled',error=$2,finished_at=now(),updated_at=now() WHERE id=$1",[runId,reason]);
      await this.event(db,run,'run.cancelled',{reason,nodes:n.rows.map(x=>x.node_key),by:principal.identityId});
      metrics.inc('sie_runs_finished_total',{status:'cancelled'});
      return {id:runId,status:'cancelled',cancelledNodes:n.rows.map(x=>x.node_key)};
    });
  }
  async retry(principal,tenantId,runId){
    requireUUID(runId,'run');await requireMembership(this.db,principal,tenantId,'member');
    return tx(this.db,async db=>{
      const run=(await db.query('SELECT * FROM runs WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[tenantId,runId])).rows[0];check(run,'run_not_found',404);
      check(['failed','cancelled'].includes(run.status),'invalid_state',409,'Only failed or cancelled runs can be retried');
      const n=await db.query(`UPDATE run_nodes SET state='pending',attempt=0,error=NULL,next_attempt_at=now(),finished_at=NULL,updated_at=now() WHERE run_id=$1 AND state IN ('failed','cancelled') RETURNING node_key`,[runId]);
      await db.query("UPDATE runs SET status='running',error=NULL,finished_at=NULL,output=NULL,updated_at=now() WHERE id=$1",[runId]);
      await this.event(db,run,'run.retried',{nodes:n.rows.map(x=>x.node_key),by:principal.identityId});
      await this.promote(db,{...run,status:'running'});
      return {id:runId,status:'running',retriedNodes:n.rows.map(x=>x.node_key)};
    });
  }
  async listApprovals(principal,tenantId,{status='pending'}={}){
    await requireMembership(this.db,principal,tenantId,'viewer');
    const r=await this.db.query(`SELECT a.*,r.project_id,r.title run_title FROM approvals a JOIN runs r ON r.id=a.run_id WHERE a.tenant_id=$1 AND ($2::text IS NULL OR a.status=$2) ORDER BY a.created_at DESC LIMIT 200`,[tenantId,status||null]);
    return {items:r.rows.map(a=>({...serializeApproval(a),runId:a.run_id,projectId:a.project_id,runTitle:a.run_title}))};
  }
  /** Approvers must be tenant admins/owners. The decision applies only to the exact request hash shown. */
  async decide(principal,tenantId,approvalId,{decision,note}){
    requireUUID(approvalId,'approval');check(['approve','deny'].includes(decision),'invalid_decision');
    await requireMembership(this.db,principal,tenantId,'admin');
    if(note!==undefined)check(typeof note==='string'&&note.length<=2000,'invalid_note');
    return tx(this.db,async db=>{
      const a=(await db.query('SELECT * FROM approvals WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[tenantId,approvalId])).rows[0];check(a,'approval_not_found',404);
      check(a.status==='pending','approval_not_pending',409);
      if(new Date(a.expires_at)<new Date()){await db.query("UPDATE approvals SET status='expired' WHERE id=$1",[a.id]);fail('approval_expired',409);}
      const status=decision==='approve'?'approved':'denied';
      await db.query('UPDATE approvals SET status=$2,decided_by=$3,decided_at=now(),decision_note=$4 WHERE id=$1',[a.id,status,principal.identityId,note||null]);
      const run=(await db.query('SELECT * FROM runs WHERE id=$1 FOR UPDATE',[a.run_id])).rows[0];
      const node=(await db.query('SELECT * FROM run_nodes WHERE run_id=$1 AND node_key=$2 FOR UPDATE',[a.run_id,a.node_key])).rows[0];
      await this.event(db,run,'approval.'+status,{approvalId:a.id,by:principal.identityId,note:note||null},a.node_key);
      if(node?.state==='awaiting_approval'){
        if(node.type==='approval'){
          await db.query(`UPDATE run_nodes SET state=$2,output=$3,error=$4,finished_at=now(),updated_at=now() WHERE id=$1`,[node.id,status==='approved'?'succeeded':'failed',JSON.stringify({approved:status==='approved',note:note||null,decidedBy:principal.identityId}),status==='approved'?null:'approval_denied']);
          if(status==='approved')await db.query("UPDATE approvals SET status='consumed' WHERE id=$1",[a.id]);
          await this.event(db,run,status==='approved'?'node.succeeded':'node.failed',{approval:status},a.node_key);
        }else if(status==='approved'){
          await db.query("UPDATE run_nodes SET state='ready',next_attempt_at=now(),updated_at=now() WHERE id=$1",[node.id]);
          await this.event(db,run,'node.ready',{resumed:true},a.node_key);
        }else{
          // Denial is fed back to the agent as a tool error so it can continue without the action.
          await db.query("UPDATE run_nodes SET state='ready',next_attempt_at=now(),updated_at=now() WHERE id=$1",[node.id]);
          await this.event(db,run,'node.ready',{resumed:true,denied:true},a.node_key);
        }
        await this.promote(db,run);
      }
      return {id:a.id,status};
    });
  }
  /** Consume an approved request for (run,node,request). Returns 'approved' | 'denied' | null. */
  async approvalState(runId,nodeKey,request){
    const r=await this.db.query('SELECT id,status FROM approvals WHERE run_id=$1 AND node_key=$2 AND request_sha256=$3',[runId,nodeKey,sha256(canonical(request))]);
    return r.rows[0]||null;
  }
  async consumeApproval(id){const r=await this.db.query("UPDATE approvals SET status='consumed' WHERE id=$1 AND status='approved'",[id]);return r.rowCount===1;}
}
function serializeApproval(a){return {id:a.id,nodeKey:a.node_key,action:a.action,effect:a.effect,summary:a.summary,request:a.request,status:a.status,createdAt:a.created_at,decidedAt:a.decided_at,decidedBy:a.decided_by,note:a.decision_note}}
function summarize(o){const s=JSON.stringify(o);return s&&s.length>2000?{truncated:true,preview:s.slice(0,2000)}:o;}
export {randomUUID};
