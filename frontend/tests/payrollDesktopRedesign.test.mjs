import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  centeredWeekWindowStart,
  clampWeekWindowStart,
  PAYROLL_WEEK_VISIBLE_COUNT,
} from "../src/lib/weekStrip.ts";

const pageSource = readFileSync(new URL("../src/pages/TimeEntriesPage.tsx", import.meta.url), "utf8");
const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

test("payroll review uses the requested master-detail queue without removing existing actions", () => {
  assert.match(pageSource, /className="time-review-workspace-layout"/);
  assert.match(pageSource, /<aside className="time-review-queue-panel" aria-label="Prüfwarteschlange">/);
  assert.match(pageSource, /placeholder="Monteur suchen\.\.\."/);
  assert.match(pageSource, /\["all", "Alle"\][\s\S]*?\["open", "Offen"\][\s\S]*?\["missing", "Keine Meldung"\][\s\S]*?\["reviewed", "Geprüft"\]/);
  assert.match(pageSource, />Monteur<\/span>\s*<span>Std\. erfasst<\/span>\s*<span>Status<\/span>/);
  assert.match(pageSource, /Zeit manuell erstellen/);
  assert.match(pageSource, /Monteurwoche als geprüft markieren/);
  assert.match(pageSource, /Monteurwoche herunterladen \(Excel\)/);
  assert.match(pageSource, /Alle Arbeitsstunden herunterladen \(Excel\)/);
});

test("review week navigation fills the shared queue width with four complete cards", () => {
  assert.match(pageSource, /className="time-week-nav-panel time-review-week-nav"/);
  assert.match(pageSource, /className="time-review-week-nav-row"[\s\S]*className="time-week-strip-shell"[\s\S]*className="icon-button secondary time-review-download-all-button"/);
  assert.match(pageSource, /<strong>\{option\.label\}<\/strong>/);
  assert.doesNotMatch(pageSource, /<small>\{formatDayMonth\(option\.start\)\}–\{formatDayMonth\(option\.end\)\}<\/small>/);
  assert.equal(PAYROLL_WEEK_VISIBLE_COUNT, 4);
  assert.match(styles, /\.time-review-main\s*\{[^}]*--time-review-queue-track:\s*minmax\(300px, 336px\);[^}]*--time-review-layout-gap:\s*20px;[^}]*--time-review-layout-inline:\s*24px;/s);
  assert.match(styles, /\.time-review-week-nav-row\s*\{[^}]*grid-template-columns:\s*var\(--time-review-queue-track\) minmax\(0, 1fr\);[^}]*gap:\s*var\(--time-review-layout-gap\);/s);
  assert.match(styles, /\.time-review-workspace-layout\s*\{[^}]*grid-template-columns:\s*var\(--time-review-queue-track\) minmax\(0, 1fr\);[^}]*gap:\s*var\(--time-review-layout-gap\);[^}]*margin:\s*16px var\(--time-review-layout-inline\) 24px;/s);
  assert.match(styles, /\.time-review-week-nav\s*\{[^}]*margin:\s*16px var\(--time-review-layout-inline\) 0;/s);
  assert.match(styles, /\.time-review-week-nav \.time-week-strip-shell\s*\{[^}]*grid-template-columns:\s*26px minmax\(0, 1fr\) 26px;[^}]*width:\s*100%;/s);
  assert.match(styles, /\.time-review-week-nav \.time-week-strip\s*\{[^}]*width:\s*100%;[^}]*min-width:\s*0;[^}]*gap:\s*6px;/s);
  assert.match(styles, /\.time-review-week-nav \.time-week-strip button\s*\{[^}]*flex:\s*0 0 calc\(25% - 4\.5px\);[^}]*min-width:\s*calc\(25% - 4\.5px\);[^}]*height:\s*26px;[^}]*min-height:\s*26px;[^}]*box-sizing:\s*border-box;/s);
  assert.match(styles, /\.time-review-week-nav \.time-week-scroll-button\s*\{[^}]*height:\s*26px;[^}]*min-height:\s*26px;[^}]*box-sizing:\s*border-box;/s);
  assert.match(styles, /\.time-review-download-all-button\s*\{[^}]*justify-self:\s*end;[^}]*min-height:\s*36px;[^}]*padding:\s*5px 9px;[^}]*font-size:\s*0\.76rem;/s);
});

