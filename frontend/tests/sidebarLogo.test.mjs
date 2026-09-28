import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const shell = readFileSync(new URL('../src/layout/AppShell.tsx', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
const logo = readFileSync(new URL('../public/beg-sidebar-logo.svg', import.meta.url), 'utf8');

test('sidebar uses its new vector logo at the existing 38 pixel size', () => {
  assert.match(shell, /src="\/beg-sidebar-logo.svg" alt="BEG Logo" width=\{38\} height=\{38\}/);
  assert.match(logo, /viewBox="0 0 40 40"/);
  assert.doesNotMatch(logo, /<text|<image|<script/);
  const rule = styles.match(/\.sidebar \.brand-logo-mark\s*\{([^}]+)\}/)[1];
  assert.match(rule, /background:\s*transparent/);
  assert.match(rule, /padding:\s*0/);
  assert.match(rule, /flex:\s*0 0 38px/);
});
