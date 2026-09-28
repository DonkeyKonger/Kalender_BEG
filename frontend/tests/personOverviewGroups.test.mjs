import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../src/pages/PersonsPage.tsx', import.meta.url), 'utf8');
const helpers = source.slice(source.indexOf('function comparePeople('), source.indexOf('function personCardColor('));
const context = vm.createContext({});
vm.runInContext(ts.transpileModule(helpers, {compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText, context);
const person = (id, roles = [], status = 'active', extra = {}) => ({
  id, display_name: `Person ${id}`, person_type: 'internal', user_roles: roles,
  employment_status: status, is_active: status === 'active', ...extra,
});
const groups = (people, scope = 'internal') => JSON.parse(JSON.stringify(context.groupPeopleForOverview(people, scope)));

test('departed staff from every role appear only in their own last collapsible group', () => {
  const result = groups([
    person(1, ['project_manager']), person(2, ['office']), person(3),
    person(4, ['project_manager'], 'departed'), person(5, ['office'], 'departed'), person(6, [], 'departed'),
  ]);
  assert.deepEqual(result.map(g => [g.key, g.people.map(p => p.id)]), [
    ['internal-project-managers', [1]], ['internal-office', [2]], ['internal-workers', [3]], ['internal-departed', [4,5,6]],
  ]);
  assert.equal(result.at(-1).label, 'Ausgeschiedene');
  assert.equal(result.at(-1).collapsible, true);
  assert.match(source, /collapsedPersonGroupKeys[^\n]*new Set\(\["internal-departed"\]\)/);
  assert.match(source, /aria-expanded=\{!isCollapsed\}/);
});

test('paused staff stay in their role groups; legacy inactive staff use the existing departed fallback', () => {
  const result = groups([person(1, [], 'paused'), person(2, ['admin'], undefined, {employment_status: undefined, is_active: false})]);
  assert.deepEqual(result.map(g => [g.key, g.people.map(p => p.id)]), [['internal-workers', [1]], ['internal-departed', [2]]]);
});

test('explicit employment status is authoritative and departed staff are sorted alphabetically', () => {
  const result = groups([person(1, [], 'departed', {is_active: true, display_name: 'Zeta'}), person(2, [], 'departed', {display_name: 'Alpha'})]);
  assert.deepEqual(result[0].people.map(p => p.id), [2,1]);
});

test('empty groups are omitted and filtered departed search results keep their own group', () => {
  assert.deepEqual(groups([]), []);
  assert.deepEqual(groups([person(1)]).map(g => g.key), ['internal-workers']);
  assert.deepEqual(groups([person(2, [], 'departed')]).map(g => g.key), ['internal-departed']);
});

test('external overview and source records stay unchanged', () => {
  const people = [person(1, [], 'active', {person_type:'external'}), person(2, [], 'active', {person_type:'external_temp'}), person(3, [], 'departed', {person_type:'external'})];
  const before = JSON.stringify(people);
  assert.deepEqual(groups(people, 'external').map(g=>[g.key,g.people.map(p=>p.id)]), [['external',[1]],['external-temp',[2]],['inactive-external',[3]]]);
  assert.equal(JSON.stringify(people), before);
});
