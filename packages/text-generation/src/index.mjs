import {createHash} from 'node:crypto';
import {BudgetLedger} from '../../budget/src/index.mjs';
import {ProjectService} from '../../projects/src/index.mjs';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IDENT=/^[a-z][a-z0-9-]{1,63}$/;
export class TextGenerationError extends Error {
 constructor(code,message){super(message||code);this.name='TextGenerationError';this.code=code}
}
function check(ok,code,message){if(!ok)throw new TextGenerationError(code,message)}
function assertUUID(value,label){check(typeof value==='string'&&UUID.test(value),'invalid_scope','Invalid '+label)}
function integer(value,label,min=0,max=Number.MAX_SAFE_INTEGER){check(Number.isSafeInteger(value)&&value>=min&&value<=max,'invalid_pricing','Invalid '+label);return value}
function sha(value){return createHash('sha256').update(value).digest('hex')}
function tariff(pricing){
 check(pricing&&typeof pricing==='object','invalid_pricing','Verified pricing required');
 const x={
  inputMicroPerToken:integer(pricing.inputMicroPerToken,'input rate'),
  outputMicroPerToken:integer(pricing.outputMicroPerToken,'output rate'),
  fixedMicros:integer(pricing.fixedMicros,'fixed rate'),
  inputTokenCeiling:integer(pricing.inputTokenCeiling,'input ceiling',1,250000)
 };
 check(x.inputMicroPerToken+x.outputMicroPerToken+x.fixedMicros>0,'invalid_pricing','Zero or unknown pricing tariff');
 return x;
}
function microCost(rate,inputTokens,outputTokens){
 const micro=BigInt(rate.fixedMicros)+BigInt(inputTokens)*BigInt(rate.inputMicroPerToken)+BigInt(outputTokens)*BigInt(rate.outputMicroPerToken);
 check(micro<=BigInt(Number.MAX_SAFE_INTEGER),'invalid_pricing','Cost overflow');
 return micro;
}
function publicRecord(record){
 return {id:record.id,projectId:record.project_id,reservationId:record.reservation_id,
  providerId:record.provider_id,operation:record.operation,state:record.state,
  artifactId:record.artifact_id||null,providerResponseId:record.provider_response_id||null,
  modelRevision:record.provider_model_revision||null,
  inputTokens:record.usage_input_tokens===null?null:Number(record.usage_input_tokens),
  outputTokens:record.usage_output_tokens===null?null:Number(record.usage_output_tokens),
  settledMicrounits:record.settled_micro===null?null:String(record.settled_micro)};
}
async function transaction(pool,operation){
 const db=await pool.connect();
 try{await db.query('BEGIN');
  try{const result=await operation(db);await db.query('COMMIT');return result}
  catch(error){await db.query('ROLLBACK');throw error}
 }finally{db.release()}
}
export class TextGenerationService {
 constructor({pool,providers,pricing,dispatchEnabled=false,onAudit=()=>{},outputPolicy}={}){
  if(!pool||typeof pool.connect!=='function'||typeof pool.query!=='function')throw new TypeError('Trusted PostgreSQL pool required');
  if(!providers||typeof providers.stream!=='function')throw new TypeError('Authorized provider registry required');
  if(typeof dispatchEnabled!=='boolean')throw new TypeError('Explicit dispatch gate required');
  this.pool=pool;this.providers=providers;this.pricing=tariff(pricing);
  this.dispatchEnabled=dispatchEnabled;this.onAudit=onAudit;
  if(outputPolicy!==undefined&&(!Object.isFrozen(outputPolicy)||typeof outputPolicy.id!=='string'||
   typeof outputPolicy.assertContext!=='function'||typeof outputPolicy.validate!=='function'||!outputPolicy.format))throw new TypeError('Trusted immutable output policy required');
  this.outputPolicy=outputPolicy;
  this.projects=new ProjectService({pool});this.budgets=new BudgetLedger({pool});
 }
 async generate({context,projectId,reservationId,providerId,operation,prompt,region,commercial=false,maxOutputTokens=512,signal,onToken}={}){
  check(this.dispatchEnabled,'dispatch_disabled','Live provider generation must be explicitly authorized');
  const tenantId=context?.tenantId,identityId=context?.session?.identityId;
  assertUUID(tenantId,'tenant');assertUUID(identityId,'identity');assertUUID(projectId,'project');assertUUID(reservationId,'reservation');
  this.outputPolicy?.assertContext(context);
  check(typeof providerId==='string'&&IDENT.test(providerId),'invalid_provider');
  check(['text.generate','reason.generate'].includes(operation),'invalid_operation');
  check(typeof prompt==='string'&&!!prompt.trim()&&prompt.length<=64000,'invalid_prompt');
  check(typeof region==='string'&&region.length>=2&&region.length<=64,'invalid_region');
  check(typeof commercial==='boolean','invalid_usage');
  integer(maxOutputTokens,'max output tokens',16,4096);
  check(onToken===undefined||typeof onToken==='function','invalid_callback');
  check(!signal?.aborted,'cancelled');
  check(Buffer.byteLength(prompt,'utf8')<=this.pricing.inputTokenCeiling,'input_ceiling','Text exceeds conservative input token ceiling');
  const maximum=microCost(this.pricing,this.pricing.inputTokenCeiling,maxOutputTokens);
  check(maximum>0n,'invalid_pricing');
  const requestSha=sha(JSON.stringify({prompt,providerId,operation,region,commercial,maxOutputTokens,pricing:this.pricing,
   ...(this.outputPolicy?{outputPolicySha256:this.outputPolicy.id}:{})}));
  const record=await transaction(this.pool,async db=>{
   const member=await db.query("SELECT 1 FROM projects p JOIN memberships m ON m.tenant_id=p.tenant_id WHERE p.tenant_id=$1 AND p.id=$2 AND m.identity_id=$3 AND m.role IN ('owner','admin','member')",[tenantId,projectId,identityId]);
   check(member.rowCount===1,'project_forbidden','Writer membership required');
   const reserved=await db.query('SELECT * FROM budget_reservations WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[tenantId,reservationId]);
   check(reserved.rowCount===1,'reservation_missing','Funded reservation required');
   const previous=await db.query('SELECT * FROM text_generation_dispatches WHERE tenant_id=$1 AND reservation_id=$2',[tenantId,reservationId]);
   if(previous.rowCount){
    const old=previous.rows[0];
    check(old.request_sha256===requestSha&&old.project_id===projectId&&old.identity_id===identityId&&old.provider_id===providerId&&old.operation===operation,'idempotency_conflict','Reservation is bound to a different generation');
    return {row:old,newDispatch:false};
   }
   check(reserved.rows[0].status==='reserved','reservation_inactive');
   check(BigInt(reserved.rows[0].reserved_micro)>=maximum,'reservation_insufficient','Upper-cost ceiling exceeds reservation');
   const created=await db.query(
    "INSERT INTO text_generation_dispatches(tenant_id,project_id,identity_id,reservation_id,provider_id,operation,request_sha256,output_limit,quoted_ceiling_micro,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'dispatch_uncertain') RETURNING *",
    [tenantId,projectId,identityId,reservationId,providerId,operation,requestSha,maxOutputTokens,String(maximum)]);
   return {row:created.rows[0],newDispatch:true};
  });
  if(!record.newDispatch){
   if(record.row.state==='completed')return {...publicRecord(record.row),replayed:true};
   throw new TextGenerationError('dispatch_uncertain','Prior provider request outcome must be reconciled before retrying');
  }
  const dispatchId=record.row.id;
  let fullText='',usage=null,completion=null;
  try{
   const stream=this.providers.stream({providerId,operation,tenantId,reservationId,input:{prompt},region,commercial,signal,
    options:{maxOutputTokens,...(this.outputPolicy?{textFormat:this.outputPolicy.format}:{})}});
   for await(const event of stream){
    check(!signal?.aborted,'cancelled','Provider request cancelled');
    if(event?.type==='token'){
     check(typeof event.text==='string'&&fullText.length+event.text.length<=125000,'output_limit');
     fullText+=event.text;
     if(!this.outputPolicy)try{await onToken?.(event.text)}catch{} // Never stream unvalidated structured fragments to downstream consumers.
    }else if(event?.type==='usage'){
     check(usage===null,'duplicate_usage');
     integer(event.inputUnits,'actual input tokens',0,250000);
     integer(event.outputUnits,'actual output tokens',0,4096);
     usage={inputTokens:event.inputUnits,outputTokens:event.outputUnits};
    }else if(event?.type==='complete'){
     check(completion===null&&typeof event.responseId==='string'&&!!event.responseId.trim(),'invalid_completion');
     completion={responseId:event.responseId,modelRevision:String(event.modelRevision||'unknown')};
    }else throw new TextGenerationError('invalid_provider_event','Unexpected or failed provider stream event');
   }
   check(usage&&completion,'incomplete_provider_result','Usage and completed provider receipt required');
   check(usage.inputTokens<=this.pricing.inputTokenCeiling&&usage.outputTokens<=maxOutputTokens,'pricing_ceiling_exceeded');
   const actual=microCost(this.pricing,usage.inputTokens,usage.outputTokens);
   check(actual<=maximum,'reservation_insufficient');
   check(Buffer.byteLength(JSON.stringify(fullText),'utf8')<250000,'output_limit');
   let output={title:'Generated text',mediaType:'text/plain',body:fullText,provenance:{}};
   if(this.outputPolicy){
    try{output=this.outputPolicy.validate(fullText,context)}catch{throw new TextGenerationError('structured_output_rejected','Structured output did not pass validation')}
   }
   check(!signal?.aborted,'cancelled');
   check(Buffer.byteLength(JSON.stringify(output.body),'utf8')<250000,'output_limit');
   const artifact=await this.projects.createArtifact(context,projectId,{
    title:output.title,mediaType:output.mediaType,checksum:sha(JSON.stringify(output.body)),body:output.body,
    rights:{commercial},
    provenance:{...output.provenance,source:'authorized-provider',dispatchId,providerId,operation,
     responseId:completion.responseId,modelRevision:completion.modelRevision,
     inputTokens:usage.inputTokens,outputTokens:usage.outputTokens}
   });
   await this.budgets.settle({tenantId,reservationId,actualMicrounits:String(actual),providerTaskId:completion.responseId});
   await this.pool.query("UPDATE text_generation_dispatches SET state='completed',artifact_id=$2,provider_response_id=$3,provider_model_revision=$4,usage_input_tokens=$5,usage_output_tokens=$6,settled_micro=$7,completed_at=now(),updated_at=now() WHERE id=$1",
    [dispatchId,artifact.id,completion.responseId,completion.modelRevision,usage.inputTokens,usage.outputTokens,String(actual)]);
   try{this.onAudit({category:'text_generation_completed',dispatchId,tenantId,projectId})}catch{}
   return {id:dispatchId,state:'completed',projectId,reservationId,providerId,operation,artifactId:artifact.id,
    providerResponseId:completion.responseId,modelRevision:completion.modelRevision,...usage,settledMicrounits:String(actual),replayed:false};
  }catch(error){
   await this.pool.query("UPDATE text_generation_dispatches SET state='needs_reconciliation',failure_code=$2,updated_at=now() WHERE id=$1 AND state='dispatch_uncertain'",
     [dispatchId,error.code||'generation_error']).catch(()=>{});
   try{this.onAudit({category:'text_generation_needs_reconciliation',dispatchId,tenantId,projectId})}catch{}
   if(error instanceof TextGenerationError)throw error;
   throw new TextGenerationError('needs_reconciliation','Provider outcome or persistence is uncertain; reservation remains held');
  }
 }
 async inspect({context,dispatchId}={}){
  const tenantId=context?.tenantId,identityId=context?.session?.identityId;
  assertUUID(tenantId,'tenant');assertUUID(identityId,'identity');assertUUID(dispatchId,'dispatch');
  const r=await this.pool.query('SELECT d.* FROM text_generation_dispatches d JOIN memberships m ON m.tenant_id=d.tenant_id AND m.identity_id=$2 WHERE d.tenant_id=$1 AND d.id=$3',[tenantId,identityId,dispatchId]);
  check(r.rowCount===1,'not_found');return publicRecord(r.rows[0]);
 }
}

