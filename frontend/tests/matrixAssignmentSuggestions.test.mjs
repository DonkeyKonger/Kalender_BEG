import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { calendarPersonCode } from '../src/types/person.ts';

const source = await readFile(new URL('../src/pages/MatrixPage.tsx', import.meta.url), 'utf8');
const helpers = source.slice(source.indexOf('function isAssignmentSuggestionPerson('), source.indexOf('function toMatrixEntryInput('));
const suggestions = source.slice(source.indexOf('  const assignmentSuggestions = useMemo('), source.indexOf('  const invalidateMatrixDataContext'));
const code = ts.transpileModule(`${helpers}\nfunction suggest(people, personSearchSeed, draftEntries = []) { ${suggestions}\nreturn assignmentSuggestions; }`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const context = vm.createContext({ calendarPersonCode, useMemo: callback => callback() });
vm.runInContext(code, context);
const person = (id, overrides = {}) => ({ id, display_name: `Chris Test ${id}`, first_name: 'Chris', last_name: `Test ${id}`, short_code: `CT${id}`, person_type: 'internal', is_active: true, deleted_at: null, user_roles: [], ...overrides });
const ids = items => Array.from(items.filter(item => item.kind === 'person'), item => item.person.id);

test('planning suggests workers with or without a login, but no office staff or project managers', () => {
  const people = [person(1, {user_roles:['monteur']}), person(2), person(3, {user_roles:undefined}),
    person(4, {user_roles:['office']}), person(5, {user_roles:['project_manager']}), person(6, {user_roles:['admin']}),
    person(7, {user_roles:['monteur','office']}), person(8, {user_roles:['monteur','project_manager']})];
  assert.deepEqual(ids(context.suggest(people, 'chris')), [1,2,3]);
});

test('both external person types remain available; inactive and deleted people do not', () => {
  const people = [person(1,{person_type:'external'}), person(2,{person_type:'external_temp'}),
    person(3,{is_active:false}), person(4,{deleted_at:'2026-09-24'}), person(5,{person_type:'external',is_active:false})];
  assert.deepEqual(ids(context.suggest(people, 'chris')), [1,2]);
});

test('role filtering occurs before suggestion limits, while assigned people stay excluded', () => {
  const people = [...Array.from({length:8}, (_,i)=>person(i+10,{user_roles:['office']})), person(1), person(2), person(3,{person_type:'external'})];
  assert.deepEqual(ids(context.suggest(people,'CHRIS',[{key:'p-1'}])), [2,3]);
});

test('search matching, keyboard item order and the external-create action remain intact', () => {
  const result = context.suggest([person(1,{person_type:'external'}),person(2)],'  Chris  ');
  assert.deepEqual(ids(result),[2,1]);
  assert.equal(result.at(-1).kind,'create_external');
  assert.equal(result.at(-1).displayName,'Chris');
  assert.equal(context.suggest([person(1)],' ').length,0);
  assert.deepEqual(ids(context.suggest([person(1),person(2)],'ct2')),[2]);
});

test('external suggestion rows display the entered name once and only Extern on the right', () => {
  const dropdown = source.slice(source.indexOf('function AssignmentAutocompleteDropdown('),source.indexOf('function OperationalAbsenceDetailPopup('));
  assert.match(dropdown, /className="assignment-autocomplete-name">\{item.person.display_name\}/);
  assert.match(dropdown, /item.person.person_type === "internal" \? calendarPersonCode\(item.person\) : "Extern"/);
  assert.doesNotMatch(dropdown, /Extern ·/);
});
