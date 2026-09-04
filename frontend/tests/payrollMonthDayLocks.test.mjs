import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  formatPayrollMonthWorkDateContext,
  payrollMonthSelectionsForDateRange,
} from "../src/lib/payrollMonth.ts";

const page = readFileSync(new URL("../src/pages/TimeEntriesPage.tsx", import.meta.url), "utf8");

test("a cross-month payroll week loads no more than its two affected month statuses", () => {
  assert.deepEqual(
    payrollMonthSelectionsForDateRange("2026-08-31", "2026-09-06"),
    [{ year: 2026, month: 8 }, { year: 2026, month: 9 }],
  );
  assert.deepEqual(
    payrollMonthSelectionsForDateRange("2026-09-07", "2026-09-13"),
    [{ year: 2026, month: 9 }],
  );
  assert.match(page, /Promise\.all\(monthSelections\.map\(\(selection\) => api\.payrollMonthPeriod\(selection\)\)\)/);
});

test("locked days are labelled and every day-level mutation is protected", () => {
  assert.match(page, /isLockedPayrollDay[\s\S]*?Monat abgeschlossen/s);
  assert.match(page, /editable=\{canManageTimeEntries && !selectedReviewWorker\.isReviewed && !isReadOnlyPayrollDay\}/);
  assert.match(page, /disabled=\{!canManageTimeEntries \|\| isReadOnlyPayrollDay \|\| payrollDateActionEntryId/);
  assert.match(page, /onClick: isReadOnlyPayrollDay \? undefined : \(\) => openLocationReviewDiagnostic/);
  assert.match(page, /onClick: isReadOnlyPayrollDay \? undefined : \(\) => openTimeReviewDiagnostic/);
  assert.match(page, /disabled: !canManageTimeEntries \|\| isReadOnlyPayrollDay \|\| payrollReviewActionEntryId/);
  assert.match(page, /disabled=\{isReviewWeekWorkDateReadOnly\(option\.date\)\}/);
  assert.match(page, /allowedWorkDates: \(isEvaluationWorkerReview \? activeReviewDayOptions : writableReviewWeekDayOptions\)/);
});

test("the mixed week keeps its week-level approval independent from locked days", () => {
  assert.match(
    page,
    /className=\{`time-review-week-review-button[\s\S]*?disabled=\{!canManageTimeEntries \|\| markingReviewWeekPersonId === selectedReviewWorker\.personId\}/s,
  );
});

test("selected worker blockers show German date and ISO week context", () => {
  assert.equal(formatPayrollMonthWorkDateContext("2026-08-31"), "31.08.2026 · KW 36/2026");
  assert.equal(formatPayrollMonthWorkDateContext(null), "Gesamter Monat");
  assert.match(page, /const selectedPayrollPersonBlockers = isSelectedPayrollPersonApproved[\s\S]*?\? \[][\s\S]*?: selectedPayrollPersonApproval\?\.blockers \?\? \[\]/);
  assert.match(page, /blockers=\{selectedPayrollPersonBlockers\}/);
  assert.match(page, /formatPayrollBlockerDateContext\(blocker\)/);
  assert.match(page, /selectedWorker\?\.personName \?\? "Monteur auswählen"/);
});
