// Principal resolution (API tokens, OIDC sessions, optional dev login), tenants and memberships.
import {EngineError,check,sha256,randomToken,requireUUID,roleAtLeast,tx,requireMembership} from './infra.mjs';

const PRODUCTS=new Set(['academy','command','engine']);
const TOKEN=/^sie_[A-Za-z0-9_-]{30,80}$/;

export class IdentityService {
  constructor({system,oidcBroker=null,devAuth=false}){this.db=system;this.oidc=oidcBroker;this.devAuth=devAuth;}

  /** Resolve the caller. Returns null when unauthenticated. */
  async authenticate(req){
    const header=req.headers.authorization||'';
    const product=req.headers['x-sie-product'];
    if(header.startsWith('Bearer ')){
      const token=header.slice(7).trim();
      if(!TOKEN.test(token))return null;
      const r=await this.db.query(`UPDATE api_tokens SET last_used_at=now() WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at>now()
        RETURNING id,identity_id,product,scopes`,[sha256(token)]);
      const row=r.rows[0];if(!row)return null;
      if(row.product!=='engine'&&product&&product!==row.product)return null;
      return {identityId:row.identity_id,product:row.product==='engine'?(PRODUCTS.has(product)?product:'engine'):row.product,tokenId:row.id,scopes:row.scopes,via:'token'};
    }
    if(this.oidc&&(product==='academy'||product==='command')&&req.headers.cookie){
      const s=await this.oidc.session({product,cookieHeader:req.headers.cookie});
      if(s)return {identityId:s.identityId,product,via:'oidc',scopes:[]};
    }
    return null;
  }

  async issueToken(identityId,{product='engine',label='',days=30,scopes=[]}={}){
    check(PRODUCTS.has(product),'invalid_product');
    check(Number.isInteger(days)&&days>=1&&days<=365,'invalid_expiry');
    check(typeof label==='string'&&label.length<=120,'invalid_label');
    const token='sie_'+randomToken(32);
    const r=await this.db.query(`INSERT INTO api_tokens(token_hash,identity_id,product,label,scopes,expires_at) VALUES($1,$2,$3,$4,$5,now()+($6::int*interval '1 day')) RETURNING id,expires_at`,
      [sha256(token),identityId,product,label,scopes,days]);
    return {token,id:r.rows[0].id,product,expiresAt:r.rows[0].expires_at};
  }
  async listTokens(identityId){
    const r=await this.db.query('SELECT id,product,label,created_at,expires_at,last_used_at,revoked_at FROM api_tokens WHERE identity_id=$1 ORDER BY created_at DESC LIMIT 100',[identityId]);
    return r.rows.map(x=>({id:x.id,product:x.product,label:x.label,createdAt:x.created_at,expiresAt:x.expires_at,lastUsedAt:x.last_used_at,revoked:!!x.revoked_at}));
  }
  async revokeToken(identityId,tokenId){
    requireUUID(tokenId,'token');
    const r=await this.db.query('UPDATE api_tokens SET revoked_at=now() WHERE id=$1 AND identity_id=$2 AND revoked_at IS NULL',[tokenId,identityId]);
    check(r.rowCount===1,'token_not_found',404);return {revoked:true};
  }

  /** Create or find an identity for a verified (issuer, subject). */
  async upsertIdentity({issuer,subject,displayName='',email=null}){
    const r=await this.db.query(`INSERT INTO identities(issuer,subject,display_name,email) VALUES($1,$2,$3,$4)
      ON CONFLICT(issuer,subject) DO UPDATE SET display_name=CASE WHEN EXCLUDED.display_name<>'' THEN EXCLUDED.display_name ELSE identities.display_name END,
      email=coalesce(EXCLUDED.email,identities.email) RETURNING id`,[issuer,subject,displayName.slice(0,160),email]);
    return r.rows[0].id;
  }

  /** Development-only login. Disabled unless SIE_DEV_AUTH=1 and not production. */
  async devLogin({handle,displayName,product='engine'}){
    if(!this.devAuth)throw new EngineError('dev_auth_disabled',404);
    check(typeof handle==='string'&&/^[a-z0-9][a-z0-9._-]{1,62}$/.test(handle),'invalid_handle');
    const identityId=await this.upsertIdentity({issuer:'urn:sie:dev',subject:handle,displayName:displayName||handle,email:handle+'@dev.local'});
    const tenants=await this.listTenants({identityId});
    if(!tenants.items.length)await this.createTenant({identityId},{name:(displayName||handle)+"'s workspace"});
    const token=await this.issueToken(identityId,{product,label:'dev-login',days:7});
    return {identityId,...token};
  }

