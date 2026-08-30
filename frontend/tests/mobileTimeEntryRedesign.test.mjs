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
  assert.match(pageSource, /className="mobile-time-manual-card is-travel"[\s\S]*?ChevronRight/);
  assert.match(pageSource, /className="mobile-time-manual-card is-manual"[\s\S]*?ChevronRight/);
  assert.match(pageSource, /className="mobile-time-entry-status"[\s\S]*?<Check/);
  assert.match(pageSource, /className="mobile-time-recent-icon"[\s\S]*?<MapPin/);
});

test("mobile time entry uses navy primary actions and compact accessible cards", () => {
  assert.match(styles, /\.mobile-time-site-action \{[^}]*min-height:\s*56px;[^}]*background:\s*#123f76;/s);
  assert.match(styles, /\.mobile-week-day\.is-today strong,[\s\S]*?\.mobile-week-day\.is-selected strong \{[^}]*background:\s*#123f76;/s);
  assert.match(styles, /\.mobile-time-entry-delete \{[^}]*width:\s*44px;[^}]*height:\s*44px;/s);
  assert.match(styles, /\.mobile-time-recent-strip \{[^}]*overflow-x:\s*auto;/s);
  assert.match(styles, /\.mobile-time-entry-copy strong \{[^}]*overflow-wrap:\s*anywhere;/s);
  assert.match(styles, /\.mobile-time-picker-section\.is-secondary \.mobile-time-site-card strong \{[^}]*overflow-wrap:\s*anywhere;/s);
});
