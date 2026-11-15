// Engine console. DOM is built with h() (textContent only) so untrusted model output never becomes markup.
const $=s=>document.querySelector(s);
const state={token:sessionStorage.getItem('sie_token')||'',tenant:sessionStorage.getItem('sie_tenant')||'',tenants:[],models:[],caps:null};

function h(tag,attrs={},...children){
  const el=document.createElement(tag);
  for(const [k,v] of Object.entries(attrs||{})){
    if(v===undefined||v===null||v===false)continue;
    if(k.startsWith('on'))el.addEventListener(k.slice(2),v);
    else if(k==='class')el.className=v;
    else if(k==='value')el.value=v;
    else if(k==='checked')el.checked=Boolean(v);
    else el.setAttribute(k,v===true?'':v);
  }
  for(const c of children.flat(Infinity)){if(c===null||c===undefined||c===false)continue;el.append(c instanceof Node?c:document.createTextNode(String(c)));}
  return el;
}
function rc(el,...kids){el.replaceChildren(...kids.flat(Infinity).filter(k=>k!==null&&k!==undefined&&k!==false));return el;}
const stateTag=s=>h('span',{class:'state '+s},s);
const usd=micro=>'$'+(Number(micro||0)/1e6).toFixed(micro&&micro<10000?6:4);
const when=t=>t?new Date(t).toLocaleString():'';
function toast(msg,ms=3500){const t=$('#toast');t.textContent=msg;t.classList.remove('hidden');clearTimeout(toast.t);toast.t=setTimeout(()=>t.classList.add('hidden'),ms);}

async function api(method,path,body,{raw=false,headers={}}={}){
  const res=await fetch(path,{method,headers:{...(state.token?{Authorization:'Bearer '+state.token}:{}),...(state.tenant?{'X-Tenant-Id':state.tenant}:{}),...(body!==undefined&&!(body instanceof Blob)?{'Content-Type':'application/json'}:{}),...headers},
    body:body===undefined?undefined:body instanceof Blob?body:JSON.stringify(body)});
  if(raw)return res;
  const text=await res.text();let data;try{data=text?JSON.parse(text):{}}catch{data={message:text}}
  if(res.status===401&&path!=='/v1/dev/login'){logout();throw new Error('Session expired');}
  if(!res.ok)throw Object.assign(new Error(data.message||data.code||res.statusText),{code:data.code,status:res.status});
  return data;
}
/** POST/GET an SSE endpoint with auth headers and invoke onEvent for each event. */
async function sse(path,{method='GET',body,onEvent,signal}={}){
  const res=await api(method,path,body,{raw:true,headers:body?{'Content-Type':'application/json'}:{}});
  if(!res.ok){const t=await res.text();let d={};try{d=JSON.parse(t)}catch{}throw new Error(d.message||d.code||res.statusText);}
  const reader=res.body.getReader(),dec=new TextDecoder();let buf='';
  signal?.addEventListener('abort',()=>reader.cancel().catch(()=>{}));
  while(true){
    const {done,value}=await reader.read();if(done)break;buf+=dec.decode(value,{stream:true});
    let i;while((i=buf.indexOf('\n\n'))>=0){const frame=buf.slice(0,i);buf=buf.slice(i+2);
      const ev=/^event: (.*)$/m.exec(frame)?.[1];const data=/^data: (.*)$/m.exec(frame)?.[1];if(ev&&data){try{onEvent(ev,JSON.parse(data))}catch(e){console.error(e)}}}
  }
}
async function blobUrl(path){const r=await api('GET',path,undefined,{raw:true});if(!r.ok)throw new Error('download failed');return URL.createObjectURL(await r.blob());}
async function download(path,name){const u=await blobUrl(path);const a=h('a',{href:u,download:name});document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(u),5000);}
const guard=fn=>async(...a)=>{try{return await fn(...a)}catch(e){toast(e.message);console.error(e)}};

// ---------------- auth ----------------
function logout(){state.token='';sessionStorage.removeItem('sie_token');$('#shell').classList.add('hidden');showLogin();}
async function showLogin(){
  $('#login').classList.remove('hidden');
  try{const caps=await (await fetch('/v1/capabilities')).json();$('#dev-form').classList.toggle('hidden',!caps.authentication?.devLogin);$('#sso-box').classList.toggle('hidden',!caps.authentication?.oidc);}catch{}
}
$('#token-form').addEventListener('submit',async e=>{e.preventDefault();state.token=$('#token-input').value.trim();await boot().catch(err=>{$('#login-error').textContent=err.message;});});
$('#dev-form').addEventListener('submit',async e=>{e.preventDefault();
  try{const r=await api('POST','/v1/dev/login',{handle:$('#dev-handle').value.trim()});state.token=r.token;await boot();}catch(err){$('#login-error').textContent=err.message;}});
$('#logout').addEventListener('click',logout);
$('#tenant-select').addEventListener('change',e=>{state.tenant=e.target.value;sessionStorage.setItem('sie_tenant',state.tenant);loadTenantData().then(route);});

