import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const [pageSource, styles] = await Promise.all([
  readFile(new URL("../src/pages/CustomersPage.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
]);
const helpers = pageSource.slice(pageSource.indexOf("function compareCustomers("), pageSource.indexOf("function formatCustomerAddress("));
const compiled = ts.transpileModule(helpers, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
const { customerInitial, groupCustomersAlphabetically, compareCustomers } = new Function(`${compiled}; return {customerInitial, groupCustomersAlphabetically, compareCustomers};`)();

test("customer directory uses compact fixed-height rows and an independent detail selection", () => {
  assert.match(styles, /\.customer-directory-row \{[^}]*height: 44px/s);
  assert.match(styles, /\.customer-directory-row-copy strong, \.customer-directory-row-copy > span \{[^}]*text-overflow: ellipsis;[^}]*white-space: nowrap/s);
  assert.match(pageSource, /onClick=\{\(\) => setPreviewCustomerId\(customer.id\)\}/);
  assert.match(pageSource, /filteredCustomers.find\(\(customer\) => customer.id === previewCustomerId\)\s*\?\? filteredCustomers\[0\] \?\? null/);
  assert.match(pageSource, /Kundenakte öffnen/);
});

test("alphabet filter includes umlauts and a group for other initials", () => {
  for (const [name, letter] of [[" Äcker", "A"], ["Öltechnik", "O"], ["Überbau", "U"], ["ebm", "E"], ["123 Firma", "#"], ["", "#"]]) {
    assert.equal(customerInitial(name), letter);
  }
  const customers = ["Zeta", "Öltechnik", "Alpha", "Äcker", "123 Firma"].map((company_name) => ({ company_name }));
  const groups = groupCustomersAlphabetically([...customers].sort(compareCustomers));
  assert.deepEqual(groups.map((group) => group.key), ["#", "A", "O", "Z"]);
  assert.equal(groups[1].customers.length, 2);
  assert.equal(groups[0].label, "Sonstige");
  assert.equal(customers[0].company_name, "Zeta");
  assert.match(pageSource, /letterFilter === "all" \|\| customerInitial\(customer.company_name\) === letterFilter/);
  assert.match(pageSource, /return sortDescending \? groups.reverse\(\) : groups/);
});

test("customer details retain contacts, permissions, full records and empty results", () => {
  assert.match(pageSource, /canEdit && <button className="icon-button secondary"/);
  assert.match(pageSource, /CustomerContactEditor key=\{previewCustomer.id\} canEdit=\{canEdit\}/);
  assert.match(pageSource, /saveCustomerContacts\(previewCustomer.id, contacts\)/);
  assert.match(pageSource, /Keine Treffer gefunden/);
  assert.match(pageSource, /Noch keine Kunden vorhanden/);
  assert.match(pageSource, /setPreviewTab\("master"\);\s*\}, \[previewCustomer\?\.id\]\)/);
});

test("customer directory stacks on mobile and independently scrolls the desktop list", () => {
  assert.match(styles, /\.customer-directory-results \{ overflow: auto; min-height: 0; flex: 1; \}/);
  assert.match(styles, /@media \(max-width: 760px\) \{\s*\.customer-directory \{ grid-template-columns: minmax\(0, 1fr\); height: auto/);
  assert.match(styles, /\.customer-directory-results \{ max-height: 330px; flex: auto; \}/);
});
