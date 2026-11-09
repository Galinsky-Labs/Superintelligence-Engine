// Drives the real console in Chromium against a live API + worker (simulator provider).
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {skip,freshDatabase,startApp} from '../helpers/harness.mjs';
import {Sandbox} from '../../packages/engine/src/sandbox.mjs';

import {createRequire} from 'node:module';
let chromium;try{({chromium}=await import('playwright'));}catch{try{({chromium}=createRequire(import.meta.url)('playwright'));}catch{}}
const shots=process.env.SIE_UI_SCREENSHOTS;

test('console end-to-end in a browser',{skip:skip||(!chromium&&'playwright not installed'),timeout:240000},async()=>{
  const db=await freshDatabase();const app=await startApp(db,{SIE_SIM_DELAY_MS:'5'});
  const ac=new AbortController();const loop=app.worker.run({signal:ac.signal});
  const browser=await chromium.launch();const page=await browser.newPage({viewport:{width:1360,height:900}});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const shot=async name=>{if(shots){await mkdir(shots,{recursive:true});await page.screenshot({path:`${shots}/${name}.png`,fullPage:true});}};
  try{
    await page.goto(app.base+'/');
    await page.fill('#dev-handle','uitester');await page.click('#dev-form button');
    await page.waitForSelector('#shell:not(.hidden)');
    await page.getByPlaceholder('Project title').fill('Browser project');
    await page.getByRole('button',{name:'Create project'}).click();
    await page.waitForSelector('text=Browser project');
    // streaming generation with the simulator
    await page.getByRole('tab',{name:'Generate'}).click();
    await page.selectOption('select[aria-label="Model"]','deterministic|sim-text');
    await page.fill('textarea[aria-label="Prompt"]','Write a haiku about databases');
    await page.getByRole('button',{name:'Generate',exact:true}).click();
    await page.waitForSelector('text=saved as artifact',{timeout:30000});
    assert.match(await page.textContent('pre.output'),/SIMULATED OUTPUT/);
    await shot('01-generate');
    // artifact editor: edit, save revision, history
    await page.getByRole('tab',{name:'Artifacts'}).click();
    await page.locator('.list button').first().click();
    await page.waitForSelector('textarea[aria-label="Artifact content"]');
    await page.fill('textarea[aria-label="Artifact content"]','Edited in the browser.');
    await page.getByRole('button',{name:'Save revision'}).click();
    await page.waitForSelector('text=revision 2 of 2');
    assert.equal(await page.locator('table tr').count(),3,'two history rows + header');
    await shot('02-artifact');
    // domain workspace operation -> run monitor
    await page.getByRole('tab',{name:'Domain workspaces'}).click();
    await page.getByRole('button',{name:'Poem'}).click();
    await page.fill('input[name="topic"]','the night shift');
    await page.selectOption('select[aria-label="Text model"]','deterministic|sim-text');
    await page.getByRole('button',{name:'Run',exact:true}).click();
    await page.waitForURL(/#\/runs\//);
    await page.waitForSelector('.row .state.succeeded',{timeout:60000});
    assert.equal(await page.locator('.dag .node').count(),2);
    await shot('03-run');
    // multi-agent workflow from the template, then approval gate
    await page.goBack();await page.goBack();
    await page.getByRole('tab',{name:'Multi-agent workflow'}).click();
    await page.getByRole('button',{name:'Draft → human approval → publish'}).click();
    await page.selectOption('select[aria-label="Default model"]','deterministic|sim-text');
    await page.getByRole('button',{name:'Start workflow'}).click();
    await page.waitForSelector('text=Approval needed',{timeout:60000});
    await shot('04-approval');
    await page.getByRole('button',{name:'Approve',exact:true}).click();
    await page.waitForSelector('.row .state.succeeded',{timeout:60000});
    // code workspace (sandbox)
    if(new Sandbox().backend){
      await page.goto(page.url().replace(/#.*/,'')+'#/projects');
      await page.getByText('Browser project').click();
      await page.getByRole('tab',{name:'Code'}).click();
      await page.fill('input[aria-label="File path"]','test_math.py');
      await page.fill('textarea[aria-label="File content"]','import unittest\nclass T(unittest.TestCase):\n    def test_sum(self):\n        self.assertEqual(sum([1,2,3]), 6)\n');
      await page.getByRole('button',{name:'Save',exact:true}).click();
      await page.getByRole('button',{name:'Run tests'}).click();
      await page.waitForFunction(()=>/exit 0/.test(document.querySelector('pre.output')?.textContent||''),null,{timeout:60000});
      assert.match(await page.textContent('pre.output'),/Ran 1 test/);
      await page.fill('input[aria-label="File path"]','index.html');
      await page.fill('textarea[aria-label="File content"]','<h1 id="t">Hello preview</h1>');
      await page.getByRole('button',{name:'Save',exact:true}).click();
      await page.getByRole('button',{name:'Preview'}).click();
      const frame=page.frameLocator('iframe.preview');
      await frame.locator('#t').waitFor();assert.equal(await frame.locator('#t').textContent(),'Hello preview');
      await shot('05-code');
    }
    // models & budget page renders usage
    await page.getByRole('link',{name:'Models & budget'}).click();
    await page.waitForSelector('text=Usage (30 days)');
    assert.ok(await page.locator('text=deterministic (sim)').count()>=1);
    await shot('06-budget');
    assert.deepEqual(errors,[]);
  }finally{await browser.close();ac.abort();await loop;await app.stop();await db.drop();}
});
