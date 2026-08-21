import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { buildMobileAssignmentHistoryWeeks } from "../src/lib/mobileAssignmentHistory.ts";

const [pageSource, personalFileSource, assignmentDetailSource, backButtonSource, apiSource, styles] = await Promise.all([
  readFile(new URL("../src/pages/MyAssignmentsPage.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/pages/MobilePersonalFilePage.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/pages/MobileAssignmentDetailPage.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/components/MobileBackButton.tsx", import.meta.url), "utf8"),
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

test("Meine Einsätze reuses the personal-file back button throughout the entry flow", () => {
  assert.match(backButtonSource, /className="mobile-back-icon-button"/);
  assert.match(backButtonSource, /<ArrowLeft aria-hidden="true" size=\{25\} \/>/);
  assert.match(personalFileSource, /<MobileBackButton label="Zurück" onClick=\{onBack\} \/>/);
  assert.match(pageSource, /<MobileBackButton label="Zurück zu Meine Übersicht"/);
  assert.match(pageSource, /<MobileBackButton label="Zurück zu Meine Einsätze" onClick=\{onBack\} \/>/);
  assert.match(assignmentDetailSource, /<MobileBackButton label="Zurück zu Meine Einsätze"/);
  assert.match(
    styles,
    /\.mobile-back-icon-button \{[^}]*width:\s*44px;[^}]*height:\s*44px;[^}]*border:\s*0;[^}]*background:\s*transparent;/s,
  );
  assert.match(
    styles,
    /\.mobile-assignment-history-header \{[^}]*align-items:\s*start;[^}]*gap:\s*12px;[^}]*padding:\s*2px 2px 4px;/s,
  );
  assert.doesNotMatch(styles, /\.mobile-assignment-history-header > button/);
});

test("site history opens the matching mobile project file above unchanged week cards", () => {
  assert.match(pageSource, /const projectFileAssignment = history\?\.assignments\[0\] \?\? null/);
  assert.match(
    pageSource,
    /className="mobile-assignment-project-file-action"[\s\S]*onOpenProjectFile\(projectFileAssignment\)[\s\S]*Baustellenakte öffnen/,
  );
  assert.match(
    pageSource,
    /navigate\(`\/me\/assignments\/\$\{assignment\.id\}`,[\s\S]*state:\s*\{ assignment \}/,
  );
  assert.match(assignmentDetailSource, /const stateAssignment = \(location\.state as LocationState \| null\)\?\.assignment/);
  assert.match(
    styles,
    /\.mobile-assignment-project-file-action \{[^}]*grid-template-columns:\s*auto minmax\(0, 1fr\) auto;[^}]*min-height:\s*76px;[^}]*border-radius:\s*10px;/s,
  );
  assert.match(pageSource, /mobile-assignment-project-file-action[\s\S]*mobile-assignment-week-list/);
});
