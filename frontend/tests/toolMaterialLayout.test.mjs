import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [pageSource, styles] = await Promise.all([
  readFile(new URL("../src/pages/MiscellaneousPage.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
]);


test("stock is absent from the table and tool material form UI", () => {
  assert.doesNotMatch(pageSource, /<span>Bestand<\/span>/);
  assert.doesNotMatch(pageSource, /<td[^>]*>\{item\.stock/);
  assert.match(pageSource, /colSpan=\{toolMaterialColumns\.length\}/);
});


test("tool material table uses the available width without content-driven expansion", () => {
  const tableRule = cssRule(".miscellaneous-tools-table");

  assert.match(tableRule, /width:\s*100%/);
  assert.match(tableRule, /table-layout:\s*fixed/);
  assert.doesNotMatch(tableRule, /width:\s*max-content/);
  assert.match(styles, /\.miscellaneous-tools-table td \{[^}]*text-overflow:\s*ellipsis/s);
  assert.match(pageSource, /title=\{item\.designation\}/);
});


test("tool material panel fills the desktop viewport and scrolls only its table area", () => {
  const panelRule = cssRule(".miscellaneous-tools-panel");
  const tableWrapRule = cssRule(".miscellaneous-tools-table-wrap");
  const desktopPageRule = cssRule(".miscellaneous-page.has-tools-material");

  assert.match(panelRule, /display:\s*flex/);
  assert.match(panelRule, /min-height:\s*0/);
  assert.match(tableWrapRule, /flex:\s*1 1 auto/);
  assert.match(tableWrapRule, /overflow:\s*auto/);
  assert.doesNotMatch(tableWrapRule, /max-height/);
  assert.match(desktopPageRule, /height:\s*calc\(100dvh - 48px\)/);
  assert.doesNotMatch(styles, /miscellaneous-tools-table[^}]*grid-auto-rows:\s*1fr/);
});


function cssRule(selector) {
  const start = styles.indexOf(`${selector} {`);
  assert.notEqual(start, -1, `CSS-Regel ${selector} fehlt`);
  const end = styles.indexOf("}", start);
  return styles.slice(start, end + 1);
}
