import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";

const source=await readFile(new URL('../src/pages/MobileAssignmentDetailPage.tsx',import.meta.url),'utf8');
const styles=await readFile(new URL('../src/pages/MobileMeasurementList.css',import.meta.url),'utf8');
const header=source.slice(source.indexOf('function MobileMeasurementTab(')).match(/<header className="mobile-measurement-page-header">[^]*?<\/header>/)[0];
const compiled=await build({stdin:{contents:`import React from 'react'; import {renderToStaticMarkup} from 'react-dom/server'; import {ArrowLeft,Plus} from 'lucide-react';
  export function tree({assignment,isSaving=false,onBackToProject,setIsSaving,setError,api,loadBatches,setSelectedBatch,setIsBatchPositionOverviewOpen,loadBatchItems}) {
    const readApiError=(_error,fallback)=>fallback;
    return (${header});
  }
  export const render=props=>renderToStaticMarkup(tree(props));`,resolveDir:fileURLToPath(new URL('..',import.meta.url)),loader:'tsx'},bundle:true,write:false,format:'cjs',platform:'node',packages:'external',jsx:'automatic'});
const module={exports:{}};
new Function('require','module','exports',compiled.outputFiles[0].text)(createRequire(import.meta.url),module,module.exports);
const assignment={id:42,site:{site_number:'9999',name:'Testbaustelle Finienweg'}};
const buttons=tree=>tree.props.children[0].props.children;

test('measurement list keeps back and create in one top row, with site name underneath and no commission number',()=>{
  const html=module.exports.render({assignment});
  assert.match(html,/mobile-measurement-page-topbar/);
  assert.match(html,/>Projektakte</);
  assert.match(html,/>Neues Aufmaß</);
  assert.match(html,/<p>Testbaustelle Finienweg<\/p>/);
  assert.doesNotMatch(html,/<h1\b|>Aufmaße</);
  assert.doesNotMatch(html,/9999/);
  assert.match(styles,/mobile-measurement-page-topbar \{[^}]*display: flex;[^}]*justify-content: space-between;/s);
  assert.match(styles,/mobile-measurement-page-topbar \.mobile-back-button \{[^}]*border: 0;[^}]*background: transparent;/s);
  assert.match(styles,/mobile-measurement-new-action \{[^}]*background: #315f91;/s);
});

test('header preserves back navigation and the complete create workflow',async()=>{
  const events=[];const batch={id:7};
  const record=name=>value=>events.push([name,value]);
  const props={assignment,onBackToProject:()=>events.push(['back']),setIsSaving:record('saving'),setError:record('error'),api:{createMobileMeasurementBatch:async id=>{events.push(['create',id]);return batch;}},loadBatches:record('loadBatches'),setSelectedBatch:record('select'),setIsBatchPositionOverviewOpen:record('positions'),loadBatchItems:record('loadItems')};
  const [back,create]=buttons(module.exports.tree(props));
  back.props.onClick();await create.props.onClick();
  assert.deepEqual(events,[['back'],['saving',true],['error',null],['create',42],['loadBatches',7],['select',batch],['positions',false],['loadItems',batch],['saving',false]]);
  events.length=0;
  props.api.createMobileMeasurementBatch=async()=>{throw Error('failed');};
  await buttons(module.exports.tree(props))[1].props.onClick();
  assert.deepEqual(events,[['saving',true],['error',null],['error','Aufmaß konnte nicht erstellt werden.'],['saving',false]]);
});

test('busy creation and responsive touch targets are preserved',()=>{
  const html=module.exports.render({assignment,isSaving:true});
  assert.match(html,/disabled=""/);
  assert.match(html,/Erstelle/);
  assert.match(styles,/mobile-measurement-page-topbar button \{[^}]*min-height: 44px;[^}]*white-space: normal;/s);
  assert.match(styles,/mobile-measurement-page-title p \{[^}]*overflow-wrap: anywhere;/s);
});
