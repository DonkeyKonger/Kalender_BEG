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
