const STATES=['pending','awaiting_approval','approved','denied','running','succeeded','failed','cancelled'];
const IMPACT=new Set(['purchase','deploy','publish','send','transfer','delete']);
const LOW_IMPACT=new Set(['read','compute','draft']);
const fail=()=>{throw new TypeError('Invalid workflow approval transition')};
/** Pure transition function. Integration MUST persist with compare-and-swap and audited actor identity. */
export function workflowTransition(current,action,{actorRole='system',expectedVersion}={}) {
 if(!current||typeof current!=='object'||!STATES.includes(current.state)||
   !Number.isSafeInteger(current.version)||current.version<0||
   !Number.isSafeInteger(expectedVersion)||current.version!==expectedVersion||
   typeof action!=='string'||(!IMPACT.has(current.effect)&&!LOW_IMPACT.has(current.effect)))fail();
 const sensitive=IMPACT.has(current.effect);
 const allowed={
   pending:{request:'awaiting_approval',start:sensitive?null:'running',cancel:'cancelled'},
   awaiting_approval:{approve:actorRole==='approver'?'approved':null,
     deny:actorRole==='approver'?'denied':null,cancel:'cancelled'},
   approved:{start:'running',cancel:'cancelled'},
   running:{succeed:'succeeded',fail:'failed',cancel:'cancelled'},
   failed:{retry:sensitive?'awaiting_approval':'pending',cancel:'cancelled'},
   denied:{},cancelled:{},succeeded:{}
 };
 const state=allowed[current.state]?.[action];if(!state)fail();
 if(sensitive&&action==='start'&&current.state!=='approved')fail();
 return Object.freeze({...current,state,version:current.version+1});
}
