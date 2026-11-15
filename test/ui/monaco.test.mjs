// The Code tab upgrades its textarea to Monaco (pinned on jsDelivr) under the console CSP, including the
// blob: worker. The CDN is served from node_modules/monaco-editor so the test is offline and exact.
import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {createRequire} from 'node:module';
import {skip,freshDatabase,startApp} from '../helpers/harness.mjs';
const require=createRequire(import.meta.url);
let chromium,monacoDir;try{({chromium}=await import('playwright'));}catch{}
try{monacoDir=require.resolve('monaco-editor/package.json').replace(/package\.json$/,'');}catch{}
test('Monaco editor loads under the console CSP and saves files',{skip:skip||(!chromium&&'playwright not installed')||(!monacoDir&&'monaco-editor not installed'),timeout:120000},async()=>{
 const db=await freshDatabase();const app=await startApp(db);let browser;
 try{
  browser=await chromium.launch(process.env.SIE_CHROMIUM_PATH?{executablePath:process.env.SIE_CHROMIUM_PATH}:{});
  const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/**',async r=>{
   const p=new URL(r.request().url()).pathname.replace('/npm/monaco-editor@0.52.2/','');
   try{r.fulfill({body:await readFile(monacoDir+p),contentType:p.endsWith('.css')?'text/css':p.endsWith('.ttf')?'font/ttf':'text/javascript',headers:{'Access-Control-Allow-Origin':'*'}});}catch{r.fulfill({status:404});}
  });
  await page.goto(app.base+'/');await page.fill('#dev-handle','monaco');await page.click('#dev-form button');await page.waitForSelector('#shell:not(.hidden)');
  await page.getByPlaceholder('Project title').fill('Editor');await page.getByRole('button',{name:'Create project'}).click();await page.waitForSelector('text=Artifacts');
  await page.getByRole('tab',{name:'Code'}).click();
  await page.waitForSelector('.monaco-editor',{timeout:30000});
  await page.fill('input[aria-label="File path"]','hello.py');
  await page.click('.monaco-editor .view-lines');await page.keyboard.type('print(40 + 2)');
  await page.getByRole('button',{name:'Save',exact:true}).click();
  const token=await page.evaluate(()=>sessionStorage.getItem('sie_token')),tenant=await page.evaluate(()=>sessionStorage.getItem('sie_tenant'));
  const pid=new URL(page.url()).hash.split('/')[2];
  let content='';for(let i=0;i<40&&!content;i++){const r=await fetch(`${app.base}/v1/projects/${pid}/files/hello.py`,{headers:{Authorization:'Bearer '+token,'X-Tenant-Id':tenant}});if(r.ok)content=(await r.json()).content;else await new Promise(s=>setTimeout(s,150));}
  assert.equal(content,'print(40 + 2)');assert.deepEqual(errors,[]);
 }finally{await browser?.close();await app.stop();await db.drop();}
});
