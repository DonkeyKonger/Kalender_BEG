import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";

const source = await readFile(new URL("../src/pages/PersonsPage.tsx", import.meta.url), "utf8");
const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
const component = source.slice(source.indexOf("function PersonReadView("), source.indexOf("function PersonToolMaterialPanel("));
const tags = [...new Set([...component.matchAll(/<([A-Z]\w*)/g)].map(match => match[1]))];
const compiled = await build({
  stdin: { contents: `
    const useState=()=>[false,()=>{}]; const useEffect=()=>{};
    const formatPersonAddress=()=>'';
    const personEmploymentStatus=()=> 'active';
    const formatAnnualVacationDays=String, formatWeeklyHours=String;
    const personDetailActions=['absence','timeAccount','equipment','performance'].map(key=>({key,title:key}));
    ${tags.map(tag=>`const ${tag}=()=>null;`).join('\n')}
    ${component}
    export const render=props=>PersonReadView(props);
  `, loader: "tsx", resolveDir: fileURLToPath(new URL("..", import.meta.url)) },
  bundle: true, write: false, platform: "node", format: "cjs", packages: "external", jsx: "automatic",
});
const module = { exports: {} };
new Function("require", "module", "exports", compiled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
function nodes(tree) {
  if (!tree || typeof tree !== 'object') return [];
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  return [tree, ...nodes(tree.props?.children)];
}

test("external and temporary external details omit payroll fields and hours account in all permission states", () => {
  for (const person_type of ['internal','external','external_temp']) {
    for (const canEdit of [false,true]) {
      const tree=nodes(module.exports.render({person:{id:1,person_type},canEdit,activeAction:null}));
      const labels=tree.map(node=>node.props?.label).filter(Boolean);
      for (const label of ['Jahresurlaub','Wochenstunden']) assert.equal(labels.includes(label),person_type==='internal');
      for (const label of ['Name','Telefon','E-Mail','Status','Kundenunterschrift','Fahrzeug']) assert.ok(labels.includes(label));
      const actions=tree.filter(node=>node.props?.onOpen).map(node=>node.props.action.key);
      assert.deepEqual(actions,person_type==='internal' ? ['absence','timeAccount','equipment','performance'] : ['absence','equipment','performance']);
    }
  }
});

test("stale hours-account selection cannot open an external employee subpage", () => {
  const tree=nodes(module.exports.render({person:{id:1,person_type:'external'},activeAction:'timeAccount'}));
  assert.equal(tree.filter(node=>node.props?.onBack).length,0);
});

test("shared employee info field reserves triple height for empty, short and long notes", () => {
  assert.match(styles,/\.person-detail-info-textarea\s*\{[^}]*height: 186px;[^}]*min-height: 186px;/);
  const editor=source.slice(source.indexOf('function PersonNotesEditor('),source.indexOf('function PersonDetailNavItem('));
  assert.match(editor,/className="person-detail-info-textarea"/);
  assert.match(editor,/onBlur=\{\(\) => void saveIfChanged\(\)\}/);
});
