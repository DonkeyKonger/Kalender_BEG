import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [source, styles] = await Promise.all([
  readFile(new URL("../src/pages/TimeEntriesPage.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
]);

test("manual payroll entry action opens the explicit create mode", () => {
  const manualButton = source.indexOf("Zeit manuell erstellen");
  const reviewButton = source.indexOf("Monteurwoche als geprüft markieren", manualButton);

  assert.ok(manualButton > 0);
  assert.ok(reviewButton > manualButton);
  assert.match(source, /\{canManageTimeEntries && \(/);
  assert.match(source, /disabled=\{selectedReviewWorker\.isReviewed \|\| markingReviewWeekPersonId/);
  assert.match(source, /onClick=\{openManualTimeEntryDialog\}/);
  assert.match(source, /setTimeReviewDialogMode\("create"\)/);
  assert.match(source, /setTimeReviewDiagnosticEntry\(buildMissingTimeReviewEntry\(selectedReviewWorker, workDate\)\)/);
  assert.match(source, /options=\{payrollManualDateOptions\}/);
  assert.match(source, /buildPayrollManualEntryPayload\(/);
  assert.match(source, /await api\.createTimeEntry\(result\.payload\)/);
  assert.match(source, /refreshSelectedReviewPayrollWeekSummary\(\)/);
  assert.match(source, /closeTimeReviewDiagnostic\(\)/);
});

test("manual action row stays aligned and stacks safely on narrow screens", () => {
  assert.match(styles, /\.time-review-worker-detail-primary-actions\s*\{[\s\S]*?display:\s*flex;[\s\S]*?gap:\s*6px;[\s\S]*?\}/);
  assert.match(styles, /@media \(max-width: 760px\)[\s\S]*?\.time-review-worker-detail-primary-actions\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\);/);
});
