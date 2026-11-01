import {createHmac,timingSafeEqual} from 'node:crypto';
/** Verify provider HMAC signature over timestamp + '.' + exact raw bytes.
 * Integration must provide authenticated provider-specific signing secret. */
export function verifyProviderCallback({body,timestamp,signature,secret,nowMs=Date.now(),maxAgeMs=300000}) {
  if(!Buffer.isBuffer(body)||body.length>1048576||typeof timestamp!=='string'||
      !/^[1-9][0-9]{0,15}$/.test(timestamp)||typeof signature!=='string'||
      !/^sha256=[a-f0-9]{64}$/.test(signature)||typeof secret!=='string'||secret.length<32||
      !Number.isSafeInteger(nowMs)||!Number.isSafeInteger(maxAgeMs)||maxAgeMs<1000||maxAgeMs>300000)
    return false;
  const created=Number(timestamp)*1000;
  if(!Number.isSafeInteger(created)||Math.abs(nowMs-created)>maxAgeMs)return false;
  const expected=createHmac('sha256',secret).update(timestamp).update('.').update(body).digest();
  const received=Buffer.from(signature.slice(7),'hex');
  return timingSafeEqual(expected,received);
}
/** In-memory event reducer only: durable transaction/idempotency ledger required
 * before billing or publishing any terminal result. */
export function reconcileProviderEvents(previous,event) {
  if(!event||typeof event!=='object'||Array.isArray(event)||
      !['queued','running','completed','failed','cancelled'].includes(event.state)||
      typeof event.callbackId!=='string'||!/^[a-zA-Z0-9_-]{1,128}$/.test(event.callbackId)||
      typeof event.providerTaskId!=='string'||!/^[a-zA-Z0-9_-]{1,128}$/.test(event.providerTaskId))
    throw new TypeError('Malformed provider event');
  const old=previous||{state:'queued',providerTaskId:event.providerTaskId,seenIds:[]};
  if(old.providerTaskId!==event.providerTaskId||!Array.isArray(old.seenIds)||
      !['queued','running','completed','failed','cancelled'].includes(old.state)||
      old.seenIds.some(id=>typeof id!=='string'||!/^[a-zA-Z0-9_-]{1,128}$/.test(id)))
    throw new TypeError('Malformed prior provider state');
  if(old.seenIds.includes(event.callbackId))return Object.freeze({...old,seenIds:Object.freeze([...old.seenIds])});
  const terminal=['completed','failed','cancelled'];
  const nextState=terminal.includes(old.state)?old.state:
    terminal.includes(event.state)?event.state:
    old.state==='running'||event.state==='running'?'running':'queued';
  return Object.freeze({providerTaskId:event.providerTaskId,state:nextState,
    seenIds:Object.freeze([...old.seenIds,event.callbackId])});
}
