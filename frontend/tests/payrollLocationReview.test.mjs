import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("manual site assignment confirms only the location check", async () => {
  const source = await readFile(new URL("../src/pages/TimeEntriesPage.tsx", import.meta.url), "utf8");
  const locationCheckStart = source.indexOf("function classifyTimeReviewLocationCheck");
  const timeCheckStart = source.indexOf("function classifyTimeReviewTimeCheck");
  const locationCheck = source.slice(locationCheckStart, timeCheckStart);

  assert.match(locationCheck, /if \(hasManualLocationReview\(entry\)\) \{\s+return "ok";/);
  assert.match(source, /return entry\.original_site_id !== null && entry\.original_site_id !== entry\.site_id;/);
});

test("location review always renders the persisted or locally previewed office site as a third source", async () => {
  const source = await readFile(new URL("../src/pages/TimeEntriesPage.tsx", import.meta.url), "utf8");
  const rowsStart = source.indexOf("function locationReviewDiagnosticRows");
  const rowsEnd = source.indexOf("function hasManualLocationReview", rowsStart);
  const rows = source.slice(rowsStart, rowsEnd);

  assert.match(rows, /source: "Mobile Erfassung"[\s\S]*?source: "GPS-Erfassung"[\s\S]*?source: "Büroerfassung"/s);
  assert.match(rows, /const hasManualOfficeReview = hasManualLocationReview\(entry\)/);
  assert.match(rows, /previewOfficeSiteId: string \| null = null/);
  assert.match(rows, /const previewedOfficeSite = [\s\S]*?findSiteSummary\(sites, parsedPreviewOfficeSiteId\)/s);
  assert.match(rows, /const hasOfficeReview = hasManualOfficeReview \|\| previewedOfficeSite !== null/);
  assert.match(rows, /siteName: hasOfficeReview \? displayDiagnosticValue\(previewedOfficeSite\?\.name \?\? timeEntrySiteName\(entry\)\) : "-"/);
  assert.match(rows, /siteNumber: hasOfficeReview \? displayDiagnosticValue\(previewedOfficeSite\?\.site_number \?\? entry\.site_number\) : "-"/);
  assert.match(rows, /location: hasOfficeReview \? siteLocationLabel\(reviewedSite\) : "-"/);
  assert.doesNotMatch(rows, /rows\.push/);
  assert.doesNotMatch(rows, /isManualReview/);
  assert.doesNotMatch(source, /is-manual-review/);
});

test("manual site selection previews the office row immediately but only saves through the primary action", async () => {
  const source = await readFile(new URL("../src/pages/TimeEntriesPage.tsx", import.meta.url), "utf8");
  const selectionStart = source.indexOf("function selectLocationReviewSite");
  const selectionEnd = source.indexOf("function moveLocationReviewActiveSite", selectionStart);
  const selection = source.slice(selectionStart, selectionEnd);
  const saveStart = source.indexOf("async function saveLocationReviewSite");
  const saveEnd = source.indexOf("async function downloadAllReviewWeekXlsx", saveStart);
  const save = source.slice(saveStart, saveEnd);

  assert.match(source, /const \[hasLocationReviewSitePreview, setHasLocationReviewSitePreview\] = useState\(false\)/);
  assert.match(selection, /setLocationReviewSiteId\(siteId\);[\s\S]*?setHasLocationReviewSitePreview\(true\);/s);
  assert.match(source, /onClick=\{\(\) => selectLocationReviewSite\(String\(site\.id\), true\)\}/);
  assert.match(source, /onClick=\{\(\) => selectLocationReviewSite\(String\(site\.id\)\)\}/);
  assert.match(source, /hasLocationReviewSitePreview \? locationReviewSiteId : null/);
  assert.doesNotMatch(selection, /decideTimeEntryReview|saveLocationReviewSite/);
  assert.match(save, /decision: "assign_site",[\s\S]*?reviewed_site_id: parsedSiteId/s);
});

test("closing without saving discards the office preview while a successful save keeps the persisted override", async () => {
  const source = await readFile(new URL("../src/pages/TimeEntriesPage.tsx", import.meta.url), "utf8");
  const resetStart = source.indexOf("useEffect(() => {\n    if (!locationReviewDiagnosticEntry)");
  const resetEnd = source.indexOf("useEffect(() => {\n    if (!isLocationReviewPickerOpen)", resetStart);
  const reset = source.slice(resetStart, resetEnd);
  const closeStart = source.indexOf("function closeLocationReviewDiagnostic");
  const closeEnd = source.indexOf("function closeLocationReviewPicker", closeStart);
  const close = source.slice(closeStart, closeEnd);
  const saveStart = source.indexOf("async function saveLocationReviewSite");
  const saveEnd = source.indexOf("async function downloadAllReviewWeekXlsx", saveStart);
  const save = source.slice(saveStart, saveEnd);

  assert.match(reset, /setHasLocationReviewSitePreview\(false\);/);
  assert.match(close, /setHasLocationReviewSitePreview\(false\);[\s\S]*?setLocationReviewDiagnosticEntry\(null\);/s);
  assert.match(save, /setLocationReviewDiagnosticEntry[\s\S]*?setLocationReviewSiteId\(String\(parsedSiteId\)\);[\s\S]*?setHasLocationReviewSitePreview\(false\);/s);
  assert.match(source, /function hasManualLocationReview\(entry: TimeEntry\): boolean \{[\s\S]*?entry\.original_site_id !== entry\.site_id;/s);
});

test("office site display reuses the saved original-versus-current site override without changing time review state", async () => {
  const source = await readFile(new URL("../src/pages/TimeEntriesPage.tsx", import.meta.url), "utf8");

  assert.match(source, /original_site_id: updatedEntry\.original_site_id \?\? previousEntry\.original_site_id/);
  assert.match(source, /decision: "assign_site",[\s\S]*?reviewed_site_id: parsedSiteId/s);
  assert.match(source, /function classifyTimeReviewTimeCheck[\s\S]*?function locationReviewDiagnosticRows/s);
});
