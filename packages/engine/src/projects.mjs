// Projects and versioned artifacts. User requests run through the tenant pool with
// row-level security bound to the principal; engine-internal writes use the system pool.
import {WORKSPACE_KINDS} from '../../core/src/index.mjs';
import {EngineError,check,fail,sha256,requireUUID,isObject,withTenant,requireMembership,tx} from './infra.mjs';

export const PROJECT_KINDS=[...new Set([...WORKSPACE_KINDS,'writing','fiction','general','cross-media'])];
const TITLE=t=>{check(typeof t==='string'&&t.trim().length>=1&&t.length<=256,'invalid_title');return t.trim()};
const MAX_INLINE=2*1024*1024;

function serializeProject(r){return {id:r.id,title:r.title,kind:r.kind,description:r.description||'',revision:Number(r.current_revision),archived:Boolean(r.archived_at),createdAt:r.created_at,updatedAt:r.updated_at,
  ...(r.artifact_count!==undefined?{artifactCount:Number(r.artifact_count)}:{}),...(r.run_count!==undefined?{runCount:Number(r.run_count)}:{})}}
function serializeArtifact(r,{withBody=false}={}){
  return {id:r.id,projectId:r.project_id,title:r.title,kind:r.kind,mediaType:r.media_type,checksum:r.sha256,revision:Number(r.current_revision??r.revision),
    assetId:r.asset_id||null,runId:r.run_id||null,provenance:r.provenance||{},createdAt:r.created_at,updatedAt:r.updated_at,
    ...(withBody?{body:r.body??null}:{preview:r.body==null?null:(typeof r.body==='string'?r.body.slice(0,280):JSON.stringify(r.body).slice(0,280))})};
}
/** Normalize artifact content. Returns {mediaType, body|assetId, checksum}. */
export function normalizeContent(input){
  check(isObject(input),'invalid_artifact');
  const hasBody=input.body!==undefined||input.text!==undefined,hasAsset=input.assetId!==undefined&&input.assetId!==null;
  check(hasBody!==hasAsset,'artifact_content_required',400,'Provide exactly one of text/body or assetId');
  if(hasAsset){requireUUID(input.assetId,'asset');return {assetId:input.assetId,mediaType:input.mediaType,checksum:input.checksum};}
  const body=input.text!==undefined?input.text:input.body;
  check(typeof body==='string'||isObject(body)||Array.isArray(body),'invalid_body');
  const json=JSON.stringify(body);check(Buffer.byteLength(json)<=MAX_INLINE,'inline_content_too_large',413);
  const mediaType=input.mediaType||(typeof body==='string'?'text/markdown':'application/json');
  check(typeof mediaType==='string'&&/^[a-z]+\/[a-z0-9.+-]{1,100}$/i.test(mediaType),'invalid_media_type');
  return {body,mediaType,checksum:sha256(json)};
}

export class ProjectStore {
  constructor({tenant,system,assets}){this.tenant=tenant;this.system=system;this.assets=assets;}
  scope(principal,tenantId,role,fn){return withTenant(this.tenant,principal,tenantId,role,fn);}

