import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { buildMobileAssignmentHistoryWeeks } from "../src/lib/mobileAssignmentHistory.ts";

const [pageSource, apiSource, styles] = await Promise.all([
  readFile(new URL("../src/pages/MyAssignmentsPage.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/lib/api.ts", import.meta.url), "utf8"),
  readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
]);

function assignment(id, start, end = start) {
  return { id, start_date: start, end_date: end };
}

test("assignment history groups contiguous days into newest ISO weeks first", () => {
  const weeks = buildMobileAssignmentHistoryWeeks([
    assignment(1, "2026-07-17"),
    assignment(2, "2026-08-11", "2026-08-13"),
    assignment(3, "2026-08-17", "2026-08-18"),
  ]);

  assert.deepEqual(weeks.map(({ isoYear, isoWeek, periods }) => ({ isoYear, isoWeek, periods })), [
    { isoYear: 2026, isoWeek: 34, periods: [{ start: "2026-08-17", end: "2026-08-18" }] },
    { isoYear: 2026, isoWeek: 33, periods: [{ start: "2026-08-11", end: "2026-08-13" }] },
    { isoYear: 2026, isoWeek: 29, periods: [{ start: "2026-07-17", end: "2026-07-17" }] },
  ]);
});

test("assignment history keeps gaps within the same week separate", () => {
  const [week] = buildMobileAssignmentHistoryWeeks([
    assignment(1, "2026-08-17"),
    assignment(2, "2026-08-19", "2026-08-20"),
  ]);

  assert.equal(week.isoWeek, 34);
  assert.deepEqual(week.periods, [
    { start: "2026-08-17", end: "2026-08-17" },
    { start: "2026-08-19", end: "2026-08-20" },
  ]);
});

test("assignment history deduplicates overlaps and uses ISO week years", () => {
  const weeks = buildMobileAssignmentHistoryWeeks([
    assignment(1, "2024-12-30", "2025-01-02"),
    assignment(2, "2025-01-01"),
  ]);

  assert.equal(weeks[0].isoYear, 2025);
  assert.equal(weeks[0].isoWeek, 1);
  assert.deepEqual(weeks[0].periods, [{ start: "2024-12-30", end: "2025-01-02" }]);
});

test("Meine Einsätze uses aggregated sites and a lazy read-only history", () => {
  assert.match(apiSource, /myAssignmentSites\(\): Promise<MobileAssignmentSitesResponse>/);
  assert.match(apiSource, /myAssignmentSiteHistory\(siteId: number\)/);
  assert.match(pageSource, /response\.sites/);
  assert.match(pageSource, /key=\{summary\.site\.id\}/);
  assert.match(pageSource, /summary\.last_assignment_date/);
  assert.match(pageSource, /Alle Einsätze chronologisch/);
  assert.match(pageSource, /buildMobileAssignmentHistoryWeeks/);
  assert.doesNotMatch(pageSource, /MobileViewMode|selectAssignmentMode|myAssignmentHistory/);
  assert.doesNotMatch(pageSource, />14 Tage<|>Jahr<|Einsatzliste|Stand:/);
});

test("new assignment cards use responsive grid columns without horizontal scrolling", () => {
  assert.match(styles, /\.mobile-assignment-site-card \{[^}]*grid-template-columns:\s*48px minmax\(0, 1fr\) auto/s);
  assert.match(styles, /\.mobile-assignment-site-copy strong,[\s\S]*overflow-wrap:\s*anywhere/s);
  assert.doesNotMatch(styles, /\.mobile-assignment-(?:site|week|history)[^{]*\{[^}]*overflow-x:\s*(?:auto|scroll)/s);
  assert.match(styles, /:has\(\.mobile-assignment-history-page\) > \.mobile-appshell-actions \{[^}]*display:\s*none/s);
});
