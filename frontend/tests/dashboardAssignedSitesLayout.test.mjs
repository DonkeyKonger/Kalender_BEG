import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const css = readFileSync(new URL('../src/pages/DashboardPage.css', import.meta.url), 'utf8');
const globalCss = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
const rule = selector => css.slice(css.indexOf(`${selector} {`)).split('}')[0];
const ruleAfter = (selector, marker) => {
  const scopedCss = css.slice(css.indexOf(marker));
  return scopedCss.slice(scopedCss.indexOf(`${selector} {`)).split('}')[0];
};

test('assigned-site lanes use the measured Figma rail and spacing', () => {
  const lane = rule('.dashboard-page .dashboard-site-group');
  assert.match(lane, /grid-template-columns:\s*64px minmax\(0, 1fr\)/);
  assert.match(lane, /gap:\s*8px/);
  assert.match(lane, /padding:\s*7px 0/);
});

test('phone and tablet avoid four mini cards while desktop keeps four flexible columns', () => {
  assert.match(rule('.dashboard-page .dashboard-site-tile-grid'), /grid-template-columns:\s*minmax\(0, 1fr\)/);
  const tabletGrid = ruleAfter('.dashboard-page .dashboard-site-tile-grid', '@media (min-width: 600px)');
  assert.match(tabletGrid, /repeat\(2, minmax\(0, 1fr\)\)/);
  const desktopGrid = ruleAfter('.dashboard-page .dashboard-site-tile-grid', '@media (min-width: 1101px)');
  assert.match(desktopGrid, /repeat\(4, minmax\(0, 1fr\)\)/);
});

test('site tiles keep the requested sixty-pixel two-line geometry and external accent', () => {
  const tile = rule('.dashboard-page .dashboard-site-tile');
  const name = globalCss.slice(globalCss.indexOf('.dashboard-site-tile-name {')).split('}')[0];
  assert.match(tile, /grid-template-rows:\s*14px minmax\(0, 30px\)/);
  assert.match(tile, /height:\s*60px/);
  assert.match(name, /-webkit-line-clamp:\s*2/);
  assert.match(rule('.dashboard-page .dashboard-site-tile-count--external'), /color:\s*#c06512/);
});

test('the desktop group list remains scrollable for many occupied sites', () => {
  const desktopCss = css.slice(css.indexOf('@media (min-width: 1101px)'));
  const listStart = desktopCss.indexOf('.dashboard-page .dashboard-section--sites > .dashboard-site-group-list,');
  const desktopList = desktopCss.slice(listStart).split('}')[0];
  assert.match(desktopList, /min-height:\s*0/);
  assert.match(desktopList, /overflow-y:\s*auto/);
});
