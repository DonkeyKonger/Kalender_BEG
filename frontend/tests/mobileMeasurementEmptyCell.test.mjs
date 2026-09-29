import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
const source=readFileSync(new URL('../src/pages/MobileAssignmentDetailPage.tsx',import.meta.url),'utf8');
const start=source.indexOf('  async function saveInlineMeasurementEdit(');
const save=source.slice(start,source.indexOf('  const filteredItems',start));
const helpers=['getMeasurementAreaKey','normalizeMeasurementArea','normalizeMeasurementAreaInput','parseOptionalMeasurementQuantity','getMobileMeasurementAreaQuantity','getMeasurementEntryQuantity','sumMeasurementEntryQuantities']
 .map(name=>source.match(new RegExp(`^function ${name}\\([^]*?^}\\n`,'m'))[0]).join('\n');
const compiled=ts.transpileModule(`export async function run(inlineQuantity,entries=[],mode='cell',free=false){
 const calls=[];const selectedBatch={id:1};const assignment={id:1};const inlineCell={itemId:1,area:'EG',mode};const isSaving=false;
 const items=[{id:1,entries,description:'Test',unit:'m'}];
 const isInlineFreePositionDraftItem=()=>free;
 const setInlineError=message=>{if(message)calls.push(['error',message]);};
 const cancelInlineMeasurementEdit=()=>calls.push(['cancel']);
 const setIsSaving=()=>{},setInlineCell=()=>{},setInlineQuantity=()=>{},setItems=()=>{},setSelectedItem=()=>{},updateBatchPositionCount=()=>{};
 const getMeasurementPositionSaveValue=()=>null;
 const api={deleteMobileMeasurementEntry:async(...args)=>calls.push(['delete',args[2]]),createMobileMeasurementEntry:async(...args)=>{calls.push(['create',args[3]]);return{id:2,...args[3]};},createMobileMeasurementFreeItem:async()=>{calls.push(['free']);return{id:2};}};
 const updateMobileMeasurementItemsAfterInlineSave=()=>{};
 ${helpers}
 ${save}
 const result=await saveInlineMeasurementEdit();return{result,calls};
}`,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
const exports={};new Function('exports',compiled)(exports);
test('untouched empty cells and new rows never save an implicit zero',async()=>{
 for(const mode of ['cell','add-row'])for(const free of [false,true]){
  const result=await exports.run('',[],mode,free);assert.equal(result.result,true);assert.deepEqual(result.calls,[['cancel']]);
 }
 assert.match(source,/const displayValue = inlineQuantity;/);assert.doesNotMatch(source,/const displayValue = inlineQuantity \|\| "0"/);
});
test('explicit zero is saved while unchanged existing zero is not rewritten',async()=>{
 const fresh=await exports.run('0');assert.deepEqual(fresh.calls,[['create',{area_or_comment:'EG',quantity:0}]]);
 const same=await exports.run('0,00',[{id:7,area_or_comment:'EG',quantity:'0'}]);assert.deepEqual(same.calls,[['cancel']]);
});
test('clearing an existing quantity removes the entry without inserting zero',async()=>{
 for(const quantity of ['0','12']){
  const result=await exports.run('',[{id:7,area_or_comment:'EG',quantity}]);assert.deepEqual(result.calls,[['delete',7]]);
 }
});
test('decimal commas save numeric values and existing comma decimals are not mistaken for zero',async()=>{
 for(const [input,expected] of [['2,5',2.5],['0,25',.25],['-12,75',-12.75],['2.5',2.5]]) {
  const result=await exports.run(input);
  assert.deepEqual(result.calls,[['create',{area_or_comment:'EG',quantity:expected}]]);
  const unchanged=await exports.run(input,[{id:7,area_or_comment:'EG',quantity:input}]);
  assert.deepEqual(unchanged.calls,[['cancel']]);
 }
});
test('table formatting displays comma and dot decimals consistently',()=>{
 const fn=source.match(/^function formatMeasurementNumber\([^]*?^}\n/m)[0];
 const js=ts.transpileModule(`${fn}; exports.format=formatMeasurementNumber;`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
 const result={};new Function('exports',js)(result);
 for(const input of ['2,5','2.5',2.5]) assert.equal(result.format(input),'2,50');
 assert.equal(result.format('-0,25'),'-0,25');
});
