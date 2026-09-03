import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { formatGermanMonthYear } from "../src/lib/formatters.ts";

const [pageSource, styles] = await Promise.all([
  readFile(new URL("../src/pages/MobileTimeEntryPage.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
]);
const headerStart = pageSource.indexOf('<header className="mobile-time-month-header">');
const header = pageSource.slice(headerStart, pageSource.indexOf("</header>", headerStart));

test("monthly time calendar combines context and dynamic month in one header", () => {
  assert.ok(headerStart >= 0);
  assert.match(header, /mobile-time-month-context[\s\S]*?<span>Zurück<\/span>[\s\S]*?mobile-time-month-label">Lohnzeit erfassen<\/span>/);
  assert.match(header, /<nav className="mobile-time-month-navigation" aria-label="Monatsnavigation">/);
  assert.match(header, /<h1>\{formatMonth\(visibleMonth\)\}<\/h1>/);
  assert.equal((header.match(/<h1>/g) ?? []).length, 1);
  assert.doesNotMatch(pageSource, /mobile-time-month-hero|mobile-calendar-today|showToday/);
  assert.doesNotMatch(styles, /mobile-time-month-hero|mobile-calendar-today/);
});

test("monthly header reuses back and month handlers without bypassing loading", () => {
  assert.match(header, /onClick=\{\(\) => navigate\("\/me\/assignments"\)\}/);
  assert.match(header, /aria-label="Vorheriger Monat" onClick=\{\(\) => showMonth\(addMonths\(visibleMonth, -1\)\)\}/);
  assert.match(header, /aria-label="Nächster Monat" onClick=\{\(\) => showMonth\(addMonths\(visibleMonth, 1\)\)\}/);
  assert.match(header, /\{!isLoading \? \([\s\S]*?<nav/);
  assert.match(pageSource, /\{isLoading \? <div className="empty-panel">Kalender wird geladen\.\.\.<\/div> : null\}/);
  assert.match(pageSource, /\{!isLoading && activeView === "month" \? \([\s\S]*?aria-label="Monatskalender"/);
});

test("monthly-only styles keep a centered single-line title and accessible controls", () => {
  assert.match(styles, /\.mobile-time-page\.is-month-view \{[^}]*gap:\s*8px;/s);
  assert.match(styles, /\.mobile-time-month-header \{[^}]*background:\s*#ffffff;/s);
  assert.match(styles, /\.mobile-time-month-navigation \{[^}]*grid-template-columns:\s*44px minmax\(0, 1fr\) 44px;[^}]*border-top:/s);
  assert.match(styles, /\.mobile-time-month-navigation h1 \{[^}]*font-size:\s*clamp\([^;]+;[^}]*text-align:\s*center;[^}]*white-space:\s*nowrap;/s);
  assert.match(styles, /\.mobile-time-month-navigation button \{[^}]*width:\s*44px;[^}]*height:\s*44px;/s);
  assert.match(styles, /\.mobile-time-month-header button:focus-visible \{[^}]*outline:\s*2px solid/s);
});

test("calendar day selection, highlights and day-view navigation stay connected", () => {
  assert.match(pageSource, /onClick=\{\(\) => openDay\(day\.date\)\}/);
  assert.match(pageSource, /day\.isToday && "is-today"/);
  assert.match(pageSource, /selectedDate === day\.date && "is-selected"/);
  assert.match(pageSource, /!day\.isCurrentMonth && "is-outside-month"/);
  assert.match(pageSource, /className="mobile-calendar-month-button" type="button" onClick=\{\(\) => setActiveView\("month"\)\}/);
});

// Execute the existing date helpers, not a second implementation of calendar logic.
const ast = ts.createSourceFile("MobileTimeEntryPage.tsx", pageSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const dateHelpers = ["buildMonthGrid", "startOfMonth", "endOfMonth", "addMonths", "addDays", "toIsoDate"];
const source = dateHelpers.map((name) => {
  const declaration = ast.statements.find((statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === name);
  assert.ok(declaration, `${name} exists`);
  return declaration.getText(ast);
}).join("\n");
const dates = vm.createContext({});
vm.runInContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, dates);

test("existing month navigation handles both directions and year boundaries", () => {
  for (const [year, month, direction, expected] of [
    [2026, 8, -1, "2026-08-01"],
    [2026, 8, 1, "2026-10-01"],
    [2026, 11, 1, "2027-01-01"],
    [2027, 0, -1, "2026-12-01"],
  ]) {
    assert.equal(dates.toIsoDate(dates.addMonths(new Date(year, month, 1), direction)), expected);
  }
});

test("month grid retains Monday alignment, outside-month days, today and weekends", () => {
  const grid = dates.buildMonthGrid(new Date(2026, 8, 1), "2026-09-03");
  assert.equal(grid.length, 35);
  assert.equal(grid[0].date, "2026-08-31");
  assert.equal(grid[0].isCurrentMonth, false);
  assert.equal(grid.at(-1).date, "2026-10-04");
  assert.equal(grid.at(-1).isCurrentMonth, false);
  assert.deepEqual(Array.from(grid.filter((day) => day.isToday), (day) => day.date), ["2026-09-03"]);
  assert.equal(grid.filter((day) => day.isCurrentMonth).length, 30);
  assert.equal(grid.filter((day) => day.isWeekend).length, 10);
});

test("month title uses the existing German month/year formatter", () => {
  for (const [month, expected] of [[8, "September 2026"], [10, "November 2026"], [11, "Dezember 2026"]]) {
    assert.equal(formatGermanMonthYear(new Date(2026, month, 1)), expected);
  }
});
