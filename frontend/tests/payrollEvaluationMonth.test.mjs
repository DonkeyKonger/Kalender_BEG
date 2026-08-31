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
  assert.match(pageSource, /className="time-evaluation-year-navigation" role="group" aria-label="Auswertungsjahr"/);
  assert.match(pageSource, /Monat im Jahr " \+ selectedEvaluationMonth\.year \+ " auswählen/);
  assert.doesNotMatch(pageSource, /selectedEvaluationWeek|evaluationWeekRange/);
  assert.match(pageSource, /selectedReviewWeek/);
  assert.match(pageSource, /time-review-week-nav/);
});

test("Monatsnavigation zeigt fünf Monate und eine schlichte Jahressteuerung rechts", () => {
  assert.match(pageSource, /time-evaluation-month-strip-shell[\s\S]*?Monate nach links scrollen[\s\S]*?time-evaluation-month-strip[\s\S]*?data-month=\{option\.month\}[\s\S]*?Monate nach rechts scrollen/s);
  assert.match(pageSource, /scrollEvaluationMonths\(-1\)[\s\S]*?scrollEvaluationMonths\(1\)/s);
  assert.match(pageSource, /function evaluationMonthVisibleButtonCount[\s\S]*?Math\.floor\(\(container\.clientWidth - firstButton\.offsetWidth\) \/ step\) \+ 1/s);
  assert.match(pageSource, /function scrollEvaluationMonths[\s\S]*?targetIndex[\s\S]*?container\.scrollTo\(\{ left: buttons\[targetIndex\]\?\.offsetLeft/s);
  assert.match(pageSource, /alignEvaluationMonthsToSelection\(container, selectedEvaluationMonth\.month\)/);
  assert.match(styles, /\.time-evaluation-month-strip\s*\{[^}]*display:\s*flex;[^}]*position:\s*relative;[^}]*overflow-x:\s*auto;[^}]*scroll-snap-type:\s*x mandatory;/s);
  assert.match(pageSource, /time-evaluation-period-controls[\s\S]*?time-evaluation-month-strip-shell[\s\S]*?time-evaluation-period-actions[\s\S]*?time-evaluation-year-navigation/s);
  assert.match(pageSource, /className="time-evaluation-year-navigation" role="group" aria-label="Auswertungsjahr"[\s\S]*?Vorheriges Jahr auswählen[\s\S]*?\{selectedEvaluationMonth\.year\}[\s\S]*?Nächstes Jahr auswählen/s);
  assert.doesNotMatch(pageSource, /time-evaluation-year-select|time-evaluation-month-controls/);
  assert.match(styles, /\.time-evaluation-period-controls\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) auto;[^}]*gap:\s*24px;/s);
  assert.match(styles, /\.time-evaluation-month-strip button\s*\{[^}]*flex:\s*0 0 20%;[^}]*min-height:\s*34px;[^}]*font-size:\s*0\.78rem;[^}]*scroll-snap-align:\s*start;[^}]*scroll-snap-stop:\s*always;/s);
  assert.match(styles, /\.time-evaluation-year-navigation\s*\{[^}]*border:\s*1px solid var\(--time-border\);[^}]*background:\s*#ffffff;/s);
  assert.match(styles, /\.time-evaluation-year-navigation \.time-week-scroll-button\s*\{[^}]*width:\s*34px;[^}]*height:\s*34px;[^}]*border:\s*0;[^}]*background:\s*#ffffff;/s);
  assert.match(styles, /@media \(max-width: 760px\)\s*\{[\s\S]*?\.time-evaluation-month-strip button\s*\{[^}]*flex-basis:\s*calc\(100% \/ 3\);/s);
  assert.match(styles, /@media \(max-width: 760px\)\s*\{[\s\S]*?\.time-evaluation-period-controls\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\);[^}]*gap:\s*8px;[\s\S]*?\.time-evaluation-period-actions\s*\{[^}]*justify-self:\s*end;/s);
  assert.match(styles, /@media \(max-width: 420px\)\s*\{[\s\S]*?\.time-evaluation-month-strip button\s*\{[^}]*min-width:\s*0;[^}]*font-size:\s*0\.78rem;/s);
  assert.match(styles, /\.time-evaluation-month-strip button\.is-active\s*\{[^}]*border-color:\s*#1459e7;[^}]*background:\s*#1459e7;/s);
  assert.doesNotMatch(styles, /\.time-evaluation-month-grid/);
});

