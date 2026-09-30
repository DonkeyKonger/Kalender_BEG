import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { filterWarehousePeople, hasWarehouseSignature, toggleWarehouseTool, warehouseToolIdentity } from "../src/lib/warehouseWorkflow.ts";

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
