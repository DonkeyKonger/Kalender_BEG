import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";

const source = await readFile(new URL("../src/pages/MobileAssignmentDetailPage.tsx", import.meta.url), "utf8");
const styles = await readFile(new URL("../src/pages/MobileMeasurementEmailSend.css", import.meta.url), "utf8");
const component = source.slice(source.indexOf("function DocumentEmailSendDialog("), source.indexOf("function ProjectEmailRecipientsModal("));
const compiled = await build({
  stdin: {contents: `import React from 'react'; import {renderToStaticMarkup} from 'react-dom/server';
    import {AlertTriangle,FileText,Mail} from 'lucide-react';
    const useMobileModalStack=()=>true;
    ${component}
    export const render=props=>renderToStaticMarkup(React.createElement(DocumentEmailSendDialog,props));
    export const tree=props=>DocumentEmailSendDialog(props);`,
    resolveDir:fileURLToPath(new URL("..",import.meta.url)),loader:"tsx"},
  bundle:true,write:false,format:"cjs",platform:"node",packages:"external",jsx:"automatic",
});
const module={exports:{}};
new Function("require","module","exports",compiled.outputFiles[0].text)(createRequire(import.meta.url),module,module.exports);
const props={variant:'measurement',title:'Aufmaß senden?',description:'Erklärung',filename:'Aufmaß_25.pdf',recipients:[{email:'test@example.de',label:'Kontaktname'}],warning:'Noch keine Kundenunterschrift.',error:null,isSending:false};
const collect=tree=>{
  const result=[];
  const visit=node=>{if(!node||typeof node!=='object')return;if(Array.isArray(node)){node.forEach(visit);return;}result.push(node);visit(node.props?.children);};
  visit(tree);return result;
};

test("measurement send dialog uses the compact template with warning icon and actual recipients",()=>{
  const html=module.exports.render(props);
  assert.match(html,/is-measurement-send/);
  assert.match(html,/Aufmaß senden\?/);
  assert.match(html,/mobile-project-email-warning/);
  assert.match(html,/lucide-triangle-alert/);
  assert.match(html,/Noch keine Kundenunterschrift/);
  assert.match(html,/<strong>Aufmaß_25.pdf<\/strong>/);
  assert.match(html,/<strong>test@example.de<\/strong>/);
  assert.doesNotMatch(html,/Erklärung|PDF-Dokument|Kontaktname/);
  assert.match(html,/aria-labelledby="mobile-extra-work-email-send-title"/);
  assert.match(source,/<DocumentEmailSendDialog\s+variant="measurement"/);
});

test("signed measurement hides warning and supports multiple recipients",()=>{
  const html=module.exports.render({...props,warning:null,recipients:[...props.recipients,{email:'second@example.de'}]});
  assert.doesNotMatch(html,/mobile-project-email-warning|lucide-triangle-alert/);
  assert.match(html,/second@example.de/);
});

test("send, cancel and busy guards retain their original behavior",()=>{
  const calls=[];
  const tree=module.exports.tree({...props,onClose:()=>calls.push('close'),onConfirm:()=>calls.push('send')});
  const buttons=collect(tree).filter(n=>n.type==='button');
  buttons[0].props.onClick();buttons[1].props.onClick();tree.props.onClick();
  assert.deepEqual(calls,['close','send','close']);
  const busy=module.exports.tree({...props,isSending:true});
  assert.equal(busy.props.onClick,undefined);
  assert.ok(collect(busy).filter(n=>n.type==='button').every(n=>n.props.disabled));
  assert.match(module.exports.render({...props,isSending:true}),/Sendet/);
  assert.match(module.exports.render({...props,error:'Versand fehlgeschlagen.'}),/form-error">Versand fehlgeschlagen/);
});

test("other document send dialogs retain their content and layout variant",()=>{
  const html=module.exports.render({...props,variant:undefined,title:'Stundenzettel senden?'});
  assert.doesNotMatch(html,/is-measurement-send|lucide-triangle-alert/);
  assert.match(html,/Erklärung/);
  assert.match(html,/PDF-Dokument/);
  assert.match(html,/<strong>Kontaktname<\/strong>/);
  assert.match(html,/<small>test@example.de<\/small>/);
});

test("responsive send layout wraps long addresses and keeps equal actions",()=>{
  assert.match(styles,/\.mobile-project-email-dialog.is-measurement-send \{[^}]*border: 1px solid #d7e3f0;/s);
  assert.match(styles,/\.is-measurement-send \.mobile-project-email-warning \{[^}]*font-weight: 400;/s);
  assert.match(styles,/\.is-measurement-send \.mobile-project-email-option strong \{[^}]*overflow-wrap: anywhere;[^}]*white-space: normal;/s);
  assert.match(styles,/\.is-measurement-send \.mobile-project-email-list \{[^}]*overflow-y: auto;/s);
  assert.match(styles,/\.is-measurement-send \.mobile-project-email-actions \{[^}]*repeat\(2, minmax\(0, 1fr\)\)/s);
});
