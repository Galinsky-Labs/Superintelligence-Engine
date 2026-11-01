import {createServer} from 'node:http';
import {projectRoute} from './project-routes.mjs';
import {mediaCallbackRoute} from './media-callback-routes.mjs';
import {mediaTaskRoute} from './media-task-routes.mjs';
import {textGenerationRoute} from './text-generation-routes.mjs';
import {runEventRoute} from './run-event-routes.mjs';
import {runControlRoute} from './run-control-routes.mjs';
import {authRoute} from './auth-routes.mjs';
import {tenantRoute} from './tenant-routes.mjs';
import {handleProductCors} from './product-cors.mjs';
import {ENGINE_VERSION,WORKSPACE_KINDS} from '../../../packages/core/src/index.mjs';
import {readFileSync} from 'node:fs';
import {CapabilityCatalog,makeCatalogPool} from '../../../packages/catalog/src/index.mjs';
const contract=JSON.parse(readFileSync(new URL('../../../contracts/openapi.json',import.meta.url),'utf8'));
const patterns=Object.entries(contract.paths).flatMap(([path,methods])=>Object.entries(methods).map(([method,op])=>({method:method.toUpperCase(),regex:new RegExp('^'+path.replace(/\{[^}]+\}/g,'[^/]+')+'$'),op})));
const pool=makeCatalogPool(process.env.MODEL_CATALOG_READ_URL);
const defaultCatalog=pool?new CapabilityCatalog({db:pool}):null;
export function handler(req,res,{catalog=defaultCatalog,originConfig,tenantAuth,tenantDb,textGenerationAuth,textGenerationService,textGenerationOrigins,runEventAuth,runEventService,runEventOrigins,mediaLifecycle,mediaAuth,mediaOrigins}={}) {
  const path=new URL(req.url||'/', 'http://localhost').pathname;
  res.setHeader('Content-Type','application/json; charset=utf-8');res.setHeader('Cache-Control','no-store');
  const reply=(code,data)=>{res.writeHead(code);res.end(JSON.stringify(data));};
  if(handleProductCors(req,res,path,{...(originConfig?{origins:originConfig}:{})}))return;
  if(authRoute(req,res,path))return;
  if(tenantRoute(req,res,path,{...(tenantAuth?{auth:tenantAuth}:{}),...(tenantDb?{db:tenantDb}:{})}))return;
  if(textGenerationRoute(req,res,path,{auth:textGenerationAuth,service:textGenerationService,authorizedOrigins:textGenerationOrigins||(process.env.AUTHORIZED_PRODUCT_ORIGINS||'').split(',').filter(Boolean)}))return;
  if(runEventRoute(req,res,path,{auth:runEventAuth,service:runEventService,authorizedOrigins:runEventOrigins||(process.env.AUTHORIZED_PRODUCT_ORIGINS||'').split(',').filter(Boolean)}))return;
  if(runControlRoute(req,res,path,{auth:runEventAuth,service:runEventService,authorizedOrigins:runEventOrigins||(process.env.AUTHORIZED_PRODUCT_ORIGINS||'').split(',').filter(Boolean)}))return;
  if(mediaCallbackRoute(req,res,path,{lifecycle:mediaLifecycle}))return;
  if(mediaTaskRoute(req,res,path,{auth:mediaAuth,lifecycle:mediaLifecycle,authorizedOrigins:mediaOrigins||(process.env.AUTHORIZED_PRODUCT_ORIGINS||'').split(',').filter(Boolean)}))return;
  if(projectRoute(req,res,path))return;
  if(path==='/health' && req.method==='GET')return reply(200,{status:'ok',version:ENGINE_VERSION});
  if(path==='/v1/capabilities' && req.method==='GET')return reply(200,{workspaceKinds:WORKSPACE_KINDS,availableProviders:[],generationEnabled:false});
  if(path==='/v1/models' && req.method==='GET'){
    if(!catalog)return reply(503,{code:'catalog_unconfigured',message:'Model catalog database is not connected.'});
    const params=new URL(req.url,'http://localhost').searchParams;
    const options={capability:params.get('capability')||undefined,region:params.get('region')||undefined,usage:params.get('usage')||'personal'};
    return catalog.list(options).then(result=>reply(200,result)).catch(e=>reply(e instanceof TypeError?400:503,{code:e instanceof TypeError?'invalid_filter':'catalog_unavailable',message:e instanceof TypeError?e.message:'Model catalog backend unavailable.'}));
  }
  const route=patterns.find(x=>x.method===req.method && x.regex.test(path));
  if(route && route.op['x-implementation']==='planned')return reply(501,{code:'not_implemented',message:'The operation is part of the versioned API contract but not available.'});
  return reply(404,{code:'not_found',message:'Unknown API route.'});
}
export function makeServer(options){return createServer((req,res)=>{handler(req,res,options);})}
if(process.argv[1] && import.meta.url===new URL('file://'+process.argv[1]).href){const port=Number(process.env.PORT||8080);makeServer().listen(port,()=>console.log('Engine API listening',port));}
