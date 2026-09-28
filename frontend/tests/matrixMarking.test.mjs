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

test('today uses the thinner marking frame without changing the day indicator or selection', async () => {
  const css = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8');
  const today = css.match(/\.matrix-cell\.today\.mark-orange\s*\{([^}]+)\}/)[1];
  assert.match(today, /inset 0 3px 0 #1d5c99, inset 0 0 0 0\.8px/);
  const selected = css.match(/\.matrix-cell\.today\.is-range-selected\s*\{([^}]+)\}/)[1];
  assert.match(selected, /inset 0 3px 0 #1d5c99, inset 0 0 0 2px/);
});
