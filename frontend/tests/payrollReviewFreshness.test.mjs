import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  arePayrollReviewSourcesReady,
  isoReviewYearsForWorkDates,
  isPayrollPersonBlockersChangedError,
  isPayrollReviewRangeAffected,
  isSamePayrollReviewDataContext,
  payrollMonthSelectionsForWorkDates,
  payrollMonthSelectionsForReviewImpact,
  replaceWeeklyReviewYear,
  upsertWeeklyReview,
  weeklyReviewsForSelection,
} from "../src/lib/payrollReviewFreshness.ts";

const source = await readFile(new URL("../src/pages/TimeEntriesPage.tsx", import.meta.url), "utf8");
const apiSource = await readFile(new URL("../src/lib/api.ts", import.meta.url), "utf8");
const typeSource = await readFile(new URL("../src/types/payrollMonth.ts", import.meta.url), "utf8");

const readySource = (key = "2026-09-07:2026-09-13") => ({
  expectedKey: key,
  loadedKey: key,
  isLoading: false,
  error: null,
});

const review = (personId, year, week, status = "reviewed") => ({
  id: personId * 100 + week,
  person_id: personId,
  iso_year: year,
  iso_week: week,
  status,
  reviewed_by_user_id: 1,
  reviewed_at: "2026-09-07T12:00:00Z",
  created_at: "2026-09-07T12:00:00Z",
  updated_at: "2026-09-07T12:00:00Z",
});

