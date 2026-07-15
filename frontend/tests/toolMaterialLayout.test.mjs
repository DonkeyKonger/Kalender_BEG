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


test("status column is compact without truncating values or widening the table", () => {
  const designationColumnRule = cssRule(".tool-material-col-designation");
  const remarksColumnRule = cssRule(".tool-material-col-remarks");
  const statusColumnRule = cssRule(".tool-material-col-status");
  const statusTriggerRule = cssRule(".tool-material-inline-status-trigger");
  const statusTextRule = cssRule(".tool-material-inline-status-trigger > span");
  const statusPopupRule = cssRule(".tool-material-inline-status-popup");

  assert.match(statusColumnRule, /width:\s*110px/);
  assert.doesNotMatch(statusColumnRule, /%|max-content/);
  assert.match(designationColumnRule, /width:\s*auto/);
  assert.match(remarksColumnRule, /width:\s*auto/);
  assert.match(statusTriggerRule, /width:\s*100%/);
  assert.match(statusTriggerRule, /justify-content:\s*space-between/);
  assert.match(statusTriggerRule, /overflow:\s*visible/);
  assert.match(statusTextRule, /text-overflow:\s*clip/);
  assert.doesNotMatch(statusTextRule, /ellipsis/);
  assert.match(statusPopupRule, /min-width:\s*132px/);
  assert.match(styles, /\.tool-material-inline-status-trigger:hover:not\(:disabled\)/);
  assert.match(styles, /\.tool-material-inline-status-trigger:focus-visible/);
  assert.match(styles, /\.tool-material-status-spinner \{[^}]*animation:/s);
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


test("filter reset restores default sorting and status changes reload the ordered list", () => {
  assert.match(pageSource, /setSortBy\(defaultToolMaterialSorting\.sortBy\)/);
  assert.match(pageSource, /setSortDirection\(defaultToolMaterialSorting\.sortDirection\)/);
  assert.match(pageSource, /const result = await saveToolMaterialStatus[\s\S]*await refreshItems\(\)/);
});


test("only written-off rows use muted text while their status control stays interactive", () => {
  const writtenOffRule = cssRule(
    ".miscellaneous-tools-row.is-written-off > td:not(.miscellaneous-tools-status-cell)",
  );
  const statusTriggerRule = cssRule(".tool-material-inline-status-trigger");

  assert.match(
    pageSource,
    /item\.status === "written_off" \? " is-written-off" : ""/,
  );
  assert.match(writtenOffRule, /color:\s*#6f7b89/);
  assert.doesNotMatch(writtenOffRule, /opacity/);
  assert.match(statusTriggerRule, /cursor:\s*pointer/);
  assert.match(pageSource, /className=\{`tool-material-inline-status-trigger/);
  assert.match(pageSource, /event\.stopPropagation\(\);\s*setIsOpen/);
});


function cssRule(selector) {
  const start = styles.indexOf(`${selector} {`);
  assert.notEqual(start, -1, `CSS-Regel ${selector} fehlt`);
  const end = styles.indexOf("}", start);
  return styles.slice(start, end + 1);
}
