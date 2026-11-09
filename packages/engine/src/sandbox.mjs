// Isolated execution of untrusted code. Backends:
//   bwrap  (default): Linux namespaces via bubblewrap — no network, private mount/pid/ipc/uts/user
//                     namespaces, read-only system, tmpfs scratch, rlimits (memory, cpu, procs, file size).
//   docker: `docker run --network none --read-only --memory ... --pids-limit ...` per execution.
// There is deliberately no unisolated fallback: if no backend is available execution is refused.
import {spawn,spawnSync} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,readFile,readdir,stat,rm} from 'node:fs/promises';
import {existsSync,realpathSync,lstatSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,relative,sep} from 'node:path';
import {EngineError,check,sha256} from './infra.mjs';

const LANGS={
  python:{file:'main.py',cmd:f=>['python3','-I','-B',f]},
  node:{file:'main.mjs',cmd:f=>[process.execPath,'--max-old-space-size=192',f]},
  javascript:{file:'main.mjs',cmd:f=>[process.execPath,'--max-old-space-size=192',f]},
  bash:{file:'main.sh',cmd:f=>['/bin/bash','--noprofile','--norc',f]},
};
export const SANDBOX_LANGUAGES=Object.keys(LANGS);
const PATH_RE=/^[A-Za-z0-9_.@+-][A-Za-z0-9_./@+-]{0,255}$/;
export function safeRelPath(p){check(typeof p==='string'&&PATH_RE.test(p)&&!p.split('/').includes('..')&&!p.includes('//')&&!p.endsWith('/'),'invalid_path',400,'Invalid file path: '+p);return p;}

function detectBackend(pref=process.env.SIE_SANDBOX||'auto'){
  if(pref==='disabled')return null;
  const has=cmd=>spawnSync('sh',['-c',`command -v ${cmd}`],{stdio:'ignore'}).status===0;
  if((pref==='auto'||pref==='bwrap')&&has('bwrap')){
    const probe=spawnSync('bwrap',['--unshare-all','--die-with-parent','--ro-bind','/usr','/usr','--symlink','usr/bin','/bin','--symlink','usr/lib','/lib','--proc','/proc','--dev','/dev','/bin/true'],{stdio:'ignore',timeout:5000});
    if(probe.status===0)return 'bwrap';
  }
  if((pref==='auto'||pref==='docker')&&has('docker')&&spawnSync('docker',['info'],{stdio:'ignore',timeout:5000}).status===0)return 'docker';
  return null;
}

