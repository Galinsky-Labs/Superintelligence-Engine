const ID=/^[a-zA-Z0-9_-]{1,128}$/;
const SCOPE=/^[a-z][a-z0-9.-]{1,95}$/;
const fail=()=>{throw new TypeError('Invalid delegated task scope')};
/** Caller grants are authoritative. Remote capabilities cannot expand them. */
export function createDelegationScope({taskId,tenantId,callerScopes,remoteCapabilities,requestedScopes,
  callerBudgetMicros,requestedBudgetMicros,callerDeadlineMs,requestedDeadlineMs,nowMs=Date.now()}={}) {
  if(!ID.test(taskId||'')||!ID.test(tenantId||'')||
     ![callerScopes,remoteCapabilities,requestedScopes].every(Array.isArray))fail();
  for(const list of [callerScopes,remoteCapabilities,requestedScopes])
    if(list.length>128||new Set(list).size!==list.length||list.some(x=>typeof x!=='string'||!SCOPE.test(x)))fail();
  if(!requestedScopes.length||requestedScopes.some(x=>!callerScopes.includes(x)||!remoteCapabilities.includes(x)))fail();
  if(![callerBudgetMicros,requestedBudgetMicros].every(Number.isSafeInteger)||
      requestedBudgetMicros<0||requestedBudgetMicros>callerBudgetMicros)fail();
  if(![callerDeadlineMs,requestedDeadlineMs,nowMs].every(Number.isSafeInteger)||
      requestedDeadlineMs<=nowMs||requestedDeadlineMs>callerDeadlineMs)fail();
  return Object.freeze({taskId,tenantId,scopes:Object.freeze([...requestedScopes].sort()),
    budgetCeilingMicros:requestedBudgetMicros,deadlineMs:requestedDeadlineMs,
    retention:'no-remote-persistence',cancelSupported:true});
}
/** Prototype-safe, minimum audit record of a delegated task transition.
 * Not a durable append-only ledger; caller must transact in run provenance. */
export function delegationAuditEvent(scope,{remoteTaskId,state,atMs=Date.now()}={}) {
  if(!scope||typeof scope!=='object'||!ID.test(scope.taskId||'')||
     !ID.test(scope.tenantId||'')||!Number.isSafeInteger(scope.budgetCeilingMicros)||
     scope.budgetCeilingMicros<0||!ID.test(remoteTaskId||'')||
     !['submitted','running','completed','failed','cancelled'].includes(state)||
     !Number.isSafeInteger(atMs))fail();
  return Object.freeze({taskId:scope.taskId,tenantId:scope.tenantId,
    remoteTaskId,state,atMs,budgetCeilingMicros:scope.budgetCeilingMicros});
}
