import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

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

test("review week navigation presents compact week cards without date ranges", () => {
  assert.match(pageSource, /className="time-week-nav-panel time-review-week-nav"/);
  assert.match(pageSource, /className="time-review-week-nav-row"[\s\S]*className="time-week-strip-shell"[\s\S]*className="icon-button secondary time-review-download-all-button"/);
  assert.match(pageSource, /<strong>\{option\.label\}<\/strong>/);
  assert.doesNotMatch(pageSource, /<small>\{formatDayMonth\(option\.start\)\}–\{formatDayMonth\(option\.end\)\}<\/small>/);
  assert.match(styles, /\.time-review-week-nav \.time-week-strip\s*\{[^}]*width:\s*324px;/s);
  assert.match(styles, /\.time-review-week-nav \.time-week-strip button\s*\{[^}]*flex:\s*0 0 60px;[^}]*min-width:\s*60px;[^}]*height:\s*26px;[^}]*min-height:\s*26px;[^}]*box-sizing:\s*border-box;[^}]*padding:\s*4px 5px;/s);
  assert.match(styles, /\.time-review-week-nav \.time-week-scroll-button\s*\{[^}]*height:\s*26px;[^}]*min-height:\s*26px;[^}]*box-sizing:\s*border-box;/s);
  assert.match(styles, /\.time-review-week-nav \.time-week-strip-shell\s*\{[^}]*align-items:\s*center;/s);
  assert.match(styles, /\.time-review-week-nav-row\s*\{[^}]*display:\s*flex;[^}]*justify-content:\s*space-between;/s);
  assert.match(styles, /\.time-review-download-all-button\s*\{[^}]*min-height:\s*36px;[^}]*padding:\s*5px 9px;[^}]*font-size:\s*0\.76rem;/s);
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
  assert.match(pageSource, /function realignReviewWeekStripAfterPageShow\(\): void \{\s*animationFrameId = window\.requestAnimationFrame\(\(\) => \{\s*scrollWeekStripToSelection\(reviewWeekStripRef\.current, reviewWeekOptions, selectedReviewWeek\);/s);
  assert.match(pageSource, /window\.removeEventListener\("pageshow", realignReviewWeekStripAfterPageShow\)/);
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
  assert.match(pageSource, /className="time-review-work-time-cell" role="cell"[\s\S]*?renderTimeReviewCheckMark\(check\.timeCheck/);
  assert.match(pageSource, /className=\{`time-review-work-time-cell\$\{hasVacationCredit \? " time-review-week-time" : ""\}`\} role="cell"/);
  assert.match(styles, /\.time-review-work-time-cell\s*\{[^}]*grid-column:\s*10;[^}]*justify-self:\s*stretch;[^}]*text-align:\s*center;/s);
  assert.match(styles, /\.time-review-week-check-row > \.time-review-work-time-cell\s*\{[^}]*display:\s*grid;[^}]*place-items:\s*center;/s);
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
  assert.match(styles, /\.time-review-workspace-layout\s*\{[^}]*grid-template-columns:\s*minmax\(300px, 336px\) minmax\(0, 1fr\);[^}]*gap:\s*20px;/s);
  assert.match(styles, /@media \(max-width: 980px\)[\s\S]*?\.time-review-workspace-layout\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\);/s);
  assert.match(styles, /@media \(max-width: 760px\)[\s\S]*?\.time-review-download-all-button\s*\{[^}]*width:\s*100%;/s);
});