async function boot(){
  const me=await api('GET','/v1/me');
  sessionStorage.setItem('sie_token',state.token);
  state.tenants=(await api('GET','/v1/tenants')).items;
  if(!state.tenants.length){await api('POST','/v1/tenants',{name:(me.displayName||'My')+"'s workspace"});state.tenants=(await api('GET','/v1/tenants')).items;}
  if(!state.tenants.find(t=>t.id===state.tenant))state.tenant=state.tenants[0]?.id||'';
  sessionStorage.setItem('sie_tenant',state.tenant);
  rc($('#tenant-select'),...state.tenants.map(t=>h('option',{value:t.id,selected:t.id===state.tenant},`${t.name} (${t.role})`)));
  $('#me').textContent=me.displayName||me.subject;
  $('#login').classList.add('hidden');$('#shell').classList.remove('hidden');
  await loadTenantData();route();
}
async function loadTenantData(){
  state.models=(await api('GET','/v1/models')).items;
  state.caps=await api('GET','/v1/capabilities');
  $('#caps').textContent=state.caps.generationEnabled?`Live providers: ${state.caps.availableProviders.filter(p=>p!=='deterministic').join(', ')}`:(state.caps.simulatedProviderEnabled?'Simulator only (no live provider configured)':'No model provider configured');
  refreshApprovalCount();
}
async function refreshApprovalCount(){try{const n=(await api('GET','/v1/approvals')).items.length;const b=$('#approval-count');b.textContent=n;b.classList.toggle('hidden',!n);}catch{}}

// ---------------- routing ----------------
window.addEventListener('hashchange',()=>route());
function route(){
  const [,section='projects',id,sub]=location.hash.split('/');
  document.querySelectorAll('[data-nav]').forEach(a=>a.classList.toggle('active',a.dataset.nav===section));
  const view=$('#view');rc(view,h('p',{class:'muted'},'Loading…'));
  const pages={projects:()=>id?projectPage(id,sub):projectsPage(),runs:()=>id?runPage(id):runsPage(),approvals:approvalsPage,providers:providersPage,connections:connectionsPage,schedules:schedulesPage,team:teamPage};
  (pages[section]||projectsPage)().then(el=>{rc(view,el);view.focus();}).catch(e=>rc(view,h('p',{class:'error'},e.message)));
}
const modelOptions=(cap='chat')=>[h('option',{value:''},'Automatic (best available)'),...state.models.filter(m=>m.capabilities.includes(cap)).map(m=>h('option',{value:m.provider+'|'+m.model,disabled:!m.available},`${m.label} — ${m.provider}${m.simulated?' [SIMULATED]':''}${!m.available?(m.priceKnown?' (no credential)':' (price not set)'):''}`))];
const parseModel=v=>v?{provider:v.split('|')[0],model:v.split('|').slice(1).join('|')}:undefined;

