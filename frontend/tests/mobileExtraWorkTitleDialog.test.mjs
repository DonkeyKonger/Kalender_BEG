import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";

const source=await readFile(new URL('../src/pages/MobileAssignmentDetailPage.tsx',import.meta.url),'utf8');
const styles=await readFile(new URL('../src/styles.css',import.meta.url),'utf8');
const component=source.slice(source.indexOf('function ExtraWorkTitleDialog('),source.indexOf('function ExtraWorkDetailsDialog('));
const compiled=await build({stdin:{contents:`import React,{useState} from 'react'; import {renderToStaticMarkup} from 'react-dom/server';
  const useMobileModalStack=()=>true;
  const getMobileExtraWorkOrderEditableTitle=order=>order.title?.trim() || '';
  const getMobileExtraWorkOrderFixedTitle=order=>'Stundenzettel '+order.sequence_number;
  const EXTRA_WORK_DEFAULT_TITLE_SUFFIX='Hauptauftrag';
  ${component}
  export const render=props=>renderToStaticMarkup(<ExtraWorkTitleDialog {...props}/>);`,resolveDir:fileURLToPath(new URL('..',import.meta.url)),loader:'tsx'},bundle:true,write:false,format:'cjs',platform:'node',packages:'external',jsx:'automatic'});
const module={exports:{}};
new Function('require','module','exports',compiled.outputFiles[0].text)(createRequire(import.meta.url),module,module.exports);
const props={assignmentId:1,order:{id:23,sequence_number:23,title:'Hauptauftrag',status:'draft',customer_signed_at:null}};

test('rename dialog follows the new title, subtitle, field and paired actions layout',()=>{
  const html=module.exports.render(props);
  assert.match(html,/<h2[^>]*>Stundenzettel benennen<\/h2><p>Stundenzettel 23<\/p>/);
  assert.match(html,/<span>Bezeichnung<\/span><input[^>]*value="Hauptauftrag"/);
  assert.match(html,/>Abbrechen<\/button>/);
  assert.match(html,/>Speichern<\/button>/);
  const dialogStyles=styles.match(/\.mobile-extra-work-title-dialog \{[^}]*\}/s)[0];
  assert.match(dialogStyles,/width: min\(560px, calc\(100vw - 32px\)\)/);
  assert.match(dialogStyles,/overflow-y: auto/);
  assert.doesNotMatch(dialogStyles,/border-top:/);
  assert.match(styles,/\.mobile-extra-work-title-dialog input \{[^}]*min-height: 52px;[^}]*font-size: 1rem;/s);
  assert.match(styles,/\.mobile-extra-work-title-dialog \.mobile-extra-work-title-dialog-actions \{[^}]*repeat\(2, minmax\(0, 1fr\)\)/s);
});

test('rename keeps permissions, title normalization and API save behavior',()=>{
  const signed=module.exports.render({...props,order:{...props.order,customer_signed_at:'2026-09-21'}});
  assert.doesNotMatch(signed,/<input/);
  assert.match(signed,/disabled="">Speichern/);
  assert.match(component,/order.status === "draft" && !order.customer_signed_at/);
  assert.match(component,/const cleanedTitle = title.trim\(\).replace\(/);
  assert.match(component,/api.updateMobileExtraWorkTicketTitle\(assignmentId, order.id, cleanedTitle \|\| null\)/);
  assert.match(component,/onSaved\(updatedOrder\)/);
  assert.match(component,/disabled=\{!canRename \|\| isSaving\}/);
});
