#!/usr/bin/env node
// Certify a provider adapter against the engine contract (SIE-040).
//   node scripts/certify-adapter.mjs <module.mjs> [--model <id>] [--media image,speech]
// The module default-exports {make({apiKey,baseUrl,fetchImpl}), model?, media?}. With no module, the built-in
// deterministic adapter is certified. Live provider calls happen only if the module's make() uses a real key.
import {resolve} from 'node:path';import {pathToFileURL} from 'node:url';
import {certifyAdapter} from '../packages/engine/src/certify.mjs';
import {DeterministicAdapter} from '../packages/engine/src/providers.mjs';
const args=process.argv.slice(2);const opt=k=>{const i=args.indexOf(k);return i>=0?args[i+1]:undefined};
const file=args.find(a=>!a.startsWith('--')&&!args[args.indexOf(a)-1]?.startsWith('--'));
let spec={make:()=>new DeterministicAdapter({delayMs:0}),model:'sim-text',media:['image','speech','music'],errors:false};
if(file)spec=(await import(pathToFileURL(resolve(file)).href)).default;
const model=opt('--model')||spec.model;const media=(opt('--media')?.split(',').filter(Boolean))||spec.media||[];
const report=await certifyAdapter(spec.make({apiKey:process.env.CERT_API_KEY||'',baseUrl:process.env.CERT_BASE_URL}),{model,media,make:spec.errors===false?undefined:spec.make});
console.log(JSON.stringify(report,null,2));process.exitCode=report.passed?0:1;
