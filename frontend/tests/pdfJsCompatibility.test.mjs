import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { installPdfJsLegacyCompatibility } from "../src/lib/pdfJsLegacyPolyfills.ts";
import {
  PDF_PREVIEW_MAX_DOCUMENT_PIXELS,
  PDF_PREVIEW_MAX_PAGE_PIXELS,
  PDF_PREVIEW_RENDER_ERROR_MESSAGE,
  getPdfPreviewRenderScale,
  renderPdfPagesSequentially,
} from "../src/lib/pdfPreview.ts";

const [compatibilitySource, polyfillSource, mobileSource, supplementaryOrderSource] = await Promise.all([
  readFile(new URL("../src/lib/pdfJsCompatibility.ts", import.meta.url), "utf8"),
  readFile(new URL("../src/lib/pdfJsLegacyPolyfills.ts", import.meta.url), "utf8"),
  readFile(new URL("../src/pages/MobileAssignmentDetailPage.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/components/SupplementaryOrderDetail.tsx", import.meta.url), "utf8"),
]);

test("legacy compatibility installs the PDF.js APIs missing in older WebViews", async () => {
  class LegacyPromise extends Promise {}
  class LegacyMap extends Map {}
  class LegacyURL extends URL {}
  const LegacyAbortSignal = function LegacyAbortSignal() {};
  const scope = {
    Promise: LegacyPromise,
    Map: LegacyMap,
    URL: LegacyURL,
    AbortController,
    AbortSignal: LegacyAbortSignal,
  };

  installPdfJsLegacyCompatibility(scope);

  const capability = scope.Promise.withResolvers();
  capability.resolve("ready");
  assert.equal(await capability.promise, "ready");

  const cache = new scope.Map();
  let computations = 0;
  assert.equal(cache.getOrInsertComputed("page", () => {
    computations += 1;
    return 7;
  }), 7);
  assert.equal(cache.getOrInsertComputed("page", () => {
    computations += 1;
    return 9;
  }), 7);
  assert.equal(computations, 1);

  assert.equal(scope.URL.parse("/pdf", "https://example.test/app")?.href, "https://example.test/pdf");
  assert.equal(scope.URL.parse("not a valid absolute URL"), null);

  const firstController = new AbortController();
  const secondController = new AbortController();
  const combinedSignal = scope.AbortSignal.any([firstController.signal, secondController.signal]);
  assert.equal(combinedSignal.aborted, false);
  secondController.abort("cancelled");
  assert.equal(combinedSignal.aborted, true);
});

