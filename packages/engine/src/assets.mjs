// Private binary asset storage: content-addressed local files (or a mounted volume),
// verified by content sniffing and, when configured, a ClamAV scan before use.
import {mkdir,readFile,writeFile,rename,stat,readdir,unlink} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {Readable} from 'node:stream';
import {fileTypeFromBuffer} from 'file-type';
import {ClamAVStreamScanner} from '../../storage/src/scanner.mjs';
import {EngineError,check,sha256,requireUUID} from './infra.mjs';

export const MAX_ASSET_BYTES=Number(process.env.SIE_MAX_ASSET_BYTES||50*1024*1024);
const ALLOWED=new Set(['image/png','image/jpeg','image/gif','image/webp','audio/mpeg','audio/wav','audio/ogg','audio/flac','audio/webm','video/mp4','video/webm',
  'application/pdf','text/plain','text/csv','text/markdown','application/json','application/zip']);
const ALIASES={'audio/x-wav':'audio/wav','audio/vnd.wave':'audio/wav','audio/x-flac':'audio/flac','audio/mp3':'audio/mpeg'};
const TEXTUAL=new Set(['text/plain','text/csv','text/markdown','application/json']);

export async function sniff(bytes,declared){
  const d=ALIASES[declared]||declared;
  const ft=await fileTypeFromBuffer(bytes.subarray(0,4100));
  let detected=ft?(ALIASES[ft.mime]||ft.mime):null;
  if(detected==='application/x-msdownload'||detected==='application/x-elf'||detected==='application/x-mach-binary')throw new EngineError('executable_rejected',415);
  if(!detected){
    try{new TextDecoder('utf-8',{fatal:true}).decode(bytes);detected=TEXTUAL.has(d)?d:'text/plain';}
    catch{throw new EngineError('unrecognized_media',415,'File content type could not be verified')}
  }
  if(detected==='video/webm'&&d==='audio/webm')detected='audio/webm';
  check(ALLOWED.has(detected),'unsupported_media',415,'Unsupported media type '+detected);
  if(d&&d!=='application/octet-stream')check(d===detected||(TEXTUAL.has(d)&&TEXTUAL.has(detected)),'media_type_mismatch',415,`Declared ${d} but content is ${detected}`);
  return TEXTUAL.has(d)?d:detected;
}

/** Local filesystem blob backend (content-addressed). */
class FileBlobs {
  constructor(dir){this.dir=join(dir,'assets');}
  path(hash){return join(this.dir,hash.slice(0,2),hash.slice(2,4),hash);}
  async put(hash,bytes){const p=this.path(hash);await mkdir(dirname(p),{recursive:true});try{await stat(p)}catch{const tmp=p+'.'+process.pid+'.'+Date.now()+'.tmp';await writeFile(tmp,bytes);await rename(tmp,p);}return 'local:'+hash;}
  async get(hash){return readFile(this.path(hash));}
  async *list(){
    let a;try{a=await readdir(this.dir)}catch{return}
    for(const x of a)for(const y of await readdir(join(this.dir,x)).catch(()=>[]))for(const f of await readdir(join(this.dir,x,y)).catch(()=>[]))if(/^[a-f0-9]{64}$/.test(f))yield f;
  }
  async remove(hash){await unlink(this.path(hash)).catch(()=>{});}
}
/** S3-compatible object storage backend (AWS S3, R2, MinIO, ...). Objects are private; access is via the API only. */
class S3Blobs {
  constructor({bucket,region,endpoint,prefix='assets/'}){
    this.bucket=bucket;this.prefix=prefix;
    this.ready=import('@aws-sdk/client-s3').then(m=>{this.m=m;this.client=new m.S3Client({region:region||'us-east-1',...(endpoint?{endpoint,forcePathStyle:true}:{})});});
  }
  async put(hash,bytes,mediaType){await this.ready;
    try{await this.client.send(new this.m.HeadObjectCommand({Bucket:this.bucket,Key:this.prefix+hash}));}
    catch{await this.client.send(new this.m.PutObjectCommand({Bucket:this.bucket,Key:this.prefix+hash,Body:bytes,ContentType:mediaType,ServerSideEncryption:process.env.SIE_S3_SSE||undefined}));}
    return 's3:'+hash;}
  async get(hash){await this.ready;const r=await this.client.send(new this.m.GetObjectCommand({Bucket:this.bucket,Key:this.prefix+hash}));return Buffer.from(await r.Body.transformToByteArray());}
}

