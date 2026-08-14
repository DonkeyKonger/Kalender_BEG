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
