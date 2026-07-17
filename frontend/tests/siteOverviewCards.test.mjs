import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [pageSource, styles] = await Promise.all([
  readFile(new URL("../src/pages/SitesPage.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
]);

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