test("weekly readiness requires every source to match the selected period and succeed", () => {
  const sources = Array.from({ length: 6 }, () => readySource());
  assert.equal(arePayrollReviewSourcesReady(sources), true);
  assert.equal(arePayrollReviewSourcesReady(sources.map((item, index) => index === 2 ? { ...item, loadedKey: "old" } : item)), false);
  assert.equal(arePayrollReviewSourcesReady(sources.map((item, index) => index === 3 ? { ...item, isLoading: true } : item)), false);
  assert.equal(arePayrollReviewSourcesReady(sources.map((item, index) => index === 4 ? { ...item, error: "failed" } : item)), false);
  assert.match(source, /const isReviewWeekDataReady = activeTimeSubtab === "review" && arePayrollReviewSourcesReady\(\[/);
  assert.match(source, /const readyReviewAllEntries = isReviewWeekDataReady \? reviewAllEntries : EMPTY_REVIEW_ENTRIES/);
  assert.match(source, /const readyReviewAbsences = isReviewWeekDataReady \? reviewAbsences : EMPTY_REVIEW_ABSENCES/);
  assert.match(source, /disabled=\{!isReviewWeekDataReady \|\| !canManageTimeEntries \|\| markingReviewWeekPersonId/);
  assert.match(source, /const needsWeeklyReviewYear = canManageTimeEntries && payrollReviewWorkerIds\.length > 0/);
  assert.match(source, /const reviewWeeklyReviewsRangeKey = !needsWeeklyReviewYear \|\| selectedReviewYearStatus\?\.state === "ready"/);
  assert.match(source, /isReviewWeekDataReady && filteredTimeReviewWorkers\.map/);
  assert.match(source, /!isReviewWeekDataReady \? \([\s\S]*?reviewDataErrorMessage \|\| "Stundenprüfung wird geladen\.\.\."/);
  assert.match(source, /<small>\{isReviewWeekDataReady \? reviewWorkerFilterCounts\[filter\] : "–"\}<\/small>/);
});

test("late mutation responses are scoped to the person, view and period that started them", () => {
  const started = { mode: "week", rangeKey: "2026-09-07:2026-09-13", personId: 4 };
  assert.equal(isSamePayrollReviewDataContext(started, { ...started }), true);
  assert.equal(isSamePayrollReviewDataContext(started, { ...started, personId: 5 }), false);
  assert.equal(isSamePayrollReviewDataContext(started, { ...started, rangeKey: "2026-08-31:2026-09-06" }), false);
  assert.equal(isSamePayrollReviewDataContext(started, { ...started, mode: "month" }), false);
  assert.equal(isPayrollReviewRangeAffected(started, { ...started, personId: 5 }, ["2026-09-08"]), true);
  assert.equal(isPayrollReviewRangeAffected(started, {
    mode: "month",
    rangeKey: "2026-09-01:2026-09-30",
    personId: 5,
  }, ["2026-08-31", "2026-09-01"]), true);
  assert.equal(isPayrollReviewRangeAffected(started, {
    mode: "week",
    rangeKey: "2026-09-14:2026-09-20",
    personId: 5,
  }, ["2026-09-08"]), false);
  assert.match(source, /function applyUpdatedTimeEntry\(updatedEntry: TimeEntry, context: PayrollReviewDataContext\)[\s\S]*?if \(!isCurrentReviewMutationContext\(context\)\) \{\s*return;/);
  assert.match(source, /setReviewAllEntriesRangeKey\(null\);\s*setReviewAbsencesRangeKey\(null\);\s*setReviewDataReloadKey/);
  assert.match(source, /isPayrollReviewRangeAffected\(context, activeReviewContextRef\.current, workDates\)/);
});

test("month refresh covers both sides of a move and only installs the still-selected month", () => {
  assert.deepEqual(payrollMonthSelectionsForWorkDates([
    "2026-08-31",
    "2026-09-01",
    "2026-08-31",
    "invalid",
  ]), [
    { year: 2026, month: 8 },
    { year: 2026, month: 9 },
  ]);
  assert.deepEqual(payrollMonthSelectionsForReviewImpact(["2026-08-31"]), [
    { year: 2026, month: 8 },
    { year: 2026, month: 9 },
  ]);
  assert.deepEqual(payrollMonthSelectionsForReviewImpact(["2027-01-01"]), [
    { year: 2026, month: 12 },
    { year: 2027, month: 1 },
  ]);
  assert.match(source, /refreshAfterPayrollMutation\(mutationContext, \[entry\.work_date, updatedEntry\.work_date\]\)/);
  assert.match(source, /payrollMonthRequestIdsRef\.current\.get\(selectionKey\) === requestId[\s\S]*?payrollMonthKey\(selectedEvaluationMonthRef\.current\) === selectionKey/);
  assert.match(source, /if \(!isVisibleAtStart\) \{\s*return null;\s*\}[\s\S]*?const period = await api\.payrollMonthPeriod\(selection\)/);
});

test("absence failure stays unready and exposes an explicit retry", () => {
  const absenceLoad = source.slice(source.indexOf("api.absences("), source.indexOf("api.timeEntryPayrollWeek("));
  assert.match(absenceLoad, /setReviewAbsencesRangeKey\(null\)/);
  assert.match(absenceLoad, /setReviewAbsencesError\(readApiError\(requestError, "Abwesenheiten konnten nicht geladen werden\."\)\)/);
  assert.doesNotMatch(absenceLoad, /catch[\s\S]*setReviewAbsencesRangeKey\(reviewDataRangeKey/);
  assert.match(source, /role=\{reviewDataErrorMessage \? "alert" : "status"\}[\s\S]*?onClick=\{retryReviewData\}[\s\S]*?Erneut versuchen/);
  assert.match(source, /error \? \([\s\S]*?onClick=\{onRetry\}>Erneut versuchen/);
});

test("people failures remain unready and both visible retry paths reload people race-safely", () => {
  assert.match(source, /const peopleRequestIdRef = useRef\(0\)/);
  assert.match(source, /const requestId = peopleRequestIdRef\.current \+ 1;[\s\S]*?peopleRequestIdRef\.current === requestId/);
  assert.match(source, /function retryReviewData\(\): void \{\s*if \(error\) \{\s*void loadPeople\(\)/);
  assert.match(source, /function retryEvaluationData\(\): void \{\s*if \(error\) \{\s*void loadPeople\(\)/);
  assert.match(source, /const isEvaluationDataReady =[\s\S]*?&& !isLoadingPeople[\s\S]*?&& error === null/);
  assert.match(source, /const evaluationDataError = error \?\? reviewAllEntriesError/);
});

test("review years are session-cached, bounded, patched and superseded safely", () => {
  const yearReviews = [review(1, 2026, 36), review(2, 2026, 37), review(3, 2027, 1)];
  assert.deepEqual(weeklyReviewsForSelection(yearReviews, { year: 2026, week: 37 }).map((item) => item.person_id), [2]);
  assert.deepEqual(replaceWeeklyReviewYear(yearReviews, 2026, [review(9, 2026, 40)]).map((item) => item.person_id), [3, 9]);
  assert.equal(upsertWeeklyReview(yearReviews, review(2, 2026, 37, "reset")).find((item) => item.person_id === 2)?.status, "reset");
  assert.deepEqual(isoReviewYearsForWorkDates(["2027-01-01", "2027-01-04"]), [2026, 2027]);
  assert.match(source, /WEEKLY_REVIEW_CACHE_TTL_MS = 60_000/);
  assert.match(source, /weeklyReviewYearLoadsRef\.current\.get\(isoYear\)\?\.controller\.abort\(\)/);
  assert.match(source, /void loadWeeklyReviewYear\(selectedReviewWeek\.year\);\s*\}, \[[\s\S]*?selectedReviewWeek\.week,[\s\S]*?selectedReviewWeek\.year/);
  assert.match(source, /function patchWeeklyReviewSessionCache[\s\S]*?weeklyReviewYearLoadsRef\.current\.get\(review\.iso_year\)\?\.controller\.abort\(\)/);
  assert.match(source, /patchWeeklyReviewSessionCache\(weeklyReview\)/);
  assert.doesNotMatch(source, /timeEntryWeeklyReviews\(\{\s*isoYear: selectedReviewWeek\.year,\s*isoWeek:/);
});

test("manual month creation avoids a weekly summary request and invalidates current month data", () => {
  const start = source.indexOf("async function createPayrollManualTimeEntry");
  const end = source.indexOf("function updatePayrollTimeBasis", start);
  const handler = source.slice(start, end);
  assert.match(handler, /refreshAfterPayrollMutation\(mutationContext, \[createdEntry\.work_date\]\)/);
  assert.doesNotMatch(handler, /timeEntryPayrollWeek|refreshSelectedReviewPayrollWeekSummary/);
});

test("blocker fingerprint is sent and a stale 409 reloads before reconfirmation", () => {
  assert.equal(isPayrollPersonBlockersChangedError({
    status: 409,
    detail: { code: "payroll_person_month_blockers_changed" },
  }), true);
  assert.equal(isPayrollPersonBlockersChangedError({ status: 409, detail: { code: "other" } }), false);
  assert.match(typeSource, /blocker_fingerprint: string/);
  assert.match(apiSource, /acknowledged_blocker_fingerprint: params\.acknowledgedBlockerFingerprint/);
  assert.match(source, /acknowledgedBlockerFingerprint: selectedPayrollPersonApproval\.blocker_fingerprint/);
  assert.match(source, /isPayrollPersonBlockersChangedError\(requestError\)[\s\S]*?refreshAffectedPayrollMonths[\s\S]*?setPayrollPersonMonthDialog\("approve"\)/);
  assert.match(source, /const refreshedApproval = refreshedPeriods[\s\S]*?if \(refreshedApproval\)[\s\S]*?setPayrollPersonMonthDialog\(null\)/);
  assert.match(source, /const isStillSelectedMonth = payrollMonthKey\(selectedEvaluationMonthRef\.current\) === selectionKey;[\s\S]*?if \(isStillSelectedMonth\) \{\s*setPayrollMonthPeriod\(updatedPeriod\)/);
});

test("monthly workers include retained server approvals even when people are archived", () => {
  assert.match(source, /readyPayrollMonthPeriod\?\.person_approvals \?\? \[\]/);
  assert.match(source, /payrollPeople\.forEach\(\(person\) =>/);
  assert.match(source, /existing\.personName = person\.person_name/);
  assert.match(source, /const evaluationWorkers = useMemo\([\s\S]*?buildTimeReviewWorkerSummaries\(\s*\[\],/);
  assert.match(source, /if \(!isEvaluationDataReady \|\| !isPayrollMonthPeriodReady\) \{\s*return;/);
  assert.match(source, /personId: isEvaluationWorkerReview \? selectedEvaluationPersonId : selectedReviewPersonId/);
});
