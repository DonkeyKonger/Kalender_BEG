import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { transformSync } from "esbuild";

const source = readFileSync(new URL("../src/pages/SiteDetailPage.tsx", import.meta.url), "utf8");
const start = source.indexOf("    const pending = pendingCreatedCellFocusRef.current;");
const end = source.indexOf("  });", start);
assert.ok(start > 0 && end > start);
const compiled = transformSync(`function restore(document, pendingCreatedCellFocusRef, tableWrapRef) {
  ${source.slice(start, end)}
}`, { loader: "ts" }).code;
const restore = new Function(`${compiled}; return restore;`)();

function fixture() {
  const sourceInput = { isConnected: true };
  const document = { body: {}, activeElement: sourceInput };
  const calls = [];
  const target = { dataset: { measurementCell: "42:eg" }, disabled: false,
    focus(options) { calls.push(options); document.activeElement = this; } };
  return { document, sourceInput, calls, target,
    pending: { current: { cellKey: "42:eg", source: sourceInput } },
    table: { current: { querySelectorAll() { return [target]; } } } };
}

test("Enter follows the newly saved cell instead of the reused empty column", () => {
  const f = fixture();
  restore(f.document, f.pending, f.table);
  assert.equal(f.document.activeElement, f.target);
  assert.deepEqual(f.calls, [{ preventScroll: true }]);
  assert.equal(f.pending.current, null);
});

test("focus restoration does not steal focus after a deliberate click or Tab", () => {
  const f = fixture();
  const otherInput = {};
  f.document.activeElement = otherInput;
  restore(f.document, f.pending, f.table);
  assert.equal(f.document.activeElement, otherInput);
  assert.equal(f.pending.current, null);
  assert.equal(f.calls.length, 0);
});

test("a newly persisted area can replace the source input without losing focus", () => {
  const f = fixture();
  f.sourceInput.isConnected = false;
  f.document.activeElement = f.document.body;
  restore(f.document, f.pending, f.table);
  assert.equal(f.document.activeElement, f.target);
});

test("waits for the saved cell to become available", () => {
  const f = fixture();
  f.target.disabled = true;
  restore(f.document, f.pending, f.table);
  assert.ok(f.pending.current);
  assert.equal(f.calls.length, 0);
  f.target.disabled = false;
  restore(f.document, f.pending, f.table);
  assert.equal(f.document.activeElement, f.target);
});

test("only Enter requests focus transfer, ordinary blur keeps normal navigation", () => {
  assert.match(source, /saveOfficeExtraCellDraft\(column.key, area, event.currentTarget, true\)/);
  assert.match(source, /saveOfficeExtraCellDraft\(column.key, area, event.currentTarget\)/);
  assert.match(source, /keepCellFocus = false/);
  assert.match(source, /if \(keepCellFocus\) \{\s*pendingCreatedCellFocusRef.current/);
});
