import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {build} from 'esbuild';
const source=await readFile(new URL('../src/pages/MobileAssignmentDetailPage.tsx',import.meta.url),'utf8');
const styles=await readFile(new URL('../src/pages/MobileSiteOverview.css',import.meta.url),'utf8');
const components=source.slice(source.indexOf('function OverviewPanel('),source.indexOf('function MobileProjectPhotoCapture('));
const helpers=source.slice(source.indexOf('function formatMobileSiteAddressLabel('),source.indexOf('function getMobileMeasurementPdfFilename('));
const compiled=await build({stdin:{contents:`import React from 'react'; import {renderToStaticMarkup} from 'react-dom/server';
  import {MapPin,ExternalLink,UserRound,Building2,MessageSquare} from 'lucide-react';
  let options,stateIndex=0;const useEffect=()=>{};
  const useState=value=>[stateIndex++===0?options.notes:stateIndex===2?options.error||false:value,()=>{}];
  ${helpers}
  ${components}
  export function render(assignment,config={notes:{info:null,note_blocks:[]}}){options=config;stateIndex=0;return renderToStaticMarkup(<OverviewPanel assignment={assignment}/>);}
  export const route=buildGoogleMapsDirectionsUrl;
`,resolveDir:fileURLToPath(new URL('..',import.meta.url)),loader:'tsx'},bundle:true,write:false,format:'cjs',platform:'node',packages:'external',jsx:'automatic'});
const module={exports:{}};
new Function('require','module','exports',compiled.outputFiles[0].text)(createRequire(import.meta.url),module,module.exports);
const assignment={site:{name:'Testbaustelle',street:'Finienweg',house_number:'12a',postal_code:'28832',city:'Achim',address_extra:'Hinterhof',project_manager:{display_name:'CE'},customer:'Kunde GmbH'},note:null};

test('overview starts with the address without redundant subtitle or site-name heading',()=>{
  const html=module.exports.render(assignment);
  assert.match(html,/^<div class="mobile-site-overview"><section class="mobile-site-address-card"/);
  assert.doesNotMatch(html,/Baustellenübersicht|<h1|mobile-site-overview-heading/);
  assert.doesNotMatch(styles,/mobile-site-overview-heading/);
});

test('overview separates address fields and keeps the route without duplicated project contacts',()=>{
  const html=module.exports.render(assignment);
  for(const [label,value] of [['Straße','Finienweg'],['Hausnummer','12a'],['PLZ','28832'],['Stadt','Achim']]) assert.match(html,new RegExp('<dt>'+label+'</dt><dd[^>]*>'+value+'</dd>'));
  assert.doesNotMatch(html,/mobile-site-contacts|Projektleiter|Kunde GmbH/);
  assert.match(html,/Hinterhof/);assert.match(html,/href="https:\/\/www.google.com\/maps\/dir/);
  assert.match(decodeURIComponent(module.exports.route(assignment.site)),/Finienweg 12a, 28832 Achim/);
  assert.match(source,/mobile-back-button mobile-site-overview-back/);
});

test('legacy and missing addresses are never guessed or hidden',()=>{
  const site={name:'Altbestand',address:'Hamburg, Deutschland',location:'Hamburg'};
  const html=module.exports.render({site});
  assert.equal((html.match(/class="is-missing"/g)||[]).length,4);
  assert.match(html,/Vorhandene Adressangabe/);assert.match(html,/Hamburg - Hamburg, Deutschland/);
  assert.equal(module.exports.route({}),null);
  assert.doesNotMatch(module.exports.render({site:{name:'Leer'}}),/mobile-site-route-link/);
});

test('information bubbles start with their content without visible block titles and retain version and paragraphs',()=>{
  const html=module.exports.render({...assignment,note:'Einsatz beachten'}, {notes:{info:'Allgemeiner Hinweis',note_blocks:[{id:1,title:'Monteurinfo',number:3,updated_at:'2026-09-14T12:00:00Z',content:'Erster Absatz\n\nZweiter Absatz <script>'}]}});
  assert.match(html,/mobile-site-note-bubble is-general/);assert.match(html,/mobile-site-note-bubble is-assignment/);
  assert.match(html,/aria-label="Allgemeine Information"><p>Allgemeiner Hinweis<\/p>/);
  assert.match(html,/aria-label="Monteurinfo"><p>Erster Absatz/);
  assert.match(html,/aria-label="Einsatzhinweis"><p>Einsatz beachten<\/p>/);
  assert.doesNotMatch(html,/<strong>|<h3/);
  assert.doesNotMatch(styles,/\.mobile-site-note-bubble strong/);
  assert.match(html,/Stand 3 ·/);assert.match(html,/Erster Absatz\n\nZweiter Absatz &lt;script&gt;/);
  assert.match(styles,/white-space: pre-wrap/);assert.match(styles,/overflow-wrap: anywhere/);
  assert.match(styles,/body:has\(\.mobile-site-overview\) \{ min-width: 0; \}/);
  assert.doesNotMatch(html,/textarea|type="submit"/);
});

test('notes preserve loading, empty, retry states and avoid cached published note blocks',()=>{
  const site={...assignment.site,general_info:'Allgemein',info:'Veralteter kombinierter Text',note_blocks:[{title:'Veralteter Notizstand'}]};
  const loading=module.exports.render({site},{notes:null});
  assert.match(loading,/Informationen werden geladen/);assert.match(loading,/Allgemein/);
  assert.doesNotMatch(loading,/Veralteter/);
  assert.match(module.exports.render(assignment),/Noch keine Informationen hinterlegt/);
  assert.match(module.exports.render(assignment,{notes:null,error:true}),/role="alert"/);
  assert.match(module.exports.render(assignment,{notes:null,error:true}),/Erneut laden/);
  assert.match(components,/window.addEventListener\("focus", onVisible\)/);
  assert.match(components,/document.addEventListener\("visibilitychange", onVisible\)/);
});
