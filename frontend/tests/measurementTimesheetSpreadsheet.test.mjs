import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [source, styles] = await Promise.all([
  readFile(new URL("../src/pages/SiteDetailPage.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
]);

test("measurement timesheet keeps category filters above and capture totals below", () => {
  const filterbarIndex = source.indexOf('className="measurement-timesheet-filterbar"');
  const tableIndex = source.indexOf('className="measurement-table measurement-timesheet-table"');
  const statusbarIndex = source.indexOf('className="measurement-timesheet-statusbar"');

  assert.ok(filterbarIndex >= 0);
  assert.ok(tableIndex > filterbarIndex);
  assert.ok(statusbarIndex > tableIndex);
  assert.match(source, /const capturedPositions = projectPositionRows\.filter\(\(row\) => row\.measuredQuantity > 0\)\.length/);
  assert.match(source, /projectPositionCaptureStats\.totalPositions\} Positionen/);
  assert.match(source, /projectPositionCaptureStats\.capturedPositions\} erfasst/);
  assert.match(source, /projectPositionCaptureStats\.openPositions\} offen/);
});

test("measurement timesheet uses a compact continuous spreadsheet grid", () => {
  assert.match(source, /MEASUREMENT_TIMESHEET_ROW_HEIGHT = 38/);
  assert.match(source, /className="measurement-timesheet-description" title=\{row\.description\}/);
  assert.match(styles, /\.measurement-timesheet-table tbody td\s*\{[\s\S]*?height:\s*38px;[\s\S]*?border-right:\s*1px solid #dbe2eb;[\s\S]*?border-bottom:\s*1px solid #dbe2eb;/);
  assert.match(styles, /\.measurement-timesheet-description\s*\{[\s\S]*?white-space:\s*nowrap;[\s\S]*?text-overflow:\s*ellipsis;/);
  assert.match(styles, /\.measurement-timesheet-statusbar\s*\{[\s\S]*?background:\s*#eef2f6;/);
  assert.doesNotMatch(styles, /\.measurement-timesheet-table tbody tr:nth-child\(even\)/);
});

test("measurement timesheet keeps its status bar inside the desktop viewport", () => {
  assert.match(source, /const isMeasurementTimesheetWorkspace = activeTab === "measurement" && measurementSubtab === "timesheet"/);
  assert.match(source, /isMeasurementTimesheetWorkspace \? " is-measurement-timesheet-workspace" : ""/);
  assert.match(styles, /\.site-detail-page\.is-project-file-workspace\.is-measurement-timesheet-workspace\s*\{[\s\S]*?height:\s*calc\(100dvh - 48px\);[\s\S]*?grid-template-rows:\s*auto auto auto minmax\(0, 1fr\);/);
  assert.match(styles, /\.site-detail-page\.is-measurement-timesheet-workspace \.measurement-timesheet-table-panel\s*\{[\s\S]*?grid-template-rows:\s*auto minmax\(0, 1fr\) auto;[\s\S]*?overflow:\s*hidden;/);
  assert.match(styles, /\.site-detail-page\.is-measurement-timesheet-workspace \.measurement-timesheet-table-wrap\s*\{[\s\S]*?height:\s*100%;[\s\S]*?max-height:\s*none;[\s\S]*?overflow:\s*auto;/);
});

test("measurement search starts on the same grid line as the hours summary", () => {
  assert.match(styles, /\.measurement-timesheet-progress-row\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\) minmax\(240px, 320px\);/);
  assert.match(styles, /\.measurement-timesheet-filterbar\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\) minmax\(240px, 320px\);[\s\S]*?padding:\s*10px 0 10px 12px;/);
  assert.match(styles, /\.measurement-timesheet-search\s*\{[\s\S]*?width:\s*auto;[\s\S]*?margin-right:\s*12px;/);
});
