import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [pageSource, styles] = await Promise.all([
  readFile(new URL("../src/pages/CustomersPage.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
]);

test("customer overview cards keep one fixed height without changing their data or click behavior", () => {
  const cardRule = cssRule(".customers-page .customer-overview-card");

  assert.match(cardRule, /height:\s*112px/);
  assert.match(cardRule, /min-height:\s*112px/);
  assert.match(cardRule, /max-height:\s*112px/);
  assert.match(pageSource, /title=\{customer\.company_name\}/);
  assert.match(pageSource, /subtitle=\{formatCustomerAddress\(customer\) \|\| "Keine Adresse hinterlegt"\}/);
  assert.match(pageSource, /meta=\{customerCardMeta\(customer\)\}/);
  assert.match(pageSource, /onClick=\{\(\) => openCustomerDrawer\(customer\.id\)\}/);
});

test("customer name, address and phone are limited to one, two and one visible lines", () => {
  const titleRule = cssRule(".customers-page .customer-overview-card .entity-card-title");
  const addressRule = cssRule(".customers-page .customer-overview-card .entity-card-subtitle");
  const phoneRule = cssRule(".customers-page .customer-overview-card .entity-card-meta");

  assert.match(titleRule, /text-overflow:\s*ellipsis/);
  assert.match(titleRule, /white-space:\s*nowrap/);
  assert.match(addressRule, /overflow:\s*hidden/);
  assert.match(addressRule, /overflow-wrap:\s*anywhere/);
  assert.match(addressRule, /-webkit-line-clamp:\s*2/);
  assert.match(addressRule, /word-break:\s*break-word/);
  assert.match(phoneRule, /min-height:\s*1\.35em/);
  assert.match(phoneRule, /overflow:\s*hidden/);
});

function cssRule(selector) {
  const start = styles.indexOf(`${selector} {`);
  assert.notEqual(start, -1, `CSS-Regel ${selector} fehlt`);
  const end = styles.indexOf("}", start);
  return styles.slice(start, end + 1);
}
