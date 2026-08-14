import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sitePageSource = await readFile(new URL("../src/pages/SiteDetailPage.tsx", import.meta.url), "utf8");
const mobilePageSource = await readFile(new URL("../src/pages/MobileAssignmentDetailPage.tsx", import.meta.url), "utf8");
const apiSource = await readFile(new URL("../src/lib/api.ts", import.meta.url), "utf8");

test("appending an offer refreshes only the selected batch position catalog", () => {
  const importStart = sitePageSource.indexOf("async function importMeasurementTimesheet(");
  const importEnd = sitePageSource.indexOf("function updateSiteDraft(", importStart);
  const importSource = sitePageSource.slice(importStart, importEnd);

  assert.match(importSource, /selectedMeasurementBatch\?\.measurement_base_id === result\.measurement_base\.id/);
  assert.match(importSource, /api\.siteMeasurementBatchItems\(site\.id, selectedBatchId\)/);
  assert.match(importSource, /setMeasurementBatchItems\(orderMeasurementItemsByColumnPosition\(selectedBatchItems\)\)/);
});

test("desktop and mobile position catalogs always bypass stale HTTP responses", () => {
  assert.match(
    apiSource,
    /siteMeasurementBatchItems[\s\S]*?measurement-batches\/\$\{batchId\}\/items`, \{\s*cache: "no-store"/,
  );
  assert.match(
    apiSource,
    /mobileMeasurementBatchItems[\s\S]*?measurement-batches\/\$\{batchId\}\/items`, \{\s*cache: "no-store"/,
  );
});

test("catalog refresh does not add empty offer positions to the correction matrix", () => {
  assert.match(sitePageSource, /const itemsWithEntries = batchItems\.filter\(\(item\) => item\.entries\.length > 0\)/);
  assert.match(
    sitePageSource,
    /const tableItems = isFreePositionOnlyBatch\s*\? batchItems\.filter\(hasMeaningfulFreeMeasurementData\)\s*: itemsWithEntries/,
  );
  assert.match(sitePageSource, /positionSuggestions=\{isFreePositionOnlyBatch[\s\S]*?: batchItems\.filter\(\(item\) => !item\.is_free_position\)\.map/);
});

test("mobile keeps the existing position selection and grouping behavior", () => {
  assert.match(mobilePageSource, /const response = await api\.mobileMeasurementBatchItems\(assignment\.id, batch\.id\);\s*setItems\(response\)/);
  assert.match(mobilePageSource, /const capturedGroup = groups\.find\(\(group\) => group\.kind === "captured" && group\.count > 0\)/);
  assert.match(mobilePageSource, /return capturedGroup\.key/);
});
