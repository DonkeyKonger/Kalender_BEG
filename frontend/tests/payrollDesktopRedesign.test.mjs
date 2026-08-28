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
  assert.match(styles, /\.time-review-week-nav \.time-week-strip button\s*\{[^}]*flex:\s*0 0 60px;[^}]*min-width:\s*60px;[^}]*min-height:\s*26px;[^}]*padding:\s*4px 5px;/s);
  assert.match(styles, /\.time-review-week-nav \.time-week-scroll-button\s*\{[^}]*height:\s*26px;/s);
  assert.match(styles, /\.time-review-week-nav-row\s*\{[^}]*display:\s*flex;[^}]*justify-content:\s*space-between;/s);
  assert.match(styles, /\.time-review-download-all-button\s*\{[^}]*min-height:\s*36px;[^}]*padding:\s*5px 9px;[^}]*font-size:\s*0\.76rem;/s);
});

test("current review week remains identifiable when another week is selected", () => {
  assert.match(pageSource, /option\.isCurrent \? "is-current" : ""/);
  assert.match(pageSource, /aria-current=\{option\.isCurrent \? "date" : undefined\}/);
  assert.match(pageSource, /aria-pressed=\{option\.year === selectedReviewWeek\.year && option\.week === selectedReviewWeek\.week\}/);
  assert.match(pageSource, /option\.isCurrent && <span className="time-review-week-current-marker" aria-hidden="true">jetzt<\/span>/);
  assert.match(styles, /button\.is-current\s*\{[^}]*border:\s*2px solid #155db2;[^}]*box-shadow:\s*inset 0 -2px 0 #155db2;/s);
  assert.match(styles, /button\.is-active\.is-current\s*\{[^}]*box-shadow:\s*inset 0 0 0 1px #155db2, inset 0 -2px 0 #f6c849;/s);
});

test("review week navigation realigns its selected week after browser scroll restoration", () => {
  assert.match(pageSource, /window\.addEventListener\("pageshow", realignReviewWeekStripAfterPageShow\)/);
  assert.match(pageSource, /function realignReviewWeekStripAfterPageShow\(\): void \{\s*animationFrameId = window\.requestAnimationFrame\(\(\) => \{\s*scrollWeekStripToSelection\(reviewWeekStripRef\.current, reviewWeekOptions, selectedReviewWeek\);/s);
  assert.match(pageSource, /window\.removeEventListener\("pageshow", realignReviewWeekStripAfterPageShow\)/);
});

test("worker detail keeps quiet metrics and explicit future-data placeholders", () => {
  assert.match(pageSource, />Erfasste Stunden<\/span>/);
  assert.match(pageSource, /className="is-placeholder" title="Geplante Stunden werden künftig ergänzt"/);
  assert.match(pageSource, /className="is-placeholder" title="Die Differenz wird künftig aus den geplanten Stunden berechnet"/);
  assert.match(styles, /\.time-review-worker-metrics \.is-placeholder strong\s*\{[^}]*color:\s*#a0aaba;/s);
  assert.match(styles, /\.time-review-check-mark:not\(\.is-ok\):not\(\.is-warning\)\s*\{[^}]*border-color:\s*transparent;[^}]*background:\s*transparent;/s);
});

test("each weekday is one bordered group with totals in their matching time columns", () => {
  assert.match(pageSource, /<section className="time-review-day-group" key=\{day\.date\} role="rowgroup"/);
  assert.match(pageSource, /className="time-review-day-group-head" role="row"/);
  assert.doesNotMatch(pageSource, /day\.entries\.length === 1 \? "Eintrag" : "Einträge"/);
  assert.match(pageSource, /className="time-review-day-group-total"[\s\S]*?Gesamtmontagezeit/);
  assert.match(pageSource, /day\.vacationCreditMinutes > 0[\s\S]*?Gesamtarbeitszeit/);
  assert.match(pageSource, /timeReviewDayTotalMinutes\(day\)/);
  assert.match(styles, /\.time-review-day-group\s*\{[^}]*border:\s*1px solid #dfe5ed;[^}]*border-radius:\s*10px;/s);
  assert.match(styles, /\.time-review-day-group-total\s*\{[^}]*justify-self:\s*end;/s);
  assert.match(styles, /\.time-review-day-group \.time-review-week-check-row\.is-travel-time\s*\{[^}]*box-shadow:\s*none;/s);
});

test("payroll review squares its framed surfaces within the active review workspace", () => {
  assert.match(pageSource, /activeTimeSubtab === "review" \? " is-payroll-review-workspace" : ""/);
  assert.match(styles, /\.time-entries-page\.is-figma-times-workspace\.is-payroll-review-workspace \.time-review-queue-panel,[\s\S]*?\.time-entries-page\.is-figma-times-workspace\.is-payroll-review-workspace \.time-review-day-group,[\s\S]*?border-radius:\s*0;/s);
  assert.match(styles, /\.time-entries-page\.is-figma-times-workspace\.is-payroll-review-workspace \.time-review-week-nav \.time-week-strip button,[\s\S]*?\.time-entries-page\.is-figma-times-workspace\.is-payroll-review-workspace \.time-review-week-check-head,[\s\S]*?border-radius:\s*0;/s);
  assert.match(styles, /\.time-review-queue-status\s*\{[^}]*border-radius:\s*999px;/s);
  assert.doesNotMatch(styles, /is-payroll-review-workspace \.time-review-queue-status/);
});

test("payroll review fixes navigation while the queue and complete detail block scroll independently", () => {
  assert.match(styles, /\.time-entries-page\.is-figma-times-workspace\.is-payroll-review-workspace\s*\{[^}]*display:\s*flex;[^}]*flex-direction:\s*column;[^}]*height:\s*calc\(100dvh - 96px\);[^}]*min-height:\s*0;/s);
  assert.match(styles, /is-payroll-review-workspace \.time-review-main\s*\{[^}]*grid-template-rows:\s*auto minmax\(0, 1fr\);[^}]*min-height:\s*0;[^}]*overflow:\s*hidden;/s);
  assert.match(styles, /is-payroll-review-workspace \.time-review-queue-panel\s*\{[^}]*grid-template-rows:\s*auto auto auto auto minmax\(0, 1fr\) auto;[^}]*min-height:\s*0;/s);
  assert.match(styles, /is-payroll-review-workspace > \.page-header,[\s\S]*?is-payroll-review-workspace > \.time-main-subtabs\s*\{[^}]*flex:\s*0 0 auto;/s);
  assert.match(styles, /is-payroll-review-workspace > \.time-main-subtabs\s*\{[^}]*overflow:\s*visible;/s);
  assert.match(styles, /is-payroll-review-workspace \.time-review-workspace-layout\s*\{[^}]*grid-template-rows:\s*minmax\(0, 1fr\);[^}]*height:\s*calc\(100% - 40px\);/s);
  assert.match(styles, /is-payroll-review-workspace \.time-review-detail-shell\s*\{[^}]*overflow-y:\s*auto;[^}]*overscroll-behavior:\s*contain;/s);
  assert.match(styles, /is-payroll-review-workspace \.time-review-worker-detail\s*\{[^}]*flex:\s*0 0 auto;/s);
  assert.match(styles, /is-payroll-review-workspace \.time-review-week-check-table\s*\{[^}]*flex:\s*0 0 auto;[^}]*overflow-x:\s*auto;[^}]*overflow-y:\s*visible;/s);
  assert.match(pageSource, /time-review-week-check-table[\s\S]*?selectedReviewWeekDays\.map\(\(day\)[\s\S]*?time-review-day-group-entries[\s\S]*?time-review-week-check-row/s);
});

test("payroll table abbreviates headers below desktop width without hiding their accessible names", () => {
  assert.match(pageSource, /role="columnheader" aria-label="Montagebeginn" title="Montagebeginn"><span className="time-review-column-label-full">Montagebeginn<\/span><span className="time-review-column-label-short" aria-hidden="true">MA<\/span>/);
  assert.match(pageSource, /role="columnheader" aria-label="Montageende" title="Montageende"[\s\S]*?time-review-column-label-short" aria-hidden="true">ME/);
  assert.match(pageSource, /role="columnheader" aria-label="Arbeitszeit" title="Arbeitszeit"[\s\S]*?time-review-column-label-short" aria-hidden="true">AZ/);
  assert.match(styles, /\.time-review-column-label-short\s*\{[^}]*display:\s*none;/s);
  assert.match(styles, /@media \(max-width: 1280px\)[\s\S]*?\.time-review-column-label-full\s*\{[^}]*display:\s*none;[\s\S]*?\.time-review-column-label-short\s*\{[^}]*display:\s*inline;/s);
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