test("Monatsabrechnungen für alle und den ausgewählten Monteur sind als Platzhalter vorbereitet", () => {
  assert.match(pageSource, /className="time-evaluation-period-actions"[\s\S]*?className="time-evaluation-year-navigation"[\s\S]*?className="time-evaluation-monthly-download-button"[\s\S]*?disabled[\s\S]*?Monatsabrechnung \(alle\)/s);
  assert.match(pageSource, /aria-describedby="time-evaluation-monthly-download-status"[\s\S]*?Noch keine Excel-Vorlage für die Monatsabrechnung hinterlegt/);
  assert.match(pageSource, /id="time-evaluation-monthly-download-status"[\s\S]*?sobald eine Excel-Vorlage hinterlegt ist/);
  const monthlyStart = pageSource.indexOf("function MonthlyPayrollWorkerWorkspace");
  const monthlySource = pageSource.slice(monthlyStart);
  assert.ok(monthlyStart >= 0);
  assert.match(monthlySource, /className="time-review-worker-detail-actions"[\s\S]*?className="time-evaluation-monthly-download-button"[\s\S]*?disabled[\s\S]*?Monatsabrechnung/s);
  assert.match(styles, /\.time-evaluation-period-actions\s*\{[^}]*display:\s*inline-flex;[^}]*justify-self:\s*end;[^}]*gap:\s*8px;/s);
  assert.match(styles, /\.time-evaluation-monthly-download-button\s*\{[^}]*min-height:\s*36px;[^}]*border-radius:\s*0;[^}]*font-size:\s*0\.78rem;[^}]*white-space:\s*nowrap;/s);
  assert.match(styles, /\.time-evaluation-monthly-download-button:disabled\s*\{[^}]*background:\s*#eef2f7;[^}]*cursor:\s*not-allowed;[^}]*opacity:\s*1;/s);
  assert.match(styles, /@media \(max-width: 420px\)\s*\{[\s\S]*?\.time-evaluation-period-actions\s*\{[^}]*grid-template-columns:\s*auto minmax\(0, 1fr\);[^}]*width:\s*100%;[\s\S]*?\.time-evaluation-monthly-download-button\s*\{[^}]*min-width:\s*0;[^}]*white-space:\s*normal;/s);
});

