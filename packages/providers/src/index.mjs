const PROVIDER_ID=/^[a-z][a-z0-9-]{1,63}$/;
const OPERATION=/^[a-z][a-z0-9.-]{1,95}$/;
const ENV_SECRET=/^PROVIDER_[A-Z0-9_]{3,100}$/;
const MAX_TIMEOUT=300000;
export class ProviderError extends Error {
 constructor(code,detail='Provider execution failed'){super(detail);this.name='ProviderError';this.code=code;}
}
function arrayOfStrings(items){return Array.isArray(items)&&items.every(v=>typeof v==='string'&&OPERATION.test(v));}
export function validateDescriptor(input){
 if(!input||typeof input!=='object'||!PROVIDER_ID.test(input.id||''))throw new TypeError('Invalid provider identifier');
 if(typeof input.model!=='string'||!input.model.trim()||!input.revision)throw new TypeError('Model and revision required');
 if(!arrayOfStrings(input.operations)||input.operations.length<1||new Set(input.operations).size!==input.operations.length)throw new TypeError('Invalid operations list');
 if(!['personal','commercial'].includes(input.licenseScope)||!Array.isArray(input.regions)||input.regions.some(x=>typeof x!=='string'))throw new TypeError('Rights and allowed regions required');
 if(input.priceMicrounits===undefined||!Number.isSafeInteger(input.priceMicrounits)||input.priceMicrounits<0)throw new TypeError('Price must be a non-negative integer estimate');
 if(input.timeoutMs!==undefined&&(!Number.isInteger(input.timeoutMs)||input.timeoutMs<100||input.timeoutMs>MAX_TIMEOUT))throw new TypeError('Timeout exceeds safe limit');
 return Object.freeze({...input,operations:Object.freeze([...input.operations]),regions:Object.freeze([...input.regions])});
}
export function assertAdapter(adapter){
 if(!adapter||typeof adapter!=='object')throw new TypeError('Provider adapter object required');
 if(typeof adapter.stream!=='function'||typeof adapter.submit!=='function'||typeof adapter.poll!=='function')throw new TypeError('Streaming, asynchronous submission, and status polling are required');
 return adapter;
}
export function validateStreamEvent(value){
 if(!value||typeof value!=='object'||!['token','usage','complete','error'].includes(value.type))throw new ProviderError('invalid_event','Unrecognized provider stream event');
 if(value.type==='token'&&typeof value.text!=='string')throw new ProviderError('invalid_event','Token text missing');
 if(value.type==='usage'&&(!Number.isSafeInteger(value.inputUnits)||!Number.isSafeInteger(value.outputUnits)||value.inputUnits<0||value.outputUnits<0))throw new ProviderError('invalid_usage','Provider usage record invalid');
 if(value.type==='error'&&typeof value.code!=='string')throw new ProviderError('invalid_event','Provider error code missing');
 return Object.freeze({...value});
}
export function validateAsyncReceipt(value){
 if(!value||typeof value!=='object'||typeof value.providerTaskId!=='string'||!value.providerTaskId.trim()||typeof value.state!=='string'||!['queued','running','completed','failed','cancelled'].includes(value.state))throw new ProviderError('invalid_receipt','Malformed asynchronous provider receipt');
 return Object.freeze({...value});
}
export class EnvironmentCredentialProvider {
 constructor(env=process.env){this.env=env;}
 async get(secretRef){if(typeof secretRef!=='string'||!ENV_SECRET.test(secretRef))throw new ProviderError('invalid_secret_ref','Only explicit provider environment secrets are permitted');const secret=this.env[secretRef];if(typeof secret!=='string'||!secret)throw new ProviderError('credential_unavailable','Provider credential is not configured');return secret;}
}
export class ProviderAdapters {
 constructor({secrets=new EnvironmentCredentialProvider(),budgetAuthority,logger=()=>{}}={}){
  if(!budgetAuthority||typeof budgetAuthority.check!=='function')throw new TypeError('Trusted budget authorization required');
  this.secrets=secrets;this.budgetAuthority=budgetAuthority;this.logger=logger;this.adapters=new Map();
 }
 register({descriptor,adapter,secretRef}){
  const d=validateDescriptor(descriptor);assertAdapter(adapter);
  if(secretRef!==undefined&&!ENV_SECRET.test(secretRef))throw new TypeError('Secret reference must be explicit provider environment variable');
  if(this.adapters.has(d.id))throw new ProviderError('duplicate_provider','Already registered');
  this.adapters.set(d.id,Object.freeze({descriptor:d,adapter,secretRef}));
  return {...d,secretConfigured:false}; // Never report availability merely because a handler is registered.
 }
 async authorize({providerId,operation,region,commercial,tenantId,reservationId,signal}){
  const entry=this.adapters.get(providerId);
  if(!entry)throw new ProviderError('unknown_provider','No such provider');
  if(!OPERATION.test(operation||'')||!entry.descriptor.operations.includes(operation))throw new ProviderError('unsupported_operation','Provider does not support operation');
  if(!entry.descriptor.regions.includes(region))throw new ProviderError('region_restricted','Operation not permitted in requested region');
  if(commercial && entry.descriptor.licenseScope!=='commercial')throw new ProviderError('rights_restricted','Commercial operation not permitted');
  if(typeof tenantId!=='string'||typeof reservationId!=='string')throw new ProviderError('authorization_required','Tenant and reservation identity required');
  if(signal?.aborted)throw new ProviderError('cancelled','Request cancelled before dispatch');
  // A forged client budget token never counts: check must query a trusted, tenant-bound ledger reservation.
  const proof=await this.budgetAuthority.check({tenantId,reservationId,maximumMicrounits:entry.descriptor.priceMicrounits});
  if(proof?.authorized!==true)throw new ProviderError('budget_denied','Provider call has no authorized reservation');
  const credential=entry.secretRef?await this.secrets.get(entry.secretRef):undefined;
  return {entry,credential,timeoutMs:entry.descriptor.timeoutMs||60000};
 }
 async *stream(request){
  const {entry,credential,timeoutMs}=await this.authorize(request);
  const controller=new AbortController();const timeout=AbortSignal.timeout(timeoutMs);
  const signal=request.signal?AbortSignal.any([request.signal,timeout,controller.signal]):AbortSignal.any([timeout,controller.signal]);
  let eventCount=0;let done=false;
  try{
   for await(const raw of entry.adapter.stream({operation:request.operation,input:request.input,credential,signal,options:request.options||{}})){
    if(signal.aborted)throw new ProviderError('cancelled','Provider stream aborted');
    const evt=validateStreamEvent(raw);eventCount++;if(evt.type==='complete'||evt.type==='error')done=true;yield evt;
   }
   if(!done)throw new ProviderError('incomplete_stream','Stream ended before terminal event');
  }finally{
   controller.abort();this.logger({providerId:entry.descriptor.id,operation:request.operation,eventCount,category:'provider_stream_closed'});
  }
 }
 async submit(request){
  const {entry,credential,timeoutMs}=await this.authorize(request);
  const signal=request.signal?AbortSignal.any([request.signal,AbortSignal.timeout(timeoutMs)]):AbortSignal.timeout(timeoutMs);
  const receipt=validateAsyncReceipt(await entry.adapter.submit({operation:request.operation,input:request.input,credential,signal,options:request.options||{}}));
  this.logger({providerId:entry.descriptor.id,operation:request.operation,category:'provider_submitted',providerTaskId:receipt.providerTaskId});
  return receipt;
 }
 async poll({providerId,providerTaskId,signal}){
  const entry=this.adapters.get(providerId);if(!entry)throw new ProviderError('unknown_provider');
  if(typeof providerTaskId!=='string'||!providerTaskId.trim())throw new ProviderError('invalid_task_id');
  const credential=entry.secretRef?await this.secrets.get(entry.secretRef):undefined;
  return validateAsyncReceipt(await entry.adapter.poll({providerTaskId,credential,signal}));
 }
 async cancel({providerId,providerTaskId,signal}){
  const entry=this.adapters.get(providerId);if(!entry)throw new ProviderError('unknown_provider');
  if(typeof entry.adapter.cancel!=='function')return {supported:false,requested:false};
  const result=await entry.adapter.cancel({providerTaskId,signal});
  return {supported:true,requested:result===true};
 }
}
