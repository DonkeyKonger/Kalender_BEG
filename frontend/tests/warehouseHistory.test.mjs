import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { getToolMaterialSection, setToolMaterialSection, buildToolMaterialEditPath, buildToolMaterialIssuePath } from "../src/lib/toolMaterialRouting.ts";
import { warehouseHistoryDate, warehouseHistorySearch } from "../src/lib/warehouseHistory.ts";

test("history is the default; existing person and defect links still open stock", () => {
  assert.equal(getToolMaterialSection(new URLSearchParams("tab=toolsMaterial")), "movements");
  assert.equal(getToolMaterialSection(new URLSearchParams(buildToolMaterialEditPath(42).split("?")[1])), "inventory");
  assert.equal(getToolMaterialSection(new URLSearchParams(buildToolMaterialIssuePath(7).split("?")[1])), "inventory");
  assert.equal(getToolMaterialSection(new URLSearchParams("toolId=bad&employeeId=-1")), "movements");
});

test("subtabs survive reload and browser history without losing stock deep link filters", () => {
  const old = new URLSearchParams("tab=toolsMaterial&toolId=7&employeeId=42");
  const history = setToolMaterialSection(old, "movements");
  assert.equal(getToolMaterialSection(new URLSearchParams(history.toString())), "movements");
  assert.equal(history.get("toolId"), "7");
  assert.equal(history.get("employeeId"), "42");
  const stock = setToolMaterialSection(history, "inventory");
  assert.equal(getToolMaterialSection(stock), "inventory");
  assert.equal(old.has("toolSection"), false);
});

test("history builds bounded encoded filters and omits empty filters", () => {
  const empty = new URLSearchParams(warehouseHistorySearch({ search: "  ", direction: "", dateFrom: "", dateTo: "", page: 1 }));
  assert.deepEqual([...empty.keys()], ["page", "page_size"]);
  assert.equal(empty.get("page_size"), "50");
  const query = new URLSearchParams(warehouseHistorySearch({ search: " BEG & 42 ", direction: "return", dateFrom: "2026-09-01", dateTo: "2026-09-30", page: 3 }));
  assert.equal(query.get("search"), "BEG & 42");
  assert.equal(query.get("direction"), "return");
  assert.equal(query.get("date_from"), "2026-09-01");
  assert.equal(query.get("date_to"), "2026-09-30");
  assert.equal(query.get("page"), "3");
});

test("receipts consistently display Berlin time including daylight saving changes", () => {
  assert.match(warehouseHistoryDate("2026-09-29T22:15:00Z"), /30\.09\.26,? 00:15/);
  assert.match(warehouseHistoryDate("2026-12-01T23:15:00Z"), /02\.12\.26,? 00:15/);
});

test("history loads signatures on demand and refreshes only while visible with cleanup", async () => {
  const source = await readFile(new URL("../src/components/WarehouseHistoryPanel.tsx", import.meta.url), "utf8");
  assert.match(source, /api\.warehouseHistoryDetail\(entry\.id, controller\.signal\)/);
  assert.match(source, /document\.visibilityState === "visible"/);
  assert.match(source, /window\.setInterval\(reloadVisible, 15_000\)/);
  assert.match(source, /controller\.abort\(\); window\.clearInterval\(timer\)/);
  assert.match(source, /if \(running \|\| controller\.signal\.aborted\) return/);
  assert.match(source, /signatureStrokeToSvgPoints\(stroke\)/);
  assert.match(source, /key=\{selected\.id\}/);
  assert.doesNotMatch(source, /localStorage|sessionStorage|dangerouslySetInnerHTML/);
});

test("subtab integration preserves the inventory component and its routes", async () => {
  const source = await readFile(new URL("../src/pages/MiscellaneousPage.tsx", import.meta.url), "utf8");
  assert.match(source, /Ausgaben \/ Rückgaben<\/button>[\s\S]*>Bestand<\/button>/);
  assert.match(source, /toolSection === "movements" \? <WarehouseHistoryPanel \/> : <ToolMaterialList/);
  assert.match(source, /onAllRouteFiltersReset=\{resetToolMaterialRouteFilters\}/);
  assert.match(source, /setToolMaterialSection\(next, "inventory"\)/);
  assert.match(source, /setToolMaterialSection\(clearToolMaterialIdFilter\(searchParams\), "inventory"\)/);
  assert.match(source, /setToolMaterialSection\(setToolMaterialEmployeeFilterValues\(searchParams, values\), "inventory"\)/);
});

test("receipt drawer stays within the viewport and lets long tool lists scroll", async () => {
  const css = await readFile(new URL("../src/components/WarehouseHistoryPanel.css", import.meta.url), "utf8");
  assert.match(css, /\.warehouse-history-panel \.entity-drawer-panel \{[^}]*height: 100dvh;[^}]*max-height: 100dvh;[^}]*min-height: 0/);
  assert.match(css, /\.warehouse-history-panel \.entity-drawer-content \{ min-height: 0/);
});