export class Sandbox {
  constructor({backend,dockerImage=process.env.SIE_SANDBOX_IMAGE||'node:22-bookworm'}={}){
    this.backend=backend===undefined?detectBackend():backend;this.image=dockerImage;
    this.nodeDir=dirname(dirname(realpathSync(process.execPath)));
  }
  info(){return {available:Boolean(this.backend),backend:this.backend,network:'disabled',languages:SANDBOX_LANGUAGES};}
  bwrapArgs(work,{memoryMb,cpuSeconds,maxProcs}){
    const a=['--unshare-all','--die-with-parent','--new-session','--cap-drop','ALL','--hostname','sandbox','--clearenv',
      '--setenv','PATH','/usr/local/bin:/usr/bin:/bin','--setenv','HOME','/work','--setenv','LANG','C.UTF-8','--setenv','PYTHONDONTWRITEBYTECODE','1',
      '--ro-bind','/usr','/usr'];
    for(const d of ['lib','lib64','bin','sbin']){
      const p='/'+d;if(!existsSync(p))continue;
      if(lstatSync(p).isSymbolicLink())a.push('--symlink',`usr/${d}`,p);else a.push('--ro-bind',p,p);
    }
    for(const p of ['/etc/alternatives','/etc/ld.so.cache','/etc/localtime'])if(existsSync(p))a.push('--ro-bind',p,p);
    if(!this.nodeDir.startsWith('/usr/'))a.push('--ro-bind',this.nodeDir,this.nodeDir);
    a.push('--proc','/proc','--dev','/dev','--tmpfs','/tmp','--bind',work,'/work','--chdir','/work','--',
      '/usr/bin/prlimit',`--data=${memoryMb*1024*1024}`,`--cpu=${cpuSeconds}`,`--nproc=${maxProcs}`,`--fsize=${64*1024*1024}`,'--nofile=256','--core=0','--');
    return a;
  }
  /**
   * Execute in isolation. files: {relativePath: content}. Either {language, code} or {command:[...]}
   * Returns {exitCode, stdout, stderr, timedOut, durationMs, files (changed/created, text only)}.
   */
  async run({files={},language,code,command,stdin='',timeoutMs=20000,memoryMb=256,cpuSeconds,maxProcs=64,collect=true}={}){
    if(!this.backend)throw new EngineError('sandbox_unavailable',503,'No isolated sandbox backend (bubblewrap or docker) is available on this host');
    check(Number.isInteger(timeoutMs)&&timeoutMs>=500&&timeoutMs<=600000,'invalid_timeout');
    check(Number.isInteger(memoryMb)&&memoryMb>=32&&memoryMb<=8192,'invalid_memory');
    const work=await mkdtemp(join(tmpdir(),'sie-sbx-'));
    const before=new Map();
    try{
      let total=0;
      for(const [p,content] of Object.entries(files)){
        safeRelPath(p);total+=Buffer.byteLength(content);check(total<=64*1024*1024,'workspace_too_large',413);
        await mkdir(dirname(join(work,p)),{recursive:true});await writeFile(join(work,p),content);before.set(p,sha256(content));
      }
      let argv;
      if(language){
        const L=LANGS[language];check(L,'unsupported_language',400,'Supported: '+SANDBOX_LANGUAGES.join(', '));
        check(typeof code==='string'&&code.length<=1024*1024,'invalid_code');
        const f='.sie_'+L.file;await writeFile(join(work,f),code);before.set(f,sha256(code));
        argv=L.cmd('/work/'+f);
      }else{
        check(Array.isArray(command)&&command.length>=1&&command.length<=64&&command.every(c=>typeof c==='string'&&c.length<=4096),'invalid_command');
        argv=command[0]==='node'?[process.execPath,...command.slice(1)]:command;
      }
      const cpu=cpuSeconds||Math.max(1,Math.ceil(timeoutMs/1000));
      let bin,args;
      if(this.backend==='bwrap'){bin='bwrap';args=[...this.bwrapArgs(work,{memoryMb,cpuSeconds:cpu,maxProcs}),...argv];}
      else{bin='docker';args=['run','--rm','-i','--network','none','--read-only','--tmpfs','/tmp:rw,size=64m','--memory',memoryMb+'m','--pids-limit',String(maxProcs),
        '--cpus','1','--cap-drop','ALL','--security-opt','no-new-privileges','-v',work+':/work','-w','/work','--user','1000:1000',this.image,...argv.map(x=>x===process.execPath?'node':x)];}
      const started=Date.now();
      const result=await new Promise(resolve=>{
        const child=spawn(bin,args,{detached:true,stdio:['pipe','pipe','pipe']});
        const out=[],err=[];let outN=0,errN=0,timedOut=false;const CAP=1024*1024;
        child.stdout.on('data',d=>{if(outN<CAP){out.push(d);outN+=d.length}});
        child.stderr.on('data',d=>{if(errN<CAP){err.push(d);errN+=d.length}});
        const timer=setTimeout(()=>{timedOut=true;try{process.kill(-child.pid,'SIGKILL')}catch{}},timeoutMs);
        child.on('error',e=>{clearTimeout(timer);resolve({exitCode:-1,stdout:'',stderr:'sandbox spawn failed: '+e.message,timedOut:false});});
        child.on('close',(c,sig)=>{clearTimeout(timer);resolve({exitCode:c??(sig?128:-1),signal:sig||null,stdout:Buffer.concat(out).toString('utf8').slice(0,CAP),stderr:Buffer.concat(err).toString('utf8').slice(0,CAP),timedOut,truncated:outN>=CAP||errN>=CAP});});
        child.stdin.on('error',()=>{});child.stdin.end(stdin);
      });
      result.durationMs=Date.now()-started;result.backend=this.backend;
      if(collect){
        result.files={};let count=0;
        const walk=async dir=>{
          for(const e of await readdir(dir,{withFileTypes:true})){
            if(count>=500)return;
            const full=join(dir,e.name),rel=relative(work,full).split(sep).join('/');
            if(e.isDirectory()){if(!['node_modules','.git','__pycache__'].includes(e.name))await walk(full);continue;}
            if(!e.isFile()||rel.startsWith('.sie_'))continue;
            const s=await stat(full);if(s.size>1024*1024)continue;
            const buf=await readFile(full);let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(buf)}catch{continue}
            if(before.get(rel)!==sha256(text)&&PATH_RE.test(rel)){result.files[rel]=text;count++;}
          }
        };
        await walk(work);
      }
      return result;
    }finally{await rm(work,{recursive:true,force:true}).catch(()=>{});}
  }
}