test("Monteur-Untertab verwendet die gemeinsame Prüfwarteschlange mit Monatsdaten", () => {
  assert.match(pageSource, /const \[activeEvaluationSubtab, setActiveEvaluationSubtab\] = useState<EvaluationSubtab>\("workers"\)/);
  assert.match(pageSource, /\["workers", "Monteure"\],[\s\S]*?\["sites", "Baustellen"\]/);
  assert.match(pageSource, /activeEvaluationSubtab === "workers" \? \([\s\S]*?<MonthlyPayrollWorkerWorkspace/s);
  assert.match(pageSource, /\) : \(\s*<PayrollSiteCockpit/);
  assert.match(pageSource, /buildTimeReviewMonthDays\([\s\S]*?evaluationMonthRange\.start,[\s\S]*?evaluationMonthRange\.end/s);
  assert.match(pageSource, /function buildTimeReviewMonthDays\(/);
  assert.match(pageSource, /className="time-review-queue-list" role="listbox" aria-label="Monteure für die Monatsauswertung"/);
  assert.match(pageSource, /className="time-review-week-check-table" role="table" aria-label=\{"Monatsprüfung " \+ selectedWorker\.personName\}/);
  assert.match(pageSource, /onOpenEntryActions=\{togglePayrollDatePicker\}/);
  assert.match(pageSource, /aria-label="Aktionen für Zeiteintrag öffnen"[\s\S]*?onOpenEntryActions\(check\.entry, event\.currentTarget\)/s);
  assert.match(pageSource, /activeReviewDayOptions\.map\(\(option\) => \([\s\S]*?movePayrollEntryDate\(activePayrollDatePickerEntry, option\.date\)/s);
  assert.match(pageSource, /activeTimeSubtab === "review" \|\| \(activeTimeSubtab === "evaluation" && activeEvaluationSubtab === "workers"\)/);
});

test("Baustellen-Untertab verwendet das eigenständige aggregierte Forecast-Cockpit", () => {
  const sitesStart = pageSource.indexOf(') : (\n            <PayrollSiteCockpit');
  const sitesEnd = pageSource.indexOf('\n          )}\n        </div>', sitesStart);
  const sitesWorkspace = pageSource.slice(sitesStart, sitesEnd);

  assert.ok(sitesStart >= 0);
  assert.ok(sitesEnd > sitesStart);
  assert.match(sitesWorkspace, /<PayrollSiteCockpit[\s\S]*?data=\{isPayrollSiteCockpitReady[\s\S]*?selectedSiteId=\{selectedEvaluationSiteId\}/);
  assert.doesNotMatch(sitesWorkspace, /finalHoursTotals|Summe je Baustelle|includeGpsStatus/);
  assert.match(pageSource, /activeEvaluationSubtab === "workers" \? \([\s\S]*?<MonthlyPayrollWorkerWorkspace/s);
});

test("Auswertungs-Untertabs teilen die kompakte Headerzeile mit der Hauptnavigation", () => {
  const navigationStart = pageSource.indexOf('className="time-payroll-navigation-row"');
  const evaluationMainStart = pageSource.indexOf('className="time-entries-main time-review-main time-evaluation-main"');

  assert.ok(navigationStart >= 0);
  assert.ok(evaluationMainStart > navigationStart);
  assert.match(pageSource.slice(navigationStart, evaluationMainStart), /time-main-subtabs[\s\S]*?activeTimeSubtab === "evaluation"[\s\S]*?time-evaluation-subtabs/s);
  assert.match(styles, /\.time-payroll-navigation-row\s*\{[^}]*display:\s*flex;[^}]*align-items:\s*center;[^}]*justify-content:\s*space-between;[^}]*border-bottom:\s*1px solid #d1d9e6;/s);
  assert.match(styles, /\.time-payroll-navigation-row\s*\{[^}]*min-height:\s*48px;[^}]*gap:\s*24px;[^}]*padding:\s*0 24px;/s);
  assert.match(styles, /\.time-entries-page\.is-figma-times-workspace \.page-header h1\s*\{[^}]*font-size:\s*1\.18rem;/s);
  assert.match(styles, /\.time-entries-page\.is-figma-times-workspace \.page-subtitle\s*\{[^}]*font-size:\s*0\.86rem;/s);
  assert.match(styles, /\.time-entries-page\.is-figma-times-workspace \.time-evaluation-month-nav\s*\{[^}]*padding:\s*8px 24px;/s);
  assert.match(styles, /is-payroll-review-workspace \.time-evaluation-main\s*\{[^}]*grid-template-rows:\s*auto minmax\(0, 1fr\);/s);
  assert.match(styles, /\.time-evaluation-subtabs\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*repeat\(2, minmax\(96px, 1fr\)\);[^}]*margin:\s*0 0 0 auto;[^}]*border:\s*0;[^}]*border-radius:\s*0;/s);
  assert.match(styles, /\.time-evaluation-subtabs button:focus-visible\s*\{[^}]*box-shadow:/s);
  assert.match(styles, /\.time-evaluation-subtabs button\s*\{[^}]*min-height:\s*34px;[^}]*border:\s*1px solid var\(--time-border\);[^}]*border-radius:\s*0;[^}]*background:\s*#ffffff;[^}]*color:\s*#243b5a;[^}]*font-size:\s*0\.78rem;/s);
  assert.match(styles, /\.time-evaluation-subtabs button\.is-active\s*\{[^}]*background:\s*var\(--time-week-active-blue\);[^}]*color:\s*#ffffff;[^}]*box-shadow:\s*none;/s);
  assert.match(styles, /@media \(max-width: 580px\)\s*\{[\s\S]*?\.time-payroll-navigation-row\s*\{[^}]*flex-wrap:\s*wrap;[\s\S]*?\.time-evaluation-subtabs\s*\{[^}]*width:\s*100%;/s);
});

