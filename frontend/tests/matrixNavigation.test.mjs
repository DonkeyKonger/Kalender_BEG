import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('../src/lib/matrixNavigation.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
const exports = {};
new Function('exports', compiled)(exports);

test('site navigation selects the normal manager view without a search or layout override', () => {
  assert.equal(exports.matrixSiteHref(8026, 12), '/matrix?site=8026&projectManager=12');
  assert.deepEqual(exports.matrixNavigationTarget('?site=8026&projectManager=12'), { siteId: 8026, managerFilter: '12' });
  assert.equal(exports.matrixSiteHref(8026, null), '/matrix?site=8026&projectManager=all');
  assert.deepEqual(exports.matrixNavigationTarget('?site=8026&projectManager=all'), { siteId: 8026, managerFilter: 'all' });
});

test('invalid targets do not trigger a matrix navigation', () => {
  for (const query of ['', '?site=abc', '?site=-1', '?site=0', '?site=1.5', '?site=99999999999999999']) {
    assert.equal(exports.matrixNavigationTarget(query), null);
  }
  assert.deepEqual(exports.matrixNavigationTarget('?site=17&projectManager=invalid'), { siteId: 17, managerFilter: 'all' });
});

test('site scrolling leaves space for the pinned calendar header and absences', () => {
  assert.equal(exports.matrixSiteScrollTop(120, 900, 100, 140), 772);
  assert.equal(exports.matrixSiteScrollTop(0, 110, 100, 140), 0);
});
