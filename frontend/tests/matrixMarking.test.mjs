import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const source = await readFile(new URL('../src/pages/MatrixPage.tsx', import.meta.url), 'utf8');
const code = source.slice(source.indexOf('function nextMatrixCellMark('), source.indexOf('function isCellInCellRange('))
  + source.slice(source.indexOf('function matrixCellClassName('), source.indexOf('function matrixAddSiteCellClassName('));
const context = vm.createContext({ isWeekendDate: () => false, isWeekStartDate: () => false });
vm.runInContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);

test('middle-click marking toggles only between orange and empty', () => {
  let mark = null;
  for (let i = 0; i < 10; i++) {
    mark = context.nextMatrixCellMark(mark);
    assert.equal(mark, i % 2 === 0 ? 'orange' : null);
  }
});

test('retired colors in stale responses are unstyled and toggle to orange', () => {
  for (const mark of ['red', 'blue', null, 'orange']) {
    const classes = context.matrixCellClassName({ date: '2026-09-28', mark }, '2026-09-28', false, false, null, false);
    assert.equal(classes.includes('mark-orange'), mark === 'orange');
    assert.equal(/mark-red|mark-blue/.test(classes), false);
    assert.equal(context.nextMatrixCellMark(mark), mark === 'orange' ? null : 'orange');
  }
});

test('middle mouse down still toggles directly without default browser action', () => {
  assert.match(source, /if \(event.button === 1\) \{\s*event.preventDefault\(\);\s*event.stopPropagation\(\);\s*props.onCycleCellMark\(row, cell\);/);
});

test('mark targets cover the full selection only when clicking inside the same site', () => {
  const cells = Array.from({ length: 7 }, (_, i) => ({ date: `2026-10-0${i + 1}`, mark: null }));
  const row = { site: { id: 42 }, cells };
  const range = { siteId: 42, startDate: cells[1].date, endDate: cells[5].date };
  assert.deepEqual(context.matrixCellMarkTargets(row, cells[3], range), cells.slice(1, 6));
  assert.deepEqual(Array.from(context.matrixCellMarkTargets(row, cells[0], range)), [cells[0]]);
  assert.deepEqual(Array.from(context.matrixCellMarkTargets(row, cells[3], { ...range, siteId: 43 })), [cells[3]]);
  assert.deepEqual(Array.from(context.matrixCellMarkTargets(row, cells[3], null)), [cells[3]]);
});

test('selected marks are saved in one request, toggle together and keep planning untouched', async () => {
  const cells = [1, 2, 3, 4, 5].map(day => ({ date: `2026-10-0${day}`, mark: day === 3 ? 'orange' : null, assignments: [{ id: day }] }));
  const row = { site: { id: 42 }, cells };
  const calls = [];
  const feedback = [];
  const state = vm.createContext({
    matrixIsEditable: true, cellMarkSavePendingRef: { current: false },
    highlightedCellRange: { siteId: 42, startDate: cells[0].date, endDate: cells[4].date },
    matrixCellMarkTargets: context.matrixCellMarkTargets, nextMatrixCellMark: context.nextMatrixCellMark,
    cellKey: (id, date) => `${id}:${date}`, clearTemporaryCellFeedback: () => {},
    setSaveStatus: () => {}, setCellMessage: () => {}, setError: () => {},
    showTemporaryCellFeedback: (...args) => feedback.push(args), syncMatrixVersionSilently: () => {},
    api: { patchMatrixCellMark: async params => {
      calls.push(params);
      return { updated_cells: cells.map(cell => ({ ...cell, mark: params.mark })) };
    } },
    replaceMatrixCells: (_, updated) => { row.cells = updated; },
    readApiError: () => 'failed', CELL_ERROR_MESSAGE: 'failed',
  });
  const handler = source.slice(source.indexOf('  async function cycleCellMark('), source.indexOf('  function handleMatrixContextMenu('));
  vm.runInContext(ts.transpileModule(handler, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, state);
  const assignments = JSON.stringify(cells.map(cell => cell.assignments));
  await state.cycleCellMark(row, cells[2]); // Clicking an already marked cell fills a mixed selection.
  assert.equal(calls.length, 1);
  assert.equal(calls[0].date, '2026-10-01');
  assert.equal(calls[0].endDate, '2026-10-05');
  assert.equal(calls[0].mark, 'orange');
  assert.equal(feedback.length, 5);
  await state.cycleCellMark(row, row.cells[2]);
  assert.equal(calls[1].mark, null);
  assert.equal(JSON.stringify(row.cells.map(cell => cell.assignments)), assignments);
  state.matrixIsEditable = false;
  await state.cycleCellMark(row, row.cells[0]);
  state.matrixIsEditable = true;
  state.cellMarkSavePendingRef.current = true;
  await state.cycleCellMark(row, row.cells[0]);
  assert.equal(calls.length, 2);
  state.cellMarkSavePendingRef.current = false;
  state.api.patchMatrixCellMark = async () => { throw new Error('failure'); };
  await state.cycleCellMark(row, row.cells[0]);
  assert.equal(state.cellMarkSavePendingRef.current, false);
  assert.ok(row.cells.every(cell => cell.mark === null));
});

test('orange marking keeps the original colors with forty percent transparency only on the marking', async () => {
  const css = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8');
  const rule = css.match(/\.matrix-cell\.mark-orange\s*\{([^}]+)\}/)[1];
  const colors = [...rule.matchAll(/rgb\((\d+) (\d+) (\d+) \/ ([\d.]+)%\)/g)];
  assert.equal(colors.length, 2);
  const originals = [[255, 242, 214], [245, 158, 11]];
  colors.forEach((color, i) => {
    assert.deepEqual(color.slice(1, 4).map(Number), originals[i]);
  });
  assert.equal(Number(colors[0][4]), 100 * 0.6);
  assert.equal(Number(colors[1][4]), 32 * 0.6);
  assert.match(rule, /box-shadow: inset 0 0 0 0\.8px/);
  assert.doesNotMatch(rule, /(?:filter|opacity)\s*:/); // Keep nested installer bubbles and text fully opaque.
});

test('today markings have no blue top stripe while the header and selection remain identifiable', async () => {
  const css = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8');
  assert.doesNotMatch(css, /\.matrix-cell\.today\.mark-orange\s*\{/);
  const selected = css.match(/\.matrix-cell\.today\.is-range-selected\s*\{([^}]+)\}/)[1];
  assert.match(selected, /box-shadow: inset 0 0 0 2px/);
  assert.doesNotMatch(selected, /inset 0 3px/);
  const header = css.match(/\.matrix-table thead th\.today\s*\{([^}]+)\}/)[1];
  assert.match(header, /inset 0 3px 0 #1d5c99/);
});
