import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";

const source = await readFile(new URL('../src/pages/MobileAssignmentDetailPage.tsx', import.meta.url), 'utf8');
const styles = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8');
const component = source.slice(source.indexOf('function ExtraWorkDetailsDialog('), source.indexOf('function DocumentEmailSendDialog('));
const compiled = await build({stdin: {contents: `
  import React, {useState, useMemo} from 'react';
  import {renderToStaticMarkup} from 'react-dom/server';
  import {X} from 'lucide-react';
  const useMobileModalStack=()=>true;
  const getExtraWorkAutomaticOrderDate=()=> '2026-08-27';
  const getIsoWeekInfo=()=>({isoYear:2026,week:39});
  const getIsoWeekRange=()=>({start:'2026-09-21',end:'2026-09-27'});
  const buildExtraWorkIsoWeekOptions=()=>[{value:'2026-39',label:'KW 39 / 2026'}];
  const parseExtraWorkIsoWeekValue=()=>({isoYear:2026,week:39});
  const formatGermanDateKey=value=>value.split('-').reverse().join('.');
  const formatMobileExtraWorkOrderTitle=order=>order.title;
  ${component}
  export const render=props=>renderToStaticMarkup(<ExtraWorkDetailsDialog {...props}/>);
`, resolveDir:fileURLToPath(new URL('..',import.meta.url)),loader:'tsx'},bundle:true,write:false,format:'cjs',platform:'node',packages:'external',jsx:'automatic'});
const module={exports:{}};
new Function('require','module','exports',compiled.outputFiles[0].text)(createRequire(import.meta.url),module,module.exports);
const props={assignmentId:1,assignmentStartDate:'2026-09-21',order:{id:23,title:'Stundenzettel 23 · Hauptauftrag',created_at:'2026-08-27',customer_signed_at:null}};

test('details template places its heading above the document name and separates week hints',()=>{
  const html=module.exports.render(props);
  assert.match(html,/<h2[^>]*>Stundenzettel-Details<\/h2><p>Stundenzettel 23 · Hauptauftrag<\/p>/);
  assert.match(html,/aria-label="Schließen"/);
  assert.match(html,/<small>21.09.2026 – 27.09.2026<br\/>Automatisch: KW 39 \/ 2026<\/small>/);
  assert.match(html,/>Abbrechen<\/button>/);
  assert.match(html,/>Speichern<\/button>/);
  assert.match(styles,/\.mobile-extra-work-details-dialog \{[^}]*border: 1px solid[^}]*border-radius: 8px;/s);
  assert.doesNotMatch(styles.match(/\.mobile-extra-work-details-dialog \{[^}]*\}/s)[0],/border-top:/);
  assert.match(styles,/\.mobile-extra-work-details-dialog \.mobile-extra-work-title-dialog-actions \{[^}]*repeat\(2, minmax\(0, 1fr\)\)/s);
});

test('signed details retain disabled fields and a single close action',()=>{
  const html=module.exports.render({...props,order:{...props.order,customer_signed_at:'2026-09-21'}});
  assert.match(html,/<input[^>]*disabled=""/);
  assert.match(html,/<select[^>]*disabled=""/);
  assert.match(html,/Nach der Kundenunterschrift/);
  assert.match(html,/mobile-extra-work-title-dialog-actions is-single/);
  assert.doesNotMatch(html,/>Speichern<|>Abbrechen</);
  assert.match(component,/onClick=\{isSaving \? undefined : onClose\}/);
  assert.match(component,/disabled=\{!canEdit \|\| isSaving\}/);
});
