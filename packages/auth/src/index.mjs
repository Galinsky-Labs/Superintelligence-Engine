import {createHash,randomBytes,createCipheriv,createDecipheriv} from 'node:crypto';
import * as oidc from 'openid-client';
import pg from 'pg';
const PRODUCTS=new Set(['academy','command']);
const hash=value=>createHash('sha256').update(value).digest('hex');
const random=()=>randomBytes(32).toString('base64url');
const cookieName=(product,kind)=>'__Host-sie_'+kind+'_'+product;
function assertProduct(p){if(!PRODUCTS.has(p))throw new TypeError('Unknown application audience');return p;}
function parseCookie(header,name){return (header||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(name+'='))?.slice(name.length+1)||null;}
function cookie(name,value,seconds){return name+'='+value+'; Path=/; Max-Age='+seconds+'; HttpOnly; Secure; SameSite=Lax';}
function mustKey(hex){if(typeof hex!=='string'||!(/^[a-fA-F0-9]{64}$/).test(hex))throw new Error('SESSION_ENCRYPTION_KEY_HEX must be exactly 32 bytes of hexadecimal');return Buffer.from(hex,'hex');}
function encrypt(text,key){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);return Buffer.concat([iv,cipher.update(String(text),'utf8'),cipher.final(),cipher.getAuthTag()]);}
function decrypt(data,key){const buf=Buffer.from(data),iv=buf.subarray(0,12),tag=buf.subarray(buf.length-16),ciphertext=buf.subarray(12,buf.length-16);const cipher=createDecipheriv('aes-256-gcm',key,iv);cipher.setAuthTag(tag);return Buffer.concat([cipher.update(ciphertext),cipher.final()]).toString('utf8');}
export class OIDCDriver{
 constructor({issuer,clients}){this.issuer=new URL(issuer);if(this.issuer.protocol!=='https:')throw new Error('HTTPS OIDC issuer required');this.clients=clients;this.cache=new Map();}
 async configuration(product){assertProduct(product);if(!this.cache.has(product)){const c=this.clients[product];if(!c||!c.clientId||!c.redirectUri)throw new Error('OIDC client not configured');const redirect=new URL(c.redirectUri);if(redirect.protocol!=='https:')throw new Error('HTTPS redirect URI required');this.cache.set(product,oidc.discovery(this.issuer,c.clientId,c.clientSecret));}return this.cache.get(product);}
 async authorize({product,state,nonce,verifier}){
  const config=await this.configuration(product);
  const challenge=await oidc.calculatePKCECodeChallenge(verifier);
  const uri=oidc.buildAuthorizationUrl(config,{scope:'openid email',redirect_uri:this.clients[product].redirectUri,state,nonce,code_challenge:challenge,code_challenge_method:'S256'});
  return uri.href;
 }
 async redeem({product,callbackUrl,state,nonce,verifier}){
  const config=await this.configuration(product);
  const tokens=await oidc.authorizationCodeGrant(config,new URL(callbackUrl),{pkceCodeVerifier:verifier,expectedState:state,expectedNonce:nonce,idTokenExpected:true});
  const claims=tokens.claims();
  if(!claims||typeof claims.sub!=='string'||!claims.sub||claims.iss!==config.serverMetadata().issuer)throw new Error('OIDC identity claims invalid');
  return {issuer:claims.iss,subject:claims.sub};
 }
}
export class AuthBroker{
 constructor({pool,driver,encryptionKeyHex,sessionLifetimeSeconds=28800}={}){
  if(!pool||typeof pool.query!=='function'||!driver)throw new TypeError('SQL pool and OIDC driver required');
  this.pool=pool;this.driver=driver;this.key=mustKey(encryptionKeyHex);
  this.sessionLifetimeSeconds=sessionLifetimeSeconds;
 }
 async begin(product){
  assertProduct(product);
  const state=random(),nonce=random(),verifier=random(),browser=random();
  const url=await this.driver.authorize({product,state,nonce,verifier});
  await this.pool.query("INSERT INTO auth_login_flows(product,state_hash,browser_cookie_hash,pkce_ciphertext,nonce_ciphertext,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '5 minutes')",[product,hash(state),hash(browser),encrypt(verifier,this.key),encrypt(nonce,this.key)]);
  return {url,flowCookie:cookie(cookieName(product,'flow'),browser,300)};
 }
 async complete({product,callbackUrl,cookieHeader}){
  assertProduct(product);
  const current=new URL(callbackUrl),state=current.searchParams.get('state'),code=current.searchParams.get('code');
  const browser=parseCookie(cookieHeader,cookieName(product,'flow'));
  if(!state||!code||!browser)throw new Error('OIDC flow state/cookie/code missing');
  const consumed=await this.pool.query('UPDATE auth_login_flows SET consumed_at=now() WHERE product=$1 AND state_hash=$2 AND browser_cookie_hash=$3 AND consumed_at IS NULL AND expires_at>now() RETURNING *',[product,hash(state),hash(browser)]);
  if(!consumed.rows.length)throw new Error('OIDC flow expired, mismatched or replayed');
  const flow=consumed.rows[0],verifier=decrypt(flow.pkce_ciphertext,this.key),nonce=decrypt(flow.nonce_ciphertext,this.key);
  const subject=await this.driver.redeem({product,callbackUrl,state,nonce,verifier});
  if(typeof subject.issuer!=='string'||typeof subject.subject!=='string'||!subject.issuer||!subject.subject)throw new Error('Identity provider returned no verified subject');
  const person=await this.pool.query('INSERT INTO identities(issuer,subject) VALUES($1,$2) ON CONFLICT(issuer,subject) DO UPDATE SET issuer=EXCLUDED.issuer RETURNING id',[subject.issuer,subject.subject]);
  const secret=random();
  await this.pool.query("INSERT INTO auth_sessions(session_hash,identity_id,product,expires_at) VALUES($1,$2,$3,now()+($4::integer * interval '1 second'))",[hash(secret),person.rows[0].id,product,this.sessionLifetimeSeconds]);
  return {sessionCookie:cookie(cookieName(product,'session'),secret,this.sessionLifetimeSeconds),clearFlowCookie:cookie(cookieName(product,'flow'),'',0),identityId:person.rows[0].id};
 }
 async session({product,cookieHeader}){
  assertProduct(product);const token=parseCookie(cookieHeader,cookieName(product,'session'));if(!token)return null;
  const rows=await this.pool.query("SELECT s.identity_id, i.issuer, i.subject, s.expires_at FROM auth_sessions s JOIN identities i ON i.id=s.identity_id WHERE s.product=$1 AND s.session_hash=$2 AND s.revoked_at IS NULL AND s.expires_at>now()",[product,hash(token)]);
  return rows.rows.length?{identityId:rows.rows[0].identity_id,issuer:rows.rows[0].issuer,subject:rows.rows[0].subject,expiresAt:rows.rows[0].expires_at}:null;
 }
 async logout({product,cookieHeader}){
  assertProduct(product);const token=parseCookie(cookieHeader,cookieName(product,'session'));
  if(token)await this.pool.query('UPDATE auth_sessions SET revoked_at=now() WHERE product=$1 AND session_hash=$2 AND revoked_at IS NULL',[product,hash(token)]);
  return {clearSessionCookie:cookie(cookieName(product,'session'),'',0)};
 }
 async revokeAll(identityId){await this.pool.query('UPDATE auth_sessions SET revoked_at=now() WHERE identity_id=$1 AND revoked_at IS NULL',[identityId]);}
}
export function brokerFromEnvironment(env=process.env){
 if(!env.OIDC_ISSUER||!env.SESSION_ENCRYPTION_KEY_HEX||!env.AUTH_DATABASE_URL)return null;
 const clients={academy:{clientId:env.OIDC_ACADEMY_CLIENT_ID,clientSecret:env.OIDC_ACADEMY_CLIENT_SECRET,redirectUri:env.OIDC_ACADEMY_REDIRECT_URI},command:{clientId:env.OIDC_COMMAND_CLIENT_ID,clientSecret:env.OIDC_COMMAND_CLIENT_SECRET,redirectUri:env.OIDC_COMMAND_REDIRECT_URI}};
 const pool=new pg.Pool({connectionString:env.AUTH_DATABASE_URL,max:8});
 pool.on('error',()=>{}); // idle-connection errors are retried on next checkout
 return new AuthBroker({pool,driver:new OIDCDriver({issuer:env.OIDC_ISSUER,clients}),encryptionKeyHex:env.SESSION_ENCRYPTION_KEY_HEX});
}
