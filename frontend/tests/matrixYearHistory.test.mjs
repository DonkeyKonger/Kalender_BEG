import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('../src/pages/MatrixPage.tsx', import.meta.url), 'utf8');
const code = source.slice(source.indexOf('function isMatrixVisibleSiteStatus('), source.indexOf('type ProjectManagerOption ='));
const compiled = ts.transpileModule(code, {compilerOptions: {module: ts.ModuleKind.CommonJS}}).outputText;
const visible = new Function(`${compiled}; return isMatrixVisibleSiteStatus;`)();

test('completing a site keeps its row only in year view when it contains planning', () => {
  for (const year of [false, true]) {
    for (const planned of [false, true]) {
      assert.equal(visible('completed', year, planned), year && planned);
      assert.equal(visible('deleted', year, planned), false);
      for (const status of ['active', 'paused', 'planned']) assert.equal(visible(status, year, planned), true);
    }
  }
  assert.match(source, /isMatrixVisibleSiteStatus\(status, isYearView, row\?\.cells.some/);
});
