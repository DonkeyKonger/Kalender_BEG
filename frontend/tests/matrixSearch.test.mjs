import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { searchMatrixRows } from '../src/lib/matrixSearch.ts';

const range = { start: '2026-09-28', end: '2026-10-09' };
const person = (id, name, type = 'internal') => ({ id, display_name: name, short_code: name, person_type: type });
const worker = person(1, 'Christoph Kramer');
const external = person(2, 'H.Bullermann', 'external_temp');
const row = (id, number, name, date, employee, manager = 10) => ({
  site: { id, site_number: number, name, location: 'Bremen', project_manager_person_id: manager },
  cells: date ? [{ date, assignments: employee ? [{ person: employee }] : [], absences: [worker], mark: 'orange' }] : [],
});
const rows = [
  row(1, '8007', 'Schüchtermann Klinik', range.start, worker),
  row(2, '8012', 'Baustelle West', range.end, worker, 20),
  row(3, '4402', 'Externe Baustelle', '2026-09-30', external, 30),
  row(4, '8020', 'Frühere Baustelle', '2026-09-27', worker),
  row(5, '9999', 'Spätere Baustelle', '2026-10-10', worker),
  row(6, null, 'Ohne Planung', range.start, null),
];
const ids = (query, data = rows, people = [], dates = range) => searchMatrixRows(data, query, people, dates).map(r => r.site.id);

test('site search supports partial numbers, names, location, whitespace and diacritics', () => {
  assert.deepEqual(ids('80'), [1, 2, 4]);
  assert.deepEqual(ids('  SCHUCHTERMANN  '), [1]);
  assert.deepEqual(ids('8007 klinik'), [1]);
  assert.deepEqual(ids('bremen'), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(ids('nicht vorhanden'), []);
});

test('installer search crosses PM groups and includes assignments within loaded dates, inclusive', () => {
  assert.deepEqual(ids('kramer'), [1, 2]);
  assert.deepEqual(ids('BULLERMANN'), [3]);
  assert.deepEqual(ids('kramer', rows, [], { start: '2026-10-10', end: '2026-10-11' }), [5]);
  assert.deepEqual(ids('kramer', rows, [], null), []);
  assert.deepEqual(ids('8007', rows, [], null), [1]);
});

test('directory names and short codes work; office/project managers are not installer matches', () => {
  const directory = [{ ...worker, first_name: 'Christoph', last_name: 'Kramer', user_roles: ['office'] }];
  assert.deepEqual(ids('kramer', rows, directory), []);
  directory[0].user_roles = ['project_manager'];
  assert.deepEqual(ids('kramer', rows, directory), []);
  directory[0].user_roles = ['monteur'];
  directory[0].first_name = 'Christopher';
  assert.deepEqual(ids('Christopher Kramer', rows, directory), [1, 2]);
  assert.deepEqual(ids('h.bull'), [3]);
  assert.deepEqual(ids('extern', [row(9, '1', 'Test', range.start, person(9, 'Externe Firma', 'external'))]), [9]);
});

test('historical/inactive people remain searchable and ambiguous input combines project and person matches', () => {
  assert.deepEqual(ids('kramer', rows, [{ ...worker, is_active: false, deleted_at: '2026-09-29' }]), [1, 2]);
  assert.deepEqual(ids('kramer', [...rows, row(10, '10', 'Kramer Baustelle')]), [1, 2, 10]);
});

test('filtering never changes planning or row order and clearing returns the original rows', () => {
  const before = JSON.stringify(rows);
  ids('kramer');
  assert.equal(JSON.stringify(rows), before);
  assert.equal(searchMatrixRows(rows, '  ', [], range), rows);
});

test('loaded eight-week range includes previous and future weeks from the first search', () => {
  const loaded = { start: '2026-09-14', end: '2026-11-08' };
  const data = [...rows,
    row(7, '7', 'Erster geladener Tag', loaded.start, worker, 20),
    row(8, '8', 'Letzter geladener Tag', loaded.end, worker),
    row(9, '9', 'Vor dem Zeitraum', '2026-09-13', worker),
    row(10, '10', 'Nach dem Zeitraum', '2026-11-09', worker),
    row(11, '11', 'Externe Vorwoche', '2026-09-15', external, 30),
  ];
  assert.deepEqual(ids('kramer', data, [], loaded), [1, 2, 4, 5, 7, 8]);
  assert.deepEqual(ids('bullermann', data, [], loaded), [3, 11]);
  assert.deepEqual(ids('kramer', data, [], { start: '2026-01-01', end: '2026-12-31' }), [1, 2, 4, 5, 7, 8, 9, 10]);
});

test('page uses the effective PM scope in every fetch and version refresh, and keeps selected PM for clearing', () => {
  const source = readFileSync(new URL('../src/pages/MatrixPage.tsx', import.meta.url), 'utf8');
  assert.equal((source.match(/matrixProjectManagerPersonIdFromFilter\(dataProjectManagerFilter\)/g) ?? []).length, 5);
  assert.match(source, /dataProjectManagerFilter = isMatrixSearchActive \? "all" : projectManagerFilter/);
  assert.match(source, /searchMatrixRows\(rows, matrixSearch, people, \{\s*start: matrix\.start_date,\s*end: matrix\.end_date,/);
  assert.doesNotMatch(source, /searchVisibleRange|matrixSearchRangeAtViewport|setSearchVisibleRange/);
  assert.match(source, /key: "search", label: "", rows: matches, showHeading: true/);
  assert.match(source, /nextFilter !== dataProjectManagerFilter[\s\S]*?invalidateMatrixDataContext\(\)/);
  assert.match(source, /element\.scrollLeft = searchScrollRestoreRef\.current\.left/);
  assert.ok(source.indexOf('className="matrix-search"') < source.indexOf('className="matrix-pm-filter"'));
});
