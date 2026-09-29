import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const [pageSource, styles] = await Promise.all([
  readFile(new URL("../src/pages/SitesPage.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
]);

test("site cards and filters use the project manager code, not an employee-style prefix", () => {
  const context = vm.createContext({});
  const helpers = pageSource.slice(pageSource.indexOf('function compactProjectManagerFilterLabel('), pageSource.indexOf('function projectManagerOptionsFromSites('))
    + pageSource.slice(pageSource.indexOf('function siteProjectManagerLabel('), pageSource.indexOf('function siteGroupCardsId('));
  vm.runInContext(ts.transpileModule(helpers, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  for (const code of ['CE', 'AB', 'KE', 'TW']) {
    const legacy = `${code[0]}.${code}`;
    assert.equal(context.siteProjectManagerLabel({ project_manager: { display_name: code, short_code: legacy, first_name: 'Christopher', last_name: code } }), code);
    assert.equal(context.compactProjectManagerFilterLabel({ name: code, shortCode: legacy }), code);
    assert.equal(context.compactSiteGroupLabel(code), code);
  }
  assert.equal(context.siteProjectManagerLabel({ project_manager: { display_name: '  CE  ', short_code: 'C.CE' } }), 'CE');
  assert.equal(context.siteProjectManagerLabel({ project_manager: { display_name: '', short_code: 'CE' } }), 'CE');
  assert.equal(context.siteProjectManagerLabel({ project_manager: { display_name: 'Carl Erik', short_code: 'C.Erik' } }), 'CE');
  assert.equal(context.siteProjectManagerLabel({ project_manager: null }), 'offen');
});

test("site overview cards keep one compact fixed height", () => {
  const cardRule = cssRule(".site-overview-page .site-card");
  const gridRule = cssRule(".site-overview-page .site-card-grid");

  assert.match(cardRule, /height:\s*84px/);
  assert.match(cardRule, /min-height:\s*84px/);
  assert.match(cardRule, /max-height:\s*84px/);
  assert.match(gridRule, /gap:\s*10px/);
});

test("all four visible site card values stay on one line with hover titles", () => {
  const titleRule = cssRule(".site-overview-page .entity-card-title");
  const locationRule = cssRule(".site-overview-page .entity-card-subtitle");
  const metaValueRule = cssRule(".site-card-meta-grid span span");

  for (const rule of [titleRule, locationRule, metaValueRule]) {
    assert.match(rule, /overflow:\s*hidden/);
    assert.match(rule, /text-overflow:\s*ellipsis/);
    assert.match(rule, /white-space:\s*nowrap/);
  }

  assert.match(pageSource, /className="entity-card-title" title=\{site\.name\}/);
  assert.match(pageSource, /className="entity-card-subtitle" title=\{siteLocationLabel\}/);
  assert.match(pageSource, /title=\{projectManagerLabel\}/);
  assert.match(pageSource, /title=\{customerLabel\}/);
});

test("site status keeps a stable reserved width without resizing the card", () => {
  const statusRule = cssRule(".site-overview-page .site-card-status-control");
  const selectRule = cssRule(".site-overview-page .site-card-status-select");

  assert.match(statusRule, /flex:\s*0 0 82px/);
  assert.match(statusRule, /justify-content:\s*flex-end/);
  assert.match(selectRule, /width:\s*72px/);
  assert.match(selectRule, /max-width:\s*72px/);
});

function cssRule(selector) {
  const start = styles.indexOf(`${selector} {`);
  assert.notEqual(start, -1, `CSS-Regel ${selector} fehlt`);
  const end = styles.indexOf("}", start);
  return styles.slice(start, end + 1);
}
