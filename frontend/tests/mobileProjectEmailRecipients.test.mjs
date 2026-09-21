import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";

const source = await readFile(new URL("../src/pages/MobileAssignmentDetailPage.tsx", import.meta.url), "utf8");
const styles = await readFile(new URL("../src/pages/MobileProjectEmailRecipients.css", import.meta.url), "utf8");
const component = source.slice(source.indexOf("function ProjectEmailRecipientsModal("), source.indexOf("function ExtraWorkCustomerSignatureOverlay("));
const helpers = ["normalizeProjectRecipientEmail", "isValidProjectRecipientEmail"]
  .map(name => source.match(new RegExp(`^function ${name}\\([^]*?^}\\n`, "m"))[0]).join("\n");
const compiled = await build({
  stdin: { contents: `import {renderToStaticMarkup} from 'react-dom/server';
    export const render=tree=>renderToStaticMarkup(tree);
    export function harness(states, api, props) {
      let index=0;
      const useState=()=>{const i=index++;return [states[i],value=>states[i]=typeof value==='function'?value(states[i]):value];};
      const useEffect=()=>{}; const useMemo=fn=>fn(); const useMobileModalStack=()=>true;
      const readApiError=(_error,fallback)=>fallback;
      ${helpers}
      ${component.replace('  return (\n', '  const tree = (\n').replace(/\n}\s*$/, '\nreturn {tree, saveRecipients};\n}')}
      return ProjectEmailRecipientsModal(props);
    }`, resolveDir: fileURLToPath(new URL("..", import.meta.url)), loader: "tsx" },
  bundle: true, write: false, format: "cjs", platform: "node", packages: "external", jsx: "automatic",
});
const module = { exports: {} };
new Function("require", "module", "exports", compiled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const suggestions = [{email:'one@example.de',label:'Kontaktname'}, {email:'two@example.de',label:null}];
const state = () => [suggestions, ['one@example.de'], '', null, false, false];
const props = {assignmentId:42,onClose(){},onSaved(){}};
const nodes = tree => {
  const result=[];
  const visit=node=>{if(!node||typeof node!=='object')return;if(Array.isArray(node)){node.forEach(visit);return;}result.push(node);visit(node.props?.children);};
  visit(tree);return result;
};

test("recipient picker shows addresses, selected rows and the compact template content", () => {
  const {tree}=module.exports.harness(state(),{},props);
  const html=module.exports.render(tree);
  assert.match(html,/is-recipient-picker/);
  assert.match(html,/aria-labelledby="mobile-project-email-dialog-title"/);
  assert.match(html,/mobile-project-email-option is-selected/);
  assert.match(html,/<strong>one@example.de<\/strong>/);
  assert.doesNotMatch(html,/Kontaktname|Hier siehst du|Hinzugefügte Adressen/);
  assert.match(html,/Neue E-Mail-Adresse/);
  assert.match(html,/autoCapitalize="none"/);
  assert.match(html,/>Abbrechen</);
  assert.match(html,/>Speichern</);
});

test("checkbox toggles and cancel keep their existing behavior", () => {
  const states=state();let closed=false;
  const {tree}=module.exports.harness(states,{}, {...props,onClose:()=>closed=true});
  const controls=nodes(tree);
  controls.find(n=>n.props?.type==='checkbox').props.onChange();
  assert.deepEqual(states[1],[]);
  controls.find(n=>n.type==='button'&&n.props.children==='Abbrechen').props.onClick();
  assert.equal(closed,true);
});

test("saving retains labels and normalizes new addresses without duplicates", async () => {
  const states=state();states[2]=' ONE@EXAMPLE.DE ';
  let saved;let count;
  const api={updateAssignmentEmailRecipients:async(id,payload)=>{saved={id,payload};return payload;}};
  await module.exports.harness(states,api,{...props,onSaved:value=>count=value}).saveRecipients();
  assert.deepEqual(saved,{id:42,payload:{recipients:[{email:'one@example.de',label:'Kontaktname'}]}});
  assert.equal(count,1);
  states[2]=' NEW@EXAMPLE.DE ';
  await module.exports.harness(states,api,props).saveRecipients();
  assert.deepEqual(saved.payload.recipients[1],{email:'new@example.de',label:null});
});

test("invalid addresses, load/save errors and busy states remain visible and safe", async () => {
  const states=state();states[2]='invalid';
  await module.exports.harness(states,{updateAssignmentEmailRecipients(){assert.fail('invalid email must not save');}},props).saveRecipients();
  assert.equal(states[3],'E-Mail-Adresse ist nicht gültig.');
  assert.equal(states[5],false);
  states[2]='';
  await module.exports.harness(states,{updateAssignmentEmailRecipients:async()=>{throw Error('failed');}},props).saveRecipients();
  assert.equal(states[3],'E-Mail-Empfänger konnten nicht gespeichert werden.');
  states[5]=true;
  const controls=nodes(module.exports.harness(states,{},props).tree);
  assert.ok(controls.filter(n=>n.type==='input'||n.type==='button').every(n=>n.props.disabled));
  states[4]=true;states[5]=false;
  const html=module.exports.render(module.exports.harness(states,{},props).tree);
  assert.match(html,/Empfänger werden geladen/);
  assert.match(html,/disabled="">Speichern/);
});

test("empty list and responsive styling preserve readable addresses and equal actions", () => {
  const states=state();states[0]=[];states[1]=[];
  assert.match(module.exports.render(module.exports.harness(states,{},props).tree),/Noch keine E-Mail-Adresse für diese Baustelle gespeichert/);
  assert.match(styles,/\.is-recipient-picker \.mobile-project-email-list \{[^}]*overflow-y: auto;/s);
  assert.match(styles,/\.is-recipient-picker \.mobile-project-email-option strong \{[^}]*overflow-wrap: anywhere;[^}]*white-space: normal;/s);
  assert.match(styles,/\.is-recipient-picker \.mobile-project-email-actions \{[^}]*repeat\(2, minmax\(0, 1fr\)\)/s);
  assert.match(styles,/\.mobile-project-email-dialog.is-recipient-picker \{[^}]*border: 1px solid #d7e3f0;/s);
  assert.equal((source.match(/is-recipient-picker/g)||[]).length,1);
});
