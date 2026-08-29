import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildCalendarMonthOptions,
  calendarMonthRange,
  formatCalendarMonth,
} from "../src/lib/calendarMonth.ts";
import { calculatePayrollEvaluationTotals } from "../src/lib/payrollEvaluation.ts";

const pageSource = readFileSync(new URL("../src/pages/TimeEntriesPage.tsx", import.meta.url), "utf8");
const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

test("Monatsbereiche schließen Monatsgrenzen, Jahreswechsel und Schaltjahre korrekt ein", () => {
  assert.deepEqual(calendarMonthRange({ year: 2026, month: 1 }), { start: "2026-01-01", end: "2026-01-31" });
  assert.deepEqual(calendarMonthRange({ year: 2026, month: 12 }), { start: "2026-12-01", end: "2026-12-31" });
  assert.deepEqual(calendarMonthRange({ year: 2028, month: 2 }), { start: "2028-02-01", end: "2028-02-29" });
  assert.deepEqual(calendarMonthRange({ year: 2027, month: 2 }), { start: "2027-02-01", end: "2027-02-28" });
});

test("Monatsauswahl hält Jahr und aktiven Monat getrennt und verständlich", () => {
  const options = buildCalendarMonthOptions({ year: 2027, month: 2 }, new Date(2026, 7, 29));

  assert.equal(options.length, 12);
  assert.equal(options[0].label, "Januar");
  assert.equal(options[11].label, "Dezember");
  assert.equal(formatCalendarMonth({ year: 2027, month: 2 }), "Februar 2027");
  assert.equal(options.some((option) => option.isCurrent), false);
});

test("Monatssummen aggregieren vollständige Einträge je Monteur und Baustelle", () => {
  const totals = calculatePayrollEvaluationTotals([
    { personName: "Anna", siteKey: "1001 - Nord", finalMinutes: 480 },
    { personName: "Anna", siteKey: "1002 - Süd", finalMinutes: 120 },
    { personName: "Bernd", siteKey: "1001 - Nord", finalMinutes: 300 },
    { personName: "Bernd", siteKey: "1001 - Nord", finalMinutes: null },
  ]);

  assert.equal(totals.totalMinutes, 900);
  assert.deepEqual(totals.byPerson, [
    { label: "Anna", minutes: 600 },
    { label: "Bernd", minutes: 300 },
  ]);
  assert.deepEqual(totals.bySite, [
    { label: "1001 - Nord", minutes: 780 },
    { label: "1002 - Süd", minutes: 120 },
  ]);
});

test("Auswertung lädt den gewählten Monatsbereich über die vorhandene Datumsbereich-API", () => {
  assert.match(pageSource, /selectedEvaluationMonth/);
  assert.match(pageSource, /calendarMonthRange\(selectedEvaluationMonth\)/);
  assert.match(pageSource, /dateFrom: reviewDataRange\.start,[\s\S]*dateTo: reviewDataRange\.end,/);
  assert.match(pageSource, /aria-label="Auswertungsjahr"/);
  assert.match(pageSource, /Monat im Jahr \$\{selectedEvaluationMonth\.year\} auswählen/);
  assert.doesNotMatch(pageSource, /selectedEvaluationWeek|evaluationWeekRange/);
  assert.match(pageSource, /selectedReviewWeek/);
  assert.match(pageSource, /time-review-week-nav/);
});

test("Monatsauswahl bleibt in der vorhandenen Formsprache responsiv erreichbar", () => {
  assert.match(styles, /\.time-evaluation-month-grid\s*\{[^}]*grid-template-columns:\s*repeat\(6, minmax\(0, 1fr\)\);/s);
  assert.match(styles, /@media \(max-width: 760px\)\s*\{[\s\S]*?\.time-evaluation-month-grid\s*\{[^}]*grid-template-columns:\s*repeat\(3, minmax\(0, 1fr\)\);/s);
  assert.match(styles, /\.time-evaluation-month-grid button\.is-active\s*\{[^}]*background:\s*var\(--time-week-active-blue\);/s);
});
