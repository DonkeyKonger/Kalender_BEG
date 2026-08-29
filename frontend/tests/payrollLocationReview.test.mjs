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

test("location review always renders the persisted office site override as a third source", async () => {
  const source = await readFile(new URL("../src/pages/TimeEntriesPage.tsx", import.meta.url), "utf8");
  const rowsStart = source.indexOf("function locationReviewDiagnosticRows");
  const rowsEnd = source.indexOf("function hasManualLocationReview", rowsStart);
  const rows = source.slice(rowsStart, rowsEnd);

  assert.match(rows, /source: "Mobile Erfassung"[\s\S]*?source: "GPS-Erfassung"[\s\S]*?source: "Büroerfassung"/s);
  assert.match(rows, /const hasManualOfficeReview = hasManualLocationReview\(entry\)/);
  assert.match(rows, /siteName: hasManualOfficeReview \? displayDiagnosticValue\(timeEntrySiteName\(entry\)\) : "-"/);
  assert.match(rows, /siteNumber: hasManualOfficeReview \? displayDiagnosticValue\(entry\.site_number\) : "-"/);
  assert.match(rows, /location: hasManualOfficeReview \? siteLocationLabel\(reviewedSite\) : "-"/);
  assert.doesNotMatch(rows, /rows\.push/);
  assert.doesNotMatch(rows, /isManualReview/);
  assert.doesNotMatch(source, /is-manual-review/);
});

test("office site display reuses the saved original-versus-current site override without changing time review state", async () => {
  const source = await readFile(new URL("../src/pages/TimeEntriesPage.tsx", import.meta.url), "utf8");

  assert.match(source, /original_site_id: updatedEntry\.original_site_id \?\? previousEntry\.original_site_id/);
  assert.match(source, /decision: "assign_site",[\s\S]*?reviewed_site_id: parsedSiteId/s);
  assert.match(source, /function classifyTimeReviewTimeCheck[\s\S]*?function locationReviewDiagnosticRows/s);
});