  async listProjects(principal,tenantId,{includeArchived=false,q}={}){
    return this.scope(principal,tenantId,'viewer',async db=>{
      const r=await db.query(`SELECT p.*,(SELECT count(*) FROM project_artifacts a WHERE a.tenant_id=p.tenant_id AND a.project_id=p.id AND a.deleted_at IS NULL) artifact_count
        FROM projects p WHERE p.tenant_id=$1 AND ($2 OR p.archived_at IS NULL) AND ($3::text IS NULL OR p.title ILIKE '%'||$3||'%') ORDER BY p.updated_at DESC,p.id LIMIT 500`,
        [tenantId,includeArchived,q||null]);
      return {items:r.rows.map(serializeProject)};
    });
  }
  async createProject(principal,tenantId,{title,kind='general',description=''}={}){
    TITLE(title);check(PROJECT_KINDS.includes(kind),'unsupported_workspace_kind');check(typeof description==='string'&&description.length<=4000,'invalid_description');
    return this.scope(principal,tenantId,'member',async db=>{
      const r=await db.query('INSERT INTO projects(tenant_id,owner_id,title,kind,description) VALUES($1,$2,$3,$4,$5) RETURNING *',[tenantId,principal.identityId,title.trim(),kind,description]);
      return serializeProject(r.rows[0]);
    });
  }
  async getProject(principal,tenantId,projectId){
    requireUUID(projectId,'project');
    return this.scope(principal,tenantId,'viewer',async db=>{
      const r=await db.query(`SELECT p.*,(SELECT count(*) FROM project_artifacts a WHERE a.tenant_id=p.tenant_id AND a.project_id=p.id AND a.deleted_at IS NULL) artifact_count,
        (SELECT count(*) FROM runs x WHERE x.tenant_id=p.tenant_id AND x.project_id=p.id) run_count FROM projects p WHERE p.tenant_id=$1 AND p.id=$2`,[tenantId,projectId]);
      check(r.rows[0],'project_not_found',404);return serializeProject(r.rows[0]);
    });
  }
  async updateProject(principal,tenantId,projectId,{title,kind,description,archived,expectedRevision}={}){
    requireUUID(projectId,'project');
    if(title!==undefined)TITLE(title);if(kind!==undefined)check(PROJECT_KINDS.includes(kind),'unsupported_workspace_kind');
    if(description!==undefined)check(typeof description==='string'&&description.length<=4000,'invalid_description');
    return this.scope(principal,tenantId,'member',async db=>{
      const cur=(await db.query('SELECT * FROM projects WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[tenantId,projectId])).rows[0];
      check(cur,'project_not_found',404);
      if(expectedRevision!==undefined)check(Number(cur.current_revision)===expectedRevision,'revision_conflict',409);
      const r=await db.query(`UPDATE projects SET title=$3,kind=$4,description=$5,archived_at=CASE WHEN $6::boolean IS NULL THEN archived_at WHEN $6 THEN coalesce(archived_at,now()) ELSE NULL END,
        current_revision=current_revision+1,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *`,
        [tenantId,projectId,title?.trim()??cur.title,kind??cur.kind,description??cur.description,archived===undefined?null:Boolean(archived)]);
      return serializeProject(r.rows[0]);
    });
  }
  async deleteProject(principal,tenantId,projectId){
    requireUUID(projectId,'project');
    return this.scope(principal,tenantId,'admin',async db=>{
      const r=await db.query('DELETE FROM projects WHERE tenant_id=$1 AND id=$2',[tenantId,projectId]);check(r.rowCount===1,'project_not_found',404);return {deleted:true};
    });
  }

  // ---- artifacts ----
  async listArtifacts(principal,tenantId,projectId,{kind,q}={}){
    requireUUID(projectId,'project');
    return this.scope(principal,tenantId,'viewer',async db=>{
      check((await db.query('SELECT 1 FROM projects WHERE tenant_id=$1 AND id=$2',[tenantId,projectId])).rowCount,'project_not_found',404);
      const r=await db.query(`SELECT a.*,v.media_type,v.sha256,v.body,v.asset_id,v.provenance FROM project_artifacts a JOIN artifact_revisions v ON v.tenant_id=a.tenant_id AND v.artifact_id=a.id AND v.revision=a.current_revision
        WHERE a.tenant_id=$1 AND a.project_id=$2 AND a.deleted_at IS NULL AND ($3::text IS NULL OR a.kind=$3) AND ($4::text IS NULL OR a.title ILIKE '%'||$4||'%') ORDER BY a.updated_at DESC,a.id LIMIT 1000`,
        [tenantId,projectId,kind||null,q||null]);
      return {items:r.rows.map(x=>serializeArtifact(x))};
    });
  }
  async getArtifact(principal,tenantId,projectId,artifactId,{revision}={}){
    requireUUID(projectId,'project');requireUUID(artifactId,'artifact');
    return this.scope(principal,tenantId,'viewer',async db=>{
      const r=await db.query(`SELECT a.id,a.project_id,a.title,a.kind,a.run_id,a.current_revision,a.created_at,a.updated_at,v.revision,v.media_type,v.sha256,v.body,v.asset_id,v.provenance
        FROM project_artifacts a JOIN artifact_revisions v ON v.tenant_id=a.tenant_id AND v.artifact_id=a.id AND v.revision=coalesce($4,a.current_revision)
        WHERE a.tenant_id=$1 AND a.project_id=$2 AND a.id=$3 AND a.deleted_at IS NULL`,[tenantId,projectId,artifactId,revision??null]);
      check(r.rows[0],'artifact_not_found',404);
      const x=r.rows[0];return {...serializeArtifact(x,{withBody:true}),revision:Number(x.revision),currentRevision:Number(x.current_revision)};
    });
  }
  async createArtifact(principal,tenantId,projectId,input){
    requireUUID(projectId,'project');const c=normalizeContent(input);
    const title=TITLE(input.title||'Untitled');const kind=typeof input.kind==='string'&&/^[a-z][a-z0-9_-]{0,63}$/.test(input.kind)?input.kind:'document';
    if(c.assetId){const m=await this.assets.meta({tenantId,assetId:c.assetId});check(m.projectId===projectId,'asset_wrong_project',422);c.mediaType=m.mediaType;c.checksum=m.sha256;}
    return this.scope(principal,tenantId,'member',async db=>{
      check((await db.query('SELECT 1 FROM projects WHERE tenant_id=$1 AND id=$2',[tenantId,projectId])).rowCount,'project_not_found',404);
      const a=await db.query('INSERT INTO project_artifacts(tenant_id,project_id,title,kind) VALUES($1,$2,$3,$4) RETURNING *',[tenantId,projectId,title,kind]);
      await db.query(`INSERT INTO artifact_revisions(tenant_id,artifact_id,revision,media_type,sha256,body,asset_id,provenance,created_by) VALUES($1,$2,1,$3,$4,$5,$6,$7,$8)`,
        [tenantId,a.rows[0].id,c.mediaType,c.checksum,c.body===undefined?null:JSON.stringify(c.body),c.assetId||null,JSON.stringify(isObject(input.provenance)?input.provenance:{source:'user'}),principal.identityId]);
      await db.query('UPDATE projects SET updated_at=now() WHERE tenant_id=$1 AND id=$2',[tenantId,projectId]);
      return {...serializeArtifact({...a.rows[0],media_type:c.mediaType,sha256:c.checksum,body:c.body??null,asset_id:c.assetId,provenance:input.provenance||{source:'user'}},{withBody:true})};
    });
  }
  async reviseArtifact(principal,tenantId,projectId,artifactId,input){
    requireUUID(projectId,'project');requireUUID(artifactId,'artifact');
    const c=normalizeContent(input);
    if(c.assetId){const m=await this.assets.meta({tenantId,assetId:c.assetId});check(m.projectId===projectId,'asset_wrong_project',422);c.mediaType=m.mediaType;c.checksum=m.sha256;}
    return this.scope(principal,tenantId,'member',async db=>{
      const cur=(await db.query('SELECT * FROM project_artifacts WHERE tenant_id=$1 AND project_id=$2 AND id=$3 AND deleted_at IS NULL FOR UPDATE',[tenantId,projectId,artifactId])).rows[0];
      check(cur,'artifact_not_found',404);
      if(input.expectedRevision!==undefined)check(Number(cur.current_revision)===input.expectedRevision,'revision_conflict',409,'Artifact changed since you loaded it');
      const rev=Number(cur.current_revision)+1;
      const title=input.title!==undefined?TITLE(input.title):cur.title;
      await db.query('UPDATE project_artifacts SET current_revision=$2,title=$3,updated_at=now() WHERE id=$1',[artifactId,rev,title]);
      await db.query(`INSERT INTO artifact_revisions(tenant_id,artifact_id,revision,media_type,sha256,body,asset_id,provenance,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [tenantId,artifactId,rev,c.mediaType,c.checksum,c.body===undefined?null:JSON.stringify(c.body),c.assetId||null,JSON.stringify(isObject(input.provenance)?input.provenance:{source:'user-edit'}),principal.identityId]);
      await db.query('UPDATE projects SET updated_at=now() WHERE tenant_id=$1 AND id=$2',[tenantId,projectId]);
      return {id:artifactId,projectId,title,kind:cur.kind,mediaType:c.mediaType,checksum:c.checksum,revision:rev,assetId:c.assetId||null,body:c.body??null};
    });
  }
  async history(principal,tenantId,projectId,artifactId){
    requireUUID(projectId,'project');requireUUID(artifactId,'artifact');
    return this.scope(principal,tenantId,'viewer',async db=>{
      check((await db.query('SELECT 1 FROM project_artifacts WHERE tenant_id=$1 AND project_id=$2 AND id=$3',[tenantId,projectId,artifactId])).rowCount,'artifact_not_found',404);
      const r=await db.query(`SELECT v.revision,v.media_type,v.sha256,v.asset_id,v.provenance,v.created_at,v.created_by,i.display_name,
        CASE WHEN v.body IS NULL THEN NULL WHEN jsonb_typeof(v.body)='string' THEN left(v.body#>>'{}',280) ELSE left(v.body::text,280) END preview
        FROM artifact_revisions v LEFT JOIN identities i ON i.id=v.created_by WHERE v.tenant_id=$1 AND v.artifact_id=$2 ORDER BY v.revision DESC`,[tenantId,artifactId]);
      return {items:r.rows.map(x=>({revision:x.revision,mediaType:x.media_type,checksum:x.sha256,assetId:x.asset_id,provenance:x.provenance,createdAt:x.created_at,createdBy:x.created_by,createdByName:x.display_name,preview:x.preview}))};
    });
  }
  async restore(principal,tenantId,projectId,artifactId,{revision,expectedRevision}){
    check(Number.isSafeInteger(revision)&&revision>=1,'invalid_revision');
    const old=await this.getArtifact(principal,tenantId,projectId,artifactId,{revision});
    return this.reviseArtifact(principal,tenantId,projectId,artifactId,{expectedRevision,...(old.assetId?{assetId:old.assetId}:{body:old.body}),mediaType:old.mediaType,provenance:{source:'restore',restoredFromRevision:revision}});
  }
  async deleteArtifact(principal,tenantId,projectId,artifactId){
    requireUUID(projectId,'project');requireUUID(artifactId,'artifact');
    return this.scope(principal,tenantId,'member',async db=>{
      const r=await db.query('UPDATE project_artifacts SET deleted_at=now(),updated_at=now() WHERE tenant_id=$1 AND project_id=$2 AND id=$3 AND deleted_at IS NULL',[tenantId,projectId,artifactId]);
      check(r.rowCount===1,'artifact_not_found',404);return {deleted:true};
    });
  }

  /** Full project export: metadata, every artifact revision, workspace files, and (optionally) embedded binary assets. */
  async exportProject(principal,tenantId,projectId,{embedAssets=true}={}){
    const project=await this.getProject(principal,tenantId,projectId);
    return this.scope(principal,tenantId,'viewer',async db=>{
      const arts=await db.query('SELECT * FROM project_artifacts WHERE tenant_id=$1 AND project_id=$2 AND deleted_at IS NULL ORDER BY created_at,id',[tenantId,projectId]);
      const out=[];const assetIds=new Set();
      for(const a of arts.rows){
        const revs=await db.query('SELECT revision,media_type,sha256,body,asset_id,provenance,created_at FROM artifact_revisions WHERE tenant_id=$1 AND artifact_id=$2 ORDER BY revision',[tenantId,a.id]);
        for(const v of revs.rows)if(v.asset_id)assetIds.add(v.asset_id);
        out.push({id:a.id,title:a.title,kind:a.kind,currentRevision:a.current_revision,revisions:revs.rows.map(v=>({revision:v.revision,mediaType:v.media_type,checksum:v.sha256,body:v.body,assetId:v.asset_id,provenance:v.provenance,createdAt:v.created_at}))});
      }
      const files=await db.query('SELECT path,content,revision,sha256,updated_at FROM workspace_files WHERE tenant_id=$1 AND project_id=$2 ORDER BY path',[tenantId,projectId]);
      const assets={};
      if(embedAssets)for(const id of assetIds){const a=await this.assets.read({tenantId,assetId:id});assets[id]={mediaType:a.mediaType,sha256:a.sha256,base64:a.bytes.toString('base64')};}
      const manifest={format:'superintelligence-engine/project-export',schemaVersion:2,exportedAt:new Date().toISOString(),project,artifacts:out,
        workspaceFiles:files.rows.map(f=>({path:f.path,content:f.content,revision:f.revision,sha256:f.sha256})),assets,binaryAssetsEmbedded:embedAssets};
      return {...manifest,sha256:sha256(JSON.stringify(manifest))};
    });
  }
  /** Import an export bundle as a new project (current revisions and full history preserved in order). */
  async importProject(principal,tenantId,bundle){
    check(isObject(bundle)&&bundle.format==='superintelligence-engine/project-export'&&isObject(bundle.project)&&Array.isArray(bundle.artifacts),'invalid_export_bundle');
    const {sha256:digest,...rest}=bundle;
    if(digest)check(sha256(JSON.stringify(rest))===digest,'export_checksum_mismatch',422);
    const project=await this.createProject(principal,tenantId,{title:bundle.project.title,kind:PROJECT_KINDS.includes(bundle.project.kind)?bundle.project.kind:'general',description:bundle.project.description||''});
    const assetMap={};
    for(const [oldId,a] of Object.entries(bundle.assets||{})){
      const bytes=Buffer.from(a.base64,'base64');check(sha256(bytes)===a.sha256,'asset_checksum_mismatch',422);
      assetMap[oldId]=(await this.assets.put({tenantId,projectId:project.id,bytes,mediaType:a.mediaType,origin:'import'})).id;
    }
    for(const art of bundle.artifacts.slice(0,5000)){
      let created=null;
      for(const v of art.revisions||[]){
        const content=v.assetId?(assetMap[v.assetId]?{assetId:assetMap[v.assetId]}:null):{body:v.body,mediaType:v.mediaType};
        if(!content)continue;
        const prov={...(isObject(v.provenance)?v.provenance:{}),importedFrom:bundle.project.id,importedRevision:v.revision};
        created=created?await this.reviseArtifact(principal,tenantId,project.id,created.id,{...content,provenance:prov})
          :await this.createArtifact(principal,tenantId,project.id,{title:art.title,kind:art.kind,...content,provenance:prov});
      }
    }
    for(const f of (bundle.workspaceFiles||[]).slice(0,2000)){
      await this.scope(principal,tenantId,'member',db=>db.query(`INSERT INTO workspace_files(tenant_id,project_id,path,content,sha256,updated_by) VALUES($1,$2,$3,$4,$5,$6)`,[tenantId,project.id,f.path,f.content,sha256(f.content),principal.identityId]));
    }
    return this.getProject(principal,tenantId,project.id);
  }

  // ---- engine-internal (worker) writes, already authorized at run creation ----
  async systemCreateArtifact({tenantId,projectId,identityId,runId=null,title,kind='document',content,provenance={}}){
    const c=normalizeContent(content);
    if(c.assetId){const m=await this.assets.meta({tenantId,assetId:c.assetId});c.mediaType=m.mediaType;c.checksum=m.sha256;}
    return tx(this.system,async db=>{
      const a=await db.query('INSERT INTO project_artifacts(tenant_id,project_id,title,kind,run_id) VALUES($1,$2,$3,$4,$5) RETURNING id',[tenantId,projectId,TITLE(String(title).slice(0,256)||'Output'),kind,runId]);
      await db.query(`INSERT INTO artifact_revisions(tenant_id,artifact_id,revision,media_type,sha256,body,asset_id,provenance,created_by) VALUES($1,$2,1,$3,$4,$5,$6,$7,$8)`,
        [tenantId,a.rows[0].id,c.mediaType,c.checksum,c.body===undefined?null:JSON.stringify(c.body),c.assetId||null,JSON.stringify(provenance),identityId]);
      await db.query('UPDATE projects SET updated_at=now() WHERE tenant_id=$1 AND id=$2',[tenantId,projectId]);
      return {id:a.rows[0].id,mediaType:c.mediaType,checksum:c.checksum};
    });
  }
  async systemReviseArtifact({tenantId,projectId,artifactId,identityId,content,provenance={}}){
    const c=normalizeContent(content);
    return tx(this.system,async db=>{
      const cur=(await db.query('SELECT current_revision FROM project_artifacts WHERE tenant_id=$1 AND project_id=$2 AND id=$3 AND deleted_at IS NULL FOR UPDATE',[tenantId,projectId,artifactId])).rows[0];
      check(cur,'artifact_not_found',404);const rev=cur.current_revision+1;
      await db.query('UPDATE project_artifacts SET current_revision=$2,updated_at=now() WHERE id=$1',[artifactId,rev]);
      await db.query(`INSERT INTO artifact_revisions(tenant_id,artifact_id,revision,media_type,sha256,body,asset_id,provenance,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [tenantId,artifactId,rev,c.mediaType,c.checksum,c.body===undefined?null:JSON.stringify(c.body),c.assetId||null,JSON.stringify(provenance),identityId]);
      return {id:artifactId,revision:rev};
    });
  }
  async systemReadArtifact({tenantId,projectId,artifactId}){
    const r=await this.system.query(`SELECT a.id,a.title,a.kind,a.current_revision,v.media_type,v.body,v.asset_id FROM project_artifacts a JOIN artifact_revisions v ON v.tenant_id=a.tenant_id AND v.artifact_id=a.id AND v.revision=a.current_revision
      WHERE a.tenant_id=$1 AND a.project_id=$2 AND a.id=$3 AND a.deleted_at IS NULL`,[tenantId,projectId,artifactId]);
    check(r.rows[0],'artifact_not_found',404);const x=r.rows[0];
    return {id:x.id,title:x.title,kind:x.kind,revision:x.current_revision,mediaType:x.media_type,body:x.body,assetId:x.asset_id};
  }
  async systemListArtifacts({tenantId,projectId}){
    const r=await this.system.query(`SELECT a.id,a.title,a.kind,a.current_revision,a.updated_at,v.media_type FROM project_artifacts a JOIN artifact_revisions v ON v.tenant_id=a.tenant_id AND v.artifact_id=a.id AND v.revision=a.current_revision
      WHERE a.tenant_id=$1 AND a.project_id=$2 AND a.deleted_at IS NULL ORDER BY a.updated_at DESC LIMIT 200`,[tenantId,projectId]);
    return r.rows.map(x=>({id:x.id,title:x.title,kind:x.kind,revision:x.current_revision,mediaType:x.media_type}));
  }
}
export {requireMembership};
