import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../src/pages/MatrixPage.tsx', import.meta.url), 'utf8');
const css = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8');
const table = source.slice(source.indexOf('function MatrixTable('), source.indexOf('type MatrixTableCalendarProps'));
const effect = table.slice(table.indexOf('  useLayoutEffect('), table.indexOf('  const tableWidth'));

test('absence offsets use actual fractional header heights and react to layout changes', () => {
  let weekHeight = 20;
  let totalHeight = 54.4375;
  let state = null;
  let resize;
  let cleanup;
  let disconnected = false;
  const observed = [];
  const weekRow = { getBoundingClientRect: () => ({ height: weekHeight }) };
  const header = { rows: [weekRow], getBoundingClientRect: () => ({ height: totalHeight }) };
  vm.runInNewContext(effect, {
    headerRef: { current: header }, props: { isCompactView: true },
    setHeaderHeights: update => { state = update(state); },
    useLayoutEffect: callback => { cleanup = callback(); },
    ResizeObserver: class {
      constructor(callback) { resize = callback; }
      observe(element) { observed.push(element); }
      disconnect() { disconnected = true; }
    },
  });
  assert.equal(state.week, 20);
  assert.equal(state.total, 54.4375);
  assert.deepEqual(observed, [header, weekRow]);
  const unchanged = state;
  resize();
  assert.equal(state, unchanged, 'unchanged dimensions must not trigger a rerender');
  weekHeight = 23.25;
  totalHeight = 67.875;
  resize();
  assert.equal(state.week, 23.25);
  assert.equal(state.total, 67.875);
  cleanup();
  assert.equal(disconnected, true);
});

test('initial layout is measured even without ResizeObserver', () => {
  let state;
  vm.runInNewContext(effect, {
    headerRef: { current: { rows: [{ getBoundingClientRect: () => ({ height: 20 }) }], getBoundingClientRect: () => ({ height: 58 }) } },
    props: { isCompactView: false }, useLayoutEffect: callback => callback(),
    setHeaderHeights: update => { state = update(null); },
  });
  assert.equal(state.total, 58);
});

test('measured offsets pin both header variants without changing their sizing or horizontal scrolling', () => {
  assert.match(table, /<thead ref=\{headerRef\}>/);
  assert.match(table, /"--matrix-week-header-offset": `\$\{headerHeights.week\}px`/);
  assert.match(table, /"--matrix-sticky-header-height": `\$\{headerHeights.total\}px`/);
  for (const prefix of ['', '.matrix-page.is-compact ']) {
    const selector = `${prefix}.matrix-table thead .matrix-day-row th {`;
    const rule = css.slice(css.indexOf(selector)).split('}')[0];
    assert.match(rule, /top: var\(--matrix-week-header-offset, var\(--matrix-week-header-height\)\);/);
  }
  assert.match(css, /\.matrix-absence-row td \{\s*position: sticky;\s*top: var\(--matrix-sticky-header-height\);/);
  assert.doesNotMatch(effect, /scrollTop|addEventListener\(["']scroll/);
});
