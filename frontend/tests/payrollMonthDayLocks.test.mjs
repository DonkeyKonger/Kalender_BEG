import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  formatPayrollMonthWorkDateContext,
  payrollMonthSelectionsForDateRange,
  payrollWorkDateLock,
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
  assert.match(page, /Promise\.all\(monthSelections\.map\(\(selection\) => api\.payrollMonthLockStatus\(selection\)\)\)/);
});

test("locked days are labelled and every day-level mutation is protected", () => {
  assert.match(page, /lock === "month" \? "Monat abgeschlossen" : lock === "person" \? "Monteurmonat abgeschlossen"/);
  assert.match(page, /const isLockedPayrollDay = payrollDayLockLabel !== null/);
  assert.match(page, /\{payrollDayLockLabel\}/);
  assert.match(page, /editable=\{canManageTimeEntries && !selectedReviewWorker\.isReviewed && !isReadOnlyPayrollDay\}/);
  assert.match(page, /disabled=\{!canManageTimeEntries \|\| isReadOnlyPayrollDay \|\| payrollDateActionEntryId/);
  assert.match(page, /onClick: isReadOnlyPayrollDay \? undefined : \(\) => openLocationReviewDiagnostic/);
  assert.match(page, /onClick: isReadOnlyPayrollDay \? undefined : \(\) => openTimeReviewDiagnostic/);
  assert.match(page, /disabled: !canManageTimeEntries \|\| isReadOnlyPayrollDay \|\| payrollReviewActionEntryId/);
  assert.match(page, /disabled=\{isReviewWeekWorkDateReadOnly\(option\.date\)\}/);
  assert.match(page, /allowedWorkDates: \(isEvaluationWorkerReview \? activeReviewDayOptions : writableReviewWeekDayOptions\)/);
});

test("global and personal locks are separate and use the affected entry person", () => {
  const statuses = {
    "2026-08": { year: 2026, month: 8, status: "OPEN", approved_person_ids: [3] },
    "2026-09": { year: 2026, month: 9, status: "LOCKED", approved_person_ids: [] },
  };
  assert.equal(payrollWorkDateLock(statuses, "2026-08-31", 3), "person");
  assert.equal(payrollWorkDateLock(statuses, "2026-08-31", 4), null);
  assert.equal(payrollWorkDateLock(statuses, "2026-09-01", 4), "month");
  assert.equal(payrollWorkDateLock(statuses, "2026-09-01", 3), "month");
  assert.match(page, /isReviewWeekWorkDateReadOnly\(entry.work_date, entry.person_id\)/);
  assert.match(page, /isReviewWeekWorkDateReadOnly\(targetWorkDate, entry.person_id\)/);
  assert.match(page, /isReviewWeekWorkDateReadOnly\(timeReviewDiagnosticEntry.work_date, timeReviewDiagnosticEntry.person_id\)/);
  assert.match(page, /isReviewWeekWorkDateReadOnly\(locationReviewDiagnosticEntry.work_date, locationReviewDiagnosticEntry.person_id\)/);
  assert.match(page, /payrollWorkDateLock\(reviewWeekPayrollMonthStatuses, option.date, selectedReviewWorker\?\.personId \?\? null\) === null/);
});

test("missing, stale or malformed lock status never makes a day writable", () => {
  const period = { year: 2026, month: 8, status: "OPEN", approved_person_ids: [] };
  assert.equal(payrollWorkDateLock({}, "2026-08-31", 3), "unknown");
  assert.equal(payrollWorkDateLock({ "2026-08": period }, "2026-09-01", 3), "unknown");
  assert.equal(payrollWorkDateLock({ "2026-08": period }, "2026-08-31", null), "unknown");
  assert.equal(payrollWorkDateLock({ "2026-08": { ...period, month: 9 } }, "2026-08-31", 3), "unknown");
  assert.equal(payrollWorkDateLock({ "2026-08": { ...period, approved_person_ids: undefined } }, "2026-08-31", 3), "unknown");
  assert.equal(payrollWorkDateLock({ "2026-08": { ...period, status: "ERROR" } }, "2026-08-31", 3), "unknown");
  assert.match(page, /reviewWeekPayrollMonthStatusRangeKey === reviewWeekRangeKey\s*&& !isLoadingReviewWeekPayrollMonthStatuses\s*&& reviewWeekPayrollMonthStatusError === null/);
  assert.match(page, /if \(!areReviewWeekPayrollMonthStatusesReady\) \{\s*return true;/);
});

test("year crossing keeps personal locks in their own month and reopening is immediately reflected", () => {
  const selections = payrollMonthSelectionsForDateRange("2026-12-28", "2027-01-03");
  assert.deepEqual(selections, [{ year: 2026, month: 12 }, { year: 2027, month: 1 }]);
  const statuses = {
    "2026-12": { year: 2026, month: 12, status: "OPEN", approved_person_ids: [3] },
    "2027-01": { year: 2027, month: 1, status: "OPEN", approved_person_ids: [] },
  };
  assert.equal(payrollWorkDateLock(statuses, "2026-12-31", 3), "person");
  assert.equal(payrollWorkDateLock(statuses, "2027-01-01", 3), null);
  statuses["2026-12"].approved_person_ids = [];
  assert.equal(payrollWorkDateLock(statuses, "2026-12-31", 3), null);
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
