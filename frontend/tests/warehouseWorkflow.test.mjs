import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { filterWarehousePeople, hasWarehouseSignature, toggleWarehouseTool, warehouseReturnReasonLabel, warehouseReturnReasonPayload, warehouseReturnReasons, warehouseToolIdentity } from "../src/lib/warehouseWorkflow.ts";

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

test("selected warehouse tool bubbles show only BEG number and type with fallbacks", async () => {
  const page = await readFile(new URL("../src/pages/WarehousePage.tsx", import.meta.url), "utf8");
  const start = page.indexOf('{selected.length > 0 && <div className="wh-selection"');
  const end = page.indexOf("{selected.length === 100", start);
  assert.notEqual(start, -1, "selection bubble block exists");
  assert.notEqual(end, -1, "selection bubble block has a stable boundary");
  const selection = page.slice(start, end);
  assert.match(selection, /aria-label=\{`\$\{item\.beg_number \|\| "Ohne BEG-Nr\."\} · \$\{item\.item_type \|\| "Ohne Typ"\} aus Auswahl entfernen`\}/);
  assert.match(selection, /\{item\.beg_number \|\| "Ohne BEG-Nr\."\} · \{item\.item_type \|\| "Ohne Typ"\}<X size=\{16\} \/>/);
  assert.match(selection, /onClick=\{\(\) => onToggle\(item\)\}/);
  assert.doesNotMatch(selection, /designation|manufacturer|device_number|serial_number|warehouseToolIdentity/);
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
  assert.match(label, /\[item\.manufacturer, item\.beg_number \|\| "Ohne BEG-Nr\.", item\.item_type\]/);
  assert.doesNotMatch(label, /className="wh-beg"/);
  assert.match(label, /\{showIdentity && <small>\{warehouseToolIdentity\(item\)\}<\/small>\}/);
  const tiles = page.slice(page.indexOf('<div className="wh-tools-grid">'), page.indexOf('{!page.items.length'));
  assert.match(tiles, /<ToolLabel item=\{item\} \/>/);
  assert.doesNotMatch(tiles, /showIdentity|device_number|serial_number|warehouseToolIdentity/);
  const review = page.slice(page.indexOf("function BookingReview("), page.indexOf("function SignaturePad("));
  assert.match(review, /<ToolLabel item=\{item\} showIdentity \/>/);
});

test("return reasons use exact labels, default to warehouse and only include selected tools", () => {
  assert.deepEqual(warehouseReturnReasons.map((option) => option.label), ["Gerät defekt", "Gerät verloren", "Rückgabe Lager"]);
  assert.equal(warehouseReturnReasonLabel("lost"), "Gerät verloren");
  assert.equal(warehouseReturnReasonLabel(null), "Nicht erfasst");
  assert.equal(warehouseReturnReasonLabel(undefined), "Nicht erfasst");
  const reasons = { 1: "defective", 2: "lost", 99: "lost" };
  assert.deepEqual(warehouseReturnReasonPayload([{ id: 1 }, { id: 2 }, { id: 3 }], reasons), { 1: "defective", 2: "lost", 3: "warehouse" });
  assert.deepEqual(reasons, { 1: "defective", 2: "lost", 99: "lost" });
});

test("return reasons are signed, frozen on uncertain saves and shown in receipt details", async () => {
  const page = await readFile(new URL("../src/pages/WarehousePage.tsx", import.meta.url), "utf8");
  assert.match(page, /direction === "return" \? \{ return_reasons: warehouseReturnReasonPayload\(items, returnReasons\) \} : \{\}/);
  assert.match(page, /direction === "return" && <label className="wh-return-reason"/);
  assert.match(page, /value=\{returnReasons\[item.id\] \?\? "warehouse"\} disabled=\{frozen\}/);
  assert.match(page, /onReasonChange\(item.id,[^\n]*setStrokes\(\[\]\); pending.current = null/);
  assert.match(page, /returnReasons=\{returnReasons\}/);
  assert.match(page, /const payload = pending.current \?\?/);
  const history = await readFile(new URL("../src/components/WarehouseHistoryPanel.tsx", import.meta.url), "utf8");
  assert.match(history, /Rückgabegrund: \{warehouseReturnReasonLabel\(item.return_reason\)\}/);
});

test("warehouse tool grid has three columns with a single-column phone fallback", async () => {
  const css = await readFile(new URL("../src/pages/WarehousePage.css", import.meta.url), "utf8");
  assert.match(css, /\.wh-tools-grid \{[^}]*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
  assert.match(css, /@media \(max-width: 650px\)[\s\S]*\.wh-start-grid, \.wh-tools-grid, \.wh-people-grid \{ grid-template-columns: minmax\(0, 1fr\)/);
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
