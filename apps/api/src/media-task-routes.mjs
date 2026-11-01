const UUID=/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
function reply(res,status,data){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(data))}
export function mediaTaskRoute(req,res,path,{auth,lifecycle,authorizedOrigins=[]}={}){
 const m=/^\/v1\/media-tasks\/([a-z][a-z0-9-]{1,63})\/([A-Za-z0-9_-]{1,128})(\/poll)?$/.exec(path);
 if(!m)return false;
 const polling=Boolean(m[3]);
 if(req.method!==(polling?'POST':'GET')){reply(res,405,{code:'method_not_allowed'});return true}
 if(!auth||!lifecycle){reply(res,503,{code:'media_unconfigured'});return true}
 const product=req.headers['x-sie-product'],tenantId=req.headers['x-tenant-id'],origin=req.headers.origin;
 if(!['academy','command'].includes(product)||typeof tenantId!=='string'||!UUID.test(tenantId)){reply(res,401,{code:'identity_scope_required'});return true}
 if(!origin||!authorizedOrigins.includes(origin)){reply(res,403,{code:'origin_not_allowed'});return true}
 (async()=>{
  const session=await auth.session({product,cookieHeader:req.headers.cookie||''});
  if(!session?.identityId||!UUID.test(session.identityId)){reply(res,401,{code:'authentication_required'});return}
  const args={tenantId,identityId:session.identityId,providerId:m[1],providerTaskId:m[2]};
  const result=await (polling?lifecycle.poll(args):lifecycle.status(args));
  reply(res,200,result);
 })().catch(e=>reply(res,e.code==='not_found'?404:e.code==='task_conflict'?409:503,
   {code:['not_found','task_conflict'].includes(e.code)?e.code:'media_unavailable'}));
 return true;
}
