// Model catalog, provider credential resolution, pricing and usage metering.
import {BudgetLedger,BudgetError} from '../../budget/src/index.mjs';
import {EngineError,check,fail,sha256,requireMembership,log,metrics} from './infra.mjs';
import {BUILTIN_MODELS} from './models.mjs';
import {PROVIDERS} from './providers.mjs';

export function textCost(price,inputTokens,outputTokens){return Math.ceil((inputTokens*price.input+outputTokens*price.output)/1e6);}
export function unitCost(price,units){return Math.ceil(units*price.unit);}

export class ModelCatalog {
  constructor({system,secretBox=null,env=process.env,enableTestProvider=env.SIE_ENABLE_TEST_PROVIDER==='1',adapterOverrides={}}){
    this.db=system;this.box=secretBox;this.env=env;this.testProvider=enableTestProvider;this.overrides=adapterOverrides;this.adapters=new Map();this.priceCache=null;
  }
  providerIds(){return Object.keys(PROVIDERS).filter(p=>p!=='deterministic'||this.testProvider);}

  async credentialFor(tenantId,provider){
    if(provider==='deterministic')return this.testProvider?{apiKey:'',source:'builtin'}:null;
    const def=PROVIDERS[provider];if(!def)return null;
    if(tenantId&&this.box){
      const r=await this.db.query('SELECT ciphertext,base_url FROM provider_credentials WHERE tenant_id=$1 AND provider=$2',[tenantId,provider]);
      if(r.rows[0])return {apiKey:this.box.open(r.rows[0].ciphertext),baseUrl:r.rows[0].base_url||undefined,source:'tenant'};
    }
    const apiKey=def.env&&this.env[def.env];const baseUrl=def.baseEnv?this.env[def.baseEnv]:this.env[`SIE_${provider.toUpperCase().replace(/-/g,'_')}_BASE_URL`];
    if(apiKey&&(!def.requiresBaseUrl||baseUrl))return {apiKey,baseUrl,source:'environment'};
    return null;
  }
  async adapter(tenantId,provider){
    if(this.overrides[provider])return this.overrides[provider];
    const cred=await this.credentialFor(tenantId,provider);
    if(!cred)fail('provider_unconfigured',409,`No credential configured for provider ${provider}`);
    const key=provider+':'+sha256(String(cred.apiKey)+'|'+(cred.baseUrl||'')).slice(0,16);
    if(!this.adapters.has(key))this.adapters.set(key,PROVIDERS[provider].make(cred));
    return this.adapters.get(key);
  }
  async prices(){
    if(this.priceCache&&this.priceCache.at>Date.now()-5000)return this.priceCache.map;
    const r=await this.db.query('SELECT provider,model,input_micro_per_mtok,output_micro_per_mtok,unit_micro FROM model_prices');
    const map=new Map(r.rows.map(x=>[x.provider+'/'+x.model,{input:Number(x.input_micro_per_mtok),output:Number(x.output_micro_per_mtok),unit:Number(x.unit_micro)}]));
    this.priceCache={at:Date.now(),map};return map;
  }
  async models(tenantId){
    const prices=await this.prices();const out=[];const seen=new Set();
    const configured=new Map();
    for(const p of this.providerIds())configured.set(p,Boolean(this.overrides[p])||Boolean(await this.credentialFor(tenantId,p)));
    for(const m of BUILTIN_MODELS){
      if(!this.providerIds().includes(m.provider))continue;
      const o=prices.get(m.provider+'/'+m.model);
      const price=o?(m.capabilities.includes('chat')?{input:o.input,output:o.output}:{unit:o.unit,per:m.price?.per||'unit'}):m.price;
      seen.add(m.provider+'/'+m.model);
      out.push({...m,price,priceKnown:Boolean(price),available:configured.get(m.provider)&&Boolean(price),configured:configured.get(m.provider)});
    }
    for(const [k,o] of prices){ // operator-added models (e.g. OpenAI-compatible endpoints)
      if(seen.has(k))continue;const [provider,...rest]=k.split('/');const model=rest.join('/');
      if(!this.providerIds().includes(provider))continue;
      const caps=o.unit&&!o.input&&!o.output?['image']:['chat','tools','structured'];
      out.push({provider,model,label:model,capabilities:caps,price:caps.includes('chat')?{input:o.input,output:o.output}:{unit:o.unit,per:'unit'},priceKnown:true,available:configured.get(provider),configured:configured.get(provider),custom:true});
    }
    return out;
  }
  /** Pick a usable model. Explicit choice must be priced and configured; otherwise choose the best available. */
  async resolve(tenantId,{provider,model,capability='chat'}={}){
    const all=await this.models(tenantId);
    if(provider||model){
      const m=all.find(x=>(!provider||x.provider===provider)&&x.model===model);
      check(m,'model_not_found',404,`Unknown model ${provider||''}/${model||''}`);
      check(m.capabilities.includes(capability),'capability_unsupported',400,`${m.model} does not support ${capability}`);
      check(m.configured,'provider_unconfigured',409,`Provider ${m.provider} has no credential configured`);
      check(m.priceKnown,'price_unknown',409,`No price configured for ${m.provider}/${m.model}; an operator must set one before use`);
      return m;
    }
    const candidates=all.filter(x=>x.available&&x.capabilities.includes(capability));
    const pick=candidates.find(x=>x.default&&!x.simulated)||candidates.find(x=>!x.simulated)||candidates[0];
    check(pick,'no_model_available',409,`No configured model supports ${capability}. Configure a provider credential.`);
    return pick;
  }
  async setCredential(principal,tenantId,{provider,apiKey,baseUrl}){
    await requireMembership(this.db,principal,tenantId,'admin');
    check(this.box,'encryption_unconfigured',503,'SIE_ENCRYPTION_KEY is required to store credentials');
    check(PROVIDERS[provider]&&provider!=='deterministic','invalid_provider');
    check(typeof apiKey==='string'&&apiKey.length>=8&&apiKey.length<=4096&&!/\s/.test(apiKey),'invalid_credential');
    if(baseUrl!==undefined&&baseUrl!==null&&baseUrl!==''){
      let u;try{u=new URL(baseUrl)}catch{fail('invalid_base_url')}
      check(u.protocol==='https:'||(this.env.SIE_ALLOW_HTTP_PROVIDER_URLS==='1'&&u.protocol==='http:'),'invalid_base_url',400,'Provider base URL must be HTTPS');
      check(!u.username&&!u.password,'invalid_base_url');
    }else check(!PROVIDERS[provider].requiresBaseUrl,'base_url_required');
    await this.db.query(`INSERT INTO provider_credentials(tenant_id,provider,ciphertext,base_url,fingerprint,created_by) VALUES($1,$2,$3,$4,$5,$6)
      ON CONFLICT(tenant_id,provider) DO UPDATE SET ciphertext=EXCLUDED.ciphertext,base_url=EXCLUDED.base_url,fingerprint=EXCLUDED.fingerprint,created_by=EXCLUDED.created_by,updated_at=now()`,
      [tenantId,provider,this.box.seal(apiKey),baseUrl||null,'…'+apiKey.slice(-4),principal.identityId]);
    return {provider,fingerprint:'…'+apiKey.slice(-4),source:'tenant'};
  }
  async deleteCredential(principal,tenantId,provider){
    await requireMembership(this.db,principal,tenantId,'admin');
    await this.db.query('DELETE FROM provider_credentials WHERE tenant_id=$1 AND provider=$2',[tenantId,provider]);return {deleted:true};
  }
  async providers(principal,tenantId){
    await requireMembership(this.db,principal,tenantId,'viewer');
    const r=await this.db.query('SELECT provider,fingerprint,base_url,updated_at FROM provider_credentials WHERE tenant_id=$1',[tenantId]);
    const stored=new Map(r.rows.map(x=>[x.provider,x]));
    return {items:this.providerIds().map(p=>{
      const s=stored.get(p),def=PROVIDERS[p];
      const env=p==='deterministic'||(def.env&&this.env[def.env]&&(!def.requiresBaseUrl||this.env[def.baseEnv]));
      return {id:p,label:def.label,configured:Boolean(s||env||this.overrides[p]),source:s?'tenant':env?(p==='deterministic'?'builtin':'environment'):null,fingerprint:s?.fingerprint||null,baseUrl:s?.base_url||null,simulated:p==='deterministic'};
    })};
  }
  async discover(principal,tenantId,provider){
    await requireMembership(this.db,principal,tenantId,'member');
    const a=await this.adapter(tenantId,provider);
    check(typeof a.listModels==='function','discovery_unsupported');
    try{return {provider,models:(await a.listModels()).slice(0,500)}}
    catch(e){throw e instanceof EngineError?e:new EngineError('discovery_failed',502,String(e.message).slice(0,200))}
  }
}

