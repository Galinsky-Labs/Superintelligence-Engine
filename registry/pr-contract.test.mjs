import test from 'node:test';
import assert from 'node:assert/strict';
import {parsePrRegistry,attachObservedWorkIds} from './pr-contract.mjs';
const unit={id:'EX-001',title:'Example',origin:'original',prs:[],dependsOn:[]};
const document={schemaVersion:1,repository:'example/project',roadmapVersion:1,planVerified:true,
  plannedPrCount:1,observedAt:'2026-10-13T00:00:00Z',units:[unit],pullRequests:[]};
const parse=doc=>parsePrRegistry(JSON.stringify(doc),'example/project');
test('one source format rejects redirects, legacy arrays, wrong identities and versions',()=>{
  for(const change of [{redirectTo:'other.json'},{milestones:[]},{repository:'other/project'},{schemaVersion:2},{plannedPrCount:2}])
    assert.throws(()=>parse({...document,...change}));
});
test('partial and historical PR evidence never becomes completion through title inference',()=>{
  for(const evidence of [{contributingPrs:[8]},{priorEvidencePrs:[8]}]){
    const {items}=parse({...document,units:[{...unit,...evidence}]});
    assert.deepEqual(attachObservedWorkIds(items,[{number:8,title:'EX-001: Partial implementation',state:'closed'}])[0].numbers,[]);
  }
});
test('open follow-ups revoke completion, ambiguous historical matches remain unresolved',()=>{
  const explicit=parse({...document,units:[{...unit,prs:[7]}]}).items;
  assert.deepEqual(attachObservedWorkIds(explicit,[{number:8,title:'EX-001: Follow-up',state:'open'}])[0].numbers,[7,8]);
  const ambiguous=attachObservedWorkIds(parse(document).items,[{number:7,title:'EX-001: First'},{number:8,title:'EX-001: Second'}])[0];
  assert.equal(ambiguous.ambiguous,true);assert.deepEqual(ambiguous.numbers,[]);
});
test('local dependency errors fail closed while explicit external gates survive parsing',()=>{
  assert.throws(()=>parse({...document,units:[{...unit,dependsOn:['EX-002']}]}));
  assert.throws(()=>parse({...document,units:[{...unit,dependsOn:['EX-001']}]}));
  const externalDependencies=[{repository:'example/upstream',unitId:'UP-001'}];
  const externalPrerequisites=['Independent acceptance review'];
  const parsed=parse({...document,units:[{...unit,externalDependencies,externalPrerequisites,scope:'Preserved scope'}]});
  assert.deepEqual(parsed.items[0].externalDependencies,externalDependencies);
  assert.deepEqual(parsed.items[0].externalPrerequisites,externalPrerequisites);
  assert.equal(parsed.document.units[0].scope,'Preserved scope');
});
