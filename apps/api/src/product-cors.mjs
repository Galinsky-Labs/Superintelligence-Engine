// Browser access is limited to the two registered companion-app origins (Academy, Command Center)
// plus optional extra console origins. Non-browser (no Origin) server calls continue to route auth.
const METHODS=new Set(['GET','POST','PUT','PATCH','DELETE']);
const HEADER_NAMES=new Set(['content-type','x-sie-product','x-tenant-id','authorization','last-event-id','idempotency-key']);
function validOrigin(value){
 if(typeof value!=='string'||!value)return null;
 try{const u=new URL(value);
  if(u.origin!==value||u.pathname!=='/'||u.search||u.hash||u.username||u.password)return null;
  if(u.protocol!=='https:'&&!(u.protocol==='http:'&&['localhost','127.0.0.1'].includes(u.hostname)))return null;
  return u.origin;
 }catch{return null}
}
export function normalizeProductOrigins(config={}){
 const academy=validOrigin(config.academy),command=validOrigin(config.command);
 if(academy&&command&&academy===command)throw new TypeError('Academy and Command Center must have separate origins');
 const extra=(config.extra||[]).map(validOrigin).filter(Boolean);
 return {academy,command,extra};
}
function sameHost(origin,host){try{return Boolean(host)&&new URL(origin).host===host}catch{return false}}
function reply(res,status,code){res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify({code}));}
export function handleProductCors(req,res,pathname,{origins=normalizeProductOrigins({academy:process.env.ACADEMY_PUBLIC_ORIGIN,command:process.env.COMMAND_PUBLIC_ORIGIN,extra:(process.env.SIE_CONSOLE_ORIGINS||'').split(',').filter(Boolean)}),selfOrigin}={}){
 const origin=req.headers.origin;
 if(!origin&&req.method!=='OPTIONS')return false;
 if(origin&&req.method!=='OPTIONS'&&((selfOrigin&&origin===selfOrigin)||sameHost(origin,req.headers.host)))return false; // same-origin console
 const authProduct=/^\/auth\/(academy|command)\//.exec(pathname)?.[1];
 const product=authProduct||req.headers['x-sie-product'];
 const expected=product==='academy'?origins.academy:product==='command'?origins.command:null;
 const allowed=(expected&&origin===expected)||(origins.extra||[]).includes(origin);
 if(typeof origin!=='string'||!allowed){reply(res,403,'origin_not_allowed');return true;}
 res.setHeader('Access-Control-Allow-Origin',origin);
 res.setHeader('Access-Control-Allow-Credentials','true');
 res.setHeader('Vary','Origin');
 if(req.method==='OPTIONS'){
  const method=req.headers['access-control-request-method'];
  const requested=(req.headers['access-control-request-headers']||'').split(',').map(x=>x.trim().toLowerCase()).filter(Boolean);
  if(!METHODS.has(method)||requested.some(x=>!HEADER_NAMES.has(x))){reply(res,403,'preflight_not_allowed');return true;}
  res.setHeader('Access-Control-Allow-Methods','GET, POST, PUT, PATCH, DELETE');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, X-SIE-Product, X-Tenant-Id, Authorization, Last-Event-ID, Idempotency-Key');
  res.setHeader('Access-Control-Max-Age','300');
  res.writeHead(204);res.end();return true;
 }
 return false;
}
export function isAllowedBrowserOrigin(origin,origins,selfOrigin,host){
 if(!origin)return false;
 if(sameHost(origin,host))return true;
 if(selfOrigin&&origin===selfOrigin)return true;
 return [origins.academy,origins.command,...(origins.extra||[])].filter(Boolean).includes(origin);
}