/** Reserve → dispatch → settle. Global, tenant and run ceilings are enforced before every paid call. */
export class Meter {
  constructor({system}){this.db=system;this.ledger=new BudgetLedger({pool:system});}
  async reserve({tenantId,runId=null,key,micro}){
    if(micro<=0)return null;
    if(runId){
      const r=await this.db.query(`SELECT r.budget_ceiling_micro,r.spent_micro,coalesce((SELECT sum(b.reserved_micro) FROM budget_reservations b WHERE b.tenant_id=r.tenant_id AND b.status='reserved' AND b.idempotency_key LIKE $2),0)::bigint AS inflight FROM runs r WHERE r.id=$1`,[runId,'run:'+runId+':%']);
      const row=r.rows[0];
      if(row&&Number(row.budget_ceiling_micro)>0&&Number(row.spent_micro)+Number(row.inflight)+micro>Number(row.budget_ceiling_micro))
        fail('run_budget_exceeded',402,'The run budget ceiling would be exceeded');
    }
    try{return await this.ledger.reserve({tenantId,idempotencyKey:(runId?'run:'+runId+':':'')+key,maximumMicrounits:String(micro)})}
    catch(e){
      if(e instanceof BudgetError)fail(e.code,402,e.code==='global_limit_exceeded'?'The operator-wide spending cap (currently enforced) would be exceeded':'The tenant budget would be exceeded');
      if(String(e.message).includes('not provisioned'))fail('tenant_limit_exceeded',402,'Tenant budget account is not provisioned');
      throw e;
    }
  }
  async settle(reservation,actualMicro,meta){
    let charged=actualMicro,estimatedOverage=false;
    if(reservation){
      const reserved=Number(reservation.reservedMicrounits);
      await this.ledger.settle({tenantId:reservation.tenantId,reservationId:reservation.id,actualMicrounits:String(Math.min(actualMicro,reserved)),providerTaskId:meta.providerResponseId||undefined});
      if(actualMicro>reserved){
        try{const extra=await this.ledger.reserve({tenantId:reservation.tenantId,idempotencyKey:'overage:'+reservation.id,maximumMicrounits:String(actualMicro-reserved)});
          await this.ledger.settle({tenantId:reservation.tenantId,reservationId:extra.id,actualMicrounits:String(actualMicro-reserved)});}
        catch(e){estimatedOverage=true;log.error('budget_overage_unrecorded',{reservationId:reservation.id,actualMicro,reserved,message:e.message});}
      }
    }
    await this.record({...meta,costMicro:charged,reservationId:reservation?.id||null,estimated:meta.estimated||estimatedOverage});
    return charged;
  }
  async release(reservation){if(reservation)await this.ledger.release({tenantId:reservation.tenantId,reservationId:reservation.id}).catch(e=>log.warn('release_failed',{message:e.message}));}
  async record(u){
    await this.db.query(`INSERT INTO usage_records(tenant_id,project_id,run_id,node_key,identity_id,provider,model,operation,input_tokens,output_tokens,units,cost_micro,estimated,simulated,provider_response_id,reservation_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [u.tenantId,u.projectId||null,u.runId||null,u.nodeKey||null,u.identityId||null,u.provider,u.model,u.operation,u.inputTokens||0,u.outputTokens||0,u.units||0,u.costMicro||0,Boolean(u.estimated),Boolean(u.simulated),u.providerResponseId||null,u.reservationId||null]);
    if(u.runId&&u.costMicro)await this.db.query('UPDATE runs SET spent_micro=spent_micro+$2,updated_at=now() WHERE id=$1',[u.runId,u.costMicro]);
    metrics.inc('sie_provider_calls_total',{provider:u.provider,operation:u.operation});
    metrics.inc('sie_provider_cost_micro_total',{provider:u.provider},u.costMicro||0);
    metrics.inc('sie_provider_tokens_total',{provider:u.provider,direction:'input'},u.inputTokens||0);
    metrics.inc('sie_provider_tokens_total',{provider:u.provider,direction:'output'},u.outputTokens||0);
  }
  async summary(principal,tenantId,{days=30}={}){
    await requireMembership(this.db,principal,tenantId,'viewer');
    const acct=await this.db.query('SELECT funded_micro,hard_limit_micro,spent_micro,reserved_micro FROM budget_accounts WHERE tenant_id=$1',[tenantId]);
    const g=await this.db.query('SELECT hard_limit_micro,spent_micro,reserved_micro FROM budget_global WHERE singleton=1');
    const by=await this.db.query(`SELECT provider,model,operation,count(*)::int calls,sum(input_tokens)::bigint input_tokens,sum(output_tokens)::bigint output_tokens,sum(cost_micro)::bigint cost_micro,bool_or(simulated) simulated
      FROM usage_records WHERE tenant_id=$1 AND recorded_at>now()-($2::int*interval '1 day') GROUP BY 1,2,3 ORDER BY cost_micro DESC,calls DESC`,[tenantId,days]);
    const a=acct.rows[0]||{funded_micro:0,hard_limit_micro:0,spent_micro:0,reserved_micro:0};
    return {tenant:{fundedMicro:Number(a.funded_micro),hardLimitMicro:Number(a.hard_limit_micro),spentMicro:Number(a.spent_micro),reservedMicro:Number(a.reserved_micro)},
      global:{hardLimitMicro:Number(g.rows[0]?.hard_limit_micro||0),spentMicro:Number(g.rows[0]?.spent_micro||0)},
      usage:by.rows.map(x=>({provider:x.provider,model:x.model,operation:x.operation,calls:x.calls,inputTokens:Number(x.input_tokens),outputTokens:Number(x.output_tokens),costMicro:Number(x.cost_micro),simulated:x.simulated}))};
  }
  async setTenantLimit(principal,tenantId,{hardLimitMicro}){
    await requireMembership(this.db,principal,tenantId,'owner');
    check(Number.isSafeInteger(hardLimitMicro)&&hardLimitMicro>=0,'invalid_limit');
    const r=await this.db.query('UPDATE budget_accounts SET hard_limit_micro=$2,updated_at=now() WHERE tenant_id=$1 AND spent_micro+reserved_micro<=$2 RETURNING hard_limit_micro',[tenantId,hardLimitMicro]);
    check(r.rowCount===1,'limit_below_committed_spend',409);
    return {hardLimitMicro};
  }
}
