import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [pageSource, styles] = await Promise.all([
  readFile(new URL("../src/pages/MobileTimeEntryPage.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
]);

test("mobile time entry keeps the designed day-view information hierarchy", () => {
  assert.match(pageSource, /className="mobile-calendar-month-button"[\s\S]*?CalendarDays/);
  assert.match(pageSource, /<span>Heute geplant<\/span>[\s\S]*?className="mobile-time-site-card is-planned"[\s\S]*?className="mobile-time-site-action"[\s\S]*?Zeit erfassen/);
  const quickActionStart = pageSource.indexOf('className="mobile-time-manual-actions"');
  const quickActionEnd = pageSource.indexOf('<section className="mobile-time-day-entries"', quickActionStart);
  const recentCardsStart = pageSource.indexOf('<section className="mobile-time-picker-section is-secondary"');
  const recentCardsEnd = pageSource.indexOf('</section>', recentCardsStart);
  assert.doesNotMatch(pageSource.slice(quickActionStart, quickActionEnd), /ChevronRight/);
  assert.doesNotMatch(pageSource.slice(recentCardsStart, recentCardsEnd), /ChevronRight/);
  assert.match(pageSource, /className="mobile-time-entry-status"[\s\S]*?<Check/);
  assert.match(pageSource, /className="mobile-time-recent-icon"[\s\S]*?<MapPin/);
});

test("mobile time entry uses navy primary actions and compact accessible cards", () => {
  assert.match(styles, /\.mobile-time-site-action \{[^}]*min-height:\s*48px;[^}]*background:\s*#123f76;/s);
  assert.match(styles, /\.mobile-week-day\.is-today strong,[\s\S]*?\.mobile-week-day\.is-selected strong \{[^}]*background:\s*#123f76;/s);
  assert.match(styles, /\.mobile-time-entry-delete \{[^}]*width:\s*44px;[^}]*height:\s*44px;/s);
  assert.match(styles, /\.mobile-time-recent-strip \{[^}]*overflow-x:\s*auto;/s);
  assert.match(styles, /\.mobile-time-entry-copy strong \{[^}]*overflow-wrap:\s*anywhere;/s);
  assert.match(styles, /\.mobile-time-picker-section\.is-secondary \.mobile-time-site-card strong \{[^}]*overflow-wrap:\s*anywhere;/s);
  assert.match(styles, /\.mobile-time-manual-actions \.mobile-time-manual-card \{[^}]*min-height:\s*96px;[^}]*grid-template-columns:\s*auto minmax\(0, 1fr\);/s);
  assert.doesNotMatch(styles, /\.mobile-time-(?:manual|recent)-chevron/);
});
