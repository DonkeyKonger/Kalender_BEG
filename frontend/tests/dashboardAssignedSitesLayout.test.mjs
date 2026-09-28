import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
const rule = selector => css.slice(css.indexOf(`${selector} {`)).split('}')[0];

test('assigned-site groups keep content-sized rows at the top of the available card', () => {
  assert.match(rule('.dashboard-site-group-list'), /align-content:\s*start/);
  assert.match(rule('.dashboard-site-group-list'), /grid-auto-rows:\s*max-content/);
  assert.match(rule('.dashboard-site-group'), /align-content:\s*start/);
});

test('site tiles do not stretch and retain responsive wrapping', () => {
  assert.match(rule('.dashboard-site-tile-grid'), /align-items:\s*start/);
  assert.match(rule('.dashboard-site-tile-grid'), /repeat\(auto-fill, minmax\(132px, 190px\)\)/);
});

test('the desktop group list remains scrollable for many occupied sites', () => {
  const desktopList = css.slice(css.indexOf('.dashboard-section--sites > .dashboard-site-group-list,')).split('}')[0];
  assert.match(desktopList, /flex:\s*1 1 auto/);
  assert.match(desktopList, /min-height:\s*0/);
  assert.match(desktopList, /overflow-y:\s*auto/);
});
