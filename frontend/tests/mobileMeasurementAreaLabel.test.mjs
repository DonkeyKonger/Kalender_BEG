import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import test from 'node:test';
import ts from 'typescript';
const require=createRequire(import.meta.url);
const source=readFileSync(new URL('../src/components/MobileMeasurementAreaLabel.tsx',import.meta.url),'utf8');
const compiled=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;
function harness(onSave=async()=>{},onStart=async()=>true){
 const values=[];let cursor=0;
 const hooks={useEffect(){},useState(initial){const i=cursor++;if(!(i in values))values[i]=initial;return[values[i],v=>{values[i]=v;}];},useRef(initial){const i=cursor++;if(!(i in values))values[i]={current:initial};return values[i];}};
 const exports={};new Function('require','exports',compiled)(id=>id==='react'?hooks:require(id),exports);
 const render=()=>{cursor=0;return exports.MobileMeasurementAreaLabel({area:'EG',disabled:false,onStart,onSave});};
 return{render,start:()=>render().props.children[0].props.onFocus(),input:()=>render().props.children[0],key(key){this.input().props.onKeyDown({key,preventDefault(){}});}};
}
const settle=()=>new Promise(resolve=>setImmediate(resolve));
test('existing area remains editable repeatedly and Enter plus blur saves only once',async()=>{
 let finish;const saved=[];const h=harness(value=>{saved.push(value);return new Promise(resolve=>{finish=resolve;});});
 await h.start();h.input().props.onChange({target:{value:' og   flur '}});
 h.key('Enter');h.input().props.onBlur();await settle();assert.deepEqual(saved,['OG FLUR']);assert.equal(h.input().props.readOnly,true);
 finish();await settle();assert.equal(h.input().props.value,'OG FLUR');await h.start();assert.equal(h.input().type,'input');
});
test('Escape discards edits even when blur follows',async()=>{
 const saved=[];const h=harness(async value=>saved.push(value));await h.start();h.input().props.onChange({target:{value:'KG'}});
 const input=h.input();h.key('Escape');input.props.onBlur();await settle();assert.deepEqual(saved,[]);assert.equal(h.input().props.value,'EG');
});
test('empty names and failed saves retain the editable draft',async()=>{
 let fail=true;const saved=[];const h=harness(async value=>{saved.push(value);if(fail)throw new Error('Ort existiert bereits');});
 await h.start();h.input().props.onChange({target:{value:'  '}});h.key('Enter');await settle();assert.equal(h.input().props['aria-invalid'],true);assert.equal(saved.length,0);
 h.input().props.onChange({target:{value:'KG'}});h.key('Enter');await settle();assert.equal(h.input().props.value,'KG');assert.equal(h.render().props.children[1].props.children,'Ort existiert bereits');
 fail=false;h.key('Enter');await settle();assert.equal(h.input().props.value,'KG');assert.equal(h.input().props['aria-invalid'],false);
});
test('failed quantity save prevents opening a conflicting area edit',async()=>{
 const saved=[];const h=harness(async value=>saved.push(value),async()=>false);await h.start();h.input().props.onChange({target:{value:'KG'}});h.key('Enter');await settle();assert.deepEqual(saved,[]);
});
test('tablet reuses phone keypad with a larger touch target and Weiter',()=>{
 const page=readFileSync(new URL('../src/pages/MobileAssignmentDetailPage.tsx',import.meta.url),'utf8');
 const keypad=page.slice(page.indexOf('function MeasurementTableFixedKeypad('),page.indexOf('function MeasurementDetail('));
 assert.match(keypad,/<MeasurementQuantityKeypad variant="entry"/);assert.match(keypad,/>\s*Weiter\s*</);assert.doesNotMatch(keypad,/Speichern|onEnter|const keys/);
 assert.match(keypad,/onPointerDown=\{\(event\) => event.preventDefault\(\)\}/);
 const css=readFileSync(new URL('../src/pages/MobileMeasurementTablet.css',import.meta.url),'utf8');assert.match(css,/min-height: 52px/);
});
test('tablet descriptions show five fixed lines with slightly wider columns',()=>{
 const css=readFileSync(new URL('../src/pages/MobileMeasurementTablet.css',import.meta.url),'utf8');
 assert.match(css,/width: 140px;\s*min-width: 140px;\s*max-width: 140px;/);
 assert.match(css,/height: 6\.75em;\s*max-height: 6\.75em;/);
 assert.match(css,/height: calc\(6\.75em \+ 14px\)/);
});
test('empty area cells have no native button decoration at any tablet width',()=>{
 const css=readFileSync(new URL('../src/pages/MobileMeasurementTablet.css',import.meta.url),'utf8');
 const button=css.match(/\.measurement-matrix-empty-area-button \{([^}]+)\}/)[1];
 for(const rule of ['display: block','width: 100%','min-height: 40px','appearance: none','-webkit-appearance: none','border: 0','background: transparent','box-shadow: none','padding: 0','cursor: text']) assert.ok(button.includes(rule),rule);
 assert.doesNotMatch(css,/@media/);
 assert.match(css,/\.measurement-matrix-empty-area-button:focus-visible/);
});
test('tablet freezes all four header rows in a viewport-bounded scroller',()=>{
 const page=readFileSync(new URL('../src/pages/MobileAssignmentDetailPage.tsx',import.meta.url),'utf8');
 const table=page.slice(page.indexOf('function MobileMeasurementTable('));
 const header=table.slice(table.indexOf('<thead>'),table.indexOf('</thead>'));
 for(const label of ['Pos.-Nr.','Beschreibung','Einheit','Bauteil / Ort']) assert.ok(header.includes(label));
 const css=readFileSync(new URL('../src/pages/MobileMeasurementTablet.css',import.meta.url),'utf8');
 assert.match(css,/thead \{\s*position: sticky;\s*top: 0;\s*z-index: 10;/);
 assert.match(css,/max-height: calc\(100dvh - var\(--measurement-table-top, 180px\) - 24px\);\s*overflow: auto;/);
 assert.match(table,/observer\.disconnect\(\)/);
 assert.match(table,/window\.removeEventListener\("resize", updateViewport\)/);
});

test('tablet matrix fills the workspace independently of viewport breakpoints',()=>{
 const css=readFileSync(new URL('../src/pages/MobileMeasurementTablet.css',import.meta.url),'utf8');
 assert.doesNotMatch(css,/@media/);
 assert.match(css,/\.mobile-detail-page:has\(\.is-table-view\) \{[^}]*width: 100%;[^}]*max-width: none;[^}]*margin: 0;[^}]*padding: 0;/);
 assert.match(css,/\.mobile-detail-panel\.mobile-measurement-positions-page\.is-table-view \{[^}]*width: 100%;[^}]*max-width: 100%;[^}]*margin: 0;[^}]*padding: 0;/);
 assert.match(css,/:has\(\.mobile-measurement-positions-page\.is-table-view\) \.app-main \{[^}]*margin-left: 0;/);
 assert.match(css,/\n\s+height: calc\(100dvh - var\(--measurement-table-top, 180px\) - 24px\);/);
 assert.match(css,/\.mobile-measurement-table-wrap \{[^}]*min-width: 100%;/);
});

test('tablet position groups stay in one touch-scrollable row with an accessible selection',()=>{
 const css=readFileSync(new URL('../src/pages/MobileMeasurementTablet.css',import.meta.url),'utf8');
 const page=readFileSync(new URL('../src/pages/MobileAssignmentDetailPage.tsx',import.meta.url),'utf8');
 assert.match(css,/\.is-table-view \.mobile-measurement-position-groups \{[^}]*display: flex;[^}]*flex-wrap: nowrap;[^}]*max-height: none;[^}]*overflow-x: auto;[^}]*overflow-y: hidden;/);
 assert.match(css,/\.is-table-view \.mobile-measurement-position-groups button \{[^}]*min-height: 44px;/);
 assert.match(css,/\.is-table-view \.mobile-measurement-position-groups button:focus-visible/);
 assert.match(page,/className="mobile-measurement-position-groups" role="group" aria-label="Positionsbereich auswählen"/);
 assert.match(page,/aria-pressed=\{group.key === effectivePositionGroupKey\}/);
 assert.match(page,/onClick=\{\(\) => setActivePositionGroupKey\(group.key\)\}/);
});
