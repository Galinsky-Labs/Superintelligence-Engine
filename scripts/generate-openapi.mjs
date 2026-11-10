#!/usr/bin/env node
// Generates contracts/openapi.json from the API's actual route table (no hand-maintained drift).
//   node scripts/generate-openapi.mjs          write
//   node scripts/generate-openapi.mjs --check  fail if the committed contract is stale
import {readFileSync,writeFileSync} from 'node:fs';
import {createApp} from '../apps/api/src/server.mjs';
const app=createApp({env:{DATABASE_URL:'postgres://unused@127.0.0.1:1/unused',LOG_LEVEL:'error'}});
const paths={};
for(const r of app.routes){
  const params=[];
  const path=r.rx.source.replace(/^\^|\$$/g,'').replace(/\\\//g,'/').replace(/\(\[\^\/\]\+\)|\(\.\+\)/g,()=>{const k=r.keys[params.length];params.push(k);return `{${k}}`;});
  const tag=path.split('/')[2]||path.split('/')[1]||'platform';
  const op={tags:[tag],operationId:`${r.method.toLowerCase()}_${path.replace(/[^A-Za-z0-9]+/g,'_').replace(/^_|_$/g,'')}`,
    parameters:[...params.map(name=>({name,in:'path',required:true,schema:{type:'string'}})),...(r.opts.tenant?[{name:'X-Tenant-Id',in:'header',required:true,schema:{type:'string',format:'uuid'}}]:[])],
    responses:{[String(r.opts.status||200)]:{description:'Success'},'4XX':{description:'Error {code,message}'}}};
  if(!r.opts.public||r.opts.optionalAuth)op.security=[{bearerAuth:[]},{sessionCookie:[]}];
  (paths[path]||={})[r.method.toLowerCase()]=op;
}
const doc={openapi:'3.1.0',info:{title:'Superintelligence Engine API',version:'0.2.0',description:'Generated from the server route table. Streaming endpoints (generate, run events) respond with text/event-stream.'},
  components:{securitySchemes:{bearerAuth:{type:'http',scheme:'bearer'},sessionCookie:{type:'apiKey',in:'cookie',name:'__Host-sie_session_command'}}},paths};
const out=JSON.stringify(doc,null,2)+'\n';const file=new URL('../contracts/openapi.json',import.meta.url);
if(process.argv.includes('--check')){if(readFileSync(file,'utf8')!==out){console.error('contracts/openapi.json is stale: run npm run generate:openapi');process.exit(1);}console.log('OpenAPI contract up to date ('+Object.keys(paths).length+' paths)');}
else{writeFileSync(file,out);console.log('wrote',Object.keys(paths).length,'paths');}
await app.close().catch(()=>{});process.exit(0);
