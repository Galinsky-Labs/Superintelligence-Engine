// Code workspace: persistent project files with history, isolated execution, tests,
// diagnostics, Git history (server-side repository per project) and signed previews.
import {spawn} from 'node:child_process';
import {createHmac,timingSafeEqual} from 'node:crypto';
import {mkdir,writeFile,rm,readdir,readFile,mkdtemp} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {EngineError,check,fail,sha256,requireUUID,requireMembership,withTenant,tx,randomToken} from './infra.mjs';
import {safeRelPath} from './sandbox.mjs';

const MAX_FILE=1024*1024,MAX_FILES=2000;
function git(args,{cwd,env={},input}={}){
  return new Promise((resolve,reject)=>{
    const p=spawn('git',['-c','core.hooksPath=/dev/null','-c','protocol.file.allow=never','-c','credential.helper=','-c','init.defaultBranch=main',...args],
      {cwd,env:{PATH:process.env.PATH,HOME:cwd||tmpdir(),GIT_TERMINAL_PROMPT:'0',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',...env},stdio:['pipe','pipe','pipe']});
    let out='',err='';p.stdout.on('data',d=>{if(out.length<4e6)out+=d});p.stderr.on('data',d=>{if(err.length<1e5)err+=d});
    p.on('error',reject);p.on('close',c=>c===0?resolve(out):reject(new EngineError('git_failed',500,err.replace(/https:\/\/[^@\s]+@/g,'https://***@').slice(0,500))));
    p.stdin.end(input||'');
  });
}

export class Workspace {
  constructor({system,tenant,sandbox,storageDir=process.env.SIE_STORAGE_DIR||'./var/storage',previewSecret}){
    this.db=system;this.tenant=tenant;this.sandbox=sandbox;this.gitRoot=join(storageDir,'git');this.secret=previewSecret||randomToken(32);
  }
  async list(principal,tenantId,projectId){
    requireUUID(projectId,'project');
    return withTenant(this.tenant,principal,tenantId,'viewer',async db=>{
      const r=await db.query('SELECT path,revision,sha256,length(content) size,updated_at FROM workspace_files WHERE tenant_id=$1 AND project_id=$2 ORDER BY path',[tenantId,projectId]);
      return {items:r.rows.map(f=>({path:f.path,revision:f.revision,sha256:f.sha256,size:Number(f.size),updatedAt:f.updated_at}))};
    });
  }
  async read(principal,tenantId,projectId,path){
    requireUUID(projectId,'project');safeRelPath(path);
    return withTenant(this.tenant,principal,tenantId,'viewer',async db=>{
      const r=await db.query('SELECT path,content,revision,sha256,updated_at FROM workspace_files WHERE tenant_id=$1 AND project_id=$2 AND path=$3',[tenantId,projectId,path]);
      check(r.rows[0],'file_not_found',404);const f=r.rows[0];return {path:f.path,content:f.content,revision:f.revision,sha256:f.sha256,updatedAt:f.updated_at};
    });
  }
  async history(principal,tenantId,projectId,path){
    requireUUID(projectId,'project');safeRelPath(path);
    return withTenant(this.tenant,principal,tenantId,'viewer',async db=>{
      const r=await db.query('SELECT revision,deleted,sha256,created_at,updated_by,content FROM workspace_file_versions WHERE tenant_id=$1 AND project_id=$2 AND path=$3 ORDER BY revision DESC LIMIT 200',[tenantId,projectId,path]);
      return {items:r.rows.map(v=>({revision:v.revision,deleted:v.deleted,sha256:v.sha256,createdAt:v.created_at,updatedBy:v.updated_by,content:v.content}))};
    });
  }
  async writeWith(db,{tenantId,projectId,identityId},path,content,expectedRevision){
    safeRelPath(path);check(typeof content==='string'&&Buffer.byteLength(content)<=MAX_FILE,'invalid_content',413,'Files are limited to 1MB of text');
    const cur=(await db.query('SELECT revision FROM workspace_files WHERE tenant_id=$1 AND project_id=$2 AND path=$3 FOR UPDATE',[tenantId,projectId,path])).rows[0];
    if(expectedRevision!==undefined&&expectedRevision!==null)check((cur?.revision??0)===expectedRevision,'revision_conflict',409,'File changed since you loaded it');
    if(!cur){const n=(await db.query('SELECT count(*)::int n FROM workspace_files WHERE tenant_id=$1 AND project_id=$2',[tenantId,projectId])).rows[0].n;check(n<MAX_FILES,'too_many_files',413);}
    const last=(await db.query('SELECT coalesce(max(revision),0) r FROM workspace_file_versions WHERE tenant_id=$1 AND project_id=$2 AND path=$3',[tenantId,projectId,path])).rows[0].r;
    const rev=Math.max(cur?.revision??0,last)+1,h=sha256(content);
    if(cur)await db.query('UPDATE workspace_files SET content=$4,revision=$5,sha256=$6,updated_by=$7,updated_at=now() WHERE tenant_id=$1 AND project_id=$2 AND path=$3',[tenantId,projectId,path,content,rev,h,identityId]);
    else await db.query('INSERT INTO workspace_files(tenant_id,project_id,path,content,revision,sha256,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7)',[tenantId,projectId,path,content,rev,h,identityId]);
    await db.query('INSERT INTO workspace_file_versions(tenant_id,project_id,path,revision,content,sha256,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7)',[tenantId,projectId,path,rev,content,h,identityId]);
    return {path,revision:rev,sha256:h};
  }
  async write(principal,tenantId,projectId,path,{content,expectedRevision}){
    requireUUID(projectId,'project');
    return withTenant(this.tenant,principal,tenantId,'member',async db=>{
      check((await db.query('SELECT 1 FROM projects WHERE tenant_id=$1 AND id=$2',[tenantId,projectId])).rowCount,'project_not_found',404);
      return this.writeWith(db,{tenantId,projectId,identityId:principal.identityId},path,content,expectedRevision);
    });
  }
  async remove(principal,tenantId,projectId,path){
    requireUUID(projectId,'project');safeRelPath(path);
    return withTenant(this.tenant,principal,tenantId,'member',async db=>{
      const cur=(await db.query('DELETE FROM workspace_files WHERE tenant_id=$1 AND project_id=$2 AND path=$3 RETURNING revision',[tenantId,projectId,path])).rows[0];
      check(cur,'file_not_found',404);
      await db.query('INSERT INTO workspace_file_versions(tenant_id,project_id,path,revision,content,deleted,updated_by) VALUES($1,$2,$3,$4,NULL,true,$5)',[tenantId,projectId,path,cur.revision+1,principal.identityId]);
      return {deleted:true};
    });
  }
  // ---- system (agents) ----
  async systemFiles(tenantId,projectId){
    const r=await this.db.query('SELECT path,content FROM workspace_files WHERE tenant_id=$1 AND project_id=$2',[tenantId,projectId]);
    return Object.fromEntries(r.rows.map(f=>[f.path,f.content]));
  }
  async systemWrite(ctx,path,content){return tx(this.db,db=>this.writeWith(db,ctx,path,content));}
  async systemRead(tenantId,projectId,path){
    safeRelPath(path);const r=await this.db.query('SELECT content,revision FROM workspace_files WHERE tenant_id=$1 AND project_id=$2 AND path=$3',[tenantId,projectId,path]);
    check(r.rows[0],'file_not_found',404);return r.rows[0];
  }
  async systemList(tenantId,projectId){return (await this.db.query('SELECT path,length(content) size,revision FROM workspace_files WHERE tenant_id=$1 AND project_id=$2 ORDER BY path',[tenantId,projectId])).rows.map(r=>({path:r.path,size:Number(r.size),revision:r.revision}));}

  /** Run a command against the project files inside the sandbox; optionally persist produced files. */
  async exec({tenantId,projectId,identityId,command,language,code,timeoutMs=60000,memoryMb=512,persist=false,stdin}){
    const files=await this.systemFiles(tenantId,projectId);
    const res=await this.sandbox.run({files,command,language,code,timeoutMs,memoryMb,stdin});
    const changed=Object.keys(res.files||{});
    if(persist&&changed.length){for(const p of changed.slice(0,200))await this.systemWrite({tenantId,projectId,identityId},p,res.files[p]);}
    return {exitCode:res.exitCode,stdout:res.stdout,stderr:res.stderr,timedOut:res.timedOut,durationMs:res.durationMs,backend:res.backend,changedFiles:changed,persisted:persist?changed.slice(0,200):[]};
  }
  async userExec(principal,tenantId,projectId,body){
    await requireMembership(this.db,principal,tenantId,'member');requireUUID(projectId,'project');
    check((await this.db.query('SELECT 1 FROM projects WHERE tenant_id=$1 AND id=$2',[tenantId,projectId])).rowCount,'project_not_found',404);
    const {command,language,code,timeoutMs,persist,stdin}=body||{};
    return this.exec({tenantId,projectId,identityId:principal.identityId,command,language,code,timeoutMs:timeoutMs??60000,persist:Boolean(persist),stdin});
  }
  /** Test runner: detects the project's test setup when no command is given. */
  async test(principal,tenantId,projectId,{command}={}){
    if(!command){
      const files=await this.systemFiles(tenantId,projectId);const names=Object.keys(files);
      if(names.some(n=>/(^|\/)test_.*\.py$|_test\.py$/.test(n)))command=['python3','-m','unittest','discover','-v','-p','*test*.py'];
      else if(names.some(n=>/\.test\.m?js$/.test(n)))command=['node','--test'];
      else fail('no_tests_found',400,'No tests found (expected test_*.py or *.test.mjs files) and no command provided');
    }
    const r=await this.userExec(principal,tenantId,projectId,{command,timeoutMs:120000});
    return {...r,passed:r.exitCode===0&&!r.timedOut,command};
  }
  /** Syntax diagnostics for supported languages, executed in the sandbox. */
  async diagnostics(principal,tenantId,projectId){
    await requireMembership(this.db,principal,tenantId,'viewer');
    const files=await this.systemFiles(tenantId,projectId);
    const script=`import json,sys,py_compile,subprocess,os
out=[]
for root,_,fs in os.walk('.'):
  for f in fs:
    p=os.path.join(root,f)[2:]
    if p.startswith('.sie_'):continue
    if p.endswith('.py'):
      try: py_compile.compile(p,doraise=True)
      except py_compile.PyCompileError as e: out.append({'path':p,'severity':'error','message':str(e.msg).strip()[-400:]})
    elif p.endswith(('.js','.mjs','.cjs')):
      r=subprocess.run([${JSON.stringify(process.execPath)},'--check',p],capture_output=True,text=True)
      if r.returncode: out.append({'path':p,'severity':'error','message':r.stderr.strip()[-400:]})
    elif p.endswith('.json'):
      try: json.load(open(p))
      except Exception as e: out.append({'path':p,'severity':'error','message':str(e)})
print(json.dumps(out))`;
    const r=await this.sandbox.run({files,language:'python',code:script,timeoutMs:30000,collect:false});
    let items=[];try{items=JSON.parse(r.stdout.trim().split('\n').pop()||'[]')}catch{}
    return {items,checked:Object.keys(files).length};
  }

  // ---- Git ----
  repoDir(tenantId,projectId){return join(this.gitRoot,tenantId,projectId);}
  async ensureRepo(tenantId,projectId){
    const dir=this.repoDir(tenantId,projectId);
    await mkdir(dir,{recursive:true});
    try{await git(['rev-parse','--git-dir'],{cwd:dir})}catch{await git(['init','-q'],{cwd:dir});}
    return dir;
  }
  async commit(principal,tenantId,projectId,{message}){
    await requireMembership(this.db,principal,tenantId,'member');requireUUID(projectId,'project');
    check(typeof message==='string'&&message.trim().length>=1&&message.length<=2000,'invalid_message');
    const dir=await this.ensureRepo(tenantId,projectId);
    const files=await this.systemFiles(tenantId,projectId);
    for(const e of await readdir(dir))if(e!=='.git')await rm(join(dir,e),{recursive:true,force:true});
    for(const [p,c] of Object.entries(files)){await mkdir(dirname(join(dir,p)),{recursive:true});await writeFile(join(dir,p),c);}
    await git(['add','-A'],{cwd:dir});
    const status=await git(['status','--porcelain'],{cwd:dir});
    const id=(await this.db.query('SELECT display_name,email FROM identities WHERE id=$1',[principal.identityId])).rows[0]||{};
    if(!status.trim()){
      try{const head=(await git(['rev-parse','HEAD'],{cwd:dir})).trim();return {commit:head,changed:false};}catch{}
    }
    await git(['commit','-q','--allow-empty','-m',message],{cwd:dir,env:{GIT_AUTHOR_NAME:id.display_name||'Engine user',GIT_AUTHOR_EMAIL:id.email||'user@engine.local',GIT_COMMITTER_NAME:'Superintelligence Engine',GIT_COMMITTER_EMAIL:'engine@engine.local'}});
    return {commit:(await git(['rev-parse','HEAD'],{cwd:dir})).trim(),changed:true};
  }
  async log(principal,tenantId,projectId){
    await requireMembership(this.db,principal,tenantId,'viewer');
    const dir=await this.ensureRepo(tenantId,projectId);
    try{
      const out=await git(['log','-n','100','--pretty=format:%H%x1f%an%x1f%aI%x1f%s','--shortstat'],{cwd:dir});
      const items=[];
      for(const block of out.split(/\n(?=[0-9a-f]{40}\x1f)/)){const [head,stat='']=block.split('\n');const [hash,author,date,subject]=head.split('\x1f');if(hash)items.push({commit:hash,author,date,message:subject,stat:stat.trim()});}
      return {items};
    }catch{return {items:[]}}
  }
  async diff(principal,tenantId,projectId,{from,to}={}){
    await requireMembership(this.db,principal,tenantId,'viewer');
    for(const c of [from,to])if(c)check(/^[0-9a-f]{7,40}$/.test(c),'invalid_commit');
    const dir=await this.ensureRepo(tenantId,projectId);
    if(!from&&!to){ // working changes vs HEAD
      const files=await this.systemFiles(tenantId,projectId);
      const scratch=await mkdtemp(join(tmpdir(),'sie-diff-'));
      try{
        await git(['clone','-q',dir,scratch]).catch(async()=>{await git(['init','-q'],{cwd:scratch})});
        for(const e of await readdir(scratch))if(e!=='.git')await rm(join(scratch,e),{recursive:true,force:true});
        for(const [p,c] of Object.entries(files)){await mkdir(dirname(join(scratch,p)),{recursive:true});await writeFile(join(scratch,p),c);}
        await git(['add','-A'],{cwd:scratch});
        return {diff:await git(['diff','--cached','--no-color'],{cwd:scratch}).catch(()=>'')};
      }finally{await rm(scratch,{recursive:true,force:true})}
    }
    return {diff:await git(['diff','--no-color',from||'HEAD~1',to||'HEAD'],{cwd:dir})};
  }
  async checkout(principal,tenantId,projectId,{commit}){
    await requireMembership(this.db,principal,tenantId,'member');check(/^[0-9a-f]{7,40}$/.test(commit||''),'invalid_commit');
    const dir=await this.ensureRepo(tenantId,projectId);
    const list=(await git(['ls-tree','-r','--name-only',commit],{cwd:dir})).split('\n').filter(Boolean);
    const current=await this.systemFiles(tenantId,projectId);
    const ctx={tenantId,projectId,identityId:principal.identityId};
    for(const p of list){const c=await git(['show',`${commit}:${p}`],{cwd:dir});if(current[p]!==c)await this.systemWrite(ctx,p,c);}
    for(const p of Object.keys(current))if(!list.includes(p))await this.remove(principal,tenantId,projectId,p);
    return {restored:list.length,commit};
  }
  /** Push to an external remote. Called only after an approval (consequential external write). */
  async push({tenantId,projectId,remoteUrl,token,branch='main'}){
    const u=new URL(remoteUrl);check(u.protocol==='https:','remote_https_required',400);
    check(/^[A-Za-z0-9._/-]{1,100}$/.test(branch),'invalid_branch');
    const dir=await this.ensureRepo(tenantId,projectId);
    if(token){u.username='x-access-token';u.password=token;}
    await git(['push',u.href,`HEAD:refs/heads/${branch}`],{cwd:dir});
    return {pushed:true,remote:remoteUrl,branch};
  }

  // ---- Preview: signed, short-lived URLs served under a sandboxing CSP ----
  previewToken(tenantId,projectId,ttlSeconds=3600){
    const exp=Math.floor(Date.now()/1000)+ttlSeconds,payload=`${tenantId}.${projectId}.${exp}`;
    return `${exp}.${createHmac('sha256',this.secret).update(payload).digest('base64url')}`;
  }
  verifyPreview(tenantId,projectId,token){
    const [exp,sig]=String(token||'').split('.');if(!exp||!sig||Number(exp)<Date.now()/1000)return false;
    const want=createHmac('sha256',this.secret).update(`${tenantId}.${projectId}.${exp}`).digest();
    const got=Buffer.from(sig,'base64url');return got.length===want.length&&timingSafeEqual(got,want);
  }
}
