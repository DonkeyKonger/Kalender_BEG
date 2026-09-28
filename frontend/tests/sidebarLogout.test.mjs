import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
const desktop = css.slice(css.indexOf('@media (min-width: 900px)'));

test('collapsed sidebar logout is invisible and noninteractive without shifting navigation', () => {
  const rule = desktop.match(/\n  \.sidebar-logout-button \{([^}]+)\}/)[1];
  assert.match(rule, /visibility:\s*hidden/);
  assert.match(rule, /opacity:\s*0/);
  assert.match(rule, /pointer-events:\s*none/);
  assert.doesNotMatch(rule, /display:\s*none/);
});

test('pointer and keyboard expansion both reveal the logout button', () => {
  const rule = desktop.match(/\.sidebar\.is-pointer-expanded \.sidebar-logout-button,\s*\.sidebar\.is-keyboard-expanded \.sidebar-logout-button \{([^}]+)\}/)[1];
  assert.match(rule, /visibility:\s*visible/);
  assert.match(rule, /opacity:\s*1/);
  assert.match(rule, /pointer-events:\s*auto/);
});
