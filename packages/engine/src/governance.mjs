// SIE-036 / SCC-015: workspace governance — policies enforced by the engine (run budget cap, provider
// allow-list, seat limit) and an append-only administrative audit log.
import {check,requireMembership,requireUUID} from './infra.mjs';
import {PROVIDERS} from './providers.mjs';

const serialize=p=>({maxRunBudgetMicro:p?.max_run_budget_micro==null?null:Number(p.max_run_budget_micro),allowedProviders:p?.allowed_providers??null,seatLimit:p?.seat_limit??null,
 updatedBy:p?.updated_by||null,updatedAt:p?.updated_at||null});
export class Governance{
 constructor({system}){this.db=system;this.cache=new Map();}
 async policy(tenantId){
  const hit=this.cache.get(tenantId);if(hit&&hit.at>Date.now()-5000)return hit.p;
  const p=serialize((await this.db.query('SELECT * FROM tenant_policies WHERE tenant_id=$1',[tenantId])).rows[0]);
  this.cache.set(tenantId,{at:Date.now(),p});return p;
 }
 async getPolicy(principal,tenantId){await requireMembership(this.db,principal,tenantId,'viewer');return this.policy(tenantId);}
 async setPolicy(principal,tenantId,{maxRunBudgetMicro=null,allowedProviders=null,seatLimit=null}={}){
  await requireMembership(this.db,principal,tenantId,'owner');
  check(maxRunBudgetMicro===null||(Number.isSafeInteger(maxRunBudgetMicro)&&maxRunBudgetMicro>=1),'invalid_policy',400,'maxRunBudgetMicro must be a positive integer (micro-dollars) or null');
  check(allowedProviders===null||(Array.isArray(allowedProviders)&&allowedProviders.length<=20&&allowedProviders.every(p=>Object.hasOwn(PROVIDERS,p))),'invalid_policy',400,'allowedProviders must list known providers or be null');
  check(seatLimit===null||(Number.isInteger(seatLimit)&&seatLimit>=1&&seatLimit<=100000),'invalid_policy',400,'seatLimit must be a positive integer or null');
  if(seatLimit!==null){const n=(await this.db.query('SELECT count(*)::int n FROM memberships WHERE tenant_id=$1',[tenantId])).rows[0].n;check(n<=seatLimit,'seat_limit_below_members',409,`The workspace already has ${n} members`);}
  await this.db.query(`INSERT INTO tenant_policies(tenant_id,max_run_budget_micro,allowed_providers,seat_limit,updated_by,updated_at) VALUES($1,$2,$3,$4,$5,now())
   ON CONFLICT(tenant_id) DO UPDATE SET max_run_budget_micro=EXCLUDED.max_run_budget_micro,allowed_providers=EXCLUDED.allowed_providers,seat_limit=EXCLUDED.seat_limit,updated_by=EXCLUDED.updated_by,updated_at=now()`,
   [tenantId,maxRunBudgetMicro,allowedProviders,seatLimit,principal.identityId]);
  this.cache.delete(tenantId);
  const p=await this.policy(tenantId);await this.record(tenantId,principal.identityId,'policy.update','tenant',p);return p;
 }
 /** Clamp a run's budget ceiling to the workspace cap (0 = no ceiling requested). */
 async clampBudget(tenantId,ceiling){const {maxRunBudgetMicro:max}=await this.policy(tenantId);if(max==null)return ceiling;return ceiling>0?Math.min(ceiling,max):max;}
 async assertProvider(tenantId,provider){
  if(provider==='deterministic')return;
  const {allowedProviders}=await this.policy(tenantId);
  check(!allowedProviders||allowedProviders.includes(provider),'provider_not_allowed',403,`Workspace policy does not allow provider ${provider}`);
 }
 async assertSeat(tenantId,identityId){
  const {seatLimit}=await this.policy(tenantId);if(seatLimit==null)return;
  const r=(await this.db.query('SELECT count(*)::int n,bool_or(identity_id=$2) present FROM memberships WHERE tenant_id=$1',[tenantId,identityId])).rows[0];
  check(r.present||r.n<seatLimit,'seat_limit_reached',409,`All ${seatLimit} seats are in use`);
 }
 async record(tenantId,actorId,action,target,detail={}){
  await this.db.query('INSERT INTO tenant_audit(tenant_id,actor_id,action,target,detail) VALUES($1,$2,$3,$4,$5)',[tenantId,actorId||null,action.slice(0,80),target==null?null:String(target).slice(0,200),detail]);
 }
 /** Admin view: administrative actions plus tool-permission decisions, newest first. */
 async audit(principal,tenantId,{limit=100,before}={}){
  await requireMembership(this.db,principal,tenantId,'admin');
  const n=Math.min(Math.max(Number(limit)||100,1),500);const cursor=before?Date.parse(before):null;check(before===undefined||Number.isFinite(cursor),'invalid_cursor');
  const r=await this.db.query(`SELECT * FROM (
    SELECT 'admin' AS source,a.recorded_at,a.actor_id,i.display_name AS actor_name,a.action,a.target,a.detail FROM tenant_audit a LEFT JOIN identities i ON i.id=a.actor_id WHERE a.tenant_id=$1
    UNION ALL
    SELECT 'tool',t.recorded_at,t.identity_id,i.display_name,'tool.'||t.decision,t.tool,jsonb_build_object('effect',t.effect,'runId',t.run_id,'node',t.node_key) FROM tool_audit t LEFT JOIN identities i ON i.id=t.identity_id WHERE t.tenant_id=$1
   ) x WHERE ($2::timestamptz IS NULL OR recorded_at<$2) ORDER BY recorded_at DESC LIMIT $3`,[tenantId,cursor?new Date(cursor).toISOString():null,n]);
  return {items:r.rows.map(x=>({source:x.source,at:x.recorded_at,actorId:x.actor_id,actorName:x.actor_name,action:x.action,target:x.target,detail:x.detail})),
   next:r.rows.length===n?new Date(r.rows.at(-1).recorded_at).toISOString():null};
 }
}
