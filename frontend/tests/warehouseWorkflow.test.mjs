import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { filterWarehousePeople, hasWarehouseSignature, toggleWarehouseTool, warehouseToolIdentity } from "../src/lib/warehouseWorkflow.ts";

test("warehouse home starts with the question without an extra tools heading", async () => {
  const page = await readFile(new URL("../src/pages/WarehousePage.tsx", import.meta.url), "utf8");
  const intro = page.slice(page.indexOf('<div className="wh-intro">'), page.indexOf('<div className="wh-start-grid">'));
  assert.match(intro, /<h1>Was möchtest du tun\?<\/h1>/);
  assert.doesNotMatch(intro, /wh-eyebrow|WERKZEUGE & MATERIAL/);
});

test("issue and return person selection omit the redundant name instruction", async () => {
  const page = await readFile(new URL("../src/pages/WarehousePage.tsx", import.meta.url), "utf8");
  const selection = page.slice(page.indexOf("function PersonSelection("), page.indexOf("function ToolSelection("));
  assert.match(selection, /holt Werkzeug ab/);
  assert.match(selection, /gibt Werkzeug zurück/);
  assert.doesNotMatch(selection, /Bitte deinen Namen auswählen/);
});

test("warehouse search matches trimmed names and short codes", () => {
  const people = [{ id: 1, display_name: "Jens Köhle", short_code: "JK" }, { id: 2, display_name: "Bert Test", short_code: "BT" }];
  assert.equal(filterWarehousePeople(people, " köHLE ")[0].id, 1);
  assert.equal(filterWarehousePeople(people, " bt ")[0].id, 2);
  assert.equal(filterWarehousePeople(people, "unknown").length, 0);
});

test("selection identifies physical items even when BEG numbers match", () => {
  const a = { id: 1, beg_number: "100" }, b = { id: 2, beg_number: "100" };
  const selected = toggleWarehouseTool(toggleWarehouseTool([], a), b);
  assert.deepEqual(selected, [a, b]);
  assert.deepEqual(toggleWarehouseTool(selected, a), [b]);
  assert.deepEqual(selected, [a, b], "no mutation");
});

test("selection limit remains removable", () => {
  const items = Array.from({ length: 100 }, (_, index) => ({ id: index + 1 }));
  assert.equal(toggleWarehouseTool(items, { id: 101 }).length, 100);
  assert.equal(toggleWarehouseTool(items, items[0]).length, 99);
});

test("physical device labels preserve both identifiers or fall back to inventory id", () => {
  assert.equal(warehouseToolIdentity({ id: 1, device_number: "A", serial_number: "B" }), "Gerät A · SN B");
  assert.equal(warehouseToolIdentity({ id: 2 }), "Eintrag #2");
});

test("warehouse tiles show only BEG number, designation, manufacturer and type; review keeps device identity", async () => {
  const page = await readFile(new URL("../src/pages/WarehousePage.tsx", import.meta.url), "utf8");
  const label = page.slice(page.indexOf("function ToolLabel("), page.indexOf("function SearchField("));
  assert.match(label, /showIdentity = false/);
  assert.match(label, /item\.beg_number/);
  assert.match(label, /item\.designation/);
  assert.match(label, /\[item\.manufacturer, item\.item_type\]/);
  assert.match(label, /\{showIdentity && <small>\{warehouseToolIdentity\(item\)\}<\/small>\}/);
  const tiles = page.slice(page.indexOf('<div className="wh-tools-grid">'), page.indexOf('{!page.items.length'));
  assert.match(tiles, /<ToolLabel item=\{item\} \/>/);
  assert.doesNotMatch(tiles, /showIdentity|device_number|serial_number|warehouseToolIdentity/);
  assert.match(page, /className="wh-review-items"[^\n]*<ToolLabel item=\{item\} showIdentity \/>/);
});

test("a tap or repeated identical coordinates is not a signature", () => {
  assert.equal(hasWarehouseSignature([]), false);
  assert.equal(hasWarehouseSignature([[{ x: .1, y: .1 }]]), false);
  assert.equal(hasWarehouseSignature([[{ x: .1, y: .1 }, { x: .1, y: .1 }]]), false);
  assert.equal(hasWarehouseSignature([[{ x: .1, y: .1 }, { x: .2, y: .1 }]]), true);
});

test("workflow preserves pending idempotency payload and keeps signatures in memory only", async () => {
  const page = await readFile(new URL("../src/pages/WarehousePage.tsx", import.meta.url), "utf8");
  assert.match(page, /pending\.current \?\?/);
  assert.match(page, /if \(inFlight\.current/);
  assert.match(page, /const frozen = saving \|\| uncertain/);
  assert.match(page, /controller\.abort\(\)/);
  assert.match(page, /ResizeObserver/);
  assert.match(page, /setSelected\(\[\]\); setPerson\(null\)/);
  assert.doesNotMatch(page, /localStorage|sessionStorage/);
});
