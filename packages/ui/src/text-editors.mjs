import React,{createElement as h,useState} from 'react';
const FIELDS={
 poetry:[['title','Title'],['stanzas','Stanzas and lines'],['meter','Meter and rhythm'],['sound','Sound and rhyme']],
 persuasion:[['audience','Audience'],['claim','Central claim'],['evidence','Evidence and citations'],['objections','Objections and replies']],
 fiction:[['scene','Scene'],['characters','Characters'],['continuity','Continuity references'],['setting','Setting']]
};
export function editableArtifact(kind,values={}) {
 const controls=FIELDS[kind];
 if(!controls||values===null||typeof values!=='object'||Array.isArray(values))throw new TypeError('Invalid editor data');
 if(Object.keys(values).some(k=>!controls.some(x=>x[0]===k)))throw new TypeError('Unknown editor field');
 const fields={};
 for(const [id] of controls){const v=values[id]??'';
  if(typeof v!=='string'||v.length>100000||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v))throw new TypeError('Invalid editor text');
  fields[id]=v;
 }
 return Object.freeze({schemaVersion:1,kind,mediaType:'application/vnd.sie.'+kind+'+json',fields:Object.freeze(fields)});
}
export function TextEditor({kind,initial={},onSave}) {
 const controls=FIELDS[kind];if(!controls)throw new TypeError('Unknown editor');
 const [values,setValues]=useState(()=>editableArtifact(kind,initial).fields);
 return h('form',{'aria-label':kind+' editor','data-editor-kind':kind,onSubmit:e=>{e.preventDefault();onSave?.(editableArtifact(kind,values));}},
  h('h2',null,kind==='poetry'?'Poetry studio':kind==='persuasion'?'Persuasion workshop':'Fiction scene editor'),
  ...controls.map(([id,label])=>h('label',{key:id},label,h('textarea',{value:values[id],maxLength:100000,
   onChange:e=>setValues(previous=>({...previous,[id]:e.currentTarget.value}))}))),
  h('button',{type:'submit',disabled:typeof onSave!=='function'},'Save editable artifact'));
}
export const PoetryEditor=props=>h(TextEditor,{...props,kind:'poetry'});
export const PersuasionEditor=props=>h(TextEditor,{...props,kind:'persuasion'});
export const FictionEditor=props=>h(TextEditor,{...props,kind:'fiction'});
