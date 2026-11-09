const CATEGORIES=new Set(['api','worker','provider','storage','ledger']);
const KINDS=new Set(['latency','error','spend','dead_letter']);
const fail=()=>{throw new TypeError('Invalid service signal')};
const plainData=input=>Object.getPrototypeOf(input)===Object.prototype&&
  Object.values(Object.getOwnPropertyDescriptors(input)).every(descriptor=>Object.hasOwn(descriptor,'value'));

/** Fixed-label policy: no prompts, tenant identities or credentials in labels. */
export function evaluateOperationalSignal(input) {
 if(!input||typeof input!=='object'||Array.isArray(input)||
   (!plainData(input)||Object.keys(input).sort().join(','))!=='category,kind,threshold,value'|| 
   !CATEGORIES.has(input.category)||!KINDS.has(input.kind)||
   !Number.isFinite(input.value)||input.value<0||
   !Number.isFinite(input.threshold)||input.threshold<=0)fail();
 const alert=input.value>=input.threshold;
 return Object.freeze({category:input.category,kind:input.kind,alert,
   severity:alert?(input.value>=2*input.threshold?'critical':'warning'):'none',
   metricRatio:Math.round(input.value/input.threshold*100)/100});
}
export function redactCorrelation(input) {
 if(!input||typeof input!=='object'||Array.isArray(input)||
  (!plainData(input)||Object.keys(input).some(x=>!['traceId','spanId','service','event'].includes(x)))||
  typeof input.traceId!=='string'||!/^[0-9a-f]{32}$/.test(input.traceId)||
  typeof input.spanId!=='string'||!/^[0-9a-f]{16}$/.test(input.spanId)||
  !CATEGORIES.has(input.service)||typeof input.event!=='string'||
  !/^[a-z_]{1,40}$/.test(input.event))fail();
 return Object.freeze({traceId:input.traceId,spanId:input.spanId,
   service:input.service,event:input.event});
}
