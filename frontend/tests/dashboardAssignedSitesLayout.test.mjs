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

test('site tiles retain a bounded responsive width instead of stretching a lone tile', () => {
  assert.match(rule('.dashboard-site-tile-grid'), /align-items:\s*start/);
  assert.match(rule('.dashboard-site-tile-grid'), /repeat\(auto-fill, minmax\(200px, 224px\)\)/);
  assert.match(rule('.dashboard-site-tile-grid'), /justify-content:\s*flex-start/);
});

test('site tiles reserve the same two-line name area without a status-height variant', () => {
  assert.match(rule('.dashboard-site-tile'), /grid-template-rows:\s*14px minmax\(0, 2\.8em\)/);
  assert.match(rule('.dashboard-site-tile'), /height:\s*76px/);
  assert.match(rule('.dashboard-site-tile-meta'), /white-space:\s*nowrap/);
  assert.match(rule('.dashboard-site-tile-name'), /overflow-wrap:\s*anywhere/);
  assert.match(rule('.dashboard-site-tile-name'), /-webkit-line-clamp:\s*2/);
  assert.match(rule('.dashboard-site-tile-name'), /overflow:\s*hidden/);
});

test('the desktop group list remains scrollable for many occupied sites', () => {
  const desktopList = css.slice(css.indexOf('.dashboard-section--sites > .dashboard-site-group-list,')).split('}')[0];
  assert.match(desktopList, /flex:\s*1 1 auto/);
  assert.match(desktopList, /min-height:\s*0/);
  assert.match(desktopList, /overflow-y:\s*auto/);
});