export class AssetStore {
  constructor({dir=process.env.SIE_STORAGE_DIR||'./var/storage',system,clamSocket=process.env.CLAMAV_SOCKET,s3=process.env.SIE_S3_BUCKET?{bucket:process.env.SIE_S3_BUCKET,region:process.env.SIE_S3_REGION,endpoint:process.env.SIE_S3_ENDPOINT}:null}={}){
    this.blobs=s3?new S3Blobs(s3):new FileBlobs(dir);this.db=system;this.scanner=clamSocket?new ClamAVStreamScanner({socketPath:clamSocket}):null;
  }
  /** Store bytes for a tenant project after verification. Returns asset metadata. */
  async put({tenantId,projectId,bytes,mediaType,origin='upload',expires=null}){
    requireUUID(tenantId,'tenant');requireUUID(projectId,'project');
    check(Buffer.isBuffer(bytes)&&bytes.length>0,'empty_asset');
    check(bytes.length<=MAX_ASSET_BYTES,'asset_too_large',413);
    const verified=await sniff(bytes,mediaType);
    if(this.scanner){
      const v=await this.scanner.scan(Readable.from([bytes]));
      if(!v.clean)throw new EngineError('malware_detected',422);
    }
    const hash=sha256(bytes);
    const key=await this.blobs.put(hash,bytes,verified);
    const r=await this.db.query(`INSERT INTO asset_metadata(tenant_id,project_id,storage_key,media_type,sha256,size_bytes,scan_state,verified_at,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,'clean',now(),$7) RETURNING id`,[tenantId,projectId,key,verified,hash,bytes.length,expires]);
    return {id:r.rows[0].id,mediaType:verified,sha256:hash,sizeBytes:bytes.length,origin};
  }
  async read({tenantId,assetId}){
    requireUUID(assetId,'asset');
    const r=await this.db.query("SELECT storage_key,media_type,sha256,size_bytes FROM asset_metadata WHERE tenant_id=$1 AND id=$2 AND scan_state='clean'",[tenantId,assetId]);
    const a=r.rows[0];check(a,'asset_not_found',404);
    const bytes=await this.blobs.get(a.sha256);
    check(sha256(bytes)===a.sha256,'asset_integrity_failure',500);
    return {bytes,mediaType:a.media_type,sha256:a.sha256,sizeBytes:Number(a.size_bytes)};
  }
  /** Delete stored blobs no asset row references (projects deleted, imports replaced). Local backend only. */
  async gc({minAgeMs=3600000}={}){
    if(!this.blobs.list)return {removed:0};
    let removed=0;
    for await(const hash of this.blobs.list()){
      const st=await stat(this.blobs.path(hash)).catch(()=>null);if(!st||Date.now()-st.mtimeMs<minAgeMs)continue;
      const used=(await this.db.query('SELECT 1 FROM asset_metadata WHERE sha256=$1 LIMIT 1',[hash])).rowCount;
      if(!used){await this.blobs.remove(hash);removed++;}
    }
    return {removed};
  }
  async meta({tenantId,assetId}){
    const r=await this.db.query("SELECT id,project_id,media_type,sha256,size_bytes,created_at FROM asset_metadata WHERE tenant_id=$1 AND id=$2 AND scan_state='clean'",[tenantId,assetId]);
    check(r.rows[0],'asset_not_found',404);const a=r.rows[0];
    return {id:a.id,projectId:a.project_id,mediaType:a.media_type,sha256:a.sha256,sizeBytes:Number(a.size_bytes),createdAt:a.created_at};
  }
}