test("main module and worker use the matching PDF.js legacy build through one retryable loader", () => {
  assert.match(compatibilitySource, /pdfjs-dist\/legacy\/build\/pdf\.worker\.min\.mjs\?url/);
  assert.match(compatibilitySource, /import\("pdfjs-dist\/legacy\/build\/pdf\.mjs"\)/);
  assert.match(compatibilitySource, /installPdfJsLegacyCompatibility\(\);[\s\S]*compatiblePdfJsLoader = import/);
  assert.match(polyfillSource, /withResolvers/);
  assert.match(polyfillSource, /getOrInsertComputed/);
  assert.match(polyfillSource, /AbortSignal/);
  assert.match(polyfillSource, /scope\.URL, "parse"/);
  assert.match(compatibilitySource, /\.catch\(\(error\) => \{\s*compatiblePdfJsLoader = null;/);
  assert.doesNotMatch(mobileSource, /pdfjs-dist\/build\/pdf/);
  assert.doesNotMatch(supplementaryOrderSource, /pdfjs-dist\/build\/pdf/);
  assert.match(mobileSource, /loadCompatiblePdfJs\(\)/);
  assert.match(supplementaryOrderSource, /loadCompatiblePdfJs\(\)/);
});

test("multi-page photo PDFs share a bounded document pixel budget", () => {
  const cssWidth = 720;
  const cssHeight = 1_018;
  const singlePageScale = getPdfPreviewRenderScale(cssWidth, cssHeight, 1, 3);
  const twelvePageScale = getPdfPreviewRenderScale(cssWidth, cssHeight, 12, 3);
  const singlePagePixels = cssWidth * cssHeight * singlePageScale ** 2;
  const twelvePagePixels = cssWidth * cssHeight * twelvePageScale ** 2 * 12;

  assert.ok(singlePagePixels <= PDF_PREVIEW_MAX_PAGE_PIXELS + 1);
  assert.ok(twelvePagePixels <= PDF_PREVIEW_MAX_DOCUMENT_PIXELS + 1);
  assert.ok(twelvePageScale < singlePageScale);
  assert.ok(twelvePageScale >= 1);
});

test("multi-page rendering stays sequential and visits every page in document order", async () => {
  const started = [];
  const completed = [];
  let activeRenders = 0;
  let peakActiveRenders = 0;

  const didComplete = await renderPdfPagesSequentially({
    pageCount: 6,
    isCancelled: () => false,
    renderPage: async (pageNumber) => {
      started.push(pageNumber);
      activeRenders += 1;
      peakActiveRenders = Math.max(peakActiveRenders, activeRenders);
      await Promise.resolve();
      activeRenders -= 1;
      return `page-${pageNumber}`;
    },
    onPageRendered: (_page, pageNumber) => completed.push(pageNumber),
  });

  assert.equal(didComplete, true);
  assert.deepEqual(started, [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(completed, [1, 2, 3, 4, 5, 6]);
  assert.equal(peakActiveRenders, 1);
});

test("a page finishing after cancellation is discarded instead of retaining its canvas", async () => {
  let isCancelled = false;
  const rendered = [];
  const discarded = [];

  const didComplete = await renderPdfPagesSequentially({
    pageCount: 4,
    isCancelled: () => isCancelled,
    renderPage: async (pageNumber) => {
      isCancelled = true;
      return `page-${pageNumber}`;
    },
    onPageRendered: (page) => rendered.push(page),
    onPageDiscarded: (page) => discarded.push(page),
  });

  assert.equal(didComplete, false);
  assert.deepEqual(rendered, []);
  assert.deepEqual(discarded, ["page-1"]);
});

test("rendering errors stop later pages and remain a clear retryable UI state", async () => {
  const started = [];
  const completed = [];

  await assert.rejects(
    renderPdfPagesSequentially({
      pageCount: 5,
      isCancelled: () => false,
      renderPage: async (pageNumber) => {
        started.push(pageNumber);
        if (pageNumber === 3) {
          throw new Error("canvas allocation failed");
        }
        return pageNumber;
      },
      onPageRendered: (_page, pageNumber) => completed.push(pageNumber),
    }),
    /canvas allocation failed/,
  );

  assert.deepEqual(started, [1, 2, 3]);
  assert.deepEqual(completed, [1, 2]);
  assert.equal(PDF_PREVIEW_RENDER_ERROR_MESSAGE, "PDF konnte nicht angezeigt werden. Bitte erneut versuchen.");
  assert.match(mobileSource, /setRenderError\(PDF_PREVIEW_RENDER_ERROR_MESSAGE\)/);
  assert.match(mobileSource, />\s*PDF erneut anzeigen\s*</);
  assert.match(mobileSource, /releasePdfPreviewCanvases\(renderTarget\)/);
  assert.match(mobileSource, /canvas\.width = 0;\s*canvas\.height = 0;/);
});

test("authenticated Blob loading and both signature workflows remain unchanged", () => {
  assert.match(mobileSource, /api\.mobileExtraWorkTicketPdf\(assignmentId, activeOrder\.id\)[\s\S]*blob\.arrayBuffer\(\)/);
  assert.match(mobileSource, /api\.mobileMeasurementBatchPdf\(assignmentId, batch\.id\)[\s\S]*blob\.arrayBuffer\(\)/);
  assert.equal(mobileSource.match(/<PdfCanvasPreview data=\{pdfData\} \/>/g)?.length, 2);
  assert.doesNotMatch(mobileSource, /mobile-customer-signature-frame" src=\{/);
  assert.match(mobileSource, /getPdfPreviewRenderScale\([\s\S]*activePdfDocument\.numPages/);
  assert.match(mobileSource, /renderPdfPagesSequentially\(\{[\s\S]*renderTarget\.appendChild\(pageElement\)/);
  assert.match(mobileSource, /onPageDiscarded:[\s\S]*releasePdfPreviewCanvases\(pageElement\)/);
});
