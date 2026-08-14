import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";


const [siteDetailSource, mobileAssignmentSource, apiSource] = await Promise.all([
  readFile(new URL("../src/pages/SiteDetailPage.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/pages/MobileAssignmentDetailPage.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/lib/api.ts", import.meta.url), "utf8"),
]);


function sourceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `Start marker not found: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `End marker not found: ${endMarker}`);
  return source.slice(start, end);
}


test("a successful timesheet import refreshes the currently selected measurement batch", () => {
  const importSource = sourceBetween(
    siteDetailSource,
    "async function importMeasurementTimesheet(",
    "function updateSiteDraft(",
  );

  assert.match(importSource, /const selectedBatchId = selectedMeasurementBatch\?\.id \?\? null/);
  assert.match(importSource, /selectedBatchId === null\s*\? Promise\.resolve\(null\)\s*: api\.siteMeasurementBatchItems\(site\.id, selectedBatchId\)/s);
  assert.match(importSource, /setMeasurementBatchItems\(orderMeasurementItemsByColumnPosition\(refreshedBatchItems\)\)/);
});


test("position-master GET requests bypass the browser HTTP cache", () => {
  const measurementItemsSource = sourceBetween(apiSource, "async measurementItems(", "async measurementTimesheet(");
  const timesheetSource = sourceBetween(apiSource, "async measurementTimesheet(", "async hideMeasurementItem(");
  const desktopBatchItemsSource = sourceBetween(apiSource, "async siteMeasurementBatchItems(", "async siteMeasurementWorkers(");
  const mobileBatchItemsSource = sourceBetween(apiSource, "async mobileMeasurementBatchItems(", "async createMobileMeasurementFreeItem(");

  [
    measurementItemsSource,
    timesheetSource,
    desktopBatchItemsSource,
    mobileBatchItemsSource,
  ].forEach((methodSource) => {
    assert.match(methodSource, /cache: "no-store"/);
  });
});


test("desktop offer-based reviews keep positions without existing measurement entries", () => {
  const reviewSource = sourceBetween(
    siteDetailSource,
    "if (selectedBatch && !archiveMode)",
    "return (\n    <>\n      <header className=\"project-record-toolbar measurement-review-toolbar\"",
  );

  assert.match(reviewSource, /const tableItems = isFreePositionOnlyBatch\s*\? batchItems\.filter\(hasMeaningfulFreeMeasurementData\)\s*: batchItems/s);
  assert.doesNotMatch(reviewSource, /entries\.length > 0/);
  assert.match(reviewSource, /!isFreePositionOnlyBatch && batchItems\.length === 0/);
});


test("mobile measurement groups initially show all positions and preserve a manual group selection", () => {
  const groupSelectionSource = sourceBetween(
    mobileAssignmentSource,
    "function getActiveMeasurementPositionGroupKey(",
    "type MeasurementPositionTreeNode",
  );

  assert.match(groupSelectionSource, /if \(currentKey && groups\.some\(\(group\) => group\.key === currentKey\)\) \{\s*return currentKey;/s);
  assert.match(groupSelectionSource, /groups\.find\(\(group\) => group\.kind === "all" && group\.count > 0\)/);
  assert.doesNotMatch(groupSelectionSource, /kind === "captured"/);
});
