import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const source = await readFile(new URL('../src/pages/MatrixPage.tsx', import.meta.url), 'utf8');
const save = source.slice(source.indexOf('  async function saveActiveCell('), source.indexOf('  function startCellSelection('));
const helpers = source.slice(source.indexOf('function toMatrixEntryInput('), source.indexOf('function cellKey('));
const code = ts.transpileModule(save + helpers, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const entry = id => ({ key: `p-${id}`, label: `Monteur ${id}`, person_id: id });

function editor(initial, draft, endDate = '2026-09-25') {
  const requests = [];
  const noop = () => {};
  const response = { warnings: [], updated_cells: [] };
  const context = vm.createContext({
    initialEntries: initial, draftEntries: draft,
    activeCell: { siteId: 7, date: '2026-09-21', endDate, key: '7-2026-09-21' },
    autosaveRef: { current: null }, activeEditorRangeRef: { current: null },
    api: {
      patchMatrixCell: async payload => { requests.push({ kind: 'cell', ...payload }); return response; },
      patchMatrixRange: async payload => { requests.push({ kind: 'range', ...payload }); return response; },
    },
    setSaveStatus: noop, closeActiveEditor: noop, uniqueAddedPersonIds: () => [],
    clearTemporaryCellFeedback: noop, setCellMessage: noop, setInitialEntries: noop,
    setError: noop, showTemporaryCellFeedback: noop, replaceMatrixCells: noop,
    syncMatrixVersionSilently: noop, showAssignmentCollisionNoticeForPlan: noop,
    setActiveEditorRange: noop, clearSelection: noop,
  });
  vm.runInContext(code, context);
  return { context, requests };
}

test('adding the third worker sends the original baseline separately from requested people', async () => {
  const { context, requests } = editor([entry(1), entry(2)], [entry(1), entry(2), entry(3)]);
  await context.saveActiveCell();
  assert.deepEqual(JSON.parse(JSON.stringify(requests)), [{ kind: 'range', siteId: 7,
    startDate: '2026-09-21', endDate: '2026-09-25', entries: [{person_id:1},{person_id:2},{person_id:3}],
    initialPersonIds: [1, 2] }]);
});

test('unchanged range never reapplies the first day to the rest of the week', async () => {
  const { context, requests } = editor([entry(1), entry(2)], [entry(1), entry(2)]);
  await context.saveActiveCell({ closeOnSuccess: true });
  assert.deepEqual(requests, []);
});

test('single-day additions keep the existing cell API contract', async () => {
  const { context, requests } = editor([entry(1)], [entry(1), entry(2)], '2026-09-21');
  await context.saveActiveCell();
  assert.equal(requests[0].kind, 'cell');
  assert.equal(requests[0].date, '2026-09-21');
  assert.equal(requests[0].initialPersonIds, undefined);
});

test('range API includes the explicit baseline, including an empty first day', async () => {
  const api = await readFile(new URL('../src/lib/api.ts', import.meta.url), 'utf8');
  const range = api.slice(api.indexOf('  async patchMatrixRange('));
  assert.match(range, /initialPersonIds: number\[\]/);
  assert.match(range, /initial_person_ids: params\.initialPersonIds/);
});
