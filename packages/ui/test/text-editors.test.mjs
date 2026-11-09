import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {editableArtifact,PoetryEditor,PersuasionEditor,FictionEditor} from '../src/text-editors.mjs';
test('distinct editors render specialized controls',()=>{
 const views=[PoetryEditor,PersuasionEditor,FictionEditor].map(Component=>renderToStaticMarkup(React.createElement(Component,{onSave:()=>{}})));
 assert.match(views[0],/Stanzas and lines/);assert.match(views[1],/Evidence and citations/);
 assert.match(views[2],/Continuity references/);assert.equal(new Set(views).size,3);
});
test('typed artifacts round-trip independently',()=>{
 for(const kind of ['poetry','persuasion','fiction']){
  const document=editableArtifact(kind,{});
  assert.deepEqual(editableArtifact(kind,JSON.parse(JSON.stringify(document)).fields),document);
  assert.ok(Object.isFrozen(document.fields));
 }
});
test('unexpected fields and malformed content rejected',()=>{
 assert.throws(()=>editableArtifact('fiction',{apiKey:'secret'}));
 assert.throws(()=>editableArtifact('poetry',{stanzas:123}));
 assert.throws(()=>editableArtifact('unknown',{}));
});