  async me(principal){
    const r=await this.db.query('SELECT id,issuer,subject,display_name,email FROM identities WHERE id=$1',[principal.identityId]);
    const x=r.rows[0];check(x,'identity_not_found',404);
    return {id:x.id,issuer:x.issuer,subject:x.subject,displayName:x.display_name,email:x.email,product:principal.product,via:principal.via};
  }

  async listTenants(principal){
    const r=await this.db.query('SELECT t.id,t.name,m.role FROM memberships m JOIN tenants t ON t.id=m.tenant_id WHERE m.identity_id=$1 ORDER BY t.created_at,t.id LIMIT 200',[principal.identityId]);
    return {items:r.rows.map(x=>({id:x.id,name:x.name,role:x.role}))};
  }
  async createTenant(principal,{name}){
    check(typeof name==='string'&&name.trim().length>=1&&name.length<=160,'invalid_name');
    return tx(this.db,async db=>{
      const t=await db.query('INSERT INTO tenants(name) VALUES($1) RETURNING id,name',[name.trim()]);
      await db.query("INSERT INTO memberships(tenant_id,identity_id,role) VALUES($1,$2,'owner')",[t.rows[0].id,principal.identityId]);
      await db.query('INSERT INTO budget_accounts(tenant_id) VALUES($1) ON CONFLICT DO NOTHING',[t.rows[0].id]);
      return {id:t.rows[0].id,name:t.rows[0].name,role:'owner'};
    });
  }
  async listMembers(principal,tenantId){
    await requireMembership(this.db,principal,tenantId,'viewer');
    const r=await this.db.query('SELECT i.id,i.display_name,i.email,m.role FROM memberships m JOIN identities i ON i.id=m.identity_id WHERE m.tenant_id=$1 ORDER BY m.created_at',[tenantId]);
    return {items:r.rows.map(x=>({identityId:x.id,displayName:x.display_name,email:x.email,role:x.role}))};
  }
  async setMember(principal,tenantId,{identityId,email,role}){
    const myRole=await requireMembership(this.db,principal,tenantId,'admin');
    check(['owner','admin','member','viewer'].includes(role),'invalid_role');
    check(role!=='owner'||myRole==='owner','insufficient_role',403);
    let target=identityId;
    if(!target&&typeof email==='string'){
      const r=await this.db.query('SELECT id FROM identities WHERE lower(email)=lower($1) ORDER BY created_at LIMIT 1',[email]);
      check(r.rows.length,'identity_not_found',404,'That person must sign in once before being added');target=r.rows[0].id;
    }
    requireUUID(target,'identity');
    const existing=await this.db.query('SELECT role FROM memberships WHERE tenant_id=$1 AND identity_id=$2',[tenantId,target]);
    if(existing.rows[0]?.role==='owner')check(myRole==='owner','insufficient_role',403);
    await this.db.query('INSERT INTO memberships(tenant_id,identity_id,role) VALUES($1,$2,$3) ON CONFLICT(tenant_id,identity_id) DO UPDATE SET role=EXCLUDED.role',[tenantId,target,role]);
    return {identityId:target,role};
  }
  async removeMember(principal,tenantId,identityId){
    const myRole=await requireMembership(this.db,principal,tenantId,'admin');requireUUID(identityId,'identity');
    const t=await this.db.query('SELECT role FROM memberships WHERE tenant_id=$1 AND identity_id=$2',[tenantId,identityId]);
    check(t.rows.length,'member_not_found',404);
    if(t.rows[0].role==='owner'){
      check(myRole==='owner','insufficient_role',403);
      const owners=await this.db.query("SELECT count(*)::int n FROM memberships WHERE tenant_id=$1 AND role='owner'",[tenantId]);
      check(owners.rows[0].n>1,'last_owner',409);
    }
    await this.db.query('DELETE FROM memberships WHERE tenant_id=$1 AND identity_id=$2',[tenantId,identityId]);
    return {removed:true};
  }
}
export {roleAtLeast};
