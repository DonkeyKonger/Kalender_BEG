import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";

const source=await readFile(new URL('../src/pages/MobileAssignmentDetailPage.tsx',import.meta.url),'utf8');
const extra=source.slice(source.indexOf('function MobileExtraWorkTab('),source.indexOf('function ExtraWorkOrderOverview('));
const header=extra.match(/<header className="mobile-measurement-page-header">[^]*?<\/header>/)[0];
const compiled=await build({stdin:{contents:`import React from 'react'; import {renderToStaticMarkup} from 'react-dom/server'; import {ArrowLeft,Plus} from 'lucide-react';
  export function tree({assignment,isSaving=false,requiresApproval=false,onBack,createOrder}) { return (${header}); }
  export const render=props=>renderToStaticMarkup(tree(props));`,resolveDir:fileURLToPath(new URL('..',import.meta.url)),loader:'tsx'},bundle:true,write:false,format:'cjs',platform:'node',packages:'external',jsx:'automatic'});
const module={exports:{}};
new Function('require','module','exports',compiled.outputFiles[0].text)(createRequire(import.meta.url),module,module.exports);
const assignment={id:42,site:{site_number:'9999',name:'Testbaustelle Finienweg'}};

test('timesheet list reuses the measurement topbar and site-only subtitle',()=>{
  const html=module.exports.render({assignment});
  assert.match(html,/mobile-measurement-page-topbar/);
  assert.match(html,/>Projektakte</);
  assert.match(html,/>Neuer Stundenzettel</);
  assert.match(html,/<p>Testbaustelle Finienweg<\/p>/);
  assert.doesNotMatch(html,/<h1\b|9999|mobile-panel-title-row/);
});

test('timesheet header preserves navigation, creation, approval and saving variants',()=>{
  const events=[];
  const tree=module.exports.tree({assignment,onBack:()=>events.push('back'),createOrder:()=>events.push('create')});
  const [back,create]=tree.props.children[0].props.children;
  back.props.onClick();create.props.onClick();
  assert.deepEqual(events,['back','create']);
  assert.match(module.exports.render({assignment,requiresApproval:true}),/>Neue Stundenfreigabe</);
  const busy=module.exports.render({assignment,isSaving:true});
  assert.match(busy,/disabled=""/);
  assert.match(busy,/>Erstelle\.\.\.</);
});
