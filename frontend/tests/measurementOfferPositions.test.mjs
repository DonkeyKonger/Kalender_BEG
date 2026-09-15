import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import test from "node:test";
import { build } from "esbuild";
import { filterMeasurementOfferPositions } from "../src/lib/measurementOfferPositions.ts";

const item = { id: 1, position: "N3.1.10", description: "Kabelrinne liefern und montieren", unit: "m", sort_order: 2, is_hidden: false, is_free_position: false };
const items = [item, { ...item, id: 2, position: "1.01", sort_order: 1 }, { ...item, id: 3, is_hidden: true }, { ...item, id: 4, is_free_position: true }];
const compiled = await build({
  stdin: { contents: `import React from 'react'; import {renderToStaticMarkup} from 'react-dom/server';
    import {MeasurementOfferPositions} from './src/components/MeasurementOfferPositions';
    export const render = props => renderToStaticMarkup(React.createElement(MeasurementOfferPositions, props));`,
    resolveDir: fileURLToPath(new URL("..", import.meta.url)), loader: "tsx" },
  bundle: true, write: false, format: "cjs", platform: "node", packages: "external", jsx: "automatic", loader: { ".css": "empty" },
});
const module = { exports: {} };
new Function("require", "module", "exports", compiled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const render = overrides => module.exports.render({ name: "Hauptauftrag", items, loading: false, error: null, onRetry() {}, onClose() {}, ...overrides });

test("offer list excludes hidden/manual positions but includes unused catalog rows in offer order", () => {
  assert.deepEqual(filterMeasurementOfferPositions(items, "").map(item => item.id), [2, 1]);
  assert.equal(items[0].id, 1, "Do not mutate the source catalog");
});

test("search matches position and description across case-insensitive terms", () => {
  assert.deepEqual(filterMeasurementOfferPositions(items, "  n3.1 KABELRINNE ").map(item => item.id), [1]);
  assert.equal(filterMeasurementOfferPositions(items, "unbekannt").length, 0);
  assert.equal(filterMeasurementOfferPositions(items, "  ").length, 2);
});

test("read-only list renders source name, search, full descriptions, units and count", () => {
  const html = render();
  assert.match(html, /Hauptauftrag/);
  assert.match(html, /aria-label="Angebotspositionen durchsuchen"/);
  assert.match(html, /Kabelrinne liefern und montieren/);
  assert.match(html, /2 von 2 Positionen/);
  assert.doesNotMatch(html, /löschen|contenteditable|type="number"/);
  assert.match(render({ name: '<script>alert(1)</script>' }), /&lt;script&gt;/);
});

test("loading, empty and retry states do not expose stale table data", () => {
  assert.match(render({ loading: true }), /Positionen werden geladen/);
  assert.doesNotMatch(render({ loading: true }), /<table/);
  assert.match(render({ error: "Nicht erreichbar" }), /role="alert"/);
  assert.match(render({ error: "Nicht erreichbar" }), /Erneut versuchen/);
  assert.doesNotMatch(render({ error: "Nicht erreichbar" }), /<table/);
  assert.match(render({ items: [] }), /Keine Angebotspositionen vorhanden/);
});

test("viewer loads lazily from the assigned offer and prevents stale responses after closing", () => {
  const viewer = readFileSync(new URL("../src/components/MeasurementOfferViewer.tsx", import.meta.url), "utf8");
  const page = readFileSync(new URL("../src/pages/SiteDetailPage.tsx", import.meta.url), "utf8");
  assert.match(page, /isOfferVisible \? <MeasurementOfferViewer/);
  assert.match(viewer, /if \(baseId !== null\)/);
  assert.match(viewer, /api\.measurementItems\(siteId, \{ measurementBaseId: baseId \}\)/);
  assert.match(viewer, /if \(!cancelled\) setItems\(result\)/);
  assert.match(viewer, /cancelled = true/);
  assert.match(page, /offerTrigger\.current\?\.focus/);
  assert.match(viewer, /event\.key === "Escape"/);
  assert.match(page, /MeasurementOfferViewer key=\{selectedBatch.id\}/);
  assert.match(page, /selectedBatch.offer_id \?\? selectedBatch.measurement_base_id \?\? null/);
  assert.doesNotMatch(viewer, /createPortal|position: fixed/);
  const styles = readFileSync(new URL("../src/components/MeasurementOfferPositions.css", import.meta.url), "utf8");
  assert.match(styles, /grid-template-columns: minmax\(0, 4fr\) minmax\(260px, 1fr\)/);
});
