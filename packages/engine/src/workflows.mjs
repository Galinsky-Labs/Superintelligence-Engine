// Saved workflow definitions: versioned, re-runnable with new inputs, schedulable.
import {check,isObject,requireUUID,requireMembership,tx} from './infra.mjs';
import {validateSpec} from './runs.mjs';

const ser=w=>({id:w.id,projectId:w.project_id,title:w.title,description:w.description,spec:w.spec,version:w.version,createdBy:w.created_by,createdAt:w.created_at,updatedAt:w.updated_at});
const TITLE=t=>{check(typeof t==='string'&&t.trim().length>=1&&t.length<=160,'invalid_title');return t.trim();};

export class WorkflowLibrary {
  constructor({system,runs}){this.db=system;this.runs=runs;}
  async list(principal,tenantId,projectId){
    requireUUID(projectId,'project');await requireMembership(this.db,principal,tenantId,'viewer');
    return {items:(await this.db.query('SELECT * FROM workflows WHERE tenant_id=$1 AND project_id=$2 ORDER BY updated_at DESC LIMIT 500',[tenantId,projectId])).rows.map(ser)};
  }
  async get(principal,tenantId,id){
    requireUUID(id,'workflow');await requireMembership(this.db,principal,tenantId,'viewer');
    const w=(await this.db.query('SELECT * FROM workflows WHERE tenant_id=$1 AND id=$2',[tenantId,id])).rows[0];check(w,'workflow_not_found',404);return ser(w);
  }
  async create(principal,tenantId,projectId,{title,description='',spec}){
    requireUUID(projectId,'project');await requireMembership(this.db,principal,tenantId,'member');
    validateSpec(spec);check(typeof description==='string'&&description.length<=4000,'invalid_description');
    return tx(this.db,async db=>{
      check((await db.query('SELECT 1 FROM projects WHERE tenant_id=$1 AND id=$2',[tenantId,projectId])).rowCount,'project_not_found',404);
      const w=(await db.query('INSERT INTO workflows(tenant_id,project_id,title,description,spec,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',[tenantId,projectId,TITLE(title),description,JSON.stringify(spec),principal.identityId])).rows[0];
      await db.query('INSERT INTO workflow_versions(workflow_id,tenant_id,version,spec,title,created_by) VALUES($1,$2,1,$3,$4,$5)',[w.id,tenantId,JSON.stringify(spec),w.title,principal.identityId]);
      return ser(w);
    });
  }
  async update(principal,tenantId,id,{title,description,spec,expectedVersion}){
    requireUUID(id,'workflow');await requireMembership(this.db,principal,tenantId,'member');
    if(spec!==undefined)validateSpec(spec);
    return tx(this.db,async db=>{
      const w=(await db.query('SELECT * FROM workflows WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[tenantId,id])).rows[0];check(w,'workflow_not_found',404);
      if(expectedVersion!==undefined)check(w.version===expectedVersion,'revision_conflict',409,'Workflow changed since you loaded it');
      const next={title:title!==undefined?TITLE(title):w.title,description:description??w.description,spec:spec??w.spec};
      const r=(await db.query('UPDATE workflows SET title=$3,description=$4,spec=$5,version=version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *',[tenantId,id,next.title,next.description,JSON.stringify(next.spec)])).rows[0];
      await db.query('INSERT INTO workflow_versions(workflow_id,tenant_id,version,spec,title,created_by) VALUES($1,$2,$3,$4,$5,$6)',[id,tenantId,r.version,JSON.stringify(next.spec),next.title,principal.identityId]);
      return ser(r);
    });
  }
  async versions(principal,tenantId,id){
    await this.get(principal,tenantId,id);
    const r=await this.db.query('SELECT version,title,spec,created_by,created_at FROM workflow_versions WHERE tenant_id=$1 AND workflow_id=$2 ORDER BY version DESC',[tenantId,id]);
    return {items:r.rows.map(v=>({version:v.version,title:v.title,spec:v.spec,createdBy:v.created_by,createdAt:v.created_at}))};
  }
  async remove(principal,tenantId,id){
    requireUUID(id,'workflow');await requireMembership(this.db,principal,tenantId,'member');
    const r=await this.db.query('DELETE FROM workflows WHERE tenant_id=$1 AND id=$2',[tenantId,id]);check(r.rowCount,'workflow_not_found',404);return {deleted:true};
  }
  /** Start a run of the current (or a given) version with merged inputs. */
  async run(principal,tenantId,id,{inputs={},version,budgetCeilingMicro,idempotencyKey}={}){
    check(isObject(inputs),'invalid_inputs');
    const w=await this.get(principal,tenantId,id);
    let spec=w.spec,ver=w.version;
    if(version!==undefined){const v=(await this.versions(principal,tenantId,id)).items.find(x=>x.version===version);check(v,'version_not_found',404);spec=v.spec;ver=v.version;}
    const merged={...spec,inputs:{...(spec.inputs||{}),...inputs},...(budgetCeilingMicro!==undefined?{budgetCeilingMicro}:{})};
    const run=await this.runs.createRun(principal,tenantId,w.projectId,{kind:'workflow',spec:merged,title:w.title,idempotencyKey});
    await this.db.query('UPDATE runs SET workflow_id=$2,workflow_version=$3 WHERE id=$1 AND workflow_id IS NULL',[run.id,id,ver]);
    return {...run,workflowId:id,workflowVersion:ver};
  }
}