test("Monats- und Wochenprüfung teilen responsive Tabellenüberschriften", () => {
  assert.match(pageSource, /function PayrollReviewTableHeaders\(\)[\s\S]*?TG[\s\S]*?TYP[\s\S]*?BS[\s\S]*?MA[\s\S]*?ME[\s\S]*?PA[\s\S]*?MZ[\s\S]*?AZ[\s\S]*?GP/s);
  assert.match(pageSource, /aria-label=\{`Lohnprüfung \$\{selectedReviewWorker\.personName\} KW \$\{selectedReviewWeek\.week\}`\}[\s\S]*?<PayrollReviewTableHeaders \/>/s);
  assert.match(pageSource, /aria-label=\{"Monatsprüfung " \+ selectedWorker\.personName\}[\s\S]*?<PayrollReviewTableHeaders \/>/s);
  assert.match(styles, /@container time-review-detail \(max-width: 1050px\)[\s\S]*?\.time-review-column-label-full\s*\{[^}]*display:\s*none;[\s\S]*?\.time-review-column-label-short\s*\{[^}]*display:\s*inline;/s);
});

test("Monatstage starten eingeklappt und behalten einen zugänglichen Einzel-Toggle", () => {
  assert.match(pageSource, /const \[expandedEvaluationDayKeys, setExpandedEvaluationDayKeys\] = useState<Set<string>>\(\(\) => new Set\(\)\)/);
  assert.match(pageSource, /setExpandedEvaluationDayKeys\(new Set\(\)\);[\s\S]*?selectedEvaluationMonth\.month, selectedEvaluationMonth\.year, selectedEvaluationPersonId/s);
  assert.match(pageSource, /className="time-evaluation-day-toggle" type="button" aria-expanded=\{isExpanded\} aria-controls=\{dayPanelId\} onClick=\{\(\) => onToggleDay\(day\.date\)\}/);
  assert.match(pageSource, /\{isExpanded && <div className="time-review-day-group-entries" id=\{dayPanelId\}>/);
  assert.match(pageSource, /day\.entries\.length > 0 \? day\.entries\.map[\s\S]*?<strong>Keine Zeitmeldung<\/strong>/s);
  assert.match(pageSource, /function buildTimeReviewMonthDays[\s\S]*?isPayrollWeekday\(day\.date\)/s);
  assert.match(styles, /\.time-evaluation-day-toggle\[aria-expanded="true"\] \.time-evaluation-day-toggle-icon\s*\{[^}]*transform:\s*rotate\(90deg\);/s);
});

test("Monatsansicht gruppiert Tage nach ISO-Kalenderwoche und zeigt die Wochensumme", () => {
  const monthlyStart = pageSource.indexOf("function MonthlyPayrollWorkerWorkspace");
  const monthlySource = pageSource.slice(monthlyStart);

  assert.ok(monthlyStart >= 0);
  assert.match(monthlySource, /const weekGroups = groupTimeReviewMonthDays\(days\);/);
  assert.match(monthlySource, /weekGroups\.map\(\(weekGroup\) => \([\s\S]*?className="time-evaluation-week-group-head"[\s\S]*?KW \{weekGroup\.week\} · \{formatMonthlyWeekHours\(weekGroup\.totalMinutes\)\} Std\.[\s\S]*?weekGroup\.days\.map/s);
  assert.match(pageSource, /function groupTimeReviewMonthDays\([\s\S]*?isoWeekFromDate\(parseDateInput\(day\.date\)\)[\s\S]*?timeReviewDayTotalMinutes\(day\)/s);
  assert.match(pageSource, /function formatMonthlyWeekHours\([\s\S]*?minimumFractionDigits: 0,[\s\S]*?maximumFractionDigits: 2,/s);
  assert.match(styles, /\.time-evaluation-week-group-head\s*\{[^}]*min-height:\s*25px;[^}]*border-top:\s*1px solid #dfe5ed;[^}]*font-size:\s*0\.68rem;/s);
});

test("Monatstage halten Wochentag, Datum und Status in festen nebeneinanderliegenden Spalten", () => {
  const monthlyStart = pageSource.indexOf('function MonthlyPayrollWorkerWorkspace');
  const monthlySource = pageSource.slice(monthlyStart);

  assert.ok(monthlyStart >= 0);
  assert.match(monthlySource, /className="time-review-day-group-label time-evaluation-day-group-label" role="rowheader"[\s\S]*?className="time-evaluation-day-toggle"[\s\S]*?className="time-review-day-group-weekday"[\s\S]*?\{formatDate\(day\.date\)\}[\s\S]*?className="time-evaluation-day-status"[\s\S]*?<PayrollOvernightStatusControl/s);
  assert.match(styles, /\.time-evaluation-day-group-label\s*\{[^}]*--time-review-weekday-label-inline-size:\s*80px;[^}]*--time-evaluation-day-date-inline-size:\s*76px;[^}]*display:\s*flex;[^}]*gap:\s*8px;/s);
  assert.match(styles, /\.time-evaluation-day-toggle\s*\{[^}]*display:\s*grid;[^}]*flex:\s*0 0 calc\([^}]*grid-template-columns:\s*var\(--time-evaluation-day-toggle-icon-size\) var\(--time-review-weekday-label-inline-size\) var\(--time-evaluation-day-date-inline-size\);/s);
  assert.match(styles, /\.time-evaluation-day-toggle-label\s*\{[^}]*display:\s*contents;/s);
  assert.match(styles, /\.time-evaluation-day-toggle-label > \.time-review-day-group-weekday\s*\{[^}]*grid-column:\s*2;/s);
  assert.match(styles, /\.time-evaluation-day-toggle-label > span\s*\{[^}]*grid-column:\s*3;/s);
  assert.match(styles, /\.time-evaluation-day-status\s*\{[^}]*flex:\s*0 0 var\(--time-review-overnight-status-width\);[^}]*width:\s*var\(--time-review-overnight-status-width\);/s);
});

