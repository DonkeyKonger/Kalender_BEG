import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";

const source = await readFile(new URL("../src/pages/MobileAssignmentDetailPage.tsx", import.meta.url), "utf8");
const styles = await readFile(new URL("../src/pages/MobileMeasurementEntry.css", import.meta.url), "utf8");
const form = source.slice(source.indexOf("function MeasurementFreePositionForm("), source.indexOf("function MobileMeasurementTable("));
const helpers = ["MeasurementQuantityKeypad", "applyMeasurementQuantityKey", "parseOptionalMeasurementQuantity", "getMeasurementAreaKey", "normalizeMeasurementArea", "normalizeMeasurementAreaInput", "blurActiveFormElement"]
  .map(name => source.match(new RegExp(`^function ${name}\\([^]*?^}\\n`, "m"))[0]).join("\n");
const compiled = await build({
  stdin: {contents: `import React from 'react'; import {renderToStaticMarkup} from 'react-dom/server';
    import {Delete,Trash2} from 'lucide-react';
    import {MobileBackButton} from './src/components/MobileBackButton';
    const MOBILE_MEASUREMENT_FREE_UNITS=['st','m','psch','std'];
    ${helpers}\n${form}
    export const render=props=>renderToStaticMarkup(React.createElement(MeasurementFreePositionForm,props));
    export const tree=props=>MeasurementFreePositionForm(props);
    export {applyMeasurementQuantityKey,parseOptionalMeasurementQuantity};`,
    resolveDir:fileURLToPath(new URL("..",import.meta.url)),loader:"tsx"},
  bundle:true,write:false,format:"cjs",platform:"node",packages:"external",jsx:"automatic",
});
const module={exports:{}};
new Function("require","module","exports",compiled.outputFiles[0].text)(createRequire(import.meta.url),module,module.exports);
const props={draft:{position:"N1.1",description:"Testleistung",unit:"st",areaOrComment:"EG",quantity:""},areaSuggestions:["EG","1. OG"],isSaving:false};

test("free-position creation shares the capture header, inputs and icon-only keypad",()=>{
  const html=module.exports.render(props);
  assert.match(html,/mobile-measurement-entry-page mobile-measurement-capture-page mobile-measurement-free-position-page/);
  assert.match(html,/aria-label="Zurück zu den Positionen"/);
  assert.match(html,/<h1>Position erstellen<\/h1>/);
  assert.doesNotMatch(html,/Freie Zusatzposition nur für dieses Aufmaß|mobile-entry-head/);
  assert.match(html,/mobile-measurement-entry-form mobile-measurement-free-position-form/);
  assert.match(html,/is-entry-keypad/);
  assert.match(html,/aria-label="Letzte Ziffer entfernen"/);
  assert.match(html,/aria-label="Menge leeren"/);
  assert.doesNotMatch(html,/>Zurück<|>Leeren<|mobile-measurement-detail-topbar/);
  assert.match(html,/for="mobile-free-position-area"/);
  assert.match(html,/for="mobile-free-position-quantity"/);
  assert.match(html,/<textarea required="" rows="3"/);
});

test("creation retains all field updates, area suggestions, save and cancel callbacks",()=>{
  const patches=[];const actions=[];
  const tree=module.exports.tree({...props,onChange:patch=>patches.push(patch),onBack:()=>actions.push('back'),onSave:()=>actions.push('save'),onCancel:()=>actions.push('cancel')});
  const nodes=[];
  const visit=node=>{if(!node||typeof node!=='object')return;if(Array.isArray(node)){node.forEach(visit);return;}nodes.push(node);visit(node.props?.children);};
  visit(tree);
  nodes.find(n=>n.props?.value==='N1.1').props.onChange({target:{value:'N2'}});
  nodes.find(n=>n.type==='textarea').props.onChange({target:{value:'Neue Leistung'}});
  nodes.find(n=>n.type==='select').props.onChange({target:{value:'m'}});
  nodes.find(n=>n.props?.id==='mobile-free-position-area').props.onChange({target:{value:'ug'}});
  nodes.find(n=>n.type==='button'&&n.props.children==='1. OG').props.onClick();
  const keypad=nodes.find(n=>n.props?.variant==='entry');
  keypad.props.onKeyPress('5');
  assert.deepEqual(patches,[{position:'N2'},{description:'Neue Leistung'},{unit:'m'},{areaOrComment:'UG'},{areaOrComment:'1. OG'},{quantity:'5'}]);
  nodes.find(n=>n.props?.label==='Zurück zu den Positionen').props.onClick();
  nodes.find(n=>n.type==='button'&&n.props.children==='Speichern').props.onClick();
  nodes.find(n=>n.type==='button'&&n.props.children==='Abbrechen').props.onClick();
  assert.deepEqual(actions,['back','save','cancel']);
});

test("dialog title, errors and saving guards remain intact with compact styling",()=>{
  const html=module.exports.render({...props,variant:'dialog',isSaving:true,error:'Bitte Beschreibung eingeben.'});
  assert.match(html,/is-dialog/);
  assert.match(html,/id="mobile-measurement-position-dialog-title"/);
  assert.match(html,/form-error">Bitte Beschreibung eingeben/);
  assert.match(html,/disabled="">Speichert/);
  assert.match(html,/disabled="">Abbrechen/);
  assert.match(html,/aria-label="Menge leeren"[^>]*disabled/);
  assert.match(styles,/mobile-measurement-free-position-page.is-dialog \{[^}]*max-width: none;/s);
  assert.match(source,/EMPTY_MEASUREMENT_FREE_POSITION_DRAFT[^]*?quantity: ""/);
  assert.equal(module.exports.parseOptionalMeasurementQuantity(''),0);
});