test("current review week remains identifiable when another week is selected", () => {
  assert.match(pageSource, /option\.isCurrent \? "is-current" : ""/);
  assert.match(pageSource, /aria-current=\{option\.isCurrent \? "date" : undefined\}/);
  assert.match(pageSource, /aria-pressed=\{option\.year === selectedReviewWeek\.year && option\.week === selectedReviewWeek\.week\}/);
  assert.doesNotMatch(pageSource, /time-review-week-current-marker|>jetzt<\/span>/i);
  assert.match(styles, /button\.is-current\s*\{[^}]*border-color:\s*#79a98a;[^}]*background:\s*#f0f8f3;[^}]*color:\s*#245b38;/s);
  assert.match(styles, /button\.is-current::after\s*\{[^}]*content:\s*"";[^}]*width:\s*5px;[^}]*height:\s*5px;[^}]*border-radius:\s*50%;[^}]*background:\s*#2f855a;/s);
  assert.match(styles, /button\.is-active\s*\{[^}]*border:\s*2px solid #1763c5;[^}]*background:\s*#f4f8ff;/s);
  assert.match(styles, /button\.is-active\.is-current\s*\{[^}]*border:\s*2px solid #1763c5;[^}]*background:\s*#edf7f1;/s);
});

test("review week navigation realigns its selected week after browser scroll restoration", () => {
  assert.match(pageSource, /window\.addEventListener\("pageshow", realignReviewWeekStripAfterPageShow\)/);
  assert.match(pageSource, /function realignReviewWeekStripAfterPageShow\(\): void \{[\s\S]*?renderFrameId = window\.requestAnimationFrame\(\(\) => \{[\s\S]*?layoutFrameId = window\.requestAnimationFrame\(\(\) => \{[\s\S]*?alignment: "center", visibleCount: PAYROLL_WEEK_VISIBLE_COUNT/s);
  assert.match(pageSource, /window\.removeEventListener\("pageshow", realignReviewWeekStripAfterPageShow\)/);
});

test("reload centers the selected current week in a stable four-week window", () => {
  const weekNumbers = [30, 31, 32, 33, 34, 35, 36, 37, 38, 39];
  const selectedIndex = weekNumbers.indexOf(35);
  const start = centeredWeekWindowStart(selectedIndex, weekNumbers.length);
  const visibleWeeks = weekNumbers.slice(start, start + PAYROLL_WEEK_VISIBLE_COUNT);

  assert.deepEqual(visibleWeeks, [34, 35, 36, 37]);
  assert.ok(visibleWeeks.includes(35));
  assert.notDeepEqual(visibleWeeks, [30, 31, 32, 33]);
  assert.doesNotMatch(pageSource, /selectedWeekIndex\s*-\s*5/);
  assert.match(pageSource, /alignment: isInitialAlignment \? "center" : "nearest"/);
  assert.match(pageSource, /behavior:\s*"auto"/);
});

test("four-week window clamps at list and year boundaries", () => {
  const crossingYear = ["2026-51", "2026-52", "2027-01", "2027-02", "2027-03"];
  const start = centeredWeekWindowStart(2, crossingYear.length);

  assert.deepEqual(crossingYear.slice(start, start + PAYROLL_WEEK_VISIBLE_COUNT), [
    "2026-52",
    "2027-01",
    "2027-02",
    "2027-03",
  ]);
  assert.equal(centeredWeekWindowStart(0, crossingYear.length), 0);
  assert.equal(centeredWeekWindowStart(crossingYear.length - 1, crossingYear.length), 1);
  assert.equal(clampWeekWindowStart(99, crossingYear.length), 1);
});

test("manual week navigation advances one full tile and is not reset by renders", () => {
  const reviewScrollStart = pageSource.indexOf("function scrollReviewWeeks");
  const evaluationScrollStart = pageSource.indexOf("function scrollEvaluationWeeks", reviewScrollStart);
  const reviewScrollSource = pageSource.slice(reviewScrollStart, evaluationScrollStart);

  assert.match(pageSource, /lastAlignedReviewWeekKeyRef\.current === selectionKey/);
  assert.match(pageSource, /const weekStep = buttons\[1\][\s\S]*?buttons\[1\]\.offsetLeft - firstButton\.offsetLeft/);
  assert.match(pageSource, /scrollBy\(\{ left: direction \* weekStep, behavior: "smooth" \}\)/);
  assert.doesNotMatch(reviewScrollSource, /container\.clientWidth \* 0\.75/);
});

test("worker detail keeps captured hours beside the name without a redundant status badge", () => {
  const identityStart = pageSource.indexOf('<div className="time-review-worker-identity">');
  const identityEnd = pageSource.indexOf("</div>", identityStart);
  const identitySource = pageSource.slice(identityStart, identityEnd);

  assert.ok(identityStart >= 0);
  assert.ok(identityEnd > identityStart);
  assert.match(identitySource, /className="time-review-worker-identity">\s*<h3>\{selectedReviewWorker\.personName\}<\/h3>\s*<span\s*className="time-review-worker-hours"/);
  assert.doesNotMatch(identitySource, /selectedReviewWeek\.week|formatRangeLabel|time-review-worker-period|KW \{/);
  assert.match(pageSource, /aria-label=\{`Erfasste Stunden: \$\{formatSubmittedHours\(selectedReviewWorker\.submittedMinutes\)\} Stunden`\}/);
  assert.doesNotMatch(pageSource, /time-review-worker-detail-status|time-review-worker-metrics|aria-label="Wochenkennzahlen"/);
  assert.doesNotMatch(pageSource, /Geplante Stunden|Die Differenz wird künftig aus den geplanten Stunden berechnet/);
  assert.doesNotMatch(styles, /\.time-review-worker-period/);
  assert.match(styles, /\.time-review-worker-identity\s*\{[^}]*display:\s*flex;[^}]*align-items:\s*center;[^}]*gap:\s*8px;[^}]*overflow:\s*hidden;/s);
  assert.match(styles, /\.time-review-worker-hours\s*\{[^}]*border-left:\s*1px solid #dfe5ed;[^}]*padding-left:\s*8px;[^}]*white-space:\s*nowrap;/s);
  assert.match(styles, /\.time-review-check-mark:not\(\.is-ok\):not\(\.is-warning\)\s*\{[^}]*border-color:\s*transparent;[^}]*background:\s*transparent;/s);
});

test("the fixed worker header is one compact action row directly above the table", () => {
  assert.match(pageSource, /className="time-review-worker-detail-head"[\s\S]*?className="time-review-worker-identity"[\s\S]*?className="time-review-worker-detail-actions"[\s\S]*?className="time-review-worker-detail-action-stack"[\s\S]*?className="time-review-worker-detail-primary-actions"[\s\S]*?time-review-manual-create-button[\s\S]*?time-review-week-review-button[\s\S]*?time-review-week-xlsx-button/s);
  assert.match(pageSource, /time-review-week-xlsx-button[\s\S]*?aria-label=\{isDownloadingReviewWeekXlsx \? "Monteurwoche wird als Excel erstellt" : "Monteurwoche herunterladen \(Excel\)"\}[\s\S]*?title="Monteurwoche herunterladen \(Excel\)"/s);
  assert.match(pageSource, /<\/div>\s*\{payrollDateError && <p className="time-review-week-error">[\s\S]*?<div className="time-review-week-check-table"/s);
  assert.match(styles, /\.time-entries-page\.is-figma-times-workspace \.time-review-worker-detail-head\s*\{[^}]*flex:\s*0 0 auto;[^}]*grid-template-columns:\s*minmax\(220px, 1fr\) auto;[^}]*align-items:\s*center;[^}]*padding:\s*6px 14px;/s);
  assert.match(styles, /\.time-review-worker-detail-head \.time-review-worker-detail-action-stack\s*\{[^}]*display:\s*flex;[^}]*align-items:\s*center;/s);
  assert.match(styles, /@container time-review-detail \(max-width: 600px\)[\s\S]*?\.time-entries-page\.is-figma-times-workspace \.time-review-worker-detail-head\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\);[\s\S]*?\.time-review-worker-detail-action-stack\s*\{[^}]*flex-wrap:\s*wrap;/s);
});

