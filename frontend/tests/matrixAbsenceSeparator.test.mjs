import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../src/pages/MatrixPage.tsx', import.meta.url), 'utf8');
const css = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8');

test('only the empty heading below absences uses the fixed separator height', () => {
  assert.match(source, /!group.label && props.showAbsences \? " is-absence-spacer" : ""/);
  assert.match(source, /matrix-group-label">\{group.label\}/);
  const selector = '.matrix-page .matrix-table .matrix-group-row.is-absence-spacer > th';
  const rule = css.slice(css.indexOf(`${selector} {`)).split('}')[0];
  assert.match(rule, /height: var\(--matrix-absence-separator-height\);/);
  assert.match(rule, /min-height: 0;/);
  assert.match(rule, /border: 0;/);
  assert.match(rule, /padding: 0;/);
  assert.match(css, /\.matrix-page \.matrix-table \.matrix-group-row.is-absence-spacer,/);
});

test('the existing sticky gap and named/current-planning group behavior stay unchanged', () => {
  assert.match(css, /--matrix-absence-separator-height: 28px;/);
  assert.match(css, /\.matrix-absence-row td::after \{[^}]*height: var\(--matrix-absence-separator-height\);/);
  assert.match(css, /\.matrix-group-row th \{[^}]*height: 32px;/);
  assert.match(css, /\.matrix-page.is-current-planning \.matrix-group-row \{\s*display: none;/);
});
