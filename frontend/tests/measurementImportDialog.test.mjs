import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import test from "node:test";
import { build } from "esbuild";

const page = readFileSync(new URL("../src/pages/SiteDetailPage.tsx", import.meta.url), "utf8");
const compiled = await build({
  stdin: { contents: `import React from 'react'; import {renderToStaticMarkup} from 'react-dom/server';
    import {MeasurementImportDialog} from './src/components/MeasurementImportDialog';
    export const render = props => renderToStaticMarkup(React.createElement(MeasurementImportDialog,props));`,
    resolveDir: fileURLToPath(new URL("..", import.meta.url)), loader: "tsx" },
  bundle: true, write: false, format: "cjs", platform: "node", packages: "external", jsx: "automatic", loader: {".css":"empty"},
});
const module = {exports:{}};
new Function("require","module","exports",compiled.outputFiles[0].text)(createRequire(import.meta.url),module,module.exports);
const render = overrides => module.exports.render({fileName:"Auftrag.pdf",mode:"append_existing",bases:[{id:4,name:"Bestand"}],hasExistingBase:true,selectedBaseId:4,newBaseName:"Hauptauftrag",pending:false,error:null,onMode(){},onBase(){},onName(){},onClose(){},onSubmit:async()=>{},...overrides});

test("new imports retain Hauptauftrag default and mode-specific request parameters", () => {
  assert.match(page, /const MEASUREMENT_IMPORT_DEFAULT_NAME = "Hauptauftrag"/);
  assert.match(page, /useState\(MEASUREMENT_IMPORT_DEFAULT_NAME\)/);
  assert.match(page, /function openImportDialog[\s\S]*?setNewBaseName\(MEASUREMENT_IMPORT_DEFAULT_NAME\)/);
  assert.match(page, /measurementBaseId: importMode === "append_existing" \? selectedBaseId : null/);
  assert.match(page, /measurementBaseName: importMode === "create_new" \? newBaseName : null/);
  assert.match(page, /bases\.filter\(\(base\) => base.status !== "closed" && base.status !== "archived"\)/);
  assert.match(page, /onName=\{setNewBaseName\}/);
});

test("dialog renders real file, exclusive options and a separate labelled existing target", () => {
  const html=render();
  assert.match(html, /<dialog/);
  assert.match(html, /PDF einem Aufmaßblatt zuordnen\./);
  assert.equal((html.match(/>Abbrechen</g)||[]).length,1);
  assert.match(html, /aria-label="Schließen"/);
  assert.match(html, /role="radiogroup" aria-label="Importziel"/);
  assert.equal((html.match(/type="radio"/g)||[]).length,2);
  assert.equal((html.match(/checked=""/g)||[]).length,1);
  assert.match(html, /<option value="4" selected="">Bestand<\/option>/);
  const selectId=html.match(/<select id="([^"]+)"/)[1];
  assert.ok(html.includes(`for="${selectId}"`));
  assert.doesNotMatch(html, /placeholder="Name des Aufmaßblatts"/);
});

test("new mode shows editable name, hides existing target and validates empty names", () => {
  const html=render({mode:"create_new",newBaseName:"Individueller Nachtrag"});
  assert.doesNotMatch(html, /<select/);
  assert.match(html, /value="Individueller Nachtrag"/);
  assert.match(render({mode:"create_new",newBaseName:" "}), /type="submit"[^>]*disabled=""/);
  assert.match(render({bases:[],selectedBaseId:null,mode:"create_new"}), /type="radio"[^>]*disabled=""/);
  assert.match(render({selectedBaseId:999}), /type="submit"[^>]*disabled=""/);
});

test("pending and errors preserve inputs without presenting a successful import", () => {
  const html=render({pending:true});
  assert.match(html, /aria-busy="true"/);
  assert.match(html, /aria-label="Schließen" disabled=""/);
  assert.match(html, /type="submit"[^>]*disabled=""[^>]*>Importiert\.\.\./);
  const failed=render({mode:"create_new",newBaseName:"Mein Name",error:"Import fehlgeschlagen"});
  assert.match(failed, /role="alert">Import fehlgeschlagen/);
  assert.match(failed, /value="Mein Name"/);
  assert.match(failed, /Auftrag.pdf/);
});

test("long file and offer names are escaped and preserved in full", () => {
  const name='Auftrag_<script>&_'+ 'LangerName'.repeat(30)+'.pdf';
  const html=render({fileName:name,bases:[{id:4,name}]});
  assert.doesNotMatch(html, /<script>/);
  assert.equal((html.match(/Auftrag_&lt;script&gt;&amp;_/g)||[]).length,2);
  assert.ok(html.includes('LangerName'.repeat(30)));
});

test("replacement warning only appears for a new sheet when any previous sheet exists", () => {
  const warning = "Nach dem Import wird das alte Aufmaßblatt durch das neue Aufmaßblatt ersetzt";
  const newSheet = render({mode:"create_new"});
  assert.ok(newSheet.includes(warning));
  assert.match(newSheet, /measurement-import-dialog-warning" aria-hidden="false"/);
  assert.match(render(), /measurement-import-dialog-warning is-concealed" aria-hidden="true"/);
  assert.ok(!render({mode:"create_new",hasExistingBase:false,bases:[]}).includes(warning));
  // Previously stored closed/archived sheets count too, even if not appendable.
  assert.ok(render({mode:"create_new",hasExistingBase:true,bases:[]}).includes(warning));
  assert.match(page, /hasExistingBase=\{bases.length > 0\}/);
  assert.doesNotMatch(newSheet, /Das neue Aufmaßblatt wird nach dem Import automatisch aktiviert/);
});
