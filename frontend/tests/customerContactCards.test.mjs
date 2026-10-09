import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";

const source = await readFile(new URL("../src/pages/CustomersPage.tsx", import.meta.url), "utf8");
const component = source.slice(source.indexOf("function CustomerContactEditor("), source.indexOf("function CustomerPhoneLink("));
const helpers = ["normalizeCustomerContactsPayload", "customerContactsKey", "normalizeCustomerContactEmailKey", "mergeCustomerContactRows", "displayCustomerContactRole", "CustomerPhoneLink"]
  .map(name => source.match(new RegExp(`^function ${name}\\([^]*?^}\\n`, "m"))[0]).join("\n");
const compiled = await build({
  stdin: { contents: `import {renderToStaticMarkup} from 'react-dom/server';
    import {Mail,Phone,Pencil,Plus,Save,Trash2,UserRound} from 'lucide-react';
    const customerContactTypeLabels={monteur:'Ansprechpartner',bauleiter:'Bauleiter Kunde'};
    ${helpers}
    export const render=tree=>renderToStaticMarkup(tree);
    export function harness(state, props) {
      const useState=()=>[state.draft,value=>state.draft=typeof value==='function'?value(state.draft):value];
      ${component.replace('  return (\n', '  const tree = (\n').replace(/\n}\s*$/, '\nreturn {tree, saveContact};\n}')}
      return CustomerContactEditor(props);
    }`, resolveDir: fileURLToPath(new URL("..", import.meta.url)), loader: "tsx" },
  bundle: true, write: false, format: "cjs", platform: "node", packages: "external", jsx: "automatic",
});
const module = { exports: {} };
new Function("require", "module", "exports", compiled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const contact = {key:"contact:1",name:"Alex Beispiel",contact_type:"bauleiter",email:"alex@example.test",phone:"0123 456"};
const props = {canEdit:true,isSaving:false,contactRows:[contact],onSaveContacts:async()=>true};
const nodes = tree => {
  const result=[];
  const visit=node=>{if(!node||typeof node!=="object")return;if(Array.isArray(node)){node.forEach(visit);return;}result.push(node);visit(node.props?.children);};
  visit(tree);return result;
};

test("contact cards show identities and links instead of permanent inputs, including read-only and missing data", () => {
  const html=module.exports.render(module.exports.harness({draft:null},props).tree);
  assert.match(html,/<article/);
  assert.match(html,/Alex Beispiel/);
  assert.match(html,/Bauleiter Kunde/);
  assert.match(html,/href="mailto:alex@example.test"/);
  assert.match(html,/href="tel:0123456"/);
  assert.doesNotMatch(html,/<input/);
  const readonly=module.exports.render(module.exports.harness({draft:null},{...props,canEdit:false,contactRows:[{key:"empty"}]}).tree);
  assert.match(readonly,/Name nicht hinterlegt/);
  assert.match(readonly,/Keine E-Mail hinterlegt/);
  assert.doesNotMatch(readonly,/<button|<input/);
  assert.match(module.exports.render(module.exports.harness({draft:null},{...props,contactRows:[]}).tree),/Keine Kontakte hinterlegt/);
});

test("contact edits save explicitly, preserve other contacts and keep drafts after errors", async () => {
  const state={draft:{...contact,name:" Neuer Name "}};
  let saved;
  const input={...props,contactRows:[contact,{...contact,key:"contact:2",email:"other@example.test"}],onSaveContacts:async payload=>{saved=payload;return false;}};
  await module.exports.harness(state,input).saveContact();
  assert.equal(saved.length,2);
  assert.equal(saved[0].name,"Neuer Name");
  assert.equal(saved[1].email,"other@example.test");
  assert.ok(state.draft);
  await module.exports.harness(state,{...input,onSaveContacts:async()=>true}).saveContact();
  assert.equal(state.draft,null);
});

test("new cards can be saved or cancelled, and busy or read-only states do not submit", async () => {
  const state={draft:{...contact,key:"new",email:"new@example.test"}};
  let calls=0;
  const input={...props,onSaveContacts:async payload=>{calls++;assert.equal(payload.length,2);return true;}};
  await module.exports.harness(state,{...input,isSaving:true}).saveContact();
  await module.exports.harness(state,{...input,canEdit:false}).saveContact();
  assert.equal(calls,0);
  await module.exports.harness(state,input).saveContact();
  assert.equal(calls,1);
  state.draft={...contact,name:"Discard me"};
  nodes(module.exports.harness(state,input).tree).find(n=>n.type==='button'&&n.props.children==='Abbrechen').props.onClick();
  assert.equal(state.draft,null);
  assert.equal(calls,1);
});
