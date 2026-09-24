import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const css = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8');
const rule = selector => css.slice(css.indexOf(`${selector} {`)).split('}')[0];

test('matrix info cells use black readable text, including disabled editors', () => {
  assert.match(rule('.matrix-info-editor textarea'), /color: #000000;/);
  assert.match(rule('.matrix-info-editor textarea'), /font-family: Verdana, Arial, sans-serif;/);
  assert.match(rule('.matrix-info-editor textarea:disabled'), /color: #000000;/);
  assert.doesNotMatch(rule('.matrix-page.is-compact .matrix-info-editor textarea'), /\bcolor:|font-family:/);
});

test('info typography retains existing regular and compact geometry', () => {
  assert.match(rule('.matrix-info-editor textarea'), /padding: 4px 5px;/);
  assert.match(rule('.matrix-info-editor textarea'), /font-size: 0.68rem;/);
  assert.match(rule('.matrix-info-editor textarea'), /line-height: 1.14;/);
  const compact = rule('.matrix-page.is-compact .matrix-info-editor textarea');
  assert.match(compact, /padding: 2px 3px;/);
  assert.match(compact, /font-size: 0.6rem;/);
  assert.match(compact, /line-height: 10px;/);
});
