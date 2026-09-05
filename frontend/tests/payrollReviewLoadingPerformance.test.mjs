import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [pageSource, apiSource] = await Promise.all([
  readFile(new URL("../src/pages/TimeEntriesPage.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/lib/api.ts", import.meta.url), "utf8"),
]);

test("Stundenprüfung lädt offene und vollständige Wochenliste gemeinsam", () => {
  assert.match(pageSource, /api\.timeEntryReviewWeek\(/);
  assert.match(pageSource, /setReviewEntries\(reviewWeek\.open_entries\)/);
  assert.match(pageSource, /setReviewAllEntries\(reviewWeek\.entries\)/);
  assert.doesNotMatch(pageSource, /reviewOpenOnly:\s*true/);
  assert.match(apiSource, /timeEntryReviewWeek[\s\S]*?\/time-entries\/review-week\?/);
});

test("Auswertung lädt keine ungenutzte offene Stundenprüfungs-Queue", () => {
  const reviewLoadStart = pageSource.indexOf("api.timeEntryReviewWeek(");
  const reviewLoadEffect = pageSource.slice(Math.max(0, reviewLoadStart - 650), reviewLoadStart + 180);
  assert.match(reviewLoadEffect, /activeTimeSubtab !== "review"/);
});

test("Baustellen-Auswertung lädt weder Monatsdetails mit GPS noch Abwesenheiten", () => {
  assert.match(pageSource, /if \(activeTimeSubtab !== "evaluation" \|\| activeEvaluationSubtab !== "workers"\) \{\s*return;/);
  assert.match(pageSource, /const needsDetailedEntries = activeTimeSubtab === "review"[\s\S]*?activeEvaluationSubtab === "workers"/s);
  assert.match(pageSource, /activeEvaluationSubtab !== "sites"[\s\S]*?api\.payrollSiteCockpit\(/s);
  assert.match(apiSource, /payrollSiteCockpit[\s\S]*?\/time-entries\/payroll-site-cockpit\?/s);
});

test("weekly lock requests skip full month status while evaluation retains full validation", () => {
  const effectStart = pageSource.indexOf("const monthSelections = payrollMonthSelectionsForDateRange");
  const effectEnd = pageSource.indexOf("}, [activeTimeSubtab, reviewWeekRange.end", effectStart);
  const effect = pageSource.slice(effectStart, effectEnd);
  assert.match(effect, /api\.payrollMonthLockStatus\(selection\)/);
  assert.doesNotMatch(effect, /api\.payrollMonthPeriod\(/);
  assert.match(effect, /setReviewWeekPayrollMonthStatuses\(\{\}\)/);
  assert.match(effect, /\.then\(\(periods\) => \{\s*perfOk = true;\s*if \(!ignore\)/);
  assert.match(effect, /\.catch\(\(\) => \{\s*if \(!ignore\)/);
  assert.match(effect, /return \(\) => \{\s*ignore = true/);
  assert.match(apiSource, /payrollMonthLockStatus[\s\S]*?\/lock-status`.*cache: "no-store"/);
  assert.match(pageSource, /api\.payrollMonthPeriod\(selectedEvaluationMonth\)/);
});

test("week performance completion includes the entire month-lock batch", () => {
  assert.match(pageSource, /expectedApiCalls: \[[\s\S]*?TIME_REVIEW_API_MONTH_LOCKS[\s\S]*?\],/);
  const effect = pageSource.slice(
    pageSource.indexOf("const monthSelections = payrollMonthSelectionsForDateRange"),
    pageSource.indexOf("}, [activeTimeSubtab, reviewWeekRange.end"),
  );
  assert.match(effect, /Promise\.all\(/);
  assert.match(effect, /\.finally\(\(\) => \{\s*if \(!ignore\) \{\s*setIsLoadingReviewWeekPayrollMonthStatuses\(false\);\s*recordTimeReviewPerfApiCall\(timeReviewPerfRef, timeReviewRenderCountRef, TIME_REVIEW_API_MONTH_LOCKS/);
  assert.match(effect, /ok: perfOk/);
});
