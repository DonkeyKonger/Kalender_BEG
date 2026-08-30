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
  assert.match(pageSource, /Monat im Jahr " \+ selectedEvaluationMonth\.year \+ " auswählen/);
  assert.doesNotMatch(pageSource, /selectedEvaluationWeek|evaluationWeekRange/);
  assert.match(pageSource, /selectedReviewWeek/);
  assert.match(pageSource, /time-review-week-nav/);
});

test("Monatsnavigation bleibt einzeilig, scrollbar und hebt die Auswahl hervor", () => {
  assert.match(pageSource, /time-evaluation-month-strip-shell[\s\S]*?Monate nach links scrollen[\s\S]*?time-evaluation-month-strip[\s\S]*?data-month=\{option\.month\}[\s\S]*?Monate nach rechts scrollen/s);
  assert.match(pageSource, /scrollEvaluationMonths\(-1\)[\s\S]*?scrollEvaluationMonths\(1\)/s);
  assert.match(pageSource, /scrollIntoView\(\{ block: "nearest", inline: "center", behavior: "auto" \}\)/);
  assert.match(styles, /\.time-evaluation-month-strip\s*\{[^}]*display:\s*flex;[^}]*overflow-x:\s*auto;[^}]*scrollbar-width:\s*none;/s);
  assert.match(styles, /\.time-evaluation-month-strip button\s*\{[^}]*flex:\s*0 0 calc\(16\.666% - 5px\);/s);
  assert.match(styles, /@media \(max-width: 760px\)\s*\{[\s\S]*?\.time-evaluation-month-strip button\s*\{[^}]*flex-basis:\s*calc\(33\.333% - 4px\);/s);
  assert.match(styles, /\.time-evaluation-month-strip button\.is-active\s*\{[^}]*background:\s*var\(--time-week-active-blue\);/s);
  assert.doesNotMatch(styles, /\.time-evaluation-month-grid/);
});

test("Monteur-Untertab verwendet die gemeinsame Prüfwarteschlange mit Monatsdaten", () => {
  assert.match(pageSource, /const \[activeEvaluationSubtab, setActiveEvaluationSubtab\] = useState<EvaluationSubtab>\("workers"\)/);
  assert.match(pageSource, /\["workers", "Monteure"\],[\s\S]*?\["sites", "Baustellen"\]/);
  assert.match(pageSource, /activeEvaluationSubtab === "workers" \? \([\s\S]*?<MonthlyPayrollWorkerWorkspace/s);
  assert.match(pageSource, /\) : \(\s*<div className="time-final-hours-panel">/);
  assert.match(pageSource, /buildTimeReviewMonthDays\([\s\S]*?evaluationMonthRange\.start,[\s\S]*?evaluationMonthRange\.end/s);
  assert.match(pageSource, /function buildTimeReviewMonthDays\(/);
  assert.match(pageSource, /className="time-review-queue-list" role="listbox" aria-label="Monteure für die Monatsauswertung"/);
  assert.match(pageSource, /className="time-review-week-check-table" role="table" aria-label=\{"Monatsprüfung " \+ selectedWorker\.personName\}/);
  assert.match(pageSource, /onOpenEntryActions=\{togglePayrollDatePicker\}/);
  assert.match(pageSource, /aria-label="Aktionen für Zeiteintrag öffnen"[\s\S]*?onOpenEntryActions\(check\.entry, event\.currentTarget\)/s);
  assert.match(pageSource, /activeReviewDayOptions\.map\(\(option\) => \([\s\S]*?movePayrollEntryDate\(activePayrollDatePickerEntry, option\.date\)/s);
  assert.match(pageSource, /activeTimeSubtab === "review" \|\| \(activeTimeSubtab === "evaluation" && activeEvaluationSubtab === "workers"\)/);
});
