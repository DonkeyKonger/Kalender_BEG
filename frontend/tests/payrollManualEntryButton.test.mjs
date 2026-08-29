import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [source, styles] = await Promise.all([
  readFile(new URL("../src/pages/TimeEntriesPage.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
]);

test("manual payroll entry action opens the explicit create mode", () => {
  const manualButton = source.indexOf("Zeit erfassen");
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

test("manual action stays in the compact header action row on narrow screens", () => {
  assert.match(styles, /\.time-review-worker-detail-head \.time-review-worker-detail-action-stack\s*\{[^}]*display:\s*flex;[^}]*align-items:\s*center;[^}]*gap:\s*6px;/s);
  assert.match(styles, /@container time-review-detail \(max-width: 600px\)[\s\S]*?\.time-review-worker-detail-action-stack\s*\{[^}]*flex-wrap:\s*wrap;[^}]*justify-content:\s*flex-start;/s);
});
