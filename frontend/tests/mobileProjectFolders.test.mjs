import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {build} from 'esbuild';
const source=await readFile(new URL('../src/pages/MobileAssignmentDetailPage.tsx',import.meta.url),'utf8');
const hookSource=await readFile(new URL('../src/pages/useProjectFolderFileCounts.ts',import.meta.url),'utf8');
const hook=hookSource.slice(hookSource.indexOf('export function')).replace('export function','function');
const panel=source.slice(source.indexOf('function MobileProjectFoldersPanel('),source.indexOf('function MobileDocumentPreview('));
const header=source.slice(source.indexOf('function MobileProjectFoldersHeader('),source.indexOf('function MobileExtraWorkTab('));
const compiled=await build({stdin:{contents:`import React from 'react';import {renderToStaticMarkup} from 'react-dom/server';
  import {ArrowLeft,FolderOpen,ChevronRight} from 'lucide-react';
  export function tree(folders,counts){
    let index=0;const updates=[];const useState=value=>{const i=index++;return [i===0?folders:i===4?false:value,next=>updates.push([i,next])];};
    const useAuth=()=>({user:{role:'worker'}});const useRef=()=>({current:null});const useCallback=fn=>fn;const useEffect=()=>{};
    const useProjectFolderFileCounts=()=>counts;
    ${panel}
    return {node:MobileProjectFoldersPanel({assignment:{site:{id:42}}}),updates};
  }
  ${header}
  export const render=(folders,counts)=>renderToStaticMarkup(tree(folders,counts).node);
  export const renderHeader=()=>renderToStaticMarkup(<MobileProjectFoldersHeader assignment={{site:{name:'Baustelle',site_number:'9999',customer:'Kunde'}}} onBack={()=>{}}/>);
  export function lifecycle(){
    let state={},effect;const listeners=new Map(),requests=[];
    const useState=()=>[state,next=>{state=typeof next==='function'?next(state):next;}];
    const useEffect=fn=>{effect=fn;};
    const window={addEventListener:(name,fn)=>listeners.set(name,fn),removeEventListener:name=>listeners.delete(name)};
    const document={...window,visibilityState:'visible'};
    const api={projectFolderFileCount:(id,key)=>new Promise((resolve,reject)=>requests.push({id,key,resolve,reject}))};
    ${hook}
    useProjectFolderFileCounts(42,[{folder_key:'a'},{folder_key:'b'},{folder_key:'c'}]);const cleanup=effect();
    return {get state(){return state;},listeners,requests,cleanup};
  }
`,resolveDir:fileURLToPath(new URL('..',import.meta.url)),loader:'tsx'},bundle:true,write:false,format:'cjs',platform:'node',packages:'external',jsx:'automatic'});
const module={exports:{}};
new Function('require','module','exports',compiled.outputFiles[0].text)(createRequire(import.meta.url),module,module.exports);
const folders=[{id:1,folder_key:'a',sort_order:5,name:'Terminplan'},{id:2,folder_key:'b',sort_order:8,name:'Aufmaß'}];
const collect=node=>!node||typeof node!=='object'?[]:Array.isArray(node)?node.flatMap(collect):[node,...collect(node.props?.children)];

test('folder design uses the site-name back link and compact rows with exact file counts',()=>{
  const html=module.exports.render(folders,{a:0,b:123});
  assert.match(html,/mobile-folder-overview/);
  assert.match(html,/aria-label="0 Dateien einschließlich Unterordner"/);
  assert.match(html,/aria-label="123 Dateien einschließlich Unterordner"/);
  assert.equal((html.match(/mobile-folder-chevron/g)||[]).length,2);
  assert.match(html,/Terminplan/);
  const heading=module.exports.renderHeader();
  assert.match(heading,/Zurück zur Projektakte: Baustelle/);
  assert.doesNotMatch(heading,/9999|Kunde|mobile-detail-summary/);
  const result=module.exports.tree(folders,{});
  collect(result.node).find(n=>n.props?.className==='mobile-folder-card').props.onClick();
  assert.deepEqual(result.updates,[[1,folders[0]]]);
});

test('unknown and failed counts never masquerade as empty folders',()=>{
  assert.doesNotMatch(module.exports.render(folders,{}),/class="mobile-folder-file-count"/);
  assert.match(module.exports.render(folders,{a:null}),/Dateianzahl nicht verfügbar/);
  assert.match(module.exports.render([],{}),/Keine Ordner vorhanden/);
});

test('count requests are bounded, refreshable and ignore unmounted responses',async()=>{
  const f=module.exports.lifecycle();
  assert.equal(f.requests.length,2);
  assert.equal(f.requests[0].id,42);
  f.requests[0].resolve({file_count:0});await Promise.resolve();
  assert.equal(f.state.a,0);assert.equal(f.requests.length,3);
  f.requests[1].reject(Error('offline'));await Promise.resolve();assert.equal(f.state.b,null);
  f.requests[2].resolve({file_count:17});
  for(let i=0;i<5;i++)await Promise.resolve();
  assert.equal(f.state.c,17);
  f.listeners.get('focus')();assert.deepEqual(f.state,{});assert.equal(f.requests.length,5);
  f.cleanup();f.requests[3].resolve({file_count:999});await Promise.resolve();
  assert.deepEqual(f.state,{});assert.equal(f.listeners.size,0);assert.equal(f.requests.length,5);
});
