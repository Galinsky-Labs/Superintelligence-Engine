import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeProductOrigins,handleProductCors,isAllowedBrowserOrigin} from '../src/product-cors.mjs';

const origins=normalizeProductOrigins({academy:'https://academy.platform.example',command:'https://command.platform.example'});
function fake(method,headers){const res={headers:{},status:null,body:'',setHeader(k,v){this.headers[k.toLowerCase()]=v},writeHead(s,h={}){this.status=s;Object.assign(this.headers,h)},end(b=''){this.body=b}};return {req:{method,headers},res};}
test('safe explicit origins: never wildcard, duplicate or invalid app origins',()=>{
  assert.equal(origins.academy,'https://academy.platform.example');
  assert.throws(()=>normalizeProductOrigins({academy:'https://same.example',command:'https://same.example'}),/separate origins/);
  assert.equal(normalizeProductOrigins({academy:'https://academy.platform.example/path'}).academy,null);
  assert.equal(normalizeProductOrigins({academy:'http://public.example'}).academy,null);
});
test('browser origin is bound to product and preflight allows only known methods/headers',()=>{
  let {req,res}=fake('OPTIONS',{origin:'https://academy.platform.example','x-sie-product':'academy','access-control-request-method':'PUT','access-control-request-headers':'authorization, content-type, x-tenant-id'});
  assert.equal(handleProductCors(req,res,'/v1/projects',{origins}),true);assert.equal(res.status,204);assert.equal(res.headers['access-control-allow-origin'],'https://academy.platform.example');
  ({req,res}=fake('OPTIONS',{origin:'https://academy.platform.example','x-sie-product':'command','access-control-request-method':'GET'}));
  handleProductCors(req,res,'/v1/projects',{origins});assert.equal(res.status,403,'academy origin cannot act as command');
  ({req,res}=fake('OPTIONS',{origin:'https://command.platform.example','x-sie-product':'command','access-control-request-method':'GET','access-control-request-headers':'x-evil'}));
  handleProductCors(req,res,'/v1/projects',{origins});assert.equal(res.status,403);
  ({req,res}=fake('GET',{origin:'https://evil.example','x-sie-product':'academy'}));
  assert.equal(handleProductCors(req,res,'/v1/projects',{origins}),true);assert.equal(res.status,403);
  ({req,res}=fake('GET',{}));assert.equal(handleProductCors(req,res,'/v1/projects',{origins}),false,'server-to-server calls proceed to authentication');
  assert.equal(isAllowedBrowserOrigin('https://command.platform.example',origins),true);
  assert.equal(isAllowedBrowserOrigin('https://evil.example',origins),false);
});
