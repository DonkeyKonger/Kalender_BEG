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

test('orange marking reduces only its own fill and border saturation by thirty percent', async () => {
  const css = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8');
  const rule = css.match(/\.matrix-cell\.mark-orange\s*\{([^}]+)\}/)[1];
  const colors = [...rule.matchAll(/hsl\(([\d.]+) ([\d.]+)% ([\d.]+)%(?: \/ (\d+)%)?\)/g)];
  assert.equal(colors.length, 2);
  const originals = [[255, 242, 214], [245, 158, 11]];
  colors.forEach((color, i) => {
    const max = Math.max(...originals[i]) / 255;
    const min = Math.min(...originals[i]) / 255;
    const lightness = (max + min) / 2;
    const saturation = (max - min) / (1 - Math.abs(2 * lightness - 1));
    assert.ok(Math.abs(Number(color[2]) - saturation * 70) < 0.01);
    assert.ok(Math.abs(Number(color[3]) - lightness * 100) < 0.01);
  });
  assert.equal(colors[1][4], '32');
  assert.doesNotMatch(rule, /filter\s*:/); // Never desaturate nested installer bubbles or text.
});
