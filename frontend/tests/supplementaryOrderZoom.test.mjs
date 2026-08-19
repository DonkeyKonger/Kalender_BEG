import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  DEFAULT_SUPPLEMENTARY_ORDER_DOCUMENT_ZOOM,
  SUPPLEMENTARY_ORDER_DOCUMENT_ZOOM_LEVELS,
  SUPPLEMENTARY_ORDER_DOCUMENT_ZOOM_STORAGE_KEY,
  getSupplementaryOrderAutoFitWidth,
  getSupplementaryOrderFinalPaperWidth,
  normalizeSupplementaryOrderDocumentZoom,
  readSupplementaryOrderDocumentZoom,
  writeSupplementaryOrderDocumentZoom,
} from "../src/lib/supplementaryOrderZoom.ts";

const [componentSource, styles] = await Promise.all([
  readFile(new URL("../src/components/SupplementaryOrderDetail.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
]);

function memoryStorage(initialValue = null) {
  const values = new Map();
  if (initialValue !== null) {
    values.set(SUPPLEMENTARY_ORDER_DOCUMENT_ZOOM_STORAGE_KEY, initialValue);
  }
  return {
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, value);
    },
  };
}

test("supplementary-order zoom exposes only the six requested levels and safely normalizes old values", () => {
  assert.deepEqual(SUPPLEMENTARY_ORDER_DOCUMENT_ZOOM_LEVELS, [75, 90, 100, 110, 125, 150]);
  assert.equal(DEFAULT_SUPPLEMENTARY_ORDER_DOCUMENT_ZOOM, 100);
  assert.equal(normalizeSupplementaryOrderDocumentZoom("125"), 125);
  assert.equal(normalizeSupplementaryOrderDocumentZoom("80"), 100);
  assert.equal(normalizeSupplementaryOrderDocumentZoom(null), 100);
});

test("zoom persistence is browser-local and unavailable storage falls back without breaking the editor", () => {
  const storage = memoryStorage();
  assert.equal(readSupplementaryOrderDocumentZoom(storage), 100);
  writeSupplementaryOrderDocumentZoom(storage, 125);
  assert.equal(readSupplementaryOrderDocumentZoom(storage), 125);
  assert.equal(readSupplementaryOrderDocumentZoom(memoryStorage("old-value")), 100);
  assert.equal(readSupplementaryOrderDocumentZoom({ getItem() { throw new Error("blocked"); }, setItem() {} }), 100);
  assert.doesNotThrow(() => writeSupplementaryOrderDocumentZoom({ getItem() { return null; }, setItem() { throw new Error("blocked"); } }, 150));
});

test("user zoom multiplies the retained auto-fit width instead of being fitted down again", () => {
  assert.equal(getSupplementaryOrderAutoFitWidth(1200), 1200);
  assert.equal(getSupplementaryOrderAutoFitWidth(400), 760);
  assert.equal(getSupplementaryOrderAutoFitWidth(2200), 1600);
  assert.equal(getSupplementaryOrderFinalPaperWidth(1200, 75), 900);
  assert.equal(getSupplementaryOrderFinalPaperWidth(1200, 100), 1200);
  assert.equal(getSupplementaryOrderFinalPaperWidth(1200, 125), 1500);
  assert.equal(getSupplementaryOrderFinalPaperWidth(1200, 150), 1800);
});

test("toolbar, resize observer and paper stack share one persisted zoom width", () => {
  assert.match(componentSource, /aria-label="Dokumentzoom"/);
  assert.match(componentSource, /SUPPLEMENTARY_ORDER_DOCUMENT_ZOOM_LEVELS\.map/);
  assert.match(componentSource, /readSupplementaryOrderDocumentZoom\(getSupplementaryOrderZoomStorage\(\)\)/);
  assert.match(componentSource, /writeSupplementaryOrderDocumentZoom\(getSupplementaryOrderZoomStorage\(\), nextZoom\)/);
  assert.match(componentSource, /setAutoFitPaperWidth\(getSupplementaryOrderAutoFitWidth\(availableWidth\)\)/);
  assert.match(componentSource, /new ResizeObserver/);
  assert.match(componentSource, /getSupplementaryOrderFinalPaperWidth\(autoFitPaperWidth, documentZoom\)/);
  assert.match(componentSource, /data-document-zoom=\{documentZoom\}[\s\S]*width: `\$\{finalPaperWidth\}px`/);
  assert.doesNotMatch(componentSource, /style\.zoom|requestFullscreen|exitFullscreen/);
  assert.match(styles, /\.supplementary-order-workspace \{[^}]*overflow:\s*auto;/s);
  assert.match(styles, /\.supplementary-order-document-zoom select \{[^}]*min-height:\s*34px;/s);
});
