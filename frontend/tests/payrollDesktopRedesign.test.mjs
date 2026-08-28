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
  assert.match(pageSource, /<strong>\{option\.label\}<\/strong>\s*<\/button>/);
  assert.doesNotMatch(pageSource, /<small>\{formatDayMonth\(option\.start\)\}–\{formatDayMonth\(option\.end\)\}<\/small>/);
  assert.match(styles, /\.time-review-week-nav \.time-week-strip\s*\{[^}]*width:\s*632px;/s);
  assert.match(styles, /\.time-review-week-nav \.time-week-strip button\s*\{[^}]*flex:\s*0 0 92px;[^}]*min-width:\s*92px;[^}]*min-height:\s*38px;/s);
  assert.match(styles, /\.time-review-week-nav \.time-week-scroll-button\s*\{[^}]*height:\s*38px;/s);
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

test("each weekday is one bordered group without decorative day bars", () => {
  assert.match(pageSource, /<section className="time-review-day-group" key=\{day\.date\} role="rowgroup"/);
  assert.match(pageSource, /className="time-review-day-group-head" role="row"/);
  assert.match(pageSource, /day\.entries\.length === 1 \? "Eintrag" : "Einträge"/);
  assert.match(pageSource, /timeReviewDayTotalMinutes\(day\)/);
  assert.match(styles, /\.time-review-day-group\s*\{[^}]*border:\s*1px solid #dfe5ed;[^}]*border-radius:\s*10px;/s);
  assert.match(styles, /\.time-review-day-group \.time-review-week-check-row\.is-travel-time\s*\{[^}]*box-shadow:\s*none;/s);
});

test("payroll review squares its framed surfaces within the active review workspace", () => {
  assert.match(pageSource, /activeTimeSubtab === "review" \? " is-payroll-review-workspace" : ""/);
  assert.match(styles, /\.time-entries-page\.is-figma-times-workspace\.is-payroll-review-workspace \.time-review-queue-panel,[\s\S]*?\.time-entries-page\.is-figma-times-workspace\.is-payroll-review-workspace \.time-review-day-group,[\s\S]*?border-radius:\s*0;/s);
  assert.match(styles, /\.time-entries-page\.is-figma-times-workspace\.is-payroll-review-workspace \.time-review-week-nav \.time-week-strip button,[\s\S]*?\.time-entries-page\.is-figma-times-workspace\.is-payroll-review-workspace \.time-review-week-check-head,[\s\S]*?border-radius:\s*0;/s);
  assert.match(styles, /\.time-review-queue-status\s*\{[^}]*border-radius:\s*999px;/s);
  assert.doesNotMatch(styles, /is-payroll-review-workspace \.time-review-queue-status/);
});

test("desktop layout keeps the queue compact and stacks safely below desktop width", () => {
  assert.match(styles, /\.time-review-workspace-layout\s*\{[^}]*grid-template-columns:\s*minmax\(300px, 336px\) minmax\(0, 1fr\);[^}]*gap:\s*20px;/s);
  assert.match(styles, /@media \(max-width: 980px\)[\s\S]*?\.time-review-workspace-layout\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\);/s);
  assert.match(styles, /@media \(max-width: 760px\)[\s\S]*?\.time-review-download-all-button\s*\{[^}]*width:\s*100%;/s);
});
