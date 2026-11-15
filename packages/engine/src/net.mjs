// Egress control for tool, integration and tenant-configured provider traffic:
// HTTPS only, private/link-local/metadata/mapped addresses blocked, the address is re-checked at
// connect time (defeats DNS rebinding), redirects re-validated hop by hop, credentials never forwarded
// across origins, bounded size and time.
import {lookup as dnsLookup} from 'node:dns';
import {BlockList,isIP} from 'node:net';
import {Agent,fetch as undiciFetch} from 'undici';
import {EngineError,check} from './infra.mjs';

const blocked=new BlockList();
for(const [a,p] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',3]])blocked.addSubnet(a,p,'ipv4');
for(const [a,p] of [['::',128],['::1',128],['fc00::',7],['fe80::',10],['ff00::',8],['64:ff9b::',96],['64:ff9b:1::',48],['2001:db8::',32],['100::',64]])blocked.addSubnet(a,p,'ipv6');
export function isPrivateAddress(ip){
  const v=isIP(ip);if(!v)return true;
  if(blocked.check(ip,v===4?'ipv4':'ipv6'))return true; // BlockList also matches IPv4-mapped IPv6 against IPv4 rules
  if(v===6){ // IPv4-compatible / mapped forms written in hex
    const m=/^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(ip);
    if(m){const n=(parseInt(m[1],16)<<16|parseInt(m[2],16))>>>0;return isPrivateAddress([n>>>24,(n>>>16)&255,(n>>>8)&255,n&255].join('.'));}
  }
  return false;
}

export function egressPolicy(env=process.env){
  return {
    allowHttp:env.SIE_ALLOW_HTTP_EGRESS==='1',
    allowPrivate:env.SIE_ALLOW_PRIVATE_EGRESS==='1',
    allowlist:(env.SIE_EGRESS_ALLOWLIST||'').split(',').map(s=>s.trim().toLowerCase()).filter(Boolean),
  };
}
export function hostAllowlisted(host,allowlist){
  host=host.toLowerCase();
  return allowlist.some(a=>a==='*'||a===host||(a.startsWith('*.')&&host.endsWith(a.slice(1))));
}

const agents=new Map();
/** undici dispatcher whose DNS lookup refuses private addresses at connect time. */
export function egressDispatcher(policy=egressPolicy()){
  const key=policy.allowPrivate?'open':'guarded';
  if(!agents.has(key))agents.set(key,new Agent({connect:{lookup:(host,opts,cb)=>{
    dnsLookup(host,{...opts,all:true},(err,addrs)=>{
      if(err)return cb(err);
      const list=Array.isArray(addrs)?addrs:[{address:addrs,family:opts?.family||4}];
      if(!policy.allowPrivate&&list.some(a=>isPrivateAddress(a.address)))return cb(Object.assign(new Error('egress to private address refused'),{code:'EGRESS_PRIVATE'}));
      if(opts?.all)cb(null,list);else cb(null,list[0].address,list[0].family);
    });
  }}}));
  return agents.get(key);
}
/** fetch() bound to the guarded dispatcher, never following redirects (for provider SDK traffic). */
export function guardedProviderFetch(policy=egressPolicy()){
  const dispatcher=egressDispatcher(policy);
  return (url,init={})=>{
    const u=new URL(typeof url==='string'?url:url.url||String(url));
    if(u.protocol!=='https:'&&!(policy.allowHttp&&u.protocol==='http:'))return Promise.reject(new EngineError('egress_https_required',403));
    if(!policy.allowPrivate&&isIP(u.hostname.replace(/^\[|\]$/g,''))&&isPrivateAddress(u.hostname.replace(/^\[|\]$/g,'')))return Promise.reject(new EngineError('egress_private_address',403));
    return undiciFetch(url,{...init,redirect:'error',dispatcher});
  };
}

export async function assertEgress(url,policy=egressPolicy()){
  let u;try{u=new URL(url)}catch{throw new EngineError('invalid_url',400)}
  check(u.protocol==='https:'||(policy.allowHttp&&u.protocol==='http:'),'egress_https_required',403,'Only HTTPS egress is allowed');
  check(!u.username&&!u.password,'egress_credentials_in_url',403);
  const host=u.hostname.replace(/^\[|\]$/g,'');
  if(!policy.allowPrivate){
    if(isIP(host))check(!isPrivateAddress(host),'egress_private_address',403,'Refusing to connect to a private or local address');
    else{
      const addrs=await new Promise((res,rej)=>dnsLookup(host,{all:true},(e,a)=>e?rej(new EngineError('egress_dns_failed',502,'Could not resolve '+host)):res(a)));
      for(const a of addrs)check(!isPrivateAddress(a.address),'egress_private_address',403,'Refusing to connect to a private or local address');
    }
  }
  return u;
}
/**
 * Guarded fetch. `redirectAllowed(url)` may veto hops to new hosts (e.g. outside the allowlist).
 * Authorization/Cookie are dropped when a redirect changes origin; 307/308 cross-origin redirects
 * (which would resend the body) are refused.
 */
export async function guardedFetch(url,{method='GET',headers={},body,maxBytes=2*1024*1024,timeoutMs=15000,policy=egressPolicy(),signal,fetchImpl,redirectAllowed}={}){
  let current=url;let hdrs={...headers};const origin=new URL(url).origin;
  const dispatcher=fetchImpl?undefined:egressDispatcher(policy);
  for(let hop=0;hop<4;hop++){
    await assertEgress(current,policy);
    const sig=signal?AbortSignal.any([signal,AbortSignal.timeout(timeoutMs)]):AbortSignal.timeout(timeoutMs);
    let res;
    try{res=await (fetchImpl||undiciFetch)(current,{method,headers:hdrs,body,redirect:'manual',signal:sig,...(dispatcher?{dispatcher}:{})});}
    catch(e){if(e?.cause?.code==='EGRESS_PRIVATE'||e?.code==='EGRESS_PRIVATE')throw new EngineError('egress_private_address',403,'Refusing to connect to a private or local address');throw new EngineError('egress_failed',502,'Request failed: '+(e?.cause?.code||e.message));}
    if([301,302,303,307,308].includes(res.status)&&res.headers.get('location')){
      const next=new URL(res.headers.get('location'),current);
      if(next.origin!==origin){
        if(res.status===307||res.status===308)throw new EngineError('egress_cross_origin_redirect',403,'Refusing to resend a request body to another origin');
        delete hdrs.Authorization;delete hdrs.authorization;delete hdrs.Cookie;delete hdrs.cookie;
        for(const k of Object.keys(hdrs))if(/^(x-api-key|xi-api-key|x-goog-api-key)$/i.test(k))delete hdrs[k];
      }
      if(redirectAllowed&&!redirectAllowed(next))throw new EngineError('egress_redirect_requires_approval',403,'Redirect to '+next.host+' is outside the approved hosts');
      current=next.href;if(res.status===303||res.status===301||res.status===302){if(method!=='GET'&&method!=='HEAD'){method='GET';body=undefined;}}
      continue;
    }
    const reader=res.body?.getReader();const chunks=[];let size=0,truncated=false;
    if(reader)while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>maxBytes){truncated=true;reader.cancel().catch(()=>{});break;}chunks.push(value);}
    return {status:res.status,ok:res.ok,headers:Object.fromEntries(res.headers),bytes:Buffer.concat(chunks.map(c=>Buffer.from(c))),truncated,url:current};
  }
  throw new EngineError('egress_too_many_redirects',502);
}
export function htmlToText(html){
  return String(html).replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<(br|p|div|li|h[1-6]|tr)[^>]*>/gi,'\n')
    .replace(/<[^>]+>/g,' ').replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'")
    .replace(/[ \t]+/g,' ').replace(/\n\s*\n+/g,'\n\n').trim();
}
