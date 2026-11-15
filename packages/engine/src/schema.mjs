// Small JSON Schema validator (draft-07 subset) used for structured outputs and tool arguments.
import {EngineError,isObject} from './infra.mjs';

const UNSAFE=new Set(['__proto__','constructor','prototype']);
export function parseJSONSafe(text){
  let s=String(text).trim();
  const fence=/^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(s);if(fence)s=fence[1];
  if(!/^[[{]/.test(s)){const i=s.search(/[[{]/);if(i>=0)s=s.slice(i);}
  return JSON.parse(s,(k,v)=>UNSAFE.has(k)?undefined:v);
}
function typeOf(v){if(v===null)return 'null';if(Array.isArray(v))return 'array';if(Number.isInteger(v))return 'integer';return typeof v;}
export function validate(schema,value,path='$',errors=[],depth=0){
  if(!schema||depth>32||errors.length>20)return errors;
  if(schema.anyOf){if(!schema.anyOf.some(s=>validate(s,value,path,[],depth+1).length===0))errors.push(`${path}: does not match any allowed shape`);return errors;}
  if(schema.oneOf){if(schema.oneOf.filter(s=>validate(s,value,path,[],depth+1).length===0).length!==1)errors.push(`${path}: must match exactly one shape`);return errors;}
  if(schema.type){
    const types=Array.isArray(schema.type)?schema.type:[schema.type];const t=typeOf(value);
    if(!types.some(x=>x===t||(x==='number'&&t==='integer')))errors.push(`${path}: expected ${types.join('|')}, got ${t}`);
  }
  if(schema.enum&&!schema.enum.some(e=>JSON.stringify(e)===JSON.stringify(value)))errors.push(`${path}: not one of ${JSON.stringify(schema.enum).slice(0,200)}`);
  if(schema.const!==undefined&&JSON.stringify(schema.const)!==JSON.stringify(value))errors.push(`${path}: must equal ${JSON.stringify(schema.const)}`);
  if(typeof value==='string'){
    if(schema.minLength!=null&&[...value].length<schema.minLength)errors.push(`${path}: shorter than ${schema.minLength}`);
    if(schema.maxLength!=null&&[...value].length>schema.maxLength)errors.push(`${path}: longer than ${schema.maxLength}`);
    if(schema.pattern){try{if(!new RegExp(schema.pattern,'u').test(value))errors.push(`${path}: does not match pattern`)}catch{}}
  }
  if(typeof value==='number'){
    if(schema.minimum!=null&&value<schema.minimum)errors.push(`${path}: below minimum ${schema.minimum}`);
    if(schema.maximum!=null&&value>schema.maximum)errors.push(`${path}: above maximum ${schema.maximum}`);
  }
  if(Array.isArray(value)){
    if(schema.minItems!=null&&value.length<schema.minItems)errors.push(`${path}: fewer than ${schema.minItems} items`);
    if(schema.maxItems!=null&&value.length>schema.maxItems)errors.push(`${path}: more than ${schema.maxItems} items`);
    if(schema.items)value.forEach((v,i)=>validate(schema.items,v,`${path}[${i}]`,errors,depth+1));
  }
  if(isObject(value)){
    for(const r of schema.required||[])if(!Object.hasOwn(value,r))errors.push(`${path}: missing required property ${r}`);
    const props=schema.properties||{};
    for(const [k,v] of Object.entries(value)){
      if(props[k])validate(props[k],v,`${path}.${k}`,errors,depth+1);
      else if(schema.additionalProperties===false)errors.push(`${path}: unexpected property ${k}`);
      else if(isObject(schema.additionalProperties))validate(schema.additionalProperties,v,`${path}.${k}`,errors,depth+1);
    }
  }
  return errors;
}
export function assertValid(schema,value,code='schema_mismatch'){
  const e=validate(schema,value);if(e.length)throw new EngineError(code,422,e.slice(0,5).join('; '));return value;
}
export function assertSchemaShape(schema){
  if(!isObject(schema)||Buffer.byteLength(JSON.stringify(schema))>32768)throw new EngineError('invalid_schema',400,'Schema must be an object under 32KB');
  if(schema.type!=='object')throw new EngineError('invalid_schema',400,'Top-level output schema must be type object');
  return schema;
}
