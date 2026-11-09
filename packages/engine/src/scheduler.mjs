// Persistent scheduled and conditional workflows.
import {EngineError,check,fail,isObject,requireUUID,requireMembership,log} from './infra.mjs';
import {validateSpec,evaluateCondition} from './runs.mjs';

const RANGES=[[0,59],[0,23],[1,31],[1,12],[0,6]];
function field(spec,[lo,hi]){
  const out=new Set();
  for(const part of spec.split(',')){
    const m=/^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);if(!m)throw new EngineError('invalid_cron',400,'Invalid cron field '+spec);
    let [a,b]=m[1]==='*'?[lo,hi]:m[1].split('-').map(Number);if(b===undefined)b=m[2]?hi:a;
    const step=Number(m[2]||1);check(a>=lo&&b<=hi&&a<=b&&step>=1,'invalid_cron',400,'Cron value out of range: '+spec);
    for(let v=a;v<=b;v+=step)out.add(v);
  }
  return out;
}
export function parseCron(expr){
  const f=String(expr).trim().split(/\s+/);check(f.length===5,'invalid_cron',400,'Cron needs 5 fields: minute hour day-of-month month day-of-week');
  const [min,hour,dom,mon,dow]=f.map((x,i)=>field(i===4?x.replace(/\b7\b/g,'0'):x,RANGES[i]));
  return {min,hour,dom,mon,dow,domStar:f[2]==='*',dowStar:f[4]==='*'};
}
function partsIn(date,tz){
  const p=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:tz,hourCycle:'h23',minute:'numeric',hour:'numeric',day:'numeric',month:'numeric',weekday:'short'}).formatToParts(date).map(x=>[x.type,x.value]));
  return {min:Number(p.minute),hour:Number(p.hour),dom:Number(p.day),mon:Number(p.month),dow:['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(p.weekday)};
}
export function nextRun(expr,tz='UTC',after=new Date()){
  const c=parseCron(expr);
  try{new Intl.DateTimeFormat('en-US',{timeZone:tz})}catch{fail('invalid_timezone')}
  let t=new Date(Math.floor(after.getTime()/60000)*60000+60000);
  for(let i=0;i<60*24*400;i++){
    const p=partsIn(t,tz);
    const dayOk=c.domStar||c.dowStar?(c.dom.has(p.dom)&&c.dow.has(p.dow)):(c.dom.has(p.dom)||c.dow.has(p.dow));
    if(c.mon.has(p.mon)&&dayOk&&c.hour.has(p.hour)&&c.min.has(p.min))return t;
    // skip quickly when hour/day do not match
    t=new Date(t.getTime()+(c.hour.has(p.hour)&&dayOk&&c.mon.has(p.mon)?60000:(60-p.min)*60000));
  }
  fail('invalid_cron',400,'Cron expression never fires');
}

export class Scheduler {
  constructor({system,runs,projects}){this.db=system;this.runs=runs;this.projects=projects;}
  serialize(s){return {id:s.id,projectId:s.project_id,title:s.title,cron:s.cron,timezone:s.timezone,spec:s.spec,condition:s.condition,enabled:s.enabled,nextRunAt:s.next_run_at,lastRunAt:s.last_run_at,lastRunId:s.last_run_id,createdAt:s.created_at}}
  async create(principal,tenantId,projectId,{title,cron,timezone='UTC',spec,condition=null}){
    requireUUID(projectId,'project');await requireMembership(this.db,principal,tenantId,'member');
    check(typeof title==='string'&&title.trim()&&title.length<=160,'invalid_title');
    validateSpec(spec);if(condition!==null)check(isObject(condition),'invalid_condition');
    const next=nextRun(cron,timezone);
    check((await this.db.query('SELECT 1 FROM projects WHERE tenant_id=$1 AND id=$2',[tenantId,projectId])).rowCount,'project_not_found',404);
    const r=await this.db.query('INSERT INTO schedules(tenant_id,project_id,created_by,title,cron,timezone,spec,condition,next_run_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
      [tenantId,projectId,principal.identityId,title.trim(),cron,timezone,JSON.stringify(spec),condition?JSON.stringify(condition):null,next]);
    return this.serialize(r.rows[0]);
  }
  async list(principal,tenantId,{projectId}={}){
    await requireMembership(this.db,principal,tenantId,'viewer');
    return {items:(await this.db.query('SELECT * FROM schedules WHERE tenant_id=$1 AND ($2::uuid IS NULL OR project_id=$2) ORDER BY created_at DESC',[tenantId,projectId||null])).rows.map(s=>this.serialize(s))};
  }
  async update(principal,tenantId,id,{enabled,cron,timezone}){
    requireUUID(id,'schedule');await requireMembership(this.db,principal,tenantId,'member');
    const s=(await this.db.query('SELECT * FROM schedules WHERE tenant_id=$1 AND id=$2',[tenantId,id])).rows[0];check(s,'schedule_not_found',404);
    const c=cron??s.cron,tz=timezone??s.timezone;
    const r=await this.db.query('UPDATE schedules SET enabled=$3,cron=$4,timezone=$5,next_run_at=$6 WHERE tenant_id=$1 AND id=$2 RETURNING *',[tenantId,id,enabled??s.enabled,c,tz,nextRun(c,tz)]);
    return this.serialize(r.rows[0]);
  }
  async remove(principal,tenantId,id){
    requireUUID(id,'schedule');await requireMembership(this.db,principal,tenantId,'member');
    const r=await this.db.query('DELETE FROM schedules WHERE tenant_id=$1 AND id=$2',[tenantId,id]);check(r.rowCount,'schedule_not_found',404);return {deleted:true};
  }
  /** Conditions: {artifactChanged: artifactId} | {artifact: artifactId, when: <condition on body>} */
  async conditionMet(s){
    const c=s.condition;if(!c)return {ok:true};
    if(c.artifactChanged||c.artifact){
      const id=c.artifactChanged||c.artifact;
      const a=await this.projects.systemReadArtifact({tenantId:s.tenant_id,projectId:s.project_id,artifactId:id}).catch(()=>null);
      if(!a)return {ok:false,reason:'artifact_missing'};
      if(c.artifactChanged){
        const prevRev=s.spec?.inputs?.__lastRevision;
        return {ok:prevRev!==a.revision,revision:a.revision,reason:prevRev===a.revision?'artifact_unchanged':undefined};
      }
      return {ok:evaluateCondition(c.when,{artifact:{body:a.body,revision:a.revision}}),revision:a.revision,reason:'condition_false'};
    }
    return {ok:true};
  }
  /** Fire due schedules. Safe with multiple workers: rows are claimed with SKIP LOCKED. */
  async tick(){
    // Claim due rows atomically (short lease) so concurrent workers never fire the same occurrence twice.
    const due=await this.db.query(`WITH d AS (SELECT id,next_run_at FROM schedules WHERE enabled AND next_run_at<=now() ORDER BY next_run_at LIMIT 20 FOR UPDATE SKIP LOCKED)
      UPDATE schedules s SET next_run_at=now()+interval '5 minutes' FROM d WHERE s.id=d.id RETURNING s.*,d.next_run_at AS due_at`);
    let fired=0;
    for(const s of due.rows){
      const next=nextRun(s.cron,s.timezone);
      try{
        const cond=await this.conditionMet(s);
        if(cond.ok){
          const spec={...s.spec,inputs:{...(s.spec.inputs||{}),scheduledAt:new Date().toISOString()}};
          const run=await this.runs.createRun({identityId:s.created_by},s.tenant_id,s.project_id,{kind:'schedule',spec,title:s.title,scheduleId:s.id,idempotencyKey:`sched:${s.id}:${new Date(s.due_at).getTime()}`});
          const newSpec=cond.revision!==undefined?{...s.spec,inputs:{...(s.spec.inputs||{}),__lastRevision:cond.revision}}:s.spec;
          await this.db.query('UPDATE schedules SET next_run_at=$2,last_run_at=now(),last_run_id=$3,spec=$4 WHERE id=$1',[s.id,next,run.id,JSON.stringify(newSpec)]);fired++;
        }else await this.db.query('UPDATE schedules SET next_run_at=$2 WHERE id=$1',[s.id,next]);
      }catch(e){
        log.error('schedule_fire_failed',{scheduleId:s.id,message:e.message});
        await this.db.query('UPDATE schedules SET next_run_at=$2 WHERE id=$1',[s.id,next]);
      }
    }
    return fired;
  }
}
