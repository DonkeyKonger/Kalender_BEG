import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const source = await readFile(new URL('../src/pages/MatrixPage.tsx', import.meta.url), 'utf8');
const layoutCode = source.slice(source.indexOf('function assignmentRunSpan('), source.indexOf('function isFullAssignmentDrag('));
const conflictCode = source.slice(source.indexOf('function assignmentAbsenceConflict('), source.indexOf('function assignmentChipClassName('));
const code = ts.transpileModule(layoutCode + conflictCode, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const context = vm.createContext({});
vm.runInContext(code, context);
const weekly = {id: 10, person: {id:1}, start_date:'2026-09-21', end_date:'2026-09-25'};
const colleague = {id: 11, person: {id:2}};

for (const day of [0, 2, 4]) {
  test(`weekly bubble keeps its span and layer when a colleague is added on day ${day}`, () => {
    const cells = Array.from({length:5}, (_, index) => ({date:`2026-09-${21+index}`,assignments:[weekly],absences:[],conflict_level:'none'}));
    const before = context.buildAssignmentRunLayout(cells);
    cells[day].assignments = [weekly, colleague];
    const after = context.buildAssignmentRunLayout(cells);
    assert.equal(after.spansByRunKey.get('10:0'), 5);
    assert.equal(after.layersByRunKey.get('10:0'), before.layersByRunKey.get('10:0'));
    assert.equal(after.spansByRunKey.get(`11:${day}`), 1);
    assert.equal(after.layersByRunKey.get(`11:${day}`), 1);
    assert.equal(after.spansByRunKey.size, 2);
  });
}

test('only an assignment’s own absence conflict can split its visual run', () => {
  const cells = Array.from({length:5}, (_, index) => ({date:`2026-09-${21+index}`,assignments:[weekly, colleague],absences:[],conflict_level:'none'}));
  cells[2].absences = [{person:{id:2},absence_type:'sick'}];
  cells[2].conflict_level = 'hard';
  assert.equal(context.buildAssignmentRunLayout(cells).spansByRunKey.get('10:0'), 5);
  cells[2].absences = [{person:{id:1},absence_type:'sick'}];
  assert.equal(context.buildAssignmentRunLayout(cells).spansByRunKey.get('10:0'), 2);
});