test("weekly review uses a round accessible state action and preserves reset", () => {
  assert.match(pageSource, /className=\{`time-review-week-review-button\$\{selectedReviewWorker\.isReviewed \? " is-reviewed" : ""\}`\}/);
  assert.match(pageSource, /aria-pressed=\{selectedReviewWorker\.isReviewed\}/);
  assert.match(pageSource, /aria-haspopup=\{selectedReviewWorker\.isReviewed \? "menu" : undefined\}/);
  assert.match(pageSource, /Monteurwoche geprüft, Status ändern/);
  assert.match(pageSource, /Monteurwoche als geprüft markieren/);
  assert.match(pageSource, /title=\{selectedReviewWorker\.isReviewed[\s\S]*?Monteurwoche geprüft – klicken, um den Status zu ändern/);
  assert.match(pageSource, /void markSelectedReviewWeekReviewed\(\)/);
  assert.match(pageSource, /role="menuitem"[\s\S]*?void resetSelectedReviewWeekReview\(\)/);
  assert.match(styles, /\.time-review-worker-detail-head \.time-review-week-review-button\s*\{[^}]*width:\s*40px;[^}]*height:\s*40px;[^}]*border:\s*2px solid #2f855a;[^}]*border-radius:\s*50%;/s);
  assert.match(styles, /\.time-review-worker-detail-head \.time-review-week-review-button:hover,[\s\S]*?\.time-review-week-review-button:focus-visible\s*\{[^}]*background:\s*#eaf6ee;[^}]*box-shadow:/s);
  assert.match(styles, /\.time-review-worker-detail-head \.time-review-week-review-button\.is-reviewed\s*\{[^}]*background:\s*#237a49;[^}]*color:\s*#ffffff;/s);
  assert.match(pageSource, /className="icon-button secondary time-review-manual-create-button"/);
});

test("weekday separators show only the full weekday and one aligned work-time total", () => {
  assert.match(pageSource, /<section className="time-review-day-group" key=\{day\.date\} role="rowgroup"/);
  assert.match(pageSource, /className="time-review-day-group-head" role="row"/);
  assert.match(pageSource, /function formatWeekdayLong\(value: string\)[\s\S]*?weekday: "long"/);
  assert.match(pageSource, /weekdayLabel: formatWeekdayLong\(date\)/);
  assert.match(pageSource, /className="time-review-day-group-label"[\s\S]*?title=\{`\$\{day\.weekdayLabel\}, \$\{formatDate\(day\.date\)\}`\}[\s\S]*?<strong>\{day\.weekdayLabel\}<\/strong>/);
  assert.doesNotMatch(pageSource, /<span>\{formatDate\(day\.date\)\}<\/span>/);
  assert.doesNotMatch(pageSource, /time-review-day-group-status|Gesamtmontagezeit/);
  assert.match(pageSource, /className="time-review-day-group-total time-review-work-time-cell"[\s\S]*?aria-label=\{`Gesamtarbeitszeit[\s\S]*?\{formatTimeEntryMinutes\(timeReviewDayTotalMinutes\(day\), "hours"\)\}/);
  assert.match(pageSource, /timeReviewDayTotalMinutes\(day\)/);
  assert.match(styles, /\.time-review-day-group-label\s*\{[^}]*grid-column:\s*1 \/ 10;/s);
  assert.match(styles, /\.time-review-day-group\s*\{[^}]*border:\s*0;[^}]*border-radius:\s*0;/s);
  assert.match(styles, /\.time-review-day-group-head\s*\{[^}]*min-height:\s*34px;[^}]*border-top:\s*1px solid #dfe5ed;[^}]*background:\s*#f8fafc;/s);
  assert.match(styles, /\.time-review-day-group \.time-review-week-check-row\.is-travel-time\s*\{[^}]*box-shadow:\s*none;/s);
});

test("daily and row work times share the same centered grid column", () => {
  assert.match(pageSource, /className="time-review-day-group-total time-review-work-time-cell"[\s\S]*?Gesamtarbeitszeit/);
  assert.match(pageSource, /className="time-review-work-time-cell has-entry-work-time" role="cell"[\s\S]*?className="time-review-work-time-value"[\s\S]*?renderPayrollWorkMinutes\(check\.entry\)[\s\S]*?renderTimeReviewCheckMark\(check\.timeCheck/);
  assert.match(pageSource, /className=\{`time-review-work-time-cell\$\{hasVacationCredit \? " time-review-week-time" : ""\}`\} role="cell"/);
  assert.match(styles, /\.time-review-work-time-cell\s*\{[^}]*grid-column:\s*10;[^}]*justify-self:\s*stretch;[^}]*text-align:\s*center;/s);
  assert.match(styles, /\.time-review-week-check-row > \.time-review-work-time-cell\s*\{[^}]*display:\s*grid;[^}]*place-items:\s*center;/s);
  assert.match(styles, /\.time-review-work-time-cell\.has-entry-work-time\s*\{[^}]*position:\s*relative;/s);
  assert.match(styles, /\.time-review-work-time-cell\.has-entry-work-time > \.time-review-check-mark\s*\{[^}]*position:\s*absolute;[^}]*right:\s*-3px;/s);
});

test("each normal entry shows its own AZ value while the day keeps one total", () => {
  const dayRowsStart = pageSource.indexOf("{day.entries.length > 0 ? day.entries.map((check) => (");
  const emptyRowStart = pageSource.indexOf(")) : (() => {", dayRowsStart);
  const entryRowsSource = pageSource.slice(dayRowsStart, emptyRowStart);
  const dayTotalOccurrences = pageSource.match(/className="time-review-day-group-total time-review-work-time-cell"/g) ?? [];

  assert.ok(dayRowsStart >= 0);
  assert.ok(emptyRowStart > dayRowsStart);
  assert.equal(dayTotalOccurrences.length, 1);
  assert.match(entryRowsSource, /renderPayrollMountingMinutes\(check\.entry\)/);
  assert.match(entryRowsSource, /className="time-review-work-time-value"[\s\S]*?aria-label=\{`Arbeitszeit \$\{formatTimeEntryMinutes\(effectivePayrollWorkMinutes\(check\.entry\), "hours"\)\}`\}[\s\S]*?renderPayrollWorkMinutes\(check\.entry\)/s);
  assert.match(entryRowsSource, /renderTimeReviewCheckMark\(check\.timeCheck,[\s\S]*?label: "Arbeitszeit-Diagnose öffnen"/s);
  assert.match(pageSource, /function effectivePayrollMountingMinutes\(entry: TimeEntry\): number \| null \{[\s\S]*?return entry\.work_minutes;[\s\S]*?\}/s);
  assert.match(pageSource, /function effectivePayrollWorkMinutes\(entry: TimeEntry\): number \| null \{[\s\S]*?effectivePayrollMountingMinutes\(entry\)[\s\S]*?roundMinutesToQuarterHour\(mountingMinutes \+ \(entry\.travel_minutes \|\| 0\)\)/s);
});

test("vacation and missing-time rows keep correct AZ values or diagnostics", () => {
  const emptyRowStart = pageSource.indexOf("const missingEntry = buildMissingTimeReviewEntry");
  const emptyRowEnd = pageSource.indexOf("})()}", emptyRowStart);
  const emptyRowSource = pageSource.slice(emptyRowStart, emptyRowEnd);

  assert.ok(emptyRowStart >= 0);
  assert.ok(emptyRowEnd > emptyRowStart);
  assert.match(emptyRowSource, /hasVacationCredit = day\.absenceType === "vacation" && day\.vacationCreditMinutes > 0/);
  assert.match(emptyRowSource, /hasVacationCredit[\s\S]*?formatTimeEntryMinutes\(day\.vacationCreditMinutes, "hours"\)[\s\S]*?renderTimeReviewCheckMark\("unknown"/s);
  assert.match(emptyRowSource, /<div className="time-review-week-time" role="cell">-<\/div>[\s\S]*?<div role="cell">/s);
});

test("payroll review squares its framed surfaces within the active review workspace", () => {
  assert.match(pageSource, /activeTimeSubtab === "review" \? " is-payroll-review-workspace" : ""/);
  assert.match(styles, /\.time-entries-page\.is-figma-times-workspace\.is-payroll-review-workspace \.time-review-queue-panel,[\s\S]*?\.time-entries-page\.is-figma-times-workspace\.is-payroll-review-workspace \.time-review-day-group,[\s\S]*?border-radius:\s*0;/s);
  assert.match(styles, /\.time-entries-page\.is-figma-times-workspace\.is-payroll-review-workspace \.time-review-week-nav \.time-week-strip button,[\s\S]*?\.time-entries-page\.is-figma-times-workspace\.is-payroll-review-workspace \.time-review-week-check-head,[\s\S]*?border-radius:\s*0;/s);
  assert.match(styles, /\.time-review-queue-status\s*\{[^}]*border-radius:\s*999px;/s);
  assert.doesNotMatch(styles, /is-payroll-review-workspace \.time-review-queue-status/);
});

test("payroll review fixes the detail head while only queue and table scroll independently", () => {
  assert.match(styles, /\.time-entries-page\.is-figma-times-workspace\.is-payroll-review-workspace\s*\{[^}]*display:\s*flex;[^}]*flex-direction:\s*column;[^}]*height:\s*calc\(100dvh - 96px\);[^}]*min-height:\s*0;/s);
  assert.match(styles, /is-payroll-review-workspace \.time-review-main\s*\{[^}]*grid-template-rows:\s*auto minmax\(0, 1fr\);[^}]*min-height:\s*0;[^}]*overflow:\s*hidden;/s);
  assert.match(styles, /is-payroll-review-workspace \.time-review-queue-panel\s*\{[^}]*grid-template-rows:\s*auto auto auto auto minmax\(0, 1fr\) auto;[^}]*min-height:\s*0;/s);
  assert.match(styles, /is-payroll-review-workspace > \.page-header,[\s\S]*?is-payroll-review-workspace > \.time-main-subtabs\s*\{[^}]*flex:\s*0 0 auto;/s);
  assert.match(styles, /is-payroll-review-workspace > \.time-main-subtabs\s*\{[^}]*overflow:\s*visible;/s);
  assert.match(styles, /is-payroll-review-workspace \.time-review-workspace-layout\s*\{[^}]*grid-template-rows:\s*minmax\(0, 1fr\);[^}]*height:\s*calc\(100% - 40px\);/s);
  assert.match(styles, /is-payroll-review-workspace \.time-review-detail-shell\s*\{[^}]*overflow:\s*hidden;[^}]*container-name:\s*time-review-detail;[^}]*container-type:\s*inline-size;/s);
  assert.match(styles, /is-payroll-review-workspace \.time-review-worker-detail\s*\{[^}]*flex:\s*1 1 auto;[^}]*min-height:\s*0;[^}]*overflow:\s*hidden;/s);
  assert.match(styles, /\.time-review-worker-detail-head\s*\{[^}]*flex:\s*0 0 auto;/s);
  assert.match(styles, /is-payroll-review-workspace \.time-review-week-check-table\s*\{[^}]*flex:\s*1 1 auto;[^}]*min-height:\s*0;[^}]*overflow:\s*auto;[^}]*overscroll-behavior:\s*contain;/s);
  assert.match(pageSource, /time-review-worker-detail-head[\s\S]*?time-review-week-check-table/);
  assert.match(pageSource, /time-review-week-check-table[\s\S]*?selectedReviewWeekDays\.map\(\(day\)[\s\S]*?time-review-day-group-entries[\s\S]*?time-review-week-check-row/s);
});

test("the scroll table keeps five days and multiple entries at natural row height", () => {
  assert.match(styles, /\.time-entries-page\.is-figma-times-workspace \.time-review-week-check-table\s*\{[^}]*align-content:\s*start;[^}]*grid-auto-rows:\s*max-content;[^}]*gap:\s*0;/s);
  assert.match(styles, /is-payroll-review-workspace \.time-review-week-check-table\s*\{[^}]*min-height:\s*0;[^}]*overflow:\s*auto;/s);
  assert.match(styles, /\.time-review-day-group\s*\{[^}]*align-content:\s*start;[^}]*grid-auto-rows:\s*max-content;[^}]*min-height:\s*max-content;[^}]*overflow:\s*visible;/s);
  assert.doesNotMatch(styles, /\.time-review-day-group\s*\{[^}]*overflow:\s*hidden;/s);
  assert.match(styles, /\.time-review-day-group-entries\s*\{[^}]*align-content:\s*start;[^}]*grid-auto-rows:\s*max-content;/s);
  assert.match(styles, /\.time-review-week-check-row\s*\{[^}]*min-height:\s*46px;/s);
  assert.match(pageSource, /selectedReviewWeekDays\.map\(\(day\) => \([\s\S]*?day\.entries\.length > 0 \? day\.entries\.map\(\(check\) => \(/s);
  assert.match(pageSource, /return numberRange\(0, 6\)[\s\S]*?filter\(\(day, index\) => index < 5 \|\| day\.entries\.length > 0 \|\| day\.absenceType !== null\)/s);
});

test("payroll table abbreviates headers from its container width without hiding accessible names", () => {
  assert.match(pageSource, /role="columnheader" aria-label="Montagebeginn" title="Montagebeginn"><span className="time-review-column-label-full">Montagebeginn<\/span><span className="time-review-column-label-short" aria-hidden="true">MA<\/span>/);
  assert.match(pageSource, /role="columnheader" aria-label="Montageende" title="Montageende"[\s\S]*?time-review-column-label-short" aria-hidden="true">ME/);
  assert.match(pageSource, /role="columnheader" aria-label="Montagezeit" title="Montagezeit"[\s\S]*?time-review-column-label-short" aria-hidden="true">MZ/);
  assert.match(pageSource, /role="columnheader" aria-label="Arbeitszeit" title="Arbeitszeit"[\s\S]*?time-review-column-label-short" aria-hidden="true">AZ/);
  assert.match(styles, /\.time-review-column-label-short\s*\{[^}]*display:\s*none;/s);
  assert.match(styles, /@container time-review-detail \(max-width: 1050px\)\s*\{[\s\S]*?\.time-review-column-label-full\s*\{[^}]*display:\s*none;[\s\S]*?\.time-review-column-label-short\s*\{[^}]*display:\s*inline;/s);
});

test("payroll queue filters stay on one compact row until the viewport is truly narrow", () => {
  assert.match(styles, /\.time-review-queue-filters\s*\{[^}]*flex-wrap:\s*nowrap;[^}]*gap:\s*3px;/s);
  assert.match(styles, /\.time-review-queue-filters button\s*\{[^}]*flex:\s*1 1 0;[^}]*justify-content:\s*center;[^}]*font-size:\s*0\.62rem;[^}]*white-space:\s*nowrap;/s);
  assert.match(styles, /@media \(max-width: 420px\)[\s\S]*?\.time-review-queue-filters\s*\{[^}]*flex-wrap:\s*wrap;/s);
});

test("desktop layout keeps the queue compact and stacks safely below desktop width", () => {
  assert.match(styles, /\.time-review-workspace-layout\s*\{[^}]*grid-template-columns:\s*var\(--time-review-queue-track\) minmax\(0, 1fr\);[^}]*gap:\s*var\(--time-review-layout-gap\);/s);
  assert.match(styles, /@media \(max-width: 1280px\)[\s\S]*?--time-review-queue-track:\s*minmax\(280px, 310px\);[\s\S]*?--time-review-layout-inline:\s*18px;/s);
  assert.match(styles, /@media \(max-width: 980px\)[\s\S]*?\.time-review-workspace-layout\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\);/s);
  assert.match(styles, /@media \(max-width: 760px\)[\s\S]*?\.time-review-download-all-button\s*\{[^}]*width:\s*100%;/s);
});
