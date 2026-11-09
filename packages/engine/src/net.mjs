// Egress control for tool/integration traffic: HTTPS only, DNS-resolved private ranges blocked,
// manual redirect re-validation, bounded size and time.
import {lookup} from 'node:dns/promises';
import {isIP} from 'node:net';
import {EngineError,check} from './infra.mjs';

function privateV4(ip){const [a,b]=ip.split('.').map(Number);
  return a===10||a===127||a===0||(a===169&&b===254)||(a===172&&b>=16&&b<=31)||(a===192&&b===168)||(a===100&&b>=64&&b<=127)||a>=224||(a===198&&(b===18||b===19));}
function privateV6(ip){const x=ip.toLowerCase();
  if(x==='::1'||x==='::')return true;if(x.startsWith('fc')||x.startsWith('fd')||x.startsWith('fe80'))return true;
  const m=/::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(x);return m?privateV4(m[1]):false;}
export function isPrivateAddress(ip){return isIP(ip)===4?privateV4(ip):isIP(ip)===6?privateV6(ip):true;}

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
export async function assertEgress(url,policy=egressPolicy()){
  let u;try{u=new URL(url)}catch{throw new EngineError('invalid_url',400)}
  check(u.protocol==='https:'||(policy.allowHttp&&u.protocol==='http:'),'egress_https_required',403,'Only HTTPS egress is allowed');
  check(!u.username&&!u.password,'egress_credentials_in_url',403);
  const host=u.hostname.replace(/^\[|\]$/g,'');
  const addrs=isIP(host)?[{address:host}]:await lookup(host,{all:true}).catch(()=>{throw new EngineError('egress_dns_failed',502,'Could not resolve '+host)});
  if(!policy.allowPrivate)for(const a of addrs)check(!isPrivateAddress(a.address),'egress_private_address',403,'Refusing to connect to a private or local address');
  return u;
}
export async function guardedFetch(url,{method='GET',headers={},body,maxBytes=2*1024*1024,timeoutMs=15000,policy=egressPolicy(),signal,fetchImpl=fetch}={}){
  let current=url;
  for(let hop=0;hop<4;hop++){
    await assertEgress(current,policy);
    const res=await fetchImpl(current,{method,headers,body,redirect:'manual',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(timeoutMs)]):AbortSignal.timeout(timeoutMs)});
    if([301,302,303,307,308].includes(res.status)&&res.headers.get('location')){current=new URL(res.headers.get('location'),current).href;if(res.status===303){method='GET';body=undefined;}continue;}
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
