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

test("supplementary-order zoom exposes all requested levels down to 25 percent and safely normalizes old values", () => {
  assert.deepEqual(SUPPLEMENTARY_ORDER_DOCUMENT_ZOOM_LEVELS, [25, 50, 75, 90, 100, 110, 125, 150]);
  assert.equal(DEFAULT_SUPPLEMENTARY_ORDER_DOCUMENT_ZOOM, 100);
  assert.equal(normalizeSupplementaryOrderDocumentZoom("25"), 25);
  assert.equal(normalizeSupplementaryOrderDocumentZoom("50"), 50);
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
  assert.equal(getSupplementaryOrderFinalPaperWidth(1200, 25), 300);
  assert.equal(getSupplementaryOrderFinalPaperWidth(1200, 50), 600);
  assert.equal(getSupplementaryOrderFinalPaperWidth(1200, 75), 900);
  assert.equal(getSupplementaryOrderFinalPaperWidth(1200, 100), 1200);
  assert.equal(getSupplementaryOrderFinalPaperWidth(1200, 125), 1500);
  assert.equal(getSupplementaryOrderFinalPaperWidth(1200, 150), 1800);
  assert.equal(getSupplementaryOrderFinalPaperWidth(getSupplementaryOrderAutoFitWidth(400), 25), 190);
});

test("toolbar, resize observer and paper stack share one persisted zoom width", () => {
  assert.match(componentSource, /aria-label="Dokumentzoom"/);
  assert.match(componentSource, /SUPPLEMENTARY_ORDER_DOCUMENT_ZOOM_LEVELS\.map/);
  assert.match(componentSource, /readSupplementaryOrderDocumentZoom\(getSupplementaryOrderZoomStorage\(\)\)/);
  assert.match(componentSource, /writeSupplementaryOrderDocumentZoom\(getSupplementaryOrderZoomStorage\(\), nextZoom\)/);
  assert.match(componentSource, /const nextWidth = getSupplementaryOrderAutoFitWidth\(availableWidth\);[\s\S]{0,250}setAutoFitPaperWidth/);
  assert.match(componentSource, /Math\.abs\(current - nextWidth\) < 1 \? current : nextWidth/);
  assert.match(componentSource, /new ResizeObserver/);
  assert.match(componentSource, /getSupplementaryOrderFinalPaperWidth\(autoFitPaperWidth, documentZoom\)/);
  assert.match(componentSource, /data-document-zoom=\{documentZoom\}[\s\S]*width: `\$\{finalPaperWidth\}px`/);
  assert.doesNotMatch(componentSource, /style\.zoom|requestFullscreen|exitFullscreen/);
  assert.match(styles, /\.supplementary-order-workspace \{[^}]*overflow:\s*auto;/s);
  assert.match(styles, /\.supplementary-order-document-back \{[^}]*height:\s*34px;[^}]*border-radius:\s*2px;/s);
  assert.match(styles, /\.supplementary-order-document-zoom select \{[^}]*height:\s*34px;[^}]*appearance:\s*none;[^}]*border-radius:\s*2px;/s);
  assert.match(styles, /\.supplementary-order-document-actions \.secondary-action,[\s\S]*?height:\s*34px;[\s\S]*?border-radius:\s*2px;/);
});

test("one bounded PDF image and the HTML overlay scale synchronously at every document zoom", () => {
  assert.equal(componentSource.match(/pdfjsLib\.getDocument\(/g)?.length, 1);
  assert.match(componentSource, /SUPPLEMENTARY_ORDER_TEMPLATE_PREVIEW_WIDTH = 1600;/);
  assert.match(componentSource, /SUPPLEMENTARY_ORDER_TEMPLATE_PREVIEW_MAX_PIXELS = 4_000_000;/);
  assert.match(componentSource, /Math\.min\(SUPPLEMENTARY_ORDER_TEMPLATE_PREVIEW_WIDTH, pixelBudgetWidth\)/);
  assert.match(componentSource, /<img[\s\S]{0,300}src=\{previewUrl\}/);
  assert.doesNotMatch(componentSource, /renderVersion|canvasRef=\{canvasRef\}/);
  assert.match(styles, /\.supplementary-order-pdf-background img \{[^}]*width:\s*100%;[^}]*height:\s*100%;/s);
  assert.match(styles, /\.supplementary-order-pdf-background,\s*\.supplementary-order-overlay \{[^}]*position:\s*absolute;[^}]*inset:\s*0;/s);
});

test("paper inputs use block layout so text baselines cannot move their boxes at small zooms", () => {
  assert.match(styles, /\.supplementary-order-paper-field input,\s*\.supplementary-order-paper-field textarea \{[^}]*display:\s*block;[^}]*width:\s*100%;[^}]*height:\s*100%;/s);
});
