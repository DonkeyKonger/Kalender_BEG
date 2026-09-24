import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const css = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8');
const rule = selector => css.slice(css.indexOf(`${selector} {`)).split('}')[0];
const source = await readFile(new URL('../src/pages/MatrixPage.tsx', import.meta.url), 'utf8');
const editor = source.slice(source.indexOf('function MatrixInfoEditor('), source.indexOf('const DAY_IN_MS'));

test('matrix info cells inherit the same font as site locations and retain black text', () => {
  assert.match(rule('.matrix-info-editor textarea'), /color: #000000;/);
  assert.match(rule('.matrix-info-editor textarea'), /font-family: inherit;/);
  assert.match(rule('.matrix-table'), /font-family: Arial, "Segoe UI", sans-serif;/);
  assert.doesNotMatch(rule('.matrix-site-compact-meta'), /font-family:/);
  assert.match(rule('.matrix-info-editor textarea:disabled'), /color: #000000;/);
  assert.doesNotMatch(rule('.matrix-page.is-compact .matrix-info-editor textarea'), /\bcolor:|font-family:/);
});

test('unfocused info previews clip padding overflow but focused editors remain scrollable', () => {
  const preview = rule('.matrix-page.is-compact .matrix-info-editor textarea:not(:focus)');
  assert.match(preview, /clip-path: inset\(0\) content-box;/);
  assert.match(preview, /overflow-y: hidden;/);
  assert.match(css, /\.matrix-info-editor textarea:not\(:focus\),/);
  assert.match(rule('.matrix-info-editor textarea'), /overflow-y: auto;/);
  assert.match(editor, /event\.currentTarget\.scrollTop = 0;\s+onSave\(\);/);
});

test('info preview height contains whole lines without truncating fractional line heights', () => {
  const calculation = editor.slice(editor.indexOf('const updateTextareaHeight ='), editor.indexOf('    updateTextareaHeight();'))
    .replace('(value: string)', '(value)');
  for (const [height, lineHeight, padding] of [[33, 10, 2], [47, 10, 2], [60, 12.4032, 4], [60, 10.26, 4]]) {
    let actualHeight;
    vm.runInNewContext(`${calculation}\nupdateTextareaHeight();`, {
      container: { clientHeight: height }, textarea: {},
      window: { getComputedStyle: () => ({ lineHeight: String(lineHeight), paddingTop: String(padding), paddingBottom: String(padding), borderTopWidth: '1', borderBottomWidth: '1' }) },
      setTextareaHeight: update => { actualHeight = typeof update === 'function' ? update(null) : update; },
    });
    const rows = (actualHeight - padding * 2 - 2) / lineHeight;
    assert.ok(Math.abs(rows - Math.round(rows)) < 1e-9);
    assert.ok(actualHeight <= height);
    assert.ok(actualHeight + lineHeight > height);
  }
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
