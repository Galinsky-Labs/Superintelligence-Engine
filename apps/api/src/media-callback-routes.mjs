const PROVIDER=/^[a-z][a-z0-9-]{1,63}$/;
function reply(res,status,data){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(data))}
async function rawBody(req){const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>1048576){const e=new Error('request_too_large');e.code='request_too_large';throw e}chunks.push(chunk)}return Buffer.concat(chunks)}
/** Provider callback boundary: no user cookie or CORS authority; only an injected trusted secret resolver. */
export function mediaCallbackRoute(req,res,path,{lifecycle}={}){
 const m=/^\/v1\/providers\/([^/]+)\/callbacks$/.exec(path);
 if(!m)return false;
 if(req.method!=='POST'){reply(res,405,{code:'method_not_allowed'});return true}
 if(!PROVIDER.test(m[1])){reply(res,404,{code:'not_found'});return true}
 if(!lifecycle){reply(res,503,{code:'media_unconfigured'});return true}
 (async()=>{
  if(req.headers['content-type']!=='application/json')return reply(res,415,{code:'json_required'});
  const body=await rawBody(req);
  const result=await lifecycle.receive({providerId:m[1],body,timestamp:req.headers['x-provider-timestamp'],signature:req.headers['x-provider-signature']});
  reply(res,200,{state:result.state,replayed:result.replayed===true,ignored:result.ignored===true});
 })().catch(e=>{
  const code=['invalid_signature','invalid_callback','invalid_result','invalid_identity'].includes(e.code)?'invalid_callback':
   ['unknown_task','callback_conflict','reservation_inactive','reservation_limit_exceeded'].includes(e.code)?e.code:
   e.code==='request_too_large'?e.code:'media_unavailable';
  const status=code==='invalid_callback'?400:code==='unknown_task'?404:code==='callback_conflict'||code==='reservation_inactive'||code==='reservation_limit_exceeded'?409:code==='request_too_large'?413:503;
  reply(res,status,{code});
 });
 return true;
}
