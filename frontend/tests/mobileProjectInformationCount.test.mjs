import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {build} from 'esbuild';
const source=await readFile(new URL('../src/pages/MobileAssignmentDetailPage.tsx',import.meta.url),'utf8');
const styles=await readFile(new URL('../src/pages/MobileProjectFile.css',import.meta.url),'utf8');
const count=source.slice(source.indexOf('function MobileProjectInformationCount('),source.indexOf('function MobileProjectNotes('));
const hook=source.slice(source.indexOf('function useMobileProjectNotes('),source.indexOf('function MobileProjectInformationCount('));
const compiled=await build({stdin:{contents:`import React from 'react';import {renderToStaticMarkup} from 'react-dom/server';
  export function render(notes){const useMobileProjectNotes=()=>({notes});${count};return renderToStaticMarkup(<MobileProjectInformationCount assignmentId={42}/>);}
  export function lifecycle(){
    const state=[],listeners=new Map(),requests=[];let index=0,effect;
    const useState=value=>{const i=index++;if(!(i in state))state[i]=value;return [state[i],next=>{state[i]=typeof next==='function'?next(state[i]):next;}];};
    const useEffect=fn=>{effect=fn;};
    const window={addEventListener:(name,fn)=>listeners.set(name,fn),removeEventListener:name=>listeners.delete(name)};
    const document={...window,visibilityState:'visible'};
    const api={mobileProjectNotes:id=>new Promise((resolve,reject)=>requests.push({id,resolve,reject}))};
    ${hook}
    index=0;useMobileProjectNotes(42);const cleanup=effect();
    return {state,listeners,requests,cleanup,document};
  }
`,resolveDir:fileURLToPath(new URL('..',import.meta.url)),loader:'tsx'},bundle:true,write:false,format:'cjs',platform:'node',packages:'external',jsx:'automatic'});
const module={exports:{}};
new Function('require','module','exports',compiled.outputFiles[0].text)(createRequire(import.meta.url),module,module.exports);
const note=content=>({content});
test('badge counts nonempty general info and published notes, up to four',()=>{
  for(let n=0;n<=3;n++){
    const html=module.exports.render({info:'General',note_blocks:Array.from({length:n},()=>note('Text'))});
    assert.match(html,new RegExp('>'+String(n+1)+'</span>'));
  }
  assert.match(module.exports.render({info:' ',note_blocks:[note(''),note('  ')]}),/>0<\/span>/);
  assert.match(module.exports.render({info:null,note_blocks:[note('Text')]}),/aria-label="1 Information hinterlegt"/);
  assert.match(module.exports.render({info:'General',note_blocks:Array.from({length:5},()=>note('Text'))}),/>4<\/span>/);
  assert.equal(module.exports.render(null),'');
  assert.match(styles,/\.mobile-project-information-count \{[^}]*background: #c53045;/s);
  assert.match(source,/<MobileProjectInformationCount assignmentId=\{assignment.id\} \/>/);
});
test('shared notes query refreshes on focus, clears stale counts and ignores obsolete responses',async()=>{
  const f=module.exports.lifecycle();assert.equal(f.requests[0].id,42);
  const old={info:'Old',note_blocks:[]},fresh={info:null,note_blocks:[]};
  f.requests[0].resolve(old);await Promise.resolve();assert.equal(f.state[0],old);
  f.listeners.get('focus')();assert.equal(f.state[0],null);
  f.listeners.get('visibilitychange')();
  f.requests[2].resolve(fresh);await Promise.resolve();
  f.requests[1].resolve(old);await Promise.resolve();assert.equal(f.state[0],fresh);
  f.listeners.get('focus')();f.requests[3].reject(Error('offline'));await Promise.resolve();
  assert.equal(f.state[0],null);assert.equal(f.state[1],true);
  f.listeners.get('focus')();f.cleanup();f.requests[4].resolve(old);await Promise.resolve();
  assert.equal(f.state[0],null);assert.equal(f.listeners.size,0);
});