// ---------------- projects ----------------
async function projectsPage(){
  const list=(await api('GET','/v1/projects')).items;
  const title=h('input',{placeholder:'Project title',required:true}),kind=h('select',{},...['general','research','writing','legislation','code','data','image','music','video','voice','cross-media','workflow'].map(k=>h('option',{value:k},k)));
  const importInput=h('input',{type:'file',accept:'application/json'});
  return h('div',{class:'stack'},
    h('h2',{},'Projects'),
    h('form',{class:'row card',onsubmit:guard(async e=>{e.preventDefault();const p=await api('POST','/v1/projects',{title:title.value,kind:kind.value});location.hash=`#/projects/${p.id}`;})},title,kind,h('button',{type:'submit'},'Create project')),
    h('div',{class:'row'},h('span',{class:'muted'},'Import an exported project:'),importInput,h('button',{class:'secondary',onclick:guard(async()=>{const f=importInput.files[0];if(!f)return;const p=await api('POST','/v1/projects/import',JSON.parse(await f.text()));location.hash=`#/projects/${p.id}`;})},'Import')),
    list.length?h('div',{class:'grid'},list.map(p=>h('a',{class:'card',href:`#/projects/${p.id}`,style:'text-decoration:none;color:inherit'},h('strong',{},p.title),h('div',{class:'muted small'},`${p.kind} · ${p.artifactCount} artifacts · updated ${when(p.updatedAt)}`)))):h('p',{class:'muted'},'No projects yet.'));
}
async function projectPage(id,tab='artifacts'){
  const p=await api('GET',`/v1/projects/${id}`);
  const tabs=[['artifacts','Artifacts'],['generate','Generate'],['workspaces','Domain workspaces'],['workflow','Multi-agent workflow'],['code','Code'],['runs','Runs'],['settings','Settings']];
  const body=h('div',{});
  const render={artifacts:artifactsTab,generate:generateTab,workspaces:workspacesTab,workflow:workflowTab,code:codeTab,runs:projectRunsTab,settings:settingsTab}[tab]||artifactsTab;
  body.append(await render(p));
  return h('div',{},
    h('div',{class:'row'},h('h2',{style:'margin:0'},p.title),h('span',{class:'muted'},p.kind),h('span',{class:'spacer'}),
      h('button',{class:'secondary',onclick:guard(()=>download(`/v1/projects/${p.id}/export?format=zip`,`${p.title}.zip`))},'Export ZIP'),h('button',{class:'secondary',onclick:guard(()=>download(`/v1/projects/${p.id}/export`,`${p.title}.json`))},'Export JSON (re-importable)')),
    h('div',{class:'tabs',role:'tablist'},tabs.map(([k,l])=>h('button',{class:k===tab?'active':'',role:'tab',onclick:()=>location.hash=`#/projects/${p.id}/${k}`},l))),
    body);
}
async function artifactsTab(p){
  const items=(await api('GET',`/v1/projects/${p.id}/artifacts`)).items;
  const detail=h('div',{class:'stack'},h('p',{class:'muted'},'Select an artifact to view or edit it.'));
  const open=guard(async(aid,rev)=>{
    const a=await api('GET',`/v1/projects/${p.id}/artifacts/${aid}${rev?`?revision=${rev}`:''}`);
    const hist=(await api('GET',`/v1/projects/${p.id}/artifacts/${aid}/revisions`)).items;
    const content=h('div',{class:'stack'});
    if(a.assetId){
      const url=await blobUrl(`/v1/projects/${p.id}/artifacts/${aid}/download${rev?`?revision=${rev}`:''}`);
      const m=a.mediaType;
      content.append(h('div',{class:'media'},m.startsWith('image/')?h('img',{src:url,alt:a.title}):m.startsWith('audio/')?h('audio',{controls:true,src:url}):m.startsWith('video/')?h('video',{controls:true,src:url}):h('a',{href:url,download:a.title},'Download file')));
    }else{
      const isText=typeof a.body==='string';
      const editor=h('textarea',{'aria-label':'Artifact content',style:'min-height:320px'});editor.value=isText?a.body:JSON.stringify(a.body,null,2);
      const title=h('input',{value:a.title,'aria-label':'Title'});
      content.append(title,editor,h('div',{class:'row'},
        h('button',{onclick:guard(async()=>{let body;if(isText)body={text:editor.value,mediaType:a.mediaType};else body={body:JSON.parse(editor.value),mediaType:'application/json'};
          await api('PUT',`/v1/projects/${p.id}/artifacts/${aid}`,{...body,title:title.value,expectedRevision:a.currentRevision});toast('Saved new revision');open(aid);})},'Save revision'),
        rev&&rev!==a.currentRevision?h('button',{class:'secondary',onclick:guard(async()=>{await api('POST',`/v1/projects/${p.id}/artifacts/${aid}/restore`,{revision:rev});toast('Restored');open(aid);})},`Restore revision ${rev}`):null));
      if(isText){
        const ask=h('input',{placeholder:'e.g. tighten the second paragraph, make the tone formal','aria-label':'AI revision instructions'});
        const reviseModel=h('select',{'aria-label':'Revision model'},...modelOptions('chat'));
        content.append(h('div',{class:'row card'},h('strong',{},'AI revise'),ask,reviseModel,h('button',{class:'secondary',onclick:guard(async()=>{
          if(!ask.value.trim())return toast('Describe the revision first');
          const run=await api('POST',`/v1/projects/${p.id}/operations/writing.revise`,{input:{artifactId:aid,instructions:ask.value},model:parseModel(reviseModel.value)});
          toast('Revision running — the result is saved as a new revision');location.hash=`#/runs/${run.id}`;})},'Revise with AI')));
      }
    }
    rc(detail,
      h('div',{class:'row'},h('h3',{style:'margin:0'},a.title),h('span',{class:'muted small'},`${a.mediaType} · revision ${a.revision} of ${a.currentRevision}`),h('span',{class:'spacer'}),
        h('button',{class:'secondary small',onclick:guard(()=>download(`/v1/projects/${p.id}/artifacts/${aid}/download${rev?`?revision=${rev}`:''}`,a.title))},'Download'),
        h('button',{class:'danger small',onclick:guard(async()=>{if(!confirm('Delete this artifact?'))return;await api('DELETE',`/v1/projects/${p.id}/artifacts/${aid}`);route();})},'Delete')),
      a.provenance?.simulated?h('p',{class:'small',style:'color:var(--warn)'},'Produced by the deterministic SIMULATOR — not real model output.'):null,
      content,
      h('h3',{},'History'),
      h('table',{},h('tr',{},h('th',{},'Rev'),h('th',{},'When'),h('th',{},'Source'),h('th',{},'')),hist.map(v=>h('tr',{},h('td',{},v.revision),h('td',{},when(v.createdAt)),h('td',{class:'small'},v.provenance?.source||''),h('td',{},h('button',{class:'secondary small',onclick:()=>open(aid,v.revision)},'View'))))));
  });
  const newTitle=h('input',{placeholder:'New document title'});
  const upload=h('input',{type:'file','aria-label':'Upload file'});
  return h('div',{class:'split'},
    h('div',{class:'stack'},
      h('div',{class:'row'},newTitle,h('button',{class:'small',onclick:guard(async()=>{const a=await api('POST',`/v1/projects/${p.id}/artifacts`,{title:newTitle.value||'Untitled',text:''});route();setTimeout(()=>open(a.id),300);})},'New')),
      h('div',{class:'row'},upload,h('button',{class:'secondary small',onclick:guard(async()=>{const f=upload.files[0];if(!f)return;await api('POST',`/v1/projects/${p.id}/assets?title=${encodeURIComponent(f.name)}`,f,{headers:{'Content-Type':f.type||'application/octet-stream'}});toast('Uploaded');route();})},'Upload')),
      h('div',{class:'list'},items.map(a=>h('button',{onclick:()=>open(a.id)},h('div',{},a.title),h('div',{class:'muted small'},`${a.kind} · ${a.mediaType} · r${a.revision}`))))),
    detail);
}
async function generateTab(p){
  const model=h('select',{'aria-label':'Model'},...modelOptions('chat'));
  const prompt=h('textarea',{placeholder:'What should the model produce?','aria-label':'Prompt'});
  const out=h('pre',{class:'output','aria-live':'polite'});const info=h('div',{class:'muted small'});
  let ctrl;
  const go=h('button',{onclick:guard(async()=>{
    out.textContent='';info.textContent='Streaming…';go.disabled=true;ctrl=new AbortController();
    try{await sse(`/v1/projects/${p.id}/generate`,{method:'POST',body:{prompt:prompt.value,model:parseModel(model.value)},signal:ctrl.signal,onEvent:(ev,d)=>{
      if(ev==='token')out.textContent+=d.text;
      if(ev==='result'){rc(info,`Done · cost ${usd(d.costMicro)} · `,h('a',{href:`#/runs/${d.runId}`},'run'),' · ',h('a',{href:`#/projects/${p.id}/artifacts`},'saved as artifact'),d.output?.simulated?' · SIMULATED output':'');}
      if(ev==='error'){info.textContent='Failed: '+(d.error||d.message||d.code);}
    }});}finally{go.disabled=false;}
  })},'Generate');
  return h('div',{class:'stack card'},h('label',{},'Model',model),h('label',{},'Prompt',prompt),h('div',{class:'row'},go),info,out);
}
async function workspacesTab(p){
  const ws=(await api('GET','/v1/workspaces')).items;
  const form=h('div',{class:'stack'});const model=h('select',{'aria-label':'Text model'},...modelOptions('chat'));
  const pick=op=>{
    const fields=Object.entries(op.inputSchema.properties).map(([k,s])=>{
      const input=s.enum?h('select',{name:k},h('option',{value:''},'—'),...s.enum.map(v=>h('option',{value:v},v))):s.type==='array'?h('textarea',{name:k,placeholder:'One per line',style:'min-height:60px'}):(k==='text'||k==='data'||k==='instructions')?h('textarea',{name:k}):h('input',{name:k,type:s.type==='integer'?'number':'text'});
      return h('label',{},`${s.title||k}${op.inputSchema.required.includes(k)?' *':''}`,input);
    });
    rc(form,h('h3',{},op.title),h('p',{class:'muted'},op.description),...fields,h('label',{},'Text model for agents',model),
      h('button',{onclick:guard(async()=>{const input={};
        for(const el of form.querySelectorAll('[name]')){const s=op.inputSchema.properties[el.name];if(el.value==='')continue;input[el.name]=s.type==='integer'?Number(el.value):s.type==='array'?el.value.split('\n').map(x=>x.trim()).filter(Boolean):el.value;}
        const run=await api('POST',`/v1/projects/${p.id}/operations/${op.id}`,{input,model:parseModel(model.value)});location.hash=`#/runs/${run.id}`;})},'Run'));
  };
  return h('div',{class:'split'},h('div',{class:'list'},ws.map(d=>[h('strong',{style:'margin-top:8px'},d.title),...d.operations.map(op=>h('button',{onclick:()=>pick(op)},op.title))])),h('div',{class:'card'},form));
}
const EXAMPLES={
  'Research team (fan-out / fan-in)':{title:'Research team',inputs:{topic:'grid-scale energy storage'},nodes:[
    {key:'scope',type:'agent',role:'research lead',instructions:'Define three research questions about {{inputs.topic}}',outputSchema:{type:'object',properties:{questions:{type:'array',items:{type:'string'}}},required:['questions']}},
    {key:'technology',type:'agent',dependsOn:['scope'],instructions:'Investigate the technology questions'},
    {key:'economics',type:'agent',dependsOn:['scope'],instructions:'Investigate the economics'},
    {key:'policy',type:'agent',dependsOn:['scope'],instructions:'Investigate the policy landscape'},
    {key:'report',type:'agent',dependsOn:['technology','economics','policy'],instructions:'Write the integrated report',artifact:{title:'Integrated report'}}]},
  'Planner with delegated agents':{title:'Delegated plan',nodes:[{key:'plan',type:'planner',maxTasks:5,instructions:'Produce a launch plan for a community library app',synthesis:{title:'Launch plan'}}]},
  'Draft → human approval → publish':{title:'Approval gate',nodes:[{key:'draft',type:'agent',instructions:'Draft an announcement'},{key:'review',type:'approval',dependsOn:['draft'],effect:'publish',summary:'Approve publishing the announcement?'},{key:'final',type:'agent',dependsOn:['review'],instructions:'Polish the approved announcement'}]},
};
async function workflowTab(p){
  const editor=h('textarea',{style:'min-height:360px','aria-label':'Workflow JSON'});editor.value=sessionStorage.getItem('sie_wf_draft_'+p.id)||JSON.stringify(Object.values(EXAMPLES)[0],null,2);
  editor.addEventListener('input',()=>sessionStorage.setItem('sie_wf_draft_'+p.id,editor.value));
  const model=h('select',{'aria-label':'Default model'},...modelOptions('chat'));
  const ceiling=h('input',{type:'number',placeholder:'Run budget ceiling (USD, optional)',step:'0.01',min:'0'});
  const saved=(await api('GET',`/v1/projects/${p.id}/workflows`)).items;let loaded=null;
  const wfTitle=h('input',{placeholder:'Saved workflow title','aria-label':'Saved workflow title'});
  const prepare=()=>{const spec=JSON.parse(editor.value);const m=parseModel(model.value);
    if(m)for(const n of spec.nodes)if(['agent','planner'].includes(n.type)&&!n.model){n.model=m;if(n.type==='planner'){n.worker={...(n.worker||{}),model:n.worker?.model||m};}}
    if(ceiling.value)spec.budgetCeilingMicro=Math.round(Number(ceiling.value)*1e6);return spec;};
  const savedList=h('table',{},h('tr',{},['Saved workflow','Version','Updated',''].map(x=>h('th',{},x))),saved.map(w=>h('tr',{},h('td',{},w.title),h('td',{},'v'+w.version),h('td',{},when(w.updatedAt)),
    h('td',{},h('div',{class:'row'},h('button',{class:'secondary small',onclick:()=>{loaded=w;editor.value=JSON.stringify(w.spec,null,2);sessionStorage.setItem('sie_wf_draft_'+p.id,editor.value);wfTitle.value=w.title;toast(`Loaded ${w.title} v${w.version}`);}},'Load'),
      h('button',{class:'small',onclick:guard(async()=>{const r=await api('POST',`/v1/workflows/${w.id}/runs`,{});location.hash=`#/runs/${r.id}`;})},'Run'),
      h('button',{class:'danger small',onclick:guard(async()=>{await api('DELETE',`/v1/workflows/${w.id}`);route();})},'Delete'))))));
  return h('div',{class:'stack card'},
    saved.length?h('div',{class:'stack'},h('h3',{style:'margin:0'},'Saved workflows'),savedList):null,
    h('div',{class:'row'},h('span',{class:'muted'},'Templates:'),Object.entries(EXAMPLES).map(([k,v])=>h('button',{class:'secondary small',onclick:()=>{editor.value=JSON.stringify(v,null,2);sessionStorage.setItem('sie_wf_draft_'+p.id,editor.value);}},k))),
    h('p',{class:'muted small'},'Node types: agent, planner, tool, approval, code, media, external_agent. Use dependsOn for ordering, when for conditions, {{nodes.key.text}} / {{inputs.x}} templates to pass outputs.'),
    editor,h('div',{class:'row'},h('label',{},'Default model for agents',model),h('label',{},'Budget ceiling',ceiling)),
    h('button',{onclick:guard(async()=>{const spec=prepare();
      const run=await api('POST',`/v1/projects/${p.id}/runs`,{spec});location.hash=`#/runs/${run.id}`;})},'Start workflow'),
    h('div',{class:'row'},wfTitle,h('button',{class:'secondary',onclick:guard(async()=>{const spec=prepare();
      if(loaded&&loaded.title===wfTitle.value){await api('PUT',`/v1/workflows/${loaded.id}`,{spec,expectedVersion:loaded.version});toast('Saved new version');}
      else{await api('POST',`/v1/projects/${p.id}/workflows`,{title:wfTitle.value||spec.title||'Workflow',spec});toast('Workflow saved');}
      sessionStorage.setItem('sie_wf_draft_'+p.id,editor.value);route();})},'Save workflow')));
}
async function codeTab(p){
  const files=(await api('GET',`/v1/projects/${p.id}/files`)).items;
  let current=null;
  const path=h('input',{placeholder:'path/to/file.py','aria-label':'File path'});const editor=h('textarea',{style:'min-height:300px','aria-label':'File content'});
  const out=h('pre',{class:'output'});const preview=h('div',{});const gitlog=h('div',{class:'small'});
  const openFile=guard(async fp=>{const f=await api('GET',`/v1/projects/${p.id}/files/${fp}`);current=f;path.value=f.path;editor.value=f.content;});
  const cmd=h('input',{placeholder:'python3 main.py','aria-label':'Command'});
  const fileList=h('div',{class:'list'},files.map(f=>h('button',{onclick:()=>openFile(f.path)},f.path,h('span',{class:'muted small'},` r${f.revision}`))));
  const showRun=r=>{out.textContent=`$ exit ${r.exitCode}${r.timedOut?' (timeout)':''} · ${r.durationMs}ms · sandbox: ${r.backend}\n${r.stdout}${r.stderr?'\n--- stderr ---\n'+r.stderr:''}`;};
  const loadLog=guard(async()=>{const l=(await api('GET',`/v1/projects/${p.id}/git/log`)).items;rc(gitlog,...l.map(c=>h('div',{},h('code',{},c.commit.slice(0,8)),' ',c.message,' ',h('span',{class:'muted'},when(c.date)),' ',h('button',{class:'secondary small',onclick:guard(async()=>{await api('POST',`/v1/projects/${p.id}/git/checkout`,{commit:c.commit});toast('Checked out');route();})},'Checkout'))));});
  loadLog();
  return h('div',{class:'split'},
    h('div',{class:'stack'},h('button',{class:'secondary small',onclick:()=>{current=null;path.value='';editor.value='';}},'New file'),
      fileList,
      h('h3',{},'Git'),h('div',{class:'row'},h('input',{id:'commit-msg',placeholder:'Commit message'}),h('button',{class:'small',onclick:guard(async()=>{const r=await api('POST',`/v1/projects/${p.id}/git/commit`,{message:$('#commit-msg').value||'Update'});toast(r.changed?'Committed '+r.commit.slice(0,8):'Nothing to commit');loadLog();})},'Commit')),
      gitlog),
    h('div',{class:'stack'},path,editor,
      h('div',{class:'row'},
        h('button',{onclick:guard(async()=>{const r=await api('PUT',`/v1/projects/${p.id}/files/${path.value}`,{content:editor.value,expectedRevision:current&&current.path===path.value?current.revision:undefined});current={path:path.value,revision:r.revision};toast('Saved r'+r.revision);if(!files.some(f=>f.path===r.path)){files.push(r);fileList.append(h('button',{onclick:()=>openFile(r.path)},r.path));}})},'Save'),
        h('button',{class:'secondary',onclick:guard(async()=>{out.textContent='Running tests…';const r=await api('POST',`/v1/projects/${p.id}/test`,{});showRun(r);})},'Run tests'),
        h('button',{class:'secondary',onclick:guard(async()=>{const d=await api('GET',`/v1/projects/${p.id}/diagnostics`);out.textContent=d.items.length?d.items.map(x=>`${x.path}: ${x.severity}: ${x.message}`).join('\n'):`No problems in ${d.checked} files`;})},'Diagnostics'),
        h('button',{class:'secondary',onclick:guard(async()=>{const d=await api('GET',`/v1/projects/${p.id}/git/diff`);out.textContent=d.diff||'No changes since last commit';})},'Diff'),
        h('button',{class:'secondary',onclick:guard(async()=>{const r=await api('POST',`/v1/projects/${p.id}/preview`,{path:path.value||'index.html'});rc(preview,h('iframe',{class:'preview',src:r.url,sandbox:'allow-scripts allow-forms',title:'Preview'}));})},'Preview')),
      h('div',{class:'row'},cmd,h('button',{class:'secondary',onclick:guard(async()=>{out.textContent='Running…';const r=await api('POST',`/v1/projects/${p.id}/exec`,{command:cmd.value.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g).map(s=>s.replace(/^["']|["']$/g,'')),persist:true});showRun(r);})},'Run in sandbox')),
      out,preview));
}
async function projectRunsTab(p){return runsTable((await api('GET',`/v1/runs?projectId=${p.id}`)).items);}
async function settingsTab(p){
  const title=h('input',{value:p.title}),desc=h('textarea',{style:'min-height:80px'});desc.value=p.description||'';
  return h('div',{class:'stack card'},h('label',{},'Title',title),h('label',{},'Description',desc),
    h('div',{class:'row'},h('button',{onclick:guard(async()=>{await api('PATCH',`/v1/projects/${p.id}`,{title:title.value,description:desc.value});toast('Saved');})},'Save'),
      h('button',{class:'secondary',onclick:guard(async()=>{await api('PATCH',`/v1/projects/${p.id}`,{archived:!p.archived});route();})},p.archived?'Unarchive':'Archive'),
      h('button',{class:'danger',onclick:guard(async()=>{if(!confirm('Delete this project and all its artifacts?'))return;await api('DELETE',`/v1/projects/${p.id}`);location.hash='#/projects';})},'Delete project')));
}

// ---------------- runs ----------------
function runsTable(runs){
  return h('table',{},h('tr',{},h('th',{},'Run'),h('th',{},'Kind'),h('th',{},'Status'),h('th',{},'Cost'),h('th',{},'Created')),
    runs.map(r=>h('tr',{},h('td',{},h('a',{href:`#/runs/${r.id}`},r.title||r.id)),h('td',{},r.kind),h('td',{},stateTag(r.status)),h('td',{},usd(r.spentMicro)),h('td',{},when(r.createdAt)))));
}
async function runsPage(){return h('div',{},h('h2',{},'Runs'),runsTable((await api('GET','/v1/runs?limit=100')).items));}
async function runPage(id){
  const wrap=h('div',{class:'stack'});const log=h('pre',{class:'output',style:'max-height:300px'});const outputs=h('div',{class:'stack'});
  const ctrl=new AbortController();
  const render=async()=>{
    const r=await api('GET',`/v1/runs/${id}`);
    const dag=h('div',{class:'dag'},r.nodes.map(n=>h('div',{class:'node'},h('strong',{},n.key),' ',stateTag(n.state),h('div',{class:'muted small'},`${n.type}${n.parent?` · delegated by ${n.parent}`:''}${n.dependsOn.length?` · after ${n.dependsOn.join(', ')}`:''}`),
      n.error?h('div',{class:'small error'},n.error):null,n.artifactId?h('div',{class:'small'},h('a',{href:`#/projects/${r.projectId}/artifacts`},'artifact')):null)));
    const approvals=r.approvals.filter(a=>a.status==='pending').map(a=>h('div',{class:'card'},h('strong',{},`Approval needed (${a.effect}): ${a.action}`),h('pre',{class:'output'},a.summary),
      h('div',{class:'row'},h('button',{onclick:guard(async()=>{await api('POST',`/v1/approvals/${a.id}`,{decision:'approve'});render();})},'Approve'),h('button',{class:'danger',onclick:guard(async()=>{await api('POST',`/v1/approvals/${a.id}`,{decision:'deny'});render();})},'Deny'))));
    rc(outputs,...r.nodes.filter(n=>n.output).map(n=>h('details',{},h('summary',{},`${n.key} output${n.output.simulated?' (SIMULATED)':''}`),h('pre',{class:'output'},typeof n.output.text==='string'?n.output.text:JSON.stringify(n.output.data??n.output,null,2)))));
    rc(wrap,
      h('div',{class:'row'},h('h2',{style:'margin:0'},r.title||'Run'),stateTag(r.status),h('span',{class:'muted'},`cost ${usd(r.spentMicro)}${r.budgetCeilingMicro?` / ceiling ${usd(r.budgetCeilingMicro)}`:''}`),h('span',{class:'spacer'}),
        ['queued','running','awaiting_approval'].includes(r.status)?h('button',{class:'danger',onclick:guard(async()=>{await api('POST',`/v1/runs/${id}/cancel`);render();})},'Cancel'):null,
        ['failed','cancelled'].includes(r.status)?h('button',{class:'secondary',onclick:guard(async()=>{await api('POST',`/v1/runs/${id}/retry`);render();})},'Retry'):null,
        h('a',{href:`#/projects/${r.projectId}/artifacts`},'Project artifacts')),
      r.error?h('p',{class:'error'},r.error):null,...approvals,dag,h('h3',{},'Outputs'),outputs,h('h3',{},'Live events'),log);
  };
  await render();
  let pending=null;
  sse(`/v1/runs/${id}/events`,{signal:ctrl.signal,onEvent:(ev,d)=>{
    if(ev==='node.delta')log.textContent+=d.payload.text;
    else if(ev!=='replay-end')log.textContent+=`${log.textContent&&!log.textContent.endsWith('\n')?'\n':''}[${d.node||'run'}] ${ev}${d.payload?.error?': '+d.payload.error:''}\n`;
    log.scrollTop=log.scrollHeight;
    if(ev!=='node.delta'&&ev!=='replay-end'){clearTimeout(pending);pending=setTimeout(()=>render().catch(()=>{}),250);}
  }}).catch(()=>{});
  window.addEventListener('hashchange',()=>ctrl.abort(),{once:true});
  return wrap;
}
async function approvalsPage(){
  const items=(await api('GET','/v1/approvals')).items;refreshApprovalCount();
  return h('div',{class:'stack'},h('h2',{},'Pending approvals'),items.length?items.map(a=>h('div',{class:'card stack'},
    h('div',{class:'row'},h('strong',{},a.action),h('span',{class:'state awaiting_approval'},a.effect),h('a',{href:`#/runs/${a.runId}`},a.runTitle||'run'),h('span',{class:'muted small'},when(a.createdAt))),
    h('pre',{class:'output'},a.summary),h('details',{},h('summary',{},'Exact request'),h('pre',{class:'output'},JSON.stringify(a.request,null,2))),
    h('div',{class:'row'},h('button',{onclick:guard(async()=>{await api('POST',`/v1/approvals/${a.id}`,{decision:'approve'});route();})},'Approve'),h('button',{class:'danger',onclick:guard(async()=>{await api('POST',`/v1/approvals/${a.id}`,{decision:'deny'});route();})},'Deny')))):h('p',{class:'muted'},'Nothing is waiting for approval.'));
}

// ---------------- providers / budget ----------------
async function providersPage(){
  const [prov,budget]=await Promise.all([api('GET','/v1/providers'),api('GET','/v1/budget')]);
  const models=(await api('GET','/v1/models')).items;
  const provRow=pv=>{const key=h('input',{type:'password',placeholder:'API key',autocomplete:'off'}),base=h('input',{placeholder:'Base URL (optional)'});
    return h('tr',{},h('td',{},pv.label),h('td',{},pv.configured?`configured (${pv.source}${pv.fingerprint?' '+pv.fingerprint:''})`:'not configured'),
      h('td',{},pv.simulated?h('span',{class:'muted small'},'built-in, test only'):h('div',{class:'row'},key,base,h('button',{class:'small',onclick:guard(async()=>{await api('PUT',`/v1/providers/${pv.id}`,{apiKey:key.value,...(base.value?{baseUrl:base.value}:{})});toast('Credential stored (encrypted)');route();})},'Save'),
        pv.source==='tenant'?h('button',{class:'secondary small',onclick:guard(async()=>{await api('DELETE',`/v1/providers/${pv.id}`);route();})},'Remove'):null)));};
  const limit=h('input',{type:'number',min:'0',step:'0.01',value:budget.tenant.hardLimitMicro/1e6});
  return h('div',{class:'stack'},
    h('h2',{},'Budget'),
    h('div',{class:'grid'},h('div',{class:'card'},h('div',{class:'muted small'},'Tenant funded'),h('strong',{},usd(budget.tenant.fundedMicro))),h('div',{class:'card'},h('div',{class:'muted small'},'Tenant hard limit'),h('strong',{},usd(budget.tenant.hardLimitMicro))),
      h('div',{class:'card'},h('div',{class:'muted small'},'Spent / reserved'),h('strong',{},`${usd(budget.tenant.spentMicro)} / ${usd(budget.tenant.reservedMicro)}`)),h('div',{class:'card'},h('div',{class:'muted small'},'Operator-wide cap'),h('strong',{},usd(budget.global.hardLimitMicro)))),
    h('div',{class:'row'},h('label',{},'Tenant hard limit (USD, owner only)',limit),h('button',{onclick:guard(async()=>{await api('PUT','/v1/budget',{hardLimitMicro:Math.round(Number(limit.value)*1e6)});toast('Limit updated');route();})},'Update limit')),
    h('h3',{},'Usage (30 days)'),h('table',{},h('tr',{},['Provider','Model','Operation','Calls','Input tok','Output tok','Cost'].map(x=>h('th',{},x))),budget.usage.map(u=>h('tr',{},h('td',{},u.provider+(u.simulated?' (sim)':'')),h('td',{},u.model),h('td',{},u.operation),h('td',{},u.calls),h('td',{},u.inputTokens),h('td',{},u.outputTokens),h('td',{},usd(u.costMicro))))),
    h('h2',{},'Providers'),h('table',{},h('tr',{},h('th',{},'Provider'),h('th',{},'Status'),h('th',{},'Credential (stored encrypted, never shown again)')),prov.items.map(provRow)),
    h('h2',{},'Models'),h('table',{},h('tr',{},['Model','Provider','Capabilities','Price','Available'].map(x=>h('th',{},x))),models.map(m=>h('tr',{},h('td',{},m.label),h('td',{},m.provider),h('td',{class:'small'},m.capabilities.join(', ')),
      h('td',{class:'small'},m.price?(m.price.input!==undefined?`${usd(m.price.input)}/${usd(m.price.output)} per MTok`:`${usd(m.price.unit)} per ${m.price.per}`):'unknown'),h('td',{},m.available?'yes':'no')))));
}
async function connectionsPage(){
  const list=(await api('GET','/v1/connections')).items;
  const kind=h('select',{},h('option',{value:'mcp'},'MCP server'),h('option',{value:'external_agent'},'External agent (A2A)'),h('option',{value:'http'},'HTTP service / Git remote'));
  const name=h('input',{placeholder:'name (a-z, 0-9, -)'}),endpoint=h('input',{placeholder:'https://…'}),secret=h('input',{type:'password',placeholder:'Bearer secret (optional)'});
  return h('div',{class:'stack'},h('h2',{},'Integrations'),
    h('p',{class:'muted'},'Agents only reach registered integrations. Tools with external effects always require an admin approval of the exact request.'),
    h('div',{class:'card row'},kind,name,endpoint,secret,h('button',{onclick:guard(async()=>{await api('POST','/v1/connections',{kind:kind.value,name:name.value,endpoint:endpoint.value,...(secret.value?{secret:secret.value}:{})});toast('Connected');route();})},'Add')),
    h('table',{},h('tr',{},['Name','Kind','Endpoint','Tools',''].map(x=>h('th',{},x))),list.map(c=>h('tr',{},h('td',{},c.name),h('td',{},c.kind),h('td',{class:'small'},c.endpoint),
      h('td',{class:'small'},c.tools.map(t=>h('div',{},`${t.name} `,h('button',{class:'secondary small',onclick:guard(async()=>{await api('PATCH',`/v1/connections/${c.id}/tools`,{tool:t.name,effect:t.effect==='read'?'external':'read'});route();})},t.effect==='read'?'read-only ✓':'needs approval')))),
      h('td',{},h('button',{class:'danger small',onclick:guard(async()=>{await api('DELETE',`/v1/connections/${c.id}`);route();})},'Remove'))))));
}
async function schedulesPage(){
  const [list,projects]=await Promise.all([api('GET','/v1/schedules'),api('GET','/v1/projects')]);
  const project=h('select',{},projects.items.map(p=>h('option',{value:p.id},p.title)));
  const title=h('input',{placeholder:'Title'}),cron=h('input',{placeholder:'0 7 * * 1-5',value:'0 7 * * *'}),tz=h('input',{value:Intl.DateTimeFormat().resolvedOptions().timeZone});
  const spec=h('textarea',{});spec.value=JSON.stringify({title:'Daily briefing',nodes:[{key:'brief',type:'agent',instructions:'Write a short daily briefing for {{inputs.scheduledAt}}'}]},null,2);
  return h('div',{class:'stack'},h('h2',{},'Schedules'),
    h('div',{class:'card stack'},h('div',{class:'row'},project,title,cron,tz),spec,h('button',{onclick:guard(async()=>{await api('POST',`/v1/projects/${project.value}/schedules`,{title:title.value||'Scheduled run',cron:cron.value,timezone:tz.value,spec:JSON.parse(spec.value)});toast('Scheduled');route();})},'Create schedule')),
    h('table',{},h('tr',{},['Title','Cron','Next run','Last run','Enabled',''].map(x=>h('th',{},x))),list.items.map(s=>h('tr',{},h('td',{},s.title),h('td',{},`${s.cron} (${s.timezone})`),h('td',{},when(s.nextRunAt)),h('td',{},s.lastRunId?h('a',{href:`#/runs/${s.lastRunId}`},when(s.lastRunAt)):'—'),
      h('td',{},h('input',{type:'checkbox',checked:s.enabled,onchange:guard(async e=>{await api('PATCH',`/v1/schedules/${s.id}`,{enabled:e.target.checked});})})),h('td',{},h('button',{class:'danger small',onclick:guard(async()=>{await api('DELETE',`/v1/schedules/${s.id}`);route();})},'Delete'))))));
}
async function teamPage(){
  const [members,tokens]=await Promise.all([api('GET',`/v1/tenants/${state.tenant}/members`),api('GET','/v1/tokens')]);
  const email=h('input',{placeholder:'email of an existing user'}),role=h('select',{},['viewer','member','admin','owner'].map(r=>h('option',{value:r},r)));
  const label=h('input',{placeholder:'Token label'});const shown=h('pre',{class:'output hidden'});
  const tname=h('input',{placeholder:'New workspace name'});
  return h('div',{class:'stack'},h('h2',{},'Team'),
    h('table',{},h('tr',{},['Name','Email','Role',''].map(x=>h('th',{},x))),members.items.map(m=>h('tr',{},h('td',{},m.displayName),h('td',{},m.email||''),h('td',{},m.role),h('td',{},h('button',{class:'secondary small',onclick:guard(async()=>{await api('DELETE',`/v1/tenants/${state.tenant}/members/${m.identityId}`);route();})},'Remove'))))),
    h('div',{class:'row'},email,role,h('button',{onclick:guard(async()=>{await api('PUT',`/v1/tenants/${state.tenant}/members`,{email:email.value,role:role.value});route();})},'Add member')),
    h('div',{class:'row'},tname,h('button',{class:'secondary',onclick:guard(async()=>{const t=await api('POST','/v1/tenants',{name:tname.value});state.tenant=t.id;await boot();})},'Create workspace')),
    h('h2',{},'API tokens'),h('p',{class:'muted'},'Server-side integrations (Academy, Command Center) authenticate with tokens. A token is shown once.'),
    h('div',{class:'row'},label,h('button',{onclick:guard(async()=>{const t=await api('POST','/v1/tokens',{label:label.value,days:90});shown.textContent=t.token;shown.classList.remove('hidden');})},'Create token')),shown,
    h('table',{},h('tr',{},['Label','Product','Expires','Last used',''].map(x=>h('th',{},x))),tokens.items.map(t=>h('tr',{},h('td',{},t.label),h('td',{},t.product),h('td',{},when(t.expiresAt)),h('td',{},when(t.lastUsedAt)||'—'),h('td',{},t.revoked?'revoked':h('button',{class:'danger small',onclick:guard(async()=>{await api('DELETE',`/v1/tokens/${t.id}`);route();})},'Revoke'))))));
}

if(state.token)boot().catch(()=>{logout();});else showLogin();