test("Monatsauswertung entfernt nur ihren Monteur-Kopfblock", () => {
  const monthlyStart = pageSource.indexOf('className="time-review-workspace-layout time-evaluation-worker-workspace"');
  const monthlyEnd = pageSource.indexOf('function currentIsoWeek', monthlyStart);
  const monthlyWorkspace = pageSource.slice(monthlyStart, monthlyEnd);

  assert.ok(monthlyStart >= 0);
  assert.doesNotMatch(monthlyWorkspace, /time-review-queue-head/);
  assert.match(monthlyWorkspace, /time-review-queue-search[\s\S]*?time-review-queue-filters[\s\S]*?time-review-queue-list/s);
  assert.match(styles, /\.time-evaluation-worker-workspace \.time-review-queue-panel\s*\{[^}]*grid-template-rows:\s*auto auto minmax\(0, 1fr\);/s);
});

test("Zeitspannen erhalten nur bei vollständigen Zeiten einen dekorativen Pfeil", () => {
  assert.match(pageSource, /function hasPayrollTimeRange\(entry: TimeEntry\): boolean \{[\s\S]*?effectivePayrollStartTime\(entry\) && effectivePayrollEndTime\(entry\)/);
  assert.match(pageSource, /hasPayrollTimeRange\(check\.entry\) && <ArrowRight className="time-review-time-range-arrow" aria-hidden="true"/);
  assert.match(styles, /\.time-review-time-range-arrow\s*\{[^}]*position:\s*absolute;[^}]*color:\s*#94a3b8;[^}]*pointer-events:\s*none;/s);
});

test("Monatsworkspace rendert nur Daten des aktuell geladenen Bereichs", () => {
  assert.match(pageSource, /const evaluationRangeKey = reviewDataRangeKey\(evaluationMonthRange\)/);
  assert.match(pageSource, /const isEvaluationDataReady = activeTimeSubtab === "evaluation"[\s\S]*?reviewAllEntriesRangeKey === evaluationRangeKey[\s\S]*?reviewAbsencesRangeKey === evaluationRangeKey/s);
  assert.match(pageSource, /const evaluationEntries = isEvaluationDataReady \? reviewAllEntries : EMPTY_REVIEW_ENTRIES;/);
  assert.match(pageSource, /const evaluationAbsences = isEvaluationDataReady \? reviewAbsences : EMPTY_REVIEW_ABSENCES;/);
  assert.match(pageSource, /setReviewAllEntriesRangeKey\(reviewDataRangeKey\(reviewDataRange\)\)/);
  assert.match(pageSource, /setReviewAbsencesRangeKey\(reviewDataRangeKey\(reviewDataRange\)\)/);
  assert.match(pageSource, /if \(!isEvaluationDataReady\) \{\s*return;\s*\}[\s\S]*?setSelectedEvaluationPersonId\(null\)/);
  assert.match(pageSource, /if \(!isReady\) \{[\s\S]*?aria-busy="true"[\s\S]*?Monatsauswertung wird geladen/);
});
